#!/usr/bin/env node
/**
 * proxy-mon.js — Mac 代理活性持续检测工具（零依赖）
 *
 * 用法：
 *   # 检测一个已有代理（本地客户端端口或远程 SOCKS/HTTP 代理）
 *   node proxy-mon.js --proxy socks5://127.0.0.1:1080
 *   node proxy-mon.js --proxy http://127.0.0.1:1087
 *
 *   # 直接检测一条分享链接（自动下载 xray-core，本地起 SOCKS 出口再探测）
 *   node proxy-mon.js --link "vless://uuid@host:port?..."
 *   node proxy-mon.js --linkfile links.txt
 *
 * 常用参数：
 *   --url     http://www.gstatic.com/generate_204   检测目标（默认 gstatic 204）
 *   --interval 30                                   检测间隔秒（默认 30）
 *   --timeout  8                                     单次超时秒（默认 8）
 *   --port     23456                                 link 模式本地 SOCKS 端口
 *   --once                                           只测一轮就退出
 *   --no-notify                                      关闭 macOS 通知（掉线/恢复提醒）
 *   --no-sound                                       通知不带声音
 *
 * 判定逻辑：每轮同时测「代理」和「直连」两条路：
 *   代理通                 → UP
 *   代理不通 + 直连通      → PROXY DOWN（代理/节点问题）
 *   代理不通 + 直连不通    → NETWORK DOWN（本机断网，不算代理的锅）
 *
 * 状态翻转时弹 macOS 通知 + 响一声；结果追加写入 proxy-mon.log.jsonl
 */
'use strict';
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const fs = require('fs');
const os = require('os');
const { spawn, execFile } = require('child_process');

/* ---------- 参数解析 ---------- */
function parseArgs() {
  const a = process.argv.slice(2), o = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--once' || k === '--no-notify' || k === '--no-sound' || k === '--quiet') o[k.slice(2)] = true;
    else if (k.startsWith('--')) { o[k.slice(2)] = a[i + 1]; i++; }
  }
  return o;
}
const OPT = parseArgs();

