// 模型配置：用户可以在界面里添加多个 OpenAI 兼容端点，并指定当前用哪一个。
// 存在 .state/models.json；.env 里的那套永远作为一条只读的「env」来源显示，删不掉。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const FILE = join(config.dataDir, '.state', 'models.json');
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const ENV_ID = 'env';

/**
 * 一条模型是拿来干嘛的。
 *
 *   chat  —— 说话、干活（默认，走 /chat/completions）
 *   image —— 出图（走 /images/generations）
 *
 * 为什么要分：生图模型当聊天模型用，上游会回一句人话、状态码 400
 * （code 是 upstream_text_reply），看着像「坏了」，其实只是问错了端点。
 * 分清楚之后，「测连通」也知道该去哪儿测。
 */
export const MODEL_KINDS = ['chat', 'image'];
export const KIND_CHAT = 'chat';
export const KIND_IMAGE = 'image';
const normKind = (v) => (MODEL_KINDS.includes(String(v || '')) ? String(v) : KIND_CHAT);
/**
 * 中转站倍率。
 *
 * 【为什么要有这个东西】
 * 丸子、凌风这类中转站，收的是「官方价 × 它的倍率」。
 * 模型名跟官方一模一样（deepseek-v4.1-flash），价目表按名字一套就套到官方价上，
 * 显示出来的钱跟实际扣的钱对不上 —— 有时差一两成，有时差一半。
 *
 * 【为什么不自动抓】
 * 中转站没有统一的价格接口，倍率都在各家自己的后台页面里，抓不到也抓不准。
 * 主人填一个数最实在：1 = 官方原价，0.8 = 打八折，1.5 = 加价五成。
 *
 * 【默认值】
 * 没填 / 填了看不懂的东西 → 1（照官方价算）。宁可少说，也别瞎乘一个数。
 */
export function normMarkup(v) {
  if (v === undefined || v === null || v === '') return 1;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 1;
  // 一位小数够用了；上限压一下，免得手滑填个 10000 把账算飞
  return Math.min(1000, Math.round(n * 1000) / 1000);
}

/**
 * 这一条模型自己的价目。
 *
 * 【为什么要「每条」一份，而不是查一张大表】
 * 价目表（rates.mjs）按模型名查，查到的是**官方价**。
 * 可中转站收的是它自己定的价：同样叫 deepseek-v4.1-flash，丸子可能收 1.5 倍、
 * 凌风可能收 0.8 倍；有的站还有自己的缓存读写价、自己的倍率。
 * 光靠「官方价 × 一个倍率」根本盖不住 —— 所以这里给每条模型一份能自己填的价。
 *
 * 四档，单位一律是「每百万 token」：
 *   inMiss   输入 · 未命中缓存（新内容）
 *   inHit    输入 · 命中缓存（缓存读）
 *   out      输出
 *   cacheWrite  缓存写入（Anthropic 这类，写缓存比原价贵 25%；OpenAI/DeepSeek 没有就留空）
 *
 * 【和倍率怎么配合】
 * 填了就按填的算（填的是**最终价**，不再乘倍率）；
 * 留空 → 回落到「价目表 × 倍率」。
 * 这样主人要么填一个倍率偷懒，要么填四个精确价，两种都行，不会互相打架。
 *
 * @param {*} v 界面上填的东西（对象 / 字符串 / 空）
 * @returns {{inMiss:number|null, inHit:number|null, out:number|null, cacheWrite:number|null}}
 */
export function normPrice(v) {
  const pick = (x) => {
    if (x === undefined || x === null || x === '') return null;
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0) return null;
    // 上限压一下：填个 99999 也就算了，再多一定是手滑
    return Math.min(99999, Math.round(n * 10000) / 10000);
  };
  let src = v;
  // 老版本 / 手写文件可能是个 JSON 字符串，别因为格式就当没填
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch { src = null; }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return { inMiss: null, inHit: null, out: null, cacheWrite: null };
  }
  return {
    inMiss: pick(src.inMiss ?? src.in ?? src.input),
    inHit: pick(src.inHit ?? src.hit ?? src.cacheRead),
    out: pick(src.out ?? src.output),
    cacheWrite: pick(src.cacheWrite ?? src.cacheWritePrice ?? src.cacheCreate),
  };
}

