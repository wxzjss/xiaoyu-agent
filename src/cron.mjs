/**
 * cron.mjs —— 定时任务
 *
 * 【主人原话】「加一个定时任务的功能吧，就是可以给他设定一个定时任务，
 *   比如说给他说一个任务，然后再说一个这个这个任务什么时候开始，
 *   然后他就会在那个时候自动去做」
 *
 * 【做成什么样】
 * 一条任务 = { 做什么, 什么时候开始, 重复还是一次, 在哪个会话里做 }。
 * 到点了，就往那个会话里投一条带 context 标记的引子，再起一轮 ——
 * 走的是跟「重启了」「主动找我」完全同一条路（startQueuedTurn），
 * 不另造引擎，也不会冒充主人说话。
 *
 * 【为什么不直接 runAgent】
 * runAgent 只跑一轮模型；startQueuedTurn 会处理排队、锁、前端实时补画、
 * 收尾落盘。定时任务跑出来的东西，主人得能在界面上看见 —— 所以走后者。
 *
 * 【出错怎么办】
 * 一律吞掉记日志。定时任务坏了不许连累主流程 —— 这是底线。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const TICK_MS = 30000;              // 30 秒看一次，够准了，也不费
const STALE_MS = 10 * 60 * 1000;    // 超过 10 分钟没跑成，就不要补跑了（补跑往往是灾难）

function dir() {
  const d = join(config.dataDir, '.state');
  try { mkdirSync(d, { recursive: true }); } catch {}
  return d;
}
function file() { return join(dir(), 'cron.json'); }

/* ---------------------------------------------------------------- 存取 */

function readAll() {
  try {
    const raw = readFileSync(file(), 'utf8');
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.tasks)) return [];
    return j.tasks.filter((t) => t && typeof t === 'object' && t.id);
  } catch {
    return [];
  }
}

function writeAll(tasks) {
  const p = file();
  const tmp = p + '.tmp';
  const body = JSON.stringify({ version: 1, tasks }, null, 2);
  writeFileSync(tmp, body, 'utf8');
  try { renameSync(tmp, p); } catch { try { writeFileSync(p, body, 'utf8'); } catch {} }
}

let seq = 0;
function newId() {
  seq = (seq + 1) % 10000;
  return 'c' + Date.now().toString(36) + seq.toString(36);
}

/* ---------------------------------------------------------------- 时间 */

/**
 * 把「什么时候开始」解析成一个毫秒时间戳。
 *
 * 认这几种写法（主人在界面上填）：
 *   · 绝对时间  "2026-11-06 09:30" / "2026-11-06 09:30:00"
 *   · 相对分钟  "+30m"  "+2h"  "+1d"
 *   · 只给时间  "09:30" —— 今天这个点，过了就明天
 *
 * 认不出来返回 0（调用方当失败处理，不许悄悄当成"现在"）。
 */
export function parseWhen(input, now = Date.now()) {
  const s = String(input == null ? '' : input).trim();
  if (!s) return 0;

  // 相对
  const rel = /^\+(\d+)\s*([mhd])$/i.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit === 'm' ? 60000 : unit === 'h' ? 3600000 : 86400000;
    return now + n * ms;
  }

  // 绝对（含日期）
  const abs = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (abs) {
    const [, y, mo, d, h, mi, se] = abs;
    const t = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se || 0), 0).getTime();
    return Number.isFinite(t) ? t : 0;
  }

  // 只有时间（今天/明天）
  const tod = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (tod) {
    const [, h, mi, se] = tod;
    const base = new Date(now);
    const t = new Date(base.getFullYear(), base.getMonth(), base.getDate(),
      Number(h), Number(mi), Number(se || 0), 0).getTime();
    if (!Number.isFinite(t)) return 0;
    // 今天这个点已经过了 → 摆到明天
    return t <= now ? t + 86400000 : t;
  }

  return 0;
}

/** 下一次该跑的时刻：一次性返回 0（跑完就完），重复的往后推 */
function nextAfter(task, from) {
  if (!task.repeat || task.repeat === 'once') return 0;
  const every = Number(task.everyMs) || 0;
  if (every > 0) {
    // 一直往前推到比 from 大的那个点
    let t = Number(task.at) || 0;
    if (!t) return 0;
    while (t <= from) t += every;
    return t;
  }
  return 0;
}

/* ---------------------------------------------------------------- 增删改查 */

export function listTasks() {
  return readAll().map((t) => ({ ...t }));
}

export function addTask(input = {}) {
  const text = String(input.text || '').trim();
  if (!text) {
    const e = new Error('没说要做什么');
    e.status = 400;
    throw e;
  }
  const at = parseWhen(input.when);
  if (!at) {
    const e = new Error('「什么时候开始」没看懂。写成 2026-11-06 09:30、09:30 或 +30m 都行');
    e.status = 400;
    throw e;
  }

  const repeat = String(input.repeat || 'once');
  let everyMs = 0;
  if (repeat !== 'once') {
    const n = Number(input.everyN) || 0;
    if (n > 0) {
      const unit = String(input.everyUnit || 'd').toLowerCase();
      everyMs = unit === 'm' ? n * 60000 : unit === 'h' ? n * 3600000 : n * 86400000;
    } else {
      /* 【2026-11-06 修】界面上那颗勾叫「每天」，前端只传 repeat:'every'、不带间隔。
       * 原来这里 everyN 缺省 0 → everyMs 也是 0 → 退化成一次性，勾了「每天」其实只跑一次。
       * 所以：说「重复」但没说多久，就按一天一次算，跟那颗勾的字面意思对上。 */
      everyMs = 86400000;
    }
  }

  const task = {
    id: newId(),
    title: String(input.title || text).slice(0, 60),
    text,
    at,
    when: String(input.when || ''),
    repeat: repeat === 'once' ? 'once' : (everyMs > 0 ? 'every' : 'once'),
    everyMs,
    sessionId: String(input.sessionId || ''),
    enabled: true,
    createdAt: Date.now(),
    lastRunAt: 0,
    lastRunOk: null,
    lastNote: '',
    runCount: 0,
  };

  const all = readAll();
  all.push(task);
  writeAll(all);
  return task;
}

