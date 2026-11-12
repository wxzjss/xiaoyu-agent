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

/**
 * 展开态：item key -> true。按 key 记，重渲染只改文本，open 属性不动。
 *
 * 【2026-11-12 修·主人报「切会话之后柜子自己开着/自己合上」】
 *
 * item key 里只有**轮次绝对下标**（`t-81-tl0` / `hub-t-81-tl0`），没有会话身份。
 * 于是 A 会话里把第 81 轮那个柜子点开，切到 B 会话 —— B 的同号轮次拿到同一个 key，
 * 打开状态直接被认成「开着的」：主人看到的是「B 里的柜子莫名其妙自己开了」。
 * 探针（scripts/_t_switch_probe.mjs 三）复现：A 点开柜子 → 切到 B，B 的
 * `details.toolhub[open]` 数 = 1。
 *
 * 这里把 openMap 包成「按当前会话自动加前缀」的一层：
 *   · 调用方（useOpen）的用法一个字都不用改：has / get / set / delete / clear 照旧；
 *   · 真正落账的 key 是 `<sid>|item key`，两个会话的同号轮次互不相干；
 *   · sid 取的是**这一屏**（LOG_STATE.sid），跟屏幕上画的是同一份。
 *
 * 注意：光换 key 还不够。两个会话的行 React key 也可能撞（同样的 `hub-t-81-tl0`），
 * 那样组件实例被复用、`useState` 的初值不会重新读 —— LogView 那边给行 key 加了
 * 会话前缀，保证换屏时每一行都是新实例（见 LogView 里 RowBoundary 的 key）。
 */
const OPEN_PREFIX_SEP = '\u0000';
const openRaw = new Map();
export const openMap = {
  get(key) { return openRaw.get(screenSid() + OPEN_PREFIX_SEP + String(key)); },
  has(key) { return openRaw.has(screenSid() + OPEN_PREFIX_SEP + String(key)); },
  set(key, v) { openRaw.set(screenSid() + OPEN_PREFIX_SEP + String(key), v); return openMap; },
  delete(key) { return openRaw.delete(screenSid() + OPEN_PREFIX_SEP + String(key)); },
  /* 清空是「全清」（所有会话）。切会话时**不**调它 —— 别的会话的展开态要留着。 */
  clear() { openRaw.clear(); },
  get size() { return openRaw.size; },
};


/* ── 辅助切片 ───────────────────────────────────────────────── */

/**
 * 这一屏属于哪个会话（展开态 / 编辑态都按它分账）。
 * 【2026-11-12 统一口径】不自己再算一套 —— 直接用 effectiveSid()
 * （「LOG_STATE.sid 有就用它，没有退 window.sessionId」，见下面那个函数的注释）。
 * 两处各读一套的话，「sid 还没摆上来」那一拍会出现「屏幕说 A、账记在空串」。
 */
function screenSid() {
  return effectiveSid();
}

/** 还没落盘的那句主人消息（乐观插入，落盘后自动消失） */
let pendingUser = [];
/** running true→false 翻转拍的缓冲（见 setLive 内注释）：
 * 待落的 false 快照 + 定时器句柄。
 * 【2026-11-11 补】还要记住「我们准备顶掉的是哪一份快照 / 收到它时历史多长」——
 * 250ms 后靠这两样判断这期间有没有更新的写（见 _fireFalseWrite）。 */
