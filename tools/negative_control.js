/**
 * negative_control.js — 拨测引擎负向对照实验
 * 目的：证明拨测流量真的走「socks 入站 → 客户端 outbound」链路，而非直连。
 * 方法：取香港1 一个真实客户端的分享链接，构建两份配置：
 *   A = 原始链接（真 UUID）
 *   B = 故意篡改 UUID 的链接
 * 同一个 xray 进程里各挂一个 socks 入站。预期：A 通过、B 失败。
 * 若 B 也通过 → 引擎有直连泄漏，拨测结果不可信。
 * 用法: node tools/negative_control.js srvzmac4 [email]
 */
'use strict';
const fs = require('fs'), https = require('https'), http = require('http'),
      { spawn } = require('child_process'), path = require('path'),
      crypto = require('crypto');
const tester = require('../tester.js');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const svId = process.argv[2] || 'srvzmac4';
const wantEmail = process.argv[3] || '';
const sv = (cfg.servers || []).find(s => s.id === svId);

function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    let data = null;
    if (body != null) {
      data = typeof body === 'string' ? body : JSON.stringify(body);
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      headers['Content-Length'] = Buffer.byteLength(data);
    }
    const r = mod.request(u, { method, headers, rejectUnauthorized: false, timeout: 15000 }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

async function getLinks() {
  const base = sv.url.replace(/\/+$/, '');
  const h = { Accept: 'application/json' };
  if (sv.token) h.Authorization = 'Bearer ' + sv.token;
  else {
    const l = await req(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { username: sv.username, password: sv.password } });
    h.Cookie = (l.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
  }
  const lr = await req(base + '/panel/api/inbounds/list', { headers: h });
  const list = JSON.parse(lr.text).obj || [];
  const out = [];
  for (const ib of list) {
    let st = ib.settings;
    if (typeof st === 'string') { try { st = JSON.parse(st); } catch (e) { st = {}; } }
    for (const c of (st.clients || [])) out.push({ email: c.email, enable: c.enable, subId: c.subId });
  }
  const links = {};
  for (const c of out) {
    if (!c.subId) continue;
    if (wantEmail && c.email !== wantEmail) continue;
    if (!wantEmail && links[c.email]) continue; // 每个客户端取一条即可
    if (!wantEmail && out.indexOf(c) > 5) continue; // 只取前几个，节省请求
    try {
      const r = await req(base + '/panel/api/clients/subLinks/' + encodeURIComponent(c.subId), { headers: h });
      const j = JSON.parse(r.text);
      const ls = (j.success !== false && Array.isArray(j.obj)) ? j.obj : [];
      if (ls.length) links[c.email] = ls[0];
    } catch (e) { /* ignore */ }
  }
  return links;
}

function corruptLink(link) {
  // 篡改凭证：vless/trojan/ss 的 UUID 或密码在 @ 之前；vmess 在 base64 里
  const at = link.indexOf('@');
  if (at > 0) {
    const head = link.slice(0, at);
    // 把凭证最后一位换掉
    const m = head.match(/^(.*:\/\/)(.+)$/);
    if (m) {
      const cred = m[2];
      const last = cred[cred.length - 1];
      const swapped = last === 'a' ? 'b' : 'a';
      return link.slice(0, at - 1) + swapped + link.slice(at);
    }
  }
  // vmess: base64 json
  const b64 = link.slice('vmess://'.length);
  const j = JSON.parse(Buffer.from(b64, 'base64').toString());
  j.id = j.id.slice(0, -1) + (j.id.endsWith('a') ? 'b' : 'a');
  return 'vmess://' + Buffer.from(JSON.stringify(j)).toString('base64');
}

async function probe(socksPort, target, timeoutS) {
  const u = new URL(target);
  const t0 = Date.now();
  try {
    const sock = await tester.socksConnect(socksPort, u.hostname, +u.port || 80, timeoutS * 1000);
    const payload = `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: nc-test\r\nConnection: close\r\n\r\n`;
    const r = await new Promise((resolve, reject) => {
      let buf = '';
      const to = setTimeout(() => { sock.destroy(); reject(new Error('HTTP 超时')); }, timeoutS * 1000);
      sock.on('data', d => { buf += d; if (buf.includes('\r\n\r\n') || /HTTP\/1\.[01] \d+/.test(buf)) { clearTimeout(to); sock.destroy(); resolve(buf.split('\r\n')[0]); } });
      sock.on('error', e => { clearTimeout(to); reject(e); });
      sock.write(payload);
    });
    return { ok: true, status: r, lat: Date.now() - t0 };
  } catch (e) {
    return { ok: false, err: e.message, lat: Date.now() - t0 };
  }
}

(async () => {
  console.log('== 负向对照实验（香港1）==\n');
  const links = await getLinks();
  const emails = Object.keys(links);
  if (!emails.length) { console.log('未取到任何链接'); return; }
  const email = emails[0];
  const link = links[email];
  console.log(`被测客户端: ${email}`);
  console.log(`链接协议: ${link.split('://')[0]}\n`);

  const obA = tester.linkToOutbound(link);
  const obB = tester.linkToOutbound(corruptLink(link));
  if (!obA) { console.log('链接解析失败'); return; }

  const tmp = fs.mkdtempSync('/tmp/nc-');
  const config = {
    log: { loglevel: 'warning' },
    inbounds: [
      { tag: 'tiA', listen: '127.0.0.1', port: 21501, protocol: 'socks', settings: { auth: 'noauth', udp: false } },
      { tag: 'tiB', listen: '127.0.0.1', port: 21502, protocol: 'socks', settings: { auth: 'noauth', udp: false } }
    ],
    outbounds: [ { ...obA, tag: 'obA' }, { ...obB, tag: 'obB' } ],
    routing: { domainStrategy: 'AsIs', rules: [
      { inboundTag: ['tiA'], outboundTag: 'obA' },
      { inboundTag: ['tiB'], outboundTag: 'obB' }
    ] }
  };
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config));

  const p = spawn(tester.BIN_PATH(), ['run', '-c', 'config.json'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  p.stderr.on('data', d => stderr += d);
  // 等 socks 就绪
  for (let i = 0; i < 30; i++) {
    try { const s = await tester.socksConnect(21501, 'example.com', 80, 500); s.destroy(); break; }
    catch (e) { await new Promise(r => setTimeout(r, 300)); }
  }

  const TARGET = 'http://www.gstatic.com/generate_204';
  const [A, B] = await Promise.all([probe(21501, TARGET, 8), probe(21502, TARGET, 8)]);

  console.log(`A 真实凭证    : ${A.ok ? '✅ 通 ' + A.lat + 'ms ' + A.status : '❌ 不通 ' + A.err}`);
  console.log(`B 篡改凭证    : ${B.ok ? '✅ 通 ' + B.lat + 'ms ' + B.status + '  ← 泄漏！' : '❌ 不通 ' + B.err}`);
  console.log('');
  if (A.ok && !B.ok) {
    console.log('✅ 结论：引擎流量真实走代理链路 —— 篡改凭证即失败，绿 = 链路真通（从看板服务器网络视角）。');
  } else if (A.ok && B.ok) {
    console.log('❌ 结论：篡改凭证也能通过 → 拨测存在直连泄漏，结果不可信，需要修引擎！');
  } else if (!A.ok) {
    console.log('⚠ 结论：真实凭证也没通过 —— 当前网络到该客户端链路本身不通，请换客户端重试。');
  }
  p.kill('SIGKILL');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
})();
