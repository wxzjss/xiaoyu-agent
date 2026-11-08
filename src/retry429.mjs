/**
 * 429 自动回退（简化版 dsh-migrate-on-429）。
 *
 * 原来是什么问题：一撞限流就整轮失败，主人白等，还得自己重打一遍。
 *
 * 现在三步走：
 *   1. 撞 429 → 按退避等一会儿再重试（1s / 2s / 4s），别原地疯狂重发烧额度
 *   2. 连续失败到阈值（默认 3 次）→ 把当前会话压成一份摘要，
 *      然后**换个新会话接着跑**（不是并行，是交接：旧的停手，新的顶上）
 *   3. 冷却：迁移完先静一会儿，别连环交接；手动点按钮不受冷却限制
 *
 * 配置存 .state/retry429.json
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const FILE = join(config.dataDir, '.state', 'retry429.json');

export const DEFAULT_RETRY429 = {
  /** 总开关 */
  enabled: true,
  /** 连续失败到这个次数就换会话 */
  migrateThreshold: 3,
  /** 每次重试前等多久（毫秒），按次数翻倍 */
  baseDelayMs: 1000,
  /** 最多重试几次 */
  maxRetries: 3,
  /** 迁移之后的冷却，别连环交接 */
  cooldownMs: 60000,
};

export function getRetry429() {
  const raw = (() => {
    try {
      const r = JSON.parse(readFileSync(FILE, 'utf8'));
      return r && typeof r === 'object' ? r : {};
    } catch {
      return {};
    }
  })();
  const num = (v, d, lo, hi) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return d;
    return Math.min(hi, Math.max(lo, n));
  };
  return {
    enabled: raw.enabled === undefined ? DEFAULT_RETRY429.enabled : Boolean(raw.enabled),
    migrateThreshold: num(raw.migrateThreshold, DEFAULT_RETRY429.migrateThreshold, 1, 20),
    baseDelayMs: num(raw.baseDelayMs, DEFAULT_RETRY429.baseDelayMs, 200, 30000),
    maxRetries: num(raw.maxRetries, DEFAULT_RETRY429.maxRetries, 0, 10),
    cooldownMs: num(raw.cooldownMs, DEFAULT_RETRY429.cooldownMs, 0, 600000),
  };
}

export function setRetry429(input = {}) {
  const cur = getRetry429();
  const next = { ...cur };
  if (input.enabled !== undefined) next.enabled = Boolean(input.enabled);
  for (const k of ['migrateThreshold', 'baseDelayMs', 'maxRetries', 'cooldownMs']) {
    if (input[k] !== undefined && Number.isFinite(Number(input[k]))) next[k] = Number(input[k]);
  }
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  // 存完再读一遍，让取值范围校验生效
  return getRetry429();
}

// ---------------------------------------------------------------- 运行时状态

/** 一个会话的连续失败计数 */
const streaks = new Map();
/** 全局冷却截止时间 */
let cooldownUntil = 0;
/** 正在迁移的会话（互斥，同刻只允许一个） */
let migrating = null;
/** 最近一次迁移的记录 */
let lastMigration = null;

export function streakOf(sessionId) {
  return streaks.get(sessionId) ?? 0;
}

export function resetStreak(sessionId) {
  streaks.delete(sessionId);
}

/** 记一次失败，返回新的连续次数 */
export function bumpStreak(sessionId) {
  const n = streakOf(sessionId) + 1;
  streaks.set(sessionId, n);
  return n;
}

export function inCooldown() {
  const left = cooldownUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

export function startCooldown(ms) {
  cooldownUntil = Date.now() + ms;
}

export function getMigrating() {
  return migrating;
}

export function setMigrating(v) {
  migrating = v;
}

export function getLastMigration() {
  return lastMigration;
}

export function recordMigration(info) {
  lastMigration = { ...info, at: Date.now() };
  return lastMigration;
}

/** 运行状态全给界面看 */
export function retryState(sessionId) {
  return {
    config: getRetry429(),
    sessionId,
    streak: sessionId ? streakOf(sessionId) : 0,
    cooldownLeft: inCooldown(),
    migrating: Boolean(migrating),
    lastMigration,
  };
}

// ---------------------------------------------------------------- 判断 + 退避

/** 这个错误是不是限流 / 配额 */
export function isRateLimited(status, text) {
  if (status === 429) return true;
  const t = String(text ?? '');
  return /rate.?limit|too many requests|tpm|quota|额度|限流|请求过于频繁|insufficient_quota/i.test(t);
}

/** 这个错误是不是「上下文太长」 */
export function isContextOverflow(status, text) {
  const t = String(text ?? '');
  return /context.*(length|window)|maximum context|too many tokens|上下文.*(超|长)/i.test(t) && (status === 400 || status === 413);
}

/** 第 n 次重试前等多久 */
export function retryDelay(attempt) {
  const { baseDelayMs } = getRetry429();
  return Math.min(30000, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 从会话历史里抽一份交接摘要（不调模型，纯结构化，不会再多烧一次请求）。
 * @param {Array} messages
 */
export function handoffSummary(messages = []) {
  const clean = messages.filter((m) => m && !m.context && m.role !== 'system');
  const userLines = [];
  const assistantLines = [];
  const files = new Set();

  for (const m of clean) {
    const raw = Array.isArray(m.content)
      ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
      : String(m.content ?? '');
    const text = raw.trim();
    if (!text) continue;
    if (m.role === 'user') userLines.push(text.replace(/\s+/g, ' ').slice(0, 400));
    else if (m.role === 'assistant') assistantLines.push(text.replace(/\s+/g, ' ').slice(0, 600));
    for (const f of m._files ?? []) files.add(String(f));
    for (const i of m._images ?? []) files.add(String(i));
  }

  const task = userLines[0] ?? '';
  const recentUser = userLines.slice(-3);
  const recentAssistant = assistantLines.slice(-2);

  const lines = [
    '# 交接摘要（上一轮撞限流，换个会话接着干）',
    '',
    '## 最初的任务',
    task || '(没记下来)',
    '',
    '## 主人后面又说了',
    ...(recentUser.length ? recentUser.map((t) => '- ' + t) : ['(没有)']),
    '',
    '## 我上一轮干到哪了',
    ...(recentAssistant.length ? recentAssistant.map((t) => '- ' + t) : ['(没有)']),
  ];
  if (files.size) {
    lines.push('', '## 涉及的文件', ...[...files].map((f) => '- ' + f));
  }
  lines.push('', '## 接着干', '- 上面没做完的事，从断的地方继续；别从头重来，也别问我「要不要继续」。');
  return lines.join('\n');
}

/** 换会话时给新会话的第一句话 */
export function handoffMessage(summaryText, originalTask = '') {
  return [
    '（这是上一轮撞限流后自动接上来的新会话，历史没丢，摘要如下）',
    '',
    summaryText,
    '',
    originalTask ? `原任务：${originalTask}` : '',
    '',
    '直接接着做，不用跟我确认。',
  ]
    .filter(Boolean)
    .join('\n');
}
