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

const STATE_DIR = join(config.dataDir, '.state');

/**
 * 按智能体分·2026-10-30
 * 谁的哪套人设 —— '' 是主人自己（小鱼），其他是智能体 id。
 * 小鱼继续用老地方，旧数据一个字节都不用搬。
 */
let _scope = '';

/** 只许字母数字下划线横线，防止拼出 ../ */
function scopeOk(x) {
  return typeof x === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(x);
}

/** 临时切到某个智能体的人设库干活，干完切回来（同步函数用） */
export function withPersonaScope(scope, fn) {
  const prev = _scope;
  _scope = scopeOk(scope) ? String(scope || '') : '';
  try {
    return fn();
  } finally {
    _scope = prev;
  }
}

/** 当前 scope（调试用） */
export function personaScope() {
  return _scope;
}

function pDir() {
  return _scope ? join(STATE_DIR, 'personas', _scope) : join(STATE_DIR, 'personas');
}

function indexFile() {
  return _scope ? join(STATE_DIR, 'personas', _scope + '.json') : join(STATE_DIR, 'personas.json');
}

function baseFile() {
  return join(config.root, 'persona', 'xiaoyu.md');
}

const LEGACY_FILE = join(STATE_DIR, 'persona.md');
const LEGACY_BACKUP = join(STATE_DIR, 'persona.backup.md');

/**
 * 主人自定义的「默认值」存这儿，跟 settings.mjs 用的是同一个文件。
 *
 * 目前两个键：
 *   bottomLines  这个项目里的一套底线（见 settings.mjs 的 setDefaultBottomLines）
 *   persona      这个项目里的一套人设正文（见本文件的 setPersonaAsBuiltinDefault）
 * 为什么不直接改 persona/xiaoyu.md：那是发布物，改了下次更新就被覆盖，
 * 而且主人想「回到原厂」时就没得回了。
 */
const DEFAULTS_FILE = join(STATE_DIR, 'defaults.json');

