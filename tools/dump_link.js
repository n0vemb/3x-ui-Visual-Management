/**
 * dump_link.js [服务器ID] [email] — 取客户端分享链接并解码全部参数（Shadowrocket 兼容性排查用）
 */
'use strict';
const fs = require('fs'), https = require('https'), http = require('http'), path = require('path');
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

(async () => {
  const base = sv.url.replace(/\/+$/, '');
  const h = { Accept: 'application/json' };
  if (sv.token) h.Authorization = 'Bearer ' + sv.token;
  else {
    const l = await req(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { username: sv.username, password: sv.password } });
    h.Cookie = (l.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
  }
  const lr = await req(base + '/panel/api/inbounds/list', { headers: h });
  const list = JSON.parse(lr.text).obj || [];
  for (const ib of list) {
    let st = ib.settings;
    if (typeof st === 'string') { try { st = JSON.parse(st); } catch (e) { st = {}; } }
    let ss = ib.streamSettings;
    if (typeof ss === 'string') { try { ss = JSON.parse(ss); } catch (e) { ss = {}; } }
    for (const c of (st.clients || [])) {
      if (wantEmail && c.email !== wantEmail) continue;
      if (!c.subId) continue;
      try {
        const r = await req(base + '/panel/api/clients/subLinks/' + encodeURIComponent(c.subId), { headers: h });
        const j = JSON.parse(r.text);
        const links = (j.success !== false && Array.isArray(j.obj)) ? j.obj : [];
        if (!links.length) continue;
        for (const link of links) {
          console.log(`\n===== ${c.email} (入站 ${ib.remark || ib.tag}:${ib.port}, 协议 ${ib.protocol}, sec ${ss.security}) =====`);
          console.log('原始链接: ' + link);
          const [main, frag] = link.split('#');
          if (main.startsWith('vmess://')) {
            const v = JSON.parse(Buffer.from(main.slice(8), 'base64').toString());
            console.log('vmess json:', JSON.stringify(v, null, 1));
          } else {
            const [body, q] = main.split('?');
            console.log('主体:', body);
            const params = new URLSearchParams(q || '');
            for (const [k, v] of params) console.log(`  ${k} = ${v}`);
          }
          console.log('锚点:', decodeURIComponent(frag || ''));
          // 服务端 Reality 配置对照
          if (ss.realitySettings) {
            const rs = ss.realitySettings;
            console.log('服务端 Reality:', JSON.stringify({ target: rs.target, serverNames: rs.serverNames, shortIds: rs.shortIds, mldsa65Verify: rs.mldsa65Verify ? '(有)' : undefined, mldsa65Seed: rs.mldsa65Seed ? '(有)' : undefined, xver: rs.xver }, null, 1).slice(0, 500));
          }
        }
      } catch (e) { console.log(`${c.email}: ${e.message}`); }
    }
  }
})();
