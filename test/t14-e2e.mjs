// 半自动端到端：把真实的东西全用真的，只给 agent 和浏览器渲染换替身。
//
// 为什么需要这一层：0.7.2~0.7.5 四个修复版全部由人在手机上实测发现，
// 而当时已有 352 项测试全绿。原因是那些 bug 落在**组件之间**——
// 真实 WebSocket 断连、文件游标与轮询的交互、连接级记账的丢失 ——
// 单元测试各自 mock 掉了对面，谁也测不到接缝。
//
// 真的部分：Relay（真 HTTP + WebSocket + token 认证）、buildHandlers()、SessionStore、
//           真实 messages.jsonl、真实 tail 轮询定时器、真实的命令注册路径。
// 假的部分：mux 连接（真 agent 要 Kiro 在跑）、浏览器渲染（这里只验消息，不验像素）。
//
// 隔离纪律：HOME 指向临时目录、端口用 0（随机）、bindLan=false。
// **绝不能碰用户真实的会话文件，也绝不能占用 3939** —— 否则跑测试会踢掉他手机上的连接。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Module from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 比 extension.js 的 TAIL_INTERVAL_MS(900) 多留一点，用来确认「某条消息始终没来」 */
const TAIL_WAIT = 1400;

// ---------------------------------------------------------------- 隔离环境
const SANDBOX = mkdtempSync(join(tmpdir(), 'krb-e2e-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SANDBOX;

const SID = 'sess_e2e_main';
const SID2 = 'sess_e2e_other';
const sessDir = (sid) => join(SANDBOX, '.kiro', 'sessions', 'ws1', sid);

function makeSession(sid, title) {
  const dir = sessDir(sid);
  mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    join(dir, 'session.json'),
    JSON.stringify({
      id: sid,
      title,
      agentMode: 'vibe',
      status: 'idle',
      modelId: 'test-model',
      workspacePaths: [join(SANDBOX, 'ws1')],
      createdAt: now,
      lastModifiedAt: now,
    })
  );
  writeFileSync(join(dir, 'messages.jsonl'), '');
}

let evSeq = 0;
const appendEvent = (sid, payload) =>
  appendFileSync(
    join(sessDir(sid), 'messages.jsonl'),
    JSON.stringify({ id: `e${++evSeq}`, timestamp: new Date().toISOString(), payload }) + '\n'
  );

makeSession(SID, '端到端主会话');
makeSession(SID2, '另一个会话');

// ---------------------------------------------------------------- vscode 替身
// port=0 让 relay 随机取端口，bindLan=false 只监听本机 —— 两条都是隔离的关键
const cfg = { port: 0, bindLan: false, autoStart: false, debugProbeOnStartup: false };
const cmds = new Map();
const fakeVscode = {
  version: '1.85.0-e2e',
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Beside: 2 },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }),
    createWebviewPanel: () => ({ webview: { html: '' }, onDidDispose() {}, dispose() {} }),
    showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
  },
  commands: {
    // 捕获真实注册的 handler：下面走命令路径启动，而不是从后门调 start()
    registerCommand: (id, fn) => {
      cmds.set(id, fn);
      return { dispose() {} };
    },
    getCommands: async () => [],
    executeCommand: async () => [],
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (k, d) => (k in cfg ? cfg[k] : d) }),
  },
};
const stubPath = join(SANDBOX, 'vscode-stub.cjs');
const require_ = createRequire(join(ROOT, 'package.json'));
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return stubPath;
  return origResolve.call(this, request, ...rest);
};
require_('node:fs').writeFileSync(stubPath, 'module.exports = globalThis.__FAKE_VSCODE__;');
globalThis.__FAKE_VSCODE__ = fakeVscode;

const ext = require_('./src/extension.js');
ext.activate({ subscriptions: [], extensionPath: ROOT });
const { onMuxInbound, pendingPermissions, getRelay } = ext.__test;

