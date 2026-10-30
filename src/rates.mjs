// 各家的价目表 + 一轮花多少钱
//
// 为什么要有这张表：模型接口只告诉你「用掉多少 token」，不告诉你「多少钱」。
// 各家单价差得很远（DeepSeek flash 输出 8 元/百万，GLM-5.3 输出 28 元/百万），
// 而且同一家还有缓存命中折扣、有峰谷价 —— 不自己算就只能看个数字干瞪眼。
//
// 价格单位一律是「元 / 百万 token」，跟各家官网标价一致，照着抄就行。
//
// 键的规则：先按模型名精确找，找不到再按前缀/后缀模糊找（deepseek-v4-pro-0813
// 会命中 deepseek-v4-pro 那条）。认不出来就不算钱，只显示 token 数 —— 宁可不说，
// 也别报个假价格。

/**
 * 价目表。形如：
 *   { hit, miss, output, win?, off?, currency?, same? }
 *     hit    缓存命中的输入单价（没有缓存机制就填成和 miss 一样）
 *     miss   缓存未命中的输入单价
 *     output 输出单价
 *     三档默认就是「高峰价」（各家官网上标的那组）。
 *     win    可选，这个模型的上下文窗口。填了就以它为准，不再去下面 WINDOWS 里猜。
 *     off    可选，谷价：{ when:{days,ranges}, hit, miss, output }
 *            只有 DeepSeek 这种分峰谷的才写；没写的是一口价。
 *
 * 数据核对时间见每条注释。价格会变，主人自己改这个文件就行，不用动别的代码。
 *
 * 2026-11 大核一遍的依据：这份表以前有一半是「照印象填的整数」，一查就错。
 * 现在除 DeepSeek / 智谱（有国内官网可对）以外，一律以 LiteLLM 的
 * model_prices_and_context_window.json 为准，美元牌价 × 7.2 换成元。
 */
