import { useEffect, useMemo, useState } from 'react';
import { useOpen } from './useOpen.js';
import { GrayPeek } from './GrayText.jsx';
import { formatArgs, niceTool, tidyToolText } from './bridge.js';

function statusText(s) {
  if (s === 'ok') return '完成';
  if (s === 'err') return '失败';
  return '运行中…';
}

function statusClass(s) {
  if (s === 'ok') return 'status ok';
  if (s === 'err') return 'status err';
  return 'status warn';
}

/**
 * 【2026-11-11 加·主人报「跑工具时屏幕上没动静，不知道她在不在干活」】
 *
 * 跑着的工具卡上要有一个**活的**状态：旋转小标记 + 已耗时秒数。
 * 数据从哪来：agent 发 tool_start 时带 ts（开跑时刻），server 存进 live 清单
 * 的 startedAt，items.js 原样透传到这张卡上 —— 卡自己拿 Date.now() 一减就是秒数。
 *
 * 为什么不用 CSS 动画：旋转标记只是一个字符轮换（盲文点阵 ⠋⠙⠹…），跟着
 * 500ms 的计时器一起换，一行 JS 就够，不用去动 index.html 的样式区。
 * 计时器只在「跑着」的卡上挂 —— 完成的卡一个定时器都不占。
 */
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useRunTicker(active) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const t = setInterval(() => { try { setTick((x) => x + 1); } catch { /* 不让它往上抛 */ } }, 500);
    return () => clearInterval(t);
  }, [active]);
  return tick;
}

/** 已耗时秒数文案：startedAt 没有就退回原来的静态「运行中…」 */
function runStatus(startedAt, spinChar) {
  const s0 = Number(startedAt) || 0;
  if (!s0) return '运行中…';
  const sec = Math.max(1, Math.round((Date.now() - s0) / 1000));
  return spinChar + ' 正在跑 · ' + sec + 's';
}

/**
 * 一张工具抽屉（`details.tool`）：一行「工具名 · 状态」，点开才看参数和结果。
 */
export function ToolCard({ it }) {
  const [open, onToggle] = useOpen(it.key, false);
  const name = useMemo(() => niceTool(it.name, it.args) || '工具', [it.name, it.args]);
  const body = useMemo(() => {
    const args = formatArgs(it.args);
    let s = args ? '参数：' + tidyToolText(args) : '（无参数）';
    if (it.output) s += '\n--- output ---\n' + tidyToolText(it.output);
    return s;
  }, [it.args, it.output]);
  const running = String(it.status || 'run') === 'run';
  const tick = useRunTicker(running && (Number(it.startedAt) || 0) > 0);

  const status = running
    ? runStatus(it.startedAt, SPIN[tick % SPIN.length])
    : statusText(it.status);
  const cls = running ? statusClass('run') + ' live' : statusClass(it.status);

  return (
    <details className="tool" open={open} onToggle={onToggle} data-tool-id={it.id || undefined}>
      <summary>
        <span className="name">{name}</span>
        <span className={cls}>{status}</span>
      </summary>
      <pre>{body}</pre>
    </details>
  );
}

/**
 * 柜子（`details.toolhub`）：把「同一段活里的几次工具调用」收成一行柜门。
 *
 * 只有一张卡时不套柜门（单抽屉直挂 #log，CSS 那边有对应的写法）——
 * 跟原来 paintTools 的口径一致。
 *
 * 柜门那一行（`.hubname` / `.status` / `.hubpeek`）由 React 按数据算，
 * 不再靠 hubRefreshTitle 去扫 DOM —— 灰色摘要因此不会再因为「每秒重算一次」
 * 而把整行推来推去。
 */
export function ToolGroup({ items }) {
  const list = Array.isArray(items) ? items : [];
  const [open, onToggle] = useOpen('hub-' + (list[0] ? list[0].key : 'x'), false);
  /* 柜门上也要走秒：有跑着的卡就挂计时器（hooks 规矩：无条件挂，内部自己判） */
  const _running0 = list.find((t) => t.status === 'run' && (Number(t.startedAt) || 0) > 0) || null;
  const tick = useRunTicker(Boolean(_running0));

  const stat = useMemo(() => {
    const n = list.length;
    const running = list.find((t) => t.status === 'run') || null;
    const bad = list.filter((t) => t.status === 'err').length;
    const warn = list.filter((t) => t.status !== 'ok' && t.status !== 'err').length;
    let name = '调了 ' + n + ' 次工具';
    if (running) name = '正在' + (niceTool(running.name, running.args) || '干活') + '…';
    const statusCls = 'status ' + (bad ? 'err' : warn ? 'warn' : 'ok') + (running ? ' run live' : '');
    const statusTxt = bad ? bad + ' 个失败' : '';
    return { name, statusCls, statusTxt, running };
  }, [list]);

  /* 跑着的卡带 startedAt 时，柜门名后面跟着已耗时秒数（没有就维持原样） */
  const doorName = stat.running && (Number(stat.running.startedAt) || 0) > 0
    ? stat.name.replace(/…$/, '') + ' · ' + Math.max(1, Math.round((Date.now() - Number(stat.running.startedAt)) / 1000)) + 's…'
    : stat.name;
  const doorSpin = stat.running && (Number(stat.running.startedAt) || 0) > 0
    ? SPIN[tick % SPIN.length] + ' ' + doorName
    : doorName;

  if (list.length === 1) return <ToolCard it={list[0]} />;

  const last = list[list.length - 1];
  return (
    <details className="toolhub" open={open} onToggle={onToggle}>
      <summary>
        <span className="hubname">{doorSpin}</span>
        <span className={stat.statusCls}>{stat.statusTxt}</span>
        <GrayPeek text={stat.running ? '' : niceTool(last.name, last.args)} />
      </summary>
      {list.map((t) => (
        <ToolCard key={t.key} it={t} />
      ))}
    </details>
  );
}

export default ToolCard;
