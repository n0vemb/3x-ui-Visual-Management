#!/usr/bin/env node
/**
 * 3x-ui 管理器后端（零依赖，Node >= 18）
 *
 * 职责：
 *  1. 轮询各服务器上的 3x-ui 面板 API（登录会话 / API Token 二选一）
 *     - 入站+客户端：GET /panel/api/inbounds/list
 *     - 在线客户端：GET /panel/api/inbounds/onlines（不可用则降级为离线）
 *     - 服务器状态：GET /panel/api/server/status（老版本降级 /server/status）
 *     - 出站+绑定：GET /panel/api/server/getConfigJson（老版本降级 getOutboundsTraffic）
 *  2. 出站 IP 地理位置查询（ip-api.com 批量接口，本地缓存 geo_cache.json）
 *  3. 对前端提供统一快照：GET /api/data（可选 ?refresh=1 强制刷新）
 *
 * 安全：如设置了 config.json 的 dashboardKey，前端需携带 X-Dash-Key 头访问 /api/*
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const CFG_FILE = path.join(ROOT, 'config.json');
const GEO_FILE = path.join(ROOT, 'geo_cache.json');

function readJSON(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }
function writeJSON(f, d) { try { fs.writeFileSync(f, JSON.stringify(d, null, 2)); } catch (e) { console.error('[io] 写文件失败', f, e.message); } }

let cfg = readJSON(CFG_FILE) || { port: 8787, demo: true, servers: [] };
let cfgMtime = 0;
try { cfgMtime = fs.statSync(CFG_FILE).mtimeMs; } catch (e) {}

// config.json 热更新：改完保存即生效，不用重启
setInterval(() => {
  try {
    const m = fs.statSync(CFG_FILE).mtimeMs;
    if (m !== cfgMtime) {
      cfgMtime = m;
      const next = readJSON(CFG_FILE);
      if (next) { cfg = next; console.log('[config] 检测到修改，已热更新'); }
    }
  } catch (e) {}
}, 5000);

/* ==================== 底层 HTTP 请求 ==================== */

function req(url, { method = 'GET', headers = {}, body = null, timeout = 12000, insecure = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const h = { ...headers };
    let data = null;
    if (body != null) {
      data = typeof body === 'string' ? body : JSON.stringify(body);
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = mod.request(u, { method, headers: h, rejectUnauthorized: !insecure, timeout }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; if (buf.length > 20 * 1024 * 1024) r.destroy(new Error('响应过大')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf }));
    });
    r.on('timeout', () => r.destroy(new Error('请求超时')));
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

/* ==================== 面板会话管理 ==================== */

const sessions = {}; // server.id -> { cookie }

async function login(sv) {
  const res = await req(sv.url.replace(/\/+$/, '') + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: { username: sv.username, password: sv.password },
    insecure: !!sv.insecure,
    timeout: sv.timeout || 12000
  });
  const sc = res.headers['set-cookie'] || [];
  const cookie = sc.map(s => s.split(';')[0]).join('; ');
  if (!cookie) throw new Error('登录失败：未返回会话 Cookie（检查用户名/密码/面板地址）');
  let ok = true;
  try { ok = JSON.parse(res.text).success !== false; } catch (e) {}
  if (!ok) throw new Error('登录被拒绝：用户名或密码错误');
  sessions[sv.id] = { cookie, ts: Date.now() };
}

async function callPanel(sv, apiPath, { method = 'GET', retry = true } = {}) {
  const headers = { 'Accept': 'application/json' };
  if (sv.token) {
    headers.Authorization = 'Bearer ' + sv.token;
  } else if (sessions[sv.id]) {
    headers.Cookie = sessions[sv.id].cookie;
  }
  let res;
  try {
    res = await req(sv.url.replace(/\/+$/, '') + apiPath, { method, headers, insecure: !!sv.insecure, timeout: sv.timeout || 12000 });
  } catch (e) {
    throw new Error('连接失败: ' + e.message);
  }
  if (res.status === 401 && retry && !sv.token) {
    await login(sv);
    return callPanel(sv, apiPath, { method, retry: false });
  }
  if (res.status !== 200) {
    const e = new Error('HTTP ' + res.status + ' ' + apiPath);
    e.status = res.status;
    throw e;
  }
  try { return JSON.parse(res.text); } catch (e) { throw new Error('响应不是 JSON（检查面板地址是否正确）'); }
}

/* ==================== 数据归一化 ==================== */

