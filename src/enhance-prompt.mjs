/**
 * 【增强提示词】—— 输入框右下角那颗星星（2026-11-11 主人要的）。
 *
 * ## 它是什么
 *
 * 主人写下「帮我看看这个报错」，点一下星星，这句话被改写成
 * 「请分析这段报错的原因、定位出错的代码位置，并给出最小修复方案和验证步骤」，
 * 直接替换回输入框 —— 他自己决定发不发。
 *
 * ## 为什么单独一份提示词、单独一次调用
 *
 * 不能拿会话里的模型「顺手」改写：那会把改写过程、思考、甚至回答本身
 * 混进主人的会话历史里，他发出去的那句话就不再是干净的。所以这里是
 * **一次性独立调用**（chat() 非流式），system/user 两份提示词专门干这件事，
 * 结果不回写会话、不进历史。
 *
 * ## 提示词哪来的
 *
 * 照抄 WorkBuddy 的实现（主人要求「参考它的实现方式，保持交互与逻辑一致」）。
 * 其中三条是效果关键，改之前先想清楚：
 *   ① 语言跟随 —— 中文进必须中文出（英文提示词很容易把中文改写成英文）
 *   ② 只输出增强后的正文，不许带「好的，这是增强后的提示词：」这类壳
 *   ③ 长度克制（约 800 字）—— 增强不是扩写，写成长篇说明书反而难用
 *
 * ## 边界
 *
 * - 空输入：不调模型，直接返回 empty_input（界面那颗星星在空输入时根本不渲染）
 * - 模型返回空/只剩引号：算失败，别把输入框清空
 * - 被取消（主人再点一下星星）：抛 AbortError，界面静默恢复原文，不弹错误
 */

/** WorkBuddy 的 system 提示词（逐字照抄，只删掉无关的代码助手限定语）。 */
const SYSTEM_PROMPT = [
  'You are a Prompt Engineering Expert specializing in improving user prompts for an AI assistant.',
  'When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose.',
  '',
  'TASK: When given a prompt, analyze and enhance it to create a more effective version while maintaining its core purpose.',
  '',
  'ANALYSIS PROCESS:',
  'Evaluate the original prompt: identify the main objective, note any ambiguities or gaps, assess the clarity of instructions, check for missing context.',
  'Apply these prompt engineering principles: write clear specific instructions, include necessary context, set explicit parameters and constraints, structure the output format, add relevant examples, match tone and complexity to the use case, remove redundant information.',
  'Create the enhanced version: maintain the original goal, incorporate identified improvements, ensure clarity and completeness, be realistic in the features to add.',
  '',
  'IMPORTANT CONSTRAINTS:',
  "1. Language matching is the highest priority - You MUST strictly respond in the exact same language as the user's input. If the user writes in Chinese, respond in Chinese; if the user writes in English, respond in English. Do not mix languages unless the user's input itself mixes languages.",
  '2. Keep the enhanced prompt concise - maximum length should be around 800 characters.',
  '',
  'FORMAT: Provide only the enhanced prompt with no additional commentary.',
].join('\n');

/**
 * user 提示词模板。{input} 是主人原话。
 *
 * 最后那组 GOOD/BAD 例子不是凑数 —— WorkBuddy 那边实测发现模型爱输出
 * 「User input is in Chinese → Response must be in Chinese.」这种语言标注，
 * 反面例子是唯一能压住它的办法。
 */
