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
 * ── 为什么分三档 ────────────────────────────────────────────────
 *
 * 工具是允许跑很久的（跑整套回归、装依赖、转视频，实测 20 分钟都有）。
 * 那种时候事件流里只有一条 tool_start，之后再无事件 —— 按「整轮」判会误杀。
 * 所以：正在等工具 → 用工具上限。
 *
 * 【2026-11-08 加第三档】「等模型」也得单独一档。
 * 上游在思考阶段一个字都不吐，事件流同样不动，可按「整轮 12 分钟」量它
 * 就变成「谁想得久谁死」—— 主人凌晨六个会话全这么死的。
 * 最后一条事件是模型吐的字（或工具刚回来）→ 说明马上去调模型 → 用 LLM 那档。
 *
 * 只剩「真·什么都不在等」才吃整轮上限，那才是真卡死。
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
 * 【2026-11-08 加·「正在等模型」要单独认出来】
 *
 * 现场：00:53~01:07 六个会话轮着被掐，日志写着「静了 306 秒（整轮上限 300 秒）」。
 * 可它们不是在空转 —— 是**上游在思考、一个字都没吐**，事件流当然不动。
 * 用「整轮静默」那把尺子量「等模型」，等于谁想得久谁死。
 *
 * 怎么认：最后一条事件如果是模型吐出来的字（正文字/思考块），
 * 说明这一圈模型刚说完、马上要发下一次请求 —— 此刻就是在等模型。
 * 工具刚回来的那一刻（tool_end）也一样：下一步必然是调模型。
 */
function looksLikeWaitingModel(events) {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const ty = events[i] && events[i].type;
    if (!ty) continue;
    if (ty === 'tool_start') return false;
    if (ty === 'tool_end') return true;
    if (ty === 'text' || ty === 'reasoning' || ty === 'whisper') return true;
    /* 超时重试时我们自己推的那句「再要一次」、以及 retry 提示，
     * 都表示「请求已经发出去、正在等上游」—— 归到等模型这一档。 */
    if (ty === 'notice' || ty === 'retry') return true;
    if (ty === 'done' || ty === 'error' || ty === 'aborted') return false;
  }
  return false;
}

/** 这一刻该拿哪把尺子（返回上限 + 人话说明，日志要用） */
function pickLimit(events, limits) {
  if (isWaitingTool(events)) {
    return { ms: limits.toolIdleMs, why: '在等工具，上限 ' + Math.round(limits.toolIdleMs / 1000) };
  }
  /* 【2026-11-08 修·续跑轮一个事件都不推，能空挂 12 分钟】
   *
   * 现场：办事鱼 06:04 自动续跑起了一轮，/api/running 显示
   * `events:0, idleMs:415000`，界面一个字都没有、主人发消息也没人答。
   * 查下来那一轮 `onEvent: () => {}` 把事件全丢了（已改成 send），
   * 于是这里看不到任何事件 → 判「真空转」→ 要等 12 分钟才掐。
   * 而 12 分钟里主人发的话全被 /api/interject 当成插话塞进这个死轮，
   * 就是「说了一句，也没回我，也没开始工作」。
   *
   * 一个事件都没有、又没在等工具 —— 不管是不是续跑，都不是「正常静默」。
   * 用等模型那档（5 分钟），别让它空挂 12 分钟。 */
  if (!events.length) {
    return { ms: limits.llmIdleMs, why: '一个事件都没有，上限 ' + Math.round(limits.llmIdleMs / 1000) };
  }
  if (looksLikeWaitingModel(events)) {
    return { ms: limits.llmIdleMs, why: '在等模型回话，上限 ' + Math.round(limits.llmIdleMs / 1000) };
  }
  return { ms: limits.idleMs, why: '整轮上限 ' + Math.round(limits.idleMs / 1000) };
}

