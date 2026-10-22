// Persona store：多套人设，一套一个文件，外加「当前用哪套」。
//
// 存法（都放 .state/）：
//   .state/personas/<id>.md     一套人设一个文件，文件名就是 id
//   .state/personas.json        { current: '<id>', list: [{id, name, builtin, updatedAt}] }
//
// 「默认人设」是内置的，永远存在、不许删；它的内容来自 persona/xiaoyu.md（发布物自带的），
// 主人把它改了也只会写到 personas/default.md，原来那份发布文件一个字都不碰。
//
// 旧数据怎么接：以前只有 .state/persona.md 一个文件。第一次读的时候如果见到它、
// 又没有 personas.json，就自动搬成「我的旧人设」这一套，并设成当前用的，
// 旧文件原样留着不删（万一搬错了还能捞回来）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const BASE_FILE = join(config.root, 'persona', 'xiaoyu.md');
const STATE_DIR = join(config.dataDir, '.state');
const P_DIR = join(STATE_DIR, 'personas');
const INDEX_FILE = join(STATE_DIR, 'personas.json');
const LEGACY_FILE = join(STATE_DIR, 'persona.md');
const LEGACY_BACKUP = join(STATE_DIR, 'persona.backup.md');

const DEFAULT_ID = 'default';
const DEFAULT_NAME = '默认人设';
const MAX_NAME = 40;
const MAX_TEXT = 200_000;

function readFileSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function ensureDirs() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(P_DIR)) mkdirSync(P_DIR, { recursive: true });
}

/** 发布物自带的那份人设原文 */
export function readBasePersona() {
  const text = readFileSafe(BASE_FILE);
  if (text === null) throw new Error(`persona file missing: ${BASE_FILE}`);
  return text.trim();
}

/** id 只许字母数字下划线横线，免得拼出 ../ 之类的东西 */
function isPersonaId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function fileFor(id) {
  return join(P_DIR, `${id}.md`);
}

function cleanName(n) {
  return String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function cleanText(t) {
  const s = String(t ?? '').replace(/\r\n/g, '\n').trim();
  if (!s) {
    const e = new Error('人设内容不能为空');
    e.status = 400;
    throw e;
  }
  if (s.length > MAX_TEXT) {
    const e = new Error(`人设太长（${s.length} 字），最多 ${MAX_TEXT} 字`);
    e.status = 400;
    throw e;
  }
  return s;
}

function newId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readIndex() {
  const raw = readFileSafe(INDEX_FILE);
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    const list = Array.isArray(j.list) ? j.list.filter((x) => x && isPersonaId(x.id)) : [];
    return { current: isPersonaId(j.current) ? j.current : DEFAULT_ID, list };
  } catch {
    return null;
  }
}

function writeIndex(idx) {
  ensureDirs();
  writeFileSync(INDEX_FILE, JSON.stringify(idx, null, 2), 'utf8');
}

/**
 * 第一次用的时候把索引建起来：内置默认人设 + （有旧文件的话）搬一份成「我的旧人设」。
 * 只在索引文件不存在时跑一次。
 */
function ensureIndex() {
  const existing = readIndex();
  if (existing) {
    // 内置那套必须在，被手删了要补回来
    if (!existing.list.some((p) => p.id === DEFAULT_ID)) {
      existing.list.unshift({ id: DEFAULT_ID, name: DEFAULT_NAME, builtin: true, updatedAt: Date.now() });
      writeIndex(existing);
    }
    return existing;
  }

  ensureDirs();
  const idx = {
    current: DEFAULT_ID,
    list: [{ id: DEFAULT_ID, name: DEFAULT_NAME, builtin: true, updatedAt: Date.now() }],
  };

  // 旧版单文件人设：搬成一套自己的，别丢
  const legacy = readFileSafe(LEGACY_FILE);
  if (legacy && legacy.trim()) {
    const id = 'legacy';
    try {
      writeFileSync(fileFor(id), legacy.trim() + '\n', 'utf8');
      const when = (() => {
        try { return Date.now(); } catch { return 0; }
      })();
      idx.list.push({ id, name: '我的旧人设', builtin: false, updatedAt: when });
      idx.current = id; // 主人原来用的就是它，继续用它
    } catch {
      // 搬不动就算了，至少默认人设可用
    }
  }

  writeIndex(idx);
  return idx;
}

/** 某一套的正文：内置且没改过 -> 发布物那份；否则读文件 */
function textOf(id) {
  const own = readFileSafe(fileFor(id));
  if (own !== null && own.trim()) return own.trim();
  if (id === DEFAULT_ID) return readBasePersona();
  return '';
}

function brief(id, meta) {
  const t = textOf(id);
  return {
    id,
    name: meta.name || (id === DEFAULT_ID ? DEFAULT_NAME : id),
    builtin: Boolean(meta.builtin) || id === DEFAULT_ID,
    updatedAt: Number(meta.updatedAt) || 0,
    chars: t.length,
    preview: t.replace(/\s+/g, ' ').slice(0, 60),
  };
}

