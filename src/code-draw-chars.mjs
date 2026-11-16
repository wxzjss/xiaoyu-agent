// ============================================================
// code-draw-chars.mjs —— 通用场景合成器 · 角色绘制库
//
// 【被谁拼】src/code-draw-scene.mjs 的 buildSceneHtml() 会把本文件导出的
//   CHAR_SCRIPT 字符串原样拼进生成的 HTML（canvas 客户端脚本的 IIFE 内部），
//   与场景脚本共用同一个作用域、同一套工具函数。
//
// 【能用哪些工具】（场景脚本已提供，这里不许重复定义）：
//   ctx                  canvas 2d 上下文
//   W, H                 画布宽 / 高
//   PAL                  配色对象：PAL.bg / PAL.a / PAL.b / PAL.c（数组或色值字符串）
//   LIGHT                布尔，是否日间 / 亮色调
//   T                    时间 id（dawn / day / dusk / night 之类）
//   WEA                  天气 id（clear / rain / snow 之类）
//   rnd / rr / ri / chance  种子随机（浮点 / 区间浮点 / 区间整数 / 概率）
//   A(c, alpha)          给色值套透明度
//   mix(c1, c2, t)       两色插值
//   lit(c, t)            提亮 / 压暗（t 正提亮、负压暗）
//   dk(c, t)             压暗
//   blob(x, y, rx, ry, c, alpha)   椭圆柔块
//   glow(x, y, r, c, a)            径向辉光
//
// 【导出】
//   CHAR_SCRIPT                 字符串：内含 drawChar(x, y, s, opt)
//   parseCharFromPrompt(prompt) 中文关键词解析，返回 {type, pose, face, size}
//
// 【禁】Math.random（一律用种子随机）、反引号、美元花括号（String.raw 模板会炸）
// ============================================================

