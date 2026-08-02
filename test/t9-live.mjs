// 验证 liveState 的判据。核心回归点：session.json 里 status=in_progress
// 但文件很久没动的会话，必须判成 idle（这正是「7 个假运行中」的来源）。
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'krb-live-'));
const store = new SessionStore(() => {});

const ev = (payload) =>
  JSON.stringify({ id: Math.random().toString(36).slice(2), timestamp: new Date().toISOString(), payload }) + '\n';

/** 造一个 messages.jsonl 并把 mtime 设成 ageMin 分钟前 */
function make(name, events, ageMin) {
  const p = path.join(root, name + '.jsonl');
  fs.writeFileSync(p, events.map(ev).join(''));
  if (ageMin) {
    const t = new Date(Date.now() - ageMin * 60000);
    fs.utimesSync(p, t, t);
  }
  return p;
}

// 1. 一轮已收尾 -> idle（即使刚刚写过）
check('turn_end 收尾 → idle',
  store.liveState(make('ended', [
    { type: 'turn_start', executionId: 'e1' },
    { type: 'assistant', content: 'hi', executionId: 'e1' },
    { type: 'turn_end', stopReason: 'end_turn', executionId: 'e1' },
  ], 0)) === 'idle');

// 2. 开了轮次还没收尾 + 刚写过 -> running
check('turn_start 未收尾 + 刚写过 → running',
  store.liveState(make('running', [
    { type: 'turn_start', executionId: 'e1' },
    { type: 'assistant', content: '思考中', executionId: 'e1' },
  ], 0)) === 'running');

// 3. 同样的内容但很久没动 -> idle（被中断的会话）
const stale = store.liveState(make('stale', [
  { type: 'turn_start', executionId: 'e1' },
  { type: 'assistant', content: '写到一半就被关掉了', executionId: 'e1' },
], 10));
check('turn_start 未收尾 + 10 分钟没动 → idle', stale === 'idle', `得到 ${stale}`);

// 4. 关键回归：几周前中断的会话
const weeksOld = store.liveState(make('weeks', [
  { type: 'turn_start', executionId: 'e1' },
  { type: 'tool_call', toolCallId: 't1', toolName: 'execute_bash', status: 'approved' },
], 30 * 24 * 60));
check('30 天前中断的会话 → idle', weeksOld === 'idle', `得到 ${weeksOld}`);

// 5. 有未回应的确认请求 -> waiting
check('未回应的 pending_interaction → waiting',
  store.liveState(make('waiting', [
    { type: 'turn_start', executionId: 'e1' },
    { type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'tc1',
      question: '执行吗', options: [{ title: '允许' }] },
  ], 1)) === 'waiting');

// 6. 确认已被回应 -> 不再 waiting
const resolved = store.liveState(make('resolved', [
  { type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'tc1' },
  { type: 'interaction_resolved', toolCallId: 'tc1', outcome: 'selected', selectedOption: '允许' },
  { type: 'turn_end', stopReason: 'end_turn', executionId: 'e1' },
], 1));
check('已回应的 pending → 不是 waiting', resolved !== 'waiting', `得到 ${resolved}`);

// 7. 等确认不看时间 —— 这条断言此前是反的
//
// 原来写的是「45 分钟前的 pending → idle（窗口外）」，理由是超过 30 分钟的等待窗口。
// 那个契约是错的，而且错在最要紧的场合：**agent 在等你审批时，文件本来就不动**。
// 实测审批可以等 607 分钟，于是一个正等着你的会话在列表上显示成灰色，
// 恰好把最需要被看见的状态藏起来了。现在等确认是确定性判定，与静置多久无关。
const oldWait = store.liveState(make('oldwait', [
  { type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'tc9' },
], 45));
check('45 分钟前的 pending → 仍然 waiting（等确认不看时间）',
  oldWait === 'waiting', `得到 ${oldWait}`);

const ancientWait = store.liveState(make('ancientwait', [
  { type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'tc9b' },
], 60 * 24 * 30)); // 静置 30 天
check('静置 30 天的未回应 pending → 仍然 waiting',
  ancientWait === 'waiting', `得到 ${ancientWait}`);

// 7b. 但字节窗口仍然生效：pending 之后 agent 又写了大量内容，说明它没在等这个 pending。
// 实测真有这样一条历史记录：pending 之后又写了 1.28MB。这种悬挂记录不该显示成「正在等你」。
const pushedOut = store.liveState(make('pushedout', [
  { type: 'pending_interaction', interactionType: 'tool_approval', toolCallId: 'tc9c' },
  // 用足量的后续内容把那条 pending 顶出 16KB 尾部窗口
  ...Array.from({ length: 400 }, (_, i) => ({
    type: 'assistant', content: 'x'.repeat(80), executionId: 'e-push', operationType: 'Say',
  })),
  { type: 'turn_end', stopReason: 'end_turn', executionId: 'e-push' },
], 45));
check('被后续内容顶出尾部窗口的 pending → 不是 waiting', pushedOut !== 'waiting',
  `得到 ${pushedOut}`);

// 8. 空文件 / 不存在
check('0 字节文件 → idle', store.liveState(make('empty', [], 0)) === 'idle');
check('文件不存在 → idle', store.liveState(path.join(root, 'nope.jsonl')) === 'idle');

// 9. 大文件只回读尾部：前面塞满已收尾的轮次，末尾是未收尾的新轮次
const bigEvents = [];
for (let i = 0; i < 4000; i++) {
  bigEvents.push({ type: 'assistant', content: 'x'.repeat(60), executionId: 'old' });
  bigEvents.push({ type: 'turn_end', stopReason: 'end_turn', executionId: 'old' });
}
bigEvents.push({ type: 'turn_start', executionId: 'new' });
bigEvents.push({ type: 'assistant', content: '正在写', executionId: 'new' });
const bigPath = make('big', bigEvents, 0);
const bigSize = fs.statSync(bigPath).size;
const t0 = Date.now();
const bigState = store.liveState(bigPath);
const cost = Date.now() - t0;
check('大文件仅回读尾部即可判定 running',
  bigState === 'running' && cost < 60,
  `${(bigSize / 1024 / 1024).toFixed(1)}MB 耗时 ${cost}ms 得到 ${bigState}`);

// 10. 末尾半行不应影响判定
const partialPath = make('partial', [
  { type: 'turn_start', executionId: 'e1' },
  { type: 'assistant', content: 'ok', executionId: 'e1' },
], 0);
fs.appendFileSync(partialPath, '{"id":"x","timestamp":"n","payload":{"type":"assist');
check('末尾半行不影响判定', store.liveState(partialPath) === 'running');

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
