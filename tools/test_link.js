/**
 * test_link.js <分享链接> — 用拨测引擎测任意一条粘贴的分享链接（本机网络视角）
 * 用途：「页面绿但手机红」时，在本机（国内网络）单独验证这条链接本身。
 */
'use strict';
const fs = require('fs'), { spawn } = require('child_process'), path = require('path');
const tester = require('../tester.js');
const link = process.argv[2];
if (!link) { console.log('用法: node tools/test_link.js "<分享链接>"'); process.exit(1); }

function probe(socksPort, target, timeoutS) {
  const u = new URL(target);
  const t0 = Date.now();
  return new Promise(async resolve => {
    try {
      const sock = await tester.socksConnect(socksPort, u.hostname, +u.port || 80, timeoutS * 1000);
      const payload = `GET ${u.pathname} HTTP/1.1\r\nHost: ${u.hostname}\r\nUser-Agent: linktest\r\nConnection: close\r\n\r\n`;
      const to = setTimeout(() => { try { sock.destroy(); } catch (e) {} resolve({ ok: false, err: 'HTTP 超时', lat: Date.now() - t0 }); }, timeoutS * 1000);
      sock.on('data', d => { clearTimeout(to); sock.destroy(); resolve({ ok: true, status: d.toString().split('\r\n')[0], lat: Date.now() - t0 }); });
      sock.on('error', e => { clearTimeout(to); resolve({ ok: false, err: e.message, lat: Date.now() - t0 }); });
      sock.write(payload);
    } catch (e) { resolve({ ok: false, err: e.message, lat: Date.now() - t0 }); }
  });
}

(async () => {
  const ob = tester.linkToOutbound(link);
  if (!ob) { console.log('❌ 链接无法解析'); process.exit(1); }
  const proto = link.split('://')[0];
  const addr = (link.match(/@([^:]+):(\d+)/) || [])[1] || '';
  const port = (link.match(/@[^:]+:(\d+)/) || [])[1] || '';
  console.log(`协议 ${proto} | 服务器 ${addr}:${port} | outbound: ${ob.protocol}`);
  if (!fs.existsSync(tester.BIN_PATH())) { console.log('❌ xray 未安装'); process.exit(1); }
  const tmp = fs.mkdtempSync('/tmp/lt-');
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    log: { loglevel: 'warning' },
    inbounds: [{ tag: 'ti', listen: '127.0.0.1', port: 21601, protocol: 'socks', settings: { auth: 'noauth', udp: false } }],
    outbounds: [{ ...ob, tag: 'ob' }],
    routing: { domainStrategy: 'AsIs', rules: [{ inboundTag: ['ti'], outboundTag: 'ob' }] }
  }));
  const p = spawn(tester.BIN_PATH(), ['run', '-c', 'config.json'], { cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = ''; p.stderr.on('data', d => err += d);
  for (let i = 0; i < 30; i++) {
    try { const s = await tester.socksConnect(21601, 'example.com', 80, 500); s.destroy(); break; }
    catch (e) { await new Promise(r => setTimeout(r, 300)); }
  }
  const r = await probe(21601, 'http://www.gstatic.com/generate_204', 10);
  console.log(r.ok ? `✅ 通 ${r.lat}ms ${r.status}` : `❌ 不通 ${r.lat}ms ${r.err}`);
  if (!r.ok && err) console.log('xray stderr:', err.slice(-400));
  p.kill('SIGKILL');
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
})();
