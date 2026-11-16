/**
 * 用代码画图（2026-11-15）。
 *
 * 【这文件现在只是个壳】真正的画由 code-draw-canvas.mjs 干：
 * 本地拼一张 HTML（内含 canvas 2D 的完整绘制脚本）→ 本机 Edge/Chrome 无头打开截一张 PNG。
 *
 * 为什么从 SVG 换到 canvas：SVG 拼不出「多层辉光叠加 + 柔光晕 + 星云 + 颗粒噪点」，
 * 主人要的是「小鱼接星星」那个游戏画面级别的精细度，只有 canvas 能做到。
 *
 * 三层兜底：canvas 截图 → 纯 JS 手搓 PNG（没浏览器时）→ 直接给 HTML。
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, unlinkSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { deflateSync } from 'node:zlib';

import { imageDir } from './gen-image.mjs';
import {
  buildDrawHtml, canvasDrawSummary, pickSceneId, pickPaletteId, parseDrawSize,
} from './code-draw-canvas.mjs';
/* 【2026-11-16 晚·把「人物」那条管线接上】
 *
 * 主人让她画鲸鱼娘，结果只出两张渐变背景 + 标题（「鲸鱼娘·黄昏海边」）。
 * 查出来：code-draw-scene.mjs 里人物绘制（CHAR_SCRIPT / parseCharFromPrompt /
 * whalegirl、mermaid、girl…）早就写好了，但**没人引用** —— drawByCode 只走
 * code-draw-canvas 的模板，模板只会画场景和标题。于是「画人物」这件事在
 * 工具层根本不存在，她传什么词都只能得到一张背景。
 *
 * 现在：只要给了 subject，或者 prompt 里出现人物词，就走场景/人物渲染器
 * （buildSceneHtml 会把 CHAR_SCRIPT 拼进 canvas）；否则照旧走模板。
 */
import { buildSceneHtml, parseScenePrompt, parseSceneSize } from './code-draw-scene.mjs';
import { PALETTES, makeRand } from './code-draw-templates.mjs';

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

function findBrowser() {
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  return '';
}

/** 尺寸：认 1280x720、竖版、横版、方形；默认 1024x1024 */
export function parseSize(size) {
  return parseDrawSize(size);
}

/**
 * 把一段完整 HTML 用无头浏览器截成 PNG。成功返回 true。
 * dw/dh 是截图窗口尺寸（已经是 逻辑尺寸 × 超采样倍数）。
 */
function htmlToPngByBrowser(html, dw, dh, outPng) {
  const exe = findBrowser();
  if (!exe) return Promise.resolve(false);

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const htmlPath = join(tmpdir(), 'fishdraw-' + stamp + '.html');
  const prof = join(tmpdir(), 'fishdraw-prof-' + stamp);
  try {
    writeFileSync(htmlPath, html, 'utf8');
  } catch {
    return Promise.resolve(false);
  }

  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--disable-extensions',
    '--user-data-dir=' + prof,
    '--window-size=' + Math.round(dw) + ',' + Math.round(dh),
    '--force-device-scale-factor=1',
    '--screenshot=' + outPng,
    'file:///' + htmlPath.replace(/\\/g, '/'),
  ];

  return new Promise((resolve) => {
    let done = false;
    let child;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { unlinkSync(htmlPath); } catch {}
      resolve(ok && existsSync(outPng));
    };
    try {
      child = execFile(exe, args, { timeout: 40000, windowsHide: true }, () => {
        finish(existsSync(outPng));
      });
    } catch { return finish(false); }
    setTimeout(() => { try { child && child.kill(); } catch {} finish(existsSync(outPng)); }, 36000);
  });
}

/* ---------------- 兜底：纯 JS 手搓 PNG（没有浏览器时也有图） ---------------- */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** 把 rgb 像素数组编成 PNG 文件 */
export function encodePng(width, height, rgb) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgb.copy ? rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
             : Buffer.from(rgb.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function hex2rgb(hex) {
  const s = String(hex).replace('#', '');
  const v = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
  return [parseInt(v.slice(0, 2), 16) || 0, parseInt(v.slice(2, 4), 16) || 0, parseInt(v.slice(4, 6), 16) || 0];
}

/** 兜底画法：竖直渐变 + 星点 + 一道波纹。不精致，但保证有画面。 */
export function fallbackPng(w, h, pal, seed) {
  const rand = makeRand(seed || 7);
  const c0 = hex2rgb(pal.bg[0]), c1 = hex2rgb(pal.bg[pal.bg.length - 1]);
  const px = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    const t = y / h;
    const r0 = Math.round(c0[0] + (c1[0] - c0[0]) * t);
    const g0 = Math.round(c0[1] + (c1[1] - c0[1]) * t);
    const b0 = Math.round(c0[2] + (c1[2] - c0[2]) * t);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      px[i] = r0; px[i + 1] = g0; px[i + 2] = b0;
    }
  }
  const dot = (cx, cy, rad, col, alpha) => {
    const x0 = Math.max(0, Math.floor(cx - rad)), x1 = Math.min(w - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad)), y1 = Math.min(h - 1, Math.ceil(cy + rad));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d > rad) continue;
        const a = alpha * Math.min(1, (rad - d) / Math.max(1, rad * 0.5));
        const i = (y * w + x) * 3;
        px[i] = Math.round(px[i] * (1 - a) + col[0] * a);
        px[i + 1] = Math.round(px[i + 1] * (1 - a) + col[1] * a);
        px[i + 2] = Math.round(px[i + 2] * (1 - a) + col[2] * a);
      }
    }
  };
  const ac = hex2rgb(pal.a), bc = hex2rgb(pal.b), cc = hex2rgb(pal.c);
  for (let i = 0; i < Math.round(w * h / 3000); i++) {
    dot(rand() * w, rand() * h, 0.6 + Math.pow(rand(), 3) * 2.6, i % 9 === 0 ? cc : (i % 3 ? ac : bc), 0.35 + rand() * 0.55);
  }
  // 底部的波
  for (let x = 0; x < w; x++) {
    const base = h * 0.78 + Math.sin((x / w) * Math.PI * 3) * h * 0.05;
    for (let y = Math.max(0, Math.floor(base)); y < h; y++) {
      const i = (y * w + x) * 3;
      const t2 = (y - base) / Math.max(1, h - base);
      const a = 0.35 + t2 * 0.5;
      px[i] = Math.round(px[i] * (1 - a) + ac[0] * a);
      px[i + 1] = Math.round(px[i + 1] * (1 - a) + ac[1] * a);
      px[i + 2] = Math.round(px[i + 2] * (1 - a) + ac[2] * a);
    }
  }
  return encodePng(w, h, px);
}


