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
 */
function memoryOff() {
  try {
    return getEnabledMap()['memory'] === false;
  } catch {
    return false; // 读不到开关就当开着（宁可多记，也不因为一个异常把记忆整个锁死）
  }
}

const OFF_HINT = '长期记忆现在是关着的，记忆本不读也不写。要记就先在顶部【功能】里把长期记忆打开。';

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
    keptFixed || '（还没记下固定事实）',
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
    keptArchive.join('\n'),
  ].join('\n').trim();

  let text = build();
  // 超长：先丢最旧的滚动条，再丢详细区，最后才动固定记忆
  while (keptRoll.length > 0 && text.length > maxChars) {
    keptRoll = keptRoll.slice(1);
    text = build();
  }
  while (keptDetail.length > 0 && text.length > maxChars) {
    keptDetail = keptDetail.slice(1);
    text = build();
  }
  if (text.length > maxChars) {
    keptArchive = [];
    keptFixed = `${keptFixed.slice(0, Math.max(0, maxChars - 320))}\n…（固定记忆太长，已截断）`;
    text = build();
  }

  return { text, keptRoll: keptRoll.length, totalRoll };
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
  const clean = String(text ?? '').trim();
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
  writeFileSync(activeFile(), renderMemory({ fixed: nextFixed, roll, detail, archive }), 'utf8');
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
   * 【关着就一个字都不给，连路径也不给】—— 2026-10-28
   *
   * agent.mjs 那边判过开关，但那只保住了「它自己那条路」。
   * 这个函数是公开的、谁都能调 —— 它自己不问，就等于漏。
   * 而且漏的不是内容，是**路径**：本子空的时候这段照样把
   *   【我的记忆本】文件：C:\...\my-memory.md
   * 报出来，她顺着路自己 read_file 就把本子全拿到了。
   *
   * 关着的时候不是「藏起来」，是压根没有这回事 —— 返回空串，调用方拼不出东西。
   */
  if (memoryOff()) return '';
  const { text } = composeMemory();
  if (!text) {
    return [
      '【我的记忆本】',
      `文件：${activeFile()}`,
      '（现在还是空的。值得记的事，用 memory_add 写一句；主人说了「以后都」「永远」这种话，用 memory_pin 写进固定区。）',
    ].join('\n');
  }
  return [
    '【我的记忆本】（这不是这次对话的内容，是我自己攒下来的）',
    `文件：${activeFile()}`,
    '',
    text,
  ].join('\n');
}

/** 给界面/自检看的状态。 */
export function memoryInfo() {
  const { keptRoll, totalRoll } = composeMemory();
  return { path: activeFile(), keptRoll, totalRoll, limit: TURN_LIMIT, detailLimit: DETAIL_LIMIT };
}
