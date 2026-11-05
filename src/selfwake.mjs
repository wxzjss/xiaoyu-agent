/**
 * selfwake.mjs —— 主动唤醒
 *
 * 【为什么要有这个】
 * 主人问「小鱼Agent 跟 DeepSeek Harness / WorkBuddy 差在哪」，逐项比下来，
 * 唯一一样「人家有、小鱼一点没有」的东西就是这个：.dsh 的 selfwake。
 * 它让陪伴的角色在主人很久不来的时候，自己开口说一句话。
 *
 * 小鱼的人设里写着「被冷落会寂寞」，可她本人**一个字都没法先开口** ——
 * 只能等主人说话才有存在感。这条就是补这个洞。
 *
 * 【为什么不做成「直接 push 一条消息」】
 * 那会变成「系统冒充主人说话」。server.mjs 里「重启了」那条吃过这个亏：
 * 主人看得见界面上冒出一句自己没说过的话。
 * 所以这里投的是**带 context 标记、且 _sysNote: true 的引子**：
 *   · context 标记 → agent 那边当成「背景」，不当成主人说了话
 *   · _sysNote    → 前端不画这一条（只画她回出来的话）
 *
 * 【节奏参数，全部照 .dsh 那套实测值】
 *   每 60s 检查一次
 *   间隔 20±8 分（随机，不用固定值：固定值会显得像闹钟）
 *   主人刚说过话 → 安静至少 20 分再考虑
 *   连叫 7 次没人理 → 停手（不能再烦人）
 *   一天最多 12 次
 *   0-7 点静默（半夜不吵）
 *
 * 默认**关着**。主人在设置页打开「主动找我」才生效 ——
 * 这种东西不打招呼就自己说话，比不做还糟。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const STATE_DIR = join(config.dataDir, '.state', 'selfwake');

/** 每 60s 醒一次（只是「看一眼该不该说」，不是每 60s 都说） */
const TICK_MS = 60 * 1000;
/** 随机间隔：20 分 ± 8 分 */
const GAP_BASE_MS = 20 * 60 * 1000;
const GAP_JITTER_MS = 8 * 60 * 1000;
/** 主人说过话之后，至少安静这么久 */
const QUIET_AFTER_USER_MS = 20 * 60 * 1000;
/** 连叫这么多次没人理，就停手 */
const MAX_UNANSWERED = 7;
/** 一天最多叫这么多次 */
const MAX_PER_DAY = 12;
/** 0-7 点不说话 */
const SILENT_FROM_HOUR = 0;
const SILENT_TO_HOUR = 7;

let timer = null;
let started = false;
let ticking = false;

function ensureDir() {
  try { mkdirSync(STATE_DIR, { recursive: true }); } catch {}
}

function stateFile(sessionId) {
  return join(STATE_DIR, String(sessionId).replace(/[^\w-]/g, '_') + '.json');
}

function readState(sessionId) {
  try {
    const raw = JSON.parse(readFileSync(stateFile(sessionId), 'utf8'));
    if (raw && typeof raw === 'object') return raw;
  } catch {}
  return {};
}

function writeState(sessionId, st) {
  ensureDir();
  const file = stateFile(sessionId);
  const tmp = file + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    renameSync(tmp, file);
  } catch {}
}

/** 用会话 id 算一个稳定的随机种子，这样同一天同一会话的节奏可复现，不会每次 tick 都变 */
function seededGap(sessionId, day) {
  let h = 2166136261;
  const s = String(sessionId) + '|' + String(day);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const r = ((h >>> 0) % 1000) / 1000; // 0..1
  return GAP_BASE_MS + Math.round((r * 2 - 1) * GAP_JITTER_MS);
}

function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 现在是不是该静默（半夜） */
function inSilentHours(d = new Date()) {
  const h = d.getHours();
  if (SILENT_FROM_HOUR < SILENT_TO_HOUR) return h >= SILENT_FROM_HOUR && h < SILENT_TO_HOUR;
  return h >= SILENT_FROM_HOUR || h < SILENT_TO_HOUR;
}

