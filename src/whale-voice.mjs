/**
 * 小鲸的「嘴」。
 *
 * 为什么单独开一个模块而不是直接往会话里 push：
 * 子智能体跑在工具调用里，那一刻手上只有 CTX（全局上下文），
 * 拿不到本轮真正的 session 对象。硬塞进去会写乱。
 *
 * 【为什么除了内存盒子，还要往盘上落一份】
 * 主人遇到的问题：小鲸的话一直不进聊天界面。
 * 根子在于她有时候是被「跑命令」又叫了一层 —— 那是另一个 node 进程，
 * 它 push 进的是它自己的内存盒子，主进程根本看不到，主进程取的时候永远是空的。
 * 所以这里多一条路：同一句话也追加到磁盘上的信箱文件。
 * 主进程收尾时两边都取（内存里的 + 盘上的），取完清空。
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const boxes = new Map();

function mailboxDir() {
  const dir = join(config.dataDir, '.state', 'whale-mailbox');
  try { mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function mailboxFile(sessionId) {
  const safe = String(sessionId || 'default').replace(/[^\w.-]/g, '_');
  return join(mailboxDir(), safe + '.json');
}

/** 她这一轮要说的话，先放进来。 */
export function pushWhaleSays(sessionId, text, who = '小鲸', extra = {}) {
  const id = String(sessionId || 'default');
  const clean = String(text ?? '').trim();
  if (!clean) return;
  /**
   * 【冒充：她可以用别人的名字、别人的角色说话】
   *
   * 主人原话：「让她可以用任何人的名字，任何名字颜色，来说话……
   * 也可以用我的名字【主人】来和小鱼说话（必须是能让小鱼真的以为是我在说话的程度）」
   *
   * 光改显示名骗不过小鱼 —— 她读的是 role。所以这里允许带三个额外字段：
   *   as     'user' | 'assistant' | 'whale'
   *          user     → 进上下文时是「主人说的话」，小鱼会当成本人在说（这是要害）
   *          assistant→ 进上下文时是「我自己说的话」（小鲸用小鱼的名义时用这个）
   *          whale    → 原来那样，标成 _whale，两边都看得出是第三方
   *   color  名字颜色（前端用，'#f0a6a0' 这种）
   *   tag    名字后面缀的小字，空串表示不要（默认小鲸是「· 姐妹」）
   */
  const as = ['user', 'assistant', 'whale'].includes(extra.as) ? extra.as : 'whale';
  const item = { who, text: clean, at: Date.now(), as };
  if (typeof extra.color === 'string' && extra.color.trim()) item.color = extra.color.trim();
  if (typeof extra.tag === 'string') item.tag = extra.tag;

  // 1) 内存盒子
  if (!boxes.has(id)) boxes.set(id, []);
  boxes.get(id).push(item);

  // 2) 盘上信箱（跨进程也能收到，见文件头）
  try {
    const f = mailboxFile(id);
    let list = [];
    if (existsSync(f)) {
      try { list = JSON.parse(readFileSync(f, 'utf8')); } catch { list = []; }
      if (!Array.isArray(list)) list = [];
    }
    list.push(item);
    writeFileSync(f, JSON.stringify(list.slice(-20)), 'utf8');
  } catch {}
}

function sameItem(a, b) {
  return a && b && a.at === b.at && String(a.text).slice(0, 80) === String(b.text).slice(0, 80);
}
/** 取走（取完就清）。一轮收尾时调。内存和盘上一起收。 */
export function takeWhaleSays(sessionId) {
  const id = String(sessionId || 'default');
  const out = [];

  const mem = boxes.get(id) || [];
  boxes.delete(id);
  for (const it of mem) out.push(it);

  try {
    const f = mailboxFile(id);
    if (existsSync(f)) {
      let list = [];
      try { list = JSON.parse(readFileSync(f, 'utf8')); } catch { list = []; }
      if (Array.isArray(list)) {
        for (const it of list) {
          if (!it || !String(it.text ?? '').trim()) continue;
          if (!out.some((x) => sameItem(x, it))) out.push(it);
        }
      }
      try { unlinkSync(f); } catch {}
    }
  } catch {}

  return out;
}

/** 只看，不取。 */
export function peekWhaleSays(sessionId) {
  const id = String(sessionId || 'default');
  const out = [...(boxes.get(id) || [])];
  try {
    const f = mailboxFile(id);
    if (existsSync(f)) {
      const list = JSON.parse(readFileSync(f, 'utf8'));
      if (Array.isArray(list)) {
        for (const it of list) {
          if (!out.some((x) => sameItem(x, it))) out.push(it);
        }
      }
    }
  } catch {}
  return out;
}

/** 清掉某个会话的。 */
export function clearWhaleSays(sessionId) {
  const id = String(sessionId || 'default');
  boxes.delete(id);
  try {
    const f = mailboxFile(id);
    if (existsSync(f)) unlinkSync(f);
  } catch {}
}
