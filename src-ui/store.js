/**
 * 对话区的数据桥：把「现有的 LOG_STATE」接进 React 的响应式。
 *
 * 设计约束（规格 4.1 / 步骤 1）：
 *   · **不动 LOG_STATE 的定义与已有调用**。它还在 public/ui/chat.js 里，
 *     `logSetHistory` / `logSetLive` 照旧被外面几十处调用。
 *   · 这里只做两件事：
 *       ① 记住一个版本号（version），数据变了就 +1 并通知订阅者；
 *       ② 把「历史 / 直播之外」的那点状态（本条还没落盘的用户消息、系统提示、
 *          历史窗口起点）收在自己身上 —— 它们本来就是纯前端的临时态。
 *   · React 侧用 `useSyncExternalStore(subscribe, getVersion)` 订阅，
 *     屏幕 = f(turns, liveItems, pendingUser, notes)，没有第三条写入 DOM 的路。
 *
 * 单一数据源仍是 LOG_STATE（turns / liveItems）。这里的数组不复制内容，
 * 只是「多出来的一层壳」。
 */

const listeners = new Set();
let version = 0;

/** 展开态：item key -> true。按 key 记，重渲染只改文本，open 属性不动。 */
export const openMap = new Map();

/* ── 辅助切片 ───────────────────────────────────────────────── */

/** 还没落盘的那句主人消息（乐观插入，落盘后自动消失） */
let pendingUser = [];
/** 系统提示（报错 / 限流 / 断线）。老实现里它挂在屏幕末尾，下次整屏重画时被冲掉 —— 口径照旧。 */
let notes = [];
/** 历史窗口起点（只画最近 N 轮）。key 是 sid。 */
const histWin = new Map();
let seq = 0;

/**
 * 【2026-11-10 修·主人报「回复中切会话会串消息」】
 *
 * pendingUser 必须按会话记账。原来它是全局一锅：
 * 在 A 会话发话（乐观气泡入账）→ 跑动中切到 B → setHistory(B) 时
 * dropLandedPending 只收「在 B 的历史里命中」的账 —— A 那句在 B 的历史里
 * 当然不存在，判据不命中就**保留** → React 把它画在 B 的屏幕上，
 * 主人当面看到 A 的话串进了 B。
 *
 * 现在每颗 pend 记下它属于哪个 sid；画的时候只画「本屏的」；
 * setHistory 换屏时顺手把别人家的账清掉。
 */

/* ── 编辑态（2026-11-10 A1：编辑框进 React，不再被提交回流冲掉） ── */

/**
 * 正在编辑哪一条：{ key, at }。正文草稿（editText）不放这儿 ——
 * 它住在 EditArea 组件自己的 state 里（打字只重渲染编辑框那一个组件，
 * 不用每敲一个字就把整屏账本 bump 一遍）。
 *
 * 为什么必须在 store 里：编辑按钮是 attachEdit 挂的（.msgActions 容器里），
 * 点下去要把「哪一行换成编辑框」这件事告诉 React —— 数据进 store，
 * 屏幕才有唯一画法。旧的手写 textarea 一开就把 bubble.textContent 清空，
 * 下一个流式 tick / 重渲染一来，输入框连着原内容一起被冲掉 —— 就是审查实测的
 * 「编辑框一开就清空原内容」。现在 textarea 由 React 受控渲染，
 * 提交回流只会让「同一行」在「气泡 ⇄ 编辑框」之间按 state 切换，谁也冲不掉谁。
 */
let edit = null;

/** 进入编辑态（key：item 的 key；at：回退点下标，保存时要用） */
export function beginEdit(key, at) {
  edit = { key: String(key || ''), at: Number.isFinite(Number(at)) ? Number(at) : null };
  bump();
}

/** 退出编辑态（存完 / 不改了 / 这一行被 key 对不上的一次重渲染顶掉） */
export function endEdit() {
  if (!edit) return;
  edit = null;
  bump();
}

export function getEdit() {
  return edit;
}

/* ── 订阅 ───────────────────────────────────────────────────── */

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getVersion() {
  return version;
}

