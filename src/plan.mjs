// Autopilot: the multi-step task board (plan + notes) that survives across turns.
// Ported from the autopilot skill: plan / note / progress injection.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state', 'plan');
// txt 清单目录：每个会话一份（以前是全体共用一份，谁最后动谁说了算）
const TXT_DIR = join(config.dataDir, '.state', 'plan');
const MAX_STEPS = 30;
const MAX_NOTES = 40;
const MAX_PROMPT_CHARS = 900;

export const STATUSES = ['pending', 'doing', 'done', 'skipped'];
const MARK = { pending: '·', doing: '▸', done: '✔', skipped: '—' };

const STATUS_ALIAS = {
  pending: 'pending', todo: 'pending', open: 'pending', new: 'pending',
  doing: 'doing', in_progress: 'doing', active: 'doing', wip: 'doing', start: 'doing',
  done: 'done', complete: 'done', completed: 'done', finish: 'done', finished: 'done', ok: 'done',
  skip: 'skipped', skipped: 'skipped', cancel: 'skipped', cancelled: 'skipped', drop: 'skipped',
};

function normStatus(v) {
  const raw = String(v ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  return STATUS_ALIAS[raw] ?? null;
}

function clean(v, max) {
  return String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** 某个会话的 txt 清单路径 */
function txtFileFor(key) {
  const safe = String(key || 'default').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'default';
  return join(TXT_DIR, `${safe}.txt`);
}

function fileFor(key) {
  const safe = String(key || 'default').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'default';
  return join(DIR, `${safe}.json`);
}

function emptyState() {
  return { goal: '', createdAt: 0, updatedAt: 0, steps: [], notes: [] };
}

export function loadPlan(key = 'default') {
  try {
    const data = JSON.parse(readFileSync(fileFor(key), 'utf8'));
    if (!data || typeof data !== 'object') return emptyState();
    return {
      goal: clean(data.goal, 300),
      createdAt: Number(data.createdAt) || 0,
      updatedAt: Number(data.updatedAt) || 0,
      steps: (Array.isArray(data.steps) ? data.steps : [])
        .filter((s) => s && typeof s.text === 'string')
        .slice(0, MAX_STEPS)
        .map((s, i) => ({
          id: i + 1,
          text: clean(s.text, 300),
          status: STATUSES.includes(s.status) ? s.status : 'pending',
          note: clean(s.note, 300),
          pinned: !!s.pinned,
        })),
      notes: (Array.isArray(data.notes) ? data.notes : [])
        .filter((n) => n && typeof n.text === 'string')
        .slice(-MAX_NOTES)
        .map((n, i) => ({ id: i + 1, text: String(n.text).slice(0, 1200), tag: clean(n.tag, 40) })),
    };
  } catch {
    return emptyState();
  }
}

/**
 * 把任何东西整理成一份「能安全读」的清单状态（2026-10-30 修 · 干活鱼2 的 ⚠）。
 *
 * 病因：`formatPlan()` 直接吃 `state.steps.length`，可它并不总是拿到 loadPlan() 的结果。
 * agent.mjs 那一行是 `const planTxt = readPlanTxt(ctxNow())` —— readPlanTxt 返回的是
 * `{ text, path }`，**根本没有 steps**。于是每一轮走到压缩前置段就当场
 * `TypeError: Cannot read properties of undefined (reading 'length')`，
 * 界面只显示一行 ⚠，主人发多少条「继续」都不会有回复（16:05 之后一次都没答上话）。
 *
 * 两道保险，哪个先拦都行：
 *   · 传进来的要是 `{text}` 那种（缺 steps）→ 就把它当空清单，绝不炸；
 *   · 传进来的 steps / notes 不是数组 → 一律按空数组。
 * 真正有多少步还是以 loadPlan() 为准，这里只保证「读不到」不会变成「跑不动」。
 */
function safeState(state) {
  const base = state && typeof state === 'object' ? state : {};
  return {
    goal: typeof base.goal === 'string' ? base.goal : '',
    steps: Array.isArray(base.steps) ? base.steps.filter((s) => s && typeof s.text === 'string') : [],
    notes: Array.isArray(base.notes) ? base.notes : [],
  };
}

/** 清单归档目录：每次覆盖/清空前，旧清单原文先扔这儿，谁也别想再「找不回来」 */
const HISTORY_DIR = join(config.dataDir, '.state', 'plan', '_history');

/**
 * 覆盖前先留一份档。reason 只写原因，不参与命名逻辑。
 * 静默失败——留档坏掉不能反过来把正常保存也搞死。
 */
function archivePlan(key, state, reason = 'overwrite') {
  try {
    if (!state || !Array.isArray(state.steps) || state.steps.length === 0) return;
    if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const safeKey = String(key || 'default').replace(/[^\w.-]/g, '_');
    const f = join(HISTORY_DIR, `${safeKey}-${stamp}-${reason}.json`);
    writeFileSync(f, JSON.stringify(state, null, 2), 'utf8');
    // 顺手留一份人眼能读的 txt
    const { done, total } = progress(state);
    const lines = [
      `任务清单（归档 · ${reason}）`,
      `归档时间：${now.toLocaleString('zh-CN')}`,
      `目标：${state.goal || '（没写）'}`,
      `进度：${done}/${total}`,
      '------------------------------',
      ...state.steps.map((st) => {
        const mark = st.status === 'done' ? '✔' : st.status === 'doing' ? '▸' : st.status === 'skipped' ? '—' : '·';
        return `${st.id}. ${mark} ${st.text}${st.note ? '（' + st.note + '）' : ''}`;
      }),
    ];
    if (state.notes && state.notes.length) {
      lines.push('', '便签：', ...state.notes.map((n) => `- ${n.tag ? '[' + n.tag + '] ' : ''}${n.text}`));
    }
    writeFileSync(f.replace(/\.json$/, '.txt'), lines.join('\n'), 'utf8');
  } catch { /* 留档失败不影响主流程 */ }
}

/**
 * 防丢闸：主人钉死的老任务不许被「新建清单」悄悄顶掉。
 * pinned=true 的步在 create 时自动接驳到新清单后面。
 */
function pinnedSteps(state) {
  return (state.steps || []).filter((st) => st && st.pinned);
}

function savePlan(key, state) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  try { const prev = loadPlan(key); if (prev && prev.steps && prev.steps.length) archivePlan(key, prev, 'save'); } catch { /* 忽略 */ }
  state.updatedAt = Date.now();
  if (!state.createdAt) state.createdAt = state.updatedAt;
  writeFileSync(fileFor(key), JSON.stringify(state, null, 2), 'utf8');
  syncTxt(key, state);
}

/** 把某个会话的清单同步写成那份共用 txt（谁最后动谁说了算） */
function syncTxt(key, state) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const { done, total } = progress(state);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
    let body = '';
    body += `任务清单\n`;
    body += `更新：${stamp}\n`;
    body += `目标：${state.goal || '（没写）'}\n`;
    body += `进度：${done}/${total}\n`;
    body += '------------------------------\n';
    if (!state.steps.length) {
      body += '（现在没有清单）\n';
    } else {
      for (const s of state.steps) {
        body += `${s.id}. ${MARK[s.status] || '·'} ${s.text}${s.note ? `（${s.note}）` : ''}\n`;
      }
    }
    if (state.notes && state.notes.length) {
      body += '\n笔记\n';
      for (const n of state.notes.slice(-20)) body += `- ${n.tag ? `[${n.tag}] ` : ''}${n.text}\n`;
    }
    writeFileSync(txtFileFor(key), body, 'utf8');
  } catch {
    // 写 txt 失败不影响主流程
  }
}

