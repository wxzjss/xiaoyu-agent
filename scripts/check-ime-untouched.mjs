/**
 * 【2026-11-09 主人报】「设置里把输入法默认改为英文时，我在右下角把『英』改『中』，
 * 双击 exe 进小鱼Agent 又自动变回英文。不是说不动我输入法吗？」
 *
 * 查下来：应用**确实没有**主动调过系统输入法（asar / 运行版 / 当前源码都核实过，
 * imm32 与 ime:matchSystem 早就不自动调用了）。但两件事让它「看起来像动了」：
 *   ① Windows 按窗口各自记 IME 状态 —— 切到这个窗口就恢复它上次记的英文，
 *      这是系统行为，不是程序切的；
 *   ② 页面启动那一下 `input.focus()` 会重建 IME 上下文，连着三次
 *      （立即 + rAF + 60ms）就把人手切好的「中」冲回默认「英」。
 *
 * 另外还留着一堆没有执行者的残留：「输入法跟随系统」功能开关、
 * imeMatchSystem 设置项、preload 里两个没人接的 IPC —— 主人看见的就是
 * 「设置里有个默认英文的开关还在」。
 *
 * 这个检查把「一行都不碰输入法」钉死：不许再出现任何改系统 IME 的桥或开关，
 * 也不许再让页面自己无手势地抢焦点。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('输入法：应用一行都不碰');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
const ui = read('public/index.html');
const preload = read('electron/preload.cjs');
const main = read('electron/main.cjs');
const features = read('src/features.mjs');
const settings = read('src/settings.mjs');

/* 一、没有任何主动改系统输入法的桥或开关 */
t.ok('preload 不再暴露 ime 的 IPC', !/imeMatchSystem|imeSystemLang|ime:matchSystem/.test(preload));
t.ok('主进程不再注册 ime IPC', !/ipcMain\.handle\(\s*['"]ime:/.test(main));
t.ok('功能页不再有「输入法跟随系统」开关', !/id:\s*['"]imeMatch['"]/.test(features));
t.ok('设置里不再有 imeMatchSystem 这一项', !/imeMatchSystem/.test(settings));
t.ok('前端不再调用任何改 IME 的桥', !/desktop\.imeMatchSystem|desktop\.imeSystemLang/.test(ui));

/* 二、开机不抢焦点（focus() 会重建 IME 上下文） */
t.ok('记录页面启动时间', /window\._xyBootAt = Date\.now\(\)/.test(ui));
t.ok('记录主人真实手势时间', /window\._xyLastGesture = Date\.now\(\)/.test(ui));
t.ok('抢焦点前先看「开机 3 秒 / 2 秒内有手势」',
  /_mayFocus = \(_now - _bootAt >= 3000\) \|\| \(_now - _gestureAt < 2000\)/.test(ui)
  && /if \(!noFocus && _mayFocus && \(forceFocus \|\| wantFocus\(\)\)\)/.test(ui));
t.ok('wantFocus 自己也有开机保护',
  /function wantFocus\(force\) \{[\s\S]{0,240}_xyBootAt/.test(ui));

/* 三、三次连 focus 只在明确允许时才会发生，不再无条件跑 */
const grabs = (ui.match(/requestAnimationFrame\(grab\)/g) || []).length;
t.ok('连着三次抢焦点只留一处，且被闸护着', grabs === 1, 'grab 段数=' + grabs);

t.done();
