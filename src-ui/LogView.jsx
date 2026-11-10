import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { getSnapshot, getVersion, setWindowStart, subscribe } from './store.js';
import { buildMerged } from './items.js';
import UserBubble from './UserBubble.jsx';
import AssistantBubble from './AssistantBubble.jsx';
import MateBubble from './MateBubble.jsx';
import ThinkBlock from './ThinkBlock.jsx';
import WorkerCard from './WorkerCard.jsx';
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
 * 把 item 清单折成「一行一行要画的东西」：
 *   · 连续的几张工具卡 → 一个柜子（跟原来「话—柜子—话—柜子」的节奏一致）
 *   · 每条 assistant 记住「它前面最近的那句主人话」，重发按钮要用
 */
function toRows(items) {
  const rows = [];
  let run = null;
  let lastAsk = null;
  for (const it of items) {
    if (it.kind === 'tool') {
      if (run) run.items.push(it);
      else {
        run = { type: 'tools', key: 'hub-' + it.key, items: [it] };
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
  return rows;
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
    const onScroll = () => {
      atBottomRef.current = dist() <= 24;
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
    /* 不贴底的人：只更新「底下多了几条」那颗提醒（不抢滚动位置） */
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
        <RowBoundary key={r.key}>{renderRow(r, merged.running, lastItem)}</RowBoundary>
      ))}
    </>
  );
}

/**
 * 一行 → 一个组件。
 *
 * 【抽出来的理由】每一行都套一层 RowBoundary（见那个文件顶上的说明）——
 * 换 React 之后，「一条坏数据毁掉整屏」这件事必须堵掉。
 */
function renderRow(r, running, lastItem) {
  {
        if (r.type === 'tools') return <ToolGroup items={r.items} />;
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
        if (it.kind === 'worker') return <WorkerCard it={it} />;
        if (it.kind === 'note') return <SysNote it={it} />;
        /* 她发的文件（A2 收编后）：独立一行，跟工具卡一个节奏 */
        if (it.kind === 'file') return <FileCard it={it} />;
        return null;
  }
}
