// 对话回退（从 DSH 的 dsh-rewind-plugin 移植，只保留「对话」这一半）。
//
// 铁律：**只遮蔽，不删除**。
// 回退从不动老消息、不删日志，只在会话里多记一个「回退点」：
//
//   { at, hidden: [消息下标...], ws: { <下标>: { 路径: 改动前的内容 | null } } }
//
// - at     目标消息（那条用户消息）的下标；
// - hidden 已经作废、但还留在日志里的消息下标。回退到更早的位置时，后面那些
//          回退点藏起来的消息也要一起算进来（连续回退才对）；
// - ws     每条消息那一轮里被写过的文件：{ 相对路径: 原内容 | null }。
//          null 表示「原来不存在」→ 回退时删掉它。只记写过的、确实变过的。
// - mem    那一轮开始时这个会话的记忆本子（正文 | null）。回退时连记忆一起退回去，
//          不然对话退回去了、记忆还记着后来那些事，两边就对不上了。
//
// 真正发给模型的历史由 effectiveHistory() 实时算出来：
// 保留 system + 上下文两条，然后只留「最早那个回退点之前」的消息。
// 日志文件本身一条都不改，所以随时可以反悔——把回退点删掉，对话原样回来。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { config } from './config.mjs';
import { readMemory, snapMemory } from './session-memory.mjs';

const DIR = join(config.dataDir, '.state', 'rewind');
const MAX_SNAPSHOT_BYTES = 1024 * 1024; // 单文件超过 1MB 就不备份（对齐 DSH：过大不备份）

/** 头部两条：system + 带人设的上下文消息。它们永远不算对话。 */
function headIndexes(messages) {
  if (!Array.isArray(messages) || messages[0]?.role !== 'system') return [];
  return messages[1]?.role === 'user' && messages[1]?.context ? [0, 1] : [0];
}

/** 会话里已有的回退点（按时间先后）。坏数据一律当没有。 */
export function loadRewinds(session) {
  // at:-1 是「本轮写文件登记表」，不是回退点，永远不算数。
  const list = Array.isArray(session?.rewinds) ? session.rewinds : [];
  return list
    .filter((r) => r && Number.isFinite(Number(r.at)))
    .map((r) => {
      const out = {
        at: Number(r.at),
        hidden: (Array.isArray(r.hidden) ? r.hidden : []).map(Number).filter(Number.isFinite),
        ws: r.ws && typeof r.ws === 'object' ? r.ws : {},
      };
      // mem 必须原样带出去：漏掉它，撤销回退时就拿不到记忆快照了。
      // 值是 null 也算有（意思「那一轮还没有本子」），所以用 'in' 判断。
      if (Object.prototype.hasOwnProperty.call(r, 'mem')) out.mem = r.mem;
      return out;
    });
}

/**
 * 现在还有效的消息下标（只算对话，不含 system / 上下文）。
 * 语义：取最近一次回退点的 at，它之前的都有效；再扣掉所有回退点藏起来的。
 */
export function effectiveIndexes(messages, rewinds) {
  const list = Array.isArray(messages) ? messages : [];
  const head = headIndexes(list);
  const hidden = new Set();
  for (const r of rewinds) for (const i of r.hidden) hidden.add(i);
  const cuts = rewinds.map((r) => r.at).filter(Number.isFinite);
  const cut = cuts.length ? Math.min(...cuts) : Number.POSITIVE_INFINITY;

  const keep = [];
  for (let i = head.length; i < list.length; i++) {
    if (hidden.has(i)) continue;
    if (i >= cut) continue;
    keep.push(i);
  }
  return { head, keep, hidden };
}

/**
 * 真正发给模型的 history（新数组，不动原来的 session.messages）。
 * @param {object[]} messages
 * @param {object[]} rewinds
 */
export function effectiveHistory(messages, rewinds) {
  const list = Array.isArray(messages) ? messages : [];
  const { head, keep } = effectiveIndexes(list, rewinds);
  return [...head.map((i) => list[i]), ...keep.map((i) => list[i])];
}

