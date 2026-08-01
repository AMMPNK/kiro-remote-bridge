// 验证 activate() 的启动副作用：默认不碰 agent、不落盘；开了开关才跑，且落盘权限收紧。
//
// 为什么值得单独一个文件：这个行为的缺陷形态是「什么都不报错，只是悄悄多做了事」——
// 用户从没启动过 bridge，扩展却已连上全部 agent mux 并把 mux token 写进磁盘。
// 这类回归没有任何报错信号，只能靠断言「不该发生的事没发生」来挡。
//
// 两个方向都测：
//   A. 默认配置 → 一个 timer 都不注册，agent 命令一次都不调，磁盘一个文件都不写
//   B. 开了 debugProbeOnStartup → timer 确实注册，触发后确实探测，且落盘是 0700/0600
// 只测 A 会让「把功能彻底改坏」也显示通过；只测 B 挡不住默认值被翻回来。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import Module from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- 隔离真实 HOME
// DIAG_DIR 是 extension.js 的模块顶层常量（os.homedir() + '.kiro-bridge'），一旦 require
// 就固定了。所以必须在 require 之前改 HOME —— 否则这个测试会往用户真实的
// ~/.kiro-bridge 里写 agent-probe.json / diagnostics.json，把生产诊断数据覆盖掉。
const SANDBOX = mkdtempSync(join(tmpdir(), 'krb-activate-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SANDBOX;
mkdirSync(join(SANDBOX, '.kiro', 'sessions'), { recursive: true });

const DIAG = join(SANDBOX, '.kiro-bridge');
const diagFiles = () => (existsSync(DIAG) ? readdirSync(DIAG).sort() : []);
const modeOf = (p) => (statSync(p).mode & 0o777).toString(8);

// ---------------------------------------------------------------- 桩掉 vscode
let cfg = {};
const executed = [];
const fakeVscode = {
  version: '1.85.0-test',
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Beside: 2 },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
    createWebviewPanel: () => ({ webview: { html: '' }, dispose() {} }),
    showInformationMessage() {},
    showWarningMessage() {},
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    getCommands: async () => [],
    executeCommand: async (cmd) => {
      executed.push(cmd);
      // 返回空端点：refresh 能正常收尾，但不会真去连任何 WebSocket
      if (cmd === 'kiro.agentRegistry.getAgentEndpoints') return [];
      return undefined;
    },
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

// ---------------------------------------------------------------- 捕获 timer
// activate() 的两条启动路径都是 setTimeout。断言「有没有注册 timer」比「等一会儿看看有没有
// 发生」结实得多：那个 timer 是 4-5 秒的，等 200ms 什么都测不到，却会显示通过。
const realSetTimeout = globalThis.setTimeout;
let timers = [];
const captureTimers = (on) => {
  if (on) {
    timers = [];
    globalThis.setTimeout = (fn, ms, ...a) => { timers.push({ fn, ms }); return { unref() {} }; };
  } else {
    globalThis.setTimeout = realSetTimeout;
  }
};
const fakeContext = () => ({ subscriptions: [], extensionPath: ROOT });

// ================================================================ A. 默认配置
cfg = {};
executed.length = 0;
captureTimers(true);
ext.activate(fakeContext());
captureTimers(false);

check('默认配置下 activate 不注册任何延时任务', timers.length === 0,
  timers.length ? `注册了 ${timers.map((t) => t.ms + 'ms').join(',')}` : '');
check('默认配置下不向 agent 发任何命令', executed.length === 0, executed.join(','));
check('默认配置下不往 ~/.kiro-bridge 写任何文件', diagFiles().length === 0,
  diagFiles().join(','));
ext.deactivate();

// ================================================================ B. 显式打开探测
cfg = { debugProbeOnStartup: true };
executed.length = 0;
captureTimers(true);
ext.activate(fakeContext());
captureTimers(false);

check('打开开关后注册了一个延时任务', timers.length === 1,
  `${timers.length} 个: ${timers.map((t) => t.ms + 'ms').join(',')}`);
check('延时是 5 秒', timers.length === 1 && timers[0].ms === 5000,
  timers.length ? String(timers[0].ms) : '无');

// 手动触发那个 timer，把异步链跑完
if (timers.length === 1) {
  timers[0].fn();
  for (let i = 0; i < 40 && !diagFiles().includes('agent-probe.json'); i++) {
    await new Promise((r) => realSetTimeout(r, 25));
  }
}
check('触发后确实去取了 agent 端点',
  executed.includes('kiro.agentRegistry.getAgentEndpoints'), executed.join(','));
check('触发后落盘了诊断文件', diagFiles().length > 0, diagFiles().join(','));

// ================================================================ 权限
check('~/.kiro-bridge 目录权限为 700', existsSync(DIAG) && modeOf(DIAG) === '700',
  existsSync(DIAG) ? modeOf(DIAG) : '目录不存在');
const bad = diagFiles().filter((f) => modeOf(join(DIAG, f)) !== '600');
check('落盘文件权限全部为 600', diagFiles().length > 0 && bad.length === 0,
  bad.length ? bad.map((f) => `${f}=${modeOf(join(DIAG, f))}`).join(' ') : diagFiles().join(','));

// ================================================================ autoStart 仍然独立生效
cfg = { autoStart: true };
captureTimers(true);
ext.activate(fakeContext());
captureTimers(false);
check('autoStart 打开时注册 4 秒启动任务',
  timers.length === 1 && timers[0].ms === 4000,
  timers.map((t) => t.ms + 'ms').join(','));

// ================================================================ 权限记账会过期
// 失效形态是「假成功」：agent 早已取消该请求，bridge 仍对死掉的 requestId 回响应，
// 手机上却显示已批准。所以要断言的是「过期的请求必须显式失败」，而不只是「表会变小」。
{
  const { pendingPermissions, prunePendingPermissions, respondPermission, PERMISSION_TTL_MS } =
    ext.__test;
  pendingPermissions.clear();

  const responded = [];
  const fakeConn = {
    respond: (id, payload) => responded.push({ id, payload }),
    respondError: (id, code, msg) => responded.push({ id, code, msg }),
  };
  const mk = (id, ageMs) => {
    pendingPermissions.set(id, {
      connection: fakeConn,
      requestId: 'rpc-' + id,
      at: Date.now() - ageMs,
      optionIds: { allow: 'opt-allow', deny: 'opt-deny' },
    });
  };

  mk('fresh', 1000);
  mk('old', PERMISSION_TTL_MS + 60000);
  check('过期记录会被清掉，新鲜的留下',
    prunePendingPermissions() === 1 && pendingPermissions.has('fresh') &&
    !pendingPermissions.has('old'), `剩 ${[...pendingPermissions.keys()].join(',')}`);

  // 新鲜的照常走 mux 路径
  responded.length = 0;
  const okRes = await respondPermission('fresh', true);
  check('新鲜请求走 mux 单条批准',
    okRes && okRes.via === 'mux' && okRes.granularity === 'single' &&
    responded.length === 1 && responded[0].payload.outcome.optionId === 'opt-allow',
    JSON.stringify({ okRes, responded }));
  check('批准后记录被移除', !pendingPermissions.has('fresh'));

  // 过期的必须抛错，且绝不能对 agent 回响应
  mk('stale', PERMISSION_TTL_MS + 60000);
  responded.length = 0;
  let threw = null;
  try {
    await respondPermission('stale', true);
  } catch (e) { threw = e; }
  check('过期请求显式失败', !!threw && /过期/.test(threw.message),
    threw ? threw.message : '没有抛错');
  check('过期请求不对 agent 回任何响应', responded.length === 0, JSON.stringify(responded));
  check('过期请求的记录被清掉', !pendingPermissions.has('stale'));
  // 关键：不能退回整批命令。runOrAcceptAll 的作用范围远大于用户以为的那一个工具调用
  check('过期请求不会退化成整批批准',
    !executed.includes('kiroAgent.execution.runOrAcceptAll'), executed.join(','));
  pendingPermissions.clear();
}

// ================================================================ 声明与实现一致
const pkg = JSON.parse(require_('node:fs').readFileSync(join(ROOT, 'package.json'), 'utf8'));
const props = pkg.contributes.configuration.properties;
check('debugProbeOnStartup 已注册为配置项', !!props['kiroBridge.debugProbeOnStartup']);
check('debugProbeOnStartup 默认为 false',
  props['kiroBridge.debugProbeOnStartup'] &&
  props['kiroBridge.debugProbeOnStartup'].default === false,
  String(props['kiroBridge.debugProbeOnStartup'] &&
    props['kiroBridge.debugProbeOnStartup'].default));
check('autoStart 默认为 false', props['kiroBridge.autoStart'].default === false);

// ---------------------------------------------------------------- 收尾
ext.deactivate();
Module._resolveFilename = origResolve;
process.env.HOME = REAL_HOME;
rmSync(SANDBOX, { recursive: true, force: true });

console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
