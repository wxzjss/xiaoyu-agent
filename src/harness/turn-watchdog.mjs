/**
 * 【整轮空闲看门狗】
 *
 * 2026-11-08 主人说「根治」。
 *
 * 现场：三个会话同时卡住 —— events 不动、会话文件几分钟不写，
 * 而界面上它们一直显示「正在跑」。查超时链发现两处：
 *   ① LLM 那层有 2 分钟空闲超时（withTimeout / stallGuard），但只覆盖「等模型」；
 *   ② TURN_IDLE_MAX_MS（整轮空闲）**只是常量表里一个数字，从来没被任何代码用过**。
 *
 * 也就是说：只要卡在「不是等模型」的地方（工具、写盘、某个没人 resolve 的 await），
 * 就完全没人管，可以卡到天荒地老。
 *
 * 这个看门狗补的就是那一层：**不管卡在哪，只要整轮静默超过上限就动手**。
 *
 * ── 怎么判断「静默」 ────────────────────────────────────────────
 *
 * 看 live.events 里最后一个带 at 的事件。没有事件就用开跑时间。
 *
 * ── 为什么分两档 ────────────────────────────────────────────────
 *
 * 工具是允许跑很久的（跑整套回归、装依赖、转视频，实测 20 分钟都有）。
 * 那种时候事件流里只有一条 tool_start，之后再无事件 —— 按「整轮 5 分钟」判会误杀。
 * 所以：正在等工具 → 用工具上限；其余（等模型、等写盘、等任何东西）→ 用整轮上限。
 *
 * ── 掐不死怎么办 ────────────────────────────────────────────────
 *
 * abort 是软掐，它靠 signal 往下传。要是卡在一个不认 signal 的 await 上，
 * 掐不掉。所以软掐之后还记一笔时间：60 秒后仍然静默，就强制清理
 * （删运行条目、把 live 标成 done）—— 界面能解冻，主人在会话里能接着说话。
 * 那个真卡住的 promise 会变成孤儿，但总比让人对着一个永远转圈的界面强。
 */

function lastActivityAt(events, startedAt) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const a = Number(events[i] && events[i].at);
    if (Number.isFinite(a) && a > 0) return a;
  }
  return Number(startedAt) || 0;
}

/** 最后一个 tool_start 之后没有对应的 tool_end → 正在等工具 */
function isWaitingTool(events) {
  let s = -1;
  let e = -1;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ty = events[i] && events[i].type;
    if (s < 0 && ty === 'tool_start') s = i;
    if (e < 0 && ty === 'tool_end') e = i;
    if (s >= 0 && e >= 0) break;
  }
  return s > e;
}

/**
 * @param {object} opts
 * @param {() => Iterable<[string, object]>} opts.turns       runningTurns 的条目
 * @param {(sid: string) => object|undefined} opts.liveOf     拿 live（events 在那）
 * @param {(sid: string) => void} opts.abort                  软掐
 * @param {(sid: string) => void} opts.forceClean             硬清（删条目 + 标 done）
 * @param {number} [opts.idleMs]       整轮静默上限（默认 5 分钟）
 * @param {number} [opts.toolIdleMs]   等工具时的上限（默认 31 分钟）
 * @param {number} [opts.hardAfterMs]  软掐后再等多久强清（默认 60 秒）
 * @param {number} [opts.tickMs]       扫的间隔（默认 15 秒）
 * @param {(tag: string, detail: string) => void} [opts.onLog]
 */
export function createTurnWatchdog(opts = {}) {
  const turns = opts.turns || (() => []);
  const liveOf = opts.liveOf || (() => undefined);
  const abort = opts.abort || (() => {});
  const forceClean = opts.forceClean || (() => {});
  const idleMs = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : 5 * 60 * 1000;
  const toolIdleMs = Number(opts.toolIdleMs) > 0 ? Number(opts.toolIdleMs) : 31 * 60 * 1000;
  const hardAfterMs = Number(opts.hardAfterMs) > 0 ? Number(opts.hardAfterMs) : 60 * 1000;
  const tickMs = Number(opts.tickMs) > 0 ? Number(opts.tickMs) : 15000;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};

  let timer = null;
  /** sid → 软掐的时间戳（已经掐过、等它退） */
  const softAt = new Map();

  function scan(now = Date.now()) {
    const seen = new Set();
    for (const [sid, t] of turns()) {
      seen.add(sid);
      const live = liveOf(sid);
      const events = (live && Array.isArray(live.events)) ? live.events : [];
      const last = lastActivityAt(events, t && t.startedAt);
      if (!last) continue;
      const idle = now - last;
      const waitingTool = isWaitingTool(events);
      const limit = waitingTool ? toolIdleMs : idleMs;

      if (idle <= limit) {
        softAt.delete(sid);
        continue;
      }

      if (!softAt.has(sid)) {
        softAt.set(sid, now);
        onLog('turn-idle-abort', sid + ' 静了 ' + Math.round(idle / 1000) + ' 秒'
          + '（' + (waitingTool ? '在等工具，上限 ' + Math.round(toolIdleMs / 1000) : '整轮上限 ' + Math.round(idleMs / 1000))
          + ' 秒），掐掉');
        try { abort(sid); } catch (e) { /* 掐不掉就等硬清 */ }
        continue;
      }

      if (now - softAt.get(sid) >= hardAfterMs) {
        onLog('turn-idle-force', sid + ' 软掐后 ' + Math.round((now - softAt.get(sid)) / 1000) + ' 秒还没退，强制清理');
        try { forceClean(sid); } catch (e) {}
        softAt.delete(sid);
      }
    }
    /* 已经结束的会话别再占着记录 */
    for (const sid of [...softAt.keys()]) if (!seen.has(sid)) softAt.delete(sid);
  }

  return {
    /** 开始定时扫（重复 start 无副作用） */
    start() {
      if (timer) return;
      timer = setInterval(() => { try { scan(); } catch (e) {} }, tickMs);
      if (typeof timer.unref === 'function') timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
      softAt.clear();
    },
    /** 手动扫一次（测试用） */
    scan,
    /** 现在有几个在等它掐 */
    pending() { return [...softAt.keys()]; },
    limits() { return { idleMs, toolIdleMs, hardAfterMs, tickMs }; },
  };
}
