/**
 * 思考档位（对齐 dsh-thinking-levels 的思路，按这个平台的体量做简化版）。
 *
 * 三件事：
 *   1. 每套模型能存一个默认档位（关 / 低 / 高 / 最高）
 *   2. 发请求时把档位翻译成**这家网关认的那组字段**再塞进去（见 thinkingFormatOf）
 *   3. 拿不准的模型不发这些字段（非推理模型收到会 400），所以能自动降级
 *
 * 存在 .state/thinking.json：{ level: 'off', perModel: { '<host>/<model>': 'low' } }
 */
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
/* 只为了「接入点 id → 地址/模型名」，好把 perModel 的键算成稳定键。
 * models.mjs 只 import config，不回头 import 本文件 —— 不成环。 */
import { endpointFor, listModels, ENV_ID } from './models.mjs';
/* 【2026-11-10 D2·原子写】thinking.json 之前用裸 writeFileSync 直接盖，
 * 进程被杀 / 断电那一刻会留半截 JSON，档位设置整个丢。统一走 writeFileAtomic。 */
import { writeFileAtomic } from './sessions-core.mjs';

const FILE = join(config.dataDir, '.state', 'thinking.json');

/**
 * 能手动选的档位。auto 是「按工具历史自动调度」，不发这个值出去。
 *
 * 【2026-11-09 主人定·只留官方三档：低 / 高 / 最高，默认高】
 *
 * 原来抄了 dsh 的八档（off/on/minimal/low/medium/high/xhigh/max + auto）。
 * 实测下来两件事：
 *   · 「关」「开」不是真正的强度值，行为全看接入点 —— 有的接入点把「开」
 *     当成不思考，长会话里就退化成整整一轮只回一句「嗯，我在」；
 *   · minimal / medium / xhigh 跟相邻档实测没区别，纯属选项太多。
 *
 * 主人原话：「把思考档位只保留 deepseek 官方的那种低、高与最高」「默认档位为高」。
 */
export const LEVELS = [
  { id: 'off', name: '关', desc: '完全不思考，直接把答案说出来' },
  { id: 'low', name: '低', desc: '简单对话，便宜又快' },
  { id: 'high', name: '高', desc: '官方默认档，稳' },
  { id: 'max', name: '最高', desc: '重任务，舍得花时间' },
];

/**
 * 老配置里的档位怎么落到这四档上。
 * 会话/模型里存着 on、minimal、medium、xhigh 的，读到就当场换算，不用主人手动改一遍。
 */
export function normalizeLevel(v) {
  const s = String(v ?? '').trim();
  if (s === 'off' || s === 'low' || s === 'high' || s === 'max') return s;
  if (s === 'minimal') return 'low';
  if (s === 'xhigh') return 'max';
  /* on / medium / auto / 空 / 认不出的，一律落到默认的「关」 */
  return 'off';
}

const LEVEL_IDS = new Set(LEVELS.map((l) => l.id));
/** 强度梯度（off 不是强度值，单独处理） */
const EFFORT_ORDER = ['low', 'high', 'max'];

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
  writeFileAtomic(FILE, JSON.stringify(data, null, 2));
}

/** 全局默认档位 + 每个模型的覆盖值 */
/**
 * 【2026-11-10 D6·孤儿键惰性清洗】
 *
 * perModel 的键有两代：老键是接入点 id（模型一删一建 id 就变，设置落在再也没人读的键上，
 * 实测盘上就躺着 `mmvkk4li5x2td: off` 这种真孤儿），新键是 host/model 稳定键。
 * 读侧（getThinking）顺手把「跟现有任何接入点的 id、host/model 稳定键都对不上」的键清掉，
 * 并当场落盘一次。节流：**每进程生命周期最多清一次**（模块级布尔）——
 * 就算第一次读的时候模型表还没就绪、清不成，也不再反复试，读路径必须保持便宜。
 *
 * 「只清真孤儿」：id 键和稳定键是**并存**的（见 setThinking 的双键存储），
 * 键只要跟两边任意一边对得上就留着，绝不动。
 */
let __orphanSwept = false;

