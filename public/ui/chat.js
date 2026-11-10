// @ts-check
/* 【2026-11-09 · 换框架】对话区（#log）改由 React 声明式渲染。
 *
 * 这个文件原来的两大职责分家了：
 *   ① **数据**：LOG_STATE（turns / liveItems）—— 留在这里，仍是唯一数据源
 *   ② **画**：paintSnapshot / paintSnapshotInner / paintSnapshot0 / renderTurns /
 *            tryLiveAppendFast / followLive 的逐条绘制 / replayInFlight 的逐条绘制
 *            —— **全部删掉**，屏幕改由 `public/ui/log.bundle.js`（src-ui/*）渲染
 *
 * 为什么删而不是留着兜底：
 *   前四轮修的都是「两套账」的补丁 —— 手写 DOM 必须自己维护节点身份、复用池、
 *   指纹、滚动锚点、展开态；「先删后建」这个动作必然产生中间态，
 *   于是堆叠 / 回弹 / 抖动换着地方冒。React 的 key 机制从根上消除这类问题。
 *   留着旧路，等于把已经拆掉的地基又铺回去一半。
 *
 * 现在这里的每一次写入都只做一件事：**改数据 + 通知订阅者**。
 * 屏幕 = f(turns, liveItems)，没有第二条写 DOM 的路。
 */

import { refreshRunning, renderSessList } from './sessions.js';

/* 【2026-11-08 模块化】`log` 是主脚本里的 const（#log 那个元素）。 */
const log = window.log;

/* ══════════════════════════════════════════════════════════════
 * 单一数据源
 *
 *   LOG_STATE = { sid, turns, live }
 *     sid    这一屏属于哪个会话（换了就整套重置）
 *     turns  落盘历史（服务端权威）
 *     live   正在跑的那一轮：{ running, startedAt, items:[...] }；没在跑就是 null
 *
 * 注意 `live.items` **直接用服务端的**：前端不再自己把事件合成 items
 * （原来的 liveItemsFeed / itemsFromEvents 已删）。两边各算一遍就是「两套账」，
 * 段落划分稍有不同，屏幕上就是「跑着时三个气泡、刷新一下变两个」。
 * ══════════════════════════════════════════════════════════════ */
const LOG_STATE = {
  sid: '',
  turns: null,
  live: null,
};

/* React 那一侧（src-ui/store.js）要读同一份数据 —— 把对象本身交出去，
 * 不是复制一份。谁改都是改这一个。 */
window.__logState = LOG_STATE;

/** 数据变了：叫一声订阅者（React 那边 useSyncExternalStore 会重渲染） */
function notifyStore() {
  try {
    const s = window.__logStore;
    if (s && typeof s.notify === 'function') s.notify();
  } catch (e) {
    try { console.warn('[log] 通知订阅者失败:', e && e.message ? e.message : e); } catch (e2) {}
  }
}
/**
 * 【2026-11-09 换框架】历史边界（trimTurnsForLive）搬去 src-ui/items.js 了。
 *
 * 那里是「turns + liveItems → 屏幕上那几段」的唯一算法。
 * 这里再留一份，就等于又有两个账本 —— 正是这一轮要根治的东西。
 */

/**
 * 【已废】原来这里扫 DOM、把「同一段被画了两遍」的节点删掉。
 *
 * 现在屏幕由 key 决定节点身份，同一份数据不可能画成两个节点 ——
 * 这个函数没有存在的理由了。保留空壳只是因为外面还有几处在调它
 * （删了会 ReferenceError），它返回 0 = 「一个重复都没收到」。
 */
export function logSettle() {
  return 0;
}

