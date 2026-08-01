// 依次运行全部测试，任一失败则整体非零退出。
// 用法：node test/run-all.mjs   （或 npm test）
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const files = readdirSync(HERE)
  .filter((f) => /^t\d+-.*\.mjs$/.test(f))
  .sort();

function run(file) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(HERE, file)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) => resolve({ file, code, out }));
  });
}

let failed = 0;
const summary = [];
for (const f of files) {
  const r = await run(f);
  const m = /结果: (\d+) 通过 \/ (\d+) 失败/.exec(r.out);
  const skipped = /^SKIP\b|\bSKIP /m.test(r.out) && (!m || Number(m[1]) + Number(m[2]) === 0);
  const passN = m ? Number(m[1]) : 0;
  const failN = m ? Number(m[2]) : 0;
  /*
   * 「一条都没验」必须和「验过且通过」区分开。
   *
   * 原来的判据只看退出码：一个零断言的文件退出 0，汇总里显示「[ OK ] 0 通过 / 0 失败」,
   * 和真正通过完全一样 —— t1-store 就以这个形态存在了很久。现在没有结果行、或者结果行
   * 是 0/0 而又没有 SKIP 标记的，一律算 EMPTY 并让整体非零退出。
   */
  const empty = !skipped && (!m || passN + failN === 0);
  console.log(`\n===== ${f} ${skipped ? '(skipped)' : ''}${empty ? '(没有任何断言)' : ''}`);
  console.log(r.out.trimEnd());
  if (r.code !== 0 || empty) failed++;
  if (empty) {
    console.log(
      `!! ${f} 没有输出任何断言结果。测试文件必须打印「结果: N 通过 / M 失败」，` +
        '或在无法运行时打印 SKIP 说明原因。'
    );
  }
  summary.push({ file: f, pass: passN, fail: failN, skipped, empty, code: r.code });
}

console.log('\n==================== 汇总 ====================');
let totalPass = 0;
let totalFail = 0;
for (const s of summary) {
  totalPass += s.pass;
  totalFail += s.fail;
  const tag = s.skipped ? 'SKIP' : s.empty ? 'EMPTY' : s.code === 0 ? ' OK ' : 'FAIL';
  console.log(`  [${tag}] ${s.file.padEnd(16)} ${s.pass} 通过 / ${s.fail} 失败`);
}
console.log(`  合计 ${totalPass} 通过 / ${totalFail} 失败，退出码非零的文件 ${failed} 个`);
process.exit(failed ? 1 : 0);