/** 界面读的就是这份 txt 原文 */
export function readPlanTxt(key = 'default') {
  const file = txtFileFor(key);
  try {
    if (!existsSync(file)) return { text: '（还没有任务清单，等我要做事的时候会写进来）', path: file };
    return { text: readFileSync(file, 'utf8'), path: file };
  } catch (e) {
    return { text: `（读清单出错了：${e && e.message}）`, path: file };
  }
}

/**
 * 给「压缩提示」用的清单文本（2026-10-30 修）。
 *
 * 上面那个 readPlanTxt 是**界面**用的，回的是 {text, path} —— 谁要是拿它去喂
 * formatPlan 就会撞上 `undefined.length`（干活鱼2 就是这么死的）。
 * 这个函数回的是给人看的纯文本：有清单就格式化，没有就直说没有。
 * @param {string} key 会话 id
 * @returns {string} 永远是一段字符串，不会抛
 */
export function planTextFor(key = 'default') {
  try {
    const state = loadPlan(key);
    const txt = formatPlan(state);
    return txt;
  } catch {
    return '（现在没有清单）';
  }
}

function progress(state) {
  const { steps } = safeState(state);
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'done').length;
  return { total, done, left: steps.filter((s) => s.status !== 'done' && s.status !== 'skipped') };
}

