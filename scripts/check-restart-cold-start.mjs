#!/usr/bin/env node
/**
 * 重启（冷启动）· 真机验收（QA 独立验收 · 2026-11-11）
 *
 * 主人报过的形态：
 *   ①「跑着一半关掉 / 断电，再打开，她说过的话一个字都没了」
 *   ②「重启后打开会话，整屏空白，或者跑到很久以前的位置」
 *   ③「重启后她说没在跑，可屏幕就是不出东西」
 *
 * 做法（真的杀进程再起，同一个数据目录）：
 *   · 造一个「跑着一半」的会话：40 轮正常历史 + 最后一句主人问话没有回答，
 *     外加一份 .state/drafts/<sid>.json（带正文和工具记录）；
 *   · 起服务 → 打开页面 → 打开这个会话 → 取样；
 *   · 硬杀服务（模拟断电 / 关进程）→ 同一个端口重新起 → 刷新页面 → 再打开 → 取样；
 *   · 再杀一次、再起一次，验「反复重启不会把半截话叠成两条」。
 *
 * 断言全部是屏幕上的东西：气泡数、DOM 阅读顺序、离底 px、草稿正文在不在、
 * 早年那几条在不在屏上、/api/chat/live 说 running=false 时屏幕是不是落在历史上。
 *
 * 用法：node scripts/check-restart-cold-start.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startIsolated } from './_test-instance.mjs';
import { connect } from './_cdp-connect.mjs';
import { makeChecker } from './_harness_util.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const c = makeChecker('重启冷启动（杀进程再起，同一个数据目录）');
const ROOT = process.cwd();

/* ── 造数据 ───────────────────────────────────────────────────── */
const ID = 'qaRestart' + Date.now().toString(36);
const ROUNDS = 30;                      // 30 轮 = 60 turn，超出 WINDOW(40) → 屏幕上只会画后面一段
const DRAFT_TEXT = 'QA半截话她说到一半程序就被关了这一段要接回来';

function mkSession(id) {
  const messages = [];
  for (let i = 0; i < ROUNDS; i++) {
    messages.push({ role: 'user', content: 'QA重启第' + i + '问', _text: 'QA重启第' + i + '问', at: 1794400000000 + i * 2000 });
    messages.push({
      role: 'assistant',
      content: 'QA重启第' + i + '答：这一轮她答了一段话，写长一点点好让屏幕有得滚（第 ' + i + ' 轮）。',
      at: 1794400000500 + i * 2000,
    });
  }
  /* 最后再来一句主人问话，她一个字都还没回 —— 断在半路 */
  messages.push({ role: 'user', content: 'QA重启最后一句问话（她答到一半就断了）', _text: 'QA重启最后一句问话（她答到一半就断了）', at: 1794400000000 + ROUNDS * 2000 });
  return { id, title: '__qa_restart__', createdAt: 1794400000000, updatedAt: 1794400000000, messages, rewinds: [] };
}

function mkDraft() {
  return {
    sessionId: ID,
    startedAt: Date.now() - 60000,
    updatedAt: Date.now() - 5000,
    text: DRAFT_TEXT,
    reasoning: 'QA断之前她想了一下这件事该怎么接',
    toolCalls: [{ type: 'tool_start', name: 'run_command' }],
  };
}

/* ── 自己起服务（好在同一个端口上反复杀 / 起） ─────────────────── */
function spawnServer(port) {
  const p = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, MINI_AGENT_DATA: globalThis.__QA_DATA, PORT: String(port), XY_TEST_INSTANCE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.__log = '';
  p.stdout.on('data', (d) => { p.__log += String(d); });
  p.stderr.on('data', (d) => { p.__log += String(d); });
  return p;
}

async function waitUp(port, ms = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(1500) });
      if (r.ok) return true;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  return false;
}

async function waitDown(port, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(1000) });
      if (!r.ok) return true;
    } catch { return true; }
    await sleep(200);
  }
  return false;
}

function killHard(p) {
  return new Promise((res) => {
    if (!p || p.exitCode != null) return res();
    try {
      const k = spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      k.on('exit', () => res());
      k.on('error', () => { try { p.kill('SIGKILL'); } catch {} res(); });
    } catch { try { p.kill('SIGKILL'); } catch {} res(); }
  });
}

