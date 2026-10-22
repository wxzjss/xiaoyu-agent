// 模型配置：用户可以在界面里添加多个 OpenAI 兼容端点，并指定当前用哪一个。
// 存在 .state/models.json；.env 里的那套永远作为一条只读的「env」来源显示，删不掉。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const FILE = join(config.dataDir, '.state', 'models.json');
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
export const ENV_ID = 'env';

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
  if (pick && pick.baseURL && pick.model) {
    return {
      id: pick.id,
      name: pick.name || pick.model,
      model: pick.model,
      baseURL: trimSlash(pick.baseURL),
      apiKey: pick.apiKey || '',
      source: 'user',
    };
  }
  // 选中的是 .env 那条、可 .env 里没有 key（装成 exe 之后根本没有 .env 文件）：
  // 这时候别报「API Key 不能为空」，退到界面里已经配好 key 的第一套模型。
  if (!config.apiKey) {
    const withKey = models.find((m) => m && m.baseURL && m.model && m.apiKey);
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
    data.models.push(item);
    data.activeId = item.id;
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
      updatedAt: now,
    };
    // 不擅自改用户正在用的那颗；只在压根没有指向时才补一个
    if (!data.activeId && !envModel()) data.activeId = id;
    writeRaw(data);
    return publicView(data.models[i]);
  }

  if (!fields.apiKey) throw Object.assign(new Error('API Key 不能为空'), { status: 400 });
  const item = { id: newId(), ...fields, createdAt: now, updatedAt: now };
  data.models.push(item);
  // 一句都没有可用的时候才自动选中新的；.env 能用的场合不偷偷切走用户正在用的那颗
  if (!data.activeId && !envModel()) data.activeId = item.id;
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
 * 只发一次极短的 chat 请求，不落盘、不影响正在用的模型。
 */
export async function testModel(input = {}) {
  const id = String(input.id ?? '').trim();
  const typed = {
    model: String(input.model ?? '').trim(),
    baseURL: trimSlash(input.baseURL),
    apiKey: String(input.apiKey ?? '').trim(),
  };
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
  }

  if (!ep.baseURL || !ep.model) throw Object.assign(new Error('地址和模型名都要填'), { status: 400 });
  if (!ep.apiKey) throw Object.assign(new Error('API Key 不能为空'), { status: 400 });

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
    throw Object.assign(new Error(`接口回了 ${res.status}：${text.slice(0, 300)}`), { status: 502 });
  }
  await res.text().catch(() => '');
  return { ok: true, ms, model: ep.model, baseURL: trimSlash(ep.baseURL) };
}

/** 给提示词/顶栏用的一句话描述。 */
export function activeLabel() {
  const ep = activeEndpoint();
  return ep.apiKey ? `${ep.model} · ${ep.baseURL}` : `${ep.model} · 未配置 API Key`;
}
