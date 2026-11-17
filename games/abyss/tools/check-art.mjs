/* ============================================================================
 * check-art.mjs — 美术精灵体检
 * ----------------------------------------------------------------------------
 * 干什么：把所有 G.ART 里的精灵，每一帧都真跑一遍 draw()，
 *        用假画笔（MockPx）记录每次落笔，检查四件事：
 *          1. draw() 会不会抛错
 *          2. 用到了画笔没有的方法（拼错名字）
 *          3. 落笔坐标有没有越出 w×h（浪费 + 说明尺寸算错）
 *          4. 每一帧是不是真的画了东西（不是空帧）
 *          + 顺带核 IDS.md 里点名的 id 是否都在
 * 怎么跑：node tools/check-art.mjs
 * 退出码：全绿 0，有问题 1
 *
 * 注意：本文件里所有大小比较一律写成「大 > 小」的方向，
 *      因为写「小于号」在部分写入通道里会被吃掉。
 * ============================================================================ */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SRC = 'D:\\小鱼Agent\\games\\abyss\\src';
const ROOT = 'D:\\小鱼Agent\\games\\abyss';

/* ---------------- 假画笔 ---------------- */
class MockPx {
  constructor(w, h) {
    this.w = w;
    this.h = h;
    this.calls = 0;
    this.pixels = new Set();
    this.oob = [];
    this.glows = 0;
    this.ctx = {
      globalAlpha: 1,
      fillStyle: '#000',
      strokeStyle: '#000',
      lineWidth: 1,
      beginPath() {},
      moveTo() {},
      lineTo() {},
      closePath() {},
      fill() {},
      stroke() {},
      fillRect() {},
      save() {},
      restore() {},
      translate() {},
      scale() {},
      drawImage() {},
      createRadialGradient() { return { addColorStop() {} }; },
      createLinearGradient() { return { addColorStop() {} }; }
    };
  }
  _mark(x, y) {
    const ix = Math.round(x), iy = Math.round(y);
    this.calls++;
    if (this.calls > 200000) {
      throw new Error('落笔超过 20 万次，疑似死循环或尺寸算错（最后一点 ' + ix + ',' + iy + '）');
    }
    // 允许 ≤3px 的边缘溢出：真画布是 canvas，超出部分会被自动裁掉，
    // 像素画贴边时少一两个点看不出来。超过 3px 才算尺寸算错。
    if (ix >= -3 && iy >= -3 && (this.w + 3) > ix && (this.h + 3) > iy) {
      this.pixels.add(ix + ',' + iy);
    } else if (12 > this.oob.length) {
      this.oob.push(ix + ',' + iy);
    }
  }
  px(x, y, c) { this._mark(x, y); }
  rect(x, y, w, h, c) {
    const rw = Math.max(1, Math.round(w)), rh = Math.max(1, Math.round(h));
    for (let j = 0; rh > j; j++)
      for (let i = 0; rw > i; i++)
        this._mark(x + i, y + j);
  }
  line(x0, y0, x1, y1, c) {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let k = 0; n >= k; k++) {
      this._mark(x0 + (x1 - x0) * k / n, y0 + (y1 - y0) * k / n);
    }
  }
  circle(cx, cy, r, c) {
    const R = Math.round(r);
    for (let j = -R; R >= j; j++)
      for (let i = -R; R >= i; i++)
        if (R * R >= i * i + j * j) this._mark(cx + i, cy + j);
  }
  disc(cx, cy, r, c) { this.circle(cx, cy, r, c); }
  ring(cx, cy, r, c) {
    const n = Math.max(8, Math.round(r * 8));
    for (let k = 0; n > k; k++) {
      const a = k / n * Math.PI * 2;
      this._mark(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
    }
  }
  ellipse(cx, cy, rx, ry, c) {
    const RX = Math.round(rx), RY = Math.round(ry);
    for (let j = -RY; RY >= j; j++) {
      for (let i = -RX; RX >= i; i++) {
        const u = i / (rx || 1), v = j / (ry || 1);
        if (1 >= u * u + v * v) this._mark(cx + i, cy + j);
      }
    }
  }
  tri(x0, y0, x1, y1, x2, y2, c) {
    this.poly([[x0, y0], [x1, y1], [x2, y2]], c);
  }
  poly(pts, c) {
    if (!Array.isArray(pts) || 3 > pts.length) {
      throw new Error('poly 参数不是 3 个以上的点: ' + JSON.stringify(pts));
    }
    let minY = Infinity, maxY = -Infinity;
    for (const pt of pts) {
      if (!Array.isArray(pt) || 2 > pt.length) {
        throw new Error('poly 的点不是 [x,y]: ' + JSON.stringify(pt));
      }
      minY = Math.min(minY, pt[1]);
      maxY = Math.max(maxY, pt[1]);
    }
    for (let y = Math.floor(minY); Math.ceil(maxY) >= y; y++) {
      const xs = [];
      for (let i = 0; pts.length > i; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if ((a[1] > y) !== (b[1] > y)) {
          xs.push(a[0] + (y - a[1]) / (b[1] - a[1]) * (b[0] - a[0]));
        }
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; xs.length > i + 1; i += 2) {
        const x0 = Math.round(xs[i]), x1 = Math.round(xs[i + 1]);
        for (let x = x0; x1 >= x; x++) this._mark(x, y);
      }
    }
  }
  // 真画笔的 glow 是径向渐变铺在画布上（fillRect），不算"实体像素"，
  // 这里也不计入覆盖率，免得光晕把占比灌满。
  glow(cx, cy, r, c) { this.glows++; return this; }
  noise(x, y, w, h, colors, seed, density) {
    let s = (seed || 1) * 9301 + 49297;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    const d = density == null ? 0.35 : density;
    for (let j = 0; h > j; j++)
      for (let i = 0; w > i; i++)
        if (d > rnd()) this.px(x + i, y + j, colors[(rnd() * colors.length) | 0]);
    return this;
  }
  // 真画笔的 outline 靠 getImageData 找边缘，mock 里没有像素缓冲，
  // 这里做成空操作（只为不报错，不参与覆盖率统计）。
  outline(c) { return this; }
}

