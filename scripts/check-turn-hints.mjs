/**
 * check-turn-hints.mjs — 守「两条自动提示」。
 *
 * 主人 2026-11-16 连下两条，要求同一句提示出现在两个时刻：
 *   ① 他每发一句话（主消息，非插话）→ 「如果当前不是闲聊，那么请先整理清单，然后根据清单上未完成的内容决定是否调用子Agent」
 *   ② 重启续上的那一轮 → 同一句
 *
 * 为什么两句都要：她容易盯着「断在半句话」就闷头重做，或者一个人干完本该分出去的活。
 *
 * 两条的落点必须分清：
 *   · ① 只拼在**发给模型的拷贝**（wireMessages）上 —— 不进 history、不落盘、界面不画，
 *        否则每一轮都留一条，上下文越滚越大；
 *   · ② 走续跑轮的引子（context: true），收尾时摘掉。
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

const HINT = '如果当前不是闲聊，那么请先整理清单，然后根据清单上未完成的内容决定是否调用子Agent';

/* ── ① 每轮主消息 ─────────────────────────────────────── */
const atChat = src.indexOf("url.pathname === '/api/chat'");
ok('找到 /api/chat 主路', atChat > 0);
const chatTail = atChat < 0 ? '' : src.slice(atChat, atChat + 180000);

ok('主路拼了那句提示', chatTail.includes(HINT), '提示词不在 /api/chat 这条路上');
ok('那句提示的标记是【每轮开始·第一条】', chatTail.includes('【每轮开始·第一条】'));
ok('拼在 wireMessages 上（只给模型看，不进历史）',
  /* 【2026-11-16 二次放宽】这条提示的正文又长了（加了「先判断闲聊/工作」那一句
   * 和会话名拼接），200 字的窗口又不够。判据的本意没变：**这一个对象**必须走
   * wireMessages.concat、并且带 context:true —— 窗口只是「同一对象内」的距离。 */
  /wireMessages\s*=\s*wireMessages\.concat\(\[\{[\s\S]{0,400}?context:\s*true[\s\S]{0,60}?\}\]\)/.test(chatTail),
  '没有走 wireMessages.concat 就可能是 push 进 history —— 那会越堆越多');
/* 【2026-11-16 判据过时修正】产品现在在这条提示里带了「当前会话名」，
 * content 不再是单一字符串字面量，而是 '【每轮开始·第一条】当前会话名：「' + _nameNow + ...
 * 的拼接式 —— 老判据 [^']* 撞到第一个拼接点就断，永远匹配不上。
 * 改成：从「每轮开始·第一条」起 600 字内找到 context: true 即可（产品没变，判据放宽）。 */
ok('这条提示带 context: true（界面不画、不进 turns、不参与压缩）',
  /content:\s*'【每轮开始·第一条】[\s\S]{0,600}?context:\s*true/.test(chatTail));

/* ── ② 重启续上 ───────────────────────────────────────── */
const atResume = src.indexOf('async function resumeInterruptedTurn');
ok('找到续跑轮', atResume > 0);
const resumeBody = (() => {
  if (atResume < 0) return '';
  const open = src.indexOf('{', atResume);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(open, i + 1); }
  }
  return '';
})();
ok('续跑引子里有那句提示', resumeBody.includes(HINT), '重启续上时没提醒她整理清单');
ok('续跑那条也是【重启续上·第一条】+ context',
  resumeBody.includes('【重启续上·第一条】') && /context:\s*true/.test(resumeBody));

/* ── ③ 插话不该被塞这句 ───────────────────────────────── */
const atInterject = src.indexOf("url.pathname === '/api/interject'");
if (atInterject > 0) {
  const seg = src.slice(atInterject, atInterject + 6000);
  ok('插话那条路不塞这句（主人说「非插话消息」才算）', !seg.includes('【每轮开始·第一条】'));
} else {
  ok('插话那条路不塞这句（主人说「非插话消息」才算）', false, '找不到 /api/interject');
}

/* ── ④ 【2026-11-16 主人钦点】先判断闲聊还是在工作 ──────────
 * 主人原话：「在我发消息（非插话消息）与重启续上时，会出现的系统提示里加一条：
 *   【判断当前是在闲聊还是在工作，然后再按底线的【闲聊时】与【工作时】要求做】」
 * 底线把两种口径并排放着，却没人叫她**先挑一个** —— 于是闲聊里带汇报腔、干活时飘人设旁白。
 * 两处都得在场；插话那条路依旧不许塞。 */