/** 这一屏换主人了 */
export function logSetHistory(sid, turns) {
  /**
   * 【2026-11-10 QA 抓到的真 bug·主人那句话每轮都显示两遍】
   *
   * 这里原来自己直接写 `LOG_STATE.turns` 再 `notifyStore()` —— 绕开了
   * `src-ui/store.js` 的 `setHistory()`，而「落盘之后把乐观气泡撤掉」
   * （`dropLandedPending`）**只写在 setHistory() 里**，生产代码里零调用点。
   *
   * 后果：主人发话 → 插一颗乐观气泡 → 这一轮落盘，历史里也有了这条 user
   * → 但乐观那颗没人撤 → 屏幕上是**两个一模一样的**主人气泡，每轮必现。
   *
   * 现在一律经 store：清账逻辑只有一份，不再分叉。
   * store 没就位时（模块加载顺序的极端情况）才退回去直接写，保证不至于整屏空着。
   */
  try {
    if (window.__logStore && typeof window.__logStore.setHistory === 'function') {
      window.__logStore.setHistory(sid, turns);
      return;
    }
  } catch (e) { /* 掉到下面的兜底 */ }
  const _sid = String(sid || '');
  if (LOG_STATE.sid !== _sid) {
    LOG_STATE.sid = _sid;
    LOG_STATE.live = null;
  }
  LOG_STATE.turns = Array.isArray(turns) ? turns : [];
  notifyStore();
}

/** 这一轮现在长什么样（传 null = 它跑完了） */
export function logSetLive(sid, live) {
  /**
   * 【2026-11-10 A9 · 收进唯一写口】
   *
   * 这里原来直写 `LOG_STATE.live` + notifyStore —— 绕开了 store.setLive()。
   * 而「清账」钩子（dropLandedPending：这一轮收尾时把已经落盘的乐观气泡撤掉）
   * 只写在 store.setLive() 里，旁路一绕，主人那句话就会留两颗（跟
   * logSetHistory 当年那个「每轮显示两遍」是同一类病根）。
   *
   * 现在一律转调 store（sid 校验 + 清账都在那一份里）；
   * store 没就位时（模块加载顺序的极端情况）才退回直写，保证不至于整屏空着。
   */
  const safe = live && Array.isArray(live.items) && live.items.length ? live : null;
  try {
    if (window.__logStore && typeof window.__logStore.setLive === 'function') {
      return window.__logStore.setLive(sid, safe);
    }
  } catch (e) { /* 掉到下面的兜底 */ }
  if (String(sid || '') !== LOG_STATE.sid) return false;   // 不是这一屏的，别污染
  LOG_STATE.live = safe;
  notifyStore();
  return true;
}

/** 开跑那一刻：把「这一屏属于谁、历史是什么」摆好 */
export function logBeginTurn(sid, turns) {
  /**
   * 【2026-11-10 修·主人报「发消息后以前的聊天记录都不显示了」】
   *
   * 原来同屏也无条件 logSetHistory(sid, turns) —— 而 turns 参数是
   * index.html 主脚本的旧变量 currentTurns，换框架后 renderTurns 已经
   * 不再是画历史的那条路，**没人再更新它**（多半是 []）。
   * 于是发消息 → setHistory(sid, []) → store 的历史被清成空 →
   * 屏幕上只剩主人那颗乐观气泡，以前的聊天记录全部蒸发。
   *
   * 正确语义（7810 行注释一直写的都是这个）：同屏 = 屏幕上这份就是对的，
   * 谁也别动；只有换屏（切会话开轮）才用调用方给的历史摆屏。
   */
  const _sid = String(sid || '');
  const sameScreen = LOG_STATE.sid === _sid;
  if (sameScreen) return true;          // 同屏：历史一动不如一静
  logSetHistory(_sid, turns);
  return false;
}

/** 历史指纹：只关心「画出来会不一样」的那几个量（诊断用，保留） */
export function logHistoryFp(turns) {
  const arr = Array.isArray(turns) ? turns : [];
  const n = arr.length;
  const last = arr[n - 1] || {};
  return n + '|' + String(last.ts || '') + '|' + String(last.text || '').length
    + '|' + String(last.reasoning || '').length;
}

/**
 * **唯一的画入口** —— 但现在它已经不画了。
 *
 * 名字留着，是因为外面有几十处 `renderLog()`（切会话、跑完、删消息、改消息…），
 * 那些调用点表达的意思对：**「数据摆好了，请把屏幕对齐」**。
 * 实现只剩一句「通知 React」，屏幕由 React 按数据算出来。
 */
export function renderLog(opts) {
  const sid = LOG_STATE.sid;
  if (!sid) return false;
  notifyStore();
  return true;
}

/* ── 直播拉取 ───────────────────────────────────────────────── */

/**
 * 把一个还在跑的会话接上：问服务端「这一轮现在长什么样」，交给 store。
 *
 * 为什么不再「按事件补画」：
 *   原来这里有 attachLive / paintLiveEvents / followLive / replayInFlight / 流式 SSE
 *   五条路各自往屏幕上加节点，各记一套账。现在只有一条：
 *   **服务端给的 items 进 LOG_STATE，React 照它渲染。**
 */