const RATES = {
  // ── DeepSeek 官方（2026-10 核对 api-docs.deepseek.com/zh-cn/quick_start/pricing）──
  // 高峰＝北京时间周一至五 9:00-12:00、14:00-18:00；谷价是峰价的一半
  'deepseek-flash': {
    hit: 0.04, miss: 2, output: 8,
    off: { when: { days: [1, 2, 3, 4, 5], ranges: [['09:00', '12:00'], ['14:00', '18:00']] }, hit: 0.02, miss: 1, output: 4 },
  },
  'deepseek-v4-pro': {
    hit: 0.3, miss: 9, output: 27,
    off: { when: { days: [1, 2, 3, 4, 5], ranges: [['09:00', '12:00'], ['14:00', '18:00']] }, hit: 0.15, miss: 4.5, output: 13.5 },
  },
  // 旧名还在服，按 flash 价计费（官方脚注 1），老配置别报「认不出来」
  'deepseek-v4-flash': { hit: 0.04, miss: 2, output: 8, same: 'deepseek-flash' },
  'deepseek-v4.1-flash': { hit: 0.04, miss: 2, output: 8, same: 'deepseek-flash' },
  'deepseek-v4-pro-0813': { hit: 0.3, miss: 9, output: 27, same: 'deepseek-v4-pro' },

  // ── 智谱 GLM（一口价，无峰谷）──
  // 2026-11 核实：单价这六条对得住官网，但窗口全写小了 —— 5.x 系列实际都是 1M 档，不是 128k。
  // 窗口写小了不会报错，只会「压得太勤」，白花压摘要的钱。
  'glm-5.3': { hit: 2, miss: 8, output: 28, win: 1048576 },
  'glm-5.2': { hit: 2, miss: 8, output: 28, win: 1048576 },
  'glm-5.3-flash': { hit: 0.23, miss: 0.8, output: 2.8, win: 1048576 },
  'glm-4.7': { hit: 1, miss: 4, output: 16, win: 200000 },
  'glm-4.7-flash': { hit: 0.15, miss: 0.5, output: 2, win: 200000 },
  'glm-4.5-air': { hit: 0.1, miss: 0.4, output: 1.6, win: 128000 },

  // ── 阿里云百炼（qwen 系列各自定价，这里给常用档）──
  // 2026-11 核实：以前这四条全是「猜的整数」（2.4/12/48、0.4/2/8），
  // 对的只有 qwen-plus 那条。实际官方价差得多，尤其输出价普遍是输入价的 3 倍而不是 4 倍。
  'qwen3.8-max': { hit: 0.25, miss: 2, output: 6, win: 991808 },
  'qwen3.7-max': { hit: 0.5, miss: 2.5, output: 7.5, win: 991808 },
  'qwen3.7-plus': { hit: 0.4, miss: 2, output: 8, win: 991808 },
  'qwen3.8-flash': { hit: 0.016, miss: 0.15, output: 0.47, win: 991808 },
  'qwen-plus': { hit: 0.4, miss: 2, output: 8, win: 129024 },

  // ── 月之暗面 Kimi（2026-11 核实，官方 API 美元价 × 7.2）──
  // 以前 k3 填 4/20/80、k2.6 填 1/4/16，都比官方标价高出两三成，
  // k2.7-code 跟 k2.6 同价但缓存单价不一样（0.19 vs 0.16 美元），以前抹平成一样了。
  'kimi-k3': { hit: 2.16, miss: 21.6, output: 108, win: 1048576 },
  'kimi-k2.6': { hit: 1.15, miss: 6.84, output: 28.8, win: 262144 },
  'kimi-k2.7-code': { hit: 1.37, miss: 6.84, output: 28.8, win: 262144 },
  'kimi-k2.5': { hit: 0.72, miss: 4.32, output: 21.6, win: 262144 },

  // ── 硅基流动（转卖多家模型，价随模型走）──
  'deepseek-ai/DeepSeek-V4.1-Flash': { hit: 0.14, miss: 1.4, output: 5.6 },
  'deepseek-ai/DeepSeek-V4-Pro': { hit: 0.3, miss: 9, output: 27 },
  'Qwen/Qwen3.8-Max': { hit: 2.4, miss: 12, output: 48 },

  // ── OpenAI（美元换算成人民币按 7.2 算，主人在国内看的都是元）──
  // 2026-11 核实：以前 gpt-5 / gpt-4.1 / gpt-4o-mini / o4-mini 的输入输出都是旧牌价，
  // 而且全把缓存命中写成了「跟没命中一个价」（等于认定它没有缓存折扣）。
  // 其实 gpt-5 输出早就从 10 美元降到 …没降，是以前这里多算了一倍（旧值 720＝100 美元）。
  'gpt-5': { hit: 0.9, miss: 9, output: 72, win: 272000 },
  'gpt-5-mini': { hit: 0.18, miss: 1.8, output: 14.4, win: 272000 },
  'gpt-4.1': { hit: 3.6, miss: 14.4, output: 57.6, win: 1047576 },
  'gpt-4.1-mini': { hit: 0.72, miss: 2.88, output: 11.52, win: 1047576 },
  'gpt-4o': { hit: 9, miss: 18, output: 72, win: 128000 },
  'gpt-4o-mini': { hit: 0.54, miss: 1.08, output: 4.32, win: 128000 },
  'o4-mini': { hit: 1.98, miss: 7.92, output: 31.68, win: 200000 },

  // ── Anthropic Claude（2026-11 核实，美元价 × 7.2）──
  // 以前这张表里根本没有 claude —— 主人要是把模型换成 claude 系列，
  // 界面就不显示钱，只说 token 数。补上。
  // 注意：claude 的缓存是「写」另外收费（比原价贵 25%），这里只记「读」的折扣价。
  'claude-opus-5': { hit: 3.6, miss: 36, output: 180, win: 1000000 },
  'claude-opus-4-7': { hit: 3.6, miss: 36, output: 180, win: 1000000 },
  'claude-opus-4-6': { hit: 3.6, miss: 36, output: 180, win: 1000000 },
  'claude-opus-4-5': { hit: 3.6, miss: 36, output: 180, win: 200000 },
  'claude-sonnet-5': { hit: 1.44, miss: 14.4, output: 72, win: 1000000 },
  'claude-sonnet-4-6': { hit: 2.16, miss: 21.6, output: 108, win: 1000000 },
  'claude-sonnet-4-5': { hit: 2.16, miss: 21.6, output: 108, win: 200000 },
  'claude-haiku-5-5': { hit: 0.072, miss: 0.72, output: 3.6, win: 1000000 },
  'claude-haiku-4-5': { hit: 0.72, miss: 7.2, output: 36, win: 200000 },

  // ── Mistral（2026-11 核实，美元价 × 7.2）──
  'mistral-large-3': { hit: 0.36, miss: 3.6, output: 10.8, win: 262144 },
  'mistral-large-4': { hit: 0.49, miss: 4.9, output: 15.05, win: 1048576 },
  'mistral-medium-3.5': { hit: 1.08, miss: 10.8, output: 54, win: 262144 },
  'mistral-small': { hit: 0.072, miss: 0.72, output: 4.32, win: 262144 },
  'devstral': { hit: 0.29, miss: 2.88, output: 14.4, win: 256000 },
  'codestral': { hit: 0.22, miss: 2.16, output: 6.48, win: 128000 },

  // ── Groq（跑开源模型，便宜到离谱；2026-11 核实，美元价 × 7.2）──
  'llama-3.3-70b': { hit: 0.43, miss: 0.43, output: 0.5, win: 131072 },
  'gpt-oss-120b': { hit: 0.54, miss: 1.08, output: 4.32, win: 131072 },
  'gpt-oss-20b': { hit: 0.27, miss: 0.54, output: 2.16, win: 131072 },

  // ── 其它常见 ──
  // MiniMax（2026-11 按官方 API 牌价再核一遍）
  // M3.1-Flash：输入 1.00 / 输出 4.00 / 缓存读 0.10（元，没变）
  // M3：牌价 $0.3 / $1.2、命中 $0.06，× 7.2 就是 2.16 / 8.64。以前填的 2.10/8.40 是按
  //     「永久五折」算的实付价，活动结束后就得按牌价。M2.7 已从官网下架，不填。
  'MiniMax-M3.1-Flash': { hit: 0.1, miss: 1, output: 4 },
  'MiniMax-M3': { hit: 0.43, miss: 2.16, output: 8.64 },

  // ── xAI（2026-11 核实：grok-4 已经下架，grok-4.3 是 1.25/2.5 美元一口价，
  //    grok-4.5 之后涨到 2/6。以前 grok-4 填 22/22/108（美元 3/3/15）早过期了。──
  'grok-4.6': { hit: 3.6, miss: 14.4, output: 43.2, win: 500000 },
  'grok-4.5': { hit: 2.16, miss: 14.4, output: 43.2, win: 500000 },
  'grok-4.3': { hit: 1.44, miss: 9, output: 18, win: 1000000 },
  'grok-4.20': { hit: 1.44, miss: 9, output: 18, win: 1000000 },
  'grok-code-fast': { hit: 1.44, miss: 7.2, output: 14.4, win: 256000 },

  // ── Google Gemini（2026-11 核实）──
  // 以前 gemini-3-pro 填 9/9/72 是拿「$1.25/$1.25/$10」算的，pro 现在只有 3.1 预览版，
  // 价格是 $2/$12；顺带缓存命中也确实有折扣（$0.2），以前写成跟没命中一样。
  'gemini-3.1-pro': { hit: 1.44, miss: 14.4, output: 86.4, win: 1048576 },
  'gemini-3-flash': { hit: 0.36, miss: 3.6, output: 21.6, win: 1048576 },
};