async function freePort(start) {
  for (let p = start; p < start + 20; p++) {
    try {
      await fetch('http://127.0.0.1:' + p + '/api/health', { signal: AbortSignal.timeout(600) });
    } catch { return p; }
  }
  throw new Error('没有空闲端口');
}

/* ── 页面取样 ─────────────────────────────────────────────────── */
const SNAP = `(function(){
  var lg = document.getElementById('log');
  var tx = function(el){ return String((el && el.textContent) || '').replace(/\\s+/g,''); };
  var rows = [];
  var nodes = lg ? lg.querySelectorAll('.msg, details.tool, details.toolhub, .sysnote, button.loadEarlier') : [];
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (el.parentElement && el.parentElement.closest('details')) continue;
    var cls = String(el.className || '');
    var kind = '';
    if (el.tagName === 'BUTTON') kind = 'loadEarlier';
    else if (el.tagName === 'DETAILS') kind = /toolhub/.test(cls) ? 'hub' : 'tool';
    else if (cls.indexOf('sysnote') >= 0) kind = 'note';
    else if (/(^|\\s)user(\\s|$)/.test(cls)) kind = 'user';
    else if (/(^|\\s)assistant(\\s|$)/.test(cls)) kind = 'assistant';
    else if (/(^|\\s)mate(\\s|$)/.test(cls)) kind = 'mate';
    var b = el.querySelector('.bubble');
    rows.push({ kind: kind, text: (kind === 'hub' || kind === 'tool' || kind === 'loadEarlier') ? tx(el).slice(0, 30) : tx(b) });
  }
  return {
    sid: window.sessionId || '',
    rows: rows.map(function(r){ return r.kind + ':' + r.text.slice(0, 26); }),
    kinds: rows.map(function(r){ return r.kind; }),
    lastRow: rows.length ? rows[rows.length - 1] : null,
    msgCount: lg ? lg.querySelectorAll('.msg').length : 0,
    streaming: lg ? lg.querySelectorAll('.bubble.streaming').length : 0,
    loadEarlier: lg ? !!lg.querySelector('button.loadEarlier') : false,
    loadEarlierText: (function(){ var b = lg && lg.querySelector('button.loadEarlier'); return b ? tx(b) : ''; })(),
    dist: lg ? Math.round(lg.scrollHeight - lg.scrollTop - lg.clientHeight) : -1,
    st: lg ? Math.round(lg.scrollTop) : -1,
    sh: lg ? lg.scrollHeight : -1,
    ch: lg ? lg.clientHeight : -1,
    sendText: (document.getElementById('send') || {}).textContent || '',
    stopShown: !!(document.getElementById('stopBtn') && document.getElementById('stopBtn').classList.contains('show')),
    sending: !!(document.getElementById('sendingHint') && document.getElementById('sendingHint').classList.contains('show')),
    busy: !!window.busy,
    text: lg ? String(lg.textContent || '').replace(/\\s+/g, '') : '',
  };
})();`;

let iso = null;
let cdp = null;
let port = 0;
let cur = null;      // 当前那个服务进程
const snap = () => cdp.eval('return ' + SNAP + ';');

const cnt = (hay, needle) => String(hay || '').split(needle).length - 1;

