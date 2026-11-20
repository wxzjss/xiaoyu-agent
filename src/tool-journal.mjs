/**
 * 【2026-11-19 新增·工具「正在跑」的账，必须落盘】
 *
 * 实测挖出来的：进程在「工具已经跑完、结果还没写回历史」那一刻被杀，
 * 重启后模型完全不知道自己调过什么，于是**原样再执行一遍**。
 *
 * 为什么只看会话历史不够：
 *   · 会话文件（sessions/<id>.json）是**整轮结束**才落盘的；
 *   · 中途被杀，那一轮的 assistant(tool_calls) 压根没写进去；
 *   · 所以 repairHistory 在续跑时什么也收不到 —— 历史里根本没有这次调用。
 *
 * 草稿（turn-draft）只存正文，没有工具。
 *
 * 工具开始执行前记账，会话文件成功保存对应结果后才清账。
 * 每次执行使用独立凭据，避免模型重复使用调用 ID 时误清另一笔记录。
 *
 * 只记名字和参数摘要，不记结果（结果可能很大）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state', 'tool-journal');
const MAX_KEEP = 40;      // 一个会话最多同时挂着这么多条（防止异常时无限增长）
const ARG_CAP = 200;      // 参数只留开头，够模型认出「这是哪一次调用」

function ensureDir() {
  if (!existsSync(DIR)) {
    try { mkdirSync(DIR, { recursive: true }); } catch {}
  }
}

function pathOf(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^\w.-]/g, '_');
  return join(DIR, safe + '.json');
}

function readRaw(sessionId) {
  try {
    const j = JSON.parse(readFileSync(pathOf(sessionId), 'utf8'));
    return Array.isArray(j?.running) ? j : { running: [] };
  } catch {
    return { running: [] };
  }
}

function writeRaw(sessionId, data) {
  try {
    ensureDir();
    const target = pathOf(sessionId);
    const tmp = `${target}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(data), 'utf8');
      renameSync(tmp, target);
    } finally {
      try { unlinkSync(tmp); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
    }
    return true;
  } catch { return false; }
}

/** 在实际执行前写入一笔账，返回本次执行的凭据。 */
export function beginTool(sessionId, call) {
  try {
    if (!call || !call.id) return;
    const name = String(call.function?.name || call.name || '');
    if (!name) return;
    const raw = readRaw(sessionId);
    const token = randomUUID();
    raw.running.push({
      token,
      id: String(call.id),
      name,
      args: String(call.function?.arguments ?? call.arguments ?? '').replace(/\s+/g, ' ').slice(0, ARG_CAP),
      at: Date.now(),
    });
    if (raw.running.length > MAX_KEEP) raw.running = raw.running.slice(-MAX_KEEP);
    if (writeRaw(sessionId, raw)) return token;
  } catch { /* 日志不可用时保留工具原有行为 */ }
}

function committedTokens(messages) {
  const tokens = new Set();
  for (const message of messages ?? []) {
    if (message?.role === 'tool' && typeof message._journalToken === 'string') tokens.add(message._journalToken);
  }
  return tokens;
}

/** 仅在会话文件成功保存之后确认这份快照里的工具结果。 */
export function acknowledgeSavedTools(sessionId, messages) {
  try {
    const raw = readRaw(sessionId);
    if (!raw.running.length) return;
    const tokens = committedTokens(messages);
    const remaining = raw.running.filter((x) => !tokens.has(x?.token));
    if (remaining.length !== raw.running.length) writeRaw(sessionId, { ...raw, running: remaining });
  } catch {}
}

/** 已保存的结果即使还没来得及清账，恢复时也不重复提示。 */
export function liveTools(sessionId, messages) {
  try {
    const tokens = committedTokens(messages);
    return readRaw(sessionId).running.filter((x) => x?.name && !tokens.has(x.token));
  } catch {
    return [];
  }
}
