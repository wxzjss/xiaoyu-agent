// OpenAI-compatible chat client with streaming (SSE) support.
// 端点 / key / 模型名都从 models.mjs 取：界面里能换，.env 只是其中一套。
import { activeEndpoint } from './models.mjs';
import { levelFor, resolveLevel, withEffort, isThinkingUnsupported, contextOverflowSize } from './thinking.mjs';
import { compressHistory, noteRealTokens } from './compress.mjs';
import { endpointFor } from './models.mjs';
import { getOverride } from './session-overrides.mjs';
import { withTimeout, stallGuard, guardedStream, LLM_IDLE_MS } from './deadline.mjs';
import { join } from 'node:path';
import { appendFileSync, mkdirSync } from 'node:fs';
import { config } from './config.mjs';

/**
 * 这个错误是不是「连接被中途掐断」。
 *
 * undici（Node 内置 fetch）在流被对端关闭时会抛 TypeError: terminated，
 * cause 往往是 ECONNRESET / UND_ERR_SOCKET，或者干脆什么都没有。
 * 这类错误跟「key 错」「模型不存在」完全不是一回事，必须自己接住。
 */
export function isStreamDropError(err) {
  if (!err) return false;
  const name = String(err.name ?? '');
  const msg = String(err.message ?? '');
  const causeCode = String(err.cause?.code ?? '');
  const causeMsg = String(err.cause?.message ?? '');
  if (name === 'AbortError') return false; // 那是用户主动停的，别当网络抖动
  if (/terminated/i.test(msg)) return true;
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET|ETIMEDOUT|socket hang up/i.test(causeCode)) return true;
  if (/ECONNRESET|EPIPE|socket hang up|other side closed/i.test(causeMsg)) return true;
  if (/fetch failed/i.test(msg) && !/HTTP \d/.test(msg)) return true;
  return false;
}

/**
 * 【上游把一整页 HTML 甩过来的时候，别照着念】
 *
 * 真发生过：网关挂了自己先崩，回一个 502 的 Cloudflare 错误页 ——
 * `<!DOCTYPE html> … <title>windking.shop | 502: Bad gateway</title> …`。
 * 我们不认识它是网页，截 500 字直接塞进「LLM HTTP 502: ...」抛给界面，
 * 于是主人看到的是满屏 HTML 源码。既看不出哪家挂了，也不知道该等还是该改配置。
 *
 * 这里把 HTML、Cloudflare 那几个特殊码、纯空正文，统统翻成人话；
 * 认不出来的才原样留着（原文会另存 diag.log，界面上只留短的一截）。
 */

const CF_REASONS = {
  520: '网关那边回了个不认识的响应（Cloudflare 520）',
  521: '网关的源站拒连（Cloudflare 521）',
  522: '连网关的源站超时（Cloudflare 522）',
  523: '网关的源站地址找不到（Cloudflare 523）',
  524: '网关的源站回得太慢，超时了（Cloudflare 524）',
  525: '和网关的源站 SSL 握手失败（Cloudflare 525）',
  526: '网关的源站证书不对（Cloudflare 526）',
};

/**
 * 网关类错误：这种情况下游一句话都没收到，重试和等往往比查配置有用。
 * 422 不在此列 —— 那是我们发的东西不合规，得多试也是白试。
 */
export function isGatewayStatus(status) {
  const n = Number(status) || 0;
  return n === 502 || n === 503 || n === 504 || n === 520 || n === 521
    || n === 522 || n === 523 || n === 524 || n === 525 || n === 526 || n === 527;
}

const GATEWAY_HINT = '这多半是那家网关自己挂了，不是你配错了 —— 等一会儿再试，或者先换个模型。';