let _falseWritePending = null;
let _falseWriteTimer = 0;
let _falseWriteSid = '';
let _falseWritePrevLive = null;
let _falseWritePrevTurns = 0;
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
/**
 * 【2026-11-12 修·主人报「切到别人身份/别的会话之后，旧消息的编辑框还在」】
 *
 * 编辑态原来是全局一个 `{key, at}`。而 key 里只有轮次下标（`t-80`），
 * 于是「正在编辑 A 会话第 80 轮」切到 B 会话 —— B 的第 80 轮 key 一模一样，
 * 屏幕上当场给 B 的这句话套上编辑框（探针三/四 复现：
 * 切到 B 后 `#log textarea.editArea` 数 = 1，getEdit() 还是 A 的 {key:'t-80'}）。
 * 更糟的是那颗 `at` 是 A 的回退下标，主人要是随手点「存上」，
 * 改的就是 B 里同下标的**另一句话**。
 *
 * 现在：edit 带上它属于哪个会话；
 *   · getEdit() 只在「还是这一屏」时才交出去（key 撞了也不认）；
 *   · setHistory 换屏时直接清掉（切走 = 放弃这次编辑，草稿不留到别人屏幕上）。
 */
let edit = null;

/** 进入编辑态（key：item 的 key；at：回退点下标，保存时要用） */
export function beginEdit(key, at) {
  edit = {
    key: String(key || ''),
    at: Number.isFinite(Number(at)) ? Number(at) : null,
    sid: screenSid(),
  };
  bump();
}

/** 退出编辑态（存完 / 不改了 / 这一行被 key 对不上的一次重渲染顶掉） */
export function endEdit() {
  if (!edit) return;
  edit = null;
  bump();
}

