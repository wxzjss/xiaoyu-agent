/**
 * 会话之间的小信箱：让两个小鱼（不同会话）能互相说句话。
 *
 * 为什么要有这个
 * --------------
 * 主人同时开着几个会话在干活，彼此看不见对方在做什么。以前想知道「那边打好了没」
 * 只能靠主人当传话筒。这套东西让会话之间能直接递话。
 *
 * 设计上的三条硬规矩
 * ------------------
 * 1. **不打断**。绝对不用 abort 去掐对方 —— 她手上可能正在打包、跑命令，
 *    掐一下就得从头来。所以消息只进信箱，等她自己走到「这一轮要收尾了」那一步
 *    才取出来看（见 agent.mjs 主循环里的 takeMail）。
 *
 * 2. **不花钱**。默认只存信箱，不主动叫醒对方。对方下次说话时自然看到。
 *    想立刻要回复，得显式叫醒（wake: true），那才会替她开一轮对话。
 *
 * 3. **只读彼此的话，不碰彼此的记忆**。信箱是独立文件，不进会话历史，
 *    也不进记忆本子 —— 递一句话不等于允许对方翻你的聊天记录。
 *
 * 存哪儿
 * ------
 * .state/peers/<收件会话id>.jsonl   一行一条，只追加
 * 每条：{ id, from, fromTitle, to, text, at, read }
 *
 * 为什么用 jsonl 而不是 json：
 * 两个进程可能同时往里写，jsonl 一行一条，追加写不用读全文、也不怕写一半断电
 * 把整个文件搞坏（最多坏最后一行）。
 */
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state', 'peers');
/** 信箱里最多留多少条，超了把最老的扔掉（防着有人忘了清，越攒越大） */
const KEEP_MAX = 200;
/** 一条消息最多多长：太长会挤爆对方的上下文，没必要 */
const TEXT_MAX = 4000;

function ensureDir() {
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {}
}

function boxPath(sessionId) {
  return join(DIR, `${String(sessionId).replace(/[^\w.-]/g, '_')}.jsonl`);
}

function isId(v) {
  return typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
}

/** 读一个信箱的全部消息（坏行跳过，不让一行坏了整箱） */
export function readBox(sessionId) {
  if (!isId(sessionId)) return [];
  const f = boxPath(sessionId);
  if (!existsSync(f)) return [];
  let raw = '';
  try {
    raw = readFileSync(f, 'utf8');
  } catch {
    return [];
  }
  const out = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o.text === 'string') out.push(o);
    } catch {
      // 坏行（多半是上次写到一半断电），跳过就行
    }
  }
  return out;
}

/**
 * 往对方信箱里塞一条。
 *
 * @param {{ from: string, to: string, text: string, fromTitle?: string }} p
 * @returns {{ ok: boolean, id?: string, error?: string }}
 */