const INTERVAL = Math.max(5, parseInt(OPT.interval || '30', 10)) * 1000;
const TIMEOUT = Math.max(2, parseInt(OPT.timeout || '8', 10)) * 1000;
const TARGET = (() => {
  let u = OPT.url || 'http://www.gstatic.com/generate_204';
  if (!/^https?:\/\//.test(u)) u = 'http://' + u;
  return u;
})();
const NOTIFY = !OPT['no-notify'];
const SOUND = !OPT['no-sound'];

if (!OPT.proxy && !OPT.link && !OPT.linkfile) {
  console.error('缺少检测对象：--proxy <socks5://host:port | http://host:port> 或 --link "<分享链接>" 或 --linkfile <文件>');
  process.exit(1);
}

/* ---------- 复用拨测引擎（链接解析 / socks 握手 / xray 下载） ---------- */
const testerPath = path.join(__dirname, 'tester.js');
const hasTester = fs.existsSync(testerPath);
let tester = null;
if (hasTester) {
  tester = require('./tester.js');
  tester.init({ ROOT: __dirname }); // bin/xray 固定放本项目目录，与 cwd 无关
}

/* ---------- 目标解析 ---------- */
const t = new URL(TARGET);
const T_HOST = t.hostname, T_PORT = +t.port || (t.protocol === 'https:' ? 443 : 80), T_HTTPS = t.protocol === 'https:';

/* ---------- 代理对象 ---------- */
let MODE = 'socks';           // socks | http
let PROXY_HOST = '127.0.0.1', PROXY_PORT = 0, PROXY_AUTH = null;
let LINK_TAG = '';
let xrayProc = null;

if (OPT.proxy) {
  const p = new URL(OPT.proxy);
  MODE = p.protocol.replace(':', '') === 'http' ? 'http' : 'socks';
  PROXY_HOST = p.hostname || '127.0.0.1';
  PROXY_PORT = +p.port;
  if (p.username) PROXY_AUTH = { user: decodeURIComponent(p.username), pass: decodeURIComponent(p.password || '') };
  if (!PROXY_PORT) { console.error('代理地址缺少端口'); process.exit(1); }
  LINK_TAG = `proxy ${PROXY_HOST}:${PROXY_PORT}(${MODE})`;
} else {
  // link / linkfile 模式：本地起 xray
  MODE = 'socks';
  PROXY_PORT = parseInt(OPT.port || '23456', 10);
}

/* ---------- 链接模式：准备 xray ---------- */
async function startXray() {
  if (!tester) { console.error('link 模式需要同目录的 tester.js（xray 下载/链接解析）'); process.exit(1); }
  let raw = OPT.link || '';
  if (OPT.linkfile) {
    raw = fs.readFileSync(OPT.linkfile, 'utf8').split('\n').map(s => s.trim())
      .filter(s => s && !s.startsWith('#'))[0] || '';
  }
  if (!raw) { console.error('没有可用的分享链接'); process.exit(1); }
  const outbound = tester.linkToOutbound(raw);
  if (!outbound) { console.error('链接解析失败（仅支持 vmess/vless/trojan/ss）'); process.exit(1); }
  LINK_TAG = decodeURIComponent((raw.split('#')[1] || '').replace(/\+/g, ' ')) ||
    `${outbound.settings?.vnext?.[0]?.address || outbound.settings?.servers?.[0]?.address || '?'}:${outbound.settings?.vnext?.[0]?.port || outbound.settings?.servers?.[0]?.port || '?'}`;
  const conf = {
    log: { loglevel: 'warning' },
    inbounds: [{ listen: '127.0.0.1', port: PROXY_PORT, protocol: 'socks', settings: { udp: false } }],
    outbounds: [outbound, { protocol: 'freedom' }]
  };
  const confPath = path.join(__dirname, 'proxy-mon-xray.json');
  fs.writeFileSync(confPath, JSON.stringify(conf, null, 2));

  const st = tester.binStatus();
  if (!st.installed) {
    console.log('⏳ 首次使用，正在下载 xray-core ...');
    await tester.downloadBin();
  }
  const binPath = tester.BIN_PATH();
  try { fs.chmodSync(binPath, 0o755); } catch (e) {}

  const launch = () => {
    xrayProc = spawn(binPath, ['-c', confPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errTail = '';
    if (xrayProc.stderr) xrayProc.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-500); });
    xrayProc.on('exit', c => {
      if (!stopping) {
        const last = errTail.trim().split('\n').pop() || '';
        logLine('xray 异常退出 code=' + c + (last ? '：' + last : '') + '，3 秒后重启');
        setTimeout(launch, 3000);
      }
    });
  };
  launch();
  // 等本地端口就绪
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise(r => {
      const s = net.connect(PROXY_PORT, '127.0.0.1');
      s.once('connect', () => { s.destroy(); r(true); });
      s.once('error', () => r(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 250));
  }
  console.error('xray 本地端口未就绪'); process.exit(1);
}

/* ---------- HTTP 探测 ---------- */
// socks5 握手（支持任意代理主机，带可选用户名/密码），成功 resolve 已建隧道的 socket
function socksConnectTo(proxyHost, proxyPort, host, port, timeoutMs, auth) {
  return new Promise((resolve, reject) => {
    const s = net.connect(proxyPort, proxyHost);
    let buf = Buffer.alloc(0), stage = 0; // 0=等method 1=等auth 2=等reply
    const to = setTimeout(() => { s.destroy(); reject(new Error('代理连接超时')); }, timeoutMs);
    const fail = e => { clearTimeout(to); s.destroy(); reject(new Error(e)); };
    s.on('error', e => fail('代理连接失败: ' + e.message));
    s.on('connect', () => s.write(auth ? Buffer.from([5, 2, 0, 2]) : Buffer.from([5, 1, 0])));
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        const m = buf[1]; buf = buf.subarray(2);
        if (m === 0) { sendReq(); }
        else if (m === 2 && auth) {
          stage = 1;
          const u = Buffer.from(auth.user), p = Buffer.from(auth.pass);
          s.write(Buffer.concat([Buffer.from([1, u.length]), u, Buffer.from([p.length]), p]));
        } else return fail('socks 握手失败（代理要求账号密码？）');
      } else if (stage === 1 && buf.length >= 2) {
        if (buf[1] !== 0) return fail('socks 认证失败');
        buf = buf.subarray(2); sendReq();
      } else if (stage === 2 && buf.length >= 5) {
        // 完整解析 connect reply：VER REP RSV ATYP + ADDR + PORT
        const atyp = buf[3];
        let need = 0;
        if (atyp === 1) need = 10;
        else if (atyp === 4) need = 22;
        else if (atyp === 3) need = 5 + buf[4] + 2;
        else return fail('socks 应答异常 ATYP=' + atyp);
        if (buf.length < need) return; // 继续等
        clearTimeout(to);
        if (buf[1] !== 0) return fail('代理链路被拒（目标不可达或节点无效）');
        const leftover = buf.subarray(need);
        s.removeAllListeners('data');
        resolve({ socket: s, leftover: Buffer.from(leftover) });
      }
    });
    function sendReq() {
      stage = 2;
      const hb = Buffer.from(host);
      const rq = Buffer.alloc(7 + hb.length);
      rq[0] = 5; rq[1] = 1; rq[2] = 0; rq[3] = 3; rq[4] = hb.length;
      hb.copy(rq, 5); rq.writeUInt16BE(port, 5 + hb.length);
      s.write(rq);
    }
  });
}

