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
export function takeMail(sessionId) {
  if (!isId(sessionId)) return [];
  const f = boxPath(sessionId);
  if (!existsSync(f)) return [];
  const all = readBox(sessionId);
  try {
    rmSync(f, { force: true });
  } catch {}
  return all;
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
