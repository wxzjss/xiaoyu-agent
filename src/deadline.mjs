/**
 * 「僵死」的兜底：让一个 await 有真正到点的时候。
 *
 * 为什么需要它
 * ------------
 * agent.mjs 里那道时间闸（TURN_WALL_LIMIT_MS）只在
 * **每一轮开头** 判一次。可真正难看的僵死不是「一直在转」，而是「卡住不动」：
 *
 *   - 上游 LLM 建了连接，一个字节都不吐（网关抽风、模型在思考、防火墙吞包）
 *   - 读流读到一半，不结束也不报错
 *   - 某个工具蹲在那里等输入
 *
 * 这几种情况下循环根本走不到下一轮的检查点，那道闸一次都轮不到执行 ——
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

/**
 * 带下限的 numOr —— 专门用来读「等多久」这类配置。
 *
 * 为什么要有下限：这几个值一旦配得太小，界面就会在最平常的一轮里刷出
 * 「静了超过 600 毫秒，我认输，不往下等了」，看着像程序坏了，其实是配置
 * 把人正常思考的时间也算成了僵死。（2026-10-26 真踩过：调试时在外壳里设了
 * LLM_IDLE_TIMEOUT_MS=600 忘了撤，之后起的服务全继承了这个 600，主人一说话
 * 就弹认输。）
 *
 * 所以：低于下限的一律退回默认值，并在 stderr 留一行警告 —— 宁可安静地
 * 用默认值，也不要让一个手滑的数字毁掉整场对话。
 */
/**
 * 测试放行开关：只在跑验证脚本时打开（MINI_AGENT_DEADLINE_TEST=1）。
 * 打开后不套下限，可以把窗口压到秒级；生产上这个变量不存在，行为不变。
 */
const DEADLINE_TEST_MODE = String(process.env.MINI_AGENT_DEADLINE_TEST ?? '').trim() === '1';