function normInbound(ib) {
  // 原始 settings / streamSettings 解析后透传：新建客户端、复制分享链接都需要
  let settings = null, stream = null, sniffing = null;
  try { settings = typeof ib.settings === 'string' ? JSON.parse(ib.settings) : ib.settings; } catch (e) {}
  try { stream = typeof ib.streamSettings === 'string' ? JSON.parse(ib.streamSettings) : ib.streamSettings; } catch (e) {}
  try { sniffing = typeof ib.sniffing === 'string' ? JSON.parse(ib.sniffing) : ib.sniffing; } catch (e) {}
  const setClients = (settings && settings.clients) || [];
  const stats = ib.clientStats || [];
  const seen = new Set();
  const clients = setClients.map(sc => {
    seen.add(sc.email);
    const st = stats.find(x => x.email === sc.email) || {};
    return {
      email: sc.email,
      enable: st.enable !== undefined ? !!st.enable : (sc.enable !== false),
      up: st.up || 0,
      down: st.down || 0,
      total: st.total || 0,
      expiryTime: st.expiryTime || 0,
      raw: sc || {}   // 原始客户端对象（id/flow/subId/limitIp/password/method...）
    };
  });
  // clientStats 是流量计数器，客户端删除后残留的统计项还在——只在 settings.clients 为空时才兜底，
  // 否则会把已删除的客户端也算进来（面板 1 个客户端、看板显示 6 个的根因）
  if (!setClients.length) {
    stats.forEach(st => {
      if (!st.email || seen.has(st.email)) return;
      seen.add(st.email);
      clients.push({ email: st.email, enable: st.enable !== false, up: st.up || 0, down: st.down || 0, total: st.total || 0, expiryTime: st.expiryTime || 0, raw: {} });
    });
  }
  return {
    id: ib.id,
    tag: ib.tag || '',
    remark: ib.remark || ib.tag || ('入站#' + ib.id),
    port: ib.port,
    listen: ib.listen || '',
    protocol: ib.protocol || '',
    enable: ib.enable !== false,
    up: ib.up || 0,
    down: ib.down || 0,
    total: ib.total || 0,
    expiryTime: ib.expiryTime || 0,
    settings, stream, sniffing,
    clients
  };
}

function normSys(st) {
  if (!st) return null;
  const s = st.obj && typeof st.obj === 'object' ? st.obj : st;
  const cpuRaw = s.cpu;
  let cpu = null;
  if (typeof cpuRaw === 'number') cpu = Math.round(cpuRaw);
  else if (cpuRaw && typeof cpuRaw === 'object') {
    if (typeof cpuRaw.usage === 'number') cpu = Math.round(cpuRaw.usage);
    else if (typeof cpuRaw.percent === 'number') cpu = Math.round(cpuRaw.percent);
  }
  const mem = (s.mem && s.mem.total) ? Math.round(s.mem.current / s.mem.total * 100) : null;
  return {
    cpu,
    mem,
    uptime: s.uptime || null,
    tcp: s.tcpConnCount != null ? s.tcpConnCount : null,
    udp: s.udpConnCount != null ? s.udpConnCount : null,
    xray: (s.xray && s.xray.state) || null
  };
}

/* ==================== 绑定推导 ==================== */

// 从 Xray 运行配置的路由规则推导 入站tag → 出站tag
function deriveBindings(xout, obList) {
  const bindings = {};
  if (!xout || !xout.routing) return bindings;
  // balancer 负载均衡：tag → selector（出站 tag 前缀列表）
  const balancers = {};
  (xout.routing.balancers || []).forEach(b => { if (b && b.tag) balancers[b.tag] = b.selector || []; });
  (xout.routing.rules || []).forEach(rule => {
    if (!rule) return;
    // 关键：Xray 字段是 outboundTag（不是 outbound）
    let ob = rule.outboundTag || rule.outbound || '';
    if (!ob && rule.balancerTag) {
      const sels = balancers[rule.balancerTag] || [];
      ob = obList.map(o => o.tag)
        .filter(t => !/^(direct|block|api|dns)/i.test(t)) // 排除内置出站
        .find(t => sels.some(sel => t.startsWith(sel))) || '';
    }
    if (!ob) return;
    // inboundTag：按入站 tag 匹配
    let ibs = rule.inboundTag;
    if (typeof ibs === 'string') ibs = [ibs]; // 容错：有的配置写成字符串
    if (Array.isArray(ibs)) ibs.forEach(t => { if (!bindings[t]) bindings[t] = ob; });
    // user：按客户端 email 匹配（客户端级路由，入站列表里没有对应的 key）
    let us = rule.user;
    if (typeof us === 'string') us = [us];
    if (Array.isArray(us)) us.forEach(u => { if (u && !bindings[u]) bindings[u] = ob; });
  });
  return bindings;
}