/** 正在编辑的那一条 —— 只属于**这一屏**（换了会话就当没在编辑） */
export function getEdit() {
  if (!edit) return null;
  return edit.sid === screenSid() ? edit : null;
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

/**
 * 【2026-11-11 补·「这一屏是谁」的唯一口径】
 *
 * LOG_STATE.sid 是 **setHistory 之后**才摆上来的，可乐观气泡是「按下发送那一刻」
 * 同步记账、也是「这一刻」就要画的。两边若各读一套，空 sid 那段窗口期就出鬼：
 *   · 记成空 sid → getSnapshot 的 `!p.sid` 放行 → **每一屏都画**，且
 *     dropPendingForScreen 的 `p.sid && p.sid !== 本屏` 永远清不掉 = 跨屏孤儿；
 *   · 记成真 sid、读侧却还拿空 sid 比 → 刚发的那句**这一拍不画**（主人看到「我的话没上屏」）。
 *
 * 所以记账、读快照、清本屏这三处统一走这里：LOG_STATE.sid 有就用它，
 * 没有就退到 window.sessionId（index.html:19318 那个 getter，跟 sessionId 同源）。
 */
function effectiveSid() {
  const s = String(logState().sid || '');
  if (s) return s;
  try { return String(window.sessionId || ''); } catch (e) { return ''; }
}

/* ── 快照：给 React 用的只读视图 ───────────────────────────── */

export function getSnapshot() {
  const st = logState();
  const _sid = String(st.sid || '');
  /* 【2026-11-11】「本屏」一律按 effectiveSid 算（见它的注释）：
   * 只拿 LOG_STATE.sid 比的话，还没 setHistory 的那一拍会把刚发的那句藏起来。 */
  const _eff = effectiveSid();
  return {
    sid: _sid,
    turns: Array.isArray(st.turns) ? st.turns : [],
    live: st.live && Array.isArray(st.live.items) ? st.live : null,
    /* 只画本屏的乐观气泡 —— 别的会话的账不属于这一屏（串消息根治） */
    pendingUser: pendingUser.filter((p) => !p.sid || p.sid === _eff),
    notes,
    windowStart: histWin.get(_eff) || 0,
  };
}

/* ── 写入 API（chat.js / index.html 通过 window.__logStore 调用） ── */

/**
 * 【2026-11-12 加·「切回来回复闪一下又冒出来」——换屏那一拍的直播兜底】
 *
 * 换屏时 st.live 必须清掉（否则 B 屏幕上会长出 A 那一轮的话 = 串消息）。
 * 可「清掉」到「attachLive 把快照拿回来」之间有一个**网络往返**的空档：
 * 历史是齐的（齐到最后一条主人话），正在跑那一轮已经吐出来的字却不在 ——
 * 主人看到的就是「切回来，她的回复先消失一下，过一会儿再全冒出来」。
 *
 * 探针（scripts/_t_switch_probe.mjs 二·b，把 /api/chat/live 打成 150ms 延迟
 * ——真机常态）实测：中间有 2 帧屏幕只剩历史，缺的正是那两段正在跑的话；
 * 本地 0ms 延迟时这一拍太快、根本来不及上屏（所以一直没人发现）。
 *
 * 修法：每个会话记住「上一次拿到的直播快照」，换屏回这个会话时先拿它垫上，
 * 服务端的新快照一到就顶掉（followLive 每 1.2s 一拍）。
 *
 * 两条硬约束（不然「垫上」就成了「拿旧账骗人」）：
 *   ① **只垫很新的**（LIVE_CACHE_TTL 内）。久不更新的快照可能属于早就跑完的那一轮，
 *      垫上去等于拿旧内容盖住历史里更完整的回复 —— 那正是主人报过的另一个病
 *      （「切走再切回来，看不到后续的话」）。
 *   ② **自己会收摊**：垫上之后 2.5s 内没有任何更新的写（followLive 还没来），
 *      说明这一轮要么早结束了、要么服务端不认 —— 立刻撤掉，把屏幕还给历史。
 *      正常在跑的轮 1.2s 内必有新快照，所以这条只对「陈旧快照」生效。
 */
const liveCache = new Map();          // sid -> { live, at }
const LIVE_CACHE_TTL = 4000;          // 只垫「4 秒内还新鲜过」的快照
let _liveRestoreTimer = 0;
let _liveRestoreSid = '';
let _liveRestoreObj = null;

/** 写直播 + 维护快照缓存（null = 这一轮收摊，缓存一起删） */
function writeLive(sid, live) {
  const st = logState();
  st.live = live && Array.isArray(live.items) ? live : null;
  const s = String(sid || '');
  if (!s) return st.live;
  if (st.live) {
    liveCache.set(s, { live: st.live, at: Date.now() });
    /* 只留最近几个会话，别让缓存无限长大（一份快照顶多几十条 item） */
    if (liveCache.size > 6) {
      let oldestKey = '';
      let oldestAt = Infinity;
      for (const [k, v] of liveCache) { if (v.at < oldestAt) { oldestAt = v.at; oldestKey = k; } }
      if (oldestKey) liveCache.delete(oldestKey);
    }
  } else {
    liveCache.delete(s);
  }
  return st.live;
}

/** 换屏：这个会话有没有「可以垫一下」的快照？（没有就返回 null = 老行为） */
function restoreLiveFor(sid) {
  const s = String(sid || '');
  const hit = liveCache.get(s);
  if (!hit || !hit.live) return null;
  if (Date.now() - hit.at > LIVE_CACHE_TTL) { liveCache.delete(s); return null; }
  if (hit.live.running === false) return null;   // 已经收尾的那一轮归历史管
  return hit.live;
}

/** 垫上之后挂一个 2.5s 的自愈：没有更新的快照来就把这层垫子撤掉 */
function armRestoreCheck(sid, obj) {
  if (_liveRestoreTimer) { try { clearTimeout(_liveRestoreTimer); } catch (e) {} }
  _liveRestoreSid = String(sid || '');
  _liveRestoreObj = obj;
  _liveRestoreTimer = setTimeout(() => {
    _liveRestoreTimer = 0;
    const st = logState();
    if (String(st.sid || '') !== _liveRestoreSid) return;   // 又切走了
    if (st.live !== _liveRestoreObj) return;                // 已经有更新的写（直播接手了）
    st.live = null;                                        // 陈旧快照：收摊，交给历史
    liveCache.delete(_liveRestoreSid);
    pendingUser = dropLandedPending(pendingUser, st.turns);
    bump();
  }, 2500);
}

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
  /* 【2026-11-12 修】原来这里无条件 st.live = null（换屏清直播）。清还是要清，
   * 但「切回一个正在跑的会话」时先用本会话上一份快照垫住那一拍 —— 见 liveCache 注释。 */
  if (changedScreen) {
    const _pad = restoreLiveFor(_sid || effectiveSid());
    st.live = _pad;
    if (_pad) armRestoreCheck(_sid || effectiveSid(), _pad);
  }
  notes = [];
  /**
   * 账本规则（2026-11-10 三修，探针实测钉死的）：
   *   · **物理账本永远不清**：切走再切回，A 轮没收尾的话主人那句必须跟着回来。
   *     「不串屏」由 getSnapshot 的读侧过滤负责，不靠写侧删账。
   *   · 收账只对「本屏的账」跑、只写回本屏的：切走期间轮收尾落了盘
   *     （finishTurn 对后台轮的收账被 sid 校验挡住），切回时历史里已有这句，
   *     不收就是两颗。收完的本屏账 + 原样保留的别家账 = 新账本。
   */
  const others = pendingUser.filter((p) => p.sid && p.sid !== (_sid || effectiveSid()));
  const mine = dropLandedPending(
    pendingUser.filter((p) => !p.sid || p.sid === (_sid || effectiveSid())),
    st.turns,
  );
  pendingUser = mine.concat(others);
  if (changedScreen) {
    /**
     * 【2026-11-12 修·换屏要清的几笔账（切会话的四个病一起收）】
     *
     *   · histWin：窗口起点是「用户在这个会话里翻到哪儿」，换进来一律从
     *     「最近 WINDOW 轮」开始（buildMerged 自己会兜底），不能带着上一屏的。
     *   · edit：正在编辑的那一行属于上一屏（key 会撞），切走就当放弃 —— 见 beginEdit。
     *   · notes 上面已经整屏清了（换成 []）。
     *
     * 这里**刻意不清 openMap**：展开态是按会话记的（见 openMap），
     * 切回去主人还想看到自己刚才看开的那个柜子；串开合由 key 前缀 + 行 key 解决。
     */
    histWin.delete(_sid);
    histTouched.delete(_sid);
    edit = null;
  }
  bump();
}