function sweepOrphanPerModelKeys(perModel) {
  if (__orphanSwept) return null;
  __orphanSwept = true;
  try {
    const keys = Object.keys(perModel || {});
    if (!keys.length) return null;
    /* 有效键全集：所有接入点的 id + 它们的稳定键。.env 那条也认（它一直是个合法 id）。 */
    const validIds = new Set([ENV_ID]);
    const stableKeys = new Set();
    for (const m of listModels().models) {
      if (m && m.id) validIds.add(String(m.id));
      const sk = perModelKeyOf(m);
      if (sk) stableKeys.add(sk);
    }
    const killed = keys.filter((k) => !validIds.has(k) && !stableKeys.has(k));
    if (!killed.length) return null;
    const cleaned = { ...perModel };
    for (const k of killed) delete cleaned[k];
    try { console.log('[thinking] 清掉 ' + killed.length + ' 个孤儿键：' + killed.join(', ').slice(0, 200)); } catch {}
    return cleaned;
  } catch {
    /* 模型表读不出来就别清 —— 宁可多留几个死键，也不能误删活设置 */
    return null;
  }
}

export function getThinking() {
  const raw = readRaw();
  /**
   * 【2026-11-09 改】默认「高」。
   *
   * 原来的默认是 off（完全不思考），理由是「网关对不认识的字段会掐流」。
   * 可实测发现另一头更糟：不思考 + 长会话 = 整轮只回一句「嗯，我在」。
   * 现在只有三档，且默认高 —— 稳比省那点 token 重要。
   *
   * 老配置里存的 off/on/minimal… 在这里**当场换算**，不用主人挨个改。
   */
  const level = normalizeLevel(raw.level);
  const perModel = raw.perModel && typeof raw.perModel === 'object' ? raw.perModel : {};
  const clean = {};
  for (const [k, v] of Object.entries(perModel)) {
    if (v === null || v === '') continue;
    clean[k] = normalizeLevel(v);
  }
  /* 【2026-11-10 D6】读侧顺手清孤儿键，清动了就落盘一次（每进程最多一次）。 */
  const swept = sweepOrphanPerModelKeys(clean);
  if (swept) {
    writeRaw({ level, perModel: swept });
    return { level, perModel: swept };
  }
  return { level, perModel: clean };
}

/** 改全局默认 / 某个模型的档位 */
export function setThinking(input = {}) {
  const cur = getThinking();
  const next = { level: cur.level, perModel: { ...cur.perModel } };

  if (input.level !== undefined) {
    /* 先换算再校验：老值（off/on/minimal/medium/xhigh）不该报错，
     * 它们都还能落到「低/高/最高」里的某一档。 */
    const lv = normalizeLevel(input.level);
    if (!LEVEL_IDS.has(lv)) {
      const e = new Error(`没有这个思考档位：${input.level}`);
      e.status = 400;
      throw e;
    }
    /* 老档位（off/on/minimal/medium/xhigh）一律换算成三档之一，不报错 ——
     * 界面上还有旧缓存、或者外部脚本还在传老值时，不该因此改不动设置。 */
    next.level = normalizeLevel(input.level);
  }

  if (input.modelId !== undefined) {
    const id = String(input.modelId);
    /* 稳定键：地址 + 模型名。模型删了重建、id 变了，这条设置还认得回来。 */
    const stable = perModelKeyOf(asEndpoint(id));
    if (input.modelLevel === null || input.modelLevel === '') {
      delete next.perModel[id];
      /* 稳定键一起删掉，否则「清掉这个模型的设置」会被稳定键又盖回来 */
      if (stable) delete next.perModel[stable];
    } else if (LEVEL_IDS.has(input.modelLevel) || normalizeLevel(input.modelLevel)) {
      const lv = normalizeLevel(input.modelLevel);
      /* 两个键都写：
       *   · 稳定键给「重新加同一个模型」用（真正的长期存储）；
       *   · id 键给界面用（模型面板读的是 perModel[activeId]，见 public/index.html 的 paintThink）。
       * 读的时候稳定键优先，所以老键就算留着也不会盖掉新值。 */
      next.perModel[id] = lv;
      if (stable) next.perModel[stable] = lv;
    } else {
      const e = new Error(`没有这个思考档位：${input.modelLevel}`);
      e.status = 400;
      throw e;
    }
  }

  writeRaw(next);
  return getThinking();
}

