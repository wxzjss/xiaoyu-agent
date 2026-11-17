/* ============================================================================
 * 20-weapons.js — 鲸落·深渊（ABYSS FALL）武器表
 * 14 把基础武器（Lv8）+ 8 种进化形态（Lv1，不进随机池）
 * 契约见 SPEC.md 4.2 / 4.5：{ id, name, icon, desc, levels[], evo, evoBase, maxLv, fire(w,lv,api), tick(w,lv,api,dt) }
 *   lv = 当前等级条目对象（levels[lv-1]），不是数字
 *   引擎负责冷却计时，fire 只管生成子弹
 * ==========================================================================*/
(function () {
  const G = window.G = window.G || {};
  if (!G.WEAPONS) G.WEAPONS = [];
  const W = G.WEAPONS;
  if (W.__built) return;   // 防重复 push
  W.__built = true;

  /* ---------- 小工具 ---------- */
  // 生成 n 级数值表
  function L(n, f) { const a = []; for (let i = 1; i <= n; i++) a.push(f(i)); return a; }
  // 取玩家乘子，全部兜底成 1
  function A(api) {
    const m = (api && api.mul) || {};
    return {
      dmg: m.dmg || 1,
      area: m.area || 1,
      cd: m.cd || 1,
      amount: m.amount || 0,
      spd: m.speed || m.projSpeed || 1,
      crit: m.crit || 0,
      critDmg: m.critDmg || 0,
    };
  }
  // 玩家位置 + 朝向
  function P(api) {
    const p = api.player || (G.Game && G.Game.player);
    return p || { x: 0, y: 0, aim: 0 };
  }
  function aimOf(p) {
    const a = p.aim == null ? (p.faceAng == null ? (p.face || 0) : p.faceAng) : p.aim;
    return (typeof a === 'number' && isFinite(a)) ? a : 0;
  }
  // 朝最近敌人算角度，没有敌人就用朝向
  function toward(api, p, range) {
    const t = api.nearestEnemy(p.x, p.y, range == null ? 640 : range);
    if (t) return { ang: Math.atan2(t.y - p.y, t.x - p.x), target: t };
    return { ang: aimOf(p), target: null };
  }
  function angToMult(a) { return (a > Math.PI / 2 && a < Math.PI * 1.5) ? -1 : 1; }

  /* ==========================================================================
   * 一、14 把基础武器
   * ========================================================================*/

  /* 1. 鱼叉 —— 朝最近敌人投直线枪，穿透 */
  W.push({
    id: 'harpoon', name: '鱼叉', icon: 'w_harpoon',
    desc: '朝最近敌人投出一根钢叉，穿透多个敌人',
    evo: { need: 'p_power', with: 'harpoon_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 0.80 - l * 0.048,
      dmg: 9 + l * 3.4,
      n: 1 + (l >= 4 ? 1 : 0) + (l >= 8 ? 1 : 0),
      pierce: 1 + Math.floor(l / 2),
      spd: 430,
      spread: l >= 6 ? 0.14 : 0,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api), t0 = toward(api, p, 640);
      const n = lv.n + Math.round(m.amount);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * (lv.spread || 0.18);
        const a = t0.ang + off;
        api.spawnBullet({
          x: p.x, y: p.y,
          vx: Math.cos(a) * lv.spd * m.spd,
          vy: Math.sin(a) * lv.spd * m.spd,
          r: 4 * m.area,
          dmg: lv.dmg * m.dmg,
          pierce: lv.pierce,
          life: 1.5,
          color: '#9fe8ff',
          kind: 'spear',
          len: 12 * m.area,
          rot: a,
          trail: true,
          onHit(b, e) {
            api.burst(e.x, e.y, 3, { color: ['#9fe8ff', '#ffffff'], speed: 60, life: 0.18 });
          },
        });
      }
      api.sfx('shoot');
    },
  });

  /* 2. 泡沫球 —— 缓慢漂浮的追踪泡，命中爆炸 */
  W.push({
    id: 'bubble', name: '泡沫球', icon: 'w_bubble',
    desc: '飘出缓慢的追踪泡泡，碰到就炸开一小片',
    evo: { need: 'p_amount', with: 'bubble_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 1.10 - l * 0.055,
      dmg: 11 + l * 3.2,
      n: 1 + Math.floor(l / 2),
      radius: 20 + l * 2.6,
      spd: 105 + l * 5,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const n = lv.n + Math.round(m.amount);
      for (let i = 0; i < n; i++) {
        const a = aimOf(p) * 0 + (Math.PI * 2 * i) / n + Math.PI * 0.5;
        const t = api.randomEnemyInRange(p.x, p.y, 460);
        const ang = t ? Math.atan2(t.y - p.y, t.x - p.x) + (Math.random() - 0.5) * 0.7 : a;
        api.spawnBullet({
          x: p.x, y: p.y,
          vx: Math.cos(ang) * lv.spd,
          vy: Math.sin(ang) * lv.spd,
          r: 7 * m.area,
          dmg: lv.dmg * m.dmg,
          pierce: 0,
          life: 3.4,
          homing: 2.2,
          color: '#bfeeff',
          kind: 'orb',
          wobble: 1,
          onDie(b) {
            api.explode(b.x, b.y, lv.radius * m.area, lv.dmg * m.dmg * 0.9, { color: '#bfeeff', shake: 2 });
          },
        });
      }
      api.sfx('bubble');
    },
  });

  /* 3. 沉锚 —— 围绕自身旋转的重锚 */
  W.push({
    id: 'anchor', name: '沉锚', icon: 'w_anchor',
    desc: '沉重的船锚绕着你打转，撞到就伤',
    evo: { need: 'p_area', with: 'anchor_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 0.42 - l * 0.022,
      dmg: 8 + l * 2.9,
      n: 1 + Math.floor((l - 1) / 2.5),
      orbit: 46 + l * 3.2,
      size: 15 + l * 1.8,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const n = lv.n + Math.round(m.amount * 0.6);
      const t = (w.state && w.state.a) || 0;
      for (let i = 0; i < n; i++) {
        const a = t + (Math.PI * 2 * i) / n;
        const ox = p.x + Math.cos(a) * lv.orbit * m.area;
        const oy = p.y + Math.sin(a) * lv.orbit * m.area * 0.86;
        api.spawnBullet({
          x: ox, y: oy,
          vx: Math.cos(a) * 260,
          vy: Math.sin(a) * 260,
          r: lv.size * m.area * 0.55,
          dmg: lv.dmg * m.dmg,
          pierce: 999,
          life: 0.34,
          color: '#cfd8e6',
          kind: 'anchor',
          knock: 180,
        });
      }
    },
    tick(w, lv, api, dt) {
      w.state = w.state || { a: 0 };
      w.state.a += dt * 3.4;
    },
  });

  /* 4. 电鳗 —— 闪电链，打到一个人跳到下一个 */
  W.push({
    id: 'eel', name: '电鳗', icon: 'w_eel',
    desc: '一道电弧跳出，在敌人之间连锁传导',
    evo: { need: 'p_crit', with: 'eel_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 0.95 - l * 0.05,
      dmg: 7 + l * 2.6,
      jumps: 1 + Math.floor(l / 2),
      range: 190 + l * 12,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      let cur = api.nearestEnemy(p.x, p.y, 520);
      if (!cur) { api.sfx('shoot'); return; }
      const hit = new Set();
      let from = { x: p.x, y: p.y };
      let dmg = lv.dmg * m.dmg;
      const jumps = lv.jumps + Math.round(m.amount * 0.5);
      for (let j = 0; j <= jumps && cur; j++) {
        api.slash(from.x, from.y, Math.atan2(cur.y - from.y, cur.x - from.x),
          G.dist(from.x, from.y, cur.x, cur.y) || 20, 4, '#a8f0ff', 0.14);
        api.damage(cur, dmg, { knock: 0 });
        api.burst(cur.x, cur.y, 4, { color: ['#a8f0ff', '#ffffff'], speed: 90, life: 0.2 });
        hit.add(cur);
        from = { x: cur.x, y: cur.y };
        dmg *= 0.86;
        // 找下一个没打过的
        let next = null, bd = lv.range * lv.range;
        for (let i = 0; i < api.enemies.length; i++) {
          const e = api.enemies[i];
          if (e.dead || hit.has(e)) continue;
          const d = (e.x - from.x) * (e.x - from.x) + (e.y - from.y) * (e.y - from.y);
          if (d < bd) { bd = d; next = e; }
        }
        cur = next;
      }
      api.sfx('zap');
    },
  });

  /* 5. 海胆 —— 向四周 360° 抛射尖刺 */
  W.push({
    id: 'urchin', name: '海胆', icon: 'w_urchin',
    desc: '向四面八方炸开一圈尖刺',
    evo: { need: 'p_cd', with: 'urchin_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 1.45 - l * 0.07,
      dmg: 6 + l * 2.2,
      n: 6 + l * 2,
      spd: 210 + l * 14,
      pierce: 3 + Math.floor(l / 2),
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const n = lv.n + Math.round(m.amount * 2);
      const base = Math.random() * 0.6;
      for (let i = 0; i < n; i++) {
        const a = base + (Math.PI * 2 * i) / n;
        api.spawnBullet({
          x: p.x, y: p.y,
          vx: Math.cos(a) * lv.spd * m.spd,
          vy: Math.sin(a) * lv.spd * m.spd,
          r: 3.4 * m.area,
          dmg: lv.dmg * m.dmg,
          pierce: lv.pierce,
          life: 1.1,
          color: '#d8f0a0',
          kind: 'spike',
          rot: a,
          len: 9,
        });
      }
      api.sfx('spike');
    },
  });

  /* 6. 声呐 —— 以自身为圆心的扩散脉冲圈 */
  W.push({
    id: 'sonar', name: '声呐', icon: 'w_sonar',
    desc: '一圈声波从脚下荡开，扫到就掉血',
    evo: { need: 'p_duration', with: 'sonar_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 1.75 - l * 0.085,
      dmg: 10 + l * 3.0,
      radius: 82 + l * 12,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const r = lv.radius * m.area;
      api.explode(p.x, p.y, r, lv.dmg * m.dmg, { color: '#7fe6d8', shake: 2, knock: 90 });
      api.ring(p.x, p.y, r, '#7fe6d8', 0.34);
      api.sfx('pulse');
    },
  });

  /* 7. 墨汁 —— 朝敌人丢一滩墨池，持续伤害 */
  W.push({
    id: 'ink', name: '墨汁', icon: 'w_ink',
    desc: '在地上一滩墨，站在里面的都被泡疼',
    evo: { need: 'p_area', with: 'ink_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 2.1 - l * 0.1,
      dmg: 4 + l * 1.5,
      radius: 30 + l * 4,
      life: 2.2 + l * 0.18,
      tick: 0.45,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const t = toward(api, p, 480);
      const dist = 120 + Math.random() * 90;
      const cx = p.x + Math.cos(t.ang) * dist;
      const cy = p.y + Math.sin(t.ang) * dist;
      const r = lv.radius * m.area;
      const dmg = lv.dmg * m.dmg;
      api.ring(cx, cy, r, '#5a5aa8', 0.3);
      w.state = w.state || { pools: [] };
      if (!w.state.pools) w.state.pools = [];
      w.state.pools.push({ x: cx, y: cy, r: r, t: lv.life, acc: 0, dmg: dmg, tick: lv.tick });
      if (w.state.pools.length > 14) w.state.pools.shift();
      api.sfx('splash');
    },
    tick(w, lv, api, dt) {
      if (!w.state || !w.state.pools) return;
      const pools = w.state.pools;
      for (let i = pools.length - 1; i >= 0; i--) {
        const o = pools[i];
        o.t -= dt; o.acc += dt;
        if (o.t <= 0) { pools.splice(i, 1); continue; }
        if (o.acc >= o.tick) {
          o.acc = 0;
          api.explode(o.x, o.y, o.r, o.dmg, { color: '#6a6ac0', shake: 0, sfx: false, slow: 0.25 });
        }
      }
    },
  });

  /* 8. 潮汐 —— 向朝向推出一道横推波浪，击退 */
  W.push({
    id: 'tide', name: '潮汐', icon: 'w_tide',
    desc: '推出一道横浪，撞上的都被推着走',
    evo: { need: 'p_power', with: 'tide_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 1.9 - l * 0.09,
      dmg: 9 + l * 3.1,
      width: 3 + Math.floor(l / 2),
      spd: 190 + l * 16,
      len: 150 + l * 16,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const a = toward(api, p, 520).ang;
      const n = lv.width + Math.round(m.amount * 0.6);
      for (let i = 0; i < n; i++) {
        const off = (i - (n - 1) / 2) * 26;
        const px = p.x + Math.cos(a + Math.PI / 2) * off;
        const py = p.y + Math.sin(a + Math.PI / 2) * off;
        api.spawnBullet({
          x: px, y: py,
          vx: Math.cos(a) * lv.spd * m.spd,
          vy: Math.sin(a) * lv.spd * m.spd,
          r: 13 * m.area,
          dmg: lv.dmg * m.dmg,
          pierce: 999,
          life: 0.85,
          color: '#77c9ff',
          kind: 'wave',
          knock: 260,
          rot: a,
          len: lv.len * m.area * 0.5,
        });
      }
      api.sfx('wave');
    },
  });

  /* 9. 珍珠 —— 弹跳子弹，撞墙/敌人反弹 */
  W.push({
    id: 'pearl', name: '珍珠', icon: 'w_pearl',
    desc: '一颗圆润的珠子在敌人之间跳来跳去',
    evo: { need: 'p_luck', with: 'pearl_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 1.6 - l * 0.08,
      dmg: 8 + l * 2.8,
      n: 1 + Math.floor(l / 3),
      bounces: 3 + l,
      spd: 300,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const n = lv.n + Math.round(m.amount * 0.5);
      for (let i = 0; i < n; i++) {
        const a = toward(api, p, 520).ang + (Math.random() - 0.5) * 0.9;
        api.spawnBullet({
          x: p.x, y: p.y,
          vx: Math.cos(a) * lv.spd * m.spd,
          vy: Math.sin(a) * lv.spd * m.spd,
          r: 5 * m.area,
          dmg: lv.dmg * m.dmg,
          pierce: lv.bounces,
          life: 3.2,
          homing: 1.4,
          color: '#fff6d0',
          kind: 'orb',
          turn: 3.2,
        });
      }
      api.sfx('shoot');
    },
  });

  /* 10. 骨枪 —— 朝最近敌人捅一根超长骨矛，高伤 */
  W.push({
    id: 'lance', name: '骨枪', icon: 'w_lance',
    desc: '一根贯穿全场的骨矛，慢慢但极重',
    evo: { need: 'p_power', with: 'lance_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 2.5 - l * 0.11,
      dmg: 26 + l * 9.5,
      spd: 620,
      len: 90 + l * 10,
      pierce: 6 + l * 2,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const a = toward(api, p, 900).ang;
      api.spawnBullet({
        x: p.x, y: p.y,
        vx: Math.cos(a) * lv.spd * m.spd,
        vy: Math.sin(a) * lv.spd * m.spd,
        r: 6 * m.area,
        dmg: lv.dmg * m.dmg,
        pierce: lv.pierce,
        life: 1.4,
        color: '#f0e0c0',
        kind: 'spear',
        rot: a,
        len: lv.len * m.area,
        knock: 220,
        onHit(b, e) { api.burst(e.x, e.y, 6, { color: ['#f0e0c0', '#ffffff'], speed: 110, life: 0.25 }); },
      });
      api.shake(2);
      api.sfx('lance');
    },
  });

  /* 11. 鱼群 —— 放出一群小鱼追踪敌人 */
  W.push({
    id: 'swarm', name: '鱼群', icon: 'w_swarm',
    desc: '放出一小群鱼，自己会追着咬',
    evo: { need: 'p_amount', with: 'swarm_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 2.3 - l * 0.1,
      dmg: 5 + l * 1.9,
      n: 3 + l,
      spd: 180 + l * 10,
      life: 2.0 + l * 0.12,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const n = lv.n + Math.round(m.amount * 1.5);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2;
        api.spawnBullet({
          x: p.x + Math.cos(a) * 14, y: p.y + Math.sin(a) * 14,
          vx: Math.cos(a) * 70, vy: Math.sin(a) * 70,
          r: 4 * m.area,
          dmg: lv.dmg * m.dmg,
          pierce: 1,
          life: lv.life,
          homing: 4.2,
          color: '#9fe0c0',
          kind: 'fish',
          wobble: 1.6,
          accel: 90,
        });
      }
      api.sfx('swarm');
    },
  });

  /* 12. 寒气 —— 身周常驻寒气光环，持续伤害 + 减速 */
  W.push({
    id: 'aura', name: '寒气', icon: 'w_aura',
    desc: '贴身一层寒气，靠近你的都冻得发抖',
    evo: { need: 'p_area', with: 'aura_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 0.6,
      dmg: 3 + l * 1.4,
      radius: 52 + l * 7,
      tick: 0.4,
    })),
    fire() { /* 靠 tick 输出 */ },
    tick(w, lv, api, dt) {
      w.state = w.state || { acc: 0 };
      w.state.acc += dt;
      if (w.state.acc < lv.tick) return;
      w.state.acc = 0;
      const m = A(api), p = P(api);
      const r = lv.radius * m.area;
      api.explode(p.x, p.y, r, lv.dmg * m.dmg, { color: '#a0e0ff', shake: 0, sfx: false, slow: 0.5 });
      api.ring(p.x, p.y, r, '#a0e0ff', 0.3);
    },
  });

  /* 13. 锁链 —— 甩出锁链钩住敌人，把敌人拽向自己 */
  W.push({
    id: 'chain', name: '锁链', icon: 'w_chain',
    desc: '甩出钩链，钩住的敌人被硬拖过来',
    evo: { need: 'p_crit', with: 'chain_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 1.8 - l * 0.08,
      dmg: 7 + l * 2.5,
      n: 1 + Math.floor(l / 3),
      spd: 460,
      pull: 90 + l * 10,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const n = lv.n + Math.round(m.amount * 0.4);
      for (let i = 0; i < n; i++) {
        const a = toward(api, p, 560).ang + (i - (n - 1) / 2) * 0.16;
        api.spawnBullet({
          x: p.x, y: p.y,
          vx: Math.cos(a) * lv.spd * m.spd,
          vy: Math.sin(a) * lv.spd * m.spd,
          r: 5 * m.area,
          dmg: lv.dmg * m.dmg,
          pierce: 2,
          life: 0.72,
          color: '#c8b090',
          kind: 'chain',
          rot: a,
          len: 16,
          onHit(b, e) {
            const dx = p.x - e.x, dy = p.y - e.y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            api.damage(e, 0, { knock: lv.pull, fromX: e.x - dx / d * 40, fromY: e.y - dy / d * 40 });
            api.burst(e.x, e.y, 3, { color: ['#c8b090'], speed: 70, life: 0.2 });
          },
        });
      }
      api.sfx('chain');
    },
  });

  /* 14. 鲸歌 —— 以自身为中心的巨型冲击波 */
  W.push({
    id: 'whale', name: '鲸歌', icon: 'w_whale',
    desc: '一声长鸣荡开，大范围重击并击退',
    evo: { need: 'p_luck', with: 'whale_evo' },
    maxLv: 8,
    levels: L(8, (l) => ({
      cd: 3.6 - l * 0.16,
      dmg: 24 + l * 9,
      radius: 110 + l * 20,
    })),
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const r = lv.radius * m.area;
      api.explode(p.x, p.y, r, lv.dmg * m.dmg, { color: '#8fb8ff', shake: 7, knock: 420 });
      api.ring(p.x, p.y, r * 0.6, '#8fb8ff', 0.4);
      api.ring(p.x, p.y, r, '#cfe0ff', 0.55);
      api.shake(6);
      api.sfx('whale');
    },
  });

  /* ==========================================================================
   * 二、8 种进化形态（maxLv:1，不进随机池，evoBase 指回基础武器）
   * ========================================================================*/

  /* 深渊巨叉 */
  W.push({
    id: 'harpoon_evo', name: '深渊巨叉', icon: 'w_harpoon',
    desc: '三根贯穿巨叉同时钉出，余威撕裂路径',
    evoBase: 'harpoon', maxLv: 1,
    levels: [{ cd: 0.42, dmg: 42, n: 3, pierce: 12, spd: 520 }],
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const t0 = toward(api, p, 800);
      for (let i = 0; i < lv.n; i++) {
        const a = t0.ang + (i - 1) * 0.17;
        api.spawnBullet({
          x: p.x, y: p.y,
          vx: Math.cos(a) * lv.spd * m.spd,
          vy: Math.sin(a) * lv.spd * m.spd,
          r: 6 * m.area, dmg: lv.dmg * m.dmg,
          pierce: lv.pierce, life: 1.8,
          color: '#6fd8ff', kind: 'spear', rot: a, len: 22 * m.area,
          onHit(b, e) {
            api.explode(e.x, e.y, 26, lv.dmg * m.dmg * 0.35, { color: '#6fd8ff', shake: 1, sfx: false });
          },
        });
      }
      api.shake(3);
      api.sfx('lance');
    },
  });

  /* 泡狱 */
  W.push({
    id: 'bubble_evo', name: '泡狱', icon: 'w_bubble',
    desc: '漫场泡泡，同时炸开一圈连锁',
    evoBase: 'bubble', maxLv: 1,
    levels: [{ cd: 0.72, dmg: 30, n: 5, radius: 54, spd: 130 }],
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      for (let i = 0; i < lv.n; i++) {
        const a = (Math.PI * 2 * i) / lv.n + Math.random() * 0.4;
        api.spawnBullet({
          x: p.x, y: p.y,
          vx: Math.cos(a) * lv.spd, vy: Math.sin(a) * lv.spd,
          r: 9 * m.area, dmg: lv.dmg * m.dmg,
          pierce: 0, life: 3.6, homing: 2.6,
          color: '#d8f6ff', kind: 'orb', wobble: 1,
          onDie(b) {
            api.explode(b.x, b.y, lv.radius * m.area, lv.dmg * m.dmg, { color: '#d8f6ff', shake: 3 });
          },
        });
      }
      api.sfx('bubble');
    },
  });

  /* 镇海锚 */
  W.push({
    id: 'anchor_evo', name: '镇海锚', icon: 'w_anchor',
    desc: '四只巨锚绕场碾过，甩不掉的压迫感',
    evoBase: 'anchor', maxLv: 1,
    levels: [{ cd: 0.2, dmg: 26, n: 4, orbit: 78, size: 30 }],
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const t = (w.state && w.state.a) || 0;
      for (let i = 0; i < lv.n; i++) {
        const a = t + (Math.PI * 2 * i) / lv.n;
        api.spawnBullet({
          x: p.x + Math.cos(a) * lv.orbit * m.area,
          y: p.y + Math.sin(a) * lv.orbit * m.area * 0.86,
          vx: Math.cos(a) * 320, vy: Math.sin(a) * 320,
          r: lv.size * m.area * 0.5,
          dmg: lv.dmg * m.dmg,
          pierce: 999, life: 0.5,
          color: '#e0e8f4', kind: 'anchor', knock: 320,
        });
      }
    },
    tick(w, lv, api, dt) {
      w.state = w.state || { a: 0 };
      w.state.a += dt * 4.2;
    },
  });

  /* 雷渊 */
  W.push({
    id: 'eel_evo', name: '雷渊', icon: 'w_eel',
    desc: '电弧在敌群里来回贯穿，越跳越远',
    evoBase: 'eel', maxLv: 1,
    levels: [{ cd: 0.5, dmg: 26, jumps: 9, range: 320 }],
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      let cur = api.nearestEnemy(p.x, p.y, 620);
      if (!cur) return;
      const hit = new Set();
      let from = { x: p.x, y: p.y }, dmg = lv.dmg * m.dmg;
      for (let j = 0; j <= lv.jumps && cur; j++) {
        api.slash(from.x, from.y, Math.atan2(cur.y - from.y, cur.x - from.x),
          G.dist(from.x, from.y, cur.x, cur.y) || 24, 6, '#c8f4ff', 0.16);
        api.damage(cur, dmg, { knock: 0 });
        hit.add(cur); from = { x: cur.x, y: cur.y }; dmg *= 0.9;
        let next = null, bd = lv.range * lv.range;
        for (let i = 0; i < api.enemies.length; i++) {
          const e = api.enemies[i];
          if (e.dead || hit.has(e)) continue;
          const d = (e.x - from.x) ** 2 + (e.y - from.y) ** 2;
          if (d < bd) { bd = d; next = e; }
        }
        cur = next;
      }
      api.sfx('zap');
    },
  });

  /* 千棘 */
  W.push({
    id: 'urchin_evo', name: '千棘', icon: 'w_urchin',
    desc: '连续三波尖刺雨，把四周填满',
    evoBase: 'urchin', maxLv: 1,
    levels: [{ cd: 0.85, dmg: 18, n: 22, spd: 280, pierce: 8 }],
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      w.state = w.state || { volley: 0 };
      for (let k = 0; k < 3; k++) {
        const base = (w.state.volley = (w.state.volley || 0) + 0.45);
        for (let i = 0; i < lv.n; i++) {
          const a = base + (Math.PI * 2 * i) / lv.n;
          api.spawnBullet({
            x: p.x, y: p.y,
            vx: Math.cos(a) * lv.spd * m.spd,
            vy: Math.sin(a) * lv.spd * m.spd,
            r: 4 * m.area, dmg: lv.dmg * 0.5 * m.dmg,
            pierce: lv.pierce, life: 0.9,
            color: '#e8ffb0', kind: 'spike', rot: a, len: 11,
          });
        }
      }
      api.sfx('spike');
    },
  });

  /* 共鸣 */
  W.push({
    id: 'sonar_evo', name: '共鸣', icon: 'w_sonar',
    desc: '双层声波来回震荡，一次扫两遍',
    evoBase: 'sonar', maxLv: 1,
    levels: [{ cd: 0.95, dmg: 34, radius: 230 }],
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const r = lv.radius * m.area;
      api.explode(p.x, p.y, r, lv.dmg * m.dmg, { color: '#7fe6d8', shake: 4, knock: 200 });
      api.ring(p.x, p.y, r, '#7fe6d8', 0.42);
      w.state = w.state || {};
      w.state.echo = 0.22;
      api.sfx('pulse');
    },
    tick(w, lv, api, dt) {
      if (!w.state || !(w.state.echo > 0)) return;
      w.state.echo -= dt;
      if (w.state.echo <= 0) {
        const m = A(api), p = P(api);
        const r = lv.radius * 0.66 * m.area;
        api.explode(p.x, p.y, r, lv.dmg * 0.55 * m.dmg, { color: '#b0fff0', shake: 2, sfx: false });
        api.ring(p.x, p.y, r, '#b0fff0', 0.32);
      }
    },
  });

  /* 墨海 */
  W.push({
    id: 'ink_evo', name: '墨海', icon: 'w_ink',
    desc: '泼出一整片墨，海里寸步难行',
    evoBase: 'ink', maxLv: 1,
    levels: [{ cd: 1.1, dmg: 10, radius: 96, life: 4.0, tick: 0.3 }],
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const r = lv.radius * m.area;
      const n = 3;
      w.state = w.state || { pools: [] };
      if (!w.state.pools) w.state.pools = [];
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, d = 60 + Math.random() * 140;
        w.state.pools.push({
          x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d,
          r: r * (0.7 + Math.random() * 0.4),
          t: lv.life, acc: 0, dmg: lv.dmg * m.dmg, tick: lv.tick,
        });
      }
      if (w.state.pools.length > 20) w.state.pools.splice(0, w.state.pools.length - 20);
      api.sfx('splash');
    },
    tick(w, lv, api, dt) {
      if (!w.state || !w.state.pools) return;
      const pools = w.state.pools;
      for (let i = pools.length - 1; i >= 0; i--) {
        const o = pools[i];
        o.t -= dt; o.acc += dt;
        if (o.t <= 0) { pools.splice(i, 1); continue; }
        if (o.acc >= o.tick) {
          o.acc = 0;
          api.explode(o.x, o.y, o.r, o.dmg, { color: '#7070d0', shake: 0, sfx: false, slow: 0.5 });
        }
      }
    },
  });

  /* 万鲸共鸣 */
  W.push({
    id: 'whale_evo', name: '万鲸共鸣', icon: 'w_whale',
    desc: '整片海一起长鸣，三重冲击波层层压开',
    evoBase: 'whale', maxLv: 1,
    levels: [{ cd: 2.6, dmg: 70, radius: 300 }],
    fire(w, lv, api) {
      const m = A(api), p = P(api);
      const r = lv.radius * m.area;
      api.explode(p.x, p.y, r, lv.dmg * m.dmg, { color: '#8fb8ff', shake: 10, knock: 600 });
      api.ring(p.x, p.y, r * 0.4, '#8fb8ff', 0.4);
      api.ring(p.x, p.y, r * 0.7, '#a8c8ff', 0.5);
      api.ring(p.x, p.y, r, '#e0ecff', 0.62);
      api.shake(9);
      api.sfx('whale');
    },
    tick(w, lv, api, dt) {
      w.state = w.state || { acc: 0 };
      w.state.acc += dt;
      if (w.state.acc < 0.5) return;
      w.state.acc = 0;
      const m = A(api), p = P(api);
      api.explode(p.x, p.y, 120 * m.area, lv.dmg * 0.16 * m.dmg, { color: '#b0c8ff', shake: 0, sfx: false, knock: 120, slow: 0.3 });
    },
  });

  /* ==========================================================================
   * 三、索引表（引擎可以按 id 直接查）
   * ========================================================================*/
  if (!G.WEAPON_BY_ID) G.WEAPON_BY_ID = {};
  for (let i = 0; i < W.length; i++) {
    G.WEAPON_BY_ID[W[i].id] = W[i];
  }
  // 进随机池的只有基础武器
  if (!G.WEAPON_BASE_IDS) {
    G.WEAPON_BASE_IDS = W.filter(function (d) { return !d.evoBase; }).map(function (d) { return d.id; });
  }
  // 进化查表：基础 id → 进化 id
  if (!G.WEAPON_EVOLVE) {
    G.WEAPON_EVOLVE = {};
    for (let i = 0; i < W.length; i++) {
      if (W[i].evoBase) G.WEAPON_EVOLVE[W[i].evoBase] = W[i].id;
    }
  }
  // 特效占位（引擎可能没定义这些音效名，调用前已由 api.sfx 兜住）
  if (G.WEAPONS.length !== 22) {
    console.warn('[20-weapons] 武器数量 ' + G.WEAPONS.length + '，应为 22');
  }
})();
