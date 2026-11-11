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
  /**
   * 【2026-11-11 改·主人问「小鲸的名字为什么是白色的不是蓝色的」】
   *
   * 原来这两行是：
   *   const isWhale = who === '小鲸';
   *   const color = isWhale ? '' : mateColorOf(who);
   * 也就是**故意不给小鲸上色**，只给她挂 `whaleSelf` 后缀（「· 姐妹」）。
   * 结果她永远是默认色 #e6e6e6（灰白），而小白曦、旁白都有颜色 ——
   * 同一个「屋里的人」，只有她像没有身份。
   *
   * 但 AssistantBubble 那边是给小鲸上色的（`who !== '小鱼' ? mateColorOf(who) : ''`），
   * 于是同一个名字在这两种气泡里颜色还不一样。现在统一：**都按她的颜色来**。
   * `whaleSelf` 那个后缀保留（「· 姐妹」是另一回事，跟颜色无关）。
   */
  const isWhale = who === '小鲸';
  const cls = (isWhale ? 'msg whale whaleSelf' : 'msg mate mateSelf') + (it.edited ? ' edited' : '') + (editing ? ' editing' : '');
  const color = mateColorOf(who);
  /* 【CSS 变量】--whoC 决定署名和左边那道线的颜色（见 index.html 的 .role { color: var(--whoC, ...) }） */
  const colorStyle = color && color !== '#e6e6e6' ? { '--whoC': color } : undefined;

  return (
    <div
      className={cls}
      ref={wrap}
      data-who-name={isWhale ? undefined : who}
      style={colorStyle}
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