export async function attachLive(id) {
  let live = null;
  try {
    live = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(id)).then((r) => r.json());
  } catch {
    return false;
  }
  /* 这一句 await 可能挂好几百毫秒。等它回来时主人可能已经切走了 ——
   * 那就一个字节都不画（否则 B 会话的话会长在 C 会话的屏幕上）。 */
  try {
    if (live && live.running) window.__xyLiveStartAt = Number(live.startedAt) || 0;
  } catch (e) {}
  if (window.sessionId !== id) return false;

  if (!live || !live.running) {
    /* 没在跑：这一屏归历史，直播节点一个都不许留 */
    try { window.turnsInFlight.delete(id); } catch (e) {}
    return false;
  }

  logSetLive(id, live);
  renderLog({ force: true });
  /* 起点推到末尾：已经在那份快照里的内容不用再「补」，后面新来的靠轮询 */
  followLive(id, Array.isArray(live.events) ? live.events.length : 0);
  return true;
}

/**
 * 跟进一个正在跑的会话：**只做对账**。
 *
 * 每一拍都重新问一次「这一轮现在该长什么样」（全量，幂等），交给 store；
 * 指纹 / 增量游标 / 合并规则全都不在前端算了 —— 那是第二套账的来源。
 *
 * 收尾（服务端说 running=false）时把历史重新拉一遍：落盘的正文才是完整的
 * （事件流有上限，长回复会被压薄），所以「跑完之后屏幕=历史」这条铁律不变。
 */
export function followLive(id, fromIndex) {
  window.stopFollow(id);
  const startedAt = Date.now();

  const timer = setInterval(async () => {
    if (window.sessionId !== id) {
      window.stopFollow(id);
      return;
    }
    let snap = null;
    try {
      snap = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(id)).then((r) => r.json());
    } catch (e) {
      return;   // 网络抖一下：下一拍再来
    }
    /* 这一拍卡在 fetch 里的时候主人可能已经切走了 —— 回来再判一次 */
    if (window.sessionId !== id) {
      window.stopFollow(id);
      return;
    }
    if (!snap || !Array.isArray(snap.items)) return;

    logSetLive(id, snap);
    renderLog();

    if (!snap.running) {
      window.stopFollow(id);
      finishTurn(id, snap, startedAt);
    }
  }, 1200);

  window.followingBySession.set(id, timer);
  window.following = timer;
}

/**
 * 这一轮结束了：把屏幕彻底交回给历史。
 *
 * 为什么要「等」：刚结束那一拍，写盘可能还没跟上（落盘的是半截）。
 * 这时候就按历史画，屏幕会永远停在那半截 —— 后面不会有人来补。
 * 所以每 700ms 再问一次，直到「历史里最后那条助手不比直播清单短」为止；
 * 最多 6 次（约 4 秒），还不齐就直接按历史画 —— 宁可用落盘的，
 * 也不用可能被压薄的直播。
 */
