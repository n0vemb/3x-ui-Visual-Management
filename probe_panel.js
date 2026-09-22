// 只读探测：确认目标 3x-ui 面板的版本与 xray 相关接口是否存在（不做任何写操作）
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const svId = process.argv[2];
const sv = (cfg.servers || []).find(s => s.id === svId);
if (!sv) { console.error('找不到服务器', svId); process.exit(1); }

function req(url, { method = 'GET', headers = {}, body = null } = {}) {
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
    const r = mod.request(u, { method, headers: h, rejectUnauthorized: false, timeout: 10000 }, res => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', c => { buf += c; if (buf.length > 5 * 1024 * 1024) r.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf }));
    });
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    if (data != null) r.write(data);
    r.end();
  });
}

(async () => {
  const base = sv.url.replace(/\/+$/, '');
  // 登录拿会话（或直接用 token）
  const headers = { Accept: 'application/json' };
  if (sv.token) headers.Authorization = 'Bearer ' + sv.token;
  else {
    const l = await req(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { username: sv.username, password: sv.password } });
    const sc = (l.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    if (!sc) { console.error('登录失败', l.text.slice(0, 200)); process.exit(1); }
    headers.Cookie = sc;
  }
  const probe = async (m, p, body) => {
    try {
      const r = await req(base + p, { method: m, headers, body });
      let info = '';
      try { const j = JSON.parse(r.text); info = j.msg ? (' msg=' + String(j.msg).slice(0, 60)) : ''; } catch (e) { info = ' body=' + r.text.slice(0, 60); }
      console.log(`${r.status}  ${m.padEnd(4)} ${p}${info}`);
      return r;
    } catch (e) { console.log(`ERR  ${m.padEnd(4)} ${p}  ${e.message}`); return null; }
  };

  console.log('== 面板基础信息 ==');
  const st = await probe('GET', '/panel/api/server/status');
  try {
    const j = JSON.parse(st.text);
    const o = j.obj || {};
    console.log('   panel 版本相关字段:', JSON.stringify({ version: o.version, xrayVersion: o.xrayVersion, xrayState: o.xrayState }));
  } catch (e) {}
  console.log('== xray 接口探测（只读）==');
  await probe('POST', '/panel/api/xray/');
  await probe('GET', '/panel/xray/getDefaultJsonConfig');
  // v3.1.x 会话路由：取 CSRF token 后读取模板（POST /panel/xray/ 是读接口）
  const ct = await req(base + '/panel/csrf-token', { method: 'GET', headers });
  console.log('GET  /panel/csrf-token →', ct.status);
  let csrf = '';
  try { csrf = JSON.parse(ct.text).obj || ''; } catch (e) {}
  if (csrf) {
    console.log('   已取得 CSRF token（长度 ' + csrf.length + '），用 cookie + X-CSRF-Token 试读模板');
    const h2 = { ...headers, 'X-CSRF-Token': csrf };
    const rr = await req(base + '/panel/xray/', { method: 'POST', headers: h2, body: '' });
    let ok = false, tplLen = 0;
    try {
      const j = JSON.parse(rr.text);
      let o = j.obj;
      if (typeof o === 'string') o = JSON.parse(o);
      tplLen = o && o.xraySetting ? String(o.xraySetting).length : 0;
      ok = !!tplLen;
    } catch (e) {}
    console.log(`${rr.status}  POST /panel/xray/  ${ok ? '模板读取成功, xraySetting 长度 ' + tplLen : ('失败: ' + rr.text.slice(0, 120))}`);
  } else {
    console.log('   未取得 CSRF token，跳过 /panel/xray/ 试读');
  }
  await probe('GET', '/panel/api/inbounds/list');
  console.log('== 完成（未做任何写操作）==');
})();