async function openSessionAndSnap(tag) {
  /* 从服务端问一次「这一轮还在跑吗」——任务书要求：说 running=false 时屏幕必须落在历史上 */
  const live = await fetch('http://127.0.0.1:' + port + '/api/chat/live?sessionId=' + encodeURIComponent(ID))
    .then((r) => r.json()).catch(() => null);
  const swOk = await cdp.eval('return window.switchSessionSafe(' + JSON.stringify(ID) + ');').catch(() => false);
  await sleep(2200);
  const s = await snap();
  s.liveRunning = live ? live.running : null;
  s.switchOk = swOk;
  /* 数据层交代：直接看盘上的会话文件 —— 半截话有没有被补成一条 _recovered 的 assistant。
   * 【不能拿 select 的 recovered 字段判】那一次「打开会话」的 select 已经被页面用掉了
   * （幂等：补完就 dropDraft），我这时候再问一次必然是 false，测出来的是时序不是行为。 */
  const disk = (() => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(globalThis.__QA_DATA, '.state', 'sessions', ID + '.json'), 'utf8'));
      const msgs = Array.isArray(j.messages) ? j.messages : [];
      return {
        n: msgs.length,
        recovered: msgs.filter((m) => m && m._recovered).length,
        lastRole: msgs.length ? String(msgs[msgs.length - 1].role || '') : '',
        lastIsRecovered: !!(msgs.length && msgs[msgs.length - 1]._recovered),
        draftLeft: fs.existsSync(path.join(globalThis.__QA_DATA, '.state', 'drafts', ID + '.json')),
      };
    } catch (e) { return { n: -1, recovered: -1, lastRole: '?', lastIsRecovered: false, draftLeft: false }; }
  })();
  s.disk = disk;
  s.recovered = disk.recovered;
  s.selTurns = disk.n;
  console.log('  ' + tag + '：msg=' + s.msgCount + ' 离底=' + s.dist + 'px live.running=' + s.liveRunning
    + ' 盘上 _recovered=' + s.recovered + ' 条 / messages=' + s.selTurns + ' 草稿残留=' + s.disk.draftLeft
    + ' 半截话命中=' + cnt(s.text, DRAFT_TEXT) + ' 早年在屏上=' + (s.text.indexOf('QA重启第0问') >= 0));
  return s;
}

async function boot() {
  iso = await startIsolated({ appPort: 8836, cdpPort: 9256 });
  console.log('隔离实例（数据目录） ' + iso.dataDir);
  globalThis.__QA_DATA = iso.dataDir;

  const SESS = path.join(iso.dataDir, '.state', 'sessions');
  const DRAFTS = path.join(iso.dataDir, '.state', 'drafts');
  fs.mkdirSync(SESS, { recursive: true });
  fs.mkdirSync(DRAFTS, { recursive: true });
  fs.writeFileSync(path.join(SESS, ID + '.json'), JSON.stringify(mkSession(ID)), 'utf8');
  fs.writeFileSync(path.join(DRAFTS, ID + '.json'), JSON.stringify(mkDraft()), 'utf8');
  console.log('造好一个「跑着一半」的会话 ' + ID + '（' + ROUNDS + ' 轮 + 一个没答的问句 + 一份草稿）');

  port = await freePort(8840);
  console.log('重启用的端口 ' + port);

  cdp = await connect({ port: iso.cdpPort, match: iso.base });
  for (let i = 0; i < 100; i++) {
    const v = await cdp.eval('return { r: !!document.getElementById("log"), s: window.sessionId || "" };').catch(() => null);
    if (v && v.r && v.s) break;
    await sleep(300);
  }
}

/** 冷启动一次：起服务 → 页面指过去 → 打开那个会话 → 取样 */
async function cycle(n) {
  cur = spawnServer(port);
  const up = await waitUp(port);
  c.ok('第 ' + n + ' 次冷启动：服务起来了', up, '端口 ' + port);
  if (!up) throw new Error('服务没起来：' + String(cur.__log || '').slice(-400));
  await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + port + '/' }).catch(() => {});
  /* 等页面脚本重新加载完 */
  for (let i = 0; i < 120; i++) {
    const v = await cdp.eval('return { r: !!document.getElementById("log"), s: window.sessionId || "", fn: typeof window.runTurn };').catch(() => null);
    if (v && v.r && v.s && v.fn === 'function') break;
    await sleep(300);
  }
  await sleep(800);
  return openSessionAndSnap('第 ' + n + ' 次打开');
}