/**
 * 新建一个回退点。
 * @param {object} session 会话对象（就地推一个回退点）
 * @param {number} at 目标用户消息在 messages 里的下标
 */
export function createRewind(session, at) {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  const idx = Number(at);
  if (!Number.isFinite(idx) || idx < 0 || idx >= messages.length) {
    return { ok: false, error: '这条消息已经不在了' };
  }
  const target = messages[idx];
  if (!target || target.role !== 'user' || target.context) {
    return { ok: false, error: '只能回退到你自己说过的话' };
  }

  const existing = loadRewinds(session);
  const alive = effectiveIndexes(messages, existing).keep.includes(idx);
  if (!alive) return { ok: false, error: '这条已经被回退过了' };

  // 藏起来 = 这条之后的全部对话 + 后面那些回退点本来藏着的
  const hidden = new Set();
  const head = headIndexes(messages).length;
  for (let i = idx + 1; i < messages.length; i++) hidden.add(i);
  for (const r of existing) for (const i of r.hidden) if (i >= idx) hidden.add(i);

  // 后面那些回退点记下的文件快照要并进来，否则文件会漏还原
  const ws = {};
  for (const r of existing) {
    if (r.at < idx) continue;
    for (const [k, v] of Object.entries(r.ws || {})) ws[k] = v;
  }
  // 目标那条自己那一轮的快照（这一轮的文件改动也要退回去）
  Object.assign(ws, target._ws || {});
  delete target._ws;

  // 记忆也一起退回这一轮开始时的样子（当时没有本子就记 null，回退时删掉）
  // 记忆也一起退回这一轮开始时的样子。用 'in' 判断而不是看值：
  // 那一轮开始时会话还没有本子时快照就是 null，null 也是有效快照（回退时要删掉本子）。
  const hasMem = Object.prototype.hasOwnProperty.call(target, '_mem');
  const mem = hasMem ? target._mem : undefined;
  delete target._mem;

  const rewind = { at: idx, hidden: [...hidden].sort((a, b) => a - b), ws };
  if (hasMem) rewind.mem = mem;
  session.rewinds = [...existing.filter((r) => r.at < idx), rewind];
  void head;
  return { ok: true, rewind };
}

/**
 * 撤销最近一次回退（摘掉最后一个回退点，对话原样回来）。
 *
 * 注意：撤销回退 = 让「回退」这件事没发生过，所以记忆也得回到「还没退」的样子。
 * 那个快照就存在被摘掉的那个回退点里，必须**在删之前**取出来 —— 一开始写的是
 * 先调这个函数再从 session.rewinds 里找，结果回退点已经没了，记忆永远还原不回来。
 */
export function undoLastRewind(session) {
  const list = loadRewinds(session);
  if (!list.length) return { ok: false, error: '没有可撤销的回退' };
  const last = list[list.length - 1];
  session.rewinds = list.slice(0, -1);
  return {
    ok: true,
    at: last.at,
    hasMem: Object.prototype.hasOwnProperty.call(last, 'mem'),
    mem: last.mem,
    ws: last.ws || {},
  };
}

function resolveInsideWorkspace(p) {
  const root = resolve(config.workspace);
  const abs = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) return null;
  return { abs, key: rel.replace(/\\/g, '/') };
}

/**
 * 拍一张「改之前」的快照。只被写类工具（write_file）调用。
 * @param {object} snap 那条消息的快照对象，就地补
 * @param {string} p 模型给的路径
 */
/**
 * 会话级的写文件登记表。
 *
 * 这里是踩过的坑：最早把快照挂在「这一轮的 user 消息」上（userMsg._ws），
 * 结果下一轮又换了新的 user 消息，旧快照没人管、回退时也翻不到。
 * 现在改成挂在会话上，key 是「这条消息刚发出去时文件长什么样」，
 * 由 server 在每轮开始/结束时 openTurn() / closeTurn() 收口。
 */
const TURN_MARK = -1; // 在 rewinds 里占位：at:-1 表示「进行中这一轮的改动」

