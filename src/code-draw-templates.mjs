/**
 * 「用代码画图」的模板库（2026-11-15）。
 *
 * 为什么要有这个东西：make_image 以前只能靠一条「出图」模型，没配模型就整档是空的。
 * 改成代码画图之后，一句话就能秒出一张几何风格的图 —— 纯 SVG：渐变、剪影、粒子、
 * 光晕，全是算出来的，没有位图、不联网、不花钱。
 *
 * 约定：每个模板是 (w, h, o) => svg 字符串，o 里有
 *   { w, h, pal, rand, seed, uid, title, subtitle }
 *   pal   —— 调色板（见 PALETTES）
 *   rand  —— 带种子的伪随机，同 seed 必出同一张
 *   uid   —— 给 defs 里 id 加后缀，一张图里不撞名
 * 模板只管画面，标题统一由 code-draw.mjs 在最外层拼，风格才统一。
 */

/* ---------------- 调色板 ---------------- */

export const PALETTES = {
  aurora:   { label: '极光', bg: ['#06121f', '#0b2f45', '#12545c'], a: '#7cf2c8', b: '#63b3ff', c: '#f9f871', ink: '#eaf7ff' },
  midnight: { label: '午夜', bg: ['#05060f', '#101a3a', '#241a4a'], a: '#8b8cff', b: '#5ad1ff', c: '#ffd166', ink: '#e8ecff' },
  sunset:   { label: '日落', bg: ['#2b1055', '#7b2d8e', '#ff7b54'], a: '#ffd166', b: '#ff8fab', c: '#4cc9f0', ink: '#fff5e6' },
  candy:    { label: '糖果', bg: ['#ffe6f0', '#ffc2d9', '#c3a6ff'], a: '#ff5d8f', b: '#7b2cbf', c: '#20c997', ink: '#3a2d44' },
  forest:   { label: '森野', bg: ['#04150f', '#0b2b21', '#134e3a'], a: '#a7f3d0', b: '#7dd3a0', c: '#fde68a', ink: '#e6fff5' },
  cyber:    { label: '赛博', bg: ['#08020f', '#160032', '#2a0147'], a: '#ff2d95', b: '#00f5ff', c: '#ffe600', ink: '#f0e6ff' },
  ocean:    { label: '深海', bg: ['#001324', '#013a63', '#2c7da0'], a: '#61dafb', b: '#89c2d9', c: '#ffd166', ink: '#e8f6ff' },
  mono:     { label: '素白', bg: ['#f7f7f5', '#eceae3', '#dcdad2'], a: '#1f2933', b: '#52606d', c: '#9aa5b1', ink: '#1f2933' },
};

export function paletteOf(name) {
  const k = String(name || '').trim().toLowerCase();
  return PALETTES[k] || null;
}

/* ---------------- 小工具 ---------------- */

