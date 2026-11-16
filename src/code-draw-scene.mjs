/**
 * 「通用场景合成器」—— canvas 场景合成核心（2026-11-15）
 *
 * 跟 code-draw-canvas.mjs 的差别：那边是 8 个写死的场景模板，靠关键词选模板；
 * 这边是把 prompt 拆成【主体 + 场景 + 时间 + 天气 + 色调】，用一套图形词汇库现画：
 *   时间 → 天空的多段渐变 / 太阳月亮位置 / 环境光与雾的色温
 *   天气 → 云层、雨丝、雪点、雾带、闪电
 *   场景 → 地平线 + 霞光 + 2~4 层远景（越远越淡越偏环境色，即景深）+ 地面/水面材质
 *   主体 → 太阳/月亮/鲸鱼/鸟群/船/大树/房子/人剪影/骆驼/鱼/热气球
 * 通用质感：暗角、颗粒、辉光、星空（多层疏密）、星云/极光。
 *
 * 对外：
 *   buildSceneHtml(opt)  → 一整个 HTML 字符串（带 <canvas id="cv">），跟 buildDrawHtml 用法一致
 *   sceneVocab()         → 词库目录，给插件面板展示
 *
 * 约束：只用 canvas 2D API；不引外图、不 fetch；所有随机走同一个 seeded RNG，
 *      同 prompt + 同 seed 必出同一张图。
 */

import { PALETTES } from './code-draw-templates.mjs';
import { CHAR_SCRIPT, parseCharFromPrompt } from './code-draw-chars.mjs';
import { actorScript } from './code-draw-actor.mjs';

/* ════════════════════════ 1. 图形词汇库 ════════════════════════ */

/** 主体（可无）。k 是 prompt 关键词，命中即选，长的排前面先匹配。 */
const SUBJECTS = [
  { id: 'whalegirl', label: '鲸鱼娘', k: ['鲸鱼娘', '鲸尾少女', 'whalegirl'] },
  { id: 'mermaid', label: '人鱼', k: ['人鱼', '美人鱼', 'mermaid'] },
  { id: 'balloon', label: '热气球', k: ['热气球', '气球', 'balloon'] },
  { id: 'camel', label: '骆驼', k: ['骆驼', '驼队', '驼', 'camel'] },
  { id: 'whale', label: '鲸鱼', k: ['鲸鱼', '鲸', 'whale'] },
  { id: 'moon', label: '月亮', k: ['月亮', '圆月', '明月', '月球', 'moon'] },
  { id: 'sun', label: '太阳', k: ['太阳', '朝阳', '旭日', '烈日', 'sun'] },
  { id: 'house', label: '房子', k: ['木屋', '小屋', '茅屋', '房子', '房屋', '小木屋', '别墅', 'house', 'cabin'] },
  { id: 'tree', label: '大树', k: ['大树', '树', '老树', '枯树', 'tree'] },
  { id: 'bird', label: '鸟群', k: ['鸟群', '一群鸟', '飞鸟', '鸟', '雁', '海鸥', '鹰', '鹤', 'bird'] },
  { id: 'boat', label: '船', k: ['小船', '帆船', '渔船', '木船', '船', '孤舟', '舟', 'boat', 'sail'] },
  { id: 'fish', label: '鱼', k: ['鱼群', '鱼', 'fish'] },

  { id: 'girl', label: '女孩', k: ['少女', '女孩', 'girl'] },
  { id: 'boy', label: '男孩', k: ['少年', '男孩', 'boy'] },
  { id: 'cat', label: '猫', k: ['小猫', '猫咪', '猫', 'cat'] },
  { id: 'dog', label: '狗', k: ['小狗', '狗', 'dog'] },
  { id: 'fox', label: '狐狸', k: ['狐狸', 'fox'] },
  { id: 'rabbit', label: '兔', k: ['兔子', '兔', 'rabbit'] },
  { id: 'bird', label: '小鸟', k: ['小鸟', 'bird'] },
  { id: 'person', label: '人剪影', k: ['人剪影', '人影', '一个人', '行人', '背影', '人', 'person', 'silhouette'] },
];

/** 场景（选一个主场景）。 */
const SCENES = [
  { id: 'space', label: '太空', k: ['太空', '宇宙', '银河', '星河', '星云', '星球', '外星', '星空', 'space', 'galaxy'] },
  { id: 'city', label: '城市', k: ['城市', '都市', '霓虹', '街道', '高楼', '楼群', '赛博', '街', '城镇', 'city', 'cyber', 'street'] },
  { id: 'sea', label: '海', k: ['海边', '海洋', '大海', '海滩', '海面', '海上', '海岛', '海', 'sea', 'ocean', 'beach'] },
  { id: 'lake', label: '湖', k: ['湖泊', '湖畔', '湖边', '池塘', '湖水', '湖', 'lake'] },
  { id: 'mountain', label: '山', k: ['雪山', '山脉', '高山', '山峰', '山顶', '悬崖', '山谷', '群山', '山脚下', '山谷', '山', 'mountain', 'peak'] },
  { id: 'forest', label: '森林', k: ['森林', '树林', '丛林', '林间', '林子里', '林子', 'forest', 'woods'] },
  { id: 'desert', label: '沙漠', k: ['沙漠', '戈壁', '荒漠', '沙丘', '黄沙', 'desert', 'dune'] },
  { id: 'field', label: '田野', k: ['田野', '稻田', '麦田', '农田', '庄稼', '梯田', 'field', 'farm'] },
  { id: 'grass', label: '草原', k: ['草原', '草地', '平原', '原野', '牧', '草甸', 'grass', 'meadow', 'prairie'] },
];

/** 时间。 */
const TIMES = [
  { id: 'polar', label: '极光夜', k: ['极光', '北极光', '极夜', '北极村', 'aurora'] },
  { id: 'dawn', label: '黎明', k: ['黎明', '清晨', '破晓', '日出', '晨曦', '拂晓', '早晨', '早上', 'dawn', 'sunrise'] },
  { id: 'dusk', label: '黄昏', k: ['黄昏', '傍晚', '夕阳', '落日', '日落', '暮色', '斜阳', '黄昏时分', 'dusk', 'sunset'] },
  { id: 'night', label: '夜晚', k: ['夜晚', '深夜', '半夜', '夜空', '夜色', '午夜', '月夜', '星夜', '夜', 'night', 'midnight'] },
  { id: 'day', label: '白天', k: ['白天', '正午', '中午', '午后', '中午', '晴朗', '阳光', '夏日', '春天', '秋日', '午后', 'day', 'noon'] },
];

/** 天气。 */
const WEATHERS = [
  { id: 'storm', label: '雷雨', k: ['雷雨', '雷电', '闪电', '雷暴', '暴风', '风暴', '台风', 'storm', 'thunder'] },
  { id: 'rain', label: '雨', k: ['暴雨', '下雨', '小雨', '大雨', '雨丝', '雨夜', '雨中', '雨', 'rain'] },
  { id: 'snow', label: '雪', k: ['下雪', '大雪', '小雪', '雪花', '雪天', '雪后', '冬天', '冬日', '寒冬', '冰', '雪', 'snow', 'winter'] },
  { id: 'fog', label: '雾', k: ['薄雾', '晨雾', '雾气', '浓雾', '大雾', '雾', '烟雨', 'fog', 'mist'] },
  { id: 'cloudy', label: '多云', k: ['多云', '阴天', '乌云', '云层', '云朵', '白云', '云', 'cloudy', 'cloud'] },
];

/** 配色关键词（跟 code-draw-templates 的 id 对齐）。 */
const PAL_KEYS = {
  cyber: ['赛博', '霓虹', 'cyber', 'punk', '街道', '机械'],
  aurora: ['极光', '北极', '绿光', 'aurora'],
  ocean: ['海', '湖', '水', '鲸', '波浪', 'ocean', 'sea'],
  forest: ['森林', '树', '草', '田', '林', 'forest', 'grass'],
  sunset: ['黄昏', '日落', '夕阳', '沙漠', '骆驼', '落日', 'sunset', 'desert'],
  midnight: ['夜', '星', '太空', '宇宙', '月', '银河', 'night', 'space'],
  mono: ['雪', '冬', '雾', '冰', '素', 'snow', 'winter', 'mono'],
  candy: ['糖果', '梦幻', '粉', 'candy', 'pink'],
};

/* ════════════════════════ 2. 解析 ════════════════════════ */

function hit(list, text) {
  const p = String(text || '').toLowerCase();
  for (const item of list) {
    for (const k of item.k) {
      if (p.indexOf(String(k).toLowerCase()) >= 0) return item.id;
    }
  }
  return '';
}

/**
 * 从 prompt 里解析出场景 / 时间 / 天气 / 主体 / 配色。
 * 显式传进来的 template / palette 优先。
 */
export function parseScenePrompt(prompt, template, palette) {
  const p = String(prompt || '');
  let scene = hit(SCENES, p);
  let time = hit(TIMES, p);
  let weather = hit(WEATHERS, p);
  const subject = hit(SUBJECTS, p) || '';

  // 显式给的模板名只要在本词汇库里就认
  if (template && SCENES.some((s) => s.id === template)) scene = template;

  // 兜底：没有场景就看主体猜一个
  if (!scene) {
    if (subject === 'whale' || subject === 'boat' || subject === 'fish') scene = 'sea';
    else if (subject === 'camel') scene = 'desert';
    else if (subject === 'house' || subject === 'tree') scene = 'forest';
    else scene = 'mountain';
  }
  // 时间是极光就一定是夜景；太空也当夜里
  if (!time) {
    if (scene === 'space' || scene === 'city' && /霓虹|霓/.test(p)) time = 'night';
    else time = scene === 'space' ? 'night' : 'day';
  }
  if (!weather) {
    if (time === 'polar') weather = 'clear';
    else weather = 'clear';
  }

  let pal = palette && PALETTES[palette] ? palette : '';
  if (!pal) {
    const low = p.toLowerCase();
    for (const [id, keys] of Object.entries(PAL_KEYS)) {
      if (keys.some((k) => low.indexOf(String(k).toLowerCase()) >= 0)) { pal = id; break; }
    }
  }
  if (!pal) pal = time === 'night' || scene === 'space' ? 'midnight' : (time === 'dusk' ? 'sunset' : 'aurora');

  return { subject, scene, time, weather, palette: pal };
}

export function parseSceneSize(size) {
  const s = String(size || '').trim().toLowerCase();
  const m = s.match(/(\d{2,5})\s*[x×*]\s*(\d{2,5})/);
  if (m) {
    return { w: Math.max(120, Math.min(4096, parseInt(m[1], 10))), h: Math.max(120, Math.min(4096, parseInt(m[2], 10))) };
  }
  if (/竖|portrait|tall|9:16/.test(s)) return { w: 768, h: 1360 };
  if (/横|landscape|wide|16:9/.test(s)) return { w: 1280, h: 720 };
  return { w: 1024, h: 1024 };
}

