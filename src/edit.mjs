// 改一句话 · 撤销修改（会话内的手动编辑）
//
// 两种改法：
//   ① 改对话本身（user / assistant 说的话）—— 直接改 messages[idx].content，
//      下一轮发给模型的就是新内容。改之前留一份原件进 session.edits。
//   ② 只改这一句在「记忆本子」里留下的那条摘要 —— 本子是纯文本，一行一条
//      `- R0001 [时间] 摘要：…`，按行替换。
//
// 撤销：session.edits 是后进先出的栈，每条记下 { idx, role, before, after, at }，
// undo 就把 before 写回去。只动这一句，不碰别的。
import { readMemory, writeMemory } from './session-memory.mjs';

/** 滚动摘要那一行的样子 */
const DIGEST_LINE = /^-\s*R(\d{4})\s*\[[^\]]*\]\s*摘要：/;

/** 改动标记：改过的行尾巴上挂这句，撤销时按它认 */
const EDIT_NOTE = '（主人把这句话改成了：';

/** 一条消息可编辑的正文（user 用 _text，那才是主人真打的字） */
function contentOf(m) {
  if (!m || typeof m !== 'object') return '';
  if (m.role === 'user' && typeof m._text === 'string') return m._text;
  return typeof m.content === 'string' ? m.content : '';
}

/** 把新正文写回消息。user 只动 _text 还是不够：content 里可能拼着附件说明块，得留着它 */
function setContentOf(m, text) {
  const next = String(text ?? '');
  if (m.role === 'user') {
    const old = typeof m.content === 'string' ? m.content : '';
    const mark = old.indexOf('【主人随这条消息一起发来的');
    // 附件说明块保留在 content 尾巴上（模型要看得见），气泡只认 _text
    m._text = next;
    m.content = mark >= 0 ? next + '\n\n' + old.slice(mark) : next;
  } else {
    m.content = next;
  }
}

/** 这一句是不是能改的对话（system / 上下文 / 工具消息一律不让改） */
function editableMessage(session, idx) {
  const list = Array.isArray(session?.messages) ? session.messages : [];
  const n = Number(idx);
  if (!Number.isInteger(n) || n < 0 || n >= list.length) return null;
  const m = list[n];
  if (!m) return null;
  if (m.role !== 'user' && m.role !== 'assistant') return null;
  if (m.context) return null;   // 每轮重算的规则副本，改了也没用
  return m;
}

/** 改一句对话。 */
export function editMessage(session, idx, text) {
  const m = editableMessage(session, idx);
  if (!m) return { ok: false, error: '这句不能改（系统消息、或者已经不存在了）' };
  const before = contentOf(m);
  const after = String(text ?? '');
  if (!after.trim()) return { ok: false, error: '不能改成空的' };
  if (before === after) return { ok: true, before, after, editedAt: 0, unchanged: true };

  setContentOf(m, after);
  m._editedAt = Date.now();
  if (!Array.isArray(session.edits)) session.edits = [];
  session.edits.push({
    idx: Number(idx),
    role: m.role,
    before,
    after,
    at: Date.now(),
  });
  return { ok: true, before, after, editedAt: m._editedAt };
}

/** 撤销最近一次改动（后进先出）。只还原这一句，别的一句不动。 */
export function undoEdit(session, idx) {
  const stack = Array.isArray(session?.edits) ? session.edits : [];
  if (!stack.length) return { ok: false, error: '没有可撤销的修改' };
  let pos = stack.length - 1;
  if (Number.isInteger(Number(idx))) {
    // 指定了这一句就找它最近那次
    for (let i = stack.length - 1; i >= 0; i--) {
      if (Number(stack[i].idx) === Number(idx)) { pos = i; break; }
    }
    if (Number(stack[pos].idx) !== Number(idx)) return { ok: false, error: '这一句没有改过的记录' };
  }
  const rec = stack[pos];
  const m = editableMessage(session, rec.idx);
  if (!m) return { ok: false, error: '这一句已经不在了' };
  setContentOf(m, rec.before);
  delete m._editedAt;
  // 还有没有别的改动剩在这句上？没有就把「改过」标记也摘掉
  const stillEdited = stack.some((e, k) => k !== pos && Number(e.idx) === Number(rec.idx));
  stack.splice(pos, 1);
  return {
    ok: true,
    idx: rec.idx,
    text: rec.before,
    at: rec.at,
    stillEdited,
    memNote: rec.memNote || null,
  };
}

