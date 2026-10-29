/**
 * 回合内的工具结果瘦身。
 *
 * 【要解决的病】
 * 一个回合里，模型每调一次工具，结果就整段拼进 messages；下一圈把 messages
 * 完整发一遍，于是第 N 圈发出去的是「前 N-1 圈结果之和」。
 *
 * 实测的后果（dsh 量的数，不是猜的）：
 * 同一个会话，prompt_tokens 在 1.4 万 和 861 万 之间跳 —— 差 300 倍。
 * 而那几百万人 token 里，85% 是【前面几圈已经看过的旧工具结果】。
 *
 * 更要命的是它对人设的影响：
 * 模型每圈都在读自己刚读过的几十万字，最新那句话被稀释到几乎看不见。
 * 表现出来就是「每轮都像第一次」—— 时间循环的物理原因就在这儿。
 *
 * 【怎么治】
 * 不删、不丢，只把【旧的】工具结果收成「摘要形态」：
 *   - 最近几圈的：原样留着（模型正要用）
 *   - 更早的：压成「前 2 行 + …共 N 行… + 后 2 行」
 *   - 永远保留「调用过什么工具」这条线索，别让模型以为没调过
 *
 * 【为什么不在压缩那儿做】
 * compressHistory 只在回合开头判一次、且只认「整份历史」。
 * 回合内涨起来的那几百万，它根本看不见。这是两条不同的路，得分开治。
 */

/** 最近几圈的 tool 结果原样留着 —— 模型靠它接着干下一步 */
const KEEP_RECENT_ROUNDS = 2;
/** 老结果缩到前几行 + 后几行 */
const HEAD_LINES = 2;
const TAIL_LINES = 2;
/** 单行最长留多少字符 */
const LINE_MAX = 300;
/** 短于这个长度的结果不值得压（压了也省不了多少，还容易丢信息） */
const MIN_COMPRESS_CHARS = 800;
/**
 * 【跨轮兜底】整份历史里最多保留多少条「原样」工具结果，更早的一律压。
 *
 * 为什么要有这个：slimRoundMessages 原来只压「本轮之后」的工具结果，
 * 跨轮的老结果一条不动。实测一个 2057 条的会话里，tool 消息占了 62% 字符
 * （123 万 / 共 199 万），每圈都整份重发，prompt_tokens 因此冲到 1590 万。
 * 压缩（compressHistory）看的是磁盘快照、只在回合开头判一次，根本管不到这儿。
 *
 * 取 24：够模型回看最近十几二十次工具调用，又不至于让历史无限膨胀。
 */
const KEEP_TOTAL_TOOLS = 24;

/**
 * 把一段工具结果压成摘要形态。
 * @param {string} text 原始结果
 * @returns {string}
 */
export function shrinkToolText(text) {
  const s = String(text ?? '');
  if (s.length <= MIN_COMPRESS_CHARS) return s;

  const lines = s.split('\n');
  const clipped = (l) => (l.length > LINE_MAX ? l.slice(0, LINE_MAX) + '…' : l);

  if (lines.length <= HEAD_LINES + TAIL_LINES + 2) {
    // 行数不多但每行很长：按字符砍
    return clipped(s.slice(0, LINE_MAX * (HEAD_LINES + 1))) + `\n…（共 ${s.length} 字符，中间的略）`;
  }

  const head = lines.slice(0, HEAD_LINES).map(clipped);
  const tail = lines.slice(-TAIL_LINES).map(clipped);
  const omitted = lines.length - HEAD_LINES - TAIL_LINES;
  return [...head, `…（中间略过 ${omitted} 行，原文共 ${lines.length} 行 / ${s.length} 字符）…`, ...tail].join('\n');
}