/**
 * @param {object} opts
 * @param {() => Iterable<[string, object]>} opts.turns       runningTurns 的条目
 * @param {(sid: string) => object|undefined} opts.liveOf     拿 live（events 在那）
 * @param {(sid: string) => void} opts.abort                  软掐
 * @param {(sid: string) => void} opts.forceClean             硬清（删条目 + 标 done）
 * @param {number} [opts.idleMs]       真空转时的上限（默认 12 分钟）
 * @param {number} [opts.toolIdleMs]   等工具时的上限（默认 31 分钟）
 * @param {number} [opts.llmIdleMs]    等模型回话时的上限（默认 5 分钟）
 * @param {(sid: string, info: object) => void} [opts.onStuck] 掐之前敲一下（自动续跑用）
 * @param {number} [opts.hardAfterMs]  软掐后再等多久强清（默认 60 秒）
 * @param {number} [opts.tickMs]       扫的间隔（默认 15 秒）
 * @param {(tag: string, detail: string) => void} [opts.onLog]
 */
export function createTurnWatchdog(opts = {}) {
  const turns = opts.turns || (() => []);
  const liveOf = opts.liveOf || (() => undefined);
  const abort = opts.abort || (() => {});
  const forceClean = opts.forceClean || (() => {});
  const idleMs = Number(opts.idleMs) > 0 ? Number(opts.idleMs) : 12 * 60 * 1000;
  const toolIdleMs = Number(opts.toolIdleMs) > 0 ? Number(opts.toolIdleMs) : 31 * 60 * 1000;
  const llmIdleMs = Number(opts.llmIdleMs) > 0 ? Number(opts.llmIdleMs) : 5 * 60 * 1000;
  const hardAfterMs = Number(opts.hardAfterMs) > 0 ? Number(opts.hardAfterMs) : 60 * 1000;
  const tickMs = Number(opts.tickMs) > 0 ? Number(opts.tickMs) : 15000;
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  /** 真要放弃一个会话之前敲一下（给「自动续跑」用） */
  const onStuck = typeof opts.onStuck === 'function' ? opts.onStuck : () => {};
  const limits = { idleMs, toolIdleMs, llmIdleMs };

  let timer = null;
  /** sid → 软掐的时间戳（已经掐过、等它退） */
  const softAt = new Map();

  function scan(now = Date.now()) {
    const seen = new Set();
    for (const [sid, t] of turns()) {
      seen.add(sid);
      const live = liveOf(sid);
      const events = (live && Array.isArray(live.events)) ? live.events : [];
      /* 【2026-11-08 加·live 被重建时别把账算到很久以前】
       * 现场出现过「静了 700 秒才报」，可上限只有 300 秒 —— 按 15 秒一扫，
       * 第一次超限最多报 315 秒，不可能报 700。
       * 唯一说得通的解释：这个 live 是刚重建的（events 空），
       * 而回退用的 startedAt 是这一轮很早以前的开始时间。
       * 两个开始时间里取**更晚**的那个：宁可晚一点判它卡住，也不要误杀。 */
      const bornAt = Math.max(
        Number(t && t.startedAt) || 0,
        Number(live && live.startedAt) || 0,
      );
      const last = lastActivityAt(events, bornAt);
      if (!last) continue;
      const idle = now - last;
      const pick = pickLimit(events, limits);

      if (idle <= pick.ms) {
        softAt.delete(sid);
        continue;
      }

      if (!softAt.has(sid)) {
        softAt.set(sid, now);
        onLog('turn-idle-abort', sid + ' 静了 ' + Math.round(idle / 1000) + ' 秒'
          + '（' + pick.why + ' 秒），掐掉');
        try { onStuck(sid, { idleMs: idle }); } catch (e) {}
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
      /* 【2026-11-08 改·扫的时候出事要留痕】
       * 原来是 `try { scan() } catch {}` —— 万一某个会话让 scan 抛了，
       * 那一次扫描就整个中断，后面的会话一个都没检查。
       * 现场出现过「静了 700 秒才报」（上限 300 秒），很可能就是这种静默中断。
       * 现在至少落一行 diag，下次再看到这种跳数就能对上号。 */
      timer = setInterval(() => {
        try { scan(); } catch (e) { try { onLog('watchdog-scan-error', String((e && e.message) || e)); } catch {} }
      }, tickMs);
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
    limits() { return { idleMs, toolIdleMs, llmIdleMs, hardAfterMs, tickMs }; },
  };
}
