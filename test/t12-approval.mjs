// 审批链路的端到端验证：mux 送来权限请求 → 记账 → 手机批准 → 回给 mux 的响应是否正确。
//
// 为什么单独一个文件：这是本项目最长期悬而未决的一件事（README 里那条「远程批准是否
// 可用」），而它此前没有任何自动化覆盖 —— 只有几次手工观察，而那几次样本恰好都落在
// 「被 agent 瞬间取消」的那一类里，导致结论下错了。
//
// 用的 options 形状照真实数据抄，不是编的：本机 183 次 tool_approval 里 703 个选项
// 都是 {optionId, name, kind} 这个形状。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Module from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- 隔离 HOME
// DIAG_DIR 是 extension.js 的模块顶层常量，必须在 require 之前改 HOME，
// 否则这个测试会往真实的 ~/.kiro-bridge 里写东西。
const SANDBOX = mkdtempSync(join(tmpdir(), 'krb-approval-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SANDBOX;
mkdirSync(join(SANDBOX, '.kiro', 'sessions'), { recursive: true });

const fakeVscode = {
  version: '1.85.0-test',
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Beside: 2 },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
    createWebviewPanel: () => ({ webview: { html: '' }, dispose() {} }),
    showInformationMessage() {}, showWarningMessage() {},
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    getCommands: async () => [],
    executeCommand: async (cmd) => { executed.push(cmd); return []; },
  },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, d) => d }) },
};
const executed = [];
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
const { pendingPermissions, respondPermission, markPermissionResolved, onMuxInbound } = ext.__test;

// ---------------------------------------------------------------- 假 mux 连接
/** 记录 bridge 回给 agent 的东西 */
let sent = [];
const fakeConn = {
  respond: (id, payload) => sent.push({ kind: 'respond', id, payload }),
  respondError: (id, code, message) => sent.push({ kind: 'error', id, code, message }),
  // 正确的提交通道。bridge 是 mux 的 observer 角色，回 JSON-RPC 应答会被丢弃，
  // 必须调 _kiro/permission/respond。
  respondPermission: async (sessionId, toolCallId, optionId, scope) => {
    if (failNextRespond) {
      failNextRespond = false;
      throw new Error('agent rejected');
    }
    sent.push({ kind: 'extMethod', sessionId, toolCallId, optionId, scope: scope || null });
    return {};
  },
};
let failNextRespond = false;

