#!/usr/bin/env node
/**
 * proxy-mon.js — 代理活性持续检测工具（零依赖，Mac/服务器通用）
 *
 * 用法：
 *   # 检测一个已有代理（本地客户端端口或远程 SOCKS/HTTP 代理，支持 user:pass@）
 *   node proxy-mon.js --proxy socks5://127.0.0.1:1080
 *   node proxy-mon.js --proxy http://127.0.0.1:1087
 *
 *   # 直接检测分享链接（自动下载 xray-core，本地起 SOCKS 出口再探测）
 *   node proxy-mon.js --link "vless://uuid@host:port?..."
 *   node proxy-mon.js --linkfile links.txt        # 一行一条链接，# 开头为注释，支持多条
 *
 * 常用参数：
 *   --url     http://www.gstatic.com/generate_204   检测目标
 *   --interval 30                                   检测间隔秒（默认 30）
 *   --timeout  8                                     单次超时秒（默认 8）
 *   --port     23456                                 链接模式本地 SOCKS 起始端口
 *   --once                                           只测一轮就退出
 *   --no-notify                                      关闭 macOS 通知
 *   --no-sound                                       通知不带声音
 *
 * 判定逻辑：每轮同时测「代理」和「直连」：
 *   代理通                 → UP
 *   代理不通 + 直连通      → PROXY_DOWN（代理/节点问题）
 *   代理不通 + 直连不通    → NET_DOWN（本机断网，不算代理的锅）
 *
 * 状态翻转弹通知（macOS）；结果追加写入 proxy-mon.log.jsonl
 */
