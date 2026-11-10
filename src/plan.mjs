// Autopilot: the multi-step task board (plan + notes) that survives across turns.
// Ported from the autopilot skill: plan / note / progress injection.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state', 'plan');
// txt 清单目录：每个会话一份（以前是全体共用一份，谁最后动谁说了算）
const TXT_DIR = join(config.dataDir, '.state', 'plan');
const MAX_STEPS = 200;   // 【2026-10-31 清单只增不减】：30 步太容易撞顶后被截，放宽到 200
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

/** 【2026-10-31 清单活档案】
 * 每个会话一份「活档案」：只追加、永不覆盖。
 * 主人遇到过清单被一次 create 砍成 6 条（原本 25 条），靠 _history 归档才捞回来。
 * 从今往后，任何一步的增/改/删都往这份 .board.md 里记一笔，谁砍了都能照它重建。
 */
function boardFileFor(key) {
  const safe = String(key || 'default').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'default';
  return join(DIR, safe + '.board.md');
}

/** 把这一刻的清单快照追加进活档案（只追加，从不覆盖） */
function appendBoard(key, state, why) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const f = boardFileFor(key);
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const stamp = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
      + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
    const { done, total } = progress(state);
    let out = '';
    if (!existsSync(f)) {
      out += '# 任务清单活档案\n';
      out += '这份文件只增不删，是清单的最后一道保险。\n';
      out += '清单要是被谁砍了，照这份从最新一条往上一段一段重建就行。\n';
    }
    out += '\n## ' + stamp + ' · ' + (why || 'sync') + ' · ' + done + '/' + total + '\n';
    out += '目标：' + (state.goal || '（没写）') + '\n';
    if (!state.steps.length) out += '（此刻清单是空的）\n';
    for (const st of state.steps) {
      out += '- [' + (st.status === 'done' ? 'x' : st.status === 'skipped' ? '-' : ' ') + '] '
        + st.id + '. ' + st.text + (st.note ? '（' + st.note + '）' : '') + '\n';
    }
    appendFileSync(f, out, 'utf8');
  } catch {
    // 记档案失败不影响主流程
  }
}

function fileFor(key) {
  const safe = String(key || 'default').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'default';
  return join(DIR, `${safe}.json`);
}

function emptyState() {
  return { goal: '', createdAt: 0, updatedAt: 0, steps: [], notes: [] };
}

/**
 * 【2026-11-08 加】清单的主人会话没了，就接到最近的活会话上。
 *
 * 老 bug：跑测试时临时会话（__ord__ 之类）会把清单抢过去，测试一结束会话就删了，
 * 清单变成没主的孤儿，谁也不再管。现在读的时候兜一层：发现没主，就接给最近改过的那个会话。
 *
 * 【2026-11-08 严检补·三条保险】
 *   1. 防重入：savePlan 里会回读 loadPlan，而 loadPlan 会走到这儿 —— 不挡就会自己绕自己。
 *   2. 只认「真孤儿」：原文件必须存在、而且超过 2 分钟没动过。刚写出来的不算。
 *   3. 接完把原文件删掉，不然下次读又接一遍，越接越多。
 */
