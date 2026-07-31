// 验证自实现的 WS server 与 client 能互通：握手、文本帧、大帧分片、掩码、ping/pong、关闭码。
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { WsServer } = require('./src/wsServer.js');
const { WsClient } = require('./src/wsClient.js');

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const wss = new WsServer();
const server = http.createServer((req, res) => res.writeHead(404).end());
server.on('upgrade', (req, socket) => {
  // 用 query token 做鉴权，和 relay 的行为一致
  const ok = new URL(req.url, 'http://x').searchParams.get('token') === 'good';
  wss.handleUpgrade(req, socket, () => ok);
});

wss.on('connection', (conn) => {
  conn.on('message', (text) => {
    if (text === 'ping-me') { conn.ping(); return; }
    if (text.startsWith('echo:')) { conn.send(text.slice(5)); return; }
    if (text === 'big') { conn.send('B'.repeat(200000)); return; }
    if (text === 'bye') { conn.close(4321, 'server-initiated'); return; }
    conn.sendJson({ got: text.length });
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
console.log(`测试 server 监听 127.0.0.1:${port}\n`);

function connectClient(token) {
  return new Promise((resolve) => {
    const c = new WsClient(`ws://127.0.0.1:${port}/?token=${token}`, { timeoutMs: 4000 });
    const msgs = [];
    let opened = false;
    c.on('open', () => { opened = true; resolve({ c, msgs, opened: true }); });
    c.on('message', (m) => msgs.push(m));
    c.on('error', () => {});
    c.on('close', (code, reason) => {
      if (!opened) resolve({ c, msgs, opened: false, code, reason });
      else { c._closeInfo = { code, reason }; }
    });
  });
}

// 1. 错 token 必须被拒
const bad = await connectClient('wrong');
check('错误 token 被拒绝', bad.opened === false);

// 2. 正确 token 能建连
const { c, msgs } = await connectClient('good');
check('正确 token 完成握手', c.state === 'open');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 3. 小文本往返（含中文，验证 UTF-8 与掩码）
c.send('echo:你好 Kiro — 中文与符号 ✓');
await wait(150);
check('中文文本往返', msgs[msgs.length - 1] === '你好 Kiro — 中文与符号 ✓',
  JSON.stringify(msgs[msgs.length - 1] || ''));

// 4. 客户端发大 payload（走 16 位长度分支）
const mid = 'x'.repeat(70000);
c.send('echo:' + mid);
await wait(400);
check('70KB 帧往返', msgs[msgs.length - 1] === mid,
  `收到 ${(msgs[msgs.length - 1] || '').length} 字节`);

// 5. 服务端发 200KB（客户端需正确处理长帧）
msgs.length = 0;
c.send('big');
await wait(500);
check('服务端 200KB 帧', msgs[0] && msgs[0].length === 200000,
  `收到 ${(msgs[0] || '').length} 字节`);

// 6. ping/pong（客户端自动回 pong，不应报错）
c.send('ping-me');
await wait(200);
check('ping/pong 不中断连接', c.state === 'open');

// 7. JSON 帧
msgs.length = 0;
c.send('plain-text');
await wait(150);
let parsed = null;
try { parsed = JSON.parse(msgs[0]); } catch (_) {}
check('JSON 帧解析', parsed && parsed.got === 'plain-text'.length);

// 8. 服务端主动关闭并带自定义关闭码
c.send('bye');
await wait(300);
check('收到服务端关闭码 4321',
  c.state === 'closed' && c._closeInfo && c._closeInfo.code === 4321,
  JSON.stringify(c._closeInfo || {}));

// 9. 连接数归零
check('server 连接表已清空', wss.connections.size === 0, `size=${wss.connections.size}`);

server.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