/** 认不出模型时给个空壳，别再往下算 */
const UNKNOWN = null;

/**
 * 哪些模型的价格是「估算」而不是抄官方标价。
 *
 * 为什么要有这个标记：这台机器连不上 OpenAI / xAI / Google 的定价页，
 * 那几家的数字是按美元牌价 × 7.2 估的。不标出来的话，主人会以为那是准数，
 * 报销、对账的时候对不上。界面上会多打一个「估」字。
 *
 * 判定顺序：条目自带 est:true 就算；别名（same 指向另一条）跟着目标走。
 */
export function isEstimated(model) {
  const rate = rateOf(model);
  if (!rate) return false;
  if (rate.est) return true;
  if (rate.same && RATES[rate.same]) return Boolean(RATES[rate.same].est);
  return false;
}

/** 现在是不是「高峰」（只认北京时间周一至五的两个区间；法定节假日不扣，宁可多算不少算） */
function isPeak(when, now = new Date()) {
  if (!when) return false;
  // 换成北京时间。别用 getTimezoneOffset() 手算 —— 那玩意儿在某些机器上会因为
  // 系统时区设置跟实际偏移不同而错位（踩过，10:00 被判成了谷）。
  // Intl 走的是系统时区数据库，最稳。
  let bj;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour12: false,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(now);
    const get = (t) => (parts.find((p) => p.type === t) || {}).value;
    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const day = dayMap[get('weekday')];
    const hm = Number(get('hour')) * 60 + Number(get('minute'));
    bj = { day, hm };
  } catch {
    // Intl 不支持时区（极老的运行时）就退回本地时间，至少不会崩
    bj = { day: now.getDay(), hm: now.getHours() * 60 + now.getMinutes() };
  }
  if (!Array.isArray(when.days) || !when.days.includes(bj.day)) return false;
  for (const [from, to] of when.ranges || []) {
    const [fh, fm] = String(from).split(':').map(Number);
    const [th, tm] = String(to).split(':').map(Number);
    if (bj.hm >= fh * 60 + fm && bj.hm < th * 60 + tm) return true;
  }
  return false;
}