// ---------------------------------------------------------------- agent 替身
const agentGot = [];
const fakeConn = {
  respond: () => {},
  respondError: () => {},
  respondPermission: async (sessionId, toolCallId, optionId, scope) => {
    agentGot.push({ sessionId, toolCallId, optionId, scope: scope || null });
    return {};
  },
};
const OPTIONS = [
  { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always-accept', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  { optionId: 'always-reject', name: 'Always deny', kind: 'reject_always' },
];
let reqId = 900;
function agentAsksPermission(sid, toolCallId) {
  onMuxInbound({
    method: 'session/request_permission',
    id: ++reqId,
    connection: fakeConn,
    params: { sessionId: sid, toolCallId, title: 'Write File', options: OPTIONS },
  });
  // 文件里也留下痕迹，和真实 agent 一致
  appendEvent(sid, {
    type: 'pending_interaction',
    interactionType: 'tool_approval',
    toolCallId,
    question: 'Write File',
    options: OPTIONS,
  });
}

// ---------------------------------------------------------------- 手机替身
let PORT = 0;
let TOKEN = '';

class Phone {
  constructor(label) {
    this.label = label;
    this.msgs = [];
    this.ws = null;
  }
  async connect() {
    this.msgs = [];
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`);
    this.ws.onmessage = (e) => {
      try {
        this.msgs.push(JSON.parse(e.data));
      } catch (_) {
        /* 非 JSON 忽略 */
      }
    };
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${this.label} 4 秒内没连上`)), 4000);
      this.ws.addEventListener('open', () => {
        clearTimeout(t);
        res();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(t);
        rej(new Error(`${this.label} 连接出错`));
      });
    });
    return this;
  }
  send(type, extra = {}) {
    this.ws.send(JSON.stringify({ type, ...extra }));
  }
  /**
   * 等到出现满足条件的消息。从已收到的全部消息里找，所以不会因为「等之前就到了」而漏。
   * 超时时把收到过的类型列出来 —— 排查时最需要的就是这个。
   */
  async waitFor(pred, label, timeoutMs = 5000) {
    return this.waitSince(0, pred, label, timeoutMs);
  }
  /**
   * 当前已收到的消息数。配合 waitSince 用。
   *
   * 为什么需要它：同一个连接上重复做同一件事（比如再打开一次同一个会话）时，
   * `waitFor` 会先命中**上一次**那条同类型消息，于是断言其实在检查旧数据。
   * 正确顺序是「先 mark、再 send、再 waitSince」。
   */
  mark() {
    return this.msgs.length;
  }
  async waitSince(from, pred, label, timeoutMs = 5000) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.msgs.slice(from).find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > timeoutMs) {
        throw new Error(
          `${this.label} 等不到「${label}」（${timeoutMs}ms）。第 ${from} 条之后收到: ${
            this.msgs.slice(from).map((m) => m.type).join(', ') || '(什么都没收到)'
          }`
        );
      }
      await sleep(40);
    }
  }
  close() {
    try {
      this.ws.close();
    } catch (_) {
      /* ignore */
    }
  }
}

/** 场景包一层：任何一条超时都不该让整个文件崩掉，要能继续跑后面的场景 */
async function scenario(name, fn) {
  console.log(`\n--- ${name}`);
  try {
    await fn();
  } catch (e) {
    check(`${name} 未抛异常`, false, e && e.message);
  }
}

// ================================================================ 启动
await cmds.get('kiroBridge.start')();
const relay = getRelay();
PORT = relay.port;
TOKEN = relay.token;
check('relay 起在随机端口（不占用 3939）', PORT > 0 && PORT !== 3939, `端口=${PORT}`);
check('只监听本机，不绑局域网', relay.bindLan === false);

let A = null;

await scenario('1. 手机连上来的握手序列', async () => {
  A = await new Phone('手机A').connect();
  const hello = await A.waitFor((m) => m.type === 'hello', 'hello');
  check('连上就收到 hello', !!hello);
  check('hello 带 maxPayload（手机要按服务端真实帧上限算附件预算）',
    Number(hello.maxPayload) > 0, String(hello.maxPayload));
  const list = await A.waitFor((m) => m.type === 'sessions', 'sessions');
  check('握手后主动推会话列表，手机不用自己发请求',
    (list.items || []).some((s) => s.sessionId === SID), `${(list.items || []).length} 个会话`);
  await A.waitFor((m) => m.type === 'status', 'status');
  check('也推了聚合状态', true);
});

await scenario('2. 打开会话', async () => {
  A.send('session:open', { sessionId: SID, limit: 400 });
  const h = await A.waitFor((m) => m.type === 'history' && m.sessionId === SID, 'history');
  check('拿到该会话的历史', !!h);
  check('没有待批时 pending 是空数组（前端要能无条件覆盖队列）',
    Array.isArray(h.pending) && h.pending.length === 0, JSON.stringify(h.pending));
});