/* ---------------- 沙箱 ---------------- */
const sandbox = {
  console, Math, Date, JSON, Object, Array, String, Number, Boolean, Error,
  parseInt, parseFloat, isNaN, isFinite, setTimeout, clearTimeout,
  Set, Map, Infinity, NaN, undefined
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.G = {};
sandbox.G.ART = {};
sandbox.G.withAlpha = (c, a) => c;
sandbox.G.rand = (a, b) => (a + b) / 2;
sandbox.G.randi = (a, b) => Math.round((a + b) / 2);
sandbox.G.pick = (arr) => arr[0];
sandbox.G.chance = () => false;
sandbox.G.clamp = (v, a, b) => Math.max(a, Math.min(b, v));
sandbox.document = {
  createElement() {
    return {
      width: 0, height: 0,
      getContext() { return new MockPx(64, 64).ctx; }
    };
  }
};

const ctx = vm.createContext(sandbox);

const files = fs.readdirSync(SRC).filter((f) => /^\d\d-.*\.js$/.test(f)).sort();
const toLoad = files.filter((f) => /^11-|^10-/.test(f));

let fatal = 0;
for (const f of toLoad) {
  const code = fs.readFileSync(path.join(SRC, f), 'utf8');
  try {
    vm.runInContext(code, ctx, { filename: f });
  } catch (e) {
    console.log('✗ 加载失败 ' + f + ' :: ' + e.message);
    fatal++;
  }
}

const ART = sandbox.G.ART;
const ids = Object.keys(ART).sort();

/* ---------------- 逐个体检 ---------------- */
let bad = 0;
const rows = [];
for (const id of ids) {
  const def = ART[id];
  if (!def || typeof def.draw !== 'function') {
    console.log('✗ ' + id + ' 没有 draw 函数');
    bad++;
    continue;
  }
  if (!def.w || !def.h) {
    console.log('✗ ' + id + ' 没写 w/h');
    bad++;
    continue;
  }
  const frames = def.frames || 1;
  let minPix = Infinity, maxPix = 0, oobAll = [], err = null;
  for (let f = 0; frames > f; f++) {
    const p = new MockPx(def.w, def.h);
    try {
      def.draw(p, f, f * 0.1);
    } catch (e) {
      err = '帧' + f + ': ' + e.message;
      break;
    }
    const n = p.pixels.size;
    minPix = Math.min(minPix, n);
    maxPix = Math.max(maxPix, n);
    if (p.oob.length) oobAll.push('帧' + f + ' 越界 ' + p.oob.join(' '));
  }
  if (err) {
    console.log('✗ ' + id + ' 抛错 :: ' + err);
    bad++;
    continue;
  }
  if (minPix === 0) {
    console.log('✗ ' + id + ' 有帧是空的（什么都没画）');
    bad++;
    continue;
  }
  const area = def.w * def.h;
  const fillRate = maxPix / area;
  let tag = '';
  if (fillRate > 0.98) tag += ' [几乎铺满，可能画大了]';
  if (oobAll.length) tag += ' [' + oobAll[0] + ']';
  rows.push(
    (id + '                    ').slice(0, 20) +
    (def.w + 'x' + def.h).padEnd(9) +
    ('帧' + frames).padEnd(5) +
    ('像素 ' + minPix + '~' + maxPix).padEnd(14) +
    ('占比 ' + (fillRate * 100).toFixed(0) + '%').padEnd(9) +
    tag
  );
  if (oobAll.length) bad++;
}

console.log('=== 精灵体检：共 ' + ids.length + ' 个 ===');
for (const r of rows) console.log(r);

/* ---------------- 核 IDS.md 点名的 id ---------------- */
const idsMd = fs.readFileSync(path.join(ROOT, 'IDS.md'), 'utf8');
const needed = [];
for (const m of idsMd.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|\s*\d+×\d+/gm)) {
  needed.push(m[1]);
}
const uniqNeeded = [...new Set(needed)];
const missing = uniqNeeded.filter((n) => !ART[n]);
console.log('');
console.log('=== IDS.md 点名 ' + uniqNeeded.length + ' 个精灵 ===');
if (missing.length) {
  console.log('✗ 缺 ' + missing.length + ' 个: ' + missing.join(', '));
  bad += missing.length;
} else {
  console.log('✓ 全在');
}

console.log('');
if (bad || fatal) {
  console.log('结论：' + (bad + fatal) + ' 处问题');
  process.exit(1);
} else {
  console.log('结论：全绿');
  process.exit(0);
}
