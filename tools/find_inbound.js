// 定位 tag=inbound-50598 的入站，输出完整信息
const https = require('https'), http = require('http'), fs = require('fs'), path = require('path');
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const TARGET_TAG = process.argv[2] || 'inbound-50598';
function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url); const mod = u.protocol === 'https:' ? https : http; const h = { ...headers }; let data = null;
    if (body != null) { data = typeof body === 'string' ? body : JSON.stringify(body); if (!h['Content-Type']) h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = mod.request(u, { method, headers: h, rejectUnauthorized: false, timeout: 15000 }, res => { let buf = ''; res.setEncoding('utf8'); res.on('data', c => buf += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: buf })); });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', reject); if (data != null) r.write(data); r.end();
  });
}
(async () => {
  const sv = (cfg.servers || []).find(s => s.id === 'srvyv0sw');
  const base = sv.url.replace(/\/+$/, '');
  const headers = { Accept: 'application/json' };
  if (sv.token) headers.Authorization = 'Bearer ' + sv.token;
  else {
    const l = await req(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { username: sv.username, password: sv.password } });
    headers.Cookie = (l.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
  }
  const lr = await req(base + '/panel/api/inbounds/list', { headers });
  const list = (JSON.parse(lr.text).obj) || [];
  console.log('共', list.length, '个入站，全部 tag:');
  console.log(list.map(i => (i.tag || i.remark) + '#' + i.id).join(', '));
  const hit = list.find(i => (i.tag || '') === TARGET_TAG || (i.remark || '') === TARGET_TAG || String(i.remark).includes(TARGET_TAG));
  if (!hit) { console.log('\n未在面板入站中找到', TARGET_TAG, '（可能 Xray 配置里另有来源）'); return; }
  console.log('\n找到入站 id=' + hit.id + '，完整字段:');
  const { up, down, total, ...rest } = hit;
  for (const k of ['id', 'tag', 'remark', 'port', 'protocol', 'listen', 'enable', 'trafficReset', 'subSortIndex']) console.log(' ', k, '=', JSON.stringify(hit[k]));
  console.log('  settings =', hit.settings);
  console.log('  streamSettings =', hit.streamSettings);
  console.log('  sniffing =', hit.sniffing);
  console.log('  allocate =', hit.allocate);
})();
