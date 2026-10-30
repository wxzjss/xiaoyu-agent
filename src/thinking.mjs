/**
 * 思考档位（对齐 dsh-thinking-levels 的思路，按这个平台的体量做简化版）。
 *
 * 三件事：
 *   1. 每套模型能存一个默认档位（off/minimal/low/medium/high/xhigh/max/auto）
 *   2. 发请求时把 reasoning_effort 塞进去；auto 就按「这轮有没有工具调用」现算
 *   3. 拿不准的模型不发这个字段（非推理模型收到会 400），所以能自动降级
 *
 * 存在 .state/thinking.json：{ level: 'auto', perModel: { '<modelId>': 'low' } }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const FILE = join(config.dataDir, '.state', 'thinking.json');

/**
 * 能手动选的档位。auto 是「按工具历史自动调度」，不发这个值出去。
 *
 * 档位集合对齐 dsh-thinking-levels 的八个标准档：off / on / minimal / low / medium / high / xhigh / max，
 * 外加 auto 调度哨兵。其中：
 *   - off 是**手动档，自动调度永远不会挑它**（跟 dsh 插件一个约定）。
 *   - on 是「打开思考、用模型默认强度」的开关档，不是 wire 值。
 */
export const LEVELS = [
  { id: 'off', name: '关', desc: '完全不思考，直接把答案说出来' },
  { id: 'on', name: '开', desc: '思考打开，用模型默认强度' },
  { id: 'minimal', name: '最低', desc: '极轻任务，几乎不思考' },
  { id: 'low', name: '低', desc: '简单对话，便宜又快' },
  { id: 'medium', name: '中', desc: '中等强度' },
  { id: 'high', name: '高', desc: '官方默认档，稳' },
  { id: 'xhigh', name: '特高', desc: '更狠一点' },
  { id: 'max', name: '最高', desc: '重任务，舍得花时间' },
  { id: 'auto', name: '自动', desc: '按这轮要不要调工具，自己挑档' },
];

const LEVEL_IDS = new Set(LEVELS.map((l) => l.id));
/** 强度梯度（不含 off / on / auto）。off 和 on 不是 wire 强度值。 */
const EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

/** 一次请求最多试几次（降档用的） */
const MAX_ATTEMPTS = 3;

function readRaw() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function writeRaw(data) {
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
}

/** 全局默认档位 + 每个模型的覆盖值 */
export function getThinking() {
  const raw = readRaw();
  /**
   * 默认值是 off，也就是「不发 reasoning_effort」。
   *
   * 踩过坑：这个网关对不认识的字段不会好好回 400，而是直接把流掐断，
   * 前端只能看到 terminated。所以默认最保守——不主动加字段，
   * 主人在面板里自己选了档位，才认为「这个模型是支持的」。
   */
  const level = LEVEL_IDS.has(raw.level) ? raw.level : 'off';
  const perModel = raw.perModel && typeof raw.perModel === 'object' ? raw.perModel : {};
  const clean = {};
  for (const [k, v] of Object.entries(perModel)) {
    if (LEVEL_IDS.has(v)) clean[k] = v;
  }
  return { level, perModel: clean };
}

/** 改全局默认 / 某个模型的档位 */
export function setThinking(input = {}) {
  const cur = getThinking();
  const next = { level: cur.level, perModel: { ...cur.perModel } };

  if (input.level !== undefined) {
    if (!LEVEL_IDS.has(input.level)) {
      const e = new Error(`没有这个思考档位：${input.level}`);
      e.status = 400;
      throw e;
    }
    next.level = input.level;
  }

  if (input.modelId !== undefined) {
    const id = String(input.modelId);
    if (input.modelLevel === null || input.modelLevel === '') {
      delete next.perModel[id];
    } else if (LEVEL_IDS.has(input.modelLevel)) {
      next.perModel[id] = input.modelLevel;
    } else {
      const e = new Error(`没有这个思考档位：${input.modelLevel}`);
      e.status = 400;
      throw e;
    }
  }

  writeRaw(next);
  return getThinking();
}

