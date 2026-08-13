#!/usr/bin/env node
'use strict';
/**
 * 发版流程。用法：node scripts/release.js [--install]
 *
 * 为什么需要它：这些步骤本来是手工做的，其中「清理旧版本扩展目录」我漏过两次 ——
 * `--install-extension --force` 不会删旧目录，于是同一个扩展 id 会有多个版本并存，
 * Kiro 加载哪个靠「应该会选高版本」这个假设。一旦它加载了旧的，
 * 测试结果就全是错的，而且极容易把「自己没装对」误诊成「功能没实现」。
 *
 * **刻意不碰 git**：提交需要人写 message，打 tag 是不可逆的推送前提。
 * 这个脚本只负责「验证 + 打包 + 安装 + 校验产物」，git 留给人。
 *
 * 校验产物这一步是重点：文件数对、体积对、exit 0 都无法证明「装的是这一版」。
 * 所以最后要去装好的目录里核对版本号与几个特征字符串。
 */
const { execFileSync, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const EXT_ID = `${pkg.publisher || 'local'}.${pkg.name}`;
const EXT_DIR = path.join(os.homedir(), '.kiro', 'extensions');
const KIRO_CLI = '/Applications/Kiro.app/Contents/Resources/app/bin/code';

const DO_INSTALL = process.argv.includes('--install');

let step = 0;
const say = (msg) => console.log(`\n[${++step}] ${msg}`);
const ok = (msg) => console.log(`    ok  ${msg}`);
const die = (msg) => {
  console.error(`\n发版中止：${msg}`);
  process.exit(1);
};

/**
 * 报一下远端 CI 上一次跑成什么样。
 *
 * 为什么要有这一步：本地全绿和 CI 全绿是两件事，而这两件事**曾经连续 4 次不一致**都没被发现
 * —— t14 用全局 WebSocket 当"手机端"，那个全局要 Node 22.4+ 才默认有，而 CI 当时钉着
 * Node 20。本地（Node 24）永远看不到，我也从不打开 Actions 页面，最后是用户收到第 5 封
 * 失败邮件才发现。
 *
 * 三条纪律，都是刻意的：
 *   - **绝不阻断**。它是旁路观测。CI 红的时候常常正是"我这一版就是来修 CI 的"，
 *     阻断就是误伤。观测永远不做主流程的前置条件。
 *   - gh 不可用 / 没登录 / 没网 → 静默说一句就过，不能让发版失败在一个附加信息上。
 *   - 报的是**上一次已完成的 run**，不是本次（本次代码还没推，CI 压根没见过它）。
 */
function reportCiStatus() {
  say('看一眼远端 CI 上一次的结果（只报告，不阻断）');
  let raw;
  try {
    raw = execFileSync(
      'gh',
      ['run', 'list', '--limit', '1', '--json', 'conclusion,headSha,displayTitle,url'],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000 }
    );
  } catch (_) {
    ok('查不到（gh 不可用或未登录），跳过 —— 记得自己去 Actions 看一眼');
    return;
  }
  let runs = [];
  try {
    runs = JSON.parse(raw);
  } catch (_) {
    ok('gh 返回的不是预期 JSON，跳过');
    return;
  }
  if (!runs.length) {
    ok('远端还没有 run');
    return;
  }
  const r = runs[0];
  const sha = String(r.headSha || '').slice(0, 7);
  if (r.conclusion === 'success') {
    ok(`上一次是绿的（${sha} ${String(r.displayTitle || '').slice(0, 40)}）`);
    return;
  }
  // 故意用醒目格式：这条信息被忽略过 4 次，不能再长得像普通日志。
  console.log('');
  console.log('  ！！ 远端 CI 上一次不是绿的 ！！');
  console.log(`     结论: ${r.conclusion}`);
  console.log(`     提交: ${sha} ${String(r.displayTitle || '').slice(0, 50)}`);
  if (r.url) console.log(`     详情: ${r.url}`);
  console.log('     本地全绿不代表 CI 全绿：环境不同（Node 版本、有没有 ~/.kiro/sessions、');
  console.log('     装不装 test/ref 依赖）。如果这一版就是来修它的，忽略本条继续。');
  console.log('');
}
reportCiStatus();

// ---------------------------------------------------------------- 1. 全量测试
say(`跑全量测试（版本 ${VERSION}）`);
let testOut = '';
try {
  testOut = execFileSync('node', ['test/run-all.mjs'], { cwd: ROOT, encoding: 'utf8' });
} catch (e) {
  console.error((e.stdout || '').split('\n').filter((l) => /FAIL|合计/.test(l)).join('\n'));
  die('测试没全绿');
}
const tally = /合计 (\d+) 通过 \/ (\d+) 失败/.exec(testOut);
if (!tally) die('读不出测试合计，run-all 的输出格式变了？');
const [, passN, failN] = tally;
if (Number(failN) > 0) die(`有 ${failN} 项失败`);
ok(`${passN} 项全绿`);

// ---------------------------------------------------------------- 2. 文档里的测试数要同步
// 这是「同一事实有多份副本」的老问题：README 里写着测试项数，改了代码忘了改它，
// 对外就是一个错的数字。这里只校验、不自动改 —— 自动改会掩盖「我忘了」这件事。
say('校验 README 里的测试项数与实测一致');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
/*
 * 第一版是按量词匹配的（`(\d+)\s*(?:个测试|项)`），结果漏掉了「391 条」这种写法 ——
 * 注入验证时把那个数字改错，门禁直接放行。**按量词枚举的检查，漏一个量词就形同虚设。**
 *
 * 改成：只要某一行提到测试，这一行里的 3-4 位数字就必须等于实测值。
 * 宁可误报也不漏报 —— 误报只是让我去看一眼，漏报是把错数字发给别人。
 * 真出现误报（比如某行既讲测试又提端口号），把那一行的写法改开即可。
 */
