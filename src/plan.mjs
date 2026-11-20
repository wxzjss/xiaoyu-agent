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

/* 【2026-11-15 晚·落盘节流】见 savePlan 里的说明：这两件事以前每次落盘都做，太贵。 */
let _lastPruneAt = 0;
const _lastSaveArchiveAt = new Map();

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

/* ══════════ 【2026-11-15 修·清单内容重复】══════════
 *
 * 主人原话：「清单内容有时候会重复，是为什么？修，同时增加自动检测完全重复的清单内容」。
 *
 * 【为什么会重复 —— 三条叠在一起】
 *   ① `create` 的语义是「接在后面」（主人定的清单只增不减），可工具说明写的是「create 新建」。
 *      她以为在重建清单，于是把同一批步骤**换个说法再列一遍** → 老的一步没删、新的又接上。
 *   ② 查重只比「trim 后完全相同的字符串」。她换个措辞（"读 run-all-checks.mjs，定位…"
 *      vs "读 run-all-checks.mjs 弄清…"）就不算重复了，照样接上去。
 *   ③ `add` 那条路**一点查重都没有**，同一句能加十遍。
 *   实测（2026-11-15 16:30 盘面）：修理鱼 20 步里有 1 对 0.79 相似、小白曦 12 步 3 对、
 *   杂活鱼 44 步 4 对、检查鱼 10 步 2 对 —— 全是「同一件事换了个说法」。
 *
 * 【怎么修】
 *   · `normStepText()`：去掉空白/标点/序号前缀/打勾标记，只留实字；
 *   · `dice()`：字符二元组 Dice 相似度（中文不需要分词，也不引依赖）；
 *   · `sameStep()`：数字/序数不同就绝不算同一件事（"跑第一次" / "跑第二次" 是两步）；
 *   · create / add 都先查：完全重复 → 跳过；近似重复（≥0.86）→ 也跳过，并告诉她撞的是第几步；
 *   · `dedupeSteps()`：落盘前把**完全重复**的合并成一条（状态取最靠后的、id 取最小、钉死/备注不丢）。
 *     这只合并没有删内容，符合「清单只增不减」的本意：重复的那份本来就没有新信息。
 */

