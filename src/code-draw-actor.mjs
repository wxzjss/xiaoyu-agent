/**
 * 角色绘制层（Q 版人物）
 * 返回一段注入到画布脚本里的函数源码，约定闭包里已有 ctx / PAL / rr / rnd 等。
 * 局部坐标：translate(cx,baseY) + scale(s,s)，所以 y=0 是脚底、y=-1 是头顶。
 */

export function actorScript() {
  return String.raw`
/* ═══════════════ 角色绘制层（Q 版） ═══════════════ */
function wgEll(x, y, rx, ry, rot) {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot || 0, 0, 6.2832);
}
function wgPath(pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (var i = 1; i < pts.length; i++) {
    var p = pts[i];
    if (p.length === 6) ctx.bezierCurveTo(p[0], p[1], p[2], p[3], p[4], p[5]);
    else if (p.length === 4) ctx.quadraticCurveTo(p[0], p[1], p[2], p[3]);
    else ctx.lineTo(p[0], p[1]);
  }
  ctx.closePath();
}


/* 一只眼睛：Q 版大眼，带虹膜渐变 + 双高光 + 上睫毛 */
function wgEye(ex, ey, P, flip) {
  var EY = P.eye, EYD = P.eyeD, EYL = P.eyeL, LASH = P.lash;
  ctx.save();
  /* 眼眶柔影 */
  wgEll(ex, ey + 0.004, 0.062, 0.076);
  ctx.fillStyle = 'rgba(120,90,90,0.13)';
  ctx.fill();
  /* 眼白 */
  wgEll(ex, ey, 0.056, 0.070);
  var gw = ctx.createRadialGradient(ex, ey - 0.03, 0.004, ex, ey, 0.070);
  gw.addColorStop(0, '#FFFFFF');
  gw.addColorStop(0.72, '#F3F8FF');
  gw.addColorStop(1, '#D6E2F2');
  ctx.fillStyle = gw;
  ctx.fill();
  /* 虹膜 */
  ctx.save();
  wgEll(ex, ey, 0.049, 0.061);
  ctx.clip();
  var gi = ctx.createRadialGradient(ex, ey - 0.026, 0.004, ex, ey + 0.006, 0.062);
  gi.addColorStop(0, EYL);
  gi.addColorStop(0.42, EY);
  gi.addColorStop(1, EYD);
  ctx.fillStyle = gi;
  ctx.fillRect(ex - 0.07, ey - 0.08, 0.14, 0.16);
  /* 下半部反光弧 */
  var gl = ctx.createLinearGradient(ex, ey + 0.02, ex, ey + 0.062);
  gl.addColorStop(0, 'rgba(255,255,255,0)');
  gl.addColorStop(1, 'rgba(190,235,255,0.55)');
  ctx.fillStyle = gl;
  ctx.fillRect(ex - 0.07, ey + 0.01, 0.14, 0.06);
  ctx.restore();
  /* 瞳孔 */
  wgEll(ex, ey + 0.005, 0.023, 0.031);
  ctx.fillStyle = 'rgba(9,22,45,0.95)';
  ctx.fill();
  /* 高光 */
  wgEll(ex - 0.017, ey - 0.024, 0.017, 0.021);
  ctx.fillStyle = 'rgba(255,255,255,0.97)';
  ctx.fill();
  wgEll(ex + 0.020, ey + 0.021, 0.009, 0.010);
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fill();
  wgEll(ex - 0.026, ey + 0.019, 0.006, 0.006);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.fill();
  /* 上睫毛（粗弧，眼尾上挑） */
  ctx.strokeStyle = LASH;
  ctx.lineWidth = 0.016;
  ctx.lineCap = 'round';
  ctx.beginPath();
  var dir = flip ? -1 : 1;
  ctx.moveTo(ex - dir * 0.050, ey - 0.036);
  ctx.quadraticCurveTo(ex, ey - 0.082, ex + dir * 0.056, ey - 0.030);
  ctx.stroke();
  /* 眼尾尖 */
  ctx.beginPath();
  ctx.moveTo(ex + dir * 0.050, ey - 0.044);
  ctx.quadraticCurveTo(ex + dir * 0.074, ey - 0.060, ex + dir * 0.080, ey - 0.052);
  ctx.quadraticCurveTo(ex + dir * 0.068, ey - 0.046, ex + dir * 0.052, ey - 0.028);
  ctx.closePath();
  ctx.fillStyle = LASH;
  ctx.fill();
  /* 下眼线 */
  ctx.strokeStyle = 'rgba(40,60,90,0.35)';
  ctx.lineWidth = 0.007;
  ctx.beginPath();
  ctx.moveTo(ex - dir * 0.034, ey + 0.058);
  ctx.quadraticCurveTo(ex + dir * 0.010, ey + 0.072, ex + dir * 0.044, ey + 0.048);
  ctx.stroke();
  ctx.restore();
}


/* 鲸鱼鳍耳：头侧向后上翘的一片鳍 */
function wgFin(ex, ey, P, flip) {
  var d = flip ? -1 : 1;
  ctx.save();
  ctx.translate(ex, ey);
  ctx.scale(d, 1);
  wgPath([
    [0.00, -0.052],
    [0.075, -0.100, 0.150, -0.075, 0.170, -0.010],
    [0.140, 0.032, 0.060, 0.030, 0.005, 0.006]
  ]);
  var g = ctx.createLinearGradient(0, -0.10, 0.16, 0.03);
  g.addColorStop(0, P.finL);
  g.addColorStop(0.55, P.fin);
  g.addColorStop(1, P.finD);
  ctx.fillStyle = g;
  ctx.fill();
  ctx.strokeStyle = 'rgba(20,50,90,0.35)';
  ctx.lineWidth = 0.007;
  ctx.stroke();
  /* 鳍纹 */
  ctx.strokeStyle = 'rgba(255,255,255,0.42)';
  ctx.lineWidth = 0.006;
  for (var i = 0; i < 3; i++) {
    var t = 0.045 + i * 0.028;
    ctx.beginPath();
    ctx.moveTo(t * 0.7, -0.028 + i * 0.010);
    ctx.quadraticCurveTo(t + 0.035, -0.036 + i * 0.014, t + 0.075, -0.008 + i * 0.014);
    ctx.stroke();
  }
  ctx.restore();
}


/* 荷叶边蕾丝：沿一条弧刷一圈小扇贝，用来做头饰/领口/裙摆 */
function wgRuffle(cx, cy, r0, r1, a0, a1, n, col, colD) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r1, a0, a1);
  ctx.arc(cx, cy, r0, a1, a0, true);
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
  /* 扇贝波边 */
  var step = (a1 - a0) / n;
  for (var i = 0; i < n; i++) {
    var a = a0 + step * (i + 0.5);
    var px = cx + Math.cos(a) * r1;
    var py = cy + Math.sin(a) * r1;
    ctx.beginPath();
    ctx.arc(px, py, Math.abs(step) * r1 * 0.58, 0, 6.2832);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.strokeStyle = colD;
    ctx.lineWidth = 0.004;
    ctx.stroke();
  }
  ctx.restore();
}


/* ═══ 主入口：一个 Q 版鲸鱼娘 ═══ */
function wgGirl(cx, baseY, s, o) {
  o = o || {};
  var c = o.colors || {};
  var P = {
    skin: c.skin || '#FFE7DA',
    skinD: c.skinD || '#EFB9A6',
    skinL: c.skinL || '#FFF7F2',
    hair1: c.hair1 || '#131F35',
    hair2: c.hair2 || '#294B7C',
    hair3: c.hair3 || '#6BA6DD',
    hair4: c.hair4 || '#B6E2FF',
    dress: c.dress || '#1B2B52',
    dressD: c.dressD || '#0F1830',
    dressL: c.dressL || '#34527F',
    white: c.white || '#FAFCFF',
    whiteD: c.whiteD || '#D3E1F4',
    blue: c.blue || '#3F7DB6',
    blueD: c.blueD || '#25537F',
    blueL: c.blueL || '#8FC9EE',
    eye: c.eye || '#2F82D8',
    eyeD: c.eyeD || '#0C2A55',
    eyeL: c.eyeL || '#A6E2FF',
    lash: c.lash || '#1A2740',
    fin: c.fin || '#3E86C4',
    finD: c.finD || '#1E4D7C',
    finL: c.finL || '#9ED6F6',
    lip: c.lip || '#B8485C',
    tongue: c.tongue || '#E8798D',
    blush: c.blush || 'rgba(255,132,152,0.5)'
  };

  ctx.save();
  ctx.translate(cx, baseY);
  ctx.scale(s, s);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  /* 脚下投影 */
  var gsh = ctx.createRadialGradient(0, -0.015, 0.01, 0, -0.015, 0.30);
  gsh.addColorStop(0, 'rgba(6,12,26,0.40)');
  gsh.addColorStop(1, 'rgba(6,12,26,0)');
  ctx.fillStyle = gsh;
  wgEll(0, -0.015, 0.30, 0.055);
  ctx.fill();

  /* ── 1. 鲸尾（身后）── */
  ctx.save();
  wgPath([
    [0.05, -0.34],
    [0.20, -0.40, 0.34, -0.44, 0.44, -0.42],
    [0.50, -0.52, 0.62, -0.58, 0.74, -0.54],
    [0.66, -0.44, 0.58, -0.34, 0.52, -0.26],
    [0.60, -0.20, 0.70, -0.20, 0.78, -0.24],
    [0.64, -0.14, 0.52, -0.18, 0.40, -0.24],
    [0.26, -0.26, 0.14, -0.26, 0.02, -0.24]
  ]);
  var gt = ctx.createLinearGradient(0.05, -0.50, 0.78, -0.14);
  gt.addColorStop(0, P.finD);
  gt.addColorStop(0.45, P.fin);
  gt.addColorStop(1, P.finL);
  ctx.fillStyle = gt;
  ctx.fill();
  ctx.strokeStyle = 'rgba(14,40,72,0.40)';
  ctx.lineWidth = 0.008;
  ctx.stroke();
  /* 尾柄高光 */
  ctx.strokeStyle = 'rgba(210,244,255,0.35)';
  ctx.lineWidth = 0.014;
  ctx.beginPath();
  ctx.moveTo(0.12, -0.355);
  ctx.quadraticCurveTo(0.30, -0.425, 0.46, -0.395);
  ctx.stroke();
  ctx.restore();

  /* ── 2. 后发（长发铺到身后）── */
  wgPath([
    [-0.196, -0.930],
    [-0.300, -0.780, -0.318, -0.420, -0.268, -0.250],
    [-0.232, -0.150, -0.130, -0.160, -0.098, -0.270],
    [-0.066, -0.180, -0.028, -0.170, 0.000, -0.262],
    [0.028, -0.170, 0.066, -0.180, 0.098, -0.270],
    [0.130, -0.160, 0.232, -0.150, 0.268, -0.250],
    [0.318, -0.420, 0.300, -0.780, 0.196, -0.930]
  ]);
  var gh = ctx.createLinearGradient(-0.30, -0.95, 0.30, 0.00);
  gh.addColorStop(0, P.hair2);
  gh.addColorStop(0.42, P.hair1);
  gh.addColorStop(0.80, P.hair2);
  gh.addColorStop(1, P.hair3);
  ctx.fillStyle = gh;
  ctx.fill();
  /* 发丝暗部 */
  ctx.strokeStyle = 'rgba(8,16,32,0.30)';
  ctx.lineWidth = 0.008;
  ctx.beginPath();
  ctx.moveTo(-0.24, -0.78);
  ctx.quadraticCurveTo(-0.30, -0.45, -0.265, -0.14);
  ctx.moveTo(0.24, -0.78);
  ctx.quadraticCurveTo(0.30, -0.45, 0.265, -0.14);
  ctx.stroke();
  /* 发尾亮边 */
  ctx.strokeStyle = 'rgba(140,200,240,0.35)';
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  ctx.moveTo(-0.30, -0.30);
  ctx.quadraticCurveTo(-0.33, -0.40, -0.315, -0.13);
  ctx.moveTo(0.30, -0.30);
  ctx.quadraticCurveTo(0.33, -0.40, 0.315, -0.13);
  ctx.stroke();

  /* ── 2.5 腿 + 小皮鞋（2026-11-16 加：以前裙子直接拖到地，像圆锥）── */
  for (var lg = -1; lg <= 1; lg += 2) {
    var gleg = ctx.createLinearGradient(lg * 0.030, -0.200, lg * 0.100, -0.010);
    gleg.addColorStop(0, P.skinD);
    gleg.addColorStop(0.35, P.skin);
    gleg.addColorStop(1, P.skinL);
    wgPath([
      [lg * 0.040, -0.200],
      [lg * 0.086, -0.196, lg * 0.092, -0.120, lg * 0.090, -0.052],
      [lg * 0.088, -0.030, lg * 0.062, -0.030, lg * 0.054, -0.052],
      [lg * 0.052, -0.120, lg * 0.046, -0.170, lg * 0.034, -0.200]
    ]);
    ctx.fillStyle = gleg;
    ctx.fill();
    ctx.strokeStyle = 'rgba(214,150,132,0.45)';
    ctx.lineWidth = 0.004;
    ctx.stroke();
    /* 小皮鞋（深蓝，带一档高光） */
    var gsh2 = ctx.createLinearGradient(lg * 0.05, -0.055, lg * 0.05, 0.002);
    gsh2.addColorStop(0, P.dressL);
    gsh2.addColorStop(0.55, P.dress);
    gsh2.addColorStop(1, P.dressD);
    wgPath([
      [lg * 0.040, -0.056],
      [lg * 0.098, -0.050, lg * 0.104, -0.016, lg * 0.100, 0.000],
      [lg * 0.060, 0.004, lg * 0.026, 0.004, lg * 0.018, -0.004],
      [lg * 0.020, -0.030, lg * 0.030, -0.050, lg * 0.040, -0.056]
    ]);
    ctx.fillStyle = gsh2;
    ctx.fill();
    ctx.strokeStyle = 'rgba(8,18,36,0.55)';
    ctx.lineWidth = 0.004;
    ctx.stroke();
    ctx.strokeStyle = 'rgba(190,225,255,0.45)';
    ctx.lineWidth = 0.005;
    ctx.beginPath();
    ctx.moveTo(lg * 0.052, -0.042);
    ctx.quadraticCurveTo(lg * 0.082, -0.040, lg * 0.094, -0.022);
    ctx.stroke();
    /* 袜口一圈白边（跟女仆装呼应） */
    ctx.strokeStyle = 'rgba(250,252,255,0.9)';
    ctx.lineWidth = 0.010;
    ctx.beginPath();
    ctx.moveTo(lg * 0.038, -0.062);
    ctx.quadraticCurveTo(lg * 0.072, -0.058, lg * 0.096, -0.062);
    ctx.stroke();
  }

  /* ── 3. 裙子（钟形）── */
  wgPath([
    [-0.150, -0.548],
    [-0.190, -0.430, -0.240, -0.300, -0.286, -0.200],
    [0.000, -0.162, 0.000, -0.162, 0.286, -0.200],
    [0.240, -0.250, 0.190, -0.430, 0.150, -0.548]
  ]);
  var gd = ctx.createLinearGradient(-0.28, -0.55, 0.28, -0.07);
  gd.addColorStop(0, P.dressL);
  gd.addColorStop(0.35, P.dress);
  gd.addColorStop(1, P.dressD);
  ctx.fillStyle = gd;
  ctx.fill();
  /* 裙褶 */
  ctx.strokeStyle = 'rgba(10,20,42,0.35)';
  ctx.lineWidth = 0.007;
  for (var f = -2; f <= 2; f++) {
    ctx.beginPath();
    ctx.moveTo(f * 0.045, -0.500);
    ctx.quadraticCurveTo(f * 0.085, -0.330, f * 0.115, -0.190);
    ctx.stroke();
  }
  /* 裙面高光 */
  ctx.strokeStyle = 'rgba(150,200,245,0.28)';
  ctx.lineWidth = 0.012;
  ctx.beginPath();
  ctx.moveTo(-0.120, -0.500);
  ctx.quadraticCurveTo(-0.175, -0.330, -0.210, -0.212);
  ctx.stroke();

  /* 裙摆荷叶边（白） */
  wgPath([
    [-0.286, -0.200],
    [0.000, -0.162, 0.000, -0.162, 0.286, -0.200],
    [0.300, -0.152, 0.290, -0.122, 0.250, -0.120],
    [0.130, -0.112, 0.060, -0.122, 0.000, -0.116],
    [-0.060, -0.122, -0.130, -0.112, -0.250, -0.120],
    [-0.290, -0.122, -0.300, -0.152, -0.286, -0.200]
  ]);
  ctx.fillStyle = P.white;
  ctx.fill();
  ctx.strokeStyle = P.whiteD;
  ctx.lineWidth = 0.005;
  ctx.stroke();
  /* 裙摆扇贝 */
  for (var b2 = 0; b2 < 9; b2++) {
    var bx = -0.25 + b2 * 0.0625;
    ctx.beginPath();
    ctx.arc(bx, -0.122, 0.032, 0, Math.PI);
    ctx.fillStyle = P.white;
    ctx.fill();
    ctx.strokeStyle = P.whiteD;
    ctx.lineWidth = 0.004;
    ctx.stroke();
  }

  /* ── 4. 白围裙 ── */
  wgPath([
    [-0.108, -0.520],
    [-0.130, -0.400, -0.168, -0.300, -0.192, -0.255],
    [-0.096, -0.225, 0.000, -0.217, 0.192, -0.255],
    [0.168, -0.260, 0.130, -0.400, 0.108, -0.520]
  ]);
  var ga = ctx.createLinearGradient(-0.19, -0.52, 0.19, -0.22);
  ga.addColorStop(0, P.white);
  ga.addColorStop(0.55, '#F2F7FF');
  ga.addColorStop(1, P.whiteD);
  ctx.fillStyle = ga;
  ctx.fill();
  ctx.strokeStyle = 'rgba(150,175,210,0.55)';
  ctx.lineWidth = 0.005;
  ctx.stroke();
  /* 围裙上的小鲸鱼 */
  ctx.save();
  ctx.translate(0, -0.330);
  ctx.fillStyle = P.blue;
  wgEll(-0.004, 0.012, 0.046, 0.030);
  ctx.fill();
  wgPath([[-0.044, 0.012], [-0.062, -0.006, -0.078, 0.002, -0.070, 0.022], [-0.060, 0.032, -0.048, 0.026, -0.042, 0.020]]);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  wgEll(0.014, 0.004, 0.022, 0.010);
  ctx.fill();
  ctx.fillStyle = 'rgba(14,40,72,0.85)';
  wgEll(0.022, 0.014, 0.0055, 0.0065);
  ctx.fill();
  ctx.strokeStyle = 'rgba(14,40,72,0.5)';
  ctx.lineWidth = 0.004;
  ctx.beginPath();
  ctx.arc(0.028, 0.026, 0.014, -0.3, 1.3);
  ctx.stroke();
  ctx.restore();
  /* 围裙腰线 */
  ctx.strokeStyle = 'rgba(150,175,210,0.5)';
  ctx.lineWidth = 0.006;
  ctx.beginPath();
  ctx.moveTo(-0.140, -0.230);
  ctx.quadraticCurveTo(0, -0.212, 0.140, -0.230);
  ctx.stroke();

  /* ── 5. 上半身（深蓝胸衣）── */
  wgPath([
    [-0.150, -0.548],
    [-0.160, -0.505, -0.150, -0.470, -0.132, -0.452],
    [0.000, -0.436, 0.000, -0.436, 0.132, -0.452],
    [0.150, -0.470, 0.160, -0.505, 0.150, -0.548]
  ]);
  var gc = ctx.createLinearGradient(-0.15, -0.55, 0.15, -0.44);
  gc.addColorStop(0, P.dressL);
  gc.addColorStop(1, P.dress);
  ctx.fillStyle = gc;
  ctx.fill();

  /* ── 6. 领口荷叶边 ── */
  ctx.save();
  wgPath([
    [-0.150, -0.552],
    [-0.090, -0.575, -0.040, -0.585, 0.000, -0.585],
    [0.040, -0.585, 0.090, -0.575, 0.150, -0.552],
    [0.110, -0.520, 0.060, -0.505, 0.000, -0.505],
    [-0.060, -0.505, -0.110, -0.520, -0.150, -0.552]
  ]);
  ctx.fillStyle = P.white;
  ctx.fill();
  ctx.strokeStyle = P.whiteD;
  ctx.lineWidth = 0.005;
  ctx.stroke();
  for (var r2 = 0; r2 < 7; r2++) {
    var rx2 = -0.105 + r2 * 0.035;
    ctx.beginPath();
    ctx.arc(rx2, -0.508, 0.019, 0, Math.PI);
    ctx.fillStyle = P.white;
    ctx.fill();
    ctx.strokeStyle = P.whiteD;
    ctx.lineWidth = 0.004;
    ctx.stroke();
  }
  ctx.restore();
  /* 领结 */
  ctx.save();
  ctx.fillStyle = P.blueD;
  wgPath([[-0.012, -0.560], [-0.058, -0.582, -0.070, -0.540, -0.014, -0.548]]);
  ctx.fill();
  wgPath([[0.012, -0.560], [0.058, -0.582, 0.070, -0.540, 0.014, -0.548]]);
  ctx.fill();
  wgEll(0.000, -0.554, 0.014, 0.014);
  ctx.fillStyle = P.blue;
  ctx.fill();
  ctx.restore();

  /* ── 7. 包子袖 ── */
  for (var sd = -1; sd <= 1; sd += 2) {
    ctx.save();
    ctx.translate(sd * 0.163, -0.492);
    var gs = ctx.createRadialGradient(-0.02, -0.03, 0.006, 0, 0, 0.098);
    gs.addColorStop(0, '#FFFFFF');
    gs.addColorStop(0.6, P.white);
    gs.addColorStop(1, P.whiteD);
    wgEll(0, 0, 0.086, 0.076, sd * 0.12);
    ctx.fillStyle = gs;
    ctx.fill();
    ctx.strokeStyle = 'rgba(140,168,205,0.55)';
    ctx.lineWidth = 0.005;
    ctx.stroke();
    /* 袖褶 */
    ctx.strokeStyle = 'rgba(150,175,210,0.5)';
    ctx.lineWidth = 0.005;
    for (var k2 = -1; k2 <= 1; k2++) {
      ctx.beginPath();
      ctx.moveTo(k2 * 0.028, -0.062);
      ctx.quadraticCurveTo(k2 * 0.038, -0.010, k2 * 0.026, 0.052);
      ctx.stroke();
    }
    /* 袖口 */
    ctx.beginPath();
    ctx.arc(0, 0.062, 0.036, 0.2, Math.PI - 0.2);
    ctx.strokeStyle = P.blue;
    ctx.lineWidth = 0.012;
    ctx.stroke();
    ctx.restore();
  }

  /* ── 8. 手臂 + 手 ── */
  for (var ad = -1; ad <= 1; ad += 2) {
    ctx.save();
    ctx.strokeStyle = P.skin;
    ctx.lineWidth = 0.050;
    ctx.beginPath();
    ctx.moveTo(ad * 0.176, -0.440);
    ctx.quadraticCurveTo(ad * 0.225, -0.360, ad * 0.212, -0.268);
    ctx.stroke();
    /* 手 */
    ctx.translate(ad * 0.214, -0.258);
    var gh2 = ctx.createRadialGradient(-0.012, -0.012, 0.004, 0, 0, 0.048);
    gh2.addColorStop(0, P.skinL);
    gh2.addColorStop(1, P.skin);
    wgEll(0, 0, 0.040, 0.040);
    ctx.fillStyle = gh2;
    ctx.fill();
    ctx.strokeStyle = 'rgba(190,140,125,0.5)';
    ctx.lineWidth = 0.005;
    ctx.stroke();
    /* 手指缝 */
    ctx.strokeStyle = 'rgba(180,125,112,0.45)';
    ctx.lineWidth = 0.004;
    ctx.beginPath();
    ctx.moveTo(-0.014, 0.026); ctx.lineTo(-0.012, 0.040);
    ctx.moveTo(0.004, 0.030); ctx.lineTo(0.005, 0.043);
    ctx.stroke();
    ctx.restore();
  }

  /* ── 9. 脖子 ── */
  var gn = ctx.createLinearGradient(-0.04, -0.60, 0.04, -0.52);
  gn.addColorStop(0, P.skin);
  gn.addColorStop(1, P.skinD);
  wgPath([[-0.048, -0.585], [0.048, -0.585], [0.042, -0.516], [-0.042, -0.516]]);
  ctx.fillStyle = gn;
  ctx.fill();

  /* ── 10. 脸 ── */
  ctx.save();
  wgEll(0, -0.775, 0.235, 0.228);
  var gface = ctx.createRadialGradient(-0.075, -0.855, 0.020, 0.000, -0.775, 0.290);
  gface.addColorStop(0, P.skinL);
  gface.addColorStop(0.55, P.skin);
  gface.addColorStop(1, P.skinD);
  ctx.fillStyle = gface;
  ctx.fill();
  /* 下颌边光 */
  ctx.strokeStyle = 'rgba(232,168,148,0.55)';
  ctx.lineWidth = 0.006;
  ctx.beginPath();
  ctx.arc(0, -0.775, 0.232, 0.45, 2.05);
  ctx.stroke();
  ctx.restore();

  /* 耳朵（被鳍耳盖住一半，露一点点） */
  for (var ed = -1; ed <= 1; ed += 2) {
    wgEll(ed * 0.226, -0.772, 0.026, 0.038);
    ctx.fillStyle = P.skin;
    ctx.fill();
    ctx.strokeStyle = 'rgba(228,160,140,0.55)';
    ctx.lineWidth = 0.005;
    ctx.stroke();
  }

  /* ── 11. 五官 ── */
  /* 眉毛 */
  ctx.strokeStyle = 'rgba(46,62,90,0.72)';
  ctx.lineWidth = 0.011;
  for (var bd = -1; bd <= 1; bd += 2) {
    ctx.beginPath();
    ctx.moveTo(bd * 0.048, -0.868);
    ctx.quadraticCurveTo(bd * 0.086, -0.890, bd * 0.124, -0.868);
    ctx.stroke();
  }
  /* 眼睛 */
  wgEye(-0.088, -0.788, P, true);
  wgEye(0.088, -0.788, P, false);
  /* 腮红 */
  for (var cd = -1; cd <= 1; cd += 2) {
    var gb = ctx.createRadialGradient(cd * 0.158, -0.712, 0.004, cd * 0.158, -0.712, 0.062);
    gb.addColorStop(0, P.blush);
    gb.addColorStop(1, 'rgba(255,132,152,0)');
    ctx.fillStyle = gb;
    wgEll(cd * 0.158, -0.712, 0.062, 0.040);
    ctx.fill();
    /* 腮红斜线 */
    ctx.strokeStyle = 'rgba(240,120,140,0.35)';
    ctx.lineWidth = 0.005;
    for (var s3 = 0; s3 < 3; s3++) {
      ctx.beginPath();
      ctx.moveTo(cd * (0.140 + s3 * 0.014), -0.700 + s3 * 0.004);
      ctx.lineTo(cd * (0.132 + s3 * 0.014), -0.690 + s3 * 0.004);
      ctx.stroke();
    }
  }
  /* 鼻子 */
  ctx.strokeStyle = 'rgba(226,158,138,0.85)';
  ctx.lineWidth = 0.008;
  ctx.beginPath();
  ctx.moveTo(-0.012, -0.716);
  ctx.quadraticCurveTo(0.000, -0.706, 0.013, -0.716);
  ctx.stroke();
  /* 张嘴笑 */
  ctx.save();
  wgPath([
    [-0.052, -0.672],
    [0.000, -0.650, 0.000, -0.650, 0.052, -0.672],
    [0.030, -0.598, -0.030, -0.598, -0.052, -0.672]
  ]);
  var gm = ctx.createLinearGradient(0, -0.672, 0, -0.596);
  gm.addColorStop(0, '#8E2F44');
  gm.addColorStop(1, P.lip);
  ctx.fillStyle = gm;
  ctx.fill();
  ctx.save();
  wgPath([
    [-0.052, -0.672],
    [0.000, -0.650, 0.000, -0.650, 0.052, -0.672],
    [0.030, -0.598, -0.030, -0.598, -0.052, -0.672]
  ]);
  ctx.clip();
  /* 舌头 */
  wgEll(0, -0.612, 0.034, 0.021);
  ctx.fillStyle = P.tongue;
  ctx.fill();
  ctx.restore();
  /* 上排小牙 */
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  wgPath([[-0.036, -0.668], [0.000, -0.652, 0.000, -0.652, 0.036, -0.668], [0.030, -0.656, -0.030, -0.656, -0.036, -0.668]]);
  ctx.fill();
  /* 唇线 */
  ctx.strokeStyle = 'rgba(120,40,58,0.65)';
  ctx.lineWidth = 0.006;
  wgPath([
    [-0.052, -0.672],
    [0.000, -0.650, 0.000, -0.650, 0.052, -0.672],
    [0.030, -0.598, -0.030, -0.598, -0.052, -0.672]
  ]);
  ctx.stroke();
  ctx.restore();

  /* ── 12. 前刘海 ── */
  wgPath([
    [-0.238, -0.790],
    [-0.232, -0.930, -0.140, -1.010, 0.000, -1.012],
    [0.140, -1.010, 0.232, -0.930, 0.238, -0.790],
    [0.196, -0.812, 0.150, -0.836, 0.116, -0.824],
    [0.088, -0.870, 0.040, -0.884, 0.006, -0.856],
    [-0.020, -0.892, -0.062, -0.900, -0.090, -0.850],
    [-0.130, -0.860, -0.180, -0.836, -0.238, -0.790]
  ]);
  var gfh = ctx.createLinearGradient(-0.24, -1.01, 0.24, -0.78);
  gfh.addColorStop(0, P.hair1);
  gfh.addColorStop(0.42, P.hair2);
  gfh.addColorStop(0.75, P.hair1);
  gfh.addColorStop(1, P.hair3);
  ctx.fillStyle = gfh;
  ctx.fill();
  /* 刘海分缕暗线 */
  ctx.strokeStyle = 'rgba(8,16,32,0.42)';
  ctx.lineWidth = 0.007;
  ctx.beginPath();
  ctx.moveTo(-0.108, -0.980);
  ctx.quadraticCurveTo(-0.086, -0.900, -0.092, -0.848);
  ctx.moveTo(0.010, -1.000);
  ctx.quadraticCurveTo(0.020, -0.910, 0.010, -0.856);
  ctx.moveTo(0.118, -0.960);
  ctx.quadraticCurveTo(0.128, -0.890, 0.118, -0.824);
  ctx.stroke();
  /* 刘海高光带 */
  ctx.strokeStyle = 'rgba(150,205,245,0.42)';
  ctx.lineWidth = 0.020;
  ctx.beginPath();
  ctx.moveTo(-0.180, -0.930);
  ctx.quadraticCurveTo(-0.100, -0.978, 0.010, -0.982);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(200,238,255,0.28)';
  ctx.lineWidth = 0.010;
  ctx.beginPath();
  ctx.moveTo(0.052, -0.972);
  ctx.quadraticCurveTo(0.140, -0.950, 0.196, -0.876);
  ctx.stroke();

  /* ── 13. 侧发（耳前两缕，垂到肩）── */
  for (var ld = -1; ld <= 1; ld += 2) {
    ctx.save();
    wgPath([
      [ld * 0.196, -0.900],
      [ld * 0.268, -0.800, ld * 0.272, -0.620, ld * 0.246, -0.470],
      [ld * 0.226, -0.440, ld * 0.196, -0.452, ld * 0.190, -0.500],
      [ld * 0.212, -0.640, ld * 0.204, -0.800, ld * 0.164, -0.884]
    ]);
    var gsd = ctx.createLinearGradient(ld * 0.18, -0.90, ld * 0.26, -0.44);
    gsd.addColorStop(0, P.hair2);
    gsd.addColorStop(0.6, P.hair1);
    gsd.addColorStop(1, P.hair3);
    ctx.fillStyle = gsd;
    ctx.fill();
    ctx.strokeStyle = 'rgba(150,205,245,0.30)';
    ctx.lineWidth = 0.008;
    ctx.beginPath();
    ctx.moveTo(ld * 0.238, -0.856);
    ctx.quadraticCurveTo(ld * 0.258, -0.680, ld * 0.238, -0.500);
    ctx.stroke();
    ctx.restore();
  }

  /* ── 14. 鲸鳍耳 ── */
  wgFin(-0.214, -0.842, P, true);
  wgFin(0.214, -0.842, P, false);

  /* ── 15. 荷叶边头饰（白色蕾丝，头顶两侧）── */
  for (var hd = -1; hd <= 1; hd += 2) {
    ctx.save();
    ctx.translate(hd * 0.150, -0.968);
    ctx.rotate(hd * -0.42);
    ctx.fillStyle = P.white;
    wgEll(0, 0, 0.070, 0.036);
    ctx.fill();
    ctx.strokeStyle = P.whiteD;
    ctx.lineWidth = 0.005;
    ctx.stroke();
    for (var r3 = 0; r3 < 4; r3++) {
      ctx.beginPath();
      ctx.arc(-0.048 + r3 * 0.032, -0.030, 0.018, 0, Math.PI);
      ctx.fillStyle = P.white;
      ctx.fill();
      ctx.strokeStyle = P.whiteD;
      ctx.lineWidth = 0.004;
      ctx.stroke();
    }
    /* 小蓝珠 */
    ctx.beginPath();
    ctx.arc(0.000, 0.006, 0.010, 0, 6.2832);
    ctx.fillStyle = P.blue;
    ctx.fill();
    ctx.restore();
  }

  /* ── 16. 整体逆光边缘 ── */
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgba(170,225,255,0.28)';
  ctx.lineWidth = 0.008;
  ctx.beginPath();
  ctx.arc(0, -0.775, 0.242, -2.45, -0.60);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(170,225,255,0.20)';
  ctx.beginPath();
  ctx.moveTo(-0.300, -0.240);
  ctx.quadraticCurveTo(-0.290, -0.080, -0.240, -0.030);
  ctx.moveTo(0.300, -0.240);
  ctx.quadraticCurveTo(0.290, -0.080, 0.240, -0.030);
  ctx.stroke();
  ctx.restore();

  ctx.restore();
}
`;
}
