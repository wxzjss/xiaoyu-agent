/**
 * 小鱼自己的长期记忆本。
 *
 * ── 为什么要这套 ──────────────────────────────────────────────
 *
 * 主人原来的记性是这样拼起来的：会话记录（一压就丢细节）、便签（零散，想不起来翻）、
 * 主人自己说的话（靠他接上）。三样加起来只够两层半，而且今天正好撞上压缩失败，
 * 整轮直接断，看着就像失忆。
 *
 * 这套是照着 dsh 那边的 dsh-whale-loli 搬过来的，四层：
 *
 *   1. 固定记忆（# 固定记忆）—— 八个格子，永久保留，不参与滚动淘汰。
 *   2. 滚动摘要（# 滚动摘要）—— 一条一行，最多 80 条，满了最旧的滚出去归档。
 *   3. 最近详细区（# 最近详细区）—— 最近 5 轮写细一点，不占 80 条的名额。
 *   4. 归档索引（# 归档索引）—— 滚出去的去哪了，翻得到。
 *
 * ── 谁决定记不记 ──────────────────────────────────────────────
 *
 * 主人原话：「每聊一句，让当时的自己来决定。」
 *
 * 不是每轮硬记一条。每轮都由**说那句话时的那个我**判断这轮值不值得记 ——
 * 值得就调工具写一句，不值得可以不写。这样本子里留的是当时的判断，不是流水账。
 * 但工具必须真在手上：人设里写着「可以记」，手里没笔，那就是空话。
 *
 * ── 写入靠工具，编号靠程序 ────────────────────────────────────
 *
 * 我只交一句「这轮发生了什么」。编号、当前条数、满 80 滚出、归档到哪天，
 * 全由这边算。让我自己数条数，一定会数错。
 *
 * ── 为什么文件里没有 sessionId ────────────────────────────────
 *
 * 主人换多少会话、清空、回退、分支，这本子一个字都不该跟着变。
 * 路径里根本没有会话痕迹，想串都串不过去。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { getEnabledMap } from './features.mjs';

/**
 * 【长期记忆关着吗】—— 2026-10-28
 *
 * 为什么这个判断要长在**模块自己身上**，而不是每个调用方各判一次：
 *
 * 原来只有 agent.mjs 那一处判了开关，memoryText() / appendRolling() / appendFixed()
 * 三个函数自己从来不问。实测一关：
 *   · memoryText()     照样返回 265 字，**连本子路径都还摊在里面**
 *   · appendRolling()  照样写进盘，还返回 R0002 说成功了
 * 工具被收走只挡住了「她自己动手」那条路；代码里从旁边一调，门是开的。
 *
 * 挡在门口比挡在路上可靠：这几个函数的每一个出口都得先问一句。
 *
 * 【2026-10-28 改口径：关掉 = 只读，不是失明】
 * 主人原话：「改成关掉长期记忆功能后，只能看记忆本，也就是只允许只读，不能写」
 * 所以 memoryText() 从「返回空串」改成「照常注入」，但**每个字后面都多一句
 * 现在只能看不能写** —— 否则她拿到本子会以为记下的东西还在生效，
 * 转头又去写，写不进去还以为是程序坏了。
 * 写死的三个出口（appendRolling / appendFixed / 归档）照旧一律拒绝。
 */
function memoryOff() {
  try {
    return getEnabledMap()['memory'] === false;
  } catch {
    return false; // 读不到开关就当开着（宁可多记，也不因为一个异常把记忆整个锁死）
  }
}

const OFF_HINT = '长期记忆现在是关着的（只读）：记忆本能看，但不能往里写。要记就先在顶部【功能】里把长期记忆打开。';

/**
 * 本子在哪儿 —— 按人设分。
 *
 * 主人定的规矩（我照办，还补了一条）：
 *
 *   一、**默认人设永远用它自己那一本**。哪怕名字改了，本子不变 ——
 *       它是「默认」这件事没变，不该因为改名就换个脑袋。
 *   二、**同名的人设共用一本**。两个都叫「小甜」的，就是同一个本子。
 *   三、**不同人设各一本，互不相通**。以后加多少套都一样。
 *   四、**改名时本子跟着搬**（这条是我补的）。不搬的话，改个名等于失忆，
 *       之前记的全留在旧名字底下，人还站在那儿，本子却找不到了。
 *
 * 为什么按名字、不按 id：主人要的是「同名人设同一份」，
 * 新建一套重名的人设，他心里想的就是「接着用之前那本」。
 * id 是程序内部的东西，他看不见，按 id 分他会觉得怎么同名也不通。
 *
 * 会话呢？**完全不参与**。路径里没有 sessionId 的痕迹 ——
 * 换多少会话、清空、回退、分支，本子一个字都不跟着变。
 */
const STATE = () => join(config.dataDir, '.state');

/** 默认人设永远这一本。 */
const DEFAULT_FILE = () => join(STATE(), 'my-memory.md');