export function formatPlan(state) {
  const safe = safeState(state);
  if (!safe.steps.length) return '（现在没有清单）';
  const { done, total } = progress(safe);
  const lines = safe.steps.map((s) => `${s.id}. ${MARK[s.status] || '·'} ${s.text}${s.note ? `（${s.note}）` : ''}`);
  return `目标：${safe.goal || '（没写）'}\n进度：${done}/${total}\n${lines.join('\n')}`;
}

// ---- tool actions ---------------------------------------------------------

export function planAction(key, args = {}) {
  const state = loadPlan(key);
  const action = clean(args.action, 20).toLowerCase() || 'view';

  if (action === 'view' || action === 'show' || action === 'list') {
    return { text: formatPlan(state), state };
  }

  if (action === 'create' || action === 'set' || action === 'new') {
    const steps = (Array.isArray(args.steps) ? args.steps : [])
      .map((s) => clean(typeof s === 'string' ? s : s?.text, 300))
      .filter(Boolean)
      .slice(0, MAX_STEPS);
    if (!steps.length) return { text: 'ERROR：create 需要 steps（字符串数组，一句一步）', state };
    // 旧清单先留档，再建新的——主人说过「清单不能丢」，不许再无声顶掉
    if (state.steps.length) archivePlan(key, state, 'create');
    const fresh = steps.map((text, i) => ({ id: i + 1, text, status: 'pending', note: '' }));
    // 防丢闸：钉死的老任务自动接驳到新清单后面，不会因为「新建清单」消失
    const keep = (state.steps || []).filter((st) => st && st.pinned && !fresh.some((f) => f.text === st.text));
    const merged = [...fresh, ...keep];
    const next = {
      goal: clean(args.goal, 300) || state.goal,
      createdAt: Date.now(),
      updatedAt: 0,
      steps: merged.map((st, i) => ({ id: i + 1, text: st.text, status: st.status === 'done' ? 'done' : (st.status || 'pending'), note: st.note || '', pinned: !!st.pinned })),
      notes: state.notes,
    };
    savePlan(key, next);
    const tip = keep.length ? `\n（钉死的 ${keep.length} 条老任务已自动接在后面，没丢）` : '';
    return { text: `清单建好了：\n${formatPlan(next)}${tip}`, state: next };
  }

  if (action === 'update' || action === 'step' || action === 'mark') {
    const id = Number(args.stepId ?? args.id ?? args.step);
    const status = normStatus(args.status);
    const step = state.steps.find((s) => s.id === id);
    if (!step) return { text: `ERROR：没有第 ${args.stepId ?? '?'} 步（现有 1~${state.steps.length}）`, state };
    if (!status) return { text: `ERROR：status 只能是 pending / doing / done / skipped`, state };
    step.status = status;
    if (args.note !== undefined) step.note = clean(args.note, 300);
    if (args.pin != null) step.pinned = !!args.pin;
    savePlan(key, state);
    return { text: `第 ${id} 步 → ${status}\n${formatPlan(state)}`, state };
  }

  if (action === 'add' || action === 'append') {
    const text = clean(args.text ?? args.step, 300);
    if (!text) return { text: 'ERROR：add 需要 text', state };
    if (state.steps.length >= MAX_STEPS) return { text: `ERROR：清单最多 ${MAX_STEPS} 步`, state };
    state.steps.push({ id: state.steps.length + 1, text, status: 'pending', note: '', pinned: !!args.pin });
    savePlan(key, state);
    return { text: `加了一步：\n${formatPlan(state)}`, state };
  }

  if (action === 'clear' || action === 'reset') {
    if (state.steps.length) archivePlan(key, state, 'clear');
    // 钉死的步不许被 clear 带走
    const keep = pinnedSteps(state);
    const next = emptyState();
    if (keep.length) {
      next.goal = state.goal;
      next.steps = keep.map((st, i) => ({ ...st, id: i + 1 }));
    }
    savePlan(key, next);
    return { text: keep.length ? `清单清空了，但钉死的 ${keep.length} 条老任务留下了` : '清单清空了（旧的那份已归档，翻得到）', state: next };
  }

  return { text: `ERROR：未知 action「${action}」，可用 create / update / add / view / clear`, state };
}