/**
 * 数据变了：+1 版本号，通知所有订阅者。
 *
 * 【为什么通知要推到微任务里，而不是当场同步调用】
 *
 * 这几个写入口（logSetHistory / logSetLive / pushNote …）是**页面里的经典脚本**
 * 在调的，调用时机不受我们控制 —— 其中有些就落在 React 的提交阶段里
 * （比如 boot 一边画一边补历史）。同步通知会让 React 在「正在提交这棵树」
 * 的过程中被要求立刻同步重渲染，实测后果是提交阶段抛
 * `removeChild: The node to be removed is not a child of this node`，
 * 而那个阶段没有错误边界接得住 —— **整棵树被卸载，屏幕一片空白**。
 *
 * 推到微任务里做就干净了：React 在这一拍的提交一定做完，下一次更新是
 * 「已有树 → 新树」的正常更新。代价是屏幕晚上一个微任务（肉眼不可见），
 * 换掉的是一整类「时序撞车」的可能。
 */
let pendingNotify = false;

export function bump() {
  version += 1;
  if (pendingNotify) return;
  pendingNotify = true;
  const fire = () => {
    pendingNotify = false;
    for (const fn of Array.from(listeners)) {
      try {
        fn();
      } catch (e) {
        try { console.warn('[log-store] 订阅者抛错:', e && e.message ? e.message : e); } catch (e2) {}
      }
    }
  };
  try { queueMicrotask(fire); } catch (e) { fire(); }
}

/* ── 底层状态读取（LOG_STATE 住在 chat.js 里） ─────────────── */

function logState() {
  const s = window.__logState;
  if (s && typeof s === 'object') return s;
  return { sid: '', turns: [], live: null };
}

/* ── 快照：给 React 用的只读视图 ───────────────────────────── */

export function getSnapshot() {
  const st = logState();
  const _sid = String(st.sid || '');
  return {
    sid: _sid,
    turns: Array.isArray(st.turns) ? st.turns : [],
    live: st.live && Array.isArray(st.live.items) ? st.live : null,
    /* 只画本屏的乐观气泡 —— 别的会话的账不属于这一屏（串消息根治） */
    pendingUser: pendingUser.filter((p) => !p.sid || p.sid === _sid),
    notes,
    windowStart: histWin.get(_sid) || 0,
  };
}

/* ── 写入 API（chat.js / index.html 通过 window.__logStore 调用） ── */

/**
 * 整屏历史换人 / 刷新。
 * 老实现里「整屏重画」会顺手把屏幕上的系统提示冲掉，这里沿用同一口径：
 * 历史一换，旧提示就不该再挂着（它们是上一轮的事）。
 */
export function setHistory(sid, turns) {
  const st = logState();
  const _sid = String(sid || '');
  const changedScreen = String(st.sid || '') !== _sid;
  st.sid = _sid;
  st.turns = Array.isArray(turns) ? turns : [];
  if (changedScreen) st.live = null;
  notes = [];
  /**
   * 账本规则（2026-11-10 三修，探针实测钉死的）：
   *   · **物理账本永远不清**：切走再切回，A 轮没收尾的话主人那句必须跟着回来。
   *     「不串屏」由 getSnapshot 的读侧过滤负责，不靠写侧删账。
   *   · 收账只对「本屏的账」跑、只写回本屏的：切走期间轮收尾落了盘
   *     （finishTurn 对后台轮的收账被 sid 校验挡住），切回时历史里已有这句，
   *     不收就是两颗。收完的本屏账 + 原样保留的别家账 = 新账本。
   */
  const others = pendingUser.filter((p) => p.sid && p.sid !== _sid);
  const mine = dropLandedPending(
    pendingUser.filter((p) => !p.sid || p.sid === _sid),
    st.turns,
  );
  pendingUser = mine.concat(others);
  if (changedScreen) histWin.delete(_sid);
  bump();
}

/** 这一轮现在长什么样（服务端 /api/chat/live 的 items） */
export function setLive(sid, live) {
  const st = logState();
  if (String(sid || '') !== String(st.sid || '')) return false;
  st.live = live && Array.isArray(live.items) ? live : null;
  if (!st.live) pendingUser = dropLandedPending(pendingUser, st.turns);
  bump();
  return true;
}