/** 按模型名找一档价格；认不出返回 null */
function rateOf(model) {
  const name = String(model || '').trim();
  if (!name) return UNKNOWN;
  // 1) 精确
  if (RATES[name]) return RATES[name];
  // 2) 不分大小写精确
  const lower = name.toLowerCase();
  for (const k of Object.keys(RATES)) {
    if (k.toLowerCase() === lower) return RATES[k];
  }
  // 3) 模糊：按 key 从长到短试。
  //    必须先精确再模糊、且长的优先，否则 deepseek-v4.1-flash 会撞上
  //    deepseek-v4-flash 那条（踩过，价格虽然一样，但模型名报错了）。
  const keys = Object.keys(RATES).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const kl = k.toLowerCase();
    // 前缀命中（deepseek-v4-pro-0813 → deepseek-v4-pro）优先
    if (lower.startsWith(kl)) return RATES[k];
  }
  for (const k of keys) {
    const kl = k.toLowerCase();
    if (lower.includes(kl)) return RATES[k];
  }
  return UNKNOWN;
}

/**
 * 算这一轮花了多少钱。
 * @param {string} model 模型名
 * @param {{prompt_tokens?:number, completion_tokens?:number, prompt_cache_hit_tokens?:number, prompt_cache_miss_tokens?:number}} u
 * @param {Date} [now] 算峰谷用，测试时可以传固定时间
 * @returns {{cost:number, currency:string, rate:object, off:boolean, breakdown:{hit:number,miss:number,out:number}}|null}
 */
