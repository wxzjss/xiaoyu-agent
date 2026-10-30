/**
 * 二维码编码器（纯 JS，零依赖）。
 *
 * 为什么自己写：小鱼Agent 装了就能跑，不想为了「显示一个码」拖一个 npm 依赖进来
 * （项目里连 ws 都没装，全套靠 node 内置模块）。
 *
 * 实现的是 QR Code Model 2，字节模式（UTF-8），纠错等级 L/M/Q/H，
 * 版本 1–40 自动选（够装下 url+token 这种 100 字符上下的串）。
 * 参考 ISO/IEC 18004。为了代码短，只做字节模式 + 掩码 0–7 全评估（找最优掩码）。
 */

// 纠错等级 → 格式信息里的 2 bit 编码
const ECC_FORMAT = { L: 1, M: 0, Q: 3, H: 2 };

// 每个版本、每个纠错等级的纠错码字数 / 分块数（来自规范表 9）
const ECC_TABLE = [
  // [L, M, Q, H] 每项：[每块纠错码字数, 块数组]
  null,
  [[7, [[1, 19]]], [10, [[1, 16]]], [13, [[1, 13]]], [17, [[1, 9]]]],
  [[10, [[1, 34]]], [16, [[1, 28]]], [22, [[1, 22]]], [28, [[1, 16]]]],
  [[15, [[1, 55]]], [26, [[1, 44]]], [18, [[2, 17]]], [22, [[2, 13]]]],
  [[20, [[1, 80]]], [18, [[2, 32]]], [26, [[2, 24]]], [16, [[4, 9]]]],
  [[26, [[1, 108]]], [24, [[2, 43]]], [18, [[2, 15], [2, 16]]], [22, [[2, 11], [2, 12]]]],
  [[18, [[2, 68]]], [16, [[4, 27]]], [24, [[4, 19]]], [28, [[4, 15]]]],
  [[20, [[2, 78]]], [18, [[4, 31]]], [18, [[2, 14], [4, 15]]], [26, [[4, 13], [1, 14]]]],
  [[24, [[2, 97]]], [22, [[2, 38], [2, 39]]], [22, [[4, 18], [2, 19]]], [26, [[4, 14], [2, 15]]]],
  [[30, [[2, 116]]], [22, [[3, 36], [2, 37]]], [20, [[4, 16], [4, 17]]], [24, [[4, 12], [4, 13]]]],
  [[18, [[2, 68], [2, 69]]], [26, [[4, 43], [1, 44]]], [24, [[6, 19], [2, 20]]], [28, [[6, 15], [2, 16]]]],
  [[20, [[4, 81]]], [30, [[1, 50], [4, 51]]], [28, [[4, 22], [4, 23]]], [24, [[3, 12], [8, 13]]]],
  [[24, [[2, 92], [2, 93]]], [22, [[6, 36], [2, 37]]], [26, [[4, 20], [6, 21]]], [28, [[7, 14], [4, 15]]]],
  [[26, [[4, 107]]], [22, [[8, 37], [1, 38]]], [24, [[8, 20], [4, 21]]], [22, [[12, 11], [4, 12]]]],
  [[30, [[3, 115], [1, 116]]], [24, [[4, 40], [5, 41]]], [20, [[11, 16], [5, 17]]], [24, [[11, 12], [5, 13]]]],
  [[22, [[5, 87], [1, 88]]], [24, [[5, 41], [5, 42]]], [30, [[5, 24], [7, 25]]], [24, [[11, 12], [7, 13]]]],
  [[24, [[5, 98], [1, 99]]], [28, [[7, 45], [3, 46]]], [24, [[15, 19], [2, 20]]], [30, [[3, 15], [13, 16]]]],
  [[28, [[1, 107], [5, 108]]], [28, [[10, 46], [1, 47]]], [28, [[1, 22], [15, 23]]], [28, [[2, 14], [17, 15]]]],
  [[30, [[5, 120], [1, 121]]], [26, [[9, 43], [4, 44]]], [28, [[17, 22], [1, 23]]], [28, [[2, 14], [19, 15]]]],
  [[28, [[3, 113], [4, 114]]], [26, [[3, 44], [11, 45]]], [26, [[17, 21], [4, 22]]], [26, [[9, 13], [16, 14]]]],
  [[28, [[3, 107], [5, 108]]], [26, [[3, 41], [13, 42]]], [30, [[15, 24], [5, 25]]], [28, [[15, 15], [10, 16]]]],
  [[28, [[4, 116], [4, 117]]], [26, [[17, 42]]], [28, [[17, 22], [6, 23]]], [30, [[19, 16], [6, 17]]]],
  [[28, [[2, 111], [7, 112]]], [28, [[17, 46]]], [30, [[7, 24], [16, 25]]], [24, [[34, 13]]]],
  [[30, [[4, 121], [5, 122]]], [28, [[4, 47], [14, 48]]], [30, [[11, 24], [14, 25]]], [30, [[16, 15], [14, 16]]]],
  [[30, [[6, 117], [4, 118]]], [28, [[6, 45], [14, 46]]], [30, [[11, 24], [16, 25]]], [30, [[30, 16], [2, 17]]]],
  [[26, [[8, 106], [4, 107]]], [28, [[8, 47], [13, 48]]], [30, [[7, 24], [22, 25]]], [30, [[22, 15], [13, 16]]]],
  [[28, [[10, 114], [2, 115]]], [28, [[19, 46], [4, 47]]], [28, [[28, 22], [6, 23]]], [30, [[33, 16], [4, 17]]]],
  [[30, [[8, 122], [4, 123]]], [28, [[22, 45], [3, 46]]], [30, [[8, 23], [26, 24]]], [30, [[12, 15], [28, 16]]]],
  [[30, [[3, 117], [10, 118]]], [28, [[3, 45], [23, 46]]], [30, [[4, 24], [31, 25]]], [30, [[11, 15], [31, 16]]]],
  [[30, [[7, 116], [7, 117]]], [28, [[21, 45], [7, 46]]], [30, [[1, 23], [37, 24]]], [30, [[19, 15], [26, 16]]]],
  [[30, [[5, 115], [10, 116]]], [28, [[19, 47], [10, 48]]], [30, [[15, 24], [25, 25]]], [30, [[23, 15], [25, 16]]]],
  [[30, [[13, 115], [3, 116]]], [28, [[2, 46], [29, 47]]], [30, [[42, 24], [1, 25]]], [30, [[23, 15], [28, 16]]]],
  [[30, [[17, 115]]], [28, [[10, 46], [23, 47]]], [30, [[10, 24], [35, 25]]], [30, [[19, 15], [35, 16]]]],
  [[30, [[17, 115], [1, 116]]], [28, [[14, 46], [21, 47]]], [30, [[29, 24], [19, 25]]], [30, [[11, 15], [46, 16]]]],
  [[30, [[13, 115], [6, 116]]], [28, [[14, 46], [23, 47]]], [30, [[44, 24], [7, 25]]], [30, [[59, 16], [1, 17]]]],
  [[30, [[12, 121], [7, 122]]], [28, [[12, 47], [26, 48]]], [30, [[39, 24], [14, 25]]], [30, [[22, 15], [41, 16]]]],
  [[30, [[6, 121], [14, 122]]], [28, [[6, 47], [34, 48]]], [30, [[46, 24], [10, 25]]], [30, [[2, 15], [64, 16]]]],
  [[30, [[17, 122], [4, 123]]], [28, [[29, 46], [14, 47]]], [30, [[49, 24], [10, 25]]], [30, [[24, 15], [46, 16]]]],
  [[30, [[4, 122], [18, 123]]], [28, [[13, 46], [32, 47]]], [30, [[48, 24], [14, 25]]], [30, [[42, 15], [32, 16]]]],
  [[30, [[20, 117], [4, 118]]], [28, [[40, 47], [7, 48]]], [30, [[43, 24], [22, 25]]], [30, [[10, 15], [67, 16]]]],
  [[30, [[19, 118], [6, 119]]], [28, [[18, 47], [31, 48]]], [30, [[34, 24], [34, 25]]], [30, [[20, 15], [61, 16]]]],
];

