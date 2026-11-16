#!/usr/bin/env node
/**
 * askApproval 真弹窗 · 端到端回归（2026-11-11）
 *
 * 【为什么要有这个】
 * 2026-11-10 三方审计抓到：`askApproval`（危险动作弹窗问主人）**从来没被注入**
 * —— ui-guard 里调 `exec.askApproval`，全仓没有任何一方提供这个函数。
 * 于是所有 needAsk=true 的操作都走「主人没有点头」分支，还报绿 ✓。
 * 注入修好之后，这条链路必须真机验一遍，不能只靠单元断言：
 *
 *   危险动作 → SSE ask_approval → 前端弹确认框 → 主人点允许/不许
 *   → POST /api/ask-approval → 工具继续执行 / 返回红 ✗
 *
 * 【怎么做到不碰主人的桌面 + 走真实用户路径】
 * 起隔离实例（_test-instance.mjs），自己 spawn 一个空白记事本当靶子。
 * **消息从浏览器页面里发**（往 #input 塞字 + 回车）—— 前端自己持有 SSE 流，
 * ask_approval 才会真的走到弹窗；脚本从旁边只做两件事：CDP 点确认框、
 * 用 /api/chat/live 断言工具结果。ui_observe 只看靶子记事本（hwnd 是测试查的），
 * ui_key 按的是 ctrl+delete —— 命中 DANGER_KEYS_EN（needAsk），
 * 点「不许」什么都没发生；点「允许」也只往空记事本按一下，无害。
 *
 * 跑法：node scripts/check-ask-approval.mjs   （要网络 + 模型配置，比较慢）
 */
import { spawn, execFile, execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { startIsolated } from './_test-instance.mjs';
import { connect as cdpConnect } from './_cdp-connect.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ok = (c, m, detail = '') => {
  if (c) { pass++; console.log('  [ok] ' + m + (detail ? '   ' + detail : '')); }
  else { fail++; console.log('  [FAIL] ' + m + (detail ? '   ' + detail : '')); }
};

/* ---- 靶子窗口 ----
 *
 * 2026-11-16 换掉记事本：这台机器的记事本是**商店版（UWP）**，
 * notepad.exe 只是个转接壳 —— 实测壳自己 MainWindowHandle=0，真窗口挂在
 * broker 拉起的**另一个进程**上，父进程根本不是我们 spawn 的那个。
 * 所以「只认自己 spawn 的那棵树」永远等不到窗口，只能掉进「正常窗口」兜底，
 * 那个窗口就直接糊到主人脸上 —— 主人今天报的「记事本的问题又冒出来了」就是它。
 *
 * 换成自己起的 WinForms 窗口，三个好处：
 *   ① 进程是我们亲生的：pid 确定、taskkill /T 一定清得掉；
 *   ② 一出生就 SetWindowPos 甩到 (-32000,-32000)，主人看不见，但句柄照旧是真的；
 *   ③ 里面是多行 TextBox：UIA 读得到文字、ctrl+delete 按得进去 —— 测试要的就这两点。
 */
import { tmpdir } from 'node:os';

const TARGET_MARK = 'xiaoyu-target';

/**
 * 靶子进程的「指纹」：靶子脚本 base64 的前 28 个字符。
 *
 * 为什么要这个：扫尸（sweepStaleLedger）要在**拉起之前**就能认出上次留下的靶子，
 * 可命令行里只有一串 base64。base64 是从第一个字节开始编的，脚本开头那段
 * （Add-Type …）永远一样 → 前 28 个字符恒定，拿它当指纹正好。
 * 为什么不额外塞个字面量参数：`-EncodedCommand` 后面跟多余参数时，
 * powershell 会当成参数错误直接退出（实测「使用 -Command 或 -EncodedCommand
 * 指定了命令」那句报错），靶子反而起不来。
 */
const MARK_B64 = Buffer.from(targetScript(''), 'utf16le').toString('base64').slice(0, 28);

function targetScript(hsPath) {
  /* 注意：这段 PowerShell 里**不许出现 try/finally**（PowerShell 5.1 走
   * -EncodedCommand 时会被防病毒扫成 ScriptContainedMaliciousContent）。 */
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    "$f = New-Object System.Windows.Forms.Form",
    "$f.Text = '" + TARGET_MARK + "'",
    '$f.Width = 520',
    '$f.Height = 360',
    '$t = New-Object System.Windows.Forms.TextBox',
    '$t.Multiline = $true',
    "$t.Dock = 'Fill'",
    "$t.Text = 'xiaoyu target window'",
    '[void]$f.Controls.Add($t)',
    '$f.Show()',
    "Add-Type -Namespace XyT -Name W -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);'",
    '[void][XyT.W]::SetWindowPos($f.Handle, [IntPtr]::Zero, -32000, -32000, 0, 0, 0x1 -bor 0x4 -bor 0x10)',
    "[System.IO.File]::WriteAllText('" + hsPath.replace(/\\/g, '\\\\') + "', [string]$f.Handle)",
    'while ($true) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 150 }',
  ].join('; ');
}

