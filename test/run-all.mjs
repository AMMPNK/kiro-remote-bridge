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
  const skipped = /SKIP/.test(r.out) && !m;
  console.log(`\n===== ${f} ${skipped ? '(skipped)' : ''}`);
  console.log(r.out.trimEnd());
  if (r.code !== 0) failed++;
  summary.push({
    file: f,
    pass: m ? Number(m[1]) : 0,
    fail: m ? Number(m[2]) : 0,
    skipped,
    code: r.code,
  });
}

console.log('\n==================== 汇总 ====================');
let totalPass = 0;
let totalFail = 0;
for (const s of summary) {
  totalPass += s.pass;
  totalFail += s.fail;
  const tag = s.skipped ? 'SKIP' : s.code === 0 ? ' OK ' : 'FAIL';
  console.log(`  [${tag}] ${s.file.padEnd(16)} ${s.pass} 通过 / ${s.fail} 失败`);
}
console.log(`  合计 ${totalPass} 通过 / ${totalFail} 失败，退出码非零的文件 ${failed} 个`);
process.exit(failed ? 1 : 0);