/** 清单文本归一化：只留实字，去掉标点、序号、勾选标记、大小写差异 */
export function normStepText(t) {
  return String(t ?? '')
    .replace(/^\s*(?:[-*+·]\s*)?(?:\[[ xX\-]\]\s*)?/, '')
    .replace(/^\s*(?:第\s*\d+\s*步[:：.、]?|\d+\s*[.、)．:：])\s*/, '')
    .replace(/[\s\u3000]/g, '')
    /* 「跑一次全量」和「跑全量」是同一件事 —— 这些量词只是口气，不改变做什么。
     * 注意：不动「第一次/第二次」那种序数（numKey 会单独比），也不动"两次"。 */
    .replace(/(?:一下|一次|一遍|一轮|一回)/g, '')
    .replace(/[，。、；：！？,.;:!?~～"'"'`（）()\[\]【】{}<>《》\-—_/\\|]/g, '')
    .toLowerCase();
}

/** 数字与序数指纹：1/2、第一/第二 都算不同的事，不能因为「其余字一样」就判重 */
function numKey(t) {
  const s = String(t ?? '');
  const out = [];
  const cn = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  for (const m of s.matchAll(/\d+/g)) out.push(String(Number(m[0])));
  for (const m of s.matchAll(/第([一二两三四五六七八九十])/g)) out.push('o' + (cn[m[1]] || m[1]));
  for (const m of s.matchAll(/([一二两三四五六七八九十])\s*(?:次|遍|轮|回)/g)) {
    const n = cn[m[1]] || m[1];
    /* 「跑一次」=「跑」，不该因为这个"一"就判成两件事；「跑两次」才是另一种量。
     * 「第一次 / 第二次」那种序数在上面的 /第X/ 已经单独取了 o 标记。 */
    if (Number(n) >= 2) out.push('t' + n);
  }
  return out.join(',');
}

/** 字符二元组 Dice 相似度（0~1）。中文按字切就够了，短句也能拉开差距。 */
function dice(a, b) {
  const s1 = String(a || '');
  const s2 = String(b || '');
  if (!s1 || !s2) return 0;
  if (s1 === s2) return 1;
  const big = (s) => {
    const m = new Map();
    if (s.length === 1) { m.set(s, 1); return m; }
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const A = big(s1);
  const B = big(s2);
  let inter = 0;
  let total = 0;
  for (const [g, n] of A) { total += n; const m = B.get(g); if (m) inter += Math.min(n, m); }
  for (const [, n] of B) total += n;
  if (!total) return 0;
  return (2 * inter) / total;
}

/**
 * 「实体指纹」：把步骤里的英文词/文件名/数字抽出来（run-all-checks.mjs、spawn、177…）。
 *
 * 【为什么必须要它】光看相似度会误杀：「修 A 文件」和「修 B 文件」字面 90% 像，
 * 却是两件不同的事。抽出实体一比就能分开 —— 这是"换说法"和"换对象"的分水岭。
 */
function tokensOf(t) {
  const arr = String(t ?? '').match(/[A-Za-z][A-Za-z0-9._\-]*|\d+/g) || [];
  return [...new Set(arr.map((x) => x.toLowerCase()))].sort().join('|');
}

/**
 * 「核心脚本」指纹：这一步最先提到的是哪个脚本 / 文件（check-smoke.mjs、run-all-checks.mjs）。
 *
 * 【2026-11-16 修·同义改写漏判·第二刀】同一件事换个说法，中文全换、日志文件名也换，
 * 唯一不变的就是那个脚本名。实测踩过：同一趟回归被写了二十遍，每次换个日志名
 * （smoke-1116.log / smoke-final.log / smoke-r19.out），实体集互不包含，
 * 全被判成新步骤，续上提示就照着念「还有 20 步没做完」。
 * 所以只要核心脚本是同一个，就当同一件事去比正文。
 */
function coreToken(t) {
  const all = String(t ?? '').match(/[A-Za-z][A-Za-z0-9._\-]*/g) || [];
  if (!all.length) return '';
  const script = all.filter((x) => /\.(mjs|js|cjs|ts|py|ps1|sh)$/i.test(x));
  const file = all.filter((x) => /\.[a-z0-9]{1,6}$/i.test(x));
  const pick = script.length ? script : file.length ? file : all;
  return pick.map((x) => x.toLowerCase()).sort((a, b) => b.length - a.length)[0];
}

/**
 * 把英文标记（连同粘在它上面的数字）整段剔掉，剩下的才是「到底说了什么」。
 * 「第 60 行 / 第 200 行」这种真数字要留着；「smoke-1116.log」里的 1116 要剔掉，
 * 不然同一个脚本换个日志名就被当成另一件事。
 */
function bodyOf(t) {
  return String(t ?? '').replace(/[A-Za-z][A-Za-z0-9._\-]*/g, ' ');
}

/** 最长公共子串长度：判断两句话的「中文主干」到底说的是不是同一件事。
 *  用子串不用整体相似度，是因为同义改写常常一长一短（多写个「并取退出码」），
 *  整体的 Dice 会被长度差拉低，而两边共有的那截主干恰好说明了是同一件事。 */
function longestCommon(a, b) {
  const s1 = String(a || '');
  const s2 = String(b || '');
  if (!s1 || !s2) return 0;
  let best = 0;
  const prev = new Array(s2.length + 1).fill(0);
  for (let i = 1; i <= s1.length; i++) {
    let diag = 0;
    for (let j = 1; j <= s2.length; j++) {
      const tmp = prev[j];
      if (s1[i - 1] === s2[j - 1]) {
        prev[j] = diag + 1;
        if (prev[j] > best) best = prev[j];
      } else {
        prev[j] = 0;
      }
      diag = tmp;
    }
  }
  return best;
}

/** 近似重复的门槛（实体指纹 + 数字指纹都一致才比这个）。
 *  0.72 是拿盘上真实重复量出来的：同义改写的 Dice 落在 0.72~0.95，
 *  而「第一次/第二次」已被 numKey 挡掉、「改 A / 改 B」已被实体指纹挡掉。
 *  宁可漏判也不误判：漏判只是多一条重复，误判会把真·新步骤吞掉。 */
const DUP_NEAR = 0.72;

/**
 * 这一段跟清单上哪一步撞了？
 * @returns {{step:object, how:'same'|'near', score:number}|null}
 */
export function findSameStep(steps, text, excludeId) {
  const key = normStepText(text);
  if (!key) return null;
  const nums = numKey(text);
  const toks = tokensOf(text);
  let best = null;
  for (const st of steps || []) {
    if (!st || (excludeId != null && Number(st.id) === Number(excludeId))) continue;
    const k = normStepText(st.text);
    if (!k) continue;
    if (k === key) return { step: st, how: 'same', score: 1 };
    /* 【2026-11-16 修·同义改写漏判】原来是 tokensOf 严格相等才继续算相似度。
     * 可实测踩过：同一件事「cd 到 scripts 跑 node check-smoke.mjs」vs
     * 「在 scripts 目录跑 node check-smoke.mjs」，中文字全换了、英文标记少了个 cd，
     * 直接被判成两件事 —— 于是同一件活被反复 add 成十几条，续上提示照着念
     * 「还有 20 步没做完」，人就一直以为活没干完。
     * 改法：一方是另一方的子集（多写个 cd / 少写句话）就放行，让 Dice 去判；
     * 真差异（改 A 文件 / 改 B 文件）两边互不包含，照旧跳过，不会误吞。
     * 顺序要在 numKey 之前判：同一件事连日志名/批次号都换了（smoke-1116.log vs
     * smoke-final.log），numKey 先拦就永远轮不到判重。 */
    /* 【2026-11-16 修·第三刀·核心脚本判重】实体集子集关系还是不够：
     * 日志名一换（smoke-1116.log → smoke-final.log），两边实体集互不包含，照样漏。
     * 实测同一趟回归被写成二十条，中文重合度只有 0.36~0.5，靠 Dice 永远抓不住。
     * 换判据：**核心脚本是同一个**（check-smoke.mjs）+ **中文主干有 3 字以上连续重合**
     * + 主干里的数字/序数一致 → 就是同一件事。
     * 反过来「改 plan.mjs 判重门槛」vs「改 server.mjs 建轮时间」核心脚本不同，
     * 落到下面的老逻辑，不会误吞。 */
    const coreA = coreToken(st.text);
    const coreB = coreToken(text);
    const bodyA = normStepText(bodyOf(st.text));
    const bodyB = normStepText(bodyOf(text));
    if (coreA && coreB && coreA === coreB && bodyA && bodyB
        && numKey(bodyA) === numKey(bodyB)) {
      const lcs = longestCommon(bodyA, bodyB);
      if (lcs >= 3 && lcs / Math.min(bodyA.length, bodyB.length) >= 0.4) {
        const sc = lcs / Math.max(bodyA.length, bodyB.length);
        if (!best || sc > best.score) best = { step: st, how: 'near', score: sc };
        continue;
      }
    }
    /* 【2026-11-16 修·第四刀】两边都带了核心脚本、而且不是同一个 → 换对象了，不是重复。
     * 实测误吞：「修 src/a.mjs 的宽度」vs「修 src/b.mjs 的宽度」剔掉英文后主干
     * 剩下“修 的宽度”一模一样，会被下面纯中文兜底当成同一件事吞掉。
     * 核心脚本不同就是不同的事，直接走开，不进任何相似度。
     * （只在互相都不包含时才算不同：check-smoke.mjs 和简写的 smoke 是同一个；
     *   a.mjs 和 b.mjs 互不包含，才是真的换了对象。） */
    if (coreA && coreB && coreA !== coreB
        && !coreA.includes(coreB) && !coreB.includes(coreA)) continue;
    /* 连脚本名都没写、纯中文改写的（「跑冒烟回归 smoke，结果看退出码」这种）：
     * 核心脚本这一关过不去，靠主干兜。门槛卡到 4 字起，且必须占短句一半以上 ——
     * 「改 A 文件」vs「改 B 文件」主干只重合 1 个字，绝不可能被吞。 */
    if (bodyA && bodyB && numKey(bodyA) === numKey(bodyB)) {
      const lcs2 = longestCommon(bodyA, bodyB);
      const short = Math.min(bodyA.length, bodyB.length);
      if (lcs2 >= 4 && short > 0 && lcs2 / short >= 0.5) {
        const sc2 = lcs2 / Math.max(bodyA.length, bodyB.length);
        if (!best || sc2 > best.score) best = { step: st, how: 'near', score: sc2 };
        continue;
      }
    }
    let related = false;
    if (tokensOf(st.text) !== toks) {
      const a = tokensOf(st.text).split('|').filter(Boolean);
      const b = String(toks || '').split('|').filter(Boolean);
      const sub = (x, y) => x.every((t) => y.includes(t));
      related = !!(a.length && b.length && (sub(a, b) || sub(b, a)));
      if (!related) continue;
    }
    if (!related && numKey(st.text) !== nums) continue;   // 第一次 / 第二次 这类不算重复
    const sc = dice(key, k);
    /* 英文标记是子集关系时，说的基本就是同一件事，Dice 门槛从 0.72 放到 0.55：
     * 「存日志、取退出码」和「日志存 smoke-1116.log，记退出码」语序都换了，
     * 二元组只剩六成重合 —— 那也还是同一件活。 */
    const nearLine = related ? 0.55 : DUP_NEAR;
    if (sc >= nearLine && (!best || sc > best.score)) best = { step: st, how: 'near', score: sc };
    /* 「包含」也算同一件事：「跑全量回归」vs「跑一次全量回归」Dice 只有 0.6（插了两个字
     * 就把二元组全打散了），可它们明明是同一件。短的那句 ≥6 字且占长的七成以上 → 判重。
     * 门槛故意定得紧：短句（"读文件"/"改文件"）永远进不来，免得误吞。
     * 【2026-11-16 补】英文标记已经是子集关系（多写个 cd）时，中文主干按「包含」判就够了，
     * 短句门槛放宽到 10 字 —— 太长的不放，怕把真·新步骤吞掉。 */
    if (!best) {
      const short = key.length <= k.length ? key : k;
      const long = short === key ? k : key;
      const ratio = long.length ? short.length / long.length : 0;
      const need = related ? 10 : 6;
      if (short.length >= need && ratio >= 0.7 && long.includes(short)) best = { step: st, how: 'near', score: ratio };
    }
  }
  return best;
}

const STATUS_RANK = { pending: 0, doing: 1, skipped: 2, done: 3 };

/**
 * 落盘前把**完全重复**的步骤合并成一条（原地改留下的那条对象，不新建，
 * 免得外面拿着的 step 引用失效）。
 *
 * 合并规则（怎么算都不丢信息）：
 *   · id 取最小那个（老号的勾还在）；
 *   · 状态取"最靠后"的（done > skipped > doing > pending）—— 做过就是做过；
 *   · 备注取更长的那条；
 *   · 任一钉死则钉死；toolCalls 取最大（真实花过的次数不会因为合并变小）。
 * @returns {number} 合并掉几条
 */
export function dedupeSteps(state) {
  if (!state || !Array.isArray(state.steps)) return 0;
  const keep = [];
  const byKey = new Map();
  let merged = 0;
  for (const st of state.steps) {
    if (!st || typeof st.text !== 'string') continue;
    const k = normStepText(st.text);
    if (!k) { keep.push(st); continue; }
    const prev = byKey.get(k);
    if (!prev) { byKey.set(k, st); keep.push(st); continue; }
    /* 合并进先出现的那条（原地改） */
    if (Number(st.id) < Number(prev.id)) prev.id = st.id;
    const a = STATUS_RANK[prev.status] ?? 0;
    const b = STATUS_RANK[st.status] ?? 0;
    if (b > a) prev.status = st.status;
    if (String(st.note || '').length > String(prev.note || '').length) prev.note = st.note;
    if (st.pinned) prev.pinned = true;
    if ((Number(st.toolCalls) || 0) > (Number(prev.toolCalls) || 0)) prev.toolCalls = Number(st.toolCalls) || 0;
    merged += 1;
  }
  if (merged) state.steps = keep;
  return merged;
}

/** 【2026-11-15】给缺 id 的老数据补号：跳过已有的号，避免重号 */
function _fillId(list, i) {
  const used = new Set();
  for (const x of list) {
    const n = Number(x && x.id);
    if (Number.isInteger(n) && n > 0) used.add(n);
  }
  let cand = i + 1;
  while (used.has(cand)) cand += 1;
  used.add(cand);
  return cand;
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
        .map((s, i, _list) => ({
          // 【2026-11-08 修】id 不许按位置重算：归档删掉前面几条后，后面 id 会整体前移，stepId 就打勾到别人头上。
          // 【2026-11-15 再修】缺 id 的老数据补号时也要避开已有的号，别补出一个跟别人重号的 id。
          id: (Number.isInteger(Number(s.id)) && Number(s.id) > 0) ? Number(s.id) : _fillId(_list, i),
          text: clean(s.text, 300),
          status: STATUSES.includes(s.status) ? s.status : 'pending',
          note: clean(s.note, 300),
          pinned: !!s.pinned,
          /* 【2026-11-18 加】并行标记 —— 标了它的步骤不受「同时只一个 doing」约束。
           * 必须在这里显式带上，否则 savePlan 一归一化就把它丢了，
           * 下一轮"唯一 doing"那道闸会把真正的并行场景误拦。 */
          parallel: !!s.parallel,
          /* 【2026-11-15 加·主人要「每项任务各用了几次工具调用」】
           * 这里是白名单式重建，漏一个字段就等于读回来时把它丢了（这坑踩过两次：
           * goal/decisions、intent 各一次）。toolCalls 必须跟着一起留。 */
          toolCalls: Number(s.toolCalls) || 0,
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

/* 【2026-11-15 晚·整套「N 次工具调用」统计按主人要求删除】
 * 原来这里有一本会话级的账：每跑一次真活 +1，打勾时取走并写进回执。
 * 主人说不要这个显示，所以计数、取数、白名单三个东西一起删干净 —— 留着不用
 * 反而是个陷阱：以后有人看到 bumpToolCall 还以为它在生效。
 */

/** 清单归档目录：每次覆盖/清空前，旧清单原文先扔这儿，谁也别想再「找不回来」 */
const HISTORY_DIR = join(config.dataDir, '.state', 'plan', '_history');

/**
 * 【2026-11-14 主人钦点·清单页「总计」】
 * 分母 = 当前清单 + _history 里所有归档清单中，出现过的最大任务编号；
 * 分子 = 那个最大编号 - 当前清单界面上还没完成的条数（done/skipped 都算完成了）。
 * 每次生成 txt / 格式化清单时现算，所以归档一多、任务一勾，数字自己跟着动。
 */
function everTotal(key, state) {
  let max = 0;
  const take = (steps) => {
    for (const s of (Array.isArray(steps) ? steps : [])) {
      const n = Number(s && (s.id ?? s.n));
      if (Number.isFinite(n) && n > max) max = n;
    }
  };
  take(state && state.steps);
  if (Array.isArray(state && state.steps)) max = Math.max(max, state.steps.length);
  try {
    if (existsSync(HISTORY_DIR)) {
      const k = String(key || 'default').replace(/[^\w.-]/g, '_');
      for (const f of readdirSync(HISTORY_DIR)) {
        if (!f.startsWith(k + '-') || !f.endsWith('.json')) continue;
        try { take(JSON.parse(readFileSync(join(HISTORY_DIR, f), 'utf8')).steps); } catch {}
      }
    }
  } catch {}
  return max;
}

function totalLine(key, state) {
  const max = everTotal(key, state);
  return `总计：${max}`;
}

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
      totalLine(key, state),
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
    // 【2026-11-15 主人新规矩】归档总量超 100 份（不分 save/归档），按最旧彻底删
    const files = readdirSync(HISTORY_DIR).filter((n) => n.endsWith('.json') || n.endsWith('.txt'));
    if (files.length <= 100) return 0;
    const now = Date.now();
    const withTime = files.map((n) => {
      let t = 0;
      try { t = statSync(join(HISTORY_DIR, n)).mtimeMs; } catch {}
      // 【2026-11-15 事故保险】mtime 在未来的文件是异常文件（时间戳溢出等），最不容易被误删
      if (t > now + 60000) t = now; // 异常文件当刚落盘的，最不容易被删
      return { n, t };
    });
    withTime.sort((a, b) => b.t - a.t);
    const drop = withTime.slice(100);
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

    // 【2026-11-15 主人新规矩】只要打勾的 done 超 10 条就清最旧的，只留 10 条；
    // pinned 也不例外 —— 归档里有底，不算丢。
    const movable = take;
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

/** 【2026-11-15】下一个可用 id = 现有最大 id + 1。永远往前走，绝不回收旧号。 */
function nextStepId(state) {
  let mx = 0;
  for (const st of (state && state.steps) || []) {
    const n = Number(st && st.id);
    if (Number.isInteger(n) && n > mx) mx = n;
  }
  return mx + 1;
}

function pinnedSteps(state) {
  return (state.steps || []).filter((st) => st && st.pinned);
}

function savePlan(key, state) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  /* 【2026-11-15 加】落盘前把完全重复的步骤并成一条 —— 老数据里已经攒下的重复，
   * 下一次落盘就自动清掉；新数据在 create/add 那两处就挡住了，这里是最后一道。
   * 只合并「归一化后一字不差」的，不动内容，不算删清单。 */
  try {
    const _m = dedupeSteps(state);
    if (_m) {
      try {
        const _f = join(config.dataDir, '.state', 'diag.log');
        appendFileSync(_f, new Date().toISOString() + ' [plan-dedupe] ' + key + ' 合并了 ' + _m + ' 条完全重复的步骤\n', 'utf8');
      } catch { /* 记日志失败不影响落盘 */ }
    }
  } catch { /* 合并失败就照原样落盘 */ }
  archiveFinishedSteps(key, state);   // 底线第8条：done 超十条先归档再落盘
  /* 【2026-11-15 晚·落盘别每次都抄一份档 —— 打勾被拖成龟速的真凶】
   *
   * 实测（40 步清单连打 60 次勾）：**6.7 秒**，顺手写出 100 个归档文件。
   * 原来每次 savePlan 都干两件重活：
   *   ① pruneSaveArchives()：readdir + 逐个 stat 整个 _history；
   *   ② archivePlan(prev,'save')：把上一版清单**整份复制**进 _history（json + txt 两份）。
   * 打一次勾 = 抄一份清单，几十步的活就是几十份，全盘 IO 都耗在这上面 ——
   * 主人看到的"清单更新卡一下"、回归里 plan 相关检查撞 60 秒超时，都是它。
   *
   * 现在上两道节流（只影响这两件"保险"，**不丢任何真实数据**）：
   *   · 归档总量守门：60 秒最多查一次（它只是删超量，晚一分钟没风险）；
   *   · save 兜底档：同一个清单 5 分钟最多存一份（create/clear/done-over 那几种
   *     关键动作的归档**不受影响**，照旧每次都存）。
   */
  try {
    const _now = Date.now();
    if (_now - _lastPruneAt > 60000) { _lastPruneAt = _now; pruneSaveArchives(); }
    const _prevArchiveAt = Number(_lastSaveArchiveAt.get(key) || 0);
    if (_now - _prevArchiveAt > 300000) {
      const prev = loadPlan(key);
      if (prev && prev.steps && prev.steps.length) {
        archivePlan(key, prev, 'save');
        _lastSaveArchiveAt.set(key, _now);
      }
    }
  } catch { /* 归档是保险，失败不能挡住落盘 */ }
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
    body += totalLine(key, state) + '\n';
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
    let text = readFileSync(file, 'utf8');
    /* 【2026-11-15 主人再报·总计还带着前一个数字】盘上老 txt 已经写下了「总计：15/17」，
     * 之前只在「没有总计行」时才补 —— 于是斜杠版本一直留着。现在每次读都重写这一行，
     * 只留后一个数字（总数）。下次 syncTxt 落盘也会写原生版本。 */
    try {
      const _state = loadPlan(key);
      const _line = totalLine(key, _state);
      if (/总计：.*/.test(text)) text = text.replace(/总计：.*/g, _line);
      else if (/进度：\d+\/\d+\n/.test(text)) text = text.replace(/(进度：\d+\/\d+\n)/, '$1' + _line + '\n');
      /* 【2026-11-15 主人报·进度行是死文本】盘上 txt 的「进度：N/M」是落盘那一刻的快照，
       * 之后打勾它也不变 —— 界面读这份文本就永远显示旧数（8/10 事件）。
       * 修法：每次读都按现算口径重写这一行，done/skipped 都算完成，跟 progress() 对齐。 */
      const _p = progress(_state);
      const _fresh = `进度：${_p.done}/${_p.total}`;
      if (/进度：\d+\/\d+\n/.test(text)) text = text.replace(/进度：\d+\/\d+\n/g, _fresh + '\n');
    } catch (e) {}
    return { text, path: file };
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
  const done = steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
  return { total, done, left: steps.filter((s) => s.status !== 'done' && s.status !== 'skipped') };
}

export function formatPlan(state) {
  const safe = safeState(state);
  if (!safe.steps.length) return '（现在没有清单）';
  const { done, total } = progress(safe);
  const lines = safe.steps.map((s) => `${s.id}. ${MARK[s.status] || '·'} ${s.text}${s.note ? `（${s.note}）` : ''}`);
  return `目标：${safe.goal || '（没写）'}\n进度：${done}/${total}\n${totalLine('', safe)}\n${lines.join('\n')}`;
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
    /* 【2026-11-15 修·重复从这里进来】老写法只比「trim 后一字不差」，换个说法就当成新步骤接上。
     * 现在用 findSameStep：完全重复 + 近似改写（≥0.86）都跳过，并把撞了第几步告诉她。 */
    const fresh = [];
    const hitOld = [];
    const seenNow = new Set();
    for (const t of steps) {
      const k = normStepText(t);
      if (!k) continue;
      if (seenNow.has(k)) { hitOld.push(`「${t.slice(0, 30)}」→ 这次给的里就重了`); continue; }
      seenNow.add(k);
      const hit = findSameStep([...(state.steps || []), ...fresh.map((x) => ({ id: 0, text: x }))], t);
      if (hit) {
        const _id = Number(hit.step.id) || 0;
        const _where = _id ? (hit.how === 'same' ? '已经在第 ' + _id + ' 步' : '跟第 ' + _id + ' 步是同一件事')
          : '跟这次新给的另一步是同一件事';
        hitOld.push(`「${t.slice(0, 30)}」→ ${_where}`);
        continue;
      }
      fresh.push(t);
    }
    const skipped = hitOld.length;
    const base = (state.steps || []).slice();
    const merged = [...base, ...fresh.map((text) => ({ text, status: 'pending', note: '' }))];
    if (!fresh.length && base.length) {
      return {
        text: ('新给的 ' + steps.length + ' 步清单上全都有了，没有重复记一遍。'
          + (hitOld.length ? '\n撞上的：\n· ' + hitOld.join('\n· ') : '')
          + '\n（清单是「只增不减」的：create 不会推倒重来，只在后面接新步骤。'
          + '要改某一步的状态用 update，别为了改状态再 create 一遍。）\n'
          + formatPlan(state)),
        state,
      };
    }
    const next = {
      goal: clean(args.goal, 300) || state.goal,
      createdAt: Date.now(),
      updatedAt: 0,
      /* 【2026-11-15 根治 · id 永不重排】create 是「接上」老清单，老步骤的 id 必须原样留着。
       * 老写法 id: i+1 会把整张清单重新编号，第 N 步换成别人，打过的勾/钉死全跟着错位
       * （实测 66 步清单被 create 串成 76 步、勾落到别的行上，就是这么来的）。
       * 新接上的步骤一律从「当前最大 id + 1」往后排，绝不回头占号。 */
      steps: (() => {
        let mx = 0;
        for (const st of base) {
          const n = Number(st && st.id);
          if (Number.isInteger(n) && n > mx) mx = n;
        }
        return merged.map((st) => {
          const kept = Number.isInteger(Number(st.id)) && Number(st.id) > 0;
          const st2 = st.status === 'done' ? 'done' : (st.status || 'pending');
          if (kept) return { id: Number(st.id), text: st.text, status: st2, note: st.note || '', pinned: !!st.pinned };
          mx += 1;
          return { id: mx, text: st.text, status: st2, note: st.note || '', pinned: !!st.pinned };
        });
      })(),
      notes: state.notes,
    };
    savePlan(key, next);
    const tip = skipped > 0
      ? `\n（跳过 ${skipped} 条重复的，没再记一遍：\n· ${hitOld.join('\n· ')}）`
      : '';
    return { text: `清单接上了（老的一步没删）：\n${formatPlan(next)}${tip}`, state: next };
  }

  if (action === 'update' || action === 'step' || action === 'mark') {
    const id = Number(args.stepId ?? args.id ?? args.step);
    const status = normStatus(args.status);
    const step = state.steps.find((s) => s.id === id);
    if (!step) {
      const ids = (state.steps || []).map((x) => x.id).join(', ');
      return { text: `ERROR：没有第 ${args.stepId ?? '?'} 步（现有这些号：${ids || '空清单'}）`, state };
    }
    if (!status) return { text: `ERROR：status 只能是 pending / doing / done / skipped`, state };
    /**
     * 【2026-11-18 加·同时只允许一步在「doing」】
     *
     * 为什么要这条（不是提示词，是结构约束）：
     *   实测 34 个会话 322 步，完成率只有 65% —— 三成多步骤停在半路。
     *   查下来一个典型形态是：同时标好几个 doing，然后哪个都没真做完。
     *   清单从"执行计划"退化成"许愿池"，界面上也看不出现在到底在干哪件。
     *
     * Claude Code 的做法是状态层直接拒（`Error: Only one todo can be in_progress`），
     * 不靠劝。这条照它的思路，但**留了后门**：
     *   · 真的并行干活（spawn_workers 那种）时，给步骤标 `parallel: true` 就不受限；
     *   · 否则必须先把上一步勾掉，再标下一步。
     *
     * 为什么留后门：我们确实有并行派活的场景（spawn_workers / team 模式），
     * 一刀切禁掉会挡住真活儿。而且"同时三件事"有时是对的 —— 只是得显式声明。
     */
    if (status === 'doing') {
      const others = (state.steps || []).filter(
        (s) => s.id !== id && s.status === 'doing' && !s.parallel,
      );
      /* 本步自己标了 parallel 就不受约束（它本来就打算并行） */
      if (others.length && !step.parallel && args.parallel !== true) {
        const list = others.map((s) => `第${s.id}步「${s.text}」`).join('、');
        return {
          text: `ERROR：现在已经有 ${list} 在做（同时只能有一个 doing）。\n`
            + '要么先把那一步勾成 done / skipped，要么改成 pending 排队。\n'
            + '如果是真的要并行跑（比如派了 worker），给这一步加 parallel: true 再标 doing。',
          state,
        };
      }
    }
    step.status = status;
    if (args.parallel !== undefined) step.parallel = !!args.parallel;
    if (args.note !== undefined) step.note = clean(args.note, 300);
    if (args.pin != null) step.pinned = !!args.pin;
    /* 【2026-11-15 晚·主人要求删掉】
     * 以前打勾回执里会带「这一步用了 N 次工具调用」，全部做完还附一张逐项统计表。
     * 主人明确说这套显示不要了 —— 整段移除；记账入口（bumpToolCall / takeToolTally）
     * 也一并删干净，免得留个没人用的钩子，下次看着还以为在生效。 */
    const _tickLine = '';
    /* savePlan 内部先走 archiveFinishedSteps（done 超十条归档+摘除、id 不重排），
     * 改的是同一个 state 对象，返回的文案/状态跟落盘天然一致。 */
    savePlan(key, state);
    return { text: `第 ${id} 步 → ${status}${_tickLine}\n${formatPlan(state)}`, state };
  }

  if (action === 'add' || action === 'append') {
    const text = clean(args.text ?? args.step, 300);
    if (!text) return { text: 'ERROR：add 需要 text', state };
    if (state.steps.length >= MAX_STEPS) return { text: `ERROR：清单最多 ${MAX_STEPS} 步`, state };
    /* 【2026-11-15 修·add 以前一点查重都没有】同一句能加十遍，清单越加越长还看不出哪条是新的。 */
    const _dup = findSameStep(state.steps, text);
    if (_dup) {
      return {
        text: `这一步清单上已经有了（第 ${_dup.step.id} 步：${String(_dup.step.text).slice(0, 40)}`
          + `），没重复加。\n要改状态就用 update（stepId:"${_dup.step.id}"），别用 add 再记一遍。\n`
          + formatPlan(state),
        state,
      };
    }
    // 【2026-11-15 根治】id 取「现有最大 id + 1」。老写法 length+1 在归档摘走中间几条后会撞上已有 id，
    // 一撞 update 就 find 到错的那一步。
    state.steps.push({ id: nextStepId(state), text, status: 'pending', note: '', pinned: !!args.pin });
    savePlan(key, state);
    return { text: `加了一步：\n${formatPlan(state)}`, state };
  }

  if (action === 'clear' || action === 'reset') {
    /**
     * 【2026-11-12 修·主人问「有没有拦住 AI 删已完成清单」】
     *
     * 原来只有「钉死的」活下来，**已完成的照样被一次 clear 带走** ——
     * 而主人定的规矩是「清单内容只可增加，无论是否做完，全部保留，严禁删除、严禁覆盖」。
     * 所以：默认把 done 也一起留在清单上（只清 pending / doing / skipped 那些还没落地的）。
     * 真要全清得显式传 force:true —— 目前没有任何界面路径会传，
     * 等于把「AI 一把梭清空清单」这个口子焊死。
     */
    const force = args.force === true;
    if (state.steps.length) archivePlan(key, state, 'clear');
    const keep = force
      ? pinnedSteps(state)
      : (state.steps || []).filter((st) => st && (st.pinned || st.status === 'done'));
    const next = emptyState();
    if (keep.length) {
      next.goal = state.goal;
      // 【2026-11-15 根治】留着的那几条沿用原 id，不重新编号，否则清空后打勾又错行
      next.steps = keep.map((st) => ({ ...st }));
    }
    savePlan(key, next);
    return {
      text: keep.length
        ? `清单清空了（旧的那份已归档）；钉死的 + 已完成的 ${keep.length} 条一条没删，还在清单上`
        : '清单清空了（旧的那份已归档，翻得到）',
      state: next,
    };
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
