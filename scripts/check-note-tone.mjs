/**
 * 严检：量线提醒只能是「状态播报」，不许夹带命令口吻
 * （程序不是主人，没资格下指令；夹命令还会被模型当成主人的话去执行）
 */
import fs from 'node:fs';

const p = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\agent.mjs';
const src = fs.readFileSync(p, 'utf8');

let pass = 0, total = 0;
const chk = (l, c) => { total++; c ? (pass++, console.log('  [ok] ' + l)) : console.log('  [FAIL] ' + l); };

// 抠出五档 say 的文本
const says = [...src.matchAll(/say:\s*\(t, l, p\)\s*=>\s*'([^']*)'/g)].map((m) => m[1]);
console.log('=== 五档提醒原文 ===');
says.forEach((s, i) => console.log('  档' + (i + 1) + ': ' + s));

const banned = [
  ['不许外包', /不许外包/],
  ['什么都别干了', /什么都别干/],
  ['立刻', /立刻/],
  ['先别干', /先别干/],
  ['停下', /停下/],
  ['把结论', /把结论/],
  ['必须', /必须/],
  ['禁止', /禁止/],
];

console.log('');
console.log('=== 命令口吻检查 ===');
for (const [name, re] of banned) {
  const hit = says.find((s) => re.test(s));
  chk('没有「' + name + '」', !hit);
}

console.log('');
console.log('=== 该有的还在吗 ===');
chk('五档都在', says.length === 5);
const fullSays = [...src.matchAll(/say:\s*\(t, l, p\)\s*=>\s*([\s\S]*?)(?=\n\s*\},)/g)].map(m => m[1]);
console.log('  （扫到 ' + fullSays.length + ' 档完整表达式）');
chk('每档都报了 token 数和比例', fullSays.length >= 5 && fullSays.every((s) => s.includes('token') && s.includes('%')));
chk('有「不是主人说的话」前缀', /SYS_MID_NOTE\s*=\s*'〔程序自动插入的量线提醒/.test(src));
chk('前缀确实拼在内容前面', /content: SYS_MID_NOTE \+ tier\.say/.test(src));

console.log('');
console.log('------------');
console.log('断言：' + pass + '/' + total);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