/** 设置面板要的全部信息 */
export function personaInfo() {
  const idx = ensureIndex();
  const list = idx.list.map((p) => brief(p.id, p));
  const current = list.some((p) => p.id === idx.current) ? idx.current : DEFAULT_ID;
  const curMeta = idx.list.find((p) => p.id === current) || { id: DEFAULT_ID, name: DEFAULT_NAME, builtin: true };
  const text = textOf(current);
  const isDefault = current === DEFAULT_ID;
  // 「改过没有」：内置那套看有没有自己的文件；其他那套基本都算改过
  const touched = existsSync(fileFor(current));
  return {
    text,
    base: readBasePersona(),
    custom: isDefault ? touched : true,
    path: existsSync(fileFor(current)) ? fileFor(current) : BASE_FILE,
    current,
    currentName: curMeta.name || DEFAULT_NAME,
    list,
  };
}

/** 切到另一套 */
export function switchPersona(id) {
  const idx = ensureIndex();
  if (!isPersonaId(id) || !idx.list.some((p) => p.id === id)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  idx.current = id;
  writeIndex(idx);
  return personaInfo();
}

/** 新建一套：可以给个起点（默认拿当前这套复制，也可以给空/给正文） */
export function createPersona({ name, text, copyCurrent = true } = {}) {
  const idx = ensureIndex();
  const id = newId();
  const body = typeof text === 'string' && text.trim()
    ? cleanText(text)
    : (copyCurrent ? textOf(idx.current) : '');
  if (!body) {
    const e = new Error('新人设内容不能为空');
    e.status = 400;
    throw e;
  }
  ensureDirs();
  writeFileSync(fileFor(id), body + '\n', 'utf8');
  const meta = { id, name: cleanName(name) || '新人设', builtin: false, updatedAt: Date.now() };
  idx.list.push(meta);
  writeIndex(idx);
  return { ...personaInfo(), created: id };
}

/** 存某一套的正文（不传 id 就存当前这套） */
export function savePersonaText(id, text) {
  const idx = ensureIndex();
  const target = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === target)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const clean = cleanText(text);
  ensureDirs();
  writeFileSync(fileFor(target), clean + '\n', 'utf8');
  const meta = idx.list.find((p) => p.id === target);
  meta.updatedAt = Date.now();
  writeIndex(idx);
  return personaInfo();
}

/** 改名字 */
export function renamePersona(id, name) {
  const idx = ensureIndex();
  const meta = idx.list.find((p) => p.id === id);
  if (!meta) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const next = cleanName(name);
  if (!next) {
    const e = new Error('名字不能为空');
    e.status = 400;
    throw e;
  }
  if (meta.builtin || id === DEFAULT_ID) {
    const e = new Error('默认人设的名字不给改，方便你随时找回来');
    e.status = 400;
    throw e;
  }
  meta.name = next;
  meta.updatedAt = Date.now();
  writeIndex(idx);
  return personaInfo();
}

/** 删掉一套（内置那套不许删；删的正好是当前用的就切回默认） */
export function deletePersona(id) {
  const idx = ensureIndex();
  if (id === DEFAULT_ID) {
    const e = new Error('默认人设删不掉');
    e.status = 400;
    throw e;
  }
  const at = idx.list.findIndex((p) => p.id === id);
  if (at < 0) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  // 删之前先留一份，别让人后悔
  const body = readFileSafe(fileFor(id));
  if (body !== null) {
    try {
      ensureDirs();
      writeFileSync(join(STATE_DIR, `persona.deleted.${id}.md`), body, 'utf8');
    } catch {}
  }
  rmSync(fileFor(id), { force: true });
  idx.list.splice(at, 1);
  if (idx.current === id) idx.current = DEFAULT_ID;
  writeIndex(idx);
  return personaInfo();
}

/** 把某一套恢复成默认内容（内置那套 = 回到发布物那份） */
export function resetPersona(id) {
  const idx = ensureIndex();
  const target = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === target)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const own = readFileSafe(fileFor(target));
  if (own && own.trim()) {
    try {
      ensureDirs();
      writeFileSync(LEGACY_BACKUP, own, 'utf8');
    } catch {}
  }
  rmSync(fileFor(target), { force: true }); // 删掉自己的文件就回到发布物那份
  const meta = idx.list.find((p) => p.id === target);
  meta.updatedAt = Date.now();
  writeIndex(idx);
  return personaInfo();
}

// ---------------------------------------------------------------- 兼容老接口

/** 老接口：存当前这套 */
export function saveUserPersona(text) {
  const idx = ensureIndex();
  return savePersonaText(idx.current, text);
}

/** 老接口：把当前这套恢复默认 */
export function resetUserPersona() {
  const idx = ensureIndex();
  return resetPersona(idx.current);
}

/** 当前生效的那套人设正文（给系统提示用） */
export function currentPersonaText() {
  const idx = ensureIndex();
  return textOf(idx.current);
}

/** 顺手清掉没人用的残留文件（只为一眼看清目录，不删备份） */
export function listPersonaFiles() {
  try {
    return readdirSync(P_DIR);
  } catch {
    return [];
  }
}