/** 某个模型现在该用哪个档位（模型自己的设置优先，否则用全局） */
export function levelFor(modelId) {
  const t = getThinking();
  return t.perModel[modelId] ?? t.level;
}

/**
 * 把 auto 解析成具体档位。
 *
 * 规则跟 dsh 那个插件一个思路，但简化成两档判断：
 *   - 这轮要调工具 / 刚调过工具 -> high（干活得想清楚）
 *   - 纯聊天                     -> low（便宜又快）
 * 显式选了档位的，原样返回。
 *
 * @param {string} level 配置里的档位（可能是 auto）
 * @param {{hasTools?:boolean, toolHeavy?:boolean}} ctx
 */
export function resolveLevel(level, ctx = {}) {
  if (!level) return 'off'; // 没设过就是关（原样返回 off，由 fieldsForLevel 翻成 disabled）
  if (level !== 'auto') return level;
  // auto：有工具要干 → high；纯聊天 → low。永远不挑 off（跟 dsh 插件一个约定）。
  if (ctx.toolHeavy || ctx.hasTools) return 'high';
  return 'low';
}

/**
 * 把档位翻译成真正发给网关的那一组字段。
 *
 * 这里是整个功能的要害，参数都是实测出来的（见下），不是照文档猜的：
 *
 *   | 发什么                          | 结果                     |
 *   |---------------------------------|--------------------------|
 *   | 什么都不发                       | **照样思考**（网关默认开） |
 *   | reasoning_effort: "off"         | **400**！网关不认这个字面值 |
 *   | reasoning_effort: "none"        | 完全不思考 ✅              |
 *   | thinking: { type: "disabled" }  | 完全不思考 ✅              |
 *   | reasoning_effort: "low/high"    | 思考，长度差不多           |
 *
 * 之前「关了还在想」的根因：代码把 off 原样发出去，网关回 400，
 * 降级逻辑以为「模型不支持这个字段」，于是把它整个删掉重发——变成"什么都不发"，
 * 而网关默认就是开思考。所以关掉档位时**必须显式发 disabled**，不能靠省略字段。
 *
 * @param {string} level 解析后的档位（auto 已经展开）
 * @returns {{fields: object, mode: 'off'|'effort'|'on'}}
 */
export function fieldsForLevel(level) {
  if (!level) return { fields: {}, mode: 'on' };
  if (level === 'off') {
    // 两条路一起发：thinking.type 是官方语义，reasoning_effort:"none" 是兜底。
    // 实测两条都有效，同时发也不冲突（网关都接受）。
    return { fields: { thinking: { type: 'disabled' }, reasoning_effort: 'none' }, mode: 'off' };
  }
  if (level === 'on') {
    // 「开」= 打开思考、强度交给模型默认。显式 enabled 比省略字段更明确。
    return { fields: { thinking: { type: 'enabled' } }, mode: 'on' };
  }
  return { fields: { reasoning_effort: level }, mode: 'effort' };
}

/** 兼容旧调用：给 body 加档位字段 */
export function withEffort(body, level) {
  const { fields, mode } = fieldsForLevel(level);
  if (!Object.keys(fields).length) return { body, effort: null };
  return { body: { ...body, ...fields }, effort: level ?? null, mode };
}

/**
 * 这个错误是不是「上下文塞爆了」，而且带上游报的窗口大小。
 *
 * 这是 2026-10-27 补的：真会话已经到 104 万 token（compress.mjs 自己都算得出来），
 * 而压不压的线是 80%×窗口 = 104.8 万 —— 一直卡在「马上要压、又还没到线」的缝里。
 * 上游这时候直接回 400 context_length_exceeded，而 llm.mjs 原来遇到 400 就立刻抛错，
 * 一个字都不试着救。主人看到的就是「聊两句就爆」。
 *
 * 所以这里认出这类报错，顺便把上游自己说的窗口捞出来，让 llm.mjs 能当场压到那个数以内。
 * @returns {number|null} 上游报的窗口大小（认不出就是 null）
 */