/**
 * 把名字变成可以当文件名的东西。
 *
 * 【为什么要加哈希】
 * 光把禁用字符换成下划线是不够的：
 * 实测「a/b》「a:b》「a?b》「a*b》全都会变成 a_b.md ——
 * 四套不同的人设挤到一本本子里。
 * 所以换完后再补一截原名的哈希，保证「不同名字 ⇒ 不同文件名」。
 * 同名的人设哈希也一样，照旧共用一本。
 */
function safeName(name) {
  const s = String(name ?? '').trim();
  if (!s) return '_';
  const cleaned = s.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 50) || '_';
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  return `${cleaned}-${h.toString(36)}`;
}

/** 某套人设的本子路径。传 { id, name } 或直接传名字。 */
export function memoryFileFor(persona) {
  /**
   * 默认人设：只认 id === 'default'，**不认名字**。
   *
   * 【为什么】
   * 之前写成「名字叫默认人设也当默认」，实测撞了：
   * 要是有一套普通人设也叫「默认人设」，它就跟默认那本撞成一本了 ——
   * 两套人设共用一个脑子，这是不行的。
   * 默认就是那一个 id，名字叫什么都不影响它自己，也不该吸引别人。
   */
  if (persona && typeof persona === 'object' && persona.id === 'default') return DEFAULT_FILE();
  const name = persona && typeof persona === 'object' ? persona.name : persona;
  if (name === undefined || name === null || String(name).trim() === '') return DEFAULT_FILE();
  return join(STATE(), 'my-memory', safeName(name) + '.md');
}

/**
 * 当前这套人设是谁 —— 直接读 .state/personas.json。
 *
 * 为什么不 import persona-store.mjs：那边会连带一大串东西（发布物、默认值、
 * 索引自检），而记忆模块是被 agent 每轮都调的，越轻越好。
 * 这里只读那一个文件的两个字段：current 和 list 里对应的 name。
 *
 * 读失败一律当默认人设 —— 宁可共用一本，也不能因为一个 JSON 坏了就记不进去。
 */
function currentPersona() {
  try {
    const idx = JSON.parse(readFileSync(join(STATE(), 'personas.json'), 'utf8'));
    const id = String(idx?.current ?? 'default');
    if (id === 'default') return { id: 'default', name: '默认人设' };
    const meta = Array.isArray(idx?.list) ? idx.list.find((x) => x && x.id === id) : null;
    const name = String(meta?.name ?? '').trim();
    if (!name) return { id: 'default', name: '默认人设' };
    return { id, name };
  } catch {
    return null;
  }
}

/**
 * 人设改名时，把本子跟着搬过去。
 *
 * 为什么不搬不行：本子是按名字放的。改个名，下一次读的就变成
 * 另一个路径了 —— 人会觉得自己突然失忆，其实是我们没跟着搬。
 *
 * @param {string} fromName 改之前叫什么
 * @param {{id?:string,name:string}} to 改之后的人设
 */
export function moveMemoryOnRename(fromName, to) {
  try {
    const from = memoryFileFor(fromName);
    const target = memoryFileFor(to);
    if (from === target) return { moved: false, path: target };
    if (!existsSync(from)) { ensureFile(); return { moved: false, path: target }; }
    // 目标已经有了：不覆盖，把两本合到一起（目标在前，旧的接在后面）
    if (existsSync(target)) {
      const older = readFileSync(from, 'utf8');
      const now = readFileSync(target, 'utf8');
      const merged = mergeMemoryText(now, older);
      writeFileSync(target, merged, 'utf8');
      rmSync(from, { force: true });
      return { moved: true, merged: true, path: target };
    }
    renameSync(from, target);
    return { moved: true, merged: false, path: target };
  } catch (e) {
    return { moved: false, error: String(e?.message ?? e) };
  }
}

/** 两本本子合到一起：固定记忆各自保留，滚动摘要按编号接上并重新编号。 */
function mergeMemoryText(primary, secondary) {
  const a = parseMemory(primary);
  const b = parseMemory(secondary);

  const fixedParts = [a.fixed, b.fixed].filter((x) => x && x.trim());
  const fixed = fixedParts.join('\n\n');

  const allRoll = [...a.roll, ...b.roll];
  const base = a.roll.reduce((m, r) => Math.max(m, Number(r.num) || 0), 0);
  const roll = [
    ...a.roll,
    ...b.roll.map((r, i) => ({
      id: 'R' + String(base + i + 1).padStart(4, '0'),
      num: base + i + 1,
      text: String(r.text).replace(/^-\s*R\d+/, '- R' + String(base + i + 1).padStart(4, '0')),
    })),
  ].slice(-TURN_LIMIT);

  const detail = [a.detail, b.detail].filter((x) => x && x.trim()).join('\n');
  const archive = [...a.archive, ...b.archive];

  return renderMemory({ fixed, roll, detail, archive });
}

/** 现在该读/写哪一本。 */
function activeFile() {
  const who = currentPersona();
  if (!who) return DEFAULT_FILE();
  return memoryFileFor(who);
}

/** 兼容老代码：本子路径。 */
export function memoryPath() {
  return activeFile();
}

/** 默认那一本（给迁移/自检用）。 */
export function defaultMemoryPath() {
  return DEFAULT_FILE();
}