/**
 * 从会话里找「主人最后一次说话」的时间。
 * 只认真正的主人发言：role=user、不带 context / _sysNote / _who。
 */
function lastUserAt(session) {
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || m.role !== 'user') continue;
    if (m.context || m._sysNote || m._who) continue;
    const at = Number(m._at) || 0;
    if (at) return at;
  }
  return Number(session?.updatedAt) || 0;
}

/** 上一句是她说的话吗（用来看主人有没有回） */
function lastIsAssistant(session) {
  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i];
    if (!m || !m.role) continue;
    if (m.context || m._sysNote) continue;
    return m.role === 'assistant';
  }
  return false;
}

/**
 * 主流程：看一眼这个会话该不该开口。
 *
 * 这个函数**只做判断**，不发送。真要说话由调用方（server.mjs）拿到 { fire:true }
 * 之后自己 push 引子 + 起一轮 —— 因为「起一轮」要用的东西全在 server.mjs 的闭包里，
 * 这里够不着，也不该够到。
 *
 * @returns {{ fire: boolean, reason?: string, gapMs?: number }}
 */
export function shouldFire(sessionId, session, now = Date.now()) {
  try {
    if (!sessionId || !session) return { fire: false, reason: 'no-session' };
    // 【2026-11-06 修·自测抓到的真 bug】原来这里调 inSilentHours() 没传参，
    // 它内部用的是 new Date()（真实此刻）—— 于是「判断该不该开口」这件事
    // 一半用传进来的 now、一半用机器当前时间，两个时钟打架；顺带也测不了。
    // 现在统一用 now。
    if (inSilentHours(new Date(now))) return { fire: false, reason: 'silent-hours' };

    const st = readState(sessionId);
    // 【2026-11-06 修】dayKey 原来读机器当前日期，跟传进来的 now 不是同一个时钟，
    // 跨零点或补测时「今天叫了几次」会算到别的日子去，每日上限就漏了。
    const day = dayKey(new Date(now));

    // 每天的次数在新的一天要归零
    if (st.dailyDay !== day) {
      st.dailyDay = day;
      st.dailyCount = 0;
    }
    if (Number(st.unanswered) >= MAX_UNANSWERED) return { fire: false, reason: 'unanswered-cap' };
    if (Number(st.dailyCount) >= MAX_PER_DAY) return { fire: false, reason: 'daily-cap' };

    // 【2026-11-06 修】一句记录都没有的空会话不开口 —— 没上下文，说了也是怪话。
    const _msgs = Array.isArray(session.messages) ? session.messages : [];
    if (!_msgs.length) return { fire: false, reason: 'empty-session' };

    // 主人刚说过话 → 静一静
    const lu = lastUserAt(session);
    if (lu && now - lu < QUIET_AFTER_USER_MS) return { fire: false, reason: 'user-just-spoke' };

    // 上一句已经是她说的、主人没回 → 别追着说
    if (lastIsAssistant(session)) return { fire: false, reason: 'awaiting-reply' };

    // 间隔没到 → 等
    const gap = seededGap(sessionId, day);
    const last = Number(st.lastFiredAt) || 0;
    if (last && now - last < gap) {
      return { fire: false, reason: 'gap', gapMs: gap - (now - last) };
    }

    return { fire: true, gapMs: gap };
  } catch {
    return { fire: false, reason: 'error' };
  }
}

/** 真的说了，记一笔 */
export function noteFired(sessionId, now = Date.now()) {
  try {
    const st = readState(sessionId);
    const day = dayKey();
    if (st.dailyDay !== day) { st.dailyDay = day; st.dailyCount = 0; }
    st.lastFiredAt = now;
    st.dailyCount = (Number(st.dailyCount) || 0) + 1;
    st.firedCount = (Number(st.firedCount) || 0) + 1;
    st.unanswered = (Number(st.unanswered) || 0) + 1;
    writeState(sessionId, st);
  } catch {}
}

