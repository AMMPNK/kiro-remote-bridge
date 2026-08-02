// 用**真实**会话数据校验 sessionStore 的解析（只读，不写任何文件）。
//
// 这个文件的作用与 t7/t9 不同，不可互相替代：那两个跑合成 fixture，验的是解析逻辑；
// 这里验的是「解析逻辑仍然匹配 Kiro 实际写出来的格式」—— 格式漂移只有真实数据能发现。
//
// 此前它是一个纯 console.log 的观察脚本：零断言，永远不会失败，而 run-all 汇总里显示
// 「[ OK ] 0 通过 / 0 失败」，和真正通过长得一模一样。另外 list[0] 没有守卫，在一台
// 没有会话的机器上会抛 TypeError 变成 FAIL —— 该跳过的情况被报成了故障。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { SessionStore } = require('./src/sessionStore.js');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

const store = new SessionStore(() => {});

/** 本机没有可用的真实数据时应当跳过，而不是当成故障 */
const shouldSkip = (s) => !s.exists() || s.listSessionDirs().length === 0;

// ---------------------------------------------------------------- 没有真实数据就明确跳过
// 关键是「跳过」必须和「通过」在输出上可区分，否则一台没有会话的机器会报绿，
// 而它其实一条都没验。
if (shouldSkip(store)) {
  console.log('SKIP  本机没有 ~/.kiro/sessions 数据，真实数据校验跳过');
  console.log('结果: 0 通过 / 0 失败（SKIP）');
  process.exit(0);
}

const dirs = store.listSessionDirs();
const list = store.listSessions();
console.log(`（真实数据：${dirs.length} 个目录，解析出 ${list.length} 个会话）`);

// ---------------------------------------------------------------- 列表层
check('解析出的会话数不超过目录数', list.length <= dirs.length,
  `${list.length} <= ${dirs.length}`);
check('至少解析出一个会话', list.length > 0, `${list.length} 个`);

check('每个会话都有 sessionId', list.every((s) => !!s.sessionId));
check('每个会话都有标题', list.every((s) => typeof s.title === 'string' && s.title.length > 0),
  `缺失 ${list.filter((s) => !s.title).length} 个`);
check('lastActiveAt 都是有限数值',
  list.every((s) => Number.isFinite(s.lastActiveAt)),
  `异常 ${list.filter((s) => !Number.isFinite(s.lastActiveAt)).length} 个`);
check('sessionId 无重复', new Set(list.map((s) => s.sessionId)).size === list.length);

// 按活动时间倒序 —— 手机端列表的排序依赖它
let ordered = true;
for (let i = 1; i < list.length; i++) {
  if (list[i - 1].lastActiveAt < list[i].lastActiveAt) ordered = false;
}
check('按 lastActiveAt 倒序', ordered);

// status / live 只能落在已知取值里。冒出新值说明 Kiro 换了格式，必须知道
const KNOWN_STATUS = new Set(['in_progress', 'waiting_on_user', 'completed', 'idle', 'unknown']);
const KNOWN_LIVE = new Set(['running', 'waiting', 'idle']);
const badStatus = [...new Set(list.map((s) => s.status))].filter((v) => !KNOWN_STATUS.has(v));
check('status 都在已知取值内', badStatus.length === 0,
  badStatus.length ? `未知: ${badStatus.join(',')}` : [...new Set(list.map((s) => s.status))].join(','));
const badLive = [...new Set(list.map((s) => s.live))].filter((v) => !KNOWN_LIVE.has(v));
check('live 都在已知取值内', badLive.length === 0,
  badLive.length ? `未知: ${badLive.join(',')}` : [...new Set(list.map((s) => s.live))].join(','));

// ---------------------------------------------------------------- 历史层
const target = list.find((s) => s.bytes > 0) || list[0];
const t0 = Date.now();
const h = store.readHistory(target.sessionId, 400);
const readMs = Date.now() - t0;
check('最新会话的历史能读出来', h.found === true, `found=${h.found}`);
check('消息数不超过 limit', h.messages.length <= 400, `${h.messages.length} 条`);
check('截断标记与消息数自洽',
  h.truncated ? h.messages.length === 400 : h.messages.length <= 400,
  `truncated=${h.truncated} n=${h.messages.length}`);