/** 读主人自定义的默认值；没有 / 坏了都当空对象 */
function readDefaults() {
  try {
    const raw = JSON.parse(readFileSync(DEFAULTS_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

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
  const d = pDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/** 发布物自带的那份人设原文 */
export function readBasePersona() {
  const text = readFileSafe(baseFile());
  if (text === null) throw new Error(`persona file missing: ${baseFile()}`);
  return text.trim();
}

/** id 只许字母数字下划线横线，免得拼出 ../ 之类的东西 */
function isPersonaId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function fileFor(id) {
  return join(pDir(), `${id}.md`);
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
  const raw = readFileSafe(indexFile());
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
  writeFileSync(indexFile(), JSON.stringify(idx, null, 2), 'utf8');
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
  // 内置那套没自己的文件时，落到「当前生效的默认」上（主人定过就用主人定的）
  if (id === DEFAULT_ID) return builtinPersonaText();
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
    // base = 「出厂默认」那份：主人定过就用主人定的，没定过才是发布物那份
    base: builtinPersonaText(),
    // 出厂那份的原始正文（真·原厂），给「连出厂的也看」这类场景用
    factory: readBasePersona(),
    custom: isDefault ? touched : true,
    path: existsSync(fileFor(current)) ? fileFor(current) : baseFile(),
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

/**
 * 把当前正在用的这套人设存成「默认人设」（内置那套，id = default）。
 *
 * 主人的意思很直白：现在用的这套就是我要的默认，以后点「恢复自带人设」要回到这套。
 * 所以把当前正文原样写进 personas/default.md，再把当前切到 default。
 * 原来那套不自删，留着随时能切回去。
 *
 * 注意：发布物里的 persona/xiaoyu.md **一个字都不碰** —— 那是出厂备份。
 * @param {string} [id] 要存成默认的那套，不传就存当前用的
 * @returns {{ persona: object, from: string, changed: boolean }}
 */
export function setPersonaAsDefault(id) {
  const idx = ensureIndex();
  const from = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === from)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const body = cleanText(textOf(from));
  const oldDefault = readFileSafe(fileFor(DEFAULT_ID));
  const already =
    from === DEFAULT_ID &&
    oldDefault !== null &&
    oldDefault.trim() === body;
  if (already) {
    return { persona: personaInfo(), from, changed: false };
  }
  // 旧默认先留一份，手滑能捡回来
  if (oldDefault && oldDefault.trim()) {
    try {
      ensureDirs();
      writeFileSync(join(STATE_DIR, 'persona.default.backup.md'), oldDefault, 'utf8');
    } catch {}
  }
  ensureDirs();
  writeFileSync(fileFor(DEFAULT_ID), body + '\n', 'utf8');
  const meta = idx.list.find((p) => p.id === DEFAULT_ID);
  if (meta) meta.updatedAt = Date.now();
  idx.current = DEFAULT_ID;
  writeIndex(idx);
  return { persona: personaInfo(), from, changed: true };
}

/** 改名字 */
export async function renamePersona(id, name) {
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
  /**
   * 记忆本跟着名字搬。
   *
   * 本子是按人设名字放的（同名共用一本）。改名不搬的话，
   * 下回读的就是另一个路径了 —— 人会觉得自己突然失忆。
   * 搬失败不能拦着改名本身：名字还得改，本子的问题记一笔日志就行。
   */
  const before = meta.name;
  meta.name = next;
  meta.updatedAt = Date.now();
  writeIndex(idx);
  if (before && before !== next) {
    try {
      const { moveMemoryOnRename } = await import('./my-memory.mjs');
      moveMemoryOnRename(before, { id, name: next });
    } catch (e) {
      console.warn('[memory] 人设改名时记忆本没搬成：', String(e?.message ?? e));
    }
  }
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
  // 删掉自己的文件就回到「当前生效的默认」（主人定过的那版，否则是发布物那份）
  rmSync(fileFor(target), { force: true });
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

/**
 * 把一套人设的正文定成「出厂的默认」。
 *
 * 主人用顺了某套之后说「这个就当默认吧」，以后新建会话 / 恢复默认时想回到它。
 * 做法和底线的 setDefaultBottomLines 完全对称：不改代码文件，
 * 只把正文抄到 .state/defaults.json 的 persona 键里；persona/xiaoyu.md 一个字都不碰。
 * 上一份自定义默认先备份到 .state/persona.default.backup.md。
 *
 * @param {string} [id] 要定成默认的那套，不传就用当前这套
 * @returns {{ persona: object, from: string, backup: string|null, changed: boolean }}
 */
export function setPersonaAsBuiltinDefault(id) {
  const idx = ensureIndex();
  const from = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === from)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const body = textOf(from);
  if (!body.trim()) {
    const e = new Error('这套是空的，不能定成默认');
    e.status = 400;
    throw e;
  }
  const prev = readDefaults();
  const before = typeof prev.persona === 'string' ? prev.persona.trim() : '';
  if (before && before === body.trim()) {
    return { persona: personaInfo(), from, backup: null, changed: false };
  }
  let backup = null;
  if (before) {
    ensureDirs();
    backup = join(STATE_DIR, 'persona.default.backup.md');
    try {
      writeFileSync(backup, before, 'utf8');
    } catch {
      backup = null;
    }
  }
  ensureDirs();
  writeFileSync(
    DEFAULTS_FILE,
    JSON.stringify({ ...prev, persona: body }, null, 2),
    'utf8',
  );
  return { persona: personaInfo(), from, backup, changed: true };
}

/** 主人定过的默认人设正文；没定过就是发布物那份 */
export function builtinPersonaText() {
  const t = readDefaults().persona;
  if (typeof t === 'string' && t.trim()) return t.trim();
  return readBasePersona();
}

/** 当前生效的那套人设正文（给系统提示用） */
export function currentPersonaText() {
  const idx = ensureIndex();
  return textOf(idx.current);
}

/**
 * 把当前这套人设的内容清空（不是删掉这套，是把正文抹成空）。
 *
 * 主人点「清空当前」并勾上了「连记忆一起清」时走这里。
 * 两条底线：
 *   1. 清之前一定先备份到 .state/persona.wiped-<时间戳>.md —— 记忆是一次次聊出来的，
 *      点错按钮不该等于永久丢失。
 *   2. 内置的 persona/xiaoyu.md 一个字都不碰。那是出厂的那份，
 *      清空只影响「主人正在用的这一套」（personas/<id>.md）。
 *
 * @param {string} [id] 要清的那套，不传就清当前用的
 * @returns {{ persona: object, id: string, backup: string|null, bytes: number }}
 */
export function wipePersonaText(id) {
  const idx = ensureIndex();
  const target = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === target)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const file = fileFor(target);
  const before = readFileSafe(file);
  // 没自定义过（文件不存在）= 用的还是出厂那份，没有可清的东西，如实告诉调用方
  if (before === null) {
    return { persona: personaInfo(), id: target, backup: null, bytes: 0 };
  }
  let backup = null;
  if (before.trim()) {
    ensureDirs();
    backup = join(STATE_DIR, `persona.wiped-${Date.now()}.md`);
    try {
      writeFileSync(backup, before, 'utf8');
    } catch {
      backup = null;
    }
  }
  writeFileSync(file, '\n', 'utf8');
  const meta = idx.list.find((p) => p.id === target);
  if (meta) meta.updatedAt = Date.now();
  writeIndex(idx);
  return { persona: personaInfo(), id: target, backup, bytes: before.length };
}

/** 顺手清掉没人用的残留文件（只为一眼看清目录，不删备份） */
export function listPersonaFiles() {
  try {
    return readdirSync(pDir());
  } catch {
    return [];
  }
}
