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

/* 【2026-11-15 加·「柜子亮着金色【正在跑】时插话不立刻显示」】
 * 服务端把插话推进直播清单了，可屏幕只由 SSE 事件触发重画 ——
 * 工具跑着的十几分钟里一个事件都没有，插话只能等工具结束那条 tool_end 才冒出来。 */
t.ok('插话收下后主动拉一次快照（不等下一个事件才显示）',
  /r\.steered === true[\s\S]{0,900}nudgeLive\(sessionId\)/.test(ui));

/* 【2026-11-16 加·「正在发消息闪一下就消失」+「排队还写正在发送」】
 *
 * 两个都是同一行提示被抢着写：
 *   ① showSending 顺手把 _turnT0 填上 → syncSendBtn 当成「刚跑完」→ 闪「已完成」再灭灯；
 *   ② 秒表 tick / 3 秒巡检每拍写死「正在发送消息」，把排队文案顶掉。
 *
 * 现在 ① 靠「刚点过发送的 8 秒内不闪完成」挡住，② 靠唯一出口 _liveHintText() 统一。 */
/* 【2026-11-16 改判据】主人第二次报闪之后，产品把「已完成」闪屏整个关掉了：
 * syncSendBtn 里那一段只剩 `_turnT0 = 0`，不再调 _flashDone()。
 * 老判据要求有 8000ms 的闸门才通过 —— 产品已改成「干脆不闪」，比闸门更彻底。
 * 判据跟着放宽：要么有 8 秒闸门（老写法），要么那一段里压根不调 _flashDone（新写法）。 */
t.ok('刚点过发送的 8 秒内不闪「已完成」（不然正在发送只闪一帧）',
  /wasBusy && !busy && _turnT0 > 0 && \(Date\.now\(\) - _sendFeedbackAt\) > 8000/.test(ui)
  || /if \(wasBusy && !busy && _turnT0 > 0\) \{\s*_turnT0 = 0;\s*\}/.test(ui));
t.ok('提示文案只有一个出口 _liveHintText()',
  /function _liveHintText\(\)/.test(ui));
t.ok('排队时不写「正在发送消息」（那句话其实还没发出去）',
  /_queueHintUntil[\s\S]{0,200}已排队/.test(ui));
t.ok('秒表 tick 与 3 秒巡检都走同一个出口（不许再写死）',
  (ui.match(/_hintSetText\(_liveHintText\(\)\)/g) || []).length >= 2);

t.done();