export function noteAction(key, args = {}) {
  const state = loadPlan(key);
  const action = clean(args.action, 20).toLowerCase() || 'add';
  if (action === 'view' || action === 'list' || action === 'show') {
    if (!state.notes.length) return { text: '（还没有笔记）', state };
    return { text: state.notes.map((n) => `- ${n.tag ? `[${n.tag}] ` : ''}${n.text}`).join('\n'), state };
  }
  if (action === 'clear') {
    state.notes = [];
    savePlan(key, state);
    return { text: '笔记清空了', state };
  }
  const text = String(args.text ?? '').trim().slice(0, 1200);
  if (!text) return { text: 'ERROR：note 需要 text', state };
  state.notes.push({ id: state.notes.length + 1, text, tag: clean(args.tag, 40) });
  state.notes = state.notes.slice(-MAX_NOTES);
  savePlan(key, state);
  return { text: `记下了（共 ${state.notes.length} 条）`, state };
}

/** Short progress line injected into the system prompt while a plan is unfinished. */
export function progressBlock(key = 'default') {
  const state = loadPlan(key);
  if (!state.steps.length) return '';
  const { done, total, left } = progress(state);
  if (!left.length) return ''; // don't burn tokens on finished plans
  const doing = state.steps.filter((s) => s.status === 'doing').map((s) => `第${s.id}步：${s.text}`);
  const pending = state.steps.filter((s) => s.status === 'pending').map((s) => `第${s.id}步：${s.text}`);
  let body = `【正在办】${state.goal || '（没写目标）'}（${done}/${total} 已完成）`;
  if (doing.length) body += `\n在做：${doing.join('；')}`;
  if (pending.length) body += `\n待办：${pending.join('；')}`;
  body += '\n（接着办就不用重新拆步骤；办完了用 plan 把对应步骤勾成 done，再照清单收尾。）';
  if (body.length > MAX_PROMPT_CHARS) body = `${body.slice(0, MAX_PROMPT_CHARS)}…`;
  return body;
}

// ---- 给界面用的（任务清单面板）---------------------------------------------
// 界面要的是「一眼能看明白」的东西：目标、进度、每步状态，别带上工具名那些术语。
export function planPublicView(key = 'default') {
  const state = loadPlan(key);
  const { done, total } = progress(state);
  return {
    goal: state.goal,
    total,
    done,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    steps: state.steps.map((s) => ({ id: s.id, text: s.text, status: s.status, note: s.note })),
  };
}

/** 界面勾选/追加/删除/清空都走这一条，返回最新的界面视图 */
export function planUiAction(key, { action, stepId, status, text, note, pin } = {}) {
  const res = planAction(key, { action, stepId, status, text, note, pin });
  return { text: res.text, plan: planPublicView(key), ok: !String(res.text).startsWith('ERROR') };
}

/** 列表页用：哪些会话有待办（没办完的才列出来） */
export function planHasOpenSteps(key = 'default') {
  const state = loadPlan(key);
  return progress(state).left.length > 0;
}
