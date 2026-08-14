// 失败路径的处理。
//
// 这一组测的都是「出错时怎么办」，而不是正常流程 —— 这类路径的共同点是：
// 平时永远不执行，所以既没人手动碰到，也不会被别的测试顺带覆盖。
// 全量测试 397 项全绿的同时，本文件里第 2、3 项在修之前是失败的。
//
// 覆盖三处：
//   ① app.html 的 token 引导：存储写不进去时不能抹掉 URL 里的 token
//   ② isPromptInFlight：识别 mux 的 -32002，据此给出带自救说明的文案
//   ③ relay 端口冲突：确认我们依赖的 err.code === 'EADDRINUSE' 这个假设成立
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import http from 'node:http';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------------------
// ① token 引导：抹 URL 之前必须确认真的存下来了
// ---------------------------------------------------------------------------
// 从 app.html 里抠出 token 引导那一段单独跑。整个内联脚本有一千多行、依赖大量 DOM，
// 而这一段只依赖 localStorage / history / location 三个东西，可以喂假的进去。
const html = readFileSync(join(ROOT, 'media', 'app.html'), 'utf8');
const script = (/<script>([\s\S]*?)<\/script>/.exec(html) || [, ''])[1];
const seg = /const TOKEN_KEY[\s\S]*?(?=const WS_URL)/.exec(script);
check('能从 app.html 里定位 token 引导段', !!seg,
  seg ? `${seg[0].split('\n').length} 行` : '正则没匹配上，下面的用例会全部跳过');

/**
 * 用假的 localStorage / history 跑一遍 token 引导。
 * @param {{store?:object, setItem?:Function}} opts
 *   store    —— 初始的存储内容
 *   setItem  —— 覆盖写入行为，用来模拟抛异常或静默失败
 */
