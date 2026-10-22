// Built-in tools. Each tool: { name, description, parameters(JSON Schema), run(args) }
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises';
import { exec } from 'node:child_process';
import { resolve, dirname, isAbsolute, relative } from 'node:path';
import { config } from './config.mjs';
import { planAction, noteAction } from './plan.mjs';
import { isToolEnabled, featureNameOfTool, enabledToolNames } from './features.mjs';
import { snapshotBeforeWrite } from './rewind.mjs';
import { webSearch, formatResults } from './search.mjs';

const LIMIT = 20000;

const ROOT = resolve(config.workspace);

/** Per-run context (which session is talking) so plan/note land in the right board. */
const CTX = { sessionId: 'default', snap: null };
/**
 * 指定本轮消息的文件快照对象（对话回退要用）。
 *
 * 传 null 就是「这轮不管文件」——cli、自检这些不走回退的调用方就这么用。
 */
export function setToolContext(sessionId, snap = null) {
  CTX.sessionId = sessionId || 'default';
  CTX.snap = snap && typeof snap === 'object' ? snap : null;
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
        // Windows 上中文会变成「С��Agent」这种乱码，两个原因叠在一起：
        //   1. powershell.exe 把输出按系统代码页（GBK）写出来，node 按 UTF-8 读 —— 必须让 PS 自己转 UTF-8；
        //   2. node 默认解码用的还是 gbk 之外的东西，所以要显式 utf8。
        // 连带把 $OutputEncoding / [Console]::OutputEncoding 一起钉成 UTF-8，管道里的原生程序（curl、git）也不乱。
        const isWin = process.platform === 'win32';
        const wrapped = isWin
          ? '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ' + command
          : command;
        exec(
          wrapped,
          {
            cwd: ROOT,
            timeout: 120000,
            maxBuffer: 4 * 1024 * 1024,
            encoding: 'utf8',
            shell: isWin ? 'powershell.exe' : '/bin/sh',
            windowsHide: true,
          },
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
      // UA 里不能有中文：fetch 要求 header 值全是单字节，写「小鱼Agent」会直接抛
      // "Cannot convert argument to a ByteString"，导致 fetch_url 每次必挂。
      const res = await fetch(url, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        },
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = htmlToText(await res.text());
      return clip(text.length > 6000 ? `${text.slice(0, 6000)}\n...[truncated]` : text);
    },
  },
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
    return { ok: true, output: await tool.run(args) };
  } catch (err) {
    return { ok: false, output: String(err?.message ?? err) };
  }
}
