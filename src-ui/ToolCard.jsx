import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useOpen } from './useOpen.js';
import { GrayPeek } from './GrayText.jsx';
import { formatArgs, niceTool, tidyToolText } from './bridge.js';
import ThinkBlock from './ThinkBlock.jsx';

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
 *
 * 【2026-11-11 改·主人问「柜子为什么夹在思考链中间 / 思考链不该在柜子里吗」】
 *
 * 现在柜子里除了工具卡，还可能装着**思考块**（分组逻辑在 LogView 的 toRows）：
 * 一段活的事件顺序本来就是「想一下 → 调工具 → 再想一下 → 再调」，把思考留在柜子外面，
 * 柜子就会被思考块切成一截一截、夹在思考链中间。收进柜子之后：
 *   · 屏幕上的节奏回到「主人的话 → 一个柜子 → 她的回答」；
 *   · 思考默认收着（跟原来一样），要看点开柜子再点开那一条。
 * 三种形态：
 *   全是思考（一个工具都没有）→ 直接画思考块，不套柜门（柜子里只有内心戏没意义）
 *   只有一个工具、且没思考     → 直挂单卡（老规矩，不套柜门）
 *   其余                       → 柜门 + 里面（思考块 / 工具卡按原顺序）
 *
 * 【2026-11-11 修·hooks 必须挂在分派之前（真机踩过的坑）】
 *
 * 三种形态是在**函数体里 return** 的，可这段组件的 hooks（useOpen / useRunTicker /
 * useMemo）原来写在第一个 return 后面。直播时一段活的事件是一条一条到的：
 *   第 1 帧 items = [think]      → 走「全是思考」那条 return，**一个 hook 都没挂**
 *   第 2 帧 items = [think,tool] → 同一行、同一个 key、同一个组件实例
 *                                → 这次挂了 4 个 hook → React 抛
 *                                  「Rendered more hooks than during the
 *                                   previous render.」
 * 后果不是掉一张卡，而是这一整行被 RowBoundary 换成「⚠ 这一条渲染出错了」——
 * 思考刚到、工具刚开跑的那一瞬间，柜子就变成一行报错。
 * 所以：**hooks 全部无条件挂在函数最上面**，形态分派一律放在 hooks 之后。
 */