/** 带种子的 LCG：同一个 seed 永远画出同一张图 */
export function makeRand(seed) {
  let s = (Number(seed) >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

const f = (n) => (Math.round(n * 100) / 100).toString();

/** 天空用的竖直渐变 */
function vgrad(id, colors, stops) {
  const st = stops || colors.map((c, i) => `${(i / (colors.length - 1)).toFixed(2)}`);
  return `<linearGradient id="${id}" x1="0" y1="0" x2="0.22" y2="1">` +
    colors.map((c, i) => `<stop offset="${st[i]}" stop-color="${c}"/>`).join('') +
    `</linearGradient>`;
}

/* ---------------- 模板 ---------------- */

/** 1. 星空：星云 + 粒子 + 亮星十字光 + 流星 */
export function tplStarfield(w, h, o) {
  const pal = o.pal, r = o.rand, u = o.uid;
  const p = [];
  p.push(`<defs>
    ${vgrad('bg' + u, pal.bg)}
    <radialGradient id="neb${u}"><stop offset="0" stop-color="${pal.a}" stop-opacity="0.5"/><stop offset="0.55" stop-color="${pal.b}" stop-opacity="0.18"/><stop offset="1" stop-color="${pal.b}" stop-opacity="0"/></radialGradient>
    <radialGradient id="neb2${u}"><stop offset="0" stop-color="${pal.c}" stop-opacity="0.42"/><stop offset="1" stop-color="${pal.c}" stop-opacity="0"/></radialGradient>
  </defs>`);
  p.push(`<rect width="${w}" height="${h}" fill="url(#bg${u})"/>`);
  for (let i = 0; i < 5; i++) {
    const cx = r() * w, cy = r() * h * 0.85;
    const rr = Math.min(w, h) * (0.16 + r() * 0.32);
    p.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(rr)}" fill="url(#${i % 2 ? 'neb' : 'neb2'}${u})"/>`);
  }
  // 粒子星
  const n = Math.max(140, Math.round((w * h) / 5200));
  const d = [];
  for (let i = 0; i < n; i++) {
    const x = r() * w, y = r() * h;
    const rad = Math.pow(r(), 2.4) * Math.min(w, h) * 0.0022 + 0.35;
    const col = i % 13 === 0 ? pal.c : (i % 5 === 0 ? pal.a : '#ffffff');
    d.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(rad)}" fill="${col}" opacity="${(0.22 + r() * 0.78).toFixed(2)}"/>`);
  }
  p.push(`<g>${d.join('')}</g>`);
  // 亮星
  for (let i = 0; i < 7; i++) {
    const x = r() * w, y = r() * h * 0.8, s = Math.min(w, h) * (0.012 + r() * 0.022);
    p.push(`<g transform="translate(${f(x)},${f(y)})" opacity="0.92">
      <rect x="${f(-s)}" y="-1.1" width="${f(s * 2)}" height="2.2" fill="#fff" opacity="0.5"/>
      <rect x="-1.1" y="${f(-s)}" width="2.2" height="${f(s * 2)}" fill="#fff" opacity="0.5"/>
      <circle r="${f(s * 0.3)}" fill="#fff"/>
    </g>`);
  }
  // 流星
  for (let i = 0; i < 2; i++) {
    const x = w * (0.15 + r() * 0.6), y = h * (0.08 + r() * 0.28), len = Math.min(w, h) * 0.22;
    p.push(`<path d="M ${f(x)} ${f(y)} L ${f(x - len)} ${f(y + len * 0.55)}" stroke="#fff" stroke-width="1.6" stroke-linecap="round" opacity="0.55"/>`);
  }
  // 地平线的暗雾，让标题有托底
  p.push(`<rect x="0" y="${f(h * 0.72)}" width="${w}" height="${f(h * 0.28)}" fill="url(#bg${u})" opacity="0.55"/>`);
  return p.join('');
}

/** 2. 深海：水波 + 小鲸鱼剪影 + 气泡 */
export function tplOcean(w, h, o) {
  const pal = o.pal, r = o.rand, u = o.uid;
  const p = [];
  p.push(`<defs>
    ${vgrad('bg' + u, pal.bg)}
    <linearGradient id="wl${u}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${pal.a}" stop-opacity="0.30"/><stop offset="1" stop-color="${pal.b}" stop-opacity="0.05"/></linearGradient>
    <radialGradient id="sun${u}" cx="0.5" cy="0" r="0.8"><stop offset="0" stop-color="${pal.c}" stop-opacity="0.55"/><stop offset="1" stop-color="${pal.c}" stop-opacity="0"/></radialGradient>
  </defs>`);
  p.push(`<rect width="${w}" height="${h}" fill="url(#bg${u})"/>`);
  p.push(`<ellipse cx="${f(w * 0.5)}" cy="0" rx="${f(w * 0.7)}" ry="${f(h * 0.55)}" fill="url(#sun${u})"/>`);
  // 光线
  for (let i = 0; i < 7; i++) {
    const x = w * (0.08 + i * 0.13);
    p.push(`<rect x="${f(x)}" y="0" width="${f(w * (0.012 + r() * 0.03))}" height="${f(h * 0.8)}" fill="${pal.a}" opacity="0.045" transform="rotate(${f(-8 - r() * 8)},${f(x)},0)"/>`);
  }
  // 水波
  for (let i = 0; i < 5; i++) {
    const yy = h * (0.42 + i * 0.13), amp = h * (0.012 + r() * 0.018), seg = 6;
    let d = `M 0 ${f(yy)}`;
    for (let s = 1; s <= seg; s++) {
      const x0 = (w / seg) * (s - 1), x1 = (w / seg) * s;
      d += ` Q ${f((x0 + x1) / 2)} ${f(yy + (s % 2 ? -amp : amp) * 2)} ${f(x1)} ${f(yy)}`;
    }
    p.push(`<path d="${d} L ${w} ${h} L 0 ${h} Z" fill="url(#wl${u})" opacity="${(0.55 - i * 0.08).toFixed(2)}"/>`);
  }
  // 小鲸鱼
  const cx = w * 0.5, cy = h * 0.42, s = Math.min(w, h) * 0.0052;
  p.push(`<g transform="translate(${f(cx)},${f(cy)}) scale(${f(s)})" fill="${pal.ink}" opacity="0.92">
    <path d="M -108 4 C -104 -44 -34 -62 22 -50 C 62 -41 84 -22 86 2 C 86 22 62 42 20 49 C -36 57 -104 44 -108 4 Z"/>
    <path d="M 84 0 C 104 -30 134 -38 152 -16 C 140 2 112 12 84 10 Z"/>
    <path d="M -52 -8 C -46 -20 -30 -22 -22 -14 C -28 -4 -44 -2 -52 -8 Z" fill="${pal.bg[0]}" opacity="0.9"/>
    <circle cx="-58" cy="-6" r="4.6" fill="${pal.bg[0]}"/>
  </g>`);
  // 气泡
  for (let i = 0; i < 26; i++) {
    const x = r() * w, y = h * (0.15 + r() * 0.75), rr = Math.min(w, h) * (0.002 + r() * 0.006);
    p.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(rr)}" fill="none" stroke="${pal.a}" stroke-width="1" opacity="${(0.15 + r() * 0.45).toFixed(2)}"/>`);
  }
  return p.join('');
}