/**
 * 把一段「工具调用的参数」压成摘要形态。
 *
 * arguments 通常是 JSON 字符串。压的时候**不能把线索压没** ——
 * 循环.txt 里踩过这个坑：下一个「我」看见「这一轮用了 write_file」，
 * 完全不知道改的是哪个文件，只能从头再查，查完又记一条「用了 write_file」，
 * 就这么打转。所以路径、命令这些「定位用的字段」要原样留下。
 *
 * 做法：认得出的键（path / file_path / target / cmd / command / pattern 等）
 * 原样保留；其余大字段（content / old_string / new_string / body …）压短。
 * 不是 JSON 的话，就当纯文本按 shrinkToolText 处理。
 *
 * @param {string} args 原始参数
 * @returns {string}
 */
export function shrinkToolArguments(args) {
  const s = String(args ?? '');
  if (s.length <= MIN_COMPRESS_CHARS) return s;

  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    // 不是 JSON（少见）：按普通文本压
    return shrinkToolText(s);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return shrinkToolText(s);

  /** 这些键是「定位线索」，必须原样留着 —— 宁可多花点 token */
  const KEEP_KEYS = new Set([
    'path', 'file_path', 'filepath', 'target', 'target_file', 'filename', 'file',
    'cmd', 'command', 'script', 'pattern', 'glob', 'query', 'url', 'name',
    'old_string_len', 'line', 'start', 'end', 'offset', 'limit', 'action', 'mode',
  ]);
  /** 这些键最占地方，压得最狠 */
  const HEAVY_KEYS = new Set([
    'content', 'old_string', 'new_string', 'body', 'text', 'data', 'patch',
    'replacement', 'insert', 'source', 'code', 'diff',
  ]);

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') {
      out[k] = v;
      continue;
    }
    if (KEEP_KEYS.has(k)) {
      // 定位线索：长路径也留全，它是模型接下去干活的关键
      out[k] = v.length > 500 ? v.slice(0, 500) + '…' : v;
      continue;
    }
    if (HEAVY_KEYS.has(k) || v.length > LINE_MAX) {
      const lines = v.split('\n');
      const note = v.includes('\n')
        ? `…（原文 ${v.length} 字符 / ${lines.length} 行，已压短）…`
        : `…（原文 ${v.length} 字符，已压短）…`;
      // 留个头，模型能认出这是哪段东西
      out[k] = v.slice(0, LINE_MAX) + note;
      continue;
    }
    out[k] = v;
  }
  const compact = JSON.stringify(out);
  // 压完反而更长（键名多、原文本来就短）：那就别压
  return compact.length < s.length ? compact : s;
}

/**
 * 给一份 messages 做「回合内瘦身」。
 *
 * 规矩（三不碰）：
 *   一、不碰主人说的话（role=user）
 *   二、不碰 assistant 的正文（那是它自己的话，也是主人要看的东西）
 *   三、不碰最近 KEEP_RECENT_ROUNDS 圈的 tool 结果（它正要用）
 *
 * 只动更早的那些 tool 结果。
 *
 * 【注意】返回的是新数组、新对象，不改原 messages ——
 * 原 messages 是落盘用的，必须保持完整。这一点别改，
 * 不然主人回来看历史，会发现工具结果被压过，跟当时看到的不一样。
 *
 * @param {Array} messages
 * @returns {{messages:Array, changed:number, savedChars:number}}
 */