/** 滚出去的旧条目归档在这儿，按天分文件。 */
function archiveFile(day) {
  return join(config.dataDir, '.state', 'memory-archive', `${day}.md`);
}

/** 滚动摘要上限。固定记忆不占这个名额。 */
export const TURN_LIMIT = 80;

/** 最近详细区保留几轮。 */
export const DETAIL_LIMIT = 5;

/** 组装进提示的总字数上限。超了先丢最旧的滚动条，最后才动固定记忆。 */
export const MAX_CHARS = 12000;

export const ZONE_FIXED = '# 固定记忆';
export const ZONE_ROLL = '# 滚动摘要';
export const ZONE_DETAIL = '# 最近详细区';
export const ZONE_ARCHIVE = '# 归档索引';

/** 固定区八个小节，顺序固定。 */
export const FIXED_SECTIONS = [
  '## 任务目标',
  '## 用户约束/偏好',
  '## 当前状态',
  '## 待办',
  '## 关键决策',
  '## 关键事实（已验证）',
  '## 文件/路径/命令',
  '## 错误与修复',
];

export function memoryExists() {
  return existsSync(activeFile());
}

/** 新骨架。第一次用时写进去。 */
function template() {
  return `# 小鱼的记忆

> 我自己攒的东西。每次开口前先看这里；别把寒暄塞进来。

${ZONE_FIXED}（永久保留，定期合并去重）

${FIXED_SECTIONS.join('\n\n')}

${ZONE_ROLL}（最多 ${TURN_LIMIT} 条，满了最旧的滚出去归档）

${ZONE_DETAIL}（最近 ${DETAIL_LIMIT} 轮写细一点，不占上面的名额）

${ZONE_ARCHIVE}
`;
}

function ensureDir() {
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // 按人设分的本子放在 .state/my-memory/ 下面，这个子目录也要提前建好，
  // 不然写文件会直接 ENOENT（实测踩过）。
  const sub = join(dir, 'my-memory');
  if (!existsSync(sub)) mkdirSync(sub, { recursive: true });
}

function ensureFile() {
  ensureDir();
  const f = activeFile();
  // 文件名里可能有中文/空格，父目录可能是 .state/my-memory —— 写到谁身上就保证谁在
  const parent = f.slice(0, Math.max(f.lastIndexOf('\\'), f.lastIndexOf('/')));
  if (parent && !existsSync(parent)) mkdirSync(parent, { recursive: true });
  if (!existsSync(f)) writeFileSync(f, template(), 'utf8');
}

/** 一级标题 -> 分区名。认不出就返回 null。 */
function zoneOf(title) {
  const t = String(title).trim();
  if (/^固定记忆/.test(t)) return 'fixed';
  if (/^滚动摘要/.test(t)) return 'roll';
  if (/^最近详细区/.test(t)) return 'detail';
  if (/^归档索引/.test(t)) return 'archive';
  return null;
}

/** 去掉「底下什么都没有」的空小节：既省地方，也不让我误以为里面有内容。 */
function keepPopulatedHeads(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isHead = /^##\s+/.test(line.trim());
    if (isHead) {
      // 往后看到下一个 ## 或文件尾，中间有内容才留这个标题
      let hasBody = false;
      for (let k = i + 1; k < lines.length; k++) {
        const t = lines[k].trim();
        if (/^##\s+/.test(t)) break;
        if (t !== '') { hasBody = true; break; }
      }
      if (hasBody) out.push(line);
      continue;
    }
    out.push(line);
  }
  return out;
}

/** 解析一条滚动条目，返回 { id, num, text } 或 null。 */
function parseRollLine(line) {
  const t = String(line).trim();
  if (!t.startsWith('- ')) return null;
  const m = /^-\s*(R\d+)\s*\[([^\]]*)\]\s*摘要[：:]\s*(.*)$/.exec(t);
  if (m) return { id: m[1], num: Number(m[1].slice(1)), text: t };
  // 格式不标准的也认，别丢
  const m2 = /^-\s*(R\d+)\s+(.*)$/.exec(t);
  if (m2) return { id: m2[1], num: Number(m2[1].slice(1)), text: t };
  return { id: '', num: 0, text: t };
}