// 提取字符串中的 IPv4（如 "socks5-204.1.113.134" → "204.1.113.134"）
function ipIn(s) {
  const m = String(s || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  return m ? m[0] : '';
}

// 命名约定兜底：入站备注/tag/客户端email = 出站标识
// 1) 精确等于出站 tag（如 "yangjin" / "YJ430" / "socks5-RS2093038..."）
// 2) 双方含同一个 IP（备注 "204.1.113.134" ↔ tag "socks5-204.1.113.134" / 出站 ip 字段）
function matchOutboundByName(ib, obList) {
  const cands = [ib.remark, ib.tag, ...(ib.clients || []).map(c => c.email)].filter(Boolean);
  for (const c of cands) {
    const hit = obList.find(o => o.tag === c);
    if (hit) return hit.tag;
  }
  for (const c of cands) {
    const ip = ipIn(c);
    if (!ip) continue;
    const hit = obList.find(o => o.tag !== c && ipIn(o.tag) === ip)
            || obList.find(o => (o.ip || '').split(':')[0] === ip);
    if (hit) return hit.tag;
  }
  return null;
}

/* ==================== 单服务器轮询 ==================== */

async function pollServer(sv) {
  const out = {
    id: sv.id, name: sv.name || sv.id, url: sv.url || '',
    online: true, lastUpdate: Date.now(), lastError: '',
    sys: null, outbounds: [], bindings: [], inbounds: []
  };

  // --- 服务器状态 ---
  for (const p of ['/panel/api/server/status', '/server/status']) {
    try {
      const r = await callPanel(sv, p);
      out.sys = normSys(r);
      break;
    } catch (e) {
      if (e.status === 404) continue; // 老版本没有新路径，试下一个
      throw e;
    }
  }

  // --- 入站 + 客户端 ---
  const list = await callPanel(sv, '/panel/api/inbounds/list');
  const arr = (list && list.obj) || [];
  out.inbounds = arr.map(normInbound);

  // --- 在线客户端（拿不到就全部视为离线，不阻塞其他数据）---
  let onlineSet = null;
  for (const [m, p] of [['GET', '/panel/api/inbounds/onlines'], ['POST', '/panel/api/inbounds/onlines']]) {
    try {
      const r = await callPanel(sv, p, { method: m });
      if (r && Array.isArray(r.obj)) { onlineSet = new Set(r.obj); break; }
    } catch (e) {}
  }
  if (onlineSet) {
    out.inbounds.forEach(ib => ib.clients.forEach(c => { c.online = onlineSet.has(c.email); }));
  } else {
    out.inbounds.forEach(ib => ib.clients.forEach(c => { c.online = false; }));
  }

  // --- Xray 运行配置（出站列表 + 路由规则 → 入站/出站绑定）---
  let xout = null;
  try {
    const cj = await callPanel(sv, '/panel/api/server/getConfigJson');
    let s = cj && cj.obj;
    if (typeof s === 'string') s = JSON.parse(s);
    xout = s;
  } catch (e) {}

  let obTraffic = null;
  if (!xout) {
    try {
      const r = await callPanel(sv, '/panel/api/xray/getOutboundsTraffic');
      obTraffic = (r && r.obj) || [];
    } catch (e) {}
  }

  const obList = [];
  if (xout && Array.isArray(xout.outbounds)) {
    xout.outbounds.forEach(o => {
      if (!o || !o.tag) return;
      let ip = '', port = null;
      const servers = o.settings && o.settings.servers;
      if (Array.isArray(servers) && servers[0]) {
        ip = servers[0].address || '';
        port = servers[0].port || null;
      }
      let proto = o.protocol || '';
      if (o.tag === 'direct' || o.protocol === 'freedom') proto = 'direct';
      if (o.tag === 'block' || o.tag === 'blocked' || o.protocol === 'blackhole') proto = 'block';
      if (o.protocol === 'wireguard') proto = 'wireguard';
      obList.push({ tag: o.tag, ip, port, proto, enabled: true, source: 'xray', up: 0, down: 0, total: 0 });
    });
  }
  if (obTraffic) {
    (Array.isArray(obTraffic) ? obTraffic : []).forEach(t => {
      if (!t || !t.tag) return;
      let ex = obList.find(o => o.tag === t.tag);
      if (!ex) { ex = { tag: t.tag, ip: '', port: null, proto: 'manual', enabled: true, source: 'traffic', up: 0, down: 0, total: 0 }; obList.push(ex); }
      ex.up = t.up || 0; ex.down = t.down || 0; ex.total = t.total || 0;
    });
  }
  // config.json 手工配置的出站：补充 / 覆盖（ip:port、启停），这是老版本面板唯一可靠的出站信息来源
  (sv.outbounds || []).forEach(m => {
    if (!m || !m.tag) return;
    const ex = obList.find(o => o.tag === m.tag);
    if (ex) {
      if (m.ip != null) ex.ip = m.ip;
      if (m.port != null) ex.port = m.port;
      if (m.proto) ex.proto = m.proto;
      if (m.enabled !== undefined) ex.enabled = !!m.enabled;
      ex.manual = true;
    } else {
      obList.push({ tag: m.tag, ip: m.ip || '', port: m.port || null, proto: m.proto || 'manual', enabled: m.enabled !== false, source: 'manual', up: 0, down: 0, total: 0, manual: true });
    }
  });
  out.outbounds = obList;

  // --- 绑定关系：路由规则推导 + 命名约定兜底，config.json 手工映射优先 ---
  const bindings = deriveBindings(xout, obList);
  Object.entries(sv.bindings || {}).forEach(([k, v]) => { bindings[k] = v; });

  let unmatched = 0;
  out.inbounds.forEach(ib => {
    let obTag = bindings[ib.tag] || bindings[ib.remark] || bindings[String(ib.id)] || null;
    // 路由规则按 user（客户端 email）匹配的：任一客户端命中即视为该入站绑定
    if (!obTag) {
      const cl = (ib.clients || []).find(c => c.email && bindings[c.email]);
      if (cl) obTag = bindings[cl.email];
    }
    let src = obTag ? 'rule' : '';
    if (!obTag) { obTag = matchOutboundByName(ib, obList); src = obTag ? 'name' : ''; }
    if (obTag && !obList.find(o => o.tag === obTag)) { obTag = null; src = ''; } // 出站不存在，视为未匹配
    ib.ob = obTag;
    ib.obFrom = src;
    if (!obTag) unmatched++;
  });
  out.bindings = Object.entries(bindings).map(([inb, ob]) => ({ inbound: inb, outbound: ob }));
  if (!xout) out.lastError = out.lastError || '未获取到 Xray 运行配置（getConfigJson 不可用），仅靠命名约定匹配绑定';
  else if (unmatched > 0) out.lastError = out.lastError || `${unmatched} 个入站未能匹配出站（路由规则与命名约定都没命中），可在「服务器管理→编辑」手工补 bindings`;

  return out;
}

/* ==================== IP 地理位置查询 ==================== */

let geo = readJSON(GEO_FILE) || {};

function flagOf(cc) {
  if (!cc || cc.length !== 2) return '🛰️';
  return String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0)));
}

