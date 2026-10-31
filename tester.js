/**
 * tester.js — 客户端批量拨测引擎（零依赖）
 *
 * 原理：
 *  1. 从面板取每个客户端的分享链接（/panel/api/clients/subLinks/{subId}，取不到时本地兜底组装）
 *  2. 自动下载 xray-core 二进制（按平台），生成临时配置：N 个 outbound + N 个本地 socks 入站（127.0.0.1）
 *  3. 通过各 socks 端口对目标 URL 发真实 HTTP 请求，2xx/3xx = 通，记录延迟
 *  4. 结果写入 test_history.jsonl；支持定时批量（默认关闭）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const { execFile, spawn } = require('child_process');

let ROOT = process.cwd();
let getCfg = () => ({ demo: true });
let callPanel = null;
let log = (...a) => console.log('[tester]', ...a);

const SETTINGS_FILE = () => path.join(ROOT, 'tester.json');
const HIST_FILE = () => path.join(ROOT, 'test_history.jsonl');
const BIN_DIR = () => path.join(ROOT, 'bin', 'xray');
const BIN_PATH = () => path.join(BIN_DIR(), 'xray');

function init(opts) {
  ROOT = opts.ROOT || ROOT;
  getCfg = opts.getCfg || getCfg;
  callPanel = opts.callPanel || callPanel;
  log = opts.log || log;
}

/* ==================== 设置（含定时） ==================== */
function loadSettings() {
  const d = readJSON(SETTINGS_FILE()) || {};
  return {
    scheduleEnabled: !!d.scheduleEnabled,
    scheduleMinutes: d.scheduleMinutes || 30,
    concurrency: d.concurrency || 10,
    timeout: d.timeout || 8,
    targetMode: d.targetMode || 'gstatic',
    customTarget: d.customTarget || '',
    nextRunAt: d.nextRunAt || 0
  };
}
function saveSettings(patch) {
  const s = { ...loadSettings(), ...patch };
  if (patch.scheduleEnabled === true && !loadSettings().scheduleEnabled) {
    s.nextRunAt = Date.now() + (s.scheduleMinutes || 30) * 60000;
  }
  if (patch.scheduleEnabled === false) s.nextRunAt = 0;
  if (patch.scheduleMinutes && s.nextRunAt) s.nextRunAt = Date.now() + s.scheduleMinutes * 60000;
  writeJSON(SETTINGS_FILE(), s);
  return s;
}
function effectiveTarget(s) {
  s = s || loadSettings();
  if (s.targetMode === 'custom') {
    let v = (s.customTarget || '').trim();
    if (!v) return '';
    if (!/^https?:\/\//.test(v)) v = 'http://' + v;
    return v;
  }
  return s.targetMode === 'cloudflare' ? 'http://cp.cloudflare.com' : 'http://www.gstatic.com/generate_204';
}

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJSON(f, d) { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { log('写文件失败', f, e.message); } }

/* ==================== xray-core 二进制管理 ==================== */
const bin = { downloading: false, progress: 0, version: '' };

function platformAsset() {
  const p = process.platform, a = process.arch;
  if (p === 'darwin') return a === 'arm64' ? 'Xray-macos-arm64-v8a.zip' : 'Xray-macos-64.zip';
  if (p === 'linux') return a === 'arm64' ? 'Xray-linux-arm64-v8a.zip' : 'Xray-linux-64.zip';
  if (p === 'win32') return 'Xray-windows-64.zip';
  return null;
}

function binStatus() {
  let installed = false;
  try { installed = fs.existsSync(BIN_PATH()) && fs.statSync(BIN_PATH()).size > 1e6; } catch (e) {}
  return { installed, version: bin.version, downloading: bin.downloading, progress: Math.round(bin.progress) };
}

function downloadBin() {
  return new Promise((resolve, reject) => {
    const st = binStatus();
    if (st.installed && st.version) return resolve({ ok: true, version: st.version });
    if (bin.downloading) return reject(new Error('已在下载中'));
    const asset = platformAsset();
    if (!asset) return reject(new Error('不支持的平台: ' + process.platform + '/' + process.arch));
    bin.downloading = true; bin.progress = 0;
    const url = 'https://github.com/XTLS/Xray-core/releases/latest/download/' + asset;
    const zipPath = path.join(BIN_DIR(), '..', asset);
    fs.mkdirSync(BIN_DIR(), { recursive: true });
    log('开始下载', url);
    const get = (u, redirects) => {
      https.get(u, res => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects < 6) {
          res.resume();
          return get(res.headers.location, redirects + 1);
        }
        if (res.statusCode !== 200) { bin.downloading = false; return reject(new Error('下载失败 HTTP ' + res.statusCode)); }
        const total = +res.headers['content-length'] || 0;
        let done = 0;
        const f = fs.createWriteStream(zipPath);
        res.on('data', c => { done += c.length; if (total) bin.progress = done / total * 95; });
        res.pipe(f);
        f.on('finish', () => f.close(() => {
          bin.progress = 96;
          execFile('unzip', ['-o', zipPath, 'xray', '-d', BIN_DIR()], (err, so, se) => {
            try { fs.unlinkSync(zipPath); } catch (e) {}
            if (err) {
              bin.downloading = false;
              return reject(new Error('解压失败（服务器需要安装 unzip）: ' + (se || err.message)));
            }
            try { fs.chmodSync(BIN_PATH(), 0o755); } catch (e) {}
            xrayVersion().then(v => {
              bin.version = v; bin.downloading = false; bin.progress = 100;
              log('xray-core 就绪:', v);
              resolve({ ok: true, version: v });
            }).catch(reject);
          });
        }));
      }).on('error', e => { bin.downloading = false; reject(e); });
    };
    get(url, 0);
  });
}