function runBootstrap(opts = {}) {
  const store = { ...(opts.store || {}) };
  const calls = { replaceState: [] };
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: opts.setItem ? opts.setItem.bind(null, store) : (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const ctx = createContext({
    URLSearchParams,
    localStorage,
    location: {
      search: opts.search === undefined ? '?token=SECRET123' : opts.search,
      pathname: '/',
      hash: '',
      protocol: 'http:',
      host: '10.0.0.2:3939',
    },
    history: {
      replaceState: (a, b, url) => { calls.replaceState.push(url); },
    },
  });
  runInContext(seg[0] + '\n;globalThis.__TOKEN = TOKEN;', ctx);
  return { token: ctx.__TOKEN, store, calls };
}

if (seg) {
  // 正常情况：存下来了，URL 被抹掉
  const ok = runBootstrap();
  check('存储正常 → token 落盘', ok.store['kiro-bridge-token'] === 'SECRET123');
  check('存储正常 → URL 里的 token 被抹掉',
    ok.calls.replaceState.length === 1 && !String(ok.calls.replaceState[0]).includes('token'),
    `replaceState(${JSON.stringify(ok.calls.replaceState[0])})`);
  check('存储正常 → 内存里仍拿得到 token', ok.token === 'SECRET123');

  // setItem 抛异常（存储配额满、部分隐私模式）
  const thrown = runBootstrap({
    setItem: () => { throw new Error('QuotaExceededError'); },
  });
  check('setItem 抛异常 → 不抹 URL（否则 token 两处同时消失）',
    thrown.calls.replaceState.length === 0,
    thrown.calls.replaceState.length ? `错误地抹掉了: ${thrown.calls.replaceState[0]}` : '');
  check('setItem 抛异常 → 本次仍能用（内存里有）', thrown.token === 'SECRET123');

  // setItem 静默失败：不抛异常，但也没存进去。
  // 这是最阴的一种 —— 只 try/catch 抓不到，必须回读才能发现。
  const silent = runBootstrap({ setItem: () => { /* 假装写了，实际丢弃 */ } });
  check('setItem 静默失败 → 不抹 URL',
    silent.calls.replaceState.length === 0,
    silent.calls.replaceState.length ? `错误地抹掉了: ${silent.calls.replaceState[0]}` : '');

  // URL 不带 token 时从存储里恢复（PWA 从主屏启动的路径）
  const restored = runBootstrap({ search: '', store: { 'kiro-bridge-token': 'FROMSTORE' } });
  check('URL 无 token → 从 localStorage 恢复', restored.token === 'FROMSTORE');
  check('URL 无 token → 不调 replaceState', restored.calls.replaceState.length === 0);
}

// ---------------------------------------------------------------------------
// ② isPromptInFlight：识别 mux 的 -32002
// ---------------------------------------------------------------------------
const extSrc = readFileSync(join(ROOT, 'src', 'extension.js'), 'utf8');
const fnSeg = /function isPromptInFlight\(err\) \{[\s\S]*?\n\}/.exec(extSrc);
check('能从 extension.js 里定位 isPromptInFlight', !!fnSeg);

if (fnSeg) {
  const ctx = createContext({});
  runInContext(fnSeg[0] + '\n;globalThis.f = isPromptInFlight;', ctx);
  const f = ctx.f;
  // 产物里的原文（读 Kiro 产物确认过的两种措辞）
  check('识别 mux 原文 A prompt is already in-flight',
    f(new Error('A prompt is already in-flight for session abc-123')) === true);
  check('识别 already in progress 变体',
    f(new Error('A prompt is already in progress for this session.')) === true);
  check('按错误码 -32002 识别（message 为空也能认出）',
    f(Object.assign(new Error(''), { code: -32002 })) === true);
  // 不能误判成 in-flight —— 误判会让「会话不存在」走不到自动重试那条路
  check('不把 Session not found 误判为 in-flight',
    f(new Error('Session xyz not found')) === false);
  check('不把连接错误误判为 in-flight',
    f(new Error('socket hang up')) === false);
  check('容忍 null / undefined', f(null) === false && f(undefined) === false);

  // 文案里必须真的写出自救动作，否则这条改动等于没做
  const hint = /const IN_FLIGHT_HINT =[\s\S]*?;\n/.exec(extSrc);
  check('IN_FLIGHT_HINT 存在', !!hint);
  if (hint) {
    check('文案里写明了自救动作（点一次停止）', /停止/.test(hint[0]), hint[0].slice(0, 60).replace(/\n/g, ' '));
    check('文案里说明了为什么电脑上看着空闲也会报', /悬空|没送达/.test(hint[0]));
  }
}

// ---------------------------------------------------------------------------
// ③ 端口冲突：我们靠 err.code === 'EADDRINUSE' 判断，先确认这个假设成立
// ---------------------------------------------------------------------------
// 这一项测的是「我依赖的平台行为是不是真这样」。如果 node 在某些情况下不给 code，
// extension.js 里那个 if 就会静默失效，让原始错误继续冒给用户。
const occupied = http.createServer(() => {});
await new Promise((r) => occupied.listen(0, '127.0.0.1', r));
const busyPort = occupied.address().port;

const { Relay } = await import(join(ROOT, 'src', 'relay.js'));
const relay = new Relay({
  mediaDir: join(ROOT, 'media'),
  log: () => {},
  handlers: {},
  token: 'x'.repeat(32),
});
let caught = null;
try {
  await relay.start(busyPort, false);
} catch (e) {
  caught = e;
}
check('端口被占时 relay.start 会 reject', !!caught);
check("reject 的错误带 code === 'EADDRINUSE'（extension.js 的判断依赖它）",
  !!caught && caught.code === 'EADDRINUSE', caught ? `实际 code=${caught.code}` : '');
occupied.close();

// 结构检查：catch 块里必须把 relay 置回 null。
// 漏了这一句的后果很隐蔽 —— 模块级的 relay 变量还指着一个没在监听的实例，
// 下次点「开启远程会话」会被开头的 if (relay) 挡住，提示「已在运行」，
// 而实际上什么都没跑，用户会以为服务开着。
const startFn = /async function start\(context\) \{[\s\S]*?\n\}/.exec(extSrc);
check('能定位 start(context)', !!startFn);
if (startFn) {
  const catchBlock = /catch \(err\) \{[\s\S]*?EADDRINUSE[\s\S]*?\n  \}/.exec(startFn[0]);
  check('EADDRINUSE 分支存在', !!catchBlock);
  if (catchBlock) {
    check('catch 里把 relay 置回 null（否则下次启动会被误判为已在运行）',
      /relay\s*=\s*null/.test(startFn[0].slice(0, catchBlock.index + catchBlock[0].length)));
    check('EADDRINUSE 时提前 return，不继续走 keepAwake / refresh',
      /return;/.test(catchBlock[0]));
    check('提示里说明了「另一个窗口已覆盖全部会话」而不是只报失败',
      /覆盖|照常能操作|不需要在这里再开/.test(catchBlock[0]));
  }
}

// ---------------------------------------------------------------------------
// ④ mux 失败之后要不要换命令通道重投
// ---------------------------------------------------------------------------
// 这一组是真跑 sendToSession，不是静态检查。理由：这个决策的错法是判据用反
// （少一个 `!`），而那种错语法和静态检查都看不出来，表现是 agent 把带副作用的活
// 干两遍（改文件、跑命令都会重来）。必须真的喂一个失败进去、看它走了哪条路。
//
// 判断「有没有重投」的信号：vscode.commands.executeCommand 有没有被调用
// kiroAgent.sessions.sendPrompt —— 那就是降级通道。
const { createRequire } = await import('node:module');
const { default: Module } = await import('node:module');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');

const SANDBOX = mkdtempSync(join(tmpdir(), 'krb-send-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = SANDBOX;
mkdirSync(join(SANDBOX, '.kiro', 'sessions'), { recursive: true });

const executed = [];
const fakeVscode = {
  version: '1.85.0-test',
  StatusBarAlignment: { Right: 2 },
  ViewColumn: { Beside: 2 },
  Uri: { file: (p) => ({ fsPath: p, toString: () => 'file://' + p }) },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
    createWebviewPanel: () => ({ webview: { html: '' }, dispose() {} }),
    showInformationMessage() {},
    showWarningMessage() {},
    showErrorMessage() {},
  },
  commands: {
    registerCommand: () => ({ dispose() {} }),
    getCommands: async () => [],
    executeCommand: async (cmd, ...args) => {
      executed.push({ cmd, args });
      if (cmd === 'kiro.agentRegistry.getAgentEndpoints') return [];
      return undefined;
    },
  },
  workspace: {
    // 用 getter 读一个可变变量：跨窗口创建的检测就是拿这个和目标 workspace 比，
    // 写成数组字面量的话没法在用例之间切换「本窗口是哪个工作区」
    get workspaceFolders() {
      return localWsFolders;
    },
    getConfiguration: () => ({ get: (k, d) => d }),
  },
};
let localWsFolders = [];

const stubPath = join(SANDBOX, 'vscode-stub.cjs');
const require_ = createRequire(join(ROOT, 'package.json'));
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return stubPath;
  return origResolve.call(this, request, ...rest);
};
writeFileSync(stubPath, 'module.exports = globalThis.__FAKE_VSCODE__;');
globalThis.__FAKE_VSCODE__ = fakeVscode;

const ext = require_('./src/extension.js');
const T = ext.__test;

// 必须先 activate 一次：sendToSession 开头要查会话属于哪个 workspace，走的是模块级的
// store，而它只在 activate() 里建。不调的话每个用例都死在 store 是 undefined 上 ——
// 而那时「不确定 → 没有重投」这类断言会**照样通过**（因为确实没重投，只不过是崩了），
// 是典型的假绿。默认配置下 activate 不注册 timer、不发命令、不写文件（见 t11），
// 且 HOME 已隔离到沙箱，所以这里调它是安全的。
ext.activate({ subscriptions: [], extensionPath: ROOT });

check('__test 暴露了这条决策链需要的东西',
  typeof T.sendToSession === 'function' &&
  typeof T.isDefinitelyNotDelivered === 'function' &&
  typeof T.setMuxPoolForTest === 'function' &&
  typeof T.setSettleForTest === 'function');

// ---- 判据本身（纯函数，先把边界钉死）
const notDelivered = T.isDefinitelyNotDelivered;
check('判据：connection not open → 确定没投进去（request 里发送前就 reject 了）',
  notDelivered(new Error('mux connection not open')) === true);
check('判据：in-flight → 确定没投进去（mux 转发前 return，没 enqueue）',
  notDelivered(Object.assign(new Error('A prompt is already in-flight for session x'), { code: -32002 })) === true);
check('判据：Session not found → 确定没投进去（找不到上下文，不可能开始执行）',
  notDelivered(new Error('Session abc not found')) === true);
// 下面这条是这次改动的核心：连接在**发出之后**断掉，消息可能已经到了 agent。
// 把它误判成「没投进去」就会重投，让同一件事做两遍。
check('判据：socket hang up → 不确定（可能已送到 agent，不能重投）',
  notDelivered(new Error('socket hang up')) === false);
check('判据：agent 内部错误 → 不确定',
  notDelivered(new Error('internal error while running tool')) === false);
check('判据：空值 → false（调用方另有 null 分支，这里不能返回 null）',
  notDelivered(null) === false && notDelivered(undefined) === false);

// ---- 决策流（真跑 sendToSession）
T.setSettleForTest(20, 20);
const settle = T.getSettleForTest();
check('等待窗口已调小，测试不用真等 2 秒', settle.send === 20 && settle.attach === 20,
  `send=${settle.send}ms attach=${settle.attach}ms`);

/** 造一个假 muxPool：sendPrompt 按 behave 指定的方式失败或成功 */
function poolThat(behave) {
  let calls = 0;
  return {
    pool: {
      pickForWorkspace: () => (behave === 'no-conn' ? null : {
        endpoint: { port: 12345 },
        sendPrompt: () => {
          calls += 1;
          if (behave === 'ok') return Promise.resolve({ stopReason: 'end_turn' });
          return Promise.reject(behave);
        },
      }),
    },
    promptCalls: () => calls,
  };
}
const fallbackCalls = () =>
  executed.filter((e) => e.cmd === 'kiroAgent.sessions.sendPrompt').length;

async function runSend(behave, atts) {
  const { pool, promptCalls } = poolThat(behave);
  T.setMuxPoolForTest(pool);
  executed.length = 0;
  let result = null, error = null;
  try {
    result = await T.sendToSession('sess-1', '把 README 里的版本号改成 9.9.9', atts);
  } catch (e) {
    error = e;
  }
  return { result, error, fallback: fallbackCalls(), promptCalls: promptCalls() };
}

// mux 成功 → 不该出现任何降级
const okRun = await runSend('ok');
check('mux 成功 → via mux，且完全不碰降级通道',
  okRun.result && okRun.result.via === 'mux' && okRun.fallback === 0,
  `via=${okRun.result && okRun.result.via} 降级调用=${okRun.fallback}`);

// 确定没投进去的三类 → 照旧自动降级，用户无感
const notOpen = await runSend(new Error('mux connection not open'));
check('connection not open → 自动降级到命令通道',
  notOpen.result && notOpen.result.via === 'command' && notOpen.fallback === 1,
  notOpen.error ? `却抛了错: ${notOpen.error.message.slice(0, 40)}` : `降级调用=${notOpen.fallback}`);

const inflightRun = await runSend(
  Object.assign(new Error('A prompt is already in-flight for session sess-1'), { code: -32002 })
);
check('in-flight → 自动降级到命令通道（高频路径，体感不能变差）',
  inflightRun.result && inflightRun.result.via === 'command' && inflightRun.fallback === 1,
  inflightRun.error ? `却抛了错: ${inflightRun.error.message.slice(0, 40)}` : '');

const notFoundRun = await runSend(new Error('Session sess-1 not found'));
check('not found → 先让桌面加载再重试，最后降级（reload 后最常撞的那条）',
  notFoundRun.result && notFoundRun.result.via === 'command',
  notFoundRun.error ? `却抛了错: ${notFoundRun.error.message.slice(0, 40)}` : `mux 尝试=${notFoundRun.promptCalls} 次`);
check('not found 时确实重试了 mux（attachDesktop 之后再试一次）',
  notFoundRun.promptCalls === 2, `实际 ${notFoundRun.promptCalls} 次`);

// 不确定的 → 绝不自动重投，如实报错
const uncertain = await runSend(new Error('socket hang up'));
check('不确定 → 不碰降级通道（这是本条改动的核心）',
  uncertain.fallback === 0,
  uncertain.fallback ? `错误地重投了 ${uncertain.fallback} 次` : '');
check('不确定 → 抛错而不是假装成功',
  !!uncertain.error && !uncertain.result,
  uncertain.result ? `却返回了 via=${uncertain.result.via}` : '');
check('不确定 → 报错里说明「可能已送到」而不是「发送失败」',
  !!uncertain.error && /可能已经送到/.test(uncertain.error.message));
check('不确定 → 报错里告诉用户去电脑上确认',
  !!uncertain.error && /电脑上看一眼|再发一次/.test(uncertain.error.message));
check('不确定 → 报错里带上原始错误，便于排查',
  !!uncertain.error && /socket hang up/.test(uncertain.error.message));

// 压根没有 mux 连接 → 命令是唯一的路，重投风险不存在，必须照走
const noConn = await runSend('no-conn');
check('没有任何 mux 连接 → 直接走命令通道（不受新判据影响）',
  noConn.result && noConn.result.via === 'command' && noConn.fallback === 1,
  noConn.error ? `却抛了错: ${noConn.error.message.slice(0, 40)}` : '');

// 带附件时没有降级通道，但「没送出去」和「可能送到了」对用户是两件事
const attImg = [{ name: 'a.png', mime: 'image/png', data: Buffer.from([1, 2, 3]).toString('base64') }];
const attUncertain = await runSend(new Error('socket hang up'), attImg);
check('带附件 + 不确定 → 报「可能已送到」',
  !!attUncertain.error && /可能已经送到/.test(attUncertain.error.message),
  attUncertain.error ? attUncertain.error.message.slice(0, 50) : '没抛错');
const attInflight = await runSend(
  Object.assign(new Error('A prompt is already in-flight'), { code: -32002 }), attImg
);
check('带附件 + in-flight → 报自救说明而不是「通道不可用」',
  !!attInflight.error && /点一次停止/.test(attInflight.error.message),
  attInflight.error ? attInflight.error.message.slice(0, 50) : '没抛错');
check('带附件时一律不走降级通道（纯文本通道会悄悄丢掉附件）',
  attUncertain.fallback === 0 && attInflight.fallback === 0);

// ---------------------------------------------------------------------------
// ④b 草稿必须按会话隔离
// ---------------------------------------------------------------------------
// 实测故障：在 A 会话里打了一半的字、挑好的图，切到 B 会话还在输入框里，
// 一按发送就发到 B 去了。附件尤其危险——它没有"属于哪个会话"的可见标记。
//
// 放在这个文件里是因为它就是一条失败路径：正常流程（在一个会话里打字、发送）永远
// 碰不到，只有"切会话"这个动作才暴露。而这类跨状态的错误，静态检查抓不到——
// 实测把 openSession 里存草稿那行删掉，t8 的 UI 一致性检查 0 项失败。
{
  // 必须显式带上 restoreDraft 再收尾：只写 `[\s\S]*?\n\}\n` 的话非贪婪会停在
  // stashDraft 的右括号处，抠出来的片段少了一半，而症状是「restoreDraft is not defined」
  const seg2 = /const drafts = new Map\(\);[\s\S]*?function restoreDraft[\s\S]*?\n\}\n/.exec(script);
  check('能从 app.html 里定位草稿隔离那段', !!seg2,
    seg2 ? `${seg2[0].split('\n').length} 行` : '正则没匹配上');
  if (seg2) {
    const mkInput = () => ({ value: '', scrollHeight: 20, style: { height: '' } });
    const ctx2 = createContext({});
    ctx2.input = mkInput();
    ctx2.atts = [];
    ctx2.renderAtts = () => {};
    ctx2.syncSendState = () => {};
    runInContext(
      seg2[0] +
        '\n;globalThis.__api = { stashDraft, restoreDraft, drafts,' +
        ' getAtts: () => atts, setAtts: (v) => { atts = v; } };',
      ctx2
    );
    const api = ctx2.__api;

    // 在 A 会话里打字并加一个附件
    ctx2.input.value = '这段话是给 A 的';
    api.setAtts([{ name: 'a.png', mimeType: 'image/png', data: 'AAA' }]);
    api.stashDraft('sessA');
    check('草稿按会话存起来了', api.drafts.has('sessA'));

    // 切到没有草稿的 B —— 输入框和附件都必须清空
    api.restoreDraft('sessB');
    check('★ 切到别的会话：文本不跟过去', ctx2.input.value === '',
      `input=${JSON.stringify(ctx2.input.value)}`);
    check('★ 切到别的会话：附件不跟过去', api.getAtts().length === 0,
      `atts=${api.getAtts().length} 个`);

    // 在 B 里写点别的，再切回 A —— 各自的内容要对得上
    ctx2.input.value = 'B 的内容';
    api.stashDraft('sessB');
    api.restoreDraft('sessA');
    check('★ 切回 A：拿回 A 自己的文本', ctx2.input.value === '这段话是给 A 的',
      JSON.stringify(ctx2.input.value));
    check('★ 切回 A：拿回 A 自己的附件',
      api.getAtts().length === 1 && api.getAtts()[0].name === 'a.png',
      JSON.stringify(api.getAtts().map((x) => x.name)));

    // 附件数组要是副本，不能和草稿里那份共享引用 ——
    // 共享的话在 A 里加一张图会同时改掉已存起来的草稿
    api.getAtts().push({ name: 'b.png', mimeType: 'image/png', data: 'BBB' });
    api.restoreDraft('sessA');
    check('★ 草稿里的附件是副本，不被后续改动污染', api.getAtts().length === 1,
      `恢复后 ${api.getAtts().length} 个`);

    // 空草稿不该占着 Map
    ctx2.input.value = '';
    api.setAtts([]);
    api.stashDraft('sessA');
    check('清空后草稿记录被删掉，Map 不会无限长', !api.drafts.has('sessA'));

    // 没有 owner 时不能乱存（例如还没进任何会话就返回列表）
    const before = api.drafts.size;
    api.stashDraft(null);
    check('owner 为空时不写草稿', api.drafts.size === before);
  }

  // 纯函数对了不等于接上了：这几处调用点少一个，草稿就会串台。
  // 这是「数据层加了函数但 UI 零调用」那类错误的防线。
  check('openSession 切走前存草稿', /if \(openId && openId !== sessionId\) stashDraft\(openId\)/.test(script));
  check('openSession 进来后恢复草稿', /restoreDraft\(sessionId\)/.test(script));
  check('返回列表时存草稿', /stashDraft\(openId\);\s*\n\s*if \(view === 'chat'/.test(script));
  check('发送后清掉该会话的草稿', /drafts\.delete\(openId\)/.test(script));
}

// ---------------------------------------------------------------------------
// ⑤ 跨窗口创建会话：agent 实际在哪个工作区干活，必须说清楚
// ---------------------------------------------------------------------------
// 实测故障：手机上选 Kiro 工作区建会话，agent 却在 personal 工作区干活。
// 原因是 createSession 最后要 attachDesktop 让桌面面板注册审批 handler，而
// vscode.commands 只能在**本窗口**执行，被打开的会话就此由本窗口接管，
// 连工作区上下文一起接管。磁盘上能看到同一 sessionId 在两个 workspace 下各有一份，
// 目标窗口那份带正确模型却没有消息，本窗口那份有 175KB 消息、且消息里的路径全是本窗口的。
//
// 现在不静默接管，会带一条 notes 回去。这里测两个方向：跨窗口时必须有提示，
// 同窗口时必须没有（不然每次创建都弹一个无关的警告，人会开始无视它）。
{
  const newSessionCalls = [];
  const fakeConn = {
    endpoint: { port: 5555, folders: [{ path: '/ws/kiro', label: 'kiro' }] },
    newSession: async (cwd) => {
      newSessionCalls.push(cwd);
      return { sessionId: 'sess_new_1', configOptions: [] };
    },
    setConfigOption: async () => ({ configOptions: [] }),
  };
  T.setMuxPoolForTest({ pickForWorkspace: () => fakeConn });

  // 场景 A：目标工作区不是本窗口的 → 必须带提示
  localWsFolders = [{ uri: { fsPath: '/ws/personal' } }];
  executed.length = 0;
  const crossed = await T.createSession('/ws/kiro', {});
  check('跨窗口创建：会话照样建出来（不能因为提示就不干活）',
    crossed && crossed.sessionId === 'sess_new_1');
  check('★ 跨窗口创建：带回 notes 说明 agent 实际在哪个工作区干活',
    !!(crossed.notes && crossed.notes.length), JSON.stringify(crossed.notes || []));
  check('★ notes 里点名了两个工作区，人能看懂是哪儿对哪儿',
    !!crossed.notes && /kiro/.test(crossed.notes[0]) && /personal/.test(crossed.notes[0]),
    crossed.notes ? crossed.notes[0].slice(0, 60) : '');
  check('仍然调了 attachDesktop（否则这个会话的审批会被立刻取消）',
    executed.some((e) => e.cmd === 'kiroAgent.viewSession'),
    executed.map((e) => e.cmd).join(','));
  check('newSession 收到的 cwd 是用户选的那个（会话确实建在目标工作区）',
    newSessionCalls[newSessionCalls.length - 1] === '/ws/kiro',
    `cwd=${newSessionCalls[newSessionCalls.length - 1]}`);

  // 场景 B：目标就是本窗口 → 不能有提示。少了这条反向断言，
  // 把判断写成恒真也会「通过」，然后每次创建都弹一个无关警告。
  localWsFolders = [{ uri: { fsPath: '/ws/kiro' } }];
  const local = await T.createSession('/ws/kiro', {});
  check('★ 同窗口创建：不带任何提示', !(local.notes && local.notes.length),
    JSON.stringify(local.notes || []));

  // 路径写法差异不该被误判成跨窗口（尾斜杠、多余的 ./）
  localWsFolders = [{ uri: { fsPath: '/ws/kiro/' } }];
  const trailing = await T.createSession('/ws/kiro', {});
  check('尾斜杠不算跨窗口', !(trailing.notes && trailing.notes.length),
    JSON.stringify(trailing.notes || []));

  /*
   * 没显式选工作区时，判据是「agent 实际会落在哪」（连接解析出来的 cwd），
   * 而不是「用户有没有点选」。连接默认落在别的窗口时照样要提示 ——
   * 用户没点选并不代表他愿意让 agent 在另一个工作区里改文件。
   */
  localWsFolders = [{ uri: { fsPath: '/ws/personal' } }];
  const noWs = await T.createSession(undefined, {});
  check('★ 没显式选工作区、但解析出的 cwd 属于别的窗口 → 照样提示',
    !!(noWs.notes && noWs.notes.length), JSON.stringify(noWs.notes || []));

  // 连接压根没有工作区信息 → 无从判断跨没跨，不提示（不能凭空报警）
  const nakedConn = {
    endpoint: { port: 5556, folders: [] },
    newSession: async () => ({ sessionId: 'sess_new_naked', configOptions: [] }),
    setConfigOption: async () => ({ configOptions: [] }),
  };
  T.setMuxPoolForTest({ pickForWorkspace: () => nakedConn });
  const naked = await T.createSession(undefined, {});
  check('连接没有工作区信息 → 不提示', !(naked.notes && naked.notes.length),
    JSON.stringify(naked.notes || []));
  T.setMuxPoolForTest({ pickForWorkspace: () => fakeConn });
}

// ---------------------------------------------------------------------------
// ⑥ 把 attach 派给拥有会话的那个窗口
// ---------------------------------------------------------------------------
// vscode 命令跨不了窗口，所以主实例只能让**目标窗口自己**去打开会话。
// 这一组测的是路由决策，重点在**失败方向**：派不出去时必须退回本地 attach 并提示，
// 而不是静默地不 attach —— 那会让审批悄悄失效，比不做这个功能更糟。
{
  const T2 = ext.__test;
  check('__test 暴露了 attachInOwningWindow', typeof T2.attachInOwningWindow === 'function');

  if (typeof T2.attachInOwningWindow === 'function') {
    // 假 relay：只实现 broadcastTo，按谓词挑“从属连接”并记下发出去的指令
    const makeRelay = (followers) => ({
      broadcastTo: (pred, obj) => {
        let n = 0;
        for (const c of followers) {
          let want = false;
          try { want = !!pred(c); } catch (_) { want = false; }
          if (want) { c.got.push(obj); n += 1; }
        }
        return n;
      },
    });

    // A. 目标就是本窗口 → 本地 attach，压根不派活
    localWsFolders = [{ uri: { fsPath: '/ws/kiro' } }];
    const f0 = [{ followerWorkspaces: ['/ws/other'], got: [] }];
    T2.setRelayForTest(makeRelay(f0));
    executed.length = 0;
    const rLocal = await T2.attachInOwningWindow('s1', '/ws/kiro');
    check('目标是本窗口 → 本地 attach',
      rLocal.via === 'local' && rLocal.ownedByLocal === true);
    check('目标是本窗口 → 不往外派活', f0[0].got.length === 0);
    check('目标是本窗口 → 真的调了 viewSession',
      executed.some((e) => e.cmd === 'kiroAgent.viewSession'));

    // B. 目标是别的窗口且那边有待命实例 → 派出去，且**不做**本地 attach
    localWsFolders = [{ uri: { fsPath: '/ws/personal' } }];
    const fOk = [{ followerWorkspaces: ['/ws/kiro'], got: [] }];
    T2.setRelayForTest(makeRelay(fOk));
    executed.length = 0;
    const pOk = T2.attachInOwningWindow('s2', '/ws/kiro');
    // 等指令发出，再模拟那个窗口回话
    for (let i = 0; i < 50 && !fOk[0].got.length; i++) await new Promise((r) => setTimeout(r, 5));
    check('★ 跨窗口 → 把 attach 指令派给负责那个 workspace 的窗口',
      fOk[0].got.length === 1 && fOk[0].got[0].type === 'follower:attach' &&
        fOk[0].got[0].sessionId === 's2',
      JSON.stringify(fOk[0].got[0] || {}));
    T2.resolveFollowerForTest(fOk[0].got[0].reqId, { ok: true });
    const rOk = await pOk;
    check('★ 目标窗口回报成功 → via=follower', rOk.via === 'follower', `via=${rOk.via}`);
    check('★ 派成功后不再本地 attach（否则本窗口又把会话抢回来了）',
      !executed.some((e) => e.cmd === 'kiroAgent.viewSession'),
      executed.map((e) => e.cmd).join(',') || '(没调)');

    // C. 没有任何窗口负责这个 workspace → 退回本地 attach
    const fNone = [{ followerWorkspaces: ['/ws/unrelated'], got: [] }];
    T2.setRelayForTest(makeRelay(fNone));
    executed.length = 0;
    const rNone = await T2.attachInOwningWindow('s3', '/ws/kiro');
    check('★ 没有待命窗口 → 退回本地 attach（功能不能因此坏掉）',
      rNone.via === 'local' && rNone.ownedByLocal === false);
    check('★ 退回时确实执行了本地 attach',
      executed.some((e) => e.cmd === 'kiroAgent.viewSession'));

    // D. 派出去了但对方报失败 → 同样退回本地
    const fBad = [{ followerWorkspaces: ['/ws/kiro'], got: [] }];
    T2.setRelayForTest(makeRelay(fBad));
    executed.length = 0;
    const pBad = T2.attachInOwningWindow('s4', '/ws/kiro');
    for (let i = 0; i < 50 && !fBad[0].got.length; i++) await new Promise((r) => setTimeout(r, 5));
    T2.resolveFollowerForTest(fBad[0].got[0].reqId, { ok: false, error: 'viewSession 抛了' });
    const rBad = await pBad;
    check('★ 目标窗口报失败 → 退回本地 attach', rBad.via === 'local');
    check('★ 报失败时也执行了本地 attach，审批不会悄悄失效',
      executed.some((e) => e.cmd === 'kiroAgent.viewSession'));

    // E. 对方不回话（超时）→ 退回本地。把超时调小，不然要等 4 秒
    const fMute = [{ followerWorkspaces: ['/ws/kiro'], got: [] }];
    T2.setRelayForTest(makeRelay(fMute));
    T2.setFollowerTimeoutForTest(80);
    executed.length = 0;
    const rMute = await T2.attachInOwningWindow('s5', '/ws/kiro');
    check('★ 目标窗口不回话 → 超时后退回本地 attach', rMute.via === 'local');
    check('★ 超时退回时也执行了本地 attach',
      executed.some((e) => e.cmd === 'kiroAgent.viewSession'));
    check('超时后不留悬挂的等待记录（否则每次派活都渗一条，越跑越多）',
      T2.followerWaiterCount() === 0, `残留 ${T2.followerWaiterCount()} 条`);

    // 路径写法差异不该让匹配失败
    const fSlash = [{ followerWorkspaces: ['/ws/kiro/'], got: [] }];
    T2.setRelayForTest(makeRelay(fSlash));
    const pSlash = T2.attachInOwningWindow('s6', '/ws/kiro');
    for (let i = 0; i < 50 && !fSlash[0].got.length; i++) await new Promise((r) => setTimeout(r, 5));
    check('从属上报的路径带尾斜杠也能匹配上', fSlash[0].got.length === 1);
    if (fSlash[0].got.length) {
      T2.resolveFollowerForTest(fSlash[0].got[0].reqId, { ok: true });
      await pSlash;
    }
    T2.setFollowerTimeoutForTest(4000);
    T2.setRelayForTest(null);
  }
}

// 收尾：把 HOME 放回去，删掉沙箱
Module._resolveFilename = origResolve;
process.env.HOME = REAL_HOME;
rmSync(SANDBOX, { recursive: true, force: true });

console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
