/**
 * 严检：会话状态淘汰不能误删「还挂在报警线上」的会话
 */
const fs = await import('node:fs');
const p = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\agent.mjs';
const src = fs.readFileSync(p, 'utf8');

let pass = 0, total = 0;
function chk(label, cond) {
  total++;
  if (cond) { pass++; console.log('  [ok] ' + label); }
  else console.log('  [FAIL] ' + label);
}

console.log('=== 代码特征 ===');
chk('按最近使用淘汰（有 seen）', /rec\.seen = Date\.now\(\)/.test(src));
chk('淘汰时跳过报警线上的会话', /if \(r\.at > 0 && r\.tier > 0\) continue;/.test(src));
chk('极端情况仍有上限兜底', /全是高压会话/.test(src) || /sz < MID_WARN_MAX_SESSIONS/.test(src) || /_midWarnState\.size < MID_WARN_MAX_SESSIONS/.test(src));
chk('没有「从头删一半」的老逻辑', !/Math\.floor\(MID_WARN_MAX_SESSIONS \/ 2\)/.test(src));

console.log('\n=== 真跑淘汰逻辑 ===');
// 把源码那段函数抠出来原样跑
const start = src.indexOf('const _midWarnState = new Map();');
const end = src.indexOf('\n}', src.indexOf('function _midWarnStateOf')) + 2;
const code = src.slice(start, end);
const fn = new Function(code + '\nreturn { _midWarnStateOf, _midWarnState, MID_WARN_MAX_SESSIONS };');
const { _midWarnStateOf, _midWarnState, MID_WARN_MAX_SESSIONS } = fn();

// 造一个「高压、正在等提醒」的会话
const hot = _midWarnStateOf('hot-session');
hot.tier = 5; hot.at = 900000;

// 塞满一堆普通会话
for (let i = 0; i < MID_WARN_MAX_SESSIONS + 50; i++) {
  const r = _midWarnStateOf('sess-' + i);
  r.seen = Date.now() - (MID_WARN_MAX_SESSIONS - i) * 1000;
}

const hotStill = _midWarnState.get('hot-session');
chk('高压会话在淘汰潮里被保住了', !!hotStill && hotStill.tier === 5);
chk('总条数没超上限太多', _midWarnState.size <= MID_WARN_MAX_SESSIONS + 60);
chk('最老的普通会话被淘汰了', !_midWarnState.has('sess-0'));
chk('还能继续建新会话', !!_midWarnStateOf('brand-new'));

console.log('\n────────────');
console.log(`断言：${pass}/${total}`);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
