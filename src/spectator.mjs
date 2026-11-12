/**
 * 旁观者模式 —— 按会话挑「谁能站在旁边看、随时插一句」。
 *
 * 【2026-11-12 主人定】
 *   · 默认关闭：本会话没选人 = 没人旁观，一个字都不许插；
 *   · 旁观者不能跟本会话正在干活的主智能体相同；
 *   · 纯闲聊不插话（只有干过活的轮才允许）；
 *   · 说话时名字旁边要带「旁观」标记。
 *
 * 存盘：.state/spectator.json，形如 { on: { '<sid>': ['小鲸', …] } }。
 * 空数组 / 缺号 = 本会话关闭。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

function file() {
  return join(config.dataDir, '.state', 'spectator.json');
}

/* mtime 缓存：跟 whale-on.json 同一副药（每次读盘太贵，statSync 几微秒） */
let __cache = { mtimeMs: -1, size: -1, data: null };

function readTable() {
  try {
    const f = file();
    const st = statSync(f);
    if (__cache.data && __cache.mtimeMs === st.mtimeMs && __cache.size === st.size) return __cache.data;
  } catch { /* 文件多半不在 */ }
  try {
    const f = file();
    if (!existsSync(f)) return { on: {} };
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const on = {};
    if (j && j.on && typeof j.on === 'object') {
      for (const [k, v] of Object.entries(j.on)) {
        if (Array.isArray(v)) on[k] = v.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 8);
      }
    }
    __cache = { mtimeMs: statSync(f).mtimeMs, size: statSync(f).size, data: { on } };
    return __cache.data;
  } catch {
    return { on: {} };
  }
}

/** 这个会话的旁观者名单（没设过 = [] = 关闭） */
export function spectatorsOf(sessionId) {
  try {
    const { on } = readTable();
    return (on[String(sessionId || '')] || []).slice();
  } catch {
    return [];
  }
}

/** 这个名字在不在本会话的旁观名单里 */
export function isSpectator(sessionId, name) {
  const n = String(name || '').trim();
  if (!n) return false;
  return spectatorsOf(sessionId).includes(n);
}

/** 设置本会话的旁观者名单（空数组 = 关闭）。名字去重、去空、上限 8 个。 */
export function setSpectators(sessionId, names) {
  const sid = String(sessionId || '').trim();
  if (!sid) return { ok: false, error: '没有 sessionId' };
  const clean = [...new Set((Array.isArray(names) ? names : [])
    .map((x) => String(x || '').trim())
    .filter(Boolean))].slice(0, 8);
  let table = { on: {} };
  try {
    const f = file();
    if (existsSync(f)) {
      const j = JSON.parse(readFileSync(f, 'utf8'));
      if (j && j.on && typeof j.on === 'object') table = { on: j.on };
    }
  } catch { /* 旧文件坏了就当空的 */
  }
  if (clean.length) table.on[sid] = clean;
  else delete table.on[sid];
  try {
    mkdirSync(join(config.dataDir, '.state'), { recursive: true });
    const f = file();
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify(table, null, 2), 'utf8');
    renameSync(tmp, f);
    __cache = { mtimeMs: -1, size: -1, data: null };
    return { ok: true, agents: clean };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}
