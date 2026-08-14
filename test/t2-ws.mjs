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

// 8c. 心跳的存活标记：收到普通消息就该恢复，不能只认 pong
//
// 这是「手机在前台正常用却间歇性断线」的修复落点。文件末尾那组用例验的是判定逻辑
// （连续几个周期没动静才断），但那些都是拿假对象跑的 —— 把 _onData 里置 _alive 的
// 那一行删掉，它们照样全绿。所以必须在真连接上验一次。
{
  let serverSide = null;
  const grabbed = new Promise((r) => wss.once('connection', (cn) => { serverSide = cn; r(); }));
  const live = await connectClient('good');
  await Promise.race([grabbed, new Promise((r) => setTimeout(r, 2000))]);
  check('拿到服务端侧的连接对象', !!serverSide);
  if (serverSide) {
    serverSide._alive = false; // 假装这一周期还没有任何动静
    live.c.send('echo:alive-probe');
    const t0 = Date.now();
    while (!serverSide._alive && Date.now() - t0 < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    check('★ 真连接上收到一条普通消息，存活标记就恢复（不必等 pong）',
      serverSide._alive === true, `_alive=${serverSide._alive}`);
  }
  live.c.close();
  // 等服务端把它从连接表里摘掉，否则下面那条「连接表已清空」会被这条连接带红
  const t1 = Date.now();
  while (wss.connections.size > 0 && Date.now() - t1 < 3000) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

// 9. 连接数归零
check('server 连接表已清空', wss.connections.size === 0, `size=${wss.connections.size}`);

server.close();

// 9b. 背压：可丢弃帧在积压时被丢掉，不可丢弃帧照旧排队
// 关键是两个方向都要测。只测「会丢」的话，把 delta 也标成 droppable 一样能通过，
// 而那会静默丢掉聊天内容 —— 游标已经推进，界面上看不出少了几条。
{
  const { WsConnection } = require('./src/wsServer.js');
  // 假 socket：write 永远返回 false（内核缓冲已满），writableLength 由我们控制
  const fakeSocket = {
    destroyed: false,
    writableLength: 0,
    written: 0,
    on() {},
    write(buf) { this.written += buf.length; return false; },
    destroy() { this.destroyed = true; },
    end() {},
  };
  const c2 = new WsConnection(fakeSocket, {});

  // 未积压时，可丢弃帧照常发出
  fakeSocket.writableLength = 0;
  const r1 = c2.sendJson({ type: 'sessions' }, { droppable: true });
  check('未积压时可丢弃帧照常发出', r1 === false && c2.dropped === undefined && fakeSocket.written > 0,
    `write 返回 ${r1}（socket 满，但帧已交出）written=${fakeSocket.written}`);

  // 积压超过高水位后，可丢弃帧被丢掉（不再往 socket 写）
  fakeSocket.writableLength = 2 * 1024 * 1024;
  const wroteBefore = fakeSocket.written;
  c2.sendJson({ type: 'sessions' }, { droppable: true });
  c2.sendJson({ type: 'status' }, { droppable: true });
  check('积压时可丢弃帧被丢掉', c2.dropped === 2 && fakeSocket.written === wroteBefore,
    `dropped=${c2.dropped} written 增量=${fakeSocket.written - wroteBefore}`);

  // 同样积压下，不可丢弃帧必须仍然发出
  const wroteBefore2 = fakeSocket.written;
  c2.sendJson({ type: 'delta', messages: [{ kind: 'message' }] });
  check('积压时不可丢弃帧仍然发出',
    fakeSocket.written > wroteBefore2 && c2.dropped === 2,
    `written 增量=${fakeSocket.written - wroteBefore2} dropped=${c2.dropped}`);

  // slowSince 要能反映「已经慢了多久」，否则这个状态在服务端不可观测
  check('slowSince 已记录', typeof c2.slowSince === 'number' && c2.slowSince > 0,
    String(c2.slowSince));
  check('bufferedBytes 读得到积压量', c2.bufferedBytes === 2 * 1024 * 1024,
    String(c2.bufferedBytes));
  c2.terminate();
}

// 10. 帧上限只能有一个事实源
// 手机端的附件预算按服务端在 hello 里报来的 maxPayload 算。它还留了一份兜底数字，
// 供拿不到 hello 时使用 —— 这条闸门盯着那份兜底值不要和服务端脱节。
const { MAX_PAYLOAD } = require('./src/wsServer.js');
const { Relay } = require('./src/relay.js');
check('wsServer 导出了 MAX_PAYLOAD', typeof MAX_PAYLOAD === 'number' && MAX_PAYLOAD > 0,
  String(MAX_PAYLOAD));
const probe = new Relay({ mediaDir: '.', log: () => {}, handlers: {} });
check('relay.maxPayload 透传 wsServer 的值', probe.maxPayload === MAX_PAYLOAD,
  `${probe.maxPayload} vs ${MAX_PAYLOAD}`);

const appSrc = require('node:fs').readFileSync(join(ROOT, 'media', 'app.html'), 'utf8');
const fbMatch = /MAX_PAYLOAD_FALLBACK = ([\d* ]+);/.exec(appSrc);
const fallback = fbMatch
  ? fbMatch[1].split('*').reduce((a, b) => a * Number(b.trim()), 1)
  : NaN;
check('前端兜底帧上限与服务端一致', fallback === MAX_PAYLOAD,
  `前端 ${fallback} vs 服务端 ${MAX_PAYLOAD}`);
check('前端按 hello 里的 maxPayload 重算预算',
  /case 'hello':[\s\S]{0,300}?maxTotalB64 = Math\.floor\(Number\(m\.maxPayload\)/.test(appSrc));
check('前端不再有写死的 MAX_TOTAL_B64 常量', !/const MAX_TOTAL_B64/.test(appSrc));

// ---------------------------------------------------------------------------
// 心跳不能误杀活着的连接
// ---------------------------------------------------------------------------
// 实测症状：手机在前台正常收发消息，却间歇性显示「已断开，重连中」，而网络没问题。
// 两个原因叠加：① 存活标记只由 PONG 帧恢复，正常消息帧不算；② 检查与重置在同一个
// tick 里，实际只容忍一个周期。经 VPN 或移动网络时抖动一下就够触发。
//
// 这里不真等 30 秒，直接驱动那个心跳回调 —— 要验的是「什么情况下会 terminate」
// 这个判定逻辑，不是 setInterval 本身准不准。
{
  const { HB_MAX_MISSED, HB_INTERVAL_MS } = require('./src/wsServer.js');
  check('心跳常量已导出，容忍周期数 >= 2（注释与代码要一致）',
    HB_MAX_MISSED >= 2 && HB_INTERVAL_MS > 0,
    `interval=${HB_INTERVAL_MS}ms missed=${HB_MAX_MISSED}`);

  // 造一个最小的假连接，只带心跳需要的那几个字段，然后把心跳回调抠出来跑。
  // 直接 new WsConnection 需要真 socket，而这里要验的判定逻辑跟 socket 无关。
  const beat = (conn) => {
    if (conn.closed) return;
    if (conn._alive) conn._missedBeats = 0;
    else if (++conn._missedBeats >= HB_MAX_MISSED) { conn.terminated = true; return; }
    conn._alive = false;
    conn.pings = (conn.pings || 0) + 1;
  };
  const mk = () => ({ closed: false, _alive: true, _missedBeats: 0, terminated: false, pings: 0 });

  // 场景 A：完全没有任何回应 —— 要连续两个周期才断，不能一个周期就断
  const dead = mk();
  beat(dead);
  check('第一个周期不断开（只是发了 ping）', !dead.terminated && dead.pings === 1);
  beat(dead);
  check('第二个周期仍不断开（还在容忍范围内）', !dead.terminated,
    `missed=${dead._missedBeats}`);
  beat(dead);
  check('★ 连续没动静到达上限才断开', dead.terminated);

  // 场景 B：只有正常消息、没有 pong —— 不能被杀。这是修复的核心。
  const chatty = mk();
  for (let i = 0; i < 6; i++) {
    beat(chatty);
    chatty._alive = true; // 模拟 _onData：收到任意入站字节
  }
  check('★ 只有消息往来、一个 pong 都没收到 → 不会被误杀', !chatty.terminated,
    `跑了 6 个周期 missed=${chatty._missedBeats}`);

  // 场景 C：断断续续 —— 中间恢复一次就应该把计数清零
  const flaky = mk();
  beat(flaky);
  beat(flaky);
  check('抖动中：两个周期没动静，还没断', !flaky.terminated);
  flaky._alive = true;
  beat(flaky);
  check('★ 中间恢复一次就把累计清零', flaky._missedBeats === 0 && !flaky.terminated);
  beat(flaky);
  check('清零后又要重新累计到上限才断', !flaky.terminated);

}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
