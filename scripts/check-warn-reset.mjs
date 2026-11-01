/**
 * 量线提醒最终验证（第三轮）
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

console.log('=== 1. 代码特征 ===');
chk('外层不再被 midWarned 挡住', /if \(win > 0\) \{/);
chk('旧的外层闸已消失', /if \(win > 0 && midWarned < MID_TIERS\.length\)/, false);
chk('跨轮状态按 sessionId 记（不能用 WeakMap 挂数组，数组每轮都新建）', /const _midWarnState = new Map\(\)/);
chk('状态取值走 sessionId', /const warnedRec = _midWarnStateOf\(sessionId\);/);
chk('会话桶有上限、不会无限涨', /MID_WARN_MAX_SESSIONS/);
chk('最高档持续提醒', /const isTop = ti === MID_TIERS\.length - 1;/);
chk('复位常量', /const MID_WARN_RESET_DROP = 0\.\d+;/);
chk('跨档不受水位闸卡', /const firstTimeThisTier = midWarned < ti \+ 1;/);
chk('压缩成功处复位', /compressedThisTurn = true;[\s\S]{0,400}?warnedRec\.tier = 0;/);
chk('压缩条 tool_end 收尾', /tool_end[\s\S]{0,120}?name: 'compress'/);
chk('系统插入标记', /SYS_MID_NOTE/);

// ── 复刻最终判定
const WIN = 1000000;
const RATIOS = [0.30, 0.40, 0.50, 0.60, 0.70];
const RESET = 0.85;
const TOP = RATIOS.length - 1;

function mk() { return { tier: 0, at: 0 }; }
function step(st, tokens) {
  const prevAt = st.at;
  if (prevAt > 0 && tokens < prevAt * RESET) { st.tier = 0; st.at = 0; }
  for (let ti = RATIOS.length - 1; ti >= 0; ti--) {
    const lineAt = Math.floor(WIN * RATIOS[ti]);
    if (tokens < lineAt) continue;
    const isTop = ti === TOP;
    const firstTime = st.tier < ti + 1;
    if (!firstTime && !isTop) continue;
    if (!firstTime) {
      const gap = Math.floor(WIN * 0.05);
      if (st.at > 0 && tokens < st.at + gap) continue;
    }
    st.tier = ti + 1;
    st.at = tokens;
    return ti + 1;
  }
  return null;
}

function run(name, seq, expect) {
  console.log(`\n=== ${name} ===`);
  const st = mk();
  let ok = 0, n = 0;
  for (let i = 0; i < seq.length; i++) {
    const [tok, note] = seq[i];
    const got = step(st, tok);
    const want = expect[i];
    n++;
    const good = got === want;
    if (good) ok++;
    console.log(`  ${good ? '[ok]' : '[FAIL]'} ${String(tok).padStart(7)} → ${got === null ? '不响' : '第' + got + '档'}`
      + ` (期望 ${want === null ? '不响' : '第' + want + '档'})  ${note}`);
  }
  return { ok, n };
}

const a = run('A. 压到75万没压下去 → 涨到99万必须一直喊', [
  [750000, '75%，响70%'],
  [760000, '没涨够5%，不响'],
  [800000, '80%，再喊'],
  [840000, '没涨够，不响'],
  [860000, '86%，再喊'],
  [920000, '92%，再喊'],
  [990000, '99%，再喊'],
], [5, null, 5, null, 5, 5, 5]);

const b = run('B. 压缩生效 → 复位 → 从低档重新提醒', [
  [750000, '冲高，响70%'],
  [86000, '压到8.6万，复位'],
  [200000, '20万，不够30%'],
  [320000, '32万，响30%'],
  [430000, '43万，响40%（这次不该被卡）'],
  [540000, '54万，响50%'],
  [650000, '65万，响60%'],
], [5, null, null, 1, 2, 3, 4]);

const c = run('C. 高档响过、回落再涨，低档照样补上', [
  [750000, '75%，响70%'],
  [100000, '压到10万，复位'],
  [350000, '35万，响30%'],
  [480000, '48万，响40%'],
], [5, null, 1, 2]);

const d = run('D. 同轮反复量不刷屏', [
  [750000, '响'],
  [750000, '不响'],
  [755000, '不响'],
  [799000, '不响'],
], [5, null, null, null]);

const behOk = a.ok + b.ok + c.ok + d.ok;
const behN = a.n + b.n + c.n + d.n;

console.log('\n────────────');
console.log(`代码检查：${pass}/${total}    行为断言：${behOk}/${behN}`);
console.log((pass === total && behOk === behN) ? 'PASS 全部通过' : 'FAIL 有未通过项');