const testLines = readme.split('\n').filter((l) => /测试|全绿|用例/.test(l));
const nums = testLines.flatMap((l) => [...l.matchAll(/(?<![\d.])(\d{3,4})(?![\d.])/g)].map((m) => m[1]));
const wrong = [...new Set(nums)].filter((n) => n !== passN);
if (wrong.length) {
  const bad = testLines.filter((l) => wrong.some((n) => l.includes(n)));
  die(
    `README 里的测试数 ${wrong.join(', ')} 与实测 ${passN} 不一致，先改 README。涉及的行：\n` +
      bad.map((l) => '      ' + l.trim().slice(0, 90)).join('\n')
  );
}
ok(`README 提到的测试数都是 ${passN}（检查了 ${testLines.length} 行）`);

// ---------------------------------------------------------------- 3. CHANGELOG 要有本版条目
say('校验 CHANGELOG 有本版条目');
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## [${VERSION}]`)) die(`CHANGELOG 里没有 ## [${VERSION}]`);
ok(`CHANGELOG 有 ${VERSION} 的条目`);

// ---------------------------------------------------------------- 4. 打包
say('打包 vsix');
execFileSync('node', ['scripts/package.js'], { cwd: ROOT, stdio: 'pipe' });
const vsix = path.join(ROOT, 'dist', `${EXT_ID}-${VERSION}.vsix`);
if (!fs.existsSync(vsix)) die(`打包后找不到 ${path.basename(vsix)}`);
ok(`${path.basename(vsix)}（${Math.round(fs.statSync(vsix).size / 1024)}KB）`);

if (!DO_INSTALL) {
  console.log('\n未加 --install，就到这里。');
  console.log('安装并校验：node scripts/release.js --install');
  process.exit(0);
}

// ---------------------------------------------------------------- 5. 清掉同 id 的旧版本目录
// 顺序很重要：先删旧的再装新的。反过来的话，如果安装失败就一个可用版本都不剩了。
say('清理同 id 的旧版本目录');
const stale = fs
  .readdirSync(EXT_DIR)
  .filter((d) => d.startsWith(`${EXT_ID}-`) && d !== `${EXT_ID}-${VERSION}`);
if (!stale.length) ok('没有需要清理的');
for (const d of stale) {
  fs.rmSync(path.join(EXT_DIR, d), { recursive: true, force: true });
  ok(`已删除 ${d}`);
}

// ---------------------------------------------------------------- 6. 安装
say('安装到 Kiro');
if (!fs.existsSync(KIRO_CLI)) die(`找不到 Kiro CLI：${KIRO_CLI}`);
const out = execFileSync(KIRO_CLI, ['--install-extension', vsix, '--force'], { encoding: 'utf8' });
if (!/successfully installed/i.test(out)) die(`安装输出里没看到成功字样：\n${out}`);
ok('安装命令报告成功');

// ---------------------------------------------------------------- 7. 校验装好的产物
/*
 * 「安装命令说成功」不等于「装对了」。这一步去真实目录里核对：
 *   - 只剩一个版本目录（不能靠 Kiro 去猜该加载哪个）
 *   - 目录里的 package.json 版本号 = 本次要发的版本
 *   - 几个必需文件都在（白名单漏项是静默的：门禁返回成功、只少一个文件）
 * 这是「能重建 ≠ 重建对了」在发版上的落地。
 */
say('校验装好的产物');
const dirs = fs.readdirSync(EXT_DIR).filter((d) => d.startsWith(`${EXT_ID}-`));
if (dirs.length !== 1) die(`应该只剩一个版本目录，实际有 ${dirs.length} 个：${dirs.join(', ')}`);
ok(`只有一个版本目录：${dirs[0]}`);

const installed = path.join(EXT_DIR, dirs[0]);
const instPkg = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
if (instPkg.version !== VERSION) die(`装好的是 ${instPkg.version}，要发的是 ${VERSION}`);
ok(`装好的版本号是 ${VERSION}`);

const REQUIRED = [
  'package.json',
  'media/app.html',
  'src/extension.js',
  'src/relay.js',
  'src/sessionStore.js',
  'src/wsServer.js',
  'src/muxClient.js',
];
const missing = REQUIRED.filter((f) => !fs.existsSync(path.join(installed, f)));
if (missing.length) {
  die(
    `装好的目录缺文件：${missing.join(', ')}\n` +
      '常见原因是打包白名单没跟生成端同步 —— 这类缺失是静默的，' +
      '打包会照样成功，只是少一个文件。'
  );
}
ok(`${REQUIRED.length} 个必需文件都在`);

// ---------------------------------------------------------------- 8. 后续动作提示
console.log(`\n${VERSION} 已就绪。剩下这些需要人做：`);
console.log('  1. 重载 Kiro 窗口（Reload Window），否则跑的还是旧代码');
console.log('  2. 按 docs/manual-regression.md 走一遍人工回归');
console.log('  3. git 提交并打 tag（脚本刻意不做，message 要人写）：');
console.log(`       git add -p && git commit && git tag v${VERSION}`);
console.log('  4. 推送之后确认 CI 变绿（本地全绿 ≠ CI 全绿，曾连续 4 次红没被发现）：');
console.log('       gh run watch   # 或者去仓库的 Actions 页面看一眼');
try {
  const dirty = execSync('git status --porcelain', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (dirty) console.log(`\n  当前有 ${dirty.split('\n').length} 个文件未提交。`);
  const ahead = execSync('git rev-list --count @{u}..HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  if (ahead !== '0') console.log(`  本地领先远端 ${ahead} 个提交（未推送）。`);
} catch (_) {
  /* 没有上游分支之类，忽略 */
}
