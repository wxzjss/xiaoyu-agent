import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('输入法：顶层不许有裸 focus');
const ui = fs.readFileSync('public/index.html', 'utf8');
const lines = ui.split(/\r?\n/);

/* 2026-11-09 主人再报：重启进小鱼Agent 输入法从中变英。
 *
 * 挖出来的实体：
 *   ① HKCU\Software\Microsoft\InputMethod\Settings\CHS 的 Default Mode
 *      =1 就是英文。微软拼音每个【新窗口】第一次拿焦点时按它初始化。
 *      改成 0 后实测（新开 PowerShell、新开记事本）任务栏都是「中」。
 *   ② index.html 原来第 11758 行躺着一句裸 input.focus()：
 *      删「清空当前」按钮时留下的孤儿，在模块顶层，页面一加载就跑，
 *      完全绕过 _mayFocus 那套「开机 3 秒内不抢」。focus() 会重建 IME
 *      上下文，于是刚切好的「中」被打回英文。已删。
 *
 * 这道检查守第②条：模块顶层（缩进 0）不许出现裸 focus()。
 * 交互里（按钮点击、回退、选文件）想聚焦就聚焦，那是主人自己的动作。
 */

const offenders = [];
for (let i = 0; i < lines.length; i++) {
  const raw = lines[i];
  const s = raw.trim();
  if (!/^(input|textarea|ta|el|sessFindInput)\.focus\(\);?$/.test(s)) continue;
  const indent = raw.length - raw.replace(/^\s+/, '').length;
  if (indent === 0) offenders.push((i + 1) + ': ' + s);
}

t.ok('模块顶层不再有裸 focus()（会重建 IME 上下文把「中」打回「英」）',
  offenders.length === 0,
  offenders.length ? '发现 ' + offenders.length + ' 处：' + offenders.join(' | ') : '');

/* 那句孤儿是我删的，确认它真的不在了（防止谁手一抖又加回来） */
t.ok('删「清空当前」留下的那句孤儿 focus 已移除',
  !/要清空记录的话去会话面板删那一整个会话[\s\S]{0,200}?^\s*input\.focus\(\);/m.test(ui));

t.done();
