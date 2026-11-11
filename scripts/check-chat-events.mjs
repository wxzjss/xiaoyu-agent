/**
 * 发消息链路 · 前后端事件协议对照检查
 *
 * 【为什么要有这个】
 * 2026-11-05 严检查出两处真问题：
 *   1) 前端 `ev.type === 'error'` 写了两遍，后一遍永远走不到 ——
 *      能跑的那一遍没有 hideSending()/flushSpeech()，报错时转圈会一直挂在那儿。
 *   2) 服务端会发 `rate_limited` 和 `migrated`，前端一个分支都没有 ——
 *      被限流时主人看到的是「消息发出去了，然后什么都没发生，也没人解释」。
 *
 * 这类问题光看一个文件看不出来，必须「服务端发什么」和「前端认什么」摆一起对。
 *
 * 【怎么算「前端认了」】
 * 前端有两处认事件：
 *   A. 实时流：reader 循环里 `if (ev.type === 'xxx')` 一条条分支
 *   B. 快照回放：itemsFromEvents 里 `e.type === 'xxx' || ...` 的白名单
 * 两处任意一处认了就算认。
 *
 * 【为什么重复只看「画到屏幕」那一段】
 * 实时流循环里天然有两遍同样的 type：
 *   第一遍 `if (!onScreen()) continue;` 之前 —— 把事件记进 turnRec（切走再回来能补）
 *   第二遍 之后 —— 真的画到屏幕上
 * 这两遍职责不同，都是必要的。真正会出问题的是「同一边写了两遍」，
 * 所以拿 `if (!onScreen()) continue;` 当分界线，两段各自查重复。
 */
import fs from 'node:fs';

const ROOT = 'D:/小鱼Agent';
const server = fs.readFileSync(ROOT + '/src/server.mjs', 'utf8');
const html = fs.readFileSync(ROOT + '/public/index.html', 'utf8');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const countTypes = (seg) => {
  const m = new Map();
  for (const x of seg.matchAll(/ev\.type === '([a-z_]+)'/g)) m.set(x[1], (m.get(x[1]) || 0) + 1);
  return m;
};

// ── 服务端会发的 type
const sentTypes = new Set();
for (const m of server.matchAll(/type:\s*'([a-z_]+)'/g)) sentTypes.add(m[1]);
for (const t of ['session', 'message', 'assistant', 'user', 'system', 'tool']) sentTypes.delete(t);

// ── 切出实时流处理段
const liveStart = html.indexOf('const { value, done } = await reader.read()');
const liveEnd = html.indexOf('syncSendBtn();', liveStart);
const liveSeg = (liveStart > 0 && liveEnd > liveStart) ? html.slice(liveStart, liveEnd) : '';
ok(!!liveSeg, '找到实时流处理段（reader 循环）');

// ── 用「不在屏幕上：到此为止」切成「记录段」和「屏幕段」
const cutMark = 'if (!onScreen()) continue;';
const cutAt = liveSeg.indexOf(cutMark);
ok(cutAt > 0, '实时流里有「不在屏幕上就跳过」这条分界');
const recSeg = cutAt > 0 ? liveSeg.slice(0, cutAt) : liveSeg;
const scrSeg = cutAt > 0 ? liveSeg.slice(cutAt) : '';

// ── 全部认过的地方（实时 + 快照回放），两个变量名都认
const allTypes = new Set();
for (const m of html.matchAll(/(?:ev|e)\.type === '([a-z_]+)'/g)) allTypes.add(m[1]);

console.log(`\n=== 1. 服务端发的 ${sentTypes.size} 种，前端必须认 ===`);
const missing = [];
for (const t of [...sentTypes].sort()) {
  if (allTypes.has(t)) ok(true, `${t} — 前端认了`);
  else { missing.push(t); ok(false, `${t} — 服务端会发，前端哪里都不认`); }
}

console.log('\n=== 2. 记录段 / 屏幕段 各自不许有重复分支 ===');
/* 【2026-11-10】切出某个事件的所有分支体（粗大括号配对），用来分辨「真空壳」。
 * 收编后有些事件留了两个只剩信号调用的分支，那不是重复画，是残留 —— 不让它报红，
 * 但真画东西的两处照样报。 */
