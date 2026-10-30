// 会话记忆文件：每个会话一份自己的本子。
//
// 放哪：.state/memory/<会话id>.md（跟 .state/sessions/<会话id>.json 挨着，一眼对得上）
// 谁看：只有我们这边看得见 —— 它不在会话消息里，界面不会画，导出也不会带上。
//       每轮现拼进系统提示，我一开口就已经知道本子里写的东西。
// 跟人设什么关系：人设是「我是谁、怎么说话」（设置里选那套，全体共用）；
//       这个本子是「这一段对话里发生过什么、主人交代了什么」（一个会话一份）。
//       两者互不覆盖，拼进系统提示时各占一段。
//
// 为什么不用「贴一条前情消息」的做法：那样模型读到的是「别人给我的资料」；
// 写成记忆本子再拼进系统提示，才是「我知道这件事」。主人要的是后者。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, copyFileSync, unlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = () => join(config.dataDir, '.state', 'memory');
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** 滚动摘要上限。超了就把最旧的挪进归档区，不丢，只是不在正文里堆着。 */
export const DIGEST_LIMIT = 80;

/** 记忆本子的骨架。新建会话就是这一份，固定记忆区先留好空小节。 */
export const SKELETON = `# 会话记忆

## 固定记忆

### 任务目标
（这个会话要做什么）

### 用户约束/偏好

### 当前状态

### 待办

## 滚动摘要
`;

const isId = (id) => typeof id === 'string' && ID_RE.test(id);

