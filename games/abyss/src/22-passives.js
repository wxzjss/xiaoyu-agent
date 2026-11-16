const G = window.G = window.G || {}; if(!G.PASSIVES) G.PASSIVES = [];
// 鲸落·深渊 — 被动道具表（12 个，id 见 IDS.md 第三节）
//
// 引擎怎么调：40-game.js 的 recomputeStats() 每次都新建一个 m，然后
//   for (let i = 0; i < ps.lv; i++) def.apply({ mul: m, player: p }, ps.lv);
// 也就是 apply 被调 ps.lv 次、第二个参数恒等于最终等级。
// 所以普通被动一律「每次往上加一份」，Lv3 → 加 3 份。
// 唯独 p_amount 是「每 2 级 +1」，不是每级都加，它走下面的小状态记账。

/* ---------- 1. 鲸骨护符：伤害 +12%/级 ---------- */
G.PASSIVES.push({
  id: 'p_power',
  name: '鲸骨护符',
  desc: '伤害 +12%/级（满级 +60%）',
  icon: 'i_power',
  rarity: 1,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.dmg = (p.mul.dmg || 0) + 0.12; }
});

/* ---------- 2. 深海之息：范围 +10%/级 ---------- */
G.PASSIVES.push({
  id: 'p_area',
  name: '深海之息',
  desc: '范围 +10%/级（满级 +50%）',
  icon: 'i_area',
  rarity: 1,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.area = (p.mul.area || 0) + 0.10; }
});

/* ---------- 3. 尾鳍强化：移速 +8%/级 ---------- */
G.PASSIVES.push({
  id: 'p_speed',
  name: '尾鳍强化',
  desc: '移速 +8%/级（满级 +40%）',
  icon: 'i_speed',
  rarity: 1,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.moveSpeed = (p.mul.moveSpeed || 0) + 0.08; }
});

/* ---------- 4. 逆流：冷却 -8%/级 ---------- */
G.PASSIVES.push({
  id: 'p_cd',
  name: '逆流',
  desc: '冷却 -8%/级（满级 -40%，转得更快）',
  icon: 'i_cd',
  rarity: 1,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.cd = (p.mul.cd || 0) - 0.08; }
});

/* ---------- 5. 分叉之鳞：投射物数量 +1（每 2 级） ---------- */
// 这个不是「每级 +1」，所以不能傻加。apply 被连调 lv 次、每次都拿到同一个 lv，
// 干脆每次都按 lv 算出该给几颗，写成「底数 + 目标值」，连调多少次都是同一个结果。
// 底数按 m 对象记一次（引擎每次重算都换新 m，所以每次都会重新取底）。
const _amtBase = new WeakMap();
G.PASSIVES.push({
  id: 'p_amount',
  name: '分叉之鳞',
  desc: '投射物数量 +1（每 2 级 +1：Lv2 +1，Lv4 +2）',
  icon: 'i_amount',
  rarity: 3,
  maxLv: 4,
  apply(p, lv) {
    if (!p || !p.mul) return;
    const m = p.mul;
    let base = _amtBase.get(m);
    if (base === undefined) { base = m.amount || 0; _amtBase.set(m, base); }
    m.amount = base + Math.floor(lv / 2); // Lv1→+0 Lv2→+1 Lv3→+1 Lv4→+2
  }
});

/* ---------- 6. 长歌：持续时间 +15%/级 ---------- */
G.PASSIVES.push({
  id: 'p_duration',
  name: '长歌',
  desc: '持续时间 +15%/级（满级 +75%）',
  icon: 'i_duration',
  rarity: 2,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.duration = (p.mul.duration || 0) + 0.15; }
});

/* ---------- 7. 潮汐引力：拾取范围 +25%/级 ---------- */
G.PASSIVES.push({
  id: 'p_magnet',
  name: '潮汐引力',
  desc: '拾取范围 +25%/级（满级 +125%）',
  icon: 'i_magnet',
  rarity: 1,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.magnet = (p.mul.magnet || 0) + 0.25; }
});

/* ---------- 8. 厚脂：受到伤害 -6%/级 ---------- */
G.PASSIVES.push({
  id: 'p_armor',
  name: '厚脂',
  desc: '受到伤害 -6%/级（满级 -30%，引擎封顶 75%）',
  icon: 'i_armor',
  rarity: 2,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.armor = (p.mul.armor || 0) + 0.06; }
});

/* ---------- 9. 鲸息：每 8 秒回 1 血/级 ---------- */
// 每 8 秒 1 点 = 每秒 0.125，所以每级往 regen 加 0.125。
// 注意：40-game.js:1120 结算时会再乘 0.35（regen * 0.35 / 秒），
// 真按引擎跑实际回血比 IDS 慢约 3 倍，这里先按 mul 的定义（每秒回血）写。
G.PASSIVES.push({
  id: 'p_regen',
  name: '鲸息',
  desc: '每秒回血 +0.125（≈每 8 秒回 1 血/级，满级每 8 秒回 5 血）',
  icon: 'i_regen',
  rarity: 2,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.regen = (p.mul.regen || 0) + 0.125; }
});

/* ---------- 10. 深海恩泽：幸运 +8%/级 ---------- */
G.PASSIVES.push({
  id: 'p_luck',
  name: '深海恩泽',
  desc: '幸运 +8%/级（满级 +40%，影响暴击率与宝箱品质）',
  icon: 'i_luck',
  rarity: 2,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.luck = (p.mul.luck || 0) + 0.08; }
});

/* ---------- 11. 猎杀本能：暴击伤害 +20%/级 ---------- */
G.PASSIVES.push({
  id: 'p_crit',
  name: '猎杀本能',
  desc: '暴击伤害 +20%/级（满级 +100%）',
  icon: 'i_crit',
  rarity: 3,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.critDmg = (p.mul.critDmg || 0) + 0.20; }
});

/* ---------- 12. 知识之潮：经验获取 +10%/级 ---------- */
G.PASSIVES.push({
  id: 'p_pickup',
  name: '知识之潮',
  desc: '经验获取 +10%/级（满级 +50%）',
  icon: 'i_pickup',
  rarity: 1,
  maxLv: 5,
  apply(p, lv) { if (!p || !p.mul) return; p.mul.xpGain = (p.mul.xpGain || 0) + 0.10; }
});
