// Built-in tools. Each tool: { name, description, parameters(JSON Schema), run(args) }
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { exec, execFile } from 'node:child_process';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
import { planAction, noteAction } from './plan.mjs';
import { isToolEnabled, featureNameOfTool, enabledToolNames } from './features.mjs';
import { snapshotBeforeWrite } from './rewind.mjs';
import { webSearch, formatResults } from './search.mjs';
import { sendFileTool } from './tools-sendfile.mjs';

const LIMIT = 20000;

const ROOT = resolve(config.workspace);
/** 程序自己的安装目录（src 的上一级），scripts/ 和 dump/ 都在这下面 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Per-run context (which session is talking) so plan/note land in the right board. */
const CTX = { sessionId: 'default', snap: null, outbox: null };
/**
 * 指定本轮消息的文件快照对象（对话回退要用）。
 *
 * 传 null 就是「这轮不管文件」——cli、自检这些不走回退的调用方就这么用。
 */
export function setToolContext(sessionId, snap = null) {
  CTX.sessionId = sessionId || 'default';
  CTX.snap = snap && typeof snap === 'object' ? snap : null;
  // 这一轮要发给主人的文件（send_file 往里塞，跑完由 server 挂到回复上）
  CTX.outbox = null;
}

/**
 * 这一轮发出去的文件清单。给 runAgent 用：它每轮都新开一个，跑完交给 server。
 */
export function beginOutbox() {
  CTX.outbox = [];
  return CTX.outbox;
}

/** Resolve a model-supplied path inside the workspace; refuse escapes. */
function safePath(p) {
  const abs = isAbsolute(p) ? resolve(p) : resolve(ROOT, p);
  const rel = relative(ROOT, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`path outside workspace is not allowed: ${p}`);
  }
  return abs;
}

function clip(s) {
  return s.length > LIMIT ? `${s.slice(0, LIMIT)}\n...[truncated ${s.length - LIMIT} chars]` : s;
}

