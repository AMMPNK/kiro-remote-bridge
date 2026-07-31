#!/usr/bin/env node
'use strict';
/**
 * 清理 Kiro 里的空会话（无任何消息、标题仍为默认值）。
 *
 *   node scripts/clean-empty-sessions.js              只列出，不改动（默认）
 *   node scripts/clean-empty-sessions.js --apply      备份后删除
 *   node scripts/clean-empty-sessions.js --restore <备份目录>   还原
 *
 * 判据是双重的，两个条件同时满足才算空会话：
 *   1. messages.jsonl 不存在，或大小为 0
 *   2. session.json 的 title 恰为 "New Session"
 * 单看标题不够（用户可能真的留了个叫这名字的会话），单看大小也不够（可能是
 * 正在创建中的会话）。两者同时成立时，这个会话确实不含任何内容。
 *
 * 备份按「相对 sessions 根的完整路径」存放，绝不用 basename 作为键 ——
 * 实测同一个 session id 会出现在多个 workspace 目录下（如
 * sess_6451d5e7… 同时在 816c469bcafbfc35/ 和 ecfc3b9aceb823cb/ 下），
 * 用 basename 备份会让后者覆盖前者，还原时把内容写错位置。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SESSIONS = path.join(os.homedir(), '.kiro', 'sessions');
const TRASH_ROOT = path.join(os.homedir(), '.kiro-bridge', 'trash');

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 收集空会话；返回的 dir 一律是绝对路径 */
function findEmpty() {
  const out = [];
  if (!fs.existsSync(SESSIONS)) return out;
  for (const ws of fs.readdirSync(SESSIONS)) {
    const wsDir = path.join(SESSIONS, ws);
    if (!fs.statSync(wsDir).isDirectory()) continue;
    for (const sess of fs.readdirSync(wsDir)) {
      const dir = path.join(wsDir, sess);
      if (!fs.statSync(dir).isDirectory()) continue;
      const metaPath = path.join(dir, 'session.json');
      if (!fs.existsSync(metaPath)) continue;
      let meta;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      } catch (_) {
        continue; // 解析不了就不动它
      }
      const jsonl = path.join(dir, 'messages.jsonl');
      const size = fs.existsSync(jsonl) ? fs.statSync(jsonl).size : -1;
      const title = String(meta.title || '').trim();
      if (size <= 0 && title === 'New Session') {
        const files = fs.readdirSync(dir).filter((f) =>
          fs.statSync(path.join(dir, f)).isFile()
        );
        out.push({
          dir,
          rel: path.relative(SESSIONS, dir),
          id: meta.id,
          created: meta.createdAt,
          model: meta.modelId || '-',
          files,
          bytes: files.reduce((a, f) => a + fs.statSync(path.join(dir, f)).size, 0),
        });
      }
    }
  }
  out.sort((a, b) => String(a.created).localeCompare(String(b.created)));
  return out;
}

function list(items) {
  console.log(`符合双重判据的空会话：${items.length} 个`);
  const ids = new Set(items.map((i) => i.id));
  if (ids.size !== items.length) {
    console.log(
      `注意：${items.length} 个目录只对应 ${ids.size} 个唯一 id —— ` +
        '同一会话在多个 workspace 下有副本，备份按完整路径存放。'
    );
  }
  let total = 0;
  for (const i of items) {
    total += i.bytes;
    console.log(`  ${i.rel}`);
    console.log(`      created=${i.created} model=${i.model} files=[${i.files.join(', ')}] ${i.bytes}B`);
  }
  console.log(`合计 ${total} 字节`);
}

function apply(items) {
  if (!items.length) {
    console.log('没有需要清理的会话');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const trash = path.join(TRASH_ROOT, stamp);

  // 1. 备份（保留相对路径结构）并记录校验和
  const manifest = [];
  for (const item of items) {
    const destDir = path.join(trash, item.rel);
    fs.mkdirSync(destDir, { recursive: true });
    for (const f of item.files) {
      const src = path.join(item.dir, f);
      const dst = path.join(destDir, f);
      fs.copyFileSync(src, dst);
      manifest.push({ rel: path.join(item.rel, f), sha256: sha256(src), size: fs.statSync(src).size });
    }
  }

  // 2. 校验备份：逐个比对校验和，不通过就中止，绝不带着坏备份去删原件
  for (const m of manifest) {
    const backupFile = path.join(trash, m.rel);
    if (!fs.existsSync(backupFile)) {
      console.error(`备份校验失败：缺少 ${m.rel}，已中止，未删除任何文件`);
      process.exit(1);
    }
    if (sha256(backupFile) !== m.sha256) {
      console.error(`备份校验失败：${m.rel} 校验和不一致，已中止，未删除任何文件`);
      process.exit(1);
    }
  }
  fs.writeFileSync(
    path.join(trash, 'manifest.json'),
    JSON.stringify({ at: stamp, sessionsRoot: SESSIONS, files: manifest }, null, 2),
    'utf8'
  );
  console.log(`已备份 ${manifest.length} 个文件到 ${trash}`);
  console.log('备份校验通过（逐文件比对 sha256）');

  // 3. 删除
  let removed = 0;
  for (const item of items) {
    fs.rmSync(item.dir, { recursive: true, force: true });
    if (!fs.existsSync(item.dir)) removed++;
    else console.error(`  删除失败：${item.rel}`);
  }
  console.log(`已删除 ${removed}/${items.length} 个会话目录`);

  // 4. 复核：这些目录应当都不存在了，且剩余会话数符合预期
  const stillThere = items.filter((i) => fs.existsSync(i.dir));
  if (stillThere.length) {
    console.error(`复核失败：${stillThere.length} 个目录仍存在`);
    process.exit(1);
  }
  const left = findEmpty();
  console.log(`复核：剩余符合判据的空会话 ${left.length} 个（应为 0）`);
  console.log(`\n如需还原：node scripts/clean-empty-sessions.js --restore ${trash}`);
}

function restore(trash) {
  const manifestPath = path.join(trash, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`找不到 ${manifestPath}`);
    process.exit(1);
  }
  const { files } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  let n = 0;
  for (const m of files) {
    const src = path.join(trash, m.rel);
    const dst = path.join(SESSIONS, m.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    // 还原后校验，不能假定 copy 成功就等于还原正确
    if (sha256(dst) !== m.sha256) {
      console.error(`还原校验失败：${m.rel}`);
      process.exit(1);
    }
    n++;
  }
  console.log(`已还原 ${n} 个文件，逐个校验和比对通过`);
}

const argv = process.argv.slice(2);
const restoreIdx = argv.indexOf('--restore');
if (restoreIdx >= 0) {
  restore(argv[restoreIdx + 1]);
} else if (argv.includes('--apply')) {
  const items = findEmpty();
  list(items);
  console.log('');
  apply(items);
} else {
  list(findEmpty());
  console.log('\n这是预览。加 --apply 才会备份并删除。');
}