/** 这份价目填了几格（0 = 全空，等于没填） */
export function priceFilled(p) {
  const q = normPrice(p);
  return ['inMiss', 'inHit', 'out', 'cacheWrite'].filter((k) => q[k] !== null).length;
}

/**
 * 价目的币种：'cny' 或 'usd'。
 *
 * 主人可能从官网抄的是美元牌价（OpenAI、Anthropic 都标美元），
 * 也可能抄的是国内官网的元。填的时候选一下，后端存的就是他自己填的那个数，
 * 换算成元交给算钱的那一步 —— 别让他每次自己乘汇率。
 */
export function normPriceCurrency(v) {
  return String(v || '').toLowerCase() === 'usd' ? 'usd' : 'cny';
}

function readRaw() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return { models: [], activeId: null };
    return {
      models: Array.isArray(raw.models) ? raw.models : [],
      activeId: typeof raw.activeId === 'string' ? raw.activeId : null,
      /** true = 用户把 .env 那条从界面里删掉了（.env 文件不动，只隐藏） */
      hideEnv: Boolean(raw.hideEnv),
    };
  } catch {
    return { models: [], activeId: null, hideEnv: false };
  }
}

function writeRaw(data) {
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    FILE,
    JSON.stringify({ models: data.models, activeId: data.activeId, hideEnv: Boolean(data.hideEnv) }, null, 2),
    'utf8',
  );
}

const trimSlash = (s) => String(s ?? '').trim().replace(/\/+$/, '');

function newId() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * .env 那套配置：只有在 .env 里真填了 key，才算一条能用的模型。
 * 没 key 的时候不列出来——界面该显示「还没配模型」的空状态，而不是一条点了也用不了的假货。
 */
export function envModel() {
  if (!config.apiKey) return null;
  return {
    id: ENV_ID,
    name: `${config.model}（.env）`,
    model: config.model,
    baseURL: config.baseURL,
    source: 'env',
    keyHint: config.apiKey ? `****${config.apiKey.slice(-4)}` : '',
    hasKey: Boolean(config.apiKey),
    /** 界面别把它当只读：可以编辑（存成普通模型）/ 删除（隐藏） */
    readonly: false,
    fromEnv: true,
  };
}

/** 对外展示用：绝不带明文 key，只给尾号。 */
function publicView(m) {
  return {
    id: m.id,
    name: m.name,
    model: m.model,
    baseURL: m.baseURL,
    source: 'user',
    keyHint: m.apiKey ? `****${String(m.apiKey).slice(-4)}` : '',
    hasKey: Boolean(m.apiKey),
    readonly: false,
    /** chat = 说话用的，image = 出图用的（界面据此分组、测连通据此挑端点） */
    kind: normKind(m.kind),
    /** 中转站倍率：1 = 照官方价，0.8 = 打八折。没填过就是 1 */
    markup: normMarkup(m.markup),
    /** 这一条自己填的价目（全空 = 照价目表 × 倍率算）；单位是「每百万 token」 */
    price: normPrice(m.price),
    /** price 那四个数是用哪种钱填的：'cny' 或 'usd' */
    priceCurrency: normPriceCurrency(m.priceCurrency),
    createdAt: m.createdAt ?? 0,
    updatedAt: m.updatedAt ?? 0,
  };
}

/** 界面上要显示的模型清单（.env 的排第一位）+ 当前选中的是谁。 */
export function listModels() {
  const { models, activeId, hideEnv } = readRaw();
  const env = envModel();
  const list = [];
  if (env && !hideEnv) list.push(env);
  for (const m of models) {
    if (!m || !ID_RE.test(String(m.id ?? ''))) continue;
    list.push(publicView(m));
  }
  const valid = new Set(list.map((m) => m.id));
  const active = activeId && valid.has(activeId) ? activeId : (list[0]?.id ?? null);
  return {
    models: list,
    activeId: active,
    /** 一条都没有 = 界面显示空状态页。 */
    empty: list.length === 0,
    envDefaults: {
      model: config.model,
      baseURL: config.baseURL,
      hasKey: Boolean(config.apiKey),
    },
  };
}

