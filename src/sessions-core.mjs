// Sessions on disk: .state/sessions/<id>.json + _last.json (最近会话).
// Every turn writes back to disk, so a reload/power-cut never loses the conversation.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state', 'sessions');
const TRASH = join(DIR, '.trash');
const LAST = join(DIR, '_last.json');
const MAX_TITLE = 40;

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isSessionId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function ensureDir(dir = DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function fileFor(id) {
  return join(DIR, `${id}.json`);
}

function cleanTitle(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/** First user line doubles as the session title. */
export function titleFromMessage(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '新会话';
  const line = raw.split(/[。！？!?\n]/)[0].trim() || raw;
  return line.slice(0, MAX_TITLE);
}

export function newSessionId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function loadSession(id) {
  if (!isSessionId(id)) return null;
  try {
    const raw = JSON.parse(readFileSync(fileFor(id), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      id,
      title: cleanTitle(raw.title) || '新会话',
      createdAt: Number(raw.createdAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
      messages: Array.isArray(raw.messages) ? raw.messages : [],
      // 回退点跟着会话一起落盘：只追加、从不改写老消息。
      rewinds: Array.isArray(raw.rewinds) ? raw.rewinds : [],
    };
  } catch {
    return null;
  }
}

export function saveSession(session) {
  if (!session || !isSessionId(session.id)) return null;
  ensureDir();
  session.updatedAt = Date.now();
  if (!session.createdAt) session.createdAt = session.updatedAt;
  const payload = {
    id: session.id,
    title: cleanTitle(session.title) || '新会话',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages ?? [],
    rewinds: Array.isArray(session.rewinds) ? session.rewinds : [],
  };
  writeFileSync(fileFor(session.id), JSON.stringify(payload), 'utf8');
  return session;
}

export function renameSession(id, title) {
  const s = loadSession(id);
  if (!s) return null;
  const next = cleanTitle(title);
  if (!next) return null;
  s.title = next;
  saveSession(s);
  return s;
}

function previewOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && !m.context) {
      const raw = m.content;
      const body = Array.isArray(raw) ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') : raw;
      let text = String(body ?? '').replace(/\s+/g, ' ').trim();
      // 只有图没文字：拿附件名顶一下
      if (!text && Array.isArray(m._images) && m._images.length) text = '[图片] ' + m._images.map((p) => String(p).split(/[\\/]/).pop()).join(' ');
      return text.slice(0, 60);
    }
  }
  return '';
}

/** Newest first, for the 会话 picker. */
export function listSessions() {
  ensureDir();
  const out = [];
  let names = [];
  try {
    names = readdirSync(DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const id = name.slice(0, -5);
    if (!isSessionId(id)) continue;
    const s = loadSession(id);
    if (!s) continue;
    out.push({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      count: s.messages.filter((m) => m && m.role === 'user' && !m.context).length,
      preview: previewOf(s.messages),
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Soft delete: the file moves to .state/sessions/.trash instead of vanishing. */
export function deleteSession(id) {
  if (!isSessionId(id)) return false;
  const file = fileFor(id);
  if (!existsSync(file)) return false;
  ensureDir(TRASH);
  renameSync(file, join(TRASH, `${id}-${Date.now()}.json`));
  const last = getLastSessionId();
  if (last === id) {
    const rest = listSessions();
    setLastSessionId(rest.length ? rest[0].id : null);
  }
  return true;
}

export function getLastSessionId() {
  try {
    const j = JSON.parse(readFileSync(LAST, 'utf8'));
    return isSessionId(j?.id) ? j.id : null;
  } catch {
    return null;
  }
}

export function setLastSessionId(id) {
  ensureDir();
  writeFileSync(LAST, JSON.stringify({ id: isSessionId(id) ? id : null, at: Date.now() }), 'utf8');
}

// ---- 导入 / 导出 -----------------------------------------------------------
/**
 * 导出格式（一个会话一个文件，纯 JSON，人类可读）：
 * {
 *   "kind": "xiaoyu-agent.session",
 *   "version": 1,
 *   "exportedAt": 1690000000000,
 *   "session": { id, title, createdAt, updatedAt, messages: [...], rewinds: [...] }
 * }
 * 消息里的附件只存路径（_images / _files），不内联二进制 —— 换台机器上那些路径可能不存在，
 * 这一点在 README 里写清楚了。要连附件一起搬，就把整个 .state 目录拷过去。
 */
export const EXPORT_KIND = 'xiaoyu-agent.session';
export const EXPORT_VERSION = 1;

/** 把一个会话包成可导出的对象；会话不存在返回 null。 */
export function exportSession(id) {
  const s = loadSession(id);
  if (!s) return null;
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    session: {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messages: s.messages,
      rewinds: s.rewinds,
    },
  };
}

/** 全部会话一起导出（备份用），不含 .trash。 */
export function exportAllSessions() {
  const ids = listSessions().map((s) => s.id);
  return {
    kind: EXPORT_KIND + '.bundle',
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    sessions: ids.map((id) => exportSession(id)).filter(Boolean).map((x) => x.session),
  };
}

/**
 * 把一条消息洗成我们认的样子。认不出来的直接丢掉，不让脏数据进库。
 * 只保留用得到的字段：role / content / _images / _files / toolCallId / isError / context 等。
 */
function cleanMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const role = String(m.role ?? '').trim();
  if (!['system', 'user', 'assistant', 'tool'].includes(role)) return null;
  const out = { role };
  if (typeof m.content === 'string') out.content = m.content;
  else if (Array.isArray(m.content)) out.content = m.content;
  else out.content = '';
  for (const k of ['_images', '_files']) {
    if (Array.isArray(m[k])) out[k] = m[k].filter((x) => typeof x === 'string');
  }
  if (typeof m.toolCallId === 'string') out.toolCallId = m.toolCallId;
  if (typeof m.toolName === 'string') out.toolName = m.toolName;
  if (m.isError) out.isError = true;
  if (m.context) out.context = true;
  return out;
}

/**
 * 从导入的数据里抠出会话列表。同时认三种形状：
 *   1. 单会话导出：{ kind, session: {...} }
 *   2. 整包导出：  { kind, sessions: [...] }
 *   3. 裸会话对象：{ messages: [...] } —— 手写的、或从别处拷来的也能进
 *   4. 裸数组：    [ {...}, {...} ]
 * @returns {Array<object>} 干净的会话草稿（还没分配 id）
 */
export function parseImport(raw) {
  const list = [];
  const push = (s) => {
    if (!s || typeof s !== 'object') return;
    const messages = Array.isArray(s.messages) ? s.messages.map(cleanMessage).filter(Boolean) : [];
    if (!messages.length) return;
    list.push({
      title: cleanTitle(s.title) || titleFromMessage(textOf(messages)),
      createdAt: Number(s.createdAt) || Date.now(),
      updatedAt: Number(s.updatedAt) || Date.now(),
      messages,
      rewinds: Array.isArray(s.rewinds) ? s.rewinds : [],
    });
  };

  if (Array.isArray(raw)) {
    for (const x of raw) push(x && x.session ? x.session : x);
  } else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.sessions)) for (const x of raw.sessions) push(x);
    else if (raw.session) push(raw.session);
    else push(raw);
  }
  return list;
}

function textOf(messages) {
  for (const m of messages) {
    if (m.role !== 'user' || m.context) continue;
    const raw = m.content;
    const body = Array.isArray(raw) ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') : raw;
    const t = String(body ?? '').trim();
    if (t) return t;
  }
  return '';
}

/**
 * 把导入的草稿真正写进 .state/sessions，每条都拿一个新 id（不会覆盖现有会话）。
 * @returns {Array<{id:string,title:string,count:number}>}
 */
export function importSessions(drafts) {
  ensureDir();
  const made = [];
  for (const d of drafts) {
    const session = {
      id: newSessionId(),
      title: d.title,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      messages: d.messages,
      rewinds: d.rewinds,
    };
    // 极端情况下生成的 id 撞了，就再摇一次
    let guard = 0;
    while (existsSync(fileFor(session.id)) && guard++ < 8) session.id = newSessionId();
    const saved = saveSession(session);
    if (!saved) continue;
    made.push({
      id: saved.id,
      title: saved.title,
      count: saved.messages.filter((m) => m && m.role === 'user' && !m.context).length,
    });
  }
  return made;
}