/** 从一段「可能是 HTML」的正文里，尽量抠出站点名和它自报的毛病。 */
function htmlFacts(text) {
  const t = String(text || '');
  const truthy = [
    /<title>([^<]{1,200})<\/title>/i.test(t) ? RegExp.$1 : '',
    /<h1[^>]*>([^<]{1,200})<\/h1>/i.test(t) ? RegExp.$1 : '',
    /<p[^>]*>([^<]{1,200})<\/p>/i.test(t) ? RegExp.$1 : '',
  ];
  const site = (() => {
    const m = t.match(/\b([a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)+\.[a-z]{2,})\b/i);
    return m ? m[1] : '';
  })();
  return { lines: truthy, site };
}

/**
 * 把「HTTP 状态 + 上游原话」整理成一句能读的结果。
 * @returns {{ text: string, gateway: boolean, looksHtml: boolean }}
 */
/**
 * 上游报错的原件留一份在 diag.log 里（界面只看人话，但排查还得有原话）。
 * 写不进去就算了 —— 记日志失败绝不许影响主流程。
 */
function noteUpstreamError(status, rawText, ep) {
  try {
    const dir = join(config.dataDir, '.state');
    mkdirSync(dir, { recursive: true });
    const who = [ep?.name, ep?.baseURL, ep?.model].filter(Boolean).join(' · ');
    const line = new Date().toISOString() + ' [llm-upstream] HTTP ' + status
      + (who ? ' ' + who : '') + ' :: ' + String(rawText ?? '').replace(/\s+/g, ' ').slice(0, 600) + NL;
    appendFileSync(join(dir, 'diag.log'), line, 'utf8');
  } catch { /* 记不上就算了 */ }
}

export function humanErrorOfUpstream(status, rawText) {
  const status2 = Number(status) || 0;
  const raw = String(rawText ?? '');
  const gateway = isGatewayStatus(status2);
  const looksHtml = /<\s*!?\s*DOCTYPE|<\s*html|<\s*head|<\s*title|<\s*style/i.test(raw);
  // 正文压根没回来（网关连页面都不给）
  if (!raw.trim()) {
    return {
      text: 'HTTP ' + status2 + (status2 ? ' ' : '') + '：上游一个字都没回。' + (gateway ? GATEWAY_HINT : ''),
      gateway,
      looksHtml: false,
    };
  }
  // 认得出来是网页：从网页里抠话，抠不出来就报「是一整页 HTML」
  if (looksHtml) {
    const { lines, site } = htmlFacts(raw);
    const said = lines.map((s) => String(s).replace(/\s+/g, ' ').trim()).filter(Boolean);
    const who = site ? '（' + site + '）' : '';
    let why = cfReason(status2) || (said[0] || '页面自报了毛病，但抠不出能读的一句');
    // 标题里常带着「站点 | 502: Bad gateway」这种，重复了就别写两遍
    if (site && why.includes(site)) why = why.split('|').pop().trim() || why;
    return {
      text: 'HTTP ' + status2 + (status2 ? ' ' : '') + who + why + '\n' + GATEWAY_HINT
        + '\n（上游回的是一整页 HTML 错误页，原文已经存进 diag.log，界面上就不铺开了。）',
      gateway,
      looksHtml: true,
    };
  }
  // 普通 JSON / 纯文本：尽量把 error.message 抠出来
  let said = "";
  try {
    const j = JSON.parse(raw);
    said = String(j?.error?.message || j?.message || j?.detail || '');
  } catch { said = ''; }
  if (!said) said = raw.slice(0, 220);
  const tail = gateway ? '\n' + GATEWAY_HINT : '';
  return { text: 'HTTP ' + status2 + (status2 ? ' ' : '') + said.trim() + tail, gateway, looksHtml: false };
}

function cfReason(status) {
  const n = Number(status) || 0;
  return CF_REASONS[n] || '';
}

function headers(ep) {
  const h = { 'Content-Type': 'application/json' };
  if (ep.apiKey) h.Authorization = 'Bearer ' + ep.apiKey;
  return h;
}

/**
 * 这次请求该用哪套模型参数。
 *
 * 会话里临时切过模型就用它 —— 通过 endpointFor 只读取那一套，**绝不改 activeId**，
 * 所以别的会话和右上角面板都不受影响。
 *
 * @param {string} [sessionId]
 */
