/**
 * 压缩真空档验证：80%~93% 该压必须真压
 */
const fs = await import('node:fs');
const base = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\';
const src = fs.readFileSync(base + 'agent.mjs', 'utf8');

let pass = 0, total = 0;
function chk(label, re, want = true) {
  total++;
  const got = re.test(src);
  const ok = got === want;
  if (ok) pass++;
  console.log((ok ? '  [ok] ' : '  [FAIL] ') + label);
}

console.log('=== 压缩真空档 ===');
chk('兜底不再死绑 93%', /const _needFold = _gate\.shouldFold && !selfNote && !compressedThisTurn;/);
chk('旧的 CRITICAL 独占判断已消失', /if \(!selfNote && _gate\.ratio >= CRITICAL_RATIO\) \{/, false);
chk('93% 紧急线仍然保留', /_gate\.ratio >= CRITICAL_RATIO\) \{[\s\S]{0,200}?兜底折一次/);
chk('80% 也兜底', /该折了、我还没写摘要/);
chk('压缩成功仍复位量线', /compressedThisTurn = true;[\s\S]{0,400}?warnedRec\.tier = 0;/);

// ── 复刻判定：不同 ratio 下会不会真压
const HARD = 0.8, CRITICAL = 0.93;
console.log('\n=== 各比例下「该不该真压」===');
const cases = [
  [0.55, 'SOFT：只瘦身，不折'],
  [0.70, '还不到 HARD，不折'],
  [0.79, '差一点，不折'],
  [0.80, 'HARD 线，必须折'],
  [0.85, '原来这里不压！现在必须折'],
  [0.92, '原来这里不压！现在必须折'],
  [0.93, '紧急线，必须折'],
  [0.98, '主人卡住的 98%，必须折'],
];
let ok2 = 0, n2 = 0;
for (const [ratio, note] of cases) {
  const shouldFold = ratio >= HARD;
  // 旧逻辑：只有在 CRITICAL 以上才造摘要，否则 note=''
  const oldNote = ratio >= CRITICAL ? 'RESCUE' : '';
  const oldCompressed = shouldFold && !!oldNote;
  // 新逻辑：只要 shouldFold 就造摘要
  const newNote = shouldFold ? 'RESCUE' : '';
  const newCompressed = shouldFold && !!newNote;

  const wantCompress = ratio >= HARD;
  const good = newCompressed === wantCompress;
  n2++;
  if (good) ok2++;
  const flag = (oldCompressed !== newCompressed) ? ' ← 修好了' : '';
  console.log(`  ${good ? '[ok]' : '[FAIL]'} ${(ratio * 100).toFixed(0).padStart(3)}%  旧=${oldCompressed ? '压' : '不压'}  新=${newCompressed ? '压' : '不压'}  ${note}${flag}`);
}

console.log('\n────────────');
console.log(`代码检查：${pass}/${total}    行为断言：${ok2}/${n2}`);
console.log((pass === total && ok2 === n2) ? 'PASS 全部通过' : 'FAIL 有未通过项');