export function ToolGroup({ items }) {
  const list = Array.isArray(items) ? items : [];
  const tools = list.filter((t) => t && t.kind === 'tool');
  const thinks = list.filter((t) => t && t.kind === 'think');

  const [open, onToggle] = useOpen('hub-' + (list[0] ? list[0].key : 'x'), false);
  /* 柜门上也要走秒：有跑着的卡就挂计时器（hooks 规矩：无条件挂，内部自己判） */
  const _running0 = tools.find((t) => t.status === 'run' && (Number(t.startedAt) || 0) > 0) || null;
  const tick = useRunTicker(Boolean(_running0));

  const stat = useMemo(() => {
    const n = tools.length;
    /**
     * 【2026-11-12 修·主人问「她说在跑检查，柜门为什么显示【正在看文件】」】
     *
     * 原来取的是 `tools.find(t => t.status === 'run')` —— **列表里第一个**还在跑的。
     * 可一张卡要是没收到结束事件（进程重启 / 事件丢了 / 那个工具真的卡住），
     * 它会一直挂着「运行中」，于是柜门标题永远被那张**老卡**占着：
     * 她明明在跑检查（run_command），门上却一直写「正在看文件 · 198s…」。
     * 实测截图就是这样：柜门「正在看文件 · 198s」，里面第一张「看文件 完成」、
     * 第二张「看文件 正在跑 · 198s」，而真正在干的活儿在更下面。
     *
     * 改法：标题跟**最新**那个在跑的工具走（人想知道的是「她现在这一秒在干什么」）；
     * 同时在跑的超过一个，就直说「正在跑 N 个工具…」—— 别拿某一个冒充全部。
     */
    const runList = tools.filter((t) => t.status === 'run');
    const running = runList.length ? runList[runList.length - 1] : null;
    let name = '调了 ' + n + ' 次工具';
    if (running) {
      name = runList.length > 1
        ? '正在跑 ' + runList.length + ' 个工具…'
        : '正在' + (niceTool(running.name, running.args) || '干活') + '…';
    }
    /* 【2026-11-12 主人】柜门上不要金色「N 个失败」（没失败时太吵，看着像出错）；
     * 改成：跑着就亮「运行中…」，柜门标题也带一份。 */
    /* 【2026-11-12 主人】柜门右侧那颗状态原本写「运行中…」——**不该有省略号**：
     * 它就是一句状态词（柜子里那张卡写的是「正在跑」，也不带省略号），
     * 带上「…」看着像「还有下文」，跟秒数后面的「…」撞一起就是两个半截句。
     * 秒数的省略号也一起去掉（见下面 hubSecs）。 */
    const statusCls = 'status ' + (running ? 'run live' : 'ok');
    const statusTxt = running ? '运行中' : '';
    return { name, statusCls, statusTxt, running, thinkCount: thinks.length };
  }, [list]);

  /* 跑着的卡带 startedAt 时，柜门名后面跟着已耗时秒数（没有就维持原样） */
  /**
   * 【2026-11-12 主人】柜门标题在「跑着」的时候整段也改成金色 ——
   * 以前只有右边那颗「运行中」是金色（#f0b954），左边「⠙ 正在跑命令 · 12s…」
   * 还是主题色，一眼看过去像两套东西。现在：转圈点、标题、秒数一并金色，
   * 跟「运行中」同一个色号，整条柜门「亮起来」才像一个状态。
   *
   * 拆成三段渲染（不再拼成一个字符串）：转圈点 / 标题 / 秒数，
   * 这样样式能分开给（秒数压一点透明度，别跟标题抢），也方便以后单独调。
   */
  const _startedAt = stat.running ? (Number(stat.running.startedAt) || 0) : 0;
  const spinOn = !!stat.running && _startedAt > 0;
  const doorTitle = spinOn ? stat.name.replace(/…$/, '') : stat.name;
  const doorSecs = spinOn ? Math.max(1, Math.round((Date.now() - _startedAt) / 1000)) : 0;

  /**
   * 【2026-11-11 加·柜子展开后要跟着新工具走】
   *
   * 主人：「展开柜子并滚轮到最底部后，新出来的工具调用消息也应该能自动滚动到最底部」。
   *
   * 柜子内容区（.hubBody）是限高 + 内部滚动的（340px），新卡片是**追加在末尾**的；
   * 没有这段逻辑的话，人明明停在柜底，新卡却在他看不见的下方悄悄长出来 ——
   * 跟聊天区「贴着底就跟着长」是同一个期望，只是坐标系换成了柜子内部。
   *
   * 判据故意跟聊天区一致：
   *   · followRef 默认 true（跟聊天区「没动过就跟随」同口径）；
   *   · 只有「他自己把柜子滚离底部」才停（离底 > 8px）；
   *   · 再滚回底部就恢复跟随；
   *   · 收起柜子时什么也不做（收起态内容不渲染，scrollTop 无意义）。
   */
  const bodyRef = useRef(null);
  const followRef = useRef(true);
  const onBodyScroll = () => {
    const el = bodyRef.current;
    if (!el) return;
    followRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
  };
  /* 末尾那条的文字长度也当依赖 —— 工具输出是在同一条卡上变长的（条数不变） */
  const _lastOfList = list.length ? list[list.length - 1] : null;
  const tailSig = _lastOfList
    ? String(_lastOfList.output || '').length + String(_lastOfList.text || '').length
    : 0;
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (!el || !open) return;
    if (!followRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [open, list.length, tailSig]);

  /* ── 形态分派（一律放在 hooks 之后，见函数头那段注释） ── */
  /* 只有思考、没有工具：不套柜门，直接把思考块摆出来 */
  if (!tools.length) {
    return <>{thinks.map((t) => <ThinkBlock key={t.key} it={t} />)}</>;
  }
  /* 单卡且没夹思考：维持老样子（单抽屉直挂） */
  if (tools.length === 1 && !thinks.length) return <ToolCard it={tools[0]} />;

  const last = tools[tools.length - 1];
  return (
    <details className="toolhub" open={open} onToggle={onToggle}>
      <summary>
        {/* 【2026-11-12 主人】顺序改成：⠙ 正在看仓库 · 运行中 · 1s
              原来秒数紧贴标题（· 1s…），「运行中…」孤零零吊在右边，两个都带省略号。
              现在：标题 → 「运行中」→ · → 秒数，跟柜子里那张卡一个读法
             （卡里是「看仓库 ⠿ 正在跑 · 1s」）。 */}
        <span className={'hubname' + (spinOn ? ' run' : '')}>
          {spinOn ? <span className="hubSpin">{SPIN[tick % SPIN.length]}</span> : null}
          <span className="hubText">{spinOn ? ' ' + doorTitle : doorTitle}</span>
        </span>
        <span className={stat.statusCls}>{stat.statusTxt}</span>
        {spinOn ? <span className="hubSep">·</span> : null}
        {spinOn ? <span className="hubSecs">{doorSecs + 's'}</span> : null}
        <GrayPeek text={stat.running ? '' : niceTool(last.name, last.args)} />
      </summary>
      {/* 【2026-11-11 加·hubBody】柜子里可能塞很多东西（思考块 + 十几张工具卡），
          以前是「内容多长柜子就多高」，长活一张柜子能顶满几屏。
          现在套一层 .hubBody，CSS 给它封顶 + 内部滚动（跟思考链的框一个规矩）。 */}
      <div className="hubBody" ref={bodyRef} onScroll={onBodyScroll}>
        {list.map((t) => (
          t.kind === 'think'
            ? <ThinkBlock key={t.key} it={t} />
            : <ToolCard key={t.key} it={t} />
        ))}
      </div>
    </details>
  );
}

export default ToolCard;