/**
 * 【model 参数能是「模型名」，也能是「模型配置 id」】—— 2026-10-27 修
 *
 * 血案：小鲸的身份卡里选的是「deepseek官方」（id=mmvjvxqzcxple，
 * 地址 api.deepseek.com，模型名 deepseek-flash）。她的调用把 model 传成这个 id，
 * 这里却只做了 { ...全局默认, model: 'mmvjvxqzcxple' } —— 名字被换成了 id，
 * 地址还是全局默认那个网关。结果拿着 deepseek-flash 去丸子网关要渠道，
 * 回 503 model_not_found（No available channel for model deepseek-flash），
 * 她一张嘴就被掐死，日志里只剩一个「败」字，主人看到的就是「跟她说话她不回」。
 *
 * 现在：先拿 model 当 id 去配置表里找，找得到就连**地址和 key**一起用；
 * 找不到才当成纯模型名，套在当前那套上（老行为，别的调用方不受影响）。
 */
function epForModelArg(want, fallbackEp) {
  const id = String(want || '').trim();
  if (!id) return fallbackEp;
  const byId = endpointFor(id);
  if (byId) return byId;
  return { ...fallbackEp, model: id };
}

/**
 * 【2026-11-01 主人问「价钱到底按哪个模型算」时揪出来的坑】
 *
 * 同一个真模型名（deepseek-v4.1-flash）可能在模型面板里有好几条，
 * 现在就有三条：丸子（人民币）/ 凌风（美元）/ 飞鱼（人民币），价格差十倍。
 * 光拿模型名去找，找到哪条全凭命。所以给每一轮存量里再加一个 configId：
 * 它就是「这一轮真正跑的那条配置」的身份证，唯一。
 * 前端拿它查价，不再拿模型名猜。
 */
export function configIdForSession(sessionId) {
  try {
    if (sessionId) {
      const ov = getOverride(sessionId);
      if (ov && ov.modelId) return String(ov.modelId);
    }
    const ep = activeEndpoint();
    return String(ep?.id ?? '');
  } catch {
    return '';
  }
}

function endpointForForSession(sessionId) {
  if (!sessionId) return null;
  const ov = getOverride(sessionId);
  if (!ov.modelId) return null;
  return endpointFor(ov.modelId); // 模型被删了就返回 null，下面会回落到默认那套
}

/**
 * 把消息整理成「只带模型该看的东西」再发出去。
 *
 * 【为什么必须有这一步】
 * 我们把内部标记都塞在消息对象上（下划线开头）：`_whale` / `_tale` / `_say` /
 * `_usage` / `_mem` / `_ws` / `_text` / `_out` / `_internal` / `_recovered` …
 * 直接 `messages` 原样塞进请求体，模型下次读历史就看见了。
 *
 * 最要命的是 `_tale`：那是「这条是小鲸说的」的标记。
 * 主人要的是「我能一眼认出来，但她自己不能意识到这件事」——
 * 她要是看见历史里自己那条带着 `_tale: {who:'小鲸'}`，立刻就知道
 * 「原来我说的话是被单独标出来的」，那套「不像工具」的戏就演不下去了。
 *
 * 所以：只放行 `role / content / name / tool_calls / tool_call_id`。
 * 万一哪天有人加了新字段忘了这里，后果是「模型看见了内部字段」，
 * 不是「消息丢了内容」—— 这个方向出错更安全。
 */