export function postMail({ from, to, text, fromTitle = '' }) {
  if (!isId(from) || !isId(to)) return { ok: false, error: '会话 id 不合法' };
  if (from === to) return { ok: false, error: '别给自己发消息' };
  // 只认字符串。传数字/对象进来是调用方写错了 —— 猜着转成 "12345" 收下，
  // 到时候对方读到的是一句莫名其妙的数字，还查不出是谁塞的。
  if (typeof text !== 'string') return { ok: false, error: '内容得是文字' };
  const body = text.trim();
  if (!body) return { ok: false, error: '内容是空的' };
  const clipped = body.length > TEXT_MAX ? body.slice(0, TEXT_MAX) + '\n…（太长了，后面截掉）' : body;

  ensureDir();
  const entry = {
    id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    from,
    fromTitle: String(fromTitle || '').slice(0, 40),
    to,
    text: clipped,
    at: Date.now(),
    read: false,
  };
  try {
    appendFileSync(boxPath(to), JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }

  // 顺手裁一下：留最近 KEEP_MAX 条
  try {
    const all = readBox(to);
    if (all.length > KEEP_MAX) {
      const keep = all.slice(-KEEP_MAX);
      writeFileSync(boxPath(to), keep.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8');
    }
  } catch {}

  return { ok: true, id: entry.id };
}

/**
 * 取走信箱里的信（取走 = 删掉）。
 *
 * 为什么取走而不是标记已读：这些消息最终会变成对方对话历史里的 user 消息，
 * 留在信箱里没有意义，还会在下次被重复提起。取走最干净。
 *
 * @returns {Array<{from:string,fromTitle:string,text:string,at:number}>}
 */
/**
 * 【进程内占用表】已经交给某一轮、但还没确认落盘的信的 id。
 *
 * 为什么要有它：takeMail 现在不再当场删文件了（见下），如果不记一笔，
 * 同一轮里每转一圈都会把同一封信重复喂进历史。这个 Set 就是「已出库未签收」。
 * id 是全局唯一的（m + 时间戳 + 随机），不用按会话分桶。
 */
const _claimed = new Map();
/** 占用的最长有效期（毫秒）—— 超过就当没占过，允许重投 */
const CLAIM_TTL_MS = 10 * 60 * 1000; // sessionId -> Set<mailId>

/**
 * 取走某个会话信箱里「还没交出去过」的信。
 *
 * 【2026-11-15 改：不再取走即删】
 * 原来是 readBox 之后立刻 rmSync 整个文件。真出过事：搭建鱼那边 22:50 收到了我递的话、
 * 01:12 也回了信，可她那一轮被重启掐断，/api/chat 的 finally 从没执行、saveSession 一次没跑，
 * 于是「信已经从信箱删了、历史里一个字都没有」—— 她那个会话 296 条消息里一条 peer 消息都没有，
 * 从主人视角看就是「根本没收到」。
 *
 * 现在的语义：交给这一轮的时候只在进程内占个位，文件一个字不动；
 * 等这一轮真的落盘了，由 ackSessionMail 把签收过的行从信箱里删掉。
 * 中途被打断/进程被杀 → _claimed 跟着进程一起没了、文件也还在 → 下一轮照常重投。
 * 代价是极端情况下可能重复投递一次（重投比丢信好）。
 */
export function takeMail(sessionId) {
  if (!isId(sessionId)) return [];
  const all = readBox(sessionId);
  if (!all.length) return [];
  let set = _claimed.get(sessionId);
  if (!set) { set = new Map(); _claimed.set(sessionId, set); }
  // 【2026-11-15 兜底】占用带过期时间：万一哪个分支漏了释放（抛异常、提前 return、
  // 换会话……），10 分钟后自动作废，信会重新投一次。宁可重复一次，不许永久卡死。
  const now = Date.now();
  for (const [id, at] of [...set]) if (now - at > CLAIM_TTL_MS) set.delete(id);
  const fresh = all.filter((m) => m && m.id && !set.has(m.id));
  for (const m of fresh) set.set(m.id, now);
  return fresh;
}

/**
 * 只认领**指定的那一封**（别的信一个字都不碰）。
 *
 * 【2026-11-19 加·递话即时送达后，别再让她读第二遍】
 *
 * 即时递送（deliverMailNow）是把信的内容做成一条「仅AI可见的系统提示」插进
 * 她当前这轮的下一步 —— 可信本身还躺在信箱文件里。等这一轮收尾，
 * agent 主循环 takeMail 又把同一封信当成「新信」投一遍，她就同一句话读了两遍
 * （主人对这种重复特别敏感，11-17 报过一次「通知发两遍」）。
 *
 * 所以插进去的同时，按 id 把这一封标成「已交给某一轮」——
 * 只标这一封，同时间进来的别的信照旧正常投递。
 * 跟 takeMail 的占用语义完全一致：进程死掉 / 这一轮被掐断，
 * releaseClaimedMail 会把它放回来重投，不会丢。
 */
export function claimMail(sessionId, id) {
  const sid = String(sessionId || '');
  const mid = String(id || '');
  if (!isId(sid) || !mid) return false;
  let set = _claimed.get(sid);
  if (!set) { set = new Map(); _claimed.set(sid, set); }
  set.set(mid, Date.now());
  return true;
}

/**
 * 签收：这一轮已经落盘了，把被占用过、且确实在这个信箱里的信从文件里删掉。
 * 返回真删了几条（给日志用）。
 *
 * 只删 _claimed 里的 —— 万一中途又有新信投进来，那些还没交给任何一轮，不能跟着一起清。
 */
export function ackSessionMail(sessionId) {
  if (!isId(sessionId)) return 0;
  const f = boxPath(sessionId);
  const set = _claimed.get(sessionId) || new Set();
  if (!existsSync(f)) {
    _claimed.delete(sessionId);
    return 0;
  }
  const all = readBox(sessionId);
  const keep = [];
  const gone = [];
  for (const m of all) {
    if (m && m.id && set.has(m.id)) gone.push(m.id);
    else keep.push(m);
  }
  if (!gone.length) return 0;
  try {
    if (keep.length) writeFileSync(f, keep.map((m) => JSON.stringify(m)).join('\n') + '\n', 'utf8');
    else rmSync(f, { force: true });
  } catch {
    // 删失败就别清占用表，下次还能再签一次
    return 0;
  }
  /* 【2026-11-19 补】签收掉的那几封，占用表里也把它们划掉。
   * 原来这里原样留在 set 里，签收完了还记着「已出库未签收」——
   * 文件里早就没了，留着纯属残留（每次 releaseClaimedMail 都会多报几条）。
   * 只划掉 gone 里的；同时间新进来的信还没交给任何一轮，不动。 */
  for (const id of gone) set.delete(id);
  if (set.size) _claimed.set(sessionId, set);
  else _claimed.delete(sessionId);
  return gone.length;
}

/** 这一轮彻底失败/被掐断时把占用吐回去，让下一轮还能重投（不删文件，只放回可投状态） */
export function releaseClaimedMail(sessionId) {
  if (sessionId) {
    const set = _claimed.get(sessionId);
    const n = set ? set.size : 0;
    _claimed.delete(sessionId);
    return n;
  }
  let n = 0;
  for (const s of _claimed.values()) n += s.size;
  _claimed.clear();
  return n;
}

/** 只看一眼，不取走（给界面显示用） */
export function peekMail(sessionId) {
  return readBox(sessionId);
}

/** 信箱里还有几封没看的 */
export function mailCount(sessionId) {
  return readBox(sessionId).length;
}

/**
 * 把信箱内容拼成一段给模型看的文字。
 *
 * 措辞很重要：得让模型明白这是「另一个会话里的我」递过来的话，
 * 不是主人在说话 —— 否则她会对着这句话撒娇或者喊主人。
 *
 * @param {Array<{from:string,fromTitle:string,text:string,at:number}>} mails
 */
export function formatMail(mails) {
  if (!Array.isArray(mails) || !mails.length) return '';
  const lines = mails.map((m) => {
    const who = m.fromTitle ? `「${m.fromTitle}」那个我（会话 ${m.from}）` : `另一个会话里的我（${m.from}）`;
    const when = new Date(m.at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    return `- ${when}，${who}递来一句话：\n${m.text.split(/\r?\n/).map((l) => '    ' + l).join('\n')}`;
  });
  return [
    '【有别的会话里的我给你递了话】',
    '',
    ...lines,
    '',
    '这不是主人在说话，是同一台电脑上另一个会话里的你写来的。',
    '该怎么回就怎么回：需要答就答，需要查就查，没什么要回的也可以不理会。',
    '答完了就用 ask_peer 把话递回去（记得带上对方的会话 id）。',
  ].join('\n');
}

/**
 * 清理信箱目录里的垃圾。两件事：
 *
 *   1. 空文件夹（内容被 takeMail 取空的残骸）
 *   2. 太久没动过的信箱（默认 30 天）—— 对方那个会话可能早删了，
 *      信一直躺在盘上占地方，还容易被下次误当成「新消息」。
 *
 * 以前这里收了 olderThanMs 却根本没用，只看文件是不是空的，
 * 而且整个函数没有任何地方调用 —— 等于白写。现在按时间真的清，
 * 并在 startServer 里定期跑一次。
 *
 * 注意：**只删真的过期货，不动刚发来的信**。宁可留，不可误删。
 *
 * @param {number} [olderThanMs] 多久没动过算过期，默认 30 天
 * @returns {number} 删了几个文件
 */
export function sweep(olderThanMs = 30 * 24 * 3600 * 1000) {
  ensureDir();
  let n = 0;
  let names = [];
  try {
    names = readdirSync(DIR);
  } catch {
    return 0;
  }
  const now = Date.now();
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const f = join(DIR, name);
    try {
      const st = readFileSync(f, 'utf8');
      // 空文件：直接清
      if (!st.trim()) {
        rmSync(f, { force: true });
        n++;
        continue;
      }
      // 有内容：看最后一条的 at，超过阈值才清
      const lines = st.split(/\r?\n/).filter(Boolean);
      let lastAt = 0;
      for (const ln of lines) {
        try {
          const m = JSON.parse(ln);
          if (m && Number.isFinite(m.at) && m.at > lastAt) lastAt = m.at;
        } catch {}
      }
      if (!lastAt) {
        // 一个能解析的都没有（坏文件），也当垃圾清掉
        rmSync(f, { force: true });
        n++;
        continue;
      }
      if (now - lastAt > olderThanMs) {
        rmSync(f, { force: true });
        n++;
      }
    } catch {
      // 读不了/删不掉就算了，下次再来
    }
  }
  return n;
}

/** 给界面看的摘要 */
export function peerInfo(sessionId) {
  const all = readBox(sessionId);
  return {
    dir: DIR,
    count: all.length,
    items: all.slice(-20).map((m) => ({ id: m.id, from: m.from, fromTitle: m.fromTitle, at: m.at, preview: m.text.slice(0, 60) })),
  };
}
