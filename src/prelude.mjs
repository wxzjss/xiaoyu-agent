// 前情：一进来就已经发生过的对话。
//
// 三条硬规矩（主人定死的）：
//   1. 不在界面上显示 —— 它不是会话里的一条消息，只是发请求前临时贴上去的。
//   2. 只放对话，不放人设 —— 人设永远是设置里选的那套，这里一个字都不提。
//   3. 只发给模型 —— 落盘的 session.messages 里永远没有它，导出、统计、压缩都碰不到。
//
// 怎么做到的：把前情做成一条 context 消息（带 context: true），排在 system 后面、
// 真正的对话前面。前端 publicSession() 第 129 行 `if (!text && !atts.length) continue;`
// 之前就有 `if (!m || m.context) continue;` —— context 消息被直接跳过，所以画不出来。
// 而发给模型时它是实打实的一条 user 消息，模型当真实对话读。
//
// 为什么不塞进 system：塞进 system 就等于改人设，也绕不开「人设按设置里选的来」。
// 为什么不做成假消息存进会话：那样界面会显示成主人没说过的话，导出和压缩也会把它当历史。

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { config } from './config.mjs';

/** 前情目录：默认 .state/prelude/，里面每个 .json 就是一段前情。 */
export function preludeDir() {
  return join(config.dataDir, '.state', 'prelude');
}

const text = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

/**
 * 读一条前情文件，取出里面的对话。
 * 认三种形状：
 *   - 会话导出包：{ session: { messages: [...] } }（就是界面「导出」出来的那种）
 *   - 裸会话：{ messages: [...] }
 *   - 对话数组：[{role, content}, ...]
 * 只挑 user / assistant，system 一律丢掉（人设归设置管）。
 * @returns {{name: string, turns: {role: string, text: string}[], file: string} | null}
 */
export function readPreludeFile(file) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    console.warn('[prelude] 读不动，跳过：', file, String(err?.message ?? err));
    return null;
  }
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.session?.messages)
      ? raw.session.messages
      : Array.isArray(raw?.messages)
        ? raw.messages
        : [];
  const turns = [];
  for (const m of list) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    // 导出的包会带 _text（主人真打的字）；没有就用 content，并剥掉拼进去的附件说明块
    let body = m.role === 'user' && typeof m._text === 'string' ? m._text : text(m.content);
    if (m.role === 'user' && typeof m._text !== 'string' && body.includes('【主人随这条消息一起发来的')) {
      body = body.slice(0, body.indexOf('【主人随这条消息一起发来的')).trim();
    }
    body = body.trim();
    if (!body) continue;
    turns.push({ role: m.role, text: body });
  }
  if (!turns.length) return null;
  const name = text(raw?.session?.title) || file.split(/[\\/]/).pop().replace(/\.json$/i, '');
  return { name, turns, file };
}

/**
 * 当前生效的前情，按文件名排序拼起来。
 * 一条都没有就返回 null —— 调用方看到 null 就什么都不加，跟没这个功能一样。
 * @returns {{text: string, files: {name: string, turns: number}[], chars: number} | null}
 */
export function prelude() {
  const dir = preludeDir();
  if (!existsSync(dir)) return null;
  let names;
  try {
    names = readdirSync(dir).filter((f) => /\.json$/i.test(f)).sort();
  } catch {
    return null;
  }
  const blocks = [];
  const files = [];
  for (const n of names) {
    const file = join(dir, n);
    try {
      if (!statSync(file).isFile()) continue;
    } catch {
      continue;
    }
    const one = readPreludeFile(file);
    if (!one) continue;
    files.push({ name: one.name, turns: one.turns.length });
    blocks.push(
      one.turns
        .map((t) => `**${t.role === 'user' ? '主人' : '小鱼'}**：${t.text}`)
        .join('\n\n'),
    );
  }
  if (!blocks.length) return null;
  return { text: blocks.join('\n\n'), files, chars: blocks.join('\n\n').length };
}

/** 把前情包成一条 context 消息。没有前情就返回 null。 */
export function preludeContextMessage() {
  const p = prelude();
  if (!p) return null;
  const body = [
    '下面是本次对话之前已经发生过的一段对话。它不是设定，也不是新内容 ——',
    '是你和主人之间真实发生过的事，你现在就应该记得它。',
    '',
    '读它的方式：主人一开口，你就当自己处在「已经认识、已经聊过这一段」的状态里。',
    '别复述它，别说「我们之前聊过」，别问主人要不要再讲一遍 ——',
    '人不会每天重新认识一次。',
    '',
    '--- 之前的对话 ---',
    '',
    p.text,
  ].join('\n');
  return { role: 'user', content: body, context: true };
}

/** 给界面/接口用的状态：有哪些前情、在哪、多少字。别把正文一起吐出去。 */
export function preludeInfo() {
  const p = prelude();
  return {
    dir: preludeDir(),
    count: p ? p.files.length : 0,
    files: p ? p.files : [],
    chars: p ? p.chars : 0,
  };
}

/** 把一个外部 json 复制成一段前情。source 可以是绝对路径或相对当前工作目录的路径。 */
export function addPreludeFromPath(source, name) {
  const file = isAbsolute(source) ? source : resolve(process.cwd(), source);
  if (!existsSync(file)) {
    const e = new Error('找不到这个文件：' + file);
    e.status = 404;
    throw e;
  }
  if (!readPreludeFile(file)) {
    const e = new Error('这个文件里没有可用的对话（要 user/assistant 消息）');
    e.status = 400;
    throw e;
  }
  const dir = preludeDir();
  mkdirp(dir);
  const safe = String(name ?? file.split(/[\\/]/).pop()).replace(/[\\/:*?"<>|]/g, '_');
  const dest = join(dir, /\.json$/i.test(safe) ? safe : safe + '.json');
  writeFileSyncSafe(dest, readFileSync(file));
  return { file: dest, ...preludeInfo() };
}

// 这两个单独抽出来只是为了文件顶部 import 干净一点
import { mkdirSync, writeFileSync } from 'node:fs';
function mkdirp(dir) {
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
}
function writeFileSyncSafe(dest, buf) {
  writeFileSync(dest, buf);
}