ok('「先判断闲聊/工作」写成了一个共用常量（两处引用同一份，不会走样）', src.includes('const TURN_MODE_HINT'));
ok('主消息那条带上了判断句', chatTail.includes('TURN_MODE_HINT'), '每轮开始那条没带');
ok('重启续上那条也带上了判断句', resumeBody.includes('TURN_MODE_HINT'), '续跑引子没带');
ok('判断句的原文没被改写',
  src.includes('【判断当前是在闲聊还是在工作，然后再按底线的【闲聊时】与【工作时】要求做】'));

/* ── ⑤ 【2026-11-16 主人拍板】跨轮只带「上一段想清楚的」那一句 ──────
 * 主人原话：「思考的压缩总结一行 system role 的输入拼接的上下文 message list 可以这样吗？」
 * 定下来的口径：总结**不当 system**（规矩的位置不能被资料占），
 * 走 context 通道；每轮整条替换、≤200 字；原文留在历史里给自己看。 */
{
  const memSrc = readFileSync(new URL('../src/session-memory.mjs', import.meta.url), 'utf8');
  ok('思考摘要有专门的落点（本子里的「## 上一段想过什么」小节）',
    memSrc.includes("const THINK_HEAD = '## 上一段想过什么'"));
  ok('摘出来的一行封顶 200 字', /TURN_THINK_MAX\s*=\s*200/.test(memSrc));
  ok('是整条替换而不是追加（不会一轮一条越积越多）',
    /export function saveTurnThink/.test(memSrc) && /lines\.splice\(at, end - at/.test(memSrc));
  ok('每轮收尾会写这一行（digTurnThink → saveTurnThink）',
    /saveTurnThink\(sessionId, _line\)/.test(src));
  ok('每轮开始那条把上一段的结论拼回去', src.includes('lastTurnThink(sessionId)') && /上一段我想清楚的/.test(src));
  ok('重启续上那条也拼', (resumeBody.match(/lastTurnThink\(sessionId\)/g) || []).length >= 1);
  ok('没有把它塞成 system 消息（只能走 context）',
    !/role:\s*'system'[\s\S]{0,80}上一段我想清楚的/.test(src));
}

/* ── ⑥ 【2026-11-16 晚】重启叫醒在没断点账时要看清单，别空转 ────── */
{
  const at = src.indexOf('after-restart-plan-pickup');
  ok('重启叫醒有「没断点 → 读清单」的兜底', at > 0 && /if \(!_hasBreakpoint\)/.test(src));
  ok('兜底用的是实时清单 liveOpenSteps(_sid)',
    /if \(!_hasBreakpoint\)[\s\S]{0,500}?liveOpenSteps\(_sid\)/.test(src));
  ok('把没打勾的步骤抄进叫醒语，并叫她接着干',
    /清单还有 .+ 步没打勾/.test(src) && /不用等我再问/.test(src));
}

/* ── ⑦ 【2026-11-16 晚】「工具跑完没接话」的自动续工要挂在所有轮次入口 ── */
{
  ok('自动续工是公用函数（不是一个入口的补丁）',
    /function maybeAutoContinueAfterSilentTurn\(sessionId, ac, finalText\)/.test(src));
  const calls = (src.match(/maybeAutoContinueAfterSilentTurn\(sessionId, ac/g) || []).length;
  ok('主路 / 叫醒接续 / 续跑 / 递话四个入口都挂上了', calls >= 5, '实际 ' + calls + ' 处（含定义）');
  ok('主人亲自说话会清零自动续工计数', /autoContinueBook\.delete\(sessionId\)/.test(src));
  ok('不会撞上限就无声停死：升级措辞 + 可见喊人 + 定时重给机会',
    /轮只跑工具、没有一句话/.test(src) && /_n >= 6/.test(src) && /_autoContinueHandoff/.test(src)
    && /_rec\.n = 0/.test(src));
}

/* ── ⑧ 【2026-11-16 晚】压缩工作单用完要摘，别让她一直念叨 ────── */
{
  const agentSrc = readFileSync(new URL('../src/agent.mjs', import.meta.url), 'utf8');
  ok('有「摘掉旧压缩工作单」的动作', /const dropCompressOrders = \(\) =>/.test(agentSrc));
  ok('压完之后立刻摘', /compressed\.compressed\)[\s\S]{0,200}?dropCompressOrders\(\)/.test(agentSrc));
  ok('不再该压时也把残留工作单摘掉', /!_gate\.shouldFold\)\s*\{[\s\S]{0,200}?dropCompressOrders\(\)/.test(agentSrc));
}

console.log('\n自动提示：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
