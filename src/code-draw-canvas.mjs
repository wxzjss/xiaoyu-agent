/**
 * 「用代码画图」的 canvas 渲染核心（2026-11-15）。
 *
 * 旧版是本地拼 SVG，表现力有限（没法多层辉光叠加、柔光晕、颗粒噪点）。
 * 现在改成：本地拼一张 HTML（内含 canvas 2D 精细绘制脚本）→ 本机浏览器无头截一张 PNG。
 * 绘制手法照「小鱼接星星」那个游戏：多层视差星点、shadowBlur 辉光、径向星云、
 * lighter 叠加、暗角、颗粒。分辨率走 2 倍超采样，出来的是 2 倍像素的真图。
 *
 * 纯本地，不联网、不出图模型。
 */
import { PALETTES, TEMPLATES } from './code-draw-templates.mjs';

/* ---------------- 尺寸 / 选题材 / 选配色 ---------------- */

export function parseDrawSize(size) {
  const s = String(size || '').trim().toLowerCase();
  const m = s.match(/^(\d{2,5})\s*[x×*]\s*(\d{2,5})$/);
  if (m) {
    const w = Math.max(160, Math.min(4096, parseInt(m[1], 10)));
    const h = Math.max(160, Math.min(4096, parseInt(m[2], 10)));
    return { w, h };
  }
  if (/竖|portrait/.test(s)) return { w: 900, h: 1350 };
  if (/横|宽|宽屏|wide|landscape/.test(s)) return { w: 1440, h: 810 };
  if (/宽屏/.test(s)) return { w: 1600, h: 900 };
  return { w: 1024, h: 1024 };
}

const SCENE_KEYS = {
  starfield: ['星', '星空', '银河', '宇宙', '夜空', '太空', '星云', 'star', 'space', 'galaxy', 'night', 'cosmic'],
  ocean: ['海', '深海', '海底', '水', '洋', 'ocean', 'sea', 'deep', 'water', 'aqua'],
  mountains: ['山', '山脉', '山野', '峰', '森林', '森林深处', 'mountain', 'hill', 'peak', 'forest'],
  city: ['城市', '街', '楼', '都市', '夜景', '霓虹', 'city', 'urban', 'street', 'skyline'],
  planet: ['星球', '行星', '行星带', '土星', '地球', '卫星', 'planet', 'saturn', 'orbit', 'moon'],
  waves: ['波', '浪', '海面', '水波', '波纹', 'wave', 'ripple'],
  pattern: ['图案', '花纹', '几何', '壁纸', '纹理', 'pattern', 'geometric', 'texture'],
  poster: ['海报', '封面', '标题', '宣传', 'poster', 'cover', 'banner', 'title'],
};

export function pickSceneId(prompt, wanted) {
  const want = String(wanted || '').trim().toLowerCase();
  if (want && SCENE_KEYS[want]) return want;
  const p = String(prompt || '').toLowerCase();
  let best = '';
  let bestN = 0;
  for (const [id, keys] of Object.entries(SCENE_KEYS)) {
    let n = 0;
    for (const k of keys) if (p.includes(k.toLowerCase())) n += k.length > 1 ? 2 : 1;
    if (n > bestN) { bestN = n; best = id; }
  }
  return best || 'starfield';
}

const PAL_KEYS = {
  aurora: ['极光', 'aurora', '北极', '绿光'],
  midnight: ['午夜', '午夜蓝', '深蓝', '夜空', 'midnight', 'navy'],
  sunset: ['日落', '黄昏', '夕阳', '晚霞', 'sunset', 'dusk', 'orange'],
  candy: ['糖果', '粉', '甜', '少女', 'candy', 'pink', 'sweet'],
  forest: ['森林', '森野', '绿', '草', 'forest', 'green', 'moss'],
  cyber: ['赛博', '霓虹', '紫', '科幻', 'cyber', 'neon', 'purple'],
  ocean: ['海', '深海', '蓝绿', 'ocean', 'aqua'],
  mono: ['素白', '黑白', '极简', '灰', 'mono', 'white', 'minimal'],
};

export function pickPaletteId(prompt, wanted) {
  const want = String(wanted || '').trim().toLowerCase();
  if (want && PALETTES[want]) return want;
  const p = String(prompt || '').toLowerCase();
  let best = '';
  let bestN = 0;
  for (const [id, keys] of Object.entries(PAL_KEYS)) {
    let n = 0;
    for (const k of keys) if (p.includes(k.toLowerCase())) n += k.length > 1 ? 2 : 1;
    if (n > bestN) { bestN = n; best = id; }
  }
  return best || 'midnight';
}

