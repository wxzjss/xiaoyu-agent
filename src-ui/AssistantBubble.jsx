import { useEffect, useRef } from 'react';
import MdDiv from './MdDiv.jsx';
import { mateColorOf } from './bridge.js';
import { beginEdit, getEdit } from './store.js';
import EditArea from './EditArea.jsx';

/**
 * 她（主智能体 / 某个身份）说的一段话。
 *
 * 一轮里「说 → 调工具 → 再说」会被服务端存成好几条 assistant turn；
 * items.js 已经把连续的几条并成一条 item 的 `bubbles` 数组（跟原来
 * 「续接进同气泡」的口径一致），所以这里只负责：一段一个 `.bubble`，
 * 署名只写在最上面一次。
 */
export default function AssistantBubble({ it, ask, streaming }) {
  const wrap = useRef(null);
  const bubbles = Array.isArray(it.bubbles) ? it.bubbles : [];
  const who = String(it.who || '小鱼');

  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    try { if (!w.querySelector('.msgTime') && window.attachTime) window.attachTime(w, it.ts); } catch (e) {}
    if (it.cont) return;
    try { window.attachEdit && window.attachEdit(w, it.rewindId, () => beginEdit(it.key, it.rewindId)); } catch (e) {}
    try { window.attachBranchBtn && window.attachBranchBtn(w, it.rewindId); } catch (e) {}
    try { window.attachRetry && window.attachRetry(w, ask ? [{ at: ask.at, text: ask.text }] : []); } catch (e) {}
    try { window.attachDelBtn && window.attachDelBtn(w, it.rewindId, it.ts); } catch (e) {}
    try { window.attachCopyBtn && window.attachCopyBtn(w); } catch (e) {}
  }, [it.rewindId, it.ts, it.cont, it.key, ask && ask.at, ask && ask.text]);

  /* 超过 4 万字的长回复折起来（阈值和原来一致；短回复一个字都不折） */
  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    const els = w.querySelectorAll('.bubble');
    els.forEach((el, i) => {
      try { window.maybeFoldBubble && window.maybeFoldBubble(el, bubbles[i]); } catch (e) {}
    });
  }, [bubbles.join('\u0000')]);

  /* 这一轮的用量（token / 花费）：原来由 index.html 直接往气泡里 append，
   * 现在这里挂 —— 样式和「悬停才显示」的规则都由 appendTurnUsage 自己带。 */
  useEffect(() => {
    const w = wrap.current;
    if (!w || !it.usageRow) return;
    try {
      if (w.querySelector(':scope > .turnUsage')) return;
      if (typeof window.appendTurnUsage === 'function') {
        window.appendTurnUsage(it.usage || null, it.rewindId, it.model || '', w, true, it.replyChars, it.userChars);
      }
    } catch (e) { /* 用量画不出来不影响正文 */ }
  }, [it.usageRow, it.rewindId, it.usage, it.model, it.replyChars, it.userChars]);

  /* 她发的文件（A2 收编）：不再走 attachFiles 往气泡上挂 ——
   * 文件在 items.js 里直出成独立条目，由 LogView → FileCard 画。 */

  const editing = (() => { try { const e = getEdit(); return !!e && e.key === it.key; } catch (e) { return false; } })();
  const color = who !== '小鱼' ? mateColorOf(who) : '';
  const cls = 'msg assistant' + (it.cont ? ' cont' : '') + (it.edited ? ' edited' : '') + (editing ? ' editing' : '');

  return (
    <div
      className={cls}
      ref={wrap}
      data-who-name={who !== '小鱼' ? who : undefined}
      data-rewind-id={it.rewindId == null ? undefined : String(it.rewindId)}
      data-at={it.rewindId == null ? undefined : String(it.rewindId)}
    >
      <div className="role" style={color ? { color } : undefined}>
        {who}
      </div>
      {editing ? (
        <EditArea text={bubbles.join('\n\n')} at={it.rewindId} msgAt={it.ts} />
      ) : (
        bubbles.map((t, i) => (
          <MdDiv
            key={'b' + i}
            className={'bubble' + (i > 0 ? ' cont' : '') + (streaming && i === bubbles.length - 1 ? ' streaming' : '')}
            text={t}
          />
        ))
      )}
    </div>
  );
}
