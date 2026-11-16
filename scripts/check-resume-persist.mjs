/**
 * check-resume-persist.mjs — 守「续跑轮也实时落盘」+「重启前先落盘」。
 *
 * 【为什么要有这条】
 * 2026-11-15 深夜，检查鱼会话 23:14→23:39（二十多分钟、一堆工具）整段没了。
 * 它自己的结论是「压根没落盘」，查下来两处都对：
 *
 *   ① **续跑轮的 onEvent 只有 `send(ev)`** —— 推给 live 就完事。
 *      主轮（/api/chat）那条路有两个落盘点：正文进草稿、每个 tool_end 把
 *      工具组接进正式历史并 saveSession；续跑轮一个都没有，整轮只在收尾存一次。
 *      这一轮再被重启掐断（23:38 又重启了一回），整段一个字不剩。
 *
 *   ② **重启路由（/api/app/restart）不先落盘** —— 只写续跑账就杀进程。
 *      草稿是节流写的（1.5 秒 / 40 字），最后那一小段本来就在内存里；
 *      会话本体也可能刚改过还没写。崩溃兜底退出（crash-guard 的 onFatal）会补草稿，
 *      正常重启这条路一条都不补。
 *
 * 这两条都是「静默丢数据」，光靠注释拦不住，钉死。
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/** 按名字抓函数体（大括号配平） */
function bodyOf(name) {
  const pats = [
    new RegExp('async\\s+function\\s+' + name + '\\s*\\('),
    new RegExp('function\\s+' + name + '\\s*\\('),
    new RegExp('(?:const|let|var)\\s+' + name + '\\s*=\\s*(?:async\\s*)?\\('),
  ];
  let at = -1;
  for (const p of pats) { const m = p.exec(src); if (m) { at = m.index; break; } }
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(open, i + 1); }
  }
  return '';
}

const resume = bodyOf('resumeInterruptedTurn');
ok('resumeInterruptedTurn 抓到了', resume.length > 500);

/* ── ① 续跑轮：正文进草稿 ───────────────────────────────── */
ok('续跑轮：正文增量写草稿（saveDraft）',
  /saveDraft\s*\(\s*sessionId\s*,/.test(resume),
  '续跑轮没写草稿 = 正文只在收尾落一次，被打断就全丢');
ok('续跑轮：草稿用节流器（makeDraftThrottle）',
  /makeDraftThrottle\s*\(\s*\)/.test(resume));
ok('续跑轮：notice 不进草稿（不然刷新后气泡里混进「连接断了」）',
  /ev\.notice/.test(resume));

/* ── ② 续跑轮：每个工具结束就提交+写盘 ─────────────────── */
ok('续跑轮：tool_end 时把齐了的工具组接进历史并写盘',
  /if\s*\(\s*ev\.type\s*===\s*'tool_end'\s*\)\s*_commitResumeToolsNow\s*\(\s*\)/.test(resume),
  '没有这一步 = 跑了几十分钟的工具，重启后一张卡都不剩');
ok('续跑轮：那个提交函数里真的 saveSession 了',
  /_commitResumeToolsNow[\s\S]{0,2200}?saveSession\s*\(\s*session\s*\)/.test(resume));
ok('续跑轮：onEvent 不再是裸 send（要带落盘）',
  !/onEvent:\s*\(ev\)\s*=>\s*\{\s*try\s*\{\s*send\(ev\);\s*\}\s*catch\s*\{\}\s*\}/.test(resume),
  'onEvent 又变回「只推 live 不落盘」了');

/* ── ③ 续跑轮收尾：把草稿作废 ───────────────────────────── */
ok('续跑轮收尾 dropDraft（不然草稿会当成「半截话」重复补一条）',
  /dropDraft\s*\(\s*sessionId\s*\)/.test(resume));

/* ── ④ 重启前先落盘 ─────────────────────────────────────── */
const at = src.indexOf("url.pathname === '/api/app/restart'");
ok('找到重启路由', at > 0);
const restart = (() => {
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  let d = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') d++;
    else if (src[i] === '}') { d--; if (d === 0) return src.slice(open, i + 1); }
  }
  return '';
})();
ok('重启路由：退出前遍历在跑的轮次补草稿',
  /for\s*\(\s*const\s*\[[\w$]+,\s*[\w$]+\]\s*of\s*runningTurns\s*\)/.test(restart)
  && /saveDraft\s*\(/.test(restart),
  '重启只写续跑账、不补草稿 → 节流窗口里最后那段话没了');
ok('重启路由：顺手把会话本体再存一次',
  /saveSession\s*\(\s*_?rs\s*\)/.test(restart) || /saveSession\s*\(/.test(restart));

/* ── ④.5 提交工具组后必须清草稿水位 ─────────────────────── */
/* 【2026-11-16 加·重启后「她一下子吐出一大堆话」（搭建鱼 07:49，一条 1534 字）】
 * 草稿 text 是整轮累计的；工具组提交进历史后如果不清，重启时
 * restoreDraftHalfTurn 会把十几分钟的零碎正文全拼成一条 _recovered 补进去。 */
{
  const mainCommit = src.slice(src.indexOf('const commitToolsNow = () => {'), src.indexOf('const commitToolsNow = () => {') + 4000);
  ok('主路：提交工具组后清掉草稿水位（draftText = 空）',
    /draftText = ''/.test(mainCommit),
    '不清的话，重启会把她整轮的零碎话拼成一条上千字的大消息');
  ok('续跑轮：提交后也清（_draft.text = 空）',
    /_draft\.text = ''/.test(resume),
    '只清主路不清续跑轮，等于只修一半');
}

/* ── ⑤ 落盘动作必须发生在「杀进程」之前 ─────────────────── */
{
  const saveAt = restart.indexOf('saveDraft(');
  const killAt = Math.min(
    ...['stopServer(', 'emitExit(', 'process.exit(', 'app.quit', 'destroy(']
      .map((k) => { const i = restart.indexOf(k); return i < 0 ? Number.MAX_SAFE_INTEGER : i; }),
  );
  ok('顺序：先落盘，再退出', saveAt > 0 && saveAt < killAt, 'saveAt=' + saveAt + ' killAt=' + killAt);
}

/* 【2026-11-16 加·断在半路的思考别丢】
 * 主人问「各种情况下重启后思考链内容是否会落盘」。跑完的那轮会在收尾把思考挂到
 * `_reasoning`；被重启掐断的那轮走 restoreDraftHalfTurn，草稿里存着 reasoning，
 * 但以前只接了正文、思考随草稿一起删 —— 界面上「想过」那块就没了。 */
{
  const fnAt = src.indexOf('function restoreDraftHalfTurn(');
  const fn = fnAt >= 0 ? src.slice(fnAt, fnAt + 9000) : '';
  ok('草稿回灌：把 reasoning 读出来（draft.reasoning）',
    /draft\.reasoning/.test(fn),
    '不读它就没得接，思考只能在草稿里等死');
  ok('草稿回灌：接回的消息带上 _reasoning',
    /_back\._reasoning = _draftReason/.test(fn),
    '正文接回来了、思考没接，等于只接半个人');
  ok('草稿回灌：正文已在历史里时，思考补到最后那条 assistant 上',
    /m\._reasoning = _draftReason/.test(fn),
    '这一支最容易漏：话已经提交了，只删草稿会把思考一起删掉');
}

console.log('\n续跑落盘：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
