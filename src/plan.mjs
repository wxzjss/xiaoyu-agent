// Autopilot: the multi-step task board (plan + notes) that survives across turns.
// Ported from the autopilot skill: plan / note / progress injection.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state', 'plan');
// 全体共用的一份 txt 清单，界面上原样显示它就是这份
const TXT_FILE = join(config.dataDir, '.state', '任务清单.txt');
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

function savePlan(key, state) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
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
    writeFileSync(TXT_FILE, body, 'utf8');
  } catch {
    // 写 txt 失败不影响主流程
  }
}

/** 界面读的就是这份 txt 原文 */
export function readPlanTxt() {
  try {
    if (!existsSync(TXT_FILE)) return { text: '（还没有任务清单，等我要做事的时候会写进来）', path: TXT_FILE };
    return { text: readFileSync(TXT_FILE, 'utf8'), path: TXT_FILE };
  } catch (e) {
    return { text: `（读清单出错了：${e && e.message}）`, path: TXT_FILE };
  }
}

function progress(state) {
  const total = state.steps.length;
  const done = state.steps.filter((s) => s.status === 'done').length;
  return { total, done, left: state.steps.filter((s) => s.status !== 'done' && s.status !== 'skipped') };
}

export function formatPlan(state) {
  if (!state.steps.length) return '（现在没有清单）';
  const { done, total } = progress(state);
  const lines = state.steps.map((s) => `${s.id}. ${MARK[s.status] || '·'} ${s.text}${s.note ? `（${s.note}）` : ''}`);
  return `目标：${state.goal || '（没写）'}\n进度：${done}/${total}\n${lines.join('\n')}`;
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
    const next = {
      goal: clean(args.goal, 300) || state.goal,
      createdAt: Date.now(),
      updatedAt: 0,
      steps: steps.map((text, i) => ({ id: i + 1, text, status: 'pending', note: '' })),
      notes: state.notes,
    };
    savePlan(key, next);
    return { text: `清单建好了：\n${formatPlan(next)}`, state: next };
  }

  if (action === 'update' || action === 'step' || action === 'mark') {
    const id = Number(args.stepId ?? args.id ?? args.step);
    const status = normStatus(args.status);
    const step = state.steps.find((s) => s.id === id);
    if (!step) return { text: `ERROR：没有第 ${args.stepId ?? '?'} 步（现有 1~${state.steps.length}）`, state };
    if (!status) return { text: `ERROR：status 只能是 pending / doing / done / skipped`, state };
    step.status = status;
    if (args.note !== undefined) step.note = clean(args.note, 300);
    savePlan(key, state);
    return { text: `第 ${id} 步 → ${status}\n${formatPlan(state)}`, state };
  }

  if (action === 'add' || action === 'append') {
    const text = clean(args.text ?? args.step, 300);
    if (!text) return { text: 'ERROR：add 需要 text', state };
    if (state.steps.length >= MAX_STEPS) return { text: `ERROR：清单最多 ${MAX_STEPS} 步`, state };
    state.steps.push({ id: state.steps.length + 1, text, status: 'pending', note: '' });
    savePlan(key, state);
    return { text: `加了一步：\n${formatPlan(state)}`, state };
  }

  if (action === 'clear' || action === 'reset') {
    savePlan(key, emptyState());
    return { text: '清单清空了', state: emptyState() };
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
export function planUiAction(key, { action, stepId, status, text, note } = {}) {
  const res = planAction(key, { action, stepId, status, text, note });
  return { text: res.text, plan: planPublicView(key), ok: !String(res.text).startsWith('ERROR') };
}

/** 列表页用：哪些会话有待办（没办完的才列出来） */
export function planHasOpenSteps(key = 'default') {
  const state = loadPlan(key);
  return progress(state).left.length > 0;
}
