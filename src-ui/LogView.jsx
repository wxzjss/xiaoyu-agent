import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getSnapshot, getVersion, setWindowStart, subscribe } from './store.js';
import { buildMerged } from './items.js';
import UserBubble from './UserBubble.jsx';
import AssistantBubble from './AssistantBubble.jsx';
import MateBubble from './MateBubble.jsx';
import ThinkBlock from './ThinkBlock.jsx';
import WorkerCard from './WorkerCard.jsx';
import TeamBar, { teamStopWorker } from './TeamBar.jsx';
import SysNote from './SysNote.jsx';
import FileCard from './FileCard.jsx';
import { ToolGroup } from './ToolCard.jsx';
import RowBoundary from './RowBoundary.jsx';

/** 一行里最后那段文字有多长（滚动 effect 要跟着它走：流式吐字不增条目也在长） */
function tailLen(items) {
  if (!items || !items.length) return 0;
  const it = items[items.length - 1];
  if (!it) return 0;
  if (Array.isArray(it.bubbles)) return it.bubbles.join('').length;
  return String(it.text || '').length;
}

/**
 * 这个 item 属于「哪一段活」。
 *
 * 【2026-11-11 加·分组不许跨消息】
 *
 * 把 think 和 tool 收成一串之后，光按「相邻」分组还不够 —— 历史里一条 turn 的
 * 数据顺序是 `思考 → 她的正文 → 工具`（见 items.js 的 turnToItems），
 * 于是「上一轮的工具」和「下一轮的思考」在清单里是**相邻**的，会被折进同一个柜子：
 * 实测 ⑤b 那个形状（两条 assistant turn 各带 reasoning + text + tools）就是
 * 柜子里装着「上一轮的工具 + 下一轮的思考」，而上一轮自己的思考反而孤零零在外面。
 * 柜子的语义是「一段活」，跨了消息就不是一段活了。
 *
 * key 里本来就带着归属（items.js：历史 `t-<轮次>-…`、直播 `l-<下标>`），
 * 所以直接读出来当边界；读不出来的（乐观气泡 p- / 系统提示 n-）返回空串 = 不设边界。
 */
function turnTagOf(it) {
  const k = String((it && it.key) || '');
  const m = /^(t-\d+)(?:-|$)/.exec(k);
  if (m) return m[1];
  if (/^l-\d+$/.test(k)) return 'live';
  return '';
}

/**
 * 把「只有思考」的那一行并进**同一轮**的工具柜。
 *
 * 【2026-11-11 加·为什么非要挪】
 *
 * 主人要的是「思考链内容在柜子里」。可历史里一条 turn 的顺序是
 * `思考 → 正文 → 工具`：思考在她的话**上面**，工具在她的话**下面**，
 * 中间隔着一条 assistant 气泡 —— 只要不挪，思考永远进不了自己那一轮的工具柜，
 * 屏幕上就还是「思考块 / 她的话 / 柜子」三块，柜子依旧夹在两条思考之间。
 *
 * 所以：一段「只有思考」的行，只要后面**同一轮**（tag 相同、中间只隔着这一轮自己的
 * 正文/文件）还有一条带工具的柜子，就把这堆思考挪到那个柜子的最前面。
 * 挪完屏幕上的节奏就是「主人的话 → 一个柜子（思考 + 工具）→ 她的回答」。
 *
 * 三条安全线：
 *   · 只对历史（`t-<n>`）生效 —— 直播 `l-<n>` 的 key 不带轮次，不动它（直播本来就是
 *     思考/工具交替、天然相邻，挪了反而打乱她正在干活的实时顺序）；
 *   · 中间只要出现**别的轮次**或者主人/别人说的话，立刻放弃（不跨消息）；
 *   · 那一轮压根没调工具 —— 思考照旧独立显示（柜子里只有内心戏没意义）。
 */