/**
 * 起一个靶子窗口，返回 { pid, hwnd }。拿不到就返回 null（调用处会判失败）。
 * 句柄通过一个握手文件回传 —— 比事后去查 MainWindowHandle 稳，不受启动时序影响。
 */
async function spawnTargetWindow() {
  const hs = join(tmpdir(), 'xy-ask-target-' + process.pid + '.txt');
  try { unlinkSync(hs); } catch {}
  const b64 = Buffer.from(targetScript(hs), 'utf16le').toString('base64');
  const p = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
    stdio: 'ignore', windowsHide: true, detached: false,
  });
  if (!p || !p.pid) return null;
  _myTargetPids.add(Number(p.pid));
  writeLedger();
  for (let i = 0; i < 60; i++) {
    if (existsSync(hs)) {
      let hwnd = 0;
      try { hwnd = Number(String(readFileSync(hs, 'utf8')).trim()); } catch {}
      if (hwnd > 0) { try { unlinkSync(hs); } catch {} return { pid: Number(p.pid), hwnd }; }
    }
    await sleep(250);
  }
  try { killTarget(p.pid); } catch {}
  return null;
}

/**
 * 【2026-11-15 修·跑回归会漏一堆记事本窗口（主人报「后台近十个记事本」）】
 *
 * 现场：主人后台堆了 9 个记事本，时间戳正好对应 13:39~14:17 我跑分片回归的时段。
 *
 * 病根两个，叠在一起：
 *   ① 只 kill 了 spawn 出来的那个 pid。Win11 记事本是 UWP 转接：
 *      真窗口挂在**子进程**上，父进程（spawn 的那个）和转接壳都留着，
 *      窗口就残在那儿 —— 每跑一次漏一个，跑十次漏十个。
 *   ② 脚本中途崩了/被超时掐了（今天被打断过好几次），finally 根本走不到，
 *      一个都不杀。
 *
 * 修法：spawn 时把整棵进程树的 pid 记在模块级集合里，收尾全杀；
 * 再挂退出/中断钩子兜底 —— 崩了也清。只动自己这次开的，不碰主人自己开的。
 */
const _myTargetPids = new Set();

/**
 * 【2026-11-15 补·被强杀时也能清干净 —— 用「pid 落盘 + 下次启动先扫尸」】
 *
 * 上面那套（整树 taskkill + exit/SIGINT/SIGTERM 钩子）只能挡住「正常崩」。
 * 挡不住**被 Stop-Process -Force / 超时 taskkill 直接砍**——那种情况下
 * node 的 exit 钩子根本不会执行，记事本就永久留下来了。
 * 主人今天就是被这个烦到：「记事本还是会偶尔时不时打开」。
 *
 * 所以再加一条落盘账：spawn 后立刻把 pid 写进 scripts/.notepad-pids.json；
 * **每次脚本启动第一件事**就是读这个文件，把上次没清掉的 pid 全杀掉。
 * 强杀留下的孤儿，下一次跑就自动收走了。
 */
const PID_LEDGER = 'D:\\小鱼Agent\\scripts\\.notepad-pids.json';

function sweepStaleLedger() {
  try {
    if (!existsSync(PID_LEDGER)) return 0;
    const raw = readFileSync(PID_LEDGER, 'utf8');
    const list = JSON.parse(raw);
    let n = 0;
    for (const id of Array.isArray(list) ? list : []) {
      const pid = Number(id);
      if (!pid) continue;
      try {
        const name = execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
        /* 认两种：
         *  · 老账里的记事本（2026-11-15 那批遗留，顺手收掉）
         *  · 现在起的 powershell 靶子 —— powershell 太常见，必须再核一遍
         *    命令行里有没有靶子标记，防 pid 复用误杀主人自己的脚本。 */
        let hit = /notepad/i.test(name);
        if (!hit && /powershell/i.test(name)) {
          try {
            const cmd = execFileSync('powershell.exe', ['-NoProfile', '-Command',
              '(Get-CimInstance Win32_Process -Filter "ProcessId=' + pid + '").CommandLine'],
            { encoding: 'utf8', windowsHide: true, timeout: 8000 });
            hit = String(cmd).includes(MARK_B64);
          } catch { hit = false; }
        }
        if (!hit) continue;
        spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        n++;
      } catch {}
    }
    try { unlinkSync(PID_LEDGER); } catch {}
    if (n) console.log('[check-ask-approval] 顺手清掉上次遗留的靶子 ' + n + ' 个');
    return n;
  } catch { return 0; }
}

