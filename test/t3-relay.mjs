// 验证 relay：token 门禁（HTTP + WS）、静态文件、路径穿越防护、消息分发、广播。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { Relay } = require('./src/relay.js');
const { WsClient } = require('./src/wsClient.js');
const path = require('path');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const calls = [];
const relay = new Relay({
  mediaDir: path.join(ROOT, 'media'),
  log: () => {},
  handlers: {
    __onConnect: (conn) => { calls.push('connect'); conn.sendJson({ type: 'hello' }); },
    'ping:test': async (msg) => { calls.push('ping:test'); return { type: 'pong', echo: msg.v }; },
    'boom': async () => { throw new Error('intentional failure'); },
  },
});

// 只绑 127.0.0.1，测试不对外暴露
const port = await relay.start(0, false);
const T = relay.token;
console.log(`relay 监听 127.0.0.1:${port}\n`);

const get = async (p, headers) => {
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { headers });
  return { status: res.status, body: await res.text(), ct: res.headers.get('content-type') };
};

// 安全模型：UI 外壳公开（PWA 从主屏启动时拿不到 token，页面必须能加载），
// 数据通道（/api/* 与 WebSocket）强制校验 token。

// 1. 外壳页无 token 也能取到，且不含会话数据
const shell = await get('/');
check('外壳页无 token 可加载', shell.status === 200 && shell.body.includes('Kiro Remote'),
  `status=${shell.status}`);
// 真正的泄露信号是「实际的会话 id」与「绝对路径」，而不是源码注释里提到的文件名。
// 早先的断言匹配 'messages.jsonl' 字面量，会被一行注释误伤。
check('外壳页不泄露真实会话 id 或绝对路径',
  !/sess_[0-9a-f]{8}-/.test(shell.body) && !/\/Users\//.test(shell.body));

// 2. 认证探测端点：无 token / 错 token 必须 401，正确 token 200
check('/api/auth 无 token → 401', (await get('/api/auth')).status === 401);
check('/api/auth 错 token → 401', (await get('/api/auth?token=nope')).status === 401);
const authOk = await get(`/api/auth?token=${T}`);
check('/api/auth 正确 token → 200', authOk.status === 200 && /"ok":true/.test(authOk.body),
  `status=${authOk.status} body=${authOk.body}`);

// 3. 未列入公开清单的路径仍需 token
check('非公开路径无 token → 401', (await get('/api/anything')).status === 401);

// 3. 正确 token 拿到 PWA
const app = await get(`/?token=${T}`);
check('正确 token → 200 且返回 app.html', app.status === 200 && app.body.includes('Kiro Remote'),
  `status=${app.status} len=${app.body.length}`);
check('content-type 为 html', /text\/html/.test(app.ct || ''), app.ct || '');

// 4. Bearer header 也认
const bearer = await get('/', { authorization: `Bearer ${T}` });
check('Authorization: Bearer 生效', bearer.status === 200);

// 5. 静态资源
const qr = await get(`/qr.js?token=${T}`);
check('可取到 qr.js', qr.status === 200 && qr.body.includes('renderQrSvg'));
const mani = await get(`/manifest.json?token=${T}`);
check('可取到 manifest.json', mani.status === 200 && /application\/manifest|json/.test(mani.ct || ''));

// 6. 路径穿越必须被拦
const trav = await get(`/../package.json?token=${T}`);
check('路径穿越 ../package.json 被拒', trav.status === 403 || trav.status === 404,
  `status=${trav.status}`);
const trav2 = await get(`/..%2Fpackage.json?token=${T}`);
check('编码后的穿越也被拒', trav2.status === 403 || trav2.status === 404, `status=${trav2.status}`);

// 7. 不存在的文件 404
check('不存在的文件 → 404', (await get(`/nope.txt?token=${T}`)).status === 404);

// 8. WS：无 token 被拒
const badWs = await new Promise((resolve) => {
  const c = new WsClient(`ws://127.0.0.1:${port}/`, { timeoutMs: 3000 });
  let opened = false;
  c.on('open', () => { opened = true; resolve(true); });
  c.on('error', () => {});
  c.on('close', () => resolve(opened));
});
check('WS 无 token 被拒', badWs === false);

// 9. WS：正确 token 连上并收到 hello
const msgs = [];
const c = new WsClient(`ws://127.0.0.1:${port}/?token=${encodeURIComponent(T)}`, { timeoutMs: 4000 });
// 监听器必须在 open 之前挂好，否则 __onConnect 的首推会落在监听之前（浏览器里
// onmessage 紧跟构造同步注册，不存在这个窗口）
c.on('message', (m) => msgs.push(JSON.parse(m)));
await new Promise((r) => { c.on('open', r); c.on('error', r); });
await wait(200);
check('WS 建连并收到 __onConnect 推送',
  c.state === 'open' && msgs.some((m) => m.type === 'hello'), JSON.stringify(msgs));

// 10. 请求-响应带 reqId 回传
msgs.length = 0;
c.sendJson({ type: 'ping:test', reqId: 'abc', v: 42 });
await wait(200);
const pong = msgs.find((m) => m.type === 'pong');
check('handler 返回值带 reqId 回传', pong && pong.echo === 42 && pong.reqId === 'abc',
  JSON.stringify(pong || {}));

// 11. 未知类型返回 error
msgs.length = 0;
c.sendJson({ type: 'no-such-handler', reqId: 'x1' });
await wait(200);
check('未知消息类型 → error', msgs.some((m) => m.type === 'error' && m.reqId === 'x1'));

// 12. handler 抛错不应打挂连接
msgs.length = 0;
c.sendJson({ type: 'boom', reqId: 'x2' });
await wait(200);
check('handler 抛错转成 error 且连接存活',
  msgs.some((m) => m.type === 'error' && /intentional/.test(m.message)) && c.state === 'open');

// 13. 非法 JSON 不应打挂连接
msgs.length = 0;
c.send('{not json');
await wait(200);
check('非法 JSON 转成 error 且连接存活',
  msgs.some((m) => m.type === 'error') && c.state === 'open');

// 14. 广播
msgs.length = 0;
relay.broadcast({ type: 'status', state: 'running' });
await wait(200);
check('broadcast 到达客户端', msgs.some((m) => m.type === 'status' && m.state === 'running'));

// 15. clientCount
check('clientCount 计数正确', relay.clientCount === 1, `count=${relay.clientCount}`);

// 16. urls() 在只绑 loopback 时不应含 LAN 地址
const urls = relay.urls();
check('bindLan=false 时只给 loopback', urls.length === 1 && urls[0].includes('127.0.0.1'),
  JSON.stringify(urls).replace(T, '<token>'));

// 17. token 不是弱随机
check('token 长度足够', T.length >= 40, `len=${T.length}`);

relay.stop();
await wait(150);
check('stop 后连接被清空', relay.clientCount === 0);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