/** 3. 山脉：层叠剪影 + 落日 + 飞鸟 */
export function tplMountains(w, h, o) {
  const pal = o.pal, r = o.rand, u = o.uid;
  const p = [];
  p.push(`<defs>
    ${vgrad('bg' + u, pal.bg)}
    <radialGradient id="sun${u}"><stop offset="0" stop-color="${pal.c}" stop-opacity="0.95"/><stop offset="0.6" stop-color="${pal.b}" stop-opacity="0.35"/><stop offset="1" stop-color="${pal.b}" stop-opacity="0"/></radialGradient>
  </defs>`);
  p.push(`<rect width="${w}" height="${h}" fill="url(#bg${u})"/>`);
  p.push(`<circle cx="${f(w * 0.72)}" cy="${f(h * 0.36)}" r="${f(Math.min(w, h) * 0.30)}" fill="url(#sun${u})"/>`);
  p.push(`<circle cx="${f(w * 0.72)}" cy="${f(h * 0.36)}" r="${f(Math.min(w, h) * 0.085)}" fill="${pal.c}" opacity="0.95"/>`);
  // 云带
  for (let i = 0; i < 5; i++) {
    const y = h * (0.14 + i * 0.055);
    p.push(`<rect x="0" y="${f(y)}" width="${w}" height="${f(h * (0.008 + r() * 0.016))}" fill="${pal.ink}" opacity="${(0.05 + r() * 0.08).toFixed(2)}"/>`);
  }
  // 山脉 4 层
  const layers = 4;
  for (let L = 0; L < layers; L++) {
    const base = h * (0.56 + L * 0.11);
    const seg = 5 + L;
    const amp = h * (0.13 - L * 0.022);
    let d = `M 0 ${f(base)}`;
    for (let s = 0; s <= seg; s++) {
      const x = (w / seg) * s;
      const y = base - (s % 2 ? amp * (0.6 + r() * 0.8) : amp * (0.1 + r() * 0.4));
      d += ` L ${f(x)} ${f(y)}`;
    }
    d += ` L ${w} ${h} L 0 ${h} Z`;
    const col = ['#000000', '#000000', '#000000', '#000000'][L];
    p.push(`<path d="${d}" fill="${col}" opacity="${(0.30 + L * 0.18).toFixed(2)}"/>`);
  }
  // 飞鸟
  for (let i = 0; i < 4; i++) {
    const x = w * (0.12 + r() * 0.4), y = h * (0.16 + r() * 0.2), s = Math.min(w, h) * 0.014;
    p.push(`<path d="M ${f(x - s)} ${f(y)} Q ${f(x - s * 0.4)} ${f(y - s * 0.6)} ${f(x)} ${f(y)} Q ${f(x + s * 0.4)} ${f(y - s * 0.6)} ${f(x + s)} ${f(y)}" fill="none" stroke="${pal.ink}" stroke-width="1.6" stroke-linecap="round" opacity="0.6"/>`);
  }
  return p.join('');
}