function xrayVersion() {
  return new Promise((resolve, reject) => {
    execFile(BIN_PATH(), ['version'], { timeout: 8000 }, (err, so) => {
      if (err) return reject(new Error('xray 无法执行: ' + err.message));
      const m = String(so).match(/Xray\s+(\S+)/i);
      resolve(m ? m[1] : 'unknown');
    });
  });
}

async function ensureBin() {
  const st = binStatus();
  if (st.installed) {
    if (!bin.version) { try { bin.version = await xrayVersion(); } catch (e) {} }
    return bin.version;
  }
  await downloadBin();
  return bin.version;
}

/* ==================== 分享链接 ==================== */
// 本地兜底组装（面板 subLinks 拿不到时用），覆盖 vless/vmess/trojan/ss + reality
function buildLinkLocal(ib, client) {
  const stream = ib.stream || {};
  const raw = client.raw || {};
  const sec = stream.security || 'none';
  const net = stream.network || 'tcp';
  const q = new URLSearchParams();
  let proto = ib.protocol, id = raw.id || raw.password || '', userinfo = id;
  if (proto === 'vmess') {
    const o = { v: '2', ps: client.email, add: ib.svAddress, port: String(ib.port), id: raw.id || '', aid: String(raw.alterId ?? 0),
      scy: raw.security || 'auto', net, type: 'none', host: '', path: '', tls: sec === 'tls' || sec === 'reality' ? 'tls' : '', sni: '', fp: '' };
    if (sec === 'tls' && stream.tlsSettings) { o.sni = stream.tlsSettings.serverName || ''; o.fp = stream.tlsSettings.fingerprint || ''; }
    if (net === 'ws' && stream.wsSettings) { o.path = stream.wsSettings.path || '/'; o.host = (stream.wsSettings.headers && stream.wsSettings.headers.Host) || ''; }
    if (net === 'grpc' && stream.grpcSettings) { o.path = stream.grpcSettings.serviceName || ''; }
    return 'vmess://' + Buffer.from(JSON.stringify(o)).toString('base64');
  }
  if (proto === 'shadowsocks') {
    const ss = ib.settings || {};
    const userinfo2 = Buffer.from((raw.method || ss.method || 'aes-128-gcm') + ':' + (raw.password || ss.password || '')).toString('base64');
    return `ss://${userinfo2}@${ib.svAddress}:${ib.port}#${encodeURIComponent(client.email)}`;
  }
  if (proto === 'trojan') {
    if (sec === 'tls' && stream.tlsSettings) q.set('sni', stream.tlsSettings.serverName || '');
    q.set('fp', 'chrome'); q.set('type', net);
    return `trojan://${encodeURIComponent(id)}@${ib.svAddress}:${ib.port}?${q}#${encodeURIComponent(client.email)}`;
  }
  // vless
  q.set('encryption', raw.encryption || 'none');
  if (raw.flow) q.set('flow', raw.flow);
  if (sec === 'tls' && stream.tlsSettings) {
    q.set('security', 'tls'); q.set('sni', stream.tlsSettings.serverName || ''); q.set('fp', stream.tlsSettings.fingerprint || 'chrome');
  } else if (sec === 'reality' && stream.realitySettings) {
    const r = stream.realitySettings;
    q.set('security', 'reality');
    q.set('sni', (r.serverNames && r.serverNames[0]) || '');
    q.set('fp', (r.settings && r.settings.fingerprint) || 'chrome');
    q.set('pbk', (r.settings && r.settings.publicKey) || r.publicKey || '');
    q.set('sid', (r.shortIds && r.shortIds[0]) || '');
    q.set('spx', (r.settings && r.settings.spiderX) || r.spiderX || '/');
    if (r.settings && r.settings.mldsa65Verify) q.set('pqv', r.settings.mldsa65Verify);
  } else q.set('security', 'none');
  q.set('type', net);
  if (net === 'ws' && stream.wsSettings) { q.set('path', stream.wsSettings.path || '/'); const h = stream.wsSettings.headers && stream.wsSettings.headers.Host; if (h) q.set('host', h); }
  if (net === 'grpc' && stream.grpcSettings) q.set('serviceName', stream.grpcSettings.serviceName || '');
  return `vless://${userinfo}@${ib.svAddress}:${ib.port}?${q}#${encodeURIComponent(client.email)}`;
}

