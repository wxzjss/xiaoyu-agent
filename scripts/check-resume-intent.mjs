/**
 * check-resume-intent.mjs — 「重启/退出后要能续上」的三道口子站岗
 *
 * 【2026-11-12 接手「检查鱼」查到一半的活】主人报「重启后你没有续上」。
 * 它定位到一半被网关 502 打断，这里把三个真凶钉住：
 *
 *  ① /api/app/restart 记续跑意图时必须带 autoResume —— 开机自续只挑
 *     autoResume===true 的续，漏了就被当「清单老账」跳过（日志只会说
 *     「没有需要自动续的」），重启完一片安静。
 *  ② 崩溃兜底退出（同类错误反复出现）那一轮铁定在跑，必须 autoResume:true。
 *  ③ 叫醒路径消费完自己的断点只许删自己那条 —— dropInterrupted() 无参
 *     = 整个 resume.json 端掉，别的会话排队的续跑意图跟着陪葬。
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log('  [ok] ' + m + (d ? '  ' + d : '')); } else { fail++; console.log('  [!!] ' + m + (d ? '  ' + d : '')); } };

/* ── ① restart 路径的 markInterrupted 带 autoResume ── */
const ri = src.indexOf("'主人让它重启（重启前这一轮还没跑完）'");
ok('restart 路径在记续跑意图（锚点还在）', ri > 0);
if (ri > 0) {
  const seg = src.slice(ri, ri + 1200);
  ok('restart 记的意图带 autoResume（真在跑才自动续）',
    /autoResume:\s*Boolean\(_live\)/.test(seg));
}

/* ── ② 崩溃兜底的 markInterrupted 带 autoResume:true ── */
const ci = src.indexOf("'进程崩了（同类错误反复出现，兜底退出）'");
ok('崩溃兜底在记续跑意图（锚点还在）', ci > 0);
if (ci > 0) {
  const seg = src.slice(ci, ci + 400);
  ok('崩溃兜底的意图带 autoResume: true', /autoResume:\s*true/.test(seg));
}

/* ── ③ 叫醒路径只删自己那条 ── */
/* 无参 dropInterrupted() = 端掉整个 resume.json。全仓库只许剩一处：
 * DELETE /api/resume（主人手动说「别续了」，整份清掉是他自己的意思）。 */
const noArg = [];
{
  const re = /dropInterrupted\(\)/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    const ctx = src.slice(Math.max(0, m.index - 160), m.index);
    noArg.push({ line, manual: ctx.includes("method === 'DELETE'") });
  }
}
ok('无参 dropInterrupted() 只剩主人手动的 DELETE /api/resume 那一处',
  noArg.length === 1 && noArg[0].manual,
  noArg.map((x) => 'L' + x.line + (x.manual ? '（手动，允许）' : '（自动路径，违规）')).join(' '));
ok('叫醒路径改成 dropInterrupted(_sid)', /try \{ dropInterrupted\(_sid\); \} catch \{\}/.test(src));

/* ── ④ 退出路径：先拍快照再 abort（手动退出重启也要续） ── */
ok('退出收尾先拍「谁在跑」快照（_wasLiveAtQuit）', /_wasLiveAtQuit = new Set\(\)/.test(src)
  && /for \(const \[id, turn\] of runningTurns\) \{[\s\S]{0,200}ac\.abort\('quit'\)/.test(src)
  && src.indexOf('_wasLiveAtQuit = new Set()') < src.indexOf("ac.abort('quit')"),
  '快照必须建在第一个 abort 之前');
const qi = src.indexOf("'关窗口退出（这一轮还没跑完）'");
ok('退出记账的 autoResume 认快照（不认 abort 之后的 runningTurns）',
  qi > 0 && /_wasLiveAtQuit\.has\(String\(_qsid\)\)/.test(src.slice(Math.max(0, qi - 1200), qi + 400)));

console.log('\n── 续跑意图三道口子：' + pass + '/' + (pass + fail) + (fail ? ' 有失败' : ' 全过') + ' ──');
process.exit(fail ? 1 : 0);