async function finishTurn(id, snap, startedAt) {
  try {
    window.turnsInFlight.delete(id);
    const nz = (s) => {
      try { return String(window.fixMojibake(String(s || '')) || '').replace(/\s+/g, ''); } catch (e) { return String(s || '').replace(/\s+/g, ''); }
    };
    let want = '';
    try {
      const lv = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(id)).then((r) => r.json());
      for (const it of (lv && Array.isArray(lv.items) ? lv.items : [])) {
        if (it && it.k === 'text') want += String(it.t || '');
      }
    } catch (e) {}
    const wantNz = nz(want).length;

    let turns = null;
    for (let k = 0; k < 6; k++) {
      if (window.sessionId !== id) return;
      const sel = await fetch('/api/sessions/select', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      }).then((r) => r.json()).catch(() => null);
      if (window.sessionId !== id) return;
      turns = (sel && sel.session && Array.isArray(sel.session.turns)) ? sel.session.turns : null;
      if (turns) {
        const as = turns.filter((t) => t && t.role === 'assistant' && !t.whale);
        const last = as.length ? nz(as[as.length - 1].text).length : 0;
        if (last >= wantNz) break;
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    if (window.sessionId !== id) return;
    /* 这一轮归历史：先换 state，再叫一次画。顺序反了就会被旧历史盖回去。 */
    if (turns) {
      logSetHistory(id, turns);
      logSetLive(id, null);
      renderLog({ force: true });
    }
  } catch (e) {
    try { console.warn('[finishTurn] 收尾对账失败（不影响屏幕，历史下次刷新会自己对齐）:', e && e.message ? e.message : e); } catch (e2) {}
  } finally {
    window.busy = false;
    try { window.hideSending(); } catch (e) {}
    try { window.syncSendBtn(); } catch (e) {}
    try { window.refreshSessions({ silent: true }).catch(() => {}); } catch (e) {}
    /* 断了流之后走这条旁路收尾时，插话还挂着 → 现在就该接着答 */
    if (window.pendingResume) {
      window.pendingResume = false;
      const t = String(window.lastInterjectText || '').trim();
      const sid = id;
      setTimeout(() => {
        window.resumeOrResend(sid, t).catch((e) => {
          window.busy = false;
          window.syncSendBtn();
          if (window.input && !window.input.value.trim() && t) { window.input.value = t; window.autosizeInput(); }
          window.addSysNote('⚠ 插的这句没接上：' + (e && e.message ? e.message : '未知错误') + '，已经放回输入框');
        });
      }, 30);
    }
    void startedAt;
  }
}

/**
 * 切回一个正在跑的会话：把「这一轮现在长什么样」摆到屏幕上。
 *
 * 原来这里拿着 rec.parts 一段一段画（addAssistantAuto / openThink / addTool /
 * addWhaleBubble）—— 那是**第二套画法**，而且它自己就有个坑：工具事件不断气泡，
 * 「正文→工具→正文」后面几段全灌进第一个气泡，正是「多段堆一块」的来源。
 *
 * 现在只做一件事：问服务端要快照，交给 store。
 */
export function replayInFlight(id) {
  const rec = window.turnsInFlight.get(id);
  /* 主人那句话：还没画过就补上（切走时它可能还在屏幕上，切会话后被清掉了） */
  try {
    if (rec && !rec.userDrawn && (rec.userText || (rec.userAttach && rec.userAttach.length))) {
      if (window.sessionId === id) {
        window.addUser(rec.userText || '', undefined, rec.userAttach && rec.userAttach.length ? rec.userAttach : undefined, undefined, undefined, rec.userIdentity);
      }
    }
    if (rec) rec.userDrawn = true;
  } catch (e) {}

  try {
    fetch('/api/chat/live?sessionId=' + encodeURIComponent(id))
      .then((r) => r.json())
      .then((live) => {
        if (!live || !Array.isArray(live.items)) return;
        if (window.sessionId !== id) return;      // 拉的过程中主人已经切走了
        logSetLive(id, live);
        renderLog({ force: true });
      })
      .catch(() => {});
  } catch (e) {}
  if (rec) rec.drawnParts = Array.isArray(rec.parts) ? rec.parts.length : 0;
  return true;
}

/**
 * 照盘上重画（删除 / 回退 / 编辑 / 分支 / 刷新费用 这些「用户操作」后面跟着叫）。
 *
 * 原来这里是 1100 行的 DOM 重建。现在只有一步：**把新历史塞进 state**。
 * 那些调用点想表达的意思本来就是「盘上变了，屏幕请对齐」——
 * 对齐这件事由 React 做，一百次都是同一个结果。
 */
export function renderTurns(turns, opts) {
  void opts;
  const sid = (typeof window.sessionId !== 'undefined' && window.sessionId) ? window.sessionId : LOG_STATE.sid;
  logSetHistory(sid, turns);
  renderLog({ force: true });
}

export async function switchSessionSafe(id, opts) {
  try {
    return await Promise.race([
      switchSession(id, opts),
      // 【2026-10-31 修】12 秒太短：186 个 turn 重画 + 260KB 解析真会超。
      // 慢不等于坏，宽限到 60 秒；真出错走下面的 catch，不打这儿的假失败。
      new Promise((r) => setTimeout(() => r(false), 60000)),
    ]);
  } catch (e) {
    console.warn('[switchSessionSafe] 切会话出错:', e && e.message ? e.message : e);
    window.releaseComposer();
    return false;
  }
}

