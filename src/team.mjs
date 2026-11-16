/**
 * team.mjs —— 【团队模式】的后台派发与结果回传（2026-11-11）。
 *
 * 设计文档：docs/design-team-mode.md。跟【办事模式】的根本区别：
 *   · 主智能体的手**留着**，派活是**后台**的 —— spawn 立刻返回门牌号，
 *     worker 在后台跑，干完把汇报主动递回来；
 *   · worker 不挂主轮的 signal（主人点「停止」说的是主轮那句话，
 *     不是「把派出去的人都杀了」）；要停某个 worker 走 /api/team/stop。
 *
 * 这个文件管三样东西：
 *   ① worker 控制器池 —— Map<sid, Map<wid, AbortController>>，
 *      /api/team/stop 从池里取了 abort（设计文档 A2 的结论）；
 *   ② 后台派发 dispatchWorker —— 不等 runSubagent，立刻返回；
 *   ③ 结果回传 reportWorkerResult —— followup + _sysNote（不冒充主人说话），
 *      主轮还活着就排下一轮，死了就自己投引子起一轮（照 selfwake 的路）。
 *
 * 【为什么不直接 import server.mjs】起轮、liveLogs 全在 server.mjs 的闭包里，
 * 反过来 import 会成环 —— 跟 setPeerWake 一个道理，由 server 启动时把通道
 * 注入进来（setTeamChannels）。没注入时降级：回传只排 followup，不起轮。
 */

import { readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { config } from './config.mjs';

/** worker 轨迹目录：跟花名册同级，用同一个 dataDir。
 *  2026-11-16 借鉴 WB 的 appendToOutputFileById —— 汇报必须落到磁盘上，
 *  不能只活在内存的 said 字段里（模型返回空就全丢）。 */
function workerTraceDir(sessionId) {
  return join(config.dataDir, '.state', 'worker-trace', String(sessionId || 'default'));
}
import { featureOnFor } from './features.mjs';
import { followup, peekInbox, drainTurns } from './inbox.mjs';
import { drainWorkerMail, finishWorker, listWorkers, noteWorker, workersPath, beatWorker, findStalledWorkers, reapStalledWorker } from './task-mode.mjs';
import { enforceZhWorkerName } from './name-zh.mjs';

/** 这个会话现在开没开团队模式。读盘失败 = 没开（fail-closed，跟 taskOn 同一口径）。 */
export function teamOn(sessionId) {
  try {
    return featureOnFor(String(sessionId || 'default'), 'team') === true;
  } catch {
    return false;
  }
}

/* ── ① worker 控制器池 ──────────────────────────────────────────── */

/** sid -> Map<wid, AbortController> */
const CTRLS = new Map();

function poolFor(sid) {
  const key = String(sid || 'default');
  let m = CTRLS.get(key);
  if (!m) { m = new Map(); CTRLS.set(key, m); }
  return m;
}

/** 开跑前登记；stop 才找得到它。 */
export function registerWorkerCtrl(sid, wid, ac) {
  try { poolFor(sid).set(String(wid), ac); } catch {}
}

/**
 * 【2026-11-16 主人问「子Agent 干活死了会自动删显示吗」】
 *
 * 进程池里有没有这个 worker —— 判断「它到底还在不在跑」的唯一可靠依据。
 * 花名册是磁盘上的账，进程被硬杀（重启 / 崩溃 / 任务管理器杀掉）时它来不及改，
 * 于是界面会一直显示「干活中…」，其实早死了。
 */
export function isWorkerAlive(sessionId, wid) {
  try {
    const m = CTRLS.get(String(sessionId || 'default'));
    return !!(m && m.has(String(wid || '').replace(/^#/, '')));
  } catch { return false; }
}

/** 本进程启动时刻 —— 早于它的 running 一定是上个进程留下的。 */
export const BOOT_AT = Date.now();

/** 收尾注销（跑完 / 停掉 / 挂了都要调，别让池子涨）。 */
export function releaseWorkerCtrl(sid, wid) {
  try {
    const m = CTRLS.get(String(sid || 'default'));
    if (m) m.delete(String(wid));
  } catch {}
}

/**
 * 停一个 worker：abort 它的 signal + 花名册记 'stopped'。
 *
 * 【语义】轮边界照旧、run_command 类工具即时断 —— subagent 的 abort 链
 * （signal → worker 自己的 abortCtrl → runTool 的 overrideSignal）已经把
 * 「工具即时断」这条修通了（见 commit d58a0e9）。
 */
export function stopWorker(sessionId, wid) {
  const sid = String(sessionId || 'default');
  const key = String(wid || '').trim().replace(/^#/, '');
  if (!key) return { ok: false, error: '没说停哪个（wid 是空的）' };
  const ac = poolFor(sid).get(key);
  if (!ac) {
    /* 池里没有：要么它已经跑完了，要么是上个进程留下的。照实说。 */
    return { ok: false, error: '没有正在跑的 #' + key + '（它可能已经跑完了）' };
  }
  try { ac.abort('stopped'); } catch {}
  releaseWorkerCtrl(sid, key);
  try { finishWorker(sid, key, { status: 'stopped' }); } catch {}
  /* 【2026-11-13 验收补漏·第四类】手动停也是「停了」—— 主智能体还在等这个
   * worker 的汇报，得让她知道它不会再回来了，别干等在那儿。 */
  try {
    const _w = Array.from(listWorkers(sid) || []).find((x) => String(x && x.id) === key);
    notifyWorkerInterrupted(sid, key, _w && _w.name, '被手动停下了（不是它自己出错）');
  } catch {}
  return { ok: true, id: key };
}

/* ── 注入通道 ───────────────────────────────────────────────────── */

let _channels = { pushWorkerEvent: null, isTurnRunning: null, startTurnWithIntro: null };

/**
 * server.mjs 启动时注入三条通道：
 *   pushWorkerEvent(sid, ev)      worker 事件落进该会话的 liveLogs（主轮结束后也能被前端收到）
 *   isTurnRunning(sid)            这个会话此刻有没有正在跑的轮
 *   startTurnWithIntro(sid, text) 投一条 context+sysNote 引子再起一轮（照 selfwake 的路）
 */
export function setTeamChannels(c = {}) {
  _channels = {
    pushWorkerEvent: typeof c.pushWorkerEvent === 'function' ? c.pushWorkerEvent : null,
    isTurnRunning: typeof c.isTurnRunning === 'function' ? c.isTurnRunning : null,
    startTurnWithIntro: typeof c.startTurnWithIntro === 'function' ? c.startTurnWithIntro : null,
  };
}

function pushWorkerEvent(sid, ev) {
  try { _channels.pushWorkerEvent && _channels.pushWorkerEvent(sid, ev); } catch {}
}

/* ── ② 后台派发 ─────────────────────────────────────────────────── */

/**
 * 后台跑一个 worker，立刻返回（调用方拿到 Promise 只用来兜异常，不 await）。
 *
 * 【signal 为什么自己 new】设计文档 A2：后台 worker 绝不能拿 ctxNow().signal
 * （那是主轮的信号，主人点停止会把 worker 连带杀掉）。这里的 controller
 * 只听 /api/team/stop 的。
 *
 * 【事件走哪条路】不用 ctxNow().pushEvent —— 那是主轮的 live 缓冲，主轮一收尾
 * 就没了；走注入进来的 pushWorkerEvent（liveLogs），主轮结束后前端照样收得到。
 */
export function dispatchWorker({ sessionId, wid, name, brief, maxRounds, timeoutMs }) {
  const sid = String(sessionId || 'default');
  const key = String(wid);
  /* 【2026-11-13 主人钦点】名字必须是中文：这里兜底也走同一套规矩 */
  const nick = enforceZhWorkerName(name, '工').name;
  const ac = new AbortController();
  registerWorkerCtrl(sid, key, ac);

  const pushEv = (kind, text, extra) => {
    pushWorkerEvent(sid, Object.assign({ type: 'worker', wid: key, name: nick, kind, text: String(text || '') }, extra || {}));
  };

  /* 【2026-11-16 借鉴 WB】轨迹落盘缓冲：worker 每一行进度都记下来。
   * 为什么要这个 —— 本会话实测：worker 模型最后返回空字符串时 r.text 是 ''，
   * 汇报整段蒸发（花名册 said 空、父层什么都收不到、报告文件根本没生成）。
   * WB 的做法是 appendToOutputFileById 强制落文件，这里照搬：轨迹先落盘，
   * 空汇报就用轨迹兜底回传，绝不让一次派活白跑。 */
  const trace = [];
  const traceFile = join(workerTraceDir(sid), String(key) + '.txt');

  const run = (async () => {
    let r = null;
    /* 【防误杀·2026-11-16】进轮/工具落地那两个心跳不够：跑一条 11 分钟的长命令期间
     * 心跳不动，而 STALL_MS 才 6 分钟 —— 必然被当成死掉。这里再挂一个定时器：
     * 只要这个 worker 进程还活着就按时踩一脚，真死了脚自然就停了。 */
    const __hb = setInterval(() => { try { beatWorker(sid, key); } catch {} }, 20000);
    try { __hb.unref?.(); } catch {}
    try {
      const { runSubagent } = await import('./subagent.mjs');
      pushEv('start', '开始干：' + String(brief || '').slice(0, 120), { startedAt: Date.now() });
      r = await runSubagent({
        task: String(brief || ''),
        name: nick,
        sessionId: sid,
        maxRounds: Number(maxRounds) > 0 ? Number(maxRounds) : 60,
        timeoutMs: Number(timeoutMs) > 0 ? Number(timeoutMs) : undefined,
        allowWrite: true,
        signal: ac.signal,
        pullMails: () => {
          try { const ms = drainWorkerMail(sid, key); if (ms && ms.length) pushEv('mail', '收到补话：' + ms.map((m) => m.text).join(' / ').slice(0, 160)); return ms; } catch { return []; }
        },
        // 【心跳】每轮开跑/每个工具落地都刷新 lastBeatAt —— 判死只看这个
        // 【实时轮次】subagent 那边两处 onBeat 分别传 {round} 和 {round, tool}，
        // 以前这里把它整个丢掉，导致 watch_worker 干活期间永远显示 0 轮 0 工具。
        onBeat: (info) => {
          try {
            const p = info && typeof info === 'object' ? info : {};
            beatWorker(sid, key, { round: p.round, tool: p.tool, lastTool: p.tool });
          } catch {}
        },
        onProgress: (line) => {
          pushEv('step', line);
          /* 每一行都进轨迹缓冲（封顶 800 行，防长活把内存吃光） */
          try { if (trace.length < 800) trace.push(String(line || '').slice(0, 300)); } catch {}
        },
      });
    } catch (e) {
      r = { ok: false, text: '子智能体没起来：' + String(e?.message ?? e) };
    }
    try { clearInterval(__hb); } catch {}
    /* 【落盘】轨迹无条件写一份，谁想复查都能查到它到底干了啥 */
    try { mkdirSync(workerTraceDir(sid), { recursive: true }); writeFileSync(traceFile, trace.join('\n'), 'utf8'); } catch {}
    let text = String((r && r.text) || '').trim();
    /* 【空汇报兜底 2026-11-16】模型返回空 = 这次派活全白干。
     * 用轨迹尾巴拼一份可读交代，至少让父层知道它走到哪、卡在哪。 */
    if (!text) {
      const tail = trace.slice(-12).join('\n');
      if (tail) {
        text = (r && r.ok ? '（模型没写汇报，以下是它最后几步的轨迹）\n' : '（子智能体没写汇报，以下是最后几步轨迹）\n') + tail
          + '\n\n完整轨迹：' + traceFile;
      } else if (r && !r.ok) {
        text = '子智能体出错了，且没有任何进度记录。';
      } else {
        text = '（子智能体跑完但没留下任何汇报和轨迹）';
      }
      /* 补一句进实时事件，界面上也能看见它变成兜底汇报 */
      try { pushEv('step', '⚠ 模型没写汇报，已用轨迹兜底'); } catch {}
    }
    const stopped = ac.signal.aborted;      // 只有 /api/team/stop 会拉这一根
    try {
      finishWorker(sid, key, {
        status: stopped ? 'stopped' : (r && r.ok ? 'reported' : 'failed'),
        rounds: r && r.rounds,
        tools: r && r.tools,
        said: text,
      });
    } catch {}
    /* 【严检】end 事件原来没保护 —— 它一抛，下面的 reportWorkerResult 就被跳过，
     * 再被 run.catch(() => {}) 静默吞掉 = 汇报蒸发。包住，别让画事件挡住汇报。 */
    try { pushEv('end', '', {
      status: stopped ? 'stopped' : (r && r.ok ? 'ok' : 'err'),
      note: text.slice(0, 400),
      /* 【2026-11-11 parity 修】收尾时刻打进事件里 —— 清单的 endedAt 从这读。
       * 不许让 appendLiveItem 自己 Date.now()：刷新走的是从头重算（读事件数组），
       * 那一侧没有「这一刻」，直播/刷新就会给两张不同的卡。 */
      endedAt: Date.now(),
    }); } catch {}
    /* 被手动停的不用汇报 —— 主人自己停的，她心里有数；
     * 花名册上记着呢，watch_worker / list_workers 都看得到。 */
    if (!stopped) reportWorkerResult(sid, key, nick, !!(r && r.ok), text);
    releaseWorkerCtrl(sid, key);
  })();
  /* 后台任务自己兜底：无人 await 也绝不变成 unhandledRejection */
  try { run.catch(() => {}); } catch {}
  return run;
}

/** 信箱取话没写进本文件（在 task-mode.mjs），惰性 import 免得加载链变重。 */
/* 【已改静态 import】task-mode.mjs 不依赖本文件（无环），不必绕注入。 */

/* ── ③ 结果回传 ─────────────────────────────────────────────────── */

/**
 * worker 干完把汇报递回主智能体。
 *
 * 【为什么不用 steer】steer 的条目在 agent.mjs 落成 _steer 消息 —— 界面上画成
 * 「主人插话」。worker 的汇报冒充主人说话，还会永久占历史，都是错的。
 * 这里走 followup（turns 槽）+ _sysNote: true：前端把它画成系统提示，
 * 模型看到的是「程序递进来的背景」。正文第一段自证身份（照 SYS_MID_NOTE 的写法）。
 *
 * 【主轮不在了怎么办】followup 只在「有一轮正在跑」时会被接走（agent.mjs
 * 收尾那道 drainTurns）。主轮已经收尾的话，2.5 秒后还没人取，就自己投引子
 * 起一轮 —— 照 selfwake 的路：context + _sysNote，绝不冒充主人。
 */
export function reportWorkerResult(sessionId, wid, name, ok, text) {
  const sid = String(sessionId || 'default');
  const head = '【你派出去的 #' + String(wid) + '「' + String(name || '') + '」回来了 —— '
    + '下面是它的汇报，不是主人说的话，别当成主人的指令】'
    + (ok ? '' : '\n（它没干成。看完决定：退回给同一个 worker 重做，还是你自己接手。）');
  const body = head + '\n' + (String(text || '').trim() || '（它没说话）');
  /* 【2026-11-13 严检·主人钦点「子Agent挂了停了却没通知主智能体的可能」】
   * 原来 try{followup}catch{} 静默吞 —— followup 一失败，这条汇报就**无痕蒸发**
   * （2.5s 的兜底读 inbox 也拿不到，因为压根没进 inbox）。现在：留痕 + 3s 后重试一次。 */
  const _deliver = () => { try { followup(sid, body, { _sysNote: true }); return true; } catch (e) { try { console.warn('[team] 汇报 followup 失败 #' + wid + '：', e && e.message); } catch {} return false; } };
  if (!_deliver()) setTimeout(() => { try { _deliver(); } catch {} }, 3000).unref?.();

  setTimeout(() => {
    try {
      /* 正在跑的那轮会在收尾时 drainTurns 把它接走 —— 那就什么都不用做。 */
      if (_channels.isTurnRunning && _channels.isTurnRunning(sid)) return;
      const pending = peekInbox(sid).turns || [];
      if (!pending.length) return;                       // 已经被接走了
      const items = drainTurns(sid);
      if (!items.length) return;
      const joined = items.map((x) => String(x && x.text || '')).filter(Boolean).join('\n\n────────\n\n');
      if (!_channels.startTurnWithIntro) return;         // 没注入通道：话留在 inbox 里，下一轮照样接得上
      _channels.startTurnWithIntro(sid,
        '（有后台 worker 回来了 —— 下面这条是程序替它们递的汇报，不是主人说的话。）\n\n' + joined);
    } catch { /* 回传失败不连累任何在跑的东西 */ }
  }, 2500).unref?.();
}

/* ── 重启后的中断标记 ───────────────────────────────────────────── */

/**
 * 程序启动时扫一遍花名册：还挂着 'running' 的 worker，进程已经没了 ——
 * 统一标成 'interrupted'，前端显示「中断了（程序重启过）」。
 * （设计文档 2.4 场景 C：不标的话，页面刷新后前端看到的 running 是文件里的旧状态。）
 */
export function markInterruptedWorkers() {
  let dir = '';
  try { dir = workersPath(); } catch { return { ok: false }; }
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { ok: true, swept: 0 }; }
  let swept = 0;
  for (const f of files) {
    const sid = basename(f, '.json');
    if (!sid) continue;
    try {
      for (const w of listWorkers(sid)) {
        if (w.status === 'running') {
          finishWorker(sid, w.id, { status: 'interrupted' });
          /* 【2026-11-13 验收补漏】这个函数目前没被调用（死代码），但一旦被调用，
           * 标中断也必须通知主智能体，别留第二个哑巴口。 */
          try { notifyWorkerInterrupted(sid, w.id, w.name, '程序重启过，任务被打断'); } catch {}
          swept += 1;
        }
      }
    } catch { /* 单个会话坏了不连累别的 */ }
  }
  return { ok: true, swept };
}

/* ── 中断通知（2026-11-13 严检·主人钦点「子Agent挂了停了却没通知主智能体的可能」） ── */
/**
 * worker 被标 interrupted（重启后过期 / 没任务原文 / 续跑次数超限 / 续跑派发失败）
 * 时，给对应会话的主智能体补一条程序代递的通知。
 *
 * 【为什么必须有】原来只 finishWorker 改花名册 —— 前端能看到「中断了」，
 * 但**主智能体永远不知道它死了**：她还在等汇报，等的那个 worker 已经没了。
 * 跟 reportWorkerResult 同一个画法：_sysNote 递进 inbox，不冒充主人说话。
 */
function notifyWorkerInterrupted(sid, wid, name, reason) {
  /* 【2026-11-13 验收补漏】原来一次 try{followup}catch{} 静默吞，连日志都没有 ——
   * 跟 reportWorkerResult 同款：留痕 + 3s 后重试一次。 */
  const body = '【你派出去的 #' + String(wid) + '「' + String(name || '') + '」没能跑完 —— ' + String(reason || '程序重启过，任务被打断') + '。'
    + '别再等它的汇报了；要继续这件活的话，重新派一个（进度参考花名册上的记录）。】';
  const _deliver = () => {
    try { followup(String(sid || 'default'), body, { _sysNote: true }); return true; }
    catch (e) { try { console.warn('[team] 中断通知投递失败 #' + wid + '：', e && e.message); } catch {} return false; }
  };
  if (!_deliver()) setTimeout(() => { try { _deliver(); } catch {} }, 3000).unref?.();

  /* 【2026-11-16 主人钦点】通知递进 inbox 后，如果那一轮已经收尾、没人接走，
   * 它就静静躺在信箱里 —— 主智能体要等下次开口才知道。
   * 照 reportWorkerResult 的做法：2.5 秒后还没人取，就自己投引子起一轮。 */
  setTimeout(() => {
    try {
      const s2 = String(sid || 'default');
      /* 先判通道在不在、再取信 —— 反过来的话，通道不在时信已经被取走，就丢了 */
      if (!_channels.startTurnWithIntro) return;
      if (_channels.isTurnRunning && _channels.isTurnRunning(s2)) return;
      const pending = peekInbox(s2).turns || [];
      if (!pending.length) return;
      const items = drainTurns(s2);
      if (!items.length) return;
      const joined = items.map((x) => String(x && x.text || '')).filter(Boolean).join('\n\n────────\n\n');
      _channels.startTurnWithIntro(s2,
        '（有个后台子Agent没能跑完 —— 下面这条是程序替你递的通知，不是主人说的话。）\n\n' + joined);
    } catch { /* 起轮失败不连累任何在跑的东西 */ }
  }, 2500).unref?.();
}

/* ── 运行期自动收尸（2026-11-16 主人钦点：死掉的子Agent自动清） ──────── */

/**
 * 主人原话：「我希望遇到这种情况能自动清」「自动清死掉的子Agent」。
 *
 * 之前的三个漏洞（这才是「跑了十几分钟还挂着」的真因）：
 *   ① 花名册里**根本没有心跳字段** —— progress 只在 onProgress 那几处写，
 *      一个卡在等模型回包的 worker 可以几十分钟不写一行，名册上看着跟活着一样；
 *   ② isWorkerAlive 只看本进程内存里有没有 AbortController，
 *      进程还在 = 永远「活着」，压根没有时间维度；
 *   ③ markInterruptedWorkers 是死代码，全仓没人调 —— 于是跨重启残留的 running
 *      永远留在名册上（实测 smwcwq8lbz3ly 的 #1/#2 从凌晨 01:53 一直挂到早上）。
 *
 * 现在：每个工具落地 + 每进一轮都 beatWorker() 刷 lastBeatAt；
 * 这个清扫器每 30s 扫一遍名册，超时没心跳的立刻：
 *   abort 真正在跑的那一轮 → 名册标 stalled → 给主智能体递一句话（别让她干等）。
 *
 * 【为什么用 6 分钟】正常的单步长工具（跑回归、全量自检）实测 2~5 分钟；
 * 6 分钟没任何一步 = 卡在服务端不回包。再给 90 秒宽限，避免刚派出去就误杀。
 */
let _reapTimer = null;
export function startWorkerReaper({ everyMs = 30000 } = {}) {
  if (_reapTimer) return _reapTimer;
  _reapTimer = setInterval(() => {
    try { reapDeadWorkersOnce(); } catch (e) { try { console.warn('[team] 收尸出错：', e && e.message); } catch {} }
  }, everyMs);
  _reapTimer.unref?.();
  return _reapTimer;
}

/** 扫一遍所有会话的名册，把死掉的收掉。返回这一趟收了几个。 */
export function reapDeadWorkersOnce({ now = Date.now() } = {}) {
  let dir = '';
  try { dir = workersPath(); } catch { return 0; }
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { return 0; }
  let n = 0;
  for (const f of files) {
    const sid = basename(f, '.json');
    if (!sid) continue;
    let dead = [];
    try { dead = findStalledWorkers(sid, { now, bootAt: BOOT_AT }); } catch { continue; }
    for (const d of dead) {
      /* ① 先把真正在跑的那一轮 abort 掉 —— 只改名册不掐轮子＝它还占着模型在烧钱 */
      try { stopWorker(sid, d.id); } catch {}
      /* ② 名册落成 stalled（不是 stopped：没人点停，是它自己不动了） */
      let rec = null;
      try { rec = reapStalledWorker(sid, d.id, { now, bootAt: BOOT_AT, why: d.deadByBoot ? '程序重启过，这个子Agent的进程已经没了' : '已经 ' + Math.round(Number(d.idleMs||0) / 60000) + ' 分钟没有任何动作，判定卡死' }); } catch {}
      if (!rec) continue;
      n += 1;
      /* ③ 告诉主智能体：别等汇报了，要看进度看花名册 */
      const why = d.deadByBoot
        ? '程序重启过，这个子Agent的进程已经没了'
        : '已经 ' + Math.round(d.idleMs / 60000) + ' 分钟没有任何动作，判定卡死';
      try { releaseWorkerCtrl(sid, d.id); } catch {}
      try { notifyWorkerInterrupted(sid, d.id, d.name, why); } catch {}
      try {
        if (_channels.pushWorkerEvent) _channels.pushWorkerEvent(sid, {
          type: 'worker', op: 'stalled', id: String(d.id), name: String(d.name || ''), why,
        });
      } catch {}
    }
  }
  return n;
}

/* ── 重启后的自动续跑（主人 2026-11-13 钦点：子 Agent 也要续上） ───── */

/**
 * 启动时扫花名册：还挂着 'running' 的 worker，进程已经没了 ——
 * 跟主会话的续跑（resume.mjs）同一个道理，把它们**重新派发**，接着上一段干。
 *
 * 规矩：
 *  · 只有「新鲜」的才续：startedAt 在 24h 内、自动续跑次数没超 2（防崩溃循环 ——
 *    如果这个任务本身会把程序搞挂，第三次就别再自动拉了，老实标 interrupted）；
 *  · 续跑的任务原文带三样：完整 brief（含汇报要求）、验收标准、上次的进度行 ——
 *    让她先看进度再动手，**接着做别从头来**；
 *  · 过期的/没任务原文的照旧标 'interrupted'（原 markInterruptedWorkers 的行为）；
 *  · 续跑用同一个 wid —— 花名册、进度、信箱、watch_worker 全都还认得它。
 *
 * 延迟 delayMs 再真正派发：开机头几秒主会话自己的续跑轮先跑，别跟它抢模型。
 */
export function resumeInterruptedWorkers({ delayMs = 12000 } = {}) {
  let dir = '';
  try { dir = workersPath(); } catch { return { ok: false }; }
  let files = [];
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return { ok: true, resumed: 0, interrupted: 0, ids: [] }; }
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // 跟 resume.mjs 的 MAX_AGE_MS 同一个口径
  const MAX_RESUMES = 2;                     // 自动续跑上限（防崩溃循环）
  let resumed = 0;
  let interrupted = 0;
  const ids = [];
  let idx = 0;
  for (const f of files) {
    const sid = basename(f, '.json');
    if (!sid) continue;
    let ws = [];
    try { ws = listWorkers(sid); } catch { continue; }
    for (const w of ws) {
      if (w.status !== 'running') continue;
      const age = Date.now() - (Number(w.startedAt) || 0);
      const fresh = Number.isFinite(age) && age >= 0 && age <= MAX_AGE_MS;
      const brief = String(w.brief || w.task || '').trim();
      if (!fresh || !brief || (Number(w.resumes) || 0) >= MAX_RESUMES) {
        try { finishWorker(sid, w.id, { status: 'interrupted' }); interrupted += 1; } catch {}
        /* 【严检】标中断的同时必须让主智能体知道 —— 她还在等汇报呢 */
        notifyWorkerInterrupted(sid, w.id, w.name,
          !fresh ? '程序重启过，而且这任务已经放了太久（超过 24h），不能再自动续'
            : (Number(w.resumes) || 0) >= MAX_RESUMES ? '自动续跑次数用完（防崩溃循环），老实停了'
            : '任务原文丢了，没法接着干');
        continue;
      }
      /* 先把名册改回 running（继承 mails/progress，resumes +1）——
       * 界面立刻显示「干活中」，真正派发在 delayMs 之后。 */
      try {
        noteWorker(sid, {
          id: w.id,
          name: w.name,
          task: w.task,
          brief: w.brief,
          accept: w.accept,
          status: 'running',
          startedAt: w.startedAt,   // 保留原开工时间 —— 界面上「跑了多久」从这算
          resumes: (Number(w.resumes) || 0) + 1,
        });
      } catch { continue; }
      const lastSteps = Array.isArray(w.progress) ? w.progress.slice(-10) : [];
      const resumeBrief = [
        '【续跑】程序中途重启过一次，你上一段干到一半被打断了。这不是新任务 ——',
        '先看下面的进度记录，**接着上一次的进度往下做**：别从头来、别重复已经做完的步骤。',
        '',
        '原任务与汇报要求：',
        brief,
        '',
        w.accept ? ('验收标准：' + w.accept) : '',
        '',
        lastSteps.length
          ? ('上次干到哪儿（按时间排的进度记录，最后一条是断点）：\n' + lastSteps.map((x) => '- ' + String(x.line || x).slice(0, 200)).join('\n'))
          : '上次没有留下进度记录（刚开始就被打断了），从头做这件活。',
      ].filter(Boolean).join('\n');
      const delay = delayMs + idx * 1500;   // 错峰派发，别一口气全挤到模型上
      idx += 1;
      resumed += 1;
      ids.push(sid + '#' + w.id);
      setTimeout(() => {
        try {
          dispatchWorker({ sessionId: sid, wid: String(w.id), name: w.name, brief: resumeBrief, maxRounds: 60 });
        } catch (e) {
          /* 续跑派发失败：老实标中断，别让界面停在「干活中」 */
          try { finishWorker(sid, w.id, { status: 'interrupted' }); } catch {}
          try { console.warn('[team] worker 续跑派发失败 #' + w.id + '：', e && e.message); } catch {}
          /* 【严检】派发失败 = 这个 worker 真死了，主智能体必须收到通知 */
          notifyWorkerInterrupted(sid, w.id, w.name, '续跑派发失败（' + String((e && e.message) || e) + '）');
        }
      }, delay).unref?.();
    }
  }
  return { ok: true, resumed, interrupted, ids };
}