/** 老的对外名，别处 import buildSvg 也不会挂 */
export const buildSvg = buildDrawHtml;

/* 画人物/生物的意图词 —— 命中就走 scene+char 渲染器。
 * 光靠模板永远画不出角色，所以这一条必须自己认，不能等调用方记得传 subject。 */
const CHAR_HINT = /鲸鱼娘|人鱼|少女|女孩|男孩|猫娘|猫耳|兽耳|角色|人物|立绘|Q版|q版|chibi|whalegirl|mermaid|\bgirl\b|\bboy\b|\bcat\b|\bdog\b|\bfox\b|\brabbit\b/i;
function wantsCharacter(opt = {}) {
  const subj = String(opt.subject || '').trim();
  if (subj) return true;
  return CHAR_HINT.test(String(opt.prompt || ''));
}

export async function drawByCode(opt = {}) {
  const t0 = Date.now();
  const prompt = String(opt.prompt || '').trim();
  if (!prompt) return { ok: false, error: '要画什么？prompt 是空的' };

  /* 人物 → scene 渲染器；纯风景 → 模板渲染器（两条路都产出 HTML，再统一截图） */
  let built;
  if (wantsCharacter(opt)) {
    const { w, h } = parseSceneSize(opt.size);
    const scale = 2;
    const parsed = parseScenePrompt(prompt, opt.template, opt.palette);
    built = {
      html: buildSceneHtml({ ...opt, prompt, scale }),
      w, h, scale,
      tplId: 'scene:' + (parsed.scene || 'mountain'),
      palId: parsed.palette,
      title: String(opt.title || '').trim(),
      subject: String(opt.subject || '').trim() || parsed.subject || '',
      char: true,
    };
  } else {
    built = buildDrawHtml({ ...opt, prompt });
  }
  mkdirSync(imageDir(), { recursive: true });
  const hash = createHash('sha1').update(built.html).digest('hex').slice(0, 10);
  const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
  const base = join(imageDir(), `code-${stamp}-${hash}`);

  const pngPath = base + '.png';
  /* 【2026-11-16 晚·人物图黑边】scene 渲染器把 canvas 的 width 属性设成 W*SCL，CSS 尺寸却只有 W；
   * 截图按 W*SCL 开视口，画布只占左上角一半，右边和下边全是黑 —— 主人那张「鲸鱼娘·黄昏海边」
   * 一半黑就是这么来的。人物路径按 CSS 尺寸截，画面铺满。 */
  const shotW = built.char ? built.w : built.w * built.scale;
  const shotH = built.char ? built.h : built.h * built.scale;
  const okPng = await htmlToPngByBrowser(built.html, shotW, shotH, pngPath);
  if (okPng) {
    let bytes = 0;
    try { bytes = readFileSync(pngPath).length; } catch {}
    return {
      ok: true, path: pngPath, bytes, width: shotW, height: shotH,
      ms: Date.now() - t0, engine: 'canvas+browser',
      template: built.tplId, palette: built.palId, title: built.title,
      subject: built.subject || '',
    };
  }

  // 没有浏览器 / 截不出来 → 手搓 PNG 兜底（只保证有图，不算精细）
  try {
    const buf = fallbackPng(built.w, built.h, PALETTES[built.palId], built.seed);
    writeFileSync(pngPath, buf);
    return {
      ok: true, path: pngPath, bytes: buf.length, width: built.w, height: built.h,
      ms: Date.now() - t0, engine: 'pure-js',
      template: built.tplId, palette: built.palId, title: built.title,
      warn: '没找到浏览器，用了简化画法',
    };
  } catch (e) {
    // 最后底牌：把 HTML 本身交出去（浏览器也能直接开，canvas 会自己画）
    const htmlPath = base + '.html';
    writeFileSync(htmlPath, built.html, 'utf8');
    return {
      ok: true, path: htmlPath, bytes: built.html.length, width: built.w, height: built.h,
      ms: Date.now() - t0, engine: 'html-only',
      template: built.tplId, palette: built.palId, title: built.title,
      warn: 'PNG 没生成成功，给的是 HTML：' + String(e && e.message || e),
    };
  }
}

/** 给插件面板 / 工具描述用的一句话说明 */
export function codeDrawSummary() {
  const s = canvasDrawSummary();
  return {
    templates: s.templates,
    palettes: s.palettes,
    browser: findBrowser() ? 'edge/chrome headless' : 'none（走简化画法）',
    renderer: 'canvas 2d · 超采样 x' + s.supersample,
  };
}