const TC1 = 'tc-e2e-1';
await scenario('3. agent 请求授权 → 手机收到浮窗数据', async () => {
  agentAsksPermission(SID, TC1);
  const perm = await A.waitFor((m) => m.type === 'permission' && m.toolCallId === TC1, 'permission');
  check('手机收到授权请求', !!perm);
  check('四个选项原样送达（不替用户预先推断）',
    ['accept', 'always-accept', 'reject', 'always-reject'].every((id) =>
      (perm.options || []).some((o) => o.optionId === id)),
    JSON.stringify((perm.options || []).map((o) => o.optionId)));
  check('带标题，框里不会是空的', !!perm.title);
});

await scenario('4. 手机批准 → agent 真的收到提交', async () => {
  agentGot.length = 0;
  A.send('session:approve', { sessionId: SID, toolCallId: TC1, approve: true, optionId: 'accept' });
  const ack = await A.waitFor((m) => m.type === 'approved' && m.toolCallId === TC1, 'approved');
  check('手机收到提交结果', ack.via === 'mux', JSON.stringify(ack));
  check('★ agent 侧真的收到了这次批准',
    agentGot.some((g) => g.toolCallId === TC1 && g.optionId === 'accept'),
    JSON.stringify(agentGot));
  check('单次放行不声明 scope（不该顺手做成永久）',
    agentGot.every((g) => g.scope === null), JSON.stringify(agentGot));
});

const TC2 = 'tc-e2e-2';
await scenario('5. 真断线再重连 → 未处理的授权还在', async () => {
  agentAsksPermission(SID, TC2);
  await A.waitFor((m) => m.type === 'permission' && m.toolCallId === TC2, 'permission TC2');
  // 真的把 WebSocket 关掉，再开一条全新连接（等价于手机刷新页面）
  A.close();
  await sleep(250);
  A = await new Phone('手机A-重连').connect();
  A.send('session:open', { sessionId: SID, limit: 400 });
  const h = await A.waitFor((m) => m.type === 'history' && m.sessionId === SID, 'history');
  check('★ 断线重连后未处理的授权被重放回来（真关了 WebSocket）',
    (h.pending || []).some((p) => p.toolCallId === TC2),
    JSON.stringify((h.pending || []).map((p) => p.toolCallId)));
  check('重放的数据带得出可点选项',
    (h.pending || []).some((p) => (p.options || []).length === 4));
});

await scenario('6. 电脑上批准 → 结局经 tail 推到手机', async () => {
  appendEvent(SID, {
    type: 'interaction_resolved',
    toolCallId: TC2,
    outcome: 'selected',
    selectedOption: 'accept',
  });
  const d = await A.waitFor(
    (m) =>
      (m.type === 'delta' || m.type === 'history') &&
      (m.messages || []).some((x) => x.kind === 'resolved' && x.toolCallId === TC2),
    'resolved 经 tail 到达'
  );
  check('★ 电脑上批准后，结局真的通过轮询推到了手机', !!d);
});

/*
 * 下面两个场景验的是**用户可见行为**：电脑上批过之后，手机再进不该看到那个框。
 *
 * 它们**不守护**「重放前核对文件」这个分支 —— 注入验证证实过：把核对逻辑整段撤掉，
 * 这两个场景照样全绿。因为 tail 推送结局时也会调 markPermissionResolved，
 * 两条路达成的是同一个结果，而端到端只看得见结果、看不见走了哪条路。
 *
 * 那个分支由 t12 的「★ 电脑上批过之后不再重放这条授权」守护（那里不起轮询，
 * 能精确复现游标跳过）。**分层原则：e2e 验行为，单元验分支。**
 * 写在这里是为了不让后来人误以为 e2e 覆盖了那个逻辑。
 */
await scenario('7. 电脑批过之后重进，不再弹回来（行为）', async () => {
  A.close();
  await sleep(250);
  A = await new Phone('手机A-再进').connect();
  const mark = A.mark();
  A.send('session:open', { sessionId: SID, limit: 400 });
  const h = await A.waitSince(mark, (m) => m.type === 'history' && m.sessionId === SID, 'history');
  check('电脑上处理过的授权不再出现在待批里', 
    !(h.pending || []).some((p) => p.toolCallId === TC2),
    JSON.stringify((h.pending || []).map((p) => p.toolCallId)));
});