/** 这一轮现在长什么样（服务端 /api/chat/live 的 items） */
export function setLive(sid, live) {
  const st = logState();
  if (String(sid || '') !== String(st.sid || '')) return false;
  /**
   * 【2026-11-11 修·收尾那一帧塌缩（steer-fixer）】
   *
   * followLive 每一拍是「先写快照、再看收尾」：running:false 的快照一进 store，
   * buildMerged 当场丢掉整个 live 段，而 finishTurn 的历史还在路上
   * （select 往返几十上百毫秒）——中间这几帧屏幕塌回旧历史，
   * 主人看到的就是「她说的话闪一下又没了」（检查鱼场景逐帧抓到：
   * 回复1 与插话气泡在收尾那一拍集体消失一帧）。
   *
   * 其实服务端在摘登记（running 翻 false）**之前**就已经
   * commitWireBack + saveSession，历史此刻必然是齐的。
   * 所以 running 从 true 翻 false 的这一拍，缓 250ms 再落账：
   * 这段时间里 finishTurn 的 setHistory + setLive(null) 几乎必然先到，
   * 屏幕从「直播」直接切到「历史」，中间没有空帧。
   * 缓冲期内来了更新的写（新一轮 running:true、setLive(null)）就作废缓冲。
   * 250ms 后才落账也没关系：那时要么历史已接管（running:false 本来就不画
   * live 段），要么屏上已有更新的 running:true 快照（落账前会再查一次）。
   */
  const _nowFalse = !!(live && live.running === false);
  const _wasRunning = !!(st.live && st.live.running !== false);
  if (_nowFalse && (_wasRunning || _falseWriteTimer)) {
    _falseWritePending = live;
    if (!_falseWriteTimer) {
      _falseWriteSid = String(sid || '');
      /* 【2026-11-11 补】记下「要顶掉的是哪一份」「此刻历史多长」——
       * 250ms 后判断有没有更新的写，就靠这两个（见 _fireFalseWrite）。 */
      _falseWritePrevLive = st.live;
      _falseWritePrevTurns = Array.isArray(st.turns) ? st.turns.length : 0;
      _falseWriteTimer = setTimeout(_fireFalseWrite, 250);
    }
    return true;
  }
  if (_falseWriteTimer) {
    clearTimeout(_falseWriteTimer);
    _falseWriteTimer = 0;
    _falseWritePending = null;
  }
  /* 【2026-11-12】写直播统一走 writeLive：顺手更新「换屏时能垫的那份快照」 */
  /**
   * 【2026-11-12 修·主人报「我一插话，她这一轮说的话就在屏幕上消失」】
   *
   * 快照偶尔会「变薄」：插话之后服务端可能给一份只有 events、没有 items 的
   * 直播对象（排队轮那份就是 {events, ...} 建出来的），或者条数比屏上已有的少。
   * 以前这里照收 —— 而 `items` 不是数组时干脆写成 null（整段直播清掉），
   * buildMerged 当场把 live 段丢掉：她已经说出来的话在屏幕上凭空消失，
   * 得等这一轮收尾落盘才回来。
   *
   * 规矩定死：**同一轮里，屏幕上的正文只许变多，不许变少。**
   * 新快照不带 items（或正文比现在少）→ 保留屏上这份 items，只把新的 running/时间接过来。
   * 真要清空（这一轮结束）走的是 setLive(null) / running:false，那条路不受影响。
   */
  const _prevItems = (st.live && Array.isArray(st.live.items) && st.live.items.length) ? st.live.items : null;
  const _nextItems = (live && Array.isArray(live.items) && live.items.length) ? live.items : null;
  /* 【判据要收窄】只认两种「真变薄」：
   *   ① 新快照**根本没带 items**（排队轮那份只有 events）—— 照收就等于清屏；
   *   ② 新清单是旧清单的**前缀截短**（同一条活、条目被削掉尾巴）。
   * 千万别拿「正文总字数」去比：新一轮可能整段换成「思考 + 工具」、正文是 0，
   * 那是正常的阶段切换（真机上会把柜子整段吞掉，check-log-react 二·c 就是这么红的）。 */
  const _sameHead = (a, b) => {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length > b.length) return false;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] || {}, y = b[i] || {};
      if (String(x.k || '') !== String(y.k || '')) return false;
      if (String(x.id || '') !== String(y.id || '')) return false;
      const tx = String(x.t == null ? '' : x.t), ty = String(y.t == null ? '' : y.t);
      if (tx !== ty.slice(0, tx.length)) return false;
    }
    return true;
  };
  const _wouldShrink = !!(_prevItems && live && live.running !== false &&
    (!_nextItems || (_nextItems.length < _prevItems.length && _sameHead(_nextItems, _prevItems))));
  if (_wouldShrink) live = Object.assign({}, live, { items: _prevItems });
  /* 【2026-11-12 修·主人嫌「上一轮被中断」提示钉死在屏幕最底部】
   * 她开工的整轮期间它都杵在历史末尾（她跑工具没正文时更显眼）。
   * 现在她一开口干活（直播 running 进来）提示就收掉 —— 它的使命
   * 只是「你回来时交代一句」，不是常驻横幅。主人发话也一样收（见 pushPendingUser）。 */
  if (live && live.running !== false && notes.length) notes = [];
  writeLive(sid, live && Array.isArray(live.items) ? live : null);
  if (!st.live) pendingUser = dropLandedPending(pendingUser, st.turns);
  bump();
  return true;
}

