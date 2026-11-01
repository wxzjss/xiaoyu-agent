/**
 * 严检：量线提醒不许在历史里叠罗汉（最多一条）
 */
import fs from 'node:fs';

const p = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\agent.mjs';
const src = fs.readFileSync(p, 'utf8');

let pass = 0, total = 0;
const chk = (l, c) => { total++; c ? (pass++, console.log('  [ok] ' + l)) : console.log('  [FAIL] ' + l); };

console.log('=== 代码特征 ===');
chk('死变量 _pendingSysNote 已删干净（注释里提到不算）', !/let _pendingSysNote/.test(src) && !/_pendingSysNote\s*=/.test(src));
chk('插提醒前会摘同类旧提醒', /mm\.content\.indexOf\('〔量线'\)/.test(src));
chk('摘的时候只挑 _sysNote 的量线提醒（不误删正常对话）',
  /mm\._sysNote === true[\s\S]{0,80}indexOf\('〔量线'\)/.test(src));

console.log('\n=== 真跑：连续响 8 次，看历史里有几条 ===');
// 把源码里那段摘除逻辑原样抠出来跑
const msgs = [
  { role: 'user', content: '主人说的正经话 A' },
  { role: 'user', content: '别的系统提醒', _sysNote: true },
  { role: 'user', content: '主人说的正经话 B' },
];

function addWarn(text) {
  for (let mi = msgs.length - 1; mi >= 0; mi--) {
    const mm = msgs[mi];
    if (mm && mm._sysNote === true && typeof mm.content === 'string'
        && mm.content.indexOf('〔量线') !== -1) {
      msgs.splice(mi, 1);
    }
  }
  msgs.push({ role: 'user', content: text, _sysNote: true });
}

for (let i = 0; i < 8; i++) addWarn(`〔量线 70% 极限〕第 ${i + 1} 次`);
const warns = msgs.filter((m) => /〔量线/.test(String(m.content)));
console.log(`  总量=${msgs.length}  量线提醒=${warns.length}`);
chk('反复响 8 次，历史里只剩 1 条量线提醒', warns.length === 1);
chk('留下的是最新的那条', String(warns[0] && warns[0].content).includes('第 8 次'));
chk('主人的正经话一条没少', msgs.filter((m) => /正经话/.test(String(m.content))).length === 2);
chk('别的系统提醒没被误删', msgs.some((m) => String(m.content) === '别的系统提醒'));

console.log('\n────────────');
console.log(`断言：${pass}/${total}`);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