export function costOf(model, u, now = new Date()) {
  const rate = rateOf(model);
  if (!rate || !u) return null;
  // 分峰谷的：写着「谷」的那组时段（工作日 9-12、14-18）之外，一律按便宜的谷价。
  // 注意顶层那三档是「高峰价」，off 里才是「谷价」，别弄反（踩过）。
  const inPeakWindow = isPeak(rate.off && rate.off.when, now);
  const cur = rate.off && !inPeakWindow ? rate.off : rate;

  const pin = Number(u.prompt_tokens ?? 0);
  const pout = Number(u.completion_tokens ?? 0);
  // 缓存命中数：接口给了就用，没给说明不支持缓存，全按未命中算
  let hitTok = Number(u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0);
  let missTok = Number(u.prompt_cache_miss_tokens ?? 0);
  if (!missTok) missTok = Math.max(0, pin - hitTok);
  if (!hitTok && !missTok) missTok = pin;

  const per = 1e6;
  const cHit = (hitTok / per) * Number(cur.hit ?? cur.miss ?? 0);
  const cMiss = (missTok / per) * Number(cur.miss ?? 0);
  const cOut = (pout / per) * Number(cur.output ?? 0);

  return {
    cost: cHit + cMiss + cOut,
    currency: '元',
    rate: cur,
    peak: !inPeakWindow && Boolean(rate.off),
    est: Boolean(rate.est || (rate.same && RATES[rate.same] && RATES[rate.same].est)),
    breakdown: { hit: cHit, miss: cMiss, out: cOut },
  };
}

/** 给界面用：这个模型有没有价目（没有就别显示钱，免得误导） */
export function hasRate(model) {
  return Boolean(rateOf(model));
}

/** 价目表整个交出去（设置页也许要看） */
export function listRates() {
  return RATES;
}

/**
 * 各家模型的上下文窗口（token）。
 *
 * 为什么要单独一张表：压缩阈值设成「自动」时，得知道这个模型到底能吃多少。
 * 128000 和 1000000 的模型用同一个水位线是荒唐的 —— 一个压得太勤白花钱，
 * 一个压得太晚直接 400（超过窗口）。
 *
 * 键的匹配规则跟价目表一样（精确 → 前缀模糊）。查不到时用 FALLBACK_WINDOW，
 * 宁可保守一点：水位低了最多多压一次，水位高了是真的会请求失败。
 */
const WINDOWS = {
  // DeepSeek 官方文档明写 1M（api-docs.deepseek.com，2026-10 核对）
  'deepseek-flash': 1000000,
  'deepseek-v4-pro': 1000000,
  'deepseek-v4-flash': 1000000,
  'deepseek-v4.1-flash': 1000000,
  'deepseek-v4-pro-0813': 1000000,
  // 丸子中转是转发，窗口跟着上游走，按 DeepSeek 同档给
  deepseek: 1000000,
  // 智谱 GLM-5.x 系列 128k 档
  'glm-5.3': 128000,
  'glm-5.2': 128000,
  'glm-5.3-flash': 128000,
  'glm-4.7': 128000,
  'glm-4.7-flash': 128000,
  'glm-4.5-air': 128000,
  glm: 128000,
  // 阿里百炼 qwen3.x
  'qwen3.8-max': 256000,
  'qwen3.7-plus': 128000,
  'qwen3.8-flash': 128000,
  'qwen-plus': 128000,
  qwen: 128000,
  // Kimi k3 是 256k 档
  'kimi-k3': 256000,
  'kimi-k2.6': 128000,
  'kimi-k2.7-code': 128000,
  kimi: 128000,
  moonshot: 128000,
  // MiniMax M3 标称 512k（官方 pricing 页超 512k 另一档价，窗口不止 512k，保守取 512k）
  'MiniMax-M3': 512000,
  'MiniMax-M2.7': 204800,
  'MiniMax-M2.5': 204800,
  MiniMax: 204800,
  // OpenAI
  'gpt-5': 400000,
  'gpt-4.1': 1000000,
  'gpt-4o': 128000,
  'o4-mini': 200000,
  gpt: 128000,
  // Anthropic claude 系列 200k
  claude: 200000,
  // Gemini 1M
  gemini: 1000000,
  // 本地 ollama 全看显存，按常见的 32k 给
  ollama: 32000,
};

