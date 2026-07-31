// 验证 sessionStore 对真实会话数据的解析（只读）。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));
const { SessionStore } = require('./src/sessionStore.js');

const store = new SessionStore((m) => {});
console.log('sessions root exists:', store.exists());

const dirs = store.listSessionDirs();
console.log('会话目录数:', dirs.length);

const list = store.listSessions();
console.log('解析出的会话数:', list.length);
const wsSet = new Set(list.map((s) => (s.workspacePaths || [])[0] || '(none)'));
console.log('涉及 workspace 数:', wsSet.size);

const statusCount = {};
for (const s of list) statusCount[s.status] = (statusCount[s.status] || 0) + 1;
console.log('status 分布:', statusCount);

console.log('\n最近 5 个会话（应按活动时间倒序）:');
for (const s of list.slice(0, 5)) {
  console.log(
    `  ${new Date(s.lastActiveAt).toISOString().slice(0, 16)}  [${s.status}] ` +
      `${s.workspaceName} :: ${s.title.slice(0, 46).replace(/\n/g, ' ')}`
  );
}
// 倒序自检
let ordered = true;
for (let i = 1; i < list.length; i++) {
  if (list[i - 1].lastActiveAt < list[i].lastActiveAt) ordered = false;
}
console.log('倒序正确:', ordered);

// 读最新会话的历史
const target = list[0];
console.log(`\n读取历史: ${target.sessionId}`);
const t0 = Date.now();
const h = store.readHistory(target.sessionId, 400);
console.log(`  耗时 ${Date.now() - t0}ms  found=${h.found} truncated=${h.truncated}`);
console.log(`  渲染消息数: ${h.messages.length}`);
const kinds = {};
for (const m of h.messages) kinds[m.kind] = (kinds[m.kind] || 0) + 1;
console.log('  kind 分布:', kinds);

const firstUser = h.messages.find((m) => m.kind === 'message' && m.role === 'user');
console.log('  首条用户消息:', firstUser ? JSON.stringify(firstUser.text.slice(0, 70)) : '(无)');
const firstAsst = h.messages.find((m) => m.kind === 'message' && m.role === 'assistant');
console.log('  首条助手消息长度:', firstAsst ? firstAsst.text.length : 0);
const tool = h.messages.find((m) => m.kind === 'tool');
console.log('  首个工具卡片:', tool ? `${tool.toolName} status=${tool.status}` : '(无)');

// 增量 tail：应为空（刚读过），随后再验证游标行为
const d1 = store.tail(target.sessionId);
console.log(`\n首次 tail（应为 0 条）: ${d1.messages.length} 条, reset=${!!d1.reset}`);

// 聚合状态
console.log('聚合状态:', store.aggregateStatus());

// 不存在的会话
const miss = store.readHistory('sess_does-not-exist');
console.log('不存在会话:', JSON.stringify(miss));