/**
 * 【2026-11-11 修·收尾那一拍可能永远落不了账（steer-fixer）】
 *
 * 缓冲到点要做的事，判据原来只写了「屏上还有 running:true 的快照就别盖」：
 *
 *     if (_st.live && _st.live.running !== false) return;
 *
 * 可那「running:true 的快照」往往**正是我们准备顶掉的那一份旧账**（服务端刚说
 * running:false，followLive 还没来得及写新的）。于是这句判据恒真 → 到点一次也不落账
 * → `live` 永远停在 running:true：按钮一直是【停止】、输入框一直锁着，屏幕上
 * 直播那份和她落盘的历史**同时**画着这一轮（一次收尾留下两份）。
 * finishTurn 真正跑到 setHistory+setLive(null) 时能救回来，可它一旦提前 return
 * （排队轮 / 切走 / 抛错）就没人来救了 —— 只能 F5。
 *
 * 现在把「有没有更新的写」判准：比**对象身份**（st.live 还是不是我们记下的那一份），
 * 不再拿「它是不是 running:true」当证据。三种情况：
 *   ① 屏上那份已经换人（新一轮的 running:true 接上了，或者已被 setLive(null) 收掉）
 *      → 一个字节都不写（旧的 false 不许盖新的）；
 *   ② 这期间历史长过了（finishTurn 的 setHistory 已经接管）→ 把 live 收成 null，
 *      干净交棒：既不重复也不留空帧；
 *   ③ 什么都没有（finishTurn 没来）→ 落账那份 running:false。
 *      宁可屏幕上少画一段（历史还在，下一拍就对上了），也不能一直骗自己"还在跑"。
 */
