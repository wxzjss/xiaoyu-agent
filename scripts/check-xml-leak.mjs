#!/usr/bin/env node
/**
 * 检查：模型把工具名自造成标签时，会不会被当成正文画到气泡里、还把整轮工具全都吞掉。
 *
 * 为什么会有这条检查
 * ------------------
 * 2026-11-14 真机事故：模型没走原生 tool_calls，而是在正文里写
 *
 *     <ask_peer">
 *     <to>smwg61ggmhd4a</to>
 *     <text>……</text>
 *     </ask_peer>
 *
 * 老守卫 createXmlCallGuard 的 MARK 只认 `tool_call|invoke|call|run_command` 四个词，
 * 一个都不匹配 → 这段原样流到气泡里给主人看，同时那一轮的工具**一次都没执行**。
 * （同一形态之前也出现在 <plan"> 上。）
 *
 * 正确做法
 * --------
 *   · 守卫的名字名单必须包含「全部真实注册过的工具名」，不能写死四个
 *   · 标签名后面跟 `"` `'` 之类多余符号也要认得出来
 *   · 认错了要能回退：解析不成工具调用就把扣住的原文原样补发，不许吞话
 *   · 纯正文里提到工具名（没有尖括号）一个字符都不能扣
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const { createXmlCallGuard, parseXmlToolCalls } = await import(
  new URL('../src/llm.mjs', import.meta.url).href
);

let pass = 0, fail = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  ok   ' + m); }
  else { fail++; console.log('  FAIL ' + m + (extra ? '  → ' + extra : '')); }
};

/* 真实工具名：从 tools 注册表里抽，别写死 —— 以后加了新工具这条检查自动覆盖 */
const toolSrc = readFileSync(join(ROOT, 'src', 'tools.mjs'), 'utf8');
const NAMES = new Set(
  [...toolSrc.matchAll(/\bname:\s*'([a-z][a-z0-9_]*)'/g)].map((m) => m[1])
);
/* 名单为空的兜底：至少要有下面这几个，否则说明正则没抓到、检查本身失效了 */
const MUST = ['run_command', 'read_file', 'write_file', 'plan', 'ask_peer'];
const missing = MUST.filter((n) => !NAMES.has(n));

console.log('工具名抓取：' + NAMES.size + ' 个');
if (missing.length) {
  console.log('  FAIL 名单缺关键项：' + missing.join(','));
  fail++;
} else {
  pass++;
  console.log('  ok   名单包含 ' + MUST.join('/'));
}

/* ---------- 1. 真机原文（抄的）必须能被解析成调用 ---------- */
console.log('\n[1] 真机吐出来的形态能解析成工具调用');
{
  const BAD = `<ask_peer">
<to>smwg61ggmhd4a</to>
<text>这条我上一条已经回过了，打住。</text>
</ask_peer>`;
  const r = parseXmlToolCalls(BAD, NAMES);
  ok(r.length === 1, '解出 1 条调用', '实际 ' + r.length);
  ok(r[0]?.name === 'ask_peer', '名字 ask_peer', String(r[0]?.name));
  let a = {};
  try { a = JSON.parse(r[0]?.arguments || '{}'); } catch {}
  ok(a.to === 'smwg61ggmhd4a', '参数 to 落地', JSON.stringify(a.to));
  ok(String(a.text || '').includes('打住'), '参数 text 落地', JSON.stringify(String(a.text).slice(0, 16)));
}

/* ---------- 2. 不带多余符号的正常闭合形态 ---------- */
console.log('\n[2] 干净闭合的 <k>v</k> 也认');
{
  const r = parseXmlToolCalls('<ask_peer><to>x</to><text>hi</text></ask_peer>', NAMES);
  ok(r.length === 1 && r[0].name === 'ask_peer', '解析成功');
}

/* ---------- 3. 未注册的名字不许当工具执行 ---------- */
console.log('\n[3] 未注册标签不执行（防误伤 / 防伪造）');
{
  ok(parseXmlToolCalls('<to>abc</to>', NAMES).length === 0, '<to> 不产生调用');
  ok(parseXmlToolCalls('<foo_bar><x>1</x></foo_bar>', NAMES).length === 0, 'foo_bar 不产生调用');
}

/* ---------- 4. 守卫：命中后立刻扣住，正文只放前半句 ---------- */
console.log('\n[4] 守卫扣得住，且不吞掉前面的正文');
{
  const g = createXmlCallGuard([...NAMES]);
  const pieces = ['好，我', '去问一下', '<ask_pe', 'er">', '<to>smwg61g', 'gmhd4a</to>', '</ask_peer>'];
  let shown = '';
  for (const p of pieces) shown += g.feed(p);
  ok(g.hit === true, '跨块切开也命中');
  ok(shown === '好，我去问一下', '前半句照常放出', JSON.stringify(shown));
  ok(String(g.heldText()).startsWith('<ask_peer'), '扣住的从 <ask_peer 起', JSON.stringify(String(g.heldText()).slice(0, 12)));
  ok(parseXmlToolCalls(g.heldText(), NAMES).length === 1, '扣住的原文能解析成调用');
}

/* ---------- 5. 正常正文一个字符都不许扣 ---------- */
console.log('\n[5] 正常正文不误伤');
{
  const GOOD = '我去看一眼日志，然后跑一下 check-live-sync，再读 read_file 那段。';
  const g = createXmlCallGuard([...NAMES]);
  let shown = '';
  for (const ch of GOOD) shown += g.feed(ch);
  shown += g.flush();
  ok(g.hit === false, '没命中');
  ok(shown === GOOD, '原样放出', shown.length + '/' + GOOD.length);
}

/* ---------- 6. 每个真实工具名都要能被守卫认出来 ---------- */
console.log('\n[6] 全部 ' + NAMES.size + ' 个工具名逐一生效');
{
  const bad = [];
  for (const n of NAMES) {
    const g = createXmlCallGuard([...NAMES]);
    g.feed('x<'); g.feed(n); g.feed('>y');
    if (!g.hit) bad.push(n);
  }
  ok(bad.length === 0, '一个不漏', bad.join(','));
}

/* ---------- 7. 老形态不许退步 ---------- */
console.log('\n[7] 原来的 <tool_call> 形态不退步');
{
  const g = createXmlCallGuard([...NAMES]);
  let shown = '';
  for (const p of ['先', '<tool_c', 'all name="plan">', '</tool_call>']) shown += g.feed(p);
  ok(g.hit === true, '仍然命中');
  ok(shown === '先', '没漏出去', JSON.stringify(shown));
}

/* ---------- 8. 认错时要能回退（不许吞话） ---------- */
console.log('\n[8] 扣住了但解析不成调用 → 原文能捞回来');
{
  const g = createXmlCallGuard([...NAMES]);
  g.feed('正文<read_file>');
  g.feed('这不是合法参数');
  const held = String(g.heldText());
  ok(held.includes('read_file'), '扣住的原文还在（可以补发）', JSON.stringify(held.slice(0, 24)));
}

console.log('\n=== ' + pass + ' passed, ' + fail + ' failed ===');
process.exit(fail ? 1 : 0);