/** 只通知，不改数据（renderLog 现在就是这个语义：数据早摆好了，React 自己会画） */
export function notify() {
  bump();
}

/** 乐观插入一句主人刚发的话。返回一个 id，落盘后由 dropPending 撤掉。 */
export function pushPendingUser(o) {
  const it = o || {};
  seq += 1;
  const item = {
    id: 'p' + seq,
    /* 会话归属：发话那一刻在哪一屏，这句话就是哪家的账 */
    sid: String(logState().sid || ''),
    text: String(it.text || ''),
    atts: Array.isArray(it.atts) ? it.atts.filter((a) => a && a.path) : [],
    who: String(it.who || ''),
    tag: String(it.tag || ''),
    rewindId: Number.isFinite(Number(it.rewindId)) ? Number(it.rewindId) : null,
  };
  pendingUser = pendingUser.concat([item]);
  bump();
  return item.id;
}

/** 服务端把落盘下标（at）告诉我了 → 这颗气泡从此能回退 / 编辑 / 分支 */
export function setPendingRewind(id, at) {
  const _id = String(id || '');
  if (!_id) return;
  let hit = false;
  pendingUser = pendingUser.map((x) => {
    if (x.id !== _id) return x;
    hit = true;
    return { ...x, rewindId: Number.isFinite(Number(at)) ? Number(at) : x.rewindId };
  });
  if (hit) bump();
}

/** 撤掉一句（发送失败 / 服务端说没落盘） */
export function dropPending(id) {
  const _id = String(id || '');
  if (!_id) return;
  const before = pendingUser.length;
  pendingUser = pendingUser.filter((x) => x.id !== _id);
  if (pendingUser.length !== before) bump();
}

/** 一行系统提示（后面可以挂按钮：`{label, onClick}`） */
export function pushNote(text, actions) {
  const t = String(text == null ? '' : text);
  if (!t.trim()) return;
  const acts = Array.isArray(actions)
    ? actions.filter((a) => a && (a.label || a.onClick))
    : null;
  notes = notes.concat([{ id: 'n' + (seq += 1), text: t, actions: acts }]);
  if (notes.length > 50) notes = notes.slice(-50);
  bump();
}

/** 历史窗口：只画最近 N 轮，往上翻再补 */
export function setWindowStart(sid, start) {
  const _sid = String(sid || '');
  const n = Math.max(0, Number(start) || 0);
  if (histWin.get(_sid) === n) return;
  histWin.set(_sid, n);
  bump();
}

export function getWindowStart(sid) {
  return histWin.get(String(sid || '')) || 0;
}

/* ── 内部：落盘之后把乐观气泡收掉 ─────────────────────────── */

function norm(s) {
  try {
    return String(window.fixMojibake ? window.fixMojibake(String(s || '')) : String(s || '')).replace(/\s+/g, '');
  } catch (e) {
    return String(s || '').replace(/\s+/g, '');
  }
}

/**
 * 这句话在不在这份历史里？
 *
 * 判据是「洗完只留字」之后相等，只看最后几条 —— 刚发出去的那句必然贴着尾巴。
 * 命中就说明服务端已经落盘了，乐观那条必须收掉，否则屏幕上两份。
 */
function dropLandedPending(list, turns) {
  if (!list.length) return list;
  const arr = Array.isArray(turns) ? turns : [];
  const tail = arr.slice(-6);
  const texts = tail.map((t) => norm(t && t.text)).filter(Boolean);
  const keep = list.filter((p) => {
    const n = norm(p.text);
    if (!n) return false;
    return !texts.some((t) => t === n || t.endsWith(n));
  });
  return keep.length === list.length ? list : keep;
}

/* ── 暴露给 chat.js / index.html（它们在 React 之外） ───────── */

window.__logStore = {
  bump,
  notify,
  setHistory,
  setLive,
  pushPendingUser,
  setPendingRewind,
  dropPending,
  pushNote,
  setWindowStart,
  getWindowStart,
  beginEdit,
  endEdit,
  getEdit,
};