// 从分享链接解析为 xray outbound（引擎使用面板返回的链接，兜底用本地组装）
function parseLink(link) {
  const u = new URL(link);
  const proto = u.protocol.replace(':', '');
  const port = +u.port;
  const host = u.hostname;
  const q = u.searchParams;
  let outbound = null;
  if (proto === 'vless') {
    const users = [{ id: decodeURIComponent(u.username), encryption: q.get('encryption') || 'none', flow: q.get('flow') || '' }];
    outbound = { protocol: 'vless', settings: { vnext: [{ address: host, port, users }] } };
  } else if (proto === 'vmess') {
    const j = JSON.parse(Buffer.from(link.replace('vmess://', ''), 'base64').toString());
    outbound = { protocol: 'vmess', settings: { vnext: [{ address: j.add, port: +j.port, users: [{ id: j.id, alterId: +(j.aid || 0), security: j.scy || 'auto' }] }] } };
    return { outbound, stream: streamFromVmess(j) };
  } else if (proto === 'trojan') {
    outbound = { protocol: 'trojan', settings: { servers: [{ address: host, port, password: decodeURIComponent(u.username) }] } };
  } else if (proto === 'ss') {
    const dec = Buffer.from(decodeURIComponent(u.username), 'base64').toString();
    const idx = dec.indexOf(':');
    outbound = { protocol: 'shadowsocks', settings: { servers: [{ address: host, port, method: dec.slice(0, idx), password: dec.slice(idx + 1) }] } };
  } else return null;
  const stream = { network: q.get('type') || 'tcp', security: q.get('security') || 'none' };
  if (stream.security === 'reality') {
    stream.realitySettings = {
      serverName: q.get('sni') || '', fingerprint: q.get('fp') || 'chrome',
      publicKey: q.get('pbk') || '', shortId: q.get('sid') || '', spiderX: q.get('spx') || '/'
    };
    if (q.get('pqv')) stream.realitySettings.mldsa65Verify = q.get('pqv');
  } else if (stream.security === 'tls') {
    stream.tlsSettings = { serverName: q.get('sni') || u.hostname, fingerprint: q.get('fp') || 'chrome', allowInsecure: true };
  }
  if (stream.network === 'ws') stream.wsSettings = { path: q.get('path') || '/', headers: q.get('host') ? { Host: q.get('host') } : {} };
  if (stream.network === 'grpc') stream.grpcSettings = { serviceName: q.get('serviceName') || '', multiMode: false };
  return { outbound, stream };
}
function streamFromVmess(j) {
  const stream = { network: j.net || 'tcp', security: j.tls === 'tls' ? 'tls' : 'none' };
  if (stream.security === 'tls') stream.tlsSettings = { serverName: j.sni || '', fingerprint: j.fp || 'chrome', allowInsecure: true };
  if (stream.network === 'ws') stream.wsSettings = { path: j.path || '/', headers: j.host ? { Host: j.host } : {} };
  if (stream.network === 'grpc') stream.grpcSettings = { serviceName: j.path || '', multiMode: false };
  return stream;
}
function linkToOutbound(link) {
  try {
    if (link.startsWith('vmess://')) {
      const p = parseLink(link);
      return p ? { ...p.outbound, streamSettings: p.stream } : null;
    }
    const p = parseLink(link);
    return p ? { ...p.outbound, streamSettings: p.stream } : null;
  } catch (e) { return null; }
}