export function extractTitleLine(prompt) {
  const p = String(prompt || '');
  const q = p.match(/[《「"“]([^》」"”]{1,18})[》」"”]/);
  if (q) return q[1].trim();
  const t = p.match(/(?:标题|题目|写上|加上文字|文字为|title)[：:\s]*([^\s，。；,;]{1,18})/i);
  if (t) return t[1].trim();
  return '';
}

function seedOf(prompt, seed) {
  if (Number.isFinite(seed) && seed > 0) return Math.floor(seed);
  let h = 2166136261;
  const s = String(prompt || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0);
}

/* ---------------- 浏览器里跑的那段绘制脚本 ---------------- */

const CLIENT_SCRIPT = String.raw`
(function(){
  var W = __W__, H = __H__, S = __S__;
  var PAL = __PAL__, OPT = __OPT__;
  var cv = document.getElementById('cv');
  cv.width = Math.round(W * S); cv.height = Math.round(H * S);
  cv.style.width = (W * S) + 'px'; cv.style.height = (H * S) + 'px';
  var ctx = cv.getContext('2d');
  ctx.scale(S, S);

  function RNG(a){ return function(){ a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  var R = RNG(OPT.seed || 1);
  function rn(a, b){ return a + R() * (b - a); }
  function ri(a, b){ return Math.floor(rn(a, b + 1)); }

  function hx(Hx, a){
    Hx = String(Hx).replace('#','');
    if (Hx.length === 3) Hx = Hx[0]+Hx[0]+Hx[1]+Hx[1]+Hx[2]+Hx[2];
    var n = parseInt(Hx, 16) || 0;
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (a == null ? 1 : a) + ')';
  }
  function mix(A, B, t){
    function p(x){ x = String(x).replace('#',''); if (x.length === 3) x = x[0]+x[0]+x[1]+x[1]+x[2]+x[2]; var n = parseInt(x,16)||0; return [(n>>16)&255,(n>>8)&255,n&255]; }
    var a = p(A), b = p(B);
    var c = [0,0,0].map(function(_, i){ return Math.round(a[i] + (b[i]-a[i])*t); });
    return '#' + c.map(function(v){ return ('0' + v.toString(16)).slice(-2); }).join('');
  }
  function lum(Hx){ Hx = String(Hx).replace('#',''); if (Hx.length===3) Hx=Hx[0]+Hx[0]+Hx[1]+Hx[1]+Hx[2]+Hx[2]; var n=parseInt(Hx,16)||0; return (((n>>16)&255)*0.299 + ((n>>8)&255)*0.587 + (n&255)*0.114)/255; }

  function vgrad(x0,y0,x1,y1,stops){
    var g = ctx.createLinearGradient(x0,y0,x1,y1);
    stops.forEach(function(s){ g.addColorStop(Math.max(0,Math.min(1,s[0])), s[1]); });
    return g;
  }
  function rgrad(x,y,r,stops){
    var g = ctx.createRadialGradient(x,y,0,x,y,Math.max(0.01,r));
    stops.forEach(function(s){ g.addColorStop(Math.max(0,Math.min(1,s[0])), s[1]); });
    return g;
  }
  function blob(x,y,r,color,al){
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgrad(x,y,r,[[0,hx(color,al)],[0.45,hx(color,al*0.42)],[0.75,hx(color,al*0.12)],[1,hx(color,0)]]);
    ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.fill(); ctx.restore();
  }
  function ellipseBlob(x,y,rx,ry,rot,color,al){
    ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.translate(x,y); ctx.rotate(rot||0);
    ctx.scale(1, ry/Math.max(0.01,rx));
    ctx.fillStyle = rgrad(0,0,rx,[[0,hx(color,al)],[0.5,hx(color,al*0.34)],[1,hx(color,0)]]);
    ctx.beginPath(); ctx.arc(0,0,rx,0,6.2832); ctx.fill(); ctx.restore();
  }
  function dot(x,y,r,color,al,blur){
    ctx.save();
    if (blur) { ctx.shadowBlur = blur; ctx.shadowColor = hx(color, Math.min(1, al * 1.5)); }
    ctx.fillStyle = hx(color, al);
    ctx.beginPath(); ctx.arc(x,y,r,0,6.2832); ctx.fill();
    ctx.restore();
  }
  function spark(x,y,len,color,al){
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    var g1 = vgrad(x-len,y,x+len,y,[[0,hx(color,0)],[0.5,hx(color,al)],[1,hx(color,0)]]);
    ctx.fillStyle = g1; ctx.fillRect(x-len, y-0.55, len*2, 1.1);
    var g2 = vgrad(x,y-len,x,y+len,[[0,hx(color,0)],[0.5,hx(color,al)],[1,hx(color,0)]]);
    ctx.fillStyle = g2; ctx.fillRect(x-0.55, y-len, 1.1, len*2);
    ctx.restore();
  }
  function vignette(k){
    var g = rgrad(W*0.5,H*0.5,Math.min(W,H)*0.28,[[0,'rgba(0,0,0,0)'],[0.62,'rgba(0,0,0,'+(k*0.35)+')'],[1,'rgba(0,0,0,'+k+')']]);
    ctx.save(); ctx.fillStyle = g; ctx.fillRect(0,0,W,H); ctx.restore();
  }
  function grain(amt){
    var c = ctx.canvas, W2 = c.width, H2 = c.height;
    var img; try { img = ctx.getImageData(0,0,W2,H2); } catch(e) { return; }
    var d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var n = (Math.random() * 2 - 1) * amt;
      d[i] += n; d[i+1] += n; d[i+2] += n;
    }
    ctx.putImageData(img, 0, 0);
  }
  function star4(x,y,sp,len,inner,rot){
    ctx.beginPath();
    for (var i = 0; i < sp*2; i++){
      var rr = (i % 2 === 0) ? len : inner;
      var a = rot + i * Math.PI / sp;
      var px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
      if (i === 0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.closePath();
  }
  function roundRect(x,y,w2,h2,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y); ctx.lineTo(x+w2-r,y); ctx.quadraticCurveTo(x+w2,y,x+w2,y+r);
    ctx.lineTo(x+w2,y+h2-r); ctx.quadraticCurveTo(x+w2,y+h2,x+w2-r,y+h2);
    ctx.lineTo(x+r,y+h2); ctx.quadraticCurveTo(x,y+h2,x,y+h2-r);
    ctx.lineTo(x,y+r); ctx.quadraticCurveTo(x,y,x+r,y); ctx.closePath();
  }

  /* ---------- 共用：星点层 ---------- */
  function starLayer(count, rMin, rMax, aMin, aMax, color, blurMax){
    for (var i = 0; i < count; i++){
      var x = rn(0,W), y = rn(0,H);
      var r = rn(rMin, rMax);
      var a = rn(aMin, aMax);
      // 越靠近中心越亮一点，制造密集感
      var dx = (x - W*0.5)/(W*0.5), dy = (y - H*0.5)/(H*0.5);
      var d = Math.sqrt(dx*dx + dy*dy);
      a *= (1.06 - d * 0.22);
      if (a <= 0.02) continue;
      dot(x, y, r, color, Math.min(1, a), blurMax ? rn(blurMax*0.4, blurMax) : 0);
    }
  }
  function milkyWay(){
    var ang = rn(-0.95, -0.35) + (R() > 0.5 ? 0.9 : 0);
    var cx = W * rn(0.4, 0.62), cy = H * rn(0.4, 0.6);
    ctx.save();
    ctx.translate(cx, cy); ctx.rotate(ang);
    var len = Math.max(W,H) * 0.95, thick = Math.min(W,H) * rn(0.10, 0.17);
    for (var i = 0; i < 7; i++){
      var ox = rn(-len*0.2, len*0.2), oy = rn(-thick*0.25, thick*0.25);
      ellipseBlob(ox, oy, len*rn(0.35,0.75), thick*rn(0.5,1.0), 0, i%2 ? PAL.b : PAL.a, rn(0.05,0.11));
    }
    for (var j = 0; j < 1400; j++){
      var t = rn(-1, 1), spread = thick * (0.35 + Math.abs(t)*0.8) * rn(0.15, 1);
      var px = t * len * 0.5, py = rn(-spread, spread);
      var rr = rn(0.22, 0.85) * (1 - Math.abs(t) * 0.35);
      var al = rn(0.10, 0.55) * (1 - Math.abs(t) * 0.45);
      dot(px, py, Math.max(0.18, rr), R() > 0.78 ? PAL.c : '#ffffff', al);
    }
    ctx.restore();
  }
  function meteors(n){
    for (var i = 0; i < n; i++){
      var x = rn(W*0.05, W*0.95), y = rn(0, H*0.6);
      var len = rn(60, 210) * (Math.min(W,H)/1000);
      var a = rn(0.25, 0.95) + Math.PI * rn(0.12, 0.22);
      var x2 = x + Math.cos(a)*len, y2 = y + Math.sin(a)*len;
      var g = ctx.createLinearGradient(x,y,x2,y2);
      g.addColorStop(0, hx('#ffffff', 0)); g.addColorStop(0.65, hx('#ffffff', rn(0.28,0.62))); g.addColorStop(1, hx(PAL.c, 0));
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = g; ctx.lineWidth = rn(0.9, 2.3); ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x,y); ctx.lineTo(x2,y2); ctx.stroke();
      dot(x2, y2, rn(0.8,1.6), '#ffffff', 0.9, 8);
      ctx.restore();
    }
  }

  /* ---------- 场景：星空 ---------- */
  function scStarfield(){
    ctx.fillStyle = vgrad(0,0,W*0.3,H,[[0,PAL.bg[0]],[0.45,mix(PAL.bg[0],PAL.bg[1],0.75)],[0.78,PAL.bg[1]],[1,'#02030a']]);
    ctx.fillRect(0,0,W,H);
    // 大尺度星云
    for (var i = 0; i < 6; i++){
      blob(rn(-W*0.05, W*1.05), rn(-H*0.05, H*0.95), Math.min(W,H)*rn(0.18,0.46),
        [PAL.a, PAL.b, PAL.c][i % 3], rn(0.05, 0.15));
    }
    milkyWay();
    starLayer(1100, 0.28, 0.7, 0.10, 0.42, '#dfe9ff', 0);
    starLayer(320, 0.55, 1.15, 0.28, 0.78, '#eaf2ff', 2.5);
    starLayer(46, 1.0, 2.1, 0.5, 1.0, '#ffffff', 9);
    // 亮星十字芒
    for (var k = 0; k < 14; k++){
      var x = rn(W*0.04, W*0.96), y = rn(H*0.02, H*0.92);
      var l = rn(7, 26);
      dot(x,y, rn(1.0,2.0), '#ffffff', 0.95, 10);
      spark(x, y, l, k % 3 === 0 ? PAL.c : '#ffffff', rn(0.18,0.5));
    }
    meteors(5);
    // 远处山脊剪影
    var baseY = H * rn(0.80, 0.88), amp = Math.min(W,H) * rn(0.05,0.10);
    var ph = rn(0, 6.28), gap = rn(0.0022, 0.0052);
    for (var layer = 0; layer < 2; layer++){
      ctx.beginPath(); ctx.moveTo(-2, H+2);
      for (var x2 = -2; x2 <= W+2; x2 += 3){
        var t2 = x2 / W;
        var y2 = baseY + layer*amp*0.55 - amp*(0.55 + 0.45*Math.sin(t2*Math.PI*1.7 + ph) + 0.35*Math.sin(t2*Math.PI*4.3 + ph*1.7) + 0.18*Math.sin(t2*Math.PI*11.0 + ph*2.3));
        ctx.lineTo(x2, y2);
      }
      ctx.lineTo(W+2, H+2); ctx.closePath();
      var gy = vgrad(0, baseY - amp*1.6, 0, H, [[0, layer ? '#01040c' : mix(PAL.bg[1], '#000000', 0.45)],[1,'#000000']]);
      ctx.fillStyle = gy; ctx.globalAlpha = layer ? 1 : 0.92; ctx.fill(); ctx.globalAlpha = 1;
    }
    // 山脊轮廓微光
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    blob(W*rn(0.35,0.65), baseY - amp*0.6, Math.min(W,H)*0.22, PAL.a, 0.05);
    ctx.restore();
    vignette(0.62);
    grain(5.5);
  }

  /* ---------- 场景：深海 ---------- */
  function scOcean(){
    ctx.fillStyle = vgrad(0,0,0,H,[[0,mix(PAL.bg[2],'#8fe4ff',0.22)],[0.16,PAL.bg[1]],[0.55,mix(PAL.bg[0],'#04121c',0.4)],[1,'#01060c']]);
    ctx.fillRect(0,0,W,H);
    // 水面亮带
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = vgrad(0,0,0,H*0.22,[[0,hx('#bff4ff',0.30)],[0.45,hx('#7fd8ff',0.10)],[1,hx('#7fd8ff',0)]]);
    ctx.fillRect(0,0,W,H*0.24);
    ctx.restore();
    // 光柱
    for (var i = 0; i < 9; i++){
      var x0 = rn(-W*0.1, W*1.05), wid = rn(W*0.012, W*0.11);
      var drop = rn(H*0.55, H*1.05), tilt = rn(-W*0.16, W*0.16);
      var g = ctx.createLinearGradient(x0,0,x0+tilt,drop);
      var al = rn(0.05, 0.15);
      g.addColorStop(0, hx('#d8f7ff', al));
      g.addColorStop(0.35, hx('#9fe6ff', al*0.55));
      g.addColorStop(1, hx('#9fe6ff', 0));
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = g; ctx.beginPath();
      ctx.moveTo(x0 - wid*0.5, -10); ctx.lineTo(x0 + wid*0.5, -10);
      ctx.lineTo(x0 + tilt + wid*1.7, drop); ctx.lineTo(x0 + tilt - wid*1.7, drop);
      ctx.closePath(); ctx.fill(); ctx.restore();
    }
    // 焦散波纹
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (var c = 0; c < 26; c++){
      var y = rn(0, H*0.35), x = rn(-W*0.1, W*1.1);
      var lw = rn(W*0.05, W*0.3);
      ctx.strokeStyle = hx('#cdf6ff', rn(0.03,0.10));
      ctx.lineWidth = rn(0.6, 2.0);
      ctx.beginPath();
      for (var t = 0; t <= lw; t += 4){
        var yy = y + Math.sin(t*0.05 + c) * rn(2, 9);
        if (t === 0) ctx.moveTo(x+t, yy); else ctx.lineTo(x+t, yy);
      }
      ctx.stroke();
    }
    ctx.restore();
    // 远景剪影（海沟/礁石）
    for (var l = 0; l < 2; l++){
      ctx.beginPath(); ctx.moveTo(-2, H+2);
      var base = H * (0.72 + l*0.14), amp = H * rn(0.05, 0.1), ph = rn(0,6.28);
      for (var x2 = -2; x2 <= W+2; x2 += 4){
        var tt = x2/W;
        ctx.lineTo(x2, base - amp*(0.5 + 0.5*Math.sin(tt*Math.PI*(2.2+l) + ph) + 0.3*Math.sin(tt*Math.PI*7 + ph)));
      }
      ctx.lineTo(W+2, H+2); ctx.closePath();
      ctx.fillStyle = l ? '#00060c' : mix(PAL.bg[0], '#000000', 0.55);
      ctx.fill();
    }
    // 悬浮微粒
    for (var p = 0; p < 420; p++){
      var px = rn(0,W), py = rn(0,H);
      var a2 = rn(0.06, 0.5) * (1 - py/H*0.4);
      dot(px, py, rn(0.3, 1.5), R() > 0.7 ? PAL.a : '#e8fbff', a2, R() > 0.9 ? 4 : 0);
    }
    // 气泡
    for (var b = 0; b < 34; b++){
      var bx = rn(0,W), by = rn(H*0.15, H), br = rn(2, 7);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hx('#dff8ff', rn(0.10, 0.30)); ctx.lineWidth = rn(0.5, 1.1);
      ctx.beginPath(); ctx.arc(bx, by, br, 0, 6.2832); ctx.stroke();
      dot(bx - br*0.3, by - br*0.35, br*0.22, '#ffffff', 0.5, 0);
      ctx.restore();
    }
    blob(W*rn(0.2,0.8), -H*0.05, W*0.5, '#9be9ff', 0.06);
    vignette(0.66);
    grain(5);
  }

  /* ---------- 场景：山野 ---------- */
  function scMountains(){
    var warm = lum(PAL.bg[2] || PAL.bg[1]) > 0.35;
    ctx.fillStyle = vgrad(0,0,0,H,[[0,PAL.bg[0]],[0.34,mix(PAL.bg[1],PAL.bg[2],0.5)],[0.62,PAL.bg[2]],[1,mix(PAL.bg[1],'#000000',0.55)]]);
    ctx.fillRect(0,0,W,H);
    // 星（黄昏时少些）
    starLayer(warm ? 220 : 620, 0.3, 0.9, 0.06, 0.35, '#eaf2ff', 0);
    // 日/月
    var sx = W * rn(0.24, 0.76), sy = H * rn(0.20, 0.34), sr = Math.min(W,H) * rn(0.05, 0.09);
    blob(sx, sy, sr*7.5, PAL.c, 0.16);
    blob(sx, sy, sr*3.2, PAL.c, 0.26);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = rgrad(sx, sy, sr, [[0,'rgba(255,255,255,0.98)'],[0.62,hx(PAL.c,0.92)],[1,hx(PAL.c,0.55)]]);
    ctx.beginPath(); ctx.arc(sx,sy,sr,0,6.2832); ctx.fill(); ctx.restore();
    // 云带
    for (var i = 0; i < 16; i++){
      var cy = H * rn(0.06, 0.55);
      ellipseBlob(W*rn(-0.05,1.05), cy, W*rn(0.12,0.42), H*rn(0.006,0.028), rn(-0.05,0.05),
        R() > 0.55 ? '#ffffff' : PAL.c, rn(0.05, 0.16));
    }
    // 四层山
    var layers = 4;
    for (var l = 0; l < layers; l++){
      var k = l / (layers - 1);
      var base = H * (0.44 + k * 0.42);
      var amp = Math.min(W,H) * (0.20 - k * 0.055) * rn(0.85, 1.2);
      var ph = rn(0, 6.28);
      var col = mix(mix(PAL.bg[1], PAL.bg[2], 0.3), '#05070d', 0.25 + k * 0.6);
      var shadeCol = mix(col, '#000000', 0.35 + k*0.35);
      ctx.beginPath(); ctx.moveTo(-2, H+2);
      var segs = 5 + l;
      for (var x = -2; x <= W+2; x += 3){
        var t = x / W;
        var y = base;
        y -= amp * (0.55 + 0.45*Math.sin(t*Math.PI*1.35 + ph));
        y -= amp * 0.32 * Math.sin(t*Math.PI*(2 + l*1.2) + ph*1.9);
        y -= amp * 0.14 * Math.sin(t*Math.PI*(6.5 + l) + ph*3.1);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(W+2, H+2); ctx.closePath();
      ctx.fillStyle = vgrad(0, base - amp, 0, H, [[0, col],[0.55, shadeCol],[1, mix(shadeCol,'#000000',0.6)]]);
      ctx.fill();
      // 层间雾
      var fogY = base - amp * 0.30;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = vgrad(0, fogY, 0, fogY + H*0.13, [[0, hx('#ffffff', 0.13 - k*0.06)],[1, hx('#ffffff', 0)]]);
      ctx.fillRect(0, fogY, W, H*0.14);
      ctx.restore();
    }
    // 前景剪影 + 树
    ctx.fillStyle = '#01030a';
    ctx.beginPath(); ctx.moveTo(-2,H+2);
    for (var x3 = -2; x3 <= W+2; x3 += 3){
      var t3 = x3/W;
      var y3 = H * 0.955 - H*0.045*(0.5 + 0.5*Math.sin(t3*Math.PI*2.6 + 1.2));
      ctx.lineTo(x3, y3);
    }
    ctx.lineTo(W+2,H+2); ctx.closePath(); ctx.fill();
    for (var tr = 0; tr < 16; tr++){
      var tx = rn(-W*0.02, W*1.02), ty = H * rn(0.90, 0.985), th = H * rn(0.05, 0.16), tw = th * rn(0.28, 0.46);
      ctx.fillStyle = '#01030a';
      ctx.beginPath(); ctx.moveTo(tx, ty - th);
      ctx.lineTo(tx - tw*0.5, ty); ctx.lineTo(tx + tw*0.5, ty); ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(tx, ty - th*0.72);
      ctx.lineTo(tx - tw*0.36, ty - th*0.22); ctx.lineTo(tx + tw*0.36, ty - th*0.22); ctx.closePath(); ctx.fill();
    }
    vignette(0.55);
    grain(6);
  }

  /* ---------- 场景：城市 ---------- */
  function scCity(){
    ctx.fillStyle = vgrad(0,0,0,H*0.8,[[0,mix(PAL.bg[0],'#000018',0.4)],[0.32,PAL.bg[0]],[0.58,mix(PAL.bg[1],PAL.bg[2],0.55)],[0.82,PAL.bg[2]],[1,mix(PAL.bg[2],'#000000',0.5)]]);
    ctx.fillRect(0,0,W,H);
    starLayer(300, 0.3, 0.9, 0.05, 0.30, '#dfe9ff', 0);
    var sx = W*rn(0.2,0.8), sy = H*rn(0.22,0.40);
    blob(sx, sy, Math.min(W,H)*0.5, PAL.c, 0.13);
    for (var i = 0; i < 14; i++){
      ellipseBlob(W*rn(-0.05,1.05), H*rn(0.06,0.55), W*rn(0.12,0.40), H*rn(0.006,0.03), rn(-0.06,0.06), PAL.c, rn(0.04,0.13));
    }
    // 三层楼群
    var floors = 3;
    for (var l = 0; l < floors; l++){
      var k = l / (floors - 1);
      var baseY = H * (0.70 + k * 0.24);
      var maxH = H * (0.30 - k * 0.10);
      var col = mix(mix(PAL.bg[0],PAL.bg[1],0.5), '#050810', 0.25 + k*0.55);
      var x = -W*0.03;
      while (x < W*1.03){
        var bw = W * rn(0.028, 0.085) * (1 - k*0.25);
        var bh = maxH * rn(0.25, 1.0);
        var by = baseY - bh;
        ctx.fillStyle = col;
        ctx.fillRect(x, by, bw, bh + H);
        // 顶
        if (R() > 0.6){ ctx.fillRect(x + bw*0.3, by - bh*0.05, bw*0.4, bh*0.05); }
        if (R() > 0.78){ ctx.fillRect(x + bw*0.46, by - bh*0.16, Math.max(1.2,bw*0.05), bh*0.16); }
        // 窗
        var cols = Math.max(2, Math.floor(bw / (W*0.016)));
        var rows = Math.max(3, Math.floor(bh / (H*0.035)));
        var ww = bw / (cols*1.9), wh = (bh / (rows*1.75)) * 0.62;
        for (var c2 = 0; c2 < cols; c2++){
          for (var r2 = 0; r2 < rows; r2++){
            if (R() > (0.42 + k*0.2)) continue;
            var wx = x + bw*0.10 + c2 * (bw*0.90/cols);
            var wy = by + bh*0.08 + r2 * (bh*0.88/rows);
            var wc = R() > 0.7 ? '#ffffff' : (R() > 0.35 ? PAL.c : PAL.a);
            ctx.save(); ctx.globalCompositeOperation = 'lighter';
            ctx.fillStyle = hx(wc, rn(0.25, 0.85) * (1 - k*0.25));
            ctx.fillRect(wx, wy, Math.max(1, ww), Math.max(1.2, wh));
            ctx.restore();
          }
        }
        x += bw + W*rn(0.001, 0.012);
      }
      // 楼间雾
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = vgrad(0, baseY - H*0.03, 0, baseY + H*0.12, [[0, hx(PAL.c, 0.10 - k*0.03)],[1, hx(PAL.c, 0)]]);
      ctx.fillRect(0, baseY - H*0.03, W, H*0.15);
      ctx.restore();
    }
    // 地面反光
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = vgrad(0, H*0.94, 0, H, [[0, hx(PAL.c, 0.16)],[1, hx(PAL.a, 0.05)]]);
    ctx.fillRect(0, H*0.94, W, H*0.06);
    ctx.restore();
    for (var b2 = 0; b2 < 5; b2++){
      blob(W*rn(0.05,0.95), H*rn(0.86,0.99), Math.min(W,H)*rn(0.06,0.16), R()>0.5?PAL.c:PAL.a, rn(0.05,0.13));
    }
    vignette(0.60);
    grain(5.5);
  }

  /* ---------- 场景：星球 ---------- */
  function scPlanet(){
    ctx.fillStyle = vgrad(0,0,W*0.4,H,[[0,PAL.bg[0]],[0.5,mix(PAL.bg[0],PAL.bg[1],0.7)],[1,'#02040c']]);
    ctx.fillRect(0,0,W,H);
    for (var i = 0; i < 4; i++) blob(rn(0,W), rn(0,H), Math.min(W,H)*rn(0.2,0.5), [PAL.a,PAL.b][i%2], rn(0.04,0.10));
    milkyWay();
    starLayer(900, 0.28, 0.75, 0.10, 0.45, '#e6efff', 0);
    starLayer(220, 0.6, 1.2, 0.3, 0.8, '#ffffff', 3);
    var px = W*rn(0.46,0.56), py = H*rn(0.44,0.54), pr = Math.min(W,H)*rn(0.24,0.30);
    // 大气辉光
    blob(px, py, pr*2.0, PAL.a, 0.11);
    blob(px, py, pr*1.35, PAL.b, 0.16);
    // 星球本体
    ctx.save();
    ctx.beginPath(); ctx.arc(px,py,pr,0,6.2832); ctx.clip();
    var lx = px - pr*0.42, ly = py - pr*0.44;
    ctx.fillStyle = rgrad(lx, ly, pr*2.0, [
      [0, mix(PAL.a,'#ffffff',0.42)],
      [0.28, PAL.a],
      [0.55, mix(PAL.a, PAL.b, 0.7)],
      [0.78, mix(PAL.b,'#04101f',0.55)],
      [1, '#020610']]);
    ctx.fillRect(px-pr, py-pr, pr*2, pr*2);
    // 表面条纹
    for (var s = 0; s < 26; s++){
      var yy = py - pr + pr*2*(s/26) + rn(-4,4);
      ctx.strokeStyle = hx(R() > 0.5 ? '#ffffff' : PAL.c, rn(0.02, 0.09));
      ctx.lineWidth = rn(1, pr*0.09);
      ctx.beginPath();
      ctx.ellipse(px, yy, pr*rn(0.9,1.25), pr*rn(0.03,0.12), rn(-0.12,0.12), 0, 6.2832);
      ctx.stroke();
    }
    // 陨坑
    for (var cr = 0; cr < 26; cr++){
      var cx = px + rn(-pr, pr), cy = py + rn(-pr, pr);
      if (Math.hypot(cx-px, cy-py) > pr*0.97) continue;
      var crr = pr * rn(0.012, 0.075);
      ctx.fillStyle = hx('#000000', rn(0.06,0.20));
      ctx.beginPath(); ctx.arc(cx, cy, crr, 0, 6.2832); ctx.fill();
      ctx.strokeStyle = hx('#ffffff', rn(0.04,0.14)); ctx.lineWidth = crr*0.22;
      ctx.beginPath(); ctx.arc(cx, cy, crr*1.02, -2.4, 0.7); ctx.stroke();
    }
    // 明暗终结
    ctx.fillStyle = rgrad(px + pr*0.55, py + pr*0.5, pr*1.9, [[0,'rgba(0,0,0,0.86)'],[0.55,'rgba(0,0,0,0.42)'],[1,'rgba(0,0,0,0)']]);
    ctx.fillRect(px-pr, py-pr, pr*2, pr*2);
    ctx.restore();
    // 边缘高光
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hx(mix(PAL.a,'#ffffff',0.5), 0.42); ctx.lineWidth = Math.max(1.2, pr*0.012);
    ctx.beginPath(); ctx.arc(px, py, pr*0.995, -2.5, 0.9); ctx.stroke();
    ctx.restore();
    // 环
    ctx.save();
    ctx.translate(px, py); ctx.rotate(rn(-0.42,-0.20));
    var rx = pr*rn(1.5,1.8), ry = pr*rn(0.30,0.40);
    for (var band = 0; band < 7; band++){
      var k2 = band/7;
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hx(band % 2 ? PAL.b : PAL.c, rn(0.06, 0.20));
      ctx.lineWidth = pr*rn(0.02, 0.075);
      ctx.beginPath(); ctx.ellipse(0,0, rx*(0.72+k2*0.34), ry*(0.72+k2*0.34), 0, 0, 6.2832); ctx.stroke();
      ctx.restore();
    }
    ctx.restore();
    // 环在球前的那半段（遮住下半）
    ctx.save();
    ctx.translate(px, py); ctx.rotate(rn(-0.42,-0.20));
    ctx.beginPath(); ctx.ellipse(0,0, rx*1.06, ry*1.06, 0, 0, Math.PI); 
    ctx.restore();
    // 卫星
    var mx = px + pr*rn(1.3, 2.0) * (R() > 0.5 ? 1 : -1), my = py - pr*rn(0.7, 1.4);
    blob(mx, my, pr*0.5, '#ffffff', 0.10);
    ctx.fillStyle = rgrad(mx - pr*0.06, my - pr*0.06, pr*0.20, [[0,'#f3f7ff'],[0.6,'#b9c6dd'],[1,'#3d4c66']]);
    ctx.beginPath(); ctx.arc(mx, my, pr*rn(0.10,0.17), 0, 6.2832); ctx.fill();
    meteors(2);
    vignette(0.60);
    grain(5);
  }

  /* ---------- 场景：波纹 ---------- */
  function scWaves(){
    ctx.fillStyle = vgrad(0,0,W*0.25,H,[[0,PAL.bg[0]],[0.42,mix(PAL.bg[1],PAL.bg[0],0.4)],[0.75,PAL.bg[1]],[1,mix(PAL.bg[2]||PAL.bg[1],'#000000',0.45)]]);
    ctx.fillRect(0,0,W,H);
    blob(W*rn(0.25,0.75), H*rn(0.12,0.3), Math.min(W,H)*0.55, PAL.c, 0.09);
    var lines = 26;
    for (var i = 0; i < lines; i++){
      var t = i/(lines-1);
      var y0 = H*(0.18 + t*0.80);
      var amp = Math.min(W,H)*rn(0.008, 0.035) * (0.6 + t*1.1);
      var freq = rn(1.6, 4.2), ph = rn(0, 6.2832);
      var col = i % 3 === 0 ? PAL.c : (i % 3 === 1 ? PAL.a : PAL.b);
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      ctx.strokeStyle = hx(col, rn(0.10, 0.42) * (0.45 + t*0.8));
      ctx.lineWidth = rn(0.6, 2.4) * (0.5 + t);
      if (i % 4 === 0){ ctx.shadowBlur = 12; ctx.shadowColor = hx(col, 0.5); }
      ctx.beginPath();
      for (var x = -2; x <= W+2; x += 3){
        var tt = x / W;
        var y = y0 + Math.sin(tt*Math.PI*freq + ph) * amp + Math.sin(tt*Math.PI*(freq*2.3) + ph*1.7) * amp*0.35;
        if (x === -2) ctx.moveTo(x,y); else ctx.lineTo(x,y);
      }
      ctx.stroke(); ctx.restore();
    }
    // 波峰高光粒子
    for (var p = 0; p < 260; p++){
      var px = rn(0,W), py = rn(H*0.2, H);
      dot(px, py, rn(0.3,1.3), R()>0.6 ? PAL.c : '#ffffff', rn(0.08,0.45), R()>0.9?5:0);
    }
    vignette(0.58);
    grain(5);
  }

  /* ---------- 场景：图案 ---------- */
  function scPattern(){
    ctx.fillStyle = vgrad(0,0,W,H,[[0,PAL.bg[0]],[0.5,mix(PAL.bg[1],PAL.bg[0],0.4)],[1,PAL.bg[2]||PAL.bg[1]]]);
    ctx.fillRect(0,0,W,H);
    blob(W*0.5, H*0.5, Math.min(W,H)*0.62, PAL.a, 0.10);
    var step = Math.min(W,H) / rn(11, 16);
    for (var gy = -1; gy < H/step + 2; gy++){
      for (var gx = -1; gx < W/step + 2; gx++){
        var cx = gx*step + (gy % 2 ? step*0.5 : 0), cy = gy*step;
        var dd = Math.hypot(cx - W*0.5, cy - H*0.5) / (Math.min(W,H)*0.62);
        var sc = Math.max(0.24, 1.15 - dd*0.85) * step * 0.36;
        var col = (gx + gy) % 3 === 0 ? PAL.c : ((gx+gy) % 3 === 1 ? PAL.a : PAL.b);
        var al = 0.28 + 0.55*(1-Math.min(1,dd));
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        var mode = (gx*3 + gy*7) % 4;
        if (mode === 0){
          ctx.strokeStyle = hx(col, al*0.75); ctx.lineWidth = Math.max(0.8, step*0.035);
          ctx.beginPath(); ctx.arc(cx, cy, sc, 0, 6.2832); ctx.stroke();
        } else if (mode === 1){
          ctx.fillStyle = hx(col, al*0.35);
          ctx.beginPath(); ctx.arc(cx, cy, sc*0.55, 0, 6.2832); ctx.fill();
        } else if (mode === 2){
          ctx.strokeStyle = hx(col, al*0.6); ctx.lineWidth = Math.max(0.7, step*0.028);
          star4(cx, cy, 4, sc*1.05, sc*0.34, Math.PI/4); ctx.stroke();
        } else {
          ctx.strokeStyle = hx(col, al*0.45); ctx.lineWidth = Math.max(0.7, step*0.025);
          roundRect(cx - sc*0.72, cy - sc*0.72, sc*1.44, sc*1.44, sc*0.22); ctx.stroke();
        }
        ctx.restore();
      }
    }
    blob(W*0.5, H*0.5, Math.min(W,H)*0.30, PAL.c, 0.12);
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hx(PAL.ink, 0.16); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(W*0.5, H*0.5, Math.min(W,H)*0.30, 0, 6.2832); ctx.stroke();
    ctx.restore();
    vignette(0.52);
    grain(5.5);
  }

  /* ---------- 场景：海报 ---------- */
  function scPoster(){
    ctx.fillStyle = vgrad(0,0,W*0.6,H,[[0,PAL.bg[0]],[0.45,mix(PAL.bg[1],PAL.bg[0],0.35)],[1,mix(PAL.bg[2]||PAL.bg[1],'#000000',0.35)]]);
    ctx.fillRect(0,0,W,H);
    // 斜光束
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (var i = 0; i < 5; i++){
      var x0 = rn(-W*0.2, W*0.8), wd = rn(W*0.04, W*0.22);
      var g = ctx.createLinearGradient(x0,0,x0 + W*0.6, H);
      g.addColorStop(0, hx(i%2?PAL.a:PAL.c, rn(0.05,0.13)));
      g.addColorStop(1, hx(i%2?PAL.a:PAL.c, 0));
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(x0, -10); ctx.lineTo(x0+wd, -10);
      ctx.lineTo(x0+wd+W*0.45, H+10); ctx.lineTo(x0+W*0.45, H+10); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    blob(W*rn(0.3,0.7), H*rn(0.25,0.45), Math.min(W,H)*0.55, PAL.c, 0.13);
    // 大装饰弧
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (var a = 0; a < 5; a++){
      ctx.strokeStyle = hx(a%2?PAL.a:PAL.b, 0.10 - a*0.014); ctx.lineWidth = rn(1, 2.6);
      ctx.beginPath(); ctx.arc(W*rn(0.2,0.8), H*rn(0.3,0.8), Math.min(W,H)*rn(0.22,0.62), rn(0,2), rn(3,6)); ctx.stroke();
    }
    ctx.restore();
    // 细网格
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    ctx.strokeStyle = hx(PAL.ink, 0.05); ctx.lineWidth = 1;
    var gs = Math.min(W,H)/22;
    for (var gx = 0; gx < W; gx += gs){ ctx.beginPath(); ctx.moveTo(gx,0); ctx.lineTo(gx,H); ctx.stroke(); }
    for (var gy = 0; gy < H; gy += gs){ ctx.beginPath(); ctx.moveTo(0,gy); ctx.lineTo(W,gy); ctx.stroke(); }
    ctx.restore();
    for (var p = 0; p < 200; p++){
      dot(rn(0,W), rn(0,H), rn(0.3,1.2), R()>0.6?PAL.c:'#ffffff', rn(0.06,0.4), R()>0.9?4:0);
    }
    vignette(0.50);
    grain(5);
  }

  var SCENES = { starfield: scStarfield, ocean: scOcean, mountains: scMountains, city: scCity,
                 planet: scPlanet, waves: scWaves, pattern: scPattern, poster: scPoster };

  (SCENES[OPT.tpl] || scStarfield)();

  /* ---------- 标题排版（可选） ---------- */
  if (OPT.title){
    var fs1 = Math.round(Math.min(W, H) * (OPT.title.length > 8 ? 0.070 : 0.092));
    var ty = H * 0.845;
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    ctx.font = '700 ' + fs1 + 'px "Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';
    // 标题底衬（提升可读）
    var bgW = Math.min(W*0.92, ctx.measureText(OPT.title).width + fs1*1.6);
    var gg = vgrad(0, ty - fs1*1.35, 0, ty + fs1*0.55, [[0, hx('#000000', 0)],[0.35, hx('#000000', 0.45)],[1, hx('#000000', 0)]]);
    ctx.fillStyle = gg; ctx.fillRect((W-bgW)/2 - fs1*0.4, ty - fs1*1.35, bgW + fs1*0.8, fs1*1.95);
    ctx.shadowBlur = fs1 * 0.42; ctx.shadowColor = hx(PAL.c, 0.75);
    ctx.fillStyle = hx(PAL.ink, 0.97);
    ctx.fillText(OPT.title, W/2, ty);
    ctx.shadowBlur = 0;
    // 装饰线
    ctx.globalCompositeOperation = 'lighter';
    var lg = vgrad(W/2 - fs1*1.7, 0, W/2 + fs1*1.7, 0, [[0,hx(PAL.c,0)],[0.5,hx(PAL.c,0.9)],[1,hx(PAL.c,0)]]);
    ctx.fillStyle = lg;
    ctx.fillRect(W/2 - fs1*1.7, ty + fs1*0.30, fs1*3.4, Math.max(1.6, fs1*0.045));
    if (OPT.subtitle){
      var fs2 = Math.round(fs1 * 0.32);
      ctx.font = '400 ' + fs2 + 'px "Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",sans-serif';
      ctx.fillStyle = hx(PAL.ink, 0.70);
      ctx.fillText(OPT.subtitle, W/2, ty + fs1*0.78);
    }
    ctx.restore();
  }

  document.documentElement.setAttribute('data-drawn', '1');
})();
`;

/* ---------------- 拼 HTML ---------------- */

export const CANVAS_TEMPLATE_LABELS = {
  starfield: '星空', ocean: '深海', mountains: '山野', city: '城市',
  planet: '星球', waves: '波纹', pattern: '图案', poster: '海报',
};

/**
 * 生成一张可直接截图的 HTML。opt: { prompt, size, template, palette, title, subtitle, seed, scale }
 * 返回 { html, w, h, tplId, palId, seed, title, subtitle, scale }
 */
export function buildDrawHtml(opt = {}) {
  const prompt = String(opt.prompt || '');
  const { w, h } = parseDrawSize(opt.size);
  const tplId = pickSceneId(prompt, opt.template);
  const palId = pickPaletteId(prompt, opt.palette);
  const seed = seedOf(prompt, opt.seed);
  const pal = PALETTES[palId] || PALETTES.midnight;
  let title = String(opt.title || '').trim() || extractTitleLine(prompt);
  const subtitle = String(opt.subtitle || '').trim();
  if (title.length > 20) title = title.slice(0, 20);
  // 2 倍超采样：出来是 w*2 × h*2 的真像素
  const scale = Number(opt.scale) || 2;

  const palObj = {
    bg: pal.bg || ['#08101d', '#0d1c31', '#123049'],
    a: pal.a || '#7cf2c8',
    b: pal.b || '#63b3ff',
    c: pal.c || '#f9f871',
    ink: pal.ink || '#eaf7ff',
  };

  const script = CLIENT_SCRIPT
    .replace('__W__', String(w))
    .replace('__H__', String(h))
    .replace('__S__', String(scale))
    .replace('__PAL__', JSON.stringify(palObj))
    .replace('__OPT__', JSON.stringify({ tpl: tplId, seed, title, subtitle }));

  const html = '<!doctype html><html><head><meta charset="utf-8">' +
    '<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}' +
    'canvas{display:block}</style></head><body>' +
    '<canvas id="cv"></canvas><script>' + script + '</script></body></html>';

  return { html, w, h, tplId, palId, seed, title, subtitle, scale };
}

/** 给插件面板用的一句话说明 */
export function canvasDrawSummary() {
  return {
    templates: Object.entries(CANVAS_TEMPLATE_LABELS).map(([id, label]) => ({ id, label })),
    palettes: Object.entries(PALETTES).map(([id, p]) => ({ id, label: p.label })),
    supersample: 2,
  };
}

// 老变量名保留，别让别处 import 挂掉
export { TEMPLATES };