// 对齐图形中心坐标表（表 E.1）
const ALIGN = [
  null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82], [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106], [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130], [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142], [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158], [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

/* ─────────────── GF(256) 与 RS 纠错 ─────────────── */

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // 本原多项式 x^8+x^4+x^3+x^2+1
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/**
 * 生成多项式 ∏(x - α^i)，i=0..degree-1。
 * 注意：QR 规范的生成多项式在 GF(256) 里是 x^d + a^(d-1)x^(d-1) + …，等价于
 * 用 i = 0..d-1 的这些根；返回的是**去掉首项 1**之后的系数数组（长度 = degree），
 * 下标 0 对应 x^(degree-1)。
 */
function rsPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

/**
 * 算一段数据的 RS 纠错码字（扩展合成除法，见 research.swtch.com/field）。
 * gen 是去掉首项 1 后的 degree 个系数。
 */
function rsEncode(data, eccLen) {
  const gen = rsPoly(eccLen);
  const res = new Array(eccLen).fill(0);
  for (const byte of data) {
    const factor = byte ^ res[0];
    res.shift();
    res.push(0);
    if (factor) {
      const lf = GF_LOG[factor];
      for (let i = 0; i < eccLen; i++) {
        if (gen[i]) res[i] ^= GF_EXP[(lf + GF_LOG[gen[i]]) % 255];
      }
    }
  }
  return res;
}

/* ─────────────── 位流 ─────────────── */

function BitBuffer() {
  const bits = [];
  return {
    bits,
    put(value, len) {
      for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
    },
  };
}

/** 每个版本每个纠错等级对应的表项 [eccLen, blocks] */
function eccSpec(version, ecc) {
  const t = ECC_TABLE[version];
  if (!t) throw new RangeError('二维码版本超出范围：' + version);
  return t[{ L: 0, M: 1, Q: 2, H: 3 }[ecc]];
}

/** 数据码字 + 纠错码字的总数 = 每块数据长度和 + 每块纠错长度 × 块数 */
function totalCodewords(version, ecc) {
  const [eccLen, blocks] = eccSpec(version, ecc);
  let total = 0;
  for (const [count, size] of blocks) total += count * size + count * eccLen;
  return total;
}

/** 该版本该等级要用多少纠错码字（每块） */
function eccPerBlock(version, ecc) {
  return eccSpec(version, ecc)[0];
}

/** 数据码字容量（不含纠错位） */
function dataCapacity(version, ecc) {
  const [, blocks] = eccSpec(version, ecc);
  let total = 0;
  for (const [count, size] of blocks) total += count * size;
  return total;
}

/* ─────────────── 矩阵构建 ─────────────── */

/**
 * @param {string} text
 * @param {{ ecc?: 'L'|'M'|'Q'|'H' }} [opts]
 * @returns {{ size: number, modules: Uint8Array, version: number, ecc: string }}
 */
export function encodeQr(text, opts = {}) {
  const ecc = String(opts.ecc || 'M').toUpperCase();
  if (!ECC_FORMAT.hasOwnProperty(ecc)) throw new Error('纠错等级只能是 L/M/Q/H');
  const bytes = Buffer.from(String(text), 'utf8');

  // 1. 选最小能装下的版本
  let version = 0;
  for (let v = 1; v <= 40; v++) {
    const capBits = dataCapacity(v, ecc) * 8;
    // 模式指示(4) + 字符计数(8 或 16)
    const ccBits = v <= 9 ? 8 : 16;
    if (4 + ccBits + bytes.length * 8 <= capBits) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('内容太长，二维码装不下');

  // 2. 组位流：模式 0100 + 字符数 + 数据 + 终止符 + 补齐
  const buf = BitBuffer();
  buf.put(4, 4);
  buf.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) buf.put(b, 8);
  const capBits = dataCapacity(version, ecc) * 8;
  const term = Math.min(4, capBits - buf.bits.length);
  buf.put(0, term);
  while (buf.bits.length % 8 !== 0) buf.bits.push(0);
  const dataCw = [];
  for (let i = 0; i < buf.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | buf.bits[i + j];
    dataCw.push(v);
  }
  // 填充码字 0xEC / 0x11 交替
  const PAD = [0xec, 0x11];
  let pi = 0;
  while (dataCw.length < dataCapacity(version, ecc)) dataCw.push(PAD[pi++ % 2]);

  // 3. 分块 + 纠错 + 交织
  const [eccLen, blocks] = eccSpec(version, ecc);
  const dataBlocks = [];
  const eccBlocks = [];
  let offset = 0;
  for (const [count, size] of blocks) {
    for (let i = 0; i < count; i++) {
      const chunk = dataCw.slice(offset, offset + size);
      offset += size;
      dataBlocks.push(chunk);
      eccBlocks.push(rsEncode(chunk, eccLen));
    }
  }
  const finalCw = [];
  const maxData = Math.max(...dataBlocks.map((b) => b.length));
  for (let i = 0; i < maxData; i++) for (const b of dataBlocks) if (i < b.length) finalCw.push(b[i]);
  for (let i = 0; i < eccLen; i++) for (const b of eccBlocks) finalCw.push(b[i]);

  // 4. 摆矩阵
  const size = version * 4 + 17;
  const total = size * size;
  const modules = new Uint8Array(total); // 1 = 深色
  const isFunc = new Uint8Array(total); // 1 = 功能图形（不参与掩码）
  const idx = (x, y) => y * size + x;
  const setFunc = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[idx(x, y)] = dark ? 1 : 0;
    isFunc[idx(x, y)] = 1;
  };

  // 定位图形（三个角）
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        setFunc(cx + dx, cy + dy, d !== 2 && d !== 4);
      }
    }
  };
  finder(3, 3);
  finder(size - 4, 3);
  finder(3, size - 4);

  // 分隔线内的一圈已经是浅色了（上面 d===4 处理了）

  // 定时图形
  for (let i = 8; i < size - 8; i++) {
    setFunc(i, 6, i % 2 === 0);
    setFunc(6, i, i % 2 === 0);
  }

  // 对齐图形
  const ac = ALIGN[version] || [];
  for (const ax of ac) {
    for (const ay of ac) {
      // 三个角上的对齐图形与定位图形重叠，要跳过（规范表 E.1 保证只有这三种情况）。
      if ((ax === 6 && ay === 6) || (ax === 6 && ay === size - 7) || (ax === size - 7 && ay === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          // d=0 中心 → 深，d=1 → 浅，d=2 → 深（5x5 的回字）
          setFunc(ax + dx, ay + dy, d !== 1);
        }
      }
    }
  }

  // 预留格式信息区（先占位，值稍后填）
  // 注意：位置 (8,6) 和 (6,8) 属于**定时图形**（第 6 行/第 6 列），扫描解码器只认那里是定时图形，
  // 所以格式信息的两个副本都必须**绕开**这两格——绝不能让 setFunc 覆盖它们。
  for (let i = 0; i < 6; i++) {
    setFunc(i, 8, false); // 左下角竖排 bits0..5 用 col8 / row i
    setFunc(8, i, false); // 左上角横排 bits0..5 用 row8 / col i
  }
  setFunc(8, 7, false);
  setFunc(7, 8, false);
  setFunc(8, 8, false);
  for (let i = 0; i < 8; i++) {
    setFunc(size - 1 - i, 8, false); // 右上角副本 bits0..7
    setFunc(8, size - 1 - i, false); // 左下角副本 bits0..7
  }
  setFunc(8, size - 8, true); // 深色模块，永远是 1

  // 版本信息（version >= 7）
  if (version >= 7) {
    let v = version;
    let rem = v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = (bits >>> i) & 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      setFunc(b, a, bit);
      setFunc(a, b, bit);
    }
  }

  // 5. 数据填充（之字形，从右下角往上）
  let bitPos = 0;
  const totalDataBits = finalCw.length * 8;
  const nextBit = () => {
    if (bitPos >= totalDataBits) return 0;
    const byte = finalCw[bitPos >> 3];
    const bit = (byte >>> (7 - (bitPos & 7))) & 1;
    bitPos++;
    return bit;
  };
  let up = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // 第 6 列整列是竖直定时图形：处理完 (7,6) 之后直接跳到 (5,4)
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) {
      const y = up ? size - 1 - vert : vert;
      for (let k = 0; k < 2; k++) {
        const x = right - k;
        if (isFunc[idx(x, y)]) continue;
        modules[idx(x, y)] = nextBit();
      }
    }
    up = !up;
  }

  // 6. 掩码：8 种都算一遍罚分，取最低的
  const maskFns = [
    (x, y) => (x + y) % 2 === 0,
    (x, y) => y % 2 === 0,
    (x, y) => x % 3 === 0,
    (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
    (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
    (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
  ];

  const formatBits = (mask) => {
    const data = (ECC_FORMAT[ecc] << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  };

  const applyFormat = (bits) => {
    // 左上（竖排）：bits0..5 → (8, 0..5)，然后 bits6 → (8,7)、bits7 → (8,8)、bits8 → (7,8)，
    // bits9..14 → (5..0, 8)。(8,6) 和 (6,8) 是**定时图形**，绝不能写。
    for (let i = 0; i <= 5; i++) modules[idx(8, i)] = (bits >>> i) & 1;
    modules[idx(8, 7)] = (bits >>> 6) & 1;
    modules[idx(8, 8)] = (bits >>> 7) & 1;
    modules[idx(7, 8)] = (bits >>> 8) & 1;
    for (let i = 9; i <= 14; i++) modules[idx(14 - i, 8)] = (bits >>> i) & 1;
    // 右上副本
    for (let i = 0; i <= 7; i++) modules[idx(size - 1 - i, 8)] = (bits >>> i) & 1;
    // 左下副本：bits8..14 从 (8, size-7) 往上排，最后一个正好落在暗模块上方
    for (let i = 8; i <= 14; i++) modules[idx(8, size - 15 + i)] = (bits >>> i) & 1;
    modules[idx(8, size - 8)] = 1; // 暗模块，永远是深色
  };

  const penalty = (m) => {
    let score = 0;
    // 规则 1：行/列里连续同色 >= 5
    for (let i = 0; i < size; i++) {
      for (const horiz of [true, false]) {
        let run = 1;
        let prev = horiz ? m[idx(0, i)] : m[idx(i, 0)];
        for (let j = 1; j < size; j++) {
          const cur = horiz ? m[idx(j, i)] : m[idx(i, j)];
          if (cur === prev) {
            run++;
          } else {
            if (run >= 5) score += 3 + (run - 5);
            run = 1;
            prev = cur;
          }
        }
        if (run >= 5) score += 3 + (run - 5);
      }
    }
    // 规则 2：2x2 同色块
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const a = m[idx(x, y)];
        if (a === m[idx(x + 1, y)] && a === m[idx(x, y + 1)] && a === m[idx(x + 1, y + 1)]) score += 3;
      }
    }
    // 规则 3：类似定位图形的 1:1:3:1:1
    const pat = [1, 0, 1, 1, 1, 0, 1];
    const check = (get) => {
      for (let i = 0; i + 7 <= size; i++) {
        let ok = true;
        for (let k = 0; k < 7; k++) if (get(i + k) !== pat[k]) { ok = false; break; }
        if (!ok) continue;
        // 前面 4 个浅色 或 后面 4 个浅色
        let before = true;
        for (let k = 1; k <= 4; k++) {
          const p = i - k;
          if (p < 0 || get(p) !== 0) { before = false; break; }
        }
        let after = true;
        for (let k = 0; k < 4; k++) {
          const p = i + 7 + k;
          if (p >= size || get(p) !== 0) { after = false; break; }
        }
        if (before || after) score += 40;
      }
    };
    for (let i = 0; i < size; i++) {
      check((k) => m[idx(k, i)]);
      check((k) => m[idx(i, k)]);
    }
    // 规则 4：深色比例偏离 50%
    let dark = 0;
    for (let i = 0; i < m.length; i++) dark += m[i];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  };

  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const trial = Uint8Array.from(modules);
    const fn = maskFns[mask];
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        if (isFunc[idx(x, y)]) continue;
        if (fn(x, y)) trial[idx(x, y)] ^= 1;
      }
    }
    // 试算格式信息（罚分不太依赖它，但为了准确还是填上）
    const bits = formatBits(mask);
    const save = modules;
    // 临时借用了 applyFormat（它写 modules），所以拷一份到 trial 上
    const applyOn = (arr) => {
      for (let i = 0; i <= 5; i++) arr[idx(8, i)] = (bits >>> i) & 1;
      arr[idx(8, 7)] = (bits >>> 6) & 1;
      arr[idx(8, 8)] = (bits >>> 7) & 1;
      arr[idx(7, 8)] = (bits >>> 8) & 1;
      for (let i = 9; i <= 14; i++) arr[idx(14 - i, 8)] = (bits >>> i) & 1;
      for (let i = 0; i <= 7; i++) arr[idx(size - 1 - i, 8)] = (bits >>> i) & 1;
      for (let i = 8; i <= 14; i++) arr[idx(8, size - 15 + i)] = (bits >>> i) & 1;
      arr[idx(8, size - 8)] = 1;
    };
    applyOn(trial);
    void save;
    void applyFormat;
    const p = penalty(trial);
    if (!best || p < best.p) best = { p, mask, arr: trial };
  }

  return {
    size,
    modules: best.arr,
    version,
    ecc,
    mask: best.mask,
  };
}

