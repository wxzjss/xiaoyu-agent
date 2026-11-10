import { useEffect, useMemo, useState } from 'react';
import { useOpen } from './useOpen.js';

const PREFIX = { mail: '  ✉ ', start: '  ▶ ' };

/**
 * 【2026-11-11 团队模式改版】
 *   · 状态四档 + 一档：干活中…（黄）/ 回来了（绿）/ 没干成（红）/ 停了（灰）/
 *     中断了（灰，程序重启时它还在跑）
 *   · 折叠态右侧显示耗时（跑着时每秒重算，收尾定格）
 *   · 有 rounds/tools 就显示「N 轮/M 次工具」（判断「卡住还是真慢」）
 *   · 跑着时悬停出「✕ 停掉」（POST /api/team/stop，主人手动干预的唯一入口；
 *     补话不做界面入口 —— 主人直接跟小鱼说，她自己 tell_worker）
 *
 * 样式自带一份 <style>：.wcard 的底样式在 public/index.html（那是 ui-safety
 * 正在改的文件，别为两个状态类去碰它）；这里只补新类和按钮。
 */

function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + '秒';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '分' + (s % 60) + '秒';
  return Math.floor(m / 60) + '时' + (m % 60) + '分';
}

export default function WorkerCard({ it, onStop }) {
  const [open, onToggle] = useOpen(it.key, false);
  /* 跑着的时候每秒跳一次，把「· 2分13秒」喂成活的 */
  const [, tick] = useState(0);
  const running = it.status === 'run';
  useEffect(() => {
    if (!running || !it.startedAt) return undefined;
    const t = setInterval(() => tick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [running, it.startedAt]);

  const steps = Array.isArray(it.steps) ? it.steps : [];

  const st = useMemo(() => {
    if (it.status === 'ok') return { txt: '回来了', cls: 'status ok' };
    if (it.status === 'err') return { txt: '没干成', cls: 'status err' };
    if (it.status === 'stopped') return { txt: '停了', cls: 'status stopped' };
    if (it.status === 'interrupted') return { txt: '中断了（程序重启过）', cls: 'status stopped' };
    return { txt: '干活中…', cls: 'status run' };
  }, [it.status]);

  const body = useMemo(() => {
    const lines = steps.map((x) => (PREFIX[x && x.kind] || '  · ') + String((x && x.t) || ''));
    if (it.note) lines.push('  ⇢ ' + String(it.note).replace(/\n/g, ' '));
    return lines.join('\n');
  }, [steps, it.note]);

  const dur = it.startedAt
    ? fmtDur((it.endedAt || (running ? Date.now() : 0)) - it.startedAt)
    : '';
  const cnt = (steps.length ? ' · ' + steps.length + ' 步' : '')
    + (Number(it.rounds) || Number(it.tools) ? ' · ' + (it.rounds || 0) + '轮/' + (it.tools || 0) + '次工具' : '')
    + (dur ? ' · ' + dur : '');

  const name = '#' + it.id + ' ' + String(it.name || '');

  return (
    <details className="wcard" open={open} onToggle={onToggle} data-wid={it.id || undefined}>
      <style>{`
        details.wcard > summary .status.stopped { color: var(--muted, #9a9a9a); }
        details.wcard > summary .wstop {
          margin-left: auto;
          display: none;
          border: 1px solid var(--line, #2a2a2a);
          background: transparent;
          color: var(--muted, #9a9a9a);
          border-radius: 6px;
          font-size: 11px;
          padding: 1px 7px;
          cursor: pointer;
        }
        details.wcard > summary:hover .wstop { display: inline-block; }
        details.wcard > summary .wstop:hover { color: var(--bad, #d0564a); border-color: var(--bad, #d0564a); }
      `}</style>
      <summary>
        <span className="name">{name}</span>
        <span className={st.cls}>{st.txt + cnt}</span>
        {running && onStop ? (
          <button
            type="button"
            className="wstop"
            title="停掉这个 worker（它手上的命令会立刻断）"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onStop(String(it.id)); }}
          >
            ✕ 停掉
          </button>
        ) : null}
      </summary>
      <pre>{body}</pre>
    </details>
  );
}
