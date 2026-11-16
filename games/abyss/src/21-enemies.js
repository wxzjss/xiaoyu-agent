/* ============================================================================
 * 21-enemies.js — 鲸落·深渊（ABYSS FALL）敌人逻辑表
 *
 * 一共 20 只：IDS.md 第四节的 17 个杂兵/精英 + 3 个 Boss
 *   jelly parasite spikefish crab bonefish urchin octopus lantern eel ghost
 *   spitter bombfish shellback siren golem shark summoner
 *   boss_angler boss_queen boss_whale
 *
 * 契约（只认 SPEC 5.1~5.3 里写的东西）：
 *   - 移动 = 直接改 e.vx / e.vy（像素/秒），引擎做 e.x += e.vx * dt
 *   - 出手只用 api.spawnBullet / api.spawnEnemy / api.explode / api.ring /
 *     api.slash / api.particle / api.shake / api.flash / api.sfx / api.text /
 *     api.setBuff / api.rnd / api.rndi / api.pick
 *   - 不碰 window 里任何游戏内部变量
 * ========================================================================== */

const G = window.G = window.G || {};
if (!G.ENEMIES) G.ENEMIES = [];

(function () {
  'use strict';

  const TAU = Math.PI * 2;

  /* ==========================================================================
   * 小工具
   * ========================================================================== */

  // e.state 是留给我自己塞东西的，可能还没建
  function st(e) {
    if (!e.state) e.state = {};
    return e.state;
  }

  function pl(api) {
    return (api && api.player) || null;
  }

  // 帧时间：优先用传进来的 dt，兜一下底
  function rdt(api, dt) {
    if (typeof dt === 'number' && dt > 0) return dt;
    if (api && typeof api.dt === 'number' && api.dt > 0) return api.dt;
    return 1 / 60;
  }

  // 实际速度：实例上被 opts 改过就用实例的，否则用定义的
  function spd(e) {
    if (typeof e.speed === 'number' && e.speed > 0) return e.speed;
    const d = e.def || {};
    if (typeof d.speed === 'number' && d.speed > 0) return d.speed;
    return 20;
  }

  function angTo(e, p) {
    if (!p) return 0;
    return Math.atan2(p.y - e.y, p.x - e.x);
  }

  function dst(e, p) {
    if (!p) return 99999;
    return Math.hypot(p.x - e.x, p.y - e.y);
  }

  function setPolar(e, ang, s) {
    e.vx = Math.cos(ang) * s;
    e.vy = Math.sin(ang) * s;
  }

  function aimAt(e, tx, ty, s) {
    let dx = tx - e.x;
    let dy = ty - e.y;
    const l = Math.hypot(dx, dy) || 1;
    e.vx = (dx / l) * s;
    e.vy = (dy / l) * s;
  }

  function clamp(v, a, b) {
    return v < a ? a : v > b ? b : v;
  }

  // 把角度差压到 [-PI, PI]
  function angDiff(a, b) {
    let d = (a - b) % TAU;
    if (d > Math.PI) d -= TAU;
    if (d  -Math.PI) d += TAU;
    return d;
  }

  function rr(api, a, b) {
    if (api && typeof api.rnd === 'function') return api.rnd(a, b);
    return a + Math.random() * (b - a);
  }

  // 抖动一下：让同类怪不会像复制粘贴
  /* ---------------- 特效/出手：全部先查有没有这个函数 ---------------- */

  function shot(api, e, ang, s, dmg, color, r, life, ox, oy) {
    if (!api || typeof api.spawnBullet !== 'function') return;
    const x = e.x + (ox || 0);
    const y = e.y + (oy || 0);
    api.spawnBullet({
      x: x,
      y: y,
      vx: Math.cos(ang) * s,
      vy: Math.sin(ang) * s,
      dmg: dmg,
      r: r,
      life: life,
      color: color
    });
  }

  function fxRing(api, x, y, r, color, life) {
    if (api && typeof api.ring === 'function') api.ring(x, y, r, color, life);
  }

  function fxFlash(api, x, y, r, color) {
    if (api && typeof api.flash === 'function') api.flash(x, y, r, color);
  }

  function fxShake(api, n) {
    if (api && typeof api.shake === 'function') api.shake(n);
  }

  function fxSfx(api, n) {
    if (api && typeof api.sfx === 'function') api.sfx(n);
  }

  function fxText(api, x, y, str, color) {
    if (api && typeof api.text === 'function') api.text(x, y, str, color);
  }

  function fxSlash(api, x, y, ang, len, w, color, life) {
    if (api && typeof api.slash === 'function') api.slash(x, y, ang, len, w, color, life);
  }

  function fxPart(api, x, y, o) {
    if (api && typeof api.particle === 'function') api.particle(x, y, o);
  }

  function fxExplode(api, x, y, r, dmg, color) {
    if (api && typeof api.explode === 'function') api.explode(x, y, r, dmg, { color: color });
  }

  function spawn(api, id, x, y, opts) {
    if (!api || typeof api.spawnEnemy !== 'function') return;
    api.spawnEnemy(id, x, y, opts);
  }

  // 保持距离：太近往后撤，太远往前贴，不远不近就横向绕
  function keepRange(e, api, p, minD, maxD, s) {
    const d = dst(e, p);
    const a = angTo(e, p);
    const side = st(e).side || 1;
    if (d < minD) {
      setPolar(e, a + Math.PI, s);
      return -1;
    }
    if (d > maxD) {
      setPolar(e, a, s);
      return 1;
    }
    setPolar(e, a + (Math.PI / 2) * side, s * 0.85);
    return 0;
  }

  // Boss 半血换阶段，只喊一次
  function phaseCheck(e, api, s) {
    if (s.ph2) return false;
    if (!e.maxHp || e.hp > e.maxHp * 0.5) return false;
    s.ph2 = true;
    fxShake(api, 10);
    fxRing(api, e.x, e.y, 96, '#ff5a6e', 0.6);
    fxText(api, e.x, e.y - 28, '第二阶段', '#ff5a6e');
    fxSfx(api, 'boss_phase');
    return true;
  }

  /* ==========================================================================
   * 一、杂兵（tier 1）
   * ========================================================================== */

  /* 幽光水母：慢慢飘 + 一直上下浮动，追人很敷衍 */
  G.ENEMIES.push({
    id: 'jelly',
    name: '幽光水母',
    art: 'jelly',
    hp: 18,
    speed: 22,
    dmg: 6,
    xp: 2,
    r: 5,
    tier: 1,
    minWave: 0,
    weight: 12,
    hpMul: 1.05,
    speedMul: 0.95,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      const ph = s.ph || 0;
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      const a = angTo(e, p);
      // 伞盖一鼓一缩：横向慢慢挪，纵向一直一上一下
      const pulse = 0.5 + 0.35 * Math.sin(e.t * 2.1 + ph);
      e.vx = Math.cos(a) * spd(e) * pulse * 0.7;
      e.vy = Math.sin(a) * spd(e) * pulse * 0.3 + Math.sin(e.t * 2.6 + ph) * 16;
      if (d < 26) e.vy -= 10; // 贴脸时轻轻往上飘一点
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.ph = rr(api, 0, TAU);
      s.k = rr(api, 1.8, 2.6);
    }
  });

  /* 寄生体：极快的直线冲刺，锁定方向就一头撞过去 */
  G.ENEMIES.push({
    id: 'parasite',
    name: '寄生体',
    art: 'parasite',
    hp: 12,
    speed: 148,
    dmg: 5,
    xp: 2,
    r: 4,
    tier: 1,
    minWave: 0,
    weight: 11,
    hpMul: 0.9,
    speedMul: 1.1,
    dmgMul: 0.95,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (typeof s.t !== 'number') s.t = 99;
      if (typeof s.ang !== 'number' || s.t > 1.05) {
        s.ang = angTo(e, p);
        s.t = 0;
        s.wind = 0.16; // 换个方向前先收一下力
      }
      s.t += d;
      if (s.wind > 0) {
        s.wind -= d;
        setPolar(e, s.ang, spd(e) * 0.22);
        return;
      }
      // 直线，不拐弯
      setPolar(e, s.ang, spd(e));
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.t = 99;
      s.wind = 0;
    }
  });

  /* 刺鱼：中速直冲，只带一点点摆尾的抖 */
  G.ENEMIES.push({
    id: 'spikefish',
    name: '刺鱼',
    art: 'spikefish',
    hp: 26,
    speed: 66,
    dmg: 8,
    xp: 3,
    r: 6,
    tier: 1,
    minWave: 0,
    weight: 12,
    hpMul: 1,
    speedMul: 1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      const a = angTo(e, p);
      // 中速、基本一条直线，尾巴甩得很轻
      setPolar(e, a + Math.sin(e.t * 6 + (s.ph || 0)) * 0.07, spd(e));
    },
    onSpawn: function (e, api) {
      st(e).ph = rr(api, 0, TAU);
    }
  });

  /* 铁壳蟹：慢，壳硬，横着一步一步挪 */
  G.ENEMIES.push({
    id: 'crab',
    name: '铁壳蟹',
    art: 'crab',
    hp: 70,
    speed: 16,
    dmg: 9,
    xp: 4,
    r: 7,
    tier: 1,
    minWave: 1,
    weight: 11,
    hpMul: 1.1,
    speedMul: 0.9,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      const a = angTo(e, p);
      const sway = Math.sin(e.t * 3.2 + (s.ph || 0));
      // 主干是往里挪，但走的是螃蟹那种横步：一会儿偏左一会儿偏右
      setPolar(e, a + sway * 0.55, spd(e) * (0.85 + 0.15 * Math.abs(sway)));
      // 再叠一点垂直于方向的横移
      e.vx += Math.cos(a + Math.PI / 2) * Math.sin(e.t * 4.4) * 9;
      e.vy += Math.sin(a + Math.PI / 2) * Math.sin(e.t * 4.4) * 9;
    },
    onSpawn: function (e, api) {
      st(e).ph = rr(api, 0, TAU);
    }
  });

  /* 骨鱼：之字形走，一左一右地拐过去 */
  G.ENEMIES.push({
    id: 'bonefish',
    name: '骨鱼',
    art: 'bonefish',
    hp: 30,
    speed: 58,
    dmg: 7,
    xp: 3,
    r: 6,
    tier: 1,
    minWave: 1,
    weight: 12,
    hpMul: 1,
    speedMul: 1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      const a = angTo(e, p);
      // 大幅左右摆：走出来的就是之字
      const zig = Math.sin(e.t * 5.2 + (s.ph || 0)) * 1.05;
      setPolar(e, a + zig, spd(e) * (0.8 + 0.2 * Math.cos(e.t * 5.2)));
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.ph = rr(api, 0, TAU);
    }
  });

  /* 海胆：慢慢靠近，一进到近处就原地打转（刺全在外面刮） */
  G.ENEMIES.push({
    id: 'urchin',
    name: '海胆',
    art: 'urchin',
    hp: 44,
    speed: 15,
    dmg: 10,
    xp: 4,
    r: 7,
    tier: 1,
    minWave: 2,
    weight: 10,
    hpMul: 1.05,
    speedMul: 0.95,
    dmgMul: 1.05,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      const dist = dst(e, p);
      if (dist > 72) {
        // 还在路上：慢吞吞往里滚
        setPolar(e, angTo(e, p), spd(e));
        return;
      }
      // 贴上了就不走了，原地绕圈磨刺
      setPolar(e, e.t * 3.4 + (s.ph || 0), spd(e) * 1.6);
      if (typeof s.pT !== 'number') s.pT = 0;
      s.pT += d;
      if (s.pT > 0.45) {
        s.pT = 0;
        fxPart(api, e.x, e.y, {
          vx: Math.cos(e.t * 3.4) * 30,
          vy: Math.sin(e.t * 3.4) * 30,
          life: 0.3,
          color: '#cdf1ff',
          r: 1,
          fade: true
        });
      }
    },
    onSpawn: function (e, api) {
      st(e).ph = rr(api, 0, TAU);
    }
  });

  /* 章鱼：走走停停，停的时候触须收一收 */
  G.ENEMIES.push({
    id: 'octopus',
    name: '章鱼',
    art: 'octopus',
    hp: 48,
    speed: 44,
    dmg: 9,
    xp: 4,
    r: 8,
    tier: 1,
    minWave: 2,
    weight: 10,
    hpMul: 1,
    speedMul: 1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (typeof s.t !== 'number') s.t = rr(api, 0, 1.3);
      s.t += d;
      const ph = s.t % 1.35;
      if (ph < 0.8) {
        // 走：慢慢追，带一点点弧
        const a = angTo(e, p) + Math.sin(s.t * 3) * 0.25;
        setPolar(e, a, spd(e));
      } else {
        // 停：原地憋一下，攒下一段
        e.vx *= 0.2;
        e.vy *= 0.2;
      }
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.t = rr(api, 0, 1.3);
    }
  });

  /* 灯笼鱼：追人，但偏爱绕到侧面去 */
  G.ENEMIES.push({
    id: 'lantern',
    name: '灯笼鱼',
    art: 'lantern',
    hp: 34,
    speed: 54,
    dmg: 8,
    xp: 4,
    r: 7,
    tier: 1,
    minWave: 2,
    weight: 10,
    hpMul: 1,
    speedMul: 1.05,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (!s.side) s.side = Math.random() < 0.5 ? 1 : -1;
      if (typeof s.t !== 'number') s.t = 0;
      s.t += d;
      if (s.t > 3.6) {
        s.t = 0;
        s.side = -s.side; // 隔一阵换一边绕
      }
      // 目标点不在玩家身上，而在玩家侧后方
      const a = angTo(e, p);
      const off = 56 * s.side;
      const tx = p.x + Math.cos(a + Math.PI / 2) * off;
      const ty = p.y + Math.sin(a + Math.PI / 2) * off;
      aimAt(e, tx, ty, spd(e));
      // 头顶那点光一晃一晃
      fxPart(api, e.x, e.y - 9, {
        vx: rr(api, -6, 6),
        vy: rr(api, -14, -4),
        life: 0.35,
        color: '#ffc84a',
        r: 1,
        fade: true
      });
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.side = rr(api, 0, 1) < 0.5 ? 1 : -1;
      s.t = 0;
    }
  });

  /* 电鳗：蛇形游，快 */
  G.ENEMIES.push({
    id: 'eel',
    name: '电鳗',
    art: 'eel',
    hp: 38,
    speed: 98,
    dmg: 9,
    xp: 4,
    r: 6,
    tier: 1,
    minWave: 3,
    weight: 9,
    hpMul: 1,
    speedMul: 1.1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      const a = angTo(e, p);
      // 蛇行：方向一直左右横摆
      const sw = Math.sin(e.t * 8.4 + (s.ph || 0)) * 0.85;
      setPolar(e, a + sw, spd(e) * (0.85 + 0.15 * Math.cos(e.t * 8.4)));
      // 身上冒电
      if (Math.random() < 0.15) {
        fxPart(api, e.x, e.y, {
          vx: rr(api, -24, 24),
          vy: rr(api, -24, 24),
          life: 0.16,
          color: '#2ee6c8',
          r: 1,
          fade: true
        });
      }
    },
    onSpawn: function (e, api) {
      st(e).ph = rr(api, 0, TAU);
    }
  });

  /* 溺魂：像不当有墙一样直线飘过去，速度忽快忽慢 */
  G.ENEMIES.push({
    id: 'ghost',
    name: '溺魂',
    art: 'ghost',
    hp: 46,
    speed: 52,
    dmg: 10,
    xp: 4,
    r: 6,
    tier: 1,
    minWave: 3,
    weight: 9,
    hpMul: 1.05,
    speedMul: 1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (typeof s.ang !== 'number') s.ang = angTo(e, p);
      // 方向只慢慢修，看起来像飘 —— 不绕路，直接穿过去
      s.ang += clamp(angDiff(angTo(e, p), s.ang), -1.2 * d * 3, 1.2 * d * 3);
      // 忽快忽慢：飘忽
      const flick = 0.35 + 0.65 * Math.abs(Math.sin(e.t * 1.6 + (s.ph || 0)));
      setPolar(e, s.ang, spd(e) * flick);
      if (Math.random() < 0.08) {
        fxPart(api, e.x, e.y + 4, {
          vx: rr(api, -8, 8),
          vy: rr(api, -18, -4),
          life: 0.5,
          color: '#8fd4f0',
          r: 1,
          fade: true
        });
      }
    },
    onSpawn: function (e, api) {
      st(e).ph = rr(api, 0, TAU);
    }
  });

  /* ==========================================================================
   * 二、精英（tier 2）
   * ========================================================================== */

  /* 喷毒螺：站在圈外，定期朝玩家吐毒弹 */
  G.ENEMIES.push({
    id: 'spitter',
    name: '喷毒螺',
    art: 'spitter',
    hp: 55,
    speed: 36,
    dmg: 8,
    xp: 8,
    r: 7,
    tier: 2,
    minWave: 3,
    weight: 7,
    hpMul: 1.1,
    speedMul: 0.95,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (typeof s.cd !== 'number') s.cd = rr(api, 0.6, 1.6);
      if (!s.side) s.side = 1;
      if (typeof s.t !== 'number') s.t = 0;
      s.t += d;
      if (s.t > 4) {
        s.t = 0;
        s.side = -s.side;
      }
      // 卡在 150~200 这个圈带上，不贴身
      const mode = keepRange(e, api, p, 150, 200, spd(e));
      s.cd -= d;
      const dist = dst(e, p);
      if (s.cd <= 0 && dist < 280 && mode !== -1) {
        s.cd = 1.7;
        const a = angTo(e, p);
        shot(api, e, a, 118, 8, '#9ef07a', 4, 3.2, Math.cos(a) * 6, Math.sin(a) * 6);
        fxFlash(api, e.x + Math.cos(a) * 8, e.y + Math.sin(a) * 8, 7, '#6ee7a0');
        fxSfx(api, 'spit');
      }
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.cd = rr(api, 0.5, 1.8);
      s.side = rr(api, 0, 1) < 0.5 ? 1 : -1;
      s.t = 0;
    }
  });

  /* 自爆河豚：鼓着刺冲上来，近了就炸，自己一起没 */
  G.ENEMIES.push({
    id: 'bombfish',
    name: '自爆河豚',
    art: 'bombfish',
    hp: 30,
    speed: 84,
    dmg: 18,
    xp: 9,
    r: 7,
    tier: 2,
    minWave: 4,
    weight: 7,
    hpMul: 1,
    speedMul: 1.05,
    dmgMul: 1.2,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (s.boom) return; // 已经炸过了，等引擎收尸
      const dist = dst(e, p);
      const a = angTo(e, p);
      if (dist < 40) {
        // 到身了 —— 引爆
        s.boom = true;
        fxExplode(api, e.x, e.y, 48, 22, '#ff9a3c');
        fxRing(api, e.x, e.y, 52, '#ffc84a', 0.35);
        fxFlash(api, e.x, e.y, 56, '#ff9a3c');
        fxShake(api, 5);
        fxSfx(api, 'boom');
        e.vx = 0;
        e.vy = 0;
        e.hp = 0;   // 自己也没了
        e.dead = true;
        return;
      }
      // 越近越急，最后一段是冲刺
      const boost = dist < 90 ? 1.45 : 1;
      setPolar(e, a, spd(e) * boost);
      if (dist < 90 && Math.random() < 0.2) {
        fxPart(api, e.x, e.y, {
          vx: rr(api, -20, 20),
          vy: rr(api, -20, 20),
          life: 0.2,
          color: '#ffc84a',
          r: 1,
          fade: true
        });
      }
      s.arm = (s.arm || 0) + d;
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.boom = false;
      s.arm = 0;
    }
  });

  /* 甲壳盾卫：正面一整面厚甲，走得慢，隔一阵往前顶一下
     （引擎没有护甲钩子，正面硬靠高血量 + 始终正面朝向 + 大碰撞半径表达） */
  G.ENEMIES.push({
    id: 'shellback',
    name: '甲壳盾卫',
    art: 'shellback',
    hp: 150,
    speed: 20,
    dmg: 12,
    xp: 10,
    r: 9,
    tier: 2,
    minWave: 4,
    weight: 6,
    hpMul: 1.15,
    speedMul: 0.9,
    dmgMul: 1.05,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (typeof s.face !== 'number') s.face = angTo(e, p);
      // 甲面一直冲着玩家：转得慢，但一直转
      s.face += clamp(angDiff(angTo(e, p), s.face), -1.8 * d, 1.8 * d);
      if (typeof s.t !== 'number') s.t = 0;
      s.t += d;
      const cyc = s.t % 2.6;
      if (cyc < 1.7) {
        // 顶：沿甲面方向小步推进
        setPolar(e, s.face, spd(e) * 1.6);
      } else {
        // 收：几乎停住，把甲立起来
        e.vx *= 0.25;
        e.vy *= 0.25;
      }
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.t = 0;
      s.face = undefined;
    }
  });

  /* 海妖：站远处唱，歌声让玩家变慢 */
  G.ENEMIES.push({
    id: 'siren',
    name: '海妖',
    art: 'siren',
    hp: 70,
    speed: 40,
    dmg: 9,
    xp: 11,
    r: 7,
    tier: 2,
    minWave: 5,
    weight: 6,
    hpMul: 1.05,
    speedMul: 1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (typeof s.cd !== 'number') s.cd = rr(api, 1.2, 2.4);
      if (!s.side) s.side = 1;
      if (typeof s.t !== 'number') s.t = 0;
      s.t += d;
      if (s.t > 5) {
        s.t = 0;
        s.side = -s.side;
      }
      keepRange(e, api, p, 170, 230, spd(e));
      s.cd -= d;
      if (s.cd <= 0 && dst(e, p) < 320) {
        s.cd = 3.2;
        // 唱一句：玩家变慢
        if (api && typeof api.setBuff === 'function') api.setBuff('slow', 0.55, 2.2);
        fxRing(api, e.x, e.y, 74, '#ff6ec7', 0.6);
        fxRing(api, e.x, e.y, 120, '#ff6ec7', 0.9);
        fxText(api, e.x, e.y - 16, '♪', '#ff6ec7');
        fxSfx(api, 'song');
      }
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.cd = rr(api, 1.0, 2.6);
      s.side = rr(api, 0, 1) < 0.5 ? 1 : -1;
      s.t = 0;
    }
  });

  /* 珊瑚傀儡：又慢又厚，碎了以后爬出两只寄生体 */
  G.ENEMIES.push({
    id: 'golem',
    name: '珊瑚傀儡',
    art: 'golem',
    hp: 170,
    speed: 22,
    dmg: 14,
    xp: 12,
    r: 9,
    tier: 2,
    minWave: 5,
    weight: 5,
    hpMul: 1.2,
    speedMul: 0.9,
    dmgMul: 1.1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      // 一步一步砸着走：速度一直在小范围抖
      const a = angTo(e, p);
      const thump = 0.55 + 0.45 * Math.abs(Math.sin(e.t * 2.4 + (s.ph || 0)));
      setPolar(e, a + Math.sin(e.t * 1.6) * 0.12, spd(e) * thump);
    },
    onDeath: function (e, api) {
      // 壳裂开，里面两只寄生体
      spawn(api, 'parasite', e.x - 9, e.y + 5, { hp: 10 });
      spawn(api, 'parasite', e.x + 9, e.y - 5, { hp: 10 });
      fxRing(api, e.x, e.y, 26, '#ff9a3c', 0.35);
      fxFlash(api, e.x, e.y, 30, '#a2673f');
      fxSfx(api, 'crack');
    },
    onSpawn: function (e, api) {
      st(e).ph = rr(api, 0, TAU);
    }
  });

  /* 鲛鲨：先停一下蓄力，再猛冲，冲完得缓一缓 */
  G.ENEMIES.push({
    id: 'shark',
    name: '鲛鲨',
    art: 'shark',
    hp: 95,
    speed: 62,
    dmg: 16,
    xp: 12,
    r: 9,
    tier: 2,
    minWave: 6,
    weight: 5,
    hpMul: 1.05,
    speedMul: 1,
    dmgMul: 1.1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (!s.phase) {
        s.phase = 'chase';
        s.t = 0;
      }
      s.t += d;
      const base = spd(e);

      if (s.phase === 'chase') {
        // 先慢慢贴着走
        setPolar(e, angTo(e, p), base * 0.55);
        if (s.t > 1.15) {
          s.phase = 'wind';
          s.t = 0;
          s.ang = angTo(e, p);
          fxRing(api, e.x, e.y, 22, '#ff5a6e', 0.3);
        }
      } else if (s.phase === 'wind') {
        // 蓄力：几乎停住，尾巴绷紧
        e.vx *= 0.1;
        e.vy *= 0.1;
        s.ang += clamp(angDiff(angTo(e, p), s.ang), -2.2 * d, 2.2 * d);
        if (s.t > 0.55) {
          s.phase = 'dash';
          s.t = 0;
          fxFlash(api, e.x, e.y, 16, '#ff5a6e');
        }
      } else if (s.phase === 'dash') {
        // 猛冲：方向锁死，不拐弯
        setPolar(e, s.ang, base * 4.6);
        if (s.t > 0.5) {
          s.phase = 'recover';
          s.t = 0;
        }
      } else {
        // 冲完岔气
        setPolar(e, angTo(e, p), base * 0.25);
        if (s.t > 0.65) {
          s.phase = 'chase';
          s.t = 0;
        }
      }
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.phase = 'chase';
      s.t = 0;
    }
  });

  /* 唤潮者：躲远，定期拍三下水母出来 */
  G.ENEMIES.push({
    id: 'summoner',
    name: '唤潮者',
    art: 'summoner',
    hp: 82,
    speed: 34,
    dmg: 10,
    xp: 13,
    r: 8,
    tier: 2,
    minWave: 6,
    weight: 4,
    hpMul: 1,
    speedMul: 1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      if (typeof s.cd !== 'number') s.cd = rr(api, 2.2, 4.2);
      if (!s.side) s.side = 1;
      if (typeof s.t !== 'number') s.t = 0;
      s.t += d;
      if (s.t > 4.5) {
        s.t = 0;
        s.side = -s.side;
      }
      keepRange(e, api, p, 160, 240, spd(e));
      s.cd -= d;
      if (s.cd <= 0) {
        s.cd = 6.5;
        // 拍三下，三只水母从手杖周围浮起来
        for (let i = 0; i < 3; i++) {
          const a = (i / 3) * TAU + e.t;
          spawn(api, 'jelly', e.x + Math.cos(a) * 18, e.y + Math.sin(a) * 18, {});
        }
        fxRing(api, e.x, e.y, 30, '#6ee7a0', 0.45);
        fxFlash(api, e.x, e.y, 28, '#2ee6c8');
        fxSfx(api, 'summon');
      }
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.cd = rr(api, 2.0, 4.5);
      s.side = rr(api, 0, 1) < 0.5 ? 1 : -1;
      s.t = 0;
    }
  });

  /* ==========================================================================
   * 三、Boss（tier 3：血量掉到 50% 换阶段，招更快更密）
   * 权重 0：不参与随机刷，波次脚本按 id 点将
   * ========================================================================== */

  /* 深渊鮟鱇：扇形弹幕 + 召唤小鱼 */
  G.ENEMIES.push({
    id: 'boss_angler',
    name: '深渊鮟鱇',
    art: 'boss_angler',
    hp: 980,
    speed: 28,
    dmg: 16,
    xp: 150,
    r: 18,
    tier: 3,
    minWave: 0,
    weight: 0,
    hpMul: 1,
    speedMul: 1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (typeof s.volT !== 'number') s.volT = 1.6;
      if (typeof s.sumT !== 'number') s.sumT = 5.5;
      const ph2 = !!s.ph2;
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      phaseCheck(e, api, s);
      s.volT -= d;
      s.sumT -= d;

      const dist = dst(e, p);
      const a = angTo(e, p);

      // 张开大嘴往前压，但贴太近会停一下（它要靠弹幕吃人）
      if (dist > 120) setPolar(e, a, spd(e) * (ph2 ? 1.5 : 1));
      else if (dist < 70) setPolar(e, a + Math.PI, spd(e) * 0.6);
      else setPolar(e, a + Math.PI / 2, spd(e) * 0.5);

      // 扇形弹幕
      if (s.volT <= 0) {
        s.volT = ph2 ? 1.9 : 2.8;
        const n = ph2 ? 11 : 7;
        const spread = ph2 ? 1.5 : 0.95;
        const base = a;
        for (let i = 0; i < n; i++) {
          const k = n > 1 ? i / (n - 1) - 0.5 : 0;
          const ang = base + k * spread;
          shot(api, e, ang, ph2 ? 130 : 112, 9, '#ffc84a', 4, 3.2, Math.cos(ang) * 12, Math.sin(ang) * 12);
        }
        fxFlash(api, e.x + Math.cos(a) * 14, e.y + Math.sin(a) * 14, 24, '#ffc84a');
        fxSfx(api, 'boss_spit');
      }

      // 召唤小鱼（刺鱼）
      if (s.sumT <= 0) {
        s.sumT = ph2 ? 6.6 : 9.2;
        const n = 3;
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * TAU + e.t * 0.7;
          spawn(api, 'spikefish', e.x + Math.cos(ang) * 26, e.y + Math.sin(ang) * 26, {});
        }
        fxRing(api, e.x, e.y, 40, '#ffc84a', 0.5);
        fxSfx(api, 'summon');
      }
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.volT = 1.6;
      s.sumT = 5.5;
      s.ph2 = false;
    }
  });

  /* 水母女王：环形弹幕 + 召唤水母 + 冲刺 */
  G.ENEMIES.push({
    id: 'boss_queen',
    name: '水母女王',
    art: 'boss_queen',
    hp: 1200,
    speed: 30,
    dmg: 18,
    xp: 180,
    r: 22,
    tier: 3,
    minWave: 0,
    weight: 0,
    hpMul: 1,
    speedMul: 1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (typeof s.ringT !== 'number') s.ringT = 2.2;
      if (typeof s.sumT !== 'number') s.sumT = 6.5;
      if (typeof s.dashT !== 'number') s.dashT = 5.5;
      if (typeof s.ringOff !== 'number') s.ringOff = 0;
      if (!s.dash) s.dash = { phase: 'idle', t: 0, ang: 0 };
      const ph2 = !!s.ph2;
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      phaseCheck(e, api, s);

      const dist = dst(e, p);
      const a = angTo(e, p);
      const D = s.dash;
      D.t += d;

      // ---- 冲刺状态机 ----
      if (D.phase === 'wind') {
        e.vx *= 0.12;
        e.vy *= 0.12;
        D.ang += clamp(angDiff(a, D.ang), -2.4 * d, 2.4 * d);
        if (D.t > 0.55) {
          D.phase = 'go';
          D.t = 0;
          fxFlash(api, e.x, e.y, 34, '#ff6ec7');
          fxSfx(api, 'boss_dash');
        }
      } else if (D.phase === 'go') {
        setPolar(e, D.ang, spd(e) * 7.5);
        if (D.t > 0.6) {
          D.phase = 'idle';
          D.t = 0;
          s.dashT = ph2 ? 5.0 : 7.4;
          fxRing(api, e.x, e.y, 30, '#ff6ec7', 0.3);
        }
      } else {
        // 平时：隔着距离绕，慢慢晃
        if (dist > 160) setPolar(e, a, spd(e) * 0.9);
        else if (dist < 110) setPolar(e, a + Math.PI, spd(e) * 0.7);
        else setPolar(e, a + Math.PI / 2, spd(e) * 0.7);
        if (dist < 220) s.dashT -= d;
        if (s.dashT <= 0 && dist < 240) {
          D.phase = 'wind';
          D.t = 0;
          D.ang = a;
          fxRing(api, e.x, e.y, 44, '#ff6ec7', 0.4);
        }
      }

      // ---- 环形弹幕 ----
      s.ringT -= d;
      if (s.ringT <= 0) {
        s.ringT = ph2 ? 2.5 : 3.5;
        const n = ph2 ? 22 : 14;
        const sp = ph2 ? 100 : 86;
        for (let i = 0; i < n; i++) {
          const ang = s.ringOff + (i / n) * TAU;
          shot(api, e, ang, sp, 8, '#ff6ec7', 4, 3.4, Math.cos(ang) * 14, Math.sin(ang) * 14);
        }
        s.ringOff += 0.31;
        fxRing(api, e.x, e.y, 36, '#ff6ec7', 0.35);
        fxSfx(api, 'boss_ring');
      }

      // ---- 召唤水母 ----
      s.sumT -= d;
      if (s.sumT <= 0) {
        s.sumT = ph2 ? 7.6 : 10.5;
        const n = ph2 ? 4 : 3;
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * TAU + e.t;
          spawn(api, 'jelly', e.x + Math.cos(ang) * 30, e.y + Math.sin(ang) * 30, {});
        }
        fxRing(api, e.x, e.y, 46, '#ff6ec7', 0.5);
        fxSfx(api, 'summon');
      }
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.ringT = 2.2;
      s.sumT = 6.5;
      s.dashT = 5.5;
      s.ringOff = 0;
      s.ph2 = false;
      s.dash = { phase: 'idle', t: 0, ang: 0 };
    }
  });

  /* 沉鲸之王：大范围冲击波 + 召唤骨鱼 + 拍尾横扫 */
  G.ENEMIES.push({
    id: 'boss_whale',
    name: '沉鲸之王',
    art: 'boss_whale',
    hp: 2200,
    speed: 22,
    dmg: 24,
    xp: 260,
    r: 28,
    tier: 3,
    minWave: 0,
    weight: 0,
    hpMul: 1,
    speedMul: 1,
    dmgMul: 1,
    behavior: function (e, api, dt) {
      const p = pl(api);
      const s = st(e);
      const d = rdt(api, dt);
      if (typeof s.waveT !== 'number') s.waveT = 4.0;
      if (typeof s.sumT !== 'number') s.sumT = 7.5;
      if (typeof s.sweepT !== 'number') s.sweepT = 8.5;
      if (!s.sweepActive) s.sweepActive = false;
      const ph2 = !!s.ph2;
      if (!p) {
        e.vx = 0;
        e.vy = 0;
        return;
      }
      phaseCheck(e, api, s);

      const dist = dst(e, p);
      const a = angTo(e, p);

      // ---- 主体移动：慢，慢慢压过来 ----
      if (s.sweepActive) {
        // 扫尾的时候身子钉住
        e.vx *= 0.2;
        e.vy *= 0.2;
      } else if (dist > 110) {
        setPolar(e, a, spd(e) * (ph2 ? 1.35 : 1));
      } else {
        setPolar(e, a + Math.PI / 2, spd(e) * 0.45);
      }

      // ---- 冲击波：一圈把周围全推开 ----
      s.waveT -= d;
      if (s.waveT <= 0) {
        s.waveT = ph2 ? 4.4 : 6.6;
        const rad = ph2 ? 170 : 120;
        fxExplode(api, e.x, e.y, rad, 24, '#8fd4f0');
        fxRing(api, e.x, e.y, rad * 0.45, '#cdf1ff', 0.5);
        fxRing(api, e.x, e.y, rad * 0.78, '#8fd4f0', 0.75);
        fxShake(api, 9);
        fxSfx(api, 'boss_wave');
      }

      // ---- 召唤骨鱼 ----
      s.sumT -= d;
      if (s.sumT <= 0) {
        s.sumT = ph2 ? 8.2 : 11.5;
        const n = ph2 ? 4 : 3;
        for (let i = 0; i < n; i++) {
          const ang = (i / n) * TAU + e.t * 0.5;
          spawn(api, 'bonefish', e.x + Math.cos(ang) * 38, e.y + Math.sin(ang) * 38, {});
        }
        fxRing(api, e.x, e.y, 54, '#cdf1ff', 0.5);
        fxSfx(api, 'summon');
      }

      // ---- 拍尾横扫：绕自己扫半圈 ----
      if (!s.sweepActive) {
        s.sweepT -= d;
        if (s.sweepT <= 0 && dist < 200) {
          s.sweepActive = true;
          s.sweepT = ph2 ? 6.2 : 9.0;
          s.sweepLeft = 0.95;
          s.sweepDur = 0.95;
          s.sweepBase = a - Math.PI / 2;
          s.sweepDir = (e.t % 2 < 1) ? 1 : -1;
          s.sweepTick = 0;
          fxShake(api, 4);
          fxSfx(api, 'boss_tail');
        }
      } else {
        s.sweepLeft -= d;
        const k = clamp(1 - s.sweepLeft / s.sweepDur, 0, 1);
        const ang = s.sweepBase + s.sweepDir * (k * Math.PI);
        s.sweepTick += d;
        // 每 0.16 秒扫一下：扇形特效 + 尾尖那一下伤害
        if (s.sweepTick >= 0.16) {
          s.sweepTick = 0;
          fxSlash(api, e.x, e.y, ang, 56, 18, '#cdf1ff', 0.18);
          const tx = e.x + Math.cos(ang) * 48;
          const ty = e.y + Math.sin(ang) * 48;
          fxExplode(api, tx, ty, 26, 16, '#8fd4f0');
        }
        if (ph2) {
          // 二阶段尾巴扫两边
          s.sweepTick2 = (s.sweepTick2 || 0) + d;
          if (s.sweepTick2 >= 0.16) {
            s.sweepTick2 = 0;
            const ang2 = s.sweepBase - s.sweepDir * (k * Math.PI);
            fxSlash(api, e.x, e.y, ang2, 56, 18, '#ffc84a', 0.18);
            fxExplode(api, e.x + Math.cos(ang2) * 48, e.y + Math.sin(ang2) * 48, 26, 16, '#ffc84a');
          }
        }
        if (s.sweepLeft <= 0) {
          s.sweepActive = false;
          s.sweepTick2 = 0;
        }
      }
    },
    onSpawn: function (e, api) {
      const s = st(e);
      s.waveT = 4.0;
      s.sumT = 7.5;
      s.sweepT = 8.5;
      s.sweepActive = false;
      s.ph2 = false;
    }
  });
})();