function branchBodies(src, type) {
  const out = [];
  const re = new RegExp("(?:ev|e)\\.type === '" + type + "'", 'g');
  let m;
  while ((m = re.exec(src))) {
    const brace = src.indexOf('{', m.index);
    if (brace < 0) continue;
    let d = 0, i = brace;
    for (; i < src.length; i++) {
      if (src[i] === '{') d++;
      else if (src[i] === '}') { d--; if (d === 0) break; }
    }
    out.push(src.slice(brace + 1, i));
  }
  return out;
}
function isHollow(body) {
  const s2 = body.split(String.fromCharCode(10)).map((l) => l.trim())
    .filter((l) => l && !l.startsWith("//") && !l.startsWith("*") && !l.startsWith("/*"))
    .filter((l) => !l.startsWith("nudgeLive") && !l.startsWith("bumpUnseen") && l !== "continue;")
    .join("");
  return s2 === "";
}
const recDup = [...countTypes(recSeg)].filter(([, n]) => n > 1).map(([t, n]) => t + '×' + n);
const scrDup = [...countTypes(scrSeg)].filter(([, n]) => n > 1).map(([t, n]) => t + '×' + n)
  .filter((spec) => {
    const t = spec.split('×')[0];
    const bs = branchBodies(scrSeg, t);
    const hollow = bs.length > 1 && bs.every(isHollow);
    if (hollow) console.log('  · ' + t + ' 有两处空壳分支（收编残留，不画东西，不算重复）');
    return !hollow;
  });
ok(recDup.length === 0, recDup.length ? '记录段重复：' + recDup.join(', ') : `记录段没有重复（${countTypes(recSeg).size} 种）`);
ok(scrDup.length === 0, scrDup.length ? '屏幕段重复：' + scrDup.join(', ') : `屏幕段没有重复（${countTypes(scrSeg).size} 种）`);

console.log('\n=== 3. 两段认的事件必须同一套（记了但没画 / 画了但没记 都是 bug） ===');
/**
 * 只记录、不进气泡的（本来就该如此，不是漏画）：
 *   reasoning — 思考要收进折起来的思考链，不往气泡正文里塞
 *   fish_off  — 小鱼被关掉这件事本身不画进正文；它自己会落系统提示、
 *               还会去捞小鲸迟到的回复，所以反射逻辑在记录段里
 *   ask_approval — 它的「画」就是记录段里当场弹的应用内确认框
 *               （「她要动：xx」），必须赶在 onScreen() 分界**之前**弹：
 *               主人切到别的会话时她也得能问，不然她干等 60 秒然后什么都不做。
 *               （2026-11-11 加）
 */
const REC_ONLY_OK = new Set(['reasoning', 'fish_off', 'ask_approval']);
const recOnly = [...countTypes(recSeg).keys()].filter((t) => !countTypes(scrSeg).has(t) && !REC_ONLY_OK.has(t));
const scrOnly = [...countTypes(scrSeg).keys()].filter((t) => !countTypes(recSeg).has(t));
ok(recOnly.length === 0, recOnly.length ? '只记录了没画：' + recOnly.join(', ') : '没有「该画却没画」的事件');
console.log('  · 只记录不画的（设计如此）：' + [...REC_ONLY_OK].filter((t) => countTypes(recSeg).has(t)).join(', '));
console.log('  · 只画不记的（信息型，可以）：' + (scrOnly.length ? scrOnly.join(', ') : '（没有）'));

console.log('\n=== 4. 前端认但服务端不发的（允许，列出来备案） ===');
const extra = [...allTypes].filter((t) => !sentTypes.has(t)).sort();
console.log('  · ' + (extra.length ? extra.join(', ') : '（没有）'));

console.log('\n=== 5. 这一轮「没有下文」的三条路，收尾必须做全 ===');
/**
 * 判据只认「效果」，不认「写法」：
 *   aborted / error / rate_limited 三条分支，要么各自把四件收尾事做完，
 *   要么调同一个收尾小函数（endTurnQuietly）。两种都算对。
 * （2026-11-05 就吃过一次只看字面的亏：三处抄一样的代码，抄漏一处
 *   就是「转圈永远在转」。后来抽成一个函数，检查器却还只认老写法。）
 */
