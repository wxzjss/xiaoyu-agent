/**
 * 生图：拿一个 OpenAI 兼容的图片端点，把 prompt 变成一张真的图。
 *
 * 为什么单独一个文件 —— 这里踩过一个坑，值得记清楚：
 *   「生图」这条模型（gpt-image-2.5-sunburst）如果当成聊天模型去用，
 *   POST /chat/completions 会回一句**人话**「Ping received! Online 输出图片质量：Auto」，
 *   状态码 400、code 是 upstream_text_reply。它没坏，它只是不在这儿出图。
 *   真正出图的端点是 POST {baseURL}/images/generations，回 { data:[{ b64_json }] }。
 *   两个端点不是一回事，别混。
 *
 * 形状（2026-11 实测本机 napi.wanzij.cn）：
 *   请求  { model, prompt, n?, size?, quality? }
 *   返回  { created, data:[{ revised_prompt, b64_json, width, height }], usage }
 *   40 秒左右才回，所以超时给足 3 分钟 —— 比聊天长得多，别拿 LLM_IDLE_MS 套它。
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { config } from './config.mjs';

/** 出图很慢：本机实测 33~40 秒。给到 3 分钟，宁可多等也别半路掐死。 */
export const IMAGE_TIMEOUT_MS = 180_000;

/** 默认尺寸；上游不认这个值也会自己给 1254x1254，所以只是「建议」。 */
const DEFAULT_SIZE = '1024x1024';

/** 图片落盘的地方：跟截图、附件分开，方便一起清。 */
export function imageDir() {
  const d = join(config.dataDir || '.', '.state', 'genimg');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const trimSlash = (s) => String(s ?? '').trim().replace(/\/+$/, '');

/**
 * 把上游的错误正文变成一句人话。
 *
 * 为什么不直接把原始 JSON 甩出去：里面全是转义和 <badge> 标签，
 * 主人看到的是一坨机器话，看不出「到底哪儿不对」。
 */
export function humanErrorOf(text, status) {
  const raw = String(text || '').trim();
  if (!raw) return '接口回了 ' + status + '，但没说原因';
  try {
    const j = JSON.parse(raw);
    const msg = String(j?.error?.message ?? j?.message ?? '').trim();
    const code = String(j?.error?.code ?? j?.code ?? '').trim();
    if (msg) return code ? msg + '（' + code + '）' : msg;
  } catch {
    /* 不是 JSON，照原样给人看 */
  }
  return raw.slice(0, 300);
}

/**
 * 现成的生图端点：models.json 里有没有一条被标成生图的。
 *
 * 为什么不硬编码模型名：主人可能换网关、换模型。认标记不认名字。
 */
export function imageEndpoint() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(config.dataDir || '.', '.state', 'models.json'), 'utf8'));
  } catch {
    return null;
  }
  const list = Array.isArray(raw?.models) ? raw.models : [];
  const pick = list.find((m) => m && m.kind === 'image' && m.baseURL && m.model) || null;
  if (!pick) return null;
  return {
    id: pick.id,
    name: pick.name || pick.model,
    model: pick.model,
    baseURL: trimSlash(pick.baseURL),
    apiKey: pick.apiKey || '',
  };
}

/** 存一张 base64 的 PNG 到 genimg 目录，返回 { path, bytes, width, height }。 */
export function savePng(b64, hint = 'img') {
  const buf = Buffer.from(String(b64 || ''), 'base64');
  if (buf.length < 100) throw new Error('上游回了个空的图');
  const tag = createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const safe = String(hint).replace(/[\\/:*?"<>|]/g, '_').slice(0, 24) || 'img';
  const path = join(imageDir(), `${stamp}-${safe}-${tag}.png`);
  writeFileSync(path, buf);
  // PNG 的宽高在 IHDR 里（offset 16/20）
  let width = 0;
  let height = 0;
  if (buf.length > 24 && buf[0] === 0x89) {
    width = buf.readUInt32BE(16);
    height = buf.readUInt32BE(20);
  }
  return { path, bytes: buf.length, width, height };
}

/**
 * 真去画一张。
 *
 * @param {object} opts
 * @param {string} opts.prompt   画什么
 * @param {object} [opts.ep]     端点（不传就用 models.json 里标成生图的那条）
 * @param {string} [opts.size]   尺寸建议
 * @param {string} [opts.prefix] 文件名前缀，方便在目录里认
 * @returns {Promise<object>} ok:true 时带 path/bytes/width/height，ok:false 时带 error
 */
export async function generateImage({ prompt, ep = null, size = DEFAULT_SIZE, prefix = 'img' } = {}) {
  const text = String(prompt || '').trim();
  if (!text) return { ok: false, error: '要画什么？prompt 是空的' };
  const use = ep || imageEndpoint();
  if (!use) {
    return { ok: false, error: '还没配生图模型：在右上角模型面板里加一条，并把它标成「生图」' };
  }
  if (!use.baseURL || !use.model) return { ok: false, error: '生图模型这条缺地址或模型名' };
  if (!use.apiKey) return { ok: false, error: '生图模型这条没填 API Key' };

  const started = Date.now();
  let res;
  try {
    res = await fetch(trimSlash(use.baseURL) + '/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + use.apiKey },
      body: JSON.stringify({ model: use.model, prompt: text, n: 1, size }),
      signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS),
    });
  } catch (err) {
    const e = err?.name === 'TimeoutError'
      ? '等了 ' + Math.round(IMAGE_TIMEOUT_MS / 1000) + ' 秒还没出图，先算了'
      : '连不上：' + (err?.message ?? err);
    return { ok: false, error: e };
  }
  const body = await res.text().catch(() => '');
  if (!res.ok) {
    return { ok: false, status: res.status, error: humanErrorOf(body, res.status) };
  }
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: '上游回的不是 JSON：' + body.slice(0, 120) };
  }
  const d = Array.isArray(json?.data) ? json.data[0] : null;
  if (!d) return { ok: false, error: '上游回了个空，没给图' };
  if (d.b64_json) {
    try {
      const saved = savePng(d.b64_json, prefix);
      return { ok: true, ...saved, revised: d.revised_prompt || '', ms: Date.now() - started };
    } catch (e) {
      return { ok: false, error: '存图的时候出错了：' + (e?.message ?? e) };
    }
  }
  if (d.url) {
    // 有的网关只给 URL，不下发 base64；这里不二次下载，把地址交回去让上层决定
    return {
      ok: false,
      error: '上游只给了图片地址（没给 base64），这个网关得配 b64 才行：' + String(d.url).slice(0, 120),
    };
  }
  return { ok: false, error: '上游回来的东西里既没有 b64_json 也没有 url' };
}