function hoistTurnThinks(rows) {
  const drop = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.type !== 'group' || drop.has(r)) continue;
    const tag = r.tag || '';
    if (!/^t-\d+$/.test(tag)) continue;
    if (r.items.some((x) => x && x.kind === 'tool')) continue;   // 本身就是柜子，不用挪
    for (let j = i + 1; j < rows.length; j++) {
      const n = rows[j];
      if (!n || drop.has(n)) continue;
      const nTag = n.type === 'group' ? (n.tag || '') : turnTagOf(n.it);
      if (nTag !== tag) break;                                   // 出了这一轮，收手
      if (n.type !== 'group' || !n.items.some((x) => x && x.kind === 'tool')) continue;
      n.items = r.items.concat(n.items);
      drop.add(r);
      break;
    }
  }
  return drop.size ? rows.filter((r) => !drop.has(r)) : rows;
}

/**
 * 把 item 清单折成「一行一行要画的东西」：
 *   · 连续的「思考块 / 工具卡」→ 一个柜子（跟原来「话—柜子—话—柜子」的节奏一致）
 *   · 每条 assistant 记住「它前面最近的那句主人话」，重发按钮要用
 *
 * 【2026-11-11 改·主人问「柜子为什么夹在思考链中间，而不是夹在消息中间」】
 *
 * 以前这里只把**连续的 tool** 收成一个柜子，思考块（think）一出现就把这串打断。
 * 可直播事件和落盘历史里的顺序常常是：
 *     思考1 → 工具A → 思考2 → 工具B → 她的话
 * 于是每一段「思考夹着一次工具」都成了一个独立的小柜子，屏幕上看着就是
 * 「柜子夹在思考链中间」，一段活被切得七零八落。
 *
 * 现在把 think 和 tool 一起收进同一串：一段活 = 一个柜子（思考折在柜子里），
 * 柜子整体摆在「主人的话」和「她的回答」之间。只有真的一个工具都没有时，
 * 思考块才照旧单独画（柜子里全是思考没意义，见 ToolGroup 里的分派）。
 *
 * 分组的两条补充规矩（都在下面两个函数里）：
 *   · 一段活不跨消息（turnTagOf 当边界，见 hoistTurnThinks 上面那段）；
 *   · 同一轮里「思考在她的话上面、工具在她的话下面」时，把思考挪进那个柜子。
 */
function toRows(items) {
  const rows = [];
  let run = null;
  let lastAsk = null;
  for (const it of items) {
    if (it.kind === 'tool' || it.kind === 'think') {
      const tag = turnTagOf(it);
      /**
       * 【2026-11-11 再修·主人报「柜子突然没了、工具全跑出来了」】
       *
       * 上一版把「轮次变了」一律当边界，结果把**同一段活**切碎了：
       * 干活时一条 assistant 常常只装一次工具调用（没有正文、没有思考），
       * 落盘后就是 `tool(A) / tool(B) / tool(C) …` 一路相邻 —— 它们本来就是一段活，
       * 却因为分属不同 turn 被切成一堆「单工具」→ 单工具不成柜 → 屏幕上全是裸卡。
       * 实测「小鲸鱼」那个会话：185 条 assistant 里 168 条是「1 个工具、无正文、无思考」，
       * 按轮次切之后 168 张裸卡，一个柜子都成不了。
       *
       * 真正需要切的只有一种形态：**下一轮的思考**。
       * 历史里一条 turn 的顺序是 `思考 → 正文 → 工具`（items.js 的 turnToItems），
       * 所以「上一轮的工具」和「下一轮的思考」在清单里相邻 —— 那才是跨消息。
       * 工具之间即便跨 turn 也照旧并进同一个柜子（那正是「一段活」的形状）。
       */
      if (run && it.kind === 'think' && tag && run.tag && tag !== run.tag) run = null;
      if (run) run.items.push(it);
      else {
        run = { type: 'group', key: 'hub-' + it.key, tag, items: [it] };
        rows.push(run);
      }
      continue;
    }
    run = null;
    if ((it.kind === 'user' || it.kind === 'mate') && !it.isLive) {
      lastAsk = { at: it.rewindId, text: it.text };
    }
    rows.push({ type: 'item', key: it.key, it, ask: lastAsk });
  }
  return hoistTurnThinks(rows);
}

/**
 * 对话区本体。
 *
 * 整个 #log 的内容只由这个组件画 —— 屏幕 = f(turns, liveItems)，
 * 没有第二条写 DOM 的路（规格 4.1）。
 */