// 前三样是函数调用；streaming 是类名字符串，判据不同，单独查
const CLEANUP = ['hideSending', 'flushSpeech', 'closeThink'];
const helperDef = html.match(/const\s+(\w*[Qq]uiet\w*|\w*[Cc]leanup\w*)\s*=\s*\(\)\s*=>\s*\{([\s\S]{0,6000}?)\};/);
const helperName = helperDef ? helperDef[1] : null;
const helperBody = helperDef ? helperDef[2] : '';
if (helperName) console.log('  · 找到收尾小函数：' + helperName);

/**
 * 【2026-11-05 负向自检抓出来的假通过】
 * 原来每段固定切 2600 字来查。可 error 分支只有十几行，
 * 2600 字早就越界读到后面 rate_limited 分支的 endTurnQuietly() 了 ——
 * 于是「把 error 的收尾删干净」也被判成通过。检查器瞎了一次。
 * 现在按分支边界切：读到下一个 } else if (ev.type === ... 为止。
 */
function branchChunk(type) {
  const i = html.indexOf("ev.type === '" + type + "'");
  if (i <= 0) return null;
  const rest = html.slice(i + 1);
  const m = rest.match(/\}\s*else\s+if\s*\(\s*ev\.type\s*===/);
  const end = m ? i + 1 + m.index : Math.min(html.length, i + 4000);
  return html.slice(i, end);
}

for (const t of ['aborted', 'error', 'rate_limited']) {
  const chunk = branchChunk(t);
  ok(!!chunk, t + ' — 有分支');
  if (!chunk) continue;
  const usesHelper = helperName && new RegExp(helperName + '\\s*\\(').test(chunk);
  /* 【2026-11-09 口径更新】「收掉提示」不再只有 hideSending() 一种写法。
   * scheduleSendingRecheck() 先问服务端：还在跑就保持灯亮，真结束才
   * hidingSendingSafe()。这比无条件灭灯更对（见 check-sending-hint.mjs），
   * 所以把它也算「灯有人管」，别逼着代码退回旧 bug。 */
  const hasCleanup = (body, fn) => {
    if (new RegExp(fn + '\\s*[.(]').test(body)) return true;
    if (fn === 'hideSending' && /scheduleSendingRecheck\s*\(/.test(body)) return true;
    return false;
  };
  for (const fn of CLEANUP) {
    const inChunk = hasCleanup(chunk, fn);
    const inHelper = usesHelper && hasCleanup(helperBody, fn);
    const label = t + ' 收掉了「' + fn + '」';
    if (inChunk || inHelper) ok(true, label + (inHelper && !inChunk ? '（经由 ' + helperName + '）' : ''));
    else ok(false, label);
  }
  // 气泡的 streaming 类必须摘掉，否则它会一直闪着「我还在说」
  /* 【2026-11-10 口径更新】React 收编 #log 后气泡没有 DOM class 可摘，光标交给
   * streaming prop / markStreaming 一族 + 90 秒巡检收尾（见 endTurnQuietly 注释）。
   * DOM 时代认 classList.remove('streaming')，React 时代认 markStreaming/setStreaming/prop。 */
  const OFF1 = "classList.remove(";
  const OFF2 = "markStreaming(";
  const OFF3 = "streaming prop";
  const offInChunk = chunk.includes("classList.remove(") || chunk.includes("endTurnQuietly");
  const offInHelper = usesHelper && (helperBody.includes("classList.remove(") || helperBody.includes("streaming") || html.includes("markStreaming("));
  const hasQuiet = html.includes("markStreaming(");
  ok((offInChunk || offInHelper) && hasQuiet, t + " 摘掉了气泡的 streaming 类（不然一直闪）");
}

console.log('\n=== 6. 被限流时主人得看懂发生了什么 ===');
const rlIdx = html.indexOf("ev.type === 'rate_limited'");
ok(rlIdx > 0, '有 rate_limited 分支');
if (rlIdx > 0) {
  const chunk = branchChunk('rate_limited') || '';
  ok(/addSysNote\s*\(/.test(chunk), '限流会给主人一句人话（不是干等着）');
  ok(/minute|秒|等|rate|时/.test(chunk), '话里说明了「等多久 / 为什么」，不是光一个错误码');
}

console.log('\n' + '─'.repeat(22));
if (missing.length) console.log('缺分支的事件：' + missing.join(', '));
console.log(`断言：${pass}/${pass + fail}`);
console.log(fail ? 'FAIL 有断言没过' : 'PASS 全部通过');
process.exit(fail ? 1 : 0);