/* ==================== SOCKS5 拨测 ==================== */
function socksConnect(socksPort, host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socksPort, '127.0.0.1');
    let buf = Buffer.alloc(0), stage = 0;
    const to = setTimeout(() => { s.destroy(); reject(new Error('连接超时')); }, timeoutMs);
    s.on('error', e => { clearTimeout(to); reject(new Error('连接失败: ' + e.message)); });
    s.on('connect', () => s.write(Buffer.from([5, 1, 0])));
    s.on('data', d => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 2) {
        if (buf[1] !== 0) { clearTimeout(to); s.destroy(); return reject(new Error('socks 握手失败')); }
        stage = 1; buf = buf.subarray(2);
        const hb = Buffer.from(host);
        const rq = Buffer.alloc(7 + hb.length);
        rq[0] = 5; rq[1] = 1; rq[2] = 0; rq[3] = 3; rq[4] = hb.length;
        hb.copy(rq, 5); rq.writeUInt16BE(port, 5 + hb.length);
        s.write(rq);
      } else if (stage === 1 && buf.length >= 4) {
        clearTimeout(to);
        if (buf[1] !== 0) { s.destroy(); return reject(new Error('代理链路被拒（目标不可达或客户端无效）')); }
        s.removeAllListeners('data');
        s.setTimeout(0);
        resolve(s);
      }
    });
  });
}

function httpProbe(sock, targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(targetUrl);
    const mod = u.protocol === 'https:' ? https : http;
    const t0 = Date.now();
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(to); try { sock.destroy(); } catch (e) {} fn(v); } };
    const to = setTimeout(() => done(reject, new Error('HTTP 请求超时')), timeoutMs);
    const creOpts = u.protocol === 'https:'
      ? () => tls.connect({ socket: sock, servername: u.hostname, rejectUnauthorized: false })
      : () => sock;
    const r = mod.request(u, { createConnection: creOpts, agent: false, timeout: timeoutMs }, rs => {
      const lat = Date.now() - t0;
      rs.resume();
      if (rs.statusCode >= 200 && rs.statusCode < 400) done(resolve, { status: rs.statusCode, latency: lat });
      else done(reject, new Error('HTTP ' + rs.statusCode + '（非 2xx/3xx）'));
    });
    r.on('timeout', () => done(reject, new Error('HTTP 请求超时')));
    r.on('error', e => done(reject, e.status ? e : new Error('请求错误: ' + e.message)));
    r.end();
  });
}

