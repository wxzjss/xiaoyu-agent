// 批量抓取 + 打包成书。
//
// 两种用法：
//   1. 批量：给一串链接 → 一个个抓下来 → 存 dump/txt，每页记编码/标题/字符数
//   2. 打包：把抓过的（或是指定目录里的）txt 合成一本，存 dump/books/《标题》.md 和 .txt
//      自动去掉 Gutenberg 那圈页眉页脚（START/END OF THE PROJECT GUTENBERG EBOOK），
//      顺手把古登堡的硬换行折成段落，读起来才像本书。
//
// 命令行：
//   node scripts/fetch-batch.mjs <urls.txt|,url1,url2> [--dir 输出目录] [--follow N]
//   node scripts/fetch-batch.mjs --pack <书名> <文件1> <文件2> ... [--author 作者] [--source 链接]
//   node scripts/fetch-batch.mjs --pack-dir <书名> <目录> [--author 作者]
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { fetchText } from './fetch-engine.mjs';
import { autoToSimplified } from '../src/zh-convert.mjs';

const APP_ROOT = resolve(process.argv[1] ? process.argv[1].replace(/[\\/]scripts[\\/][^\\/]+$/, '') : '.', '.');
const TXT_DIR = join(APP_ROOT, 'dump', 'txt');
const BOOK_DIR = join(APP_ROOT, 'dump', 'books');

/** 把参数里带 --key value 的都挑出来 */
function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      out[k] = v;
    } else out._.push(a);
  }
  return out;
}

// ---------------- 去古登堡页眉页脚 ----------------
const GUT_START = /\*\*\*\s*START OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;
const GUT_END = /\*\*\*\s*END OF (THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*/i;

export function stripGutenberg(txt) {
  let s = String(txt || '');
  const a = GUT_START.exec(s);
  if (a) s = s.slice(a.index + a[0].length);
  const b = GUT_END.exec(s);
  if (b) s = s.slice(0, b.index);
  return s.trim();
}

/**
 * 古登堡纯文本是硬换行（一行 70 来字就断），直接拼会读成一段一段的碎片。
 * 这里把「不是段落边界」的换行折成空格：空行留段，章节标题、缩进行照旧起段。
 */
export function reflow(txt) {
  const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/;
  const isCJK = (t) => CJK_RE.test(t);
  /** 这行攒到一屏宽了吗（中文按字算、一屏约 28 字；英文按字符算、约 60） */
  const isLong = (t) => (isCJK(t) ? t.replace(/\s/g, '').length >= 28 : t.length >= 60);
  const lines = String(txt || '')
    .replace(/\r\n?/g, '\n')
    .split('\n');
  const out = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push(buf);
    buf = '';
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flush();
      out.push('');
      continue;
    }
    const t = line.trim();
    const isHeading =
      /^(chapter|part|book|volume|act|scene|prologue|epilogue)\b/i.test(t) ||
      /^[IVXLC]+\.?$/.test(t) ||
      /^\d{1,4}\.?$/.test(t) ||
      /^第[一二三四五六七八九十百千零〇\d]+[章节回卷]/.test(t) ||
      /^(卷|回)[一二三四五六七八九十百千零〇\d]+/.test(t);
    const indented = /^\s{2,}\S/.test(raw);
    if (isHeading) {
      flush();
      out.push(t);
      out.push('');
      continue;
    }
    if (indented) {
      flush();
      buf = t;
      continue;
    }
    if (buf) {
      if (!isLong(buf)) {
        buf = buf.endsWith('-') ? buf.slice(0, -1) + t : buf + t;
        continue;
      }
      flush();
    }
    buf = t;
  }
  flush();
  return out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 是不是中日韩字 */
export function isCJK(t) {
  return /[\u3400-\u9FFF\uF900-\uFAFF]/.test(t);
}

/** 文件名洗干净 */
function safeName(s, n = 80) {
  return (String(s || '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().slice(0, n) || 'untitled');
}

// ---------------- 批量抓 ----------------
/**
 * @param {string[]} urls
 * @param {{dir?:string, follow?:number, onProgress?:(r:object)=>void}} opts
 */
export async function fetchMany(urls, opts = {}) {
  const dir = opts.dir || TXT_DIR;
  mkdirSync(dir, { recursive: true });
  const follow = Math.max(0, Math.min(20, Number(opts.follow) || 0));
  const queue = [...new Set((urls || []).map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)))];
  const done = [];
  const failed = [];
  const seen = new Set();
  let idx = 0;
  while (idx < queue.length) {
    const url = queue[idx++];
    if (seen.has(url)) continue;
    seen.add(url);
    let r;
    try {
      r = await fetchText(url, { outDir: dir });
    } catch (e) {
      const item = { url, ok: false, error: String(e?.message ?? e) };
      failed.push(item);
      opts.onProgress?.(item);
      continue;
    }
    const item = {
      url,
      ok: true,
      finalUrl: r.finalUrl,
      file: r.file,
      title: r.title,
      chars: r.chars,
      charset: r.charset,
      converted: Boolean(r.converted),
    };
    done.push(item);
    opts.onProgress?.(item);
    // 跟着「下一页」再走几页
    let next = r.next;
    for (let k = 0; k < follow && next && !seen.has(next); k++) {
      seen.add(next);
      queue.push(next);
      next = '';
    }
  }
  return { dir, done, failed, total: done.length + failed.length };
}