/**
 * 从接入点地址里取「主机」（含端口，小写）。取不到就给空串，绝不抛。
 *
 * @param {string} baseURL 形如 https://napi.wanzij.cn/v1
 * @returns {string} 'napi.wanzij.cn'
 */
export function hostOf(baseURL) {
  const raw = String(baseURL ?? '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).host.toLowerCase();
  } catch { /* 不是合法 URL 就手工抠一段，别让一个脏配置把整轮弄挂 */ }
  const m = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').match(/^[^/?#]+/i);
  return m ? m[0].toLowerCase() : '';
}

/** 认得的四种「思考方言」 */
export const THINKING_FORMATS = ['openai', 'deepseek', 'zai', 'qwen'];
const FORMAT_SET = new Set(THINKING_FORMATS);

/** 某个接入点现在该用哪一档（模型自己的设置优先，键可能是稳定键或老的 id 键） */
export function levelFor(target) {
  const t = getThinking();
  const ep = asEndpoint(target);
  /* 先认稳定键（host/模型名）—— 模型被删了重建、id 变了也还认得出来。
   * 再退回老的 id 键（兼容主人已经存下的设置）。最后才用全局。 */
  const stable = perModelKeyOf(ep);
  if (stable && t.perModel[stable] !== undefined) return normalizeLevel(t.perModel[stable]);
  const id = typeof target === 'string' ? String(target).trim() : String(ep?.id ?? '');
  if (id && t.perModel[id] !== undefined) return normalizeLevel(t.perModel[id]);
  return normalizeLevel(t.level);
}

/**
 * 这个接入点说的是哪家的「思考方言」。
 *
 * 为什么必须分：同一件事（关思考 / 开思考），各家认的字段完全不一样 ——
 * 实测（2026-11-09，两台网关四种写法都试过）：
 *
 *   | 请求体                          | 飞鱼 ai.feiyuapi.top | 丸子 napi.wanzij.cn |
 *   |--------------------------------|----------------------|---------------------|
 *   | 什么都不发                       | 19 tok ❌ 还在想      | 22 tok ❌ 还在想     |
 *   | reasoning_effort:"none"         | 0 ✅                 | 49 tok ❌ 静默忽略   |
 *   | thinking:{type:"disabled"}      | 0 ✅                 | 0 ✅                |
 *   | reasoning_effort:"off"          | 200 / 0 tok          | **HTTP 400** ❌      |
 *
 * 两条铁律由此而来：
 *   · 关思考**永远**带上 `thinking.type='disabled'`（唯一全网关都认的写法）；
 *   · `reasoning_effort` 这个字段只在 openai 方言下发，而且**永不发 'off' 字面值**。
 *
 * @param {object|null} ep 接入点（{ baseURL, model, id }）
 * @returns {'openai'|'deepseek'|'zai'|'qwen'}
 */
export function thinkingFormatOf(ep) {
  /* 少数自建/中转接入点说不清是哪家，允许在配置里直接写 thinkingFormat 指定 */
  const forced = String(ep?.thinkingFormat ?? '').trim().toLowerCase();
  if (FORMAT_SET.has(forced)) return forced;
  const host = hostOf(ep?.baseURL);
  if (!host) return 'openai';
  if (host.includes('api.deepseek.com')) return 'deepseek';
  /* 智谱：开放平台 bigmodel.cn，企业版 open.bigmodel.cn，老名字 zhipu */
  if (host.includes('bigmodel.cn') || host.includes('zhipu')) return 'zai';
  /* 通义 / 百炼：dashscope.aliyuncs.com，国际站 dashscope-intl.aliyuncs.com */
  if (host.includes('dashscope') || host.includes('aliyuncs')) return 'qwen';
  return 'openai';
}

/**
 * perModel 的稳定键：主机 + '/' + 模型名。
 *
 * 【为什么要换】老的键是接入点 id（如 mmvkk4li5x2td）。模型一删一建 id 就变，
 * 于是主人设的档位落在一个再也没人读的孤儿键上 —— 实测 .state/thinking.json 里
 * `mmvkk4li5x2td: off` 就是一个已经不在 models.json 里的 id。
 * 换成「地址 + 模型名」之后，重新加同一个模型还是同一个键。
 *
 * @returns {string} 'ai.feiyuapi.top/deepseek-v4.1-flash'（算不出来就是空串）
 */
