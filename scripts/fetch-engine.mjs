// 抓取引擎：给一个链接，把网页正文抓成干净文本。
//
// 跟以前那版的区别（以前只会 res.text() 当 UTF-8 解，中文老站全是乱码）：
//   1. 先看 Content-Type 的 charset，没有就看 <meta charset>，还没有就猜（UTF-8 / GBK 都试一遍，取最像人话的）
//   2. 认 BOM
//   3. 正文清洗：去脚本样式导航页脚，把 <br>/<p> 换成换行，压掉空行
//   4. 顺手抽出标题、翻页/下一页链接，批量抓书要用
//
// 既能被 tools.mjs 里的 fetch_txt 调用（导出 fetchText），也能命令行直接跑：
//   node scripts/fetch-engine.mjs <url> [输出目录]
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { autoToSimplified } from '../src/zh-convert.mjs';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** 从 Content-Type 或 <meta> 里抠 charset */
function charsetFrom(ctype, head) {
  const m1 = /charset\s*=\s*["']?([\w-]+)/i.exec(ctype || '');
  if (m1) return m1[1].toLowerCase();
  const m2 = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head || '');
  if (m2) return m2[1].toLowerCase();
  return '';
}

/** 各种 charset 名归一化到 TextDecoder 认的名字 */
function normalizeCharset(cs) {
  const s = String(cs || '').toLowerCase().replace(/["']/g, '').trim();
  if (!s) return '';
  if (s === 'gb2312' || s === 'gbk' || s === 'gb_2312-80' || s === 'x-gbk' || s === 'cp936') return 'gbk';
  if (s === 'big5' || s === 'big5-hkscs') return 'big5';
  if (s === 'utf8' || s === 'utf-8' || s === 'utf8mb4') return 'utf-8';
  return s;
}

/** 这段字节当 utf-8 解出来的“乱码程度”（0 最好）。U+FFFD 越多越烂 */
function garbageScore(text) {
  if (!text) return 1;
  const bad = (text.match(/\uFFFD/g) || []).length;
  // 罕见的私用区/替换符也算坏
  const weird = (text.match(/[\uE000-\uF8FF]/g) || []).length;
  return (bad * 3 + weird) / Math.max(1, text.length);
}

/** 把一串字节解成字符串：先信声明，再猜，取最像人话的 */
export function decodeBuffer(buf, ctype = '') {
  const head = buf.subarray(0, 4096).toString('latin1');
  // BOM 优先
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buf.subarray(3)), charset: 'utf-8(bom)' };
  }
  const declared = normalizeCharset(charsetFrom(ctype, head));
  const candidates = [];
  if (declared) candidates.push(declared);
  for (const c of ['utf-8', 'gbk', 'big5']) if (!candidates.includes(c)) candidates.push(c);

  let best = null;
  for (const cs of candidates) {
    let text;
    try {
      text = new TextDecoder(cs, { fatal: false }).decode(buf);
    } catch {
      continue;
    }
    const score = garbageScore(text);
    if (!best || score < best.score - 1e-9) best = { text, charset: cs, score };
    if (score === 0) break; // 干净就不折腾了
  }
  if (!best) return { text: buf.toString('utf8'), charset: 'utf-8(fallback)' };
  return { text: best.text, charset: best.charset };
}

const DROP_BLOCKS =
  /<(script|style|noscript|svg|canvas|iframe|template|head|nav|footer|aside|form|select|button)\b[\s\S]*?<\/\1>/gi;
const DROP_ATTR = /<(div|section|header|ul|ol|table|span)[^>]+(?:class|id)\s*=\s*["'][^"']*(?:nav|menu|footer|header|breadcrumb|sidebar|comment|advert|ads?|share|copyright)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi;

function decodeEntities(s) {
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", ldquo: '“', rdquo: '”', hellip: '…', mdash: '—', ndash: '–', middot: '·' };
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      try { return String.fromCodePoint(parseInt(h, 16)); } catch { return ''; }
    })
    .replace(/&#(\d+);/g, (_, d) => {
      try { return String.fromCodePoint(Number(d)); } catch { return ''; }
    })
    .replace(/&([a-z]+);/gi, (m, n) => named[n.toLowerCase()] ?? m);
}

