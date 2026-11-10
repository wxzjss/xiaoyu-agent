import { useMemo } from 'react';
import { useOpen } from './useOpen.js';

const PREFIX = { mail: '  ✉ ', start: '  ▶ ' };

/**
 * 办事模式里的子任务卡（`details.wcard`）：谁在干活、干到第几步。
 *
 * 原来这张卡靠 `_wcardByWid` 这张门牌表 + 「只登记不摘」的手法避免闪烁 ——
 * 那套手法的全部意义就是「别删了重建」。React 用 key 直接把这件事做掉了，
 * 所以这里不需要任何缓存表。
 */
export default function WorkerCard({ it }) {
  const [open, onToggle] = useOpen(it.key, false);
  const steps = Array.isArray(it.steps) ? it.steps : [];

  const st = useMemo(() => {
    if (it.status === 'ok') return { txt: '回来了', cls: 'status ok' };
    if (it.status === 'err') return { txt: '没干成', cls: 'status err' };
    return { txt: '干活中…', cls: 'status warn' };
  }, [it.status]);

  const body = useMemo(() => {
    const lines = steps.map((x) => (PREFIX[x && x.kind] || '  · ') + String((x && x.t) || ''));
    if (it.note) lines.push('  ⇢ ' + String(it.note).replace(/\n/g, ' '));
    return lines.join('\n');
  }, [steps, it.note]);

  const name = '#' + it.id + ' ' + String(it.name || '');
  const cnt = steps.length ? ' · ' + steps.length + ' 步' : '';

  return (
    <details className="wcard" open={open} onToggle={onToggle} data-wid={it.id || undefined}>
      <summary>
        <span className="name">{name}</span>
        <span className={st.cls}>{st.txt + cnt}</span>
      </summary>
      <pre>{body}</pre>
    </details>
  );
}
