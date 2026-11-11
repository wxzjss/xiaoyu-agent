/**
 * 【真机】乐观气泡该在什么时候收掉 —— 主人报「一轮结束我说的话堆到最下面」
 */
import fs from 'node:fs';

const src = fs.readFileSync('src-ui/store.js', 'utf8');
const i = src.indexOf('function dropLandedPending(');
const open = src.indexOf('{', i);
let d = 0, end = -1;
for (let k = open; k < src.length; k++) {
  if (src[k] === '{') d++;
  else if (src[k] === '}') { d--; if (d === 0) { end = k + 1; break; } }
}
/* 依赖的东西只有一个 norm()，照它的实现给个等价物 */
const normFn = `function norm(s){ return String(s == null ? '' : s).replace(/\\s+/g, ''); }`;
const drop = new Function(normFn + src.slice(i, end) + '; return dropLandedPending;')();

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  OK   ' + n + (x ? '  ' + x : '')); } else { fail++; console.log('  FAIL ' + n + (x ? '  ' + x : '')); } };

const pend = [{ id: 'p1', text: '帮我看一下那个报错' }];

/* ① 主人那句话后面跟着 10 段她的回复（一轮被劈成多段）→ 也必须收掉 */
{
  const turns = [{ role: 'user', text: '帮我看一下那个报错' }];
  for (let i2 = 0; i2 < 10; i2++) turns.push({ role: 'assistant', text: '第 ' + i2 + ' 段回复' });
  const kept = drop(pend, turns);
  ok('① 后面跟 10 段回复 → 乐观气泡照样收掉（原来是这个漏的）', kept.length === 0, '剩 ' + kept.length);
}

/* ② 4 段（旧代码的 6 条窗口刚好够）→ 收掉 */
{
  const turns = [{ role: 'user', text: '帮我看一下那个报错' }];
  for (let i2 = 0; i2 < 4; i2++) turns.push({ role: 'assistant', text: '第 ' + i2 + ' 段' });
  ok('② 4 段 → 收掉', drop(pend, turns).length === 0);
}

/* ③ 还没落盘（历史里最后是上一轮）→ 必须留着，不然屏幕上一瞬间没这条 */
{
  const turns = [{ role: 'user', text: '上一句' }, { role: 'assistant', text: '上一轮的回答' }];
  ok('③ 还没落盘 → 留着（不能吞掉刚发的那条）', drop(pend, turns).length === 1);
}

/* ④ 隔了很多轮又说同样的话 → 这一句是新的，必须留着 */
{
  const turns = [
    { role: 'user', text: '帮我看一下那个报错' },
    { role: 'assistant', text: '第一轮的回答' },
  ];
  for (let i2 = 0; i2 < 8; i2++) turns.push({ role: 'assistant', text: '中间第 ' + i2 + ' 段' });
  turns.push({ role: 'user', text: '别的问句' });
  turns.push({ role: 'assistant', text: '别的回答' });
  ok('④ 老的同文在很前面、最后一条 user 不是它 → 留着（不误吞）', drop(pend, turns).length === 1);
}

/* ⑤ 空白/换行差异也算命中 */
{
  const turns = [{ role: 'user', text: '帮我看一下  那个报错\n' }, { role: 'assistant', text: 'x' }];
  ok('⑤ 空白差异也算落盘', drop(pend, turns).length === 0);
}

/* ⑥ 空列表 / 非数组不出错 */
ok('⑥ 空列表不出错', drop([], [{ role: 'user', text: 'x' }]).length === 0);
ok('⑦ 非数组不出错', drop(pend, null).length === 1);

console.log('\n' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
