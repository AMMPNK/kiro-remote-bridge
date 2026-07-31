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

fs.rmSync(root, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
