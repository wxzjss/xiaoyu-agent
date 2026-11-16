/* ============================================================
 * 鲸落·深渊 —— 主逻辑（状态机 / 玩家 / 敌人 / 子弹 / 波次 / 升级）
 * ============================================================ */
(function () {
  'use strict';
  const G = window.G;
  const Cam = G.camera;

  const PAL = {
    bg0: '#05070d', bg1: '#0b1020', bg2: '#141d33', bg3: '#1e2c4a',
    blue: '#3f6394', lblue: '#5b93c9', ice: '#8fd4f0', pale: '#cdf1ff',
    white: '#ffffff', gold: '#ffc84a', goldL: '#ffe6a3', orange: '#ff9a3c',
    red: '#ff5a6e', redD: '#b02a45', pink: '#ff6ec7', purple: '#b06cff',
    purpleD: '#5b2e8f', green: '#6ee7a0', teal: '#2ee6c8', brown: '#a2673f',
    gray: '#7b8aa3', grayD: '#3b4657',
  };
  G.PAL = PAL;

  /* ---------- 角色 ---------- */
  const CHARS = [
    { id: 'whale', name: '鲸落', desc: '平衡型 · 初始【鱼叉】', weapon: 'harpoon', hp: 110, speed: 96, dmg: 0.05, luck: 0, cost: 0, tint: 0 },
    { id: 'eel', name: '鳗影', desc: '又快又脆 · 初始【电鳗】', weapon: 'eel', hp: 88, speed: 112, dmg: 0, luck: 0.05, cost: 260, tint: 60 },
    { id: 'crab', name: '铁壳', desc: '血厚防高 · 初始【沉锚】', weapon: 'anchor', hp: 165, speed: 86, dmg: 0, luck: 0, cost: 520, tint: -80 },
    { id: 'ghost', name: '溺魂', desc: '幸运流 · 初始【鱼群】', weapon: 'swarm', hp: 82, speed: 104, dmg: 0, luck: 0.3, cost: 900, tint: 150 },
  ];
  G.CHARS = CHARS;

  /* ---------- 局外成长 ---------- */
  const META_DEF = [
    { id: 'm_hp', name: '鲸脂', desc: '初始生命 +8/级', max: 8, cost: 60 },
    { id: 'm_dmg', name: '利齿', desc: '伤害 +4%/级', max: 8, cost: 80 },
    { id: 'm_spd', name: '尾鳍', desc: '移速 +3%/级', max: 6, cost: 70 },
    { id: 'm_xp', name: '求知', desc: '经验 +6%/级', max: 6, cost: 90 },
    { id: 'm_lck', name: '海之恩', desc: '幸运 +5%/级', max: 6, cost: 110 },
  ];
  G.META_DEF = META_DEF;

  const ACHS = [
    { id: 'a_first', name: '初次下潜', desc: '完成第一局游戏' },
    { id: 'a_kill100', name: '百兽斩', desc: '单局击杀 100 只' },
    { id: 'a_kill500', name: '深渊屠夫', desc: '单局击杀 500 只' },
    { id: 'a_kill1500', name: '鲸落之怒', desc: '单局击杀 1500 只' },
    { id: 'a_lv20', name: '成长', desc: '单局升到 20 级' },
    { id: 'a_lv40', name: '蜕变', desc: '单局升到 40 级' },
    { id: 'a_evo', name: '进化', desc: '首次让武器进化' },
    { id: 'a_boss1', name: '猎鮟鱇', desc: '击败深渊鮟鱇' },
    { id: 'a_boss2', name: '灭女王', desc: '击败水母女王' },
    { id: 'a_boss3', name: '沉鲸终结', desc: '击败沉鲸之王' },
    { id: 'a_win', name: '深渊征服者', desc: '通关（活到 15:00）' },
    { id: 'a_noHit', name: '无伤', desc: '前 3 分钟不受伤' },
    { id: 'a_allW', name: '军火库', desc: '一局装满 6 把武器' },
    { id: 'a_coin', name: '发财', desc: '累计获得 5000 金币' },
  ];
  G.ACHS = ACHS;

  function defaultSave() {
    return {
      coins: 0, totalCoins: 0, meta: {}, achs: {}, unlocked: { whale: true },
      best: { time: 0, kills: 0, level: 0 }, runs: 0, kills: 0,
      settings: { master: 0.7, music: 0.45, sfx: 0.7, shake: true, damageNum: true, autoAim: true },
      seen: {},
    };
  }

  const Game = {
    state: 'title',
    time: 0,
    dt: 0,
    t0: 0,
    paused: false,
    over: false,
    win: false,
    kills: 0,
    coinsRun: 0,
    hitTaken: false,
    selChar: 0,
    selIndex: 0,
    save: defaultSave(),
    player: null,
    enemies: [],
    bullets: [],
    pickups: [],
    particles: [],
    effects: [],
    texts: [],
    hazards: [],
    orbs: [],
    spawnTimer: 0,
    bossTimer: 0,
    bossIndex: 0,
    levelUpQueue: 0,
    cards: [],
    cardSel: 0,
    rerolls: 1,
    msg: null,
    msgT: 0,
    hitstopT: 0,
    slowmo: 0,
    waveAnnounce: 0,
    lastStage: 0,
    menuTab: 0,
    stat: { dmg: 0, kills10: 0 },
    seeds: [],
    frame: 0,
  };
  G.Game = Game;

  const MAX_WEAPONS = 6;
  const MAX_PASSIVES = 6;
  const RUN_TIME = 900; // 15 分钟

  /* ---------- 存档 ---------- */
  function loadGame() {
    const s = G.loadSave();
    const d = defaultSave();
    if (s && typeof s === 'object') {
      Game.save = Object.assign(d, s);
      Game.save.settings = Object.assign(d.settings, s.settings || {});
      Game.save.meta = s.meta || {};
      Game.save.achs = s.achs || {};
      Game.save.unlocked = Object.assign({ whale: true }, s.unlocked || {});
      Game.save.best = Object.assign(d.best, s.best || {});
    } else {
      Game.save = d;
    }
  }
  function persist() { G.writeSave(Game.save); }

  /* ---------- 成就 ---------- */
  function unlockAch(id) {
    if (Game.save.achs[id]) return;
    const a = ACHS.find((x) => x.id === id);
    if (!a) return;
    Game.save.achs[id] = 1;
    persist();
    toast('成就达成：' + a.name);
    if (G.AUDIO) G.AUDIO.sfx('levelup');
  }
  Game.unlockAch = unlockAch;

  function toast(str, t) {
    Game.msg = str;
    Game.msgT = t || 2.2;
  }
  Game.toast = toast;

  /* ---------- 空间网格 ---------- */
  const GS = 64;
  let grid = new Map();
  function gridKey(gx, gy) { return gx * 73856093 ^ gy * 19349663; }
  function buildGrid() {
    grid.clear();
    const es = Game.enemies;
    for (let i = 0; i < es.length; i++) {
      const e = es[i];
      const k = gridKey((e.x / GS) | 0, (e.y / GS) | 0);
      let a = grid.get(k);
      if (!a) { a = []; grid.set(k, a); }
      a.push(e);
    }
  }
  function nearEnemies(x, y, r, cb) {
    const x0 = ((x - r) / GS) | 0, x1 = ((x + r) / GS) | 0;
    const y0 = ((y - r) / GS) | 0, y1 = ((y + r) / GS) | 0;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const a = grid.get(gridKey(gx, gy));
        if (!a) continue;
        for (let i = 0; i < a.length; i++) if (cb(a[i]) === false) return;
      }
    }
  }
  Game.nearEnemies = nearEnemies;

  /* ---------- 粒子 / 特效 ---------- */
  function particle(x, y, o) {
    if (Game.particles.length > 900) return;
    o = o || {};
    Game.particles.push({
      x, y,
      vx: o.vx || 0, vy: o.vy || 0,
      life: o.life || 0.5, max: o.life || 0.5,
      color: o.color || '#fff',
      r: o.r == null ? 1 : o.r,
      grav: o.gravity || 0,
      drag: o.drag == null ? 0.92 : o.drag,
      glow: o.glow || false,
      shrink: o.shrink !== false,
    });
  }
  function burst(x, y, n, o) {
    o = o || {};
    for (let i = 0; i < n; i++) {
      const a = o.angle == null ? Math.random() * Math.PI * 2 : o.angle + (Math.random() - 0.5) * (o.spread || 0.9);
      const sp = (o.speed || 60) * (0.4 + Math.random() * 0.9);
      particle(x, y, {
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: (o.life || 0.5) * (0.6 + Math.random() * 0.8),
        color: Array.isArray(o.color) ? G.pick(o.color) : (o.color || '#fff'),
        r: o.r || (Math.random() < 0.3 ? 2 : 1),
        gravity: o.gravity, drag: o.drag, glow: o.glow,
      });
    }
  }
  Game.particle = particle;
  Game.burst = burst;

  function ringFx(x, y, r, color, life, w) {
    Game.effects.push({ kind: 'ring', x, y, r0: r * 0.25, r1: r, color, life: life || 0.35, max: life || 0.35, w: w || 2 });
  }
  function slashFx(x, y, ang, len, width, color, life) {
    Game.effects.push({ kind: 'slash', x, y, ang, len, width: width || 10, color, life: life || 0.2, max: life || 0.2 });
  }
  function floatText(x, y, str, color, size) {
    if (Game.texts.length > 60) Game.texts.shift();
    Game.texts.push({ x, y, str, color: color || '#fff', life: 0.7, max: 0.7, vy: -26, size: size || 9 });
  }
  Game.ringFx = ringFx;
  Game.slashFx = slashFx;
  Game.floatText = floatText;

  /* ---------- 玩家 ---------- */
  function makePlayer(ch) {
    const meta = Game.save.meta || {};
    const p = {
      x: 320, y: 180, vx: 0, vy: 0,
      r: 6,
      hp: 1, maxHp: 1,
      speed: 96,
      facing: 1,
      hurtT: 0, invuln: 0,
      level: 1, xp: 0, xpNext: 6,
      weapons: [], passives: [],
      buffs: {},
      dmgFlash: 0,
      animT: 0,
      char: ch,
      regenT: 0,
      dashCd: 0, dashT: 0,
      killCount: 0,
      shield: 0,
      mulBase: null,
      stats: null,
    };
    p.maxHp = ch.hp + (meta.m_hp || 0) * 8;
    p.hp = p.maxHp;
    p.speed = ch.speed * (1 + (meta.m_spd || 0) * 0.03);
    return p;
  }

  function recomputeStats() {
    const p = Game.player;
    const m = {
      dmg: Game.player.char.dmg + (Game.save.meta.m_dmg || 0) * 0.04,
      area: 1, moveSpeed: 1, cd: 1, amount: 0, duration: 1,
      magnet: 1, armor: 0, regen: 0, luck: Game.player.char.luck + (Game.save.meta.m_lck || 0) * 0.05,
      critDmg: 1.6, xpGain: 1 + (Game.save.meta.m_xp || 0) * 0.06,
      crit: 0.05, projSpeed: 1, dash: 0, thorns: 0,
    };
    // 被动累加
    for (const ps of p.passives) {
      const def = G.PASSIVES.find((x) => x.id === ps.id);
      if (!def) continue;
      for (let i = 0; i < ps.lv; i++) {
        try { def.apply({ mul: m, player: p }, i + 1); } catch (e) { }
      }
    }
    // 角色 / 局外
    m.dmg = Math.max(0.15, m.dmg + 0);
    m.moveSpeed = Math.max(0.3, m.moveSpeed);
    m.cd = Math.max(0.25, m.cd);
    m.armor = Math.min(0.75, m.armor);
    p.stats = m;
    p.speed = p.char.speed * m.moveSpeed;
    return m;
  }
  Game.recomputeStats = recomputeStats;

  /* ---------- 武器 ---------- */
  function addWeapon(id) {
    const p = Game.player;
    const def = G.WEAPONS.find((w) => w.id === id);
    if (!def) return null;
    const ex = p.weapons.find((w) => w.id === id);
    if (ex) {
      if (ex.lv < (def.maxLv || 8)) { ex.lv++; return ex; }
      return null;
    }
    if (p.weapons.length >= MAX_WEAPONS) return null;
    const w = { id, lv: 1, timer: 0.1 + Math.random() * 0.2, def };
    p.weapons.push(w);
    return w;
  }
  Game.addWeapon = addWeapon;

  function addPassive(id) {
    const p = Game.player;
    const def = G.PASSIVES.find((x) => x.id === id);
    if (!def) return null;
    const ex = p.passives.find((w) => w.id === id);
    if (ex) {
      if (ex.lv < (def.maxLv || 5)) { ex.lv++; return ex; }
      return null;
    }
    if (p.passives.length >= MAX_PASSIVES) return null;
    const w = { id, lv: 1, def };
    p.passives.push(w);
    return w;
  }
  Game.addPassive = addPassive;

  function getWeaponLevelEntry(w) {
    const def = w.def;
    const arr = def.levels || [];
    const i = Math.min(arr.length - 1, Math.max(0, w.lv - 1));
    return arr[i] || {};
  }
  Game.getWeaponLevelEntry = getWeaponLevelEntry;

  /* ---------- 敌人 ---------- */
  function spawnEnemy(id, x, y, opt) {
    const def = G.ENEMIES.find((e) => e.id === id);
    if (!def) return null;
    const t = Game.time;
    const o = opt || {};
    const hpScale = o.noScale ? 1 : (1 + t / 95 + Math.pow(t / 300, 1.9));
    const e = {
      id, def,
      x, y,
      vx: 0, vy: 0,
      hp: def.hp * hpScale * (o.hpMul || 1),
      maxHp: def.hp * hpScale * (o.hpMul || 1),
      speed: def.speed * (o.speedMul || 1),
      dmg: def.dmg * (o.dmgMul || 1) * (1 + t / 400),
      xp: def.xp || 1,
      r: def.r || 6,
      t: 0, flash: 0, dead: false,
      state: {},
      hpScale,
      elite: !!o.elite,
      boss: def.tier === 3,
      facing: 1,
      slow: 0, freeze: 0,
    };
    if (o.elite) {
      e.hp *= 3.2; e.maxHp = e.hp; e.r *= 1.25; e.xp *= 4; e.dmg *= 1.4;
      e.speed *= 0.86;
    }
    Game.enemies.push(e);
    if (def.onSpawn) { try { def.onSpawn(e, API); } catch (err) { } }
    return e;
  }
  Game.spawnEnemy = spawnEnemy;

  function damageEnemy(e, amount, opt) {
    if (e.dead) return 0;
    const o = opt || {};
    let dmg = amount;
    if (!o.noCrit) {
      const crit = Math.random() < (Game.player.stats.crit + Game.player.stats.luck * 0.3);
      if (crit) { dmg *= Game.player.stats.critDmg; o.crit = true; }
    }
    if (e.def && e.def.onHurt) { try { e.def.onHurt(e, dmg, API); } catch (err) { } }
    e.hp -= dmg;
    e.flash = 0.09;
    Game.stat.dmg += dmg;
    if (Game.save.settings.damageNum) {
      floatText(e.x + G.rand(-3, 3), e.y - e.r - 4, Math.round(dmg) + '', o.crit ? '#ffc84a' : '#ffffff', o.crit ? 11 : 8);
    }
    if (o.knock && !e.boss) {
      const a = o.knockAngle != null ? o.knockAngle : Math.atan2(e.y - o.fromY, e.x - o.fromX);
      const k = o.knock / (1 + (e.def.tier === 2 ? 2 : 1) * 0.6);
      e.vx += Math.cos(a) * k;
      e.vy += Math.sin(a) * k;
    }
    if (e.hp <= 0) killEnemy(e, o);
    return dmg;
  }
  Game.damageEnemy = damageEnemy;

  function killEnemy(e, opt) {
    if (e.dead) return;
    e.dead = true;
    Game.kills++;
    const p = Game.player;
    p.killCount++;
    if (e.def.onDeath) { try { e.def.onDeath(e, API); } catch (err) { } }
    // 掉经验
    const n = e.boss ? 30 : e.elite ? 6 : 1;
    for (let i = 0; i < n; i++) {
      dropPickup('gem', e.x + G.rand(-6, 6), e.y + G.rand(-6, 6), e.xp || 1);
    }
    if (e.boss) {
      for (let i = 0; i < 6; i++) dropPickup('coin', e.x + G.rand(-16, 16), e.y + G.rand(-16, 16), 12);
      dropPickup('chest', e.x, e.y, 1);
      Game.bossKilled = (Game.bossKilled || 0) + 1;
      Cam.kick(9, 0.6);
      ringFx(e.x, e.y, 140, '#ffc84a', 0.8, 3);
      if (e.id === 'boss_angler') unlockAch('a_boss1');
      if (e.id === 'boss_queen') unlockAch('a_boss2');
      if (e.id === 'boss_whale') unlockAch('a_boss3');
    } else if (e.elite) {
      dropPickup('coin', e.x, e.y, 3);
    } else if (G.chance(0.012 + Game.player.stats.luck * 0.02)) {
      dropPickup('heart', e.x, e.y, 1);
    }
    burst(e.x, e.y, e.boss ? 40 : 6, {
      color: e.boss ? ['#ff5a6e', '#ff9a3c', '#ffc84a', '#ffffff'] : ['#ff5a6e', '#8fd4f0', '#cdf1ff'],
      speed: e.boss ? 180 : 70,
      life: e.boss ? 0.9 : 0.4,
      glow: true,
    });
    if (Game.kills === 100) unlockAch('a_kill100');
    if (Game.kills === 500) unlockAch('a_kill500');
    if (Game.kills === 1500) unlockAch('a_kill1500');
  }
  Game.killEnemy = killEnemy;

  /* ---------- 掉落 ---------- */
  function dropPickup(type, x, y, value) {
    if (Game.pickups.length > 700) return;
    Game.pickups.push({
      type, x, y, vx: G.rand(-30, 30), vy: G.rand(-30, 30),
      value: value || 1, t: 0, r: type === 'chest' ? 10 : 4,
    });
  }
  Game.dropPickup = dropPickup;

  /* ---------- 特效 API ---------- */
  const API = {
    get t() { return Game.time; },
    get dt() { return Game.dt; },
    get player() { return Game.player; },
    get enemies() { return Game.enemies; },
    get projectiles() { return Game.bullets; },
    get mul() { return Game.player.stats; },
    spawnBullet(o) {
      if (Game.bullets.length > 1200) return null;
      const b = {
        x: o.x, y: o.y,
        vx: o.vx || 0, vy: o.vy || 0,
        dmg: o.dmg || 10,
        r: o.r || 3,
        life: o.life == null ? 1.2 : o.life,
        maxLife: o.life == null ? 1.2 : o.life,
        pierce: o.pierce == null ? 0 : o.pierce,
        color: o.color || '#8fd4f0',
        art: o.art || null,
        trail: o.trail !== false,
        homing: o.homing || 0,
        target: o.target || null,
        knock: o.knock || 0,
        hit: new Set(),
        rot: o.rot || 0,
        spin: o.spin || 0,
        scale: o.scale || 1,
        len: o.len || 0,
        kind: o.kind || 'orb',
        onHit: o.onHit || null,
        onDie: o.onDie || null,
        owner: o.owner || null,
        wobble: o.wobble || 0,
        t: 0,
        fromPlayer: o.fromPlayer !== false,
        accel: o.accel || 0,
        turn: o.turn || 0,
      };
      Game.bullets.push(b);
      return b;
    },
    spawnEnemy(id, x, y, opt) { return spawnEnemy(id, x, y, opt); },
    explode(x, y, radius, dmg, opt) {
      const o = opt || {};
      ringFx(x, y, radius, o.color || '#ff9a3c', 0.4, 3);
      burst(x, y, 10, { color: [o.color || '#ff9a3c', '#ffc84a', '#ffffff'], speed: radius * 2.2, life: 0.45, glow: true });
      Cam.kick(o.shake == null ? 3 : o.shake, 0.2);
      if (o.sfx !== false && G.AUDIO) G.AUDIO.sfx('explode');
      nearEnemies(x, y, radius + 12, (e) => {
        if (G.dist(x, y, e.x, e.y) <= radius + e.r) {
          damageEnemy(e, dmg, { knock: o.knock || 0, fromX: x, fromY: y });
          if (o.slow) e.slow = Math.max(e.slow, o.slow);
        }
      });
      return true;
    },
    ring(x, y, radius, color, life) { ringFx(x, y, radius, color, life); },
    slash(x, y, ang, len, width, color, life) { slashFx(x, y, ang, len, width, color, life); },
    particle(x, y, o) { particle(x, y, o); },
    burst(x, y, n, o) { burst(x, y, n, o); },
    damage(e, amount, opts) { return damageEnemy(e, amount, opts); },
    heal(n) {
      const p = Game.player;
      const before = p.hp;
      p.hp = Math.min(p.maxHp, p.hp + n);
      if (p.hp > before) {
        floatText(p.x, p.y - 12, '+' + Math.round(n), '#6ee7a0', 9);
        if (G.AUDIO) G.AUDIO.sfx('heal');
      }
    },
    shake(v) { Cam.kick(v, 0.2); },
    hitstop(s) { Game.hitstopT = Math.max(Game.hitstopT, s); },
    flash(x, y, r, color) {
      Game.effects.push({ kind: 'flash', x, y, r, color: color || '#fff', life: 0.18, max: 0.18 });
    },
    sfx(n) { if (G.AUDIO) G.AUDIO.sfx(n); },
    text(x, y, str, color) { floatText(x, y, str, color || '#fff'); },
    nearestEnemy(x, y, maxDist) {
      let best = null, bd = maxDist == null ? 1e9 : maxDist;
      const es = Game.enemies;
      for (let i = 0; i < es.length; i++) {
        const e = es[i];
        if (e.dead) continue;
        const d = (e.x - x) * (e.x - x) + (e.y - y) * (e.y - y);
        if (d < bd) { bd = d; best = e; }
      }
      return best;
    },
    randomEnemyInRange(x, y, range) {
      const arr = API.enemiesInRange(x, y, range);
      return arr.length ? G.pick(arr) : null;
    },
    enemiesInRange(x, y, range) {
      const out = [];
      const r2 = range * range;
      nearEnemies(x, y, range, (e) => {
        if (e.dead) return;
        const dx = e.x - x, dy = e.y - y;
        if (dx * dx + dy * dy <= r2) out.push(e);
      });
      return out;
    },
    setBuff(key, value, seconds) {
      const p = Game.player;
      p.buffs[key] = Math.max(p.buffs[key] || 0, seconds);
      p.buffs[key + '_v'] = value;
    },
    rnd(a, b) { return G.rand(a, b); },
    rndi(a, b) { return G.randi(a, b); },
    pick(a) { return G.pick(a); },
    addWeapon(id) { return addWeapon(id); },
    addPassive(id) { return addPassive(id); },
    toast(s) { toast(s); },
    get weapons() { return Game.player.weapons; },
    get passives() { return Game.player.passives; },
  };
  G.api = API;

  /* ============ 开局 ============ */
  function startRun(charIdx) {
    const ch = CHARS[charIdx] || CHARS[0];
    Game.state = 'playing';
    Game.time = 0;
    Game.kills = 0;
    Game.coinsRun = 0;
    Game.enemies.length = 0;
    Game.bullets.length = 0;
    Game.pickups.length = 0;
    Game.particles.length = 0;
    Game.effects.length = 0;
    Game.texts.length = 0;
    Game.hazards.length = 0;
    Game.orbs.length = 0;
    Game.spawnTimer = 0.4;
    Game.bossIndex = 0;
    Game.bossTimer = 150;
    Game.levelUpQueue = 0;
    Game.over = false;
    Game.win = false;
    Game.hitTaken = false;
    Game.rerolls = 1;
    Game.paused = false;
    Game.stat = { dmg: 0 };
    Game.bossKilled = 0;
    Game.save.runs++;
    persist();
    const p = makePlayer(ch);
    Game.player = p;
    recomputeStats();
    addWeapon(ch.weapon);
    Cam.x = p.x; Cam.y = p.y;
    toast(ch.name + ' · 下潜开始', 2.4);
    if (G.AUDIO) { G.AUDIO.init(); G.AUDIO.music(1); }
  }
  Game.startRun = startRun;

  /* ============ 升级 ============ */
  function xpForLevel(lv) { return Math.round(6 + (lv - 1) * 5.5 + Math.pow(lv, 1.45) * 0.8); }

  function gainXp(n) {
    const p = Game.player;
    p.xp += n;
    while (p.xp >= p.xpNext) {
      p.xp -= p.xpNext;
      p.level++;
      p.xpNext = xpForLevel(p.level);
      Game.levelUpQueue++;
      if (p.level === 20) unlockAch('a_lv20');
      if (p.level === 40) unlockAch('a_lv40');
    }
    if (Game.levelUpQueue > 0 && Game.state === 'playing') openLevelUp();
  }

  function buildCards() {
    const p = Game.player;
    const pool = [];
    // 武器
    for (const w of p.weapons) {
      const def = w.def;
      // 进化
      if (def.evo && w.lv >= (def.maxLv || 8)) {
        const need = p.passives.find((x) => x.id === def.evo.need);
        const nd = G.PASSIVES.find((x) => x.id === def.evo.need);
        if (need && nd && need.lv >= (nd.maxLv || 5)) {
          const evoDef = G.WEAPONS.find((x) => x.id === def.evo.with);
          if (evoDef && !p.weapons.find((x) => x.id === evoDef.id)) {
            pool.push({ kind: 'evo', id: evoDef.id, w: w, weight: 100, rarity: 3 });
          }
        }
      }
      if (w.lv < (def.maxLv || 8) && !def.evoBase) {
        pool.push({ kind: 'wlv', id: def.id, weight: 10 + (def.rarity === 3 ? -4 : def.rarity === 2 ? -1 : 2), rarity: def.rarity || 1 });
      }
    }
    // 新武器
    if (p.weapons.length < MAX_WEAPONS) {
      for (const def of G.WEAPONS) {
        if (def.evoBase) continue;
        if (p.weapons.find((x) => x.id === def.id)) continue;
        pool.push({ kind: 'wnew', id: def.id, weight: 9 + (def.rarity === 1 ? 3 : def.rarity === 2 ? 0 : -6), rarity: def.rarity || 1 });
      }
    }
    // 被动
    for (const ps of p.passives) {
      const def = G.PASSIVES.find((x) => x.id === ps.id);
      if (def && ps.lv < (def.maxLv || 5)) pool.push({ kind: 'plv', id: def.id, weight: 10, rarity: def.rarity || 1 });
    }
    if (p.passives.length < MAX_PASSIVES) {
      for (const def of G.PASSIVES) {
        if (p.passives.find((x) => x.id === def.id)) continue;
        pool.push({ kind: 'pnew', id: def.id, weight: 9, rarity: def.rarity || 1 });
      }
    }
    // 稀有兜底
    if (!pool.length) {
      pool.push({ kind: 'heal', id: 'heal', weight: 1, rarity: 1 });
      pool.push({ kind: 'coin', id: 'coin', weight: 1, rarity: 1 });
    }
    // 加权抽
    const luck = p.stats.luck;
    const picks = [];
    const used = new Set();
    const tryPick = (bonusRare) => {
      let total = 0;
      const cand = pool.filter((c) => !used.has(c.kind + c.id));
      if (!cand.length) return null;
      for (const c of cand) {
        let w = Math.max(1, c.weight);
        if (bonusRare && c.rarity >= 2) w *= 1 + bonusRare;
        total += w;
      }
      let r = Math.random() * total;
      for (const c of cand) {
        let w = Math.max(1, c.weight);
        if (bonusRare && c.rarity >= 2) w *= 1 + bonusRare;
        r -= w;
        if (r <= 0) return c;
      }
      return cand[cand.length - 1];
    };
    for (let i = 0; i < 3; i++) {
      const c = tryPick(i === 0 ? 0 : luck);
      if (!c) break;
      used.add(c.kind + c.id);
      picks.push(c);
    }
    return picks;
  }

  function openLevelUp() {
    Game.state = 'levelup';
    Game.cards = buildCards();
    Game.cardSel = 0;
    if (G.AUDIO) G.AUDIO.sfx('levelup');
    Cam.kick(1.5, 0.15);
  }
  Game.openLevelUp = openLevelUp;

  function takeCard(c) {
    const p = Game.player;
    if (!c) return;
    if (c.kind === 'wlv') {
      const w = p.weapons.find((x) => x.id === c.id);
      if (w) { w.lv++; toast(w.def.name + ' Lv' + w.lv); }
    } else if (c.kind === 'wnew') {
      addWeapon(c.id);
      const def = G.WEAPONS.find((x) => x.id === c.id);
      toast('获得武器：' + (def ? def.name : ''));
      if (p.weapons.length >= MAX_WEAPONS) unlockAch('a_allW');
    } else if (c.kind === 'plv') {
      const w = p.passives.find((x) => x.id === c.id);
      if (w) { w.lv++; toast(w.def.name + ' Lv' + w.lv); }
    } else if (c.kind === 'pnew') {
      addPassive(c.id);
      const def = G.PASSIVES.find((x) => x.id === c.id);
      toast('获得：' + (def ? def.name : ''));
    } else if (c.kind === 'evo') {
      const base = c.w;
      const idx = p.weapons.indexOf(base);
      const evoDef = G.WEAPONS.find((x) => x.id === c.id);
      if (idx >= 0 && evoDef) {
        p.weapons[idx] = { id: evoDef.id, lv: 1, timer: 0, def: evoDef };
        toast('进化！' + evoDef.name);
        Cam.kick(6, 0.5);
        ringFx(p.x, p.y, 90, '#ffc84a', 0.7, 3);
        unlockAch('a_evo');
        if (G.AUDIO) G.AUDIO.sfx('evolve');
      }
    } else if (c.kind === 'heal') {
      API.heal(p.maxHp * 0.35);
    } else if (c.kind === 'coin') {
      Game.coinsRun += 25;
    }
    recomputeStats();
    Game.levelUpQueue--;
    if (Game.levelUpQueue > 0) {
      Game.cards = buildCards();
      Game.cardSel = 0;
      Game.state = 'levelup';
    } else {
      Game.state = 'playing';
    }
  }
  Game.takeCard = takeCard;

  /* ============ 敌人 AI 更新 ============ */
  function updateEnemies(dt) {
    const p = Game.player;
    const es = Game.enemies;
    for (let i = es.length - 1; i >= 0; i--) {
      const e = es[i];
      if (e.dead) { es.splice(i, 1); continue; }
      e.t += dt;
      if (e.flash > 0) e.flash -= dt;
      if (e.slow > 0) { e.slow -= dt; }
      if (e.freeze > 0) { e.freeze -= dt; continue; }
      // AI
      if (e.def.behavior) {
        try { e.def.behavior(e, API, dt); } catch (err) { }
      } else {
        const a = Math.atan2(p.y - e.y, p.x - e.x);
        e.vx = Math.cos(a) * e.speed;
        e.vy = Math.sin(a) * e.speed;
      }
      const slowK = e.slow > 0 ? 0.45 : 1;
      // 物理
      e.x += e.vx * dt * slowK;
      e.y += e.vy * dt * slowK;
      e.vx *= 0.92; e.vy *= 0.92;
      if (e.vx !== 0) e.facing = e.vx > 0 ? 1 : -1;
      // 分离（避免重叠成一坨）
      if (!e.boss) {
        nearEnemies(e.x, e.y, e.r * 2, (o) => {
          if (o === e || o.boss) return;
          const dx = e.x - o.x, dy = e.y - o.y;
          const d2 = dx * dx + dy * dy;
          const rr = (e.r + o.r) * 0.85;
          if (d2 > 0.01 && d2 < rr * rr) {
            const d = Math.sqrt(d2);
            const push = (rr - d) / d * 0.5;
            e.x += dx * push * 0.5;
            e.y += dy * push * 0.5;
          }
        });
      }
      // 撞玩家
      const dx = p.x - e.x, dy = p.y - e.y;
      if (dx * dx + dy * dy < (e.r + p.r) * (e.r + p.r)) {
        hurtPlayer(e.dmg, e);
      }
      // 太远就回收
      if (G.dist(e.x, e.y, p.x, p.y) > 1400) { es.splice(i, 1); }
    }
  }

  /* ============ 受伤 ============ */
  function hurtPlayer(amount, src) {
    const p = Game.player;
    if (p.invuln > 0) return false;
    if (p.buffs.invuln > 0) return false;
    const dmg = Math.max(1, amount * (1 - (p.stats.armor || 0)));
    p.hp -= dmg;
    p.hurtT = 0.28;
    p.invuln = 0.75;
    Game.hitTaken = true;
    Cam.kick(5, 0.25);
    Game.hitstopT = Math.max(Game.hitstopT, 0.05);
    if (G.AUDIO) G.AUDIO.sfx('hurt');
    floatText(p.x, p.y - 14, '-' + Math.round(dmg), '#ff5a6e', 10);
    burst(p.x, p.y, 8, { color: ['#ff5a6e', '#b02a45'], speed: 90, life: 0.4 });
    if (p.hp <= 0) {
      p.hp = 0;
      die();
    }
    return true;
  }
  Game.hurtPlayer = hurtPlayer;

  function die() {
    Game.state = 'dead';
    Game.over = true;
    Cam.kick(10, 0.8);
    if (G.AUDIO) G.AUDIO.sfx('death');
    finishRun(false);
  }

  function finishRun(won) {
    Game.win = won;
    const s = Game.save;
    const coins = Math.floor(Game.kills * 0.35 + Game.time * 0.6 + Game.coinsRun);
    Game.coinsRun = coins;
    s.coins += coins;
    s.totalCoins += coins;
    s.kills += Game.kills;
    if (Game.time > s.best.time) s.best.time = Game.time;
    if (Game.kills > s.best.kills) s.best.kills = Game.kills;
    if (Game.player.level > s.best.level) s.best.level = Game.player.level;
    if (s.totalCoins >= 5000) unlockAch('a_coin');
    unlockAch('a_first');
    if (!Game.hitTaken && Game.time >= 180) unlockAch('a_noHit');
    persist();
  }

  /* ============ 拾取 ============ */
  function updatePickups(dt) {
    const p = Game.player;
    const magnet = 44 * p.stats.magnet;
    for (let i = Game.pickups.length - 1; i >= 0; i--) {
      const it = Game.pickups[i];
      it.t += dt;
      const dx = p.x - it.x, dy = p.y - it.y;
      const d = Math.hypot(dx, dy);
      if (d < magnet && it.type !== 'chest') {
        const pull = Math.min(420, 200 + (magnet - d) * 7);
        it.x += (dx / (d || 1)) * pull * dt;
        it.y += (dy / (d || 1)) * pull * dt;
      } else {
        it.x += it.vx * dt; it.y += it.vy * dt;
        it.vx *= 0.9; it.vy *= 0.9;
      }
      if (d < p.r + 8) {
        Game.pickups.splice(i, 1);
        if (it.type === 'gem') {
          gainXp(it.value * p.stats.xpGain);
          if (G.AUDIO) G.AUDIO.sfx('gem');
          burst(it.x, it.y, 2, { color: ['#8fd4f0', '#cdf1ff'], speed: 40, life: 0.25 });
        } else if (it.type === 'coin') {
          Game.coinsRun += it.value;
          if (G.AUDIO) G.AUDIO.sfx('pickup');
        } else if (it.type === 'heart') {
          API.heal(it.value * 15);
        } else if (it.type === 'chest') {
          openChest();
        }
      }
    }
  }

  function openChest() {
    if (G.AUDIO) G.AUDIO.sfx('chest');
    const r = Math.random() + Game.player.stats.luck * 0.5;
    if (r > 0.75) {
      // 进化或满级武器
      const p = Game.player;
      const cand = p.weapons.filter((w) => {
        const def = w.def;
        if (!def.evo || w.lv < (def.maxLv || 8)) return false;
        const need = p.passives.find((x) => x.id === def.evo.need);
        const nd = G.PASSIVES.find((x) => x.id === def.evo.need);
        return need && nd && need.lv >= (nd.maxLv || 5);
      });
      if (cand.length) {
        const w = G.pick(cand);
        const evoDef = G.WEAPONS.find((x) => x.id === w.def.evo.with);
        const idx = p.weapons.indexOf(w);
        if (evoDef && idx >= 0) {
          p.weapons[idx] = { id: evoDef.id, lv: 1, timer: 0, def: evoDef };
          toast('宝箱进化！' + evoDef.name);
          unlockAch('a_evo');
          ringFx(p.x, p.y, 110, '#ffc84a', 0.8, 3);
          if (G.AUDIO) G.AUDIO.sfx('evolve');
          return;
        }
      }
    }
    // 普通：给一堆金币 + 经验 + 随机一件
    const p = Game.player;
    for (let i = 0; i < 8; i++) dropPickup('gem', p.x + G.rand(-20, 20), p.y + G.rand(-20, 20), 5);
    Game.coinsRun += 15;
    // 随机升级一件
    const pool = [];
    for (const w of p.weapons) if (w.lv < (w.def.maxLv || 8)) pool.push({ t: 'w', o: w });
    for (const ps of p.passives) if (ps.lv < (ps.def.maxLv || 5)) pool.push({ t: 'p', o: ps });
    if (pool.length) {
      const c = G.pick(pool);
      c.o.lv++;
      toast('宝箱：' + (c.t === 'w' ? c.o.def.name : c.o.def.name) + ' Lv' + c.o.lv);
      recomputeStats();
    } else {
      Game.coinsRun += 40;
    }
  }
  Game.openChest = openChest;

  /* ============ 子弹 ============ */
  function updateBullets(dt) {
    const bs = Game.bullets;
    for (let i = bs.length - 1; i >= 0; i--) {
      const b = bs[i];
      b.t += dt;
      b.life -= dt;
      if (b.life <= 0) {
        if (b.onDie) { try { b.onDie(b, API); } catch (e) { } }
        bs.splice(i, 1);
        continue;
      }
      if (b.homing > 0) {
        let target = b.target;
        if (!target || target.dead) target = API.nearestEnemy(b.x, b.y, 260);
        b.target = target;
        if (target) {
          const want = Math.atan2(target.y - b.y, target.x - b.x);
          const cur = Math.atan2(b.vy, b.vx);
          const diff = G.wrapAngle(want - cur);
          const na = cur + G.clamp(diff, -b.homing * dt, b.homing * dt);
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(na) * sp;
          b.vy = Math.sin(na) * sp;
        }
      }
      if (b.accel) {
        const sp = Math.hypot(b.vx, b.vy) || 1;
        b.vx += (b.vx / sp) * b.accel * dt;
        b.vy += (b.vy / sp) * b.accel * dt;
      }
      if (b.wobble) {
        const perp = Math.atan2(b.vy, b.vx) + Math.PI / 2;
        const w = Math.sin(b.t * 18) * b.wobble;
        b.x += Math.cos(perp) * w * dt * 60;
        b.y += Math.sin(perp) * w * dt * 60;
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.spin) b.rot += b.spin * dt;
      if (b.trail && b.t > 0.02 && Math.random() < 0.55) {
        particle(b.x, b.y, { vx: G.rand(-8, 8), vy: G.rand(-8, 8), life: 0.22, color: b.color, r: 1 });
      }
      // 命中
      let hitAny = false;
      nearEnemies(b.x, b.y, b.r + 20, (e) => {
        if (e.dead || b.hit.has(e)) return;
        const rr = b.r + e.r;
        if ((e.x - b.x) ** 2 + (e.y - b.y) ** 2 <= rr * rr) {
          b.hit.add(e);
          hitAny = true;
          damageEnemy(e, b.dmg, { knock: b.knock, fromX: b.x, fromY: b.y, crit: false });
          if (b.onHit) { try { b.onHit(b, e, API); } catch (err) { } }
          burst(b.x, b.y, 3, { color: [b.color, '#ffffff'], speed: 55, life: 0.2 });
          return b.pierce-- > 0 ? undefined : false;
        }
      });
      if (hitAny && b.pierce < 0) {
        if (b.onDie) { try { b.onDie(b, API); } catch (e) { } }
        bs.splice(i, 1);
        continue;
      }
      if (Math.abs(b.x - Game.player.x) > 900 || Math.abs(b.y - Game.player.y) > 700) {
        bs.splice(i, 1);
      }
    }
  }

  /* ============ 武器驱动 ============ */
  function updateWeapons(dt) {
    const p = Game.player;
    const cdMul = p.stats.cd;
    for (const w of p.weapons) {
      const def = w.def;
      const lv = getWeaponLevelEntry(w);
      const cd = (lv.cd || 1) * cdMul;
      w.timer -= dt;
      if (w.timer <= 0) {
        w.timer += Math.max(0.05, cd);
        if (w.timer < 0) w.timer = Math.max(0.05, cd);
        if (def.fire) { try { def.fire(w, lv, API); } catch (e) { console.warn('武器 ' + def.id + ' 开火挂了', e); } }
      }
      if (def.tick) { try { def.tick(w, lv, API, dt); } catch (e) { } }
    }
  }

  /* ============ 生成 ============ */
  function spawnRadius() { return Math.max(G.W, G.H) * 0.62 + 40; }

  function spawnPoint() {
    const a = Math.random() * Math.PI * 2;
    const r = spawnRadius() * (0.9 + Math.random() * 0.35);
    return { x: Game.player.x + Math.cos(a) * r, y: Game.player.y + Math.sin(a) * r * 0.8 };
  }

  function pickEnemyForTime() {
    const mins = Game.time / 60;
    const pool = G.ENEMIES.filter((e) => e.tier < 3 && (e.minWave || 0) <= mins);
    if (!pool.length) return G.ENEMIES[0];
    let total = 0;
    for (const e of pool) total += e.weight || 5;
    let r = Math.random() * total;
    for (const e of pool) { r -= (e.weight || 5); if (r <= 0) return e; }
    return pool[pool.length - 1];
  }

  function doSpawn(dt) {
    const t = Game.time;
    const maxAlive = Math.min(240, 50 + t / 6);
    if (Game.enemies.length >= maxAlive) return;
    Game.spawnTimer -= dt;
    if (Game.spawnTimer > 0) return;
    const rate = 1.1 + t / 80;
    Game.spawnTimer = 1 / rate;
    const batch = 1 + Math.floor(t / 90);
    for (let i = 0; i < batch && Game.enemies.length < maxAlive; i++) {
      const def = pickEnemyForTime();
      const pt = spawnPoint();
      const elite = t > 120 && G.chance(0.035 + t / 90000);
      spawnEnemy(def.id, pt.x, pt.y, { elite });
    }
  }

  const BOSS_ORDER = ['boss_angler', 'boss_queen', 'boss_whale'];
  function doBoss(dt) {
    if (Game.time < Game.bossTimer) return;
    const id = BOSS_ORDER[Game.bossIndex % BOSS_ORDER.length];
    Game.bossIndex++;
    Game.bossTimer += 150;
    const ang = Math.random() * Math.PI * 2;
    const r = spawnRadius();
    const e = spawnEnemy(id, Game.player.x + Math.cos(ang) * r, Game.player.y + Math.sin(ang) * r * 0.8, { elite: false, noScale: false });
    if (e) {
      const mul = 1 + (Game.bossIndex - 1) * 0.55;
      e.hp *= mul; e.maxHp = e.hp; e.dmg *= 1 + (Game.bossIndex - 1) * 0.2;
      toast('★ ' + (e.def.name || 'Boss') + ' 出现！', 3);
      Cam.kick(7, 0.7);
      if (G.AUDIO) G.AUDIO.sfx('boss');
    }
  }

  /* ============ 特效更新 ============ */
  function updateFx(dt) {
    for (let i = Game.particles.length - 1; i >= 0; i--) {
      const pt = Game.particles[i];
      pt.life -= dt;
      if (pt.life <= 0) { Game.particles.splice(i, 1); continue; }
      pt.x += pt.vx * dt; pt.y += pt.vy * dt;
      pt.vx *= pt.drag; pt.vy *= pt.drag;
      pt.vy += pt.grav * dt;
    }
    for (let i = Game.effects.length - 1; i >= 0; i--) {
      const fx = Game.effects[i];
      fx.life -= dt;
      if (fx.life <= 0) Game.effects.splice(i, 1);
    }
    for (let i = Game.texts.length - 1; i >= 0; i--) {
      const tx = Game.texts[i];
      tx.life -= dt;
      tx.y += tx.vy * dt;
      tx.vy *= 0.94;
      if (tx.life <= 0) Game.texts.splice(i, 1);
    }
    for (let i = Game.hazards.length - 1; i >= 0; i--) {
      const h = Game.hazards[i];
      h.life -= dt;
      h.t += dt;
      if (h.tick) {
        h.tickT = (h.tickT || 0) - dt;
        if (h.tickT <= 0) {
          h.tickT = h.interval || 0.4;
          nearEnemies(h.x, h.y, h.r + 10, (e) => {
            if (G.dist(h.x, h.y, e.x, e.y) <= h.r + e.r) {
              damageEnemy(e, h.dmg, {});
              if (h.slow) e.slow = Math.max(e.slow, h.slow);
            }
          });
        }
      }
      if (h.life <= 0) Game.hazards.splice(i, 1);
    }
  }

  /* ============ 每帧 ============ */
  function updatePlaying(dt) {
    const p = Game.player;
    Game.time += dt;
    p.invuln = Math.max(0, p.invuln - dt);
    p.hurtT = Math.max(0, p.hurtT - dt);
    p.animT += dt;
    for (const k in p.buffs) {
      if (k.endsWith('_v')) continue;
      p.buffs[k] -= dt;
      if (p.buffs[k] <= 0) { delete p.buffs[k]; delete p.buffs[k + '_v']; }
    }
    // 移动
    const mv = G.moveVec();
    const sp = p.speed * (p.buffs.speed ? 1 + (p.buffs.speed_v || 0) : 1);
    p.vx = mv.x * sp;
    p.vy = mv.y * sp;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (mv.x !== 0) p.facing = mv.x > 0 ? 1 : -1;
    // 回血
    if (p.stats.regen > 0) {
      p.regenT += dt;
      if (p.regenT >= 1) { p.regenT -= 1; if (p.hp < p.maxHp) p.hp = Math.min(p.maxHp, p.hp + p.stats.regen * 0.35); }
    }
    // 相机
    const lookAhead = 18;
    Cam.follow(p.x + mv.x * lookAhead, p.y + mv.y * lookAhead, dt, 0.16);

    buildGrid();
    updateWeapons(dt);
    updateEnemies(dt);
    updateBullets(dt);
    updatePickups(dt);
    updateFx(dt);
    doSpawn(dt);
    doBoss(dt);
    // 关卡推进
    const stage = Game.time < 300 ? 1 : Game.time < 600 ? 2 : 3;
    if (stage !== Game.lastStage) {
      Game.lastStage = stage;
      if (G.AUDIO) G.AUDIO.music(stage);
      toast(stage === 2 ? '—— 沉入更深处 ——' : '—— 深渊之心 ——', 2.5);
    }
    if (Game.time >= RUN_TIME) {
      Game.state = 'win';
      finishRun(true);
      unlockAch('a_win');
      if (G.AUDIO) G.AUDIO.sfx('evolve');
    }
  }

  /* ============ 主循环 ============ */
  let lastT = 0;
  let accum = 0;
  const STEP = 1 / 60;

  function frame(now) {
    requestAnimationFrame(frame);
    if (!lastT) lastT = now;
    let dt = (now - lastT) / 1000;
    lastT = now;
    if (dt > 0.25) dt = 0.25;

    G.pollGamepad();
    Game.frame++;

    if (Game.state === 'playing' && !Game.paused) {
      if (Game.hitstopT > 0) {
        Game.hitstopT -= dt;
        dt *= 0.08;
      }
      accum += dt;
      let guard = 0;
      while (accum >= STEP && guard++ < 5) {
        Game.dt = STEP;
        updatePlaying(STEP);
        accum -= STEP;
        if (Game.state !== 'playing') { accum = 0; break; }
      }
    } else {
      // 非游戏状态也让特效动一动
      Game.dt = dt;
      if (Game.msgT > 0) Game.msgT -= dt;
      if (Game.state !== 'playing') updateFx(dt * 0.6);
    }
    if (Game.msgT > 0) Game.msgT -= dt * (Game.state === 'playing' ? 1 : 1);

    Cam.update(Game.dt);
    if (G.UI) G.UI.frame(dt);
    G.endFrameInput();
  }

  /* ============ 启动 ============ */
  function boot() {
    G.initCanvas();
    G.setupInput();
    loadGame();
    G.bakeArt();
    if (G.AUDIO) { try { G.AUDIO.ready = false; } catch (e) { } }
    // 地面纹理
    if (G.UI && G.UI.buildFloor) G.UI.buildFloor();
    requestAnimationFrame(frame);
    // 首次交互后初始化音频
    const once = () => {
      if (G.AUDIO) { try { G.AUDIO.init(); } catch (e) { } }
      window.removeEventListener('pointerdown', once);
      window.removeEventListener('keydown', once);
    };
    window.addEventListener('pointerdown', once);
    window.addEventListener('keydown', once);
  }

  G.boot = boot;
  Game.startRun = startRun;
  Game.updatePlaying = updatePlaying;

  /* 供 UI 用的计算属性 */
  Game.xpForLevel = xpForLevel;
  Game.retryCards = buildCards;
  Game.MAX_WEAPONS = MAX_WEAPONS;
  Game.MAX_PASSIVES = MAX_PASSIVES;
  Game.RUN_TIME = RUN_TIME;
  Game.persist = persist;
  Game.CHARS = CHARS;
  Game.defaultSave = defaultSave;
  Game.loadGame = loadGame;

  window.addEventListener('load', () => setTimeout(boot, 30));
})();
