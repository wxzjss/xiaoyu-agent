/**
 * 【哪些消息不该画到界面上】
 *
 * 主人 2026-11-08：「重启后【杂活鱼】会发出一大段话，是说给我看的吗？
 * 需要这个功能吗？能删吗？」
 *
 * 查下来那是 `_recovered` —— 重启时把上一轮没说完的半截话从草稿补回来
 * （目的是别丢话、让她接着往下说）。实测那条 1079 字，全是括号里的内心独白，
 * 还带着 `<assistant>` 标签。功能要留，但不该当正文画出来。
 *
 * 这类「程序自己的消息」不止一种，历史上漏过好几次（system 人设被画出来、
 * 压缩摘要漏到屏幕、量线提醒被当成主人说话）。这个检查把它们收成一张清单，
 * 谁漏了就在这儿红。
 */
import { makeChecker } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';
import fs from 'node:fs';

const t = makeChecker('sessions / 不该显示的消息');
const server = fs.readFileSync('src/server.mjs', 'utf8');
const core = fs.readFileSync('src/sessions-core.mjs', 'utf8');
const ui = readUISource();

/** publicSession 里那段循环（从 for 到 turns.push 之前） */
const a = server.indexOf('function publicSession(session)');
const b = server.indexOf('return {', a) > 0 ? server.indexOf('return {', a) : a + 40000;
const body = server.slice(a, b > a ? b : a + 40000);

const MUST_SKIP = [
  ['role: tool', /if \(m\.role === 'tool'\) continue;/, '工具结果是配在 assistant 上的，不是谁说的话'],
  ['role: system', /if \(m\.role === 'system'\) continue;/, '人设正文不该出现在对话流里'],
  ['context 提示', /if \(!m \|\| m\.context\) continue;/, '程序插的上下文提示'],
  /* 【2026-11-13 删】_recovered 不再隐藏——主人钦点「她说过的话不能消失」，照常画成正文气泡。 */
];

console.log('── publicSession 该跳过的消息类型 ──');
for (const [name, re, why] of MUST_SKIP) {
  t.ok('跳过 ' + name + '（' + why + '）', re.test(body));
}

// ── 前端：_sysNote 也不画 ──
t.ok('前端不画 _sysNote（重启提示/量线提醒）', /turn\.sysNote/.test(ui) && /continue/.test(ui));

// ── 落盘清洗：角色标签 + 思考标签 + 压缩记忆 ──
t.ok('读盘时剥角色标签', /assistant\|user\|system/.test(core));
t.ok('读盘时剥思考标签', /thinking\|think\|reasoning/.test(core));
t.ok('读盘时剥压缩记忆正文', /压缩记忆/.test(core));

// ── 写进去的那条确实带标记（不然上面跳过也没用） ──
t.ok('草稿回灌写入时带 _recovered', /_recovered: true/.test(server));

t.done();
