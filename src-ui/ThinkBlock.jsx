import { useMemo } from 'react';
import { useOpen } from './useOpen.js';
import { ThinkMeta } from './GrayText.jsx';

function titleOf(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '正在想…';
  try {
    if (typeof window.thinkTitleOf === 'function') {
      const t = String(window.thinkTitleOf(flat) || '');
      if (t) return t;
    }
  } catch (e) { /* 退化成第一句 */ }
  return flat.slice(0, 60);
}

/**
 * 一段思考，折成一块 `<details>`（默认收着 —— 别看个回复先被内心戏糊一脸）。
 *
 * 规格 4.6 的根治点：`open` 由 React state 控（按 item key 记在 openMap 上），
 * 重渲染时 React 只更新文本节点、`open` 属性原样不动 ——
 * 于是「我刚点开它就自己合上了」在结构上不可能发生。
 */
export default function ThinkBlock({ it }) {
  const [open, onToggle] = useOpen(it.key, false);
  const title = useMemo(() => titleOf(it.text), [it.text]);
  const cls = 'think' + (it.running ? ' thinking-now' : '') + (it.isLive ? '' : ' thinkPast');

  return (
    <details className={cls} open={open} onToggle={onToggle}>
      <summary>
        <span className="thinkTitle">{title}</span>
        <ThinkMeta body={it.text} />
      </summary>
      <div className="thinkBody">{String(it.text || '')}</div>
    </details>
  );
}
