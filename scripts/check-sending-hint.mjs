/**
 * 【2026-11-09 主人报】做任务做着做着，输入框左上角「正在发送消息」消失了，再也不回来。
 *
 * 现场取证（主人应用当时真在跑）：/api/running 报 running:true、
 * /api/chat/live 也报 running:true、544 个事件还在涨（text 81 + 工具 23 组 +
 * reasoning 611），**服务端一直认为在跑**，所以是前端把灯灭了没人点回来。
 *
 * 三条撞在一起：
 *  ① SSE 的 done 分支和 finally 都无条件 hideSending()；
 *  ② 服务端收尾用 setImmediate 接着跑队列里的下一轮（那轮不是前端发起的），
 *     前端这条流已经 done → 灯灭了，没人再 showSending；
 *  ③ 3 秒巡检只在「服务端在跑 且 busy=false」时纠正，而此时 busy 常还是 true，
 *     条件不成立 → 灯永久熄灭。
 *
 * 修法：流结束不立刻灭灯，延迟 900ms 问一次 /api/chat/live（唯一权威），
 * 还在跑就把灯和 busy 都保持住；巡检也不再只看 busy，灯本身灭了就纠正。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('正在发送消息：任务跑完前不许消失');
const ui = fs.readFileSync('public/index.html', 'utf8');

t.ok('有「延迟复核再决定灭灯」的函数', /function scheduleSendingRecheck\(sid\)/.test(ui));
t.ok('复核问的是服务端权威状态 /api/chat/live',
  /scheduleSendingRecheck[\s\S]{0,900}\/api\/chat\/live\?sessionId=/.test(ui));
t.ok('服务端还在跑 → 保持灯亮和 busy',
  /if \(still \|\| turnsInFlight\.has\(_sid\)\)[\s\S]{0,200}busy = true[\s\S]{0,200}showSending\(/.test(ui));
t.ok('切了会话就不动别人的灯',
  /String\(sessionId \|\| ''\) !== _sid\) return/.test(ui));
/* SSE 的四个收尾出口（done / finally / endTurnQuietly / 断线自愈失败）统一走延迟复核。
 * renderTurns、手动停止、切会话 仍会直接 hideSending —— 那是合理的，
 * 而且下面那条巡检兜底会在服务端说「还在跑」时把灯点回来，
 * 所以这里**不**要求「一处 hideSending 都不剩」，只钉 SSE 收尾。 */
t.ok('SSE 四个收尾出口全部改成延迟复核',
  (ui.match(/scheduleSendingRecheck\(sessionId\)/g) || []).length >= 4);
t.ok('3 秒巡检同时核对 busy 和灯本身',
  /if \(r && \(!busy \|\| !_hintOn\)\)/.test(ui)
  && /_hintOn[\s\S]{0,160}classList\.contains\('show'\)/.test(ui));
t.ok('真结束了仍然会灭灯（不会永远挂住）',
  /busy = false;\s*\n\s*hidingSendingSafe\(\);/.test(ui));

t.done();