// 在已建立的 socket 上发 HTTP 请求并读响应头（leftover = 握手阶段残留字节）
function httpOverSocket(socket, timeoutMs, leftover) {
  return new Promise((resolve, reject) => {
    let buf = '', done = false;
    const req = `GET ${t.pathname}${t.search} HTTP/1.1\r\nHost: ${T_HOST}\r\nUser-Agent: proxy-mon\r\nConnection: close\r\n\r\n`;
    const to = setTimeout(() => { if (!done) { done = true; socket.destroy(); reject(new Error('响应超时')); } }, timeoutMs);
    socket.on('error', e => { if (!done) { done = true; clearTimeout(to); reject(new Error('socket 错误: ' + e.message)); } });
    const feed = str => {
      if (done) return;
      buf += str;
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1) return;
      done = true; clearTimeout(to);
      const m = /^HTTP\/[\d.]+ (\d{3})/.exec(buf);
      socket.destroy();
      if (!m) return reject(new Error('非法 HTTP 响应'));
      resolve(+m[1]);
    };
    socket.on('data', d => feed(d.toString('latin1')));
    socket.write(req);
    if (leftover && leftover.length) { const l = leftover; leftover = null; feed(l.toString('latin1')); }
  });
}

// 直连探测（不经过任何代理）
function checkDirect() {
  return new Promise(resolve => {
    const t0 = Date.now();
    const mod = T_HTTPS ? tls : http;
    const req = mod.request({ host: T_HOST, port: T_PORT, path: t.pathname + t.search, method: 'GET',
      headers: { 'User-Agent': 'proxy-mon' }, timeout: TIMEOUT }, res => {
      res.resume();
      resolve({ ok: res.statusCode < 400, ms: Date.now() - t0, status: res.statusCode });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0, err: '直连超时' }); });
    req.on('error', e => resolve({ ok: false, ms: Date.now() - t0, err: '直连失败: ' + e.message }));
    req.end();
  });
}

// 经代理探测
async function checkProxy() {
  const t0 = Date.now();
  try {
    if (MODE === 'socks') {
      const r = await socksConnectTo(PROXY_HOST, PROXY_PORT, T_HOST, T_PORT, TIMEOUT, PROXY_AUTH);
      const status = await httpOverSocket(r.socket, TIMEOUT, r.leftover);
      return { ok: status < 400, ms: Date.now() - t0, status };
    }
    // http 代理：https 目标用 CONNECT，http 目标用绝对地址 GET
    return await new Promise(resolve => {
      const t0b = Date.now();
      if (T_HTTPS) {
        const req = http.request({ host: PROXY_HOST, port: PROXY_PORT, method: 'CONNECT', path: `${T_HOST}:${T_PORT}`, timeout: TIMEOUT });
        req.on('connect', (res, socket) => {
          if (res.statusCode !== 200) return resolve({ ok: false, ms: Date.now() - t0b, err: 'CONNECT ' + res.statusCode });
          const s = tls.connect({ socket, servername: T_HOST });
          s.once('secureConnect', () => httpOverSocket(s, TIMEOUT).then(r => resolve({ ...r, ms: Date.now() - t0b })).catch(e => resolve({ ok: false, ms: Date.now() - t0b, err: e.message })));
          s.once('error', e => resolve({ ok: false, ms: Date.now() - t0b, err: 'tls: ' + e.message }));
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0b, err: '代理超时' }); });
        req.on('error', e => resolve({ ok: false, ms: Date.now() - t0b, err: '代理连接失败: ' + e.message }));
        req.end();
      } else {
        const req = http.request({ host: PROXY_HOST, port: PROXY_PORT, path: TARGET, method: 'GET',
          headers: { Host: T_HOST, 'User-Agent': 'proxy-mon' }, timeout: TIMEOUT }, res => {
          res.resume();
          resolve({ ok: res.statusCode < 400, ms: Date.now() - t0b, status: res.statusCode });
        });
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0b, err: '代理超时' }); });
        req.on('error', e => resolve({ ok: false, ms: Date.now() - t0b, err: '代理连接失败: ' + e.message }));
        req.end();
      }
    });
  } catch (e) {
    return { ok: false, ms: Date.now() - t0, err: e.message };
  }
}

/* ---------- 通知 / 日志 / 渲染 ---------- */
const C = { g: s => `\x1b[32m${s}\x1b[0m`, r: s => `\x1b[31m${s}\x1b[0m`, y: s => `\x1b[33m${s}\x1b[0m`, dim: s => `\x1b[2m${s}\x1b[0m` };

