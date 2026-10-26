/**
 * 「僵死」的兜底：让一个 await 有真正到点的时候。
 *
 * 为什么需要它
 * ------------
 * agent.mjs 里那两道闸（哑转闸 STALL_LIMIT、时间闸 TURN_WALL_LIMIT_MS）都只在
 * **每一轮开头** 判一次。可真正难看的僵死不是「一直在转」，而是「卡住不动」：
 *
 *   - 上游 LLM 建了连接，一个字节都不吐（网关抽风、模型在思考、防火墙吞包）
 *   - 读流读到一半，不结束也不报错
 *   - 某个工具蹲在那里等输入
 *
 * 这几种情况下循环根本走不到下一轮的检查点，两道闸一次都轮不到执行 ——
 * 主人看到的就是界面停在半句话上，一直不动，连「我卡住了」都等不到。
 *
 * 怎么办
 * ------
 * 三件事：
 *   1. withTimeout：给一个 await 套上「到点就认输」的外壳，报一个 timeout 错，
 *      而不是永远挂着。配合 AbortSignal 用，认输后顺手把底层连接掐掉。
 *   2. StallWatch：一路记「最后一次有动静是什么时候」。每收到一个字节、
 *      每跑完一个工具，都拍一下。超过窗口没动静就判定僵住。
 *   3. 所有报错都带 isTimeout 标记，上层据此区分「上游抽风」和「代码写错了」。
 *
 * 这里的窗口都拍得比较宽：正常一轮里，模型思考几十秒、跑一条命令几分钟
 * 都有。宁可慢一点认输，也不要把正在干活的一轮误判成僵死。
 */