const WIRE_KEYS = ['role', 'content', 'name', 'tool_calls', 'tool_call_id'];
export function wireMessage(m) {
  if (!m || typeof m !== 'object') return m;
  const out = {};
  for (const k of WIRE_KEYS) {
    if (m[k] !== undefined && m[k] !== null) out[k] = m[k];
  }
  // 网关不接受 content:null（有些连字段缺了都报错），带工具调用的那种补成空串
  if (out.role === 'assistant' && (out.content === undefined || out.content === null)) out.content = '';
  if (out.role === 'tool' && out.content === undefined) out.content = '';
  return out;
}
/**
 * 【把 tool 消息的配对理顺 —— 2026-11-01 主人报了 400】
 *
 * 主人原话：会话名【清单2】报「⚠ LLM HTTP 400: Messages with role 'tool' must be a
 * response to a preceding message with 'tool_calls'」。
 *
 * 真因（实测那个会话 1753 条里有 **668 条**孤儿）：历史被压缩/裁剪时，
 * 带 tool_calls 的那条 assistant 被整块折走了，可它下面那一大串 tool 响应留下了。
 * OpenAI 协议要求每条 role:'tool' 必须紧跟在声明它的 tool_calls 后面，
 * 于是整个请求当场 400，这个会话从此**一句话都发不出去**。
 *
 * 这里做两件事，都是「出门前最后一道」：
 *  ① 孤儿 tool（前面没有认领它的 tool_calls）→ 直接丢掉。它对应的调用都没有了，
 *     留着只会让整个会话报废；丢掉的只是工具结果文本，不影响对话本身。
 *  ② 有 tool_calls 但没湊齐响应的 → 补一条占位响应该死，别让模型看到半截。
 *     （少了响应，网关同样会拒。）
 *
 * 只动发出去的这一份，**不动内存里的 messages、不动磁盘上的会话** ——
 * 主人还能在界面上看见那些工具记录，只是不再发给模型。
 */
export function normalizeToolPairing(list) {
  const arr = Array.isArray(list) ? list : [];
  const out = [];
  // 当前这组 tool_calls 里，还没被响应掉的 id
  let open = null;

  const closeOpen = () => {
    if (open && open.ids.size) {
      for (const id of open.ids) {
        out.push({ role: 'tool', tool_call_id: id, content: '（这条工具结果没有回传）' });
      }
    }
    open = null;
  };

  for (const raw of arr) {
    const m = wireMessage(raw);
    if (!m || typeof m !== 'object') continue;

    if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      // 上一组还没闭合就来了新的一组：把上一组补齐
      closeOpen();
      open = { ids: new Set(m.tool_calls.map((c) => c && c.id).filter(Boolean)) };
      out.push(m);
      continue;
    }

    if (m.role === 'tool') {
      const id = m.tool_call_id;
      if (open && id && open.ids.has(id)) {
        open.ids.delete(id);
        out.push(m);
        // 这一组都回完了，就关掉，免得后面的 tool 被错认
        if (!open.ids.size) open = null;
        continue;
      }
      // 孤儿：前面没有认领它的 tool_calls —— 丢掉，不发给模型
      continue;
    }

    // 普通消息（user / assistant 纯文本）：它一出现，上一组就算断了
    closeOpen();
    out.push(m);
  }
  closeOpen();
  return out;
}

export function wireMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return normalizeToolPairing(messages);
}

/**
 * 这个会话实际会用哪个模型的**名字**。
 *
 * 压缩阈值设成「自动」时要按模型窗口算水位，而窗口从 32k 到 1M 差得远，
 * 所以必须在调模型之前就知道用哪个。判断顺序跟 streamChat 完全一致：
 * 会话里临时切过模型 → 用它；否则用全局默认那一套。
 *
 * @param {string} [sessionId]
 * @returns {string} 模型名（认不出来时返回空串）
 */
export function modelNameForSession(sessionId) {
  const ep = endpointForForSession(sessionId) ?? activeEndpoint();
  return String(ep?.model ?? '');
}

/**
 * Stream one chat completion.
 * Yields {type:'text', text} | {type:'reasoning', text} | {type:'tool_calls', toolCalls} | {type:'usage', usage}
 */
