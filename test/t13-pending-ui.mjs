// 手机端「待批准」状态机的运行时验证。
//
// 为什么需要这个文件：此前前端只有 t8 的**静态**一致性检查（id / class / 消息类型对齐），
// 没有任何东西真的执行过前端逻辑。结果是一个纯状态机 bug 溜过了 294 项测试，
// 靠人在手机上点出来的 —— 而且它的两条路径表现不同，只测一条会得到「已修好」的错觉：
//
//   退出后重新进 URL  → 框能恢复（页面重载，pendingItem 从头开始）
//   返回列表再切回会话 → 框回不来（renderList 把框 hide 了但没清 pendingItem，
//                                  而 queuePending 拿 pendingItem 当「框还在显示」用）
//
// 做法：从 app.html 里抽出这几个函数，配一套最小 DOM stub 真的跑一遍。
// 不整段 eval 整个 <script>：那会在顶层连 WebSocket、绑事件，测试会挂住。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'media', 'app.html'), 'utf8');
const script = (/<script>([\s\S]*?)<\/script>/.exec(html) || [, ''])[1];

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

/**
 * 按名字抽一个函数声明的源码。靠花括号配平找结尾。
 * 模板字符串里的 ${} 是成对的，不会让计数失衡；真出现落单的花括号字面量时
 * 下面的自检会因为抽不到完整函数而直接报错，不会静默拿到半截代码。
 */
function extractFn(src, name) {
  const head = `function ${name}(`;
  const i = src.indexOf(head);
  if (i < 0) throw new Error(`app.html 里找不到 function ${name}(`);
  let depth = 0, started = false;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') { depth++; started = true; }
    else if (src[j] === '}') {
      depth--;
      if (started && depth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`function ${name} 花括号不配平，抽取失败`);
}

// ---------------------------------------------------------------- 最小 DOM stub
function makeEl() {
  const cls = new Set();
  const el = {
    textContent: '',
    _html: '',
    buttons: [],
    classList: {
      add: (c) => cls.add(c),
      remove: (c) => cls.delete(c),
      contains: (c) => cls.has(c),
    },
    set className(v) { cls.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => cls.add(c)); },
    get className() { return [...cls].join(' '); },
    set innerHTML(v) {
      el._html = v;
      // 只解析出按钮的 data-opt，够这个测试用；不引第三方 DOM 实现
      el.buttons = [...String(v).matchAll(/data-opt="([^"]*)"/g)].map((m) => ({
        dataset: { opt: m[1] },
        onclick: null,
      }));
    },
    get innerHTML() { return el._html; },
    querySelectorAll: () => el.buttons,
  };
  return el;
}