export function perModelKeyOf(ep) {
  const host = hostOf(ep?.baseURL);
  const model = String(ep?.model ?? '').trim();
  if (!host || !model) return '';
  return host + '/' + model;
}

/** 把「接入点对象」或「接入点 id」统一成接入点对象（认不出就 null） */
function asEndpoint(target) {
  if (!target) return null;
  if (typeof target === 'object') return target.baseURL || target.model ? target : null;
  const id = String(target).trim();
  if (!id) return null;
  try {
    return endpointFor(id);
  } catch {
    return null;
  }
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
  /* 【2026-11-09 简化】只有 关/低/高/最高 四档，不再有 auto 调度。
   * 老值（on/medium/minimal/xhigh/auto）由 normalizeLevel 统一换算 ——
   * ctx 留着是为了兼容旧调用点，暂时不用。 */
  void ctx;
  return normalizeLevel(level);
}

/**
 * 把档位翻译成真正发给网关的那一组字段（**按接入点的方言分派**）。
 *
 * 这里是整个功能的要害，参数都是实测出来的（见 thinkingFormatOf 上方的表），
 * 不是照文档猜的。四种方言 × 四个档位的对照：
 *
 *   | 档位          | openai（默认）                        | deepseek                | zai                                        | qwen                             |
 *   |---------------|---------------------------------------|-------------------------|--------------------------------------------|----------------------------------|
 *   | off           | thinking:{type:disabled} + effort:none | thinking:{type:disabled} | thinking:{type:disabled, clear_thinking:false} | thinking:{type:disabled} + enable_thinking:false |
 *   | low/high/max  | reasoning_effort: 档位                 | thinking:{type:enabled} | thinking:{type:enabled, clear_thinking:false} | enable_thinking:true             |
 *
 * ── deepseek 官方：不认 reasoning_effort，三档等价 ────────────────
 *
 * 实测 2026-11-09，接入点 mmvjvxqzcxple（api.deepseek.com / deepseek-flash），
 * 交错采样 10 轮、"鸡兔同笼"、max_tokens=4000，看 usage.completion_tokens_details
 * .reasoning_tokens 的中位数：
 *
 *   | 发什么                      | reasoning_tokens 中位 | 区间     |
 *   |----------------------------|----------------------|----------|
 *   | 什么都不发（对照）            | 84                   | 58~93    |
 *   | thinking:{type:enabled}     | 74.5                 | 68~92    |
 *   | reasoning_effort:low        | 77.5                 | 62~88    |
 *   | reasoning_effort:high       | 77.5                 | 66~94    |
 *   | reasoning_effort:max        | 78                   | 61~128   |
 *   | thinking:{type:disabled}     | 没有（null），正文 3 tok | —      |
 *
 * 判据：低/高/最高 三档相对「什么都不发」的差（-6.5 / -6.5 / -6）全都落在
 * 对照组自身抖动（35 tok）以内 —— 也就是说**这个字段对思考长度没有任何影响**，
 * 而且是 HTTP 200 静默忽略，不报错。
 *
 * 所以 deepseek 方言只发开/关：`thinking:{type:'enabled'|'disabled'}`。
 * 主人在这类接入点上选「低/高/最高」发出去的东西一模一样 —— 这是上游的限制，
 * 不是我们的 bug。**别再改成发 reasoning_effort**，实测过没用。
 * （界面上想提示「该模型只有开/关」是另一件事，要主人点头再动。）
 *
 * 唯一的例外是 host 里带 deepseek 但其实是中转站的（比如 ai.feiyuapi.top），
 * 那种会被判成 openai 方言，走 reasoning_effort —— 实测那家是认的。
 *
 * 两条铁律（改动这里请先读一遍）：
 *   1. 关档位**永远**带 `thinking.type='disabled'` —— 这是唯一全网关都认的关闭写法。
 *      光发 `reasoning_effort:'none'` 在丸子那种网关上会被静默忽略（实测照样 49 tok）。
 *   2. `reasoning_effort` 只在 openai 方言下发，且**永不发 'off' 字面值** ——
 *      丸子网关对它回 HTTP 400 `unsupported reasoning effort: "off"`。
 *
 * 之前「关了还在想」的根因：代码把 off 原样当成本值发出去，网关回 400，
 * 降级逻辑以为「模型不支持这个字段」，于是把它整个删掉重发 —— 变成"什么都不发"，
 * 而网关默认就是开思考。所以关掉档位时**必须显式发 disabled**，不能靠省略字段。
 *
 * @param {string} level 解析后的档位（off/low/high/max；老值当场换算）
 * @param {object|null} [ep] 这一轮用的接入点；不传按 openai 方言（保住老调用点行为）
 * @returns {{fields: object, mode: 'off'|'effort'|'on'}}
 */
