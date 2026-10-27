/**
 * 端到端：真叫一次小鲸，看她的提示词里有没有状态段、跑完状态本子有没有变。
 *
 * 不调模型 —— 只调 runSubagent 的「拼提示词」这一段做不到（它内部就发请求了）。
 * 所以这里改成：直接把 subagent.mjs 里拼好的 systemPrompt 关键段读出来验证，
 * 再单独把状态记账走一遍。真调模型的验证由主人实际使用时完成。
 *
 * 跑法：
 *   $env:MINI_AGENT_DATA='%APPDATA%\小鱼Agent\data'
 *   node scripts/test-whaleself-e2e.mjs
 */
import { readFileSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { selfPath, readSelf, writeSelf, afterRound, decayOverTime, stateBrief } from '../src/whale-self.mjs';

let pass = 0;
let fail = 0;
const ok = (n, c, x = '') => {
  if (c) { pass += 1; console.log('  ✓ ' + n); }
  else { fail += 1; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); }
};

const p = selfPath();
const bak = p + '.e2e';
if (existsSync(p)) renameSync(p, bak);

try {
  console.log('\n[1] 功能页里不该再有 whaleSelf 项（主人 2026-10-27 要求删掉）');
  const featSrc = readFileSync(new URL('../src/features.mjs', import.meta.url), 'utf8');
  ok('功能页里没有 whaleSelf 项', !featSrc.includes("id: 'whaleSelf'"));

  console.log('\n[2] subagent 里状态段的接线');
  const src = readFileSync(new URL('../src/subagent.mjs', import.meta.url), 'utf8');
  ok('读了状态本子', src.includes('readSelf()'));
  ok('做了时间回落', src.includes('decayOverTime(self)'));
  // 2026-10-27 主人删掉了功能页的「小鲸的状态」开关，
  // 状态系统改成常开（不再读 m.whaleSelf）。这里改成守「确实不再依赖那个开关」。
  ok('不再依赖已删除的 whaleSelf 开关', !src.includes('m.whaleSelf'));
  ok('状态段拼进提示词', src.includes('你说的状态') || src.includes('你现在是什么状态'));
  ok('不会拒绝那条在状态段之前', src.indexOf('不会拒绝') < src.indexOf('你现在是什么状态'), '顺序反了');
  ok('明确禁止念台词', src.includes('绝对不要说「我现在很累」'));

  console.log('\n[3] 反复问同一个问题：耐心单调下降');
  let s = readSelf();
  s.patience = { value: 95, bore: '' };
  s.tire = { body: 0, heart: 0 };
  s.boreCount = 0;
  const seq = [];
  for (let i = 1; i <= 5; i += 1) {
    afterRound(s, {
      minutes: 2,
      toolCount: 1,
      ok: true,
      sameBore: i,
      taskText: '确认一下 8787 端口是不是在监听',
    });
    seq.push(s.patience.value);
  }
  ok('耐心一路往下', seq.every((v, i) => i === 0 || v < seq[i - 1]), JSON.stringify(seq));
  ok('第 4 次掉得明显（≥20）', seq[2] - seq[3] >= 20, `${seq[2]} → ${seq[3]}`);

  console.log('\n[4] 累了 / 烦了，行为指令真的会变');
  const fresh = { desire: ['想清静'], desireStrength: [10], patience: { value: 90, bore: '' }, tire: { body: 5, heart: 5 }, shame: { value: 0, why: '' }, fear: { value: 0, what: '' }, mood: { 喜: 40, 怒: 5, 哀: 5, 乐: 40 }, care: { 小鱼: 60 } };
  const b1 = stateBrief(fresh);
  const worn = { ...fresh, patience: { value: 15, bore: '8787 端口' }, tire: { body: 85, heart: 72 } };
  const b2 = stateBrief(worn);
  ok('新鲜时不会说「压到最短」', !b1.includes('压到最短'), b1.slice(0, 60));
  ok('累透了才会说「压到最短」', b2.includes('压到最短'));
  ok('烦透了才会说「上面说过」', b2.includes('上面说过'));
  ok('两条都不一样长', b1.length !== b2.length, `${b1.length} vs ${b2.length}`);

  console.log('\n[5] 搁一天回来：累该退到很低');
  const tired = { ...JSON.parse(JSON.stringify(s)), lastAt: Date.now() - 24 * 3600 * 1000, tire: { body: 92, heart: 88 } };
  decayOverTime(tired);
  ok('体力从 92 掉到 0', tired.tire.body === 0, String(tired.tire.body));
  ok('心累也降了不少', tired.tire.heart < 30, String(tired.tire.heart));

  console.log(`\n结果：${pass} 过 / ${fail} 挂`);
  if (fail) process.exitCode = 1;
} finally {
  try { if (existsSync(p)) unlinkSync(p); } catch {}
  try { if (existsSync(bak)) renameSync(bak, p); } catch {}
}