/** 4. 城市：楼群剪影 + 亮窗 + 月亮 */
export function tplCity(w, h, o) {
  const pal = o.pal, r = o.rand, u = o.uid;
  const p = [];
  p.push(`<defs>
    ${vgrad('bg' + u, pal.bg)}
    <radialGradient id="moon${u}"><stop offset="0" stop-color="${pal.c}" stop-opacity="0.85"/><stop offset="1" stop-color="${pal.c}" stop-opacity="0"/></radialGradient>
  </defs>`);
  p.push(`<rect width="${w}" height="${h}" fill="url(#bg${u})"/>`);
  p.push(`<circle cx="${f(w * 0.78)}" cy="${f(h * 0.22)}" r="${f(Math.min(w, h) * 0.2)}" fill="url(#moon${u})"/>`);
  p.push(`<circle cx="${f(w * 0.78)}" cy="${f(h * 0.22)}" r="${f(Math.min(w, h) * 0.055)}" fill="#fff" opacity="0.92"/>`);
  // 星点
  for (let i = 0; i < 90; i++) {
    const x = r() * w, y = r() * h * 0.55, rr = 0.4 + r() * 1.1;
    p.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(rr)}" fill="#fff" opacity="${(0.2 + r() * 0.7).toFixed(2)}"/>`);
  }
  // 三层楼
  for (let L = 0; L < 3; L++) {
    const baseY = h * (0.72 + L * 0.09);
    let x = -w * 0.02;
    const minW = w * (0.045 + L * 0.012), maxW = w * (0.10 + L * 0.02);
    const minH = h * (0.10 + L * 0.04), maxH = h * (0.26 + L * 0.06);
    while (x < w * 1.02) {
      const bw = minW + r() * (maxW - minW);
      const bh = minH + r() * (maxH - minH);
      const top = baseY - bh;
      p.push(`<rect x="${f(x)}" y="${f(top)}" width="${f(bw)}" height="${f(bh + (h - baseY))}" fill="#000" opacity="${(0.45 + L * 0.2).toFixed(2)}"/>`);
      // 窗
      const cols = Math.max(2, Math.floor(bw / (w * 0.018)));
      const rows = Math.max(2, Math.floor(bh / (h * 0.035)));
      for (let cx = 0; cx < cols; cx++) {
        for (let cy = 0; cy < rows; cy++) {
          if (r() > 0.34) continue;
          const wx = x + bw * ((cx + 0.5) / cols) - bw * 0.055;
          const wy = top + bh * ((cy + 0.5) / rows) - bh * 0.012;
          p.push(`<rect x="${f(wx)}" y="${f(wy)}" width="${f(bw * 0.11)}" height="${f(bh * 0.024)}" fill="${r() > 0.75 ? pal.c : pal.a}" opacity="${(0.35 + r() * 0.6).toFixed(2)}"/>`);
        }
      }
      x += bw + w * (0.004 + r() * 0.012);
    }
  }
  return p.join('');
}

