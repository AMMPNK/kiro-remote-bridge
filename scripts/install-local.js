#!/usr/bin/env node
'use strict';
/**
 * 把扩展直接装进 Kiro 的本地扩展目录（不经 CLI）。
 *
 *   node scripts/install-local.js            安装 / 覆盖安装
 *   node scripts/install-local.js --uninstall 卸载并还原索引
 *
 * 优先用官方 CLI，这个脚本只作为 CLI 不可用时的退路：
 *   node scripts/package.js
 *   /Applications/Kiro.app/Contents/Resources/app/bin/code \
 *       --install-extension dist/<publisher>.<name>-<version>.vsix --force
 *
 * 原因（实测踩过）：手写索引条目时，IDE 会把 metadata 字段规范化掉，
 * 留下一条没有 metadata 的记录。那样的扩展在某些启动路径下会被直接跳过 ——
 * exthost 日志里 onStartupFinished 阶段根本不出现它，且没有任何报错。
 * 走 CLI 安装则会写入完整 metadata（source: "vsix"）并把旧版本标记进 .obsolete。
 *
 * 做两件事：
 *   1. 按白名单把运行时文件拷到 ~/.kiro/extensions/<publisher>.<name>-<version>/
 *   2. 往 ~/.kiro/extensions/extensions.json 里登记一条，IDE 重载后才会加载
 *
 * extensions.json 是 IDE 自己维护的索引，改之前一定先备份 —— 写坏它会让整个
 * 扩展系统异常，而这个后果不可逆。备份带时间戳，卸载时会自动还原最近一份。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const EXT_HOME = path.join(os.homedir(), '.kiro', 'extensions');
const INDEX = path.join(EXT_HOME, 'extensions.json');

const FILES = [
  'package.json',
  'src/extension.js',
  'src/muxClient.js',
  'src/presets.js',
  'src/relay.js',
  'src/sessionStore.js',
  'src/wsClient.js',
  'src/wsServer.js',
  'media/app.html',
  'media/manifest.json',
  'media/qr.js',
  'media/icon.svg',
];

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ID = `${pkg.publisher}.${pkg.name}`;
const DIR_NAME = `${ID}-${pkg.version}`;
const TARGET = path.join(EXT_HOME, DIR_NAME);

function readIndex() {
  const raw = fs.readFileSync(INDEX, 'utf8');
  const arr = JSON.parse(raw);
  if (!Array.isArray(arr)) throw new Error('extensions.json 不是数组，格式与预期不符，中止');
  return arr;
}

function backupIndex() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const bak = `${INDEX}.bak-${stamp}`;
  fs.copyFileSync(INDEX, bak);
  // 校验备份可读且内容一致，避免「以为备份了其实没成功」
  const a = fs.readFileSync(INDEX);
  const b = fs.readFileSync(bak);
  if (!a.equals(b)) throw new Error('备份内容与原文件不一致，中止');
  return bak;
}

function latestBackup() {
  const files = fs
    .readdirSync(EXT_HOME)
    .filter((f) => f.startsWith('extensions.json.bak-'))
    .sort();
  return files.length ? path.join(EXT_HOME, files[files.length - 1]) : null;
}

function install() {
  const missing = FILES.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) {
    console.error('缺少必需文件，中止安装：');
    for (const m of missing) console.error(`  - ${m}`);
    process.exit(1);
  }
  if (!fs.existsSync(INDEX)) {
    console.error(`找不到 ${INDEX}，无法登记扩展`);
    process.exit(1);
  }

  const bak = backupIndex();
  console.log(`已备份索引 -> ${path.basename(bak)}`);

  fs.rmSync(TARGET, { recursive: true, force: true });
  for (const rel of FILES) {
    const dest = path.join(TARGET, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }
  console.log(`已拷入 ${FILES.length} 个文件 -> ${TARGET}`);

  const arr = readIndex();
  const kept = arr.filter((e) => !(e.identifier && e.identifier.id === ID));
  kept.push({
    identifier: { id: ID, uuid: crypto.randomUUID() },
    version: pkg.version,
    location: { $mid: 1, path: TARGET, scheme: 'file' },
    relativeLocation: DIR_NAME,
    metadata: {
      isApplicationScoped: false,
      isMachineScoped: false,
      isBuiltin: false,
      installedTimestamp: Date.now(),
      pinned: true,
      source: 'vsix',
      targetPlatform: 'undefined',
      updated: false,
      private: false,
      isPreReleaseVersion: false,
      hasPreReleaseVersion: false,
      preRelease: false,
    },
  });
  const text = JSON.stringify(kept);
  JSON.parse(text); // 写前自检
  fs.writeFileSync(INDEX, text, 'utf8');
  console.log(`已登记索引：${ID}@${pkg.version}（索引现有 ${kept.length} 项）`);

  // 写后复核：重新读一遍确认自己那条在里面
  const after = readIndex();
  const found = after.find((e) => e.identifier && e.identifier.id === ID);
  if (!found) {
    console.error('写后复核失败：索引里找不到刚登记的条目');
    process.exit(1);
  }
  console.log('\n安装完成。下一步：在 Kiro 里执行 Developer: Reload Window');
}

function uninstall() {
  const bak = latestBackup();
  if (bak) {
    fs.copyFileSync(bak, INDEX);
    console.log(`已从 ${path.basename(bak)} 还原索引`);
  } else {
    const arr = readIndex().filter((e) => !(e.identifier && e.identifier.id === ID));
    fs.writeFileSync(INDEX, JSON.stringify(arr), 'utf8');
    console.log('没有备份，改为从索引里移除条目');
  }
  fs.rmSync(TARGET, { recursive: true, force: true });
  console.log(`已删除 ${TARGET}`);
  console.log('\n卸载完成。下一步：在 Kiro 里执行 Developer: Reload Window');
}

if (process.argv.includes('--uninstall')) uninstall();
else install();