export const CHAR_SCRIPT = String.raw`
// ---------- 角色绘制 drawChar(x, y, s, opt) ----------
// x, y = 脚下地面点；s = 角色身高（像素）
// opt.type  : boy / cat / dog / fox / rabbit / bird（girl 由外部 drawGirl 兜底）
// opt.pose  : stand / sit / run / reach / lookup
// opt.face  : 1 朝右 / -1 朝左（save + scale(face,1) 包住整体）
// opt.size  : near / mid / far（far 退化为剪影 + 主色块）
function _chc(v, i){ if (typeof v === 'string') return v; if (v && v.length) return v[i % v.length]; return v; }
function _chE(px, py, rx, ry, rot, c, a){
  ctx.save();
  ctx.globalAlpha = (a === undefined ? 1 : a);
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.ellipse(px, py, Math.max(0.5, rx), Math.max(0.5, ry), rot, 0, 6.2832);
  ctx.fill();
  ctx.restore();
}
function _chTri(ax, ay, bx, by, cx, cy, c, a){
  ctx.save();
  ctx.globalAlpha = (a === undefined ? 1 : a);
  ctx.fillStyle = c;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
function drawChar(x, y, s, opt){
  opt = opt || {};
  var type = opt.type || 'boy';
  var pose = opt.pose || 'stand';
  var face = (opt.face === -1) ? -1 : 1;
  var size = opt.size || 'mid';
  if (type === 'girl'){
    if (typeof drawGirl==='function') drawGirl(x,y,s,opt);
    return;
  }

  // ---- 调色（全部从 PAL / 工具派生，不引入 Math.random）----
  var cA = _chc(PAL.a, 2), cB = _chc(PAL.b, 2), cC = _chc(PAL.c, 4);
  var cMain  = cC;                                                    // 主体色：毛色 / 衣服
  var cDark  = dk(cMain, 0.35);
  var cDeep  = dk(cMain, 0.6);
  var cHair  = mix(cDeep, '#2b2f3a', 0.55);
  var cSkin  = lit(mix(cMain, '#ffe3d2', 0.62), LIGHT ? 0.08 : -0.06);
  var cEye   = mix(cDeep, '#141821', 0.65);
  var cWhite = mix(cMain, '#ffffff', 0.86);
  var cPink  = mix(cSkin, '#ff9fae', 0.5);
  var cShirt = cA;
  var cShort = dk(cShirt, 0.28);
  var cShoe  = dk(cMain, 0.45);
  var cBlush = mix(cSkin, '#ff8f9c', 0.45);
  var cBeak  = mix('#ffb054', cB, 0.3);

  var isBoy  = (type === 'boy');
  var isBird = (type === 'bird');
  var sit    = (pose === 'sit');
  var run    = (pose === 'run');
  var reach  = (pose === 'reach');
  var lookup = (pose === 'lookup');

  ctx.save();
  ctx.translate(x, y);
  ctx.scale(face, 1);
  ctx.translate(-x, -y);

  // ---- 地面影 ----
  blob(x, y + s * 0.01, s * (sit ? 0.30 : 0.22), s * 0.045, '#000000', LIGHT ? 0.14 : 0.22);

  // ---- far：剪影 + 主色块，到此为止 ----
  if (size === 'far'){
    _chE(x, y - s * 0.38, s * 0.15, s * 0.30, 0, cMain);
    _chE(x, y - s * 0.76, s * 0.18, s * 0.18, 0, dk(cMain, 0.15));
    if (!isBoy){
      if (type === 'rabbit'){
        _chE(x - s * 0.07, y - s * 0.96, s * 0.045, s * 0.13, 0, dk(cMain, 0.15));
        _chE(x + s * 0.07, y - s * 0.96, s * 0.045, s * 0.13, 0, dk(cMain, 0.15));
      } else if (isBird){
        _chTri(x - s * 0.06, y - s * 0.90, x + s * 0.06, y - s * 0.90, x, y - s * 1.02, dk(cMain, 0.15));
      } else {
        _chTri(x - s * 0.14, y - s * 0.86, x - s * 0.18, y - s * 1.0, x - s * 0.02, y - s * 0.90, dk(cMain, 0.15));
        _chTri(x + s * 0.02, y - s * 0.90, x + s * 0.18, y - s * 1.0, x + s * 0.14, y - s * 0.86, dk(cMain, 0.15));
      }
    } else {
      _chE(x, y - s * 0.90, s * 0.17, s * 0.11, 0, cHair);
    }
    ctx.restore();
    return;
  }

  // ---- 姿态通用量（Q 版 2~2.5 头身：头约占一半）----
  var hipY   = y - s * (sit ? 0.16 : 0.40);
  var bodyRx = s * 0.16, bodyRy = s * 0.19;
  var bodyY  = sit ? (y - s * 0.26) : hipY;
  var headR  = s * 0.215;
  var headY  = sit ? (y - s * 0.60) : (y - s * 0.77);
  var headX  = x + s * (run ? 0.02 : 0.01);

  // 跑步：身体前倾（整段包一层旋转）
  if (run){
    ctx.save();
    ctx.translate(x, hipY);
    ctx.rotate(0.12);
    ctx.translate(-x, -hipY);
  }

  // ---- 尾巴（画在身体后面）----
  if (!isBoy && !isBird){
    if (type === 'cat'){
      _chE(x - s * 0.19, y - s * 0.26, s * 0.045, s * 0.15, 0.8, cMain);
      _chE(x - s * 0.205, y - s * 0.335, s * 0.03, s * 0.035, 0, cWhite, 0.9);
    } else if (type === 'dog'){
      _chE(x - s * 0.18, y - s * 0.22, s * 0.05, s * 0.09, 0.5, cMain);
    } else if (type === 'fox'){
      _chE(x - s * 0.24, y - s * 0.22, s * 0.07, s * 0.19, 0.5, cMain);
      _chE(x - s * 0.30, y - s * 0.34, s * 0.045, s * 0.06, 0.4, cWhite, 0.95);
    } else if (type === 'rabbit'){
      _chE(x - s * 0.175, y - s * 0.15, s * 0.055, s * 0.055, 0, cWhite, 0.95);
    }
  }
  if (isBird){ // 鸟尾羽
    _chE(x - s * 0.18, y - s * 0.30, s * 0.085, s * 0.03, -0.5, cDark);
    _chE(x - s * 0.19, y - s * 0.24, s * 0.09, s * 0.03, -0.15, dk(cMain, 0.18));
  }

  // ---- 腿 ----
  var legC = isBoy ? cSkin : cMain;
  if (isBird){
    ctx.save();
    ctx.strokeStyle = dk(cMain, 0.35);
    ctx.lineWidth = Math.max(1, s * 0.022);
    ctx.beginPath();
    ctx.moveTo(x - s * 0.055, y - s * 0.10); ctx.lineTo(x - s * 0.062, y);
    ctx.moveTo(x + s * 0.055, y - s * 0.10); ctx.lineTo(x + s * 0.062, y);
    ctx.stroke();
    ctx.restore();
    _chE(x - s * 0.078, y, s * 0.04, s * 0.02, 0, dk(cMain, 0.35));
    _chE(x + s * 0.078, y, s * 0.04, s * 0.02, 0, dk(cMain, 0.35));
  } else if (sit){
    _chE(x - s * 0.02, y - s * 0.085, s * 0.11, s * 0.062, 0, cDark, 0.92); // 后侧腿压暗
    _chE(x + s * 0.10, y - s * 0.09, s * 0.13, s * 0.07, 0, legC);          // 大腿前伸
    _chE(x + s * 0.19, y - s * 0.045, s * 0.05, s * 0.055, 0, legC);        // 小腿 / 脚
    if (isBoy) _chE(x + s * 0.20, y - s * 0.015, s * 0.055, s * 0.03, 0, cShoe);
  } else if (run){
    _chE(x - s * 0.09, y - s * 0.13, s * 0.05, s * 0.115, -0.5, legC);      // 后腿抬起
    _chE(x + s * 0.10, y - s * 0.11, s * 0.05, s * 0.125, 0.55, legC);      // 前腿迈出
    if (isBoy){
      _chE(x - s * 0.115, y - s * 0.05, s * 0.055, s * 0.03, -0.5, cShoe);
      _chE(x + s * 0.145, y - s * 0.03, s * 0.055, s * 0.03, 0.5, cShoe);
    }
    ctx.save();                                                              // 速度线
    ctx.strokeStyle = A(cDark, 0.5);
    ctx.lineWidth = Math.max(1, s * 0.015);
    ctx.beginPath();
    ctx.moveTo(x - s * 0.22, y - s * 0.18); ctx.lineTo(x - s * 0.34, y - s * 0.18);
    ctx.moveTo(x - s * 0.20, y - s * 0.30); ctx.lineTo(x - s * 0.30, y - s * 0.30);
    ctx.moveTo(x - s * 0.24, y - s * 0.42); ctx.lineTo(x - s * 0.33, y - s * 0.42);
    ctx.stroke();
    ctx.restore();
  } else {
    _chE(x - s * 0.07, y - s * 0.11, s * 0.055, s * 0.115, 0, legC);
    _chE(x + s * 0.07, y - s * 0.11, s * 0.055, s * 0.115, 0, legC);
    if (isBoy){
      _chE(x - s * 0.075, y - s * 0.01, s * 0.06, s * 0.032, 0, cShoe);
      _chE(x + s * 0.085, y - s * 0.01, s * 0.06, s * 0.032, 0, cShoe);
    }
  }

  // ---- 躯干（男孩 T 恤 / 动物毛身）----
  _chE(x, bodyY, bodyRx, bodyRy, 0, isBoy ? cShirt : cMain);
  if (isBoy){
    _chE(x, bodyY + bodyRy * 0.62, s * 0.145, s * 0.075, 0, cShort); // 短裤
  } else if (size === 'near'){
    _chE(x + s * 0.02, bodyY + s * 0.02, s * 0.10, s * 0.12, 0, cWhite, 0.85); // 肚皮浅色
  }

  // ---- 手臂 ----
  var armC = isBoy ? cSkin : cMain;
  var shY  = bodyY - bodyRy * 0.55;
  if (reach){
    _chE(x + s * 0.17, shY - s * 0.10, s * 0.045, s * 0.115, -0.85, armC); // 前臂伸向上前方
    _chE(x - s * 0.16, shY + s * 0.02, s * 0.045, s * 0.10, -0.35, armC);
  } else if (run){
    _chE(x + s * 0.17, shY + s * 0.03, s * 0.045, s * 0.105, -0.7, armC);
    _chE(x - s * 0.17, shY + s * 0.03, s * 0.045, s * 0.105, 0.7, armC);
  } else if (sit){
    _chE(x + s * 0.15, bodyY + s * 0.05, s * 0.045, s * 0.10, -0.25, armC);
    _chE(x - s * 0.15, bodyY + s * 0.05, s * 0.045, s * 0.10, 0.25, armC);
  } else {
    _chE(x + s * 0.155, shY + s * 0.07, s * 0.045, s * 0.10, -0.22, armC);
    _chE(x - s * 0.155, shY + s * 0.07, s * 0.045, s * 0.10, 0.22, armC);
  }
  if (isBoy){ // T 恤短袖
    _chE(x + s * 0.13, shY + s * 0.015, s * 0.052, s * 0.048, -0.2, cShirt);
    _chE(x - s * 0.13, shY + s * 0.015, s * 0.052, s * 0.048, 0.2, cShirt);
  }

  // ---- 头 ----
  _chE(headX, headY, headR, headR, 0, isBoy ? cSkin : cMain);

  // 耳朵（按 type）
  if (type === 'cat'){
    _chTri(headX - s * 0.15, headY - s * 0.10, headX - s * 0.19, headY - s * 0.30, headX - s * 0.02, headY - s * 0.17, cMain);
    _chTri(headX + s * 0.02, headY - s * 0.17, headX + s * 0.19, headY - s * 0.30, headX + s * 0.15, headY - s * 0.10, cMain);
    _chTri(headX - s * 0.135, headY - s * 0.13, headX - s * 0.16, headY - s * 0.26, headX - s * 0.06, headY - s * 0.17, cPink, 0.85);
    _chTri(headX + s * 0.06, headY - s * 0.17, headX + s * 0.16, headY - s * 0.26, headX + s * 0.135, headY - s * 0.13, cPink, 0.85);
  } else if (type === 'fox'){
    _chTri(headX - s * 0.16, headY - s * 0.08, headX - s * 0.25, headY - s * 0.37, headX + s * 0.02, headY - s * 0.18, cMain);
    _chTri(headX + s * 0.02, headY - s * 0.18, headX + s * 0.25, headY - s * 0.37, headX + s * 0.16, headY - s * 0.08, cMain);
    _chTri(headX - s * 0.21, headY - s * 0.27, headX - s * 0.25, headY - s * 0.37, headX - s * 0.13, headY - s * 0.22, cWhite, 0.9);
    _chTri(headX + s * 0.13, headY - s * 0.22, headX + s * 0.25, headY - s * 0.37, headX + s * 0.21, headY - s * 0.27, cWhite, 0.9);
  } else if (type === 'dog'){
    _chE(headX - s * 0.17, headY - s * 0.08, s * 0.055, s * 0.12, 0.45, dk(cMain, 0.18));
    _chE(headX + s * 0.17, headY - s * 0.08, s * 0.055, s * 0.12, -0.45, dk(cMain, 0.18));
  } else if (type === 'rabbit'){
    _chE(headX - s * 0.09, headY - s * 0.34, s * 0.05, s * 0.16, -0.12, cMain);
    _chE(headX + s * 0.09, headY - s * 0.34, s * 0.05, s * 0.16, 0.12, cMain);
    _chE(headX - s * 0.09, headY - s * 0.33, s * 0.026, s * 0.115, -0.12, cPink, 0.85);
    _chE(headX + s * 0.09, headY - s * 0.33, s * 0.026, s * 0.115, 0.12, cPink, 0.85);
  } else if (isBird){
    _chTri(headX - s * 0.05, headY - headR, headX + s * 0.05, headY - headR, headX + s * 0.01, headY - headR - s * 0.07, cDark);
  }

  // 男孩短发（头顶半圆 + 刘海）
  if (isBoy){
    ctx.save();
    ctx.fillStyle = cHair;
    ctx.beginPath();
    ctx.arc(headX, headY - s * 0.02, headR * 1.02, Math.PI * 1.02, Math.PI * 1.98);
    ctx.fill();
    ctx.restore();
    _chE(headX - s * 0.02, headY - s * 0.19, s * 0.09, s * 0.045, -0.2, cHair);
    _chE(headX + s * 0.10, headY - s * 0.16, s * 0.06, s * 0.04, 0.3, cHair);
  }

  // ---- 脸 ----
  if (!isBoy){
    _chE(headX + s * 0.05, headY + s * 0.045, s * 0.10, s * 0.075, 0, cWhite, 0.9); // 口鼻浅色块
    if (isBird){
      _chTri(headX + s * 0.13, headY - s * 0.005, headX + s * 0.13, headY + s * 0.045, headX + s * 0.26, headY + s * 0.02, cBeak);
    } else {
      _chTri(headX + s * 0.03, headY + s * 0.02, headX + s * 0.07, headY + s * 0.02, headX + s * 0.05, headY + s * 0.055, cDeep); // 鼻子
    }
  }
  var eyeY  = headY + s * (lookup ? -0.045 : 0.015);   // lookup：眼睛移到头顶方向
  var eyeDx = s * 0.075;
  var eyeCx = headX + s * 0.02;
  _chE(eyeCx - eyeDx, eyeY, s * 0.033, s * 0.042, 0, cEye);
  _chE(eyeCx + eyeDx, eyeY, s * 0.033, s * 0.042, 0, cEye);
  if (size === 'near'){
    _chE(eyeCx - eyeDx - s * 0.012, eyeY - s * (lookup ? 0.018 : 0.015), s * 0.011, s * 0.013, 0, cWhite);
    _chE(eyeCx + eyeDx - s * 0.012, eyeY - s * (lookup ? 0.018 : 0.015), s * 0.011, s * 0.013, 0, cWhite);
    _chE(headX - s * 0.125, headY + s * 0.055, s * 0.033, s * 0.018, 0, cBlush, 0.55); // 腮红
    _chE(headX + s * 0.115, headY + s * 0.055, s * 0.033, s * 0.018, 0, cBlush, 0.55);
  }
  ctx.save(); // 嘴：小弧线
  ctx.strokeStyle = cDeep;
  ctx.lineWidth = Math.max(1, s * 0.018);
  ctx.beginPath();
  ctx.arc(headX + s * 0.03, headY + s * (lookup ? 0.05 : 0.09), s * 0.035, 0.3, 2.6);
  ctx.stroke();
  ctx.restore();

  if (run) ctx.restore(); // 解开跑步前倾的旋转
  ctx.restore();          // 解开 face 镜像
}
`;