const USER_PROMPT_TEMPLATE = [
  'You are a prompt enhancement assistant. Improve the user prompt while preserving its intent and language.',
  '',
  'USER INPUT:',
  '{input}',
  '',
  'TASK:',
  'Rewrite the user input into a clearer, more specific prompt for the target AI assistant.',
  '',
  'CRITICAL PRIORITY - LANGUAGE CONSISTENCY:',
  '1. You MUST detect the language of the user input above and write the enhanced prompt in that same language.',
  '2. If the user writes in Chinese, the enhanced prompt MUST be entirely in Chinese.',
  '3. If the user writes in English, the enhanced prompt MUST be entirely in English.',
  '4. If the user writes in any other language, the enhanced prompt MUST use that exact same language.',
  '5. If the user mixes languages, keep a natural matching mix. Do not translate the user intent into a single language.',
  '6. These language rules are behavior instructions only; never include language analysis or language labels in the output.',
  '',
  'ENHANCEMENT REQUIREMENTS:',
  '1. Return only the enhanced prompt text; do not add explanations, prefaces, markdown fences, labels, or analysis.',
  '2. Do not include language labels or meta notes such as "User input is in Chinese" or "Response must be in Chinese".',
  '3. Preserve the user original intent, topic, constraints, and target output type. Do not answer the request.',
  '4. Always make a substantive enhancement when possible: clarify the task, scope, constraints, and expected output.',
  '5. If the original prompt is already clear, lightly polish it instead of returning it unchanged.',
  '6. Keep the enhanced prompt complete and concise. Do not end with an unfinished list, dangling conjunction, or trailing colon.',
  '7. Do not add unrelated requirements, unsupported facts, or unnecessary sections.',
  '',
  'EXAMPLES:',
  'User input (Chinese): "请帮我解释这段代码的功能"',
  'Enhanced prompt: "请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。"',
  '',
  'User input (English): "Please explain what this code does"',
  'Enhanced prompt: "Explain what this code does, including its main purpose, key control flow, and any important edge cases."',
  '',
  'User input (Mixed): "这段代码有 bug，can you help me fix it?"',
  'Enhanced prompt: "请分析这段代码中的 bug，explain the root cause, and provide a minimal fix with necessary verification steps."',
  '',
  'BAD OUTPUT EXAMPLE:',
  'User input is in Chinese → Response must be in Chinese.',
  '请解释这段代码的主要功能',
  '',
  'GOOD OUTPUT EXAMPLE:',
  '请解释这段代码的主要功能、执行流程和关键逻辑，并指出可能需要注意的边界情况。',
].join('\n');

/**
 * 去掉模型可能包在外面的引号/代码栅栏。
 *
 * 三个来源：提示词里明说了不要，但模型有时候还是包；中文引号「」也常见；
 * 偶尔整个答案塞进 ``` 里。这里只剥「整段都被包住」的情况，
 * 中间出现的引号一个字都不动（不然会把「他说"你好"」改成「他说"你好」）。
 */
export function stripWrapping(text) {
  let s = String(text ?? '').trim();
  if (!s) return '';

  // ```lang\n....\n```
  const fence = s.match(/^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?```$/);
  if (fence) s = fence[1].trim();

  // 整段被一对引号包住（英文/中文/日式都算）
  const pairs = [['"', '"'], ["'", "'"], ['“', '”'], ['「', '」'], ['『', '』'], ['‘', '’']];
  let changed = true;
  while (changed && s.length >= 2) {
    changed = false;
    for (const [open, close] of pairs) {
      if (s.startsWith(open) && s.endsWith(close)) {
        // 只有「开头那个引号在内部不再出现」才算整段被包住，否则可能本来就带引号
        const inner = s.slice(open.length, s.length - close.length);
        if (!inner.includes(open) && !inner.includes(close)) {
          s = inner.trim();
          changed = true;
        }
      }
    }
  }
  return s;
}

/**
 * 增强一段提示词。
 *
 * @param {object} o
 * @param {string} o.text       主人输入框里的原话
 * @param {string} [o.sessionId] 用来继承这个会话选的模型（可选）
 * @param {string} [o.model]     指定模型名（优先于会话选择）
 * @param {AbortSignal} [o.signal] 取消信号（主人再点一下星星）
 * @returns {Promise<{ok:true,text:string} | {ok:false,code:string,error:string}>}
 *
 * 注意：这里**不抛异常**（除 AbortError 之外）—— 失败一律走返回值，
 * 让上层接口能稳定给出 {success:false,code} 这层结构，跟 WorkBuddy 对齐。
 */
export async function enhancePrompt({ text, sessionId = '', model, signal } = {}) {
  const raw = String(text ?? '').trim();
  if (!raw) return { ok: false, code: 'empty_input', error: '输入框是空的，没东西可增强。' };

  let chatFn;
  try {
    ({ chat: chatFn } = await import('./llm.mjs'));
  } catch (e) {
    return { ok: false, code: 'unknown', error: '加载模型模块失败：' + String(e?.message ?? e) };
  }

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: USER_PROMPT_TEMPLATE.replace('{input}', raw) },
  ];

  let data;
  try {
    data = await chatFn({ messages, sessionId, model, signal });
  } catch (e) {
    // 取消：原样抛出去，上层负责静默处理（界面不弹错误）
    if (e?.name === 'AbortError' || String(e?.message || '').includes('aborted')) {
      const err = new Error('enhance-prompt-aborted-by-user');
      err.name = 'AbortError';
      throw err;
    }
    return { ok: false, code: 'llm_error', error: '模型没回上来：' + String(e?.message ?? e) };
  }

  let content = '';
  try {
    const msg = data?.choices?.[0]?.message;
    content = String(msg?.content ?? '');
  } catch { content = ''; }

  const out = stripWrapping(content);
  if (!out) {
    return { ok: false, code: 'llm_error', error: '模型返回了空内容，输入框保持原文。' };
  }
  return { ok: true, text: out };
}