export function contextOverflowSize(status, text) {
  if (status !== 400 && status !== 413 && status !== 422) return null;
  const t = String(text ?? '');
  const hit = /context[_ ]length|context_length_exceeded|maximum context|too many tokens|exceeds? the maximum|prompt is too long|input is too long/i.test(t);
  if (!hit) return null;
  //
  // 报错里常常两个数一起出现：请求量 + 窗口量，谁大谁小都不一定
  // （实测两种都遇过：「maximum context length is 1048576 tokens. However, you requested
  //   1045901 tokens」请求量比窗口小；「prompt is too long: 1200000 tokens > 1048576」请求量大）。
  // 所以不能只靠大小猜，先认「窗口」旁边那个数。
  const WIN_NEAR = /(?:maximum context\s*length\s*is|maximum\s*(?:context|prompt)?\s*(?:length|size)?\s*(?:is|=)?\s*|context\s*(?:length|window)\s*(?:is|=|of)?\s*|max(?:imum)?\s*=?\s*|limit\s*(?:is|=)?\s*|>\s*)(\d{4,9})/i;
  const near = t.match(WIN_NEAR);
  if (near) {
    const n = Number(near[1]);
    if (Number.isFinite(n) && n >= 4096) return n;
  }
  const nums = (t.match(/\d{4,9}/g) || []).map(Number).filter((n) => n >= 4096);
  if (!nums.length) return -1; // 认出来了，但没说大小
  // 没有上下文线索：取最小的那个（窗口通常比超量的请求还小）
  return Math.min(...nums);
}

/**
 * 这个错误是不是「模型不认 reasoning 字段」。
 *
 * 注意检查的是 `reasoning_effort` / `thinking` 这一类参数名，
 * 不能拿 off 本身当判据——网关对 "off" 回的正是 unsupported reasoning effort，
 * 但那是「值不合法」，不是「这个模型不支持思考」。
 */
export function isUnsupportedEffortError(status, text) {
  const t = String(text ?? '');
  if (status !== 400 && status !== 422) return false;
  return /reasoning_effort|reasoning effort|reasoning\.effort|thinking|UNSUPPORTED_REASONING|unknown.*parameter/i.test(t);
}

/**
 * 这个错误是不是「模型压根不支持思考」——只在这种情况下才降级。
 * 判据：报错里点名 reasoning/thinking 字段，且不是「值不合法」那种。
 */
export function isThinkingUnsupported(status, text) {
  const t = String(text ?? '');
  if (!isUnsupportedEffortError(status, text)) return false;
  // 网关说 "unsupported reasoning effort: off" 属于值不对，重试用别的值没意义
  return /unknown|not support|unsupported parameter|unrecognized|unexpected/i.test(t)
    && !/unsupported reasoning effort/i.test(t);
}

/** 降档顺序：失败时依次往下降，最后退到「什么都不发」 */
function fallbackChain(level) {
  if (level === 'off' || level === 'on') return [level, null];
  const i = EFFORT_ORDER.indexOf(level);
  if (i < 0) return [null];
  const chain = [level];
  for (let k = i - 1; k >= 0; k--) chain.push(EFFORT_ORDER[k]);
  chain.push(null);
  return [...new Set(chain)];
}

/**
 * 依次尝试「当前档 → 更低档 → 不带这个字段」。
 *
 * @param {(body:object, level:string|null) => Promise<any>} attempt
 *   用给定的请求体真正发一次；返回 result，抛错要带上 status / text
 * @param {object} baseBody 原始请求体
 * @param {string|null} level 解析后的档位
 */
export async function attemptWithFallback(attempt, baseBody, level) {
  const chain = fallbackChain(level);
  let lastErr = null;
  for (const lv of chain) {
    const { body } = withEffort(baseBody, lv);
    try {
      return { result: await attempt(body, lv), effort: lv ?? null };
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? 0;
      const text = err?.text ?? err?.message ?? '';
      // 只有「模型不支持思考」才降档；key 错、网络断、参数值不合法都直接抛。
      if (!isThinkingUnsupported(status, text)) throw err;
    }
  }
  throw lastErr ?? new Error('思考档位降级也没成');
}

/** 界面/顶栏用的一句说明 */
export function levelName(id) {
  return LEVELS.find((l) => l.id === id)?.name ?? id;
}
