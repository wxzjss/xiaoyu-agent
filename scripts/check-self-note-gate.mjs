/**
 * check-self-note-gate.mjs —— 「压缩记忆」不许再画成她对主人说的话
 *
 * 主人报：「游戏鱼会话里，她思考链说要写压缩记忆，然后下一个回复就是空消息，只有署名」。
 *
 * 这个检查钉住四件事：
 *   ① 流式闸门：以【压缩记忆 开头的正文，一个字都不许漏到界面；
 *   ② 正文里夹着压缩记忆时，前面的正常话照常放行，后面那段被剪走；
 *   ③ agent 侧确实接了闸门、并且空正文不再落历史（空壳气泡就是这么来的）；
 *   ④ 渲染层那个过滤还在（第二道保险，别有人当它多余删掉）。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
};

const { makeSelfNoteGate, splitSelfNote, SELF_NOTE_TAG } = await import('../src/self-compress.mjs');

/** 按固定长度切块喂进去，模拟真实流式（逐字/三字一包都试） */
function feed(text, size) {
  const g = makeSelfNoteGate();
  let visible = '';
  for (let i = 0; i < text.length; i += size) {
    for (const seg of g.push(text.slice(i, i + size))) visible += seg;
  }
  for (const seg of g.finish()) visible += seg;
  return { visible, note: g.note };
}

console.log('\n[闸门] 压缩记忆不进正文');
const NOTE = '【压缩记忆·seg-2-3fdaf7ee87】\n## 目标\n修 run-all-checks 的 spawn 停摆\n## 卡点\n到 171 条停住';
for (const size of [1, 3, 7, 1000]) {
  const r = feed(NOTE, size);
  ok(r.visible === '', '整条都是压缩记忆 → 界面一个字都收不到（切块 ' + size + ' 字）', JSON.stringify(r.visible.slice(0, 40)));
  ok(r.note.includes('seg-2-3fdaf7ee87') && r.note.includes('spawn'), '记忆正文完整进了闸门（切块 ' + size + ' 字）', r.note.slice(0, 30));
}
for (const size of [1, 3, 1000]) {
  const chat = '（尾巴一摆）好，我这就去改。';
  const r = feed(chat, size);
  ok(r.visible === chat && !r.note, '普通说话照常放行，一个字不吞（切块 ' + size + ' 字）', JSON.stringify(r.visible));
}
for (const size of [1, 4, 1000]) {
  const r = feed('先跟你说一句：我记一下。' + NOTE, size);
  ok(r.visible === '先跟你说一句：我记一下。', '前面的话留着、后面那段剪掉（切块 ' + size + ' 字）', JSON.stringify(r.visible));
  ok(r.note.startsWith('【压缩记忆'), '剪下来的那段进了记忆（切块 ' + size + ' 字）', r.note.slice(0, 20));
}
/* 以「【」开头但不是压缩记忆的话，不许被误吞 */
for (const size of [1, 2, 1000]) {
  const r = feed('【修好了】界面那条不再空。', size);
  ok(r.visible === '【修好了】界面那条不再空。', '「【」开头但不是压缩记忆 → 不许误吞（切块 ' + size + ' 字）', JSON.stringify(r.visible));
}
ok(SELF_NOTE_TAG === '【压缩记忆', '记号没变（前端过滤、记忆本读取都靠它）', SELF_NOTE_TAG);

console.log('\n[分叉] splitSelfNote');
{
  const a = splitSelfNote('我说完了。\n' + NOTE);
  ok(a.chat === '我说完了。' && a.note.startsWith('【压缩记忆'), '正常话 + 记忆 → 切开', JSON.stringify(a.chat));
  const b = splitSelfNote('就是一句普通的话');
  ok(b.chat === '就是一句普通的话' && b.note === '', '没有记忆 → 原样返回');
}

console.log('\n[接线] agent 侧');
{
  const src = readFileSync(join(ROOT, 'src', 'agent.mjs'), 'utf8');
  ok(/_noteGate\.push\(ev\.text\)/.test(src), '收流时走闸门（不是直接 text += ev.text）');
  ok(!/^\s*text \+= ev\.text;\s*$/m.test(src), '没有绕过闸门的旧写法残留');
  ok(/_noteGate\.note/.test(src) && /saveSelfNote\(sid, _noteRaw\)/.test(src), 'saveSelfNote 从闸门取记忆正文');
  ok(/assistantMsg\.tool_calls\.length \|\| String\(assistantMsg\.content \|\| ''\)\.trim\(\)/.test(src),
    '空正文且无工具调用 → 不落历史（空壳气泡的根因）');
  ok(/String\(text \|\| ''\)\.trim\(\) && !isFillerReply\(text\)\) messages\.push/.test(src),
    '收尾落历史前先判空');
}

console.log('\n[保险] 渲染层过滤还在');
{
  const items = readFileSync(join(ROOT, 'src-ui', 'items.js'), 'utf8');
  ok(/压缩记忆/.test(items), 'items.js 仍然过滤压缩记忆（第二道保险）');
}

console.log('\n结果：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