function msOr(raw, fallback, floorMs, name) {
  const n = Number(String(raw ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return fallback;
  if (n < floorMs) {
    try {
      console.warn(`[deadline] ${name}=${n} 太短了（下限 ${floorMs} 毫秒），已退回默认 ${fallback} 毫秒。`);
    } catch { /* 忽略 */ }
    return fallback;
  }
  return n;
}

/**
 * 上游 LLM 一个字节都不吐的忍耐上限。
 *
 * 默认 10 分钟，最少给 3 分钟。
 *
 * 为什么定这么长：这个闸的本意是「上游真卡死了别让界面永远转圈」，
 * 不是「催模型快点说话」。模型在长任务里憋半分钟一分钟都是常事，
 * 主人刚发完消息就弹「我认输」是最难受的观感 —— 2026-10-26 踩过，
 * 那次还是被一个残留的 LLM_IDLE_TIMEOUT_MS=600 坑的。
 *
 * 所以宁可 10 分钟才认输（那时基本可以确定是真卡死了），
 * 也不要为了「反应快」在正常人身上误报。
 *
 * 【2026-11-07 改·10 分钟 → 2 分钟】
 *
 * 上面那个理由成立的前提是「长时间没有块 = 模型在憋大招」。可实测不是这样：
 *   · 真在思考时，reasoning 是**一块一块流回来**的 —— 每块都会 beat 看门狗；
 *   · 真卡住时，是**一个块都没有**（events = 0）。
 * 这两件事在「有没有 chunk」上分得很干净，所以空闲阈值只该按「多久没收到一个字节」算。
 *
 * 主人今晚遇到的就是后者：两个会话 running 挂着、events 全是 0，
 * 界面一动不动，可程序认为「还在正常等」，要等满 10 分钟才认输。
 * 10 分钟对使用者来说就是「卡死了」，等它自己恢复之前人早就烦了。
 *
 * 2 分钟：正常首字 1~3 秒，长思考也一直在吐块；两分钟一个字节都没有，
 * 基本可以确定是上游挂了。下限降到 30 秒（`LLM_IDLE_TIMEOUT_MS` 设得比这更小才视为误配）。
 */
/**
 * 【2026-11-08 再改·2 分钟 → 4 分钟】
 *
 * 主人 11-08 凌晨问「为什么会话总是做任务做着做着自己停了」。
 * 查 diag.log：00:53~01:07 这十几分钟里，**六个会话轮着被掐**：
 *   静了 700 秒 / 325 秒 / 443 秒 / 306 秒 / 310 秒 / 305 秒 —— 全是撞 5 分钟那条线。
 *
 * 再往回看，2 分钟这条线也在误杀：`等上游开始回话静了超过 2 分钟，我认输`。
 * DeepSeek 在大上下文 + 长思考时，首字三五分钟很常见，两分钟就认输等于
 * 「每次想得久一点就自己断」，主人看到的就是「做着做着自己停了」。
 *
 * 【2026-11-11 放宽 4 分钟 → 8 分钟】真机 diag.log 实测（11-10 16:39）：
 *   [turn-idle-abort] 静了 313 秒（在等模型回话，上限 300 秒），掐掉
 * 「长思考一直在吐块」在这个网关上不成立 —— 推理型模型 + 网关缓冲，
 * 想复杂任务时可以整整五分钟一个字节都不吐，然后照样把活干完。
 * 4 分钟会把她正在进行的思考掐死在半路（主人 11-11 又报了一次同款：
 * 「做着做着系统突然显示【停止】」）。8 分钟仍然能抓住真挂死
 * （挂死是真的一动不动，8 分钟照旧一个字节都没有），但不再误杀长思考。
 * 真挂的时候下面 recovery 还会再给一次机会（见 classify 的 isTimeout 分支）。
 */
export const LLM_IDLE_MS = msOr(process.env.LLM_IDLE_TIMEOUT_MS, 8 * 60 * 1000, DEADLINE_TEST_MODE ? 1 : 30 * 1000, 'LLM_IDLE_TIMEOUT_MS');

/** 单个工具从开跑到返回的忍耐上限（默认 30 分钟，最少给 3 分钟；跑整套回归、装依赖都够） */
export const TOOL_MAX_MS = msOr(process.env.TOOL_MAX_TIMEOUT_MS, 30 * 60 * 1000, DEADLINE_TEST_MODE ? 1 : 3 * 60 * 1000, 'TOOL_MAX_TIMEOUT_MS');

/**
 * 工具跑到这个点先喊一声「还在跑」（默认 10 分钟，最少给 30 秒）。
 *
 * 为什么要留可调：跑大活时主人一直没动静，他分不清我是在干活还是卡死了。
 * 但每个主人的耐心不一样，有人 5 分钟就想知道，有人跑一小时的转码不想被打断。
 * 所以这个点也做成环境变量，能调、能关（设成很大的数就等于不喊）。
 *
 * 注意：真正的提醒点还会被压到「不超过工具总窗口的 1/3」——
 * 不然还没喊完就该掐了，那句话等于废话。
 */
export const TOOL_NOTICE_MS = msOr(process.env.TOOL_NOTICE_TIMEOUT_MS, 10 * 60 * 1000, DEADLINE_TEST_MODE ? 100 : 30 * 1000, 'TOOL_NOTICE_TIMEOUT_MS');

/** 整轮允许的最长静默（默认 60 分钟，最少给 10 分钟）—— 这个管「完全不动」（哑转闸 2026-10-29 已删） */
/**
 * 整轮静默上限（这一轮里一直没有任何事件）。
 *
 * 【2026-11-08 改·60 分钟 → 5 分钟，而且这次真的有人用它】
 *
 * 这个常量以前只是躺在表里：`harness/recovery.mjs` 的 DEADLINES 引了一下，
 * **没有任何代码真的按它去判**。所以卡住的轮次可以挂到天荒地老 ——
 * 实测三个会话同时卡着、events 不动、会话文件十几分钟不写，界面一直显示「正在跑」。
 *
 * 现在由 `harness/turn-watchdog.mjs` 真正执行它：
 * 整轮静默超过这个数就掐；正在等工具的那段时间另算（TOOL_MAX_MS + 1 分钟），
 * 因为工具本来就允许跑很久。
 *
 * 【2026-11-08 再改·5 分钟 → 12 分钟，而且「等模型」另立一档】
 *
 * 5 分钟这条线是照「界面卡住」定的，可它把**正在正常思考**也算进去了：
 * 只要上游在思考阶段不吐字，事件流就不动，5 分钟一到照样掐。
 * 主人凌晨那六个被掐的会话，全都是这么死的。
 *
 * 现在分三档（见 turn-watchdog 的 pickLimit）：
 *   · 最后一条事件是模型吐字 → 用 LLM_IDLE_MS + 1 分钟（等模型，本来就该由 LLM 层管）
 *   · 最后一条是 tool_start     → 用 TOOL_MAX_MS + 1 分钟（工具允许跑很久）
 *   · 其余（真·什么都不在等）  → 用这个 12 分钟
 * 只有第三档才是「真空转」，那才是真卡死，12 分钟已经够狠了。
 */
export const TURN_IDLE_MAX_MS = msOr(process.env.TURN_IDLE_MAX_MS, 12 * 60 * 1000, DEADLINE_TEST_MODE ? 1 : 30 * 1000, 'TURN_IDLE_MAX_MS');

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

  /**
   * 中途报平安：跑到 noticeAt 先喊一声，然后接着等。
   *
   * 为什么要有：跑大活（整套回归、装依赖、转视频）十几分钟很正常，
   * 主人那边一直没动静，他分不清我是在干活还是卡死了。
   * 到点喊一句「还在跑」，比让人干等半小时强。
   */
  const noticeAt = Number.isFinite(opts.noticeAt) && opts.noticeAt > 0 && opts.noticeAt < limit
    ? opts.noticeAt
    : 0;

  let timer = null;
  let noticeTimer = null;

  const timeout = new Promise((_, reject) => {
    if (noticeAt) {
      noticeTimer = setTimeout(() => {
        try { opts.onNotice?.(noticeAt); } catch {}
      }, noticeAt);
      if (typeof noticeTimer.unref === 'function') noticeTimer.unref();
    }
    timer = setTimeout(() => {
      const err = new Error(what + '静了超过 ' + fmtMins(limit) + '，我认输，不往下等了。');
      err.isTimeout = true;
      err.timeoutMs = limit;
      err.what = what;
      try { opts.onTimeout?.(); } catch {}
      try {
        /* 【2026-11-05 修·「认输后顺手掐掉底层连接」从来没生效过】
         *
         * 这里注释一直写着 ac 是 AbortController，可调用方（agent.mjs）传的是
         * **AbortSignal** —— 它没有 .abort()。所以 `ac?.abort('timeout')` 必然抛
         * TypeError，又被这个空 catch 吞掉，一点痕迹都不留。
         * 后果：30 分钟到点后 agent 往下走了，但子进程 / 浏览器 / 视频任务还活着，
         * 继续占 CPU、继续写工作区。
         *
         * 现在两种都认：真给了 controller 就掐；只给 signal 就不硬来（标准里
         * AbortSignal 没有主动中止的入口），但至少不再抛错把后面的清理一起吞掉。
         * 想把子进程真正干掉，调用方要传 AbortController。
         */
        const ac = opts.ac;
        if (ac && typeof ac.abort === 'function') ac.abort('timeout');
        else if (ac && process.env.TOOL_DEBUG === '1') {
          console.warn('[deadline] 只拿到 AbortSignal，没法主动中止（' + what + '）—— 需要调用方传 AbortController');
        }
      } catch {}
      reject(err);
    }, limit);
    // 别让这个定时器把进程吊着不退出
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([Promise.resolve(work), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
    if (noticeTimer) clearTimeout(noticeTimer);
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
  // 多久去看一眼：窗口的 1/4，夹在 50ms~1s 之间 —— 反应够快，也不空转。
  const tickMs = Math.max(50, Math.min(1000, Math.floor(limitMs / 4)));

  /**
   * 【为什么要 race，而不是只靠 it.return()】
   *
   * 两版都试过，各有各的死法，最后只能两个都要：
   *
   * 一、只用 Promise.race([it.next(), stalled])：
   *    stalled 准时 reject，外层确实被叫醒了。但 it.next() 还在后台悬着，
   *    若流真的永远不动，它就一直悬着，反复几轮就是泄漏。
   *
   * 二、只用 it.return()（定时器里主动收流）：
   *    对「还能响应 return 的流」很干净，但它治不了真正卡死的流 ——
   *    如果那个迭代器正 await 一个永不 settle 的 promise，it.return() 会
   *    跟着一起吊住，于是 await it.next() 永远不返回，整个 for-await 卡死。
   *    实测：800ms 的窗口，进程直接带着 "unsettled top-level await" 退出。
   *
   * 所以现在是：race 负责「外层一定被叫醒」，it.return() 负责「尽量把流
   * 收掉，别留悬着的东西」。谁先到就听谁的，另一条路不会把流程钉死。
   */
  let timedOut = null;
  let tick = null;

  const arm = () => {
    if (tick) clearInterval(tick);
    tick = setInterval(() => {
      const e = guard.error();
      if (!e) return;
      timedOut = e;
      try { if (tick) { clearInterval(tick); tick = null; } } catch {}
      // 顺手把流收掉。收得掉最好，收不掉也没关系 —— 上面的 race 已经能返回。
      try { it.return?.()?.catch?.(() => {}); } catch {}
    }, tickMs);
    if (typeof tick.unref === 'function') tick.unref();
  };

  try {
    for (;;) {
      arm();
      let step;
      /**
       * 【2026-11-09 修·叫醒器的定时器没人清，每读一块漏一个】
       *
       * stalledPromise 里的 interval 只在「看门狗开火」那条路上被 clearInterval。
       * 可绝大多数情况是 it.next() 先赢 —— 这时那个 interval 谁也不管，
       * 而且它**故意没 unref**（unref 了就叫不醒 race）。结果：
       * 一块数据 = 一个永远在跑的定时器，进程也再也退不出去
       * （实测：本地假网关跑一遍 streamChat，脚本挂到超时被杀）。
       *
       * 现在这一轮自己拿住它，race 一有结果就在 finally 里收掉。
       */
      const stalled = stalledPromise(guard, tickMs);
      try {
        step = await Promise.race([it.next(), stalled]);
      } catch (err) {
        if (timedOut || guard.error()) throw timedOut || guard.error();
        throw err;
      } finally {
        stalled.stop();
        if (tick) { try { clearInterval(tick); } catch {} tick = null; }
      }
      if (timedOut || guard.error()) throw timedOut || guard.error();
      if (!step || step.done) return;
      guard.beat('收到数据块');
      yield step.value;
    }
  } finally {
    if (tick) { try { clearInterval(tick); } catch {} }
    guard.stop();
    // 这里千万不能直接 await it.return()。
    // 流若已经卡死（迭代器正 await 一个永不 settle 的 promise），
    // it.return() 会跟着一起吊住，于是 finally 永不返回 —— 而 finally 卡住，
    // 上面那个 timeout 错误就永远传不出去，整个对话卡死在这。实测过。
    // 所以：发出去就不管了，最多等一小会儿。
    try {
      const closing = it.return?.();
      if (closing && typeof closing.then === 'function') {
        await Promise.race([
          closing.catch(() => {}),
          new Promise((r) => { const t = setTimeout(r, 50); if (t.unref) t.unref(); }),
        ]);
      }
    } catch {}
  }
}

/**
 * 「看门狗开火」做成一个会 reject 的 promise，专门用来把 race 叫醒。
 * 每次进循环都新建一个。
 *
 * 【必须带 stop()】race 可能是 it.next() 先赢，那时这个 interval 就没人清了 ——
 * 而它又不能 unref（unref 掉进程闲着时压根不跑，race 就白等）。所以把清定时器的
 * 责任交给调用方：race 一有结果就 stop()。见 guardedStream 里的 finally。
 */
function stalledPromise(guard, tickMs) {
  let timer = null;
  const stalled = new Promise((_, reject) => {
    timer = setInterval(() => {
      const e = guard.error();
      if (e) {
        if (timer) { clearInterval(timer); timer = null; }
        reject(e);
      }
    }, tickMs);
    // 故意**不** unref：这个定时器存在的唯一目的就是把 race 叫醒，
    // unref 掉以后它可能压根不跑（进程没别的活儿时），race 就白等了。
  });
  /** 这一轮结束了，把定时器收掉 */
  stalled.stop = () => {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  };
  return stalled;
}