async function probeOne(socksPort, target, timeoutS) {
  const u = new URL(target);
  const port = +u.port || (u.protocol === 'https:' ? 443 : 80);
  const sock = await socksConnect(socksPort, u.hostname, port, timeoutS * 1000);
  return httpProbe(sock, target, timeoutS * 1000);
}

/* ==================== 队列构建 ==================== */
function buildQueue(servers) {
  const q = [];
  for (const sv of servers || []) {
    if (!sv.online && !sv.inbounds.length) continue;
    for (const ib of sv.inbounds || []) {
      for (const c of ib.clients || []) {
        q.push({
          key: sv.id + '|' + ib.id + '|' + c.email,
          svId: sv.id, svName: sv.name || sv.id, ip: sv.ip || (sv.url || '').replace(/^https?:\/\//, '').split(':')[0],
          ibId: ib.id, ibTag: ib.tag || ib.remark, port: ib.port, proto: ib.protocol || '',
          email: c.email, enabled: !!c.enable && ib.enable !== false,
          subId: (c.raw && c.raw.subId) || ''
        });
      }
    }
  }
  return q;
}

/* ==================== 测试任务 ==================== */
const job = { running: false, stop: false, done: 0, all: 0, pass: 0, fail: 0, skip: 0, lats: [], cur: '', error: '', results: {}, demo: false, xrayProc: null, tmpDir: '' };

function jobSnapshot() {
  return {
    running: job.running, done: job.done, all: job.all, pass: job.pass, fail: job.fail, skip: job.skip,
    avg: job.lats.length ? Math.round(job.lats.reduce((a, b) => a + b, 0) / job.lats.length) : null,
    cur: job.cur, error: job.error, demo: job.demo,
    results: job.results
  };
}

async function fetchLinks(queue) {
  // 按服务器分组取 subLinks；失败/无 subId 用本地兜底组装
  const bySv = {};
  queue.forEach(c => { (bySv[c.svId] = bySv[c.svId] || []).push(c); });
  for (const svId of Object.keys(bySv)) {
    const list = bySv[svId];
    const sv = (getCfg().servers || []).find(s => s.id === svId);
    if (!sv) { list.forEach(c => { c.link = ''; c.linkErr = '配置缺失'; }); continue; }
    const need = list.filter(c => c.subId);
    const CONC = 6;
    let idx = 0;
    const worker = async () => {
      while (idx < need.length) {
        const c = need[idx++];
        try {
          const r = await callPanel(sv, '/panel/api/clients/subLinks/' + encodeURIComponent(c.subId));
          const links = (r && r.success !== false && Array.isArray(r.obj)) ? r.obj : [];
          const hit = links.find(l => decodeURIComponent(l.split('#')[1] || '') === c.email) || links[0] || '';
          c.link = hit;
        } catch (e) { c.link = ''; }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONC, need.length || 1) }, worker));
  }
  queue.forEach(c => { if (!c.link) c.link = ''; });
  return queue;
}

async function runBatch(opts = {}) {
  if (job.running) return { ok: false, error: '已有测试在进行中' };
  const settings = { ...loadSettings(), ...opts };
  const target = effectiveTarget(settings);
  saveSettings({
    concurrency: settings.concurrency, timeout: settings.timeout,
    targetMode: settings.targetMode, customTarget: settings.customTarget
  });
  const demo = !!getCfg().demo;
  Object.assign(job, { running: true, stop: false, done: 0, all: 0, pass: 0, fail: 0, skip: 0, lats: [], cur: '', error: '', results: {}, demo });
  const runPromise = _run(settings, target, demo);
  runPromise.catch(e => { job.error = e.message; log('批量测试异常:', e.message); }).finally(() => { job.running = false; job.cur = ''; });
  return { ok: true };
}

