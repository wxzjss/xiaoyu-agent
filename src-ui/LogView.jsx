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
      /* 换了轮次就不再往同一个柜子里塞（tag 读不出来的不当边界） */
      if (run && tag && run.tag && tag !== run.tag) run = null;
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

  /* #log 是页面里现成的那个容器（React 只接管它的内容） */
  if (!listRef.current) listRef.current = document.getElementById('log');

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
      /* 【2026-11-11 修·收缩引起的滚动不算数】两发 scroll 之间高度变矮了
       * （折叠收起、流式重画换了个更矮的节点），浏览器会把 scrollTop 夹小
       * 并发出 scroll 事件 —— 这一发不是主人滚的。此刻 d 可能短暂变得很小，
       * 照常记账的后果：atBottomRef 被写成 true → 下一次 pin/effect 就贴底；
       * userScrolledRef 被清 → 「他在翻历史」的账被偷。所以高度变矮期间
       * 一律不记账，主人的状态一个字都不动。 */
      const shrank = h < lastHeightRef.current;
      lastHeightRef.current = h;
      if (!shrank) {
        /* 【2026-11-11 改·阈值 24 → 8】主人报「向上小幅滚动就被弹回最新消息」：
         * 原来离底 24px 以内都算「在底部」，往上滚一小格（20px 左右）根本不算数，
         * pin/effect 照样贴底（探针实测：滚 20px + 追加一条内容 → 立刻弹回底部）。
         * 8px 只留物理贴底的那点余量，滚 10px 就已经算「在翻历史」。 */
        atBottomRef.current = d <= 8;
        /* 滚回底部就复位「在翻历史」——但只认「连续两次都贴底」：
         * 单独一发 d 很小的 scroll 可能是收缩夹出来的，不许凭它清账。 */
        const prevDist = lastDistRef.current;
        lastDistRef.current = d;
        if (d <= 8 && prevDist <= 8) userScrolledRef.current = false;
        lastScrollTopRef.current = el.scrollTop;
      }
      /* 【2026-11-11 修·跳底按钮】滚动位置变化要驱动右下角按钮的显隐/未读清零。
       * 原来只有 noteNewContent/bumpUnseen/jumpToBottom 三个调用点，没有 scroll 监听 ——
       * 人滚回底部后按钮和角标还挂着，且往上滚远时按钮从不出现。 */
      try { window.paintToBottom && window.paintToBottom(); } catch (e) {}
    };
    /* 只有这几种「他自己动手」的动作才把人标记成「在翻历史」 */
    const onUserIntent = () => { userScrolledRef.current = true; };
    el.addEventListener('scroll', onScroll, { passive: true });
    el.addEventListener('wheel', onUserIntent, { passive: true });
    el.addEventListener('touchmove', onUserIntent, { passive: true });
    el.addEventListener('pointerdown', onUserIntent, { passive: true });
    el.addEventListener('keydown', onUserIntent);

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
        if (userScrolledRef.current && !atBottomRef.current) return;
        try { el.scrollTop = el.scrollHeight; } catch (e) {}
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
      el.removeEventListener('wheel', onUserIntent);
      el.removeEventListener('touchmove', onUserIntent);
      el.removeEventListener('pointerdown', onUserIntent);
      el.removeEventListener('keydown', onUserIntent);
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
    if (!userScrolledRef.current || atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      return;
    }
    /* 【2026-11-11 修·重画把人甩到顶上】真在翻历史的人：整屏重画换 DOM 的瞬间
     * 浏览器把 scrollTop 夹成 0，画面就跳到最老的消息 —— 主人报的「发消息后
     * 弹到很久以前」正是这条。现在把他还回他刚才看的地方（往底部加新内容
     * 不挪旧内容的位置，所以按 scrollTop 还原是准的）。 */
    try {
      const want = lastScrollTopRef.current;
      if (want > 0 && Math.abs(el.scrollTop - want) > 4) el.scrollTop = want;
    } catch (e) {}
    /* 只更新「底下多了几条」那颗提醒 */
    try { if (window.noteNewContent) window.noteNewContent(); } catch (e) {}
  }, [count, lastLen]);

  /* 「再往前看」：补完把视口还到「离底同样的距离」，一像素都不跳 */
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el || keepFromBottom.current == null) return;
    el.scrollTop = el.scrollHeight - keepFromBottom.current;
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
        <RowBoundary key={r.key}>{renderRow(r, merged.running, lastItem, snap.sid)}</RowBoundary>
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