function _fireFalseWrite() {
  _falseWriteTimer = 0;
  const p = _falseWritePending;
  _falseWritePending = null;
  if (!p) return;
  const st = logState();
  /* ① 切走了：这份账不属于这一屏 */
  if (_falseWriteSid !== String(st.sid || '')) return;
  /* ② 这期间有更新的写（换人 / 已经收成 null）→ 别拿旧的 false 去盖 */
  if (st.live !== _falseWritePrevLive) return;
  const _len = Array.isArray(st.turns) ? st.turns.length : 0;
  if (_len > _falseWritePrevTurns) {
    /* ③ 历史已经接住了：直播收摊，屏幕交给历史 */
    writeLive(_falseWriteSid, null);
    pendingUser = dropLandedPending(pendingUser, st.turns);
  } else {
    /* ④ 没人接手：落账真相（running:false），别让界面永远以为在跑 */
    st.live = p;
  }
  bump();
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
    /**
     * 会话归属：发话那一刻在哪一屏，这句话就是哪家的账。
     *
     * 【2026-11-11 补·sid 取不到会变成跨屏孤儿】
     * 原来只读 LOG_STATE.sid。可它是**异步摆上来**的（setHistory 才写），
     * 而 pushPendingUser 是「按下发送那一刻」同步调的。万一这一刻 sid 还是空串，
     * 这颗气泡就带着 `sid: ''` 进账本，后果两头都坏：
     *   · getSnapshot 的过滤是 `!p.sid || p.sid === 本屏` → 空 sid 在**每一屏**都画出来；
     *   · dropPendingForScreen 的过滤是 `p.sid && p.sid !== 本屏` → 空 sid 永远清不掉。
     * 于是「我在 A 说了一句，切到 B 屏幕上还挂着我那句话，怎么都收不掉」。
     * 兜底读 window.sessionId（index.html:19318 那个 getter，跟 LOG_STATE.sid 同源）。
     */
    sid: effectiveSid(),
    text: String(it.text || ''),
    atts: Array.isArray(it.atts) ? it.atts.filter((a) => a && a.path) : [],
    who: String(it.who || ''),
    tag: String(it.tag || ''),
    rewindId: Number.isFinite(Number(it.rewindId)) ? Number(it.rewindId) : null,
    /**
     * 【2026-11-12 加·记账那一刻历史有多长】
     *
     * 收账（dropLandedPending）原来只在「历史末尾 6 条 / 最后一条 user」里找。
     * 一轮被打断、停止，或者收尾那一路没走 setHistory，这颗气泡就收不掉；
     * 之后每轮合并 `items.concat(pend, live)` 都把它排到清单最末尾 ——
     * 主人看到的就是「我早先发的那句话每轮结束都被重发一遍」，
     * 而它不是真实历史条目，点编辑拿不到合法 at →「这句不能改」。
     * （搭建鱼会话的「搭一个看看」实锤：历史里只有一条，屏幕上却反复出现。）
     *
     * 记下 push 时的历史长度，收账时就能分清：
     *   · 历史里 push 位置**之后**出现了同文 user → 这就是它落盘的那份，收掉；
     *   · push 之后已经又落了 **2 条以上别的 user** → 它那一轮早结束了，
     *     还没对上账的就是孤儿（没落盘也不会再有答案）——收掉，别再阴魂不散。
     */
    pushLen: (() => {
      try { const t = logState().turns; return Array.isArray(t) ? t.length : 0; } catch (e) { return 0; }
    })(),
  };
  if (notes.length) notes = [];
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