/** 真正拿来发请求的那套参数（含明文 key，只在服务端用）。 */
export function activeEndpoint() {
  const { models, activeId } = readRaw();
  const pick = models.find((m) => m && m.id === activeId);
  // 生图那条不能拿来「说话」：它没有聊天端点，硬发过去上游只会回一句人话 + 400。
  // 万一 activeId 真指到它身上（老配置 / 手动改文件），这里退到一条能说话的。
  if (pick && pick.baseURL && pick.model && normKind(pick.kind) !== KIND_IMAGE) {
    return {
      id: pick.id,
      name: pick.name || pick.model,
      model: pick.model,
      baseURL: trimSlash(pick.baseURL),
      apiKey: pick.apiKey || '',
      source: 'user',
    };
  }
  // 选中的是 .env 那条、可 .env 里没有 key（装成 exe 之后根本没有 .env 文件），
  // 或者选中的是生图那条：别报「API Key 不能为空」，退到界面里已经配好 key 的第一套能说话的模型。
  if (!config.apiKey || !pick) {
    const withKey = models.find((m) => m && m.baseURL && m.model && m.apiKey && normKind(m.kind) !== KIND_IMAGE);
    if (withKey) {
      return {
        id: withKey.id,
        name: withKey.name || withKey.model,
        model: withKey.model,
        baseURL: trimSlash(withKey.baseURL),
        apiKey: withKey.apiKey,
        source: 'user',
      };
    }
  }
  return {
    id: ENV_ID,
    name: `${config.model}（.env）`,
    model: config.model,
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    source: 'env',
  };
}

/**
 * 按 id 取某一套模型参数 —— 只读，**不动右上角存的 activeId**。
 *
 * 为什么要有它：左上角切模型只该影响当前会话。
 * 要是这里顺手把 activeId 改了，别的会话就跟着变了，右上角那套设置也被动了。
 *
 * @param {string} id 模型 id（就是右上角列表里那个 id）
 * @returns {object|null} 找不到就 null
 */
export function endpointFor(id) {
  if (!id) return null;
  const { models } = readRaw();
  const pick = models.find((m) => m && m.id === id);
  if (!pick || !pick.baseURL || !pick.model) return null;
  return {
    id: pick.id,
    name: pick.name || pick.model,
    model: pick.model,
    baseURL: trimSlash(pick.baseURL),
    apiKey: pick.apiKey || '',
    source: 'user',
  };
}

function normalizeInput(input = {}) {
  const model = String(input.model ?? '').trim();
  const baseURL = trimSlash(input.baseURL);
  if (!model) throw Object.assign(new Error('模型名不能为空'), { status: 400 });
  if (!/^https?:\/\//i.test(baseURL)) {
    throw Object.assign(new Error('接口地址要以 http:// 或 https:// 开头'), { status: 400 });
  }
  return {
    model,
    baseURL,
    name: String(input.name ?? '').trim() || model,
    apiKey: String(input.apiKey ?? '').trim(),
    markup: normMarkup(input.markup),
    price: normPrice(input.price),
    priceCurrency: normPriceCurrency(input.priceCurrency),
  };
}