/** 这一句有没有改过、能不能撤销（界面要据此显示按钮） */
export function editInfo(session) {
  const stack = Array.isArray(session?.edits) ? session.edits : [];
  const map = {};
  for (const e of stack) map[Number(e.idx)] = e.at;
  return map;
}

// ---- 改对话 = 顺手把记忆本子里对应的那行也换掉 ------------------------------
//
// 主人要的是：「编辑好之后，这个会话的记忆也要跟着变成编辑后的内容」。
// 本子是纯文本，没存下标，所以只能按「原来那句话在不在这一行里」来认领：
//   · 先在滚动摘要里找（那是每轮记下来的、和某句最贴近的东西）
//   · 滚动摘要里找不到，再去固定记忆那几段里找
//   · 全都找不到就算了，别硬改 —— 本子里没有提到这句，改了反而是瞎编。

/** 把一句话压成一行，方便塞进本子 */
function oneLine(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 本子里某一行是不是这一句留下的。
 *
 * 以前要求「开头 6 字 + 结尾 6 字都在」，太脆：AI 记摘要时会在开头加称呼
 * （原话「我今天想吃红烧肉」，本子里写成「主人说他今天想吃红烧肉，晚上一起吃饭」），
 * 开头 6 字「我今天想吃红」立刻对不上，整行判负 —— 结果改完对话记忆根本没变（踩过）。
 *
 * 现在改成：从原句里滑一个窗口，任意一段够长的连续片段出现在那一行里就算命中。
 *   · 短句（≤12 字）整句出现就算，或者 6 字窗口命中
 *   · 长句用 10 字窗口滑一遍，命中任意一段就算
 * 误伤风险：只有很短又很常见的句子（「好的」「继续」）容易撞，所以短于 6 字直接判否；
 * 真撞上了也只是把那一行换成新内容，不算灾难 —— 聊胜于无。
 */
function lineMatches(line, text, next) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length < 6) return false;   // 太短，本子里根本不会留它
  const flat = String(line ?? '').replace(/\s+/g, ' ');
  if (!flat) return false;

  // 先看整句：最干脆的情况
  let hit = flat.includes(s);
  if (!hit) {
    // 再滑窗口。短句 6 字，长句 10 字 —— 窗口越长越不容易撞车
    const win = s.length <= 12 ? 6 : 10;
    for (let i = 0; i + win <= s.length; i++) {
      const seg = s.slice(i, i + win);
      if (flat.includes(seg)) { hit = true; break; }
    }
  }
  if (!hit) return false;

  // 改前改后只差一两个字（「好呀」→「好呀呀」）就别往本子里掺了，纯噪音
  const n = String(next ?? '').replace(/\s+/g, ' ').trim();
  if (n && n.length >= 2 && s.length >= 2) {
    let diff = 0;
    const max = Math.max(s.length, n.length);
    for (let i = 0; i < max; i++) if (s[i] !== n[i]) diff++;
    if (diff < 2) return false;
  }
  return true;
}

/**
 * 改完对话后同步记忆本子。
 * 返回 hits 是「改了哪几行、原来长什么样」，撤销时按它写回去。
 */