export const tools = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 text file from the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Relative path in workspace' } },
      required: ['path'],
    },
    async run({ path }) {
      return clip(await readFile(safePath(path), 'utf8'));
    },
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['path', 'content'],
    },
    async run({ path, content }) {
      const abs = safePath(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      return `wrote ${content.length} chars to ${path}`;
    },
  },
  {
    name: 'list_dir',
    description: 'List files and folders in a workspace directory.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory, "." for workspace root' } },
      required: ['path'],
    },
    async run({ path }) {
      const abs = safePath(path || '.');
      const entries = await readdir(abs, { withFileTypes: true });
      const rows = await Promise.all(
        entries.map(async (e) => {
          if (e.isDirectory()) return `${e.name}/`;
          try {
            const s = await stat(resolve(abs, e.name));
            return `${e.name} (${s.size}B)`;
          } catch {
            return e.name;
          }
        }),
      );
      return rows.sort().join('\n') || '(empty)';
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command (PowerShell on Windows) with the workspace as cwd. Returns combined stdout/stderr.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    run({ command }) {
      return new Promise((done) => {
        exec(
          command,
          { cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh' },
          (err, stdout, stderr) => {
            const parts = [];
            if (stdout) parts.push(stdout);
            if (stderr) parts.push(stderr);
            if (err && !stdout && !stderr) parts.push(`exit ${err.code}: ${err.message}`);
            done(clip(parts.join('\n').trim() || '(no output)'));
          },
        );
      });
    },
  },
  {
    name: 'plan',
    description:
      'Autopilot task board. Create a short checklist before a multi-step job, tick steps off as you go, and read it back. Never start a multi-step task without a plan.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'add', 'view', 'clear'],
          description: 'create = new checklist, update = set one step status, add = append a step, view = show it, clear = wipe it',
        },
        goal: { type: 'string', description: 'One line: what the user asked for (create only)' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: 'One action per step, 3~8 steps (create only)',
        },
        stepId: { type: 'number', description: 'Step number to update (update only)' },
        status: {
          type: 'string',
          enum: ['pending', 'doing', 'done', 'skipped'],
          description: 'New status for the step (update only)',
        },
        note: { type: 'string', description: 'Short result note for the step (update only)' },
        text: { type: 'string', description: 'Step text (add only)' },
      },
      required: ['action'],
    },
    async run(args) {
      return planAction(CTX.sessionId, args).text;
    },
  },
  {
    name: 'note',
    description:
      'Scratch notes for the current job: key numbers, paths, conclusions you must not lose between tool calls. Read them back with action=view.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'view', 'clear'], description: 'Default add' },
        text: { type: 'string', description: 'What to remember (add only)' },
        tag: { type: 'string', description: 'Optional tag, e.g. 结论 / 路径' },
      },
      required: [],
    },
    async run(args) {
      return noteAction(CTX.sessionId, args).text;
    },
  },
  {
    name: 'web_search',
    description:
      'Search the web and get a numbered list of results (title, URL, snippet). Use this first when the answer depends on current facts, then fetch_url the best link for details.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords' },
        limit: { type: 'integer', description: 'How many results, default 8, max 20' },
      },
      required: ['query'],
    },
    async run({ query, limit }) {
      const data = await webSearch(query, { limit });
      return formatResults(data);
    },
  },
  {
    name: 'fetch_url',
    description: 'Fetch a web page and return its readable text (HTML stripped, capped at ~6000 chars).',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL' } },
      required: ['url'],
    },
    async run({ url }) {
      if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs are allowed');
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (小鱼Agent)' },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = htmlToText(await res.text());
      return clip(text.length > 6000 ? `${text.slice(0, 6000)}\n...[truncated]` : text);
    },
  },
  {
    name: 'fetch_txt',
    description:
      'Fetch a web page, strip it to plain text (auto-detects charset: utf-8 / gbk / gb2312 / big5 / bom, so Chinese pages no longer come out garbled), save it under dump/txt, and return the saved path + length + detected charset. Traditional-Chinese pages (繁體) are automatically converted to Simplified (简体) before saving. Use when the page should be kept on disk.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) URL' } },
      required: ['url'],
    },
    run({ url }) {
      if (!/^https?:\/\//i.test(url)) throw new Error('only http(s) URLs are allowed');
      const script = resolve(APP_ROOT, 'scripts', 'fetch-txt.mjs');
      const outDir = resolve(APP_ROOT, 'dump', 'txt');
      return new Promise((done, fail) => {
        execFile(
          process.execPath,
          [script, url, outDir],
          { timeout: 120000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
          (err, stdout, stderr) => {
            if (err) return fail(new Error(String(stderr || err.message).trim()));
            done(String(stdout || "").trim() || "(no output)");
          },
        );
      });
    },
  },
  {
    name: 'fetch_many',
    description:
      'Batch-fetch many pages at once (same charset auto-detection as fetch_txt): pass a list of URLs or a urls.txt path, each page is saved as its own txt under dump/txt. Optionally follow "next page" links N times per seed URL. Returns per-URL ok/fail, saved paths, titles, char counts, detected charsets. Use this instead of calling fetch_txt in a loop when there are more than ~3 pages.',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: 'http(s) URLs to fetch' },
        file: { type: 'string', description: 'Alternative: path to a text file with one URL per line (workspace-relative or absolute)' },
        dir: { type: 'string', description: 'Output folder, default dump/txt under the app root' },
        follow: { type: 'integer', description: 'Follow the "next page" link this many times per seed URL, 0 = no follow, max 20' },
      },
    },
    async run({ urls, file, dir, follow }) {
      let list = Array.isArray(urls) ? urls.slice() : [];
      if (file) {
        const p = isAbsolute(file) ? file : resolve(ROOT, file);
        if (!existsSync(p)) throw new Error(`file not found: ${p}`);
        list = list.concat(
          readFileSync(p, 'utf8')
            .replace(/^\uFEFF/, '')
            .split(/\r?\n/)
            .map((x) => x.trim()),
        );
      }
      list = list.filter((x) => /^https?:\/\//i.test(x));
      if (!list.length) throw new Error('no http(s) URLs given');
      if (list.length > 300) throw new Error('too many URLs in one go (max 300), split it up');
      const finalDir = dir ? (isAbsolute(dir) ? dir : resolve(APP_ROOT, dir)) : resolve(APP_ROOT, 'dump', 'txt');
      const { fetchMany } = await import('../scripts/fetch-batch.mjs');
      const r = await fetchMany(list, { dir: finalDir, follow: Number(follow) || 0 });
      const lines = r.done.map(
        (d) =>
          `OK  ${d.url} -> ${d.file}  (${d.chars} chars, ${d.charset}${d.title ? ', ' + d.title : ''}${d.converted ? ', 已转简体' : ''})`,
      );
      const bad = r.failed.map((f) => `FAIL ${f.url}  ${f.error}`);
      return clip(
        [`saved to ${r.dir}`, `ok ${r.done.length} / fail ${r.failed.length}`, ...lines, ...bad].join('\n'),
      );
    },
  },
  {
    name: 'pack_book',
    description:
      'Stitch already-fetched txt pages into one book file: strips Project Gutenberg header/footer boilerplate, re-flows hard-wrapped lines into paragraphs, writes dump/books/<title>.md and <title>.txt (utf8), returns both paths + char count + a preview. Use after fetch_txt / fetch_many to turn many pages into a single readable book.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Book title, also used as the file name' },
        files: { type: 'array', items: { type: 'string' }, description: 'txt file paths or file names under dump/txt, in reading order' },
        dir: { type: 'string', description: 'Alternative: pack every .txt in this folder, sorted by name' },
        author: { type: 'string', description: 'Optional author line' },
        source: { type: 'string', description: 'Optional source URL' },
        reflow: { type: 'boolean', description: 'Re-flow hard-wrapped lines into paragraphs, default true' },
      },
      required: ['title'],
    },
    async run({ title, files, dir, author, source, reflow }) {
      const { packBook } = await import('../scripts/fetch-batch.mjs');
      const abs = (f) =>
        isAbsolute(String(f)) || existsSync(String(f))
          ? String(f)
          : existsSync(resolve(APP_ROOT, String(f)))
            ? resolve(APP_ROOT, String(f))
            : String(f);
      let list = (Array.isArray(files) ? files.slice() : []).map(abs);
      if (dir) {
        const d = isAbsolute(dir) ? dir : resolve(APP_ROOT, dir);
        if (!existsSync(d)) throw new Error(`dir not found: ${d}`);
        list = list.concat(
          readdirSync(d)
            .filter((f) => f.toLowerCase().endsWith('.txt'))
            .sort()
            .map((f) => resolve(d, f)),
        );
      }
      if (!list.length) throw new Error('no files to pack');
      const r = packBook({
        title,
        files: list,
        author,
        source,
        outDir: dir ? (isAbsolute(dir) ? dir : resolve(APP_ROOT, dir)) : undefined,
        reflowParagraphs: reflow !== false,
      });
      return clip(
        [
          `title: ${r.title}`,
          `pages: ${r.files}`,
          `chars: ${r.chars}`,
          `md: ${r.md}`,
          `txt: ${r.txt}`,
          '',
          '--- preview ---',
          r.preview,
        ].join('\n'),
      );
    },
  },
  {
    name: 't2s_convert',
    description:
      '繁体转简体（Traditional -> Simplified Chinese, uses OpenCC word-level conversion so 頭髮→头发, 軟體→软件). Give it text, or a file under the workspace (path), and it returns/gives back the Simplified version. With inPlace=true a workspace text file is overwritten in Simplified (original kept as .bak-t2s). Use when the master hands over 繁體 text or a 繁體 txt and wants it readable in 简体.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要转的文本（和 path 二选一）' },
        path: { type: 'string', description: '工作区里的文本文件路径（和 text 二选一）' },
        inPlace: { type: 'boolean', description: '传了 path 时，直接覆盖原文件为简体（原文件存成 .bak-t2s），默认 false 只返回结果' },
        from: { type: 'string', enum: ['twp', 'tw', 'hk'], description: '繁体的口音：twp=台繁+台湾用词（默认），tw=台繁，hk=港繁' },
      },
    },
    async run({ text, path, inPlace, from }) {
      const { toSimplified, autoToSimplified, converterReady } = await import('./zh-convert.mjs');
      if (!converterReady()) return '转简库没装上（缺 opencc-js），先别急着转，跟我说一声。';
      if (path) {
        const { resolve, isAbsolute } = await import('node:path');
        // 相对路径按「工作区」算，工作区没设就按程序根目录（dump/txt 就在那儿），
        // 绝对不按 cwd 算 —— 打包启动时 cwd 可能是 System32。
        const { writeFileSync, copyFileSync: cp, statSync, existsSync } = await import('node:fs');
        // 工作区里找不到，就按程序根目录再找一次（dump/txt 在那儿，抓来的书也顺手）
        const rel = String(path);
        const guesses = isAbsolute(rel)
          ? [rel]
          : [resolve(config.workspace || process.cwd(), rel), resolve(rel)];
        const abs = guesses.find((g) => existsSync(g)) || guesses[0];
        statSync(abs);
        const raw = readFileSync(abs, 'utf8');
        const r = autoToSimplified(raw, { from });
        if (!r.converted) return `这文件本来就是简体（繁体字占比 ${(r.ratio * 100).toFixed(1)}%），不用转：${abs}`;
        if (inPlace) {
          cp(abs, abs + '.bak-t2s');
          writeFileSync(abs, r.text, 'utf8');
          return `转好了，已覆盖：${abs}\n原文件备份：${abs}.bak-t2s\n字数：${raw.length} -> ${r.text.length}`;
        }
        return `转好了（没覆盖原文件，要覆盖就加 inPlace=true）：${abs}\n繁体字占比 ${(r.ratio * 100).toFixed(1)}%\n\n--- preview ---\n${r.text.slice(0, 800)}`;
      }
      const src = String(text ?? '');
      if (!src.trim()) return '没东西可转，把 text 或 path 给我一个。';
      const out = toSimplified(src, { from });
      return out === src ? `本来就是简体，一字没动：\n${out}` : out;
    },
  },
  sendFileTool,
];

