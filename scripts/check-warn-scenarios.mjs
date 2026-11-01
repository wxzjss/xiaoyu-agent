/**
 * 量线场景断言（从 agent.mjs 原样提取判定逻辑，不手抄）
 */
import fs from 'node:fs';

const p = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\agent.mjs';
const src = fs.readFileSync(p, 'utf8');
const lines = src.split(/\r?\n/);

const startIdx = lines.findIndex((l) => l.includes('const _prevAt = warnedRec.at;'));
const forIdx = lines.findIndex((l, i) => i > startIdx && l.includes('for (let ti = MID_TIERS.length - 1'));
let depth = 0, endIdx = -1, started = false;
for (let i = forIdx; i < lines.length; i++) {
  for (const ch of lines[i]) {
    if (ch === '{') { depth++; started = true; } else if (ch === '}') { depth--; }
  }
  if (started && depth === 0) { endIdx = i; break; }
}
const body = lines.slice(startIdx, endIdx + 1).join('\n');

const ts = lines.findIndex((l) => l.includes('const MID_TIERS = ['));
let te = ts, d = 0, st = false;
for (let i = ts; i < lines.length; i++) {
  for (const ch of lines[i]) { if (ch === '[') { d++; st = true; } else if (ch === ']') { d--; } }
  if (st && d === 0) { te = i; break; }
}
const MID_TIERS = new Function(lines.slice(ts, te + 1).join('\n') + '\nreturn MID_TIERS;')();
const RESET_DROP = Number((src.match(/const MID_WARN_RESET_DROP = ([\d.]+);/) || [])[1]);
const DELTA = Number((src.match(/const MID_REWARN_DELTA = ([\d.]+);/) || [])[1]);

const fnSrc = `
const SYS_MID_NOTE = 'X';
const MID_WARN_RESET_DROP = ${RESET_DROP};
const MID_REWARN_DELTA = ${DELTA};
function impl(win, midTokens, warnedRec, MID_TIERS, messages) {
  let midWarned = warnedRec.tier;
  const estimateTokens = () => midTokens;
  const contextWindowOf = () => win;
  ${body}
  return midWarned;
}
`;
const impl = new Function(fnSrc + '\nreturn impl;')();

const WIN = 1000000;

function sim(seq) {
  const rec = { tier: 0, at: 0 };
  const out = [];
  for (const t of seq) {
    const bAt = rec.at, bTier = rec.tier;
    impl(WIN, t, rec, MID_TIERS, []);
    const fired = rec.at === t && (rec.tier !== bTier || rec.at !== bAt);
    out.push({ t, fired, tier: rec.tier });
  }
  return out;
}

let pass = 0, total = 0;
function chk(label, cond) {
  total++;
  if (cond) { pass++; console.log('  [ok] ' + label); }
  else console.log('  [FAIL] ' + label);
}

console.log('=== 场景1 压缩只到 92 万（没压干净），继续涨 ===');
const s1 = sim([700000, 780000, 850000, 920000, 980000, 920000, 950000, 970000, 990000, 999000]);
s1.forEach(({ t, fired }) => console.log('  ' + String(t).padStart(7) + ' (' + Math.round(t / WIN * 100) + '%) -> ' + (fired ? '响' : '不响')));
chk('压完降到 92 万那一下不重复喊', !s1[5].fired);
chk('涨到 95 万必须再响（不许哑火）', s1[6].fired);
chk('涨到 99 万还在响', s1[8].fired);
chk('涨到 100 万还在响', s1[9].fired);

console.log('');
console.log('=== 场景2 真压到 8 万后重新涨 ===');
const s2 = sim([700000, 780000, 980000, 80000, 350000, 720000, 900000]);
s2.forEach(({ t, fired }) => console.log('  ' + String(t).padStart(7) + ' (' + Math.round(t / WIN * 100) + '%) -> ' + (fired ? '响' : '不响')));
chk('压到 8 万不响', !s2[3].fired);
chk('涨到 35 万响第一档（复位成功）', s2[4].fired);
chk('涨到 72 万响最高档', s2[5].fired);

console.log('');
console.log('=== 场景3 一直不压缩，逐档提醒 ===');
const s3 = sim([300000, 420000, 520000, 620000, 720000]);
s3.forEach(({ t, fired, tier }) => console.log('  ' + String(t).padStart(7) + ' (' + Math.round(t / WIN * 100) + '%) -> ' + (fired ? '响第' + tier + '档' : '不响')));
chk('30% 响', s3[0].fired);
chk('40% 响', s3[1].fired);
chk('50% 响', s3[2].fired);
chk('60% 响', s3[3].fired);
chk('70% 响', s3[4].fired);

console.log('');
console.log('=== 场景4 同一水位反复量（不许刷屏）===');
const s4 = sim([750000, 750000, 750000, 760000]);
s4.forEach(({ t, fired }) => console.log('  ' + String(t).padStart(7) + ' (' + Math.round(t / WIN * 100) + '%) -> ' + (fired ? '响' : '不响')));
chk('第一次响', s4[0].fired);
chk('同水位第二次不响', !s4[1].fired);
chk('同水位第三次不响', !s4[2].fired);
chk('只涨 1 万不响（不够 5%）', !s4[3].fired);

console.log('');
console.log('------------');
console.log('断言：' + pass + '/' + total);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
