import { useEffect, useRef } from 'react';
import MdDiv from './MdDiv.jsx';
import { mateColorOf } from './bridge.js';
import { beginEdit, getEdit } from './store.js';
import EditArea from './EditArea.jsx';

/**
 * 「别人说的话」—— 小鲸，或群聊里别的智能体卡。
 *
 * 服务端把它存成一个 assistant turn 带 `whale`/`who`，直播清单里是 `k:'say'`。
 * 它单独一条气泡，绝不并进我的 —— 主人要一眼看出哪句不是小鱼说的。
 */
export default function MateBubble({ it, ask }) {
  const wrap = useRef(null);
  const who = String(it.who || '小鲸');
  const bubbles = Array.isArray(it.bubbles) ? it.bubbles : [];

  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    try { if (!w.querySelector('.msgTime') && window.attachTime) window.attachTime(w, it.ts); } catch (e) {}
    try { window.attachEdit && window.attachEdit(w, it.rewindId, () => beginEdit(it.key, it.rewindId)); } catch (e) {}
    try { window.attachBranchBtn && window.attachBranchBtn(w, it.rewindId); } catch (e) {}
    try { window.attachRetry && window.attachRetry(w, ask ? [{ at: ask.at, text: ask.text }] : []); } catch (e) {}
    try { window.attachDelBtn && window.attachDelBtn(w, it.rewindId); } catch (e) {}
    try { window.attachCopyBtn && window.attachCopyBtn(w); } catch (e) {}
  }, [it.rewindId, it.ts, it.key, ask && ask.at, ask && ask.text]);

  /* 她发的文件（A2 收编）：由 items.js 直出成独立条目，不再往气泡上挂。 */

  const editing = (() => { try { const e = getEdit(); return !!e && e.key === it.key; } catch (e) { return false; } })();
  const isWhale = who === '小鲸';
  const cls = (isWhale ? 'msg whale whaleSelf' : 'msg mate mateSelf') + (it.edited ? ' edited' : '') + (editing ? ' editing' : '');
  const color = isWhale ? '' : mateColorOf(who);

  return (
    <div
      className={cls}
      ref={wrap}
      data-who-name={isWhale ? undefined : who}
      style={color ? { '--whoC': color } : undefined}
      data-rewind-id={it.rewindId == null ? undefined : String(it.rewindId)}
      data-at={it.rewindId == null ? undefined : String(it.rewindId)}
    >
      <div className="role">{who}</div>
      {editing ? (
        <EditArea text={bubbles.join('\n\n')} at={it.rewindId} />
      ) : (
        bubbles.map((t, i) => (
          <MdDiv key={'b' + i} className={'bubble' + (i > 0 ? ' cont' : '')} text={t} />
        ))
      )}
    </div>
  );
}