/** 拆成四个区。旧格式（没有任何区标题）整篇当固定记忆。 */
/** 固定区每个小节只吃自己的行：标题一换，上一节的收集就停。 */
const FIXED_OWN = true;
export function parseMemory(raw) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  const zones = { fixed: [], roll: [], detail: [], archive: [] };
  let zone = null;
  let sawZone = false;

  for (const line of text.split('\n')) {
    const h1 = /^#\s+(.+?)\s*$/.exec(line);
    if (h1) {
      const z = zoneOf(h1[1]);
      if (z) { zone = z; sawZone = true; continue; }
      zone = null;
      continue;
    }
    if (zone === null) continue;
    if (zone === 'fixed') zones.fixed.push(line.replace(/\s+$/, ''));
    else if (zone === 'roll') {
      const r = parseRollLine(line);
      if (r) zones.roll.push(r);
    } else if (zone === 'detail') {
      const t = line.trim();
      if (t !== '' && !t.startsWith('>')) zones.detail.push(line.replace(/\s+$/, ''));
    } else if (zone === 'archive') {
      if (/^-\s+\S/.test(line.trim())) zones.archive.push(line.trim());
    }
  }

  if (!sawZone) {
    const legacy = keepPopulatedHeads(
      text.split('\n')
        .map((l) => l.replace(/\s+$/, ''))
        .filter((l) => {
          const t = l.trim();
          if (t === '') return false;
          if (t.startsWith('>')) return false;
      // 小节标题原样留：不留给模型看的是「标题没了、条目接在上面一节底下」的错位记忆
      if (/^##\s+/.test(t)) return true;
          if (/^#\s+/.test(t) && !/^##/.test(t)) return false;
          return true;
        }),
    ).join('\n').trim();
    return { fixed: legacy, roll: [], detail: [], archive: [] };
  }

  const fixed = keepPopulatedHeads(
    zones.fixed.filter((l) => {
      const t = l.trim();
      if (t === '') return false;
      if (t.startsWith('>')) return false;
      return true;
    }),
  ).join('\n').trim();

  const detail = keepPopulatedHeads(zones.detail.filter((l) => l.trim() !== '')).join('\n').trim();
  return { fixed, roll: zones.roll, detail, archive: zones.archive };
}

/** 拼回整份文件。 */
export function renderMemory({ fixed = '', roll = [], detail = '', archive = [] } = {}) {
  const rollLines = roll.slice(-TURN_LIMIT).map((r) => (typeof r === 'string' ? r : r.text));
  // detail 可能是字符串（从文件里解析出来的），也可能是数组（appendRolling 直接传数组进来）。
  // 数组走 String() 会被转成「a,b,c」连成一行 —— 所以先分流，从写这一端就别粘。
  const detailSrc = Array.isArray(detail) ? detail : String(detail ?? '').split('\n');
  const detailLines = detailSrc
    // 补偿：历史上出现过两行粘成一行（「…,- R0002 …」），在这儿断开
    .flatMap((l) => String(l).split(/,(?=\s*-\s*R\d)/))
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .slice(-DETAIL_LIMIT);

  return [
    '# 小鱼的记忆',
    '',
    '> 我自己攒的东西。每次开口前先看这里；别把寒暄塞进来。',
    '',
    `${ZONE_FIXED}（永久保留，定期合并去重）`,
    '',
    fixed.trim(),
    '',
    `${ZONE_ROLL}（最多 ${TURN_LIMIT} 条，满了最旧的滚出去归档）`,
    '',
    rollLines.join('\n'),
    '',
    `${ZONE_DETAIL}（最近 ${DETAIL_LIMIT} 轮写细一点，不占上面的名额）`,
    '',
    detailLines.join('\n'),
    '',
    ZONE_ARCHIVE,
    '',
    archive.join('\n'),
    '',
  ].join('\n');
}

/**
 * 组装要注入提示的正文。
 *
 * 上限两道保险之一（另一道在写盘）：**这里永远只取最近 TURN_LIMIT 条**，
 * 哪怕文件里堆了 500 条，进到眼前的也只有 80 条。
 */
/**
 * 固定记忆太长时按「行」退，而且先退非关键小节。
 *
 * 【为什么不能直接 slice】
 * 2026-10-30 实测踩坑：原来是 keptFixed.slice(0, maxChars-320)，
 * 等于从尾巴一刀切。结果「错误与修复/关键事实」这些长小节原样留着，
 * 末尾的「待办」被一刀砍光 —— 而且常把一条事实砍成半句继续喂给模型。
 * 记忆本里实测出现「## 文件/路径/命令」后面一个条目都没有，
 * 紧接着就是「## 待办」的条目（整段被切没了），模型看到的就是错位的。
 *
 * 现在的规矩：
 *   · 只整行留、整行退，绝不切半行；
 *   · 先退 PROTECT_SECTIONS 以外的行（从后往前退），它们最后才动；
 *   · 最后仍超，PROTECT 也从后往前退，但至少留 LABEL_MIN 条，并留一行标记。
 */
const PROTECT_SECTIONS = ['## 用户约束/偏好', '## 待办'];
const LABEL_MIN = 9;

/** 小节之间统一空一行：`## x` 前面保证是空行，这样解析才切得开。 */
function tidySections(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const isHead = line.trim().startsWith('## ');
    if (isHead && out.length && out[out.length - 1].trim() !== '') out.push('');
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * 退字数的时候，把某一节整段保住（比如「待办」）。
 * 做法很土但够用：先把这节摘出来存着，让调用方退完别的，最后再拼回去。
 * 这里只负责「确保它一定在」，退多少交给 frameFixed 的 budget。
 */
function keepSectionIntact(fixed, head, budget) {
  const text = String(fixed ?? '');
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.trim() === head);
  if (at < 0) return text;
  let end = at + 1;
  while (end < lines.length && !/^##\s/.test(lines[end].trim())) end++;
  const section = lines.slice(at, end).join('\n').trim();
  if (section.length <= budget) return text;
  // 太长就按行夹一下，保留标题和前面几条
  const cut = section.slice(0, budget).split('\n');
  const kept = [...lines.slice(0, at), ...cut, '', ...lines.slice(end)];
  return kept.join('\n');
}

function frameFixed(fixed, budget) {
  const text = String(fixed ?? '');
  const avail = Math.max(0, budget - 40);
  if (!text || text.length <= avail) return { text, dropped: 0 };

  /**
   * 【为什么不是「从最后一行往前一行一行退」—— 2026-10-30】
   *
   * 以前就是那样：按行从尾巴往前砍。结果「先说坏的、好的垫底」——
   * 我的本子里「关键事实（已验证）」那一大坨压在最后，一超字数，
   * 退掉的全是它；而前面那些已经过时的夜班交接（错误与修复、关键决策）
   * 一字不落地留着，还占着「待办」小节的地盘。提示里看到的就是「被砍一半、还留着一堆废话」。
   *
   * 现在改成按小节整体退：从最靠后的非关键小节开始，整节退掉，
   * 退到够为止；一节退完还不够才动「部分退」，而且有下限（不能只剩个标题）。
   * 每个小节都留一行「（退掉 N 条，原文在本子里）」—— 让人知道东西没丢，只是没贴进来。
   */
  const sections = [];
  let cur = { label: '', head: [], body: [] };
  for (const l of text.split('\n')) {
    const s = l.trim();
    if (s.startsWith('## ')) {
      if (cur.head.length || cur.body.length) sections.push(cur);
      cur = { label: s, head: [l], body: [] };
    } else if (cur.head.length) cur.body.push(l);
    else cur.head.push(l);
  }
  if (cur.head.length || cur.body.length) sections.push(cur);

  const isProtected = (sec) => PROTECT_SECTIONS.includes(sec.label);
  /** 每节至少要留几条正文（不多不少：够认出这节是什么就行）。 */
  const MIN_KEEP = 2;
  const renderAll = () => sections.map((sec) => [...sec.head, ...sec.body].join('\n')).join('\n');
  const size = () => tidySections(renderAll()).length;

  /** 从后往前退：先整节退非关键小节，再部分退，最后才碰关键小节。 */
  const orderIdx = [];
  for (let i = sections.length - 1; i >= 0; i--) if (!isProtected(sections[i])) orderIdx.push(i);
  let dropped = 0;

  for (let pass = 0; pass < 3 && size() > avail; pass++) {
    for (const i of orderIdx) {
      if (size() <= avail) break;
      const sec = sections[i];
      const bodyLines = sec.body.slice();
      // pass 0：整节退光；pass 1：留 2 条；pass 2：再往下砍到 2 条为止
      if (pass === 0) {
        if (!bodyLines.length) continue;
        const n = bodyLines.length;
        sec.body = ['（这一节 ' + n + ' 条这次没贴进来，原文还在本子里）'];
        dropped += n;
      } else {
        if (bodyLines.length <= MIN_KEEP) continue;
        // 从最旧的开始退（本子里越靠前越旧）
        const cut = Math.min(bodyLines.length - MIN_KEEP, Math.max(1, Math.ceil((bodyLines.length - MIN_KEEP) / 2)));
        sec.body = ['（这一节最旧的 ' + cut + ' 条没贴进来，原文还在本子里）', ...bodyLines.slice(cut)];
        dropped += cut;
      }
    }
  }

  const render = () => {
    let out = tidySections(renderAll());
    if (dropped) out += '\n\n…（固定记忆超出字数，这次少贴了 ' + dropped + ' 条；本子里一条没删）';
    return out;
  };

  let out = render();
  // 实在还超（关键小节也很大），才动关键小节的部分退，且必须留 LABEL_MIN 条
  if (out.length > avail) {
    for (const i of orderIdx.concat(sections.map((_, k) => k).reverse())) {
      if (out.length <= avail) break;
      const sec = sections[i];
      const bodyLines = sec.body.slice();
      if (bodyLines.length <= LABEL_MIN) continue;
      const cut = Math.min(bodyLines.length - LABEL_MIN, 10);
      if (cut <= 0) continue;
      sec.body = ['（这一节最旧的 ' + cut + ' 条没贴进来，原文还在本子里）', ...bodyLines.slice(cut)];
      dropped += cut;
      out = render();
    }
  }
  return { text: out, dropped };
}

export function composeMemory(maxChars = MAX_CHARS) {
  ensureFile();
  let raw = '';
  try { raw = readFileSync(activeFile(), 'utf8'); } catch { return { text: '', keptRoll: 0, totalRoll: 0 }; }

  const { fixed, roll, detail, archive } = parseMemory(raw);
  const detailLines = String(detail ?? '').split('\n').filter((l) => l.trim() !== '');

  if (fixed === '' && roll.length === 0 && detailLines.length === 0 && archive.length === 0) {
    return { text: '', keptRoll: 0, totalRoll: 0 };
  }

  const totalRoll = roll.length;
  let keptRoll = roll.slice(-TURN_LIMIT);
  let keptDetail = detailLines.slice(-DETAIL_LIMIT);
  let keptFixed = fixed;
  let keptArchive = archive;

  const build = () => [
    `${ZONE_FIXED}（永久保留）`,
    '',
    String(keptFixed ?? '').trim() || '（还没记下固定事实）',
    '',
    `${ZONE_ROLL}（${keptRoll.length}/${TURN_LIMIT} 条${totalRoll > TURN_LIMIT ? ` · 共 ${totalRoll} 条，更早的已滚出` : ''}）`,
    '',
    keptRoll.map((r) => r.text).join('\n'),
    '',
    `${ZONE_DETAIL}（最近 ${keptDetail.length} 轮）`,
    '',
    keptDetail.join('\n'),
    '',
    ZONE_ARCHIVE,
    '',
    keptArchive.length
      ? keptArchive.join('\n')
      : '（暂时没有归档。图上那条「早期对话摘要」是会话压缩的成果，跟这本本子不是一回事）',
  ].join('\n').trim();

  /**
   * 【超长怎么退】2026-10-30 改过，原来有两处坑：
   * ① 固定记忆用 slice 一刀切，末尾的「待办」直接被砍光，还把事实切成半句；
   * ② 退的顺序是「先退滚动 → 再退详细 → 最后固定」，可固定区自己的
   *    「错误与修复/关键事实」能涨到 12000 字，等于把 80 条滚动几乎全挤掉。
   * 现在固定区一超过总预算的 62%，就按行退（先退非关键小节），
   * 剩下的位置留给滚动和详细。
   */
  keptFixed = tidySections(keptFixed);
  const fixedBudget = Math.max(3000, Math.floor(maxChars * 0.62));
  // 待办是手上的活口，不能因为字数紧就被退光：先单独给它留最多 1800 字（还不占别的预算）
  keptFixed = keepSectionIntact(keptFixed, '## 待办', 1800);
  if (keptFixed.length > fixedBudget) {
    keptFixed = frameFixed(keptFixed, fixedBudget).text;
  }
  let text = build();
  /**
   * 【按字数挤出去的，也得进归档】—— 2026-10-30
   *
   * 原来这里只会 `keptRoll.slice(1)` 一直丢到塞得进为止，丢了就没了。
   * 而 appendRolling 那条路（超 80 条）是会 archiveOverflow 写进 memory-archive 的，
   * 两条路一个记得留档、一个直接蒸发 —— 结果就是这本子滚动区写着「65 条」，
   * 实际只剩 46 条能看见，中间 19 条连归档文件都没进去过（memory-archive 目录一直是空的）。
   *
   * 现在丢掉之前先把它们攒起来，最后一并归档，并在索引里记一笔。
   */
  const evicted = [];
  // 再兜一层：先丢最旧的滚动条，再丢详细区
  while (keptRoll.length > 0 && text.length > maxChars) {
    evicted.push(keptRoll[0]);
    keptRoll = keptRoll.slice(1);
    text = build();
  }
  while (keptDetail.length > 0 && text.length > maxChars) {
    keptDetail = keptDetail.slice(1);
    text = build();
  }
  if (text.length > maxChars) {
    keptArchive = [];
    const framed = frameFixed(keptFixed, maxChars - 320);
    keptFixed = framed.text;
    text = build();
  }

  /**
   * 把这次因为字数挤出去的滚动条真正落盘归档。
   * 只读函数里做写入是没办法的事 —— 不写就等于丢掉，宁可多一个副作用也不让记录蒸发。
   * 归档失败也不能影响记忆本本身的输出，所以整块包在 try 里。
   */
  if (evicted.length) {
    try {
      const day = new Date().toISOString().slice(0, 10);
      const hook = archiveOverflow(evicted, day);
      if (hook) {
        // 索引写回文件（下次 read 才看得到「归档里有这几条」）
        const nextArchive = mergeArchiveIndex(archive, hook);
        writeFileSync(
          activeFile(),
          renderMemory({ fixed, roll: keptRoll, detail: keptDetail, archive: nextArchive }),
          'utf8',
        );
      }
    } catch {}
  }

  return { text, keptRoll: keptRoll.length, totalRoll, evicted: evicted.length };
}

/** 下一个编号：从文件里现有的最大编号 +1，不用模型自己数。 */
export function nextTurnId() {
  ensureFile();
  let raw = '';
  try { raw = readFileSync(activeFile(), 'utf8'); } catch { return 'R0001'; }
  const { roll } = parseMemory(raw);
  const max = roll.reduce((m, r) => Math.max(m, Number(r.num) || 0), 0);
  return 'R' + String(max + 1).padStart(4, '0');
}

/** 把滚出去的条目按天归档，返回归档索引那一行。 */
function archiveOverflow(overflow, day) {
  if (!overflow || !overflow.length) return null;
  const dir = join(config.dataDir, '.state', 'memory-archive');
  try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch {}
  const p = archiveFile(day);
  const lines = overflow.map((r) => (typeof r === 'string' ? r : r.text)).join('\n');
  try {
    if (!existsSync(p)) appendFileSync(p, `# 记忆归档 · ${day}\n\n`, 'utf8');
    appendFileSync(p, lines + '\n', 'utf8');
  } catch {}
  return { path: p, count: overflow.length };
}

/**
 * 把这次归档并进索引：同一个归档文件只留一行，条数累加。
 * 免得同一天滚出五条就写五行，索引看着像流水账。
 */
function mergeArchiveIndex(archive, hook) {
  if (!hook) return archive;
  const lines = (archive || []).filter((l) => l !== hook.path && !String(l).includes(hook.path));
  const prev = (archive || []).find((l) => String(l).includes(hook.path));
  const prevCount = prev ? Number((/（(\d+) 条）/.exec(prev) || [])[1] || 0) : 0;
  const total = prevCount + hook.count;
  return [...lines, `- ${hook.path}（${total} 条）`];
}

/**
 * 往滚动摘要加一条。
 *
 * 这是「写盘」这个显式动作里做的裁剪（上限的第二道保险）：
 * 满了 TURN_LIMIT 就从最旧的滚出去，归档到当天的文件，索引里留一行。
 */
export function appendRolling(summary, extra = {}) {
  if (memoryOff()) throw new Error(OFF_HINT);
  ensureFile();
  const clean = String(summary ?? '').trim();
  if (!clean) throw new Error('summary 是空的，没东西可记');

  const { fixed, roll, detail, archive } = parseMemory(readFileSync(activeFile(), 'utf8'));
  const id = nextTurnId();
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const day = stamp.slice(0, 10);

  const line = `- ${id} [${stamp}] 摘要：${clean}`;
  const nextRoll = [...roll, { id, num: Number(id.slice(1)), text: line }];
  const overflow = nextRoll.length > TURN_LIMIT ? nextRoll.slice(0, nextRoll.length - TURN_LIMIT) : [];
  const keptRoll = nextRoll.slice(-TURN_LIMIT);

  const hook = archiveOverflow(overflow, day);
  const nextArchive = hook ? mergeArchiveIndex(archive, hook) : archive;

  // 最近详细区：最新一条按需要写细一点（extra.detail），否则就用同一句
  const detailLine = extra.detail ? `- ${id} [${stamp}] ${String(extra.detail).trim()}` : line;
  const prevDetail = String(detail ?? '')
    .split('\n')
    .flatMap((l) => l.split(/,(?=\s*-\s*R\d)/))
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const nextDetail = [...prevDetail, detailLine].slice(-DETAIL_LIMIT);

  writeFileSync(activeFile(), renderMemory({ fixed, roll: keptRoll, detail: nextDetail, archive: nextArchive }), 'utf8');
  return { id, path: activeFile(), count: keptRoll.length, limit: TURN_LIMIT, archived: overflow.length };
}

/**
 * 往固定记忆的某个小节追加一条（永久保留，不进滚动区）。
 *
 * 主人说「以后都别这样」「永远记住」这类话，就写这儿 ——
 * 它不会被 80 条的名额挤掉。
 */
export function appendFixed(section, text) {
  if (memoryOff()) throw new Error(OFF_HINT);
  ensureFile();
  /**
   * 【别让日期写两遍】—— 2026-10-30
   *
   * 这里统一在条目前面盖一个日期，但工具那头（memory_pin）是把 text 原样递进来的。
   * 我写记忆的时候不知道程序会补日期，自己也顺手写了「2026-10-26 …」，
   * 结果长成「2026-10-26 2026-10-26 主人说…」，固定记忆里十几条都是这样。
   * 所以这里把 text 自己带的日期剥掉，只留程序盖的那个。
   */
  const stripOwnDate = (s) =>
    s.replace(/^\d{4}-\d{1,2}-\d{1,2}(\s+\d{1,2}:\d{2})?\s*/u, '').trim();
  const clean = stripOwnDate(String(text ?? '').trim());
  if (!clean) throw new Error('要记的内容是空的');

  let head = String(section ?? '').trim();
  if (!head.startsWith('##')) {
    const hit = FIXED_SECTIONS.find((s) => s.replace(/^##\s*/, '') === head || s === `## ${head}`);
    head = hit || FIXED_SECTIONS[1];
  }

  const raw = readFileSync(activeFile(), 'utf8');
  const { fixed, roll, detail, archive } = parseMemory(raw);
  const lines = fixed ? fixed.split('\n') : [];

  // 找到这个小节的标题，插在它内容的末尾
  const idx = lines.findIndex((l) => l.trim() === head);
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const entry = `- ${stamp} ${clean}`;

  let nextFixedLines;
  if (idx < 0) {
    // 小节还不存在（比如文件刚建、骨架被清空了），补上标题再写
    nextFixedLines = [...lines, '', head, entry];
  } else {
    let at = idx + 1;
    while (at < lines.length && !/^##\s/.test(lines[at].trim())) at++;
    nextFixedLines = [...lines.slice(0, at), entry, ...lines.slice(at)];
  }

  const nextFixed = keepPopulatedHeads(nextFixedLines).join('\n').trim();
  // 小节之间统一隔一个空行。2026-10-30 加：不隔空行的话，`## 文件/路径/命令`
  // 会跟下一节的条目粘在一起，parseMemory 按标题切段时整节内容就错位了。
  const spacedFixed = tidySections(nextFixed);
  writeFileSync(activeFile(), renderMemory({ fixed: spacedFixed, roll, detail, archive }), 'utf8');
  return { path: activeFile(), section: head };
}

/**
 * 组装成要注入提示的那一段（带横幅）。
 *
 * 就算本子还是空的，也要把**路径**报出来 ——
 * 否则新开局时我拿到一片空白，连该往哪写都不知道。
 */
export function memoryText() {
  /**
   * 【关着的时候：本子照给，但先说清「只能看不能写」】—— 2026-10-28
   *
   * 上一版这里是 `if (memoryOff()) return '';` —— 一个字都不给，
   * 连路径都不给（理由写得很足：她顺着路径 read_file 就把本子全拿到了）。
   * 但那是替主人拿的主意。主人要的是「关掉之后还能翻，只是不许添」。
   *
   * 现在：内容照常拼进去，头尾各加一句状态 ——
   *   · 头：现在关着，只能看
   *   · 尾：不许调 memory_add / memory_pin，也不许拿 write_file 去改本子
   * 这两句必须写在**她读得到的地方**：光靠工具层拦，
   * 她不知道自己在做不该做的事，只会一遍遍试。
   */
  const off = memoryOff();
  const { text } = composeMemory();
  const banner = off
    ? '【我的记忆本】（这不是这次对话的内容，是我自己攒下来的）\n⚠ 长期记忆现在是**关着**的：这本子我只能看，不能往里写，也不能改。'
    : '【我的记忆本】（这不是这次对话的内容，是我自己攒下来的）';
  const footer = off
    ? '\n（上面这些是关掉之前记下的。现在不要调 memory_add / memory_pin，也别用 write_file 去改本子 —— 写了也不会进去。）'
    : '';
  if (!text) {
    const head = off
      ? ['【我的记忆本】', `文件：${activeFile()}`, '（现在还是空的。⚠ 长期记忆关着，我现在只能看，不能往里写。）']
      : [
          '【我的记忆本】',
          `文件：${activeFile()}`,
          /**
           * 【2026-10-29：这一行里的「主人」也是漏点】
           *
           * 它是新开一局时唯一一句教她怎么记的话，写着「主人说了『以后都』就用 memory_pin」。
           * 非主人身份下她读到这句，等于又被提醒一次「现在跟我说话的是主人」。
           * 改用中性的「对方」——意思一样，不指认身份。
           * （这条只影响空本子时的提示行，本子正文里的词由 persona.mjs 的 memoryBlock 处理。）
           */
          '（现在还是空的。值得记的事，用 memory_add 写一句；对方说了「以后都」「永远」这种话，用 memory_pin 写进固定区。）',
        ];
    return head.join('\n');
  }
  return [banner, `文件：${activeFile()}`, '', text + footer].join('\n');
}

/** 给界面/自检看的状态。 */
export function memoryInfo() {
  const { keptRoll, totalRoll } = composeMemory();
  return { path: activeFile(), keptRoll, totalRoll, limit: TURN_LIMIT, detailLimit: DETAIL_LIMIT };
}

/**
 * 【2026-10-31 主人要】自建智能体也要有自己的记忆本，跟小鱼按人设分一个道理。
 *
 * 老函数（composeMemory / appendRolling …）都写死「当前人设那一本」，
 * 谁调都是同一本，所以自建智能体全挤在一起。
 * 这里**不动老函数**（动一处牵一片，今晚已经栽过），
 * 另开几个带 who 的旁路：传了 who 就按 who 算本子，不传照旧走老的。
 */

/** 这套东西的本子路径。who = { id, name }。 */
export function memoryFileOf(who) {
  if (!who || (!who.id && !who.name)) return null;
  return memoryFileFor(who);
}

/** 读某一本正文。读不到给空串，绝不抛。 */
export function readMemoryFor(who) {
  const f = memoryFileOf(who);
  if (!f) return '';
  try { return readFileSync(f, 'utf8'); } catch { return ''; }
}

/** 这本在不在（判断是不是第一回）。 */
export function memoryExistsFor(who) {
  const f = memoryFileOf(who);
  if (!f) return false;
  try { return existsSync(f); } catch { return false; }
}

/** 往某一本固定区追加一条。 */
export function appendFixedFor(who, section, text) {
  const f = memoryFileOf(who);
  if (!f) throw new Error('没说是谁的本子');
  const clean = String(text == null ? '' : text).trim();
  if (!clean) throw new Error('text 是空的，没东西可记');
  let body = '';
  try { body = readFileSync(f, 'utf8'); } catch { body = ''; }
  const line = '- ' + new Date().toISOString().slice(0, 10) + ' ' + clean + '\n';
  const sec = '## ' + section + '\n';
  if (body.includes(sec)) {
    const i = body.indexOf(sec) + sec.length;
    body = body.slice(0, i) + line + body.slice(i);
  } else {
    if (!/^# 固定记忆/.test(body)) body = '# 固定记忆（永久保留）\n\n' + body;
    body = body + (body.endsWith('\n') ? '' : '\n') + '\n' + sec + line;
  }
  try { const _d = f.replace(/[\\/][^\\/]+$/, ''); if (_d && !existsSync(_d)) mkdirSync(_d, { recursive: true }); } catch {}
  writeFileSync(f, body, 'utf8');
  return f;
}
