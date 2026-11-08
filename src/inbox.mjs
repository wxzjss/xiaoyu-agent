/**
 * 中途投递信箱 —— 照 dsh 的 steering 做的。
 *
 * 【为什么要这个东西】
 * 主人 2026-11-01：「我发消息时…我发现插话会直接打断 ai 正在说的话」
 * 「给小鱼Agent添加和 dsh 一样的消息预发送机制」。
 *
 * 以前小鱼Agent 的插话是 0.9.26 那套：一进来就把正在跑的那一轮 abort 掉，
 * 然后由前端拿新话重新起一轮。代价是**她正在说的那句话被拦腰砍断** ——
 * 主人看到的像是自己一开口就把她噎住了。
 *
 * dsh 不是这么做的。它把「用户又来话了」分成三档（见 @deepseek-ai/dsh-agent）：
 *
 *   steer(input)     → send(input, 'next-step', true)   排到**下一步**，并唤醒驱动器
 *   followup(input)  → send(input, 'next-turn', true)   排到**下一轮**
 *   inject(input)    → send(input, 'next-step', false)  排到下一步，但不唤醒（静默上下文）
 *
 * 三者都只是往一个 inbox 里塞，**不 abort**；真正把它接进对话的是 agent loop
 * 在每个步骤边界上去 drain 一次。所以那句话一定是在「她这一步已经说完」之后
 * 才被看见的 —— 不打断正在流的字，也不会丢。
 *
 * 这个文件就是那个 inbox。两个槽：
 *   steps：下一步就给她（主人的插话走这条）
 *   turns：下一轮再给她（她这一轮已经在收尾时用）
 *
 * 【为什么要落盘】
 * 只放内存的话，进程一重启那句话就没了 —— 主人打了字、按了发送、什么都没发生，
 * 这是最难查的一类 bug（以前真发生过）。所以每次入队/出队都写一份
 * `.state/inbox/<sessionId>.json`，重启后还认得。
 */
import fs from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = () => join(config.dataDir, '.state', 'inbox');

/** 会话 id 洗成能当文件名的样子（跟 compact-core 里 sidSafe 同一套规矩） */
function sidSafe(sessionId) {
  return String(sessionId || 'default').replace(/[^\w-]/g, '_').slice(0, 60);
}

function fileOf(sessionId) {
  return join(DIR(), sidSafe(sessionId) + '.json');
}

/** 内存里那一份：sessionId → { steps: [], turns: [] } */
const boxes = new Map();

function emptyBox() {
  return { steps: [], turns: [] };
}

function load(sessionId) {
  const id = sidSafe(sessionId);
  if (boxes.has(id)) return boxes.get(id);
  let box = emptyBox();
  try {
    const f = fileOf(sessionId);
    if (fs.existsSync(f)) {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      box = {
        steps: Array.isArray(j?.steps) ? j.steps.filter((x) => x && typeof x.text === 'string') : [],
        turns: Array.isArray(j?.turns) ? j.turns.filter((x) => x && typeof x.text === 'string') : [],
      };
    }
  } catch {
    box = emptyBox();
  }
  boxes.set(id, box);
  return box;
}

function save(sessionId, box) {
  try {
    fs.mkdirSync(DIR(), { recursive: true });
    const f = fileOf(sessionId);
    if (!box.steps.length && !box.turns.length) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
      return;
    }
    fs.writeFileSync(f, JSON.stringify({ sessionId: String(sessionId || ''), ...box }, null, 2), 'utf8');
  } catch {
    // 落盘失败不影响这一轮：内存里那份还在，最坏就是重启丢
  }
}

function push(sessionId, slot, text, extra = {}) {
  const t = String(text ?? '');
  if (!t.trim()) return 0;
  const box = load(sessionId);
  const item = {
    text: t,
    at: Date.now(),
    ...extra,
  };
  box[slot].push(item);
  save(sessionId, box);
  return box[slot].length;
}

/**
 * 中途引导：排到下一步。
 * 这是「主人插话」该走的那一档 —— 她这一步说完、下一次请求模型时就会看见。
 */
export function steer(sessionId, text, extra = {}) {
  return push(sessionId, 'steps', text, extra);
}

/**
 * 排到下一轮：她这一轮马上就收尾了，别硬塞进去打断收尾。
 * 目前 /api/interject 不用它（一律走 steer），留给「明确知道自己要排下一轮」的场合。
 */
export function followup(sessionId, text, extra = {}) {
  return push(sessionId, 'turns', text, extra);
}

/** 取走「下一步」那批（取走即清空；agent loop 每圈开头调一次） */
export function drainSteps(sessionId) {
  const box = load(sessionId);
  const out = box.steps.slice();
  if (out.length) {
    box.steps.length = 0;
    save(sessionId, box);
  }
  return out;
}

/** 取走「下一轮」那批 */
export function drainTurns(sessionId) {
  const box = load(sessionId);
  const out = box.turns.slice();
  if (out.length) {
    box.turns.length = 0;
    save(sessionId, box);
  }
  return out;
}

/** 看看还有没有压着的（不改动） */
export function peekInbox(sessionId) {
  const box = load(sessionId);
  return { steps: box.steps.slice(), turns: box.turns.slice() };
}

/** 还有几条没送出去 */
export function inboxCount(sessionId) {
  const box = load(sessionId);
  return box.steps.length + box.turns.length;
}

/**
 * 清空。
 *
 * 【点「停止」时要连着清】dsh 的 cancel 默认也清 inbox（`options.keepInbox` 才留）：
 * 主人点停止的意思是「这一轮到此为止」，那么压着的插话也不该在他停手之后突然冒出来
 * 接着跑 —— 那会变成「明明停了还在动」。
 */
export function clearInbox(sessionId) {
  boxes.set(sidSafe(sessionId), emptyBox());
  save(sessionId, emptyBox());
}