/**
 * 历史窗口：只画最近 N 轮，往上翻再补。
 *
 * 【2026-11-12 加·「翻到最顶」不再被打回最新】
 *
 * 原来 0 有两种含义：**从没翻过**（该只画最近 40 轮）和**翻到最顶**（该全画）。
 * 两者同一个值，于是主人一路点「↑ 再往前看」点到 0 时，buildMerged 一瞅
 * 「start 不大于 0」就把窗口重置回「最近 40 轮」——他刚翻到的位置当场丢了，
 * 屏幕跳回最新（探针实测：300 轮会话，翻到 0 之后 start 又变回 260）。
 *
 * 所以另记一笔「这个会话他手动翻过没有」：翻过就尊重他的位置（哪怕是 0）。
 */
const histTouched = new Set();

export function setWindowStart(sid, start) {
  const _sid = String(sid || '') || effectiveSid();
  const n = Math.max(0, Number(start) || 0);
  histTouched.add(_sid);
  if (histWin.get(_sid) === n) return;
  histWin.set(_sid, n);
  bump();
}

export function getWindowStart(sid) {
  return histWin.get(String(sid || '')) || 0;
}

/** 这个会话的历史窗口是「他手动翻出来的」吗（翻过就尊重到底，含 0） */
export function isWindowTouched(sid) {
  return histTouched.has(String(sid || ''));
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
 * 命中了就说明服务端已经落盘，乐观那条必须收掉，否则屏幕上两份。
 *
 * 【2026-11-11 修·主人报「一轮结束，我说的话全堆到这一轮最下面」】
 *
 * 原来只看**最后 6 条**（`arr.slice(-6)`）。可一轮活儿里她的回复常常被劈成
 * 好几段 assistant turn（正文→工具→正文→工具…），主人那句话很快就被挤出这 6 条窗口：
 * 于是「落盘了」判不出来 → 乐观气泡一直留着 → buildMerged 的 `items.concat(pend, live)`
 * 把它摆在清单**最末尾** = 主人看到的「我这句话堆到了这一轮最下面」。
 * 按 F5 就正常，是因为 pendingUser 只活在前端内存里，刷新即清空。
 *
 * 正确判据：**历史里最后一条 user turn 就是它**（不管这一轮后面又劈出多少段 assistant）。
 * 保留末尾 6 条做兜底 —— 极少数路径（续跑 / 切会话）里最后一条 user 可能不是它。
 * 刻意**不**全表扫：主人隔了很多轮又说一句同样的话（比如第三次「继续」），
 * 全表扫会把它当「已经在历史里」当场收掉，屏幕上看着像话被吞了。
 */
function dropLandedPending(list, turns) {
  if (!list.length) return list;
  const arr = Array.isArray(turns) ? turns : [];
  const nz = (t) => norm(t && t.text);
  let lastUserText = '';
  for (let i = arr.length - 1; i >= 0; i--) {
    const t = arr[i];
    if (t && t.role === 'user') { lastUserText = nz(t); break; }
  }
  const texts = arr.slice(-6).map(nz).filter(Boolean);
  /* 【2026-11-12 加·孤儿账收容】push 之后的 user turn（带下标），给两条新规矩用 */
  const userAfter = (pushLen) => {
    const out = [];
    for (let i = Math.max(0, pushLen | 0); i < arr.length; i++) {
      const t = arr[i];
      if (t && t.role === 'user') out.push(nz(t));
    }
    return out;
  };
  const keep = list.filter((p) => {
    const n = norm(p.text);
    if (!n) return false;
    if (lastUserText && (lastUserText === n || lastUserText.endsWith(n))) return false;
    if (texts.some((t) => t === n || t.endsWith(n))) return false;
    /* 新规矩只对带 pushLen 的账生效（老账没有这个字段，走原判据） */
    const pl = Number(p.pushLen);
    if (Number.isFinite(pl) && pl >= 0) {
      const after = userAfter(pl);
      /* ① 落盘了：push 位置之后历史里出现了同文 user —— 那就是它，收掉。
       *    （不管它排在哪，劈成几段、中间隔了多少轮都算数。） */
      if (after.some((t) => t === n || t.endsWith(n) || n.endsWith(t))) return false;
      /* ② 孤儿：push 之后已经又落了 2 条以上**别的** user —— 它那一轮早就结束了，
       *    还没对上账说明这份乐观气泡永远等不到落盘（被停 / 被断 / 上游 402）。
       *    留着就是「每轮重发一遍」的鬼影，收掉。 */
      const others = after.filter((t) => !(t === n || t.endsWith(n) || n.endsWith(t)));
      if (others.length >= 2) return false;
    }
    return true;
  });
  return keep.length === list.length ? list : keep;
}

/**
 * 清掉**本屏**所有乐观气泡（不管有没有历史可对账）。
 *
 * 【2026-11-10 加·上游失败那一路的收尾】
 * 正常收尾走 setHistory → dropLandedPending（拿历史去比对，最准）。
 * 但上游失败时这一轮可能**没有历史可拿**（assistant 一条都没有），
 * 那时 setHistory 不会被调用，乐观气泡就永远挂在屏幕上 ——
 * 实测每失败一轮多一颗，连跑三次屏幕上三颗一样的主人气泡。
 *
 * 触发条件很明确：只有「这一轮真的结束了」才会调它，
 * 而话在开跑前就已 saveUserMessage 落过盘 —— 屏幕上不该再有「未落盘」的账。
 * 只清本屏（按 sid 过滤），别的会话的账原样留着（切回去还要用）。
 */
export function dropPendingForScreen() {
  /* 【2026-11-11】「本屏」按 effectiveSid 算：记成空 sid 的账（极早期那一拍）
   * 原来一律被判成「别家的」而原样留着 —— 那就是怎么都收不掉的孤儿。 */
  const _sid = effectiveSid();
  const before = pendingUser.length;
  pendingUser = pendingUser.filter((p) => p.sid && p.sid !== _sid);
  const dropped = before - pendingUser.length;
  if (dropped) bump();
  return dropped;
}

/**
 * 按文字撤掉一条乐观气泡（不看历史）。
 *
 * 窄口子：只按文本精确匹配（归一化后相同或结尾相同），不碰别人的账。
 * 留给「知道具体是哪句话」的调用方用。
 */
export function dropPendingByText(text) {
  const n = norm(text);
  if (!n) return 0;
  const before = pendingUser.length;
  pendingUser = pendingUser.filter((p) => {
    const pn = norm(p.text);
    if (!pn) return false;
    return !(pn === n || pn.endsWith(n) || n.endsWith(pn));
  });
  const dropped = before - pendingUser.length;
  if (dropped) bump();
  return dropped;
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
  dropPendingForScreen,
  dropPendingByText,
  pushNote,
  setWindowStart,
  getWindowStart,
  isWindowTouched,
  beginEdit,
  endEdit,
  getEdit,
};
