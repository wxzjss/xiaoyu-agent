// check-no-autoresume：守的是「主人亲手退出，不许自己爬起来」。
//
// 【2026-11-07 改写·原来这条守错了对象】
//
// 它 2026-11-02 立的时候，断言是「启动时不许 setTimeout 调 resumeInterruptedTurn」。
// 可主人 2026-11-05 明确要求过「重启完自己接着做，别等我发一句」，
// 2026-11-07 又当面确认「**我要的就是自动续跑**」，还报了两个 bug
// （有时只重启不续、多个会话只续一个）。
//
// 也就是说：这条断言守的那件事，早就被主人自己推翻了。
// 之所以一直显示「通过」，是因为旧正则只往后看 200 个字符，
// 而那段代码中间隔着一大截，压根没匹配上 —— 属于**假通过**。
//
// 主人 11-02 真正不满的是什么？看 server.mjs 里那段注释就清楚：
//   「只要 resume.json 里还压着旧账，哪怕是他自己点了退出，程序也会偷偷 relaunch」
// —— 他烦的是**手动退出后自己爬起来**，不是「重启后续跑」。
//
// 所以这条检查改成守那件真事，另外把自动续跑该有的闸也一起守住：
//   ① 手动退出不许偷偷 relaunch（__xyRelaunchOnQuit 只能是注释，不能是代码）
//   ② 自动续跑必须受「自动重启续上」开关管（关掉就是干净冷启动）
//   ③ 手动接口和函数本体都得留着
//   ④ 多会话续跑：开机要遍历所有待续，不是只挑一个
import fs from 'node:fs';

const FILES = [
  'D:/小鱼Agent/src/server.mjs',
  'C:/Users/35453/AppData/Roaming/小鱼Agent/data/code/src/server.mjs',
];

let bad = 0;
const ok = (m) => console.log('OK   ' + m);
const no = (m) => { console.log('FAIL ' + m); bad++; };

for (const p of FILES) {
  if (!fs.existsSync(p)) { console.log('跳过（不存在）' + p); continue; }
  const s = fs.readFileSync(p, 'utf8');
  console.log('── ' + p);

  /* ① 只允许出现在注释里。判断法：找到它，看那一行是不是以 * 或 // 开头 */
  const lines = s.split('\n');
  const codeHits = lines.filter((l) => {
    const t = l.trim();
    if (!t.includes('__xyRelaunchOnQuit')) return false;
    return !(t.startsWith('*') || t.startsWith('//') || t.startsWith('/*'));
  });
  if (codeHits.length) no('手动退出还会偷偷 relaunch（__xyRelaunchOnQuit 出现在代码里）');
  else ok('手动退出不偷偷 relaunch');

  /* ② 自动续跑必须在 selfRestart 开关之后 */
  const gateIdx = s.indexOf("id === 'selfRestart'");
  const autoIdx = s.indexOf('listInterrupted()');
  if (gateIdx < 0) no('找不到 selfRestart 开关（自动续跑会关不掉）');
  else if (autoIdx >= 0 && autoIdx < gateIdx) no('自动续跑跑在开关前面了（关不掉）');
  else ok('自动续跑受 selfRestart 开关管');

  /* ③ 手动接口 + 函数本体 */
  if (!s.includes('async function resumeInterruptedTurn')) no('resumeInterruptedTurn 函数被误删');
  else ok('resumeInterruptedTurn 函数还在');
  if (!s.includes("'/api/resume'")) no('/api/resume 手动接口被误删');
  else ok('/api/resume 手动接口还在');

  /* ④ 多会话 + 只续该续的（2026-11-07 改口径）
   *   原来断言「开机遍历 listInterrupted()」；
   *   现在多了 autoResume 过滤 —— 只有「真被打断」的才自动续，
   *   清单老账不自动续（实测一次能记出 8 条，全续会把端点打爆）。 */
  if (!s.includes('const pendingAll = listInterrupted()')) no('开机没读待续列表（应该 listInterrupted）');
  else if (!/pendingAll\.filter\(\(x\) => x && x\.autoResume === true\)/.test(s)) no('没有按 autoResume 过滤（清单老账会被一起续）');
  else ok('开机只自动续「真被打断」的会话');
}
console.log(bad === 0 ? '\n全部通过' : '\n有 ' + bad + ' 项失败');
process.exit(bad === 0 ? 0 : 1);