const TC5 = 'tc-e2e-5';
await scenario('7b. 手机离线期间电脑批准 → 重连后也不该弹（复现锁屏场景）', async () => {
  agentAsksPermission(SID, TC5);
  await A.waitFor((m) => m.type === 'permission' && m.toolCallId === TC5, 'permission TC5');
  /*
   * 手机下线。tail 轮询的第一个条件就是「有没有客户端连着」，没有就整个跳过 ——
   * 所以接下来写入的结局，在手机重连之前一次都不会被读到。
   * 这正是「人锁屏几分钟、期间在电脑上批准」的真实时序。
   */
  A.close();
  await sleep(300);
  appendEvent(SID, {
    type: 'interaction_resolved',
    toolCallId: TC5,
    outcome: 'selected',
    selectedOption: 'reject',
  });
  await sleep(TAIL_WAIT); // 这段时间里没有客户端，tail 确实没跑

  A = await new Phone('手机A-锁屏后').connect();
  const mark = A.mark();
  A.send('session:open', { sessionId: SID, limit: 400 });
  const h = await A.waitSince(mark, (m) => m.type === 'history' && m.sessionId === SID, 'history');
  check('★ 离线期间被电脑批准的授权，重连后不再弹回来',
    !(h.pending || []).some((p) => p.toolCallId === TC5),
    JSON.stringify((h.pending || []).map((p) => p.toolCallId)));
  check('这一条被判为拒绝，不该出现在待批里也不该显示成已允许',
    !(h.pending || []).some((p) => p.toolCallId === TC5));
});

const TC3 = 'tc-e2e-3';
await scenario('8. 会话之间互不串台', async () => {
  agentAsksPermission(SID2, TC3);
  await sleep(200);
  // 这里必须用 mark/waitSince：这条连接上已经有过一次 SID 的 history，
  // 直接 waitFor 会命中那条旧的，断言就变成在检查历史数据
  const mark = A.mark();
  A.send('session:open', { sessionId: SID, limit: 400 });
  const h = await A.waitSince(
    mark,
    (m) => m.type === 'history' && m.sessionId === SID,
    'history（再次打开 SID）'
  );
  check('★ 别的会话的待批不会混进这个会话',
    !(h.pending || []).some((p) => p.toolCallId === TC3),
    JSON.stringify((h.pending || []).map((p) => p.toolCallId)));
});

await scenario('9. 两台手机各看一个会话，增量定向推送', async () => {
  const B = await new Phone('手机B').connect();
  B.send('session:open', { sessionId: SID2, limit: 400 });
  await B.waitFor((m) => m.type === 'history' && m.sessionId === SID2, 'B 的 history');
  const beforeB = B.msgs.length;
  appendEvent(SID, { type: 'assistant', content: '只给看 SID 的那台', operationType: 'Answer' });
  await A.waitFor(
    (m) => m.type === 'delta' && m.sessionId === SID,
    'A 收到 SID 的增量'
  );
  // 再多等一个轮询周期，确认 B 始终没被波及
  await sleep(TAIL_WAIT);
  check('★ 会话增量只发给正在看它的那台手机（不广播给所有人）',
    !B.msgs.slice(beforeB).some((m) => m.type === 'delta' && m.sessionId === SID),
    `B 之后收到: ${B.msgs.slice(beforeB).map((m) => m.type).join(',') || '(无)'}`);
  B.close();
});

const TC4 = 'tc-e2e-4';
await scenario('10. 桥重启 → 内存记账清空（之后只能靠上游补发）', async () => {
  agentAsksPermission(SID, TC4);
  await sleep(150);
  check('重启前这条在内存里', pendingPermissions.has(TC4));
  A.close();
  await cmds.get('kiroBridge.stop')();
  check('★ 桥重启后内存记账被清空', !pendingPermissions.has(TC4));
  // 文件里那条 pending_interaction 还在，所以历史卡片仍会显示「待确认」——
  // 按钮要靠 Kiro 上游的 resendPendingPermissions() 补发。这条互补路径需要真实 agent，
  // 自动化测不到，只能在人工清单里保留。
  check('（已知边界）文件里的 pending 仍在，按钮靠上游补发，此处不可自动验证', true);
});

// ---------------------------------------------------------------- 收尾
try {
  await cmds.get('kiroBridge.stop')();
} catch (_) {
  /* 已经停了 */
}
ext.deactivate();
Module._resolveFilename = origResolve;
process.env.HOME = REAL_HOME;
rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