export async function switchSession(id, opts) {
  // 换会话 = 换了一份历史，球的数必须跟着换（先清掉旧数字，别让上一份的残留骗人）
  /**
   * 【2026-10-26 主人报：批量删除开了之后，关掉会话、下次打开还是启用状态】
   *
   * bulkMode / picked 是纯内存变量，从来没人把它清掉，
   * 而 switchSession 一路走到底、最后 renderSessList() 又照着旧值把
   * 复选框和「删掉选中的 N 个」整个重画出来 —— 看着就像「记住了」。
   *
   * 批量删除是「我现在就要删一批」的临时动作，不是该常驻的模式。
   * 切会话就是换了一件事在做，顺手收掉最稳妥：
   * 不带着勾选跨会话（勾的都是上一个列表里的 id，留着反而容易删错）。
   * 注意必须在 start 就清，不能等 renderSessList 之后再清 ——
   * 那样中间会闪一下批量界面。
   */
  if (window.bulkMode || window.picked.size) {
    window.bulkMode = false;
    window.picked.clear();
    try {
      const bar = document.getElementById('sessBulkBar');
      if (bar) bar.hidden = true;
      const bb = document.getElementById('sessBulk');
      if (bb) bb.classList.remove('on');
      const sl = document.getElementById('sessList');
      if (sl) sl.classList.remove('bulk');
    } catch {}
  }

  /**
   * 【2026-11-05 修·附件跟着会话串味】
   *
   * 草稿是按会话存的（`xy.draft.<sid>`），附件却是全局一个数组：
   * 在 A 会话挑好一张图、切到 B，图还挂在输入框上面，一按发送就发进了 B。
   * 附件是「我现在要发的这个东西」，跟谁走就该是谁的 —— 切会话一律清掉。
   * 草稿文字仍然按会话留着，丢的只是那个还没发出去的附件，重新选一次比发错人强。
   */
  if (window.attachments.length) {
    window.attachments = [];
    try { window.renderAttachBar(); } catch {}
    try { window.syncSendBtn(); } catch {}
  }

  /**
   * 【2026-10-31 主人报：重启回来弹「没能自动回到上次的会话」，可人其实还在这个会话里】
   *
   * 病根两处：
   *   ① 上面 switchSessionSafe 是 12 秒硬砍，而 186 个 turn 的重画不是网络的活，
   *      超了照样砍 → 报「没能回去」，可数据早回来了，人看着就是自相矛盾。
   *   ② 这里 .then(x => x.json()) 把「解析」挂在超时保护外面，而且一有风吹草动
   *      就 catch 成 null，只往 console 打一行 —— 主人和我都看不见真正的原因。
   *
   * 现在：网络给 30 秒；解析单独兜住，失败时把原文前 200 字也带上，能一眼看出
   * 是服务端返了错页、还是数据太大解析崩了。
   */
  window.__switchGen++;
  const __switchGenSeen = window.__switchGen;
  const __t0 = performance.now();
  const __mark = (name) => {
    const ms = Math.round(performance.now() - __t0);
    console.log('[switchSession] ' + name + ' @ ' + ms + 'ms');
    try {
      fetch('/api/debug-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'switchSession', name, ms, sid: id }),
      }).catch(() => {});
    } catch {}
  };

  let __resp = null;
  try {
    __resp = await window.fetchTimed('/api/sessions/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }, 30000);
  } catch (e) {
    console.warn('[switchSession] 请求失败:', e && e.message ? e.message : e);
    return null;
  }
  __mark('响应头回来');

  let __raw = '';
  let r = null;
  try {
    __raw = await __resp.text();
    __mark('读完正文(' + __raw.length + '字符)');
    r = JSON.parse(__raw);
    __mark('解析完(' + (r && r.session && r.session.turns ? r.session.turns.length : 0) + '个turn)');
  } catch (e) {
    // 这里以前只会静静地返回 null，主人看到的就是「切不过去」却不知道为什么。
    const why = e && e.message ? e.message : String(e);
    console.warn('[switchSession] 响应解析失败:', why, '原文前 200 字:', String(__raw).slice(0, 200));
    try {
      fetch('/api/debug-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'switchSession', name: '解析失败 ' + why + ' 原文:' + String(__raw).slice(0, 120), ms: -1, sid: id }),
      }).catch(() => {});
    } catch {}
    return null;
  }
  if (!r || r.error) {
    // 打不开这个会话（多半是它已经被删了，或多个窗口共用同一目录时被别的窗口改掉了）。
    // 以前是静默 return，人看着就是"点了一下，会话没了/没反应"。现在说一句、并刷新列表。
    const why = r && r.error ? String(r.error) : '连不上服务';
    console.warn('[switchSession] 打不开会话', id, why);
    try {
      if (window.sessHint) {
        window.sessHint.textContent = why.includes('not found') ? '这个会话已经不在了，列表已刷新' : ('打不开：' + why);
        window.sessHint.classList.add('sessWarn');
        setTimeout(() => { try { window.sessHint.classList.remove('sessWarn'); } catch {} }, 4000);
      }
    } catch {}
    await window.refreshSessions({ silent: true });
    // 切不过去也别把输入区锁着
    window.releaseComposer();
    return false;
  }
  /* 【2026-11-02 串会话 · 第三道闸】
   *  拉历史这一段也可能很慢（186 个 turn 要几十毫秒甚至更久）。
   *  等回来时若主人已经又点开了第三个会话，这里再往下画就是拿旧会话的 turns 盖新屏幕。
   *  判据用一个只增不减的世代号：发起时记一份，回来时对不上就整段作废。 */
  /* 作废要返回 true —— 这不是「切失败」。主人已经切到别的会话去了，
   *  这一趟的活儿本来就该扔；返回 false 会让 bootSessions 以为连续三次没切过去，
   *  再弹出那句「刚才没能自动回到上次的会话」，等于凭空造一个错。 */
  if (__switchGenSeen !== window.__switchGen) return true;
  /* 【2026-11-03 修·切会话输入框串味】原来这里只给 sessionId 赋新值，
   *  从没碰过草稿：在 A 里打的字，切到 B 还留在输入框里（切回来又变成 B 的），
   *  等于草稿根本没按会话分开 —— 可 draftKey() 明明是按 sessionId 存的。
   *  修法：赋值前先把旧会话的打字存进它自己的格子，赋值后再把新会话的打字捞出来。 */
  try { if (typeof window.saveDraft === 'function') window.saveDraft(); } catch { /* 存不上也不许挡切换 */ }
  window.sessionId = r.session.id;
  window.sessionTitle = r.session.title;
  localStorage.setItem(window.STORE_KEY, window.sessionId);
  try { if (typeof window.restoreDraft === 'function') window.restoreDraft(); } catch { /* 恢复失败就当空白 */ }
  window.paintSessNow();
  window.paintMemoryFlag(r.memory); // 换会话，顶栏的记忆小字也要跟着换
  // 小鱼/小鲸在不在场也是按会话的 —— 但 2026-11-02 顶栏那两颗按钮删了之后，
  // 这件事只剩一处要看：左边「屋里的人」那列牌子（refreshWhoRail 会自己按
  // 新会话重读 /api/agents/group，服务端把 fish/whale 两套状态并进去了）。
  // 专业模式也按会话：切过去要重读，不然按钮还亮着上一个会话的状态
  // 办事模式同理，而且它还带着 worker 名册 —— 切会话必须重读
  try { if (typeof window.__reloadTaskState === 'function') window.__reloadTaskState(); } catch {}
  window.loadTopCfg(); // 左上角那两个框跟着换成本会话的设置
  /* 【2026-11-02 修·切回来自家会话，历史署名全变成上一个会话的人】
   * 病根在顺序：renderTurns 先把 578 条历史画出来，而它给每条气泡配署名时
   * 优先看这条消息自带的名字，老消息没存名字就退回全局 mainAgentName ——
   * 可这个全局变量要等 refreshAgentChip() 跑完才会改成「这个会话是谁」。
   * 于是画图时拿到的还是上一个会话的人名，满屏都是他。
   * 按 F5 重开就正常，正因为那时 chip 早就算完了。
   * 现在：画之前先把身份算准，算不出来也照画（不能因为一个名字卡住整屏）。 */
  try { if (typeof window.refreshAgentChip === 'function') await window.refreshAgentChip(); } catch { /* 名字算不出来也要画 */ }
  /**
   * 【2026-11-10 A4 清理】原来这里有句 window.hubReset()：
   * 切会话时把「还指着旧柜子的指针」断开。换 React 之后柜子没有指针了
   * （ToolGroup 照数据算，没有可搬移的节点），这句没有活儿干，删掉。
   */
  /* 【2026-11-08 修·自动重启后历史一条都不画】
   *
   * 主人报：「办事鱼做完自动重启后，只显示我说的一句以及她说的第一句话，
   * 后面其他说过的话都没了」。
   *
   * 数据其实全在：会话 265 条消息（97 条可见），服务端给了 95 个 turn / 10.8 万字符，
   * 前端日志也写着「解析完(95个turn)」——**是这一步没把它们画出来**。
   *
   * renderTurns 开头有一道保护：这个会话在 turnsInFlight 里（自动续跑已经开跑）
   * 且屏幕归属没变，就直接 return，DOM 交给流式那条路自己长。
   * 自动重启恰好撞上它：开机 8 秒后服务端就把续跑轮起起来了，前端来取历史时
   * 那一轮已经在跑 —— 于是整屏历史被跳过，屏幕上只剩续跑轮刚画的两条。
   *
   * 现在：屏幕本来就是空的（重启后的新窗口）→ 强制画历史。
   * 屏幕上已经有内容时保持原样，不打断正在流式的气泡。
   */
  const _emptyScreen = !(log && (log.querySelector('.msg') || log.querySelector('details.toolhub')));
  /* 【2026-11-08 修·「多段消息堆在一起」又回来了】
   *
   * 今天为了修「重启后历史不画」加了上面这个 force:true，可它只看了 DOM 空不空，
   * 没看这一轮有没有被流式接管。重启后 3 秒轮询会先把 turnsInFlight 记上、
   * 起 followLive 画新事件；这时 switchSession 再拿整份历史 force 重画一遍，
   * 两套画法叠在同一屏上 —— 就是主人说的「多段话又挤在一起」。
   *
   * 现在多一道：这一轮已经被流式接管了，就别再整屏强插，交给 followLive。
   * 屏幕空 + 没人在画，才强制补历史（那正是「重启后一片空白」要救的场景）。
   */
  const _inFlightHere = (() => {
    try { const r = window.turnsInFlight.get(window.sessionId); return !!(r && (r.startedAt || r.adopted)); }
    catch { return false; }
  })();
  /* 【2026-11-08 收口·切会话只做两件事：改 state、叫一次 renderLog】
   *
   * 这段原来自己算 dropTail、自己传 force —— 和 attachLive、followLive 各判一套。
   * 判错一次就是「切回来还画着上一个会话」（实测 45 条 → 切走 → 切回还是别人的）。
   * 现在屏幕归谁、这一轮归谁，全由 LOG_STATE + renderLog 一个地方决定。 */
  logSetHistory(window.sessionId, r.session.turns);
  renderLog({ force: true });
  /* 【2026-11-08】切会话：把**这个会话**的待发送队列读出来（按会话分 key 存的） */
  try { window.loadPendingQueue(); } catch (e) {}
  // 上下文球：这个会话用了多少 / 能装多少 / 累计 —— 换过来立刻问一次

  // 这个会话还在后台跑吗？
  // 先问服务端（窗口关过也能补回来），再退回本页内存里的记录。
  // 整段包 try：补画失败只是少一段内容，绝不能连累输入框。
  try {
    const liveRunning = typeof attachLive === 'function' ? await attachLive(window.sessionId) : false;
    if (!liveRunning) {
      const stillRunning = typeof window.turnsInFlight !== 'undefined' && window.turnsInFlight.has(window.sessionId);
      if (stillRunning && typeof replayInFlight === 'function') {
        replayInFlight(window.sessionId);
        window.busy = true;
        window.showSending();
      } else {
        /**
         * 【2026-11-01 修·切会话回来按钮变回【发送】】
         *
         * turnsInFlight 是本页面内存的 Map。切会话、Ctrl+F5 之后它一定是空的，
         * 所以「服务端明明还在跑」也会走到这个 else，把按钮打回【发送】、
         * 连「正在发送消息」也一起藏了 —— 主人报的正是这个。
         *
         * 现在不认内存了，直接再问一次服务端：
         *   running=true  → 锁着（按钮还是【停止】），并且接着跟直播
         *   running=false → 才放开
         */
        let _stillUp = false;
        try {
          const _l = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(window.sessionId)).then((x) => x.json());
          _stillUp = Boolean(_l && _l.running);
        /* 【2026-11-02 修·切过来看不到这轮已经吐出来的字】
         *
         * attachLive 内部已经把这一轮画过一遍了，并且按 drawnParts 记好了
         * 「画到第几个事件」，剩下的字由它挂的轮询接着长 —— 这里再叫一次
         * followLive 等于同一个会话起两条轮询，后一条会把前一条顶掉，
         * 起点还用的是 events.length（末尾），中间那一大段就永远画不出来了。
         */
        } catch {}
        if (_stillUp) {
          window.busy = true;
          window.showSending();
          try { window.syncSendBtn(); } catch {}
        } else {
          window.busy = false;
          window.hideSending();
          try { window.syncSendBtn(); } catch {}
        }
      }
    } else {
      /* 【2026-11-02 修·切换会话后按钮还是「发送」】       *       *  attachLive 返回 true 说明服务端这一轮确实还在跑，可这里原来只设了       *  busy 和「正在发送」，**漏了 syncSendBtn()** —— 于是输入框锁着、       *  那行小字也出来了，唯独按钮还停在【发送】。主人一点就是发新一轮，       *  服务端回 409，那句话就石沉大海。       *       *  别的分支（往上一行的 _stillUp、往下的 else）都调了这个，唯独这条主路径漏。       */
      window.busy = true;
      window.showSending();
      try { window.syncSendBtn(); } catch {}
    }
  } catch (err) {
    console.warn('[switchSession] 补画后台进度失败（不影响输入）:', err && err.message ? err.message : err);
    /**
     * 【2026-11-01 修 Ctrl+F5：补画失手 ≠ 这一轮跑完了】
     *
     * 原来这里无脑 busy=false + 藏「正在发送」。可补画失败的原因多半是
     * 「渲染时 DOM 出岔子」，跟「服务端还在不在跑」毫无关系。
     * 主人刷新时，服务端 running=True、缓存里 295 个事件，界面却因为这里
     * 把按钮变回【发送】—— 正是他报的那个现象。
     *
     * 现在改成：失败也再问一次服务端，它说在跑就保持锁着（按钮还是【停止】），
     * 剩下的字照样会通过 followLive 长出来。只有服务端明确说没跑，才放开。
     */
    try {
      const live2 = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(window.sessionId)).then((x) => x.json());
      if (live2 && live2.running) {
        window.busy = true;
        window.showSending();
        try { followLive(window.sessionId, Array.isArray(live2.events) ? live2.events.length : 0); } catch {}
      } else {
        window.busy = false;
        window.hidingSendingSafe();
      }
    } catch {
      window.busy = false;
      window.hidingSendingSafe();
    }
  }
  window.stopping = false;
  window.syncSendBtn();

  renderSessList();
  /**
   * 不管上面有没有抛错，输入区都收拾干净（这条是「删会话后点不了输入框」的根治）。
   *
   * 【这里不能用 settleComposer，它会把 busy 无条件清成 false】
   *   上面刚根据「服务端说这一轮还在跑吗」把 busy 设好（还在跑就是 true），
   *   紧接着 settleComposer 一调，busy 又被清成 false ——
   *   按钮从「停止」变回「发送」，主人一按就是发新一轮，撞 409，消息发不出去。
   *   主人报的「切回来她就停了、发不出话」就是这个。
   *
   *   closeSessPanel 只做该做的事：收面板、放开输入框、还焦点，一个 busy 都不碰。
   *   （settleComposer 的注释里也写着这一条，只是这个调用点以前漏改了。）
   */
  window.closeSessPanel();
  if (typeof window.input !== 'undefined' && window.input) {
    try { window.input.disabled = false; window.input.readOnly = false; if (window.input.dataset) delete window.input.dataset.locked; } catch {}
  }
  // focus:false 的理由跟以前一样：切会话时人不一定想打字，抢焦点会把输入法冲回英文。
  return true;
}

/* 经典脚本（index.html 里那段）还要按名字直接调这些函数 ——
   模块有独立作用域，不挂回 window 它们就找不到了。 */
Object.assign(window, {
  logSettle, logSetHistory, logBeginTurn, logSetLive, logHistoryFp, renderLog,
  attachLive, followLive, replayInFlight, renderTurns, switchSessionSafe, switchSession,
});
