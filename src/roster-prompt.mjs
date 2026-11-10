/**
 * 屋里的人 · 给智能体看的「这一轮都有谁在」
 *
 * 【2026-11-03 主人问的】
 * 「旁白的人设里固定写了这个屋子里有三个女孩，那我要是只启用了小鱼与旁白，
 *   旁白是不是还会说小鲸做了什么、小白曦做了什么？智能体能看到【屋里的人】有哪些人吗？」
 *
 * 查过了：看不到。程序从来没有把「这个会话坐着谁」告诉过她，
 * 她只能从人设里那几句死板的描述去猜 —— 猜出来就是编。
 *
 * 这个模块补的就是这块料：按会话算出「现在真在的人」，拼成一小段给提示词用。
 *
 * 三条铁律（踩过才知道）：
 *   1. 判据必须跟界面左边「屋里的人」那一竖列完全同一套（server.mjs 的 members 接口）。
 *      两套判据 = 主人眼睛看到的和智能体以为的会不一样。
 *   2. 会话不存在就不给名单。agents.mjs 的 cleanGroup 有个「小鱼必须在这屋里」的兜底，
 *      连不存在的会话都会返回 [xiaoyu] —— 照抄就会告诉智能体「小鱼在场」。
 *   3. 拿不到就返回空串，提示词一个字都不多。宁可不说，不许说错。
 */
import { loadSession } from './sessions-core.mjs';
import { groupAgentIds, groupEnabledMap, listAgents } from './agents.mjs';
import { fishOn } from './fish-presence.mjs';
import { whaleOn } from './whale-presence.mjs';

const AGENT_XIAOYU = 'xiaoyu';
const AGENT_XIAOJING = 'xiaojing';

/** 这张牌这一轮说得出话吗（判据与 server.mjs 的 members 接口一致） */
function onOf(id, qsid) {
  if (id === AGENT_XIAOYU) {
    try { return fishOn(qsid); } catch { return true; }
  }
  if (id === AGENT_XIAOJING) {
    try { return whaleOn(qsid); } catch { return true; }
  }
  // 自建卡：只认「屋里的人」那颗牌
  try {
    const m = groupEnabledMap(qsid) || {};
    return m[id] !== false;
  } catch {
    return true;
  }
}

/**
 * 这个会话里都有谁。
 * @returns {Array<{id:string,name:string,on:boolean}>}  会话不存在 -> []
 */
export function rosterOf(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return [];
  // 会话不存在就别编名单（见上面第 2 条铁律）
  let sess = null;
  try { sess = loadSession(sid); } catch { return []; }
  if (!sess) return [];

  let ids = [];
  try { ids = groupAgentIds(sid) || []; } catch { return []; }
  if (!ids.length) return [];

  const cards = new Map();
  try {
    for (const a of listAgents()) cards.set(String(a.id), a);
  } catch { /* 拿不到卡片就只报 id */ }

  const out = [];
  const seen = new Set();
  for (const raw of ids) {
    const id = String(raw || '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const card = cards.get(id);
    out.push({
      id,
      name: card ? String(card.name || id) : id,
      on: onOf(id, sid),
    });
  }
  return out;
}

/** 把名单拼成一段提示词。没有会话 / 全都不在 -> 空串 */
export function rosterPrompt(sessionId, { selfName = '' } = {}) {
  const list = rosterOf(sessionId);
  if (!list.length) return '';

  // 自己就是自己，不用在名单里念一遍
  const me = String(selfName || '').trim();
  const others = list.filter((p) => !me || p.name !== me);

  const here = list.filter((p) => p.on).map((p) => p.name);
  const gone = list.filter((p) => !p.on).map((p) => p.name);

  // 一个都没在（理论上不会）就别写「没人」这种容易被误读的话
  if (!here.length) return '';

  const lines = ['【屋里现在有谁】'];
  lines.push(here.map((n) => '- ' + n).join('\n'));

  if (gone.length) {
    lines.push('');
    lines.push('【这一轮不在场的】' + gone.join('、'));
    lines.push('这些人这一轮不在。不要替她们写动作、不要替她们说话、不要写她们做了什么 —— 你没看见她们。');
  }

  lines.push('');
  lines.push('这份名单是这一刻的真实情况，以它为准。人设里提到的名字要是没出现在上面，就当没来。');
  if (others.length) {
    lines.push('名单里没写的人，这一轮就是不在。别自己补人。');
  }
  return lines.join('\n');
}
