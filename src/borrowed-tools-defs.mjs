/**
 * 借鉴工具的「工具定义」层（2026-11-15）
 *
 * 实现都在 borrowed-tools.mjs / borrowed-tools2.mjs，这里只把它们包成
 * tools.mjs 认的 { name, description, parameters, run } 条目。
 * 拆出来是为了 tools.mjs 只加一行 ...borrowedToolDefs，不用手改大数组。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { ctxNow } from './tools.mjs';
import { termStart, termSend, termRead, termClose, listTerminals, findFiles, readImage, goalSet, describeForSend } from './borrowed-tools.mjs';
import { editFile, batchFileList, ralphPlan, traceTurns } from './borrowed-tools2.mjs';
import { sendFileTool } from './tools-sendfile.mjs';

export const borrowedToolDefs = [
  {
    name: 'edit_file',
    description: '精准改文件：给「原来那段」和「换成什么」，只改那一处，不用整份重写。原文找不到会报错，出现多次也会报错（除非 allow_multiple）。改之前自动留 .bak-edit 备份。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径（工作区相对路径或绝对路径）' },
        old_str: { type: 'string', description: '要被替换掉的原文，写长一点更准，必须一字不差' },
        new_str: { type: 'string', description: '换成什么；传空字符串 = 删掉那段' },
        allow_multiple: { type: 'boolean', description: 'true = 这段出现好几次就全改掉；默认 false 会报错' },
      },
      required: ['path', 'old_str', 'new_str'],
    },
    run: async (args) => {
      const r = editFile(args.path, args.old_str, args.new_str, { allowMultiple: !!args.allow_multiple });
      const d = r.delta >= 0 ? '+' + r.delta : String(r.delta);
      return '改好了：' + r.path + '\n改了 ' + r.changes + ' 处，' + r.before + ' 字 → ' + r.after + ' 字（' + d + '）';
    },
  },
  {
    name: 'term_start',
    description: '开一个常驻终端：开了以后 cd、设的环境变量都留着，不用每条命令重来一次。开了拿 id 去 term_send / term_read。',
    parameters: {
      type: 'object',
      properties: {
        cwd: { type: 'string', description: '在哪个目录开，不填就当前目录' },
        shell: { type: 'string', description: '用哪个 shell，Windows 默认 powershell，不填就行' },
      },
    },
    run: async (args) => {
      const r = termStart({ cwd: args.cwd, shell: args.shell });
      return '终端开好了，id = ' + r.id + '（目录 ' + r.cwd + '，' + r.shell + '）\n用 term_send 往里面敲，term_read 看输出。';
    },
  },
  {
    name: 'term_send',
    description: '往常驻终端里敲一行命令（自动补回车）。敲完用 term_read 看结果。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'term_start 给的终端 id' },
        input: { type: 'string', description: '要敲的命令' },
      },
      required: ['id', 'input'],
    },
    run: async (args) => {
      termSend(args.id, args.input);
      return '敲进去了：' + String(args.input).slice(0, 200) + '\n等一下用 term_read 取输出。';
    },
  },
  {
    name: 'term_read',
    description: '看常驻终端从上次读完之后攒的输出（读完就清空缓冲）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '终端 id' } },
      required: ['id'],
    },
    run: async (args) => {
      const r = termRead(args.id);
      if (!r.output) return r.alive ? '（暂时没新输出）' : '（终端已经退出了，没有输出）';
      return r.output;
    },
  },
  {
    name: 'term_close',
    description: '关掉一个常驻终端。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '终端 id' } },
      required: ['id'],
    },
    run: async (args) => (termClose(args.id) ? '终端 ' + args.id + ' 关掉了。' : '没有这个终端：' + args.id),
  },
  {
    name: 'list_terminals',
    description: '看看现在开着哪些常驻终端。',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const l = listTerminals();
      if (!l.length) return '现在没开着终端。';
      return l.map((t) => t.id + ' | ' + t.cwd + ' | ' + (t.alive ? '活着' : '已退出') + ' | ' + t.shell).join('\n');
    },
  },
  {
    name: 'find_files',
    description: '按文件名/内容筛选找文件：给个目录和一条正则，自动跳过 node_modules、.git、dump 这些。比 search_files 多的是能按深度、条数限制，还能带内容匹配。',
    parameters: {
      type: 'object',
      properties: {
        dir: { type: 'string', description: '从哪个目录开始找，不填就当前目录' },
        pattern: { type: 'string', description: '正则，匹配文件名（或路径）；不填就是全列' },
        ignore: { type: 'array', items: { type: 'string' }, description: '要跳过的目录名，默认 node_modules/.git/dist/.cache/dump' },
        max_results: { type: 'number', description: '最多给几条，默认 200，上限 2000' },
        max_depth: { type: 'number', description: '最多往下几层，默认 12' },
        with_content: { type: 'boolean', description: 'true = 匹配文件内容，不是文件名' },
      },
    },
    run: async (args) => {
      const r = findFiles({
        dir: args.dir, pattern: args.pattern, ignore: args.ignore,
        maxResults: args.max_results, maxDepth: args.max_depth, withContent: args.with_content,
      });
      const head = '从 ' + r.start + ' 找了 ' + r.scanned + ' 个文件，命中 ' + r.found.length + ' 个' + (r.truncated ? '（到上限了，可能还有）' : '');
      if (!r.found.length) return head;
      return head + '\n' + r.found.map((f) => f.path + '  (' + f.size + ' B)').join('\n');
    },
  },
  {
    name: 'read_image',
    description: '直接看一张图（png/jpg/jpeg/gif/webp/bmp）：图会直接递到眼前，不用自己解码 base64。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '图片路径' } },
      required: ['path'],
    },
    run: async (args) => {
      const r = readImage(args.path);
      const kb = (r.size / 1024).toFixed(1);
      return {
        text: '[这是一张图片] ' + r.path + '（' + r.mime + '，' + kb + ' KB）—— 图已经直接给你了，看就行，别去猜。',
        images: [r.path],
      };
    },
  },
  {
    name: 'goal_set',
    description: '把这个会话的目标钉住：上下文被压掉、重启之后还认得「我在干什么」。不传 text 就是读当前目标，done=true 就是收工。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '这次要干成什么；不填就只读当前目标' },
        done: { type: 'boolean', description: 'true = 这个目标做完了，清掉' },
      },
    },
    run: async (args) => {
      const me = ctxNow().sessionId || 'default';
      const r = goalSet(me, args.text, args.done);
      if (!r.text) return args.done ? '目标清掉了，这个会话现在没有挂着的目标。' : '这个会话还没设过目标。';
      const when = r.updatedAt ? '\n（更新于 ' + new Date(r.updatedAt).toLocaleString('zh-CN', { hour12: false }) + '）' : '';
      return '当前目标：' + r.text + when;
    },
  },
  {
    name: 'send_files',
    description: '一次发好几个文件给主人：图片、视频、文档、压缩包都行，一次把一组路径递过去。',
    parameters: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: '要发的文件路径，一组' },
        note: { type: 'string', description: '一句话说这是啥' },
      },
      required: ['paths'],
    },
    run: async (args) => {
      const r = batchFileList(args.paths);
      const lines = [];
      for (const f of r.ok) {
        try {
          const d = describeForSend(f.path);
          await sendFileTool.run({ path: f.path, note: args.note });
          lines.push('发出去了：' + f.path + (d.mime ? '（' + d.mime + '）' : '') + (f.dir ? '（文件夹）' : ''));
        } catch (e) {
          lines.push('没发成：' + f.path + ' —— ' + String((e && e.message) || e));
        }
      }
      for (const b of r.bad) lines.push('找不到：' + b.path);
      return lines.join('\n') || '没有可发的。';
    },
  },
  {
    name: 'ralph',
    description: '「反复做到过」：说清要做到什么、拿什么命令验，它帮你把验收口诀和轮次记下来，一轮一轮试到过为止，别反复从头来。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '要做到什么（验收标准）' },
        check_cmd: { type: 'string', description: '拿什么命令验它过没过' },
        max_rounds: { type: 'number', description: '最多试几轮，默认 5' },
      },
      required: ['goal', 'check_cmd'],
    },
    run: async (args) => {
      const stateDir = join(config.dataDir, '.state', 'task');
      mkdirSync(stateDir, { recursive: true });
      const r = ralphPlan(args.goal, args.check_cmd, { stateDir, maxRounds: args.max_rounds });
      const over = r.over ? '（轮数用完了，该说实话了）' : '';
      return '第 ' + r.round + ' 轮 / 最多 ' + r.maxRounds + ' 轮' + over +
        '\n目标：' + r.goal + '\n验收：' + r.checkCmd + '\n状态记在 ' + r.path;
    },
  },
  {
    name: 'trace_turns',
    description: '翻这一场会话的轮次：每轮调了哪些工具、哪个挂了、错在哪。查「刚才第几轮到底哪一步出的问题」用它，比翻整个会话文件快。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '看最近几轮，默认 40' },
        session_id: { type: 'string', description: '哪个会话，不填就当前这个' },
      },
    },
    run: async (args) => {
      const sid = args.session_id || ctxNow().sessionId;
      if (!sid) return '不知道是哪个会话，给我 session_id。';
      const f = join(config.dataDir, '.state', 'sessions', sid + '.json');
      if (!existsSync(f)) return '找不到会话文件：' + f;
      let data;
      try {
        data = JSON.parse(readFileSync(f, 'utf8'));
      } catch (e) {
        return '会话文件读不了：' + String((e && e.message) || e);
      }
      const msgs = Array.isArray(data) ? data : (data.messages || []);
      const r = traceTurns(msgs, { limit: args.limit });
      if (!r.rounds.length) return '没翻到工具调用。';
      const out = r.rounds.map((x) => {
        const bad = x.failed.length
          ? '  ✗ ' + x.failed.map((f2) => f2.tool + '：' + String(f2.err).replace(/\s+/g, ' ')).join(' / ')
          : '';
        return '第' + x.round + '轮（' + x.total + ' 次）：' + (x.tools.join(', ') || '没调工具') + bad;
      });
      return '共 ' + r.roundsSeen + ' 轮，最近这些：\n' + out.join('\n');
    },
  },
];
