/**
 * 【2026-11-01 主人：办事模式不再新开临时智能体，改成调动屋里的人】
 *
 * 规则逐条落成代码：
 *   ① 主智能体 = 屋里排序第一个「已启用」的卡（主流程用 mainAgentId 算好了传进来）。
 *   ② 派活时优先找屋里**除主智能体之外**的人来做。
 *   ③ 找到了但没启用 → 自动启用她。
 *   ④ 屋里没有别人（只剩主智能体一个）→ 自动拉一个进来：
 *        · 主声是小鱼   → 拉小鲸
 *        · 主声是小鲸   → 拉小鱼
 *        · 主声是自建卡 → 拉小鱼
 *      拉进来之后就是「屋里有别人了」，再把活派给她。
 *
 * 为什么不做「新建一个临时 worker」：主人要的是「屋里的智能体都是独立个体、
 * 都能独立干活」，临时 worker 是凭空捏出来的第四种东西，不在屋里、不在名单上、
 * 关了界面就没了。改成用屋里的人，派活才跟「屋里的人」这张名单是一回事。
 */
import {
  AGENT_XIAOYU,
  AGENT_XIAOJING,
  getAgent,
  groupAgentIds,
  isGroupMemberEnabled,
  setGroupMemberEnabled,
  setSessionGroup,
} from './agents.mjs';

/** 主声不是小鱼时该拉谁进屋里补位 */
function whoToPull(mainId) {
  if (String(mainId) === AGENT_XIAOYU) return AGENT_XIAOJING;
  return AGENT_XIAOYU;
}

/**
 * 挑一个「屋里」的帮手来干这件活。
 *
 * @param {string} sessionId
 * @param {string} mainId 这屋的主智能体（排序第一个已启用的）
 * @returns {{id:string,name:string,enabled:boolean,added:boolean}|null}
 */
export function pickHelperForTask(sessionId, mainId = '') {
  const sid = String(sessionId || 'default');
  const main = String(mainId || '');

  let list = [];
  try { list = groupAgentIds(sid).map((x) => String(x)); } catch { list = []; }

  /* ② 屋里除主智能体之外的人，按名单顺序挑第一个 */
  const others = list.filter((id) => id !== main);
  if (others.length) {
    const pick = others[0];
    let on = false;
    try { on = isGroupMemberEnabled(pick, sid); } catch { on = true; }
    let name = pick;
    try { name = String(getAgent(pick)?.name || pick); } catch {}
    if (on) return { id: pick, name, enabled: true, added: false };

    /* ③ 没启用 → 自动启用，再派给她 */
    try { setGroupMemberEnabled(pick, sid, true); } catch {}
    return { id: pick, name, enabled: false, added: false };
  }

  /* ④ 屋里只剩主智能体一个 → 按规矩拉一个人进来 */
  const pull = whoToPull(main);
  let name = pull;
  try { name = String(getAgent(pull)?.name || pull); } catch {}
  try {
    setSessionGroup(sid, [...list, pull]);
    setGroupMemberEnabled(pull, sid, true);
  } catch {}
  return { id: pull, name, enabled: false, added: true };
}

export default { pickHelperForTask, whoToPull };