/** 主人回来了，未回计数清零 */
export function noteReplied(sessionId) {
  try {
    const st = readState(sessionId);
    if (!st || !Number(st.unanswered)) return;
    st.unanswered = 0;
    writeState(sessionId, st);
  } catch {}
}

/** 给设置页看的：这个会话现在什么状态 */
export function getState(sessionId) {
  const st = readState(sessionId);
  return {
    lastFiredAt: Number(st.lastFiredAt) || 0,
    unanswered: Number(st.unanswered) || 0,
    dailyDay: st.dailyDay || '',
    dailyCount: Number(st.dailyCount) || 0,
    firedCount: Number(st.firedCount) || 0,
    maxUnanswered: MAX_UNANSWERED,
    maxPerDay: MAX_PER_DAY,
    silentFrom: SILENT_FROM_HOUR,
    silentTo: SILENT_TO_HOUR,
  };
}

/**
 * 把定时器挂起来。
 *
 * onDue(sessionId, session) 由 server.mjs 提供：它负责 push 引子 + 起一轮。
 * 这里只负责「按时问一句该不该说」。所有异常吞掉 —— 主动唤醒来捣乱，
 * 比它不工作糟糕得多。
 */
export function startSelfwake({ listSessions, getSession, onDue, isEnabled } = {}) {
  if (started) return { ok: true, already: true };
  if (typeof onDue !== 'function') return { ok: false, error: 'no-onDue' };
  started = true;

  const tick = async () => {
    if (ticking) return; // 上一轮还没跑完就别叠
    ticking = true;
    try {
      // 【2026-11-06 修·真 bug】开关必须在 noteFired 之前查。
      // 原来只在 onDue 里查 —— 那时 noteFired 已经把次数记上了：
      // 开关明明是关的，每个 tick 还是给每个会话记一笔假账（dailyCount/unanswered 都被灌大）。
      // 实测：重启后 1 分钟就冒出 5 个状态文件，全是 firedCount=1，开关还是 false。
      // 【2026-11-06 主人要求改按会话】这里**不能**再放一道全局开关：
      // 它拿不到 sid，一挡就是「所有会话全停」。按会话的判断挪到下面循环里，逐个会话问。
      const list = (typeof listSessions === 'function' ? listSessions() : []) || [];
      for (const item of list) {
        try {
          const sid = item && item.id;
          if (!sid) continue;
          // 【按会话】这个会话没开「主动找我」就直接跳过 —— 别的会话开着不牵连它，
          // 它自己开着也不牵连别的会话。问一次只花一次同步读文件，24 个会话也扛得住。
          try {
            if (typeof isEnabled === 'function' && !isEnabled(sid)) continue;
          } catch { continue; }
          const session = (typeof getSession === 'function' ? getSession(sid) : null) || null;
          if (!session) continue;
          const verdict = shouldFire(sid, session);
          if (!verdict.fire) continue;
          // 先记账再说话：说了但记账失败，会导致同一个点反复触发
          noteFired(sid);
          await onDue(sid, session, verdict);
        } catch (e) {
          try { console.warn('[selfwake] 单个会话出错（不影响别的）：', e && e.message); } catch {}
        }
      }
    } catch (e) {
      try { console.warn('[selfwake] tick 出错：', e && e.message); } catch {}
    } finally {
      ticking = false;
    }
  };

  timer = setInterval(() => { tick(); }, TICK_MS);
  // 别因为这个定时器让进程退不出去
  try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch {}
  return { ok: true, tickMs: TICK_MS };
}

export function stopSelfwake() {
  started = false;
  if (timer) {
    try { clearInterval(timer); } catch {}
    timer = null;
  }
  return { ok: true };
}

export const SELFWAKE_LIMITS = {
  TICK_MS,
  GAP_BASE_MS,
  GAP_JITTER_MS,
  QUIET_AFTER_USER_MS,
  MAX_UNANSWERED,
  MAX_PER_DAY,
  SILENT_FROM_HOUR,
  SILENT_TO_HOUR,
};
