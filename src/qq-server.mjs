/**
 * 【QQ小鱼】服务端这一侧 —— 把 QQ 收到的那句话跑成一轮真对话。
 *
 * ── 分工（为什么拆成三个文件）────────────────────────────────
 *
 *   src/qq.mjs        只管存：凭据、接哪个会话、认人表、「这是我」的口令
 *   src/qq-bridge.mjs 只管连：起 QQ 客户端、收消息、切块回话（不碰会话存储）
 *   src/qq-server.mjs 就是这一份：把它俩接到本服务器身上 ——
 *                     给 qq-bridge 提供「建会话 / 跑一轮 / 记账」这三只手。
 *
 * 拆开的好处：qq.mjs 没有服务器也能跑（测试直接验存盘规则），
 * qq-bridge.mjs 没有真会话也能跑（给它三个假回调就能验收发流程）。
 *
 * ── 跑一轮为什么不复用 /api/chat ─────────────────────────────
 *
 * /api/chat 是「HTTP 请求进来 → 写 SSE 出去」，事件一路往 res 上写。
 * QQ 这边没有 HTTP 客户端在等，只有一根 WebSocket。所以这里走
 * **跟 /api/chat 同一条引擎**（runAgent）但换一根管子：事件推到 onEvent 回调。
 * 这跟「小鲸插话那条路」（server.mjs 的 startPeerTurn）是同一个思路，
 * 连「runAgent 会重建数组、所以 wire 必须浅拷贝、接回时按 seen 集合认」
 * 那些坑都一样 —— 下面的代码就是照着 startPeerTurn 抄的骨架，别自己另发明一套。
 */
import { repairHistory } from './agent.mjs';
import { setTurnSource, clearTurnSource } from './turn-source.mjs';

let H = null;

/**
 * 装好这一侧。server.mjs 在路由分发之前调一次。
 *
 * handles 要有：
 *   getSession(id) / saveSession(s) / publicSession(s)
 *   newSessionFor({ title, agentId }) → { id }
 *   runAgent / runWithToolContext / snapFor(sessionId)   ← 跑一轮要用的那几样
 *   inPersonaMode(session), sessionModeWord(session)
 *   fishOn(sid) / setFishOn(sid, on) / setIdentity(id, sid)
 *   isSessionId(v) / runningTurns(Map) / liveLogs(Map)
 */
export function mountQq(handles = {}) {
  H = handles;
  return true;
}

export function qqMounted() {
  return Boolean(H);
}

function need() {
  if (!H) {
    const err = new Error('QQ 这一侧没装好（服务器启动时没调 mountQq）');
    err.status = 500;
    throw err;
  }
  return H;
}

/**
 * 「给这个人找个会话」。
 *
 *   mode = 'shared'   → 所有 QQ 用户都进主人挑的那一个会话（一个屋里几个人）
 *   mode = 'per-user' → 每个 QQ 用户第一次说话就给他开一个自己的会话
 *
 * per-user 下新会话照主人的习惯起名「QQ · 名字」，智能体绑小鱼。
 */
/**
 * 拿群名。OneBot 的 get_group_info 要 group_id；拿不到就返回空，让上层用群号兜底。
 * 结果记在内存里 —— 群名不会天天改，没必要每句话都问一遍。
 */
const __groupNameCache = new Map();
export async function groupNameOf(groupId) {
  const gid = String(groupId || '').trim();
  if (!gid) return '';
  if (__groupNameCache.has(gid)) return __groupNameCache.get(gid);
  try {
    const { call } = await import('./qq-onebot.mjs');
    const r = await call('get_group_info', { group_id: Number(gid) || gid }, 8000);
    const nm = String(r?.data?.group_name ?? r?.group_name ?? '').trim();
    if (nm) { __groupNameCache.set(gid, nm); return nm; }
  } catch {}
  return '';
}

export async function ensureQqSession({ openid, peer, name = '', isGroup = false, groupId = '' } = {}) {
  const h = need();
  const { qqBind } = await import('./qq.mjs');
  const bind = qqBind();

  // ① 主人指定了「都进这一个」
  if (bind.mode === 'shared' && bind.sessionId) {
    if (h.getSession(bind.sessionId)) return { sessionId: bind.sessionId };
    // 挑的那个会话被删了：别悄悄开一个新的装作没事，直接说不能聊，让主人重选
    return null;
  }
  // ①' 主人选了「各聊各的」但认人表里这人还没会话 → 落到下面 ③ 现开一个
  if (bind.mode === 'per-user' && bind.sessionId === undefined) { /* 正常往下走 */ }
  // ② 这人已经有自己的会话了（重启后靠认人表恢复）
  if (peer && peer.sessionId) {
    if (h.getSession(peer.sessionId)) return { sessionId: peer.sessionId };
  }
  // ③ 现开一个
  // 【2026-10-30 主人要的】会话名分两种，别一律挂发话人昵称：
  //   群聊 → 「QQ群 · 群名」（拿不到群名就先叫群号）
  //   私聊 → 「QQ · 对方昵称」
  const title = isGroup
    ? `QQ群 · ${String(await groupNameOf(groupId) || groupId || '群聊').slice(0, 20)}`
    : `QQ · ${String(name || openid.slice(0, 6)).slice(0, 20)}`;
  const made = await h.newSessionFor({ title, agentId: 'xiaoyu' });
  if (!made || !made.id) return null;
  return { sessionId: made.id };
}

/**
 * 跑一轮。骨架照抄 startPeerTurn，改的只有两处：
 *   · 引子不是「信箱里有话」，而是 QQ 上这个人真说的那一句（play 成一条真 user 消息）
 *   · 事件推给 onEvent，不推给 SSE
 */
