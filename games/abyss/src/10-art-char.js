/* ============================================================================
 * 10-art-char.js — 鲸落·深渊（ABYSS FALL）
 * 【主角 + 17 杂兵】像素精灵表
 * ----------------------------------------------------------------------------
 * 契约：只挂 G.ART，不碰别的命名空间。
 *   G.ART[id] = { w, h, frames, ax, ay, draw(p, f) }
 *   p 是核心层给的画笔 Px 实例，坐标原点在精灵左上角。
 *   逻辑像素，别画大。
 * ----------------------------------------------------------------------------
 * 调色板（SPEC §2，只用这一套，不许自己发明颜色）
 * ============================================================================ */
(function () {
  'use strict';

  const A = window.G.ART = window.G.ART || {};

  /* ---------------- 调色板 ---------------- */
  const K0 = '#05070d', K1 = '#0b1020', K2 = '#141d33', K3 = '#1e2c4a', K4 = '#2b4066',
        K5 = '#3f6394', K6 = '#5b93c9', K7 = '#8fd4f0', K8 = '#cdf1ff', W  = '#ffffff',
        Y1 = '#ffe6a3', Y2 = '#ffc84a', O1 = '#ff9a3c',
        R1 = '#ff5a6e', R2 = '#b02a45', M1 = '#ff6ec7', P1 = '#b06cff', P2 = '#5b2e8f',
        G1 = '#6ee7a0', G2 = '#2ee6c8', B1 = '#a2673f', B2 = '#5c3a24',
        S1 = '#7b8aa3', S2 = '#3b4657';

  /* ---------------- 小工具 ---------------- */

  // 注册一个精灵
  function S(id, w, h, frames, ax, ay, draw) {
    A[id] = {
      w: w, h: h,
      frames: frames || 1,
      ax: ax == null ? w / 2 : ax,
      ay: ay == null ? h / 2 : ay,
      draw: draw
    };
  }

  // 地面椭圆影子
  function shadow(p, cx, cy, rx, ry) {
    p.ctx.globalAlpha = 0.25;
    p.ellipse(cx, cy, rx, ry, '#000000');
    p.ctx.globalAlpha = 1;
  }

  // 一段会摆的细须
  function wisp(p, x, y, len, phase, amp, c) {
    for (let k = 0; k < len; k++) {
      const xx = Math.round(x + Math.sin(phase + k * 0.5) * amp * (k / len));
      p.px(xx, y + k, c);
    }
  }

  // 扇形触须（从一点向外散开）
  function fanTent(p, cx, cy, n, r0, r1, phase, amp, c1, c2) {
    for (let i = 0; i < n; i++) {
      const t = n === 1 ? 0.5 : i / (n - 1);
      const a = Math.PI * (0.12 + t * 0.76);
      const sw = Math.sin(phase + i * 0.9) * amp;
      const x1 = cx + Math.cos(a) * r1 + sw;
      const y1 = cy + Math.sin(a) * r1;
      p.line(Math.round(cx + Math.cos(a) * r0), Math.round(cy + Math.sin(a) * r0),
             Math.round(x1), Math.round(y1), i % 2 ? c2 : c1);
    }
  }

  /* ============================================================================
   *  一、主角：鲸鱼娘 whale  22×22  4 帧
   *  蓝黑长发（K3→K1 发梢）、白色荷叶边头饰、深蓝女仆裙（K3）+ 白围裙（W/K8）、
   *  围裙正中一只小鲸鱼（K6）、耳后小鳍（K6）、身后大鲸尾（K4/K3）、蓝眼（K7 瞳孔 W）
   *  4 帧：呼吸起伏 + 尾巴摆动
   * ========================================================================== */
  S('whale', 22, 22, 4, 11, 19, function (p, f) {
    // 呼吸：0→1→2→1 的起伏
    const bob = [0, -1, 0, 1][f];
    // 尾巴摆：左右两档
    const tw = [0, 1, 0, -1][f];

    shadow(p, 11, 20, 6, 2);

    /* ---------- 身后：大鲸鱼尾巴 ---------- */
    // 尾柄（从裙后伸出来）
    p.line(11, 17 + bob, 11 + tw, 19 + bob, K4);
    p.line(10, 17 + bob, 10 + tw, 19 + bob, K3);
    p.line(12, 17 + bob, 12 + tw, 19 + bob, K3);
    // 尾鳍（两片，像个横着的叶子）
    const tx = 11 + tw, ty = 20 + bob;
    p.poly([[tx, ty - 1], [tx - 4, ty - 3], [tx - 3, ty + 1], [tx, ty + 1]], K4);
    p.poly([[tx, ty - 1], [tx + 4, ty - 3], [tx + 3, ty + 1], [tx, ty + 1]], K4);
    // 尾鳍亮边
    p.px(tx - 3, ty - 2, K5);
    p.px(tx + 3, ty - 2, K5);

    /* ---------- 长发（后层，垂到身后） ---------- */
    // 左半边长发
    p.poly([[7, 6 + bob], [5, 9 + bob], [4, 15 + bob], [6, 16 + bob], [7, 12 + bob]], K2);
    p.poly([[6, 9 + bob], [4, 14 + bob], [5, 15 + bob], [6, 12 + bob]], K1);
    // 右半边长发
    p.poly([[15, 6 + bob], [17, 9 + bob], [18, 15 + bob], [16, 16 + bob], [15, 12 + bob]], K2);
    p.poly([[16, 9 + bob], [18, 14 + bob], [17, 15 + bob], [16, 12 + bob]], K1);

    /* ---------- 耳后小鲸鳍（左右各一） ---------- */
    p.poly([[5, 9 + bob], [3, 8 + bob], [4, 11 + bob]], K6);
    p.poly([[17, 9 + bob], [19, 8 + bob], [18, 11 + bob]], K6);
    p.px(4, 9 + bob, K7);
    p.px(18, 9 + bob, K7);

    /* ---------- 头（Q 版，圆圆的） ---------- */
    p.ellipse(11, 9 + bob, 6, 5.6, K3);
    p.ellipse(11, 8 + bob, 5.4, 5, K4);
    // 头顶高光
    p.ellipse(9, 5 + bob, 2.2, 1.4, K5);

    /* ---------- 头发前层（刘海） ---------- */
    // 额前刘海：锯齿状垂在眉上
    p.poly([[6, 6 + bob], [8, 4 + bob], [11, 3 + bob], [14, 4 + bob], [16, 6 + bob],
            [15, 8 + bob], [13, 7 + bob], [11, 8 + bob], [9, 7 + bob], [7, 8 + bob]], K2);
    p.poly([[7, 5 + bob], [11, 4 + bob], [15, 5 + bob], [14, 6 + bob], [11, 6 + bob], [8, 6 + bob]], K3);
    // 鬓角（两缕垂到脸颊边）
    p.rect(5, 7 + bob, 2, 5, K2);
    p.rect(15, 7 + bob, 2, 5, K2);
    p.px(5, 7 + bob, K3);
    p.px(16, 7 + bob, K3);

    /* ---------- 白色荷叶边头饰 ---------- */
    // 头饰主体（横一条白带）
    p.rect(6, 3 + bob, 10, 2, W);
    p.rect(6, 4 + bob, 10, 1, K8);
    // 荷叶边：上下各一排小凸起
    for (let i = 0; i < 5; i++) {
      p.px(6 + i * 2, 2 + bob, W);
      p.px(7 + i * 2, 3 + bob, K8);
    }
    // 头饰上的小蝴蝶结
    p.px(10, 3 + bob, M1);
    p.px(11, 3 + bob, M1);
    p.px(10, 2 + bob, M1);

    /* ---------- 眼睛（蓝眼，瞳孔白点） ---------- */
    // 左眼
    p.rect(8, 9 + bob, 2, 2, K7);
    p.px(9, 10 + bob, W);
    p.px(8, 9 + bob, K0);
    // 右眼
    p.rect(13, 9 + bob, 2, 2, K7);
    p.px(14, 10 + bob, W);
    p.px(13, 9 + bob, K0);
    // 腮红
    p.px(7, 11 + bob, R1);
    p.px(15, 11 + bob, R1);

    /* ---------- 笑脸（笑起来会张嘴） ---------- */
    if (f === 0 || f === 2) {
      // 微笑：一条弧
      p.px(10, 12 + bob, K0);
      p.px(11, 12 + bob, K0);
      p.px(12, 12 + bob, K0);
      p.px(9, 11 + bob, K0);
      p.px(13, 11 + bob, K0);
    } else {
      // 张嘴笑
      p.ellipse(11, 12 + bob, 1.6, 1.2, K0);
      p.px(11, 13 + bob, R1);
    }

    /* ---------- 深蓝女仆裙 ---------- */
    const by = 15 + bob;
    // 裙摆（上窄下宽的梯形）
    p.poly([[8, by], [14, by], [16, by + 4], [6, by + 4]], K3);
    p.poly([[8, by], [14, by], [15, by + 2], [7, by + 2]], K4);
    // 裙摆荷叶边
    for (let i = 0; i < 5; i++) {
      p.px(7 + i * 2, by + 4, K5);
      p.px(8 + i * 2, by + 5, K3);
    }

    /* ---------- 白色围裙 ---------- */
    p.poly([[9, by], [13, by], [13, by + 3], [9, by + 3]], W);
    p.poly([[9, by + 3], [13, by + 3], [12, by + 4], [10, by + 4]], K8);
    // 围裙带子（背后交叉，露一点点）
    p.px(8, by, W);
    p.px(14, by, W);

    /* ---------- 围裙正中：一只小鲸鱼（K6） ---------- */
    p.ellipse(11, by + 1, 1.6, 1, K6);
    p.px(12, by + 2, K6);   // 尾
    p.px(12, by + 1, K6);
    p.px(10, by + 1, W);    // 眼睛

    /* ---------- 小短手 ---------- */
    p.rect(6, by, 2, 2, K4);
    p.rect(14, by, 2, 2, K4);
    p.px(6, by + 1, K7);
    p.px(15, by + 1, K7);
  });

  /* ============================================================================
   *  二、17 个杂兵（全部朝下画，引擎负责转向）
   * ========================================================================== */

  /* ---- 1. jelly 水母 12×12 2帧：半透明伞盖 + 下垂触须 ---- */
  S('jelly', 12, 12, 2, 6, 8, function (p, f) {
    const s = [0, 1][f];
    // 伞盖（两层，外圈透亮）
    p.ellipse(6, 5, 5, 4, M1);
    p.ellipse(6, 4, 4.2, 3.2, '#ffb3e0');
    p.ellipse(5, 3, 1.8, 1.2, W);
    // 伞盖下边缘的褶皱
    for (let i = 0; i < 4; i++) {
      p.px(3 + i * 2, 8, P1);
    }
    // 触须（会摆）
    wisp(p, 4, 9, 3 + s, f * 1.6, 1.2, P1);
    wisp(p, 6, 9, 3 + (1 - s), f * 1.6 + 1, 1.0, M1);
    wisp(p, 8, 9, 3 + s, f * 1.6 + 2, 1.2, P1);
  });

  /* ---- 2. spikefish 刺鱼 14×12 2帧：扁身 + 背刺 + 横眼 ---- */
  S('spikefish', 14, 12, 2, 7, 6, function (p, f) {
    const s = [0, 1][f];
    // 尾鳍
    p.tri(1, 4, 1, 9, 4, 6 + (s ? 1 : -1), K5);
    // 身体
    p.ellipse(8, 6, 5, 3.4, K4);
    p.ellipse(8, 5, 4, 2.4, K5);
    // 背刺
    for (let i = 0; i < 4; i++) {
      const x = 5 + i * 2;
      p.line(x, 3, x + 1, 0 + (i % 2) * s, K8);
    }
    // 眼
    p.px(10, 5, W);
    p.px(11, 5, K0);
    // 嘴
    p.px(12, 7, K0);
    // 腹鳍
    p.tri(6, 8, 9, 8, 7, 10 + s, K3);
  });

  /* ---- 3. crab 螃蟹 16×12 2帧：两只大钳 + 横着走 ---- */
  S('crab', 16, 12, 2, 8, 7, function (p, f) {
    const s = [0, 1][f];
    // 影子
    shadow(p, 8, 11, 5, 1.2);
    // 腿（每边三条，会动）
    for (let i = 0; i < 3; i++) {
      const dy = (i % 2 === 0 ? 0 : 1) * s;
      p.line(5 - i, 8, 2 - i, 10 + dy, R2);
      p.line(11 + i, 8, 14 + i, 10 + dy, R2);
    }
    // 两只大钳（张开/合拢）
    const cl = [0, 1][f];
    // 左钳
    p.ellipse(2, 4, 2.4, 2, R1);
    p.poly([[0, 2 - cl], [2, 3], [0, 4 + cl]], R1);
    p.px(1, 3, '#ff9a9a');
    // 右钳
    p.ellipse(14, 4, 2.4, 2, R1);
    p.poly([[16, 2 - cl], [14, 3], [16, 4 + cl]], R1);
    p.px(15, 3, '#ff9a9a');
    // 壳
    p.ellipse(8, 6, 5, 3.4, R2);
    p.ellipse(8, 5, 4, 2.4, R1);
    // 眼睛（两根小柄顶上来）
    p.line(6, 4, 6, 2, R1);
    p.line(10, 4, 10, 2, R1);
    p.px(6, 2, W);
    p.px(10, 2, W);
    p.px(6, 2, K0);
    p.px(10, 2, K0);
    // 嘴
    p.px(8, 7, K0);
  });

  /* ---- 4. shark 鲨鱼 20×12 2帧：尖吻 + 背鳍 + 牙 ---- */
  S('shark', 20, 12, 2, 10, 6.5, function (p, f) {
    const s = [0, 1][f];
    // 尾鳍（大，会摆）
    p.tri(1, 3 + s, 1, 9 - s, 6, 6, S1);
    p.tri(1, 5, 1, 8, 4, 6, S2);
    // 身体
    p.ellipse(11, 6, 7, 3.2, S1);
    p.ellipse(11, 5, 6, 2.2, '#93a2ba');
    // 背鳍
    p.tri(9, 3, 13, 3, 11, 0, S2);
    // 腹鳍
    p.tri(8, 9, 11, 9, 9, 11, S2);
    // 头（尖吻朝右）
    p.tri(16, 4, 16, 8, 19, 6, S1);
    // 眼
    p.px(15, 5, K0);
    p.px(16, 5, R1);
    // 牙（一排白点）
    p.px(17, 7, W);
    p.px(18, 6, W);
    p.px(16, 7, W);
    // 鳃
    p.line(13, 5, 13, 7, S2);
    p.line(14, 5, 14, 7, S2);
  });

  /* ---- 5. urchin 海胆 13×13 2帧：圆球 + 360° 长刺 ---- */
  S('urchin', 13, 13, 2, 6.5, 6.5, function (p, f) {
    const s = [0, 1][f];
    // 尖刺（16 根，长短交替）
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const r0 = 3.6;
      const r1 = 4.8 + (i % 2 ? 1.6 : 0) + (i % 4 === 0 ? s * 0.8 : 0);
      p.line(Math.round(6.5 + Math.cos(a) * r0), Math.round(6.5 + Math.sin(a) * r0),
             Math.round(6.5 + Math.cos(a) * r1), Math.round(6.5 + Math.sin(a) * r1),
             i % 3 === 0 ? P1 : '#8a5fc4');
    }
    // 球体
    p.circle(6.5, 6.5, 3.4, P2);
    p.circle(6.5, 6.5, 2.4, P1);
    p.px(5, 5, '#e0c8ff');
    // 两眼
    p.px(5, 7, K0);
    p.px(8, 7, K0);
  });

  /* ---- 6. octopus 章鱼 16×16 2帧：圆头 + 八条摆动的腿 ---- */
  S('octopus', 16, 16, 2, 8, 9, function (p, f) {
    const s = [0, 1][f];
    shadow(p, 8, 15, 4.5, 1);
    // 八条腿
    for (let i = 0; i < 8; i++) {
      const t = (i / 7) * 2 - 1;               // -1..1
      const x0 = 8 + t * 4;
      const sway = Math.sin(f * Math.PI + i * 0.8) * 1.6;
      for (let k = 0; k < 6; k++) {
        const x = Math.round(x0 + sway * (k / 6) * (t >= 0 ? 1 : -1) * 1.2 + t * (k / 6));
        p.px(x, 10 + k, k > 3 ? P2 : P1);
      }
    }
    // 头（大圆）
    p.ellipse(8, 6, 6, 5.4, P2);
    p.ellipse(8, 5.5, 5, 4.2, P1);
    p.ellipse(6, 4, 2, 1.4, '#e0b3ff');
    // 两眼（横瞳，凶）
    p.rect(5, 6, 2, 1, K0);
    p.rect(10, 6, 2, 1, K0);
    p.px(5, 6, Y2);
    p.px(11, 6, Y2);
    // 喙
    p.px(8, 9, K2);
  });

  /* ---- 7. lantern 灯笼鱼 12×16 2帧：头顶一根发光诱饵 ---- */
  S('lantern', 12, 16, 2, 6, 9, function (p, f) {
    const s = [0, 1][f];
    // 诱饵竿
    p.line(6, 5, 8, 1, S2);
    p.line(8, 1, 9, 2, S2);
    // 诱饵光球（会呼吸、有辉光）
    p.glow(9, 3, 4 + s * 0.6, Y2);
    p.circle(9, 3, 1.8, Y1);
    p.circle(9, 3, 1, W);
    // 身体
    p.ellipse(6, 10, 5, 4.4, K3);
    p.ellipse(6, 9, 4.2, 3.4, K4);
    // 大嘴（朝下）
    p.ellipse(6, 12, 3.4, 1.8, K0);
    // 牙
    for (let i = 0; i < 4; i++) {
      p.px(4 + i * 1.5 | 0, 11, W);
    }
    p.px(5, 11, W); p.px(7, 11, W);
    // 眼
    p.px(4, 8, K8);
    p.px(4, 8, K0);
    p.px(8, 8, K8);
    p.px(8, 8, K0);
    // 尾
    p.tri(1, 9, 1, 12, 3, 10, K3);
  });

  /* ---- 8. eel 电鳗 24×9 2帧：细长条 + 电火花 ---- */
  S('eel', 24, 9, 2, 12, 4.5, function (p, f) {
    const s = [0, 1][f];
    // 长身（一条波浪）
    for (let x = 2; x < 22; x++) {
      const y = Math.round(4.5 + Math.sin((x / 3) + f * Math.PI * 0.5) * 1.6);
      p.px(x, y, K5);
      p.px(x, y + 1, K6);
      p.px(x, y - 1, K4);
    }
    // 头
    p.ellipse(21, 4, 2.2, 2, K6);
    // 眼
    p.px(21, 3, K0);
    p.px(22, 3, Y2);
    // 嘴
    p.px(23, 5, K0);
    // 尾
    p.tri(1, 2, 1, 6, 3, 4, K4);
    // 电火花
    const e1 = 3 + f * 2;
    p.px(e1, 0, G2);
    p.px(e1 + 2, 1, G2);
    p.px(e1 + 4, 0, G2);
    p.px(17 - f * 2, 8, G2);
    p.px(15 - f * 2, 8, G2);
  });

  /* ---- 9. ghost 幽灵 14×16 2帧：飘浮的半透明亡魂 ---- */
  S('ghost', 14, 16, 2, 7, 10, function (p, f) {
    const s = [0, 1][f];
    // 尾摆（下缘参差的裙边）
    const base = 13 + s;
    p.poly([[3, 8], [11, 8], [11, base], [9, base - 2], [7, base], [5, base - 2], [3, base]], K1);
    // 身体（上圆下散）
    p.ellipse(7, 6, 4.8, 5, K2);
    p.ellipse(7, 5.5, 3.8, 4, K3);
    // 头巾似的亮部
    p.ellipse(6, 3.5, 2, 1.4, K5);
    // 两只空洞的眼（发亮）
    p.ellipse(5, 6, 1.2, 1.6, K0);
    p.ellipse(9, 6, 1.2, 1.6, K0);
    p.px(5, 6, G2);
    p.px(9, 6, G2);
    // 嘴
    p.ellipse(7, 9, 1, 1.4, K0);
    // 飘着的雾
    p.ctx.globalAlpha = 0.4;
    p.px(2 - s, 10, K5);
    p.px(12 + s, 11, K5);
    p.px(1, 8, K5);
    p.ctx.globalAlpha = 1;
  });

  /* ---- 10. golem 石魔 18×20 2帧：石块堆的巨汉 + 缝里透光 ---- */
  S('golem', 18, 20, 2, 9, 16, function (p, f) {
    const s = [0, 1][f];
    shadow(p, 9, 19, 6, 1.4);
    // 腿
    p.rect(4, 15, 4, 4, S2);
    p.rect(10, 15, 4, 4, S2);
    p.rect(4, 18, 4, 1, K2);
    p.rect(10, 18, 4, 1, K2);
    // 躯干（几块歪斜的石头拼起来）
    p.poly([[4, 7], [14, 6], [15, 11], [13, 15], [5, 15], [3, 11]], S1);
    p.poly([[5, 8], [13, 7], [13, 12], [11, 14], [6, 14]], '#8b9ab3');
    // 石头缝（暗线）
    p.line(6, 9, 12, 8, S2);
    p.line(5, 12, 13, 11, S2);
    p.line(9, 7, 9, 14, S2);
    // 缝里透出的光（会闪）
    p.px(8, 10 + s, O1);
    p.px(10, 12 - s, O1);
    p.px(7, 12, Y2);
    // 手臂（粗）
    p.rect(1, 8, 3, 7, S2);
    p.rect(14, 8, 3, 7, S2);
    p.rect(1, 13, 4, 3, S1);
    p.rect(13, 13, 4, 3, S1);
    // 头（小，嵌在肩上）
    p.ellipse(9, 5, 3.4, 3, S1);
    p.ellipse(9, 4.5, 2.6, 2.2, '#8b9ab3');
    // 两只发光的眼
    p.rect(7, 4, 1, 1, O1);
    p.rect(10, 4, 1, 1, O1);
    // 嘴缝
    p.line(7, 6, 11, 6, S2);
  });

  /* ---- 11. parasite 寄生虫 9×11 2帧：小、快、丑 ---- */
  S('parasite', 9, 11, 2, 4.5, 6, function (p, f) {
    const s = [0, 1][f];
    // 身子（一弯月牙）
    p.ellipse(4.5, 6, 3, 3.6, B2);
    p.ellipse(4.5, 5.5, 2.2, 2.8, B1);
    // 两侧的小腿（会划）
    p.line(2, 7, 1, 9 - s, B2);
    p.line(7, 7, 8, 9 + s, B2);
    p.line(2, 5, 0, 4 + s, B2);
    p.line(7, 5, 9, 4 - s, B2);
    // 头（靠上）
    p.ellipse(4.5, 3, 2, 1.8, B1);
    // 一只大眼
    p.px(4, 3, W);
    p.px(4, 3, K0);
    p.px(5, 3, Y2);
    // 口器
    p.px(4.5, 5, R1);
  });

  /* ---- 12. spitter 喷吐者 14×14 2帧：鼓起腮帮子要吐 ---- */
  S('spitter', 14, 14, 2, 7, 8, function (p, f) {
    const s = [0, 1][f];
    shadow(p, 7, 13, 4.5, 1);
    // 底座（贴地的软体）
    p.ellipse(7, 11, 5.5, 2.6, G1);
    p.ellipse(7, 10.5, 4.5, 1.8, '#a8f5c8');
    // 球身（鼓起来，两帧一胀一缩）
    const r = 4.6 + s * 0.5;
    p.ellipse(7, 7, r, r, '#2fa86c');
    p.ellipse(7, 6.5, r - 1, r - 1.2, G1);
    p.ellipse(5, 4.5, 1.6, 1, '#d6ffe8');
    // 腮帮子（鼓）
    p.ellipse(4, 8, 1.6 + s * 0.4, 1.4 + s * 0.3, G1);
    p.ellipse(10, 8, 1.6 + s * 0.4, 1.4 + s * 0.3, G1);
    // 眼
    p.px(5, 6, K0);
    p.px(9, 6, K0);
    // 嘴（吐口）
    p.ellipse(7, 9 + s, 1.2, 1, K2);
    // 嘴边一滴
    p.px(7, 11 + s, G2);
  });

  /* ---- 13. summoner 召唤者 16×18 2帧：兜帽 + 法球 ---- */
  S('summoner', 16, 18, 2, 8, 14, function (p, f) {
    const s = [0, 1][f];
    shadow(p, 8, 17, 4.5, 1.2);
    // 袍子
    p.poly([[8, 4], [13, 10], [14, 17], [2, 17], [3, 10]], P2);
    p.poly([[8, 6], [11, 11], [12, 16], [4, 16], [5, 11]], '#3f2064');
    // 兜帽
    p.ellipse(8, 5, 4, 4.4, P2);
    p.ellipse(8, 5, 3.2, 3.4, K0);
    // 兜帽里两点眼
    p.px(6, 5, M1);
    p.px(10, 5, M1);
    // 手里的法球（浮在胸前）
    p.glow(8, 11, 4 + s, M1);
    p.circle(8, 11, 1.8, M1);
    p.circle(8, 11, 1, '#ffb3e0');
    // 浮着的小符文
    p.px(2, 8 + s, G2);
    p.px(14, 9 - s, G2);
    p.px(1, 13, G2);
  });

  /* ---- 14. shellback 甲壳盾卫 19×17 2帧：正面一面厚甲 ---- */
  S('shellback', 19, 17, 2, 9.5, 13, function (p, f) {
    const s = [0, 1][f];
    shadow(p, 9, 16, 6, 1.4);
    // 腿
    p.line(5, 13, 3, 16, S2);
    p.line(8, 13, 7, 16, S2);
    p.line(11, 13, 12, 16, S2);
    p.line(14, 13, 16, 16, S2);
    // 壳（三层，中间厚）
    p.ellipse(9, 8, 8, 7, S2);
    p.ellipse(9, 7.5, 7, 6, S1);
    p.ellipse(9, 7, 5.2, 4.4, '#93a2ba');
    p.ellipse(9, 6.5, 3.4, 2.8, S1);
    // 甲片分层线
    p.line(1, 8, 17, 8, S2);
    p.line(2, 11, 16, 11, S2);
    // 铆钉
    for (let i = 0; i < 4; i++) {
      p.px(3 + i * 4, 8, K8);
    }
    p.px(5, 4, K8); p.px(13, 4, K8);
    // 壳后探出的两只眼（两只小柄）
    p.line(6, 2, 6, 4, S2);
    p.line(12, 2, 12, 4, S2);
    p.px(6, 1 + s, Y2);
    p.px(12, 1 + s, Y2);
    p.px(6, 1 + s, K0);
    p.px(12, 1 + s, K0);
  });

  /* ---- 15. bombfish 自爆河豚 15×15 2帧：圆鼓鼓 + 全身短刺 ---- */
  S('bombfish', 15, 15, 2, 7.5, 8, function (p, f) {
    const s = [0, 1][f];
    shadow(p, 7, 13, 4.5, 1);
    // 短刺（一圈，两帧长短交替 = 鼓气）
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2;
      const r0 = 5.4;
      const r1 = 6.8 + (i % 2 === 0 ? s * 0.9 : 0);
      p.line(Math.round(7 + Math.cos(a) * r0), Math.round(7 + Math.sin(a) * r0),
             Math.round(7 + Math.cos(a) * r1), Math.round(7 + Math.sin(a) * r1), Y1);
    }
    // 圆身
    p.circle(7, 7, 5.4, '#d9762a');
    p.circle(7, 7, 4.5, O1);
    p.circle(5.5, 5.5, 1.8, '#ffb877');
    // 鲀脸：两只眼 + 小圆嘴
    p.circle(5, 7, 1.4, W);
    p.circle(9, 7, 1.4, W);
    p.px(5, 7, K0);
    p.px(9, 7, K0);
    p.ellipse(7, 10, 1.4, 0.9, K2);
    // 危险标记（会闪）
    if (s) { p.px(7, 1, R1); }
    else { p.px(7, 1, Y2); }
  });

  /* ---- 16. bonefish 骨鱼 18×11 2帧：一副鱼骨 ---- */
  S('bonefish', 18, 11, 2, 9, 5.5, function (p, f) {
    const s = [0, 1][f];
    shadow(p, 9, 9, 5, 0.9);
    // 脊椎
    p.line(4, 5, 14, 5, K8);
    p.line(4, 6, 14, 6, S1);
    // 肋骨（上下交错）
    for (let i = 0; i < 5; i++) {
      const x = 6 + i * 2;
      const h = i % 2 === 0 ? 0 : 1;
      p.line(x, 2 + h, x, 8 - h, K8);
    }
    // 头骨
    p.ellipse(3, 5, 2.6, 2.6, W);
    p.ellipse(3, 5, 2, 2, K8);
    // 空洞眼眶
    p.px(2, 4, K0);
    p.px(4, 4, K0);
    p.px(3, 7, K0);
    // 尾鳍（会摆）
    p.tri(14, 3, 14, 8, 17, 5 + s, K8);
    // 背鳍
    p.tri(8, 5, 11, 5, 9, 1, K8);
    // 腹鳍
    p.tri(8, 6, 10, 6, 9, 9, S1);
  });

  /* ---- 17. siren 海妖 16×20 2帧：苍白人身鱼尾 + 长发 ---- */
  S('siren', 16, 20, 2, 8, 14, function (p, f) {
    const s = [0, 1][f];
    shadow(p, 8, 19, 4, 1.2);
    // 长发（后层，飘到腰下）
    p.ellipse(8, 7, 5.6, 6, M1);
    for (let i = 0; i < 5; i++) {
      const x0 = 3 + i * 2.5;
      for (let k = 0; k < 9; k++) {
        const x = Math.round(x0 + Math.sin(f * Math.PI + k * 0.4 + i) * 1.4);
        p.px(x, 8 + k, k > 5 ? '#d94f9f' : M1);
      }
    }
    // 上身前层（苍白）
    p.ellipse(8, 10, 3.2, 3.6, K7);
    p.ellipse(8, 9.5, 2.4, 2.8, K8);
    // 手臂（伸向前）
    p.line(5, 9, 2, 12, K7);
    p.line(11, 9, 14, 12, K7);
    // 鱼尾
    p.ellipse(8, 15, 3.4, 3, M1);
    p.ellipse(8, 15, 2.4, 2.2, '#ff9ad8');
    p.tri(5, 17, 11, 17, 8, 19 + s, M1);
    p.tri(6, 16, 10, 16, 8, 18, P1);
    // 尾上的鳞
    p.px(7, 14, K8);
    p.px(9, 15, K8);
    // 脸
    p.ellipse(8, 7, 2.8, 2.8, K8);
    // 眼（闭着唱）
    p.line(6, 7, 8, 7, K2);
    p.line(8, 7, 10, 7, K2);
    // 张嘴唱（随帧开合）
    p.ellipse(8, 9.5, 1, 0.6 + s * 0.6, R2);
    // 歌声的音波
    p.ctx.globalAlpha = 0.7;
    p.px(12 + s, 6, G2);
    p.px(13 + s, 8, G2);
    p.px(12, 10 - s, G2);
    p.ctx.globalAlpha = 1;
  });

})();
