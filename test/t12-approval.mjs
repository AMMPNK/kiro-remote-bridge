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
};

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
check('回给 agent 的是一条 respond', sent.length === 1 && sent[0].kind === 'respond',
  JSON.stringify(sent));
check('响应带对的 requestId', sent[0] && sent[0].id === 101);
check('响应形状是 selected + optionId',
  sent[0] && sent[0].payload.outcome.outcome === 'selected' &&
  sent[0].payload.outcome.optionId === 'accept',
  JSON.stringify(sent[0] && sent[0].payload));

// ================================================================ 3. 手机拒绝
pendingPermissions.clear();
sent = [];
incoming('tc-2', 102);
await respondPermission('tc-2', false);
check('拒绝用 deny 的 optionId',
  sent.length === 1 && sent[0].payload.outcome.optionId === 'reject',
  JSON.stringify(sent[0] && sent[0].payload));

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
  sent[0].payload.outcome.optionId === 'accept',
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