export default function LogView() {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  const snap = getSnapshot();
  const merged = useMemo(() => buildMerged(snap), [snap.sid, snap.turns, snap.live, snap.pendingUser, snap.notes, snap.windowStart]);
  const rows = useMemo(() => toRows(merged.items), [merged]);

  const listRef = useRef(null);
  const atBottomRef = useRef(true);
  /* 【贴底的真正判据】主人**自己**动过滚轮/摸过屏/按过方向键之后，位置才归他；
   * 在那之前，屏幕永远跟着最新一条走 —— F5 之后停在半路那种事就是这么来的：
   * 重画一瞬间高度变矮、浏览器把 scrollTop 夹小，滚动事件一响就被当成「他在往上翻」，
   * 从此再也不跟随。（实测离底 251px 那个数就是这么攒出来的。） */
  const userScrolledRef = useRef(false);
  /* 【2026-11-11 加·收缩防误清】上一发 scroll 事件时的高度 / 离底距离。
   * 用它们认出「内容收缩把 scrollTop 夹出来的那发 scroll」—— 那不是主人滚的，
   * 不能拿它改账（否则翻历史的状态会被一次收缩偷走）。 */
  const lastHeightRef = useRef(0);
  const lastDistRef = useRef(0);
  /* 【2026-11-11 加·重画锚点】整屏重画（发消息/轮次收尾）会把 DOM 换一遍，
   * 浏览器在换的瞬间把 scrollTop 夹成 0 —— 主人正在看的那段直接飞到顶上
   * （「发消息后弹到很久以前的位置」就是它）。这里持续记着主人最后停在哪，
   * 重画完把他还回去。 */
  const lastScrollTopRef = useRef(0);
  const keepFromBottom = useRef(null);
  /**
   * 【2026-11-11 再修·还原位置的锚点不能慢半拍】
   *
   * 上面那个 lastScrollTopRef 是 onScroll 记的，而 **scroll 事件要到下一帧才派发**；
   * 流式内容一到，React 当场同步重画并跑 useLayoutEffect —— 那一刻记账还停在
   * 「上一帧的位置」。主人刚往上滚了 5px，effect 一看视口不在这笔账上，
   * 就当成「被重画夹掉了」把他还原回去 = 每一格上滚都被弹回最新 → 「不断抖动」。
   * （探针逐帧抓到的就是它：roll 5px 之后 1ms 有一笔 scrollTop 写回 scrollHeight，
   *   调用栈落在 React commit → 这个 effect，不是 pin。）
   *
   * render 阶段（React 还没换 DOM）读到的 scrollTop 才是他真正停的地方 ——
   * 滚轮一滚浏览器当场就把 scrollTop 改了，不等 scroll 事件。
   */
  const preSwapScrollTop = useRef(0);
  /**
   * 【2026-11-12 加·区分「我自己写的 scrollTop」和「主人滚的」】
   *
   * 每次程序性写入都把目标值记在这儿；onScroll 看到 scrollTop 落在它附近，
   * 就知道这一发是自己造成的 —— 只同步账本，不改「他在翻历史」的意图。
   * 不这么记的话：换屏复位 / 收缩 clamp 之后我们自己那一发写入会被判成
   * 「他往上滚了」，从此不再跟随最新消息（收尾后停在离底 87px 那个 bug）。
   */
  const selfWriteRef = useRef(0);
  /**
   * 【2026-11-12 加·「要不要跟着最新消息走」只由他的动作决定】
   *
   * 以前这件事靠 atBottomRef（离底 <= 8px）。可那个数会被**内容长高**改掉：
   * 内容「先刚好铺满视口（335=clientHeight）、再长到 454」时，中间没有任何 scroll 事件，
   * 等到下一发 scroll 到来时 d 已经是 119 → atBottom=false → pin 从此不贴底，
   * 屏幕就停在顶部（实测：收尾后离底 119px，最新一条压在视口下面）。
   *
   * 所以单独记一笔「跟随意图」：
   *   · 默认 true（新开屏、换会话都是「跟着最新」）；
   *   · 只有**他主动往上翻**（滚轮朝上 / ↑ PageUp Home / 触屏上划）才置 false；
   *   · 他自己滚回底部（scroll 后 d <= 8 且这一发不是往上走）就恢复 true。
   * 内容长高、收缩 clamp、我们自己写 scrollTop —— 一律不动这笔账。
   */
  const followRef = useRef(true);
  const writeTop = (v) => {
    const el = listRef.current || document.getElementById('log');
    if (!el) return;
    const want = Number(v);
    if (!Number.isFinite(want)) return;
    selfWriteRef.current = want;
    try { el.scrollTop = want; } catch (e) {}
  };

  /* #log 是页面里现成的那个容器（React 只接管它的内容） */
  if (!listRef.current) listRef.current = document.getElementById('log');
  /* 只在「位置归主人」的时候读 —— 跟随最新时根本用不上这笔账，
   * 少一次强制布局（流式吐字每帧都在 render）。 */
  if (userScrolledRef.current && listRef.current) {
    const t = listRef.current.scrollTop;
    if (typeof t === 'number' && t >= 0) preSwapScrollTop.current = t;
  }

  /* 是不是贴着底：只认「用户真的往上滚了」 */
  useLayoutEffect(() => {
    const el = listRef.current || document.getElementById('log');
    if (!el) return;
    listRef.current = el;
    atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
    const dist = () => el.scrollHeight - el.scrollTop - el.clientHeight;
    lastHeightRef.current = el.scrollHeight;
    const onScroll = () => {
      const h = el.scrollHeight;
      const d = dist();
      const st0 = el.scrollTop;
      /**
       * 【2026-11-12 加·先认出「这一发是我自己写出来的」】
       *
       * pin / 滚动 effect / 换屏复位都会写 `scrollTop`，浏览器随后同样发一条 scroll 事件。
       * 那条事件以前会被当成「主人往上滚了」——判据是 `st < lastScrollTopRef`（见下面 wentUp）：
       *   · 换屏时我们写 `scrollTop = scrollHeight`，但 `lastScrollTopRef` 还停在上一个会话的
       *     小值上 → 这一发被误判成「他往上滚」；
       *   · 长屏换短屏时浏览器把 scrollTop 夹小（shrank 分支不记账），
       *     `lastScrollTopRef` 留在旧的大值 → 紧接着我们自己的 `scrollTop = scrollHeight`
       *     那一发又被判成「往上滚」→ `userScrolledRef=true / atBottomRef=false` → 从此不跟随
       *     （探针实测：收尾后停在离底 87px，最新一条压在视口下面，得手动滚一下才恢复）。
       *
       * 所以每次程序性写入都把「我写的那个值」记下来（`selfWriteRef`），
       * 对应的那发 scroll 只同步账本、不改「他在翻历史」的意图。
       */
      if (selfWriteRef.current > 0 && Math.abs(st0 - selfWriteRef.current) <= 1) {
        selfWriteRef.current = 0;
        lastHeightRef.current = h;
        lastDistRef.current = d;
        lastScrollTopRef.current = st0;
        atBottomRef.current = d <= 8;
        try { window.paintToBottom && window.paintToBottom(); } catch (e) {}
        return;
      }
      /* 【2026-11-11 修·收缩引起的滚动不算数】两发 scroll 之间高度变矮了
       * （折叠收起、流式重画换了个更矮的节点），浏览器会把 scrollTop 夹小
       * 并发出 scroll 事件 —— 这一发不是主人滚的。此刻 d 可能短暂变得很小，
       * 照常记账的后果：atBottomRef 被写成 true → 下一次 pin/effect 就贴底；
       * userScrolledRef 被清 → 「他在翻历史」的账被偷。所以高度变矮期间
       * 一律不记账，主人的状态一个字都不动。 */
      const shrank = h < lastHeightRef.current;
      lastHeightRef.current = h;
      if (shrank) {
        /* 【2026-11-12 补】但锚点必须跟着夹小后的位置走 —— 否则下一发「我自己写的」
         * scroll 会拿夹之前的旧大值去比，被判成「他往上滚了」（就是上面那段说的 87px）。 */
        lastScrollTopRef.current = st0;
        lastDistRef.current = d;
      }
      if (!shrank) {
        /**
         * 【2026-11-11 再修·「8px 以内的上滚仍然被拽回」的真正根因】
         *
         * 上一版把阈值 24 → 8，只解决了「滚 20px 被弹回」。
         * 可 8px 以内的上滚还是同一个病，而且**光改 wheel handler 治不好**：
         * onWheel 确实把 atBottomRef 置成了 false，但浏览器紧接着为这一发滚轮
         * 发出的 **scroll 事件**又跑回这里，用 `d <= 8` 把它写回 true。
         * 于是 pin / 滚动 effect 一看「在底部」，立刻把屏幕拽回最新 ——
         * 主人手指还在往上滚，每一格都被拽一次，看着就是「不断抖动」。
         *
         * 探针逐帧抓到的正是这一刻（_t_scroll_jitter.mjs 场景 A2）：
         *   滚轮上移 5px → 5ms 后有一笔 scrollTop 写回 scrollHeight。
         *
         * 所以判据不能只看「离底多远」，必须看 **scrollTop 往哪边动**：
         *   · scrollTop 变小 = 视口在往更早的内容走 = 他不想贴底，不管只走了 1px；
         *   · d 变大还有另一种来源（内容长高，scrollTop 一点没动），那种绝不能误判。
         */
        const st = el.scrollTop;
        const wentUp = st < lastScrollTopRef.current - 0.5;
        atBottomRef.current = wentUp ? false : (d <= 8);
        /* 往上走这一下本身就是「他自己动的手」，记账（收缩 clamp 不会走到这里） */
        if (wentUp) userScrolledRef.current = true;
        /* 滚回底部就复位「在翻历史」——但只认「连续两次都贴底」：
         * 单独一发 d 很小的 scroll 可能是收缩夹出来的，不许凭它清账。
         * 刚往上走过（wentUp）更不能清：那一发 d 天然就小。 */
        const prevDist = lastDistRef.current;
        lastDistRef.current = d;
        if (!wentUp && d <= 8) followRef.current = true;
        if (!wentUp && d <= 8 && prevDist <= 8) userScrolledRef.current = false;
        lastScrollTopRef.current = st;
      }
      /* 【2026-11-11 修·跳底按钮】滚动位置变化要驱动右下角按钮的显隐/未读清零。
       * 原来只有 noteNewContent/bumpUnseen/jumpToBottom 三个调用点，没有 scroll 监听 ——
       * 人滚回底部后按钮和角标还挂着，且往上滚远时按钮从不出现。 */
      try { window.paintToBottom && window.paintToBottom(); } catch (e) {}
    };
    /* 只有这几种「他自己动手」的动作才把人标记成「在翻历史」 */
    const onUserIntent = () => { userScrolledRef.current = true; selfWriteRef.current = 0; };
    /* 触屏上划：先停跟随；滚回底部 onScroll 会恢复 */
    const onTouchMove = () => { userScrolledRef.current = true; selfWriteRef.current = 0; followRef.current = false; };
    /**
     * 【2026-11-11 修·主人报「小幅往上滚会不断抖动、把我拉回最新消息」】
     *
     * 上一版把阈值从 24px 收到 8px，解决了「滚 20px 就被弹回」；
     * 但**8px 以内的上滚**还有同一个病：那一发 scroll 里 d 仍 <= 8，
     * atBottomRef 被写成 true → 下面的 pin（内容一变就贴底）立刻执行 →
     * 屏幕弹回底部；弹回底部又发一发 scroll（d=0）→ 更容易判成贴底。
     * 主人看到的就是「抖动 + 被拽回最新」。
     *
     * 判据本来就不该只看距离：**用户往上滚**这件事本身就是「他不想贴底」的最强信号，
     * 不管只滚了 1px 还是 20px。所以滚轮/键盘方向键往上 → 当场取消「在底部」，
     * 不等那一发 scroll 的 d 值。滚回底部时 onScroll 会再把 atBottom 置回 true
     * （连续两次贴底还会清掉「在翻历史」的账），跟随自然恢复。
     */
    /**
     * 【2026-11-11 加·柜子/思考框内部滚动，不许算成「他去翻聊天记录」】
     *
     * wheel 事件是从子节点冒泡上来的：#log 里既有柜子内容区（.hubBody，340px 内部滚），
     * 也有思考框（.thinkBody，320px 内部滚），还有工具结果（pre）。
     * 人只是在柜子里往上滚看卡，事件一样会到 #log —— 以前就直接把聊天区标成
     * 「他在翻历史」，于是聊天区不再跟随最新消息（看着像「滚了柜子聊天就不动了」）。
     * 现在：事件目标落在「内部真能滚的那个盒子」里就整条忽略，交给它自己滚
     * （那两个盒子都上了 overscroll-behavior: contain，滚到边也不会传给聊天区）。
     */
    const fromInnerScroller = (e) => {
      try {
        const t = e && e.target;
        if (!t || t === el || !el.contains(t)) return false;
        const box = t.closest && t.closest('.hubBody, .thinkBody, details.tool > pre');
        if (!box) return false;
        return box.scrollHeight > box.clientHeight + 1;
      } catch (err) { return false; }
    };
    const onWheel = (e) => {
      if (fromInnerScroller(e)) return;      // 内部滚自己的，别惊动聊天区
      selfWriteRef.current = 0;              // 他动手了：作废「我自己写的」那个标记
      userScrolledRef.current = true;
      /* deltaY < 0 = 往上（看更早的内容）。触控板惯性里也有 deltaY>0 的帧，别误伤 */
      if (e && Number(e.deltaY) < 0) { atBottomRef.current = false; followRef.current = false; }
    };
    const onKey = (e) => {
      if (fromInnerScroller(e)) return;
      selfWriteRef.current = 0;
      userScrolledRef.current = true;
      const k = e && e.key;
      if (k === 'ArrowUp' || k === 'PageUp' || k === 'Home') { atBottomRef.current = false; followRef.current = false; }
    };
        el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: true });
    el.addEventListener('pointerdown', onUserIntent, { passive: true });
    el.addEventListener('keydown', onKey);

    /**
     * 【贴底要跟着「内容后来才长高」走】
     *
     * 只靠 [条数, 末段字数] 那一发滚动 effect 是不够的：markdown 画完、
     * 图片加载完、字体换行都会在**渲染之后**把高度再撑开一截 ——
     * 那时候没人再看一眼，画面就停在离底几百像素的地方
     *（实测 F5 之后停在离底 251px，正是量出来的这个差）。
     *
     * 这里盯 #log 子树的任何变化（含文本变长），在下一帧补一次贴底。
     * 只在「本来就贴底」时补 —— 主人往上翻的时候一根手指都不许动。
     */
    let pending = false;
    const pin = () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        /**
         * 【2026-11-12 修·收尾后停在离底 119px（最新一条压在视口下面）】
         *
         * 原来这里还要「他没自己滚过」那笔账 —— 可那个账很容易被误置成 true：
         * 内容「先刚好铺满视口、再长高」时，期间那几发 scroll（浏览器 clamp /
         * 我们自己的写入）里只要有一发被判成「他往上滚了」，pin 从此就再也不贴底。
         * 探针实测账本：atBottom=false / userScrolled=true / lastH=335（正好等于视口高）
         * / self=99（一次没落地的程序写入残留），内容长到 454 之后屏幕就停在顶部。
         *
         * 判据其实只需要一条：**此刻是不是贴着底**。
         *   · 真贴底 → 内容一变就跟着长（跟原来一样）；
         *   · 他往上翻了 → onScroll 距离一超过 8px 就把 atBottom 置 false，
         *     这里什么都不做，「别动人正在看的位置」这条规矩没变。
         */
        if (!followRef.current) return;
        try { writeTop(el.scrollHeight); } catch (e) {}
      });
    };
    let mo = null;
    try {
      mo = new MutationObserver(pin);
      mo.observe(el, { childList: true, subtree: true, characterData: true });
    } catch (e) { /* 观察不到就算了，上面那发 effect 还在 */ }
    /* 容器自己的高度也会变（「正在发送消息」那条小字出现/消失、附件条收起…），
     * 那一下不会触发 MutationObserver —— 单独盯它。 */
    let ro = null;
    try {
      ro = new ResizeObserver(pin);
      ro.observe(el);
    } catch (e) { /* 老浏览器没有就算了 */ }

    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('pointerdown', onUserIntent);
      el.removeEventListener('keydown', onKey);
      try { if (mo) mo.disconnect(); } catch (e) {}
      try { if (ro) ro.disconnect(); } catch (e) {}
    };
  }, []);

  /* 长会话才开「屏幕外不算」（content-visibility），短会话不动它 */
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    try { el.classList.toggle('long-list', merged.totalTurns > 150); } catch (e) {}
  }, [merged.totalTurns]);

  /**
   * 【2026-11-12 加·换屏必须把「滚动的账」清零（主人报的那一串切会话症状的根）】
   *
   * 这个组件是**单例**：切会话只换 store 里的数据，LogView 不重建 → 上面那些 ref
   * （atBottomRef / userScrolledRef / lastScrollTopRef / preSwapScrollTop /
   *   keepFromBottom）全都带着**上一个会话的状态**进到新会话：
   *
   *   · 在 A 翻到中间 → `userScrolledRef=true`、`atBottomRef=false`；
   *     切到 B 之后 `pin()` 一看「他自己滚过、而且不在底部」→ 一根手指都不动，
   *     滚动 effect 也走「还原位置」那一支，把视口摆到 `preSwapScrollTop`
   *     （A 的 scrollTop！）—— 于是 B 落在半路、再也不跟随最新消息。
   *     探针（scripts/_t_switch_probe.mjs 一）实测：切到 B 之后离底 **720px** 恒定不动，
   *     B 里来新内容也只是把 720 变成 792（内容长高，视口没动）。
   *   · `keepFromBottom` 还留着上一屏「再往前看」的中间值 → 补历史那个 effect
   *     会把新会话的视口按那个距离重新摆一次 —— 位置随机。
   *
   * 换屏的正确语义只有一条：**新会话从底部开始、跟着最新消息走**。
   * 所以这里把五笔账全部清零，并直接把视口摆到底。
   *
   * 放在滚动 effect 之前声明 = 同一次提交里先跑（useLayoutEffect 按声明顺序执行），
   * 后面的滚动 effect 就不会拿旧的锚点去还原位置了。
   */
  const sidRef = useRef(null);
  useLayoutEffect(() => {
    const el = listRef.current || document.getElementById('log');
    if (!el) return;
    listRef.current = el;
    const prev = sidRef.current;
    sidRef.current = snap.sid;
    /* 首帧（prev 还是 null）不用动：下面那个滚动 effect 本来就会贴底 */
    if (prev === null || prev === snap.sid) return;
    atBottomRef.current = true;
    followRef.current = true;
    userScrolledRef.current = false;
    lastDistRef.current = 0;
    preSwapScrollTop.current = 0;
    keepFromBottom.current = null;
    try { writeTop(el.scrollHeight); } catch (e) {}
    /* 自己这一发写入也会来一条 scroll 事件：把「上一次的位置/高度」记成写完之后的值，
     * 否则那一发会被当成「他往上滚了」（st 比旧值小）而把 atBottom 打回 false。 */
    lastHeightRef.current = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
  }, [snap.sid]);

  const count = merged.items.length;
  const lastLen = tailLen(merged.items);

  /**
   * 滚动（规格 4.4）：只有这一处写 scrollTop。
   *
   * 不再有 stickBottom / hardScrollBottom / 锚点补偿 —— 那些都是为了对冲
   * 「先删后建造成的高度骤降」。现在节点按 key 复用，高度只会因为真的多了内容而变，
   * 贴底就跟着长，不贴底就一动不动。
   */
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    if (keepFromBottom.current != null) return;   // 补历史时由下面那个 effect 接管
    if (followRef.current) {
      writeTop(el.scrollHeight);
      return;
    }
    /* 【2026-11-11 修·重画把人甩到顶上】真在翻历史的人：整屏重画换 DOM 的瞬间
     * 浏览器把 scrollTop 夹成 0，画面就跳到最老的消息 —— 主人报的「发消息后
     * 弹到很久以前」正是这条。现在把他还回他刚才看的地方（往底部加新内容
     * 不挪旧内容的位置，所以按 scrollTop 还原是准的）。
     *
     * 【2026-11-11 再修】锚点用 preSwapScrollTop（render 阶段读的），不用
     * lastScrollTopRef（onScroll 记的，慢一帧）—— 见那个 ref 上面的长注释。 */
    try {
      const want = preSwapScrollTop.current;
      if (want > 0 && Math.abs(el.scrollTop - want) > 4) writeTop(want);
    } catch (e) {}
    /* 只更新「底下多了几条」那颗提醒 */
    try { if (window.noteNewContent) window.noteNewContent(); } catch (e) {}
  }, [count, lastLen]);

  /* 「再往前看」：补完把视口还到「离底同样的距离」，一像素都不跳 */
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || keepFromBottom.current == null) return;
    writeTop(el.scrollHeight - keepFromBottom.current);
    keepFromBottom.current = null;
  }, [merged.start]);

  const onLoadEarlier = () => {
    const el = listRef.current;
    if (el) keepFromBottom.current = el.scrollHeight - el.scrollTop;
    setWindowStart(snap.sid, Math.max(0, merged.start - 100));
  };

  const lastItem = merged.items.length ? merged.items[merged.items.length - 1] : null;

  return (
    <>
      {merged.start > 0 ? (
        <button type="button" className="loadEarlier" onClick={onLoadEarlier}>
          {'↑ 再往前看 100 轮（还有 ' + merged.start + ' 轮没显示）'}
        </button>
      ) : null}
      {rows.map((r) => (
        /**
         * 【2026-11-12 加·行 key 带上会话身份】
         *
         * item key 只有轮次绝对下标（`t-81-tl0` / `hub-t-81-tl0`），两个会话的
         * 同号轮次完全一样。React 按 key 复用组件实例，于是切会话时**这一行不会重建**：
         * 它的 `useState`（useOpen 的展开态、WorkerCard 的展开…）原样留着，
         * `useOpen` 的初值也不会重新从 openMap 读 —— 主人看到的就是
         * 「B 里第 81 轮的柜子自己开着」（探针三 复现）。
         *
         * 加上 sid 前缀之后，换屏时每一行都是新实例：展开态从 openMap 重新读
         * （那边已经按会话分账），别的一并归零。sid 不换时 key 不变，不影响重渲染复用。
         */
        <RowBoundary key={snap.sid + '\u0000' + r.key}>{renderRow(r, merged.running, lastItem, snap.sid)}</RowBoundary>
      ))}
      {/* 【团队模式】顶部轻提示 + 流外的 running 卡（按 wid 与流内去重） */}
      <TeamBar sid={snap.sid} items={merged.items} />
    </>
  );
}

