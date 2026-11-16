/* ============================================================
 * 鲸落·深渊 —— 界面层（世界渲染 / HUD / 菜单 / 升级 / 结算）
 * ============================================================ */
(function () {
  'use strict';
  const G = window.G;
  const Game = G.Game;
  const Cam = G.camera;
  const UI = (G.UI = {});
  const P = G.PAL;

  const buttons = [];
  let hoverId = null;

  /* ---------- 确定性随机（装饰物用） ---------- */
  function hash2(x, y) {
    let h = x * 374761393 + y * 668265263;
    h = (h ^ (h >> 13)) * 1274126177;
    h = h ^ (h >> 16);
    return (h >>> 0) / 4294967296;
  }
  function hash3(x, y, s) {
    return hash2(x * 31 + s * 7, y * 17 + s * 13);
  }

  /* ---------- 地面纹理 ---------- */
  const TILE = 128;
  let floorTile = null;
  UI.buildFloor = function () {
    const p = new G.Px(TILE, TILE);
    p.rect(0, 0, TILE, TILE, '#0a1020');
    // 大块暗斑
    let s = 12345;
    const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
    for (let i = 0; i < 26; i++) {
      const x = rnd() * TILE, y = rnd() * TILE, r = 8 + rnd() * 26;
      p.ellipse(x, y, r, r * 0.7, rnd() < 0.5 ? '#0c1426' : '#080d19');
    }
    // 细沙点
    for (let i = 0; i < 700; i++) {
      const x = (rnd() * TILE) | 0, y = (rnd() * TILE) | 0;
      const c = rnd();
      p.px(x, y, c < 0.5 ? '#111a2e' : c < 0.85 ? '#0d1526' : '#16223c');
    }
    // 一点点亮砂
    for (let i = 0; i < 40; i++) {
      p.px((rnd() * TILE) | 0, (rnd() * TILE) | 0, '#25324d');
    }
    floorTile = p.cv;
  };

  /* ---------- 装饰物池 ---------- */
  const DECOR = ['coral_a', 'coral_b', 'coral_c', 'rock_a', 'rock_b', 'kelp_a', 'kelp_b', 'vent', 'shell_a', 'bone_a'];
  const CELL = 150;

  function drawDecor(ctx) {
    const cx0 = Math.floor((Cam.x - G.W / 2 - 60) / CELL);
    const cx1 = Math.floor((Cam.x + G.W / 2 + 60) / CELL);
    const cy0 = Math.floor((Cam.y - G.H / 2 - 60) / CELL);
    const cy1 = Math.floor((Cam.y + G.H / 2 + 60) / CELL);
    const t = Game.time;
    for (let gy = cy0; gy <= cy1; gy++) {
      for (let gx = cx0; gx <= cx1; gx++) {
        const n = 1 + Math.floor(hash3(gx, gy, 1) * 2.4);
        for (let i = 0; i < n; i++) {
          const h1 = hash3(gx, gy, i * 5 + 2);
          const h2 = hash3(gx, gy, i * 5 + 3);
          const h3 = hash3(gx, gy, i * 5 + 4);
          if (h3 < 0.18) continue;
          const id = DECOR[(h1 * DECOR.length) | 0];
          const ax = gx * CELL + h2 * CELL;
          const ay = gy * CELL + h3 * CELL;
          const a = G.BAKED[id];
          if (!a) continue;
          const sway = id.indexOf('kelp') === 0 ? Math.sin(t * 1.1 + h1 * 9) * 1.2 : 0;
          ctx.globalAlpha = 0.85;
          G.drawArt(ctx, id, ax + sway, ay, { f: (t * 2 + h1 * 10) | 0 });
          ctx.globalAlpha = 1;
        }
      }
    }
  }

  /* ---------- 世界渲染 ---------- */
  function renderWorld(ctx) {
    const p = Game.player;
    ctx.save();
    Cam.apply(ctx);

    // ---- 地面 ----
    const ox = -((Cam.x - G.W / 2) % TILE + TILE) % TILE;
    const oy = -((Cam.y - G.H / 2) % TILE + TILE) % TILE;
    const startX = Cam.x - G.W / 2, startY = Cam.y - G.H / 2;
    const px0 = Math.floor(startX / TILE) * TILE;
    const py0 = Math.floor(startY / TILE) * TILE;
    for (let y = py0; y < startY + G.H + TILE; y += TILE) {
      for (let x = px0; x < startX + G.W + TILE; x += TILE) {
        ctx.drawImage(floorTile, x, y);
      }
    }

    // ---- 海底光斑 ----
    ctx.globalCompositeOperation = 'lighter';
    const t = Game.time;
    for (let i = 0; i < 5; i++) {
      const bx = Cam.x + Math.sin(t * 0.16 + i * 2.1) * 260;
      const by = Cam.y + Math.cos(t * 0.11 + i * 1.7) * 150;
      const r = 90 + Math.sin(t * 0.3 + i) * 30;
      const g = ctx.createRadialGradient(bx, by, 0, bx, by, r);
      g.addColorStop(0, 'rgba(80,150,220,0.055)');
      g.addColorStop(1, 'rgba(80,150,220,0)');
      ctx.fillStyle = g;
      ctx.fillRect(bx - r, by - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';

    // ---- 装饰 ----
    drawDecor(ctx);

    // ---- 危险区（墨池等） ----
    for (const h of Game.hazards) {
      const k = Math.min(1, h.life / 0.4);
      ctx.globalAlpha = 0.5 * k;
      ctx.fillStyle = h.color || 'rgba(90,40,150,0.8)';
      ctx.beginPath();
      ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = h.edge || 'rgba(160,90,255,0.5)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(h.x, h.y, h.r, 0, Math.PI * 2);
      ctx.stroke();
    }

    // ---- 拾取物 ----
    for (const it of Game.pickups) {
      if (!Cam.inView(it.x, it.y, 20)) continue;
      const bob = Math.sin(it.t * 6 + it.x * 0.1) * 1.2;
      const fid = (Game.frame / 8 + it.x) | 0;
      if (it.type === 'gem') {
        G.glowCircle(ctx, it.x, it.y + bob, 9, '#8fd4f0', 0.35);
        G.drawArt(ctx, 'gem', it.x, it.y + bob, { f: fid });
      } else if (it.type === 'coin') {
        G.drawArt(ctx, 'coin', it.x, it.y + bob, { f: fid });
      } else if (it.type === 'heart') {
        G.glowCircle(ctx, it.x, it.y + bob, 11, '#ff5a6e', 0.35);
        G.drawArt(ctx, 'heart', it.x, it.y + bob);
      } else if (it.type === 'chest') {
        G.glowCircle(ctx, it.x, it.y + bob, 22, '#ffc84a', 0.4);
        G.drawArt(ctx, 'chest', it.x, it.y + bob, { f: (Game.frame / 20 | 0) % 2 });
      }
    }

    // ---- 敌人 ----
    for (const e of Game.enemies) {
      if (!Cam.inView(e.x, e.y, 60)) continue;
      const a = G.BAKED[e.def.art];
      // 影子
      ctx.globalAlpha = 0.22;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(e.x, e.y + (a ? a.ay * 0.72 : e.r), e.r * 1.05, e.r * 0.48, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      let scale = 1;
      if (e.boss) scale = 1;
      if (e.elite) scale = 1.22;
      const flip = e.facing < 0;
      const f = (Game.frame / 7 + (e.x | 0)) | 0;

      // 精英光环
      if (e.elite) {
        G.glowCircle(ctx, e.x, e.y - e.r * 0.4, e.r * 2.4, '#ff5a6e', 0.3);
      }
      if (e.freeze > 0) {
        G.glowCircle(ctx, e.x, e.y - e.r * 0.4, e.r * 2, '#8fd4f0', 0.4);
      }
      if (e.def.art && G.BAKED[e.def.art]) {
        ctx.save();
        if (e.flash > 0) {
          ctx.filter = 'brightness(2.4) saturate(0.3)';
        }
        G.drawArt(ctx, e.def.art, e.x, e.y, { f, flip, scale: e.elite ? 1.22 : 1 });
        ctx.restore();
      } else {
        ctx.fillStyle = '#ff5a6e';
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
        ctx.fill();
      }
      // 血条（非小怪）
      if ((e.boss || e.elite) && e.hp < e.maxHp) {
        const w = e.boss ? 0 : Math.max(14, e.r * 2.2);
        if (w > 0) {
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(e.x - w / 2, e.y - (a ? a.ay : e.r) - 7, w, 3);
          ctx.fillStyle = '#ff5a6e';
          ctx.fillRect(e.x - w / 2, e.y - (a ? a.ay : e.r) - 7, w * (e.hp / e.maxHp), 3);
        }
      }
    }

    // ---- 子弹 ----
    for (const b of Game.bullets) {
      if (!Cam.inView(b.x, b.y, 30)) continue;
      if (b.art && G.BAKED[b.art]) {
        G.drawArt(ctx, b.art, b.x, b.y, { rot: b.rot, scale: b.scale, f: (Game.frame / 6) | 0 });
      } else {
        G.glowCircle(ctx, b.x, b.y, b.r * 4.5, b.color, 0.5);
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.beginPath();
        ctx.arc(b.x, b.y, b.r * 0.45, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- 玩家 ----
    if (p) {
      // 影子
      ctx.globalAlpha = 0.28;
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.ellipse(p.x, p.y + 7, 7, 3.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;

      // 柔光
      G.glowCircle(ctx, p.x, p.y - 4, 26, '#4a90d9', 0.20);

      const flick = p.invuln > 0 && (Math.floor(p.invuln * 20) % 2 === 0);
      if (!flick) {
        const moving = Math.abs(p.vx) + Math.abs(p.vy) > 1;
        const f = moving ? (((p.animT * 9) | 0) % 4) : (((p.animT * 3) | 0) % 4);
        G.drawArt(ctx, 'whale', p.x, p.y - 2, { f, flip: p.facing < 0 });
      }

      // 冰霜/受击染色
      if (p.hurtT > 0) {
        ctx.globalAlpha = p.hurtT * 1.6;
        ctx.globalCompositeOperation = 'source-atop';
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
      }
    }

    // ---- 粒子 ----
    for (const pt of Game.particles) {
      const k = Math.max(0, pt.life / pt.max);
      ctx.globalAlpha = pt.glow ? k * 0.9 : k;
      ctx.fillStyle = pt.color;
      const r = pt.shrink ? Math.max(0.6, pt.r * k) : pt.r;
      ctx.fillRect(pt.x - r / 2, pt.y - r / 2, r, r);
    }
    ctx.globalAlpha = 1;

    // ---- 特效 ----
    for (const fx of Game.effects) {
      const k = Math.max(0, fx.life / fx.max);
      if (fx.kind === 'ring') {
        const r = fx.r0 + (fx.r1 - fx.r0) * (1 - k);
        ctx.globalAlpha = k * 0.9;
        ctx.strokeStyle = fx.color;
        ctx.lineWidth = fx.w * k + 0.5;
        ctx.beginPath();
        ctx.arc(fx.x, fx.y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      } else if (fx.kind === 'slash') {
        ctx.save();
        ctx.translate(fx.x, fx.y);
        ctx.rotate(fx.ang);
        ctx.globalAlpha = k * 0.95;
        ctx.fillStyle = fx.color;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.arc(0, 0, fx.len, -0.55, 0.55);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
        ctx.globalAlpha = 1;
      } else if (fx.kind === 'flash') {
        ctx.globalAlpha = k * 0.7;
        G.glowCircle(ctx, fx.x, fx.y, fx.r, fx.color, 0.7);
        ctx.globalAlpha = 1;
      }
    }

    // ---- 飘字 ----
    ctx.font = '700 8px monospace';
    ctx.textAlign = 'center';
    for (const tx of Game.texts) {
      const k = Math.max(0, tx.life / tx.max);
      ctx.globalAlpha = Math.min(1, k * 1.6);
      ctx.fillStyle = '#000';
      ctx.fillText(tx.str, tx.x + 1, tx.y + 1);
      ctx.fillStyle = tx.color;
      ctx.fillText(tx.str, tx.x, tx.y);
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = 'left';

    ctx.restore();

    // ---- 暗角 ----
    const vg = ctx.createRadialGradient(G.W / 2, G.H / 2, G.H * 0.42, G.W / 2, G.H / 2, G.H * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, G.W, G.H);

    // ---- 受击红边 ----
    if (p && p.hurtT > 0) {
      const a = p.hurtT * 1.2;
      const g2 = ctx.createRadialGradient(G.W / 2, G.H / 2, G.H * 0.3, G.W / 2, G.H / 2, G.H * 0.9);
      g2.addColorStop(0, 'rgba(255,40,60,0)');
      g2.addColorStop(1, 'rgba(255,40,60,' + (a * 0.55) + ')');
      ctx.fillStyle = g2;
      ctx.fillRect(0, 0, G.W, G.H);
    }
  }

  /* ---------- UI 小工具 ---------- */
  function txt(ctx, str, x, y, size, color, align, bold, outline) {
    G.text(ctx, str, x, y, { size, color, align: align || 'left', bold, outline, outlineWidth: 3 });
  }
  function btn(id, x, y, w, h) {
    buttons.push({ id, x, y, w, h });
  }
  function isHover(id) { return hoverId === id; }

  function panel(ctx, x, y, w, h, r) {
    ctx.save();
    G.roundRect(ctx, x, y, w, h, r == null ? 10 : r);
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, 'rgba(20,30,52,0.94)');
    g.addColorStop(1, 'rgba(8,13,26,0.96)');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.strokeStyle = 'rgba(91,147,201,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.restore();
  }

  function bar(ctx, x, y, w, h, k, c1, c2, bg) {
    ctx.fillStyle = bg || 'rgba(0,0,0,0.55)';
    G.roundRect(ctx, x, y, w, h, h / 2);
    ctx.fill();
    if (k > 0) {
      ctx.save();
      G.roundRect(ctx, x, y, Math.max(h, w * Math.min(1, k)), h, h / 2);
      ctx.clip();
      const g = ctx.createLinearGradient(x, y, x + w, y);
      g.addColorStop(0, c1);
      g.addColorStop(1, c2 || c1);
      ctx.fillStyle = g;
      ctx.fillRect(x, y, w, h);
      ctx.restore();
    }
  }

  /* ---------- HUD ---------- */
  function drawHUD(ctx, W, H) {
    const p = Game.player;
    if (!p) return;
    const s = Math.min(1.15, Math.max(0.72, W / 1280));

    // 顶部经验条
    const xpK = p.xp / p.xpNext;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(0, 0, W, 5 * s);
    const gxp = ctx.createLinearGradient(0, 0, W, 0);
    gxp.addColorStop(0, '#2ee6c8');
    gxp.addColorStop(0.5, '#8fd4f0');
    gxp.addColorStop(1, '#b06cff');
    ctx.fillStyle = gxp;
    ctx.fillRect(0, 0, W * Math.min(1, xpK), 5 * s);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(0, 0, W * Math.min(1, xpK), 1.5 * s);

    // 左上：等级 + 血量
    const lx = 14 * s, ly = 18 * s;
    // 等级圆
    ctx.beginPath();
    ctx.arc(lx + 16 * s, ly + 16 * s, 16 * s, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(10,16,30,0.9)';
    ctx.fill();
    ctx.strokeStyle = '#5b93c9';
    ctx.lineWidth = 2 * s;
    ctx.stroke();
    txt(ctx, '' + p.level, lx + 16 * s, ly + 22 * s, 15 * s, '#cdf1ff', 'center', true);

    // 血条
    const bx = lx + 40 * s, by = ly + 4 * s, bw = 150 * s, bh = 13 * s;
    bar(ctx, bx, by, bw, bh, p.hp / p.maxHp, '#ff5a6e', '#ff9a3c');
    txt(ctx, Math.ceil(p.hp) + ' / ' + Math.round(p.maxHp), bx + bw / 2, by + bh * 0.78, 9.5 * s, '#fff', 'center', true, 'rgba(0,0,0,0.85)');

    // 金币
    const cy = by + bh + 8 * s;
    G.drawArt(ctx.canvas === G.cv ? ctx : ctx, 'coin', bx + 5 * s, cy + 2 * s, { f: (Game.frame / 10 | 0) % 2 });
    txt(ctx, '' + Game.coinsRun, bx + 15 * s, cy + 7 * s, 11 * s, '#ffe6a3', 'left', true, 'rgba(0,0,0,0.85)');

    // 右上：时间 / 击杀
    const rx = W - 16 * s;
    const mm = Math.floor(Game.time / 60), ss = Math.floor(Game.time % 60);
    txt(ctx, (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss, rx, 30 * s, 20 * s, '#cdf1ff', 'right', true, 'rgba(0,0,0,0.9)');
    txt(ctx, '击杀 ' + Game.kills, rx, 48 * s, 11 * s, 'rgba(205,241,255,0.72)', 'right', false, 'rgba(0,0,0,0.8)');

    // 底部：武器图标
    const wy = H - 26 * s;
    let wx = 14 * s;
    for (let i = 0; i < p.weapons.length; i++) {
      const w = p.weapons[i];
      ctx.fillStyle = 'rgba(8,14,26,0.82)';
      G.roundRect(ctx, wx, wy, 22 * s, 22 * s, 4 * s);
      ctx.fill();
      ctx.strokeStyle = w.def.evoBase || w.def.evo && w.lv >= (w.def.maxLv || 8) ? '#ffc84a' : 'rgba(91,147,201,0.6)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      G.drawArt(ctx, w.def.icon, wx + 11 * s, wy + 11 * s, { scale: s });
      // 等级小字
      txt(ctx, '' + w.lv, wx + 20 * s, wy + 8 * s, 8 * s, '#cdf1ff', 'right', true, 'rgba(0,0,0,0.9)');
      wx += 26 * s;
    }
    // 被动图标
    let px2 = wx + 8 * s;
    for (let i = 0; i < p.passives.length; i++) {
      const w = p.passives[i];
      ctx.fillStyle = 'rgba(8,14,26,0.75)';
      G.roundRect(ctx, px2, wy + 3 * s, 17 * s, 17 * s, 3 * s);
      ctx.fill();
      ctx.strokeStyle = 'rgba(110,231,160,0.45)';
      ctx.lineWidth = 1;
      ctx.stroke();
      G.drawArt(ctx, w.def.icon, px2 + 8.5 * s, wy + 11.5 * s, { scale: s * 0.8 });
      txt(ctx, '' + w.lv, px2 + 16 * s, wy + 8 * s, 7 * s, '#6ee7a0', 'right', true, 'rgba(0,0,0,0.9)');
      px2 += 20 * s;
    }

    // Boss 血条
    const boss = Game.enemies.find((e) => e.boss && e.hp > 0);
    if (boss) {
      const bw2 = Math.min(W * 0.5, 380 * s);
      const bx2 = (W - bw2) / 2, by2 = 16 * s;
      ctx.fillStyle = 'rgba(0,0,0,0.65)';
      G.roundRect(ctx, bx2 - 2, by2 - 2, bw2 + 4, 12 * s + 4, 6 * s);
      ctx.fill();
      bar(ctx, bx2, by2, bw2, 12 * s, boss.hp / boss.maxHp, '#b06cff', '#ff5a6e', 'rgba(20,10,30,0.9)');
      txt(ctx, boss.def.name || 'BOSS', W / 2, by2 - 5 * s, 11 * s, '#ffb0d0', 'center', true, 'rgba(0,0,0,0.9)');
    }

    // 提示消息
    if (Game.msg && Game.msgT > 0) {
      const a = Math.min(1, Game.msgT * 2);
      ctx.globalAlpha = a;
      const w = G.measureText(ctx, Game.msg, 15 * s, true);
      ctx.fillStyle = 'rgba(5,8,16,0.72)';
      G.roundRect(ctx, W / 2 - w / 2 - 14, H * 0.14 - 17 * s, w + 28, 26 * s, 13 * s);
      ctx.fill();
      txt(ctx, Game.msg, W / 2, H * 0.14 + 1, 15 * s, '#ffe6a3', 'center', true, 'rgba(0,0,0,0.9)');
      ctx.globalAlpha = 1;
    }
  }

  /* ---------- 升级选卡 ---------- */
  function drawLevelUp(ctx, W, H) {
    ctx.fillStyle = 'rgba(3,6,14,0.78)';
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(1.2, Math.max(0.66, W / 1280));
    const titleY = H * 0.18;
    txt(ctx, '等 级 提 升', W / 2, titleY, 30 * s, '#ffe6a3', 'center', true, 'rgba(0,0,0,0.9)');
    txt(ctx, 'Lv ' + Game.player.level + '  ·  选一样带走', W / 2, titleY + 22 * s, 12 * s, 'rgba(205,241,255,0.7)', 'center');

    const cards = Game.cards || [];
    const n = cards.length;
    if (!n) return;
    const cw = Math.min(190 * s, (W - 80 * s) / n - 14 * s);
    const chh = 210 * s;
    const gap = 16 * s;
    const totalW = n * cw + (n - 1) * gap;
    let cx = (W - totalW) / 2;
    const cy = H * 0.34;

    for (let i = 0; i < n; i++) {
      const c = cards[i];
      const sel = i === Game.cardSel;
      const x = cx + i * (cw + gap);
      buttons.push({ id: 'card' + i, x, y: cy, w: cw, h: chh });
      const hv = isHover('card' + i);
      const lift = sel || hv ? -6 * s : 0;
      const y = cy + lift;

      // 稀有度颜色
      let rc = '#5b93c9', rc2 = 'rgba(91,147,201,0.15)';
      if (c.rarity === 3) { rc = '#ffc84a'; rc2 = 'rgba(255,200,74,0.18)'; }
      else if (c.rarity === 2) { rc = '#b06cff'; rc2 = 'rgba(176,108,255,0.16)'; }

      ctx.save();
      ctx.shadowColor = rc;
      ctx.shadowBlur = (sel || hv) ? 22 * s : 8 * s;
      G.roundRect(ctx, x, y, cw, chh, 12 * s);
      const g = ctx.createLinearGradient(0, y, 0, y + chh);
      g.addColorStop(0, 'rgba(26,38,64,0.98)');
      g.addColorStop(1, 'rgba(9,14,28,0.98)');
      ctx.fillStyle = g;
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = rc;
      ctx.lineWidth = (sel || hv) ? 2.4 * s : 1.4 * s;
      G.roundRect(ctx, x, y, cw, chh, 12 * s);
      ctx.stroke();

      // 顶部色带
      ctx.save();
      G.roundRect(ctx, x, y, cw, chh, 12 * s);
      ctx.clip();
      ctx.fillStyle = rc2;
      ctx.fillRect(x, y, cw, 46 * s);
      ctx.restore();

      // 图标
      let iconId = null, name = '', desc = '', lvTxt = '';
      if (c.kind === 'wlv') {
        const w = Game.player.weapons.find((q) => q.id === c.id);
        const def = w ? w.def : G.WEAPONS.find((q) => q.id === c.id);
        iconId = def.icon; name = def.name; desc = def.desc;
        lvTxt = 'Lv' + w.lv + ' → Lv' + (w.lv + 1);
      } else if (c.kind === 'wnew') {
        const def = G.WEAPONS.find((q) => q.id === c.id);
        iconId = def.icon; name = def.name; desc = def.desc;
        lvTxt = '新武器';
      } else if (c.kind === 'plv') {
        const w = Game.player.passives.find((q) => q.id === c.id);
        const def = w ? w.def : G.PASSIVES.find((q) => q.id === c.id);
        iconId = def.icon; name = def.name; desc = def.desc;
        lvTxt = 'Lv' + w.lv + ' → Lv' + (w.lv + 1);
      } else if (c.kind === 'pnew') {
        const def = G.PASSIVES.find((q) => q.id === c.id);
        iconId = def.icon; name = def.name; desc = def.desc;
        lvTxt = '新被动';
      } else if (c.kind === 'evo') {
        const def = G.WEAPONS.find((q) => q.id === c.id);
        iconId = def.icon; name = def.name; desc = '进化！' + def.desc;
        lvTxt = '★ 进化';
      } else if (c.kind === 'heal') {
        iconId = 'heart'; name = '治疗'; desc = '恢复 35% 生命';
        lvTxt = '';
      } else if (c.kind === 'coin') {
        iconId = 'coin'; name = '财宝'; desc = '+25 金币';
        lvTxt = '';
      }

      if (iconId) {
        ctx.fillStyle = 'rgba(0,0,0,0.35)';
        G.roundRect(ctx, x + cw / 2 - 20 * s, y + 8 * s, 40 * s, 40 * s, 8 * s);
        ctx.fill();
        const ic = G.BAKED[iconId];
        const sc = ic ? Math.min(2, 36 / Math.max(ic.w, ic.h)) : 1;
        G.drawArt(ctx, iconId, x + cw / 2, y + 28 * s, { scale: sc * s });
      }

      // 名字
      txt(ctx, name, x + cw / 2, y + 66 * s, 16 * s, '#fff', 'center', true, 'rgba(0,0,0,0.85)');
      // 等级
      if (lvTxt) txt(ctx, lvTxt, x + cw / 2, y + 84 * s, 10.5 * s, rc, 'center', true);

      // 描述（自动换行）
      wrapText(ctx, desc || '', x + cw / 2, y + 106 * s, cw - 22 * s, 12.5 * s, 11 * s, 'rgba(205,241,255,0.82)', 'center');

      // 底部提示
      txt(ctx, '' + (i + 1), x + cw / 2, y + chh - 12 * s, 11 * s, 'rgba(205,241,255,0.32)', 'center', true);
    }

    // 底部操作提示
    const by = cy + chh + 30 * s;
    txt(ctx, '← → 选择   Enter/空格 确认   点卡片也行', W / 2, by, 11.5 * s, 'rgba(205,241,255,0.55)', 'center');

    // 重掷
    if (Game.rerolls > 0) {
      const rw = 96 * s, rh = 30 * s;
      const rx = W / 2 - rw / 2, ry = by + 14 * s;
      buttons.push({ id: 'reroll', x: rx, y: ry, w: rw, h: rh });
      ctx.fillStyle = isHover('reroll') ? 'rgba(46,230,200,0.28)' : 'rgba(46,230,200,0.14)';
      G.roundRect(ctx, rx, ry, rw, rh, 8 * s);
      ctx.fill();
      ctx.strokeStyle = '#2ee6c8';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      txt(ctx, '重掷 (' + Game.rerolls + ')', rx + rw / 2, ry + rh * 0.66, 12 * s, '#2ee6c8', 'center', true);
    }
  }

  function wrapText(ctx, str, cx, y, maxW, lineH, size, color, align) {
    ctx.save();
    ctx.font = size + 'px "Microsoft YaHei","PingFang SC",sans-serif';
    const lines = [];
    let cur = '';
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; }
      else cur += ch;
    }
    if (cur) lines.push(cur);
    ctx.restore();
    for (let i = 0; i < lines.length && i < 5; i++) {
      txt(ctx, lines[i], cx, y + i * lineH, size, color, align || 'center');
    }
  }

  /* ---------- 背景（菜单用） ---------- */
  const bubbles = [];
  for (let i = 0; i < 60; i++) {
    bubbles.push({ x: Math.random(), y: Math.random(), r: 1 + Math.random() * 3.5, sp: 0.01 + Math.random() * 0.05, ph: Math.random() * 9 });
  }
  function drawMenuBG(ctx, W, H, t) {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0a1428');
    g.addColorStop(0.4, '#081020');
    g.addColorStop(1, '#03050b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // 光柱
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 4; i++) {
      const x = W * (0.16 + i * 0.23) + Math.sin(t * 0.2 + i) * 40;
      const w = 60 + Math.sin(t * 0.35 + i * 2) * 24;
      const lg = ctx.createLinearGradient(x, 0, x, H);
      lg.addColorStop(0, 'rgba(90,160,230,0.10)');
      lg.addColorStop(0.6, 'rgba(90,160,230,0.03)');
      lg.addColorStop(1, 'rgba(90,160,230,0)');
      ctx.fillStyle = lg;
      ctx.beginPath();
      ctx.moveTo(x - w * 0.25, 0);
      ctx.lineTo(x + w * 0.25, 0);
      ctx.lineTo(x + w, H);
      ctx.lineTo(x - w, H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // 气泡
    ctx.save();
    for (const b of bubbles) {
      b.y -= b.sp * 0.006;
      if (b.y < -0.05) { b.y = 1.05; b.x = Math.random(); }
      const x = (b.x + Math.sin(t * 0.6 + b.ph) * 0.006) * W;
      const y = b.y * H;
      ctx.beginPath();
      ctx.arc(x, y, b.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(160,220,255,0.10)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(160,220,255,0.16)';
      ctx.lineWidth = 0.7;
      ctx.stroke();
    }
    ctx.restore();

    // 海底剪影
    ctx.fillStyle = '#050810';
    ctx.beginPath();
    ctx.moveTo(0, H);
    let yy = H * 0.86;
    for (let x = 0; x <= W; x += 20) {
      yy = H * 0.86 + Math.sin(x * 0.008 + 1.2) * 12 + Math.sin(x * 0.021) * 6;
      ctx.lineTo(x, yy);
    }
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fill();
  }

  /* ---------- 标题界面 ---------- */
  function drawTitle(ctx, W, H, t) {
    drawMenuBG(ctx, W, H, t);
    const s = Math.min(1.3, Math.max(0.66, W / 1280));
    const cy = H * 0.30;

    // 标题
    ctx.save();
    ctx.shadowColor = 'rgba(110,200,255,0.85)';
    ctx.shadowBlur = 26 * s;
    txt(ctx, '鲸 落 · 深 渊', W / 2, cy, 44 * s, '#dff4ff', 'center', true);
    ctx.restore();
    txt(ctx, 'A B Y S S   F A L L', W / 2, cy + 26 * s, 12 * s, 'rgba(143,212,240,0.6)', 'center', true);

    // 主角立绘
    const wh = G.BAKED['whale'];
    if (wh) {
      const bob = Math.sin(t * 1.6) * 4 * s;
      ctx.save();
      ctx.globalAlpha = 0.9;
      const sc = 3.2 * s;
      G.drawArt(ctx, 'whale', W / 2, cy + 92 * s + bob, { f: ((t * 5) | 0) % 4, scale: sc });
      ctx.restore();
      // 光
      const g = ctx.createRadialGradient(W / 2, cy + 92 * s, 0, W / 2, cy + 92 * s, 80 * s);
      g.addColorStop(0, 'rgba(90,160,230,0.16)');
      g.addColorStop(1, 'rgba(90,160,230,0)');
      ctx.fillStyle = g;
      ctx.fillRect(W / 2 - 90 * s, cy + 92 * s - 90 * s, 180 * s, 180 * s);
    }

    // 按钮
    const bw = 190 * s, bh = 40 * s, gap = 12 * s;
    const bx = W / 2 - bw / 2;
    let by = H * 0.66;

    const items = [
      { id: 'b_start', label: '开 始 下 潜', c1: '#2ee6c8', c2: '#8fd4f0' },
      { id: 'b_meta', label: '深 海 强 化', c1: '#8fd4f0', c2: '#5b93c9' },
      { id: 'b_ach', label: '成 就 图 鉴', c1: '#b06cff', c2: '#ff6ec7' },
      { id: 'b_set', label: '设 置', c1: '#7b8aa3', c2: '#3b4657' },
    ];
    for (const it of items) {
      const hv = isHover(it.id);
      buttons.push({ id: it.id, x: bx, y: by, w: bw, h: bh });
      const sc2 = hv ? 1.04 : 1;
      ctx.save();
      ctx.translate(W / 2, by + bh / 2);
      ctx.scale(sc2, sc2);
      G.roundRect(ctx, -bw / 2, -bh / 2, bw, bh, bh / 2);
      ctx.fillStyle = hv ? 'rgba(30,46,76,0.95)' : 'rgba(12,20,36,0.9)';
      ctx.fill();
      ctx.strokeStyle = it.c1;
      ctx.lineWidth = hv ? 2 : 1.3;
      ctx.stroke();
      txt(ctx, it.label, 0, 5 * s, 15 * s, hv ? '#fff' : it.c1, 'center', true);
      ctx.restore();
      by += bh + gap;
    }

    // 底部金币 & 最高记录
    const save = Game.save;
    txt(ctx, '金币 ' + save.coins, 18 * s, H - 18 * s, 12 * s, '#ffe6a3', 'left', true, 'rgba(0,0,0,0.8)');
    const bestT = save.best.time;
    const bm = Math.floor(bestT / 60), bs = Math.floor(bestT % 60);
    txt(ctx, '最佳 ' + (bestT > 0 ? bm + ':' + (bs < 10 ? '0' : '') + bs + ' · 击杀 ' + save.best.kills + ' · Lv' + save.best.level : '尚无记录'),
      W - 18 * s, H - 18 * s, 11 * s, 'rgba(205,241,255,0.55)', 'right');
    txt(ctx, 'WASD/方向键移动 · 自动攻击 · Esc 暂停', W / 2, H - 18 * s, 10.5 * s, 'rgba(205,241,255,0.38)', 'center');
  }

  /* ---------- 角色选择 ---------- */
  function drawChars(ctx, W, H, t) {
    drawMenuBG(ctx, W, H, t);
    const s = Math.min(1.2, Math.max(0.66, W / 1280));
    txt(ctx, '选 择 下 潜 者', W / 2, H * 0.12, 26 * s, '#dff4ff', 'center', true, 'rgba(0,0,0,0.8)');

    const chs = Game.CHARS;
    const n = chs.length;
    const cw = Math.min(170 * s, (W - 60 * s) / n - 12 * s);
    const chh = 190 * s;
    const gap = 12 * s;
    const totalW = n * cw + (n - 1) * gap;
    let cx = (W - totalW) / 2;
    const cy = H * 0.24;

    for (let i = 0; i < n; i++) {
      const c = chs[i];
      const unlocked = c.cost === 0 || Game.save.unlocked[c.id];
      const sel = i === Game.selIndex;
      const x = cx + i * (cw + gap);
      const y = cy + (sel ? -6 * s : 0);
      buttons.push({ id: 'char' + i, x, y, w: cw, h: chh });

      G.roundRect(ctx, x, y, cw, chh, 12 * s);
      ctx.fillStyle = sel ? 'rgba(28,44,74,0.96)' : 'rgba(10,17,31,0.92)';
      ctx.fill();
      ctx.strokeStyle = sel ? '#2ee6c8' : 'rgba(91,147,201,0.4)';
      ctx.lineWidth = sel ? 2.2 : 1.2;
      ctx.stroke();

      // 立绘
      ctx.save();
      ctx.globalAlpha = unlocked ? 1 : 0.28;
      const tint = c.tint || 0;
      G.drawArt(ctx, 'whale', x + cw / 2, y + 56 * s, { f: 0, scale: 2.4 * s * (sel ? 1.06 : 1) });
      ctx.restore();

      txt(ctx, c.name, x + cw / 2, y + 96 * s, 18 * s, sel ? '#fff' : '#cdf1ff', 'center', true, 'rgba(0,0,0,0.8)');

      // HP/速度条
      const statY = y + 108 * s;
      txt(ctx, '生命', x + 14 * s, statY + 7 * s, 9.5 * s, 'rgba(205,241,255,0.6)');
      bar(ctx, x + 40 * s, statY, cw - 54 * s, 6 * s, c.hp / 180, '#ff5a6e', '#ff9a3c');
      txt(ctx, '速度', x + 14 * s, statY + 21 * s, 9.5 * s, 'rgba(205,241,255,0.6)');
      bar(ctx, x + 40 * s, statY + 14 * s, cw - 54 * s, 6 * s, c.speed / 120, '#2ee6c8', '#8fd4f0');

      wrapText(ctx, c.desc, x + cw / 2, y + 144 * s, cw - 20 * s, 13 * s, 10.5 * s, 'rgba(205,241,255,0.75)', 'center');

      if (!unlocked) {
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        G.roundRect(ctx, x, y, cw, chh, 12 * s);
        ctx.fill();
        G.drawArt(ctx, 'coin', x + cw / 2 - 16 * s, y + chh / 2 - 4 * s, { f: 0 });
        txt(ctx, '' + c.cost, x + cw / 2 + 2 * s, y + chh / 2 + 2 * s, 13 * s, '#ffe6a3', 'left', true);
        txt(ctx, Game.save.coins >= c.cost ? '点击解锁' : '金币不足', x + cw / 2, y + chh / 2 + 22 * s, 11 * s, 'rgba(205,241,255,0.7)', 'center');
      }
    }

    // 按钮
    const bw = 150 * s, bh = 36 * s;
    const by = H * 0.83;
    buttons.push({ id: 'char_go', x: W / 2 - bw - 10 * s, y: by, w: bw, h: bh });
    const hv = isHover('char_go');
    G.roundRect(ctx, W / 2 - bw - 10 * s, by, bw, bh, bh / 2);
    ctx.fillStyle = hv ? 'rgba(46,230,200,0.3)' : 'rgba(46,230,200,0.16)';
    ctx.fill();
    ctx.strokeStyle = '#2ee6c8';
    ctx.lineWidth = hv ? 2 : 1.3;
    ctx.stroke();
    txt(ctx, '出 发', W / 2 - bw / 2 - 10 * s, by + bh * 0.64, 15 * s, '#2ee6c8', 'center', true);

    buttons.push({ id: 'char_back', x: W / 2 + 10 * s, y: by, w: bw, h: bh });
    const hv2 = isHover('char_back');
    G.roundRect(ctx, W / 2 + 10 * s, by, bw, bh, bh / 2);
    ctx.fillStyle = hv2 ? 'rgba(123,138,163,0.3)' : 'rgba(123,138,163,0.14)';
    ctx.fill();
    ctx.strokeStyle = '#7b8aa3';
    ctx.lineWidth = hv2 ? 2 : 1.3;
    ctx.stroke();
    txt(ctx, '返 回', W / 2 + bw / 2 + 10 * s, by + bh * 0.64, 15 * s, '#7b8aa3', 'center', true);
  }

  /* ---------- 局外强化 ---------- */
  function drawMeta(ctx, W, H, t) {
    drawMenuBG(ctx, W, H, t);
    const s = Math.min(1.2, Math.max(0.66, W / 1280));
    txt(ctx, '深 海 强 化', W / 2, H * 0.11, 26 * s, '#dff4ff', 'center', true, 'rgba(0,0,0,0.8)');
    txt(ctx, '金币 ' + Game.save.coins, W / 2, H * 0.11 + 24 * s, 14 * s, '#ffe6a3', 'center', true);

    const defs = G.META_DEF;
    const rows = defs.length;
    const pw = Math.min(560 * s, W - 60 * s);
    const rh = 46 * s;
    const px = (W - pw) / 2;
    const py = H * 0.24;
    for (let i = 0; i < rows; i++) {
      const d = defs[i];
      const lv = Game.save.meta[d.id] || 0;
      const max = d.max;
      const cost = Math.round(d.cost * (1 + lv * 0.75));
      const full = lv >= max;
      const can = !full && Game.save.coins >= cost;
      const y = py + i * (rh + 8 * s);
      buttons.push({ id: 'meta' + i, x: px, y, w: pw, h: rh });
      const hv = isHover('meta' + i);

      G.roundRect(ctx, px, y, pw, rh, 9 * s);
      ctx.fillStyle = hv && can ? 'rgba(28,44,74,0.95)' : 'rgba(10,17,31,0.9)';
      ctx.fill();
      ctx.strokeStyle = full ? 'rgba(255,200,74,0.5)' : can ? 'rgba(91,147,201,0.55)' : 'rgba(60,72,96,0.45)';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      txt(ctx, d.name, px + 14 * s, y + 19 * s, 14 * s, '#fff', 'left', true);
      txt(ctx, d.desc, px + 14 * s, y + 35 * s, 10.5 * s, 'rgba(205,241,255,0.6)');

      // 等级点
      const dotY = y + rh / 2;
      const dotX = px + pw - 190 * s;
      for (let k = 0; k < max; k++) {
        ctx.beginPath();
        ctx.arc(dotX + k * 12 * s, dotY, 3.6 * s, 0, Math.PI * 2);
        ctx.fillStyle = k < lv ? '#2ee6c8' : 'rgba(255,255,255,0.14)';
        ctx.fill();
      }

      // 按钮
      const bw2 = 74 * s, bh2 = 26 * s;
      const bx2 = px + pw - bw2 - 12 * s;
      const by2 = y + (rh - bh2) / 2;
      G.roundRect(ctx, bx2, by2, bw2, bh2, bh2 / 2);
      ctx.fillStyle = full ? 'rgba(255,200,74,0.16)' : can ? (hv ? 'rgba(46,230,200,0.3)' : 'rgba(46,230,200,0.16)') : 'rgba(60,72,96,0.25)';
      ctx.fill();
      ctx.strokeStyle = full ? '#ffc84a' : can ? '#2ee6c8' : 'rgba(120,132,150,0.4)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      txt(ctx, full ? '满级' : (cost + ' 金'), bx2 + bw2 / 2, by2 + bh2 * 0.66, 11 * s, full ? '#ffc84a' : can ? '#2ee6c8' : 'rgba(160,172,190,0.6)', 'center', true);
    }

    const by = H - 50 * s;
    buttons.push({ id: 'meta_back', x: W / 2 - 70 * s, y: by, w: 140 * s, h: 34 * s });
    const hv = isHover('meta_back');
    G.roundRect(ctx, W / 2 - 70 * s, by, 140 * s, 34 * s, 17 * s);
    ctx.fillStyle = hv ? 'rgba(123,138,163,0.3)' : 'rgba(123,138,163,0.14)';
    ctx.fill();
    ctx.strokeStyle = '#7b8aa3';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    txt(ctx, '返 回', W / 2, by + 22 * s, 14 * s, '#7b8aa3', 'center', true);
  }

  /* ---------- 成就 ---------- */
  function drawAch(ctx, W, H, t) {
    drawMenuBG(ctx, W, H, t);
    const s = Math.min(1.2, Math.max(0.66, W / 1280));
    txt(ctx, '成 就 图 鉴', W / 2, H * 0.10, 26 * s, '#dff4ff', 'center', true, 'rgba(0,0,0,0.8)');
    const done = G.ACHS.filter((a) => Game.save.achs[a.id]).length;
    txt(ctx, done + ' / ' + G.ACHS.length, W / 2, H * 0.10 + 22 * s, 13 * s, '#ffc84a', 'center', true);

    const cols = 2;
    const pw = Math.min(260 * s, (W - 70 * s) / cols - 10 * s);
    const rh = 38 * s;
    const gap = 8 * s;
    const totalW = cols * pw + gap;
    const px = (W - totalW) / 2;
    const py = H * 0.20;
    for (let i = 0; i < G.ACHS.length; i++) {
      const a = G.ACHS[i];
      const got = !!Game.save.achs[a.id];
      const col = i % cols, row = (i / cols) | 0;
      const x = px + col * (pw + gap);
      const y = py + row * (rh + gap);
      G.roundRect(ctx, x, y, pw, rh, 7 * s);
      ctx.fillStyle = got ? 'rgba(30,46,76,0.92)' : 'rgba(10,16,28,0.8)';
      ctx.fill();
      ctx.strokeStyle = got ? 'rgba(255,200,74,0.6)' : 'rgba(60,72,96,0.4)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      txt(ctx, a.name, x + 12 * s, y + 17 * s, 12.5 * s, got ? '#ffe6a3' : 'rgba(150,162,180,0.7)', 'left', true);
      txt(ctx, a.desc, x + 12 * s, y + 31 * s, 10 * s, got ? 'rgba(205,241,255,0.62)' : 'rgba(120,132,150,0.45)');
      if (got) {
        G.drawArt(ctx, 'star', x + pw - 16 * s, y + rh / 2, { f: (Game.frame / 12 | 0) % 2, scale: s });
      }
    }

    const by = H - 48 * s;
    buttons.push({ id: 'ach_back', x: W / 2 - 70 * s, y: by, w: 140 * s, h: 34 * s });
    const hv = isHover('ach_back');
    G.roundRect(ctx, W / 2 - 70 * s, by, 140 * s, 34 * s, 17 * s);
    ctx.fillStyle = hv ? 'rgba(123,138,163,0.3)' : 'rgba(123,138,163,0.14)';
    ctx.fill();
    ctx.strokeStyle = '#7b8aa3';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    txt(ctx, '返 回', W / 2, by + 22 * s, 14 * s, '#7b8aa3', 'center', true);
  }

  /* ---------- 设置 ---------- */
  const SET_ROWS = [
    { id: 'master', name: '总音量' },
    { id: 'music', name: '音乐' },
    { id: 'sfx', name: '音效' },
    { id: 'shake', name: '屏幕震动', toggle: true },
    { id: 'damageNum', name: '伤害数字', toggle: true },
  ];
  function drawSettings(ctx, W, H, t) {
    drawMenuBG(ctx, W, H, t);
    const s = Math.min(1.2, Math.max(0.66, W / 1280));
    txt(ctx, '设 置', W / 2, H * 0.13, 26 * s, '#dff4ff', 'center', true, 'rgba(0,0,0,0.8)');

    const pw = Math.min(480 * s, W - 70 * s);
    const rh = 44 * s;
    const px = (W - pw) / 2;
    let py = H * 0.24;
    for (const row of SET_ROWS) {
      const y = py;
      G.roundRect(ctx, px, y, pw, rh, 8 * s);
      ctx.fillStyle = 'rgba(10,17,31,0.88)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(91,147,201,0.35)';
      ctx.lineWidth = 1.1;
      ctx.stroke();
      txt(ctx, row.name, px + 14 * s, y + rh * 0.63, 13.5 * s, '#fff', 'left', true);

      if (row.toggle) {
        const on = Game.save.settings[row.id] !== false;
        const tw = 46 * s, th = 22 * s;
        const tx = px + pw - tw - 14 * s, ty = y + (rh - th) / 2;
        buttons.push({ id: 'set_' + row.id, x: tx - 10 * s, y, w: tw + 20 * s, h: rh });
        G.roundRect(ctx, tx, ty, tw, th, th / 2);
        ctx.fillStyle = on ? 'rgba(46,230,200,0.55)' : 'rgba(80,92,110,0.5)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(on ? tx + tw - th / 2 : tx + th / 2, ty + th / 2, th / 2 - 2 * s, 0, Math.PI * 2);
        ctx.fillStyle = '#fff';
        ctx.fill();
        txt(ctx, on ? '开' : '关', tx + tw / 2, ty + th * 0.68, 10 * s, '#fff', 'center', true);
      } else {
        const v = Game.save.settings[row.id] == null ? 0.7 : Game.save.settings[row.id];
        const bw = pw * 0.42;
        const bx = px + pw - bw - 20 * s;
        const by = y + rh / 2;
        buttons.push({ id: 'set_' + row.id, x: bx - 4, y, w: bw + 8, h: rh });
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        G.roundRect(ctx, bx, by - 4 * s, bw, 8 * s, 4 * s);
        ctx.fill();
        ctx.fillStyle = '#2ee6c8';
        G.roundRect(ctx, bx, by - 4 * s, bw * v, 8 * s, 4 * s);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(bx + bw * v, by, 7 * s, 0, Math.PI * 2);
        ctx.fillStyle = '#cdf1ff';
        ctx.fill();
        txt(ctx, Math.round(v * 100) + '%', bx + bw + 6 * s, by + 5 * s, 10 * s, 'rgba(205,241,255,0.6)');
      }
      py += rh + 8 * s;
    }

    // 擦除存档
    const dy = py + 12 * s;
    buttons.push({ id: 'set_wipe', x: W / 2 - 80 * s, y: dy, w: 160 * s, h: 30 * s });
    const hv = isHover('set_wipe');
    G.roundRect(ctx, W / 2 - 80 * s, dy, 160 * s, 30 * s, 15 * s);
    ctx.fillStyle = hv ? 'rgba(255,90,110,0.28)' : 'rgba(255,90,110,0.12)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,90,110,0.7)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    txt(ctx, '清除全部存档', W / 2, dy + 20 * s, 12 * s, '#ff5a6e', 'center', true);

    const by = H - 48 * s;
    buttons.push({ id: 'set_back', x: W / 2 - 70 * s, y: by, w: 140 * s, h: 34 * s });
    const hv2 = isHover('set_back');
    G.roundRect(ctx, W / 2 - 70 * s, by, 140 * s, 34 * s, 17 * s);
    ctx.fillStyle = hv2 ? 'rgba(123,138,163,0.3)' : 'rgba(123,138,163,0.14)';
    ctx.fill();
    ctx.strokeStyle = '#7b8aa3';
    ctx.lineWidth = 1.3;
    ctx.stroke();
    txt(ctx, '返 回', W / 2, by + 22 * s, 14 * s, '#7b8aa3', 'center', true);
  }

  /* ---------- 暂停 ---------- */
  function drawPause(ctx, W, H) {
    ctx.fillStyle = 'rgba(3,6,14,0.72)';
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(1.2, Math.max(0.66, W / 1280));
    txt(ctx, '暂 停', W / 2, H * 0.32, 32 * s, '#dff4ff', 'center', true, 'rgba(0,0,0,0.9)');

    // 面板：当前装备
    const pw = Math.min(420 * s, W - 60 * s);
    const px = (W - pw) / 2;
    const py = H * 0.40;
    panel(ctx, px, py, pw, 120 * s, 10 * s);
    txt(ctx, '武器', px + 14 * s, py + 20 * s, 12 * s, 'rgba(205,241,255,0.6)');
    const p = Game.player;
    let ix = px + 14 * s, iy = py + 30 * s;
    for (const w of p.weapons) {
      G.drawArt(ctx, w.def.icon, ix + 11 * s, iy + 11 * s, { scale: s });
      txt(ctx, w.def.name + ' Lv' + w.lv, ix + 24 * s, iy + 15 * s, 10 * s, '#cdf1ff');
      ix += 130 * s;
      if (ix > px + pw - 120 * s) { ix = px + 14 * s; iy += 20 * s; }
    }
    txt(ctx, '被动', px + 14 * s, iy + 40 * s, 12 * s, 'rgba(205,241,255,0.6)');
    ix = px + 14 * s; iy = iy + 50 * s;
    for (const w of p.passives) {
      G.drawArt(ctx, w.def.icon, ix + 9 * s, iy + 9 * s, { scale: s * 0.85 });
      txt(ctx, w.def.name + ' Lv' + w.lv, ix + 20 * s, iy + 13 * s, 9.5 * s, '#6ee7a0');
      ix += 130 * s;
      if (ix > px + pw - 120 * s) { ix = px + 14 * s; iy += 18 * s; }
    }

    const by = H * 0.75;
    const items = [
      { id: 'p_resume', label: '继续' },
      { id: 'p_quit', label: '放弃并返回' },
    ];
    const bw = 150 * s, bh = 36 * s;
    let bx = W / 2 - bw - 8 * s;
    for (const it of items) {
      buttons.push({ id: it.id, x: bx, y: by, w: bw, h: bh });
      const hv = isHover(it.id);
      G.roundRect(ctx, bx, by, bw, bh, bh / 2);
      ctx.fillStyle = hv ? 'rgba(46,230,200,0.28)' : 'rgba(46,230,200,0.12)';
      ctx.fill();
      ctx.strokeStyle = it.id === 'p_quit' ? 'rgba(255,90,110,0.8)' : '#2ee6c8';
      ctx.lineWidth = 1.3;
      ctx.stroke();
      txt(ctx, it.label, bx + bw / 2, by + bh * 0.64, 13 * s, it.id === 'p_quit' ? '#ff5a6e' : '#2ee6c8', 'center', true);
      bx += bw + 16 * s;
    }
  }

  /* ---------- 结算 ---------- */
  function drawResult(ctx, W, H, t) {
    ctx.fillStyle = 'rgba(3,6,14,0.82)';
    ctx.fillRect(0, 0, W, H);
    const s = Math.min(1.25, Math.max(0.68, W / 1280));
    const won = Game.state === 'win';

    ctx.save();
    ctx.shadowColor = won ? 'rgba(255,200,74,0.8)' : 'rgba(255,90,110,0.7)';
    ctx.shadowBlur = 24 * s;
    txt(ctx, won ? '深 渊 征 服' : '下 潜 结 束', W / 2, H * 0.18, 36 * s, won ? '#ffe6a3' : '#ff8f9e', 'center', true);
    ctx.restore();

    const p = Game.player;
    const mm = Math.floor(Game.time / 60), ss = Math.floor(Game.time % 60);
    const stats = [
      ['存活时间', mm + ':' + (ss < 10 ? '0' : '') + ss],
      ['击杀数', '' + Game.kills],
      ['等级', 'Lv' + p.level],
      ['获得金币', '' + Game.coinsRun],
    ];
    const pw = Math.min(420 * s, W - 60 * s);
    const px = (W - pw) / 2;
    const py = H * 0.28;
    panel(ctx, px, py, pw, 150 * s, 12 * s);
    for (let i = 0; i < stats.length; i++) {
      const y = py + 30 * s + i * 30 * s;
      txt(ctx, stats[i][0], px + 22 * s, y, 13 * s, 'rgba(205,241,255,0.62)');
      txt(ctx, stats[i][1], px + pw - 22 * s, y, 17 * s, '#fff', 'right', true);
    }

    const by = H * 0.72;
    const bw = 150 * s, bh = 38 * s;
    buttons.push({ id: 'r_again', x: W / 2 - bw - 8 * s, y: by, w: bw, h: bh });
    let hv = isHover('r_again');
    G.roundRect(ctx, W / 2 - bw - 8 * s, by, bw, bh, bh / 2);
    ctx.fillStyle = hv ? 'rgba(46,230,200,0.3)' : 'rgba(46,230,200,0.15)';
    ctx.fill();
    ctx.strokeStyle = '#2ee6c8';
    ctx.lineWidth = hv ? 2 : 1.3;
    ctx.stroke();
    txt(ctx, '再 来 一 局', W / 2 - bw / 2 - 8 * s, by + bh * 0.64, 14 * s, '#2ee6c8', 'center', true);

    buttons.push({ id: 'r_menu', x: W / 2 + 8 * s, y: by, w: bw, h: bh });
    hv = isHover('r_menu');
    G.roundRect(ctx, W / 2 + 8 * s, by, bw, bh, bh / 2);
    ctx.fillStyle = hv ? 'rgba(123,138,163,0.3)' : 'rgba(123,138,163,0.14)';
    ctx.fill();
    ctx.strokeStyle = '#7b8aa3';
    ctx.lineWidth = hv ? 2 : 1.3;
    ctx.stroke();
    txt(ctx, '返 回 主 页', W / 2 + bw / 2 + 8 * s, by + bh * 0.64, 14 * s, '#7b8aa3', 'center', true);
  }

  /* ---------- 音频设置同步 ---------- */
  function applyVolumes() {
    if (!G.AUDIO) return;
    try {
      if (G.AUDIO.setVolume) G.AUDIO.setVolume(Game.save.settings.master);
      if (G.AUDIO.setMusicVolume) G.AUDIO.setMusicVolume(Game.save.settings.music);
      if (G.AUDIO.setSfxVolume) G.AUDIO.setSfxVolume(Game.save.settings.sfx);
    } catch (e) { }
  }
  UI.applyVolumes = applyVolumes;

  /* ---------- 每帧 ---------- */
  let uiT = 0;
  UI.frame = function (dt) {
    uiT += dt;
    const ctx = G.ctx, uctx = G.uctx;
    const W = G.uiW || window.innerWidth, H = G.uiH || window.innerHeight;

    // 清理按钮表（保留上一帧结果用于点击判定）
    const prev = UI.prevButtons || [];
    hoverId = null;
    for (const b of prev) {
      if (G.mouse.sx >= b.x && G.mouse.sx <= b.x + b.w && G.mouse.sy >= b.y && G.mouse.sy <= b.y + b.h) {
        hoverId = b.id;
        break;
      }
    }
    buttons.length = 0;

    // --- 游戏世界 ---
    if (Game.state === 'playing' || Game.state === 'paused' || Game.state === 'levelup' ||
      Game.state === 'dead' || Game.state === 'win') {
      ctx.save();
      ctx.fillStyle = '#05070d';
      ctx.fillRect(0, 0, G.W, G.H);
      renderWorld(ctx);
      ctx.restore();
    } else {
      ctx.fillStyle = '#05070d';
      ctx.fillRect(0, 0, G.W, G.H);
    }

    // --- UI 层 ---
    uctx.clearRect(0, 0, W, H);

    if (Game.state === 'playing') {
      drawHUD(uctx, W, H);
    } else if (Game.state === 'paused') {
      drawHUD(uctx, W, H);
      drawPause(uctx, W, H);
    } else if (Game.state === 'levelup') {
      drawHUD(uctx, W, H);
      drawLevelUp(uctx, W, H);
    } else if (Game.state === 'dead' || Game.state === 'win') {
      drawResult(uctx, W, H);
    } else if (Game.state === 'title') {
      drawTitle(uctx, W, H, uiT);
    } else if (Game.state === 'chars') {
      drawChars(uctx, W, H, uiT);
    } else if (Game.state === 'meta') {
      drawMeta(uctx, W, H, uiT);
    } else if (Game.state === 'ach') {
      drawAch(uctx, W, H, uiT);
    } else if (Game.state === 'settings') {
      drawSettings(uctx, W, H, uiT);
    }

    UI.prevButtons = buttons.slice();

    // --- 点击处理 ---
    if (G.mouse.clicked) {
      const mx = G.mouse.sx, my = G.mouse.sy;
      for (const b of UI.prevButtons) {
        if (mx >= b.x && mx <= b.x + b.w && my >= b.y && my <= b.y + b.h) {
          handleClick(b.id);
          break;
        }
      }
    }

    // --- 键盘 ---
    handleKeys();
  };

  function handleKeys() {
    const st = Game.state;
    if (G.pressed.esc) {
      if (st === 'playing') { Game.state = 'paused'; if (G.AUDIO) G.AUDIO.sfx('ui'); }
      else if (st === 'paused') { Game.state = 'playing'; if (G.AUDIO) G.AUDIO.sfx('ui'); }
      else if (st === 'levelup') { /* 不许跳过 */ }
      else if (st === 'chars' || st === 'meta' || st === 'ach' || st === 'settings') { Game.state = 'title'; if (G.AUDIO) G.AUDIO.sfx('ui'); }
    }
    if (st === 'levelup') {
      if (G.pressed.left) { Game.cardSel = (Game.cardSel + Game.cards.length - 1) % Game.cards.length; if (G.AUDIO) G.AUDIO.sfx('ui'); }
      if (G.pressed.right) { Game.cardSel = (Game.cardSel + 1) % Game.cards.length; if (G.AUDIO) G.AUDIO.sfx('ui'); }
      if (G.pressed['1']) { Game.cardSel = 0; }
      if (G.pressed['2']) { Game.cardSel = 1; }
      if (G.pressed['3']) { Game.cardSel = 2; }
      if (G.pressed.ok || G.pressed['1'] || G.pressed['2'] || G.pressed['3']) {
        const c = Game.cards[Game.cardSel];
        if (c && !(G.pressed.ok && Game.cardSel < 0)) Game.takeCard(c);
        if (G.AUDIO) G.AUDIO.sfx('ui');
      }
      if (G.pressed.r && Game.rerolls > 0) doReroll();
    }
    if (st === 'paused' && G.pressed.q) { quitToTitle(); }
    if (st === 'dead' || st === 'win') {
      if (G.pressed.ok || G.pressed.r) { Game.state = 'chars'; Game.selIndex = 0; }
    }
    if (st === 'chars') {
      if (G.pressed.left) { Game.selIndex = (Game.selIndex + Game.CHARS.length - 1) % Game.CHARS.length; if (G.AUDIO) G.AUDIO.sfx('ui'); }
      if (G.pressed.right) { Game.selIndex = (Game.selIndex + 1) % Game.CHARS.length; if (G.AUDIO) G.AUDIO.sfx('ui'); }
      if (G.pressed.ok) tryStart();
    }
    if (st === 'title' && G.pressed.ok) { Game.state = 'chars'; }
  }

  function doReroll() {
    Game.rerolls--;
    Game.cards = rebuildCardsPublic();
    Game.cardSel = 0;
    if (G.AUDIO) G.AUDIO.sfx('ui');
  }
  function rebuildCardsPublic() {
    // 复用游戏层的抽卡：先伪造成 levelup 再抽
    const p = Game.player;
    const saved = Game.state;
    Game.state = 'playing';
    const res = (function () {
      // 直接调用内部逻辑：通过临时提高等级触发不可行，这里简单再抽一次
      return Game.retryCards ? Game.retryCards() : Game.cards;
    })();
    Game.state = saved;
    return res;
  }

  function tryStart() {
    const c = Game.CHARS[Game.selIndex];
    if (c.cost > 0 && !Game.save.unlocked[c.id]) {
      if (Game.save.coins >= c.cost) {
        Game.save.coins -= c.cost;
        Game.save.unlocked[c.id] = true;
        Game.persist();
        Game.toast('解锁 ' + c.name + '！');
        if (G.AUDIO) G.AUDIO.sfx('chest');
      } else {
        Game.toast('金币不够哦');
        if (G.AUDIO) G.AUDIO.sfx('ui_bad');
      }
      return;
    }
    Game.startRun(Game.selIndex);
    UI.applyVolumes();
  }

  function quitToTitle() {
    Game.state = 'title';
    Game.paused = false;
    if (G.AUDIO) G.AUDIO.music(0);
  }

  function handleClick(id) {
    if (G.AUDIO) { try { G.AUDIO.init(); } catch (e) { } }
    switch (id) {
      case 'b_start': Game.state = 'chars'; G.AUDIO && G.AUDIO.sfx('ui'); break;
      case 'b_meta': Game.state = 'meta'; G.AUDIO && G.AUDIO.sfx('ui'); break;
      case 'b_ach': Game.state = 'ach'; G.AUDIO && G.AUDIO.sfx('ui'); break;
      case 'b_set': Game.state = 'settings'; G.AUDIO && G.AUDIO.sfx('ui'); break;
      case 'char_go': tryStart(); break;
      case 'char_back': Game.state = 'title'; break;
      case 'meta_back': Game.state = 'title'; break;
      case 'ach_back': Game.state = 'title'; break;
      case 'set_back': Game.state = 'title'; Game.persist(); break;
      case 'set_wipe':
        if (Game.save._wipeConfirm) {
          G.clearSave();
          Game.loadGame();
          Game.save = Game.defaultSave();
          Game.persist();
          Game.toast('存档已清除');
          delete Game.save._wipeConfirm;
        } else {
          Game.save._wipeConfirm = true;
          Game.toast('再点一次确认清除');
          setTimeout(() => { delete Game.save._wipeConfirm; }, 3000);
        }
        break;
      case 'p_resume': Game.state = 'playing'; break;
      case 'p_quit': quitToTitle(); break;
      case 'r_again': Game.state = 'chars'; Game.selIndex = 0; break;
      case 'r_menu': quitToTitle(); break;
      case 'reroll': if (Game.rerolls > 0) doReroll(); break;
    }
    if (id.startsWith('char') && id !== 'char_go' && id !== 'char_back') {
      const i = parseInt(id.slice(4), 10);
      if (!isNaN(i)) { Game.selIndex = i; if (G.AUDIO) G.AUDIO.sfx('ui'); }
    }
    if (id.startsWith('card')) {
      const i = parseInt(id.slice(4), 10);
      if (!isNaN(i) && Game.cards[i]) { Game.cardSel = i; Game.takeCard(Game.cards[i]); if (G.AUDIO) G.AUDIO.sfx('ui'); }
    }
    if (id.startsWith('meta')) {
      const i = parseInt(id.slice(4), 10);
      const d = G.META_DEF[i];
      if (d) {
        const lv = Game.save.meta[d.id] || 0;
        const cost = Math.round(d.cost * (1 + lv * 0.75));
        if (lv < d.max && Game.save.coins >= cost) {
          Game.save.coins -= cost;
          Game.save.meta[d.id] = lv + 1;
          Game.persist();
          if (G.AUDIO) G.AUDIO.sfx('chest');
        } else if (lv >= d.max) {
          if (G.AUDIO) G.AUDIO.sfx('ui_bad');
        } else {
          Game.toast('金币不够');
          if (G.AUDIO) G.AUDIO.sfx('ui_bad');
        }
      }
    }
    if (id.startsWith('set_') && id !== 'set_back' && id !== 'set_wipe') {
      const key = id.slice(4);
      const row = SET_ROWS.find((r) => r.id === key);
      if (row && row.toggle) {
        Game.save.settings[key] = Game.save.settings[key] === false;
        Game.persist();
        if (G.AUDIO) G.AUDIO.sfx('ui');
      } else {
        // 点击音量条：按位置设值
        const b = (UI.prevButtons || []).find((q) => q.id === id);
        if (b) {
          const k = G.clamp((G.mouse.sx - b.x) / b.w, 0, 1);
          Game.save.settings[key] = k;
          Game.persist();
          applyVolumes();
        }
      }
    }
  }

  /* 拖动音量条 */
  UI.dragVolume = function () { };
  window.addEventListener('mousemove', (ev) => {
    if (!G.mouse.down) return;
    const hid = hoverId;
    if (hid && hid.startsWith('set_') && hid !== 'set_back' && hid !== 'set_wipe') {
      const key = hid.slice(4);
      const row = SET_ROWS.find((r) => r.id === key);
      if (row && !row.toggle) {
        const b = (UI.prevButtons || []).find((q) => q.id === hid);
        if (b) {
          Game.save.settings[key] = G.clamp((ev.clientX - b.x) / b.w, 0, 1);
          applyVolumes();
        }
      }
    }
  });

  UI.init = function () { applyVolumes(); };
})();
