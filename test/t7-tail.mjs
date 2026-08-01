// 验证 tail 的增量读取：用一个临时的 messages.jsonl 精确控制写入，
// 覆盖正常追加、半行、截断重置三种情况。不碰真实会话数据。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { SessionStore } = require('./src/sessionStore.js');

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// 在临时目录里搭一个与真实布局同构的会话；不写 ~/.kiro
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'krb-tail-'));
const sessDir = path.join(root, 'wshash', 'sess_test-tail');
fs.mkdirSync(sessDir, { recursive: true });
fs.writeFileSync(
  path.join(sessDir, 'session.json'),
  JSON.stringify({
    schemaVersion: '1.0.0', dataModelVersion: 1, id: 'sess_test-tail',
    title: 'tail 测试', agentMode: 'vibe', status: 'idle',
    workspacePaths: ['/tmp/wsA'], createdAt: new Date().toISOString(),
    lastModifiedAt: new Date().toISOString(),
  })
);
const jsonl = path.join(sessDir, 'messages.jsonl');
const ev = (payload) =>
  JSON.stringify({ id: Math.random().toString(36).slice(2), timestamp: new Date().toISOString(), payload }) + '\n';

fs.writeFileSync(jsonl, ev({ type: 'user', content: '第一条' }) +
  ev({ type: 'assistant', content: 'A段', executionId: 'e1' }));

// 让 store 指向临时根目录
class TestStore extends SessionStore {
  get root() { return root; }
  listSessionDirs() { return [sessDir]; }
}
const store = new TestStore(() => {});

const h = store.readHistory('sess_test-tail');
check('初次读取拿到 2 条', h.messages.length === 2 && h.found,
  JSON.stringify(h.messages.map((m) => m.kind)));

// 1. 无变化时 tail 应为空
check('无写入时 tail 为空', store.tail('sess_test-tail').messages.length === 0);

// 2. 追加完整行
fs.appendFileSync(jsonl, ev({ type: 'user', content: '第二条' }));
let d = store.tail('sess_test-tail');
check('追加一行后 tail 拿到 1 条',
  d.messages.length === 1 && d.messages[0].text === '第二条', JSON.stringify(d.messages));

// 3. 半行不应被消费
fs.appendFileSync(jsonl, '{"id":"x","timestamp":"now","payload":{"type":"user","content":"半');
d = store.tail('sess_test-tail');
check('半行不产生消息', d.messages.length === 0, JSON.stringify(d.messages));

// 4. 补齐半行后应完整读到
fs.appendFileSync(jsonl, '行"}}\n');
d = store.tail('sess_test-tail');
check('补齐后读到完整消息',
  d.messages.length === 1 && d.messages[0].text === '半行', JSON.stringify(d.messages));

// 5. 连续 assistant 片段应合并成一条
fs.appendFileSync(jsonl,
  ev({ type: 'assistant', content: 'X', executionId: 'e9' }) +
  ev({ type: 'assistant', content: 'Y', executionId: 'e9' }) +
  ev({ type: 'assistant', content: 'Z', executionId: 'e9' }));
d = store.tail('sess_test-tail');
check('同 executionId 的 assistant 合并',
  d.messages.length === 1 && d.messages[0].text === 'XYZ', JSON.stringify(d.messages));

// 6. 不同 executionId 不应合并
fs.appendFileSync(jsonl,
  ev({ type: 'assistant', content: 'P', executionId: 'e10' }) +
  ev({ type: 'assistant', content: 'Q', executionId: 'e11' }));
d = store.tail('sess_test-tail');
check('不同 executionId 不合并', d.messages.length === 2, JSON.stringify(d.messages.map(m=>m.text)));

// 7. 文件被截断 → 应重置并回全量
fs.writeFileSync(jsonl, ev({ type: 'user', content: '重置后' }));
d = store.tail('sess_test-tail');
check('截断后触发 reset 并回全量',
  d.reset === true && d.messages.length === 1 && d.messages[0].text === '重置后',
  JSON.stringify({ reset: d.reset, n: d.messages.length }));

// 8. 工具事件对齐
fs.appendFileSync(jsonl,
  ev({ type: 'tool_call', toolCallId: 't1', toolName: 'execute_bash', status: 'approved',
       kind: 'execute', args: { explanation: '跑一下' } }) +
  ev({ type: 'tool_result', toolCallId: 't1', success: true, content: 'ok' }));
d = store.tail('sess_test-tail');
check('工具调用与结果被渲染',
  d.messages.length === 2 && d.messages[0].kind === 'tool' &&
  d.messages[0].explanation === '跑一下' && d.messages[1].kind === 'toolResult',
  JSON.stringify(d.messages.map((m) => m.kind)));