export function syncMemoryAfterEdit(sessionId, before, after) {
  const cur = readMemory(sessionId);
  if (cur === null || !cur.trim()) return { changed: 0, where: [] };
  if (String(before ?? '').replace(/\s+/g, ' ').trim().length < 6) return { changed: 0, where: [] };

  const lines = cur.split('\n');
  let changed = 0;
  const where = [];
  const hits = [];
  const note = `（主人把这句话改成了：${oneLine(after)}）`;

  let inArchive = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^#+\s*归档/.test(lines[i])) inArchive = true;
    // 已经被改过一次的行不再重复套娃（否则会变成「改成了…改成了…」）
    if (lines[i].includes(EDIT_NOTE)) continue;
    if (!lineMatches(lines[i], before, after)) continue;
    const old = lines[i];
    if (DIGEST_LINE.test(old)) {
      // 摘要行：保留 `- R0001 [时间] 摘要：` 这一截，后面换成新内容
      const head = old.slice(0, old.indexOf('摘要：') + 3);
      lines[i] = head + oneLine(after, 200) + note;
    } else {
      // 固定记忆里的正文行：原样换成新内容，缩进和列表符号留着
      const lead = old.match(/^[\s\-*]*/)[0];
      lines[i] = lead + oneLine(after, 200) + note;
    }
    // 记下「改之前这一行原样长什么样」。撤销时直接按行号写回去 ——
    // 不能靠拿原话再去匹配：写进本子的是截断版（oneLine），原话开头已经被换掉了，
    // 再匹配必然对不上（这个坑踩过，撤销时 changed 恒为 0）。
    hits.push({ line: i, old });
    changed++;
    where.push(inArchive ? '归档' : (DIGEST_LINE.test(old) ? '滚动摘要' : '固定记忆'));
  }

  if (!changed) return { changed: 0, where: [] };
  writeMemory(sessionId, lines.join('\n'));
  return { changed, where, hits };
}

/** 撤销修改时把记忆也退回去：按 syncMemoryAfterEdit 记下的行号把原行写回去 */
export function unsyncMemoryAfterEdit(sessionId, hits) {
  const list = Array.isArray(hits) ? hits : null;
  if (!list || !list.length) return { changed: 0 };
  const cur = readMemory(sessionId);
  if (cur === null || !cur.trim()) return { changed: 0 };
  const lines = cur.split('\n');
  let changed = 0;
  for (const h of list) {
    const i = Number(h.line);
    if (!Number.isInteger(i) || i < 0 || i >= lines.length) continue;
    // 只在这个位置确实还是「我们改过的那一行」时才回写。
    // 本子可能已经被 AI 自己又改过一遍（追加摘要会挪行），那就别硬盖回去。
    if (lines[i].indexOf(EDIT_NOTE) < 0) continue;
    lines[i] = h.old;
    changed++;
  }
  if (!changed) return { changed: 0 };
  writeMemory(sessionId, lines.join('\n'));
  return { changed };
}

// ---- 改某一句在记忆里留下的那条摘要 ----------------------------------------

/** 改摘要：lineNo 是 R 后面的编号。找不到就报错，别悄悄新建一条。 */
export function editDigest(sessionId, lineNo, summary) {
  const n = Number(lineNo);
  if (!Number.isFinite(n) || n < 1) return { ok: false, error: '摘要编号不对' };
  const one = String(summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  if (!one) return { ok: false, error: '摘要不能是空的' };
  const cur = readMemory(sessionId);
  if (cur === null) return { ok: false, error: '这个会话还没有记忆本子' };
  const lines = cur.split('\n');
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    const mt = lines[i].match(DIGEST_LINE);
    if (mt && Number(mt[1]) === n) { hit = i; break; }
  }
  if (hit < 0) return { ok: false, error: `找不到第 ${n} 条摘要` };
  const before = lines[hit];
  // 时间戳留着，只换「摘要：」后面那段
  const head = before.slice(0, before.indexOf('摘要：') + 3);
  lines[hit] = head + one;
  writeMemory(sessionId, lines.join('\n'));
  return { ok: true, before, after: lines[hit], index: n };
}

/** 读摘要列表（界面拿来做下拉 / 定位） */
export function digestLines(sessionId) {
  const cur = readMemory(sessionId);
  if (!cur) return [];
  return cur
    .split('\n')
    .map((line) => {
      const mt = line.match(DIGEST_LINE);
      if (!mt) return null;
      return { index: Number(mt[1]), line };
    })
    .filter(Boolean);
}
