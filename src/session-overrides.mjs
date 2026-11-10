// 会话级的「模型 + 思考强度」覆盖。
//
// 需求：
//   - 左上角切模型 / 切思考强度，只影响**当前这个会话**
//   - 没切（默认）就跟右上角「模型」面板里给这个模型设的一致
//   - 右上角那套设置一个字都不许被左上角改动
//
// 存在 .state/session-overrides.json：{ '<sessionId>': { modelId, level } }
// level 是 '' 或不写 = 默认（跟模型设置走）
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
/* 只是拿一个纯函数（老档位 → 四档之一）。thinking.mjs 不回头 import 本文件，不成环。 */
import { normalizeLevel } from './thinking.mjs';
/* 【2026-11-10 D2·原子写】裸 writeFileSync 在进程被杀那一刻会留半截 JSON，
 * 整份 override 表就废了。统一走 sessions-core 的 writeFileAtomic（tmp+fsync+rename）。 */
import { writeFileAtomic } from './sessions-core.mjs';

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
  writeFileAtomic(FILE, JSON.stringify(data, null, 2));
}

function isSessionId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
}

/**
 * 某个会话的覆盖（没有就给空对象，别塞 undefined 进去）。
 *
 * 【2026-11-09 修·读出来就换算档位】
 *
 * 这里原先原样把字符串递出去。可盘上可能存着老档位（on / medium / xhigh）——
 * 于是 `on` 一路传到 thinking.mjs 被 normalizeLevel 换算成「高」，
 * 主人明明在左上角选了「关」，被一个老值盖住，界面还显示得好好的。
 * 现在出口处就换算成四档之一，后面谁拿到都是干净的。
 */
export function getOverride(sessionId) {
  if (!isSessionId(sessionId)) return {};
  const all = readAll();
  const o = all[sessionId];
  if (!o || typeof o !== 'object') return {};
  const out = {};
  if (typeof o.modelId === 'string' && o.modelId) out.modelId = o.modelId;
  if (typeof o.level === 'string' && o.level) out.level = normalizeLevel(o.level);
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
    /* 存的时候就换算：老值（on / medium / xhigh）不进盘，免得下次读出又要清洗一遍 */
    else cur.level = normalizeLevel(level);
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