'use strict';
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const fs = require('fs');
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
const BASE_PORT = parseInt(OPT.port || '23456', 10);
const TARGET = (() => {
  let u = OPT.url || 'https://www.gstatic.com/generate_204';
  if (!/^https?:\/\//.test(u)) u = 'http://' + u;
  return u;
})();
const NOTIFY = !OPT['no-notify'];
const SOUND = !OPT['no-sound'];

if (!OPT.proxy && !OPT.link && !OPT.linkfile) {
  console.error('缺少检测对象：--proxy <socks5://host:port | http://host:port> 或 --link "<分享链接>" 或 --linkfile <文件>');
  process.exit(1);
}

/* ---------- 复用拨测引擎（链接解析 / xray 下载，link 模式需要） ---------- */
const hasTester = fs.existsSync(path.join(__dirname, 'tester.js'));
let tester = null;
if (hasTester) { tester = require('./tester.js'); tester.init({ ROOT: __dirname }); }

/* ---------- 目标解析 ---------- */
const t = new URL(TARGET);
const T_HOST = t.hostname, T_PORT = +t.port || (t.protocol === 'https:' ? 443 : 80), T_HTTPS = t.protocol === 'https:';

/* ---------- 检测对象（支持多条） ---------- */
const SOURCES = []; // { kind:'socks'|'http', host, port, auth, tag, outbound }

if (OPT.proxy) {
  const p = new URL(OPT.proxy);
  const kind = p.protocol.replace(':', '') === 'http' ? 'http' : 'socks';
  const host = p.hostname || '127.0.0.1', port = +p.port;
  if (!port) { console.error('代理地址缺少端口'); process.exit(1); }
  const auth = p.username ? { user: decodeURIComponent(p.username), pass: decodeURIComponent(p.password || '') } : null;
  SOURCES.push({ kind, host, port, auth, tag: `proxy ${host}:${port}(${kind})` });
} else {
  let raws = [];
  if (OPT.link) raws = [OPT.link.trim()];
  if (OPT.linkfile) {
    raws = fs.readFileSync(OPT.linkfile, 'utf8').split('\n')
      .map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  }
  for (const raw of raws) {
    const ob = tester ? tester.linkToOutbound(raw) : null;
    if (!ob) { console.error('链接解析失败（仅支持 vmess/vless/trojan/ss）: ' + raw.slice(0, 60) + '...'); process.exit(1); }
    const remark = decodeURIComponent((raw.split('#')[1] || '').replace(/\+/g, ' '));
    const u = new URL(raw.replace(/^[a-z]+:\/\//, 'vless://')); // 统一 scheme 便于解析 host:port
    const tag = remark || `${u.hostname}:${u.port}`;
    SOURCES.push({ kind: 'socks', host: '127.0.0.1', port: 0, tag, outbound: ob });
  }
  if (!SOURCES.length) { console.error('没有可用的链接'); process.exit(1); }
}
const TAGW = Math.max(...SOURCES.map(s => s.tag.length), 8);

/* ---------- 链接模式：准备 xray（N 个出站 + N 个本地 socks 入站 + 路由） ---------- */
let xrayProc = null;
async function startXray() {
  if (!tester) { console.error('link 模式需要同目录的 tester.js'); process.exit(1); }
  const inbounds = [], outbounds = [{ protocol: 'freedom', tag: 'direct' }], rules = [];
  SOURCES.forEach((s, i) => {
    const port = BASE_PORT + i;
    s.port = port;
    const ti = 'in' + i, oi = 'out' + i;
    inbounds.push({ tag: ti, listen: '127.0.0.1', port, protocol: 'socks', settings: { auth: 'noauth', udp: false } });
    outbounds.push({ ...s.outbound, tag: oi });
    rules.push({ inboundTag: [ti], outboundTag: oi });
  });
  const conf = { log: { loglevel: 'warning' }, inbounds, outbounds, routing: { domainStrategy: 'AsIs', rules } };
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
    xrayProc = spawn(binPath, ['run', '-c', confPath], { stdio: ['ignore', 'ignore', 'pipe'] });
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
  // 等第一个本地端口就绪
  for (let i = 0; i < 40; i++) {
    const ok = await new Promise(r => {
      const s = net.connect(BASE_PORT, '127.0.0.1');
      s.once('connect', () => { s.destroy(); r(true); });
      s.once('error', () => r(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 250));
  }
  console.error('xray 本地端口未就绪'); process.exit(1);
}

/* ---------- socks5 握手（支持任意代理主机 + 可选认证），resolve {socket, leftover} ---------- */
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
        if (m === 0) sendReq();
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
        const leftover = Buffer.from(buf.subarray(need));
        s.removeAllListeners('data');
        resolve({ socket: s, leftover });
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

/* ---------- HTTP 探测 ---------- */
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

// 直连探测（每轮共享一次）
function checkDirect() {
  return new Promise(resolve => {
    const t0 = Date.now();
    const mod = T_HTTPS ? https : http;
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

// 经指定检测对象探测
async function checkProxy(S) {
  const t0 = Date.now();
  try {
    if (S.kind === 'socks') {
      const sock = await socksConnectTo(S.host, S.port, T_HOST, T_PORT, TIMEOUT, S.auth);
      // 探测方式与拨测引擎 httpProbe 一致：http.request + createConnection(隧道上按需套 TLS)
      // 注意：不能用裸 socket 立刻写 GET —— 那会让 xray 把 vless 头和载荷打进同一个外层记录，
      // 部分 Reality 服务端（如 US1 面板）对这种包形不响应
      const status = await new Promise((resolve, reject) => {
        const mod = T_HTTPS ? https : http;
        let settled = false;
        const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(to); try { sock.destroy(); } catch (e) {} fn(v); } };
        const to = setTimeout(() => done(reject, new Error('响应超时')), TIMEOUT);
        const creOpts = () => T_HTTPS
          ? tls.connect({ socket: sock, servername: T_HOST, rejectUnauthorized: false })
          : sock;
        const rq = mod.request({ host: T_HOST, port: T_PORT, path: t.pathname + t.search, method: 'GET',
          headers: { 'User-Agent': 'proxy-mon' }, createConnection: creOpts, agent: false, timeout: TIMEOUT }, rs => {
          rs.resume();
          if (rs.statusCode < 400) done(resolve, rs.statusCode);
          else done(reject, new Error('HTTP ' + rs.statusCode));
        });
        rq.on('timeout', () => done(reject, new Error('响应超时')));
        rq.on('error', e => done(reject, new Error('请求错误: ' + e.message)));
        rq.end();
      });
      return { ok: status < 400, ms: Date.now() - t0, status };
    }
    // http 代理
    return await new Promise(resolve => {
      const t0b = Date.now();
      if (T_HTTPS) {
        const req = http.request({ host: S.host, port: S.port, method: 'CONNECT', path: `${T_HOST}:${T_PORT}`, timeout: TIMEOUT });
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
        const req = http.request({ host: S.host, port: S.port, path: TARGET, method: 'GET',
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
  if (!NOTIFY || process.platform !== 'darwin') return;
  const snd = SOUND ? ' sound name "Funk"' : '';
  execFile('osascript', ['-e', `display notification "${msg.replace(/"/g, "'")}" with title "${title}"${snd}`], () => {});
}

const LOG = path.join(process.cwd(), 'proxy-mon.log.jsonl');
function logLine(s) { console.log(`${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ${s}`); }
function logJSON(obj) { try { fs.appendFileSync(LOG, JSON.stringify({ t: new Date().toISOString(), ...obj }) + '\n'); } catch (e) {} }

// 每个检测对象一套独立统计
for (const S of SOURCES) Object.assign(S, { state: 'INIT', total: 0, pass: 0, fail: 0, latSum: 0, downSince: 0, hist: [] });

function spark(S) { return S.hist.map(x => x ? C.g('▮') : C.r('▯')).join(''); }
function uptime(S) { return S.total ? (S.pass / S.total * 100).toFixed(1) + '%' : '—'; }
function avgLat(S) { return S.pass ? Math.round(S.latSum / S.pass) + 'ms' : '—'; }

function updateState(S, direct, proxy) {
  S.total++;
  if (proxy.ok) { S.pass++; S.latSum += proxy.ms; } else S.fail++;
  let newState, color, detail;
  if (proxy.ok) {
    newState = 'UP'; color = C.g;
    detail = `延迟 ${proxy.ms}ms (HTTP ${proxy.status})`;
  } else if (direct.ok) {
    newState = 'PROXY_DOWN'; color = C.r;
    detail = `不通(${proxy.err || 'HTTP ' + proxy.status}) 直连通 ${direct.ms}ms → 代理/节点问题`;
  } else {
    newState = 'NET_DOWN'; color = C.y;
    detail = '不通，直连也不通 → 本机断网';
  }
  S.hist.push(proxy.ok); if (S.hist.length > 30) S.hist.shift();
  logJSON({ link: S.tag, state: newState, proxy_ok: proxy.ok, proxy_ms: proxy.ms, proxy_err: proxy.err || null, proxy_status: proxy.status || null, direct_ok: direct.ok, target: TARGET });

  if (newState !== S.state) {
    if (S.state !== 'INIT') {
      if (newState === 'PROXY_DOWN') {
        notify('⚠️ 代理掉线', `${S.tag} 不通（网络正常，代理问题）`);
        logLine(C.r(`‼️  [${S.tag}] 代理掉线`));
      } else if (newState === 'NET_DOWN') {
        notify('📵 本机断网', `${S.tag} 与直连都不通`);
        logLine(C.y('‼️  本机断网（代理、直连都不通）'));
      } else if (newState === 'UP') {
        const dur = S.downSince ? Math.round((Date.now() - S.downSince) / 1000) : 0;
        notify('✅ 代理恢复', `${S.tag} 已恢复${dur ? `，故障 ${dur}s` : ''}`);
        logLine(C.g(`✅ [${S.tag}] 代理恢复${dur ? `（故障 ${dur} 秒）` : ''}`));
      }
    }
    S.downSince = newState === 'UP' ? 0 : (S.downSince || Date.now());
    S.state = newState;
  }

  const tag = newState === 'UP' ? color('✓') : color('✗');
  logLine(
    `${tag} ${color(newState.padEnd(11))}` +
    `[${S.tag.padEnd(TAGW)}] ` +
    `第 ${String(S.total).padStart(3)} 轮 | ` +
    `成功 ${C.g(String(S.pass))} / 失败 ${S.fail > 0 ? C.r(String(S.fail)) : '0'} | ` +
    `本次 ${proxy.ok ? proxy.ms + 'ms' : '—'} | 平均 ${avgLat(S)} | 在线率 ${uptime(S)}  ${spark(S)}`
  );
}

async function tick() {
  const direct = await checkDirect();
  await Promise.all(SOURCES.map(async S => {
    try {
      const proxy = await checkProxy(S);
      updateState(S, direct, proxy);
    } catch (e) {
      logLine(C.r(`[${S.tag}] 轮次异常: ` + e.message));
    }
  }));
}

/* ---------- 主循环 ---------- */
let stopping = false;
async function main() {
  console.log(C.dim(`proxy-mon  目标=${TARGET}  间隔=${INTERVAL / 1000}s  超时=${TIMEOUT / 1000}s  对象=${SOURCES.length} 个  日志=${LOG}`));
  SOURCES.forEach((S, i) => console.log(C.dim(`  · ${S.tag}${S.outbound ? ` (link, 本地端口 ${BASE_PORT + i})` : ''}`)));
  if (!OPT.proxy) await startXray();
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
  for (const S of SOURCES) {
    console.log(`${S.tag.padEnd(TAGW)}  总轮数 ${S.total} | 成功 ${S.pass} | 失败 ${S.fail} | 在线率 ${uptime(S)} | 平均延迟 ${avgLat(S)}`);
  }
  console.log(`日志: ${LOG}`);
  if (xrayProc) try { xrayProc.kill(); } catch (e) {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
main().catch(e => { console.error('启动失败:', e.message); process.exit(1); });