async function geoLookup(ips) {
  const now = Date.now();
  const ttl = (cfg.geoTTLHours || 168) * 3600 * 1000;
  const need = [...new Set(ips.filter(Boolean))].filter(ip => !geo[ip] || now - (geo[ip].ts || 0) > ttl);
  if (!need.length) return;
  for (let i = 0; i < need.length; i += 100) {
    const batch = need.slice(i, i + 100);
    try {
      const res = await req('http://ip-api.com/batch?fields=status,message,country,countryCode,query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
        timeout: 15000
      });
      const arr = JSON.parse(res.text);
      arr.forEach(r => {
        if (r && r.query) geo[r.query] = { cc: r.countryCode || '', country: r.country || '', ts: Date.now() };
      });
      console.log('[geo] 已查询', batch.length, '个 IP');
    } catch (e) {
      console.error('[geo] 查询失败:', e.message);
    }
  }
  writeJSON(GEO_FILE, geo);
}

/* ==================== 演示数据（demo=true 时使用，形状与真实快照完全一致）==================== */

function demoData() {
  const now = Date.now();
  const GB = 1024 ** 3;
  const cl = (email, usedGB, totalGB, online, days, enable = true) => {
    const used = Math.round(usedGB * GB);
    const total = totalGB == null ? 0 : Math.round(totalGB * GB);
    return { email, enable, up: Math.round(used * 0.3), down: used - Math.round(used * 0.3), total, expiryTime: days == null ? 0 : now + days * 864e5, online,
      raw: { id: 'demo-' + Math.random().toString(16).slice(2, 10) + '-' + Math.random().toString(16).slice(2, 6), flow: '' } };
  };
  const mkSv = (id, name, outbounds, inbounds, sys) => ({ id, name, online: true, lastUpdate: now, lastError: '', sys, outbounds, bindings: [], inbounds });
  const ob = (tag, ip, proto, enabled, flag, cc, country) => ({ tag, ip, port: null, proto, enabled, source: 'manual', flag, cc, country, up: 0, down: 0, total: 0 });
  return [
    mkSv('us', '美国 · 45.119.4.207', [
      ob('204.170.138', '204.170.138:9467', 'socks', true, '🇺🇸', 'US', 'United States'),
      ob('yangjin', '204.164.51:9428', 'socks', true, '🇺🇸', 'US', 'United States'),
      ob('YJ430', '204.164.96:9428', 'socks', false, '🇯🇵', 'JP', 'Japan')
    ], [
      { id: 1, tag: 'in-1', remark: '包子', port: 50145, protocol: 'vless', enable: true, ob: '204.170.138', clients: [cl('4shlfmml', 575.59, 600, false, 32), cl('a2317f5m', 222.57, 300, true, 12), cl('t3h0kvnxq', 0.18, 50, false, 0, false), cl('wb4d8jdq', 37.10, 300, false, 88)] },
      { id: 2, tag: 'in-2', remark: '2026.5.7', port: 21102, protocol: 'vless', enable: true, ob: 'yangjin', clients: [cl('YJM1', 197.77, 300, true, 45), cl('tia6u7mm', 261.62, 260, false, 0), cl('126', 215.41, 300, false, 7)] },
      { id: 3, tag: 'in-3', remark: 'tia6u7mm', port: 10311, protocol: 'vless', enable: true, ob: '204.170.138', clients: [cl('w9k2m4', 88.20, 200, true, 60), cl('p3x8q1', 12.40, 100, false, 21), cl('z7t5n2', 45.90, 100, true, 8)] },
      { id: 4, tag: 'in-4', remark: '0829-113.4', port: 22881, protocol: 'vless', enable: true, ob: '204.170.138', clients: [cl('m8d3k9', 133.60, 300, true, 90), cl('q4w7j1', 56.20, 100, false, 40)] },
      { id: 5, tag: 'in-5', remark: '070712-10.82', port: 18022, protocol: 'vless', enable: true, ob: '204.170.138', clients: [cl('hh12', 210.40, 300, true, 15), cl('gg34', 3.20, 100, false, 2), cl('kk56', 99.80, 100, true, 33), cl('mm78', 300.00, 299, false, 0)] },
      { id: 6, tag: 'in-6', remark: 'zp 27', port: 50220, protocol: 'vless', enable: true, ob: 'yangjin', clients: [cl('zx41', 66.60, 100, true, 51), cl('cv23', 21.00, 100, false, 77)] },
      { id: 7, tag: 'in-7', remark: 'din', port: 19953, protocol: 'vless', enable: false, ob: '204.170.138', clients: [cl('lone', 8.80, 100, false, 12, false)] },
      { id: 8, tag: 'in-8', remark: '0520Y', port: 31200, protocol: 'vless', enable: true, ob: '204.170.138', clients: [cl('yy01', 45.00, 100, true, 5), cl('yy02', 78.00, 100, false, 26), cl('yy03', 12.10, 100, true, 44)] },
      { id: 9, tag: 'in-9', remark: '204.164.95', port: 9428, protocol: 'vless', enable: true, ob: 'yangjin', clients: [cl('ab12', 154.30, 300, true, 61), cl('cd34', 9.90, 100, false, 18)] },
      { id: 10, tag: 'in-10', remark: '2026-05-24', port: 12044, protocol: 'vless', enable: true, ob: '204.170.138', clients: [cl('ef56', 77.70, 100, true, 29), cl('gh78', 14.50, 100, false, 63), cl('ij90', 201.10, 300, true, 9)] },
      { id: 11, tag: 'in-11', remark: '0606-113.6', port: 24601, protocol: 'vless', enable: true, ob: 'yangjin', clients: [cl('f1x9', 31.60, 100, true, 70)] },
      { id: 12, tag: 'in-12', remark: '70c454cc', port: 30211, protocol: 'vless', enable: true, ob: '204.170.138', clients: [cl('kl12', 44.00, 100, false, 36), cl('mn34', 122.80, 300, true, 19), cl('op56', 9.30, 100, true, 50)] },
      { id: 13, tag: 'in-13', remark: '204.164.96', port: 9871, protocol: 'vless', enable: true, ob: 'yangjin', clients: [cl('qr78', 64.20, 100, true, 41), cl('st90', 250.00, 249, false, 0)] },
      { id: 14, tag: 'in-14', remark: '0712-10.82', port: 11800, protocol: 'vless', enable: true, ob: 'yangjin', clients: [cl('uv12', 180.50, 300, true, 22), cl('wx34', 7.70, 100, false, 84), cl('yz56', 55.00, 100, true, 3), cl('aa78', 96.40, 200, true, 47)] }
    ], { cpu: 23, mem: 61, uptime: 86400 * 12 + 3600 * 5, tcp: 214, udp: 38, xray: 'running' }),
    mkSv('hk1', '香港1 · 38.90.4.31', [
      ob('hkg-out-01', '103.42.18.7:8443', 'socks', true, '🇭🇰', 'HK', 'Hong Kong'),
      ob('hkg-backup', '103.42.18.9:8443', 'socks', false, '🇭🇰', 'HK', 'Hong Kong')
    ], [
      { id: 1, tag: 'hkg-main', remark: 'hkg-主力', port: 443, protocol: 'vless', enable: true, ob: 'hkg-out-01', clients: [cl('hkMain', 412.30, 500, true, 120), cl('hkSub', 88.10, 100, false, 60)] },
      { id: 2, tag: 'hkg-bak', remark: 'hkg-备用', port: 8443, protocol: 'vless', enable: true, ob: 'hkg-out-01', clients: [cl('bk01', 52.60, 100, true, 90)] },
      { id: 3, tag: 'hkg-tst', remark: 'hkg-测试', port: 2053, protocol: 'vless', enable: true, ob: 'hkg-out-01', clients: [cl('test1', 3.80, 20, true, 14), cl('test2', 50.00, 49, false, 0)] },
      { id: 4, tag: 'hkg-relay', remark: 'hkg-中转', port: 2087, protocol: 'vless', enable: true, ob: 'hkg-out-01', clients: [cl('relay1', 240.10, 300, true, 75), cl('relay2', 19.40, 100, false, 30), cl('relay3', 66.90, 100, true, 11)] },
      { id: 5, tag: 'hkg-old', remark: 'hkg-退役', port: 2096, protocol: 'vless', enable: false, ob: 'hkg-backup', clients: [cl('old1', 512.00, 500, false, 0, false)] },
      { id: 6, tag: 'hkg-live', remark: 'hkg-直播', port: 2083, protocol: 'vless', enable: true, ob: 'hkg-out-01', clients: [cl('live1', 780.40, 1000, true, 45), cl('live2', 301.20, 500, true, 45)] }
    ], { cpu: 12, mem: 44, uptime: 86400 * 30, tcp: 96, udp: 12, xray: 'running' }),
    mkSv('hk2', '香港2 · 38.90.4.10', [
      ob('hkg2-out', '38.90.4.10:9467', 'socks', true, '🇭🇰', 'HK', 'Hong Kong')
    ], [
      { id: 1, tag: 'hkg2-vless', remark: 'hkg2-vless', port: 50145, protocol: 'vless', enable: true, ob: 'hkg2-out', clients: [cl('sl5Om9rPKo', 1228.80, 2000, true, 200), cl('guest01', 8.60, 50, false, 30)] },
      { id: 2, tag: 'hkg2-reality', remark: 'hkg2-reality', port: 21102, protocol: 'vless', enable: true, ob: 'hkg2-out', clients: [cl('r1', 96.40, 200, true, 88), cl('r2', 44.20, 100, true, 88), cl('r3', 2.10, 50, false, 12)] },
      { id: 3, tag: 'hkg2-ws', remark: 'hkg2-ws', port: 50220, protocol: 'vless', enable: true, ob: 'hkg2-out', clients: [cl('ws1', 152.70, 300, true, 25)] },
      { id: 4, tag: 'hkg2-grpc', remark: 'hkg2-grpc', port: 50221, protocol: 'vless', enable: true, ob: 'hkg2-out', clients: [cl('g1', 31.00, 100, false, 52), cl('g2', 100.00, 99, false, 0)] },
      { id: 5, tag: 'hkg2-dbg', remark: 'hkg2-调试', port: 50222, protocol: 'vless', enable: false, ob: 'hkg2-out', clients: [cl('dbg', 0, 10, false, 5, false)] }
    ], { cpu: 41, mem: 72, uptime: 86400 * 3 + 7200, tcp: 168, udp: 26, xray: 'running' })
  ];
}

