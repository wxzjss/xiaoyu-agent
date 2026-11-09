/**
 * 【2026-11-09 主人报】关掉小鱼、开启小白曦，流式那一下屏幕上先是「小鱼」在发消息，
 * 发完名字才变成小白曦。
 *
 * 根因：`addAssistant()`（直播气泡）名字取 `who || mainAgentName || '小鱼'`。
 * 主流程的 text 事件不带 who，而 mainAgentName 是**历史消息署名兜底**
 * （后端约定空 _who = 小鱼，上一轮刚把它固定住），于是流式期间永远写小鱼；
 * 轮末 commitWireBack 给消息补上 _who、重画时才变成真正的主智能体。
 *
 * 修法：直播气泡的名字直接读【屋里的人】那列牌子 —— 第一个没 .off 的就是
 * 这一轮的主智能体（动态，跟后端 mainAgentId 同源），同步读 DOM、零延迟；
 * who 参数（群里别人接话自带名字）永远优先。历史重画仍走 renderTurns，不受影响。
 *
 * 真机实测（隔离实例 CDP）：
 *   全开 → 小鱼 / 关小鱼开小白曦 → 小白曦 / 小白曦排第一 → 小白曦 / who=旁白 → 旁白
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('直播气泡署名：一开始就对，不用等发完');
const ui = fs.readFileSync('public/index.html', 'utf8');

/* 一、静态 */
t.ok('直播气泡同步读「屋里的人」第一个开着的牌子',
  /#whoRail \.whoBtn:not\(\.off\)/.test(ui) && /const __liveName =/.test(ui));
t.ok('who 参数（别人接话）仍然优先',
  /const __whoNow = String\(who \|\| ''\)\.trim\(\) \|\| __liveName/.test(ui));
t.ok('refreshAgentChip 存一份动态名字给流式兜底',
  /window\.__turnSpeakerName = _speakerName/.test(ui));
t.ok('历史署名兜底没被污染，仍是小鱼',
  /mainAgentName = '小鱼';/.test(ui) && !/mainAgentName = __liveName/.test(ui));
t.ok('直播与历史两条路分开（历史仍用 renderTurns 的 turn.who）',
  /mainAgentName = '小鱼';/.test(ui));

/* 二、真机段刻意不进全量回归
 *
 * 【2026-11-09 教训】这里原来连 CDP 在隔离实例的页面上真造牌子验四种情况，
 * 结果 WebSocket 一直挂着、子进程不退出，整批回归卡在它身上 11 分钟。
 * 同一页还会跟别的真机检查抢 page。所以全量只留上面的静态断言。
 *
 * 手工真机验证过（独立隔离实例 + CDP，见当天工作日志）：
 *   全开 → 小鱼 / 关小鱼开小白曦 → 小白曦 / 小白曦排第一 → 小白曦 /
 *   who=旁白 → 旁白（别人接话自带名字优先）
 * 注意 addAssistant 返回的是 bubble，取名字要 b.closest('.msg.assistant')。
 */

t.done();