/**
 * 一行 → 一个组件。
 *
 * 【抽出来的理由】每一行都套一层 RowBoundary（见那个文件顶上的说明）——
 * 换 React 之后，「一条坏数据毁掉整屏」这件事必须堵掉。
 */
function renderRow(r, running, lastItem, sid) {
  {
        if (r.type === 'group') return <ToolGroup items={r.items} />;
        const it = r.it;
        if (it.kind === 'user') return <UserBubble it={it} />;
        /* 'say' 是服务端 items 里的「别人说的话」，'mate' 是历史里 role:user 带 who 的老数据，
         * 两种都画成同一个气泡（MateBubble）—— 少了这一支，小鲸说的话会整段消失。 */
        if (it.kind === 'say' || it.kind === 'mate') return <MateBubble it={it} ask={r.ask} />;
        if (it.kind === 'assistant') {
          /* 光标只亮在「这一轮最后那段、而且是直播那份」上 */
          const streaming = Boolean(running && it.isLive && lastItem && lastItem.key === it.key);
          return <AssistantBubble it={it} ask={r.ask} streaming={streaming} />;
        }
        if (it.kind === 'think') return <ThinkBlock it={it} />;
        /* 【团队模式】跑着的卡带上「停掉」；历史收尾卡没有这个按钮 */
        if (it.kind === 'worker') {
          return (
            <WorkerCard
              it={it}
              onStop={sid && it.status === 'run' ? (wid) => { teamStopWorker(sid, wid); } : undefined}
            />
          );
        }
        if (it.kind === 'note') return <SysNote it={it} />;
        /* 她发的文件（A2 收编后）：独立一行，跟工具卡一个节奏 */
        if (it.kind === 'file') return <FileCard it={it} />;
        return null;
  }
}
