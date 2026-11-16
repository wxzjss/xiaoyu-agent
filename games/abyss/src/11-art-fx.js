const G = window.G = window.G || {}; if(!G.ART) G.ART = {};
/* ============================================================
 * 鲸落·深渊 —— 11-art-fx.js
 * 【B 负责】Boss ×3 / 拾取物 ×7 / 场景装饰 ×10 / 武器图标 ×14 / 被动图标 ×12
 * 只用 SPEC 第 2 节调色板；统一 1px 深色描边 K0；全静态、无随机外部依赖。
 * ============================================================ */
(function () {
  'use strict';

  const A = G.ART;

  /* ---------------- 调色板（SPEC §2，只用这一套） ---------------- */
  const K0 = '#05070d', K1 = '#0b1020', K2 = '#141d33', K3 = '#1e2c4a', K4 = '#2b4066',
        K5 = '#3f6394', K6 = '#5b93c9', K7 = '#8fd4f0', K8 = '#cdf1ff', W  = '#ffffff',
        Y1 = '#ffe6a3', Y2 = '#ffc84a', O1 = '#ff9a3c',
        R1 = '#ff5a6e', R2 = '#b02a45', M1 = '#ff6ec7', P1 = '#b06cff', P2 = '#5b2e8f',
        G1 = '#6ee7a0', G2 = '#2ee6c8', B1 = '#a2673f', B2 = '#5c3a24',
        S1 = '#7b8aa3', S2 = '#3b4657';

  const fa = (typeof G.withAlpha === 'function')
    ? G.withAlpha
    : function (c, a) { return c; };

  /* ---------------- 小工具 ---------------- */
  function S(id, w, h, frames, ax, ay, draw) {
    A[id] = {
      w: w, h: h,
      frames: frames || 1,
      ax: ax == null ? w / 2 : ax,
      ay: ay == null ? h / 2 : ay,
      draw: draw
    };
  }

  // 点阵椭圆弧：a0→a1 扫一段
  function parc(p, cx, cy, rx, ry, a0, a1, c) {
    const n = Math.max(10, Math.round(Math.abs(a1 - a0) * Math.max(rx, ry) * 1.4));
    for (let i = 0; i !== n + 1; i++) {
      const a = a0 + (a1 - a0) * (i / n);
      p.px(Math.round(cx + Math.cos(a) * rx), Math.round(cy + Math.sin(a) * ry), c);
    }
  }

  // 一条会摆的细触须
  function tentacle(p, x, y0, len, phase, amp, c1, c2) {
    for (let k = 0; k !== len; k++) {
      const t = k / len;
      const xx = Math.round(x + Math.sin(t * 2.6 + phase) * (amp * t));
      const col = t >= 0.45 ? c2 : c1;
      p.px(xx, y0 + k, col);
      if (t > 0.3) p.px(xx + 1, y0 + k, col);
    }
  }

  // 图标底板（暗底；1px 深色描边由 outline 统一收）
  function plate(p) {
    p.rect(1, 1, 14, 14, K2);
    p.rect(1, 1, 14, 1, K3);
    p.rect(1, 13, 14, 1, K1);
    p.rect(1, 1, 1, 14, K3);
  }

  /* ============================================================
   * 1) BOSS ×3
   * ============================================================ */

  /* 深渊鮟鱇 44×38：巨嘴 / 三排獠牙 / 头顶发光诱饵 / 厚皮 / 恶意小眼 */
  S('boss_angler', 44, 38, 4, 22, 34, function (p, f) {
    const by = [0, -1, -1, 0][f];
    const op = [0, 1, 2, 1][f];
    const sw = [0, 1, 0, -1][f];

    // 尾鳍
    p.poly([[36, 18 + by], [43, 11 + by], [41, 21 + by], [43, 31 + by], [36, 26 + by]], K2);
    p.poly([[37, 20 + by], [41, 14 + by], [40, 21 + by], [41, 28 + by], [37, 25 + by]], K4);

    // 背刺
    for (let i = 0; i !== 5; i++) {
      const x = 11 + i * 5;
      p.tri(x, 11 + by, x + 2, 4 + by, x + 4, 11 + by, S2);
      p.tri(x + 1, 10 + by, x + 2, 6 + by, x + 3, 10 + by, K4);
    }

    // 身体：厚皮三档
    p.ellipse(22, 20 + by, 17, 13, K3);
    p.ellipse(21, 18 + by, 15, 10, K4);
    p.ellipse(22, 26 + by, 15, 8, S2);
    p.noise(6, 9 + by, 32, 23, [K3, S2, K4], 17, 0.22);
    p.noise(8, 12 + by, 28, 10, [K4, K3], 41, 0.12);

    // 胸鳍
    p.poly([[6, 25 + by], [0, 33 + by], [10, 32 + by]], K2);
    p.poly([[38, 25 + by], [44, 33 + by], [34, 32 + by]], K2);
    p.poly([[7, 26 + by], [3, 31 + by], [10, 30 + by]], K4);
    p.poly([[37, 26 + by], [41, 31 + by], [34, 30 + by]], K4);
    p.line(5, 28 + by, 8, 31 + by, K0);
    p.line(39, 28 + by, 36, 31 + by, K0);

    // 巨嘴：外唇 → 口腔 → 深喉
    p.ellipse(22, 27 + by, 15, 7 + op, S2);
    p.ellipse(22, 27 + by, 13, 6 + op, K1);
    p.ellipse(22, 28 + by, 10, 3 + op, K0);

    // 三排獠牙
    for (let i = 0; i !== 8; i++) {
      const x = 8 + i * 4;
      p.tri(x, 21 + by, x + 3, 21 + by, x + 1, 25 + by, W);
      p.px(x + 1, 22 + by, K8);
    }
    for (let i = 0; i !== 7; i++) {
      const x = 10 + i * 4;
      p.tri(x, 25 + by, x + 3, 25 + by, x + 1, 28 + by, K8);
    }
    for (let i = 0; i !== 7; i++) {
      const x = 10 + i * 4;
      p.tri(x, 33 + by, x + 3, 33 + by, x + 1, 29 + by, W);
      p.px(x + 1, 32 + by, K8);
    }

    // 小眼睛，透着恶意
    p.ellipse(14, 17 + by, 4, 3, K1);
    p.ellipse(29, 17 + by, 4, 3, K1);
    p.rect(13, 16 + by, 2, 2, R1);
    p.rect(28, 16 + by, 2, 2, R1);
    p.px(13, 16 + by, W);
    p.px(28, 16 + by, W);
    p.line(10, 13 + by, 17, 14 + by, S2);
    p.line(26, 14 + by, 33, 13 + by, S2);

    // 诱饵：弯刺 + 光球
    p.line(16, 13 + by, 13, 9 + by, S2);
    p.line(13, 9 + by, 9 + sw, 6 + by, K4);
    p.px(12, 9 + by, K6);

    p.outline(K0);

    // 光晕叠在描边外，不参与描边
    p.glow(9 + sw, 5 + by, 8, Y2);
    p.circle(9 + sw, 5 + by, 3, Y2);
    p.circle(9 + sw, 5 + by, 2, Y1);
    p.px(9 + sw, 5 + by, W);
    p.glow(9 + sw, 5 + by, 4, W);
    p.glow(20, 12 + by, 10, fa(Y2, 0.10));
  });

  /* 水母女王 48×46：层叠伞盖 / 上百条触须 / 伞盖里一张脸 / 周围小水母 */
  S('boss_queen', 48, 46, 4, 24, 28, function (p, f) {
    const pl = [0, -1, -2, -1][f];
    const ph = f * 1.55;

    // 周围漂浮的小水母
    const jl = [[3, 8], [43, 11], [4, 37], [43, 33], [24, 43]];
    for (let i = 0; i !== jl.length; i++) {
      const jx = jl[i][0], jy = jl[i][1] + ((i + f) % 2 ? 0 : -1);
      p.ellipse(jx, jy, 3, 2, P1);
      p.rect(jx - 2, jy - 1, 5, 1, M1);
      p.px(jx, jy - 1, W);
      p.px(jx - 1, jy + 2, P2);
      p.px(jx + 1, jy + 3, P2);
    }

    // 触须：一圈细的 + 4 条粗口腕
    for (let i = 0; i !== 22; i++) {
      const bx = 4 + i * 1.9;
      const len = 8 + ((i * 7) % 9);
      tentacle(p, bx, 28 + pl, len, ph + i * 0.42, 3.2, M1, P2);
    }
    const arms = [[9, 15], [20, 17], [28, 16], [39, 14]];
    for (let i = 0; i !== arms.length; i++) {
      tentacle(p, arms[i][0], 27 + pl, arms[i][1], ph + i * 1.1, 5, P1, P2);
      tentacle(p, arms[i][0] + 2, 27 + pl, arms[i][1] - 3, ph + i * 1.1 + 0.6, 4, M1, P1);
    }

    // 伞盖：外层实色 + 内层半透明层叠
    p.ellipse(24, 16 + pl, 21, 13, P2);
    p.ellipse(24, 15 + pl, 20, 12, P1);
    p.ellipse(24, 12 + pl, 17, 9, fa(M1, 0.75));
    p.ellipse(24, 9 + pl, 12, 5, fa(M1, 0.55));
    p.noise(8, 5 + pl, 32, 16, [P1, M1, P2], 23, 0.16);
    parc(p, 24, 15 + pl, 18, 10, 3.55, 5.9, K8);
    parc(p, 24, 15 + pl, 15, 8, 3.7, 5.7, fa(W, 0.35));

    // 伞盖边缘的褶
    for (let i = 0; i !== 7; i++) {
      const cx = 6 + i * 6;
      parc(p, cx, 27 + pl, 3, 3, 0.15, Math.PI - 0.15, P2);
      parc(p, cx, 26 + pl, 3, 2, 0.15, Math.PI - 0.15, M1);
    }

    // 伞盖里的一张脸
    p.ellipse(24, 18 + pl, 9, 7, fa(K1, 0.55));
    p.ellipse(19, 16 + pl, 3, 4, K1);
    p.ellipse(29, 16 + pl, 3, 4, K1);
    p.circle(19, 17 + pl, 2, Y2);
    p.circle(29, 17 + pl, 2, Y2);
    p.px(19, 16 + pl, W);
    p.px(29, 16 + pl, W);
    p.px(18, 18 + pl, K0);
    p.px(28, 18 + pl, K0);
    p.line(15, 12 + pl, 22, 11 + pl, P2);
    p.line(26, 11 + pl, 33, 12 + pl, P2);
    p.ellipse(24, 23 + pl, 3, 2, K0);
    p.px(23, 23 + pl, R2);
    p.px(25, 23 + pl, R2);

    p.outline(K0);

    p.glow(24, 16 + pl, 16, M1);
    p.glow(19, 17 + pl, 4, Y2);
    p.glow(29, 17 + pl, 4, Y2);
  });

  /* 沉鲸之王 60×50：鲸骨外骨骼 / 巨大胸鳍 / 藤壶 / 眼窝两点红光 */
  S('boss_whale', 60, 50, 4, 30, 44, function (p, f) {
    const by = [0, -1, 0, 1][f];
    const flap = [0, 2, 3, 1][f];

    // 巨大胸鳍（压在身体下面）
    p.poly([[9, 28 + by], [-2, 42 + flap + by], [18, 44 + by]], K2);
    p.poly([[51, 28 + by], [62, 42 + flap + by], [42, 44 + by]], K2);
    p.poly([[10, 30 + by], [2, 40 + flap + by], [16, 42 + by]], K3);
    p.poly([[50, 30 + by], [58, 40 + flap + by], [44, 42 + by]], K3);
    for (let i = 0; i !== 4; i++) {
      p.line(10 + i * 2, 31 + by, 4 + i * 4, 41 + flap + by, K8);
      p.line(50 - i * 2, 31 + by, 56 - i * 4, 41 + flap + by, K8);
    }

    // 躯干
    p.ellipse(30, 26 + by, 26, 17, K3);
    p.ellipse(30, 21 + by, 24, 12, K4);
    p.ellipse(30, 33 + by, 22, 9, S2);
    p.noise(8, 12 + by, 44, 28, [K3, K4, S2], 31, 0.18);

    // 鲸骨脊梁 + 脊椎节
    parc(p, 30, 30 + by, 25, 16, 3.35, 6.07, K8);
    for (let i = 0; i !== 9; i++) {
      const a = 3.5 + i * 0.32;
      const x = Math.round(30 + Math.cos(a) * 25), y = Math.round(30 + by + Math.sin(a) * 16);
      p.px(x, y - 1, W);
      p.px(x, y + 1, S1);
    }

    // 肋骨
    for (let r = 0; r !== 3; r++) {
      parc(p, 30, 22 + by, 22 - r * 4, 13 - r * 2, 0.55, Math.PI - 0.55, K8);
      parc(p, 30, 23 + by, 18 - r * 3, 12 - r * 2, 0.6, Math.PI - 0.6, S1);
    }

    // 头骨板
    p.poly([[23, 7 + by], [37, 7 + by], [40, 14 + by], [20, 14 + by]], K8);
    p.poly([[25, 9 + by], [35, 9 + by], [37, 13 + by], [23, 13 + by]], W);
    p.line(30, 8 + by, 30, 13 + by, K2);
    p.line(25, 11 + by, 29, 12 + by, K2);
    p.line(35, 11 + by, 31, 12 + by, K2);

    // 眼窝 + 两点红光
    const eye = function (cx) {
      p.ellipse(cx, 25 + by, 6, 5, K0);
      p.ellipse(cx, 25 + by, 5, 4, K1);
      p.circle(cx, 25 + by, 2, R1);
      p.px(cx - 1, 24 + by, W);
      p.line(cx - 6, 19 + by, cx - 3, 21 + by, K2);
      p.line(cx + 6, 19 + by, cx + 3, 21 + by, K2);
      p.line(cx - 6, 31 + by, cx - 3, 29 + by, K2);
      p.line(cx + 6, 31 + by, cx + 3, 29 + by, K2);
    };
    eye(18);
    eye(42);

    // 嘴 + 鲸须
    parc(p, 30, 30 + by, 15, 8, 0.42, Math.PI - 0.42, K0);
    for (let i = 0; i !== 9; i++) {
      const t = 0.52 + i * 0.25;
      const x = Math.round(30 + Math.cos(t) * 15), y = Math.round(30 + by + Math.sin(t) * 8);
      p.line(x, y, x, y + 3, K8);
    }

    // 身上长满藤壶
    const bar = [[13, 17], [46, 19], [30, 40], [23, 37], [37, 34], [11, 25], [49, 27]];
    for (let i = 0; i !== bar.length; i++) {
      const bx = bar[i][0], byy = bar[i][1] + by;
      p.circle(bx, byy, 3, B2);
      p.circle(bx, byy, 2, B1);
      p.px(bx, byy, K0);
      p.px(bx - 1, byy - 1, Y1);
    }

    p.outline(K0);

    p.glow(18, 25 + by, 6, R1);
    p.glow(42, 25 + by, 6, R1);
    p.glow(30, 12 + by, 12, fa(K8, 0.12));
  });

  /* ============================================================
   * 2) 拾取物 ×7
   * ============================================================ */

  /* 经验宝石 7×7 2帧：菱形，中心 W，边缘亮青 */
  S('gem', 7, 7, 2, 3.5, 3.5, function (p, f) {
    if (f === 0) {
      p.poly([[3, 0], [6, 3], [3, 6], [0, 3]], K6);
      p.poly([[3, 1], [5, 3], [3, 5], [1, 3]], K7);
      p.poly([[3, 2], [4, 3], [3, 4], [2, 3]], K8);
      p.px(3, 3, W);
      p.px(2, 2, W);
    } else {
      p.poly([[3, 0], [6, 3], [3, 6], [0, 3]], K7);
      p.poly([[3, 1], [5, 3], [3, 5], [1, 3]], K8);
      p.px(3, 3, W);
      p.px(2, 2, W);
      p.px(4, 2, W);
      p.px(2, 4, W);
    }
    p.outline(K0);
  });

  /* 金币 7×7 2帧：圆 Y2 + Y1 高光，第 2 帧侧转 */
  S('coin', 7, 7, 2, 3.5, 3.5, function (p, f) {
    if (f === 0) {
      p.circle(3, 3, 3, Y2);
      p.circle(3, 3, 2, Y1);
      p.px(2, 2, W);
      p.px(4, 4, O1);
      p.rect(3, 2, 1, 3, O1);
    } else {
      p.ellipse(3, 3, 1, 3, Y2);
      p.ellipse(3, 3, 1, 3, Y1);
      p.px(3, 1, W);
    }
    p.outline(K0);
  });

  /* 宝箱 17×15 2帧：木箱 B1 + 铁箍 S1 + 锁 Y2 */
  S('chest', 17, 15, 2, 8.5, 14, function (p, f) {
    const open = f === 1;
    // 箱体
    p.rect(1, 6, 15, 8, B1);
    p.rect(1, 6, 15, 1, B2);
    p.rect(1, 12, 15, 2, B2);
    p.noise(2, 7, 13, 6, [B1, B2], 9, 0.18);
    // 铁箍
    p.rect(3, 6, 2, 8, S1);
    p.rect(12, 6, 2, 8, S1);
    p.rect(3, 6, 1, 8, S2);
    p.rect(12, 6, 1, 8, S2);
    p.px(3, 8, K8);
    p.px(4, 11, K8);
    p.px(12, 8, K8);
    p.px(13, 11, K8);
    // 箱盖
    if (!open) {
      p.rect(1, 2, 15, 5, B1);
      p.rect(1, 2, 15, 1, B2);
      p.rect(1, 2, 15, 1, S1);
      p.rect(3, 2, 2, 5, S1);
      p.rect(12, 2, 2, 5, S1);
      p.line(2, 4, 14, 4, B2);
      p.rect(7, 5, 3, 3, Y2);
      p.px(8, 6, K0);
    } else {
      p.rect(1, 0, 15, 3, B1);
      p.rect(1, 0, 15, 1, S1);
      p.rect(3, 0, 2, 3, S1);
      p.rect(12, 0, 2, 3, S1);
      p.rect(2, 4, 13, 2, Y2);
      p.rect(4, 4, 9, 1, Y1);
      p.px(6, 3, W);
      p.px(10, 3, W);
      p.rect(7, 8, 3, 3, Y1);
      p.px(8, 9, K0);
    }
    p.outline(K0);
    if (f === 1) p.glow(8, 5, 7, Y2);
  });

  /* 红心 11×11 */
  S('heart', 11, 11, 1, 5.5, 5.5, function (p) {
    p.ellipse(3, 4, 3, 3, R2);
    p.ellipse(7, 4, 3, 3, R2);
    p.tri(1, 5, 10, 5, 5, 10, R2);
    p.ellipse(3, 4, 2, 2, R1);
    p.ellipse(7, 4, 2, 2, R1);
    p.tri(2, 5, 9, 5, 5, 9, R1);
    p.px(3, 3, W);
    p.px(4, 3, W);
    p.px(3, 4, Y1);
    p.outline(K0);
  });

  /* 磁铁 11×11 */
  S('magnet', 11, 11, 1, 5.5, 5.5, function (p) {
    p.rect(2, 1, 2, 7, R1);
    p.rect(7, 1, 2, 7, R1);
    p.rect(2, 6, 7, 2, R1);
    p.rect(2, 1, 1, 7, R2);
    p.rect(3, 2, 1, 6, M1);
    p.rect(8, 4, 1, 4, R2);
    p.rect(2, 1, 2, 3, S1);
    p.rect(7, 1, 2, 3, S1);
    p.px(2, 1, K8);
    p.px(8, 1, K8);
    p.outline(K0);
  });

  /* 炸弹 11×11：K2 球 + Y2 引线 */
  S('bomb', 11, 11, 1, 5.5, 5.5, function (p) {
    p.circle(5, 6, 4, K2);
    p.circle(4, 5, 3, K3);
    p.px(3, 4, K5);
    p.px(4, 3, K5);
    p.px(3, 8, K1);
    p.rect(4, 1, 2, 2, S1);
    p.line(6, 1, 8, 0, Y2);
    p.px(8, 0, O1);
    p.px(9, 1, Y1);
    p.outline(K0);
  });

  /* 星星 9×9 2帧：Y1/Y2 */
  S('star', 9, 9, 2, 4.5, 4.5, function (p, f) {
    const pts = [[4, 0], [5, 3], [8, 3], [6, 5], [7, 8], [4, 6], [1, 8], [2, 5], [0, 3], [3, 3]];
    p.poly(pts, Y2);
    if (f === 0) {
      p.tri(4, 1, 5, 3, 3, 3, Y1);
      p.px(4, 4, W);
      p.px(4, 5, Y1);
    } else {
      p.tri(4, 1, 6, 4, 2, 4, Y1);
      p.px(4, 3, W);
      p.px(3, 4, W);
      p.px(5, 4, Y1);
    }
    p.outline(K0);
  });

  /* ============================================================
   * 3) 场景装饰 ×10（底部当锚点）
   * ============================================================ */

  /* 高珊瑚 20×26：分枝状，粉紫，底部深色 */
  S('coral_a', 20, 26, 1, 10, 26, function (p) {
    p.ellipse(10, 25, 7, 2, K2);
    p.rect(9, 12, 3, 13, P2);
    p.poly([[12, 20], [17, 13], [19, 15], [13, 22]], P1);
    p.poly([[9, 18], [4, 11], [2, 13], [8, 20]], P1);
    p.poly([[12, 15], [16, 8], [18, 10], [13, 17]], P2);
    p.line(10, 22, 5, 15, M1);
    p.line(11, 18, 15, 11, M1);
    p.circle(4, 10, 2, M1);
    p.circle(17, 7, 2, M1);
    p.circle(18, 14, 2, P1);
    p.circle(10, 8, 2, M1);
    p.circle(4, 9, 1, W);
    p.circle(17, 6, 1, W);
    p.px(10, 7, W);
    p.px(6, 13, P2);
    p.px(15, 16, P2);
    p.outline(K0);
  });

  /* 矮扇形珊瑚 26×18：O1/Y1 */
  S('coral_b', 26, 18, 1, 13, 18, function (p) {
    p.poly([[1, 17], [13, 3], [25, 17]], O1);
    p.poly([[4, 17], [13, 7], [22, 17]], Y1);
    for (let i = 0; i !== 7; i++) {
      const a = Math.PI + 0.28 + i * 0.43;
      p.line(13, 17, Math.round(13 + Math.cos(a) * 11), Math.round(17 + Math.sin(a) * 14), O1);
    }
    p.poly([[8, 17], [13, 10], [18, 17]], O1);
    p.ellipse(13, 17, 6, 2, B1);
    p.px(9, 9, W);
    p.px(17, 9, W);
    p.outline(K0);
  });

  /* 管状海绵 16×22：G2/K6 */
  S('coral_c', 16, 22, 1, 8, 22, function (p) {
    p.ellipse(8, 21, 7, 2, K2);
    const tubes = [[1, 6, 4, 15], [6, 3, 4, 18], [11, 7, 4, 14]];
    for (let i = 0; i !== tubes.length; i++) {
      const x = tubes[i][0], y = tubes[i][1], w = tubes[i][2], h = tubes[i][3];
      p.rect(x, y, w, h, G2);
      p.rect(x, y, 1, h, K6);
      p.rect(x + w - 1, y, 1, h, P2);
      p.ellipse(x + Math.floor(w / 2), y, 2, 1, K1);
      p.px(x + 1, y + 1, K8);
    }
    p.rect(2, 17, 3, 3, K4);
    p.px(5, 12, G1);
    p.px(9, 9, G1);
    p.outline(K0);
  });

  /* 岩石 24×18：S2/K3 块面 */
  S('rock_a', 24, 18, 1, 12, 18, function (p) {
    p.ellipse(12, 17, 11, 3, K1);
    p.poly([[2, 17], [4, 8], [9, 3], [16, 4], [21, 10], [22, 17]], S2);
    p.poly([[5, 16], [6, 9], [10, 5], [15, 6], [19, 11], [20, 16]], S1);
    p.poly([[6, 9], [10, 5], [12, 11], [8, 13]], K3);
    p.poly([[14, 12], [18, 10], [19, 16], [13, 16]], K3);
    p.noise(4, 5, 17, 11, [S2, K3, S1], 13, 0.2);
    p.line(8, 14, 11, 15, K2);
    p.outline(K0);
  });

  /* 小石头堆 18×14 */
  S('rock_b', 18, 14, 1, 9, 14, function (p) {
    p.ellipse(9, 13, 8, 2, K1);
    p.poly([[1, 13], [2, 9], [6, 7], [9, 10], [8, 13]], S2);
    p.poly([[3, 12], [4, 9], [6, 8], [7, 11]], S1);
    p.poly([[9, 13], [10, 6], [14, 4], [17, 8], [16, 13]], S2);
    p.poly([[11, 12], [12, 7], [14, 6], [15, 9], [15, 12]], S1);
    p.poly([[6, 13], [7, 10], [11, 9], [12, 13]], K3);
    p.noise(2, 5, 14, 8, [S2, K3, S1], 29, 0.22);
    p.outline(K0);
  });

  /* 海带 10×32：深绿长条 K4/G1 */
  S('kelp_a', 10, 32, 1, 5, 32, function (p) {
    for (let y = 0; y !== 31; y++) {
      const t = y / 31;
      const x = Math.round(5 + Math.sin(t * 7.5) * 2.6);
      const w = t >= 0.15 ? 3 : 2;
      p.rect(x - 1, y, w, 1, K4);
      p.px(x + 1, y, G1);
      if (y % 4 === 0) p.px(x - 1, y, G2);
    }
    p.ellipse(5, 31, 4, 1, K2);
    p.px(3, 8, G1);
    p.px(7, 14, G2);
    p.px(3, 21, G1);
    p.outline(K0);
  });

  /* 宽海带 14×24 */
  S('kelp_b', 14, 24, 1, 7, 24, function (p) {
    for (let y = 0; y !== 23; y++) {
      const t = y / 23;
      const x = Math.round(7 + Math.sin(t * 5.4) * 3);
      const w = 4 + (y % 6 === 0 ? 2 : 0);
      p.rect(x - Math.floor(w / 2), y, w, 1, K4);
      p.rect(x - Math.floor(w / 2) + 1, y, 2, 1, G1);
    }
    p.ellipse(7, 23, 5, 1, K2);
    p.px(4, 6, G2);
    p.px(9, 11, G2);
    p.px(4, 17, G2);
    p.outline(K0);
  });

  /* 海底热泉口 18×18：黑石 + 顶部 O1 余烬 */
  S('vent', 18, 18, 1, 9, 18, function (p) {
    p.ellipse(9, 17, 8, 2, K0);
    p.ellipse(9, 14, 7, 4, K2);
    p.ellipse(9, 12, 5, 3, K1);
    p.rect(4, 12, 10, 5, K2);
    p.ellipse(9, 11, 4, 2, K0);
    p.ellipse(9, 11, 3, 1, O1);
    p.px(8, 11, Y2);
    p.px(10, 11, Y2);
    p.px(9, 9, O1);
    p.px(7, 7, O1);
    p.px(11, 6, R2);
    p.px(9, 5, R2);
    p.noise(3, 12, 12, 5, [K2, K3, K1], 7, 0.25);
    p.outline(K0);
    p.glow(9, 10, 6, O1);
  });

  /* 贝壳 14×11：S1/K8 */
  S('shell_a', 14, 11, 1, 7, 11, function (p) {
    p.poly([[2, 10], [7, 1], [12, 10]], S1);
    for (let i = 0; i !== 5; i++) {
      const a = Math.PI + 0.35 + i * 0.55;
      p.line(7, 10, Math.round(7 + Math.cos(a) * 5.5), Math.round(10 + Math.sin(a) * 8.5), K3);
    }
    p.poly([[5, 10], [7, 5], [9, 10]], K8);
    p.px(7, 4, W);
    p.ellipse(7, 10, 5, 1, K8);
    p.outline(K0);
  });

  /* 沉船木板 / 大骨 20×12：B2/K8 */
  S('bone_a', 20, 12, 1, 10, 12, function (p) {
    // 木板
    p.poly([[0, 9], [1, 5], [19, 7], [18, 11]], B2);
    p.poly([[1, 6], [18, 8], [18, 9], [1, 7]], B1);
    p.line(4, 7, 4, 10, K1);
    p.line(10, 8, 10, 11, K1);
    p.line(16, 8, 16, 11, K1);
    p.noise(1, 6, 17, 4, [B1, B2], 19, 0.16);
    // 骨头
    p.rect(6, 2, 8, 2, K8);
    p.circle(6, 3, 2, K8);
    p.circle(14, 3, 2, K8);
    p.circle(6, 3, 1, W);
    p.circle(14, 3, 1, S1);
    p.line(6, 4, 14, 4, S1);
    p.outline(K0);
  });

  /* ============================================================
   * 4) 武器图标 ×14（16×16，暗底 + 亮物体）
   * ============================================================ */

  /* 鱼叉：双叉 + 倒钩 + 长杆 */
  S('w_harpoon', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.line(8, 5, 8, 14, S1);
    p.line(9, 5, 9, 14, S2);
    p.line(8, 6, 4, 2, K8);
    p.line(9, 6, 13, 2, K8);
    p.px(3, 2, W);
    p.px(4, 1, W);
    p.px(14, 2, W);
    p.px(13, 1, W);
    p.px(5, 5, Y2);
    p.px(6, 4, Y2);
    p.px(11, 5, Y2);
    p.px(10, 4, Y2);
    p.rect(6, 13, 5, 2, B1);
    p.px(6, 13, B2);
    p.outline(K0);
  });

  /* 泡沫：三个气泡 */
  S('w_bubble', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.circle(6, 9, 4, K6);
    p.circle(6, 9, 3, K5);
    p.ring(6, 9, 4, K8);
    p.px(5, 7, W);
    p.px(6, 7, W);
    p.circle(12, 5, 2, K6);
    p.ring(12, 5, 2, K8);
    p.px(12, 4, W);
    p.circle(12, 12, 2, K5);
    p.ring(12, 12, 2, K7);
    p.px(11, 11, K8);
    p.outline(K0);
  });

  /* 船锚 */
  S('w_anchor', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.ring(8, 3, 2, K8);
    p.px(8, 1, W);
    p.rect(7, 5, 2, 8, S1);
    p.rect(7, 5, 1, 8, K8);
    p.rect(4, 6, 8, 2, S1);
    p.rect(4, 6, 8, 1, K8);
    p.px(4, 7, S2);
    p.px(11, 7, S2);
    parc(p, 8, 10, 5, 4, 0.15, Math.PI - 0.15, K8);
    p.line(3, 10, 2, 12, K8);
    p.px(2, 13, W);
    p.px(1, 12, W);
    p.line(13, 10, 14, 12, K8);
    p.px(14, 13, W);
    p.px(15, 12, W);
    p.outline(K0);
  });

  /* 电鳗：S 形身体 + 电弧 */
  S('w_eel', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    parc(p, 6, 6, 4, 4, 3.1, 5.9, G2);
    parc(p, 10, 10, 4, 4, 0.1, 2.9, G2);
    parc(p, 6, 6, 3, 3, 3.2, 5.8, G1);
    parc(p, 10, 10, 3, 3, 0.2, 2.8, G1);
    p.circle(2, 4, 1, G1);
    p.px(1, 3, K8);
    p.px(2, 3, W);
    p.line(12, 3, 9, 6, W);
    p.line(9, 6, 12, 7, W);
    p.line(4, 12, 6, 10, W);
    p.px(13, 9, G1);
    p.px(13, 10, G1);
    p.outline(K0);
  });

  /* 海胆：P2 球 + W 尖刺 */
  S('w_urchin', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    for (let i = 0; i !== 12; i++) {
      const a = i * Math.PI / 6;
      const x1 = Math.round(8 + Math.cos(a) * 5), y1 = Math.round(8 + Math.sin(a) * 5);
      const x2 = Math.round(8 + Math.cos(a) * 7), y2 = Math.round(8 + Math.sin(a) * 7);
      p.line(x1, y1, x2, y2, K8);
      p.px(x2, y2, W);
    }
    p.circle(8, 8, 4, P2);
    p.circle(7, 7, 2, P1);
    p.px(7, 6, M1);
    p.px(6, 7, W);
    p.outline(K0);
  });

  /* 声呐：同心弧 + 亮点 */
  S('w_sonar', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.circle(4, 12, 2, G2);
    p.circle(4, 12, 1, K8);
    parc(p, 4, 12, 5, 5, -1.45, -0.1, G1);
    parc(p, 4, 12, 8, 8, -1.45, -0.1, G1);
    parc(p, 4, 12, 11, 11, -1.45, -0.1, G2);
    p.px(9, 6, W);
    p.px(12, 4, K8);
    p.px(13, 3, K8);
    p.px(10, 8, K8);
    p.outline(K0);
  });

  /* 墨汁：墨团 + 飞溅 */
  S('w_ink', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.ellipse(8, 9, 5, 4, P2);
    p.ellipse(7, 8, 3, 2, P1);
    p.px(6, 7, M1);
    p.px(7, 7, M1);
    p.px(6, 8, M1);
    p.circle(13, 5, 1, P1);
    p.circle(3, 5, 1, P1);
    p.circle(12, 12, 1, P1);
    p.px(2, 10, P2);
    p.px(14, 9, P2);
    p.line(8, 4, 8, 1, P2);
    p.px(7, 2, P1);
    p.px(9, 2, P1);
    p.outline(K0);
  });

  /* 潮汐：三道波浪 */
  S('w_tide', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    const wave = function (y, c) {
      for (let x = 2; x !== 14; x++) {
        const yy = Math.round(y + Math.sin((x - 2) * 0.7) * 1.6);
        p.px(x, yy, c);
        p.px(x, yy + 1, c);
      }
    };
    wave(5, K5);
    wave(8, K6);
    wave(11, K7);
    p.px(4, 4, K8);
    p.px(5, 4, W);
    p.px(9, 7, K8);
    p.px(10, 7, K8);
    p.px(4, 10, W);
    p.px(12, 13, K8);
    p.outline(K0);
  });

  /* 珍珠：贝壳托珠 */
  S('w_pearl', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.circle(8, 7, 4, K8);
    p.circle(8, 7, 3, W);
    p.px(6, 6, W);
    p.circle(7, 9, 2, K8);
    parc(p, 8, 14, 6, 4, 3.25, 6.2, S1);
    parc(p, 8, 14, 5, 3, 3.35, 6.1, K8);
    p.px(2, 12, S1);
    p.px(14, 12, S1);
    p.outline(K0);
  });

  /* 骨枪：骨矛 + 螺旋骨纹 */
  S('w_lance', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.line(3, 13, 10, 6, K8);
    p.line(4, 14, 11, 7, S1);
    p.poly([[10, 6], [13, 1], [14, 2], [12, 7]], W);
    p.px(13, 1, K8);
    p.px(9, 6, K8);
    p.line(9, 8, 11, 10, K8);
    p.line(6, 11, 8, 13, K8);
    p.rect(2, 12, 3, 2, B1);
    p.px(2, 13, B2);
    p.px(11, 5, S1);
    p.px(12, 4, S1);
    p.outline(K0);
  });

  /* 鱼群：三条鱼 */
  S('w_swarm', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    const fish = function (x, y, c, c2) {
      p.ellipse(x, y, 2, 1, c);
      p.tri(x - 3, y, x - 5, y - 2, x - 5, y + 2, c2);
      p.px(x + 1, y, K0);
    };
    fish(9, 4, K7, K5);
    fish(6, 8, K8, K6);
    fish(10, 12, K6, K4);
    p.px(11, 3, W);
    p.px(8, 7, W);
    p.px(3, 12, K5);
    p.px(4, 13, K5);
    p.outline(K0);
  });

  /* 寒气：雪花 */
  S('w_aura', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    for (let i = 0; i !== 6; i++) {
      const a = i * Math.PI / 3;
      const x2 = Math.round(8 + Math.cos(a) * 6), y2 = Math.round(8 + Math.sin(a) * 6);
      p.line(8, 8, x2, y2, K8);
      const mx = Math.round(8 + Math.cos(a) * 3.5), my = Math.round(8 + Math.sin(a) * 3.5);
      p.px(mx + 1, my, K7);
      p.px(mx, my + 1, K7);
      p.px(x2, y2, W);
    }
    p.circle(8, 8, 2, K7);
    p.px(8, 8, W);
    p.outline(K0);
  });

  /* 锁链：三环相扣 */
  S('w_chain', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.ring(8, 3, 2, S1);
    p.px(8, 1, K8);
    p.ring(8, 8, 3, S1);
    p.ring(8, 8, 2, S2);
    p.px(6, 5, K8);
    p.px(10, 5, K8);
    p.ring(8, 13, 2, S1);
    p.px(8, 15, K8);
    p.px(8, 6, K8);
    p.outline(K0);
  });

  /* 鲸歌：鲸影 + 声波弧 */
  S('w_whale', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.ellipse(5, 9, 4, 3, K6);
    p.poly([[2, 9], [0, 6], [1, 10], [0, 13]], K5);
    p.ellipse(5, 10, 3, 2, K8);
    p.px(7, 8, K0);
    p.px(8, 8, W);
    p.px(3, 7, K7);
    parc(p, 10, 8, 3, 3, -0.6, 0.6, G2);
    parc(p, 10, 8, 5, 5, -0.6, 0.6, G1);
    parc(p, 10, 8, 6, 6, -0.5, 0.5, G2);
    p.outline(K0);
  });

  /* ============================================================
   * 5) 被动图标 ×12（16×16）
   * ============================================================ */

  /* 伤害：剑 */
  S('i_power', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.line(5, 11, 12, 3, K8);
    p.line(6, 12, 13, 4, S1);
    p.line(5, 10, 12, 2, W);
    p.px(12, 2, W);
    p.px(13, 3, W);
    p.line(3, 10, 7, 13, Y2);
    p.line(4, 9, 8, 12, Y2);
    p.rect(2, 12, 3, 2, B1);
    p.px(2, 13, B2);
    p.outline(K0);
  });

  /* 范围：同心圆环 */
  S('i_area', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.ring(8, 8, 6, K5);
    p.ring(8, 8, 4, K6);
    p.ring(8, 8, 2, K7);
    p.circle(8, 8, 1, Y2);
    p.px(8, 1, K8);
    p.px(8, 15, K8);
    p.px(1, 8, K8);
    p.px(15, 8, K8);
    p.outline(K0);
  });

  /* 移速：靴子 + 速度线 */
  S('i_speed', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.poly([[6, 3], [11, 3], [11, 8], [14, 11], [14, 13], [6, 13]], B1);
    p.poly([[7, 4], [10, 4], [10, 8], [13, 11], [13, 12], [7, 12]], B2);
    p.rect(4, 12, 11, 2, S1);
    p.rect(4, 12, 11, 1, K8);
    p.px(8, 6, S1);
    p.px(9, 6, S1);
    p.line(2, 5, 5, 5, Y2);
    p.line(1, 8, 4, 8, Y2);
    p.line(2, 11, 3, 11, Y1);
    p.outline(K0);
  });

  /* 冷却：沙漏 */
  S('i_cd', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.rect(3, 2, 10, 2, Y2);
    p.rect(3, 12, 10, 2, Y2);
    p.poly([[4, 4], [11, 4], [8, 8]], S1);
    p.poly([[4, 11], [11, 11], [8, 8]], S1);
    p.poly([[7, 4], [9, 4], [8, 6]], Y1);
    p.tri(5, 11, 10, 11, 8, 8, Y2);
    p.px(8, 10, O1);
    p.px(4, 3, K8);
    p.px(11, 3, K8);
    p.line(8, 1, 8, 2, K8);
    p.outline(K0);
  });

  /* 数量：三颗点 */
  S('i_amount', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.circle(8, 5, 2, Y2);
    p.px(8, 4, Y1);
    p.circle(5, 11, 2, Y2);
    p.px(5, 10, Y1);
    p.circle(11, 11, 2, Y2);
    p.px(11, 10, Y1);
    p.px(8, 9, K6);
    p.px(8, 10, K6);
    p.outline(K0);
  });

  /* 持续：无穷符号 */
  S('i_duration', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.ring(5, 8, 2, G2);
    p.ring(11, 8, 2, G2);
    p.px(7, 7, G2);
    p.px(9, 7, G2);
    p.px(7, 9, G2);
    p.px(9, 9, G2);
    p.px(4, 7, G1);
    p.px(4, 6, K8);
    p.px(12, 7, G1);
    p.px(12, 6, K8);
    p.outline(K0);
  });

  /* 拾取：磁铁 */
  S('i_magnet', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.rect(4, 3, 3, 8, R1);
    p.rect(9, 3, 3, 8, R1);
    p.rect(4, 9, 8, 3, R1);
    p.rect(4, 3, 1, 8, R2);
    p.rect(11, 3, 1, 8, R2);
    p.rect(5, 4, 1, 6, M1);
    p.rect(4, 2, 3, 3, S1);
    p.rect(9, 2, 3, 3, S1);
    p.px(4, 2, K8);
    p.px(10, 2, K8);
    p.outline(K0);
  });

  /* 减伤：盾 */
  S('i_armor', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.poly([[3, 3], [13, 3], [13, 9], [8, 14], [3, 9]], K5);
    p.poly([[4, 4], [12, 4], [12, 9], [8, 13], [4, 9]], K6);
    p.poly([[5, 5], [11, 5], [11, 8], [8, 11], [5, 8]], K4);
    p.circle(8, 8, 2, S1);
    p.circle(8, 8, 1, K8);
    p.px(6, 6, K8);
    p.px(10, 6, K8);
    p.outline(K0);
  });

  /* 回血：心 + 十字 */
  S('i_regen', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.circle(5, 6, 3, R2);
    p.circle(10, 6, 3, R2);
    p.tri(2, 7, 13, 7, 7, 13, R2);
    p.circle(5, 6, 2, R1);
    p.circle(10, 6, 2, R1);
    p.tri(3, 7, 12, 7, 7, 12, R1);
    p.px(4, 5, W);
    p.rect(7, 4, 2, 7, W);
    p.rect(5, 6, 6, 2, W);
    p.px(8, 6, K8);
    p.outline(K0);
  });

  /* 幸运：四叶草 */
  S('i_luck', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.circle(6, 6, 3, G1);
    p.circle(10, 6, 3, G1);
    p.circle(6, 10, 3, G1);
    p.circle(10, 10, 3, G1);
    p.circle(6, 6, 1, K4);
    p.circle(10, 6, 1, K4);
    p.circle(6, 10, 1, K4);
    p.circle(10, 10, 1, K4);
    p.px(5, 5, K8);
    p.px(9, 5, K8);
    p.rect(8, 11, 1, 4, K4);
    p.px(7, 14, G2);
    p.outline(K0);
  });

  /* 暴击：四角星 */
  S('i_crit', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.poly([[8, 1], [10, 6], [15, 8], [10, 10], [8, 15], [6, 10], [1, 8], [6, 6]], Y2);
    p.poly([[8, 3], [9, 7], [13, 8], [9, 9], [8, 13], [7, 9], [3, 8], [7, 7]], Y1);
    p.px(8, 8, W);
    p.px(8, 7, W);
    p.px(7, 8, W);
    p.px(4, 4, R1);
    p.px(12, 4, R1);
    p.px(4, 12, R1);
    p.px(12, 12, R1);
    p.outline(K0);
  });

  /* 经验：书 */
  S('i_pickup', 16, 16, 1, 8, 8, function (p) {
    plate(p);
    p.rect(2, 3, 11, 10, B1);
    p.rect(2, 3, 11, 1, B2);
    p.rect(2, 12, 11, 1, B2);
    p.rect(2, 3, 2, 10, B2);
    p.rect(4, 4, 8, 8, Y1);
    p.rect(4, 4, 8, 1, Y2);
    p.rect(6, 4, 1, 8, Y2);
    p.px(9, 6, K5);
    p.px(10, 6, K5);
    p.px(9, 7, K5);
    p.px(9, 9, K5);
    p.px(10, 9, K5);
    p.rect(12, 6, 2, 3, R1);
    p.outline(K0);
  });

})();
