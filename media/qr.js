/* 最小 QR 编码器：byte mode + 纠错等级 L + 版本 1..5（单数据块，逻辑最简）。
 * 只为把一条本机 URL 变成可扫的码，不追求完整 QR 规范覆盖。
 * 版本 1..5 在 L 级下的容量为 19/34/55/80/108 字节；超出时调用方应回退到纯文本。
 */
(function (global) {
  'use strict';

  // [版本] = { total: 总码字, data: 数据码字, ec: 每块纠错码字 }
  var CAPS = {
    1: { total: 26, data: 19, ec: 7 },
    2: { total: 44, data: 34, ec: 10 },
    3: { total: 70, data: 55, ec: 15 },
    4: { total: 100, data: 80, ec: 20 },
    5: { total: 134, data: 108, ec: 26 },
  };
  // 对齐图形中心坐标（版本 1 没有）
  var ALIGN = { 1: null, 2: 18, 3: 22, 4: 26, 5: 30 };
  // 格式信息 15 bit，纠错等级 L，掩码 0..7（QR 规范固定表）
  var FORMAT_L = [
    0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
  ];

  // ---- GF(256) 运算，本原多项式 0x11d ----
  var EXP = new Uint8Array(512);
  var LOG = new Uint8Array(256);
  (function initGf() {
    var x = 1;
    for (var i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) EXP[j] = EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return EXP[LOG[a] + LOG[b]];
  }

  /** 生成 degree 次 RS 生成多项式 */
  function rsGenerator(degree) {
    var poly = [1];
    for (var d = 0; d < degree; d++) {
      var next = new Array(poly.length + 1).fill(0);
      for (var i = 0; i < poly.length; i++) {
        next[i] ^= poly[i];
        next[i + 1] ^= gfMul(poly[i], EXP[d]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    var gen = rsGenerator(ecLen);
    var res = new Array(ecLen).fill(0);
    for (var i = 0; i < data.length; i++) {
      var factor = data[i] ^ res[0];
      res.shift();
      res.push(0);
      for (var j = 0; j < ecLen; j++) {
        res[j] ^= gfMul(gen[j + 1], factor);
      }
    }
    return res;
  }

  // ---- 位流 ----
  function BitBuffer() {
    this.bits = [];
  }
  BitBuffer.prototype.put = function (value, length) {
    for (var i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  };
  BitBuffer.prototype.toBytes = function (totalDataCodewords) {
    var bits = this.bits.slice();
    // 终止符最多 4 个 0
    var cap = totalDataCodewords * 8;
    var pad = Math.min(4, cap - bits.length);
    for (var i = 0; i < pad; i++) bits.push(0);
    while (bits.length % 8 !== 0) bits.push(0);
    var bytes = [];
    for (var b = 0; b < bits.length; b += 8) {
      var v = 0;
      for (var k = 0; k < 8; k++) v = (v << 1) | bits[b + k];
      bytes.push(v);
    }
    // 交替填充字节
    var padBytes = [0xec, 0x11];
    var pi = 0;
    while (bytes.length < totalDataCodewords) bytes.push(padBytes[pi++ % 2]);
    return bytes;
  };

  function utf8Bytes(str) {
    var out = [];
    for (var i = 0; i < str.length; i++) {
      var c = str.codePointAt(i);
      if (c > 0xffff) i++;
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else
        out.push(
          0xf0 | (c >> 18),
          0x80 | ((c >> 12) & 63),
          0x80 | ((c >> 6) & 63),
          0x80 | (c & 63)
        );
    }
    return out;
  }

  function pickVersion(byteLen) {
    for (var v = 1; v <= 5; v++) {
      // byte mode 头部：4 bit 模式 + 8 bit 长度（版本 1..9）
      var need = Math.ceil((4 + 8 + byteLen * 8) / 8);
      if (need <= CAPS[v].data) return v;
    }
    return null;
  }

  // ---- 矩阵 ----
  function makeMatrix(size) {
    var m = [];
    for (var i = 0; i < size; i++) m.push(new Array(size).fill(null));
    return m;
  }

  function placeFinder(m, r, c) {
    for (var dr = -1; dr <= 7; dr++) {
      for (var dc = -1; dc <= 7; dc++) {
        var rr = r + dr;
        var cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
        var inRing =
          (dr >= 0 && dr <= 6 && (dc === 0 || dc === 6)) ||
          (dc >= 0 && dc <= 6 && (dr === 0 || dr === 6));
        var inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        m[rr][cc] = inRing || inCore ? 1 : 0;
      }
    }
  }

  function placeAlignment(m, center) {
    for (var dr = -2; dr <= 2; dr++) {
      for (var dc = -2; dc <= 2; dc++) {
        var isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
        m[center + dr][center + dc] = isDark ? 1 : 0;
      }
    }
  }

  function reserveFormat(m) {
    var size = m.length;
    for (var i = 0; i < 9; i++) {
      if (m[8][i] === null) m[8][i] = 0;
      if (m[i][8] === null) m[i][8] = 0;
    }
    for (var j = 0; j < 8; j++) {
      if (m[8][size - 1 - j] === null) m[8][size - 1 - j] = 0;
      if (m[size - 1 - j][8] === null) m[size - 1 - j][8] = 0;
    }
    m[size - 8][8] = 1; // 固定为深色的那一格
  }

  function buildBase(version) {
    var size = 21 + (version - 1) * 4;
    var m = makeMatrix(size);
    placeFinder(m, 0, 0);
    placeFinder(m, 0, size - 7);
    placeFinder(m, size - 7, 0);
    // 定位图形
    for (var i = 8; i < size - 8; i++) {
      var bit = i % 2 === 0 ? 1 : 0;
      if (m[6][i] === null) m[6][i] = bit;
      if (m[i][6] === null) m[i][6] = bit;
    }
    var a = ALIGN[version];
    if (a !== null) placeAlignment(m, a);
    reserveFormat(m);
    return m;
  }

  /** 数据按 zigzag 自右下向上填充，跳过第 6 列（定位图形） */
  function placeData(m, bytes) {
    var size = m.length;
    var bits = [];
    for (var i = 0; i < bytes.length; i++) {
      for (var b = 7; b >= 0; b--) bits.push((bytes[i] >> b) & 1);
    }
    var idx = 0;
    var up = true;
    for (var col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (var n = 0; n < size; n++) {
        var row = up ? size - 1 - n : n;
        for (var k = 0; k < 2; k++) {
          var c = col - k;
          if (m[row][c] !== null) continue;
          m[row][c] = idx < bits.length ? bits[idx++] : 0;
        }
      }
      up = !up;
    }
  }

  function maskFn(id, r, c) {
    switch (id) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  }

  /** 记录哪些格子是功能图形（不参与掩码） */
  function functionMask(version) {
    var base = buildBase(version);
    var size = base.length;
    var fixed = [];
    for (var r = 0; r < size; r++) {
      fixed.push([]);
      for (var c = 0; c < size; c++) fixed[r].push(base[r][c] !== null);
    }
    return fixed;
  }

  /** 第一份格式信息拷贝的坐标，序号 0 对应 15 bit 里的最高位 */
  var FORMAT_POS_1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];

  /**
   * 写入 15 bit 格式信息的两份拷贝。
   * 位序为「高位在前」：序号 0 取表值的最高位（bit14），而不是最低位。
   * 第一份见 FORMAT_POS_1；第二份序号 0..6 → (size-1,8)..(size-7,8)，
   * 序号 7..14 → (8,size-8)..(8,size-1)。
   */
  function applyFormat(m, maskId) {
    var size = m.length;
    var fmt = FORMAT_L[maskId];
    var bitAt = function (i) {
      return (fmt >> (14 - i)) & 1;
    };
    var i;
    for (i = 0; i < 15; i++) {
      m[FORMAT_POS_1[i][0]][FORMAT_POS_1[i][1]] = bitAt(i);
    }
    for (i = 0; i <= 6; i++) m[size - 1 - i][8] = bitAt(i);
    for (i = 7; i <= 14; i++) m[8][size - 15 + i] = bitAt(i);
    m[size - 8][8] = 1; // 规范规定恒为深色
  }

  /** 简化惩罚：规则 1（同色连续）+ 规则 3（2x2 同色），足以在 8 种掩码中挑出可扫的 */
  function penalty(m) {
    var size = m.length;
    var score = 0;
    for (var r = 0; r < size; r++) {
      var runV = 1;
      for (var c = 1; c < size; c++) {
        if (m[r][c] === m[r][c - 1]) {
          runV++;
        } else {
          if (runV >= 5) score += 3 + (runV - 5);
          runV = 1;
        }
      }
      if (runV >= 5) score += 3 + (runV - 5);
    }
    for (var c2 = 0; c2 < size; c2++) {
      var runH = 1;
      for (var r2 = 1; r2 < size; r2++) {
        if (m[r2][c2] === m[r2 - 1][c2]) {
          runH++;
        } else {
          if (runH >= 5) score += 3 + (runH - 5);
          runH = 1;
        }
      }
      if (runH >= 5) score += 3 + (runH - 5);
    }
    for (var r3 = 0; r3 < size - 1; r3++) {
      for (var c3 = 0; c3 < size - 1; c3++) {
        var v = m[r3][c3];
        if (v === m[r3][c3 + 1] && v === m[r3 + 1][c3] && v === m[r3 + 1][c3 + 1]) score += 3;
      }
    }
    return score;
  }

  /**
   * @param {string} text
   * @param {number} [forceMask] 指定掩码（0..7）。仅用于与参考实现做逐掩码比对；
   *        正常调用不传，由惩罚评分自动挑选。
   */
  function encode(text, forceMask) {
    var data = utf8Bytes(String(text));
    var version = pickVersion(data.length);
    if (!version) return null;
    var cap = CAPS[version];

    var bb = new BitBuffer();
    bb.put(0b0100, 4); // byte mode
    bb.put(data.length, 8); // 版本 1..9 的长度字段为 8 bit
    for (var i = 0; i < data.length; i++) bb.put(data[i], 8);
    var dataCw = bb.toBytes(cap.data);
    var ecCw = rsEncode(dataCw, cap.ec);
    var all = dataCw.concat(ecCw);

    var fixed = functionMask(version);
    var best = null;
    var from = typeof forceMask === 'number' ? forceMask : 0;
    var to = typeof forceMask === 'number' ? forceMask : 7;
    for (var maskId = from; maskId <= to; maskId++) {
      var m = buildBase(version);
      placeData(m, all);
      for (var r = 0; r < m.length; r++) {
        for (var c = 0; c < m.length; c++) {
          if (!fixed[r][c] && maskFn(maskId, r, c)) m[r][c] ^= 1;
        }
      }
      applyFormat(m, maskId);
      var p = penalty(m);
      if (!best || p < best.penalty) best = { matrix: m, penalty: p };
    }
    return best.matrix;
  }

  /** 渲染成 SVG 字符串；scale 为每个模块的像素边长 */
  function renderQrSvg(text, scale) {
    var m = encode(text);
    if (!m) {
      return (
        '<div style="color:#a00;font:13px system-ui">内容超出本编码器容量（>108 字节），' +
        '请手动复制链接</div>'
      );
    }
    var s = scale || 6;
    var quiet = 4;
    var size = m.length;
    var dim = (size + quiet * 2) * s;
    var parts = [
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
        dim +
        '" height="' +
        dim +
        '" viewBox="0 0 ' +
        dim +
        ' ' +
        dim +
        '" shape-rendering="crispEdges">',
      '<rect width="100%" height="100%" fill="#fff"/>',
    ];
    for (var r = 0; r < size; r++) {
      for (var c = 0; c < size; c++) {
        if (m[r][c] === 1) {
          parts.push(
            '<rect x="' +
              (c + quiet) * s +
              '" y="' +
              (r + quiet) * s +
              '" width="' +
              s +
              '" height="' +
              s +
              '" fill="#000"/>'
          );
        }
      }
    }
    parts.push('</svg>');
    return parts.join('');
  }

  global.renderQrSvg = renderQrSvg;
  global.qrEncode = encode;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { renderQrSvg: renderQrSvg, encode: encode };
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
