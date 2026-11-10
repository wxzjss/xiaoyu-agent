/**
 * 进程兜底：让小鱼Agent 不会因为一处没 catch 的异常就整个消失。
 *
 * 背景：以前整个项目没有 uncaughtException / unhandledRejection 兜底。
 * Node 15 之后，一个没人管的 Promise 拒绝会直接把进程杀掉——
 * 表现就是「聊着聊着她突然没了」，如果正好在跑长任务，那一轮的回复全丢。
 *
 * 原则：
 *   1. 单次出错 ≠ 程序该死。记下来、继续跑。
 *   2. 但也不能装死：出事必须留痕，方便事后查。
 *   3. 真的连栈都炸了（同一个错误短时间内反复出现）才让进程退，
 *      而且退之前把状态落盘，别把主人正在聊的东西一起带走。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state');
const LOG = join(DIR, 'crash.log');
const COUNT = join(DIR, 'crash-count.json');

/** 同一个错误指纹在 60 秒内出现这么多次，就认为已经救不回来了 */
const FATAL_WINDOW_MS = 60_000;
const FATAL_TIMES = 5;

function ensureDir() {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
  } catch {}
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 把错误写成几行能看懂的中文，别扔一坨 stack 给主人看 */
export function describeError(err) {
  if (!err) return '（没拿到错误对象）';
  if (typeof err === 'string') return err;
  const name = err.name || 'Error';
  const msg = err.message || String(err);
  const code = err.code ? ` [${err.code}]` : '';
  return `${name}: ${msg}${code}`;
}

/** 错误指纹：同名同消息算一类，用来判断是不是在反复炸 */
function fingerprint(err) {
  const s = describeError(err);
  // 把变动的部分（数字、临时文件名）抹掉，免得每条都算不同的
  return s.replace(/\d+/g, '#').slice(0, 200);
}

function readCounter() {
  try {
    const j = JSON.parse(readFileSync(COUNT, 'utf8'));
    if (j && typeof j === 'object') return j;
  } catch {}
  return {};
}

function writeCounter(obj) {
  try {
    ensureDir();
    writeFileSync(COUNT, JSON.stringify(obj), 'utf8');
  } catch {}
}

/**
 * 记一条崩溃日志。
 * @returns {{fatal: boolean, times: number}}
 */
export function logCrash(kind, err, extra = '') {
  ensureDir();
  const now = Date.now();
  const fp = fingerprint(err);

  // 同一类错误在窗口内数次数
  const counter = readCounter();
  const rec = counter[fp] && now - counter[fp].at < FATAL_WINDOW_MS ? counter[fp] : { at: now, times: 0 };
  rec.at = now;
  rec.times += 1;
  counter[fp] = rec;
  // 清掉过期的，别让这个文件无限长
  for (const k of Object.keys(counter)) {
    if (now - counter[k].at > FATAL_WINDOW_MS) delete counter[k];
  }
  writeCounter(counter);

  const stack = err && err.stack ? String(err.stack) : '';
  // stack 第一行通常就是「Error: 消息」，已经单独打过了，从第二行开始留
  const stackLines = stack ? stack.split('\n').slice(1, 8).map((l) => '  ' + l.trim()).filter((l) => l.trim()) : [];
  const block = [
    `${stamp()} 【${kind}】`,
    `  ${describeError(err)}`,
    extra ? `  ${extra}` : '',
    ...stackLines,
    `  累计同类错误：${rec.times} 次 / ${Math.round(FATAL_WINDOW_MS / 1000)} 秒内`,
    '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    appendFileSync(LOG, block + '\n', 'utf8');
  } catch {}

  return { fatal: rec.times >= FATAL_TIMES, times: rec.times };
}

/**
 * 装上兜底。传了 onFatal 就在「反复炸」时先调它（用来落盘正在跑的东西），再让进程退。
 */
export function installGuards({ onFatal } = {}) {
  const handle = (kind) => (err) => {
    const { fatal, times } = logCrash(kind, err);

    if (fatal) {
      try {
        if (typeof onFatal === 'function') onFatal(err, times);
      } catch (e) {
        logCrash('onFatal 出错', e);
      }
      // 实在没救了才退：先给 stdout 一句，主人在终端里能看见
      console.error(`[crash] ${describeError(err)} 反复出现 ${times} 次，只能退出了。日志：${LOG}`);
      process.exit(1);
    }

    console.warn(`[crash] 接住一个 ${kind}：${describeError(err)}（已记到 .state/crash.log，不影响继续用）`);
  };

  process.on('uncaughtException', handle('未捕获异常'));
  process.on('unhandledRejection', handle('没人接的 Promise 拒绝'));

  // Electron / Node 被杀之前的最后一句
  process.on('SIGTERM', () => {
    logCrash('收到 SIGTERM', '进程被要求退出（可能是关窗口 / 系统关机）');
    try {
      if (typeof onFatal === 'function') onFatal(new Error('SIGTERM'), 0);
    } catch {}
    process.exit(0);
  });
}

/** 最近多少条崩溃记录，给界面/自检看 */
export function crashSummary() {
  try {
    if (!existsSync(LOG)) return { count: 0, tail: '', file: LOG };
    const t = readFileSync(LOG, 'utf8');
    const lines = t.split('\n').filter((l) => /【/.test(l));
    return { count: lines.length, tail: t.split('\n').slice(-14).join('\n').trim(), file: LOG };
  } catch {
    return { count: 0, tail: '', file: LOG };
  }
}