/** 新增或更新一条模型配置；apiKey 留空表示沿用原值。 */
export function saveModel(input = {}) {
  const fields = normalizeInput(input);
  const data = readRaw();
  const id = String(input.id ?? '').trim();
  const now = Date.now();

  // 「编辑 .env 那条」：改完的东西存成一条普通模型，并切过去。
  // 不回去改 .env 文件——那是主人的配置文件，程序别乱动。
  if (id === ENV_ID) {
    const item = { id: newId(), ...fields, createdAt: now, updatedAt: now, fromEnv: true };
    if (!item.apiKey) item.apiKey = config.apiKey;
    if (input.kind !== undefined) item.kind = normKind(input.kind);
    // 生图那条不能顶替正在用的聊天模型，否则下一句话就没模型说了
    const kind = normKind(item.kind);
    data.models.push(item);
    if (kind === KIND_CHAT) data.activeId = item.id;
    else if (!data.activeId) data.activeId = data.models.find((m) => normKind(m.kind) === KIND_CHAT)?.id ?? null;
    data.hideEnv = true; // 存了副本就别再并列显示 .env 那条
    writeRaw(data);
    const view = publicView(item);
    return { ...view, convertedFromEnv: true };
  }

  if (id && id !== ENV_ID) {
    const i = data.models.findIndex((m) => m && m.id === id);
    if (i < 0) throw Object.assign(new Error('这条模型不存在'), { status: 404 });
    const prev = data.models[i];
    data.models[i] = {
      ...prev,
      ...fields,
      apiKey: fields.apiKey || prev.apiKey || '',
      id,
      // kind 没传就保持原样（别把已经标成生图的默默改回聊天）
      kind: input.kind !== undefined ? normKind(input.kind) : normKind(prev.kind),
      // 倍率同理：这一版界面还没带这个字段的旧客户端，不该把填好的数冲成 1
      markup: input.markup !== undefined ? normMarkup(input.markup) : normMarkup(prev.markup),
      // 价目同理：老界面不会传这个字段，别把主人填好的四格冲成空
      price: input.price !== undefined ? normPrice(input.price) : normPrice(prev.price),
      priceCurrency: input.priceCurrency !== undefined ? normPriceCurrency(input.priceCurrency) : normPriceCurrency(prev.priceCurrency),
      updatedAt: now,
    };
    // 不擅自改用户正在用的那颗；只在压根没有指向时才补一个
    if (!data.activeId && !envModel()) data.activeId = id;
    writeRaw(data);
    return publicView(data.models[i]);
  }

  if (!fields.apiKey) throw Object.assign(new Error('API Key 不能为空'), { status: 400 });
  const item = { id: newId(), ...fields, kind: normKind(input.kind), createdAt: now, updatedAt: now };
  data.models.push(item);
  // 一句都没有可用的时候才自动选中新的；.env 能用的场合不偷偷切走用户正在用的那颗。
  // 生图那条永远不自动选中 —— 它说不了话，选中了下一句就发不出去。
  if (item.kind === KIND_CHAT && !data.activeId && !envModel()) data.activeId = item.id;
  writeRaw(data);
  return publicView(item);
}

export function deleteModel(id) {
  // 删 .env 那条 = 只是从界面列表里藏起来，.env 文件一个字都不动
  if (id === ENV_ID) {
    const data = readRaw();
    data.hideEnv = true;
    if (data.activeId === ENV_ID) data.activeId = data.models[0]?.id ?? ENV_ID;
    writeRaw(data);
    return { ...listModels(), uninstalledEnv: true };
  }

  const data = readRaw();
  const i = data.models.findIndex((m) => m && m.id === id);
  if (i < 0) throw Object.assign(new Error('这条模型不存在'), { status: 404 });
  data.models.splice(i, 1);
  if (data.activeId === id) data.activeId = data.models[0]?.id ?? ENV_ID;
  writeRaw(data);
  return listModels();
}

/** 把被删掉的 .env 那条恢复回列表里。 */
export function restoreEnvModel() {
  const data = readRaw();
  data.hideEnv = false;
  if (!data.activeId) data.activeId = ENV_ID;
  writeRaw(data);
  return listModels();
}

/** 切当前用哪个模型。 */
export function selectModel(id) {
  const data = readRaw();
  const valid = new Set([ENV_ID, ...data.models.map((m) => m?.id).filter(Boolean)]);
  if (!id || !valid.has(id)) throw Object.assign(new Error('没有这个模型'), { status: 404 });
  if (id === ENV_ID && !envModel()) throw Object.assign(new Error('.env 里没有可用配置'), { status: 400 });
  if (id === ENV_ID && data.hideEnv) throw Object.assign(new Error('这条已经从列表里删掉了'), { status: 400 });
  data.activeId = id;
  writeRaw(data);
  return listModels();
}