/**
 * 画成 SVG（前端直接塞 innerHTML 就能显示，不用 canvas）。
 * @param {string} text
 * @param {{ ecc?: string, scale?: number, margin?: number, dark?: string, light?: string }} [opts]
 */
export function qrSvg(text, opts = {}) {
  const { size, modules } = encodeQr(text, { ecc: opts.ecc || 'M' });
  const margin = opts.margin ?? 3;
  const scale = opts.scale ?? 4;
  const dim = (size + margin * 2) * scale;
  const dark = opts.dark || '#101418';
  const light = opts.light || '#ffffff';
  let path = '';
  for (let y = 0; y < size; y++) {
    let x = 0;
    while (x < size) {
      if (!modules[y * size + x]) {
        x++;
        continue;
      }
      let w = 0;
      while (x + w < size && modules[y * size + x + w]) w++;
      path += `M${(x + margin) * scale} ${(y + margin) * scale}h${w * scale}v${scale}h-${w * scale}z`;
      x += w;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dim}" height="${dim}" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges">` +
    `<rect width="${dim}" height="${dim}" fill="${light}"/>` +
    `<path d="${path}" fill="${dark}"/>` +
    `</svg>`
  );
}

/** 配对字符串：手机扫这个就能一次性拿到地址 + token */
export function pairingUrl(baseUrl, token) {
  const u = String(baseUrl || '').replace(/\/+$/, '');
  const t = encodeURIComponent(String(token || ''));
  return `xiaoyu://pair?url=${encodeURIComponent(u)}&token=${t}`;
}