/** Very small HTML -> text reducer (good enough for reading articles / docs). */
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6]|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const toolSchemas = tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.parameters },
}));

/** 只把【功能】面板里开着的工具交出去。关掉的功能，模型连看都看不到。 */
export function enabledToolSchemas() {
  const on = new Set(enabledToolNames());
  return toolSchemas.filter((t) => on.has(t.function.name));
}

export async function runTool(name, rawArgs) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) return { ok: false, output: `unknown tool: ${name}` };
  if (!isToolEnabled(name)) {
    const feat = featureNameOfTool(name) || name;
    return { ok: false, output: `「${feat}」现在是关着的，用不了这个工具。要用的话先在顶部【功能】里打开。` };
  }
  let args = {};
  try {
    args = typeof rawArgs === 'string' && rawArgs.trim() ? JSON.parse(rawArgs) : rawArgs ?? {};
  } catch {
    return { ok: false, output: `invalid JSON arguments for ${name}` };
  }
  // 写类工具动手前先留个底，回退时靠它把文件还原回去。
  if (name === 'write_file' && CTX.snap) {
    try {
      snapshotBeforeWrite(CTX.snap, args?.path);
    } catch {}
  }
  try {
    return { ok: true, output: await tool.run(args, CTX) };
  } catch (err) {
    return { ok: false, output: String(err?.message ?? err) };
  }
}
