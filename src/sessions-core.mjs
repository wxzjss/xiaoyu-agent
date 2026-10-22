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