/*
 * 已知 kind 的清单从 sessionStore 源码里提取，不手写。
 *
 * 第一版是手写的，而清单是照「当时恰好最新的那个会话」的实际取值列的 —— 换一个会话
 * 就冒出 usage / sessionEvent / turnStart 三个漏项。样本不是清单的来源，产出方才是。
 * 这与 t8 不把后端广播类型写死成数组是同一条纪律。
 */
const storeSrc = readFileSync(join(ROOT, 'src', 'sessionStore.js'), 'utf8');
const KNOWN_KINDS = new Set(
  [...storeSrc.matchAll(/kind: '([a-zA-Z]+)'/g)].map((m) => m[1])
);
// reasoning 是运行时算出来的（isReasoning ? 'reasoning' : 'message'），抓不到字面量
KNOWN_KINDS.add('reasoning');
check('能从源码提取出 kind 清单', KNOWN_KINDS.size >= 10, `${KNOWN_KINDS.size} 种`);
const badKinds = [...new Set(h.messages.map((m) => m.kind))].filter((k) => !KNOWN_KINDS.has(k));
check('渲染事件的 kind 都在已知取值内', badKinds.length === 0,
  badKinds.length ? `未知: ${badKinds.join(',')}` : `${new Set(h.messages.map((m) => m.kind)).size} 种`);
check('每条消息都带 kind', h.messages.every((m) => !!m.kind));

const msgs = h.messages.filter((m) => m.kind === 'message');
check('message 事件的 role 只有 user / assistant',
  msgs.every((m) => m.role === 'user' || m.role === 'assistant'),
  [...new Set(msgs.map((m) => m.role))].join(','));
check('message 事件都有文本字段', msgs.every((m) => typeof m.text === 'string'));

// ---------------------------------------------------------------- 游标层
// 刚整读过，紧接着 tail 必须是空的。这条是手机端不会看到重复内容的依据。
const d1 = store.tail(target.sessionId);
check('readHistory 之后紧接 tail 为空',
  d1.messages.length === 0 && !d1.reset,
  `${d1.messages.length} 条 reset=${!!d1.reset}`);

// ---------------------------------------------------------------- 边界
const miss = store.readHistory('sess_does-not-exist');
check('不存在的会话返回 found=false 且不抛错',
  miss.found === false && Array.isArray(miss.messages) && miss.messages.length === 0,
  JSON.stringify(miss));
const missTail = store.tail('sess_does-not-exist');
check('对不存在的会话 tail 不抛错',
  Array.isArray(missTail.messages) && missTail.messages.length === 0);

const agg = store.aggregateStatus();
check('聚合状态的计数是非负整数',
  Number.isInteger(agg.running) && agg.running >= 0 &&
  Number.isInteger(agg.waiting) && agg.waiting >= 0,
  JSON.stringify(agg));
check('聚合计数不超过会话总数', agg.running + agg.waiting <= list.length,
  `${agg.running}+${agg.waiting} <= ${list.length}`);
check('聚合状态与 live 分布一致',
  agg.running === list.filter((s) => s.live === 'running').length &&
  agg.waiting === list.filter((s) => s.live === 'waiting').length,
  `agg=${agg.running}/${agg.waiting} live=${list.filter((s) => s.live === 'running').length}/${list.filter((s) => s.live === 'waiting').length}`);

// ---------------------------------------------------------------- 跳过判定本身也要验
// 否则「没有数据时会跳过」这条路径永远不会被执行到，而它恰恰是别人机器上会走的那条。
class EmptyStore extends SessionStore {
  exists() { return false; }
  listSessionDirs() { return []; }
}
class NoDirStore extends SessionStore {
  exists() { return true; }
  listSessionDirs() { return []; }
}
check('根目录不存在时判定为跳过', shouldSkip(new EmptyStore(() => {})) === true);
check('根目录存在但没有会话时也判定为跳过', shouldSkip(new NoDirStore(() => {})) === true);
check('本机有真实数据时不跳过', shouldSkip(store) === false);

console.log(`（最大会话读取耗时 ${readMs}ms，${h.messages.length} 条渲染消息）`);
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
