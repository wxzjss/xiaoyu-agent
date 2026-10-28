/**
 * 折起来的那些段原文 —— 落盘、可查、能翻回来。
 *
 * 【为什么要这个模块】
 *
 * 压缩从来都是「当场扔掉旧消息，换一条四行摘要」。扔的那一刻，
 * 主人几百条对话就只剩下「已经做完：- 修了 xxx」这么一行。
 * 她要回头翻「上周三我到底让你改的是哪一行代码」，翻不到 ——
 * 摘要里根本没有那行代码。
 *
 * 主人原话（2026-10-28）：「让该会话的 ai 自己决定哪些上下文该删，
 * 哪些不能删，怎么总结摘要，让她自己决定怎么压，让她自己压」。
 *
 * 光让她「决定」不够。注意力有限是必然的，决定本身救不回丢掉的原文。
 * 真正的解法是：**压掉的段不销毁，存盘，给她一个能翻回来的工具**。
 * 这样「自己管上下文」才不是一句空话 —— 她可以放心折，因为折了还能翻。
 *
 * 【存哪儿、什么格式】
 *
 *   <dataDir>/.state/folded/<sid>/seg-<起始序号>-<结束序号>-<时间戳>.txt   原文
 *   <dataDir>/.state/folded/<sid>/index.json                            索引
 *
 * 原文按「一条消息一段」写，每段前有 `--- #序号 [role] 时间 ---` 的分隔行，
 * 这样她翻回来的时候还看得出「这句是谁说的、第几条」。
 *
 * 索引里存的是**清单**：每段覆盖哪几条、多少 token、什么时候折的、摘要是什么。
 * 她要先看清单（folded_list），再决定翻哪一段（folded_read）。
 *
 * 【为什么不复用 oversize 目录】
 *
 * oversize/ 装的是「一条消息太长，截断时留下的原文」，跟折叠是两件事：
 * 一个是单条超限，一个是整段历史被折。混在一起，清单就没法只列折叠记录。
 */
import { mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

/** 一份会话的折叠目录。会话 id 里可能带奇怪字符（导入的会话、手改过的），一律洗掉。 */
function segDir(sessionId) {
  const sid = String(sessionId || 'unknown').replace(/[^\w-]/g, '_');
  return join(config.dataDir, '.state', 'folded', sid);
}

function indexFile(sessionId) {
  return join(segDir(sessionId), 'index.json');
}

/**
 * 读索引。坏了就当空的 —— 索引坏不该让整轮压缩失败，
 * 大不了这一段翻不回来（原文文件还在，只是没登记）。
 */
export function readIndex(sessionId) {
  try {
    const raw = readFileSync(indexFile(sessionId), 'utf8');
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

function writeIndex(sessionId, arr) {
  const dir = segDir(sessionId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(indexFile(sessionId), JSON.stringify(arr, null, 2), 'utf8');
}

/**
 * 把一条消息渲染成原文里的一段。
 *
 * 为什么不直接 JSON.stringify：她翻回来看的是一段给人读的文本，
 * JSON 里那些 `{"role":"assistant","content":"..."}` 会把内容埋掉。
 * 但工具调用不能丢 —— 「我到底跑过什么命令」往往是回头最想查的。
 */
function renderMessage(m, idx) {
  const role = String(m?.role || '?');
  const at = m?.at || m?.ts || m?.createdAt;
  const when = at ? ' ' + new Date(Number(at)).toLocaleString('zh-CN') : '';
  const head = '--- #' + idx + ' [' + role + ']' + when + ' ---\n';
  const parts = [];
  const text = typeof m?.content === 'string' ? m.content : '';
  if (text) parts.push(text);
  // 内容可能是分段数组（多模态），把文字部分挑出来
  if (Array.isArray(m?.content)) {
    for (const p of m.content) {
      if (p && typeof p.text === 'string') parts.push(p.text);
      else if (p && p.type) parts.push('（附件：' + p.type + '）');
    }
  }
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
    parts.push('[工具调用] ' + m.tool_calls.map((c) => {
      const n = c?.function?.name || c?.name || '?';
      const a = c?.function?.arguments ?? c?.arguments ?? '';
      return n + '(' + (typeof a === 'string' ? a : JSON.stringify(a)) + ')';
    }).join('\n'));
  }
  if (!parts.length) parts.push('（空）');
  return head + parts.join('\n') + '\n';
}

/**
 * 把被折掉的那一段存下来，登记进索引。
 *
 * 返回登记项（含 id 和原文路径）；存不了就返回 null —— 调用方不该因此中断压缩。
 *
 * @param {object} opt
 * @param {string} opt.sessionId   会话 id
 * @param {number} opt.fromIndex   这一段在原 history 里的起始下标（含）
 * @param {number} opt.toIndex     结束下标（不含）
 * @param {Array}  opt.messages    那一段消息本身
 * @param {number} opt.tokens      这段原来多少 token
 * @param {string} opt.summary     这段换来的摘要正文
 * @param {string} opt.reason      为什么折（水位/硬线/手动…）
 */
export function saveSegment({ sessionId, fromIndex, toIndex, messages, tokens, summary, reason }) {
  try {
    const dir = segDir(sessionId);
    mkdirSync(dir, { recursive: true });
    const stamp = Date.now();
    const id = 'seg-' + fromIndex + '-' + toIndex + '-' + stamp;
    const file = join(dir, id + '.txt');
    const body = (messages || []).map((m, i) => renderMessage(m, fromIndex + i)).join('\n');
    writeFileSync(file, body, 'utf8');
    const entry = {
      id,
      from: fromIndex,
      to: toIndex,
      count: (messages || []).length,
      tokens: Number(tokens) || 0,
      at: stamp,
      reason: String(reason || ''),
      file,
      // 摘要存一份，翻清单时不用开原文就知道这段大概是啥
      summary: String(summary || '').slice(0, 2000),
    };
    const idx = readIndex(sessionId);
    idx.push(entry);
    // 只留最近 200 条登记，老的不删原文（原文按会话留着），只是不再列出来
    const trimmed = idx.length > 200 ? idx.slice(-200) : idx;
    writeIndex(sessionId, trimmed);
    return entry;
  } catch (err) {
    console.warn('[folded] 存折叠原文失败：', String(err?.message ?? err));
    return null;
  }
}

/** 列一段的目录：返回登记表（去掉 file 全路径，只留文件名，免得刷屏）。 */
export function listSegments(sessionId) {
  return readIndex(sessionId).map((e) => ({
    id: e.id,
    from: e.from,
    to: e.to,
    count: e.count,
    tokens: e.tokens,
    at: new Date(e.at).toLocaleString('zh-CN'),
    reason: e.reason,
    summary: firstLine(e.summary),
  }));
}

function firstLine(s) {
  const t = String(s || '').split('\n').map((x) => x.trim()).filter(Boolean);
  return t.length ? t[0].slice(0, 80) : '';
}

/**
 * 按 id 读回原文。
 *
 * 只认索引里登记过的 id —— 不能让模型拿 `../` 之类的路径乱翻硬盘。
 * 同时也接受 `seg-12-30` 这种前缀（时间戳省掉），方便她凭清单里的 from/to 直接读。
 */
export function readSegment(sessionId, id) {
  const want = String(id || '').trim();
  if (!want) return { ok: false, error: '要给一个 id，先用 folded_list 看有哪些段' };
  const idx = readIndex(sessionId);
  let hit = idx.find((e) => e.id === want);
  if (!hit) {
    // 允许只给前缀（seg-12-30），时间戳省掉
    const cands = idx.filter((e) => e.id.startsWith(want + '-') || e.id === want);
    if (cands.length === 1) hit = cands[0];
    else if (cands.length > 1) {
      return { ok: false, error: '「' + want + '」能对上 ' + cands.length + ' 段，把 id 写全：' + cands.map((e) => e.id).join('、') };
    }
  }
  if (!hit) {
    const all = idx.map((e) => e.id).slice(-20);
    return { ok: false, error: '没有这一段。现有的（最多列 20 条）：' + (all.length ? all.join('、') : '（这一段没有任何折叠记录）') };
  }
  try {
    if (!existsSync(hit.file)) return { ok: false, error: '登记里有这一段，但原文文件不见了：' + hit.file };
    const size = statSync(hit.file).size;
    const text = readFileSync(hit.file, 'utf8');
    return { ok: true, id: hit.id, from: hit.from, to: hit.to, size, text };
  } catch (err) {
    return { ok: false, error: '读原文失败：' + String(err?.message ?? err) };
  }
}

/**
 * 把折叠原文整份导成一条普通文本，供「把这个会话的全部折叠原文给我」用。
 * 按时间顺序拼，每段前加一段小标题。
 */
export function dumpAll(sessionId) {
  const idx = readIndex(sessionId);
  if (!idx.length) return { ok: true, text: '（这个会话还没有折叠过任何段）', count: 0 };
  const chunks = [];
  for (const e of idx) {
    try {
      if (!existsSync(e.file)) continue;
      chunks.push('===== ' + e.id + '（第 ' + e.from + '–' + (e.to - 1) + ' 条，约 ' + e.tokens + ' token，' + new Date(e.at).toLocaleString('zh-CN') + '）=====');
      chunks.push(readFileSync(e.file, 'utf8'));
    } catch {}
  }
  return { ok: true, count: idx.length, text: chunks.join('\n') };
}

/** 这个会话一共折了多少段、多少 token —— 界面上「已折叠」那个数用它。 */
export function stats(sessionId) {
  const idx = readIndex(sessionId);
  return {
    segments: idx.length,
    tokens: idx.reduce((sum, e) => sum + (Number(e.tokens) || 0), 0),
    messages: idx.reduce((sum, e) => sum + (Number(e.count) || 0), 0),
  };
}

/** 清掉一个会话的折叠记录（删会话时一起删，免得越攒越多）。 */
export function clearSession(sessionId) {
  try {
    const dir = segDir(sessionId);
    if (!existsSync(dir)) return true;
    for (const f of readdirSync(dir)) {
      try { writeFileSync(join(dir, f), ''); } catch {}
    }
    return true;
  } catch {
    return false;
  }
}
