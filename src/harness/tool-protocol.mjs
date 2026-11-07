/**
 * 【统一工具调用协议 · 增量 / 幂等 / 累积】
 *
 * 重做前的两个真问题（agent.mjs:180-191 的注释记过事故）：
 *
 *  ① `toolCalls = takeFreshToolCalls(ev.toolCalls, ...)` 是**覆盖赋值**。
 *     同一 round 里只要出现第二次 tool_calls 事件（断流续传、[DONE] 与
 *     finish_reason 双触发），去重函数返回空数组 → 把第一批**冲掉**
 *     → 判定「模型说完了」→ 一个工具都不执行，日志里还没有错。
 *
 *  ② 原生 tool_calls 是流式增量、末尾整批交付；XML 伪协议是收完整条流
 *     才解析一次，而且要求「一条正规 tool_calls 都没有」。
 *     两条协议的时机、id 生成、增量能力完全不一致。
 *
 * 这里把它们收敛成同一条：每条调用完成即 emit；agent 侧用 Map **累积**，
 * 重复交付变成「补全」，永远不变成「丢批」。
 */

/** 把各种来源的 tool_call 归一成统一形状 */
export function normalizeCall(tc) {
  const src = tc || {};
  const fn = src.function || src || {};
  const name = String(fn.name || src.name || '');
  let args = fn.arguments;
  if (args && typeof args === 'object') {
    try { args = JSON.stringify(args); } catch { args = '{}'; }
  }
  return {
    id: String(src.id || fn.id || ''),
    name,
    arguments: String(args == null ? '' : args),
    index: Number.isFinite(Number(src.index)) ? Number(src.index) : undefined,
  };
}

/**
 * 累积器。关键语义：**同 id 的第二次交付是补充，不是丢弃。**
 *
 * 片段合并规则（流式 tool_calls 会把 name / arguments 切在多个 delta 里）：
 *   · name：以旧值为前缀 → 用新值（更全）；否则拼接
 *   · arguments：同上
 * 这样既能接增量片段，也能接「整批重发」的完整副本，两者都不会重复。
 */
export function createCallAccumulator() {
  const map = new Map();
  let serial = 0;

  const keyOf = (c) => c.id || ('__anon_' + (c.index ?? serial));

  const joinPiece = (oldV, newV) => {
    if (!oldV) return newV;
    if (!newV) return oldV;
    if (newV === oldV) return oldV;
    if (newV.startsWith(oldV)) return newV;      // 增量片段续上
    if (oldV.startsWith(newV)) return oldV;      // 整批重发但更短，保留更全的
    return oldV + newV;                          // 两半截，拼起来
  };

  return {
    /** @returns 本次真正新增了几条（合并已有片段不算新增） */
    merge(list) {
      let added = 0;
      for (const raw of Array.isArray(list) ? list : []) {
        const c = normalizeCall(raw);
        if (!c.name && !c.arguments) continue;
        const k = keyOf(c);
        const old = map.get(k);
        if (old) {
          map.set(k, {
            ...old,
            id: c.id || old.id,
            name: joinPiece(old.name, c.name),
            arguments: joinPiece(old.arguments, c.arguments),
            index: old.index ?? c.index,
          });
        } else {
          map.set(k, c);
          added++;
          serial++;
        }
      }
      return added;
    },
    values() { return [...map.values()]; },
    get size() { return map.size; },
    has(id) { return map.has(String(id)); },
    reset() { map.clear(); serial = 0; },
  };
}

/** 幂等键：断流续传时同一个 session+round+call.id 只允许真正跑一次工具 */
export function makeIdempotencyKey(sessionId, round, id) {
  return String(sessionId || 'default') + '|' + String(round ?? 0) + '|' + String(id || '');
}

/* ── XML 伪协议：边流边扫，不再等整条流收完 ───────────────────────── */

const INVOKE_OPEN = /<invoke\s+name=["']([^"']+)["']\s*>/i;
const PARAM_RE = /<parameter\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/parameter>/gi;

function parseInvokeBlock(block) {
  const m = INVOKE_OPEN.exec(block);
  if (!m) return null;
  const args = {};
  PARAM_RE.lastIndex = 0;
  let p;
  while ((p = PARAM_RE.exec(block))) {
    try { args[p[1]] = JSON.parse(p[2].trim()); }
    catch { args[p[1]] = p[2].trim(); }
  }
  return {
    id: 'xmlcall_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    name: m[1],
    arguments: JSON.stringify(args),
  };
}

/** 一次性解析（兼容老调用方：llm.mjs 里的 parseXmlToolCalls 行为） */
export function parseXmlToolCalls(text) {
  const out = [];
  const re = /<invoke\s+name=["'][^"']+["']\s*>[\s\S]*?<\/invoke>/gi;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const c = parseInvokeBlock(m[0]);
    if (c) out.push(c);
  }
  return out;
}

/**
 * 增量扫描器：feed 一段文本，把**已经闭合**的 <invoke> 立刻吐出来；
 * 没闭合的留在缓冲区等下一块。这样 XML 与原生 tool_calls 一样可以边流边执行。
 */
export function createXmlScanner() {
  let buf = '';
  return {
    feed(chunk) {
      buf += String(chunk || '');
      const out = [];
      let guard = 0;
      while (guard++ < 200) {
        const start = buf.search(INVOKE_OPEN);
        if (start < 0) { buf = ''; break; }              // 没有起始标签，别攒着
        const end = buf.toLowerCase().indexOf('</invoke>', start);
        if (end < 0) { buf = buf.slice(start); break; }   // 没闭合，留着等下一块
        const block = buf.slice(start, end + '</invoke>'.length);
        const c = parseInvokeBlock(block);
        if (c) out.push(c);
        buf = buf.slice(end + '</invoke>'.length);
      }
      return out;
    },
    /** 流结束时把「没闭合但内容齐全」的也尽量救回来 */
    flush() {
      const c = buf ? parseInvokeBlock(buf) : null;
      buf = '';
      return c ? [c] : [];
    },
  };
}