/** 5. 海报：大色块 + 几何装饰，给标题留出干净地方 */
export function tplPoster(w, h, o) {
  const pal = o.pal, r = o.rand, u = o.uid;
  const p = [];
  p.push(`<defs>
    <linearGradient id="bg${u}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${pal.bg[0]}"/><stop offset="0.5" stop-color="${pal.bg[1] || pal.bg[0]}"/><stop offset="1" stop-color="${pal.bg[2] || pal.bg[1] || pal.bg[0]}"/>
    </linearGradient>
  </defs>`);
  p.push(`<rect width="${w}" height="${h}" fill="url(#bg${u})"/>`);
  // 大圆
  p.push(`<circle cx="${f(w * 0.82)}" cy="${f(h * 0.18)}" r="${f(Math.min(w, h) * 0.34)}" fill="${pal.a}" opacity="0.16"/>`);
  p.push(`<circle cx="${f(w * 0.16)}" cy="${f(h * 0.86)}" r="${f(Math.min(w, h) * 0.26)}" fill="${pal.b}" opacity="0.14"/>`);
  // 斜条纹
  for (let i = 0; i < 9; i++) {
    const x = w * (0.02 + i * 0.115);
    p.push(`<rect x="${f(x)}" y="0" width="${f(w * 0.016)}" height="${h}" fill="${pal.ink}" opacity="0.035" transform="rotate(18,${f(x)},${f(h / 2)})"/>`);
  }
  // 圆环
  for (let i = 0; i < 3; i++) {
    p.push(`<circle cx="${f(w * (0.2 + r() * 0.6))}" cy="${f(h * (0.2 + r() * 0.5))}" r="${f(Math.min(w, h) * (0.06 + r() * 0.16))}" fill="none" stroke="${i % 2 ? pal.c : pal.a}" stroke-width="${f(Math.min(w, h) * 0.004)}" opacity="${(0.25 + r() * 0.35).toFixed(2)}"/>`);
  }
  // 网格点
  for (let gx = 0; gx < 14; gx++) {
    for (let gy = 0; gy < 10; gy++) {
      p.push(`<circle cx="${f(w * (0.68 + gx * 0.024))}" cy="${f(h * (0.62 + gy * 0.036))}" r="1.6" fill="${pal.ink}" opacity="0.16"/>`);
    }
  }
  return p.join('');
}

/** 6. 抽象波纹：一条条正弦曲线，冷暖对撞 */
export function tplWaves(w, h, o) {
  const pal = o.pal, r = o.rand, u = o.uid;
  const p = [];
  p.push(`<defs>${vgrad('bg' + u, pal.bg)}</defs>`);
  p.push(`<rect width="${w}" height="${h}" fill="url(#bg${u})"/>`);
  const lines = 46;
  for (let i = 0; i < lines; i++) {
    const t = i / lines;
    const yy = h * (0.08 + t * 0.92);
    const amp = h * (0.03 + t * 0.09) * (0.5 + r() * 0.9);
    const k = 1.2 + r() * 1.6;
    const seg = 48;
    let d = `M 0 ${f(yy)}`;
    for (let s = 1; s <= seg; s++) {
      const x = (w / seg) * s;
      const y = yy + Math.sin((s / seg) * Math.PI * 2 * k + t * 6) * amp;
      d += ` L ${f(x)} ${f(y)}`;
    }
    const col = i % 3 === 0 ? pal.c : (i % 2 ? pal.a : pal.b);
    p.push(`<path d="${d}" fill="none" stroke="${col}" stroke-width="${f(1 + r() * 2.6)}" opacity="${(0.15 + r() * 0.5).toFixed(2)}" stroke-linecap="round"/>`);
  }
  return p.join('');
}