let ADOPTING = false;
function adoptPlanIfOrphan(key, state) {
  if (ADOPTING) return null;
  try {
    ADOPTING = true;
    if (SESS_DIR === null) return null;
    // 会话还在：这不是孤儿，什么都不该做
    if (fs.existsSync(join(SESS_DIR, key + ".json"))) return null;
    // 原文件得真的在那儿，而且不是刚写出来的（刚写的可能是别的进程正在用）
    const src = fileFor(key);
    if (!fs.existsSync(src)) return null;
    try {
      if (Date.now() - fs.statSync(src).mtimeMs < 120000) return null;
    } catch {
      return null;
    }
    const files = fs
      .readdirSync(SESS_DIR)
      .filter((f) => f.endsWith(".json") && !f.startsWith("_"))
      .map((f) => ({ id: f.slice(0, -5), t: fs.statSync(join(SESS_DIR, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (!files.length) return null;
    const last = files[0].id;
    if (last === key) return null;
    const st = state || emptyState();
    if (!st.steps.length) return null;
    // 【2026-11-08 修·踩过的坑】目标位置已经有清单时绝不许覆盖。
    // 刚才就是把幽灵清单接到了自己会话上，把主清单盖掉了（22 步变 1 步，靠 _history 才救回来）。
    if (fs.existsSync(fileFor(last))) return null;
    savePlan(last, { ...st, sessionId: last });
    // 接完把原来那份删掉，不然下次读又来一遍
    try {
      fs.unlinkSync(src);
    } catch {}
    return last;
  } catch {
    return null;
  } finally {
    ADOPTING = false;
  }
}

let SESS_DIR = null;
try {
  SESS_DIR = join(config.dataDir, ".state", "sessions");
} catch {}

export function loadPlan(key = 'default') {
  try {
    const data = JSON.parse(readFileSync(fileFor(key), 'utf8'));
    if (!data || typeof data !== 'object') return emptyState();
    const st = {
      goal: clean(data.goal, 300),
      createdAt: Number(data.createdAt) || 0,
      updatedAt: Number(data.updatedAt) || 0,
      steps: (Array.isArray(data.steps) ? data.steps : [])
        .filter((s) => s && typeof s.text === 'string')
        .slice(0, MAX_STEPS)
        .map((s, i) => ({
          // 【2026-11-08 修】id 不许按位置重算：归档删掉前面几条后，后面 id 会整体前移，stepId 就打勾到别人头上。
          id: (Number.isInteger(Number(s.id)) && Number(s.id) > 0) ? Number(s.id) : (i + 1),
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
    try { adoptPlanIfOrphan(key, st); } catch {}
    return st;
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
    // 【2026-11-08 修】文件名原来只精确到秒：同一秒里归档两次就撞名，
    // 后一次直接把前一次覆盖掉 —— 归档的作用就是「原件别丢」，撞名就等于白存。
    // 所以撞名时往后加序号。
    let f = join(HISTORY_DIR, `${safeKey}-${stamp}-${reason}.json`);
    let _n = 1;
    while (existsSync(f)) {
      f = join(HISTORY_DIR, `${safeKey}-${stamp}-${reason}-${_n}.json`);
      _n++;
    }
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
  try { pruneSaveArchives(); } catch {}
}

/**
 * 防丢闸：主人钉死的老任务不许被「新建清单」悄悄顶掉。
 * pinned=true 的步在 create 时自动接驳到新清单后面。
 */
/**
 * 【2026-11-08 加·底线第8条】已完成超过十条就归档并删掉这十条
 *
 * 背景：底线里早就写着这条，但代码里从来没人去数过 —— 规矩只印在纸上。
 * 结果清单一路涨到 64 条，还得主人自己来问「你清单多少了」。
 *
 * 现在让机器自己管：每次落盘前数一遍 done。
 * 超过 10 条就从最老的开始一条条收进 _history，一直收到只剩 10 条。
 * （主人 2026-11-09 把底线写成「删掉最旧的那条，最多保留 10 条」，就是这个意思）
 * 只搬 done 和 skipped；没做完的一个都不许动；pinned 的也不搬。
 *
 * 跟「清单只增不减」（MAX_STEPS=200）不冲突：那条管的是不许因为撞顶把步骤截掉，
 * 这里是主动归档，原文照样在 _history 里翻得到。
 */
const ARCHIVE_KEEP_DONE = 10;

/** 只清 'save' 这类自动存档，按时间倒序留最近 50 份（含 .json 和 .txt 成对）。 */
function pruneSaveArchives() {
  try {
    if (!existsSync(HISTORY_DIR)) return 0;
    const files = readdirSync(HISTORY_DIR).filter((n) => /-save\.(json|txt)$/.test(n));
    if (files.length <= 50 * 2) return 0;
    const withTime = files.map((n) => {
      let t = 0;
      try { t = statSync(join(HISTORY_DIR, n)).mtimeMs; } catch {}
      return { n, t };
    });
    withTime.sort((a, b) => b.t - a.t);
    const drop = withTime.slice(50 * 2);
    for (const d of drop) {
      try { unlinkSync(join(HISTORY_DIR, d.n)); } catch {}
    }
    return drop.length;
  } catch {
    return 0;
  }
}

function archiveFinishedSteps(key, state) {
  try {
    const steps = Array.isArray(state.steps) ? state.steps : [];
    const finished = steps.filter((st) => st && (st.status === 'done' || st.status === 'skipped'));
    if (finished.length <= ARCHIVE_KEEP_DONE) return 0;

    // 按在清单里出现的先后排（不按 id：老清单删过步，id 会有空洞）
    const ranked = finished
      .map((st) => ({ st, idx: steps.indexOf(st) }))
      .sort((a, b) => a.idx - b.idx);

    // 【2026-11-08 修】原来这里一次只收 10 条、然后循环。
    // 循环会把「最新做完的那几条」也当成最老的收走，而且收完还重编号，
    // 外面拿着的 stepId 全错位 —— 打勾会改到别的步骤上。
    //
    // 现在：只收一批，收「最老的 10 条」，剩下的（包括最新的）一条不动；
    // 收完绝对不重编号 —— id 就是身份证，动了就没人认得出谁是谁。
    const take = ranked.slice(0, finished.length - ARCHIVE_KEEP_DONE).map((x) => x.st);
    const takeSet = new Set(take);

    // pinned 的留下：主人钉死的任务不许自动消失
    const movable = take.filter((st) => !st.pinned);
    if (!movable.length) return 0;
    const movableSet = new Set(movable);

    // 先单独存一份档：只放这批，别把没做完的也写进去
    archivePlan(key, { ...state, steps: movable, notes: [] }, 'done-over');

    // 从当前清单摘掉（id 原样保留，绝不重编号）
    state.steps = steps.filter((st) => !movableSet.has(st));
    return movable.length;
  } catch {
    return 0;
  }
}

function pinnedSteps(state) {
  return (state.steps || []).filter((st) => st && st.pinned);
}

function savePlan(key, state) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  archiveFinishedSteps(key, state);   // 底线第8条：done 超十条先归档再落盘
  try { const prev = loadPlan(key); if (prev && prev.steps && prev.steps.length) archivePlan(key, prev, 'save'); } catch { /* 忽略 */ }
  state.updatedAt = Date.now();
  if (!state.createdAt) state.createdAt = state.updatedAt;
  writeFileSync(fileFor(key), JSON.stringify(state, null, 2), 'utf8');
  syncTxt(key, state);
}

/** 把某个会话的清单同步写成那份共用 txt（谁最后动谁说了算） */
function syncTxt(key, state) {
  // 【2026-10-31 清单活档案】：每次落盘顺手往只增不删的 .board.md 记一笔
  appendBoard(key, state, 'sync');
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
    // 【2026-10-31 清单只增不减】
    // 主人原话：「清单内容只可增加，无论是否做完，清单内容全部保留，清单内容严禁删除，严禁覆盖」。
    // 所以 create 不再是「推倒重来」，而是「往后面接」：
    //   ① 老步骤一条不动，原样留着（完成的也留着，带勾）
    //   ② 新步骤接在后面，跟老的重复的跳过
    //   ③ 真的一条都没接上（全重复）就照实说，不假装新建了
    if (state.steps.length) archivePlan(key, state, 'create-append');
    const have = new Set((state.steps || []).map((st) => String(st.text || '').trim()));
    const fresh = steps.filter((t) => !have.has(String(t).trim()));
    const skipped = steps.length - fresh.length;
    const base = (state.steps || []).slice();
    const merged = [...base, ...fresh.map((text) => ({ text, status: 'pending', note: '' }))];
    if (!fresh.length && base.length) {
      return { text: ('新给的 ' + steps.length + ' 步清单上全都有了，没有重复记一遍。\n' + formatPlan(state)), state };
    }
    const next = {
      goal: clean(args.goal, 300) || state.goal,
      createdAt: Date.now(),
      updatedAt: 0,
      steps: merged.map((st, i) => ({ id: i + 1, text: st.text, status: st.status === 'done' ? 'done' : (st.status || 'pending'), note: st.note || '', pinned: !!st.pinned })),
      notes: state.notes,
    };
    savePlan(key, next);
    const tip = skipped > 0 ? `\n（有 ${skipped} 条之前就在清单上，没重复记）` : '';
    return { text: `清单接上了（老的一步没删）：\n${formatPlan(next)}${tip}`, state: next };
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
  /**
   * 【2026-11-08 改硬·主人报「每次做完都不打勾，得我提醒」】
   *
   * 实测数据：113 个清单共 984 步，done 只有 584（59%），386 步一直停在 pending ——
   * 很多清单是 0/5、0/7。她**看得到**这段（真机验过提示词里确实有【正在办】），
   * 但原来那句「办完了用 plan 把对应步骤勾成 done」读起来像建议，不是规矩。
   * 现在改成命令语气 + 讲清代价（不勾＝没做，攒着会忘，最后要主人来提醒）。
   */
  const TAIL = '\n【打完这一步就勾】每做完一步，**立刻** plan update（stepId + status:"done"）勾掉，别攒着。'
    + '\n不勾等于没做完：攒到最后一定忘，主人就得自己提醒你。'
    + '\n主人中途加的要求也要 add 进清单，别只在脑子里记。';
  if (body.length + TAIL.length > MAX_PROMPT_CHARS) body = body.slice(0, MAX_PROMPT_CHARS - TAIL.length) + '…';
  body += TAIL;
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

/**
 * 【2026-11-08 根治·干完活不列清单】
 *
 * 真出过的事：主人问「清单都做完了？」，我一查才发现这一轮压根没建清单 ——
 * 活照干、文件照改、回归照跑，但清单是空的，progressBlock 没东西可提醒，
 * 等于零保护。别的会话也出过同样的事，所以这里不能只靠提示词叮嘱。
 *
 * 做法：由 agent 那边在每次工具跑完后调 markToolTouched()，
 * 只要这一轮动过手、而清单为空，就返回一句硬提醒，
 * 由调用方塞进工具结果里 —— 下一轮我一定读得到。
 */
let _toolTouched = false;

/** agent 那边每跑完一个工具就喊一声。onlyWrite=true 表示这是会改东西的工具。 */
export function markToolTouched() {
  _toolTouched = true;
}

/** 每轮开头复位。 */
export function resetToolTouched() {
  _toolTouched = false;
}

/** 动过手但清单是空的 → 返回一句警告；其它情况一律返回空串。 */
export function planEmptyHint(key = 'default') {
  if (!_toolTouched) return '';
  try {
    const state = loadPlan(key);
    const steps = Array.isArray(state.steps) ? state.steps : [];
    if (steps.length) return '';
    return (
      '【清单缺失·硬规矩】你这一轮已经在动手了，但清单一条都没列。' +
      '立刻用 plan create 把这次真正要做的事列成清单（一步一句，说人话），' +
      '然后把已经做完的那几步 update 成 done。' +
      '没列清单就等于没做，别等主人问。'
    );
  } catch {
    return '';
  }
}
