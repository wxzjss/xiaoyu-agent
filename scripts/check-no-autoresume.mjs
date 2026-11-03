// check-no-autoresume：主人 2026-11-02 要求删掉「重启后自动续上」。
// 这条守着它别被以后不小心加回来。
import fs from 'node:fs';

const FILES = [
  'D:/小鱼Agent/src/server.mjs',
  'C:/Users/35453/AppData/Roaming/小鱼Agent/data/code/src/server.mjs',
];

let bad = 0;
for (const p of FILES) {
  if (!fs.existsSync(p)) { console.log('跳过（不存在）' + p); continue; }
  const s = fs.readFileSync(p, 'utf8');

  // 1) 启动时不许有 setTimeout 自动调 resumeInterruptedTurn
  const auto = /setTimeout\s*\(\s*\(\s*\)\s*=>\s*\{?[\s\S]{0,200}?resumeInterruptedTurn\s*\(/.test(s);
  if (auto) { console.log('FAIL 启动时还在自动续跑: ' + p); bad++; }
  else console.log('OK   启动时不自动续跑');

  // 2) 手动接口和函数本体要留着
  if (!s.includes('async function resumeInterruptedTurn')) { console.log('FAIL 函数本体被误删'); bad++; }
  else console.log('OK   resumeInterruptedTurn 函数还在（给手动接口用）');

  if (!s.includes("'/api/resume'")) { console.log('FAIL 手动接口被误删'); bad++; }
  else console.log('OK   /api/resume 手动接口还在');
}
console.log(bad === 0 ? '\n全部通过' : '\n有 ' + bad + ' 项失败');
process.exit(bad === 0 ? 0 : 1);
