// 静态一致性检查 app.html：JS 引用的元素 / class 是否真的存在。
// 这类问题语法检查抓不到，只会在特定交互路径下才炸（例如点了某个按钮才发现 id 拼错）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'media', 'app.html'), 'utf8');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const script = (/<script>([\s\S]*?)<\/script>/.exec(html) || [, ''])[1];
const style = (/<style>([\s\S]*?)<\/style>/.exec(html) || [, ''])[1];
const body = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<style>[\s\S]*?<\/style>/g, '');

// ---- 1. JS 里引用的 id 必须真实存在
// id 有两个来源：静态 HTML，以及 JS 用模板字符串动态渲染出来的（如归档页的按钮）。
const htmlIds = new Set([...body.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const jsGenIds = new Set([...script.matchAll(/\bid="([^"$]+)"/g)].map((m) => m[1]));
const allIds = new Set([...htmlIds, ...jsGenIds]);
const refIds = new Set([
  ...script.matchAll(/\bel\('([^']+)'\)/g),
  ...script.matchAll(/getElementById\('([^']+)'\)/g),
].map((m) => m[1]));
const missingIds = [...refIds].filter((i) => !allIds.has(i));
check('JS 引用的 id 全部真实存在', missingIds.length === 0,
  missingIds.length ? `缺失: ${missingIds.join(', ')}` : `共 ${refIds.size} 个引用`);

// ---- 2. 声明的 id 应当被用到（未用到的通常是改动残留）
// 除了直接 el('x')，还有把 id 当参数传进渲染函数的间接用法，所以把 JS 里的
// 字符串字面量也算作引用，宁可放宽也不要误报。
const cssIdRefs = new Set([...style.matchAll(/#([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const strLiterals = new Set([...script.matchAll(/'([a-zA-Z][\w-]*)'/g)].map((m) => m[1]));
// <symbol> 可以只被静态 HTML 里的 <use href="#x"> 引用，脚本里根本不出现。
// 漏掉这类会把在用的图标报成「残留」，进而诱使人把它删掉。
const markupIdRefs = new Set(
  [...html.matchAll(/(?:href|xlink:href)="#([a-zA-Z][\w-]*)"/g)].map((m) => m[1])
);
const unusedIds = [...allIds].filter(
  (i) =>
    !refIds.has(i) &&
    !cssIdRefs.has(i) &&
    !strLiterals.has(i) &&
    !markupIdRefs.has(i) &&
    !script.includes(`#${i}`)
);
check('声明的 id 没有无用残留', unusedIds.length === 0,
  unusedIds.length ? `未被引用: ${unusedIds.join(', ')}` : `共 ${allIds.size} 个 id`);

// ---- 3. JS 生成的 class 必须在 CSS 里有定义
// class 常写成模板插值（class="card${cond ? ' s-x' : ''}"），只取静态前缀那段，
// 否则会把这类 class 整个漏掉。
const genClasses = new Set(
  [...script.matchAll(/class="([\w\s-]*)/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter(Boolean)
);
const cssClasses = new Set([...style.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]));
const undefinedClasses = [...genClasses].filter((c) => !cssClasses.has(c));
check('JS 生成的 class 都有 CSS 定义', undefinedClasses.length === 0,
  undefinedClasses.length ? `无定义: ${undefinedClasses.join(', ')}` : `共 ${genClasses.size} 个`);

// ---- 4. querySelector 用到的 class 必须存在于 JS 生成的结构或 HTML 中
const qsClasses = new Set(
  [...script.matchAll(/querySelector(?:All)?\('\.([\w-]+)/g)].map((m) => m[1])
);
const bodyClasses = new Set(
  [...body.matchAll(/class="([^"]+)"/g)].flatMap((m) => m[1].split(/\s+/))
);
const danglingQs = [...qsClasses].filter((c) => !genClasses.has(c) && !bodyClasses.has(c));
check('querySelector 的 class 有对应产出', danglingQs.length === 0,
  danglingQs.length ? `找不到来源: ${danglingQs.join(', ')}` : `共 ${qsClasses.size} 个`);

// ---- 5. CSS 里不应残留非法颜色值（打字错误会让整条声明被浏览器丢弃）
const badColors = [...style.matchAll(/:\s*#([0-9a-fA-F]*[g-zG-Z][^;}]*)/g)].map((m) => m[0].trim());
check('CSS 无非法颜色值', badColors.length === 0,
  badColors.length ? badColors.join(' | ') : '');

// ---- 6. <symbol> 被 <use> 引用时 id 必须匹配
const symbolIds = new Set([...html.matchAll(/<symbol[^>]*\bid="([^"]+)"/g)].map((m) => m[1]));
const useRefs = new Set([...html.matchAll(/<use[^>]*href="#([^"]+)"/g)].map((m) => m[1]));
const danglingUse = [...useRefs].filter((u) => !symbolIds.has(u));
check('<use> 引用的 symbol 都已定义', danglingUse.length === 0,
  danglingUse.length ? `未定义: ${danglingUse.join(', ')}` : `symbol: ${[...symbolIds].join(', ')}`);

// ---- 7. 发往服务端的消息类型必须是 relay 侧登记过的
const sentTypes = new Set([...script.matchAll(/send\('([^']+)'/g)].map((m) => m[1]));
const extHandlers = readFileSync(join(ROOT, 'src', 'extension.js'), 'utf8');
const unknownTypes = [...sentTypes].filter((t) => !extHandlers.includes(`'${t}'`));
check('前端发送的消息类型都有 handler', unknownTypes.length === 0,
  unknownTypes.length ? `无 handler: ${unknownTypes.join(', ')}` : `共 ${sentTypes.size} 种`);

// ---- 8. 前端处理的入站类型应覆盖后端会广播的类型
// 清单必须从后端源码提取。原来写死成数组，于是新增 muxUpdate 时没人同步，
// 这条本该抓住「后端发了、前端不处理」的检查静默放行了一整个版本 —— 门禁的输入
// 不能是事实源的副本。
const handled = new Set([...script.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]));
const relaySrc = readFileSync(join(ROOT, 'src', 'relay.js'), 'utf8');
/**
 * 前端刻意不进 switch 的类型，必须写明理由；新类型默认要求被处理（fail-closed）。
 *
 * 现在是空的 —— 三条豁免全部消化掉了，而且每一条都不是靠「补一个空 handler」消化的：
 *   cancelled    前端本来就该能发 session:cancel，豁免掩盖的是一个功能缺口
 *   hello        前端本来就该读握手里的 maxPayload，豁免掩盖的是一份写死的副本
 *   diagnostics  后端本来就不该把这份数据开给手机端，handler 已删除
 * 空表是这条门禁的正常状态。往里加东西之前，先确认要加的不是上面那三种情况之一。
 */
const NOT_IN_SWITCH = new Map();
// 只认真正发往手机的出口：broadcast(…)、sendJson(…)、handler 的 return / 箭头直接返回。
// 不能宽泛地抓所有 type: 'x' —— 后端还会构造 ACP 内容块（image / resource / text），
// 那些不是广播类型，抓进来会让这条门禁误报，进而诱使人给前端加没用的 handler。
const broadcast = [
  ...new Set(
    [
      ...(extHandlers + relaySrc).matchAll(
        /(?:broadcast|sendJson|return|=>)\s*\(?\s*\{\s*type:\s*'([a-zA-Z][\w]*)'/g
      ),
    ].map((m) => m[1])
  ),
].filter((t) => !NOT_IN_SWITCH.has(t));
const unhandled = broadcast.filter((t) => !handled.has(t));
check('后端广播的类型前端都处理了', unhandled.length === 0,
  unhandled.length
    ? `未处理: ${unhandled.join(', ')}`
    : `共 ${broadcast.length} 种（另有 ${NOT_IN_SWITCH.size} 种已登记豁免）`);

// ---- 9. 标签配对（简单检查关键容器）
for (const tag of ['div', 'header', 'footer', 'main', 'svg']) {
  const open = (body.match(new RegExp(`<${tag}[\\s>]`, 'g')) || []).length;
  const close = (body.match(new RegExp(`</${tag}>`, 'g')) || []).length;
  check(`<${tag}> 标签配对`, open === close, `${open} 开 / ${close} 闭`);
}

// ---- 9b. sessionStore 产出的 kind 与前端 nodeFor 的对齐
// 第 8 条检查的是「后端广播的消息类型」，这条检查的是「解析器产出的渲染事件种类」——
// 两个不同的边界，之前只有前者有门禁。nodeFor 的 default 分支是 return ''，
// 也就是不认识的 kind 会被静默丢掉，正是最容易长期没人发现的形态。
const storeSrc = readFileSync(join(ROOT, 'src', 'sessionStore.js'), 'utf8');
const producedKinds = new Set([...storeSrc.matchAll(/kind: '([a-zA-Z]+)'/g)].map((m) => m[1]));
producedKinds.add('reasoning'); // 运行时算出来的，抓不到字面量
const nodeForBody = script.slice(script.indexOf('function nodeFor'));
const renderedKinds = new Set(
  [...nodeForBody.slice(0, nodeForBody.indexOf('function bindTools')).matchAll(/case '([a-zA-Z]+)'/g)]
    .map((m) => m[1])
);
/** 刻意不渲染的 kind，必须写明理由 */
const NOT_RENDERED = new Map([
  ['context', '附加的上下文文件清单，不是对话内容'],
  ['usage', 'token 用量统计，手机上不展示'],
  ['turnStart', '回合开始标记，只用于后端判活（liveState）'],
  ['sessionEvent', '会话生命周期事件，手机上不展示'],
]);
const droppedSilently = [...producedKinds].filter(
  (k) => !renderedKinds.has(k) && !NOT_RENDERED.has(k)
);
check('解析器产出的 kind 要么被渲染、要么登记了不渲染的理由',
  droppedSilently.length === 0,
  droppedSilently.length
    ? `会被静默丢掉: ${droppedSilently.join(', ')}`
    : `产出 ${producedKinds.size} 种，渲染 ${renderedKinds.size} 种，登记不渲染 ${NOT_RENDERED.size} 种`);
// 反方向：登记表里不该有已经不存在的 kind
const staleExempt = [...NOT_RENDERED.keys()].filter((k) => !producedKinds.has(k));
check('不渲染登记表里没有已消失的 kind', staleExempt.length === 0, staleExempt.join(', '));

// ---- 9c. 待确认选项的标签字段
// 两类交互的字段名不一样：tool_approval 用 name，user_input 用 title。
// 只读 title 会让所有工具授权卡片的选项显示成空的「 /  /  / 」——
// 而那正是最需要看清有哪些选项的场合。实测数据里 703 个选项用 name、5 个用 title。
check('选项标签同时认 name 与 title',
  /o\.name \|\| o\.title|o\.title \|\| o\.name/.test(script),
  '应有 optionLabels 之类同时取两个字段的实现');
check('待确认卡片走 optionLabels 而不是直接取 title',
  /case 'pending':[\s\S]{0,400}?optionLabels\(m\.options\)/.test(script));

// ---- 10. 停止键的两个已知失效方向
// 这几条是针对具体缺陷的回归闸门，不是泛化检查：写这个按钮时两个方向各踩了一次。
check('停止键会发出 session:cancel',
  /el\('stop'\)\.onclick[\s\S]{0,240}?'session:cancel'/.test(script));

// 方向一：停止键卡住 → 发送键消失 → 人再也发不出消息。
// 触发条件是「会话安静下来后列表签名不再变化」，所以校正不能挂在签名判断里面。
check('列表推送不会因签名未变而跳过停止键校正',
  !/if\s*\(\s*sig\s*===\s*sessionsSig\s*\)\s*break/.test(script) &&
  /if\s*\(view === 'chat'\) syncTurnFromList\(\)/.test(script));

// 方向二：live 不在签名里 → 后端按时间窗把 running 翻成 idle 的那次翻转永远不渲染。
check('live 已进入会话列表签名', /sig = next\.map[\s\S]{0,200}?s\.live/.test(script));

// 停止键必须真的能被收回去：至少有一条路径把它置回 false
check('存在把停止键收回的路径',
  (script.match(/setTurnActive\(false\)/g) || []).length >= 2,
  `${(script.match(/setTurnActive\(false\)/g) || []).length} 处`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