/** HTML -> 干净正文 */
export function htmlToText(html) {
  let s = String(html || '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(DROP_BLOCKS, '\n');
  s = s.replace(DROP_ATTR, '\n');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article|dd|dt)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(/\u00a0/g, ' ').replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  s = s.replace(/[ \t\u3000]+/g, ' ');
  s = s.replace(/ *\n */g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/** 抠 <title> */
export function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html || '');
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim() : '';
}

/** 找「下一页」链接（批量抓连载/分页用） */
export function extractNextLink(html, baseUrl) {
  const re = /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]{0,60}?)<\/a>/gi;
  let m;
  while ((m = re.exec(html || ''))) {
    const label = decodeEntities(m[2]).replace(/<[^>]+>/g, '').trim();
    if (/^(下一页|下页|下一章|下一節|下一节|next|next page|›|»|>)/i.test(label)) {
      try {
        return new URL(m[1], baseUrl).href;
      } catch {
        /* 跳过坏链接 */
      }
    }
  }
  // rel="next"
  const rel = /<link\b[^>]*rel\s*=\s*["']next["'][^>]*href\s*=\s*["']([^"']+)["']/i.exec(html || '');
  if (rel) {
    try { return new URL(rel[1], baseUrl).href; } catch {}
  }
  return '';
}

function fileNameFrom(url, ext = 'txt') {
  let base = 'page';
  try {
    const u = new URL(url);
    base = (u.pathname.split('/').filter(Boolean).pop() || u.hostname).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60);
  } catch {}
  return `txt_${Date.now()}_${base}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
}

const MAX_BYTES = 12 * 1024 * 1024;

/**
 * 抓一页。
 * @param {string} url
 * @param {object} [opts]
 * @param {string} [opts.outDir] 存盘目录；不给就只返回文本不落盘
 * @param {number} [opts.timeout] 毫秒
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{url:string, finalUrl:string, status:number, charset:string, title:string, text:string, chars:number, next:string, file:string}>}
 */
export async function fetchText(url, opts = {}) {
  if (!/^https?:\/\//i.test(String(url || ''))) throw new Error('只认 http(s) 链接');
  const timeout = opts.timeout ?? 45000;
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: opts.signal ?? AbortSignal.timeout(timeout),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText || ''}`.trim());

  const ctype = res.headers.get('content-type') || '';
  const ab = await res.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) throw new Error(`页面太大（${(ab.byteLength / 1048576).toFixed(1)}MB），先只抓局部`);

  const { text: raw, charset } = decodeBuffer(Buffer.from(ab), ctype);
  const looksHtml = /html|xml/i.test(ctype) || /^\s*</.test(raw.slice(0, 200));
  const title = looksHtml ? extractTitle(raw) : '';
  let text = looksHtml ? htmlToText(raw) : raw.trim();
  const next = looksHtml ? extractNextLink(raw, res.url || url) : '';
  // 繁体站抓下来直接转简体（是简体就一字不动）
  const conv = autoToSimplified(text);
  const converted = conv.converted;
  if (converted) text = conv.text;

  let file = '';
  if (opts.outDir) {
    mkdirSync(opts.outDir, { recursive: true });
    file = join(opts.outDir, fileNameFrom(res.url || url));
    writeFileSync(file, text, 'utf8');
  }
  return {
    url,
    finalUrl: res.url || url,
    status: res.status,
    charset,
    title,
    text,
    chars: text.length,
    next,
    file,
    converted,
    tradRatio: conv.ratio,
  };
}

// ---------- 命令行：node scripts/fetch-engine.mjs <url> [输出目录] ----------
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('fetch-engine.mjs')) {
  const [url, outDir] = process.argv.slice(2);
  if (!url) {
    console.error('用法: node fetch-engine.mjs <url> [输出目录]');
    process.exit(1);
  }
  try {
    const r = await fetchText(url, { outDir: outDir || undefined });
    console.log(JSON.stringify({ ok: true, file: r.file, chars: r.chars, charset: r.charset, title: r.title, next: r.next }, null, 2));
  } catch (e) {
    console.error('抓取失败:', e.message);
    process.exit(1);
  }
}