export async function* streamChat({ messages, tools, signal, temperature, sessionId, model }) {
  /**
   * 【显式指定的模型压过一切】
   *
   * 顺序：显式传的 model → 会话里切过的 → 全局默认。
   * 小鲸没有会话，她的模型就是靠这个参数带进来的（见 whale-profile.mjs）。
   */
  const _ovEp = endpointForForSession(sessionId) ?? activeEndpoint();
  const ep = epForModelArg(model, _ovEp);
  // 【她到底用了哪套】查「小鲸不说话」时靠这一行看真话，不靠猜
  try {
    if (process.env.WHALE_DEBUG || String(model || '').trim()) console.log('[llm] streamChat model参数=' + JSON.stringify(String(model||'')) + ' → 用 ' + ep.name + ' (' + ep.baseURL + ' / ' + ep.model + ')');
  } catch {}
  const body = {
    model: ep.model,
    // 只发模型该看的那几个字段（内部标记一律剥掉，见上方 wireMessage 的注释）
    messages: wireMessages(messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (tools?.length) body.tools = tools;
  if (temperature !== undefined) body.temperature = temperature;

  /**
   * 思考档位：模型自己的设置优先，否则用全局；auto 按这轮有没有工具现算。
   * 有工具 = 要干活，给 high；纯聊天给 low。
   *
   * 关键：**关档位必须显式发 thinking:{type:disabled}**，不能靠省略字段——
   * 这个网关省略字段就是默认开思考（详见 thinking.mjs 的 fieldsForLevel）。
   */
  const ov = sessionId ? getOverride(sessionId) : {};
  // 会话自己设了强度就用它；没设就跟这个模型在右上角里的设置走
  const cfgLevel = ov.level || levelFor(ep.id ?? 'env');
  const effort = resolveLevel(cfgLevel, { hasTools: Boolean(tools?.length) });

  // 只有「模型不支持思考」才降；key 错 / 网络断 / 值不合法都直接抛。
  let res = null;
  let lastStatus = 0;
  let lastText = '';
  let level = effort;
  /**
   * 上游说「你超窗口了」之后，这里最多压一次再重发。
   *
   * 为什么不在进这函数之前压：压不压是按 CONTEXT_LIMIT 算的，
   * 而主人可能把窗口填得比上游实际给的大，也可能是网关偷偷调小 ——
   * 只有上游亲口说「超了、上限是 N」，才是最可信的数字。
   * 压过一次还报同样的错，就不再死循环，老实抛给主人看。
   */
  let overflowTried = false;
  let gatewayRetried = 0; // 网关 5xx 已经重试过几次（最多 2 次）
  for (let guard = 0; guard < 8; guard++) {
    const payload = withEffort(body, level).body;
    /**
     * 【静默闸：建了连接却一个字节都不吐，不能永远等】
     *
     * 真发生过：网关接了连接、握手也成了，然后就没有然后了 —— 不报错、不断开、
     * 不吐字节。fetch 自己不会超时（Node 的 fetch 没有默认超时），下面的读取
     * 就一直挂着。而 agent 那两道闸（哑转闸、整轮时间闸）只在「每一轮开头」判
     * 一次，卡在这儿走不到检查点 —— 主人看到的就是界面停在半句话上，一直不动。
     *
     * LLM_IDLE_MS 管「响应头回来之前」这段静默（默认 5 分钟）。头回来之后、
     * 正在吐字那段由下面的看门狗 StallWatch 管，两边不重叠。
     */
    const r = await withTimeout(
      fetch(ep.baseURL + '/chat/completions', {
        method: 'POST',
        headers: headers(ep),
        body: JSON.stringify(payload),
        signal,
      }),
      LLM_IDLE_MS,
      { what: '等上游开始回话' },
    );
    if (r.ok) {
      res = r;
      break;
    }
    lastStatus = r.status;
    lastText = await withTimeout(r.text().catch(() => ''), LLM_IDLE_MS, { what: '读上游的错误正文' });
    /**
     * 【网关自己挂了：等多一两秒再敲一次门，别一次抖动就整轮白跑】
     *
     * 502/503/504、Cloudflare 那串 52x，全都是「上游此刻不行」，不是我们发错了。
     * 实测那家网关抖动十几秒是常事，硬撞一次就报错，等于把主人的一句话白扔了。
     * 422 不算 —— 那是我们发的东西不合规，重试多少次都一样。
     */
    if (isGatewayStatus(r.status)) {
      noteUpstreamError(r.status, lastText, ep);
      const tries = (typeof gatewayRetried !== 'undefined' ? gatewayRetried : 0);
      if (tries < 2 && !overflowTried) {
        gatewayRetried = tries + 1;
        const waitMs = 1200 * gatewayRetried;
        console.warn('[llm] 上游 ' + r.status + '，' + Math.round(waitMs / 100) / 10 + ' 秒后重试（第 ' + gatewayRetried + ' 次）');
        await new Promise((ok) => setTimeout(ok, waitMs));
        continue;
      }
    }
    /**
     * 【上下文塞爆：先救一次，别一撞就死】
     * 上游回的窗口大小最可信，按它压一刀再重发；压完还报就认了。
     */
    const over = contextOverflowSize(r.status, lastText);
    if (over !== null && !overflowTried && Array.isArray(messages) && messages.length) {
      overflowTried = true;
      const cap = over > 0 ? Math.floor(over * 0.85) : undefined; // 留 15% 给回话和摘要
      try {
        const cr = await compressHistory({ messages, limit: cap, signal });
        if (cr && cr.compressed) noteRealTokens(cr.after, cr.after, sessionId);
        console.warn('[llm] 上游说超窗口（' + (over > 0 ? over : '没说大小') + '），压了一刀：' + JSON.stringify({ before: cr?.before, after: cr?.after, kept: cr?.kept }));
        if (cr && cr.compressed) {
          body = { ...body, messages }; // 用压过的历史重发
          continue;
        }
      } catch (e) {
        console.warn('[llm] 压了也没成：', String(e?.message ?? e));
      }
    }
    if (!isThinkingUnsupported(r.status, lastText)) {
      const _he = humanErrorOfUpstream(r.status, lastText);
      throw new Error(`LLM HTTP ${r.status}: ${_he.text}`);
    }
    // 模型不支持思考：退到「什么都不发」
    if (!level) throw new Error(`LLM HTTP ${lastStatus}: ${humanErrorOfUpstream(lastStatus, lastText).text}`);
    level = null;
  }

  if (!res) {
    throw new Error(`LLM HTTP ${lastStatus}: ${humanErrorOfUpstream(lastStatus, lastText).text}`);
  }

  const acc = new Map(); // index -> {id, name, arguments}
  const decoder = new TextDecoder();
  let buf = '';

  /**
   * 断流自愈：一次流式请求最多续 2 次。
   *
   * 已经交给调用方的内容（yield 出去的）不会重复——这里只把「还没读到的那部分」
   * 从断点继续读完。续的时候带着已收到的内容再去要一次，模型会把话写完。
   */
  try {
    /**
     * 【流到一半不动了，也得能认输】
     *
     * 上面那道静默闸只管到「响应头回来」。头回来之后还有更难看的僵死：
     * 吐了半句，然后不吐了、不结束、也不报错，连接就那么挂着 —— 真碰上过。
     *
     * 看门狗：一个定时器盯全程，每收到一块就重置。静默超窗就取消这条流，
     * 于是 for-await 抛错、落进下面的 catch —— 恰好就是已有的「流被中途掐断」
     * 那条路，上层带着已收到的内容去续读，不必另写一套恢复逻辑。
     */
    // 注意：这里别再调 res.body.cancel()。guardedStream 已经拿住了 reader，
    // 外部 cancel 会抛 ERR_INVALID_STATE（ReadableStream is locked）把进程带走。
    const guard = stallGuard({
      what: '上游往这边吐字',
      limitMs: LLM_IDLE_MS,
    });
    for await (const chunk of guardedStream(res.body, guard)) {
    guard.beat('收到数据块');
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }

      if (json.usage) yield { type: 'usage', usage: json.usage };
      const delta = json.choices?.[0]?.delta;
      if (!delta) continue;

      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (reasoning) yield { type: 'reasoning', text: reasoning };
      if (delta.content) yield { type: 'text', text: delta.content };

      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = acc.get(idx) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        acc.set(idx, cur);
      }

      const finish = json.choices?.[0]?.finish_reason;
      if (finish === 'tool_calls' && acc.size) {
        yield { type: 'tool_calls', toolCalls: [...acc.values()].filter((t) => t.name) };
        acc.clear();
      }
    }
    }
  } catch (err) {
    // 流被掐断了。把已经攒好的 tool_calls 先交出去，别让这一轮白跑；
    // 然后往上抛一个带标记的错，交给 agent 那边决定「续跑」。
    if (acc.size) {
      try {
        yield { type: 'tool_calls', toolCalls: [...acc.values()].filter((t) => t.name) };
        acc.clear();
      } catch {}
    }
    // 看门狗取消流之后抛出来的错，语义就是「静了太久」，跟真断线一样走续读
    const stalled = err?.name === 'AbortError' || /cancel/i.test(String(err?.message ?? ''));
    if (isStreamDropError(err) || stalled) {
      const e = new Error('流被中途掐断（' + (String(err.cause?.code ?? err.message ?? err)) + '）');
      e.streamDropped = true;
      e.received = buf.length;
      throw e;
    }
    throw err;
  }
}

