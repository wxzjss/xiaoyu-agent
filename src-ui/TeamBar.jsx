import { useEffect, useMemo, useRef, useState } from 'react';
import WorkerCard from './WorkerCard.jsx';

/**
 * TeamBar —— 【团队模式】的轻量状态条（2026-11-11）。
 *
 * 设计文档 §2.2③：只在有 worker 在跑时出现，不占布局；点它滚到最新的
 * worker 卡。数据来自 /api/team/workers 的 3 秒轮询（SSE 只在主轮活着时
 * 有缓冲，后台 worker 在主轮结束后还在跑 —— 轮询是唯一可靠的通道）。
 *
 * 同时兜两件事：
 *   · 流外的 running 卡：主轮结束后直播清单清空，还在跑的 worker 在聊天流里
 *     没有位置了 —— 这里按花名册补画（跟流里已有的按 wid 去重，不画两份）。
 *   · 「✕ 停掉」的主人入口（POST /api/team/stop）。
 *
 * 全停之后轮询自动降频到 10 秒（不彻底停 —— 要看到历史 worker 的收尾状态）。
 */

/** 停一个 worker（聊天流里的卡和这里的轮询卡都走这一个入口）。 */
export async function teamStopWorker(sid, wid) {
  try {
    await fetch('/api/team/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, wid }),
    });
  } catch { /* 停不掉下次轮询会看到它还在跑，再试就是 */ }
}

export default function TeamBar({ sid, items }) {
  const [ws, setWs] = useState([]);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    let timer = null;
    const poll = async () => {
      if (!aliveRef.current) return;
      try {
        const r = await fetch('/api/team/workers?sessionId=' + encodeURIComponent(String(sid || '')));
        const j = await r.json();
        if (!aliveRef.current) return;
        const list = Array.isArray(j && j.workers) ? j.workers : [];
        setWs(list);
        /* 只在有 running 时按 3 秒轮；全停了降到 10 秒兜底（便宜，本机回环） */
        timer = setTimeout(poll, list.some((w) => w && w.status === 'running') ? 3000 : 10000);
      } catch {
        if (aliveRef.current) timer = setTimeout(poll, 8000);
      }
    };
    if (sid) poll();
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [sid]);

  /* 切会话立刻清空旧数据，免得上一秒还显示 A 会话的 worker */
  useEffect(() => { setWs([]); }, [sid]);

  const running = ws.filter((w) => w && w.status === 'running');
  /* 聊天流里已经画着、还在跑的卡（直播那份）不重复画 */
  const inFlowRunning = useMemo(
    () => new Set((items || []).filter((x) => x && x.kind === 'worker' && x.status === 'run').map((x) => String(x.id))),
    [items],
  );
  const extra = running.filter((w) => !inFlowRunning.has(String(w.id)));

  const onStop = (wid) => { teamStopWorker(sid, wid); };
  const jumpToLatest = () => {
    try {
      const el = document.getElementById('log');
      if (el) el.scrollTop = el.scrollHeight;
    } catch { /* 滚不动就算了 */ }
  };

  if (!running.length && !extra.length) return null;

  return (
    <div className="teamBar" data-team-sid={String(sid || '')}>
      <style>{`
        .teamBar .teamHint {
          position: sticky; top: 0; z-index: 6;
          margin: 4px 0 6px 0;
          padding: 4px 12px;
          font-size: 12px;
          color: var(--warn, #d8a13a);
          background: color-mix(in srgb, var(--warn, #d8a13a) 10%, transparent);
          border: 1px solid color-mix(in srgb, var(--warn, #d8a13a) 35%, transparent);
          border-radius: 999px;
          width: fit-content;
          cursor: pointer;
          backdrop-filter: blur(4px);
        }
        .teamBar .teamTail { margin: 2px 0 8px 0; }
      `}</style>
      {running.length ? (
        <button type="button" className="teamHint" onClick={jumpToLatest}>
          {'⚑ ' + running.length + ' 个在后台干活…'}
        </button>
      ) : null}
      {extra.length ? (
        <div className="teamTail">
          {extra.map((w) => (
            <WorkerCard
              key={'team-' + w.id}
              it={{
                key: 'team-' + w.id,
                id: String(w.id),
                name: String(w.name || ''),
                status: 'run',
                steps: (Array.isArray(w.progress) ? w.progress : []).map((p) => ({ kind: 'step', t: String((p && p.line) || '') })),
                note: String(w.said || ''),
                startedAt: Number(w.startedAt) || 0,
                endedAt: 0,
                rounds: Number(w.rounds) || 0,
                tools: Number(w.tools) || 0,
              }}
              onStop={onStop}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
