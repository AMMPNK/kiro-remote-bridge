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

console.log(`结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