export function slimRoundMessages(messages, opts = {}) {
  if (!Array.isArray(messages) || !messages.length) {
    return { messages, changed: 0, savedChars: 0 };
  }

  /**
   * 只瘦「本轮之后」的那部分。
   *
   * 上个回合读过的东西这个回合可能还要用 —— 压了就是失忆。
   * from 由调用方给（本轮那条 user 消息的下标）；没给就整份都算。
   */
  const from = Number.isInteger(opts.from) && opts.from >= 0 ? opts.from : 0;

  // 全表所有 tool 消息的下标（跨轮兜底要看整份，不能只看 from 之后）
  const allToolIdxs = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i] && messages[i].role === 'tool') allToolIdxs.push(i);
  }

  // 本轮之后的 tool 下标
  const toolIdxs = allToolIdxs.filter((i) => i >= from);

  // 跨轮兜底：整份历史只保留最近 KEEP_TOTAL_TOOLS 条原样
  const keepGlobalFrom = Math.max(0, allToolIdxs.length - KEEP_TOTAL_TOOLS);
  const globalSlim = new Set(allToolIdxs.slice(0, keepGlobalFrom));

  // 本轮之内：最近 KEEP_RECENT_ROUNDS 条也原样留着
  const localSlim = new Set(toolIdxs.slice(0, Math.max(0, toolIdxs.length - KEEP_RECENT_ROUNDS)));

  const slimSet = new Set([...globalSlim, ...localSlim]);
  if (!slimSet.size) {
    return { messages, changed: 0, savedChars: 0 };
  }

  let changed = 0;
  let savedChars = 0;
  const out = messages.map((m, i) => {
    if (!slimSet.has(i)) return m;
    if (!m || m.role !== 'tool') return m;
    const raw = m.content;
    // 带图的结果（content 是数组）不动 —— 那是多模态，压了就废了
    if (Array.isArray(raw)) return m;
    const before = String(raw ?? '');
    const after = shrinkToolText(before);
    if (after === before) return m;
    changed++;
    savedChars += before.length - after.length;
    return { ...m, content: after };
  });

  /**
   * 【第二块：工具调用的参数】
   *
   * 上面那块只压 role==='tool' 的「工具结果」。可 2026-11-01 量下来，
   * 「修理鱼」那个会话瘦身后还剩 91.8 万 token，其中 **48.9 万（53%）
   * 是 assistant 消息里 tool_calls 的 arguments** —— 比工具结果本身还大。
   *
   * 想也合理：模型每调一次 write_file，整份文件正文都在 arguments 里；
   * 每调一次 edit，old_string + new_string 也在。一次几千字，
   * 一个会话上千次调用，就是几十万字，每一圈都原样重发一遍。
   *
   * 而且这一块**压缩也管不着** —— compressHistory 只折叠旧对话，
   * 不碰 assistant 的 tool_calls。两条路都没人管它，于是它一直躺在账上。
   *
   * 规矩跟工具结果一样，别抢模型还在用的东西：
   *   · 只压更早的调用，最近 KEEP_RECENT_ROUNDS 圈的参数原样留着；
   *   · 压的时候保留「调了什么工具、打在哪个文件上」——
   *     这一条最要紧：下一个「我」看见 write_file 却不知道改的是哪个文件，
   *     就只能从头再查一遍，那才是真正的打转（循环.txt 里写过这事）。
   *     arguments 是 JSON，能认出 path/file_path/target 就写进去。
   */
  const allCallIdxs = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m && Array.isArray(m.tool_calls) && m.tool_calls.length) allCallIdxs.push(i);
  }
  /**
   * 跨轮兜底（跟 KEEP_TOTAL_TOOLS 一个道理，2026-11-01 补）。
   *
   * 一开始这里只写「本轮之后」（i >= from），结果实测一点没省：
   * 「修理鱼」的 from=2055（最后一条 user），1025 次调用全在那之前，
   * 一个都没进压的名单 —— 那 18 万 token 的 args 照旧每圈全量重发。
   *
   * 工具结果那边早有 KEEP_TOTAL_TOOLS 这个跨轮兜底，调用参数这边漏了。
   */
  const keepGlobalCalls = Math.max(0, allCallIdxs.length - KEEP_TOTAL_TOOLS);
  const callSlim = new Set(allCallIdxs.slice(0, keepGlobalCalls));
  // 本轮之内：最近 KEEP_RECENT_ROUNDS 圈也原样留着
  const localCalls = allCallIdxs.filter((i) => i >= from);
  for (const i of localCalls.slice(Math.max(0, localCalls.length - KEEP_RECENT_ROUNDS))) callSlim.delete(i);

  if (callSlim.size) {
    const out2 = out.map((m, i) => {
      if (!callSlim.has(i)) return m;
      if (!m || !Array.isArray(m.tool_calls)) return m;
      let touched = false;
      const calls = m.tool_calls.map((tc) => {
        const f = tc && tc.function;
        if (!f || typeof f.arguments !== 'string') return tc;
        const before = f.arguments;
        const after = shrinkToolArguments(before);
        if (after === before) return tc;
        touched = true;
        savedChars += before.length - after.length;
        return { ...tc, function: { ...f, arguments: after } };
      });
      if (!touched) return m;
      changed++;
      return { ...m, tool_calls: calls };
    });
    out.length = 0;
    out.push(...out2);
  }

  return { messages: changed ? out : messages, changed, savedChars };
}