/**
 * Non-streaming helper used by the context summarizer and smoke checks.
 *
 * 【为什么要有 model 参数】
 * 以前这里写死 activeEndpoint()，于是「压缩摘要」永远用全局默认端点去算 ——
 * 会话里切到别的模型（比如切到窗口 100 万的、或者切到便宜的），摘要还是拿
 * 默认那个模型的 key/地址/名字去请求，等于白切。压完的上下文还可能超对方窗口。
 * 现在跟 streamChat 一致：显式给的 model → 会话里切过的 → 全局默认。
 * 摘要调用（compress.mjs）就是靠这个把当前会话的模型带进来的。
 */
export async function chat({ messages, tools, signal, sessionId = '', model }) {
  const _ovEp = endpointForForSession(sessionId) ?? activeEndpoint();
  const ep = epForModelArg(model, _ovEp);
  const body = { model: ep.model, messages: wireMessages(messages) };
  if (tools?.length) body.tools = tools;

  // chat 也要带档位（摘要、连通测试都走这里）；关档位同样显式发 disabled
  //
  // sessionId 要从参数里来 —— 以前这里直接引用了一个不存在于本作用域的 sessionId，
  // 一进来就抛 ReferenceError。后果特别隐蔽：压缩上下文时的摘要调用永远失败，
  // 只能吞成"摘要生成失败"的降级文案；「测连通」也一起报错。
  // 不传就当没有会话级覆盖，退回全局档位。
  const ov2 = sessionId ? getOverride(sessionId) : {};
  const effort = resolveLevel(ov2.level || levelFor(ep.id ?? 'env'), { hasTools: Boolean(tools?.length) });
  let lastStatus = 0;
  let lastText = '';
  let level = effort;
  for (let guard = 0; guard < 8; guard++) {
    const payload = withEffort(body, level).body;
    const res = await fetch(ep.baseURL + '/chat/completions', {
      method: 'POST',
      headers: headers(ep),
      body: JSON.stringify(payload),
      signal,
    });
    if (res.ok) return res.json();
    lastStatus = res.status;
    lastText = await res.text().catch(() => '');
    if (!isThinkingUnsupported(res.status, lastText)) {
      throw new Error(`LLM HTTP ${lastStatus}: ${humanErrorOfUpstream(lastStatus, lastText).text}`);
    }
    if (!level) break;
    level = null;
  }
  throw new Error(`LLM HTTP ${lastStatus}: ${humanErrorOfUpstream(lastStatus, lastText).text}`);
}