function ensureDir() {
  const dir = DIR();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 某个会话的记忆文件路径。id 不合法直接抛，别让它拼出越界路径。 */
export function memoryPath(id) {
  if (!isId(id)) {
    const e = new Error('会话 id 不合法：' + id);
    e.status = 400;
    throw e;
  }
  return join(DIR(), `${id}.md`);
}

export function memoryExists(id) {
  if (!isId(id)) return false;
  return existsSync(join(DIR(), `${id}.md`));
}

/** 读正文。没建过返回 null（跟「建了但是空的」区分开）。 */
export function readMemory(id) {
  if (!isId(id)) return null;
  const file = join(DIR(), `${id}.md`);
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 写正文（整份覆盖）。force=false 时已存在就不动。 */
export function writeMemory(id, text, { force = true } = {}) {
  if (!isId(id)) {
    const e = new Error('会话 id 不合法：' + id);
    e.status = 400;
    throw e;
  }
  ensureDir();
  const file = join(DIR(), `${id}.md`);
  if (!force && existsSync(file)) return false;
  writeFileSync(file, String(text ?? ''), 'utf8');
  return true;
}

/**
 * 回退专用：把本子退回成某一轮的快照（传 null = 当时还没有本子，那就删掉）。
 *
 * 为什么不复用 writeMemory：回退还可能要把「本来没有、后来才建出来」的本子删掉，
 * 而且删之前得留一份，别让主人回退一次把记忆弄丢。
 * @returns {{restored: boolean, removed: boolean, backup: string|null}}
 */
export function snapMemory(id, text) {
  if (!isId(id)) return { restored: false, removed: false, backup: null };
  const file = join(DIR(), `${id}.md`);
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : null;
  let backup = null;
  if (cur !== null && cur !== text) {
    ensureDir();
    try {
      const p = join(DIR(), `rewind-${id}-${Date.now()}.md`);
      writeFileSync(p, cur, 'utf8');
      backup = p;
    } catch {
      backup = null;
    }
  }
  if (text === null || text === undefined) {
    if (cur !== null) {
      try {
        rmSync(file, { force: true });
      } catch {}
      return { restored: false, removed: true, backup };
    }
    return { restored: false, removed: false, backup };
  }
  if (cur === text) return { restored: false, removed: false, backup };
  writeMemory(id, text);
  return { restored: true, removed: false, backup };
}

/**
 * 确保这个会话有记忆本子，顺便返回正文。
 * 新建会话、分支复制、旧会话第一次开口，都走这里 —— 一处逻辑，不会有的建有的不建。
 * @param {string} id
 * @param {string} [seed] 初始正文；不给就用骨架
 */
export function ensureMemory(id, seed) {
  const cur = readMemory(id);
  if (cur !== null) return cur;
  const text = typeof seed === 'string' && seed.trim() ? seed : SKELETON;
  writeMemory(id, text, { force: false });
  return text;
}

/** 分支/交接：把原会话的本子抄一份给新会话。不想继承就传 withMemory=false。 */
export function copyMemory(fromId, toId) {  const src = readMemory(fromId);
  if (src === null) return ensureMemory(toId);
  writeMemory(toId, src, { force: true });
  return src;
}

/** 会话删掉时，把本子挪进 .trash（不直接删，主人可能想找回）。 */
export function trashMemory(id) {
  if (!isId(id)) return false;
  const file = join(DIR(), `${id}.md`);
  if (!existsSync(file)) return false;
  const trash = join(DIR(), '.trash');
  try {
    if (!existsSync(trash)) mkdirSync(trash, { recursive: true });
    copyFileSync(file, join(trash, `${id}.md`));
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 滚动摘要

const DIGEST_HEAD = '## 滚动摘要';
const ARCHIVE_HEAD = '## 归档';

/**
 * 从正文里切出「滚动摘要」那一段。
 * @returns {{head: string, digest: string, tail: string}} 摘要前、摘要正文、摘要后
 */
function splitDigest(text) {
  const s = String(text ?? '');
  const at = s.indexOf(DIGEST_HEAD);
  if (at < 0) return { head: s, digest: '', tail: '', found: false };
  const bodyStart = at + DIGEST_HEAD.length;
  const after = s.slice(bodyStart);
  // 下一个 ## 级标题就是摘要段的结束（.### 不算）
  const m = after.match(/\n## (?!#)/);
  const end = m ? bodyStart + m.index : s.length;
  return {
    head: s.slice(0, bodyStart),
    digest: s.slice(bodyStart, end),
    tail: s.slice(end),
    found: true,
  };
}

/** 摘要段里的每一条（形如 `- R0001 [时间] 摘要：…`） */
export function digestEntries(text) {
  const { digest } = splitDigest(text);
  return digest
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^-\s+R\d{4}\b/.test(l));
}

/**
 * 往滚动摘要里加一条。编号自己算，满了把最旧的挪进「归档」段。
 * 全程只动文字，不调用模型 —— 写成什么样取决于调用方给的 summary。
 * @returns {{text: string, index: number, folded: string[]}}
 */
export function appendDigest(id, summary) {
  const one = String(summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!one) {
    const e = new Error('摘要不能是空的');
    e.status = 400;
    throw e;
  }
  const cur = ensureMemory(id);
  const parts = splitDigest(cur);
  const entries = digestEntries(cur);

  /**
   * 【源头查重】同一件事不许记第二遍。
   *
   * 踩过两次的坑（2026-10-25、2026-10-26，同一个坑踩了两次）：
   * 我卡在某个地方反复说同一段话，appendDigest 来一条记一条，
   * 20 条上限一满，有用的全被挤走 —— 看着就像「记忆被清空了」。
   *
   * 上次的修法是事后擦（scripts/clean-digest.mjs），擦完下一轮又照样写进来。
   * 这次改在源头：新摘要跟已有的任何一条「足够像」就不记。
   *
   * 怎么算「像」：把两边的标点、空白、数字编号都剃掉，只留文字，
   * 然后比「开头这 60 个字」——同一件事的开头总是差不多的。
   * 不用相似度算法是怕误伤：两件不同的事，开头很少会一模一样。
   */
  const norm = (t) =>
    String(t ?? '')
      .replace(/^.*?摘要：/, '')
      .replace(/[\s\u3000]+/g, '')
      .replace(/[，。、；：！？「」『』（）()【】\[\]…—\-·.,!?;:"']/g, '')
      .slice(0, 60);
  const mine = norm(one);
  if (mine) {
    const dup = entries.find((l) => {
      const body = norm(l);
      return body && (body === mine || (body.length >= 40 && mine.length >= 40 && (body.startsWith(mine.slice(0, 40)) || mine.startsWith(body.slice(0, 40)))));
    });
    if (dup) {
      // 重复的不记，原样返回。调用方不用管 —— 记忆没变就是没变。
      return { text: cur, index: null, folded: [], skipped: 'duplicate' };
    }
  }

  const nextNo = entries.length
    ? Math.max(...entries.map((l) => Number(l.match(/^-\s+R(\d{4})/)[1]))) + 1
    : 1;
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const line = `- R${String(nextNo).padStart(4, '0')} [${stamp}] 摘要：${one}`;

  const folded = [];
  let kept = [...entries, line];
  while (kept.length > DIGEST_LIMIT) folded.push(kept.shift());

  // 摘要段之外的东西原样保留（固定记忆那几节一个字不动）
  let out = parts.found
    ? parts.head + '\n' + kept.join('\n') + '\n' + parts.tail
    : cur.replace(/\s*$/, '') + '\n\n' + DIGEST_HEAD + '\n' + kept.join('\n') + '\n';

  if (folded.length) {
    // 滚出去的进归档段（同一个文件里，正文不堆但一条不丢）
    if (out.includes(ARCHIVE_HEAD)) {
      out = out.replace(ARCHIVE_HEAD, ARCHIVE_HEAD + '\n' + folded.join('\n'));
    } else {
      out = out.replace(/\s*$/, '') + '\n\n' + ARCHIVE_HEAD + '\n' + folded.join('\n') + '\n';
    }
  }
  writeMemory(id, out);
  return { text: out, index: nextNo, folded };
}

/**
 * 把一段摘要写进固定记忆的某个小节。—— 2026-11
 *
 * 为什么要有这个：实测 154 个本子里 153 个的固定记忆区是空骨架。
 * SKELETON 建了四个小节（任务目标 / 用户约束偏好 / 当前状态 / 待办），
 * 但全文件没有一个函数往里写 —— 从建出来那天起就永远是空的。
 *
 * 不用模型：谁送什么就写什么（server 会把滚动摘要收敛成一句送进来）。
 * 没有小节就补一个；同一小节里已经有一样的行就不重复写。
 *
 * @param {string} id 会话 id
 * @param {string} section 小节名（不带 ###），如「当前状态」
 * @param {string} text 要记的一句话
 * @returns {{text: string, added: boolean, section: string}}
 */
/** 「当前状态」最多留几条。每条一句话，8 条已经能看出这个会话在干什么了。 */
const STATE_KEEP = 8;

export function appendFixed(id, section, text) {
  const name = String(section ?? "").replace(/^#+\s*/, "").trim();
  const one = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
  if (!isId(id)) {
    const e = new Error("会话 id 不合法：" + id);
    e.status = 400;
    throw e;
  }
  if (!name) {
    const e = new Error("小节名不能是空的");
    e.status = 400;
    throw e;
  }
  const cur = ensureMemory(id);
  if (!one) return { text: cur, added: false, section: name };

  const lines = cur.split(/\r?\n/);
  const head = "### " + name;
  const at = lines.findIndex((l) => l.trim() === head);
  const line = "- " + one;

  if (at < 0) {
    /** 没有这个小节：补在「## 滚动摘要」之前（即固定记忆区末尾），不然会跑到滚动区里去 */
    const dig = lines.findIndex((l) => l.trim() === DIGEST_HEAD);
    const put = dig >= 0 ? dig : lines.length;
    const block = ["", head, line, ""];
    lines.splice(put, 0, ...block);
  } else {
    /** 找这个小节的正文区间：从标题下一行到下一个标题前 */
    let end = lines.length;
    for (let i = at + 1; i < lines.length; i++) {
      if (/^#{2,3}\s/.test(lines[i])) { end = i; break; }
    }
    const body = lines.slice(at + 1, end);
    if (body.some((l) => l.trim() === line)) {
      /** 同一句已经在里面了，不重复写 */
      return { text: cur, added: false, section: name };
    }
    /** 底部那些占位提示行（如「（这个会话要做什么）」）在第一次真写东西时清掉 */
    let tailAt = body.length;
    while (tailAt > 0 && (/^\s*$/.test(body[tailAt - 1]) || /^（.*）\s*$/.test(body[tailAt - 1]))) tailAt--;
    const kept = body.slice(0, tailAt);
    /** 末尾补一个空行，保持「标题 → 正文 → 空行 → 下个标题」的排版 */
    const keepTailBlank = end < lines.length;
    /**
     * 「当前状态」是滚动的：只保留最新的 STATE_KEEP 条。
     * 没有这道限制它会越堆越长，写到 40 条的时候
     * 就变成了一份没人看的日志 —— 而它占的是每一轮都要发的提示词。
     * 其它小节不限（那几个本来就该少而精，且多半是她自己写的）。
     */
    const KEEP = name === "当前状态" ? STATE_KEEP : Infinity;
    const merged = [...kept, line];
    const trimmed = Number.isFinite(KEEP) && merged.length > KEEP ? merged.slice(merged.length - KEEP) : merged;
    lines.splice(at + 1, end - (at + 1), ...trimmed, ...(keepTailBlank ? [""] : []));
  }

  const out = lines.join("\n").replace(/\s*$/, "") + "\n";
  writeMemory(id, out, { force: true });
  return { text: out, added: true, section: name };
}

/** 清掉固定记忆区的内容（留骨架），滚动摘要一起清。删之前先备份。 */
export function wipeMemory(id) {
  const cur = readMemory(id);
  if (cur === null) return { bytes: 0, backup: null };
  const dir = ensureDir();
  const backup = join(dir, `wiped-${id}-${Date.now()}.md`);
  try {
    writeFileSync(backup, cur, 'utf8');
  } catch {
    /* 备份失败也照样清，只是没得回滚 */
  }
  writeMemory(id, SKELETON, { force: true });
  return { bytes: cur.length, backup };
}

/** 界面上用：这个会话本子多大、有几条摘要。别把正文吐出去。 */
export function memoryInfo(id) {
  const file = isId(id) && existsSync(join(DIR(), `${id}.md`)) ? join(DIR(), `${id}.md`) : null;
  const text = file ? readMemory(id) : null;
  let updatedAt = 0;
  if (file) {
    try {
      updatedAt = statSync(file).mtimeMs;
    } catch {}
  }
  return {
    exists: text !== null,
    chars: text ? text.length : 0,
    digest: text ? digestEntries(text).length : 0,
    updatedAt,
    path: file ?? join(DIR(), `${id}.md`),
  };
}