// 9. pending_interaction 带 options
fs.appendFileSync(jsonl, ev({ type: 'pending_interaction', interactionType: 'tool_approval',
  toolCallId: 't2', question: '要执行吗', options: [{ title: '允许' }, { title: '拒绝' }] }));
d = store.tail('sess_test-tail');
check('pending_interaction 被渲染',
  d.messages.length === 1 && d.messages[0].kind === 'pending' &&
  d.messages[0].options.length === 2);

// 10. 状态随 session.json 变化
fs.writeFileSync(path.join(sessDir, 'session.json'), JSON.stringify({
  id: 'sess_test-tail', title: 'tail 测试', agentMode: 'vibe',
  status: 'in_progress', workspacePaths: ['/tmp/wsA'],
}));
fs.appendFileSync(jsonl, ev({ type: 'turn_start', executionId: 'e12' }));
d = store.tail('sess_test-tail');
check('tail 带回最新 status', d.status === 'in_progress', d.status);

// 11. readHistory 的尾部回读必须与全量读等价
// readHistory 不再整份读文件，只回读尾部足够的字节。风险点是窗口起点会切断
// renderEvents 的合并组（相邻同 executionId 的 assistant 片段会被并成一条），
// 使窗口里的第一条比全量读时短。实现靠「要求窗口产出严格多于 limit 条」来吸收，
// 这里把窗口调到极小，逼着它反复扩窗，验证结果仍与全量读逐字一致。
{
  const bigDir = path.join(root, 'wshash', 'sess_window');
  fs.mkdirSync(bigDir, { recursive: true });
  fs.writeFileSync(path.join(bigDir, 'session.json'), JSON.stringify({
    id: 'sess_window', title: '窗口边界', status: 'idle', workspacePaths: ['/tmp/wsA'],
  }));
  const bigJsonl = path.join(bigDir, 'messages.jsonl');
  // 刻意让 assistant 片段跨多行同 executionId，制造大量合并组
  const lines = [];
  for (let i = 0; i < 300; i++) {
    lines.push(ev({ type: 'user', content: `问题 ${i}` }));
    for (let k = 0; k < 3; k++) {
      lines.push(ev({ type: 'assistant', content: `答${i}-${k} `, executionId: `e${i}`,
        operationType: 'Say' }));
    }
  }
  fs.writeFileSync(bigJsonl, lines.join(''));

  /** 参照实现：整份读进来再 slice，与改动前的行为一致 */
  const fullRead = (limit) => {
    const events = [];
    for (const line of fs.readFileSync(bigJsonl, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try { events.push(JSON.parse(line)); } catch (_) { /* 半行 */ }
    }
    let m = SessionStore.renderEvents(events);
    const truncated = m.length > limit;
    if (truncated) m = m.slice(-limit);
    return { m, truncated };
  };

  class WindowStore extends SessionStore {
    get root() { return root; }
    listSessionDirs() { return [bigDir]; }
  }

  let allSame = true;
  const detail = [];
  /*
   * 这几对 (窗口, limit) 是扫参数扫出来的：limit 恰好等于该窗口的产出条数。
   * 这正是「严格大于」那个守卫唯一起作用的场合 —— 放松成 >= 就会把被切断的首条
   * 留在结果里。不带这几对的话，等价性断言对 > 和 >= 两种实现都通过，
   * 也就是说它并没有钉住这个守卫（第一版就是这样，变异测试才暴露出来）。
   */
  const BOUNDARY_PAIRS = [[200, 1], [644, 3], [681, 3], [385, 1]];
  for (const [win, limit] of BOUNDARY_PAIRS) {
    const s = new WindowStore(() => {});
    s.historyWindow = win;
    const got = s.readHistory('sess_window', limit);
    const want = fullRead(limit);
    if (JSON.stringify(got.messages) !== JSON.stringify(want.m)) {
      allSame = false;
      detail.push(`边界对 win=${win} limit=${limit}`);
    }
  }
  for (const win of [64, 512, 4096, 65536]) {
    for (const limit of [10, 50, 200, 5000]) {
      const s = new WindowStore(() => {});
      s.historyWindow = win;
      const got = s.readHistory('sess_window', limit);
      const want = fullRead(limit);
      const sameMsg = JSON.stringify(got.messages) === JSON.stringify(want.m);
      const sameTrunc = !!got.truncated === !!want.truncated;
      if (!sameMsg || !sameTrunc) {
        allSame = false;
        detail.push(`win=${win} limit=${limit} 条数${got.messages.length}/${want.m.length} trunc${got.truncated}/${want.truncated}`);
      }
    }
  }
  check('极小窗口下尾部回读与全量读逐字一致', allSame, detail.slice(0, 3).join(' | '));

  // 合并组确实存在，否则上面那条等价性是在一个没有边界风险的样本上通过的
  const probe = new WindowStore(() => {});
  const merged = probe.readHistory('sess_window', 5000).messages
    .filter((m) => m.kind === 'message' && m.role === 'assistant');
  check('样本里确实产生了合并（每组 3 段并成 1 条）',
    merged.length === 300 && merged.every((m) => /答\d+-0 答\d+-1 答\d+-2 /.test(m.text)),
    `${merged.length} 条助手消息`);

  // 游标语义：回读之后紧接 tail 必须为空，否则手机上会重复收到已显示的内容
  const cur = new WindowStore(() => {});
  cur.historyWindow = 128;
  cur.readHistory('sess_window', 50);
  check('小窗口回读后 tail 仍为空', cur.tail('sess_window').messages.length === 0);
}

// 12. findSessionDir 的缓存不能改变查找语义
// 缓存本身很简单，风险全在语义上：同一个 session id 会出现在多个 workspace 目录下，
// 而这里决定「读哪个会话的历史」。原实现是逐个目录先比目录名、再比 meta.id，
// 所以「meta.id 匹配的靠前目录」胜过「目录名匹配的靠后目录」。
{
  const cacheRoot = path.join(root, 'cache-test');
  const mk = (rel, id) => {
    const d = path.join(cacheRoot, rel);
    fs.mkdirSync(d, { recursive: true });
    if (id !== undefined) {
      fs.writeFileSync(path.join(d, 'session.json'), JSON.stringify({ id, status: 'idle' }));
    }
    fs.writeFileSync(path.join(d, 'messages.jsonl'), '');
    return d;
  };

  // 场景一：两个目录同名（同一 id 出现在两个 workspace 下）→ 必须返回枚举里第一个
  const dupA = mk('wsA/sess_dup', 'sess_dup');
  const dupB = mk('wsB/sess_dup', 'sess_dup');
  // 场景二：靠前目录靠 meta.id 匹配，靠后目录靠目录名匹配 → 原实现返回靠前那个
  const byMeta = mk('wsA/oddly-named', 'sess_pref');
  const byName = mk('wsB/sess_pref', 'sess_other');

  class OrderedStore extends SessionStore {
    constructor(dirs) { super(() => {}); this._dirs = dirs; }
    get root() { return cacheRoot; }
    listSessionDirs() { return this._dirs; }
  }

  const s1 = new OrderedStore([dupA, dupB]);
  const firstCold = s1.findSessionDir('sess_dup');
  const firstWarm = s1.findSessionDir('sess_dup');
  check('同名目录：返回枚举里第一个，且缓存不改变结果',
    firstCold === dupA && firstWarm === dupA, `${path.basename(path.dirname(firstCold))}`);

  const s2 = new OrderedStore([byMeta, byName]);
  const prefCold = s2.findSessionDir('sess_pref');
  s2.dirCache.clear();
  const prefRecold = s2.findSessionDir('sess_pref');
  const prefWarm = s2.findSessionDir('sess_pref');
  check('meta.id 匹配的靠前目录胜过目录名匹配的靠后目录',
    prefCold === byMeta && prefRecold === byMeta && prefWarm === byMeta,
    `得到 ${prefCold === byMeta ? 'byMeta(正确)' : path.basename(prefCold || 'null')}`);

  // 目录被删掉之后，缓存必须失效并重新查
  const gone = mk('wsC/sess_gone', 'sess_gone');
  const s3 = new OrderedStore([gone]);
  check('删除前能查到', s3.findSessionDir('sess_gone') === gone);
  fs.rmSync(gone, { recursive: true, force: true });
  s3._dirs = [];
  check('目录被删后缓存失效并返回 null', s3.findSessionDir('sess_gone') === null);

  // 目录换了位置：缓存要跟着换，不能一直指着旧路径
  const moved1 = mk('wsD/sess_move', 'sess_move');
  const s4 = new OrderedStore([moved1]);
  check('移动前查到旧位置', s4.findSessionDir('sess_move') === moved1);
  fs.rmSync(moved1, { recursive: true, force: true });
  const moved2 = mk('wsE/sess_move', 'sess_move');
  s4._dirs = [moved2];
  check('移动后查到新位置', s4.findSessionDir('sess_move') === moved2,
    `得到 ${path.basename(path.dirname(s4.findSessionDir('sess_move') || 'x'))}`);

  // 查不到的 id 不应写进缓存，否则下次会拿到 undefined 却当成命中
  const s5 = new OrderedStore([dupA]);
  check('查不到的 id 返回 null 且不污染缓存',
    s5.findSessionDir('sess_nope') === null && !s5.dirCache.has('sess_nope'));
  check('空 sessionId 直接返回 null', s5.findSessionDir('') === null &&
    s5.findSessionDir(undefined) === null);
}

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