// ============================================================
// parseCharFromPrompt(prompt)：中文关键词 -> {type, pose, face, size}
// 默认 mid / face 1（朝右）/ stand / boy
// ============================================================
export function parseCharFromPrompt(prompt){
  var p = String(prompt == null ? '' : prompt);
  var out = { type: 'boy', pose: 'stand', face: 1, size: 'mid' };
  if (/女孩|少女/.test(p)) out.type = 'girl';
  else if (/男孩|少年/.test(p)) out.type = 'boy';
  else if (/猫/.test(p)) out.type = 'cat';
  else if (/狗/.test(p)) out.type = 'dog';
  else if (/狐狸/.test(p)) out.type = 'fox';
  else if (/兔/.test(p)) out.type = 'rabbit';
  else if (/鸟/.test(p)) out.type = 'bird';
  if (/跑|奔跑/.test(p)) out.pose = 'run';
  else if (/坐着|蹲/.test(p)) out.pose = 'sit';
  else if (/伸手|招手|挥手/.test(p)) out.pose = 'reach';
  else if (/抬头|仰望/.test(p)) out.pose = 'lookup';
  if (/左边|面向左|朝左|向左/.test(p)) out.face = -1;
  if (/近景|特写/.test(p)) out.size = 'near';
  else if (/远景/.test(p)) out.size = 'far';
  return out;
}
