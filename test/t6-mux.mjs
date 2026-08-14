// 验证 muxClient：endpoint 获取、initialize 握手、sendPrompt、入站权限请求、断连清理。
// 用一个假的 ACP over WS 服务端替代真实 IDE agent server，协议形状照产物里的用法。
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { MuxPool } = require('./src/muxClient.js');
const { WsServer } = require('./src/wsServer.js');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const GOOD_TOKEN = 'tok-good';
const received = [];
let serverConn = null;

const wss = new WsServer();
const server = http.createServer((req, res) => res.writeHead(404).end());
server.on('upgrade', (req, socket) => {
  wss.handleUpgrade(req, socket, (r) => {
    // 真实 mux 用 4001 Invalid token 拒绝；这里同样校验 query token
    return new URL(r.url, 'http://x').searchParams.get('token') === GOOD_TOKEN;
  });
});
wss.on('connection', (conn) => {
  serverConn = conn;
  conn.on('message', (text) => {
    const msg = JSON.parse(text);
    received.push(msg);
    if (msg.method === 'initialize') {
      conn.sendJson({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        },
      });
      return;
    }
    if (msg.method === 'session/prompt') {
      conn.sendJson({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
      return;
    }
    if (msg.method === 'never/answers') return; // 故意不响应，用于测超时
    if (msg.id !== undefined) {
      conn.sendJson({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } });
    }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// mock 出 vscode 的命令面
let endpointMode = 'ok';
const fakeVscode = {
  commands: {
    executeCommand: async (cmd) => {
      if (cmd !== 'kiro.agentRegistry.getAgentEndpoints') throw new Error('unexpected cmd ' + cmd);
      if (endpointMode === 'throw') throw new Error('command not found');
      if (endpointMode === 'garbage') return { nope: true };
      return [
        { port, token: GOOD_TOKEN, windowId: 'win-1', folders: [{ label: 'Kiro', path: '/tmp/wsA' }] },
      ];
    },
  },
};

const logs = [];
const pool = new MuxPool(fakeVscode, (m) => logs.push(m));
const inbound = [];
pool.on('inbound', (m) => inbound.push(m));

// 1. 正常连接 + initialize
let r = await pool.refresh();
check('拿到 endpoint 并建连', r.endpointCount === 1 && r.connectedCount === 1, JSON.stringify(r));
check('initialize 已发出', received.some((m) => m.method === 'initialize'));
const initMsg = received.find((m) => m.method === 'initialize');
check('initialize 参数形状正确',
  initMsg && initMsg.params.protocolVersion === 1 &&
  initMsg.params.clientInfo && typeof initMsg.params.clientInfo.name === 'string',
  JSON.stringify(initMsg && initMsg.params));

const conn = pool.anyReady();
check('连接标记为 ready', !!conn && conn.ready);
check('capabilities 已记录',
  conn && conn.initializeResult && conn.initializeResult.agentCapabilities.loadSession === true);

// 2. 按工作区路径挑连接
check('按工作区路径命中', pool.pickForWorkspace('/tmp/wsA') === conn);
check('工作区不匹配时回退到可用连接', pool.pickForWorkspace('/nope') === conn);

// 3. sendPrompt 形状（须与 kiroAgent.sessions.sendPrompt 内部一致）
received.length = 0;
const promptRes = await conn.sendPrompt('sess_abc', '你好');
const pm = received.find((m) => m.method === 'session/prompt');
check('session/prompt 参数形状正确',
  pm && pm.params.sessionId === 'sess_abc' &&
  Array.isArray(pm.params.prompt) && pm.params.prompt[0].type === 'text' &&
  pm.params.prompt[0].text === '你好',
  JSON.stringify(pm && pm.params));
check('sendPrompt 拿到响应', promptRes && promptRes.stopReason === 'end_turn');

// 4. 入站请求（权限）应作为 inbound 抛出
inbound.length = 0;
serverConn.sendJson({
  jsonrpc: '2.0',
  id: 900,
  method: 'session/request_permission',
  params: {
    sessionId: 'sess_abc',
    toolCallId: 'tc-1',
    options: [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ],
  },
});
await wait(200);
check('入站权限请求被抛出', inbound.length === 1 && inbound[0].id === 900 &&
  /request_permission/.test(inbound[0].method),
  inbound[0] ? `${inbound[0].method} id=${inbound[0].id}` : '(空)');

// 5. respond 能把结果发回服务端
received.length = 0;
inbound[0].connection.respond(900, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
await wait(200);
const resp = received.find((m) => m.id === 900);
check('respond 结果送达服务端',
  resp && resp.result.outcome.optionId === 'allow-once', JSON.stringify(resp || {}));

// 6. 入站方法被记录（自诊断用）
check('入站方法计入 seenMethods',
  conn.seenMethods.get('session/request_permission') === 1);

// 7. 通知（无 id）也应抛出，且不回响应
inbound.length = 0;
received.length = 0;
serverConn.sendJson({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess_abc' } });
await wait(200);
check('入站通知被抛出且未回响应',
  inbound.length === 1 && inbound[0].id === undefined && received.length === 0);

// 8a. 服务端返回 error 时应 reject（而非静默 resolve），并且把结构化字段带出来
//
// 为什么要断言 err.code：调用方靠错误码分流（-32001 = 该权限已不存在、
// -32002 = 已有回合在跑），而这两个判据的行为差别很大 —— 一个停止重放，一个自动降级。
// 此前 reject 的是 `new Error(JSON.stringify(error))`，code 永远 undefined，
// 于是所有 `err.code === -320xx` 的判断都是死代码，只有正则匹配 message 在起作用。
// 更糟的是别处的测试用手工构造的 `{ code }` 对象测那些判据，看着有覆盖、实际从没生效。
// 这一条把真实产出的形态钉住，免得 mock 和真实行为各自漂移。
let errCaught = null;
try {
  await conn.request('unknown/method', {}, 3000);
} catch (e) {
  errCaught = e;
}
check('error 响应会 reject', !!errCaught && /32601/.test(errCaught.message));
check('reject 的 Error 带 code（调用方按错误码分流，靠 message 正则不可靠）',
  !!errCaught && errCaught.code === -32601, errCaught ? `code=${errCaught.code}` : '');
check('reject 的 Error 带 rpcMessage（原始文案，不含 JSON 包装）',
  !!errCaught && errCaught.rpcMessage === 'nope', errCaught ? `rpcMessage=${errCaught.rpcMessage}` : '');
check('message 仍是整个 error 的 JSON（旧的文本兜底判据依赖它）',
  !!errCaught && /"code"\s*:\s*-32601/.test(errCaught.message));

// 8b. 服务端不响应时应在超时后 reject，不能悬挂
const t0 = Date.now();
let timedOut = false;
try {
  await conn.request('never/answers', {}, 600);
} catch (e) {
  timedOut = /timed out/.test(e.message);
}
const elapsed = Date.now() - t0;
check('请求超时会 reject', timedOut && elapsed >= 550 && elapsed < 2000, `${elapsed}ms`);
check('超时后 pending 表已清理', conn.pending.size === 0, `size=${conn.pending.size}`);

// 9. 服务端断开后连接应从池中移除
serverConn.terminate();
await wait(300);
check('断连后从池中移除', pool.connections.size === 0, `size=${pool.connections.size}`);

// 10. endpoints 命令不可用时不应抛异常
endpointMode = 'throw';
r = await pool.refresh();
check('getAgentEndpoints 抛错时安全降级',
  r.endpointCount === 0 && pool.endpointsAvailable === false && !!pool.lastEndpointError);

// 11. 返回值异常时也不应崩
endpointMode = 'garbage';
r = await pool.refresh();
check('返回值非数组时安全降级', r.endpointCount === 0 && pool.endpointsAvailable === false);

// 12. 恢复后能重连
endpointMode = 'ok';
r = await pool.refresh();
check('恢复后可重新建连', r.connectedCount === 1, JSON.stringify(r));

// 13. 诊断输出结构完整
const diag = pool.diagnostics();
check('diagnostics 结构完整',
  diag.endpointsAvailable === true && diag.connections.length === 1 &&
  diag.connections[0].ready === true && diag.connections[0].protocolVersion === 1,
  JSON.stringify(diag.connections[0] || {}).slice(0, 160));

pool.dispose();
await wait(150);
server.close();
wss.closeAll();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