/** 7. 星球：行星 + 光环 + 环带碎屑 */
export function tplPlanet(w, h, o) {
  const pal = o.pal, r = o.rand, u = o.uid;
  const p = [];
  p.push(`<defs>
    ${vgrad('bg' + u, pal.bg)}
    <radialGradient id="pl${u}" cx="0.34" cy="0.28" r="0.82">
      <stop offset="0" stop-color="${pal.a}"/><stop offset="0.55" stop-color="${pal.b}"/><stop offset="1" stop-color="${pal.bg[0]}"/>
    </radialGradient>
    <linearGradient id="rg${u}" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0" stop-color="${pal.c}" stop-opacity="0"/><stop offset="0.5" stop-color="${pal.c}" stop-opacity="0.75"/><stop offset="1" stop-color="${pal.c}" stop-opacity="0"/>
    </linearGradient>
  </defs>`);
  p.push(`<rect width="${w}" height="${h}" fill="url(#bg${u})"/>`);
  for (let i = 0; i < 160; i++) {
    const x = r() * w, y = r() * h, rr = 0.35 + Math.pow(r(), 3) * 1.6;
    p.push(`<circle cx="${f(x)}" cy="${f(y)}" r="${f(rr)}" fill="#fff" opacity="${(0.2 + r() * 0.72).toFixed(2)}"/>`);
  }
  const cx = w * 0.5, cy = h * 0.47, R = Math.min(w, h) * 0.26;
  // 后半环
  p.push(`<ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(R * 1.85)}" ry="${f(R * 0.42)}" fill="none" stroke="url(#rg${u})" stroke-width="${f(R * 0.16)}" opacity="0.75" transform="rotate(-16,${f(cx)},${f(cy)})"/>`);
  // 星球
  p.push(`<circle cx="${f(cx)}" cy="${f(cy)}" r="${f(R)}" fill="url(#pl${u})"/>`);
  // 表面条带
  for (let i = 0; i < 7; i++) {
    const yy = cy - R + (i + 0.5) * (R * 2 / 7);
    const hh = (R * 2 / 7) * (0.3 + r() * 0.4);
    const halfW = Math.sqrt(Math.max(0, R * R - Math.pow(yy - cy, 2)));
    p.push(`<rect x="${f(cx - halfW)}" y="${f(yy - hh / 2)}" width="${f(halfW * 2)}" height="${f(hh)}" fill="${pal.bg[0]}" opacity="${(0.06 + r() * 0.16).toFixed(2)}"/>`);
  }
  // 前半环（把下半段盖住才有立体感）
  p.push(`<path d="M ${f(cx - R * 1.85)} ${f(cy)} A ${f(R * 1.85)} ${f(R * 0.42)} 0 0 0 ${f(cx + R * 1.85)} ${f(cy)}" fill="none" stroke="url(#rg${u})" stroke-width="${f(R * 0.16)}" opacity="0.9" transform="rotate(-16,${f(cx)},${f(cy)})"/>`);
  // 卫星
  p.push(`<circle cx="${f(cx + R * 1.55)}" cy="${f(cy - R * 0.62)}" r="${f(R * 0.11)}" fill="${pal.ink}" opacity="0.85"/>`);
  return p.join('');
}

/** 8. 几何图案：等距小方块/斜格，很适合做底纹和封面 */
export function tplPattern(w, h, o) {
  const pal = o.pal, r = o.rand, u = o.uid;
  const p = [];
  p.push(`<defs>
    <linearGradient id="bg${u}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${pal.bg[0]}"/><stop offset="1" stop-color="${pal.bg[2] || pal.bg[1] || pal.bg[0]}"/>
    </linearGradient>
  </defs>`);
  p.push(`<rect width="${w}" height="${h}" fill="url(#bg${u})"/>`);
  const step = Math.min(w, h) / 13;
  for (let gx = -1; gx < w / step + 2; gx++) {
    for (let gy = -1; gy < h / step + 2; gy++) {
      const x = gx * step, y = gy * step;
      const kind = Math.floor(r() * 5);
      const col = [pal.a, pal.b, pal.c, pal.ink][Math.floor(r() * 4)];
      const op = (0.12 + r() * 0.42).toFixed(2);
      if (kind === 0) p.push(`<circle cx="${f(x + step / 2)}" cy="${f(y + step / 2)}" r="${f(step * (0.12 + r() * 0.24))}" fill="${col}" opacity="${op}"/>`);
      else if (kind === 1) p.push(`<rect x="${f(x + step * 0.22)}" y="${f(y + step * 0.22)}" width="${f(step * 0.56)}" height="${f(step * 0.56)}" fill="${col}" opacity="${op}" transform="rotate(45,${f(x + step / 2)},${f(y + step / 2)})"/>`);
      else if (kind === 2) p.push(`<path d="M ${f(x)} ${f(y + step)} L ${f(x + step / 2)} ${f(y)} L ${f(x + step)} ${f(y + step)}" fill="none" stroke="${col}" stroke-width="${f(step * 0.05)}" opacity="${op}"/>`);
      else if (kind === 3) p.push(`<circle cx="${f(x + step / 2)}" cy="${f(y + step / 2)}" r="${f(step * 0.34)}" fill="none" stroke="${col}" stroke-width="${f(step * 0.045)}" opacity="${op}"/>`);
      else p.push(`<rect x="${f(x)}" y="${f(y + step * 0.62)}" width="${f(step * 0.62)}" height="${f(step * 0.045)}" fill="${col}" opacity="${op}"/>`);
    }
  }
  // 一层暗角，压住四角
  p.push(`<rect width="${w}" height="${h}" fill="none" stroke="#000" stroke-width="${f(Math.min(w, h) * 0.16)}" opacity="0.18"/>`);
  return p.join('');
}

