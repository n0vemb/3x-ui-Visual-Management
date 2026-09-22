// 临时诊断：查看各面板 Reality 入站实际字段 + Xray 状态
const https = require('https'), http = require('http'), fs = require('fs'), path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const mod = u.protocol === 'https:' ? https : http; const h = { ...headers }; let data = null;
    if (body != null) { data = typeof body === 'string' ? body : JSON.stringify(body); if (!h['Content-Type']) h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = mod.request(u, { method, headers: h, rejectUnauthorized: false, timeout: 15000 }, res => { let buf = ''; res.setEncoding('utf8'); res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf })); });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject); if (data != null) r.write(data); r.end();
  });
}
(async () => {
  for (const sv of (cfg.servers || []).filter(s => s.enabled !== false)) {
    const base = sv.url.replace(/\/+$/, '');
    const headers = { Accept: 'application/json' };
    if (sv.token) headers.Authorization = 'Bearer ' + sv.token;
    else {
      const l = await req(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { username: sv.username, password: sv.password } });
      headers.Cookie = (l.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    }
    console.log('\n===', sv.id, sv.name || sv.url, '===');
    const st = await req(base + '/panel/api/server/status', { headers });
    try {
      const o = JSON.parse(st.text).obj || {};
      const xr = {};
      for (const k of Object.keys(o)) if (/xray/i.test(k)) xr[k] = o[k];
      console.log('xray相关字段:', JSON.stringify(xr).slice(0, 400));
    } catch (e) { console.log('status 解析失败', st.status, st.text.slice(0, 100)); }
    const lr = await req(base + '/panel/api/inbounds/list', { headers });
    const list = (JSON.parse(lr.text).obj) || [];
    for (const ib of list) {
      let ss; try { ss = JSON.parse(ib.streamSettings || '{}'); } catch (e) { continue; }
      if (ss.security === 'reality' || ss.realitySettings) {
        const r = ss.realitySettings || {};
        const sn = (r.serverNames || []).join('|') || '空';
        console.log('  [' + (ib.tag || ib.remark) + '] port=' + ib.port + ' enable=' + ib.enable + ' sec=' + ss.security
          + ' target=' + (r.target ? '有' : '无') + ' dest=' + (r.dest || '无') + ' sni=' + sn);
      }
    }
  }
})();
