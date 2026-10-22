// 会话级的「模型 + 思考强度」覆盖。
//
// 需求：
//   - 左上角切模型 / 切思考强度，只影响**当前这个会话**
//   - 没切（默认）就跟右上角「模型」面板里给这个模型设的一致
//   - 右上角那套设置一个字都不许被左上角改动
//
// 存在 .state/session-overrides.json：{ '<sessionId>': { modelId, level } }
// level 是 '' 或不写 = 默认（跟模型设置走）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const FILE = join(config.dataDir, '.state', 'session-overrides.json');
const DIR = join(config.dataDir, '.state');

function readAll() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

function isSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

/** 某个会话的覆盖（没有就给空对象，别塞 undefined 进去） */
export function getOverride(sessionId) {
  if (!isSessionId(sessionId)) return {};
  const all = readAll();
  const o = all[sessionId];
  if (!o || typeof o !== 'object') return {};
  const out = {};
  if (typeof o.modelId === 'string' && o.modelId) out.modelId = o.modelId;
  if (typeof o.level === 'string' && o.level) out.level = o.level;
  return out;
}

/**
 * 改某个会话的覆盖。
 *   modelId: 传字符串 = 用这个模型；传 null/'' = 回到默认（跟右上角一致）
 *   level:   传字符串 = 用这个思考强度；传 null/'' = 回到默认
 */
export function setOverride(sessionId, { modelId, level } = {}) {
  if (!isSessionId(sessionId)) {
    const e = new Error('会话 id 不对');
    e.status = 400;
    throw e;
  }
  const all = readAll();
  const cur = getOverride(sessionId);

  if (modelId !== undefined) {
    if (modelId === null || modelId === '') delete cur.modelId;
    else cur.modelId = String(modelId);
  }
  if (level !== undefined) {
    if (level === null || level === '') delete cur.level;
    else cur.level = String(level);
  }

  if (Object.keys(cur).length) all[sessionId] = cur;
  else delete all[sessionId];

  writeAll(all);
  return cur;
}

/** 会话没了就把它的覆盖一起删掉，别留垃圾 */
export function clearOverride(sessionId) {
  const all = readAll();
  if (all[sessionId]) {
    delete all[sessionId];
    writeAll(all);
  }
}