function seedOf(prompt, seed) {
  let h = 2166136261 >>> 0;
  if (seed != null && String(seed).length) {
    const t = String(seed);
    for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619); }
    if (/^\d+$/.test(t)) h = (h ^ (parseInt(t, 10) >>> 0)) >>> 0;
    return Math.abs(h) || 1;
  }
  const s = String(prompt || 'scene');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h) || 1;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function titleOf(prompt) {
  const t = String(prompt || '').replace(/^[#\s]+/, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t.length > 26 ? t.slice(0, 26) + '…' : t;
}

/* ════════════════════════ 3. 绘制脚本（浏览器里跑） ════════════════════════ */

const CLIENT_SCRIPT = String.raw`
(function () {
  'use strict';
  var W = __W__, H = __H__, SCL = __S__;
  var PAL = __PAL__, OPT = __OPT__;
  /*__CHAR_SCRIPT__*/
  var cv = document.getElementById('cv');
  cv.width = Math.round(W * SCL);
  cv.height = Math.round(H * SCL);
  cv.style.width = W + 'px';
  cv.style.height = H + 'px';
  var ctx = cv.getContext('2d');
  ctx.scale(SCL, SCL);

  /* ─────── 种子随机：全程只用它，保证同 prompt 同图 ─────── */
  var _s = (OPT.seed >>> 0) || 12345;
  function rnd() {
    _s ^= _s << 13; _s >>>= 0;
    _s ^= _s >>> 17;
    _s ^= _s << 5; _s >>>= 0;
    return _s / 4294967296;
  }
  function rr(a, b) { return a + (b - a) * rnd(); }
  function ri(a, b) { return Math.floor(a + (b - a + 1) * rnd()); }
  function chance(p) { return rnd() < p; }

  /* ─────── 颜色工具：一律从 PAL 派生 ─────── */
  var P0 = PAL.bg[0], P1 = PAL.bg[1], P2 = PAL.bg[2];
  function h2r(c) {
    var s = String(c || '#888888').replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    var n = parseInt(s, 16);
    if (isNaN(n)) n = 0x888888;
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function r2h(r, g, b) {
    var v = (1 << 24) + (Math.round(r) << 16) + (Math.round(g) << 8) + Math.round(b);
    return '#' + v.toString(16).slice(1);
  }
  function mix(c1, c2, t) {
    var a = h2r(c1), b = h2r(c2);
    return r2h(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
  }
  function lit(c, t) { return mix(c, '#ffffff', t); }
  function dk(c, t) { return mix(c, '#000000', t); }
  function A(c, a) { var p = h2r(c); return 'rgba(' + p[0] + ',' + p[1] + ',' + p[2] + ',' + a + ')'; }
  function lum(c) { var p = h2r(c); return (p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114) / 255; }
  var LIGHT = lum(P2) > 0.6;
  var INKC = LIGHT ? dk(P0, 0.55) : lit(PAL.ink, 0.25);

  /* ═════════ 时间配置：天空多段配色 / 日月位置 / 环境光 / 雾色温 ═════════ */
  var T = OPT.time || 'day';
  var WEA = OPT.weather || 'clear';
  var SC = OPT.scene || 'mountain';
  var SUBJ = OPT.subject || '';

  var LK = (function () {
    var o = {};
    if (T === 'dawn') {
      o.top = mix(P0, PAL.b, 0.30);
      o.mid = mix(P1, PAL.b, 0.34);
      o.low = mix(P2, PAL.c, 0.38);
      o.hz = mix(PAL.c, PAL.ink, 0.42);
      o.sunY = 0.605; o.sunR = 0.050; o.sunCol = lit(PAL.c, 0.32);
      o.stars = 0.30; o.amb = 0.66; o.kind = 'sun';
    } else if (T === 'dusk') {
      o.top = mix(P0, PAL.a, 0.16);
      o.mid = mix(P1, PAL.a, 0.42);
      o.low = mix(P2, PAL.c, 0.52);
      o.hz = mix(PAL.c, PAL.a, 0.38);
      o.sunY = 0.545; o.sunR = 0.058; o.sunCol = lit(PAL.c, 0.28);
      o.stars = 0.20; o.amb = 0.52; o.kind = 'sun';
    } else if (T === 'night') {
      o.top = dk(P0, 0.42);
      o.mid = dk(P1, 0.40);
      o.low = mix(P2, PAL.b, 0.28);
      o.hz = mix(P2, PAL.b, 0.50);
      o.sunY = 0.245; o.sunR = 0.046; o.sunCol = lit(PAL.ink, 0.55);
      o.stars = 1.0; o.amb = 0.34; o.kind = 'moon';
    } else if (T === 'polar') {
      o.top = dk(P0, 0.38);
      o.mid = dk(P1, 0.26);
      o.low = mix(P2, PAL.a, 0.34);
      o.hz = mix(PAL.a, PAL.b, 0.45);
      o.sunY = 0.30; o.sunR = 0.038; o.sunCol = lit(PAL.ink, 0.5);
      o.stars = 0.92; o.amb = 0.40; o.kind = 'moon';
    } else {
      o.top = lit(mix(P1, PAL.b, 0.55), 0.20);
      o.mid = lit(mix(P2, PAL.b, 0.40), 0.34);
      o.low = lit(mix(P2, PAL.c, 0.26), 0.52);
      o.hz = lit(mix(PAL.c, PAL.ink, 0.42), 0.50);
      o.sunY = 0.155; o.sunR = 0.040; o.sunCol = lit(PAL.c, 0.55);
      o.stars = 0.0; o.amb = 1.0; o.kind = 'sun';
    }
    // 环境雾色 = 地平线色往 ink 淡一点，远处一切往它身上靠（景深）
    o.haze = mix(o.hz, PAL.ink, 0.30);
    o.deep = mix(mix(P0, P1, 0.5), '#000000', 0.25);
    if (T === 'day') o.haze = lit(o.hz, 0.35);
    return o;
  })();

  /* 景深：越远越淡、越偏环境色 */
  function depth(c, d) { return mix(c, LK.haze, Math.max(0, Math.min(1, d))); }

  /* ─────── 画布辅助 ─────── */
  function vg(y0, y1, stops) {
    var g = ctx.createLinearGradient(0, y0, 0, y1);
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  }
  function rg(x, y, r, stops) {
    var g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(0.6, r));
    for (var i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    return g;
  }
  /* 柔光椭圆（所有云/辉光/烟的基础笔刷） */
  function blob(x, y, rx, ry, col, a) {
    if (rx <= 0 || ry <= 0) return;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1, Math.max(0.05, ry / rx));
    ctx.fillStyle = rg(0, 0, rx, [[0, A(col, a)], [0.55, A(col, a * 0.45)], [1, A(col, 0)]]);
    ctx.beginPath();
    ctx.arc(0, 0, rx, 0, 6.2832);
    ctx.fill();
    ctx.restore();
  }
  /* 辉光登记 + 叠加（bloom 用） */
  var GLOWS = [];
  function glow(x, y, r, col, a, keep) {
    blob(x, y, r, r, col, a);
    if (keep !== false) GLOWS.push({ x: x, y: y, r: r, c: col, a: a });
  }

  /* 地形/山脊：平滑随机曲线，fill 到画布底 */
  function ridgePts(baseY, amp, segs, jag) {
    var ph = [], k;
    for (k = 0; k <= segs; k++) ph.push(rr(-0.30, 1.0));
    var n = 180, pts = [], i;
    for (i = 0; i <= n; i++) {
      var u = i / n, t = u * segs, i0 = Math.floor(t), i1 = Math.min(segs, i0 + 1), fr = t - i0;
      var sm = 0.5 - 0.5 * Math.cos(fr * Math.PI);
      var hgt = ph[i0] * (1 - sm) + ph[i1] * sm;
      if (jag) hgt += jag * Math.abs(Math.sin(u * segs * 3.1 + i0 * 1.7)) * (0.4 + 0.6 * rnd());
      pts.push([u * W, baseY - amp * Math.max(0, hgt)]);
    }
    return pts;
  }
  function fillRidge(pts, cTop, cBot, yTop, yBot, alpha) {
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.lineTo(W + 4, H + 4);
    ctx.lineTo(-4, H + 4);
    ctx.closePath();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.fillStyle = vg(yTop, yBot, [[0, cTop], [1, cBot]]);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  function rimStroke(pts, col, a, w) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.strokeStyle = A(col, a);
    ctx.lineWidth = w || 1.4;
    ctx.stroke();
    ctx.restore();
  }

  /* ═════════ 地平线高度（各场景不一样） ═════════ */
  var GY = (function () {
    var t = 0.62;
    if (SC === 'sea') t = 0.565;
    else if (SC === 'lake') t = 0.585;
    else if (SC === 'mountain') t = 0.655;
    else if (SC === 'forest') t = 0.680;
    else if (SC === 'grass') t = 0.615;
    else if (SC === 'desert') t = 0.600;
    else if (SC === 'city') t = 0.700;
    else if (SC === 'field') t = 0.640;
    else if (SC === 'space') t = 0.78;
    // 竖版把地平线抬一点，别把天压得太扁
    if (H > W * 1.15) t -= 0.05;
    return H * t;
  })();

  /* ═════════ 1. 天空底 ═════════ */
  function sky() {
    var top = LK.top, mid = LK.mid, low = LK.low, hz = LK.hz;
    if (SC === 'space') {
      top = dk(P0, 0.62); mid = dk(mix(P1, PAL.b, 0.35), 0.45); low = mix(P0, PAL.b, 0.16); hz = mix(P0, PAL.b, 0.22);
    }
    ctx.fillStyle = vg(0, H, [
      [0, top], [0.34, mid], [0.70, low], [1, hz],
    ]);
    ctx.fillRect(0, 0, W, H);

    // 高空一层薄薄的色温带，压出空气感
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = vg(0, H * 0.6, [[0, A(PAL.b, 0.10)], [1, A(PAL.b, 0)]]);
    ctx.fillRect(0, 0, W, H * 0.6);
    ctx.restore();
  }

  /* ═════════ 2. 星云 / 极光 ═════════ */
  function nebula(strength) {
    var n = Math.max(2, Math.round(4 + 4 * strength));
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < n; i++) {
      var cx = rr(0.08, 0.92) * W;
      var cy = rr(0.05, 0.58) * H;
      var r = rr(0.16, 0.44) * Math.min(W, H) * (0.7 + 0.6 * strength);
      var col = [PAL.a, PAL.b, PAL.c, lit(PAL.a, 0.3)][i % 4];
      blob(cx, cy, r, r * rr(0.45, 0.85), col, 0.10 * strength + 0.03);
      blob(cx + r * rr(-0.3, 0.3), cy + r * rr(-0.2, 0.2), r * 0.55, r * rr(0.3, 0.6), lit(col, 0.25), 0.07 * strength);
    }
    // 银河带
    if (SC === 'space' || T === 'polar') {
      ctx.save();
      ctx.translate(W * 0.5, H * 0.36);
      ctx.rotate(rr(-0.5, -0.15));
      for (var k = 0; k < 26; k++) {
        var t = k / 25 - 0.5;
        blob(t * W * 1.25, rr(-1, 1) * H * 0.03, W * rr(0.10, 0.20), H * rr(0.02, 0.05), lit(PAL.ink, 0.2), 0.055);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  function aurora() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var bands = 5;
    for (var b = 0; b < bands; b++) {
      var baseY = H * rr(0.16, 0.42);
      var amp = H * rr(0.03, 0.10);
      var col = [PAL.a, PAL.b, lit(PAL.a, 0.25), PAL.c][b % 4];
      var phase = rr(0, 6.28);
      for (var pass = 0; pass < 3; pass++) {
        ctx.beginPath();
        for (var x = -10; x <= W + 10; x += 6) {
          var u = x / W;
          var y = baseY + Math.sin(u * 6.2 + phase) * amp + Math.sin(u * 13.7 + phase * 2) * amp * 0.35;
          if (x === -10) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = A(col, 0.05 + pass * 0.035);
        ctx.lineWidth = (14 - pass * 4) * (H / 720);
        ctx.stroke();
        // 向下拖的帘幕
        ctx.beginPath();
        for (var x2 = -10; x2 <= W + 10; x2 += 8) {
          var u2 = x2 / W;
          var y2 = baseY + Math.sin(u2 * 6.2 + phase) * amp + Math.sin(u2 * 13.7 + phase * 2) * amp * 0.35;
          var len = (0.06 + 0.10 * Math.abs(Math.sin(u2 * 9 + phase))) * H;
          ctx.moveTo(x2, y2);
          ctx.lineTo(x2 + rr(-2, 2), y2 + len);
        }
        ctx.strokeStyle = A(col, 0.035 + pass * 0.02);
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      glow(W * rr(0.2, 0.8), baseY, Math.min(W, H) * 0.16, col, 0.10);
    }
    ctx.restore();
  }

  /* ═════════ 3. 星星（多层不同大小亮度，疏密做闪烁感） ═════════ */
  function stars(power) {
    if (power <= 0.02) return;
    var area = (W * H) / 1000;
    var layers = [
      { n: Math.round(area * 0.30), r: [0.5, 1.0], a: [0.25, 0.6], col: lit(PAL.ink, 0.35) },
      { n: Math.round(area * 0.12), r: [0.9, 1.6], a: [0.4, 0.85], col: PAL.ink },
      { n: Math.round(area * 0.035), r: [1.5, 2.6], a: [0.55, 1.0], col: lit(PAL.a, 0.45) },
    ];
    var starCol = LIGHT ? dk(P0, 0.25) : null;
    for (var L = 0; L < layers.length; L++) {
      var ly = layers[L];
      for (var i = 0; i < ly.n; i++) {
        var x = rr(0, W), y = rr(0, GY * (L === 2 ? 1.0 : 0.96));
        // 疏密：靠近银河/上方更密
        if (rnd() > 0.35 + 0.65 * (1 - y / GY)) { if (rnd() < 0.55) continue; }
        var r = rr(ly.r[0], ly.r[1]);
        var a = rr(ly.a[0], ly.a[1]) * Math.min(1, power);
        var c = starCol || ly.col;
        if (chance(0.26)) {           // 大气闪烁：同颗星画两圈，一大一小
          blob(x, y, r * 3.2, r * 3.2, c, a * 0.20);
        }
        ctx.fillStyle = A(c, a);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, 6.2832);
        ctx.fill();
        if (L === 2) {
          // 亮星十字芒
          ctx.strokeStyle = A(c, a * 0.5);
          ctx.lineWidth = 0.8;
          ctx.beginPath();
          ctx.moveTo(x - r * 3.4, y); ctx.lineTo(x + r * 3.4, y);
          ctx.moveTo(x, y - r * 3.4); ctx.lineTo(x, y + r * 3.4);
          ctx.stroke();
        }
      }
    }
  }

  /* ═════════ 4. 太阳 / 月亮 ═════════ */
  function disc(x, y, r, col, kind) {
    // 大气辉光
    glow(x, y, r * (kind === 'moon' ? 7 : 11), col, kind === 'moon' ? 0.22 : 0.30);
    glow(x, y, r * 3.2, lit(col, 0.4), 0.45);
    // 本体
    ctx.save();
    ctx.fillStyle = rg(x, y, r * 1.15, [[0, lit(col, 0.75)], [0.78, col], [1, A(col, 0.75)]]);
    ctx.beginPath(); ctx.arc(x, y, r, 0, 6.2832); ctx.fill();
    if (kind === 'moon') {
      // 月面暗斑
      var k;
      for (k = 0; k < 7; k++) {
        var ang = rr(0, 6.28), dd = rr(0, r * 0.72);
        blob(x + Math.cos(ang) * dd, y + Math.sin(ang) * dd, r * rr(0.10, 0.30), r * rr(0.10, 0.28), dk(col, 0.35), 0.22);
      }
      // 月晕环
      ctx.strokeStyle = A(lit(col, 0.5), 0.18);
      ctx.lineWidth = Math.max(1, r * 0.16);
      ctx.beginPath(); ctx.arc(x, y, r * 2.5, 0, 6.2832); ctx.stroke();
    } else {
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < 20; i++) {
        var a2 = (i / 20) * 6.2832 + rr(-0.1, 0.1);
        var l = r * rr(1.5, 4.2);
        ctx.strokeStyle = A(lit(col, 0.5), rr(0.05, 0.14));
        ctx.lineWidth = rr(1, r * 0.35);
        ctx.beginPath();
        ctx.moveTo(x + Math.cos(a2) * r * 1.25, y + Math.sin(a2) * r * 1.25);
        ctx.lineTo(x + Math.cos(a2) * l, y + Math.sin(a2) * l);
        ctx.stroke();
      }
    }
    ctx.restore();
  }
  var SUNX = W * (chance(0.5) ? rr(0.18, 0.34) : rr(0.66, 0.84));
  var SUNY = H * LK.sunY;
  var SUNR = Math.min(W, H) * LK.sunR;
  function sunMoon() {
    disc(SUNX, SUNY, SUNR, LK.sunCol, LK.kind);
  }

  /* ═════════ 5. 云（多层柔光椭圆叠加） ═════════ */
  function clouds() {
    var dense = WEA === 'cloudy' ? 1.0 : (WEA === 'rain' || WEA === 'storm') ? 1.25 : 0.45;
    if (WEA === 'fog' || WEA === 'snow') dense = Math.max(dense, 0.7);
    var clusterN = Math.round(2 + 7 * dense);
    var baseCol = (WEA === 'rain' || WEA === 'storm')
      ? mix(dk(P1, 0.25), PAL.b, 0.25)
      : mix(PAL.ink, LK.haze, 0.45);
    for (var c = 0; c < clusterN; c++) {
      var cx = rr(-0.08, 1.08) * W;
      var cy = rr(0.05, 0.42) * H;
      var cw = rr(0.12, 0.34) * W;
      var puffs = ri(5, 11);
      var a0 = (WEA === 'clear') ? rr(0.10, 0.20) : rr(0.16, 0.30);
      for (var i = 0; i < puffs; i++) {
        var px = cx + rr(-1, 1) * cw * 0.55;
        var py = cy + rr(-0.35, 0.35) * cw * 0.28;
        var pr = cw * rr(0.16, 0.42);
        // 底部暗、顶部亮，做出体积
        blob(px, py + pr * 0.25, pr, pr * rr(0.30, 0.55), mix(baseCol, dk(P0, 0.3), 0.35), a0 * 0.7);
        blob(px, py - pr * 0.15, pr * 0.85, pr * rr(0.28, 0.5), lit(baseCol, 0.45), a0 * 0.8);
      }
    }
  }

  /* ═════════ 6. 天与地交界处的霞光 ═════════ */
  function horizonGlow() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = vg(GY - H * 0.34, GY + H * 0.03, [
      [0, A(LK.hz, 0)],
      [0.60, A(LK.hz, 0.16)],
      [0.88, A(LK.hz, 0.34)],
      [1, A(lit(LK.hz, 0.3), 0.46)],
    ]);
    ctx.fillRect(0, GY - H * 0.34, W, H * 0.37);
    // 地平线上一条极亮的细带
    ctx.fillStyle = vg(GY - H * 0.012, GY + H * 0.012, [[0, A(lit(LK.hz, 0.5), 0)], [0.5, A(lit(LK.hz, 0.55), 0.40)], [1, A(lit(LK.hz, 0.5), 0)]]);
    ctx.fillRect(0, GY - H * 0.012, W, H * 0.024);
    ctx.restore();
  }

  /* ═════════ 7. 场景 ═════════ */
  function groundBase(cTop, cBot) {
    ctx.fillStyle = vg(GY, H, [[0, cTop], [0.5, cBot], [1, dk(cBot, 0.42)]]);
    ctx.fillRect(0, GY, W, H - GY + 2);
  }

  /* --- 山 --- */
  function sceneMountain() {
    var hz = GY;
    // 最远一层：几乎融进雾里
    var p0 = ridgePts(hz - H * 0.02, H * 0.20, 5, 0.55);
    fillRidge(p0, depth(mix(P2, PAL.b, 0.3), 0.72), depth(mix(P1, PAL.b, 0.2), 0.80), hz - H * 0.24, H);
    rimStroke(p0, lit(LK.haze, 0.4), 0.20, 1.1);
    // 第二层：带雪顶
    var p1 = ridgePts(hz + H * 0.015, H * 0.26, 6, 0.75);
    fillRidge(p1, depth(mix(P1, PAL.a, 0.16), 0.44), depth(P0, 0.5), hz - H * 0.3, H);
    rimStroke(p1, lit(LK.haze, 0.5), 0.26, 1.6);
    // 雪顶：沿最高的几个峰点铺白
    var peaks = ridgePeaks(p1);
    for (var i = 0; i < peaks.length; i++) {
      var pk = peaks[i];
      var sr = Math.max(W * 0.02, (hz + H * 0.02 - pk[1]) * 0.36);
      blob(pk[0], pk[1] + sr * 0.20, sr * 1.5, sr * 0.85, lit(LK.haze, 0.55), 0.34);
      blob(pk[0], pk[1], sr * 0.9, sr * 0.5, lit(PAL.ink, 0.4), 0.30);
    }
    // 第三层：中景山脊
    var p2 = ridgePts(hz + H * 0.055, H * 0.19, 5, 0.60);
    fillRidge(p2, depth(mix(P0, PAL.a, 0.10), 0.24), dk(P0, 0.42), hz - H * 0.16, H);
    rimStroke(p2, A(lit(PAL.a, 0.3), 0.3), 0.20, 1.4);
    // 近景：山脚大坡
    var p3 = ridgePts(hz + H * 0.16, H * 0.10, 4, 0.25);
    fillRidge(p3, dk(mix(P0, P1, 0.4), 0.30), dk(P0, 0.62), hz, H);
    groundBase(dk(mix(P0, P1, 0.35), 0.28), dk(P0, 0.56));
    // 谷里的雾
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var k = 0; k < 5; k++) {
      blob(rr(0, W), hz - H * rr(0.01, 0.07), W * rr(0.14, 0.3), H * rr(0.014, 0.035), LK.haze, 0.16);
    }
    ctx.restore();
    return { groundY: GY + H * 0.1 };
  }

  function ridgePeaks(pts) {
    var out = [], i;
    for (i = 6; i < pts.length - 6; i += 9) {
      var isMax = true;
      for (var j = -8; j <= 8; j++) {
        if (pts[i + j] && pts[i + j][1] < pts[i][1]) { isMax = false; break; }
      }
      if (isMax) out.push(pts[i]);
      if (out.length > 7) break;
    }
    return out;
  }

  /* --- 海 --- */
  function sceneSea() {
    var hz = GY;
    // 远处岛屿/岬角（2 层，越远越淡）
    var p0 = ridgePts(hz - H * 0.004, H * 0.055, 4, 0.4);
    fillRidge(p0, depth(P0, 0.68), depth(P0, 0.74), hz - H * 0.07, hz + 4, 0.9);
    var p1 = ridgePts(hz + H * 0.002, H * 0.085, 3, 0.5);
    fillRidge(p1, depth(dk(P1, 0.2), 0.34), depth(dk(P0, 0.3), 0.42), hz - H * 0.1, hz + 4, 1);
    rimStroke(p1, lit(LK.haze, 0.4), 0.22, 1.2);

    // 水面
    var wTop = mix(LK.hz, PAL.b, 0.30), wBot = dk(mix(P0, PAL.b, 0.10), 0.40);
    ctx.fillStyle = vg(hz, H, [
      [0, lit(wTop, 0.18)],
      [0.25, wTop],
      [0.7, dk(wTop, 0.32)],
      [1, wBot],
    ]);
    ctx.fillRect(0, hz, W, H - hz + 2);

    // 横向波纹
    var ripples = Math.round(((W * H) / 90000) * 26);
    for (var i = 0; i < ripples; i++) {
      var t = Math.pow(rnd(), 1.55);
      var y = hz + (H - hz) * t + rr(0, 2);
      var len = W * rr(0.008, 0.055) * (0.35 + t * 2.4);
      var x = rr(-0.06 * W, 1.02 * W);
      var al = (0.05 + 0.26 * t) * rr(0.4, 1);
      ctx.strokeStyle = A(chance(0.55) ? lit(LK.hz, 0.35) : lit(PAL.b, 0.2), al);
      ctx.lineWidth = Math.max(0.6, 0.5 + t * 2.4);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + len * 0.5, y - rr(0.4, 1.6) * (0.6 + t * 2.6), x + len, y);
      ctx.stroke();
    }
    // 太阳倒影光柱
    sunColumn(SUNX, hz + H * 0.005, lit(LK.sunCol, 0.25), 0.55);
    // 浪花：贴近画面底部几道
    for (var k = 0; k < 8; k++) {
      var yy = H - rr(0, H * 0.12);
      blob(rr(-0.05, 1.05) * W, yy, W * rr(0.05, 0.14), H * rr(0.006, 0.016), lit(LK.hz, 0.5), rr(0.06, 0.14));
    }
    return { groundY: hz + (H - hz) * 0.5 };
  }

  function sunColumn(x, y0, col, alpha) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var wid = W * rr(0.028, 0.055);
    for (var i = 0; i < 30; i++) {
      var t = i / 30;
      var yy = y0 + (H - y0) * Math.pow(t, 1.35);
      var ww = wid * (1 + t * 3.2);
      var a = alpha * (1 - t) * rr(0.4, 1.0);
      ctx.fillStyle = A(col, a * 0.55);
      ctx.beginPath();
      ctx.ellipse(x + Math.sin(i * 1.7 + t * 7) * ww * 0.16, yy, ww * 0.5, Math.max(1, 1.6 + 3.4 * t), 0, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  /* --- 湖 --- */
  function sceneLake() {
    var hz = GY;
    var p0 = ridgePts(hz - H * 0.008, H * 0.13, 4, 0.55);
    fillRidge(p0, depth(mix(P1, PAL.a, 0.12), 0.60), depth(P0, 0.66), hz - H * 0.15, hz + 2, 0.95);
    rimStroke(p0, lit(LK.haze, 0.45), 0.22, 1.2);
    var p1 = ridgePts(hz + H * 0.002, H * 0.09, 5, 0.5);
    fillRidge(p1, depth(P0, 0.34), depth(dk(P0, 0.2), 0.45), hz - H * 0.1, hz + 2);

    var wTop = mix(LK.hz, PAL.b, 0.24);
    ctx.fillStyle = vg(hz, H, [[0, lit(wTop, 0.10)], [0.35, dk(wTop, 0.10)], [1, dk(mix(P0, PAL.b, 0.16), 0.4)]]);
    ctx.fillRect(0, hz, W, H - hz + 2);
    // 山影倒影
    ctx.save();
    ctx.globalAlpha = 0.32;
    ctx.translate(0, hz * 2);
    ctx.scale(1, -1);
    fillRidge(p1, depth(P0, 0.34), depth(dk(P0, 0.2), 0.45), hz - H * 0.1, hz + 2);
    ctx.restore();
    // 静水细波
    for (var i = 0; i < Math.round(H / 3); i++) {
      var t = Math.pow(rnd(), 1.4);
      var y = hz + (H - hz) * t;
      var len = W * rr(0.02, 0.10) * (0.3 + t);
      var x = rr(0, W);
      ctx.strokeStyle = A(lit(LK.hz, 0.3), (0.04 + 0.16 * t) * rr(0.4, 1));
      ctx.lineWidth = Math.max(0.5, 0.4 + t * 1.6);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + len, y - rr(0, 1.2)); ctx.stroke();
    }
    sunColumn(SUNX * rr(0.9, 1.1), hz + 2, lit(LK.sunCol, 0.3), 0.42);
    // 近岸芦苇
    var reedCol = dk(mix(P0, PAL.a, 0.16), 0.35);
    for (var r = 0; r < 46; r++) {
      var bx = rr(-0.02, 1.02) * W, by = H - rr(0, H * 0.06);
      var hh = H * rr(0.03, 0.13), bend = rr(-0.05, 0.05) * W;
      ctx.strokeStyle = A(reedCol, rr(0.35, 0.8));
      ctx.lineWidth = rr(0.8, 2.2);
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.quadraticCurveTo(bx + bend * 0.4, by - hh * 0.6, bx + bend, by - hh);
      ctx.stroke();
    }
    return { groundY: hz + (H - hz) * 0.4 };
  }

  /* --- 森林 --- */
  function fir(x, baseY, hgt, wdt, col, a) {
    ctx.save();
    ctx.globalAlpha = a == null ? 1 : a;
    ctx.fillStyle = col;
    // 树干
    ctx.fillRect(x - wdt * 0.05, baseY - hgt * 0.22, Math.max(1, wdt * 0.10), hgt * 0.24);
    // 三层树冠
    for (var t = 0; t < 3; t++) {
      var ty = baseY - hgt * (0.18 + t * 0.26);
      var tw = wdt * (1 - t * 0.24);
      var th = hgt * (0.42 - t * 0.06);
      ctx.beginPath();
      ctx.moveTo(x, ty - th);
      ctx.quadraticCurveTo(x + tw * 0.30, ty - th * 0.42, x + tw * 0.5, ty);
      ctx.quadraticCurveTo(x + tw * 0.16, ty + th * 0.12, x, ty + th * 0.16);
      ctx.quadraticCurveTo(x - tw * 0.16, ty + th * 0.12, x - tw * 0.5, ty);
      ctx.quadraticCurveTo(x - tw * 0.30, ty - th * 0.42, x, ty - th);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }
  function sceneForest() {
    var hz = GY;
    // 远：雾里的树墙
    var farL = mix(P0, P1, 0.5);
    fillRidge(ridgePts(hz, H * 0.02, 3, 0.1), depth(farL, 0.70), depth(farL, 0.76), hz - H * 0.05, hz + 4);
    var i, x;
    for (i = 0; i < 130; i++) {
      x = rr(-0.02, 1.02) * W;
      fir(x, hz + rr(-4, 6), H * rr(0.05, 0.11), W * rr(0.012, 0.03), depth(farL, 0.62), rr(0.5, 0.9));
    }
    // 中景
    for (i = 0; i < 70; i++) {
      x = rr(-0.02, 1.02) * W;
      fir(x, hz + H * rr(0.01, 0.06), H * rr(0.10, 0.19), W * rr(0.02, 0.05), depth(dk(mix(P0, PAL.a, 0.2), 0.2), 0.34), rr(0.7, 1));
    }
    // 地面
    groundBase(dk(mix(P0, PAL.a, 0.18), 0.30), dk(P0, 0.55));
    // 近景：大树干 + 大树冠
    for (i = 0; i < 9; i++) {
      x = (i < 4 ? rr(-0.05, 0.16) : i < 7 ? rr(0.82, 1.05) : rr(0, 1)) * W;
      var baseY = H + H * rr(0, 0.06);
      var hgt = H * rr(0.55, 0.95);
      fir(x, baseY, hgt, W * rr(0.08, 0.17), dk(mix(P0, PAL.a, 0.10), 0.5), 1);
    }
    // 林间光柱
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (i = 0; i < 4; i++) {
      var lx = rr(0.15, 0.85) * W;
      var g = ctx.createLinearGradient(lx, 0, lx + W * 0.08, H);
      g.addColorStop(0, A(lit(PAL.c, 0.4), 0.14));
      g.addColorStop(1, A(lit(PAL.c, 0.4), 0));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(lx - W * 0.02, 0);
      ctx.lineTo(lx + W * 0.03, 0);
      ctx.lineTo(lx + W * 0.10, H);
      ctx.lineTo(lx + W * 0.02, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
    return { groundY: GY + H * 0.18 };
  }

  /* --- 草原 --- */
  function sceneGrass() {
    var hz = GY;
    // 远山
    var p0 = ridgePts(hz - H * 0.01, H * 0.10, 5, 0.25);
    fillRidge(p0, depth(mix(P1, PAL.b, 0.25), 0.66), depth(P0, 0.72), hz - H * 0.12, hz + 4);
    rimStroke(p0, lit(LK.haze, 0.4), 0.18, 1.1);
    // 缓坡 3 层
    var g1 = mix(P1, PAL.a, 0.30), g2 = mix(dk(P0, 0.1), PAL.a, 0.26);
    var p1 = ridgePts(hz + H * 0.01, H * 0.055, 4, 0.10);
    fillRidge(p1, depth(g1, 0.42), depth(dk(g1, 0.2), 0.5), hz - H * 0.06, H);
    var p2 = ridgePts(hz + H * 0.055, H * 0.045, 3, 0.06);
    fillRidge(p2, g2, dk(g2, 0.35), hz, H);
    groundBase(lit(g2, 0.06), dk(g2, 0.30));
    // 草浪纹理
    var n = Math.round((W * H) / 5200);
    for (var i = 0; i < n; i++) {
      var t = Math.pow(rnd(), 0.85);
      var y = hz + (H - hz) * t;
      var x = rr(0, W);
      var len = (2 + t * 26) * (H / 720);
      var sway = rr(-0.5, 0.5) * len;
      ctx.strokeStyle = A(chance(0.5) ? lit(g2, 0.30) : dk(g2, 0.25), (0.10 + 0.40 * t) * rr(0.5, 1));
      ctx.lineWidth = Math.max(0.5, 0.4 + t * 1.5);
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + sway * 0.6, y - len * 0.6, x + sway, y - len);
      ctx.stroke();
    }
    // 小花点缀
    for (var k = 0; k < Math.round(n * 0.05); k++) {
      var yy = hz + (H - hz) * Math.pow(rnd(), 0.7);
      var xx = rr(0, W);
      var s = 1 + (yy - hz) / (H - hz) * 3;
      blob(xx, yy, s * 2.4, s * 2.4, chance(0.6) ? lit(PAL.c, 0.2) : lit(PAL.a, 0.3), 0.35);
    }
    return { groundY: hz + (H - hz) * 0.55 };
  }

  /* --- 荒野/沙漠 --- */
  function sceneDesert() {
    var hz = GY;
    var p0 = ridgePts(hz - H * 0.005, H * 0.07, 4, 0.10);
    fillRidge(p0, depth(mix(P2, PAL.c, 0.35), 0.62), depth(P1, 0.68), hz - H * 0.09, hz + 4);
    // 沙丘：4 条，明暗两面
    var tones = [
      { top: mix(P2, PAL.c, 0.55), d: 0.42, amp: 0.045 },
      { top: mix(P2, PAL.c, 0.42), d: 0.26, amp: 0.060 },
      { top: mix(P1, PAL.c, 0.34), d: 0.14, amp: 0.075 },
      { top: mix(P1, PAL.c, 0.20), d: 0.02, amp: 0.090 },
    ];
    for (var i = 0; i < tones.length; i++) {
      var t = tones[i];
      var by = hz + H * (0.01 + i * 0.075);
      var pts = ridgePts(by, H * t.amp, 3 + i, 0.04);
      var cTop = depth(lit(t.top, 0.22), t.d);
      var cBot = depth(dk(t.top, 0.28), t.d);
      fillRidge(pts, cTop, cBot, by - H * t.amp, H);
      rimStroke(pts, depth(lit(t.top, 0.55), t.d), 0.20, 1.2);
      // 迎风坡亮面
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      for (var k = 0; k < 3; k++) {
        blob(rr(0.1, 0.9) * W, by - rr(0, H * 0.02), W * rr(0.10, 0.24), H * rr(0.01, 0.025), lit(t.top, 0.5), 0.12);
      }
      ctx.restore();
    }
    // 沙纹
    var n = Math.round((W * H) / 9000);
    for (var s = 0; s < n; s++) {
      var yy = GY + (H - GY) * Math.pow(rnd(), 0.8);
      var xx = rr(0, W);
      var len = W * rr(0.01, 0.05);
      ctx.strokeStyle = A(chance(0.5) ? lit(PAL.c, 0.4) : dk(P1, 0.3), rr(0.04, 0.14));
      ctx.lineWidth = Math.max(0.5, (yy - GY) / (H - GY) * 1.8);
      ctx.beginPath();
      ctx.moveTo(xx, yy);
      ctx.quadraticCurveTo(xx + len * 0.5, yy - rr(0, 2), xx + len, yy + rr(-1, 1));
      ctx.stroke();
    }
    return { groundY: GY + H * 0.20 };
  }

  /* --- 田野 --- */
  function sceneField() {
    var hz = GY;
    var p0 = ridgePts(hz - H * 0.01, H * 0.09, 5, 0.2);
    fillRidge(p0, depth(mix(P1, PAL.a, 0.2), 0.62), depth(P0, 0.70), hz - H * 0.11, hz + 4);
    groundBase(mix(P1, PAL.c, 0.32), dk(mix(P0, PAL.c, 0.12), 0.34));
    // 田地：透视收敛的条带
    var vpx = W * rr(0.35, 0.65);
    for (var i = 0; i < 26; i++) {
      var t0 = i / 26, t1 = (i + 0.9) / 26;
      var y0 = hz + (H - hz) * Math.pow(t0, 1.7);
      var y1 = hz + (H - hz) * Math.pow(t1, 1.7);
      var col = i % 2 ? lit(mix(P1, PAL.c, 0.42), 0.10) : dk(mix(P1, PAL.c, 0.20), 0.16);
      ctx.fillStyle = A(col, 0.55);
      ctx.beginPath();
      ctx.moveTo(vpx + (0 - vpx) * (0.25 + t0), y0);
      ctx.lineTo(vpx + (W - vpx) * (0.25 + t1), y1);
      ctx.lineTo(vpx + (W - vpx) * (0.25 + t1 * 1.02), y1 + (H - hz) * 0.02);
      ctx.lineTo(vpx + (0 - vpx) * (0.25 + t0 * 1.02), y0 + (H - hz) * 0.02);
      ctx.closePath();
      ctx.fill();
    }
    // 纵向垄沟
    for (var k = 0; k <= 22; k++) {
      var ux = k / 22;
      ctx.strokeStyle = A(dk(mix(P0, PAL.a, 0.2), 0.25), 0.16);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(vpx + (ux * W - vpx) * 0.30, hz + H * 0.004);
      ctx.lineTo(vpx + (ux * W - vpx) * 1.4, H);
      ctx.stroke();
    }
    // 稻穗
    for (var s = 0; s < Math.round(W * 0.5); s++) {
      var t = Math.pow(rnd(), 0.8);
      var y = hz + (H - hz) * t;
      var x = rr(0, W);
      var len = (2 + t * 15) * (H / 720);
      ctx.strokeStyle = A(lit(PAL.c, 0.35), (0.10 + 0.30 * t) * 0.9);
      ctx.lineWidth = Math.max(0.5, 0.4 + t);
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rr(-2, 2), y - len); ctx.stroke();
    }
    return { groundY: GY + H * 0.3 };
  }

  /* --- 城市 --- */
  function skyline(baseY, colTop, colBot, hMin, hMax, wMin, wMax, winCol, winA) {
    var x = -rr(0, 0.05) * W;
    var guard = 0;
    while (x < W * 1.05 && guard++ < 300) {
      var bw = W * rr(wMin, wMax);
      var bh = H * rr(hMin, hMax);
      var y = baseY - bh;
      ctx.fillStyle = vg(y, baseY, [[0, colTop], [1, colBot]]);
      ctx.fillRect(x, y, bw, baseY - y + 2);
      if (chance(0.22)) { // 天线
        var ax = x + bw * rr(0.35, 0.65);
        ctx.fillStyle = colBot;
        ctx.fillRect(ax, y - H * rr(0.01, 0.035), Math.max(1, bw * 0.035), H * 0.04);
      }
      if (winA > 0) {
        var cols = Math.max(1, Math.round(bw / (W * 0.011)));
        var rows = Math.max(1, Math.round(bh / (H * 0.017)));
        for (var i = 0; i < cols; i++) {
          for (var j = 0; j < rows; j++) {
            if (rnd() > 0.36) continue;
            var wx = x + bw * (i + 0.28) / cols;
            var wy = y + bh * (j + 0.26) / rows;
            var a = winA * rr(0.3, 1);
            ctx.fillStyle = A(chance(0.78) ? winCol : PAL.a, a);
            ctx.fillRect(wx, wy, Math.max(1.1, bw / cols * 0.44), Math.max(1.1, bh / rows * 0.34));
            if (chance(0.10)) glow(wx, wy, Math.max(5, W * 0.006), winCol, a * 0.55);
          }
        }
      }
      x += bw + W * rr(0.002, 0.010);
    }
  }
  function sceneCity() {
    var hz = GY;
    var refCol = mix(PAL.a, PAL.b, rr(0, 1));
    // 远：天际线融进雾
    skyline(hz - H * 0.02, depth(mix(P1, PAL.b, 0.4), 0.72), depth(mix(P2, PAL.b, 0.3), 0.78), 0.06, 0.20, 0.015, 0.045, 0, 0);
    // 中：有零星灯
    skyline(hz + H * 0.01, depth(mix(P1, PAL.a, 0.2), 0.44), depth(P0, 0.5), 0.10, 0.32, 0.02, 0.06, lit(PAL.c, 0.3), 0.35);
    // 近：黑楼 + 亮窗
    skyline(hz + H * 0.03, dk(mix(P0, PAL.a, 0.08), 0.32), dk(P0, 0.62), 0.14, 0.46, 0.03, 0.085, PAL.c, 0.75);
    // 地面（湿街）
    ctx.fillStyle = vg(hz, H, [[0, dk(mix(P0, PAL.b, 0.22), 0.30)], [0.4, dk(P0, 0.52)], [1, dk(P0, 0.68)]]);
    ctx.fillRect(0, hz, W, H - hz + 2);
    // 霓虹：横向光带 + 竖直倒影
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    var neons = ['#ff2d95', '#00f5ff', '#ffe600', PAL.a, PAL.b, PAL.c];
    var nBand = 5;
    for (var i = 0; i < nBand; i++) {
      var nx = rr(0.05, 0.95) * W;
      var ny = hz + rr(0, (H - hz) * 0.5);
      var nc = chance(0.55) ? neons[i % neons.length] : refCol;
      var nh = rr(0.004, 0.014) * H, nw = rr(0.08, 0.34) * W;
      // 街面霓虹带
      ctx.fillStyle = A(nc, 0.35);
      ctx.fillRect(nx - nw / 2, ny, nw, nh * 2);
      glow(nx, ny, nw * 0.55, nc, 0.18, false);
      // 湿街倒影
      for (var k = 0; k < 22; k++) {
        var t = k / 22;
        var yy = ny + nh + (H - ny) * Math.pow(t, 1.4) * 0.75;
        ctx.fillStyle = A(nc, 0.30 * (1 - t));
        ctx.fillRect(nx - nw * 0.32 * (1 + t * 1.4), yy, nw * 0.64 * (1 + t * 1.4) * rr(0.5, 1), Math.max(1, 1.4 + 2.4 * t));
      }
    }
    ctx.restore();
    // 路灯
    for (var L = 0; L < 6; L++) {
      var lx = rr(0.02, 0.98) * W, ly = hz + rr(0.01, 0.10) * H;
      var lh = H * rr(0.05, 0.13);
      ctx.strokeStyle = A(dk(P0, 0.7), 0.85);
      ctx.lineWidth = Math.max(1, W * 0.0022);
      ctx.beginPath(); ctx.moveTo(lx, ly + lh); ctx.lineTo(lx, ly); ctx.stroke();
      glow(lx, ly, W * rr(0.012, 0.022), lit(PAL.c, 0.3), 0.35);
    }
    return { groundY: GY + H * 0.24 };
  }

  /* --- 太空 --- */
  function sceneSpace() {
    // 大星球
    var px = rr(0.25, 0.75) * W, py = rr(0.30, 0.52) * H;
    var pr = Math.min(W, H) * rr(0.16, 0.26);
    // 大气辉光
    glow(px, py, pr * 2.6, PAL.b, 0.16);
    // 球体
    ctx.save();
    ctx.beginPath(); ctx.arc(px, py, pr, 0, 6.2832); ctx.clip();
    ctx.fillStyle = rg(px - pr * 0.35, py - pr * 0.40, pr * 2.0, [
      [0, lit(mix(P2, PAL.a, 0.5), 0.35)],
      [0.45, mix(P1, PAL.a, 0.35)],
      [1, dk(P0, 0.55)],
    ]);
    ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
    // 表面条带/云纹
    for (var i = 0; i < 16; i++) {
      var yy = py - pr + (i / 16) * pr * 2;
      blob(px + rr(-pr, pr), yy, pr * rr(0.3, 0.9), pr * rr(0.03, 0.09), chance(0.5) ? lit(PAL.a, 0.2) : dk(PAL.b, 0.25), rr(0.08, 0.22));
    }
    // 明暗终止线
    ctx.fillStyle = rg(px + pr * 0.55, py + pr * 0.35, pr * 1.9, [[0, A('#000000', 0.62)], [1, A('#000000', 0)]]);
    ctx.fillRect(px - pr, py - pr, pr * 2, pr * 2);
    ctx.restore();
    // 边缘光
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = A(lit(PAL.b, 0.35), 0.40);
    ctx.lineWidth = Math.max(1.5, pr * 0.045);
    ctx.beginPath(); ctx.arc(px, py, pr * 0.985, 0, 6.2832); ctx.stroke();
    ctx.restore();
    // 环
    if (chance(0.6)) {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(rr(-0.5, -0.15));
      ctx.scale(1, rr(0.16, 0.28));
      ctx.strokeStyle = A(lit(PAL.a, 0.3), 0.30);
      for (var r2 = 0; r2 < 3; r2++) {
        ctx.lineWidth = pr * (0.05 - r2 * 0.012);
        ctx.beginPath(); ctx.arc(0, 0, pr * (1.42 + r2 * 0.12), 0, 6.2832); ctx.stroke();
      }
      ctx.restore();
    }
    // 更密的星
    stars(1.25);
    // 流星
    if (chance(0.7)) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      var mx = rr(0.1, 0.9) * W, my = rr(0.05, 0.4) * H, len = W * rr(0.08, 0.18);
      var g2 = ctx.createLinearGradient(mx, my, mx - len, my + len * 0.5);
      g2.addColorStop(0, A(lit(PAL.ink, 0.5), 0.9));
      g2.addColorStop(1, A(PAL.ink, 0));
      ctx.strokeStyle = g2;
      ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(mx, my); ctx.lineTo(mx - len, my + len * 0.5); ctx.stroke();
      ctx.restore();
    }
    return { groundY: H };
  }

  /* ═════════ 8. 主体 ═════════ */
  function silhouetteCol() { return LIGHT ? dk(P0, 0.62) : mix(P0, '#000000', 0.55); }
  function rimGlow(x, y, r, col, a) { glow(x, y, r, col, a, false); }

  function subjWhale(cx, cy, s) {
    var col = silhouetteCol();
    // 水花
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 40; i++) {
      var ang = rr(-0.4, Math.PI + 0.4);
      var d = rr(0.6, 2.6) * s;
      blob(cx + Math.cos(ang) * d * 1.4, cy + s * 0.75 + Math.abs(Math.sin(ang)) * -d * 0.5, s * rr(0.05, 0.22), s * rr(0.05, 0.2), lit(LK.haze, 0.6), rr(0.2, 0.6));
    }
    ctx.restore();
    // 身体
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-0.28);
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-s * 1.05, s * 0.10);
    ctx.bezierCurveTo(-s * 0.95, -s * 0.42, -s * 0.20, -s * 0.62, s * 0.35, -s * 0.40);
    ctx.bezierCurveTo(s * 0.72, -s * 0.26, s * 0.88, -s * 0.06, s * 1.00, s * 0.02);
    // 尾鳍（上方一支）
    ctx.lineTo(s * 1.22, -s * 0.30);
    ctx.lineTo(s * 1.12, s * 0.02);
    ctx.lineTo(s * 1.30, s * 0.16);
    ctx.lineTo(s * 0.98, s * 0.22);
    ctx.bezierCurveTo(s * 0.55, s * 0.46, -s * 0.55, s * 0.46, -s * 1.05, s * 0.16);
    ctx.closePath();
    ctx.fill();
    // 腹部提亮
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = A(lit(PAL.b, 0.35), 0.20);
    ctx.beginPath();
    ctx.ellipse(-s * 0.20, s * 0.16, s * 0.78, s * 0.13, -0.05, 0, 6.2832);
    ctx.fill();
    // 胸鳍
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(-s * 0.32, s * 0.22);
    ctx.quadraticCurveTo(-s * 0.10, s * 0.66, -s * 0.62, s * 0.52);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    // 边缘柔光
    rimGlow(cx + s * 0.1, cy - s * 0.25, s * 1.5, lit(PAL.b, 0.4), 0.10);
    // 喷潮
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var k = 0; k < 18; k++) {
      blob(cx - s * 0.72 + rr(-0.06, 0.06) * s, cy - s * rr(0.35, 1.1), s * rr(0.03, 0.10), s * rr(0.02, 0.07), lit(LK.haze, 0.7), rr(0.15, 0.42));
    }
    ctx.restore();
  }

  function subjBird(x, y, s, col) {
    ctx.save();
    ctx.strokeStyle = col;
    ctx.lineWidth = Math.max(0.9, s * 0.16);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x - s, y);
    ctx.quadraticCurveTo(x - s * 0.5, y - s * 0.55, x, y - s * 0.05);
    ctx.quadraticCurveTo(x + s * 0.5, y - s * 0.55, x + s, y);
    ctx.stroke();
    ctx.restore();
  }

  function subjBoat(cx, cy, s) {
    var col = silhouetteCol();
    // 船身
    ctx.save();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(cx - s * 1.0, cy);
    ctx.lineTo(cx + s * 1.05, cy);
    ctx.quadraticCurveTo(cx + s * 0.5, cy + s * 0.42, cx - s * 0.62, cy + s * 0.40);
    ctx.closePath();
    ctx.fill();
    // 桅杆
    ctx.fillRect(cx - s * 0.02, cy - s * 1.35, Math.max(1, s * 0.06), s * 1.36);
    // 帆
    ctx.beginPath();
    ctx.moveTo(cx + s * 0.05, cy - s * 1.30);
    ctx.quadraticCurveTo(cx + s * 0.88, cy - s * 0.55, cx + s * 0.10, cy - s * 0.10);
    ctx.closePath();
    ctx.fill();
    // 倒影
    ctx.globalAlpha = 0.30;
    ctx.translate(0, cy * 2);
    ctx.scale(1, -1);
    ctx.beginPath();
    ctx.moveTo(cx - s * 1.0, cy);
    ctx.lineTo(cx + s * 1.05, cy);
    ctx.quadraticCurveTo(cx + s * 0.5, cy + s * 0.42, cx - s * 0.62, cy + s * 0.40);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
    rimGlow(cx + s * 0.7, cy - s * 0.75, s * 1.3, lit(PAL.c, 0.4), 0.10);
  }

  function subjTree(cx, baseY, s) {
    var trunk = LIGHT ? dk(mix(P0, PAL.a, 0.3), 0.45) : dk(mix(P0, PAL.a, 0.20), 0.30);
    // 主干
    ctx.save();
    ctx.fillStyle = trunk;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.11, baseY);
    ctx.quadraticCurveTo(cx - s * 0.06, baseY - s * 0.55, cx - s * 0.04, baseY - s * 0.95);
    ctx.lineTo(cx + s * 0.05, baseY - s * 0.95);
    ctx.quadraticCurveTo(cx + s * 0.07, baseY - s * 0.5, cx + s * 0.13, baseY);
    ctx.closePath();
    ctx.fill();
    // 主枝
    ctx.strokeStyle = trunk;
    ctx.lineCap = 'round';
    for (var b = 0; b < 5; b++) {
      var dir = b % 2 ? 1 : -1;
      ctx.lineWidth = s * rr(0.018, 0.032);
      ctx.beginPath();
      ctx.moveTo(cx + dir * s * 0.03, baseY - s * rr(0.55, 0.85));
      ctx.quadraticCurveTo(cx + dir * s * 0.22, baseY - s * rr(0.95, 1.10), cx + dir * s * rr(0.28, 0.52), baseY - s * rr(1.05, 1.35));
      ctx.stroke();
    }
    ctx.restore();
    // 树冠：多团柔光叠加成体积
    var leafA = mix(P1, PAL.a, 0.55), leafB = dk(mix(P0, PAL.a, 0.35), 0.20);
    var cyTop = baseY - s * 1.35;
    for (var i = 0; i < 26; i++) {
      var ang = rr(0, 6.2832), dd = Math.pow(rnd(), 0.6) * s * 0.95;
      var px = cx + Math.cos(ang) * dd * 1.05;
      var py = cyTop + Math.sin(ang) * dd * 0.72;
      var pr = s * rr(0.16, 0.34);
      blob(px, py, pr, pr * 0.92, i % 3 === 0 ? lit(leafA, 0.18) : leafB, rr(0.35, 0.62));
    }
    // 受光边
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var k = 0; k < 10; k++) {
      blob(cx + rr(0.05, 0.75) * s, cyTop - rr(-0.2, 0.55) * s, s * rr(0.06, 0.16), s * rr(0.05, 0.13), lit(PAL.c, 0.45), rr(0.10, 0.26));
    }
    ctx.restore();
  }

  function subjHouse(cx, baseY, s) {
    var wall = dk(mix(P0, PAL.c, 0.22), 0.28);
    var roof = dk(mix(P0, PAL.a, 0.10), 0.42);
    ctx.save();
    // 墙
    ctx.fillStyle = vg(baseY - s * 0.82, baseY, [[0, lit(wall, 0.10)], [1, dk(wall, 0.30)]]);
    ctx.fillRect(cx - s * 0.55, baseY - s * 0.82, s * 1.10, s * 0.82);
    // 屋顶
    ctx.fillStyle = roof;
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.74, baseY - s * 0.78);
    ctx.lineTo(cx, baseY - s * 1.34);
    ctx.lineTo(cx + s * 0.74, baseY - s * 0.78);
    ctx.closePath();
    ctx.fill();
    // 雪/霜盖在屋顶
    if (WEA === 'snow' || T === 'dawn' || LIGHT) {
      ctx.fillStyle = A(lit(LK.haze, 0.65), 0.75);
      ctx.beginPath();
      ctx.moveTo(cx - s * 0.66, baseY - s * 0.815);
      ctx.lineTo(cx, baseY - s * 1.30);
      ctx.lineTo(cx + s * 0.66, baseY - s * 0.815);
      ctx.quadraticCurveTo(cx, baseY - s * 0.96, cx - s * 0.66, baseY - s * 0.815);
      ctx.closePath();
      ctx.fill();
    }
    // 烟囱
    ctx.fillStyle = dk(wall, 0.18);
    ctx.fillRect(cx + s * 0.30, baseY - s * 1.26, s * 0.14, s * 0.34);
    // 窗（暖光）
    ctx.fillStyle = A(lit(PAL.c, 0.35), 0.92);
    ctx.fillRect(cx - s * 0.34, baseY - s * 0.60, s * 0.24, s * 0.22);
    ctx.fillRect(cx + s * 0.10, baseY - s * 0.60, s * 0.24, s * 0.22);
    // 门
    ctx.fillStyle = dk(wall, 0.35);
    ctx.fillRect(cx - s * 0.08, baseY - s * 0.40, s * 0.17, s * 0.40);
    ctx.restore();
    glow(cx - s * 0.22, baseY - s * 0.49, s * 0.42, lit(PAL.c, 0.3), 0.35);
    glow(cx + s * 0.22, baseY - s * 0.49, s * 0.42, lit(PAL.c, 0.3), 0.32);
    // 烟
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 16; i++) {
      var t = i / 16;
      blob(cx + s * 0.37 + Math.sin(t * 5) * s * 0.16 + t * s * 0.20,
        baseY - s * 1.30 - t * s * 1.25,
        s * (0.05 + t * 0.19), s * (0.04 + t * 0.16),
        lit(LK.haze, 0.45), (0.30 * (1 - t) + 0.06));
    }
    ctx.restore();
  }

  function subjPerson(cx, baseY, s) {
    var col = silhouetteCol();
    ctx.save();
    ctx.fillStyle = col;
    // 头
    ctx.beginPath(); ctx.arc(cx, baseY - s * 1.02, s * 0.16, 0, 6.2832); ctx.fill();
    // 身+腿
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.19, baseY - s * 0.84);
    ctx.quadraticCurveTo(cx - s * 0.22, baseY - s * 0.42, cx - s * 0.16, baseY);
    ctx.lineTo(cx - s * 0.02, baseY);
    ctx.quadraticCurveTo(cx - s * 0.05, baseY - s * 0.40, cx, baseY - s * 0.62);
    ctx.quadraticCurveTo(cx + s * 0.05, baseY - s * 0.40, cx + s * 0.02, baseY);
    ctx.lineTo(cx + s * 0.16, baseY);
    ctx.quadraticCurveTo(cx + s * 0.22, baseY - s * 0.42, cx + s * 0.19, baseY - s * 0.84);
    ctx.quadraticCurveTo(cx, baseY - s * 0.96, cx - s * 0.19, baseY - s * 0.84);
    ctx.closePath();
    ctx.fill();
    // 手臂
    ctx.strokeStyle = col;
    ctx.lineWidth = s * 0.075;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - s * 0.17, baseY - s * 0.80);
    ctx.quadraticCurveTo(cx - s * 0.26, baseY - s * 0.62, cx - s * 0.22, baseY - s * 0.44);
    ctx.moveTo(cx + s * 0.17, baseY - s * 0.80);
    ctx.quadraticCurveTo(cx + s * 0.27, baseY - s * 0.64, cx + s * 0.24, baseY - s * 0.46);
    ctx.stroke();
    ctx.restore();
    // 边缘柔光（逆光轮廓）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = A(lit(PAL.c, 0.5), 0.35);
    ctx.lineWidth = Math.max(1, s * 0.035);
    ctx.beginPath();
    ctx.arc(cx, baseY - s * 1.02, s * 0.175, -0.6, 1.9);
    ctx.stroke();
    ctx.restore();
  }

  function subjCamel(cx, baseY, s) {
    var col = silhouetteCol();
    ctx.save();
    ctx.translate(cx, baseY);
    ctx.fillStyle = col;
    // 腿
    ctx.lineWidth = s * 0.055;
    ctx.strokeStyle = col;
    ctx.lineCap = 'round';
    var legs = [[-0.34, 0.02], [-0.20, 0.03], [0.22, 0.02], [0.36, 0.03]];
    for (var i = 0; i < legs.length; i++) {
      ctx.beginPath();
      ctx.moveTo(legs[i][0] * s, -s * 0.42);
      ctx.quadraticCurveTo(legs[i][0] * s + (i % 2 ? s * 0.03 : -s * 0.02), -s * 0.18, legs[i][0] * s, 0);
      ctx.stroke();
    }
    // 身体
    ctx.beginPath();
    ctx.ellipse(0, -s * 0.55, s * 0.42, s * 0.19, 0, 0, 6.2832);
    ctx.fill();
    // 驼峰
    ctx.beginPath();
    ctx.moveTo(-s * 0.22, -s * 0.66);
    ctx.quadraticCurveTo(-s * 0.05, -s * 0.95, s * 0.16, -s * 0.66);
    ctx.closePath();
    ctx.fill();
    // 脖子 + 头
    ctx.beginPath();
    ctx.moveTo(s * 0.34, -s * 0.62);
    ctx.bezierCurveTo(s * 0.56, -s * 0.72, s * 0.52, -s * 1.02, s * 0.62, -s * 1.06);
    ctx.lineTo(s * 0.78, -s * 1.04);
    ctx.bezierCurveTo(s * 0.70, -s * 0.92, s * 0.70, -s * 0.74, s * 0.46, -s * 0.52);
    ctx.closePath();
    ctx.fill();
    // 尾巴
    ctx.beginPath();
    ctx.moveTo(-s * 0.42, -s * 0.60);
    ctx.quadraticCurveTo(-s * 0.56, -s * 0.50, -s * 0.54, -s * 0.36);
    ctx.stroke();
    ctx.restore();
    rimGlow(cx + s * 0.5, baseY - s * 1.0, s * 0.6, lit(PAL.c, 0.45), 0.12);
  }

  function subjFish(cx, cy, s) {
    var col = silhouetteCol();
    ctx.save();
    ctx.translate(cx, cy);
    for (var i = 0; i < 3; i++) {
      var sc = s * (1 - i * 0.26);
      var ox = i * s * 1.5, oy = Math.sin(i * 2.1) * s * 0.35;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.fillStyle = i === 0 ? col : A(col, 0.75);
      ctx.beginPath();
      ctx.moveTo(-sc * 0.5, 0);
      ctx.quadraticCurveTo(0, -sc * 0.42, sc * 0.52, 0);
      ctx.quadraticCurveTo(0, sc * 0.42, -sc * 0.5, 0);
      ctx.closePath();
      ctx.fill();
      // 尾
      ctx.beginPath();
      ctx.moveTo(-sc * 0.46, 0);
      ctx.lineTo(-sc * 0.86, -sc * 0.28);
      ctx.lineTo(-sc * 0.74, 0);
      ctx.lineTo(-sc * 0.86, sc * 0.28);
      ctx.closePath();
      ctx.fill();
      // 背鳍
      ctx.beginPath();
      ctx.moveTo(-sc * 0.08, -sc * 0.30);
      ctx.quadraticCurveTo(0, -sc * 0.58, sc * 0.18, -sc * 0.24);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
    ctx.restore();
  }

  function subjBalloon(cx, cy, s) {
    var c1 = mix(PAL.a, '#ffffff', 0.15), c2 = PAL.b, c3 = PAL.c;
    ctx.save();
    // 球体
    ctx.translate(cx, cy);
    var g = rg(0, -s * 0.15, s * 1.1, [[0, lit(c3, 0.5)], [0.45, c1], [1, dk(c1, 0.35)]]);
    ctx.beginPath();
    ctx.moveTo(0, s * 0.42);
    ctx.bezierCurveTo(-s * 0.86, s * 0.10, -s * 0.82, -s * 0.98, 0, -s * 1.02);
    ctx.bezierCurveTo(s * 0.82, -s * 0.98, s * 0.86, s * 0.10, 0, s * 0.42);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    // 分片条纹
    ctx.save();
    ctx.clip();
    for (var i = -3; i <= 3; i++) {
      ctx.strokeStyle = A(i % 2 ? lit(c3, 0.25) : dk(c2, 0.20), 0.42);
      ctx.lineWidth = s * 0.045;
      ctx.beginPath();
      ctx.moveTo(i * s * 0.22, -s * 1.02);
      ctx.quadraticCurveTo(i * s * 0.34, 0, i * s * 0.16, s * 0.44);
      ctx.stroke();
    }
    ctx.restore();
    // 吊篮
    ctx.fillStyle = dk(mix(P0, PAL.c, 0.25), 0.30);
    ctx.fillRect(-s * 0.16, s * 0.52, s * 0.32, s * 0.20);
    ctx.strokeStyle = A(dk(P0, 0.2), 0.85);
    ctx.lineWidth = Math.max(0.8, s * 0.014);
    ctx.beginPath();
    ctx.moveTo(-s * 0.14, s * 0.50); ctx.lineTo(-s * 0.16, s * 0.40);
    ctx.moveTo(s * 0.14, s * 0.50); ctx.lineTo(s * 0.16, s * 0.40);
    ctx.stroke();
    ctx.restore();
    glow(cx, cy - s * 0.35, s * 1.5, lit(PAL.c, 0.4), 0.12);
  }

  /* 主体统一入口：位置按场景挑，避免压住地平线 */
  function subjectDraw(info) {
    if (!SUBJ) return;
    var s, cx, cy;
    var gy = (info && info.groundY) || GY;
    if (SUBJ === 'sun') { disc(SUNX, SUNY, SUNR * 1.9, lit(LK.sunCol, 0.2), 'sun'); return; }
    if (SUBJ === 'moon') { disc(SUNX, SUNY, SUNR * 1.7, lit(PAL.ink, 0.5), 'moon'); return; }

    // ── 角色绘制层：prompt 点名谁就画谁 ──
    if (SUBJ === 'whalegirl') {
      s = Math.min(W, H) * (OPT.char && OPT.char.size === 'near' ? 0.62 : OPT.char && OPT.char.size === 'far' ? 0.30 : 0.44);
      var wgx = rr(0.30, 0.70) * W, wgy = gy + (H - gy) * (OPT.char && OPT.char.size === 'far' ? 0.34 : 0.18);
      var wgd = OPT.char && OPT.char.dir === 'left' ? -1 : 1;
      ctx.save(); ctx.translate(wgx, wgy); ctx.scale(s * wgd, s); wgGirl(0, 0, 1, OPT.char && OPT.char.palette || {});
      ctx.restore();
      return;
    }
    if (SUBJ === 'mermaid') {
      s = Math.min(W, H) * (OPT.char && OPT.char.size === 'near' ? 0.62 : 0.42);
      var mx = rr(0.35, 0.65) * W, my = GY - H * 0.16;
      ctx.save(); ctx.translate(mx, my); ctx.scale(s, s);
      ctx.fillStyle = dk(PAL.ink, 0.15); ctx.globalAlpha = 0.85;
      ctx.beginPath(); ctx.ellipse(0, -0.30, 0.16, 0.30, 0, 0, 6.2832); ctx.fill();
      ctx.beginPath(); ctx.moveTo(0.02, -0.05); ctx.quadraticCurveTo(0.30, -0.12, 0.34, 0.02); ctx.quadraticCurveTo(0.18, 0.02, 0.05, 0); ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 1; ctx.restore();
      return;
      return;
    }
    if (SUBJ === 'girl' || SUBJ === 'boy' || SUBJ === 'cat' || SUBJ === 'dog' || SUBJ === 'fox' || SUBJ === 'rabbit') {
      s = Math.min(W, H) * (OPT.char && OPT.char.size === 'near' ? 0.62 : OPT.char && OPT.char.size === 'far' ? 0.26 : 0.42);
      var cx2 = rr(0.28, 0.72) * W, cy2 = gy + (H - gy) * (OPT.char && OPT.char.size === 'far' ? 0.36 : 0.16);
      var d2 = OPT.char && OPT.char.dir === 'left' ? -1 : 1;
      drawChar(cx2, cy2, s, { type: SUBJ, pose: OPT.char && OPT.char.pose, dir: d2, palette: OPT.char && OPT.char.palette });
      return;
    }
    if (SUBJ === 'bird') {
      s = Math.min(W, H) * 0.022;
      var flock = ri(5, 11);
      var fx = rr(0.2, 0.8) * W, fy = GY * rr(0.22, 0.6);
      for (var i = 0; i < flock; i++) {
        var sc = s * rr(0.7, 1.5) * (1 - i * 0.03);
        subjBird(fx + rr(-0.22, 0.22) * W, fy + rr(-0.10, 0.10) * H, sc, A(LIGHT ? dk(P0, 0.4) : dk(P0, 0.15), rr(0.55, 0.95)));
      }
      return;
    }
    if (SUBJ === 'balloon') {
      s = Math.min(W, H) * 0.085;
      subjBalloon(rr(0.22, 0.78) * W, GY * rr(0.42, 0.72), s);
      return;
    }
    if (SUBJ === 'whale') {
      s = Math.min(W, H) * 0.20;
      subjWhale(rr(0.30, 0.68) * W, GY - H * rr(0.02, 0.10), s);
      return;
    }
    if (SUBJ === 'boat') {
      s = Math.min(W, H) * 0.075;
      subjBoat(rr(0.24, 0.76) * W, GY + (H - GY) * rr(0.18, 0.40), s);
      return;
    }
    if (SUBJ === 'tree') {
      s = Math.min(W, H) * (SC === 'grass' || SC === 'field' ? 0.30 : 0.24);
      subjTree(rr(0.24, 0.74) * W, GY + (H - GY) * rr(0.30, 0.46), s);
      return;
    }
    if (SUBJ === 'house') {
      s = Math.min(W, H) * 0.17;
      subjHouse(rr(0.30, 0.70) * W, GY + (H - GY) * rr(0.26, 0.42), s);
      return;
    }
    if (SUBJ === 'person') {
      s = Math.min(W, H) * 0.14;
      subjPerson(rr(0.24, 0.76) * W, GY + (H - GY) * rr(0.26, 0.50), s);
      return;
    }
    if (SUBJ === 'camel') {
      s = Math.min(W, H) * 0.115;
      var baseY = GY + (H - GY) * rr(0.34, 0.46);
      var dir = rr(0, 1) < 0.5 ? 1 : -1;
      var startX = dir > 0 ? rr(0.16, 0.34) * W : rr(0.66, 0.84) * W;
      for (var c = 0; c < 3; c++) {
        var cs = s * (1 - c * 0.13);
        subjCamel(startX + dir * c * s * 1.5 * -1, baseY - cs * 0.12 * c + c * H * 0.012, cs);
      }
      return;
    }
    if (SUBJ === 'fish') {
      s = Math.min(W, H) * 0.075;
      subjFish(rr(0.20, 0.50) * W, GY * rr(0.3, 0.55) + H * 0.05, s);
      return;
    }
  }

  /* ═════════ 9. 天气（前景） ═════════ */
  function weatherFront() {
    if (WEA === 'rain' || WEA === 'storm') {
      var heavy = WEA === 'storm' ? 1.6 : 1;
      var n = Math.round((W * H) / 1400 * heavy);
      n = Math.min(n, 2600);
      var angle = 0.20;
      for (var i = 0; i < n; i++) {
        var x = rr(-0.1, 1.1) * W;
        var y = rr(-0.05, 1.05) * H;
        var len = rr(0.02, 0.075) * H * rr(0.7, 1.6);
        var a = rr(0.06, 0.26) * heavy;
        ctx.strokeStyle = A(chance(0.6) ? lit(PAL.ink, 0.35) : lit(PAL.b, 0.25), Math.min(0.4, a));
        ctx.lineWidth = rr(0.6, 1.6);
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - len * Math.sin(angle), y + len * Math.cos(angle));
        ctx.stroke();
      }
      // 近景雨丝（大而虚）
      for (var k = 0; k < 18; k++) {
        var x2 = rr(0, W), y2 = rr(-0.1, 0.9) * H;
        var len2 = rr(0.10, 0.24) * H;
        ctx.strokeStyle = A(lit(PAL.ink, 0.5), rr(0.04, 0.12));
        ctx.lineWidth = rr(2.4, 5);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - len2 * Math.sin(angle + 0.06), y2 + len2 * Math.cos(angle + 0.06));
        ctx.stroke();
      }
      // 地面水花
      if (SC === 'city' || SC === 'sea' || SC === 'lake') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (var s2 = 0; s2 < 60; s2++) {
          blob(rr(0, W), GY + (H - GY) * Math.pow(rnd(), 0.6), W * rr(0.004, 0.012), H * rr(0.002, 0.006), lit(PAL.ink, 0.4), rr(0.15, 0.4));
        }
        ctx.restore();
      }
      if (WEA === 'storm') lightning();
    }
    if (WEA === 'snow') {
      var m = Math.round((W * H) / 2600);
      m = Math.min(m, 1500);
      for (var j = 0; j < m; j++) {
        var sx = rr(0, W), sy = rr(0, H);
        var r = Math.pow(rnd(), 1.8) * 3.4 + 0.5;
        var al = 0.30 + r * 0.16;
        ctx.fillStyle = A(lit(PAL.ink, 0.65), Math.min(0.95, al));
        ctx.beginPath();
        ctx.arc(sx + Math.sin(sy * 0.02) * W * 0.01, sy, r, 0, 6.2832);
        ctx.fill();
        if (r > 2.2) blob(sx, sy, r * 4, r * 4, lit(PAL.ink, 0.5), 0.12);
      }
      // 近景大雪片（虚焦）
      for (var q = 0; q < 22; q++) {
        blob(rr(0, W), rr(0, H), W * rr(0.006, 0.018), W * rr(0.006, 0.018), lit(PAL.ink, 0.7), rr(0.10, 0.26));
      }
    }
    if (WEA === 'fog') {
      ctx.save();
      for (var f = 0; f < 9; f++) {
        var fy = rr(0.25, 1.0) * H;
        var fh = H * rr(0.05, 0.16);
        var g = ctx.createLinearGradient(0, fy - fh, 0, fy + fh);
        var fa = rr(0.10, 0.24);
        g.addColorStop(0, A(lit(LK.haze, 0.3), 0));
        g.addColorStop(0.5, A(lit(LK.haze, 0.3), fa));
        g.addColorStop(1, A(lit(LK.haze, 0.3), 0));
        ctx.fillStyle = g;
        ctx.fillRect(0, fy - fh, W, fh * 2);
      }
      ctx.restore();
    }
  }

  function lightning() {
    var x = rr(0.18, 0.82) * W;
    var y = 0;
    var pts = [[x, y]];
    var yy = 0;
    while (yy < GY * 0.94) {
      yy += H * rr(0.03, 0.08);
      x += rr(-0.045, 0.045) * W;
      pts.push([x, yy]);
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    // 云底局部辉光
    glow(pts[0][0], pts[0][1] + H * 0.05, W * 0.16, lit(PAL.ink, 0.4), 0.30);
    // 主干
    for (var pass = 0; pass < 3; pass++) {
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      ctx.strokeStyle = A(lit(PAL.ink, 0.6), 0.85 - pass * 0.28);
      ctx.lineWidth = 5 - pass * 1.6;
      ctx.stroke();
    }
    // 分叉
    for (var b = 0; b < 3; b++) {
      var s0 = pts[ri(1, pts.length - 3)];
      var bx = s0[0], by = s0[1];
      ctx.beginPath();
      ctx.moveTo(bx, by);
      for (var k = 0; k < 5; k++) {
        bx += rr(-0.03, 0.03) * W;
        by += H * rr(0.01, 0.035);
        ctx.lineTo(bx, by);
      }
      ctx.strokeStyle = A(lit(PAL.ink, 0.5), 0.45);
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ═════════ 10. 辉光叠加 / 暗角 / 颗粒 ═════════ */
  function bloomPass() {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < GLOWS.length; i++) {
      var g = GLOWS[i];
      var r = g.r * 2.4;
      if (r < 2) continue;
      ctx.fillStyle = rg(g.x, g.y, r, [[0, A(g.c, g.a * 0.30)], [0.4, A(g.c, g.a * 0.14)], [1, A(g.c, 0)]]);
      ctx.beginPath();
      ctx.arc(g.x, g.y, r, 0, 6.2832);
      ctx.fill();
    }
    ctx.restore();
  }

  function vignette() {
    var cx = W * 0.5, cy = H * 0.44;
    var rMax = Math.sqrt(W * W + H * H) * 0.62;
    var g = ctx.createRadialGradient(cx, cy, rMax * 0.30, cx, cy, rMax);
    var dark = LIGHT ? dk(P0, 0.45) : '#000000';
    var amt = LIGHT ? 0.30 : 0.62;
    g.addColorStop(0, A(dark, 0));
    g.addColorStop(0.62, A(dark, amt * 0.28));
    g.addColorStop(1, A(dark, amt));
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    // 顶部压一点，画面更沉
    ctx.fillStyle = vg(0, H * 0.14, [[0, A(dark, LIGHT ? 0.12 : 0.28)], [1, A(dark, 0)]]);
    ctx.fillRect(0, 0, W, H * 0.14);
  }

  function grain() {
    try {
      var iw = cv.width, ih = cv.height;
      var img = ctx.getImageData(0, 0, iw, ih);
      var d = img.data;
      var st = ((OPT.seed >>> 0) ^ 0x9e3779b9) >>> 0 || 7;
      var amt = LIGHT ? 8 : 13;
      for (var i = 0; i < d.length; i += 4) {
        st ^= st << 13; st >>>= 0;
        st ^= st >>> 17;
        st ^= st << 5; st >>>= 0;
        var n = ((st & 255) - 128) * (amt / 128);
        var r = d[i] + n, g = d[i + 1] + n, b = d[i + 2] + n;
        d[i] = r < 0 ? 0 : r > 255 ? 255 : r;
        d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
        d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      }
      ctx.putImageData(img, 0, 0);
    } catch (e) { /* 拿不到像素就不加颗粒，别报错 */ }
  }

  /* ═════════ 11. 标题（可选，低调压在左下） ═════════ */
  function caption() {
    if (!OPT.subtitle) return;
    ctx.save();
    var fs = Math.max(11, Math.min(W, H) * (H > W ? 0.030 : 0.024));
    ctx.font = '600 ' + fs + 'px "Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    var tx = W * 0.045, ty = H - W * 0.045;
    ctx.shadowColor = A(LIGHT ? '#ffffff' : '#000000', 0.55);
    ctx.shadowBlur = fs * 0.8;
    ctx.fillStyle = A(LIGHT ? dk(P0, 0.3) : lit(PAL.ink, 0.3), 0.82);
    ctx.fillText(OPT.subtitle, tx, ty);
    // 一条细线
    ctx.shadowBlur = 0;
    ctx.fillStyle = A(lit(PAL.c, 0.3), 0.5);
    ctx.fillRect(tx, ty + fs * 0.28, fs * 2.2, Math.max(1, fs * 0.06));
    ctx.restore();
  }

  /* ═════════ 主流程：层次顺序 fixed ═════════ */
  function draw() {
    var info = null;
    sky();                                    // 天空底
    if (SC === 'space') {
      nebula(1.0);
      stars(1.1);
      info = sceneSpace();
    } else {
      if (T === 'polar') aurora();
      nebula(T === 'polar' ? 0.8 : (T === 'night' ? 0.45 : 0.16));
      stars(LK.stars);                        // 星
      sunMoon();                              // 日月
      if (WEA === 'cloudy' || WEA === 'rain' || WEA === 'storm' || WEA === 'fog' || WEA === 'snow' || chance(0.5)) clouds();
      horizonGlow();                          // 天与地交界霞光
      if (SC === 'sea') info = sceneSea();
      else if (SC === 'lake') info = sceneLake();
      else if (SC === 'mountain') info = sceneMountain();
      else if (SC === 'forest') info = sceneForest();
      else if (SC === 'grass') info = sceneGrass();
      else if (SC === 'desert') info = sceneDesert();
      else if (SC === 'city') info = sceneCity();
      else if (SC === 'field') info = sceneField();
      else info = sceneMountain();
    }
    subjectDraw(info);                        // 主体
    atmo();                                   // 大气雾 / 霞光
    weatherFront();                           // 雨雪闪电
    bloomPass();                              // 辉光
    vignette();                               // 暗角
    grain();                                  // 颗粒
    caption();
  }

  /* 大气雾（压在远景上，薄薄几道） */
  function atmo() {
    var n = WEA === 'fog' ? 7 : (WEA === 'rain' || WEA === 'storm') ? 4 : 2;
    ctx.save();
    for (var i = 0; i < n; i++) {
      var y = GY + H * rr(-0.18, 0.22);
      var hh = H * rr(0.025, 0.12);
      var a = rr(0.08, 0.24);
      var g = ctx.createLinearGradient(0, y - hh, 0, y + hh);
      g.addColorStop(0, A(LK.haze, 0));
      g.addColorStop(0.5, A(LK.haze, a));
      g.addColorStop(1, A(LK.haze, 0));
      ctx.fillStyle = g;
      ctx.fillRect(0, y - hh, W, hh * 2);
    }
    // 地平线附近的暖/冷霞光再压一层
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = vg(GY - H * 0.10, GY + H * 0.02, [[0, A(LK.hz, 0)], [1, A(lit(LK.hz, 0.4), 0.14)]]);
    ctx.fillRect(0, GY - H * 0.10, W, H * 0.12);
    ctx.restore();
  }

  draw();
  document.documentElement.setAttribute('data-drawn', '1');
})();
`;

/* ════════════════════════ 4. 对外接口 ════════════════════════ */

export function buildSceneHtml(opt = {}) {
  const prompt = String(opt.prompt || '');
  const { w, h } = parseSceneSize(opt.size);
  const scale = Math.max(1, Math.min(4, Number(opt.scale) || 2));
  const parsed = parseScenePrompt(prompt, opt.template, opt.palette);
  const palId = parsed.palette;
  const pal = PALETTES[palId] || PALETTES.midnight;
  const seed = seedOf(prompt, opt.seed);

  const title = String(opt.title || '').trim() || titleOf(prompt);
  const subtitle = String(opt.subtitle || '').trim();

  const palJson = JSON.stringify({
    bg: [pal.bg[0], pal.bg[1], pal.bg[2]],
    a: pal.a, b: pal.b, c: pal.c, ink: pal.ink,
  });
  const optJson = JSON.stringify({
    seed, title, subtitle,
    scene: parsed.scene, time: parsed.time, weather: parsed.weather,
    subject: parsed.subject, palette: palId,
    char: parseCharFromPrompt(prompt),
  });

  // 占位符全部替换（用全局正则，一个不漏）
  const script = CLIENT_SCRIPT
    .replace(/__W__/g, String(w))
    .replace(/__H__/g, String(h))
    .replace(/__S__/g, String(scale))
    .replace(/__PAL__/g, palJson)
    .replace(/__OPT__/g, optJson)
.replace('/*__CHAR_SCRIPT__*/', CHAR_SCRIPT + String.fromCharCode(10) + actorScript());

  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
    + '<title>' + escHtml(title || 'scene') + '</title>\n'
    + '<style>html,body{margin:0;padding:0;background:#08080c;overflow:hidden}'
    + 'canvas{display:block}</style>\n</head>\n<body>\n'
    + '<canvas id="cv"></canvas>\n'
    + '<script>' + script + '<\/script>\n'
    + '</body>\n</html>\n';
}

/** 词库目录，给插件面板展示用 */
export function sceneVocab() {
  const toList = (arr) => arr.map((x) => ({ id: x.id, label: x.label }));
  return {
    subjects: toList(SUBJECTS),
    scenes: toList(SCENES),
    times: toList(TIMES),
    weathers: toList(WEATHERS),
  };
}
