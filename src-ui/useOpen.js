import { useCallback, useState } from 'react';
import { openMap } from './store.js';

/**
 * 展开态（规格 4.6）。
 *
 * 关键点：`open` 由 React 的 state 决定，**不从 DOM 事件反推**。
 * 记在模块级的 openMap 里（按 item key），所以整块重挂载也不会忘。
 *
 * 重渲染时 React 只是把 `open` 属性设成同一个值 → `<details>` 不会收起，
 * 主人正看着的那一块永远待在该待的地方。
 */
export function useOpen(key, defaultOpen) {
  const [open, setOpen] = useState(() => {
    if (openMap.has(key)) return openMap.get(key) === true;
    return Boolean(defaultOpen);
  });

  const onToggle = useCallback(
    (e) => {
      const el = e && e.currentTarget;
      const v = Boolean(el && el.open);
      openMap.set(key, v);
      setOpen(v);
    },
    [key],
  );

  return [open, onToggle];
}