function buildHarness() {
  const els = { pq: makeEl(), pacts: makeEl(), pend: makeEl() };
  const sent = [];
  const vibrations = [];
  const src = [
    'let pendingItem = null;',
    'let pendingQueue = [];',
    extractFn(script, 'optionTone'),
    extractFn(script, 'showPending'),
    extractFn(script, 'queuePending'),
    extractFn(script, 'nextPending'),
    extractFn(script, 'hidePending'),
    extractFn(script, 'respondPending'),
    'return { els, sent, vibrations,',
    '  queuePending, showPending, hidePending, nextPending, respondPending,',
    '  state: () => ({ item: pendingItem, queue: pendingQueue.slice() }) };',
  ].join('\n');

  const fn = new Function(
    'el', 'els', 'sent', 'vibrations', 'navigator', 'send', 'esc', 'escAttr', 'openId', 'setTimeout',
    src
  );
  return fn(
    (id) => {
      if (!els[id]) throw new Error(`stub 里没有元素 ${id}，说明前端引用了新的 id`);
      return els[id];
    },
    els,
    sent,
    vibrations,
    { vibrate: (p) => vibrations.push(p) },
    (type, payload) => sent.push({ type, payload }),
    (s) => String(s == null ? '' : s),
    (s) => String(s == null ? '' : s).replace(/"/g, '&quot;'),
    'sess_x',
    // 队列推进用了 setTimeout(…, 320)，测试里同步执行，免得引入等待
    (f) => f()
  );
}

const OPTIONS = [
  { optionId: 'accept', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always-accept', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  { optionId: 'always-reject', name: 'Always deny', kind: 'reject_always' },
];
const req = (id, at) => ({ toolCallId: id, title: `工具 ${id}`, detail: '{}', options: OPTIONS, at });

const visible = (h) => !h.els.pend.classList.contains('hide');
const btnIds = (h) => h.els.pacts.buttons.map((b) => b.dataset.opt);

// ================================================================ 1. 抽取本身要可靠
{
  let err = null;
  try { buildHarness(); } catch (e) { err = e; }
  check('能从 app.html 抽出待批相关函数并求值', !err, err ? err.message : '');
}

// ================================================================ 2. 首次收到 → 框显示、四个按钮齐
{
  const h = buildHarness();
  h.queuePending([req('tc-1', 1)]);
  check('收到待批后框显示', visible(h));
  check('四个选项都渲染成按钮',
    ['accept', 'always-accept', 'reject', 'always-reject'].every((id) => btnIds(h).includes(id)),
    btnIds(h).join(','));
  check('首次显示会震动提醒', h.vibrations.length === 1, JSON.stringify(h.vibrations));
  // extra 一律走 JSON.stringify：textContent 是「标题\n详情」两行拼出来的，
  // 直接打印会让第二行看起来像一条独立的异常输出（实测被自己骗了五轮）
  check('标题进了文案区', /tc-1/.test(h.els.pq.textContent), JSON.stringify(h.els.pq.textContent));
}

// ================================================================ 3. 返回列表再切回会话 —— 本次修复的那条路
//
// renderList() 做的是 el('pend').classList.add('hide')，**不清 pendingItem**。
// 复现它，然后模拟 openSession → session:open → history(pending) 再走一次 queuePending。
{
  const h = buildHarness();
  h.queuePending([req('tc-1', 1)]);
  // —— 返回列表（照 renderList 的真实做法：只隐藏，不清状态）
  h.els.pend.classList.add('hide');
  check('返回列表后框被隐藏', !visible(h));
  check('但待批状态还留着（这正是坑的来源）', !!h.state().item, JSON.stringify(h.state().item && h.state().item.toolCallId));
  // —— 切回会话，后端把同一条 pending 又送来一次
  h.queuePending([req('tc-1', 1)]);
  check('★ 切回会话后框重新显示', visible(h));
  // 这条**不能**单独用来判断重建成功：框被 hide 时按钮 DOM 仍然留着（真实浏览器同理），
  // 所以旧写法下它照样通过 —— 注入验证时它确实没红。留着只是确认重画没把按钮弄丢。
  check('重新显示后按钮仍然齐全',
    ['accept', 'always-accept', 'reject', 'always-reject'].every((id) => btnIds(h).includes(id)),
    btnIds(h).join(','));
  check('同一条重画不重复震动', h.vibrations.length === 1, `震了 ${h.vibrations.length} 次`);
}

// ================================================================ 4. 后端说没有了 → 框要跟着关
{
  const h = buildHarness();
  h.queuePending([req('tc-1', 1)]);
  h.queuePending([]);
  check('后端返回空列表时框关掉', !visible(h));
  check('本地状态一起清掉（不留点不动的框）', h.state().item === null);
}

// ================================================================ 5. 多条待批排队
{
  const h = buildHarness();
  h.queuePending([req('tc-a', 1), req('tc-b', 2)]);
  check('先显示最早到达的那条', h.state().item.toolCallId === 'tc-a', h.state().item.toolCallId);
  check('其余的进队列', h.state().queue.length === 1 && h.state().queue[0].toolCallId === 'tc-b');
  h.respondPending('accept', true);
  check('批完第一条后自动接上下一条', h.state().item && h.state().item.toolCallId === 'tc-b',
    h.state().item && h.state().item.toolCallId);
  check('框仍然可见（还有待批）', visible(h));
  h.respondPending('accept', true);
  check('全部处理完后框关闭', !visible(h) && h.state().item === null);
}

// ================================================================ 6. 正在看的那条要保住，不要被顶掉
{
  const h = buildHarness();
  h.queuePending([req('tc-a', 1), req('tc-b', 2)]);
  h.respondPending('accept', true);           // 处理掉 a，现在显示 b
  h.queuePending([req('tc-b', 2)]);            // 切回会话，后端只剩 b
  check('重建时保住正在看的那条', h.state().item.toolCallId === 'tc-b', h.state().item.toolCallId);
  check('不会把已处理的那条又拉回来', !h.state().queue.some((p) => p.toolCallId === 'tc-a'));
}

// ================================================================ 7. 点击回传的内容
{
  const h = buildHarness();
  h.queuePending([req('tc-1', 1)]);
  h.respondPending('always-accept', true);
  const last = h.sent[h.sent.length - 1];
  check('提交走 session:approve', last && last.type === 'session:approve', last && last.type);
  check('带上用户点的那个 optionId 原样回传',
    last && last.payload.optionId === 'always-accept', last && last.payload.optionId);
  check('带上 toolCallId', last && last.payload.toolCallId === 'tc-1', last && last.payload.toolCallId);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