function notify(title, msg) {
  if (!NOTIFY) return;
  const snd = SOUND ? ' sound name "Funk"' : '';
  execFile('osascript', ['-e', `display notification "${msg.replace(/"/g, "'")}" with title "${title}"${snd}`], () => {});
}

const LOG = path.join(process.cwd(), 'proxy-mon.log.jsonl');
function logLine(s) { console.log(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${s}`); }
function logJSON(obj) { try { fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch (e) {} }

const hist = [];        // 最近结果 true/false
let total = 0, pass = 0, fail = 0, downSince = 0, latSum = 0;
let state = 'INIT';     // UP | PROXY_DOWN | NET_DOWN

function spark() { return hist.map(x => x ? C.g('▮') : C.r('▯')).join(''); }
function uptime() { return total ? (pass / total * 100).toFixed(1) + '%' : '—'; }
function avgLat() { return pass ? Math.round(latSum / pass) + 'ms' : '—'; }

async function tick() {
  const [direct, proxy] = await Promise.all([checkDirect(), checkProxy()]);
  total++;
  if (proxy.ok) { pass++; latSum += proxy.ms; } else fail++;
  let newState, color, detail;
  if (proxy.ok) {
    newState = 'UP'; color = C.g;
    detail = `延迟 ${proxy.ms}ms (HTTP ${proxy.status})  直连${direct.ok ? ' ' + direct.ms + 'ms' : ' ✗'}`;
  } else if (direct.ok) {
    newState = 'PROXY_DOWN'; color = C.r;
    detail = `不通(${proxy.err || 'HTTP ' + proxy.status}) 但直连通 ${direct.ms}ms → 代理/节点问题`;
  } else {
    newState = 'NET_DOWN'; color = C.y;
    detail = '不通，且直连也不通 → 本机网络断了，不算代理的锅';
  }
  hist.push(proxy.ok); if (hist.length > 30) hist.shift();
  logJSON({ state: newState, proxy_ok: proxy.ok, proxy_ms: proxy.ms, proxy_err: proxy.err || null, proxy_status: proxy.status || null, direct_ok: direct.ok, direct_ms: direct.ms, target: TARGET });

  if (newState !== state) {
    if (state !== 'INIT') {
      if (newState === 'PROXY_DOWN') {
        notify('⚠️ 代理掉线', `${LINK_TAG} 不通（网络正常，代理问题）`);
        logLine(C.r(`‼️  代理掉线：${LINK_TAG}`));
      } else if (newState === 'NET_DOWN') {
        notify('📵 本机断网', '代理与直连都不通');
        logLine(C.y('‼️  本机断网（代理、直连都不通）'));
      } else if (newState === 'UP') {
        const dur = downSince ? Math.round((Date.now() - downSince) / 1000) : 0;
        notify('✅ 代理恢复', `${LINK_TAG} 已恢复${dur ? `，故障 ${dur}s` : ''}`);
        logLine(C.g(`✅ 代理恢复${dur ? `（故障持续 ${dur} 秒）` : ''}`));
      }
    }
    downSince = newState === 'UP' ? 0 : (downSince || Date.now());
    state = newState;
  }

  const tag = newState === 'UP' ? color('✓') : color('✗');
  logLine(
    `${tag} ${color(newState.padEnd(11))}` +
    `第 ${String(total).padStart(3)} 轮 | ` +
    `成功 ${C.g(String(pass))} / 失败 ${fail > 0 ? C.r(String(fail)) : '0'} | ` +
    `本次延迟 ${proxy.ok ? proxy.ms + 'ms' : '—'} | 平均 ${avgLat()} | 在线率 ${uptime()}  ${spark()}`
  );
}

/* ---------- 主循环 ---------- */
let stopping = false;
async function main() {
  console.log(C.dim(`proxy-mon  目标=${TARGET}  间隔=${INTERVAL / 1000}s  超时=${TIMEOUT / 1000}s  日志=${LOG}`));
  if (OPT.link || OPT.linkfile) await startXray();
  console.log(C.dim(`检测对象: ${LINK_TAG || OPT.proxy || '(链接)'}`));
  console.log(C.dim('Ctrl+C 退出\n'));
  await tick();
  if (OPT.once) { shutdown(); return; }
  setInterval(async () => {
    try { await tick(); } catch (e) { logLine(C.r('轮次异常: ' + e.message)); }
  }, INTERVAL);
}
function shutdown() {
  if (stopping) return; stopping = true;
  console.log(`\n—— 检测汇总 ——`);
  console.log(`总轮数 ${total} | 成功 ${pass} | 失败 ${fail} | 在线率 ${uptime()} | 平均延迟 ${avgLat()}`);
  console.log(`日志: ${LOG}`);
  if (xrayProc) try { xrayProc.kill(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch(e => { console.error('启动失败:', e.message); process.exit(1); });