// ---------------- 打包成书 ----------------
/**
 * @param {object} o
 * @param {string} o.title 书名
 * @param {string[]} o.files txt 文件路径（绝对或相对 dump/txt）
 * @param {string} [o.author]
 * @param {string} [o.source]
 * @param {boolean} [o.reflowParagraphs] 默认 true
 * @param {string} [o.outDir]
 */
export function packBook(o) {
  const files = (o.files || []).map((f) => (existsSync(f) ? f : join(TXT_DIR, f))).filter((f) => existsSync(f));
  if (!files.length) throw new Error('没有可打包的文件');
  const outDir = o.outDir || BOOK_DIR;
  mkdirSync(outDir, { recursive: true });

  const parts = [];
  let total = 0;
  for (const f of files) {
    let body = stripGutenberg(readFileSync(f, 'utf8'));
    // 打包前再兜一次：老 txt（补丁之前抓的）是繁体的话，这一步转成简体
    const conv = autoToSimplified(body);
    if (conv.converted) body = conv.text;
    if (o.reflowParagraphs !== false) body = reflow(body);
    total += body.length;
    parts.push({ file: f, name: basename(f), body });
  }

  const title = safeName(o.title || '未命名');
  const head = [
    `# ${o.title || '未命名'}`,
    '',
    o.author ? `作者：${o.author}` : '',
    o.source ? `来源：${o.source}` : '',
    `字符数：${total}`,
    `打包时间：${new Date().toLocaleString('zh-CN')}`,
    '',
    '---',
    '',
  ].filter((x) => x !== undefined && x !== '').join('\n');

  const multi = parts.length > 1;
  const md = head + parts.map((p, i) => `${multi ? `\n## ${i + 1}. ${title}\n` : ''}\n${p.body}\n`).join('\n');
  const mdPath = join(outDir, `${title}.md`);
  writeFileSync(mdPath, md, 'utf8');

  // 纯文本版：去掉 markdown 标记，方便塞进阅读器 / 手机
  const txt = md.replace(/^# /m, '').replace(/^## /gm, '').replace(/^---$/gm, '—'.repeat(20));
  const txtPath = join(outDir, `${title}.txt`);
  writeFileSync(txtPath, txt, 'utf8');

  return {
    title: o.title || '未命名',
    files: parts.length,
    chars: total,
    md: mdPath,
    txt: txtPath,
    // 头一万字给模型瞄一眼，确认抓对了
    preview: parts.map((p) => p.body).join('\n\n').slice(0, 10000),
  };
}

// ---------------- 命令行 ----------------
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('fetch-batch.mjs')) {
  const args = parseArgs(process.argv.slice(2));
  try {
    if (args.pack) {
      const r = packBook({ title: args.pack, files: args._, author: args.author, source: args.source });
      console.log(JSON.stringify({ ok: true, ...r, preview: undefined }, null, 2));
    } else if (args['pack-dir']) {
      const dir = args._[0];
      if (!dir || !existsSync(dir)) throw new Error(`目录不存在: ${dir}`);
      const files = readdirSync(dir).filter((f) => f.endsWith('.txt')).sort().map((f) => join(dir, f));
      const r = packBook({ title: args['pack-dir'], files, author: args.author, source: args.source });
      console.log(JSON.stringify({ ok: true, ...r, preview: undefined }, null, 2));
    } else {
      const src = args._[0];
      if (!src) throw new Error('用法: node fetch-batch.mjs <urls.txt|url1,url2> [--dir 目录] [--follow N]');
      const urls = existsSync(src)
        ? readFileSync(src, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).map((x) => x.trim())
        : src.split(',');
      const r = await fetchMany(urls, { dir: args.dir, follow: Number(args.follow) || 0 });
      console.log(JSON.stringify({ ok: true, ...r }, null, 2));
    }
  } catch (e) {
    console.error('失败:', e.message);
    process.exit(1);
  }
}