/* ==================== 全局刷新循环 ==================== */

const state = { demo: null, generatedAt: 0, servers: [] };

async function refresh() {
  try {
    if (cfg.demo) {
      state.demo = true;
      state.generatedAt = Date.now();
      state.servers = demoData();
      return;
    }
    state.demo = false;
    const enabled = (cfg.servers || []).filter(s => s && s.id && s.enabled !== false && s.url && !/面板端口/.test(s.url));
    const skipped = (cfg.servers || []).filter(s => s && s.enabled !== false && (!s.url || /面板端口/.test(s.url)));
    const results = await Promise.all(enabled.map(async sv => {
      try {
        const r = await pollServer(sv);
        const ips = r.outbounds.map(o => o.ip).filter(Boolean);
        await geoLookup(ips);
        r.outbounds.forEach(o => {
          const g = geo[o.ip];
          if (g) { o.cc = g.cc; o.country = g.country; o.flag = flagOf(g.cc); }
        });
        return r;
      } catch (e) {
        console.error(`[poll] ${sv.id} 拉取失败:`, e.message);
        return { id: sv.id, name: sv.name || sv.id, url: sv.url || '', online: false, lastUpdate: Date.now(), lastError: e.message, sys: null, outbounds: [], bindings: [], inbounds: [] };
      }
    }));
    // 未配置完整的服务器也显示出来（灰点提示），方便发现配置遗漏
    skipped.forEach(sv => results.push({
      id: sv.id, name: sv.name || sv.id, url: sv.url || '', online: false,
      lastUpdate: 0, lastError: 'config.json 未填完整（url 中含占位符）或未启用',
      sys: null, outbounds: [], bindings: [], inbounds: []
    }));
    state.servers = results;
    state.generatedAt = Date.now();
  } catch (e) {
    console.error('[refresh] 异常:', e.message);
  }
}