/** 认不出模型时的窗口：宁可保守，超了是真会 400 的 */
export const FALLBACK_WINDOW = 128000;

/**
 * 这个模型的上下文窗口有多大。
 * @param {string} model 模型名
 * @returns {number} token 数
 */
export function contextWindowOf(model) {
  const key = String(model ?? '').trim();
  if (!key) return FALLBACK_WINDOW;
  // 0) 价目条目里自带窗口的，直接用。价目和窗口本来就该是同一份数据，
  //    分两张表迟早对不上（这次核对就发现 qwen3.8-max 一边写 256k 一边官方是 991808）。
  const rate = rateOf(key);
  if (rate && Number(rate.win) > 0) return Number(rate.win);
  if (WINDOWS[key]) return WINDOWS[key];
  const lower = key.toLowerCase();
  // 不分大小写精确
  for (const [k, v] of Object.entries(WINDOWS)) {
    if (k.toLowerCase() === lower) return v;
  }
  // 长的键优先，免得 deepseek-v4-flash 抢在 deepseek-v4.1-flash 前面
  const keys = Object.keys(WINDOWS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (lower.startsWith(lk) || lower.includes(lk)) return WINDOWS[k];
  }
  return FALLBACK_WINDOW;
}

/**
 * 自动档的水位线：窗口的 70%。
 *
 * 为什么不压到 100%：请求本身还要给输出留空间（各家 max_tokens 占窗口），
 * 而且「压完那一次请求」的上下文还是旧的大小 —— 水位一旦贴顶，
 * 就会出现「这一轮压了、下一轮又超了」的反复压缩，每次都要额外调一次模型做摘要。
 * 留三成余量，压一次能撑很久。
 *
 * 下限 32000：万一碰到个超小窗口的冷门模型，也别压成一条线。
 * @param {string} model
 * @returns {number}
 */
export function autoLimitFor(model) {
  const win = contextWindowOf(model);
  return Math.max(32000, Math.floor(win * 0.7));
}

/**
 * 自动档的「自适应判断」比例带。
 *
 * 旧的 autoLimitFor 是一刀切：窗口 70% 才压。碰到 100 万窗口的模型（deepseek-v4.1-flash），
 * 水位就是 70 万 —— 历史涨到六七十万都不动，主人看到的就是「一直压不了」。
 *
 * 现在改成按「历史占窗口的比例」分三段判断：
 *   - 低于 COMFORT_RATIO（30%）：还很宽裕，不压（不额外花钱）。
 *   - 高于 ACT_RATIO（45%）：明显该压了，直接压。
 *   - 中间那一段（30%~45%）：拿不准，交给小鲸拍板（见 whale-judge.mjs，带冷却）。
 *
 * 用比例而不是绝对 token，是为了让 100 万窗口的模型也灵：30% 就是 30 万，
 * 历史涨到那儿就该动手了，不用等它堆到 70 万。
 */
export const AUTO_COMFORT_RATIO = 0.3;
export const AUTO_ACT_RATIO = 0.45;

/**
 * 按窗口比例判断「现在该不该压」。给 process 侧判断用。
 *
 * @param {string} model 模型名
 * @param {number} beforeTokens 当前历史大约多少 token
 * @returns {{ratio:number, window:number, verdict:'comfortable'|'critical'|'act'}}
 *   comfortable = 别压；act = 该压；critical = 拿不准，问小鲸。
 */
export function autoRatioVerdict(model, beforeTokens) {
  const win = contextWindowOf(model);
  const before = Number(beforeTokens);
  const ratio = win > 0 && Number.isFinite(before) ? before / win : 0;
  let verdict = 'comfortable';
  if (ratio >= AUTO_ACT_RATIO) verdict = 'act';
  else if (ratio >= AUTO_COMFORT_RATIO) verdict = 'critical';
  return { ratio, window: win, verdict };
}