async function _run(settings, target, demo) {
  const t0 = Date.now();
  const queue = buildQueue(stateGetter());
  let list = queue.filter(c => optsOnlyEnabled(settings) ? c.enabled : true);
  if (Array.isArray(settings.keys) && settings.keys.length) list = list.filter(c => settings.keys.includes(c.key));
  if (settings.limit) list.length = Math.min(list.length, settings.limit);
  job.all = list.length;
  if (!list.length) { job.error = '没有可测试的客户端'; return; }
  if (!target) { job.error = '自定义目标 URL 未填写'; return; }
  log(`拨测开始: ${list.length} 个客户端, 目标 ${target}, 并发 ${settings.concurrency}, 超时 ${settings.timeout}s${demo ? '（演示模拟）' : ''}`);

  // 结果先全部置 skip（未入选）/idle
  queue.forEach(c => { job.results[c.key] = { st: list.includes(c) ? 'idle' : 'skip', lat: null, err: '' }; });

  let links = null;
  if (!demo) {
    job.cur = '获取分享链接…';
    await fetchLinks(list);
  }

  // 启动引擎（演示模式跳过）
  let socksBase = 0;
  if (!demo) {
    job.cur = '准备 xray-core…';
    await ensureBin();
    const tmp = fs.mkdtempSync(path.join(ROOT, '.testrun-'));
    job.tmpDir = tmp;
    socksBase = 21000;
    const inbounds = [], outbounds = [], rules = [];
    const valid = [];
    list.forEach((c, i) => {
      const ob = linkToOutbound(c.link);
      if (!ob) { job.results[c.key] = { st: 'fail', lat: null, err: '分享链接无法解析' }; return; }
      const ti = 'ti' + i, oi = 'ob' + i;
      inbounds.push({ tag: ti, listen: '127.0.0.1', port: socksBase + i, protocol: 'socks', settings: { auth: 'noauth', udp: false } });
      outbounds.push({ ...ob, tag: oi });
      rules.push({ inboundTag: [ti], outboundTag: oi });
      valid.push({ c, socksPort: socksBase + i });
    });
    if (!valid.length) { job.error = '没有可解析的客户端链接'; fs.rmSync(tmp, { recursive: true, force: true }); return; }
    const config = { log: { loglevel: 'warning' }, inbounds, outbounds, routing: { domainStrategy: 'AsIs', rules } };
    fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(config));
    job.cur = '启动 xray-core…';
    await new Promise((resolve, reject) => {
      const p = spawn(BIN_PATH(), ['run', '-c', 'config.json'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
      job.xrayProc = p;
      let errBuf = '';
      p.stderr.on('data', d => { errBuf += d; if (errBuf.length > 4000) errBuf = errBuf.slice(-4000); });
      const to = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('xray 启动超时')); }, 10000);
      // 就绪判定：轮询第一个 socks 端口
      const tryConn = async (n) => {
        if (job.stop) { clearTimeout(to); return resolve(); }
        try { const s = await socksConnect(valid[0].socksPort, 'example.com', 80, 800); s.destroy(); clearTimeout(to); resolve(); }
        catch (e) {
          if (p.exitCode !== null) { clearTimeout(to); return reject(new Error('xray 启动失败: ' + errBuf.slice(-300))); }
          if (n <= 0) { clearTimeout(to); return reject(new Error('xray 就绪检测超时: ' + errBuf.slice(-300))); }
          setTimeout(() => tryConn(n - 1), 300);
        }
      };
      p.on('exit', code => { if (code !== null && code !== 0) { clearTimeout(to); reject(new Error('xray 启动失败(code ' + code + '): ' + errBuf.slice(-300))); } });
      tryConn(10);
    });
  }

  // 并发拨测
  const testList = demo ? list.map(c => ({ c, socksPort: 0 })) : list.filter(c => job.results[c.key].st !== 'fail').map(c => ({ c, socksPort: socksBase + list.indexOf(c) }));
  let idx = 0;
  const CONC = Math.max(1, Math.min(50, settings.concurrency || 10));
  const worker = async () => {
    while (idx < testList.length) {
      if (job.stop) return;
      const { c, socksPort } = testList[idx++];
      job.cur = `${c.svName} · ${c.email}`;
      if (demo) {
        await new Promise(r2 => setTimeout(r2, 250 + Math.random() * 700));
        if (Math.random() < 0.12) job.results[c.key] = { st: 'fail', lat: null, err: ['连接超时', 'Reality 握手失败', '连接被拒绝'][Math.floor(Math.random() * 3)] };
        else job.results[c.key] = { st: 'pass', lat: 80 + Math.floor(Math.random() * 380), err: '' };
      } else {
        try {
          const r = await probeOne(socksPort, target, settings.timeout || 8);
          job.results[c.key] = { st: 'pass', lat: r.latency, err: '' };
        } catch (e) {
          job.results[c.key] = { st: 'fail', lat: null, err: String(e.message || e) };
        }
      }
      const rs = job.results[c.key];
      job.done++;
      if (rs.st === 'pass') { job.pass++; job.lats.push(rs.lat); } else if (rs.st === 'fail') job.fail++; else job.skip++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONC, testList.length) }, worker));

  // 清理
  if (job.xrayProc) { try { job.xrayProc.kill('SIGTERM'); } catch (e) {} setTimeout(() => { try { job.xrayProc.kill('SIGKILL'); } catch (e) {} }, 2000); job.xrayProc = null; }
  if (job.tmpDir) { try { fs.rmSync(job.tmpDir, { recursive: true, force: true }); } catch (e) {} job.tmpDir = ''; }
  if (job.stop) list.forEach(c => { if (job.results[c.key] && job.results[c.key].st === 'idle') job.results[c.key].st = 'skip'; });

  // 写历史
  const avg = job.lats.length ? Math.round(job.lats.reduce((a, b) => a + b, 0) / job.lats.length) : 0;
  const rec = { time: new Date().toISOString(), total: job.done, pass: job.pass, fail: job.fail, skip: job.skip, avg, demo, aborted: job.stop, durationS: Math.round((Date.now() - t0) / 1000) };
  try {
    fs.appendFileSync(HIST_FILE(), JSON.stringify(rec) + '\n');
    trimHistory();
  } catch (e) { log('历史写入失败:', e.message); }
  log(`拨测完成: ${rec.pass} 通 / ${rec.fail} 失败 / ${rec.skip} 跳过, 平均 ${avg}ms`);
  if (settings.scheduleEnabled) saveSettings({ nextRunAt: Date.now() + (settings.scheduleMinutes || 30) * 60000 });
}

