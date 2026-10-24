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
import { sayTool } from './tools-say.mjs';

const LIMIT = 20000;

const ROOT = resolve(config.workspace);
/** 程序自己的安装目录（src 的上一级），scripts/ 和 dump/ 都在这下面 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Per-run context (which session is talking) so plan/note land in the right board. */
const CTX = { sessionId: 'default', snap: null, outbox: null, signal: null };
/**
 * 指定本轮消息的文件快照对象（对话回退要用）。
 *
 * 传 null 就是「这轮不管文件」——cli、自检这些不走回退的调用方就这么用。
 */
export function setToolContext(sessionId, snap = null, signal = null) {
  CTX.sessionId = sessionId || 'default';
  CTX.snap = snap && typeof snap === 'object' ? snap : null;
  // 这一轮的 AbortSignal：主人点停止 / 点退出时，长命令（Start-Sleep、ffmpeg、装依赖）
  // 要能被真的打断。否则 agent 卡在 await 里，那一轮的 finally 永远不执行，
  // 磁盘上就只剩主人那句话 —— 看起来像「她压根没回」。
  CTX.signal = signal && typeof signal === 'object' ? signal : null;
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
    description:
      '读一个文本文件的内容。工作区里的相对路径，或主人机器上的绝对路径都行（带中文、空格也没问题）。大文件会截断。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '工作区里的相对路径' } },
      required: ['path'],
    },
    async run({ path }) {
      return clip(await readFile(safePath(path), 'utf8'));
    },
  },
  {
    name: 'write_file',
    description:
      '新建或整个覆盖一个文本文件（代码、报告、配置、笔记都行）。要改已有文件的一小段，先 read_file 再整份写回去；父目录不存在会自动建。',
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
    description:
      '看一个目录里有什么文件和子目录，带大小和修改时间。不知道文件在哪、要找刚下载的东西，就先列一下。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '目录；「.」表示工作区根' } },
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
    description:
      '在本机跑一条命令（Windows 上是 PowerShell，工作区当前目录）。装依赖、跑脚本、压包、转格式、调 ffmpeg、查环境全都靠它。返回 stdout 和 stderr 合并的结果。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    run({ command }) {
      const signal = CTX.signal;
      return new Promise((done) => {
        const child = exec(
          command,
          { cwd: ROOT, timeout: 120000, maxBuffer: 4 * 1024 * 1024, shell: process.platform === 'win32' ? 'powershell.exe' : '/bin/sh' },
          (err, stdout, stderr) => {
            if (onAbort) signal.removeEventListener('abort', onAbort);
            const parts = [];
            if (stdout) parts.push(stdout);
            if (stderr) parts.push(stderr);
            if (aborted) { parts.push('[被主人叫停了，命令已经掐掉]'); }
            else if (err && !stdout && !stderr) parts.push(`exit ${err.code}: ${err.message}`);
            done(clip(parts.join('\n').trim() || '(no output)'));
          },
        );
        // 主人点停止 / 点退出：立刻把子进程砍掉，别让整轮卡在一个跑不完的命令上。
        let aborted = false;
        let onAbort = null;
        if (signal && typeof signal.addEventListener === 'function') {
          if (signal.aborted) {
            aborted = true;
            try { child.kill('SIGTERM'); } catch {}
          } else {
            onAbort = () => {
              aborted = true;
              try { child.kill('SIGTERM'); } catch {}
              // PowerShell 有时候不吃 SIGTERM，2 秒后补一刀
              setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 2000);
            };
            signal.addEventListener('abort', onAbort, { once: true });
          }
        }
      });
    },
  },
  {
    name: 'plan',
    description:
      '维护这次任务的分步清单：多步的活儿开工前先列出 3~8 步，做一步勾一步，随时能读回来。别没计划就开干。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'add', 'view', 'clear'],
          description:
      '维护这次任务的分步清单：create 新建，update 改某一步的状态，add 追加一步，view 看当前清单，clear 清空。长任务先用它把步骤列出来，别做到一半忘了。',
        },
        goal: { type: 'string', description: '一句话说清主人要什么（仅 create）' },
        steps: {
          type: 'array',
          items: { type: 'string' },
          description: '一步一个动作，3~8 步（仅 create）',
        },
        stepId: { type: 'number', description: '要改第几步（仅 update）' },
        status: {
          type: 'string',
          enum: ['pending', 'doing', 'done', 'skipped'],
          description: '这一步的新状态（仅 update）',
        },
        note: { type: 'string', description: '这一步的一句话结果备注（仅 update）' },
        text: { type: 'string', description: '新增那一步写什么（仅 add）' },
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
      '记便签：这次任务里不能丢的关键数字、路径、结论，先记下来，下一步再 action=view 读回来。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'view', 'clear'], description: '不填就当 add' },
        text: { type: 'string', description: '要记住的内容（仅 add）' },
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
      '上网搜，拿回一串带编号的结果（标题、网址、摘要）。答案要看最新情况就先用它，再拿 fetch_url 打开最合适的那条看细节。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词' },
        limit: { type: 'integer', description: '要几条结果，默认 8，最多 20' },
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
    description:
      '打开一个网页，把正文抽出来给你看（去掉 HTML 标签，大约 6000 字以内）。想读某篇文章、某个文档页就用它。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) 网址' } },
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
      '抓一个网页、剥成纯文本（自动认编码：utf-8 / gbk / gb2312 / big5 / bom，中文页不会再乱码），存到 dump/txt 下，返回存到哪、多少字、认出来的编码。繁体页（繁體）会先自动转成简体（简体）再存。想把页面留在硬盘上就用它。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'http(s) 网址' } },
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
      '一次批量抓很多个网页（编码自动识别，跟 fetch_txt 一样）：给一串网址，或给一个 urls.txt 路径，每页各存成一个 txt 放在 dump/txt 下。还能顺着每个起始网址的「下一页」往下翻若干次。返回每个网址成功/失败、存到哪、标题、字数、识别到的编码。要抓三个以上的页面就用它，别用 fetch_txt 一个个循环。',
    parameters: {
      type: 'object',
      properties: {
        urls: { type: 'array', items: { type: 'string' }, description: '要抓的 http(s) 网址，可以给多个' },
        file: { type: 'string', description: '也可以给一个 txt 路径，里面一行一个网址（工作区相对路径或绝对路径都行）' },
        dir: { type: 'string', description: '存到哪个目录，默认是程序目录下的 dump/txt' },
        follow: { type: 'integer', description: '每个起始网址顺着「下一页」往下翻几次，0 = 不翻，最多 20' },
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
      '把已经抓下来的零散 txt 章节拼成一整本书：会去掉 Project Gutenberg 的页头页尾、把硬换行接回段落，写出 dump/books/<书名>.md 和 <书名>.txt（UTF-8），返回两个路径、字数和一个开头预览。抓完一批页面之后用它收尾。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '书名，也当文件名用' },
        files: { type: 'array', items: { type: 'string' }, description: '各章 txt 的路径或 dump/txt 下的文件名，按阅读顺序排' },
        dir: { type: 'string', description: '也可以给一个目录，把这个目录下所有 .txt 按文件名顺序打包' },
        author: { type: 'string', description: '作者，可有可无' },
        source: { type: 'string', description: '来源网址，可有可无' },
        reflow: { type: 'boolean', description: '把硬换行重新接成段落，默认接' },
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
      '繁体转简体（OpenCC 词级转换，頭髮→头发、軟體→软件）。可以给一段文字，也可以给工作区里的文件路径，返回简体结果；inPlace=true 会直接把那个文件改写成简体（原文留一份 .bak-t2s）。主人丢来繁體文字或繁體 txt、想看得顺时就用它。',
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
  sayTool,
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

/**
 * 启动自检：每个工具都得有中文 description 和中文参数说明。
 *
 * 为什么要查：工具清单是**从 schema 自动生成**塞进系统提示的（见 persona.mjs 的 toolBlock）。
 * 哪天加了新工具忘了写中文 description，模型就会拿着一行英文去判断该不该用 —— 等于白给。
 * 这里只在启动时 console.warn，不抛错、不影响服务起来。
 */
export function checkToolDocs() {
  const problems = [];
  const hasCjk = (s) => /[\u4e00-\u9fff]/.test(String(s ?? ''));
  for (const t of tools) {
    if (!hasCjk(t.description)) problems.push(`${t.name}: description 没有中文`);
    const props = (t.parameters && t.parameters.properties) || {};
    for (const [key, spec] of Object.entries(props)) {
      if (spec && spec.description && !hasCjk(spec.description)) {
        problems.push(`${t.name}.${key}: 参数说明没有中文`);
      }
    }
  }
  return problems;
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