export async function runQqTurn({ sessionId, text, fromQq, onEvent, replyTarget, media } = {}) {
  const h = need();
  const id = String(sessionId || '');
  if (!h.isSessionId(id)) {
    const err = new Error('会话 id 不对');
    err.status = 400;
    throw err;
  }
  const session = h.getSession(id);
  if (!session) {
    const err = new Error('没有这个会话');
    err.status = 404;
    throw err;
  }

  // 这个会话正在跑（主人在界面里聊着）→ 排队等它，别两个 runAgent 抢一个数组
  for (let i = 0; i < 120; i++) {
    if (!h.runningTurns.get(id)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (h.runningTurns.get(id)) {
    const err = new Error('这个会话正在跑别的，等一下再发');
    err.status = 409;
    throw err;
  }

  const ac = new AbortController();
  const turn = { ac, done: null, qqTurn: true };
  h.runningTurns.set(id, turn);
  // 让界面也能看到 QQ 这边在说什么（主人那边手机/电脑同时看得到）
  const live = { sessionId: id, events: [], startedAt: Date.now(), done: false, source: 'qq' };
  try { h.liveLogs.set(id, live); } catch {}
  const emit = (ev) => {
    try {
      if (live.events.length < 5000) live.events.push(ev);
    } catch {}
    try { onEvent?.(ev); } catch {}
  };

  try {
    const history = session.messages;
    if (!Array.isArray(history)) throw new Error('这个会话的历史不是数组');
    repairHistory(history);

    // 把 QQ 那句当成一句真正的用户消息（带 _who，界面上署名是对方的名字）
    // 署名只挂 _who —— 千万别顺手挂 _whoId。
    // _whoId 是「什么身份说的话」的记号（owner / fish / 自定义），界面上有别的用途；
    // 塞成 'owner' 就等于把 QQ 那头的人一律冒充成主人（2026-11-04 揪出来的旧账）。
    //
    // _thirdParty 是「这不是电脑前的那个人」的记号，合并相邻消息时按它分嗓子
    // （见 merge-voice.mjs）。主人自己从 QQ 发的话也算 thirdParty —— 他在 QQ 上说的话
    // 本来就不该和他在电脑前打的字搅成一句。
    const userMsg = { role: 'user', content: String(text ?? ''), _text: String(text ?? '') };
    if (fromQq && fromQq.name) userMsg._who = String(fromQq.name).slice(0, 20);
    if (fromQq && (fromQq.openid || fromQq.name)) userMsg._thirdParty = true;
    history.push(userMsg);
    const firstUserTurn = history.filter((m) => m && m.role === 'user' && !m.context).length === 1;
    if (firstUserTurn && fromQq && fromQq.name) {
      session.title = `QQ · ${String(fromQq.name).slice(0, 20)}`;
    }
    session.updatedAt = Date.now();
    h.saveSession(session);

    const wire = history.slice(); // 浅拷贝：runAgent 会重建数组，引用必须留住
    const seen = new Set(history);
    const snap = h.snapFor ? h.snapFor(id) : {};
    // 2026-10-30：告诉这一轮的她「这话是从 QQ 递进来的、是 XX 说的」。
    // 不这么做的话她分不清电脑前的主人还是 QQ 那头的人，会让人「看我这」。
    setTurnSource(id, {
      source: 'qq',
      who: (fromQq && fromQq.name) || '',
      // 名字靠不住，号才作数 —— 主人 2026-10-30 特意交代要带上
      whoId: (fromQq && fromQq.openid) || '',
      isOwner: !!(fromQq && fromQq.isOwner),
      // 2026-11-02：她要在 QQ 里发图/发语音/发文件，得知道发回哪儿；
      // 附件也一并带上，省得她再猜「主人刚说的那张图是哪个」。
      replyTarget: replyTarget || null,
      attachments: Array.isArray(media) ? media.filter((m) => m && m.ok).map((m) => ({ kind: m.kind, localPath: m.localPath })) : [],
    });
    const out = await h.runWithToolContext({ sessionId: id, snap, signal: ac.signal, outbox: null }, () => h.runAgent({
      messages: wire,
      signal: ac.signal,
      sessionId: id,
      safeMode: !h.inPersonaMode(session),
      safeWord: session.mode?.word || '',
      onEvent: (ev) => emit(ev),
    }));

    repairHistory(history);
    for (const m of wire) {
      if (seen.has(m)) continue;
      if (m && (m.role === 'system' || m.context)) continue;
      seen.add(m);
      history.push(m);
    }
    session.updatedAt = Date.now();
    h.saveSession(session);
    emit({ type: 'done', text: String(out?.text ?? '') });
    return { ok: true, text: out && out.text };
  } catch (e) {
    emit({ type: 'error', message: String(e?.message ?? e) });
    throw e;
  } finally {
    live.done = true;
    // 这一轮结束，来源标记马上摘掉：绝不能让下一轮（主人在界面打字）误以为来自 QQ
    clearTurnSource(id);
    if (h.runningTurns.get(id) === turn) h.runningTurns.delete(id);
  }
}

/** 主人认领了 → 把这个人的话按「主人身份」处理（安全词、改名这些都算数）。 */
export function markQqOwner(sessionId) {
  try {
    const h = need();
    h.setIdentity('owner', sessionId);
    h.setFishOn(sessionId, true);
  } catch {}
}


/** 群聊会话改名成群名（桥接那边拿到群号后调） */
export async function renameGroupSession({ sessionId, groupId } = {}) {
  const h = need();
  const s = h.getSession(String(sessionId || ''));
  if (!s) return false;
  const nm = await groupNameOf(groupId);
  if (!nm) return false;
  const want = `QQ群 · ${String(nm).slice(0, 20)}`;
  if (s.title === want) return true;
  s.title = want;
  s.updatedAt = Date.now();
  h.saveSession(s);
  return true;
}