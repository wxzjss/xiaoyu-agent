// 发送缓冲 —— 防回归站岗（主人钦定 2026-11-12）
//
// 主人原话：「在我发一句话后等几秒再让小鱼Agent发消息……每按一次键盘都重置一次
// 时间并延长一秒……时间内发送的话不算插话，等时间结束后，小鱼Agent能一次性看到
// 所有消息」「初始改为3秒，上限5秒」「把这个【发送缓冲】做成一个功能放在功能页，
// 可自行设置缓冲时间」「改回车是直接发送插话消息，只有点输入框右侧的【发送】
// 按钮才是预发送」。
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
};

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf-8');
const feats = readFileSync(new URL('../src/features.mjs', import.meta.url), 'utf-8');

/* ── ① 功能定义与数值设置 ─────────────────────────────── */
ok('FEATURES 里有「发送缓冲」卡（默认关）',
  /id:\s*'sendBuffer',\s*\n\s*name:\s*'发送缓冲'[\s\S]{0,400}defaultOn:\s*false/.test(feats));
ok('featureNumber / setFeatureNumber 两个读写都在',
  /export function featureNumber\(/.test(feats) && /export function setFeatureNumber\(/.test(feats));
ok('服务端 GET /api/features/numbers 默认 3 秒 / 5 秒',
  /featureNumber\('sendBufferSec',\s*3\)/.test(server) && /featureNumber\('sendBufferMaxSec',\s*5\)/.test(server));
ok('服务端 POST /api/features/number 可写时长',
  /pathname === '\/api\/features\/number'[\s\S]{0,200}setFeatureNumber/.test(server));

/* ── ② 服务端合并落盘（不算插话） ──────────────────────── */
ok('/api/chat 收 extraMessages 并按普通发言落盘',
  /发送缓冲】缓冲窗到点[\s\S]{0,400}extraMessages[\s\S]{0,1200}history\.push\(_exMsg\)/.test(server));
ok('合并的消息不带 _steer（窗里不算插话）',
  !/extraMessages[\s\S]{0,900}_steer/.test(server));
ok('合并落盘留了 diag 痕迹',
  /send-buffer-merge/.test(server));

/* ── ③ 前端缓冲窗 ─────────────────────────────────────── */
ok('点【发送】走 sendBuffered（回车不受影响）',
  /if \(!busy\) return sendBuffered\(\);/.test(html));
ok('回车键照旧走 send()（直接发，不缓冲）',
  /if \(!busy\) send\(\);\s*\n\s*else queueFromInput\(\);/.test(html));
ok('缓冲窗打字顺延：_holdPat 每键 +1 秒',
  /function _holdPat\(\)[\s\S]{0,200}deadline \+ 1000[\s\S]{0,120}firstAt \+ st\.maxMs/.test(html));
ok('keydown 里挂了 _holdPat',
  /try \{ _holdPat\(\); \} catch/.test(html));
ok('到点一次性发：_holdFire 带 _extraMsgs',
  /_holdFire[\s\S]{0,900}_extraMsgs: extras/.test(html));
ok('缓冲中的乐观显示不画两遍（_skipUserDraw）',
  html.includes('_skipUserDraw = false') && /if \(!_skipUserDraw\) \{[\s\S]{0,300}pendingRewindBubble = addUser\(text/.test(html));
ok('缓冲窗开着时按回车 = 立刻连缓冲一起发',
  /缓冲窗开着时按了回车[\s\S]{0,900}await _holdFire\(\)/.test(html));
ok('切会话前先放行缓冲（不把旧会话的话带过去）',
  /_holdFlushOnLeave\(\);[\s\S]{0,120}sessionId = String\(v \|\| ''\)/.test(html));
ok('功能页有「改时长」入口（两个数字输入 + 存）',
  /改时长」入口[\s\S]{0,800}sendBufferSec[\s\S]{0,600}sendBufferMaxSec/.test(html));

  /* 【2026-11-12 主人问「预发送重启了还会在吗」——钉住落盘与恢复 */
  ok('缓冲队列落 localStorage（重启/刷新不丢）',
    /_bufferSave\(_holdState\)/.test(html) && /'__xySendBuffer:' \+ \(sessionId/.test(html));
  ok('_holdFire 取账时清落盘那份',
    /_holdState = null;[\s\S]{0,80}_bufferClear\(\)/.test(html));
  ok('启动恢复残留缓冲：没在跑→续钟放行；在跑→退回输入框（不许自动插话）',
    /_restoreBuffered\(\), 900\)/.test(html) && /重启前有/.test(html));
console.log('\n发送缓冲：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