function writeLedger() {
  try { writeFileSync(PID_LEDGER, JSON.stringify([..._myTargetPids]), 'utf8'); } catch {}
}

/* 一进门先扫尸 */
sweepStaleLedger();

/**
 * 把某个窗口挪到屏幕外（不激活、不改大小、不抢焦点）。
 * 失败一律吞掉：挪不动只是难看，不能因此让测试跑不了。
 */
function parkWindow(hwnd) {
  const h = Number(hwnd) || 0;
  if (!h) return;
  try {
    const ps = 'Add-Type -Namespace XyPark -Name U -MemberDefinition '
      + "'[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);';"
      + ' [void][XyPark.U]::SetWindowPos([IntPtr]' + h + ', [IntPtr]::Zero, -32000, -32000, 0, 0, 0x1 -bor 0x4 -bor 0x10)';
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, timeout: 8000, encoding: 'utf8' });
  } catch { /* 挪不动就算了 */ }
}

function killTarget(pid) {
  const ids = new Set(_myTargetPids);
  if (pid) ids.add(Number(pid));
  /* /T 连子进程树一起杀 —— UWP 记事本只杀父进程是关不掉窗口的 */
  for (const id of ids) {
    try { spawn('taskkill', ['/PID', String(id), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
  }
  _myTargetPids.clear();
}

/* 【崩了也要清】不装这些钩子，脚本被掐/抛错就是永久漏一个窗口 */
function sweepMyTargets() {
  try { if (_myTargetPids.size) killTarget(null); } catch {}
}
try { process.on('exit', sweepMyTargets); } catch {}
try { process.on('SIGINT', () => { sweepMyTargets(); process.exit(130); }); } catch {}
try { process.on('SIGTERM', () => { sweepMyTargets(); process.exit(143); }); } catch {}

/* ---- CDP 助手 ---- */

async function cdpTry(cdp, expr) {
  try { return await cdp.eval(expr); } catch { return undefined; }
}

/* ⚠ cdp.eval 会把表达式包进 (async () => { ... })()，**不自动 return** ——
 * 里头必须自己写 return，不然永远拿到 undefined（第一版就栽在这）。 */

/* 把还开着的旧确认框按「不许」收掉 —— 不然新一轮的弹窗出不来 / 会点错框 */
async function cdpDismissStale(cdp) {
  for (let i = 0; i < 12; i++) {
    const v = await cdpTry(cdp, `return (function(){
      const d = document.getElementById('confirmDlg');
      if (!d || !d.open) return 'closed';
      const c = document.getElementById('confirmCancel');
      if (c) c.click();
      return 'dismissed';
    })()`);
    if (v === 'closed') return;
    await sleep(400);
  }
}

/* 2026-11-14 诊断用 */
function fsAppend(file, line) {
  try { writeFileSync(file, readFileSync(file, 'utf8') + line + '\r\n'); }
  catch (e) { try { writeFileSync(file, line + '\r\n'); } catch (e2) {} }
}

/* 等确认框弹出来；wantClickOk=true 点「允许」，false 点「不许」。
 * 返回 'clicked:标题' / 'timeout'。弹窗最长等 90 秒（前端拿到事件有延迟）。 */
async function cdpWaitDialogAndClick(cdp, wantClickOk) {
  let dumped = 0;
  for (let i = 0; i < 225; i++) {
    /* 2026-11-14 诊断：每 10 轮（4 秒）dump 一次页面状态 */
    if (i % 10 === 0) {
      try {
        const st = await cdpTry(cdp, `return JSON.stringify({
          dlgOpen: !!(document.getElementById('confirmDlg') || {}).open,
          dlgExists: !!document.getElementById('confirmDlg'),
          title: ((document.getElementById('confirmTitle')||{}).textContent||'').slice(0,80),
          msgs: document.querySelectorAll('.msg').length,
          lastMsg: ((document.querySelector('.msg:last-child')||{}).textContent||'').slice(0,120),
          hidden: document.hidden,
          sid: String(window.sessionId||''),
          turns: (window.turns||[]).length,
          busy: String(window._curInFlight),
        })`);
        fsAppend('D:\\小鱼Agent\\scripts\\_dlglog.txt', 'i=' + i + ' ' + st);
      } catch (e) {}
    }
    const v = await cdpTry(cdp, `return (function(){
      const d = document.getElementById('confirmDlg');
      if (!d || !d.open) return 'closed';
      const t = (document.getElementById('confirmTitle')||{}).textContent || '';
      if (!/她要动/.test(t)) return 'closed';
      const b = document.getElementById(${wantClickOk ? "'confirmOk'" : "'confirmCancel'"});
      if (!b) return 'nobtn';
      b.click();
      return 'clicked:' + t;
    })()`);
    if (typeof v === 'string' && v.startsWith('clicked:')) return v;
    await sleep(400);
  }
  return 'timeout';
}

/* 从浏览器页面把话发出去（真实用户路径：#input + 回车） */
async function pageSend(cdp, text) {
  const v = await cdpTry(cdp, `return (function(){
    const inp = document.getElementById('input');
    if (!inp) return 'no-input';
    inp.value = ${JSON.stringify(text)};
    inp.focus();
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
    return 'sent';
  })()`);
  return v;
}

/* 这一轮的 sessionId：发完立刻问 /api/running */
async function grabSessionId(base) {
  for (let i = 0; i < 40; i++) {
    try {
      const j = await fetch(base + '/api/running').then((r) => r.json());
      const list = (j && j.running) || [];
      if (list.length) return list[0].sessionId;
    } catch {}
    await sleep(500);
  }
  return null;
}

/* 等 live 事件流里出现 ui_key 的 tool_end（/api/chat/live 的 events 是原始事件，type/name/ok/output） */
async function waitUiKeyDone(base, sid, maxMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const lv = await fetch(base + '/api/chat/live?sessionId=' + encodeURIComponent(sid)).then((r) => r.json());
      const evs = (lv && (lv.events || lv.items)) || [];
      const ends = evs.filter((e) => e && e.type === 'tool_end' && e.name === 'ui_key');
      if (ends.length) return ends;
    } catch {}
    await sleep(1000);
  }
  return [];
}

/* 等这一轮彻底收尾（running 里没了）—— 下一轮要等空闲才能发 */
async function waitTurnEnd(base, sid, maxMs = 150000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const j = await fetch(base + '/api/running').then((r) => r.json());
      const list = (j && j.running) || [];
      if (!list.some((x) => x.sessionId === sid)) return true;
    } catch {}
    await sleep(1000);
  }
  return false;
}

