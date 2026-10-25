/**
 * 子智能体：叫一个「小鲸」出来，独立跑一轮完整的干活循环。
 *
 * 跟主人的那个「我」完全分开：
 *   - 独立的消息历史（不污染主人的会话）
 *   - 独立的 sessionId（计划、便签落到它自己名下，不串到主人的板上）
 *   - 独立的工具循环（自己去调模型、跑工具、再调模型，直到给出结论）
 *   - 独立的超时（跑太久直接掐，别把主人那一轮拖死）
 *
 * 它最后只把「结论」交回来 —— 中间调了多少次工具、想了什么，
 * 主智能体看不到，也不必看。这样主人的上下文能省一大截。
 *
 * 几道必须有的闸：
 *   一、嵌套深度上限（MAX_SUBAGENT_DEPTH）：子智能体不许再开子智能体到无限层。
 *   二、轮数上限：防止模型在工具循环里打转。
 *   三、总超时：防止某个工具卡住把整轮拖死。
 *   四、工具白名单：默认只给「查」类工具（读文件、看目录、搜网页），
 *      不给写文件、跑命令 —— 子智能体是来查资料的，不是来动主人电脑的。
 *      想要它干活就显式传 allowWrite。
 */
import { streamChat } from './llm.mjs';
import { enabledToolSchemas, runTool, pushToolContext, setToolContext, subagentDepth, bumpSubagentDepth, dropSubagentDepth, MAX_SUBAGENT_DEPTH } from './tools.mjs';
import { featureNameOfTool } from './features.mjs';
import { config } from './config.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 查资料默认允许的工具。都是只读的，不会动主人的东西。 */
const READONLY_TOOLS = new Set([
  'read_file',
  'list_dir',
  'web_search',
  'fetch_url',
  'fetch_txt',
  'fetch_many',
  'pack_book',
  't2s_convert',
  'note',
]);

/** 干活才会用到的工具。要显式 allowWrite 才给。 */
const WRITE_TOOLS = new Set(['write_file', 'run_command', 'send_file', 'say']);

/**
 * 把子智能体交回来的文字「去客套」。
 *
 * 提示词里写了两遍「不要以『如果需要』结尾」，模型还是照说不误。
 * 那就别指望它了 —— 交回来之前我们自己切。
 *
 * 做法：从后往前找，如果最后一段是那类推销/反问的话，整段删掉，直到尾巴正常为止。
 */