/* ---------------- 名册 ---------------- */

export const TEMPLATES = {
  starfield: { label: '星空', fn: tplStarfield, keys: ['星', '星空', '银河', '宇宙', '夜空', '太空', 'star', 'space', 'galaxy', 'night'] },
  ocean:     { label: '深海', fn: tplOcean,     keys: ['海', '鲸', '鱼', '水', '深蓝', '海浪', 'ocean', 'sea', 'whale', 'fish', 'water'] },
  mountains: { label: '山野', fn: tplMountains, keys: ['山', '峰', '日落', '黄昏', '旷野', '鸟', 'mountain', 'hill', 'sunset', 'peak'] },
  city:      { label: '城市', fn: tplCity,      keys: ['城', '楼', '夜', '街', '都市', '夜景', 'city', 'building', 'skyline'] },
  planet:    { label: '星球', fn: tplPlanet,    keys: ['星球', '行星', '土星', '环', '卫星', 'planet', 'saturn', 'orbit'] },
  waves:     { label: '波纹', fn: tplWaves,     keys: ['波', '线', '流', '抽象', '波纹', 'wave', 'line', 'flow', 'abstract'] },
  pattern:   { label: '图案', fn: tplPattern,   keys: ['图案', '底纹', '几何', '格', '纹理', 'pattern', 'geometric', 'texture'] },
  poster:    { label: '海报', fn: tplPoster,    keys: ['海报', '封面', '标题', '宣传', '卡片', 'poster', 'cover', 'banner', 'title'] },
};

/** 按 prompt 里的词挑模板；挑不到就给星空（最不容易难看） */
export function pickTemplate(prompt) {
  const s = String(prompt || '').toLowerCase();
  let best = null, bestScore = 0;
  for (const [id, t] of Object.entries(TEMPLATES)) {
    let score = 0;
    for (const k of t.keys) if (s.includes(k.toLowerCase())) score += k.length >= 2 ? 2 : 1;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best || 'starfield';
}

/** 按 prompt 里的词挑配色；挑不到就给极光 */
export function pickPalette(prompt) {
  const s = String(prompt || '').toLowerCase();
  const map = [
    ['aurora', ['极光', '清新', '绿', '薄荷', 'aurora', 'mint', 'green']],
    ['midnight', ['午夜', '深蓝', '蓝紫', '紫', 'midnight', 'blue', 'indigo']],
    ['sunset', ['日落', '夕阳', '橙', '暖', '黄昏', 'sunset', 'orange', 'warm']],
    ['candy', ['糖果', '粉', '可爱', '少女', '甜', 'candy', 'pink', 'sweet']],
    ['forest', ['森', '林', '草', '自然', 'forest', 'wood']],
    ['cyber', ['赛博', '霓虹', '科技', '朋克', 'cyber', 'neon', 'tech']],
    ['ocean', ['深海', '海蓝', '水蓝', 'ocean', 'aqua']],
    ['mono', ['素', '白', '灰', '极简', '黑白', 'mono', 'minimal', 'white', 'gray']],
  ];
  for (const [id, keys] of map) {
    for (const k of keys) if (s.includes(k)) return id;
  }
  return 'aurora';
}

/** 从 prompt 里抠标题：引号里的、「标题是X」、「写上X」；抠不到返回空 */
export function extractTitle(prompt) {
  const s = String(prompt || '');
  const quoted = s.match(/[「『"“]([^」』"”]{1,40})[」』"”]/);
  if (quoted) return quoted[1].trim();
  const m = s.match(/(?:标题|大字|写上|写|文字|文案)\s*(?:是|为|:|：)?\s*([^\s,，。;；]{1,40})/);
  if (m && m[1] && !/^[0-9x×]+$/i.test(m[1])) return m[1].trim();
  return '';
}