/* ---- 主流程 ---- */

const _isoPort = Number(process.env.XY_CHECK_PORT) || 8795;
const _isoCdp = Number(process.env.XY_CHECK_CDP) || 9223;
const iso = await startIsolated({ appPort: _isoPort, cdpPort: _isoCdp });
let np = null;
try {
  console.log('隔离实例：' + iso.base);

  /* 操作桌面必须在功能面板里开着（defaultOn=false，主人那份 features.json 里未必开着） */
  const featPath = join(iso.dataDir, '.state', 'features.json');
  let feats = {};
  try { if (existsSync(featPath)) feats = JSON.parse(readFileSync(featPath, 'utf8')); } catch {}
  feats.desktopHands = true;
  writeFileSync(featPath, JSON.stringify(feats));
  /* 白名单清空 = 不限窗口（主人的 settings.json 可能限了别的名单） */
  const setPath = join(iso.dataDir, '.state', 'settings.json');
  let st = {};
  try { if (existsSync(setPath)) st = JSON.parse(readFileSync(setPath, 'utf8')); } catch {}
  st.uiAllowedApps = [];
  writeFileSync(setPath, JSON.stringify(st));

  /* 2026-11-15 修：只认自己 spawn 的记事本，不再抢机器上现成的那个 ——
   * 并发跑多趟全量时会被别趟的 killTarget 连坐杀掉。 */
  np = await spawnTargetWindow();
  if (!np) throw new Error('靶子窗口没起来（拉起的那条路没回传 hwnd）');
  console.log('靶子窗口：pid=' + np.pid + ' hwnd=' + np.hwnd);

  await sleep(1500);
  const cdp = await cdpConnect({ port: iso.cdpPort, match: iso.base });

  /* 刷新一次页面，确保跑的是当前仓库的 index.html */
  try {
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    await sleep(9000);
  } catch {}
  const hasInput = await cdpTry(cdp, `return !!document.getElementById('input')`);
  if (!hasInput) throw new Error('页面上没有 #input（页面没就绪？）');

  const PROMPT = '请按顺序做这两件事，别做别的，做完用一句话汇报：'
    + '1) 调用 ui_observe 工具，hwnd 参数填 ' + np.hwnd + '；'
    + '2) 调用 ui_key 工具，keys 参数填 ctrl+delete。';

  /**
   * 【2026-11-16 加·第一句常常「发出去了但没开轮」】
   *
   * 现场：刚 reload 完 9 秒就发第一句，页面这边 `sent` 返回成功，
   * 可 /api/running 二十秒里一直是空的 —— 那一句被吞了（会话还没恢复完，
   * 前端把消息挂在一个还没建好的会话上）。第二轮再发就正常。
   * 于是第一组断言（点「不许」）整串挂掉，看着像功能坏了，其实是没开跑。
   *
   * 现在：发完等 25 秒还不开轮，就重发一次；最多三次。真坏了照样会挂。
   */
  async function sendAndGetSid(text) {
    for (let i = 0; i < 3; i++) {
      const r = await pageSend(cdp, text);
      if (r !== 'sent') return { sent: r, sid: null };
      const sid = await grabSessionId(iso.base);
      if (sid) return { sent: 'sent', sid };
      if (i < 2) console.log('  （第 ' + (i + 1) + ' 次发出去没开轮，重发一次）');
    }
    return { sent: 'sent', sid: null };
  }

  /* ===== 第一轮：弹窗 → 点「不许」→ 工具必须红 ✗ 且没按 ===== */
  console.log('\n=== 1. 点「不许」===');
  await cdpDismissStale(cdp);
  const r1 = await sendAndGetSid(PROMPT);
  const sent1 = r1.sent;
  ok(sent1 === 'sent', '从浏览器页面把消息发了出去', String(sent1));
  const sid = r1.sid;
  ok(Boolean(sid), '拿到这一轮的 sessionId', String(sid));

  const dlg1 = await cdpWaitDialogAndClick(cdp, false);
  ok(dlg1.startsWith('clicked:'), '前端真弹了确认框，点掉了「不许」', String(dlg1).slice(0, 60));
  const tools1 = await waitUiKeyDone(iso.base, sid);
  ok(tools1.length > 0, 'live 事件流里有 ui_key 的 tool_end', tools1.length + ' 条');
  ok(tools1.some((t) => t.ok === false && /✗|没动/.test(String(t.output || ''))),
    '点不许后 ui_key 返回红 ✗（没按）',
    tools1.map((t) => 'ok=' + t.ok + ' out=' + String(t.output || '').slice(0, 40)).join(' | '));
  await waitTurnEnd(iso.base, sid);
  await cdpDismissStale(cdp);

  /* ===== 第二轮：弹窗 → 真浏览器里点「允许」→ 工具执行 ===== */
  console.log('\n=== 2. 点「允许」===');
  const r2 = await sendAndGetSid(PROMPT);
  const sent2 = r2.sent;
  ok(sent2 === 'sent', '第二轮消息发出', String(sent2));
  const sid2 = r2.sid;
  /* 2026-11-14 诊断 */
  try {
    const rn = await fetch(iso.base + '/api/running').then((r) => r.text());
    const ss = await fetch(iso.base + '/api/sessions').then((r) => r.text());
    writeFileSync('D:\\小鱼Agent\\scripts\\_diag2.json', JSON.stringify({ sid, sid2, sent2, rn: rn.slice(0, 500), ss: ss.slice(0, 800) }, null, 2));
  } catch (e) {}
  ok(Boolean(sid2), '第二轮拿到 sessionId', String(sid2));

  const dlg2 = await cdpWaitDialogAndClick(cdp, true);
  ok(dlg2.startsWith('clicked:'), '确认框弹出且点掉了「允许」', String(dlg2).slice(0, 60));
  const tools2 = await waitUiKeyDone(iso.base, sid2);
  ok(tools2.some((t) => t.ok === true || /按了/.test(String(t.output || ''))),
    '点允许后 ui_key 真的执行了（ok / 「按了 ctrl+delete」）',
    tools2.map((t) => 'ok=' + t.ok + ' out=' + String(t.output || '').slice(0, 40)).join(' | '));
  await waitTurnEnd(iso.base, sid2);

  console.log('\n────────────────────────────────');
  if (!fail) { console.log('断言：' + pass + '/' + pass + '   全部通过'); console.log('PASS askApproval 链路真机全通'); }
  else { console.log('断言：' + pass + '/' + (pass + fail) + '   有失败'); process.exitCode = 1; }
} catch (e) {
  console.error('[check-ask-approval] ' + (e && e.message ? e.message : e));
  process.exitCode = 1;
} finally {
  killTarget(np && np.pid);
  await iso.stop();
}
