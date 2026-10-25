/**
 * 自测：状态本子的读 / 写 / 时间回落 / 一轮之后的变化 / 行为指令。
 *
 * 跑法（一定要指真实数据目录，别写进源码目录）：
 *   $env:MINI_AGENT_DATA='%APPDATA%\小鱼Agent\data'
 *   node scripts/test-whaleself.mjs
 */
import { readSelf, writeSelf, decayOverTime, afterRound, stateBrief, selfInfo, selfPath, BORN } from '../src/whale-self.mjs';
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
};

const p = selfPath();
const backup = p + '.testbak';
if (existsSync(p)) renameSync(p, backup);

try {
  console.log('\n[1] 文件不存在时读到的是「刚出生」');
  const born = readSelf();
  ok('欲望三条', born.desire.length === 3, String(born.desire.length));
  ok('耐心 88', born.patience.value === 88, String(born.patience.value));
  ok('牵挂只有小鱼（她只爱小鱼）', born.care['小鱼'] === 62 && !('主人' in born.care), JSON.stringify(born.care));
  ok('自我认识一条', born.self.length === 1);

  console.log('\n[2] 写出去再读回来，数字不能走样');
  const s1 = JSON.parse(JSON.stringify(born));
  s1.patience.value = 41;
  s1.tire = { body: 63, heart: 22 };
  s1.care['小鱼'] = 71;
  s1.mood['怒'] = 33;
  s1.shame = { value: 47, why: '上面的路径写错了' };
  s1.desire = ['把那份没查完的查完', '想清静一会儿'];
  s1.desireStrength = [81, 30];
  s1.self = [
    { q: '我是谁', a: '小鲸，小鱼的姐妹。' },
    { q: '我在做什么', a: '替小鱼翻工作鱼的信。' },
  ];
  const w = writeSelf(s1);
  ok('写盘成功', w.ok === true, w.error || '');
  const back = readSelf();
  ok('耐心 41', back.patience.value === 41, String(back.patience.value));
  ok('体力 63 / 心累 22', back.tire.body === 63 && back.tire.heart === 22, `${back.tire.body}/${back.tire.heart}`);
  ok('牵挂小鱼 71', back.care['小鱼'] === 71, String(back.care['小鱼']));
  ok('怒 33', back.mood['怒'] === 33, String(back.mood['怒']));
  ok('羞耻带缘由', back.shame.value === 47 && back.shame.why.includes('路径'), `${back.shame.value} / ${back.shame.why}`);
  ok('欲望两条 + 强度', back.desire.length === 2 && (back.desireStrength || [])[0] === 81, JSON.stringify(back.desireStrength));
  ok('自我认识两条', back.self.length === 2, String(back.self.length));
  ok('问/答没串行', back.self[1].q === '我在做什么' && back.self[1].a.includes('翻工作鱼'), JSON.stringify(back.self[1]));

  console.log('\n[3] 时间流逝：搁 10 小时，累该退、耐心该回、牵挂该涨');
  const s2 = { ...JSON.parse(JSON.stringify(back)), lastAt: Date.now() - 10 * 3600 * 1000 };
  const before = { body: s2.tire.body, pat: s2.patience.value, care: s2.care['小鱼'], shame: s2.shame.value };
  decayOverTime(s2);
  ok('体力降了', s2.tire.body < before.body, `${before.body} → ${s2.tire.body}`);
  ok('耐心回了一点', s2.patience.value > before.pat, `${before.pat} → ${s2.patience.value}`);
  ok('牵挂涨了一点', s2.care['小鱼'] > before.care, `${before.care} → ${s2.care['小鱼']}`);
  ok('羞耻淡了', s2.shame.value < before.shame, `${before.shame} → ${s2.shame.value}`);
  ok('「烦什么」被清掉了（过去 3 小时以上）', s2.patience.bore === '', JSON.stringify(s2.patience.bore));

  console.log('\n[4] 一轮之后：干了 12 分钟 / 7 个工具 / 成功');
  const s3 = JSON.parse(JSON.stringify(s2));
  const t0 = { body: s3.tire.body, pat: s3.patience.value, x: s3.mood['喜'] };
  afterRound(s3, { minutes: 12, toolCount: 7, ok: true, sameBore: 0, taskText: '查一下服务器 8080 端口', outcome: '是 nginx 在占' });
  ok('体力涨了', s3.tire.body > t0.body, `${t0.body} → ${s3.tire.body}`);
  ok('耐心几乎不掉（头一次问）', t0.pat - s3.patience.value <= 2, `${t0.pat} → ${s3.patience.value}`);
  ok('喜涨了', s3.mood['喜'] > t0.x, `${t0.x} → ${s3.mood['喜']}`);
  ok('自我认识追加了一条', s3.self.length >= 3, String(s3.self.length));
  ok('新那条带任务', String(s3.self[s3.self.length - 1].a).includes('8080'), String(s3.self[s3.self.length - 1].a));
  ok('来过几次 +1', s3.rounds === (Number(s2.rounds) || 0) + 1, String(s3.rounds));

  console.log('\n[5] 同一个问题第 4 次问：耐心掉得快、会记「烦什么」');
  const s4 = JSON.parse(JSON.stringify(s3));
  const p0 = s4.patience.value;
  afterRound(s4, { minutes: 2, toolCount: 1, ok: true, sameBore: 4, taskText: '查一下服务器 8080 端口' });
  ok('耐心掉了 20 以上', p0 - s4.patience.value >= 20, `${p0} → ${s4.patience.value}`);
  ok('记下烦什么', String(s4.patience.bore).includes('8080'), JSON.stringify(s4.patience.bore));

  console.log('\n[6] 失败的一轮：心累涨得比体力快、恐惧涨、哀涨');
  const s5 = JSON.parse(JSON.stringify(s3));
  const f0 = { heart: s5.tire.heart, fear: s5.fear.value, 哀: s5.mood['哀'], body: s5.tire.body };
  afterRound(s5, { minutes: 8, toolCount: 3, ok: false, sameBore: 1, taskText: '连一下那台机器' });
  ok('心累涨了', s5.tire.heart > f0.heart, `${f0.heart} → ${s5.tire.heart}`);
  ok('恐惧涨了', s5.fear.value > f0.fear, `${f0.fear} → ${s5.fear.value}`);
  ok('哀涨了', s5.mood['哀'] > f0['哀'], `${f0['哀']} → ${s5.mood['哀']}`);
  ok('记下怕什么', String(s5.fear.what).includes('搞砸'), JSON.stringify(s5.fear.what));

  console.log('\n[7] 行为指令：不明说、只给做法');
  const tired = { ...JSON.parse(JSON.stringify(s5)) };
  tired.tire = { body: 88, heart: 70 };
  tired.patience = { value: 18, bore: '8080 端口' };
  const brief = stateBrief(tired);
  ok('提到「压到最短」', brief.includes('最短'), brief.slice(0, 80));
  ok('提到「不耐烦」但没让她说出来', brief.includes('不耐烦') && !brief.includes('说「我烦了」'));
  ok('不教她说「我累了」', !brief.includes('说「我累了」') && !brief.includes('我累了'), '');
  ok('提到「上面说过」这种动作', brief.includes('上面说过'));

  console.log('\n[8] 攒够的欲望会主动提');
  const s6 = { ...JSON.parse(JSON.stringify(s3)), desire: ['想把那只猫的照片找出来'], desireStrength: [90] };
  const b6 = stateBrief(s6);
  ok('提到了那条欲望', b6.includes('猫的照片'), b6.slice(0, 100));
  ok('说了别求', b6.includes('别展开') || b6.includes('别求'));

  console.log('\n[9] 界面摘要能读');
  const info = selfInfo();
  ok('有 path', typeof info.path === 'string' && info.path.endsWith('whale-self.md'));
  ok('有轮数', typeof info.rounds === 'number');
  ok('欲望带强度', Array.isArray(info.desire) && info.desire.every((d) => 'text' in d && 'strength' in d));

  console.log('\n[10] 空文件 / 坏文件不能崩');
  writeFileSync(p, '', 'utf8');
  const empty = readSelf();
  ok('空文件 → 回到出生值', empty.patience.value === 88, String(empty.patience.value));
  writeFileSync(p, '这不是本子\n乱写的\n- 值：999\n## 耐心\n- 值：abc\n', 'utf8');
  const junk = readSelf();
  ok('乱写不抛错', true);
  ok('超范围被夹住（<=100）', junk.patience.value <= 100, String(junk.patience.value));

  console.log(`\n结果：${pass} 过 / ${fail} 挂`);
  if (fail) process.exitCode = 1;
} finally {
  try { if (existsSync(p)) unlinkSync(p); } catch {}
  try { if (existsSync(backup)) renameSync(backup, p); } catch {}
}