export function openTurn(session) {
  const box = { files: {} };
  const rewinds = Array.isArray(session.rewinds) ? session.rewinds : (session.rewinds = []);
  // 这一轮开始时记忆本子长什么样。回退到这一轮时用它还原，别让对话退回去、记忆还往前跑。
  const mem = session?.id ? readMemory(session.id) : null;
  const entry = { at: TURN_MARK, hidden: [], ws: box.files, mem };
  const i = rewinds.findIndex((r) => Number(r.at) === TURN_MARK);
  if (i >= 0) rewinds[i] = entry;
  else rewinds.push(entry);
  return box;
}

/** 这一轮结束：把登记表里的改动挂到目标消息上，并撤掉 at:-1 占位。 */
export function closeTurn(session, targetIndex) {
  const rewinds = Array.isArray(session.rewinds) ? session.rewinds : [];
  const i = rewinds.findIndex((r) => Number(r.at) === TURN_MARK);
  if (i < 0) return {};
  const files = rewinds[i].ws || {};
  // 注意：mem 可能是 null（那一轮开始时会话还没有本子），null 也是有效快照，
  // 代表「回退到这儿就得把本子删掉」。所以判空必须用 'mem' in 而不是 !== undefined。
  const hasMem = Object.prototype.hasOwnProperty.call(rewinds[i], 'mem');
  const mem = rewinds[i].mem;
  rewinds.splice(i, 1);
  const n = Number(targetIndex);
  if (Number.isFinite(n)) {
    const hasFiles = Object.keys(files).length > 0;
    if (hasFiles || hasMem) {
      const hit = rewinds.find((r) => Number(r.at) === n);
      if (hit) {
        if (hasFiles) hit.ws = { ...(hit.ws || {}), ...files };
        // 已经有快照就别覆盖：那个才是这一轮开始时的样子
        if (hasMem && !Object.prototype.hasOwnProperty.call(hit, 'mem')) hit.mem = mem;
      } else {
        const entry = { at: n, hidden: [], ws: files };
        if (hasMem) entry.mem = mem;
        rewinds.push(entry);
      }
    }
  }
  return files;
}

/**
 * 回退时还原记忆。别的什么都不动，只让本子回到那个回退点记下的样子。
 * 找不到快照就什么都不做（老的回退点没有 mem 字段）。
 */
export function restoreMemory(session, rewind) {
  if (!session?.id || !rewind || !('mem' in rewind)) return null;
  try {
    return snapMemory(session.id, rewind.mem ?? null);
  } catch {
    return null;
  }
}

export function snapshotBeforeWrite(snap, p) {
  if (!snap || typeof snap !== 'object') return;
  const hit = resolveInsideWorkspace(String(p ?? ''));
  if (!hit) return; // 工作区外，本来就不归回退管
  if (Object.prototype.hasOwnProperty.call(snap, hit.key)) return; // 同一轮写过两次，只留第一次的原样
  try {
    const st = statSync(hit.abs);
    if (!st.isFile()) return;
    snap[hit.key] = st.size > MAX_SNAPSHOT_BYTES ? null : readFileSync(hit.abs, 'utf8');
  } catch {
    snap[hit.key] = null; // 原来不存在 → 回退时删掉
  }
}

/**
 * 按快照把工作区还原回去。以快照为唯一标准，只动真正不一致的文件。
 */
export function restoreWorkspace(ws = {}) {
  const out = { restored: [], deleted: [], skipped: [], failed: [] };
  const root = resolve(config.workspace);
  for (const [key, content] of Object.entries(ws || {})) {
    const abs = resolve(root, key);
    const rel = relative(root, abs);
    if (rel.startsWith('..') || isAbsolute(rel)) continue;
    try {
      if (content === null) {
        if (existsSync(abs)) {
          unlinkSync(abs);
          out.deleted.push(key);
        } else out.skipped.push(key);
      } else if (typeof content === 'string') {
        const now = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
        if (now === content) out.skipped.push(key);
        else {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, content, 'utf8');
          out.restored.push(key);
        }
      } else out.skipped.push(key);
    } catch (e) {
      out.failed.push({ path: key, error: String(e?.message ?? e) });
    }
  }
  return out;
}