/**
 * 量一下这份 messages 有多大（字符数 + 粗估 token）。
 *
 * 只写日志、不改逻辑 —— 用来证明「瘦身到底有没有用」。
 * 估算沿用项目里的老办法（1 字符≈1 token，宁高勿低）。
 *
 * 【2026-11-01 补齐两处漏算】
 * 以前只数 content 的字符串部分，结果有两样东西完全不在账上：
 *
 *   一、tool_calls 的 arguments。模型调 write_file 时整个文件正文都塞在
 *       arguments 里，实测全部会话合计 268 万字符、单会话最多 50 万字符
 *       （≈33 万 token），一分钱没算进去。compress.mjs 的 estimateTokens
 *       是数了的，两边口径对不上，日志就会骗人。
 *
 *   二、图片。以前给个死数 4000 字符，可真的发出去时 inflateImages 会把
 *       文件读成 base64 塞进 content —— 一张 1.2MB 的截图 base64 后是
 *       1.6MB，比 4000 大三个数量级。按死数算，「带着十张图」和「不带图」
 *       在账上一模一样，于是永远判「还没到线」，压都不压。
 *
 * 图片这里没法真去读文件（measureMessages 是纯函数、且可能在没有磁盘的
 * 地方调），所以按 dataUrl 里已有的 base64 长度算；只有路径没有 dataUrl
 * 的那种（落盘的原始形态）按 IMAGE_ESTIMATE_CHARS 估个保守值。
 */
const IMAGE_ESTIMATE_CHARS = 4000;

export function measureMessages(messages) {
  if (!Array.isArray(messages)) return { chars: 0, tokens: 0, tools: 0, calls: 0, images: 0 };
  let chars = 0;
  let tools = 0;
  let calls = 0;
  let images = 0;
  for (const m of messages) {
    if (!m) continue;
    if (m.role === 'tool') tools++;
    const c = m.content;
    if (typeof c === 'string') chars += c.length;
    else if (Array.isArray(c)) {
      for (const p of c) {
        if (!p) continue;
        if (typeof p.text === 'string') chars += p.text.length;
        else if (p.type === 'image_url') {
          images++;
          // 已经读成 dataUrl 的：按真实 base64 长度算（这才是发出去的量）
          const url = p.image_url?.url;
          if (typeof url === 'string' && url.startsWith('data:')) chars += url.length;
          else chars += IMAGE_ESTIMATE_CHARS;
        }
      }
    }
    // 落盘形态的图（只有路径、还没 inflate）：按保守估值记一笔
    if (Array.isArray(m._images) && m._images.length) {
      images += m._images.length;
      chars += m._images.length * IMAGE_ESTIMATE_CHARS;
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const f = tc && tc.function;
        if (!f) continue;
        calls++;
        if (typeof f.name === 'string') chars += f.name.length;
        if (typeof f.arguments === 'string') chars += f.arguments.length;
      }
    }
  }
  return { chars, tokens: chars, tools, calls, images };
}