/** 照真实数据的形状造一个 tool_approval 权限请求 */
const REAL_OPTIONS = [
  { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always-accept', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  { optionId: 'always-reject', name: 'Always deny', kind: 'reject_always' },
];
const incoming = (toolCallId, id, options = REAL_OPTIONS) => {
  onMuxInbound({
    method: 'session/request_permission',
    id,
    connection: fakeConn,
    params: {
      sessionId: 'sess_x',
      toolCallId,
      title: 'feishu-mcp-pro/app_scopes',
      options,
    },
  });
};

// ================================================================ 1. 记账
pendingPermissions.clear();
sent = [];
incoming('tc-1', 101);
const rec = pendingPermissions.get('tc-1');
check('mux 权限请求被记下来', !!rec && rec.requestId === 101, JSON.stringify(rec && { id: rec.requestId }));
check('从真实选项里认出 allow',
  !!rec && rec.optionIds.allow === 'accept', rec && String(rec.optionIds.allow));
check('从真实选项里认出 deny',
  !!rec && rec.optionIds.deny === 'reject', rec && String(rec.optionIds.deny));
// 关键：allow 必须取「单次放行」而不是「永久放行」—— 后者作用范围大得多
check('allow 取单次放行而非永久放行',
  !!rec && rec.optionIds.allow === 'accept' && rec.optionIds.allow !== 'always-accept');
check('收到请求时不会立刻回响应（要等人批）', sent.length === 0, JSON.stringify(sent));

// ================================================================ 2. 手机批准
sent = [];
const r1 = await respondPermission('tc-1', true);
check('批准走 mux 单条路径', r1 && r1.via === 'mux' && r1.granularity === 'single',
  JSON.stringify(r1));
/*
 * 这里原来断言的是「回一条 JSON-RPC respond，带对的 requestId」——
 * 那个契约是错的，而且错得很隐蔽：形状完全符合 ACP 规范，测试全绿，实机却无效。
 *
 * 原因在 Kiro 产物的 MultiplexStream 里：mux 给每个客户端标了 role，
 * observer 的 permission 应答会被直接丢弃（日志原文
 * "discarded observer permission response ... (waiting for _kiro/permission/respond)"），
 * 只有 primary（拥有会话的桌面面板）的应答才转发给 agent。bridge 是 observer。
 *
 * 实测后果：手机点「允许」→ 电脑上的框继续挂着 → 5 分钟（产物里 300*1e3）超时后
 * 以 cancelled 收场，selectedOption 为空。
 */
check('走 _kiro/permission/respond 而不是 JSON-RPC 应答',
  sent.length === 1 && sent[0].kind === 'extMethod',
  JSON.stringify(sent));
check('带上 sessionId（该方法的必要参数）',
  sent[0] && sent[0].sessionId === 'sess_x', sent[0] && String(sent[0].sessionId));
check('带上 toolCallId 与 optionId',
  sent[0] && sent[0].toolCallId === 'tc-1' && sent[0].optionId === 'accept',
  JSON.stringify(sent[0]));
check('不再回 JSON-RPC 应答（会被 mux 当 observer 丢弃）',
  !sent.some((x) => x.kind === 'respond'), JSON.stringify(sent));

// ================================================================ 3. 手机拒绝
pendingPermissions.clear();
sent = [];
incoming('tc-2', 102);
await respondPermission('tc-2', false);
check('拒绝用 deny 的 optionId',
  sent.length === 1 && sent[0].optionId === 'reject',
  JSON.stringify(sent[0]));

// ================================================================ 4. 认不出 allow 时不能假装成功
// 缺 optionId 的 selected 在协议上是无效响应，agent 会当成取消处理，
// 而手机上却会显示「已回应」—— 宁可显式失败。
pendingPermissions.clear();
sent = [];
incoming('tc-3', 103, [{ optionId: 'weird', name: 'Hmm', kind: 'something_else' }]);
let threw = null;
try { await respondPermission('tc-3', true); } catch (e) { threw = e; }
check('认不出 allow 选项时显式失败', !!threw, threw ? threw.message : '没抛错');
check('并且如实给 agent 回 error 而不是空的 selected',
  sent.length === 1 && sent[0].kind === 'error' && sent[0].code === -32602,
  JSON.stringify(sent));

// ================================================================ 5. 不过期
// 这是用户明确要的行为：有审批就一直等，和电脑端一致。
pendingPermissions.clear();
sent = [];
incoming('tc-4', 104);
pendingPermissions.get('tc-4').at = Date.now() - 400 * 24 * 60 * 60 * 1000; // 400 天前
const r4 = await respondPermission('tc-4', true);
check('挂了 400 天的审批照样能批出去',
  r4 && r4.via === 'mux' && sent.length === 1 &&
  sent[0].optionId === 'accept',
  JSON.stringify({ via: r4 && r4.via, n: sent.length }));

// ================================================================ 6. 结局对账
// 「远程批准到底有没有落地」唯一的直接证据。
pendingPermissions.clear();
incoming('tc-5', 105);
await respondPermission('tc-5', true);
check('批准后记录保留下来等结局',
  pendingPermissions.has('tc-5') && !!pendingPermissions.get('tc-5').respondedAt);
check('结局到达时能对上账', markPermissionResolved('tc-5', 'selected') === true);
const done = pendingPermissions.get('tc-5');
check('对账后能算出「手机批的 → 实际结局」',
  done.respondedApprove === true && done.outcome === 'selected' &&
  typeof done.resolvedAt === 'number');

// 被 agent 瞬间取消的那一类（实测 6~130ms），也要能如实反映
pendingPermissions.clear();
incoming('tc-6', 106);
markPermissionResolved('tc-6', 'cancelled');
sent = [];
let canc = null;
try { await respondPermission('tc-6', true); } catch (e) { canc = e; }
check('已被 agent 取消的请求，点了会说清楚而不是假装成功',
  !!canc && /已被取消/.test(canc.message), canc ? canc.message : '没抛错');
check('对已取消的请求不回任何响应', sent.length === 0, JSON.stringify(sent));

// ================================================================ 6b. 手机指定 optionId
// 实测：手机上只给「允许 / 拒绝」两个按钮时，用户无法知道自己批的是单次还是永久，
// 而 allow_once 与 allow_always 的作用范围差别很大。所以四个选项都要摆出来，
// 并且用户点的那个 optionId 必须原样发出去，不能被后端的推断覆盖。
pendingPermissions.clear();
sent = [];
incoming('tc-7', 107);
check('记录里存下了全部四个选项',
  (pendingPermissions.get('tc-7').options || []).length === 4,
  `${(pendingPermissions.get('tc-7').options || []).length} 个`);

const r7 = await respondPermission('tc-7', true, 'always-accept');
check('指定 always-accept 时就发 always-accept（不被推断成 accept）',
  sent.length === 1 && sent[0].optionId === 'always-accept',
  JSON.stringify(sent[0]));
check('应答里回传实际发出的 optionId', r7 && r7.optionId === 'always-accept',
  JSON.stringify(r7));

// 四个选项逐个都要能原样发出
for (const want of ['accept', 'always-accept', 'reject', 'always-reject']) {
  pendingPermissions.clear();
  sent = [];
  incoming(`tc-opt-${want}`, 200);
  await respondPermission(`tc-opt-${want}`, !/reject/.test(want), want);
  check(`选项 ${want} 原样发出`,
    sent.length === 1 && sent[0].optionId === want,
    JSON.stringify(sent[0]));
}

// 不属于本次请求的 optionId 要被拒绝，而不是照发
pendingPermissions.clear();
sent = [];
incoming('tc-8', 108);
let bad = null;
try { await respondPermission('tc-8', true, 'not-a-real-option'); } catch (e) { bad = e; }
check('不属于本次请求的 optionId 被拒绝', !!bad && /不属于本次请求/.test(bad.message),
  bad ? bad.message : '没抛错');
check('被拒绝时不对 agent 发任何东西', sent.length === 0, JSON.stringify(sent));
check('被拒绝后记录还在（用户可以重新选）', pendingPermissions.has('tc-8'));

// 没给 optionId 时退回推断（老外壳页的兼容路径）
pendingPermissions.clear();
sent = [];
incoming('tc-9', 109);
await respondPermission('tc-9', true);
check('不给 optionId 时退回按 approve 推断（取单次放行）',
  sent.length === 1 && sent[0].optionId === 'accept',
  JSON.stringify(sent[0]));

// ================================================================ 6b-2. 永久授权的范围
// *_always 选项必须带 scope='user'，与电脑端一致（桌面响应时 scope 默认就是 user，
// 写 ~/.kiro/settings/permissions.yaml）。不带的话 agent 落到默认 'session'，
// 只进内存、会话结束即失效 —— 那就是「按钮写着 Always 却只管这一个会话」。
// 0.7.0 及之前就是这个状态，而当时被误记成了「限制」，其实只是少传一个字段。
const SCOPE_CASES = [
  ['accept', 'allow_once', null],
  ['always-accept', 'allow_always', 'user'],
  ['reject', 'reject_once', null],
  ['always-reject', 'reject_always', 'user'],
];
for (const [optId, kind, wantScope] of SCOPE_CASES) {
  pendingPermissions.clear();
  sent = [];
  incoming(`tc-scope-${optId}`, 300);
  await respondPermission(`tc-scope-${optId}`, !/reject/.test(optId), optId);
  const got = sent[0] || {};
  check(`${optId}（${kind}）的 scope 应为 ${wantScope || '不传'}`,
    sent.length === 1 && got.scope === wantScope,
    `实际 scope=${JSON.stringify(got.scope)}`);
}

// 单次选项不该带 scope —— 带了虽然无害，但语义上 scope 只对持久化有意义
pendingPermissions.clear();
sent = [];
incoming('tc-once-clean', 301);
await respondPermission('tc-once-clean', true, 'accept');
check('单次放行不声明 scope', sent[0] && sent[0].scope === null,
  JSON.stringify(sent[0]));

// 应答里要把 scope 回传给手机端，让 toast 能标出「永久」
pendingPermissions.clear();
sent = [];
incoming('tc-scope-echo', 302);
const rScope = await respondPermission('tc-scope-echo', true, 'always-accept');
check('应答回传 scope=user', rScope && rScope.scope === 'user', JSON.stringify(rScope));

// kind 认不出来时不要瞎猜成永久 —— 宁可退回 session（更保守的那一侧）
pendingPermissions.clear();
sent = [];
incoming('tc-weird-kind', 303, [
  { optionId: 'yes', name: 'Yes', kind: 'something_unknown' },
  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
]);
await respondPermission('tc-weird-kind', true, 'yes');
check('kind 无法识别时不声明 scope（偏保守）',
  sent[0] && sent[0].scope === null, JSON.stringify(sent[0]));

// ================================================================ 6c. 提交失败要如实说
// agent 拒绝或超时时，绝不能让手机端以为批准成功了 —— 这正是此前那个 bug 的形态。
pendingPermissions.clear();
sent = [];
incoming('tc-10', 110);
failNextRespond = true;
let subErr = null;
try { await respondPermission('tc-10', true, 'accept'); } catch (e) { subErr = e; }
check('提交失败时抛错而不是假装成功', !!subErr && /提交失败/.test(subErr.message),
  subErr ? subErr.message : '没抛错');
check('提交失败后 respondedAt 被清掉，可以重试',
  pendingPermissions.has('tc-10') && !pendingPermissions.get('tc-10').respondedAt);
sent = [];
const retry = await respondPermission('tc-10', true, 'accept');
check('失败后能重新提交', retry && retry.via === 'mux' && sent.length === 1,
  JSON.stringify(sent));

// 缺 sessionId 时不能瞎发（该方法要求 sessionId）
pendingPermissions.clear();
sent = [];
onMuxInbound({
  method: 'session/request_permission',
  id: 111,
  connection: fakeConn,
  params: { toolCallId: 'tc-11', title: 'no session', options: REAL_OPTIONS },
});
let noSid = null;
try { await respondPermission('tc-11', true, 'accept'); } catch (e) { noSid = e; }
check('缺 sessionId 时显式失败而不是发一个不完整的请求',
  !!noSid && /会话标识/.test(noSid.message) && sent.length === 0,
  noSid ? noSid.message : '没抛错');

// ================================================================ 7. 任何失败都不退化成整批批准
check('全过程没有触发 runOrAcceptAll',
  !executed.includes('kiroAgent.execution.runOrAcceptAll'), executed.join(','));

// ---------------------------------------------------------------- 收尾
pendingPermissions.clear();
ext.deactivate();
Module._resolveFilename = origResolve;
process.env.HOME = REAL_HOME;
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
