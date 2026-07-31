// 交叉验证自写 QR 编码器：与 qrcode@1.5.4 逐掩码比对完整矩阵。
// 关键：必须强制参考实现也用 byte mode。默认它会对纯大写/数字串选 alphanumeric
// 模式（11 bits/2 字符），容量口径与 byte mode 不同，直接比会得出错误结论。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'test', 'ref', 'package.json'));
const mine = createRequire(join(ROOT, 'package.json'))(join(ROOT, 'media', 'qr.js'));

// 参考实现是可选的开发依赖：装了才做交叉验证。
// 安装方式：cd test/ref && npm init -y && npm i qrcode@1.5.4
let QRCode;
try {
  QRCode = require('qrcode');
} catch (_) {
  console.log('  SKIP  未安装参考实现 qrcode，跳过交叉验证');
  console.log('        安装：cd test/ref && npm init -y && npm i qrcode@1.5.4');
  process.exit(0);
}

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
  ok ? pass++ : fail++;
};

// byte mode 在版本 1..5 / 等级 L 下的字符容量：头部占 12 bit
const BYTE_CAP = { 1: 17, 2: 32, 3: 53, 4: 78, 5: 106 };

const CASES = [
  'http://192.168.1.23:3939/?token=abc',
  'http://192.168.31.144:3939/?token=' + 'aB3'.repeat(14) + 'x',   // 77 字符，真实形态
  'http://10.0.0.2:3939/?token=' + 'zY7'.repeat(14) + 'q',
  'a'.repeat(BYTE_CAP[1]),        // V1 byte 满
  'a'.repeat(BYTE_CAP[1] + 1),    // 溢出到 V2
  'a'.repeat(BYTE_CAP[2]),        // V2 满
  'a'.repeat(BYTE_CAP[2] + 1),
  'a'.repeat(BYTE_CAP[3]),        // V3 满
  'a'.repeat(BYTE_CAP[4]),        // V4 满
  'a'.repeat(BYTE_CAP[5]),        // V5 满
  '中文测试 Kiro 远程桥接',
  'mixed 混合 ~!@#$%^&*()_+ 内容',
];

function refMatrix(text, mask) {
  // segments 显式指定 byte mode，与本实现口径一致
  const qr = QRCode.create([{ data: text, mode: 'byte' }], {
    errorCorrectionLevel: 'L',
    maskPattern: mask,
  });
  const size = qr.modules.size;
  const out = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) row.push(qr.modules.data[r * size + c] ? 1 : 0);
    out.push(row);
  }
  return { m: out, version: qr.version };
}

function diff(a, b) {
  if (a.length !== b.length) return `尺寸不同 ${a.length} vs ${b.length}`;
  let n = 0, first = null;
  for (let r = 0; r < a.length; r++) {
    for (let c = 0; c < a.length; c++) {
      if (a[r][c] !== b[r][c]) { n++; if (!first) first = `(${r},${c})`; }
    }
  }
  return n === 0 ? null : `${n} 个模块不同，首个 ${first}`;
}

for (const text of CASES) {
  const bytes = Buffer.byteLength(text, 'utf8');
  const label = text.length > 30 ? text.slice(0, 27) + `…(${bytes}B)` : `${text} (${bytes}B)`;
  let allOk = true, note = '';
  for (let mask = 0; mask < 8; mask++) {
    const ref = refMatrix(text, mask);
    const got = mine.encode(text, mask);
    if (!got) { allOk = false; note = '本实现返回 null'; break; }
    note = `V${ref.version}`;
    const d = diff(got, ref.m);
    if (d) { allOk = false; note += ` mask${mask}: ${d}`; break; }
  }
  check(label, allOk, note);
}

// 自动选掩码的产物必须等于参考实现 8 个掩码中的某一个（即为合法编码）
const url = 'http://192.168.31.144:3939/?token=' + 'kQ9'.repeat(14) + 'w';
const auto = mine.encode(url);
let matched = -1;
for (let mask = 0; mask < 8; mask++) {
  if (!diff(auto, refMatrix(url, mask).m)) { matched = mask; break; }
}
check('自动选掩码结果是合法编码', matched >= 0, `匹配 mask=${matched}`);

// 版本选择应与参考实现一致
let versionOk = true;
const versionRows = [];
for (const n of [17, 18, 32, 33, 53, 54, 78, 79, 106]) {
  const t = 'a'.repeat(n);
  const refV = refMatrix(t, 0).version;
  const myM = mine.encode(t, 0);
  const myV = myM ? (myM.length - 21) / 4 + 1 : null;
  versionRows.push(`${n}B:ref V${refV}/mine V${myV}`);
  if (myV !== refV) versionOk = false;
}
check('版本选择与参考实现一致', versionOk, versionRows.join('  '));

check('超出 V5 容量时返回 null', mine.encode('a'.repeat(BYTE_CAP[5] + 1)) === null);

const svg = mine.renderQrSvg(url, 6);
check('renderQrSvg 产出合法 SVG',
  svg.startsWith('<svg') && svg.includes('</svg>') && svg.includes('<rect'),
  `${svg.length} 字节`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
