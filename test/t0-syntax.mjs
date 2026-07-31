// 对全部源文件做语法检查。
//
// 为什么需要它：extension.js 依赖 vscode，任何测试都不会 require 它，所以它里面的
// 语法错误能躲过整套测试。实测踩过一次 —— 把函数抽到 presets.js 后忘了删原定义，
// 造成 "Identifier 'parseConfigOptions' has already been declared"，122 项测试
// 全绿，而扩展在 IDE 里根本激活不了，报错只出现在 exthost 日志深处。
//
// node --check 能抓到这类错误，问题在于它依赖人记得手动跑。放进测试套件就不依赖记性了。
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

function syntaxOk(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return null;
  } catch (err) {
    const out = String((err.stderr || err.stdout || err.message) || '');
    const line = out.split('\n').find((l) => /Error/.test(l)) || out.split('\n')[0];
    return line.trim().slice(0, 160);
  }
}

// 1. src 下所有 .js
const srcFiles = readdirSync(join(ROOT, 'src')).filter((f) => f.endsWith('.js'));
check('src 目录非空', srcFiles.length > 0, `${srcFiles.length} 个文件`);
for (const f of srcFiles) {
  const err = syntaxOk(join(ROOT, 'src', f));
  check(`src/${f}`, err === null, err || '');
}

// 2. scripts 下所有 .js
for (const f of readdirSync(join(ROOT, 'scripts')).filter((x) => x.endsWith('.js'))) {
  const err = syntaxOk(join(ROOT, 'scripts', f));
  check(`scripts/${f}`, err === null, err || '');
}

// 3. media 下的 .js
for (const f of readdirSync(join(ROOT, 'media')).filter((x) => x.endsWith('.js'))) {
  const err = syntaxOk(join(ROOT, 'media', f));
  check(`media/${f}`, err === null, err || '');
}

// 4. app.html 的内联脚本
const html = readFileSync(join(ROOT, 'media', 'app.html'), 'utf8');
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
check('app.html 内含内联脚本', blocks.length === 1, `${blocks.length} 块`);
blocks.forEach((code, i) => {
  const tmp = join(tmpdir(), `krb-inline-${process.pid}-${i}.js`);
  writeFileSync(tmp, code, 'utf8');
  const err = syntaxOk(tmp);
  unlinkSync(tmp);
  check(`app.html 内联脚本 #${i}`, err === null, err || `${code.length} 字节`);
});

// 5. package.json 与 manifest 合法
for (const rel of ['package.json', 'media/manifest.json']) {
  let ok = true;
  let detail = '';
  try {
    JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
  } catch (e) {
    ok = false;
    detail = String(e.message).slice(0, 120);
  }
  check(`${rel} 是合法 JSON`, ok, detail);
}

// 6. package.json 里声明的命令必须都在 extension.js 里注册
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const ext = readFileSync(join(ROOT, 'src', 'extension.js'), 'utf8');
const declared = (pkg.contributes?.commands ?? []).map((c) => c.command);
const unregistered = declared.filter((c) => !ext.includes(`'${c}'`));
check('声明的命令都已注册', unregistered.length === 0,
  unregistered.length ? `未注册: ${unregistered.join(', ')}` : `共 ${declared.length} 个`);

// 7. extension.js 里 require 的本地模块都存在
const localReqs = [...ext.matchAll(/require\('(\.\/[^']+)'\)/g)].map((m) => m[1]);
const missing = localReqs.filter((r) => {
  const f = r.endsWith('.js') ? r : r + '.js';
  return !srcFiles.includes(f.replace('./', ''));
});
check('require 的本地模块都存在', missing.length === 0,
  missing.length ? `缺失: ${missing.join(', ')}` : `共 ${localReqs.length} 个`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