export function removeTask(id) {
  const all = readAll();
  const next = all.filter((t) => String(t.id) !== String(id));
  if (next.length === all.length) return { removed: 0 };
  writeAll(next);
  return { removed: 1 };
}

export function setEnabled(id, on) {
  const all = readAll();
  let hit = 0;
  for (const t of all) {
    if (String(t.id) === String(id)) { t.enabled = Boolean(on); hit++; }
  }
  if (hit) writeAll(all);
  return { updated: hit };
}

/** 到点了没？返回该跑的那些任务（不改文件，只算） */
export function dueTasks(now = Date.now()) {
  const out = [];
  for (const t of readAll()) {
    if (!t || t.enabled === false) continue;
    const at = Number(t.at) || 0;
    if (!at) continue;
    if (at > now) continue;                    // 还没到
    if (now - at > STALE_MS) {                 // 过太久了，不补跑
      // 重复任务往后挪一格，别卡死在这里
      if (t.repeat === 'every') out.push({ ...t, _reschedule: true });
      continue;
    }
    out.push({ ...t });
  }
  return out;
}

/** 记一次跑过（跑成没跑成都记，免得同一个点反复触发） */
/**
 * 【2026-11-05 加】补记一笔「这一趟没跑起来」。
 *
 * 为什么不能用 markRan：它会给 repeat 任务重算 `t.at`（下次触发时间）、
 * 还会 `runCount + 1`。拿它补记失败，等于把任务往后多推一轮、还多算一次。
 *
 * 这个只改两个字段：lastRunOk / lastNote。调度、计数一律不动。
 */
export function noteRunFailed(id, note = '') {
  const all = readAll();
  let hit = false;
  for (const t of all) {
    if (String(t.id) !== String(id)) continue;
    hit = true;
    t.lastRunOk = false;
    t.lastNote = String(note || '').slice(0, 200);
  }
  if (hit) writeAll(all);
  return { updated: hit ? 1 : 0 };
}

export function markRan(id, ok, note = '', now = Date.now()) {
  const all = readAll();
  let hit = false;
  for (const t of all) {
    if (String(t.id) !== String(id)) continue;
    hit = true;
    t.lastRunAt = now;
    t.lastRunOk = Boolean(ok);
    t.lastNote = String(note || '').slice(0, 200);
    t.runCount = (Number(t.runCount) || 0) + 1;
    if (t.repeat === 'every') {
      const nx = nextAfter({ ...t, at: t.at }, Math.max(now, Number(t.at) || 0));
      if (nx) t.at = nx;
      else { t.enabled = false; t.lastNote = (t.lastNote + ' · 没有下一次了').slice(0, 200); }
    } else {
      // 一次性：跑完就关掉，但留着记录让主人看得到
      t.enabled = false;
    }
  }
  if (hit) writeAll(all);
  return { updated: hit ? 1 : 0 };
}

/* ---------------------------------------------------------------- 定时器 */

let started = false;
let timer = null;
let ticking = false;

/**
 * 起定时器。onDue(task) 由 server 提供 —— 那边才知道怎么起一轮。
 * 判断「到点没」全在这里，那边只管照做。
 */
export function startCron({ onDue } = {}) {
  if (started) return { ok: true, already: true };
  if (typeof onDue !== 'function') return { ok: false, error: 'no-onDue' };
  started = true;

  const tick = async () => {
    if (ticking) return;                 // 上一轮还没跑完，别叠
    ticking = true;
    try {
      const now = Date.now();
      const due = dueTasks(now);
      for (const task of due) {
        if (task._reschedule) {
          // 过太久没跑：直接往后挪，不补跑
          try { markRan(task.id, false, '错过了（那时候程序没开着），这次不补跑', now); } catch {}
          continue;
        }
        // 先记账再跑：跑崩了也不会在下一个 tick 又触发一次
        try { markRan(task.id, true, '', now); } catch {}
        try {
          await onDue(task);
        } catch (e) {
          /* 【2026-11-05 修·跑崩了却记成成功】
           * 上面那句 markRan(task.id, true) 是为了"跑崩也不再触发一次"，
           * 可它把 lastRunOk 记成了 true —— 任务列表里一片绿，看不出哪次没干成。
           * 这里补一笔失败（只改 lastRunOk/lastNote，不碰调度和计数）。 */
          try { noteRunFailed(task.id, '这一趟没跑起来：' + String(e && e.message ? e.message : e)); } catch {}
          try { console.warn('[cron] 单个任务起不来（不影响别的）：', task.id, e && e.message); } catch {}
        }
      }
    } catch (e) {
      try { console.warn('[cron] tick 出错：', e && e.message); } catch {}
    } finally {
      ticking = false;
    }
  };

  timer = setInterval(() => { tick(); }, TICK_MS);
  try { if (timer && typeof timer.unref === 'function') timer.unref(); } catch {}
  return { ok: true, tickMs: TICK_MS };
}

export function stopCron() {
  started = false;
  if (timer) { try { clearInterval(timer); } catch {} timer = null; }
  return { ok: true };
}

export const CRON_LIMITS = { TICK_MS, STALE_MS };