/**
 * 试一下能不能连通：拿给的表单值优先，没填的用已存的；都不填就用当前生效的那套。
 * 只发一次极短的请求，不落盘、不影响正在用的模型。
 *
 * 两条路分开走（2026-11 加）：
 *   chat  → /chat/completions 发一句 ping
 *   image → /images/generations 画一张最小的图（1:1、最低档），能出图才算通
 *
 * 为什么生图不能沿用 chat 那条：生图模型往 /chat/completions 打，
 * 上游会回一句人话 + 400（code=upstream_text_reply），界面就报「连不上」，
 * 可它明明好好的 —— 只是问错端点了。
 */
export async function testModel(input = {}) {
  const id = String(input.id ?? '').trim();
  const typed = {
    model: String(input.model ?? '').trim(),
    baseURL: trimSlash(input.baseURL),
    apiKey: String(input.apiKey ?? '').trim(),
  };
  // 表单里没传 kind 时，用那条已存的 kind 顶上（改地址不该把生图默默变回聊天）
  let kind = input.kind !== undefined ? normKind(input.kind) : KIND_CHAT;
  if (input.kind === undefined && id && id !== ENV_ID) {
    const stored = readRaw().models.find((x) => x && x.id === id);
    kind = normKind(stored?.kind);
  }
  let ep;
  if (typed.model && typed.baseURL) {
    // 表单里填了新的：优先测表单，key 留空就沿用那条已存的
    let apiKey = typed.apiKey;
    if (!apiKey && id && id !== ENV_ID) {
      const stored = readRaw().models.find((x) => x && x.id === id);
      apiKey = stored?.apiKey || '';
    }
    if (!apiKey && id === ENV_ID) apiKey = config.apiKey;
    ep = { baseURL: typed.baseURL, apiKey, model: typed.model };
  } else if (id === ENV_ID) {
    ep = { baseURL: config.baseURL, apiKey: config.apiKey, model: config.model };
  } else if (id) {
    const m = readRaw().models.find((x) => x && x.id === id);
    if (!m) throw Object.assign(new Error('这条模型不存在'), { status: 404 });
    ep = { baseURL: m.baseURL, apiKey: m.apiKey, model: m.model };
  } else {
    ep = activeEndpoint();
    kind = KIND_CHAT;
  }

  if (!ep.baseURL || !ep.model) throw Object.assign(new Error('地址和模型名都要填'), { status: 400 });
  if (!ep.apiKey) throw Object.assign(new Error('API Key 不能为空'), { status: 400 });

  if (kind === KIND_IMAGE) return await testImageModel(ep);

  const started = Date.now();
  let res;
  try {
    res = await fetch(`${trimSlash(ep.baseURL)}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({ model: ep.model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    throw Object.assign(new Error(`连不上：${err?.message ?? err}`), { status: 502 });
  }
  const ms = Date.now() - started;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // 能把人话抠出来就抠出来，别甩一坨 JSON 给主人看
    throw Object.assign(new Error(humanTextOf(text, `接口回了 ${res.status}`)), { status: 502 });
  }
  await res.text().catch(() => '');
  return { ok: true, kind: KIND_CHAT, ms, model: ep.model, baseURL: trimSlash(ep.baseURL) };
}

/** 上游错误正文里那句人话（抠不出来就原样截一段）。 */
function humanTextOf(text, fallback) {
  const raw = String(text || '').trim();
  if (!raw) return fallback;
  try {
    const j = JSON.parse(raw);
    const msg = String(j?.error?.message ?? j?.message ?? '').trim();
    const code = String(j?.error?.code ?? j?.code ?? '').trim();
    if (msg) return code ? `${msg}（${code}）` : msg;
  } catch {
    /* 不是 JSON */
  }
  return `${fallback}：${raw.slice(0, 300)}`;
}

/**
 * 生图那条的「测连通」：真去画一张最小的图。
 *
 * 为什么不只探端口：地址通、key 错、模型名错，三种毛病在端口上长得一模一样。
 * 只有真出图才算通。代价是要等 30~40 秒，所以界面那边得说清楚「正在画」。
 */
async function testImageModel(ep) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(`${trimSlash(ep.baseURL)}/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
      body: JSON.stringify({ model: ep.model, prompt: 'a single blue dot', n: 1, size: '1024x1024' }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch (err) {
    const msg = err?.name === 'TimeoutError' ? '等了 3 分钟还没出图' : `连不上：${err?.message ?? err}`;
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const ms = Date.now() - started;
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw Object.assign(new Error(humanTextOf(text, `接口回了 ${res.status}`)), { status: 502 });
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('回了 200，可正文不是 JSON —— 地址可能填到了聊天那面上'), { status: 502 });
  }
  const d = Array.isArray(json?.data) ? json.data[0] : null;
  if (!d || (!d.b64_json && !d.url)) {
    throw Object.assign(
      new Error('回了 200，但没有图 —— 这个模型名在 /images/generations 上不出图，换个模型名试试'),
      { status: 502 },
    );
  }
  return { ok: true, kind: KIND_IMAGE, ms, model: ep.model, baseURL: trimSlash(ep.baseURL) };
}

/** 给提示词/顶栏用的一句话描述。 */
export function activeLabel() {
  const ep = activeEndpoint();
  return ep.apiKey ? `${ep.model} · ${ep.baseURL}` : `${ep.model} · 未配置 API Key`;
}

/**
 * 「这个地址上到底有没有人在听」—— 只探端口，不发请求。
 *
 * 为什么不直接复用 testModel() 发一次真请求：
 *   - 启动时网络上如果慢，一条 chat 请求能卡 20 秒，把整个服务启动拖住；
 *   - 我们要回答的问题只是「地址填错了吗」，TCP 能不能握上手就足够回答，
 *     不需要模型真的回一句话（那是「试连通」按钮该干的事）。
 *
 * 为什么这件事必须有人做（2026-10-26）：
 *   模型地址被写成 http://127.0.0.1:18599 —— 一个根本不存在的本地服务。
 *   界面上一切正常，只有发消息时才会 ECONNREFUSED，而那个错当时又被当成
 *   「连接断了一下」反复重试，主人看到的是「卡在发送中」和「连接一直断」，
 *   完全看不出真正的原因。地址写错是**静态错误**，应该在发消息之前就说出来。
 *
 * @param {string} baseURL 形如 https://napi.wanzij.cn/v1
 * @param {{timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:boolean, host:string, port:number, reason?:string, ms:number}>}
 */
export async function probeEndpoint(baseURL, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000;
  const started = Date.now();
  let url;
  try {
    url = new URL(trimSlash(baseURL));
  } catch {
    return { ok: false, host: String(baseURL || ''), port: 0, reason: '地址不是合法的 URL', ms: 0 };
  }
  const isHttps = url.protocol === 'https:';
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port) || (isHttps ? 443 : 80);

  const { connect } = await import('node:net');
  const tls = isHttps ? await import('node:tls') : null;

  return await new Promise((resolve) => {
    let settled = false;
    const done = (ok, reason) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* 已关就算了 */ }
      resolve({ ok, host, port, reason, ms: Date.now() - started });
    };

    let sock;
    try {
      sock = isHttps
        ? tls.connect({ host, port, servername: host, timeout: timeoutMs })
        : connect({ host, port, timeout: timeoutMs });
    } catch (err) {
      return resolve({ ok: false, host, port, reason: String(err?.message ?? err), ms: Date.now() - started });
    }

    sock.once(isHttps ? 'secureConnect' : 'connect', () => done(true));
    sock.once('timeout', () => done(false, `${timeoutMs} 毫秒内没有应答`));
    sock.once('error', (err) => {
      const code = err?.code || '';
      if (code === 'ECONNREFUSED') done(false, '这个端口上没有服务在听（连接被拒绝）');
      else if (code === 'ENOTFOUND') done(false, '这个域名解析不出来（拼错了吗）');
      else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') done(false, '这台主机 / 这个网段到不了');
      else if (code === 'CERT_HAS_EXPIRED') done(false, '证书过期了');
      else if (/CERT|SELF_SIGNED/i.test(code)) done(false, `证书有问题（${code}）`);
      else done(false, code || String(err?.message ?? err));
    });
  });
}