/* ── 主线 ─────────────────────────────────────────────────────── */
try {
  await boot();

  /* ① 第一次（模拟「关掉程序再打开」）：草稿要接回来 */
  const s1 = await cycle(1);
  c.ok('冷启动后屏幕不是空的（不许整屏空白）', s1.msgCount > 0, 'msg=' + s1.msgCount);
  /* 【数据层】草稿必须被接回来 —— select 回 recovered=true，历史里多出一条 _recovered 的 assistant。
   * （正文本身**有意不画**：2026-11-08 主人说「重启后她发出一大段内心独白，是说给我看的吗」，
   *  2026-11-13 起 _recovered 照常显示（主人钦点），屏幕上看到它才是对的。） */
  c.ok('数据层：半截话被接回来了（历史里多出一条 _recovered 的 assistant，话没丢）',
    s1.recovered === 1 && s1.disk.lastIsRecovered === true && s1.disk.draftLeft === false,
    '盘上 _recovered ' + s1.recovered + ' 条 / messages ' + s1.selTurns + ' / 最后一条 ' + s1.disk.lastRole
    + ' / 草稿残留 ' + s1.disk.draftLeft);
  /* 【2026-11-13 反转·主人钦点翻案】旧设计把接回的半截话藏起来（"有意隐藏"），
   * 结果主人重启后看到「她说过的话全没了」。现在照常画成她的正文气泡，
   * 这里改判「必须出现」——话不能消失。 */
  c.ok('屏幕层：半截话被接回来并照常画出来（她说过的话不能消失）', cnt(s1.text, DRAFT_TEXT) >= 1,
    '命中 ' + cnt(s1.text, DRAFT_TEXT) + ' 次（应 ≥1）');
  c.ok('她自己那句话也在（不是只有主人的问句）', s1.text.indexOf('QA重启第29答') >= 0,
    '第29答命中 ' + (s1.text.indexOf('QA重启第29答') >= 0));
  c.ok('/api/chat/live 说 running=false', s1.liveRunning === false, 'live.running=' + s1.liveRunning);
  c.ok('running=false 时屏幕落在历史上（有内容、没有流式光标）',
    s1.msgCount > 0 && s1.streaming === 0, 'msg=' + s1.msgCount + ' streaming=' + s1.streaming);
  c.ok('屏幕贴在底部（不是停在很早以前的位置）', s1.dist <= 8,
    '离底 ' + s1.dist + 'px（scrollTop ' + s1.st + ' / sh ' + s1.sh + ' / ch ' + s1.ch + '）');
  /* 【2026-11-12 改·提示行出现后这条要按「最后一行对话内容」判】
   * 现在断在半路会在历史末尾补一条 note（「她那半截话我接回历史了」），
   * 它本来就该在**最底下** —— 所以不能拿「最后一行必须是问句」去判，
   * 要跳过提示行，看最后一条真正的对话内容是不是那句问话。
   * 注意 rows 是字符串数组（'kind:text'），不是对象。 */
  const __lastTalks1 = (() => {
    const rows = Array.isArray(s1.rows) ? s1.rows : [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = String(rows[i] || '');
      if (row.indexOf('note:') === 0) continue;   // 提示行本来就该在最底下，跳过它
      return row;
    }
    return '';
  })();
  /* 【2026-11-13 反转】旧设计接回的话被藏，最后一条「真对话」停在主人的问句；
   * 现在接回的半截话照常显示，最后一条就该是它。 */
  c.ok('最后一条对话内容是接回的半截话（她说过的话回来了，就排在最底下）',
    __lastTalks1.indexOf('assistant:') === 0 && /半截话|接回/.test(__lastTalks1),
    '最后一条对话：' + __lastTalks1.slice(0, 30));
  /* 【屏幕层·交代】这一轮断在半路，屏幕上总得看得出「发生过什么」：
   * 要么半截话可见，要么有一条提示（sysnote / 提示条 / 待续按钮）。
   * 现在两者都没有 —— 主人看到的就是「我问了一句，她一个字没回」，跟没发生过一样。 */
  /* 【判据要严】不能拿主人自己那句问话里的「断了」当交代（我这份测试数据里就有）。
   * 只认三种真交代：① 一条系统提示行；② 草稿正文本身（含「说到这儿断了一下」那截尾巴）；
   * ③ 一个「接着跑」的按钮。 */
  const hasNotice = s1.kinds.indexOf('note') >= 0
    || /说到这儿断了一下|中间动了这些工具|接回来了|上一轮没说完/.test(String(s1.text || ''))
    || s1.kinds.some((k) => k === 'button');
  c.ok('屏幕层：断在半路这件事有交代（半截话可见 或 有条提示说「上一轮断在半路」）',
    cnt(s1.text, DRAFT_TEXT) >= 1 || hasNotice,
    '半截话可见=' + (cnt(s1.text, DRAFT_TEXT) > 0)
    + '，提示行=' + s1.kinds.filter((k) => k === 'note').length
    + '，草稿尾巴可见=' + /说到这儿断了一下|接回来了/.test(String(s1.text || ''))
    + '（盘上 recovered 那条被人为隐藏，屏幕上一个字都没提）');
  c.ok('很早那几条没被摆到屏幕上（窗口生效）', s1.text.indexOf('QA重启第0问') < 0 && s1.text.indexOf('QA重启第5答') < 0,
    '第0问命中 ' + (s1.text.indexOf('QA重启第0问') >= 0) + ' / 第5答命中 ' + (s1.text.indexOf('QA重启第5答') >= 0));
  c.ok('顶部有「再往前看」而不是把 60 条全塞进屏幕', s1.loadEarlier === true, s1.loadEarlierText.slice(0, 40));
  c.ok('主按钮文案是【发送】、没在跑', s1.sendText === '发送' && s1.busy === false,
    '「' + s1.sendText + '」busy=' + s1.busy);

  /* ② 硬杀（模拟断电）→ 同一个端口再起 → 再打开 */
  await killHard(cur);
  const down = await waitDown(port);
  c.ok('硬杀之后服务确实没了（模拟断电）', down);
  const s2 = await cycle(2);
  c.ok('第二次冷启动：屏幕不是空的', s2.msgCount > 0, 'msg=' + s2.msgCount);
  c.ok('第二次冷启动：不会重复回灌（_recovered 仍只有 1 条）', s2.recovered === 1,
    '盘上 _recovered ' + s2.recovered + ' 条 / messages ' + s2.selTurns);
  c.ok('第二次冷启动：贴在底部', s2.dist <= 8, '离底 ' + s2.dist + 'px');
  const __lastTalks2 = (() => {
    const rows = Array.isArray(s2.rows) ? s2.rows : [];
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = String(rows[i] || '');
      if (row.indexOf('note:') === 0) continue;   // 提示行本来就该在最底下，跳过它
      return row;
    }
    return '';
  })();
  c.ok('第二次冷启动：最后一条对话仍是接回的半截话（不重复、不消失）',
    __lastTalks2.indexOf('assistant:') === 0 && /半截话|接回/.test(__lastTalks2), '最后一条对话：' + __lastTalks2.slice(0, 30));
  c.ok('两次冷启动的 DOM 阅读顺序一致（没有一次比一次多/少）',
    JSON.stringify(s1.rows) === JSON.stringify(s2.rows),
    '第一次 ' + s1.rows.length + ' 行 / 第二次 ' + s2.rows.length + ' 行');

  /* ③ 再杀一次、再起一次 —— 反复重启不许把半截话叠成两条 */
  await killHard(cur);
  await waitDown(port);
  const s3 = await cycle(3);
  c.ok('第三次冷启动：仍然只有一份半截话（不会一轮轮叠上去）',
    s3.recovered === 1 && s3.selTurns === s1.selTurns,
    '_recovered 第一次 ' + s1.recovered + ' 条 / 第三次 ' + s3.recovered + ' 条；messages 第一次 ' + s1.selTurns + ' / 第三次 ' + s3.selTurns);
  c.ok('第三次冷启动：贴在底部', s3.dist <= 8, '离底 ' + s3.dist + 'px');
  c.ok('三次之后整屏行数没变（没有一轮轮叠上去）', s3.rows.length === s1.rows.length,
    '第一次 ' + s1.rows.length + ' 行 / 第三次 ' + s3.rows.length + ' 行');
} catch (e) {
  console.log('  [!!] 跑挂了：' + (e && e.stack ? e.stack : e));
  process.exitCode = 1;
} finally {
  try { await killHard(cur); } catch (e) {}
  try { cdp && cdp.close(); } catch (e) {}
  try { iso && await iso.stop(); } catch (e) {}
}
c.done();
process.exit(process.exitCode || 0);
