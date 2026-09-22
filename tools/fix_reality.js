// 修复 REALITY 入站缺 "target" 字段导致 Xray 无法启动的问题
// 用法: node tools/fix_reality.js [服务器ID]   （缺省 = 所有启用的服务器）
// 逻辑: 扫描所有入站 → streamSettings.realitySettings 有 dest 但没有 target 的 → target=dest 回写
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
const only = process.argv[2];
const servers = (cfg.servers || []).filter(s => s.enabled !== false && (!only || s.id === only));
if (!servers.length) { console.error('没有匹配的服务器'); process.exit(1); }

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
    const r = mod.request(u, { method, headers: h, rejectUnauthorized: false, timeout: 15000 }, res => {
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

async function fixServer(sv) {
  const base = sv.url.replace(/\/+$/, '');
  console.log(`\n=== ${sv.id} (${sv.name || sv.url}) ===`);
  const headers = { Accept: 'application/json' };
  if (sv.token) headers.Authorization = 'Bearer ' + sv.token;
  else {
    const l = await req(base + '/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: { username: sv.username, password: sv.password } });
    const sc = (l.headers['set-cookie'] || []).map(s => s.split(';')[0]).join('; ');
    if (!sc) { console.log('登录失败:', l.text.slice(0, 120)); return; }
    headers.Cookie = sc;
  }

  const lr = await req(base + '/panel/api/inbounds/list', { headers });
  let j;
  try { j = JSON.parse(lr.text); } catch (e) { console.log('入站列表解析失败:', lr.status, lr.text.slice(0, 120)); return; }
  const list = j.obj || [];
  console.log(`入站总数: ${list.length}`);

  let fixed = 0;
  for (const ib of list) {
    // v3.1.x list API 可能返回对象而非 JSON 字符串，两者都要兼容
    const toObj = (v) => v == null ? {} : (typeof v === 'object' ? v : (() => { try { return JSON.parse(v); } catch (e) { return null; } })());
    const st = toObj(ib.streamSettings);
    if (!st) continue;
    const r = st.realitySettings;
    if (!r) continue;
    if (r.target) continue; // 已有有效 target
    const tgt = (r.target || r.dest || '').trim() || 'www.microsoft.com:443';
    const patch = { ...r, target: tgt, dest: undefined };
    delete patch.dest;
    if (!Array.isArray(patch.serverNames) || !patch.serverNames.length) {
      patch.serverNames = [tgt.split(':')[0]];
      console.log(`  [${ib.tag || ib.remark}] serverNames 为空，补为 [${patch.serverNames[0]}]`);
    }
    if (!Array.isArray(patch.shortIds) || !patch.shortIds.length) patch.shortIds = [''];
    const newStream = JSON.stringify({ ...st, realitySettings: patch });
    console.log(`  [${ib.tag || ib.remark}] 端口 ${ib.port}: target 缺失 → 补 "${tgt}"`);
    // v3.1.x update 接口要求这些字段为 JSON 字符串
    const asStr = (v) => typeof v === 'string' ? v : JSON.stringify(v || {});
    const payload = {
      up: ib.up || 0, down: ib.down || 0, total: ib.total || 0,
      remark: ib.remark || '', enable: ib.enable, expiryTime: ib.expiryTime || 0,
      listen: ib.listen || '', port: ib.port, protocol: ib.protocol,
      tag: ib.tag || '', trafficReset: ib.trafficReset || 0, subSortIndex: ib.subSortIndex || 0,
      settings: asStr(ib.settings), streamSettings: newStream,
      sniffing: asStr(ib.sniffing), allocate: asStr(ib.allocate)
    };
    const ur = await req(base + `/panel/api/inbounds/update/${ib.id}`, { method: 'POST', headers, body: payload });
    let ok = false, msg = '';
    try { const uj = JSON.parse(ur.text); ok = uj.success !== false; msg = uj.msg || ''; } catch (e) { msg = ur.text.slice(0, 80); }
    console.log(`    → 更新${ok ? '成功' : '失败: ' + msg}`);
    if (ok) fixed++;
  }
  console.log(`修复 ${fixed} 个入站`);

  const srr = await req(base + '/panel/api/server/status', { headers });
  try {
    const o = JSON.parse(srr.text).obj || {};
    console.log('Xray 状态:', o.xrayState, '| 错误:', (o.xrayErr || '').slice(0, 160));
  } catch (e) {}
}

(async () => { for (const sv of servers) { try { await fixServer(sv); } catch (e) { console.log('异常:', e.message); } } })();