function stateGetter() { return typeof _state === 'function' ? _state() : []; }
let _state = () => [];
function setStateGetter(fn) { _state = fn; }
function optsOnlyEnabled(s) { return s.onlyEnabled !== false; }

function stopJob() { if (job.running) { job.stop = true; log('收到停止指令'); return true; } return false; }

/* ==================== 历史 ==================== */
function trimHistory() {
  try {
    const txt = fs.readFileSync(HIST_FILE(), 'utf8').trim();
    if (!txt) return;
    const lines = txt.split('\n');
    if (lines.length > 200) fs.writeFileSync(HIST_FILE(), lines.slice(-100).join('\n') + '\n');
  } catch (e) {}
}
function history(n = 30) {
  try {
    const lines = fs.readFileSync(HIST_FILE(), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean).reverse();
  } catch (e) { return []; }
}

/* ==================== 定时调度 ==================== */
let schedTimer = null;
function initScheduler(triggerRun) {
  if (schedTimer) clearInterval(schedTimer);
  schedTimer = setInterval(() => {
    const s = loadSettings();
    if (!s.scheduleEnabled || !s.nextRunAt) return;
    if (Date.now() >= s.nextRunAt) {
      if (job.running) { saveSettings({ nextRunAt: Date.now() + 60000 }); return; }
      log('定时拨测触发');
      saveSettings({ nextRunAt: Date.now() + (s.scheduleMinutes || 30) * 60000 });
      triggerRun();
    }
  }, 10000);
}

module.exports = { init, setStateGetter, binStatus, downloadBin, runBatch, stopJob, jobSnapshot, history, loadSettings, saveSettings, effectiveTarget, buildQueue, initScheduler };
