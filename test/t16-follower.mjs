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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
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

// ================================================================ 8. 主实例没了 → 尝试升主
// 这是「主窗口一关，远程能力全没」的修法。判据是断线后先问一次能不能自己上位，
// 上位成功就停止从属逻辑（不然一个实例会同时是主又是从）。
{
  let promoteAsked = 0;
  const f2 = new Follower({
    port: PORT,
    workspacePaths: ['/ws/promote'],
    log: () => {},
    onAttach: async () => {},
    tryPromote: async () => { promoteAsked += 1; return true; }, // 假装抢到了端口
  });
  const ok = await f2.start();
  check('待命建立', ok === true);
  const conn = [...wss.connections].pop();
  conn.terminate(); // 模拟主实例所在的窗口被关掉
  const asked = await waitFor(() => promoteAsked > 0, 3000);
  check('★ 主实例断开后会问一次「我能不能自己上位」', asked, `问了 ${promoteAsked} 次`);
  check('★ 升主成功后停止从属逻辑（stopped=true，不再重连）', f2.stopped === true);
  const stayed = await waitFor(() => f2.retryTotal > 0, 400);
  check('★ 升主成功后不再排重连', stayed === false, `重连了 ${f2.retryTotal} 次`);
  f2.stop();
}

// ================================================================ 9. 抢不到端口 → 持久重连
// 原先固定三次就永久放弃，而失效是静默的、要到人真正去用时才暴露。
// 现在退避到最后一档会一直重试。这里只验「不会因为次数用完而停」。
{
  let promoteTries = 0;
  const f3 = new Follower({
    port: PORT,
    workspacePaths: ['/ws/keepretry'],
    log: () => {},
    onAttach: async () => {},
    tryPromote: async () => { promoteTries += 1; return false; }, // 一直抢不到
  });
  const ok = await f3.start();
  check('待命建立', ok === true);
  // 把退避第一档压到很小，否则要等 1 秒起
  const conn = [...wss.connections].pop();
  conn.terminate();
  // 连续断几次，确认它一直在重连而不是放弃
  const reconnected = await waitFor(() => f3.retryTotal >= 1, 3000);
  check('★ 断开后会重连（不是立刻放弃）', reconnected, `retryTotal=${f3.retryTotal}`);
  check('★ 每次断开都先问过能不能升主', promoteTries >= 1, `问了 ${promoteTries} 次`);
  const reconnectedAgain = await waitFor(() => wss.connections.size > 0, 3000);
  check('★ 真的连回来了', reconnectedAgain, `连接数 ${wss.connections.size}`);
  // 再断一次，验证退避没有"用完次数就不干了"
  const before = f3.retryTotal;
  const conn2 = [...wss.connections].pop();
  if (conn2) conn2.terminate();
  const again = await waitFor(() => f3.retryTotal > before, 4000);
  check('★ 第二次断开照样重连（不存在"次数用完"）', again,
    `retryTotal ${before} → ${f3.retryTotal}`);

  /*
   * 上面只走到第 2 次重连。真正要守的是「**退到最后一档之后一直重试、永不放弃**」，
   * 而端到端验它要连断 5 次、累计等 1+3+8+20+60 秒，测试会慢到没人愿意跑。
   * 所以这里改成检查那段索引逻辑本身：用 Math.min 夹住索引就意味着不会越界成
   * undefined、也就不会出现"次数用完"。注入验证过：把它换回
   * `RETRY_DELAYS_MS[this.retry]` + `if (undefined) return`，前面那两条断言仍然通过
   * （因为 3 次以内够用），只有这条能拦住。
   */
  const followerSrc = readFileSync(join(ROOT, 'src', 'follower.js'), 'utf8');
  check('★ 退避索引被夹住，不会因为次数用完而放弃',
    /Math\.min\(this\.retry, RETRY_DELAYS_MS\.length - 1\)/.test(followerSrc));
  check('退避序列是单调递增的，且最长一档到分钟级', (() => {
    const m = /const RETRY_DELAYS_MS = \[([^\]]+)\]/.exec(followerSrc);
    if (!m) return false;
    const arr = m[1].split(',').map((x) => Number(x.trim()));
    const inc = arr.every((v, i) => i === 0 || v > arr[i - 1]);
    return inc && arr[arr.length - 1] >= 30000;
  })(), (/const RETRY_DELAYS_MS = \[([^\]]+)\]/.exec(followerSrc) || [, '?'])[1].trim());
  /*
   * stop() 之后不能再连回来 —— 少了 stop 里清理定时器那一步就会。
   *
   * 断言要挑对时机：必须在**有一个重连已经排上、但还没触发**的那一刻调 stop，
   * 否则「stop 后连接数没涨」是恒真的（本来就没有待触发的重连）。
   * 第一版就写错了，跑出来是「stop 前 0 → 现在 0」，看着通过、其实什么都没测。
   */
  const c3 = [...wss.connections].pop();
  if (c3) c3.terminate();
  await waitFor(() => f3._retryTimer !== null && !f3.connected, 2000);
  check('确认此刻有一个重连正排着（下面那条断言才有意义）',
    !!f3._retryTimer && !f3.connected, `timer=${!!f3._retryTimer} connected=${f3.connected}`);
  f3.stop();
  const cnt = wss.connections.size;
  await new Promise((r) => setTimeout(r, 1500));
  check('★ stop() 之后那个排上的重连不会再执行',
    wss.connections.size === cnt && f3.connected === false,
    `stop 前 ${cnt} → 现在 ${wss.connections.size}，connected=${f3.connected}`);
  /*
   * 关于上面这条的守护层次（注入实测过，如实记下来）：
   * 这个行为实际由 `stopped` 标志保证 —— 定时器回调开头就是 `if (this.stopped) return`。
   * 把 stop() 里的 clearTimeout 删掉，这条断言**照样通过**，因为标志已经挡住了重连。
   * 所以 clearTimeout 是资源清理（不留一个必然空转的定时器），不是这条行为的守护者。
   * 保留断言是对的（它验的是行为），但别指望它能守住 clearTimeout ——
   * 那属于「这个分支不该由这一层守护」。
   */
}

wss.closeAll();
server.close();
process.env.HOME = REAL_HOME;
rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
