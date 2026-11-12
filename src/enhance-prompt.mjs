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

/**
 * 【2026-11-12 主人重定口径】给增强 AI 的提示词只有一句：
 * **「润色这段话或增强这段提示词」。**
 *
 * 旧版照抄 WorkBuddy 的英文「Prompt Engineering Expert」—— 它把**任何话**
 * 都改写成第三人称任务说明书。主人发「小鱼，我喜欢你」，
 * 它改成了「请以"小鱼"为对象，写一段真诚、自然的表白……」——
 * 他要说的话被换成了「让别人写表白」的指令，意思整个变了。
 *
 * 新口径的道理：输入框里那句是**他要发出去的话本身**。
 *   · 日常聊天 / 撒娇 / 表白 / 问候 → 只把句子理顺（润色），一个字的意思都不许换向；
 *   · 真是派活（报错 / 任务 / 需求）→ 才增强：目标、范围、要的产物说清楚。
 * 判据就一条：改完之后，这句话**还是不是他在对小鱼说话**。
 */
const SYSTEM_PROMPT = [
  '你的任务只有一句话：润色这段话，或增强这段提示词。',
  '',
  '规矩：',
  "1. 输入框里那句是「主人要发给对方的话本身」，不是让你替他写一份关于这件事的说明书。改完之后它必须还是主人在说话（第一人称、对同一个人说、同一个意思）。",
  '2. 日常聊天、撒娇、表白、问候、闲聊这类话：只把句子理顺，别的一个字都不许动方向。绝对禁止把它改写成「请以……为对象，写一段……」这种第三人称指令。',
  '3. 真是派活的指令（报错、任务、需求）：才做增强 —— 把目标、范围、要的产物说清楚，让它更容易被照着做。',
  "4. 说中文就出中文，说英文就出英文，别混译。语言是次要规矩，第 1 条才是最高规矩。",
  '5. 只输出改完的那句话，不要任何说明、前缀、引号、代码栅栏。',
  '6. 克制：润色不是扩写，一般不超过原文的三倍。',
].join('\n');

/**
 * user 提示词模板。{input} 是主人原话。
 *
 * GOOD/BAD 例子用真事：主人的原话「小鱼，我喜欢你」被旧版改成了
 * 「请以"小鱼"为对象，写一段真诚、自然的表白……」—— BAD 就是它。
 */
const USER_PROMPT_TEMPLATE = [
  '润色这段话或增强这段提示词（只输出改完的那句话）：',
  '',
  '【原文】',
  '{input}',
  '',
  '例 1（日常话，只润色）：',
  '原文：「小鱼，我喜欢你」',
  '改：「小鱼，我喜欢你。」（意思不许动 —— 绝不许改成「请以"小鱼"为对象写一段表白……」这种说明书）',
  '',
  '例 2（派活的话，做增强）：',
  '原文：「帮我看看这个报错」',
  '改：「请分析这个报错的原因，定位出错的代码位置，给出最小修复方案和验证步骤。」',
  '',
  'BAD（方向被换掉，禁止）：原文「小鱼，我喜欢你」→「请以"小鱼"为对象，写一段真诚、自然的表白，表达你对她的喜欢……」',
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