export function fieldsForLevel(level, ep = null) {
  if (!level) return { fields: {}, mode: 'on' };
  /* null / '' 是降级链里「什么都不发」那一档，上面已经挡掉了。
   * 剩下的一律先换算成四档之一，别把 on / medium / xhigh 这些老值漏给网关。 */
  const lv = normalizeLevel(level);
  const fmt = thinkingFormatOf(ep);

  if (lv === 'off') {
    if (fmt === 'zai') {
      // 智谱认 clear_thinking（要不要把上一轮的思考清掉），这里明确清掉
      return { fields: { thinking: { type: 'disabled', clear_thinking: false } }, mode: 'off' };
    }
    if (fmt === 'qwen') {
      // 通义/百炼的原生开关是 enable_thinking，但 thinking.type 也认，两个一起发最稳
      return { fields: { thinking: { type: 'disabled' }, enable_thinking: false }, mode: 'off' };
    }
    if (fmt === 'deepseek') {
      /* 【2026-11-09 实测】官方不认 reasoning_effort（交错采样 10 轮，
       * low/high/max 的 reasoning_tokens 中位 77.5/77.5/78，相对「什么都不发」
       * 的 84 全在噪声内）。所以这里只发开关，别加 effort —— 加了也白发。
       * 详见上方方言表下的实测记录。 */
      return { fields: { thinking: { type: 'disabled' } }, mode: 'off' };
    }
    // openai 方言（含所有没认出来的中转站）：两条路一起发，
    // thinking.type 是官方语义，reasoning_effort:'none' 是给只认这个字段的网关兜底。
    return { fields: { thinking: { type: 'disabled' }, reasoning_effort: 'none' }, mode: 'off' };
  }

  if (fmt === 'deepseek') {
    /* 官方只有「开/关」一个布尔语义，强度由模型自己定。
     * 实测（2026-11-09）它连 reasoning_effort 都不认，三档发出去一模一样，
     * 详见上方方言表下的实测记录。所以这里刻意不带 effort。 */
    return { fields: { thinking: { type: 'enabled' } }, mode: 'on' };
  }
  if (fmt === 'zai') {
    return { fields: { thinking: { type: 'enabled', clear_thinking: false } }, mode: 'on' };
  }
  if (fmt === 'qwen') {
    return { fields: { enable_thinking: true }, mode: 'on' };
  }
  return { fields: { reasoning_effort: lv }, mode: 'effort' };
}

/**
 * 兼容旧调用：给 body 加档位字段。
 *
 * @param {object} body 原始请求体
 * @param {string|null} level 档位
 * @param {object|null} [ep] 这一轮用的接入点（决定用哪家方言）
 */
export function withEffort(body, level, ep = null) {
  const { fields, mode } = fieldsForLevel(level, ep);
  if (!Object.keys(fields).length) return { body, effort: null, mode };
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

/**
 * 降档顺序：失败时依次往下降，最后退到「什么都不发」。
 *
 * 【关 档位不再退到「什么都不发」】以前 off 的链是 [off, null]，
 * 可「什么都不发」在这个网关上的意思正是**开思考** —— 退到那一步等于把
 * 主人亲手关掉的思考又打开了（就是「关了还在想」这个 bug 的一半）。
 * 现在 off 只试一次，真被拒就老实报错。
 */
function fallbackChain(level) {
  if (level === 'off') return ['off'];
  if (level === 'on') return ['on', null];
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
 * @param {object|null} [ep] 这一轮用的接入点（决定字段用哪家方言）
 */
export async function attemptWithFallback(attempt, baseBody, level, ep = null) {
  const chain = fallbackChain(level);
  let lastErr = null;
  for (const lv of chain) {
    const { body } = withEffort(baseBody, lv, ep);
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