function trimFiller(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return raw;
  const paras = raw.split(/\n\s*\n/);
  // 明显是「推销/反问」的段落特征
  const smelly = [
    /如果你(还)?(有|需要|想)/,
    /需要的话/,
    /我(还)?可以(帮|再|先|接着)/,
    /你(可以|能)?(自己|手动)/,
    /告诉我想/,
    /(还有|其他)(什么|别的)?(需求|问题)/,
    /随时(告诉|说|找我)/,
    /要我(再|帮)?(看看|做|查|递归)/,
    /^你有两个选择/,
    // 反问式收尾：模型特爱用这三种
    /吗？?\s*$/,
    /要不要/,
    /需要你/,
    /或者直接/,
    /另外提醒/,
    /^另外，/,
  ];
  while (paras.length > 1) {
    const last = paras[paras.length - 1];
    const hit = smelly.some((re) => re.test(last));
    if (!hit) break;
    paras.pop();
  }
  // 段落内部也可能是一行尾巴，去掉以「如果你/需要的话」开头的行
  const kept = paras.join('\n\n').split('\n').filter((line) => {
    const t = line.trim();
    if (!t) return true;
    return !/^(如果你|需要的话|你可以自己|或者告诉|随时|要我|要不要|另外|或者直接|需要你)/.test(t);
  });
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const DEFAULT_MAX_ROUNDS = 12;
const DEFAULT_TIMEOUT_MS = 180000; // 3 分钟

/**
 * 跑一个子智能体，返回它的结论文本。
 *
 * @param {object} opts
 * @param {string} opts.task          要它干什么（自然语言，越具体越好）
 * @param {string} [opts.name]        它的名字，默认「小鲸」
 * @param {number} [opts.maxRounds]   最多几轮工具循环
 * @param {number} [opts.timeoutMs]   总超时
 * @param {boolean} [opts.allowWrite] 允许它写文件 / 跑命令
 * @param {string} [opts.model]       指定模型（不传就跟主人当前用的那个）
 * @param {(msg:string)=>void} [opts.onProgress] 进度回调（主智能体看不到，日志用）
 */
/**
 * 程序本体所在目录（electron / src / public 那一层的父目录）。
 *
 * 为什么子智能体要知道它：主人问「这个项目里有多少文件」时，问的是程序本体，
 * 不是工作区。只告诉它工作区的话，它会在工作区里数出个位数就交卷。
 */
const appRoot = (() => {
  try {
    // subagent.mjs 在 <appRoot>/src/ 下，往上退两层就是程序根
    return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  } catch {
    return '';
  }
})();

export async function runSubagent({
  task,
  name = '小鲸',
  maxRounds = DEFAULT_MAX_ROUNDS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowWrite = false,
  model = '',
  sessionId = '',
  onProgress = () => {},
} = {}) {
  const cleanTask = String(task ?? '').trim();
  if (!cleanTask) {
    return { ok: false, text: '没有给我任务内容（task 是空的）。' };
  }

  // ---- 闸一：嵌套深度 ----
  if (subagentDepth() >= MAX_SUBAGENT_DEPTH) {
    return {
      ok: false,
      text: `已经套到 ${MAX_SUBAGENT_DEPTH} 层了，不能再往下开子智能体（会无限套娃）。这次请自己动手。`,
    };
  }

  // 子智能体用自己的一套上下文。跑完必须还原，否则主人的工具调用会落到这里来。
  const restoreCtx = pushToolContext();
  const subSessionId = sessionId || `sub-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  setToolContext(subSessionId, null, null);
  bumpSubagentDepth();

  const abortCtrl = new AbortController();
  const timer = setTimeout(() => {
    try { abortCtrl.abort('timeout'); } catch {}
  }, Math.max(5000, timeoutMs));

  try {
    // ---- 工具白名单 ----
    const allowed = allowWrite
      ? new Set([...READONLY_TOOLS, ...WRITE_TOOLS])
      : READONLY_TOOLS;
    const toolSchemas = enabledToolSchemas().filter((t) => allowed.has(t.function.name));

    const systemPrompt = [
      `你是「${name}」，是主智能体叫出来专门查事情的子智能体。`,
      '',
      '你的活法：',
      '- 拿到一个具体问题，自己去找答案：能查文件就查文件，能上网就上网，别凭印象瞎编。',
      '- 查到了就提炼成结论，直接交回去。',
      '- 交回去的东西要能直接用：该给路径的给路径，该给数字的给数字，该说「没查到」就直说没查到。',
      '',
      `你手上能用这些工具：${toolSchemas.map((t) => t.function.name).join('、') || '（一个都没有）'}`,
      '',
      '工作区就在这儿：' + (config.workspace || process.cwd()),
      '相对路径都按它算。找东西先 list_dir 看一眼这个目录，别满磁盘乱翻；',
      '连查两三次还找不到，就停下来说「没找到，找过这些地方：…」，别一直翻。',
      /**
       * 项目根目录：主人嘴里说的「这个项目」「源码目录」，指的常常是程序本体那份，
       * 不是工作区。两个都写出来，让它自己判断该看哪个 ——
       * 不然会出现「问项目里有多少文件，它去工作区数了 2 个就交卷」这种事。
       */
      appRoot && appRoot !== (config.workspace || process.cwd())
        ? '程序本体的目录（主人说的「项目」「源码」一般指这个）：' + appRoot
        : null,

      /**
       * 别把简单问题搞复杂。
       *
       * 踩过：问「src 下有多少个 .mjs」，它连查 7 轮、调 9 次工具、烧掉 5 万 token，
       * 还写了段「### 统计方式」的说明。主人要的是数字，不是报告。
       */
      '交结论的时候，一句话能说清就一句话。不要写小标题、不要分点、不要解释你怎么查的。',
      '问「多少个」就回数字加文件名；问「在哪」就回路径；问「是什么」就回答案本身。',
      allowWrite ? '' : '注意：你只能查，不能改东西（没有写文件、跑命令的权限）。',
      '',
      '说话方式：不寒暄、不铺垫、不用颜文字。给的是结论，不是聊天。',
      '你【没有嘴】，主人看不见你的话——你交回去的这段文字只会给主智能体看。',
      '所以不许反问、不许说「你能手动建一下吗」「需要的话告诉我」这类话，',
      '也不许把活推回去。能干就干完，干不了就直说「这件事我这个权限做不到，原因是……」。',
      '写完直接结束。绝对不要以「如果你有…」「需要的话…」「我还可以…」结尾——',
      '主智能体不需要你推销自己，它要的是结论。',
    ].filter(Boolean).join('\n');

    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: cleanTask },
    ];

    const trace = [];
    let totalUsage = null;

    for (let round = 0; round < maxRounds; round++) {
      if (abortCtrl.signal.aborted) {
        return { ok: false, text: `超时了（${Math.round(timeoutMs / 1000)} 秒还没查完）。已经查到的：\n${trace.join('\n') || '（无）'}`, timedOut: true };
      }

      let text = '';
      let toolCalls = [];
      let usage = null;

      for await (const ev of streamChat({
        messages,
        tools: toolSchemas,
        signal: abortCtrl.signal,
        sessionId: subSessionId,
      })) {
        if (ev.type === 'text') text += ev.text;
        else if (ev.type === 'tool_calls') toolCalls = ev.toolCalls;
        else if (ev.type === 'usage') usage = ev.usage;
      }

      if (usage) {
        totalUsage = totalUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
        totalUsage.prompt_tokens += Number(usage.prompt_tokens ?? 0);
        totalUsage.completion_tokens += Number(usage.completion_tokens ?? 0);
        totalUsage.total_tokens += Number(usage.total_tokens ?? 0);
      }

      // 没有工具调用 = 它说完了，就是结论
      if (!toolCalls.length) {
        return {
          ok: true,
          text: trimFiller(text) || '（它查完什么都没说）',
          rounds: round + 1,
          tools: trace.length,
          usage: totalUsage,
          sessionId: subSessionId,
        };
      }

      // 有工具调用：记下 assistant 那轮，跑工具，把结果喂回去
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolCalls.map((tc, i) => ({
          id: tc.id || `sub_${round}_${i}`,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments || '{}' },
        })),
      });

      for (const tc of toolCalls) {
        const label = featureNameOfTool(tc.name) || tc.name;
        onProgress(`[${name}] 调工具：${tc.name}`);

        let out;
        if (!allowed.has(tc.name)) {
          out = { ok: false, output: `「${tc.name}」不在你这个子智能体的权限里（只能查、不能改）。` };
        } else {
          try {
            out = await runTool(tc.name, tc.arguments);
          } catch (e) {
            out = { ok: false, output: String(e?.message ?? e) };
          }
        }

        trace.push(`${tc.name} → ${out.ok ? '成' : '败'}：${String(out.output).slice(0, 120).replace(/\n/g, ' ')}`);

        messages.push({
          role: 'tool',
          tool_call_id: tc.id || `sub_${round}_${toolCalls.indexOf(tc)}`,
          content: out.ok ? out.output : `ERROR: ${out.output}`,
        });
      }
    }

    // 轮数用完了还没收尾
    return {
      ok: false,
      text: `查了 ${maxRounds} 轮还没得出答案，先停在这儿。中间做过：\n${trace.join('\n') || '（无）'}`,
      rounds: maxRounds,
      tools: trace.length,
      usage: totalUsage,
      sessionId: subSessionId,
    };
  } catch (err) {
    return { ok: false, text: `子智能体出错了：${String(err?.message ?? err)}` };
  } finally {
    clearTimeout(timer);
    dropSubagentDepth();
    restoreCtx();
  }
}
