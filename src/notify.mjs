/**
 * 系统通知（2026-11-12 主人：「你看看有没有系统通知的插件，没有做一个，
 * 设置在软件对话，ai 回复的时候提醒下，还有 qq 回复的设置提醒下，做两个开关项」）。
 *
 * ── 这个东西在哪儿弹 ──────────────────────────────────────────
 *
 * 真正「弹出来」的动作只能在 Electron 主进程做（`new Notification()`）。
 * 好消息是：server.mjs 是 `await import()` 进**主进程**跑的（同一个进程），
 * 所以 main.cjs 把弹窗函数挂在 `globalThis.__xyNotify` 上，这里直接拿来用。
 *
 * 浏览器里直接打开页面（没有 Electron）时它不存在 —— 那就**静默不弹**，
 * 绝不能让「没通知」把一轮对话搞挂。
 *
 * ── 两个开关 ──────────────────────────────────────────────────
 *
 *   chat  软件里她回完一句时提醒（窗口不在最前面才弹，你正看着就别吵）
 *   qq    QQ 上有人私聊她 / 在群里 @ 她时提醒（同上）
 *
 * 存 .state/notify.json。文件坏了 / 读不出来 → 用默认值（都开），
 * 不因为一份坏 JSON 把提醒永久关掉 —— 这跟白名单那种「坏了就关死」
 * 是相反的方向：这里坏了的代价只是多弹两条，不是安全风险。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.mjs';

const VERSION = 1;

/** 默认两个都开：主人要的就是「有事提醒我」，装完不用再去点一次。 */
const DEFAULTS = { chat: true, qq: true };

export function notifyFile() {
  return join(config.dataDir, '.state', 'notify.json');
}

const boolOr = (v, dflt) => (typeof v === 'boolean' ? v : dflt);

export function getNotifyPrefs() {
  try {
    const f = notifyFile();
    if (!existsSync(f)) return { version: VERSION, ...DEFAULTS };
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return {
      version: VERSION,
      chat: boolOr(j?.chat, DEFAULTS.chat),
      qq: boolOr(j?.qq, DEFAULTS.qq),
    };
  } catch {
    // 坏文件 → 回默认（多提醒两句，不影响任何功能）
    return { version: VERSION, ...DEFAULTS };
  }
}

export function setNotifyPrefs(patch = {}) {
  const cur = getNotifyPrefs();
  const next = {
    version: VERSION,
    chat: boolOr(patch?.chat, cur.chat),
    qq: boolOr(patch?.qq, cur.qq),
  };
  const f = notifyFile();
  try {
    mkdirSync(dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    renameSync(tmp, f);
  } catch (err) {
    const e = new Error('通知设置没存上：' + String(err?.message ?? err));
    e.status = 500;
    throw e;
  }
  return next;
}

/** 主进程把弹窗函数挂上来没有？（前端/命令行可以用它显示「这台机器能不能弹」） */
export function notifyAvailable() {
  return typeof globalThis.__xyNotify === 'function';
}

/**
 * 弹一条。kind 是 'chat' | 'qq'，对应两个开关。
 *
 * 返回 true = 真的交给系统了；false = 开关关着 / 没有弹窗能力 / 弹的时候出错。
 * **永远不抛**：通知只是锦上添花，不许因为它把回复流程打断。
 *
 * opts.force = 无视窗口是否在前台（自检、命令行测试用）。
 */
export function notifyNow(kind, title, body, opts = {}) {
  try {
    const prefs = getNotifyPrefs();
    if (kind === 'chat' && prefs.chat !== true) return false;
    if (kind === 'qq' && prefs.qq !== true) return false;
    const fn = globalThis.__xyNotify;
    if (typeof fn !== 'function') return false;
    const text = String(body ?? '').replace(/\s+/g, ' ').trim();
    if (!text) return false;
    return fn({
      kind: kind === 'qq' ? 'qq' : 'chat',
      title: String(title || '小鱼').slice(0, 80),
      body: text.slice(0, 180),
      force: opts.force === true,
    }) !== false;
  } catch {
    return false;
  }
}
