import { useEffect, useRef, useState } from 'react';
import { endEdit } from './store.js';

/**
 * 编辑一条消息（2026-11-10 A1：编辑态进 React）。
 *
 * 旧的 startEdit 是手写 textarea：一进编辑先把 bubble.textContent 清空，
 * 而 React 的提交回流随时会把这一行重画 —— 输入框连着原内容一起被冲掉
 * （审查实测「编辑框一开就清空原内容」的病根）。
 *
 * 现在这一整块由 React 受控渲染：editKey 记在 store（哪一行在改），
 * 草稿是这里的本地 state（打字只重渲染编辑框，不 bump 整屏）。
 * React 的重渲染只会把同一个 value 原样写回 textarea，谁也冲不掉谁。
 *
 * 样式全用旧类名（.bubble.editing / textarea.editArea / .editActions），
 * .msg.editing 由外层组件挂 —— 一行 CSS 都不用改。
 */
export default function EditArea({ text, at }) {
  const [draft, setDraft] = useState(String(text == null ? '' : text));
  const [busy, setBusy] = useState(false);
  const ta = useRef(null);

  /* 进编辑就把光标放到末尾（旧口径）。不再需要 keepTop/restore 补偿：
   * React 重渲染不动展开行，focus 的滚动现在交给 CSS/DOM 的自然行为，
   * LogView 的贴底 effect 会兜住「本来就贴底」的情况。 */
  useEffect(() => {
    const el = ta.current;
    if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { try { el.focus(); } catch (e2) {} }
    try { el.selectionStart = el.selectionEnd = el.value.length; } catch (e3) {}
  }, []);

  const note = (t) => { try { window.addSysNote && window.addSysNote(t); } catch (e) {} };

  /** 存完 / 撤销完，把盘上的最新历史拉回来（React 照新历史重画这一行）。
   *  旧实现就地 repaint 一个气泡 —— 那是手写 DOM 时代的手法，
   *  现在屏幕 = f(数据)，改完数据来一遍才对。 */
  const refreshHistory = async () => {
    try {
      const r = await fetch('/api/sessions/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: window.sessionId }),
      }).then((x) => x.json()).catch(() => null);
      if (r && r.session && Array.isArray(r.session.turns) && typeof window.renderTurns === 'function') {
        window.renderTurns(r.session.turns, { force: true });
      }
    } catch (e) { /* 拉不到就等下次刷新，屏幕保持当前样子 */ }
  };

  const save = async () => {
    const next = draft;
    if (!next.trim()) { note('不能改成空的。'); return; }
    if (next === String(text == null ? '' : text)) { endEdit(); return; }
    setBusy(true);
    const r = await fetch('/api/sessions/edit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: window.sessionId, text: next }),
    }).then((x) => x.json()).catch(() => null);
    setBusy(false);
    if (!r || r.error) { note('改不了：' + ((r && r.error) || '网络错误')); return; }
    endEdit();
    const md = r.memory;
    note(md && md.changed
      ? `改好了，下一句就按新的来。记忆本子也跟着改了 ${md.lines || 1} 处。`
      : '改好了，下一句就按新的来。记忆本子里没找到提到这句的地方，本子没动。');
    await refreshHistory();
  };

  const undo = async () => {
    setBusy(true);
    const r = await fetch('/api/sessions/edit-undo', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: window.sessionId, at }),
    }).then((x) => x.json()).catch(() => null);
    setBusy(false);
    if (!r || r.error) { note('撤销不了：' + ((r && r.error) || '网络错误')); return; }
    if (r.unchanged) { note('这句没改过，没得撤销。'); return; }
    endEdit();
    note(r.memory && r.memory.changed ? '撤销了，记忆本子也一起退回去了。' : '撤销了。');
    await refreshHistory();
  };

  return (
    <div className="bubble editing">
      <textarea
        ref={ta}
        className="editArea"
        value={draft}
        spellCheck={false}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); endEdit(); }
          /* Ctrl/Cmd + Enter 存上，普通回车是换行（一句话可能有好几段） */
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
        }}
      />
      <div className="editActions">
        <button type="button" className="primary" disabled={busy} onClick={save}>存上</button>
        <button type="button" disabled={busy} onClick={undo}>撤销上次修改</button>
        <button type="button" disabled={busy} onClick={endEdit}>不改了</button>
      </div>
    </div>
  );
}
