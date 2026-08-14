// 从属实例：没抢到端口的窗口连回主实例待命，替主实例在自己窗口打开会话。
//
// 为什么单独一个文件：这是链路的**另一半**。t15 测的是主实例的派活决策（用假 relay），
// 那一侧全绿也不能说明从属侧真的连得上、真的会执行、真的会回话。
// 这里起一个**真的 WebSocket 服务端**当主实例，跑真的 Follower，端到端走一遍。
//
// 重点覆盖的失败方向：
//   - 没有 token 文件（用户从没开过 Bridge）→ 必须安静退出，不能重试等待
//   - 主实例不在 → 同样安静退出
//   - 派来的活执行失败 → 必须回报 ok:false，而不是不回话（主实例只能等超时）
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- 隔离 HOME
// follower.js 的 TOKEN_FILE 是模块顶层常量（os.homedir() 拼出来），require 之前必须改 HOME，
// 否则这个测试会去读用户真实的 ~/.kiro-bridge/relay-token.json
const SANDBOX = mkdtempSync(join(tmpdir(), 'krb-follower-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SANDBOX;
mkdirSync(join(SANDBOX, '.kiro-bridge'), { recursive: true });

const { Follower, TOKEN_FILE } = require('./src/follower.js');
check('TOKEN_FILE 落在沙箱里（没去读用户真实的 token）', TOKEN_FILE.startsWith(SANDBOX),
  TOKEN_FILE);

const { WsServer } = require('./src/wsServer.js');

// ---------------------------------------------------------------- 假主实例
const TOKEN = 'T'.repeat(43);
const wss = new WsServer();
const inbox = []; // 主实例收到的消息
let serverConn = null;
const server = http.createServer((req, res) => res.writeHead(404).end());
/*
 * 数**连接尝试**次数（包括被 token 校验拒掉的）。
 *
 * 为什么不能只看「最后连上了没有」：那个信号对「压根没尝试」和「尝试了但被拒」给出
 * 同一个答案。实测踩到过 —— 把 follower 里「没 token 就不连」那个判断去掉之后，
 * 它会拿着 null 去连、被服务端拒掉，于是 `start()` 照样返回 false、连接数照样是 0，
 * 断言全绿。而真实后果是：用户从没开过 Bridge 的窗口会白发三轮连接请求加定时器。
 * 要区分这两种情况，必须在**更上游**数一次。
 */
let upgradeAttempts = 0;
server.on('upgrade', (req, socket) => {
  upgradeAttempts += 1;
  const ok = new URL(req.url, 'http://x').searchParams.get('token') === TOKEN;
  wss.handleUpgrade(req, socket, () => ok);
});
wss.on('connection', (conn) => {
  serverConn = conn;
  conn.on('message', (text) => {
    try { inbox.push(JSON.parse(text)); } catch (_) { inbox.push({ raw: text }); }
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const PORT = server.address().port;

const waitFor = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
};

// ================================================================ 1. 没有 token 文件
// 用户从没开过 Bridge 的机器上，从属模式必须安静地什么都不做
{
  const before = upgradeAttempts;
  const f = new Follower({ port: PORT, workspacePaths: ['/ws/a'], log: () => {}, onAttach: async () => {} });
  const started = await f.start();
  check('★ 没有 token 文件 → 不进入从属模式（不是报错、不是重试）', started === false);
  // 这一条才是真正的判据：**一次连接尝试都不该发起**。
  // 只断言「最后没连上」是不够的 —— 拿着 null 去连也会被拒，两者结果一样。
  check('★ 没有 token 文件 → 一次连接尝试都没发起',
    upgradeAttempts === before, `发起了 ${upgradeAttempts - before} 次`);
  check('并且没有建立任何连接', wss.connections.size === 0, `连接数 ${wss.connections.size}`);
  f.stop();
}

// 写入 token，后面的用例才能通过认证
writeFileSync(join(SANDBOX, '.kiro-bridge', 'relay-token.json'),
  JSON.stringify({ at: new Date().toISOString(), token: TOKEN }));

// ================================================================ 2. 主实例不在
{
  // 挑一个几乎不可能有人监听的端口
  const f = new Follower({ port: 1, workspacePaths: ['/ws/a'], log: () => {}, onAttach: async () => {} });
  const started = await f.start();
  check('★ 主实例不在 → 安静退出，不抛异常', started === false);
  f.stop(); // 顺手确认 stop 会拦住后续重连
}

// ================================================================ 3. 正常待命并报到
let attached = [];
const f = new Follower({
  port: PORT,
  workspacePaths: ['/ws/kiro'],
  log: () => {},
  onAttach: async (sessionId) => { attached.push(sessionId); },
});
{
  const started = await f.start();
  check('连上主实例', started === true);
  const got = await waitFor(() => inbox.some((m) => m.type === 'follower:hello'));
  check('★ 连上就报到，带着自己的 workspacePaths', got);
  const hello = inbox.find((m) => m.type === 'follower:hello');
  check('★ 报到消息里的 workspacePaths 正确',
    !!hello && Array.isArray(hello.workspacePaths) && hello.workspacePaths[0] === '/ws/kiro',
    JSON.stringify(hello || {}));
}

// ================================================================ 4. 派活 → 执行 → 回报
{
  inbox.length = 0;
  attached = [];
  serverConn.sendJson({ type: 'follower:attach', sessionId: 'sess_abc', reqId: 'r1' });
  const done = await waitFor(() => inbox.some((m) => m.type === 'follower:attached'));
  check('★ 收到派活后回报结果', done);
  check('★ 真的执行了 onAttach，且拿到正确的 sessionId',
    attached.length === 1 && attached[0] === 'sess_abc', JSON.stringify(attached));
  const rep = inbox.find((m) => m.type === 'follower:attached');
  check('★ 回报 ok=true 且带回 reqId（主实例靠它对上号）',
    !!rep && rep.ok === true && rep.reqId === 'r1', JSON.stringify(rep || {}));
}

// ================================================================ 5. 执行失败也必须回话
// 不回话的话主实例只能干等到超时——用户体感是「新建会话卡了几秒」，
// 而且它拿不到失败原因，日志里查不出所以然
{
  const boom = new Follower({
    port: PORT,
    workspacePaths: ['/ws/boom'],
    log: () => {},
    onAttach: async () => { throw new Error('viewSession 炸了'); },
  });
  const ok = await boom.start();
  check('第二个从属实例也能连上（主实例支持多个窗口待命）', ok === true);
  await waitFor(() => inbox.filter((m) => m.type === 'follower:hello').length >= 1);
  inbox.length = 0;
  // serverConn 现在指向最新那条连接，也就是 boom
  serverConn.sendJson({ type: 'follower:attach', sessionId: 'sess_bad', reqId: 'r2' });
  const replied = await waitFor(() => inbox.some((m) => m.type === 'follower:attached'));
  check('★ onAttach 抛错时照样回话（不能让主实例干等超时）', replied);
  const rep = inbox.find((m) => m.type === 'follower:attached');
  check('★ 回报 ok=false 并带上原因', !!rep && rep.ok === false && /炸了/.test(rep.error || ''),
    JSON.stringify(rep || {}));
  boom.stop();
}

// ================================================================ 6. 不认识的消息不能让它崩
{
  inbox.length = 0;
  serverConn = [...wss.connections].pop();
  serverConn.sendJson({ type: 'sessions', items: [] }); // 主实例给手机端推的东西
  serverConn.sendJson({ type: 'follower:welcome' });
  const bad = 'not json at all';
  serverConn.send(bad);
  await new Promise((r) => setTimeout(r, 120));
  check('★ 收到无关消息与非 JSON 都不崩，也不误当成派活', attached.length === 1,
    `onAttach 被调了 ${attached.length} 次`);
}

// ================================================================ 7. stop 之后不再响应
{
  f.stop();
  const gone = await waitFor(() => wss.connections.size === 0, 2000);
  check('stop() 后连接关闭', gone, `剩 ${wss.connections.size} 条`);
}

wss.closeAll();
server.close();
process.env.HOME = REAL_HOME;
rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
