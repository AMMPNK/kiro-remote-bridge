#!/usr/bin/env node
'use strict';
/**
 * 打包 vsix（零依赖，用系统 zip）。
 *
 * 用白名单而非黑名单：只有显式列出的文件进包。黑名单挡不住将来新增的本地文件，
 * 而 test/ref/node_modules 这类正是最容易误入的一类。
 * 同时校验「必需项清单」——白名单漏项的表现是静默的（只少一个文件、体积几乎不变），
 * 所以必须硬校验，缺任一项就非零退出。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist');
const STAGE = path.join(OUT_DIR, 'stage');

/** 进包的文件（相对项目根）。新增运行时文件必须同时加到这里和 REQUIRED。 */
const WHITELIST = [
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

/** 必需项：缺任何一个都不该产出 vsix。防的是白名单与生成端不同步。 */
const REQUIRED = WHITELIST.slice();

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const vsixName = `${pkg.publisher}.${pkg.name}-${pkg.version}.vsix`;

  // 校验必需项齐备
  const missing = REQUIRED.filter((rel) => !fs.existsSync(path.join(ROOT, rel)));
  if (missing.length) {
    console.error('缺少必需文件，拒绝打包：');
    for (const m of missing) console.error(`  - ${m}`);
    console.error('常见原因是白名单未与生成端同步（新增了源文件但没加进 WHITELIST）。');
    process.exit(1);
  }

  // 反向检查：src/ 与 media/ 下是否有文件不在白名单里（可能是漏加）
  const tracked = new Set(WHITELIST);
  const strays = [];
  for (const dir of ['src', 'media']) {
    const abs = path.join(ROOT, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of fs.readdirSync(abs)) {
      const rel = `${dir}/${f}`;
      if (!tracked.has(rel)) strays.push(rel);
    }
  }
  if (strays.length) {
    console.error('以下文件存在但未列入白名单，拒绝打包（要么加进 WHITELIST，要么删除）：');
    for (const s of strays) console.error(`  - ${s}`);
    process.exit(1);
  }

  rmrf(STAGE);
  fs.mkdirSync(path.join(STAGE, 'extension'), { recursive: true });

  for (const rel of WHITELIST) {
    const dest = path.join(STAGE, 'extension', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(ROOT, rel), dest);
  }

  fs.writeFileSync(
    path.join(STAGE, '[Content_Types].xml'),
    `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json" />
  <Default Extension=".js" ContentType="application/javascript" />
  <Default Extension=".html" ContentType="text/html" />
  <Default Extension=".svg" ContentType="image/svg+xml" />
  <Default Extension=".xml" ContentType="text/xml" />
  <Default Extension=".vsixmanifest" ContentType="text/xml" />
</Types>
`
  );

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  fs.writeFileSync(
    path.join(STAGE, 'extension.vsixmanifest'),
    `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags></Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`
  );

  const vsixPath = path.join(OUT_DIR, vsixName);
  rmrf(vsixPath);
  execFileSync('zip', ['-r', '-q', '-X', vsixPath, '.'], { cwd: STAGE });
  rmrf(STAGE);

  // 产物校验：把包内清单读出来，逐项确认必需文件真的在里面
  const listing = execFileSync('unzip', ['-Z1', vsixPath], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  const inPkg = new Set(listing);
  const notPacked = REQUIRED.filter((rel) => !inPkg.has(`extension/${rel}`));
  if (notPacked.length) {
    console.error('打包后校验失败，以下必需文件不在包内：');
    for (const m of notPacked) console.error(`  - extension/${m}`);
    process.exit(1);
  }
  for (const meta of ['[Content_Types].xml', 'extension.vsixmanifest']) {
    if (!inPkg.has(meta)) {
      console.error(`打包后校验失败：缺少 ${meta}`);
      process.exit(1);
    }
  }
  // 不该出现的东西
  const forbidden = listing.filter((f) => /node_modules|(^|\/)test\/|\.DS_Store/.test(f));
  if (forbidden.length) {
    console.error('包内出现不应发布的文件：');
    for (const f of forbidden) console.error(`  - ${f}`);
    process.exit(1);
  }

  const kb = (fs.statSync(vsixPath).size / 1024).toFixed(1);
  console.log(`已生成 ${path.relative(ROOT, vsixPath)}  (${kb} KB, ${listing.length} 个条目)`);
  console.log('包内条目：');
  for (const f of listing.sort()) console.log(`  ${f}`);
}

main();