function numOr(raw, fallback) {
  const n = Number(String(raw ?? '').trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** 上游 LLM 一个字节都不吐的忍耐上限（默认 5 分钟） */
export const LLM_IDLE_MS = numOr(process.env.LLM_IDLE_TIMEOUT_MS, 5 * 60 * 1000);

/** 单个工具从开跑到返回的忍耐上限（默认 30 分钟；跑整套回归、装依赖都够） */
export const TOOL_MAX_MS = numOr(process.env.TOOL_MAX_TIMEOUT_MS, 30 * 60 * 1000);

/** 整轮允许的最长静默（默认 45 分钟）—— 哑转闸管「一直在转」，这个管「完全不动」 */
export const TURN_IDLE_MAX_MS = numOr(process.env.TURN_IDLE_MAX_MS, 45 * 60 * 1000);

function fmtMins(ms) {
  const m = ms / 60000;
  if (m >= 1) return (Math.round(m * 10) / 10) + ' 分钟';
  // 不足 1 秒的也别说成「0 秒」—— 那样看不出是真卡还是配错了
  if (ms >= 1000) return (Math.round(ms / 1000 * 10) / 10) + ' 秒';
  return Math.round(ms) + ' 毫秒';
}

/**
 * 给一个 promise 套上到点认输。
 *
 * @param {Promise|any} work          要等的东西
 * @param {number} ms                 最多等多久
 * @param {object} [opts]
 * @param {string} [opts.what]        报错时说清是哪儿卡住了
 * @param {AbortController} [opts.ac] 认输时顺手把底层连接掐掉
 * @param {() => any} [opts.onTimeout] 认输那一刻要做的清理
 * @returns {Promise<any>}
 */
export function withTimeout(work, ms, opts = {}) {
  const what = opts.what || '这一步';
  const limit = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (!limit) return Promise.resolve(work);

  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(what + '静了超过 ' + fmtMins(limit) + '，我认输，不往下等了。');
      err.isTimeout = true;
      err.timeoutMs = limit;
      err.what = what;
      try { opts.onTimeout?.(); } catch {}
      try { opts.ac?.abort('timeout'); } catch {}
      reject(err);
    }, limit);
    // 别让这个定时器把进程吊着不退出
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([Promise.resolve(work), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * 拍一下 —— 记「最后一次有动静」。
 *
 * agent.mjs 每一轮开头调 watch.check()，超了就地收尾；
 * 读流的地方每收到一块就 watch.beat()。
 */
export class StallWatch {
  constructor(limitMs = TURN_IDLE_MAX_MS) {
    this.limitMs = limitMs;
    this.lastAt = Date.now();
    this.lastWhat = '开跑';
  }

  /** 有动静了（收到字节、工具跑完、任意进展） */
  beat(what) {
    this.lastAt = Date.now();
    if (what) this.lastWhat = what;
  }

  /** 静了多久（毫秒） */
  idleMs() {
    return Date.now() - this.lastAt;
  }

  /** 僵住了没有 */
  stalled() {
    return this.idleMs() > this.limitMs;
  }

  /** 说人话：静了 X 分钟，最后一步是 Y */
  describe() {
    const mins = Math.round(this.idleMs() / 60000 * 10) / 10;
    return '已经 ' + mins + ' 分钟没有任何进展了（最后一步：' + this.lastWhat + '）';
  }
}

/**
 * 守着一条流：只要超过 limitMs 没有 beat，就开火。
 *
 * 为什么不直接对每个 chunk 套 withTimeout：流式响应一秒能来几十个 chunk，
 * 每个都建一个定时器、再清掉，太吵也没必要。看门狗是「一个定时器盯全程」，
 * 收到数据就重置。
 *
 * 用法：
 *   const guard = stallGuard({ what: '上游吐字', limitMs: LLM_IDLE_MS });
 *   for await (const chunk of guardedStream(res.body, guard)) { ... }
 *   // guardedStream 的 finally 里会自动 guard.stop()
 */
export function stallGuard(opts = {}) {
  const what = opts.what || '这一步';
  const limitMs = Number.isFinite(opts.limitMs) && opts.limitMs > 0 ? opts.limitMs : LLM_IDLE_MS;
  const watch = new StallWatch(limitMs);
  let timer = null;
  let stopped = false;
  let fired = null;

  const arm = () => {
    if (stopped || !(limitMs > 0)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (stopped) return;
      fired = new Error(what + '静了超过 ' + fmtMins(limitMs) + '，我认输，不往下等了。');
      fired.isTimeout = true;
      fired.timeoutMs = limitMs;
      fired.what = what;
      fired.stall = true;
      try { opts.onStall?.(fired); } catch {}
    }, limitMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  arm();

  return {
    what,
    limitMs,
    /** 有动静了 */
    beat(w) { if (stopped) return; watch.beat(w); arm(); },
    /** 看门狗已经开火了吗（开火了就把 error 抛出去） */
    error() { return fired; },
    stop() { stopped = true; if (timer) { clearTimeout(timer); timer = null; } },
    watch,
  };
}

/**
 * 把一条流包上「看门狗」：读的同时盯着，静默超窗就把这条流取消。
 *
 * 为什么单独抽出来：llm.mjs 里那段读流的 for-await 是个大循环，直接在里面
 * 塞 Promise.race 会把缩进和 yield 搅乱（真搅乱过一次）。包成独立的生成器，
 * 循环体一个字都不用动，只把 `res.body` 换成 `guardedStream(res.body, guard)`。
 *
 * 踩过的坑（必须留在这）：看门狗开火时**不能**在外面调 `stream.cancel()` ——
 * 这个生成器已经用 `[Symbol.asyncIterator]()` 把流拿住了，Node 的
 * ReadableStream 处于锁定状态，外部再 cancel 会抛
 * `ERR_INVALID_STATE: ReadableStream is locked`，而且是在定时器回调里抛，
 * 直接成未捕获异常把整个进程带走（实测过）。必须由拿着 reader 的这边自己
 * 调 `it.return()` —— 对 ReadableStream 的异步迭代器来说那就是 cancel。
 */
export async function* guardedStream(stream, guard) {
  const it = stream[Symbol.asyncIterator]();
  const limitMs = guard.limitMs || LLM_IDLE_MS;
  // 多久去看一眼看门狗。窗口的 1/4，夹在 50ms~1s 之间 —— 既能及时反应，也不空转。
  const tickMs = Math.max(50, Math.min(1000, Math.floor(limitMs / 4)));

  try {
    for (;;) {
      let tick = null;
      const stalled = new Promise((_, reject) => {
        tick = setInterval(() => {
          const e = guard.error();
          if (e) reject(e);
        }, tickMs);
        if (typeof tick.unref === 'function') tick.unref();
      });

      let step;
      try {
        step = await Promise.race([it.next(), stalled]);
      } finally {
        if (tick) clearInterval(tick);
      }

      if (step.done) return;
      guard.beat('收到数据块');
      yield step.value;
    }
  } finally {
    guard.stop();
    // 由拿着 reader 的这边自己收尾（见上面那条坑）
    try { await it.return?.(); } catch {}
  }
}