/* ==================== 对外 HTTP 服务 ==================== */

const PORT = cfg.port || 8787;

function authOK(req2) {
  if (!cfg.dashboardKey) return true;
  const key = req2.headers['x-dash-key'] || new URL(req2.url, 'http://x').searchParams.get('key') || '';
  return key === cfg.dashboardKey;
}

// 读取并解析 POST JSON body（上限 1MB）
function readBody(req2) {
  return new Promise(resolve => {
    let buf = '';
    req2.on('data', c => { buf += c; if (buf.length > 1024 * 1024) { req2.destroy(); resolve(null); } });
    req2.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch (e) { resolve(null); } });
    req2.on('error', () => resolve(null));
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

http.createServer(async (req2, res) => {
  const u = new URL(req2.url, 'http://x');
  if (u.pathname === '/api/data' || u.pathname === '/api/refresh') {
    if (!authOK(req2)) { res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('unauthorized'); }
    if (u.pathname === '/api/refresh' || u.searchParams.get('refresh') === '1') await refresh();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(state));
  }

  // ===== 服务器管理（Web 页面直接增删改，无需编辑 config.json）=====
  if (u.pathname === '/api/settings' && req2.method === 'GET') {
    if (!authOK(req2)) { res.writeHead(401); return res.end('unauthorized'); }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    // 账密/Token 不下发前端，只返回"是否已保存"标记
    return res.end(JSON.stringify({
      demo: !!cfg.demo,
      pollInterval: cfg.pollInterval || 20,
      hasKey: !!cfg.dashboardKey,
      servers: (cfg.servers || []).map(s => ({
        id: s.id, name: s.name || s.id, url: s.url || '', username: s.username || '',
        insecure: !!s.insecure, enabled: s.enabled !== false,
        hasPassword: !!s.password, hasToken: !!s.token
      }))
    }));
  }
  if (u.pathname === '/api/settings' && req2.method === 'POST') {
    if (!authOK(req2)) { res.writeHead(401); return res.end('unauthorized'); }
    const body = await readBody(req2);
    if (!body) { res.writeHead(400); return res.end('bad json'); }
    try {
      if (Array.isArray(body.servers)) {
        const oldMap = {};
        (cfg.servers || []).forEach(s => { oldMap[s.id] = s; });
        cfg.servers = body.servers
          .filter(s => s && s.id && s.url)
          .map(s => {
            const old = oldMap[s.id] || {};
            return {
              id: String(s.id), name: s.name || s.id, url: String(s.url).trim(),
              username: s.username || '', password: s.password || old.password || '',
              token: s.token || old.token || '',
              insecure: !!s.insecure, enabled: s.enabled !== false,
              outbounds: old.outbounds || s.outbounds || [],
              bindings: old.bindings || s.bindings || {}
            };
          });
      }
      if (typeof body.demo === 'boolean') cfg.demo = body.demo;
      // 管理器访问密码：Web 弹窗直接设置/清除
      if (typeof body.dashboardKey === 'string' && body.dashboardKey.trim()) cfg.dashboardKey = body.dashboardKey.trim();
      if (body.clearKey === true) delete cfg.dashboardKey;
      writeJSON(CFG_FILE, cfg);
      try { cfgMtime = fs.statSync(CFG_FILE).mtimeMs; } catch (e) {}
      console.log('[settings] 服务器配置已更新（Web），共', (cfg.servers || []).length, '台');
      await refresh();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  if (u.pathname === '/api/test' && req2.method === 'POST') {
    if (!authOK(req2)) { res.writeHead(401); return res.end('unauthorized'); }
    const body = await readBody(req2);
    if (!body || !body.server || !body.server.url) { res.writeHead(400); return res.end('bad request'); }
    const s = body.server;
    // 密码/Token 留空 = 沿用已保存的（按 id 匹配）
    const old = (cfg.servers || []).find(o => o.id === s.id) || {};
    const sv = {
      id: s.id || '__test__', name: s.name || s.id, url: String(s.url).trim(),
      username: s.username || '', password: s.password || old.password || '',
      token: s.token || old.token || '', insecure: !!s.insecure, timeout: 8000
    };
    try {
      if (!sv.token && (!sv.username || !sv.password)) throw new Error('请填写用户名密码，或使用 API Token');
      const r = await callPanel(sv, '/panel/api/inbounds/list');
      const n = r && Array.isArray(r.obj) ? r.obj.length : 0;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, inbounds: n }));
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }
  /* ==================== 面板写操作代理（新建入站/客户端、路由规则、开关）==================== */

  const actM = u.pathname.match(/^\/api\/act\/([^/]+)\/(.+)$/);
  if (actM && req2.method === 'POST') {
    if (!authOK(req2)) { res.writeHead(401); return res.end('unauthorized'); }
    // 演示模式：模拟成功，不触碰任何面板
    if (cfg.demo) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ ok: true, demo: true, msg: '演示模式：操作已模拟' }));
    }
    const sv = (cfg.servers || []).find(s => s.id === actM[1]);
    if (!sv) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ ok: false, error: '找不到服务器 ' + actM[1] })); }
    const op = actM[2];
    const body = await readBody(req2);
    if (!body) { res.writeHead(400); return res.end('bad json'); }
    const jout = (o) => { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(o)); };
    const panelRes = (r) => ({ ok: !!(r && r.success !== false), msg: (r && r.msg) || '', demo: false });

    try {
      // --- 新建入站：payload 由前端按 3x-ui 表单组装（settings/streamSettings/sniffing 为 JSON 字符串），原样转发 ---
      if (op === 'inbound/add') {
        if (!body.payload || !body.payload.port || !body.payload.protocol) throw new Error('payload 不完整');
        const r = await callPanel(sv, '/panel/api/inbounds/add', { method: 'POST', body: body.payload });
        console.log('[act]', sv.id, '新建入站', body.payload.remark, body.payload.port, '→', r && r.success !== false ? '成功' : (r && r.msg));
        return jout(panelRes(r));
      }

      // --- 新建客户端：优先 addClient，失败/不支持则 读入站→追加→update 整体写回（老版本兜底）---
      if (op === 'client/add') {
        if (!body.inboundId || !body.client) throw new Error('参数不完整');
        const settingsArr = JSON.stringify([body.client]);
        let r = null, via = 'addClient';
        try {
          r = await callPanel(sv, '/panel/api/inbounds/addClient', { method: 'POST', body: { id: body.inboundId, settings: settingsArr } });
          if (!r || r.success === false) throw new Error((r && r.msg) || 'addClient 不可用');
        } catch (e1) {
          via = 'update(兜底)';
          const j = await callPanel(sv, `/panel/api/inbounds/get/${body.inboundId}`);
          const ib = j && j.obj;
          if (!ib) throw new Error('获取入站失败：' + ((j && j.msg) || e1.message));
          const st = JSON.parse(ib.settings || '{}');
          st.clients = st.clients || [];
          st.clients.push(body.client);
          const payload = {
            up: ib.up || 0, down: ib.down || 0, total: ib.total || 0, remark: ib.remark || '',
            enable: ib.enable, expiryTime: ib.expiryTime || 0, listen: ib.listen || '',
            port: ib.port, protocol: ib.protocol,
            settings: JSON.stringify(st),
            streamSettings: ib.streamSettings || '', sniffing: ib.sniffing || '', allocate: ib.allocate || ''
          };
          r = await callPanel(sv, `/panel/api/inbounds/update/${body.inboundId}`, { method: 'POST', body: payload });
        }
        console.log('[act]', sv.id, '新建客户端', body.client.email, '@入站', body.inboundId, `(${via})`);
        return jout({ ...panelRes(r), via });
      }

      // --- 客户端启停开关：读入站→改 settings.clients 里对应 email 的 enable→update 写回（与面板数据源一致，最稳）---
      if (op === 'client/toggle') {
        if (!body.inboundId || !body.email) throw new Error('参数不完整');
        const j = await callPanel(sv, `/panel/api/inbounds/get/${body.inboundId}`);
        const ib = j && j.obj;
        if (!ib) throw new Error('获取入站失败：' + ((j && j.msg) || ''));
        const st = JSON.parse(ib.settings || '{}');
        const c = (st.clients || []).find(x => x.email === body.email);
        if (!c) throw new Error('面板上找不到客户端 ' + body.email);
        c.enable = !!body.enable;
        const payload = {
          up: ib.up || 0, down: ib.down || 0, total: ib.total || 0, remark: ib.remark || '',
          enable: ib.enable, expiryTime: ib.expiryTime || 0, listen: ib.listen || '',
          port: ib.port, protocol: ib.protocol,
          settings: JSON.stringify(st),
          streamSettings: ib.streamSettings || '', sniffing: ib.sniffing || '', allocate: ib.allocate || ''
        };
        const r = await callPanel(sv, `/panel/api/inbounds/update/${body.inboundId}`, { method: 'POST', body: payload });
        console.log('[act]', sv.id, '客户端', body.email, body.enable ? '启用' : '停用');
        return jout(panelRes(r));
      }

      // --- 路由规则写回：读 Xray 模板 → 插入规则 → 写回（写前备份、失败自动回滚；面板 update 会自动重启 Xray）---
      if (op === 'route/add') {
        if (!body.inboundTag || !body.outboundTag) throw new Error('参数不完整');
        const xr = await callPanel(sv, '/panel/api/xray/');
        let obj = xr && xr.obj;
        let tplStr = obj && typeof obj === 'object' ? (obj.xraySetting || '') : (typeof obj === 'string' ? obj : '');
        if (!tplStr) throw new Error('未获取到 Xray 模板（GET /panel/api/xray/ 返回异常），请到面板 Xray 设置页手动加规则');
        const tpl = JSON.parse(tplStr);
        tpl.routing = tpl.routing || {};
        tpl.routing.rules = tpl.routing.rules || [];
        const dup = tpl.routing.rules.some(r => r && Array.isArray(r.inboundTag) && r.inboundTag.includes(body.inboundTag));
        if (dup) return jout({ ok: true, msg: '已存在相同入站 tag 的路由规则，无需重复写入', demo: false });
        const newRule = { inboundTag: [body.inboundTag], outboundTag: body.outboundTag, type: 'field' };
        // 插到最后一条「带 inboundTag 的规则」之后（避免落在通用兜底规则 direct/block 之后的失配区）
        let pos = -1;
        tpl.routing.rules.forEach((r, i) => { if (r && (Array.isArray(r.inboundTag) || Array.isArray(r.user))) pos = i; });
        tpl.routing.rules.splice(pos + 1, 0, newRule);
        const newStr = JSON.stringify(tpl, null, 2);
        // 写前备份
        const bakDir = path.join(ROOT, 'backups');
        try { fs.mkdirSync(bakDir, { recursive: true }); } catch (e) {}
        const bakFile = path.join(bakDir, `xray_${sv.id}_${Date.now()}.json`);
        try { fs.writeFileSync(bakFile, tplStr); } catch (e) {}
        // 写回（面板收到 update 会校验并自动重启 Xray）
        let r = null;
        try {
          r = await callPanel(sv, '/panel/api/xray/update', { method: 'POST', body: { xraySetting: newStr } });
        } catch (e) {
          r = { success: false, msg: e.message };
        }
        if (!r || r.success === false) {
          // 失败自动回滚
          let rollback = '';
          try {
            const rr = await callPanel(sv, '/panel/api/xray/update', { method: 'POST', body: { xraySetting: tplStr } });
            rollback = rr && rr.success !== false ? '已自动回滚到原配置' : '回滚失败，请用备份文件手动恢复：' + bakFile;
          } catch (e) { rollback = '回滚请求失败，请用备份文件手动恢复：' + bakFile; }
          console.error('[act]', sv.id, '路由写回失败:', (r && r.msg), '备份:', bakFile);
          throw new Error('路由规则写回失败：' + ((r && r.msg) || '') + '（' + rollback + '）');
        }
        console.log('[act]', sv.id, `路由规则 ${body.inboundTag} → ${body.outboundTag} 已写入，Xray 重启生效，备份:`, bakFile);
        return jout({ ok: true, demo: false, msg: '路由规则已写入，Xray 重启生效', backup: bakFile });
      }

      return jout({ ok: false, error: '未知操作 ' + op });
    } catch (e) {
      return jout({ ok: false, error: e.message });
    }
  }

  // --- Reality 密钥对生成（纯本地 x25519，无需面板）---
  if (u.pathname === '/api/reality/new' && req2.method === 'GET') {
    if (!authOK(req2)) { res.writeHead(401); return res.end('unauthorized'); }
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
    const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
    const b64u = b => Buffer.from(b).toString('base64url');
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ privateKey: b64u(privRaw), publicKey: b64u(pubRaw) }));
  }

  let f = u.pathname === '/' ? '/index.html' : decodeURIComponent(u.pathname);
  f = path.join(ROOT, 'public', path.normalize(f));
  if (!f.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, buf) => {
    if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, () => {
  console.log(`3x-ui 管理器已启动: http://localhost:${PORT}${cfg.demo ? '（演示模式）' : ''}`);
});

// 首次立即拉取，之后按 pollInterval 轮询
refresh();
setInterval(refresh, Math.max(5, cfg.pollInterval || 20) * 1000);
