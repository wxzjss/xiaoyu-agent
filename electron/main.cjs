// Electron 主进程：内置起服务 → 开窗口。
// 写成 CommonJS 是有意的：Electron 的 ESM loader 没法 `import 'electron'`。
//
// 【后台继续跑】三处关键设置，缺一个都会「一离开就断」：
//   1. backgroundThrottling: false —— 不加这个，窗口最小化 / 失焦时渲染进程被降频，
//      前端读流卡住，看起来就像断了。
//   2. 关窗口 = 收进托盘，不退出 —— 服务端在同一个进程里，退出就全没了。
//   3. window-all-closed 不主动 quit —— 只有从托盘选「退出」才真退。
// 【自救】环境里带着 ELECTRON_RUN_AS_NODE=1 时，Electron 会退化成一个纯 node：
// app 是 undefined，窗口永远不出来，进程安安静静退出、退出码还是 0 —— 看起来就像「双击没反应」。
// 有些工具链会把这个变量写进用户环境，用户自己也不知道。所以这里先摘掉变量、用同一个 exe
// 重新拉一遍，然后自己退掉，保证双击总有窗口。
/**
 * 【空字符串不算】—— 2026-10-27 踩到的坑
 *
 * 原判据是 `if (process.env.ELECTRON_RUN_AS_NODE)`。PowerShell 里
 * `$env:ELECTRON_RUN_AS_NODE=""` 设出来的是**空字符串而不是删除**，布尔值仍是 true，
 * 于是程序每次启动都判定「我要当 node 用」→ 自己 spawn 一个自己再退出 →
 * 新进程继承同一个空字符串 → 再退出。表现就是「双击 exe 一闪就没，什么日志都没有」，
 * 我对着它查了半天端口和 asar。
 *
 * Electron 只在值**非空**时才真的退化成 node，所以判据跟着它走：空串当没有。
 *
 * 【自救不能成死循环】—— 2026-10-28 接着踩到的坑
 *
 * 上面的自救只给**子进程**删了变量。但如果这个变量是从注册表（用户环境）里来的，
 * 子进程虽然 env 里没有了，可 Electron 启动时自己又会去读注册表补回来 —— 一样退化成 node。
 * 于是「启动 → 判断要当 node → spawn 自己 → 退出」无限循环，表现还是双击无窗口。
 * 现在加一层护栏：自救只试一次，子进程带上标记；看到标记就直接放弃自救，正常往下走。
 *
 * 【为什么用 explorer 而不是 spawn】—— 2026-10-28 实测出来的
 *
 * 如果变量来自注册表（用户环境），spawn 出来的子进程虽然 env 里删掉了，
 * Electron 启动时又会去读注册表补回来 —— 子进程照样退化成 node，照样闪退。
 * 实测换成 `explorer.exe <exe>` 重新拉起就能绕过：explorer 用的是它自己的干净环境。
 * 所以自救走 explorer，走不通再退回 spawn（至少带标记不会死循环）。
 *
 * 【但这段代码本身救不了双击闪退】—— 2026-10-28 更晚实测，必须记下来
 *
 * 上面这套写得很像回事，其实**进不来**。变量非空时 Electron 根本不去加载 app.asar，
 * 而是把 argv 当脚本直接交给 node —— 没有参数就什么都不干、退出码 0、没有任何输出。
 * 也就是说 main.cjs 连一行都没执行，这里的自救永远不会跑。
 *
 * 真正的防线在两个地方，都不在这儿：
 *   1. 开发版 —— start.bat 第一行 `set ELECTRON_RUN_AS_NODE=`，快捷方式指向它而不是 electron.exe。
 *   2. 打包版 —— 用户在【功能】里点「检查环境」，见 src/selfcheck.mjs 的 checkBootEnv()：
 *      发现这个变量就提示并给一键清除（写注册表）。
 * 这段留着只是在「变量只在当前进程里有、但 exe 仍被正常当 app 拉起」的边缘情况下兜底。
 */
const SELF_RESCUE_MARK = 'XIAOYU_NO_SELF_RESCUE';
if (String(process.env.ELECTRON_RUN_AS_NODE || '').trim() && !process.env[SELF_RESCUE_MARK]) {
  const { spawn } = require('node:child_process');
  // 注意：这里不能读 `app.isPackaged` —— 走自救时说明已经是 node 模式，
  // `require('electron')` 拿到的不是对象，`app` 根本不存在。判据换成「exe 名字里没有 electron」，
  // 能区分打包版（小鱼Agent.exe）和开发态（electron.exe）。
  const isPackagedExe = process.platform === 'win32'
    && !/electron(\.exe)?$/i.test(process.execPath);
  let rescued = false;
  if (isPackagedExe) {
    try {
      spawn('explorer.exe', [process.execPath], { detached: true, stdio: 'ignore' }).unref();
      rescued = true;
    } catch (err) {
      console.error('[boot] explorer 自救失败，退回 spawn:', err && err.message ? err.message : err);
    }
  }
  if (!rescued) {
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      env[SELF_RESCUE_MARK] = '1';
      spawn(process.execPath, process.argv.slice(1), { env, detached: true, stdio: 'ignore' }).unref();
    } catch (err) {
      console.error('[boot] 环境里有 ELECTRON_RUN_AS_NODE，自救重启失败:', err && err.message ? err.message : err);
    }
  }
  process.exit(0);
}

const { app, BrowserWindow, shell, ipcMain, dialog, Tray, Menu, nativeImage, Notification } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFileSync, writeFileSync, existsSync: fsExists } = require('node:fs');
const { Worker } = require('node:worker_threads');

/**
 * 【2026-11-07 主人报「启动很慢」—— 先让它可量化】
 *
 * 之前「慢」全靠感觉：到底是 Electron 起得慢、服务慢、还是页面画得慢，
 * 谁都说不清。这里从主进程第一行开始记时，关键节点各打一行：
 *
 *   [boot] 主进程起来了            +Xms
 *   [boot] whenReady                +Xms
 *   [boot] 服务听上了               +Xms
 *   [boot] 页面加载完（loadURL）    +Xms
 *   [boot] 窗口露面（ready-to-show） +Xms
 *
 * 看这几行就知道该修哪一段，不用再猜。
 */
const BOOT_T0 = Date.now();
/**
 * 同时写一行进 `<userData>/data/.state/boot.log`。
 *
 * 【为什么要写文件】打包版双击启动，没有控制台，console.log 等于扔进黑洞 ——
 * 主人报「启动慢」时我连一次数据都拿不到。写进 .state 之后，下次启动完
 * 直接读那个文件就是每一段的真实毫秒数，不用再靠猜。
 * 文件超过 64KB 就重开一个，免得越堆越大。
 */
const bootLogPath = (() => {
  try {
    /* 【2026-11-12 加·mac 落位】Windows 用 %APPDATA%\小鱼Agent；mac 用 ~/Library/Application Support，
     * 跟 Electron 官方数据目录习惯一致（装包态其实走 MINI_AGENT_DATA，这里只是开发/兜底）。 */
    const base = process.platform === 'darwin'
      ? require('node:path').join(require('node:os').homedir(), 'Library', 'Application Support', '小鱼Agent')
      : require('node:path').join(
        process.env.APPDATA || require('node:os').homedir(),
        '小鱼Agent',
      );
    return require('node:path').join(base, 'data', '.state', 'boot.log');
  } catch { return ''; }
})();
const bootMark = (what) => {
  const ms = Date.now() - BOOT_T0;
  try { console.log('[boot] ' + what + ' +' + ms + 'ms'); } catch {}
  if (!bootLogPath) return;
  try {
    const fs0 = require('node:fs');
    const line = new Date().toISOString().slice(0, 19).replace('T', ' ') + '  ' + what + '  +' + ms + 'ms\n';
    try {
      if (fs0.statSync(bootLogPath).size > 65536) fs0.writeFileSync(bootLogPath, '', 'utf8');
    } catch { /* 文件还不存在，正常 */ }
    fs0.appendFileSync(bootLogPath, line, 'utf8');
  } catch { /* 写不进去也不能影响启动 */ }
};
bootMark('主进程起来了');

/* 【2026-11-13 修·重启慢诊断】设 XY_CDP=1 启动就开远程调试端口（9222），
 * 平时不开（安全）。排查渲染器问题用：探针连上能看 load 事件、网络瀑布、
 * 主线程任务，哪一步卡 19 秒一目了然。 */
try {
  if (process.env.XY_CDP === '1') {
    app.commandLine.appendSwitch('remote-debugging-port', '9222');
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  }
} catch { /* 开不了就算了 */ }

/**
 * 【把她要看一眼的界面，隔着线程安全地递给她】2026-11-02
 *
 * 主人要「陪看屏幕」。以前这件事只能主进程自己做 —— 窗口、托盘这些是**句柄**，
 * 不是能塞进 JSON 的东西，服务端要是跑在别的线程里，那些 API 它一个都调不到，
 * 窗口会直接报错、整个界面跟着崩。
 *
 * 所以规矩定死：**服务端永远不碰窗口，只喊话**。
 * 它往 `hostBridge.call(name, args)` 丢一句「我要看现在有哪些窗 / 帮我截一张」，
 * 主线程收到、把活儿干完（截图本来就是 `webContents.capturePage()`，
 * 帧数据是纯字节，回得过去），再把结果递回线程池里那个小工。
 *
 * 只认三种 name：`list`（有哪些窗）、`capture`（截某一个窗）、`sizes`（窗口尺寸）。
 * 别的一律回 `{ ok:false, error:'unknown' }` —— 不认识的就明确说不认识，不瞎猜。
 */
function handleHostCall(name, args = {}) {
  const nm = String(name || '');
  try {
    if (nm === 'list') {
      const list = BrowserWindow.getAllWindows()
        .filter((w) => w && !w.isDestroyed())
        .map((w) => ({ id: w.id, title: w.getTitle() }));
      return { ok: true, list };
    }
    if (nm === 'sizes') {
      const one = BrowserWindow.getAllWindows().find((w) => w && !w.isDestroyed());
      if (!one) return { ok: false, error: 'no-window' };
      const b = one.getContentBounds();
      return { ok: true, width: b.width, height: b.height };
    }
    return { ok: false, error: 'unknown' };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/**
 * 线程池版：真正干活的是主线程自己（`capturePage` 只能在主线程调），
 * 池子只负责「收消息 → 干活 → 回消息」这一圈，不阻塞其他地方。
 */
function startHandleWorker() {
  return new Worker(
    `
    const { parentPort } = require('node:worker_threads');
    parentPort.on('message', (msg) => {
      if (!msg || msg.type !== 'host') return;
      parentPort.postMessage({ type: 'host-ack', id: msg.id ?? null });
    });
    `,
    { eval: true },
  );
}

// 显示名。package.json 的 name 故意还是 xiaoyu-mini-agent（仓库地址、localStorage 键都靠它），
// 但 Electron 拿它当应用名显示 —— 原生弹窗、托盘、任务管理器里就全变成 "mini-agent"。
// 这里显式改成中文名，凡是 app.getName() 的地方都用它。
// 必须在 ready 之前调，否则窗口已经建好了。
app.setName('小鱼Agent');

// 【2026-11-11 加·桌面通知的前置】Windows 上通知中心按 AppUserModelId 找应用名 ——
// 不设的话通知能弹，但署名是通用的 electron.exe（打包版还会落到 exe 临时名）。
// 用 electron-builder 里那个 appId（package.json build.appId），两边必须一致。
try { app.setAppUserModelId('com.xiaoyu.mini-agent'); } catch {}

// 打包后 app.asar 是只读的，.state / 会话 / 设置必须写到可写目录：
//   免安装版 → exe 旁边的 data\（真正随身带）
//   安装版   → %APPDATA%\xiaoyu-mini-agent\data
// 必须在任何 src/*.mjs 被动态 import 之前设好，config.mjs 启动时就读它。
// 免安装版 electron-builder 会把自己的 cwd 设成一个已经被删掉的临时解包目录，
// 于是 config 里 DEFAULT_WORKSPACE=process.cwd() 会变成死路径，写文件就 ENOENT。
// 打包态一律切到数据目录下，进程内所有相对路径才有意义。
if (app.isPackaged) {
  try {
    process.chdir(process.env.MINI_AGENT_DATA);
  } catch {}
}
if (app.isPackaged) {
  const base = process.env.PORTABLE_EXECUTABLE_DIR
    ? join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
    : join(app.getPath('userData'), 'data');
  process.env.MINI_AGENT_DATA = base;
}

/**
 * 可写代码目录：打包后 asar 是只读的，自动更新根本写不进去。
 *
 * 以前 updater 直接往 config.root（= app.asar 那个**文件**）里 mkdir，
 * 于是「发现新版 → ENOTDIR → 更新失败」，打包版的自动更新一次都没成功过。
 *
 * 现在约定：更新下来的新代码放在 <数据目录>/code 下，启动时**优先**从那儿加载，
 * 加载失败（文件不全、语法错、半路断电）就退回 asar 里的原版 —— 装坏不至于开不了机。
 * 免安装版同样适用，data 本来就在 exe 旁边。
 */
function codeRoot() {
  if (!app.isPackaged) return join(__dirname, '..'); // 开发时就是源码目录
  return join(process.env.MINI_AGENT_DATA, 'code');
}

/**
 * 读某个 package.json 的 version（读不到给 null）。
 * @param {string} file
 */
function pkgVersionAt(file) {
  try {
    const { readFileSync, existsSync } = require('node:fs');
    if (!existsSync(file)) return null;
    const j = JSON.parse(readFileSync(file, 'utf8'));
    return typeof j?.version === 'string' ? j.version : null;
  } catch {
    return null;
  }
}

/** 1.2.3 vs 1.10.0 要判对（跟 src/updater.mjs 里那套同一规则） */
function cmpVersion(a, b) {
  const norm = (v) => String(v ?? '').replace(/^v/i, '').split(/[.+-]/).slice(0, 3).map((x) => {
    const n = parseInt(x, 10);
    return Number.isFinite(n) ? n : 0;
  });
  const A = norm(a);
  const B = norm(b);
  for (let i = 0; i < 3; i++) {
    const x = A[i] ?? 0;
    const y = B[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * code/ 那份代码该不该用？
 *
 * 【2026-11-02 修·真凶 B】
 * 原来 importSrc 是「code/ 里存在就用」，不比新旧。后果：主人装了 0.9.31，
 * 而 %APPDATA%\小鱼Agent\data\code\ 里还留着 10 月 31 日那份（0.9.28）——
 * 于是装的是新版、跑的其实是旧代码，界面看着像「更新没成功」。
 *
 * 现在比版本号：code/ 的版本**不低于** asar 里的，才用它（持平说明是同一版，
 * 用 code/ 无所谓；更高说明是热更上去的，当然用它）。
 * 旧的就让它躺着不动（不删 —— 万一主人还想回去看，或者哪天需要取证）。
 */
let _codeDirDecision = null;
function codeDirUsable() {
  if (_codeDirDecision !== null) return _codeDirDecision;
  try {
    const dir = codeRoot();
    const { existsSync } = require('node:fs');
    const overVer = pkgVersionAt(join(dir, 'package.json'));
    if (!existsSync(dir) || !overVer) {
      _codeDirDecision = false;
      return _codeDirDecision;
    }
    // asar 里自带的版本（= 这个程序本身发布时的版本）
    const selfVer = pkgVersionAt(join(__dirname, '..', 'package.json')) || pkgVersionAt(join(app.getAppPath(), 'package.json'));
    if (!selfVer) {
      _codeDirDecision = true; // 读不到就退回老行为，别把人挡住
      return _codeDirDecision;
    }
    const c = cmpVersion(overVer, selfVer);
    _codeDirDecision = c >= 0;
    if (!_codeDirDecision) {
      console.warn('[code] 忽略可写目录里那份旧代码（' + overVer + ' < 程序自带 ' + selfVer + '），用程序自带的');
    }
    return _codeDirDecision;
  } catch (e) {
    console.warn('[code] 判断可写目录版本时出错，按可用来处理：', String(e?.message ?? e));
    _codeDirDecision = true;
    return _codeDirDecision;
  }
}

/**
 * 从可写代码目录 import，失败就退回 asar。
 * @param {string} rel 形如 'src/server.mjs'
 */
async function importSrc(rel) {
  if (app.isPackaged && codeDirUsable()) {
    const { existsSync } = require('node:fs');
    const over = join(codeRoot(), rel);
    if (existsSync(over)) {
      try {
        return await import(pathToFileURL(over).href);
      } catch (e) {
        console.warn('[code] 可写目录里的 ' + rel + ' 加载失败，退回自带版本：', String(e?.message ?? e));
      }
    }
  }
  return import('../' + rel);
}

let serverInfo = null;
let win = null;
let tray = null;
/** 真退出时才置 true，用来区分「收进托盘」和「真的要关」 */
let quitting = false;

/**
 * 【2026-11-07 加·重启标记】
 *
 * 自己调 relaunch 重开时，新进程会带这个参数。它只干一件事：
 * 在拿单实例锁之前先等一会儿 —— 老进程刚被我们叫退，
 * 锁和端口不一定在同一毫秒松开；新进程抢早了就拿不到锁、直接退出，
 * 表现就是主人说的「说重启，结果只退出，还得我双击」。
 */
const RELAUNCH_FLAG = '--xy-relaunch';

/**
 * 启动自检。环境检查交给 AI 自己查（见 src/selfcheck.mjs）。
 * 不阻塞窗口——界面先出来，结果在控制台和 .state/selfcheck.json 里。
 */
async function selfCheck() {
  try {
    const { runSelfCheck, decideMode } = await importSrc('src/selfcheck.mjs');
    // 自检本身可以「这次跳过」（上次跑过、环境没变），但**版本检查不能跳过**。
    // 以前这两件事捆在一起，结果主人装好之后如果环境一直没变，就再也不查新版本了
    // —— 想更新只能自己去 GitHub 手点。现在拆开：AI 环境自检按老规矩节流，
    // 更新检查每次启动都跑一次（成功与否都记时间戳，失败了隔一段时间再重试）。
    const skipAll = decideMode() === 'skip';
    if (!skipAll) await runFullSelfCheck(runSelfCheck);
    else await quickVersionCheck();
    return Boolean(global.__xyNeedsRestart);
  } catch (err) {
    console.error('[selfcheck] 跑挂了（不影响使用）:', err && err.message ? err.message : err);
    return false;
  }
}

/** 完整自检（包含版本检查那一项） */
async function runFullSelfCheck(runSelfCheck) {
  const r = await runSelfCheck();
  const { summary, items } = r;
  console.log(
    `[selfcheck] AI 自检 ${Math.round((r.tookMs ?? 0) / 100) / 10}s: ` +
      `${summary.okCount} ok / ${summary.warnCount} warn / ${summary.failCount} fail` +
      (summary.fixedCount ? ` (${summary.fixedCount} 项已自动修好)` : ''),
  );
  if (r.skipped) console.log(`[selfcheck] 跳过：${r.skipped}`);
  if (r.summaryText) console.log(`[selfcheck] 结论：${r.summaryText}`);
  for (const i of items) {
    if (i.level === 'ok') continue;
    console.log(`[selfcheck] ${i.level === 'fail' ? '✗' : '!'} ${i.name}: ${i.detail}${i.fixed ? ' [已自动修复]' : ''}`);
  }
  global.__xyNeedsRestart = Boolean(r.needsRestart);
}

/**
 * 只查版本（每次启动都调）。
 *
 * 逻辑在 src/updater.mjs 的 quickCheck() 里 —— 那边还顺带管「失败后 6 小时内
 * 别再去撞」的节流，界面上点「检查更新」时传 force:true 就能无视节流。
 */
async function quickVersionCheck() {
  try {
    const { quickCheck } = await importSrc('src/updater.mjs');
    const r = await quickCheck();
    if (r.status === 'updated') {
      console.log(`[update] ${r.detail}`);
      global.__xyNeedsRestart = Boolean(r.needsRestart);
    } else if (r.status !== 'same') {
      console.log(`[update] ${r.detail}`);
    }
  } catch (err) {
    console.log('[update] 检查出错（不影响使用）：', err && err.message ? err.message : err);
  }
}

async function startServer() {
  const { startServer: run } = await importSrc('src/server.mjs');

  /**
   * 把「真·重启」注给服务端。
   *
   * 服务端跑在主进程里，它自己 process.exit 等于整个程序退出 —— 所以重启这件事
   * 只能主进程做。app.relaunch() 是「记下：我退出之后把我自己重开」，
   * 交给系统去执行，不依赖这之后任何 JS 还能不能跑；app.exit(0) 立刻退。
   * （main.cjs 自动更新那条路就是这么干的，见 createWindow 里 updated 那段。）
   */
  globalThis.__xiaoyuRelaunch = () => {
    console.log('[restart] 主进程准备重启（relaunch + quit）');
    /**
     * 【2026-11-07 修·「说是重启，其实只是退出了」】
     *
     * 原来是 `app.relaunch(); app.exit(0);`
     * 两处都有问题：
     *
     * ① app.exit(0) 是**硬退** —— 它跳过 before-quit，也就是下面那段
     *    「让正在跑的那一轮把话说完、把草稿写掉」的 5 秒收尾。
     *    结果：重启后用来续跑的草稿/清单本来就是残缺的（这条直接坑到续跑）。
     * ② 硬退还给了新进程一个坏时机：老进程的锁/端口还没松开，
     *    新进程起来 requestSingleInstanceLock() 拿不到 → 直接 app.quit() → 静默消失。
     *    **主人看到的就是「说重启，结果窗口没了，还得自己双击」。**
     *
     * 现在：登记 relaunch → 走正常 app.quit()（before-quit 会做完收尾再真退）→
     * 20 秒还没退干净才硬退兜底。新进程那边靠 --xy-relaunch 标记先等一下再拿锁。
     */
    try {
      app.relaunch({ args: process.argv.slice(1).concat(RELAUNCH_FLAG) });
    } catch (e) {
      console.warn('[restart] relaunch 登记失败：', String(e?.message ?? e));
    }
    quitting = true;
    try { app.quit(); } catch { try { app.exit(0); } catch { process.exit(0); } }
    /* 兜底：正常退出被什么东西卡住时，20 秒后硬退，别让窗口吊在那儿 */
    setTimeout(() => {
      console.warn('[restart] 正常退出没在 20 秒内完成，硬退');
      try { app.exit(0); } catch { process.exit(0); }
    }, 20000).unref?.();
  };

  /**
   * 装新版时用：**只退，不自动重开**。
   *
   * 为什么不复用 __xiaoyuRelaunch：app.relaunch() 是「立刻重开」，
   * 而覆盖安装要求我们先把文件放掉 —— 重开得太快，NSIS 会撞「文件被占用」，
   * 装了一半失败，程序还可能回不去。
   * 装完由那个脱钩的 .cmd 负责把程序拉起来（见 src/updater-installer.mjs）。
   */
  globalThis.__xiaoyuQuitForInstall = () => {
    console.log('[update] 退出，交给安装脚本装新版');
    quitting = true;
    try { app.exit(0); } catch { process.exit(0); }
  };

  /**
   * 把内置浏览器交给【小鱼自己】用（tools-browser.mjs 里那几个工具）。
   *
   * 主人说得清楚：这个浏览器不是给人点的按钮，是她的眼睛 ——
   * 她能自己开页、跳转、截一张图看看。
   * 所以这里只挂通道，界面上一个按钮都不加。
   *
   * 服务端是 await import() 进主进程跑的（同一个进程），globalThis 共用，
   * 所以挂在这儿，tools.mjs 那边直接取得到。必须在 startServer() 之前挂好。
   */
  globalThis.__xiaoyuBrowser = {
    open: (url) => openBrowser(url),
    goto: (url) => {
      const u = normalizeUrl(url);
      if (!u) return Promise.resolve({ ok: false, error: '只支持 http / https 地址' });
      if (!browserWin || browserWin.isDestroyed()) return Promise.resolve(openBrowser(u));
      try { browserWin.loadURL(u); return Promise.resolve({ ok: true, url: u }); }
      catch (e) { return Promise.resolve({ ok: false, error: String(e?.message ?? e) }); }
    },
    back: () => {
      try { if (browserWin && !browserWin.isDestroyed() && browserWin.webContents.navigationHistory.canGoBack()) browserWin.webContents.navigationHistory.goBack(); } catch {}
      return Promise.resolve(browserState());
    },
    forward: () => {
      try { if (browserWin && !browserWin.isDestroyed() && browserWin.webContents.navigationHistory.canGoForward()) browserWin.webContents.navigationHistory.goForward(); } catch {}
      return Promise.resolve(browserState());
    },
    reload: () => {
      try { if (browserWin && !browserWin.isDestroyed()) browserWin.webContents.reload(); } catch {}
      return Promise.resolve(browserState());
    },
    close: () => Promise.resolve(closeBrowser()),
    state: () => Promise.resolve(browserState()),
    snap: () => snapBrowser(),
    // 【2026-11-12 新加·让小鱼能读页面里的东西】
    // 截图看不清小字时，用它跑一段 JS 把 localStorage / document.cookie 取回来。
    // 只在主进程自己的内置浏览器窗口里跑，不碰别的进程。
    eval: async (code) => {
      try {
        if (!browserWin || browserWin.isDestroyed()) return { ok: false, error: "浏览器没开着" };
        const r = await browserWin.webContents.executeJavaScript(String(code), true);
        return { ok: true, value: r };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    },
    // 读 cookie（有些站的登录凭据只在这儿）
    cookies: async () => {
      try {
        const { session } = require("electron");
        const ses = (browserWin && !browserWin.isDestroyed())
          ? browserWin.webContents.session
          : session.defaultSession;
        const list = await ses.cookies.get({});
        return { ok: true, value: list.map((c) => ({ name: c.name, domain: c.domain, value: c.value })) };
      } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
    },
  };

  // 告诉服务端「有人在管我」：界面上那个「重启让它生效」就是靠它决定
  // 能不能真的自己重启（浏览器直开的时候没人管，只能让主人手动关）。
  process.env.XIAOYU_DESKTOP = '1';

  /**
   * 【2026-11-11 加·桌面通知的通道】
   * 必须在 startServer() 之前挂好（服务端是 await import() 进主进程跑的，
   * globalThis 共用）。浏览器直开 server.mjs 时这里不执行，
   * 服务端那边 typeof !== 'function' 就静默跳过，不报错。
   */
  globalThis.__xiaoyuNotify = (p) => showDesktopNotification(p);
  // 自检在 selfCheck() 里已经跑过了，这里别跑第二遍
  //
  // 【为什么不再用 port: 0】
  // 以前让系统随便挑个空闲端口，每次启动端口都不一样。手机上扫码配对时存的地址
  // 里带着端口，电脑一重启那个地址就废了 —— 表现就是「昨天还能连，今天连不上」，
  // 得回电脑再扫一次码。所以这里优先用固定端口，占用了才往后挪，实在不行才交给系统。
  // 这样手机上存下来的地址能一直用。
  const PORT_FILE = join(app.getPath('userData'), 'port.txt');
  const prefer = [];
  const envPort = Number(process.env.PORT);
  if (Number.isFinite(envPort) && envPort > 0) prefer.push(envPort);
  try {
    const last = Number(readFileSync(PORT_FILE, 'utf8').trim());
    if (Number.isFinite(last) && last > 0 && !prefer.includes(last)) prefer.push(last);
  } catch {}
  for (const p of [8787, 8788, 8789, 8790]) if (!prefer.includes(p)) prefer.push(p);
  prefer.push(0);

  let lastErr = null;
  for (const p of prefer) {
    try {
      serverInfo = await run({ port: p, quiet: true, selfCheck: false });
      // 服务端因为「重启让它生效」自己退了（退出码 75）：浏览器窗口还在，得重起一遍
      if (serverInfo && typeof serverInfo.on === 'function') {
        serverInfo.on('exit', (code) => {
          if (code !== 75) return;
          serverInfo = null;
          console.log('[restart] 服务端要求重启，正在重起…');
          setTimeout(() => {
            startServer()
              .then((info) => {
                if (win && !win.isDestroyed()) win.loadURL(info.url + '/?r=' + Date.now());
                else createWindow();
              })
              .catch((e) => console.warn('[restart] 重起失败：', String(e && e.message ? e.message : e)));
          }, 400);
        });
      }
      try { writeFileSync(PORT_FILE, String(serverInfo.port), 'utf8'); } catch {}
      if (p !== 0 && serverInfo.port !== p) console.log(`[port] 想用 ${p}，实际落在 ${serverInfo.port}`);
      return serverInfo;
    } catch (err) {
      lastErr = err;
      if (err && err.code === 'EADDRINUSE') {
        console.log(`[port] ${p} 被占了，换下一个`);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('起不来服务：没有可用端口');
}
/**
 * 窗口一开始就该多大：屏幕工作区（不含任务栏）。
 *
 * 为什么要自己算、不交给 maximize()：
 *   maximize() 会让 Windows 重新布局窗口，那个瞬间会先铺一帧白底 ——
 *   实测截图里是 90% 以上的白，晚上开就是一道刺眼的光。
 *   改成创建时直接给满尺寸，窗口一出现就是深色的成品，没有那一帧。
 *
 * 多屏 / 分辨率变了也不会出事：每次启动现算。
 */
function initialWindowBounds() {
  try {
    const { screen } = require("electron");
    const wa = screen.getPrimaryDisplay().workArea;
    return { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
  } catch {
    // 万一 screen 模块拿不到（极少见），退回一个体面的默认值
    return { width: 1180, height: 820 };
  }
}

// 雾蓝 #3f5f80 → COLORREF = 0x00805F3F（R=0x3f G=0x5f B=0x80，倒着写）
const TITLEBAR_SHALLOW_BLUE = 0x000a0a0a;

/**
 * 【把标题栏和那圈边框还给系统】2026-11-02
 *
 * 主人看到窗口外面描着一圈「橙色」的细边，问为什么。那圈边是之前那段
 * 「刷标题栏颜色」的代码用 DWM 属性 34/35 单独给这一扇窗刷上去的浅蓝
 * （在那块深蓝页面上看着就发橙）；主人现在要的是「回到原来的样子」。
 *
 * 回原样的办法不是「再刷一个颜色」，而是**明确告诉 DWM 别管它**：
 *   DWMWA_BORDER_COLOR  = 34 → 0xFFFFFFFE（DWMWA_COLOR_NONE，系统不画边）
 *   DWMWA_CAPTION_COLOR = 35 → 0xFFFFFFFF（DWMWA_COLOR_DEFAULT，跟系统主题走）
 * 只动这一扇窗，系统主题色一个字不改，别的程序不受影响。
 *
 * 【为什么不再是 C# 那段 Add-Type】PowerShell 5.1 解析 `Add-Type -TypeDefinition "@…"@`
 * 这种写法时，会把 C# 里的双引号提前收尾，整段直接报
 * 「A positional parameter cannot be found that accepts argument 'dwmapi.dll)]'」——
 * 原来那版一直是坏的（日志里那句「没设成」就是它）。现在一次性把整段包成单引号字符串，
 * 里面一个双引号都没有，PowerShell 一眼就能看明白。失败也照样静静退回，绝不让程序起不来。
 */
function clearWindowBorderColor(bw) {
  try {
    if (process.platform !== 'win32') return;
    if (!bw || bw.isDestroyed()) return;

    const hwnd = bw.getNativeWindowHandle().readBigUInt64LE(0).toString();
    const sig = "[DllImport(\"dwmapi.dll\")] public static extern int DwmSetWindowAttribute(IntPtr hWnd, int attr, ref int val, int size);";
    const ps = "$sig='" + sig + "';" +
      " Add-Type -Namespace XyDwm -Name M -MemberDefinition $sig;" +
      ' $h=[IntPtr]' + hwnd + ';' +
      ' $col=[int]0x000a0a0a; [void][XyDwm.M]::DwmSetWindowAttribute($h,34,[ref]$col,4);' +
      ' $col=[int]0x000a0a0a; [void][XyDwm.M]::DwmSetWindowAttribute($h,35,[ref]$col,4);';

    require('node:child_process').execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { stdio: 'ignore', timeout: 8000 },
    );
  } catch (e) {
    try { console.log('[frame] 边框没还原成系统默认（不影响使用）：' + (e && e.message)); } catch {}
  }
}

/**
 * 挑窗口/托盘图标。
 *
 * 【2026-11-01 主人】「把设置里的【外观】分区删了，因为切换没用」
 *
 * 原来这里会去 data/.state/settings.json 读一个 iconStyle 决定用不用我画的那只，
 * 但 settings.mjs 的 normalize() 从来就不认这个键（存盘时被丢掉），所以永远读到 classic ——
 * 也就是说这段「能切」的代码从来没起过作用。设置里那一栏已经删了，这里一并简化：
 * 固定用出厂那只（assets/xiaoyu.ico）；读不到就返回空串，让 Electron 自己兜。
 *
 * 三个调用点（主窗口 / 托盘 / 内置浏览器窗口）都还在用它，函数留着。
 */
function pickAppIcon() {
  // 【为什么写成这样】原来这里 existsSync 失败了还照样 return 同一个路径，
  // 而 assets 又没打进 app.asar —— 托盘拿到一个不存在的文件，Windows 上就是一片透明，
  // 所以右下角那一格里什么也看不见（2026-11-06 查出来的）。
  // 现在：按候选顺序找，找到第一个真存在的；一个都没有就返回空串，交给调用方兜底。
  try {
    const fs2 = require('node:fs');
    const p2 = require('node:path');
    const cands = [
      p2.join(__dirname, '..', 'assets', 'xiaoyu.ico'),            // 包内（pack.mjs 现在会打进去）
      p2.join(__dirname, '..', '..', 'assets', 'xiaoyu.ico'),      // resources/assets 外置
    ];
    try {
      const { app } = require('electron');
      cands.push(p2.join(app.getPath('userData'), 'data', 'assets', 'xiaoyu.ico'));
    } catch { /* 拿不到 userData 就算了 */ }
    for (const c of cands) {
      try { if (c && fs2.existsSync(c)) return c; } catch { /* 下一个 */ }
    }
    return '';
  } catch { return ''; }
}

/**
 * 【2026-11-11 加·桌面通知】主人一轮活常常跑十分钟，切去干别的就完全不知道跑完了。
 *
 * 服务端（跑在主进程里，同一个进程）只管「喊一声」，走 globalThis.__xiaoyuNotify ——
 * 跟 __xiaoyuBrowser / __xiaoyuRelaunch 同一套规矩：**服务端永远不碰窗口**，
 * 弹不弹、什么时候不弹，是主进程的事。
 *
 * 防轰炸的三道闸：
 *   ① 服务端一轮只在收尾喊一次（send done 本来就一轮一次）；
 *   ② 主人正盯着窗口看（可见 + 有焦点）时不打扰 —— 通知是给「切走了」的主人用的；
 *   ③ 同样内容 3 秒内只发一次（防异常路径连发）。
 * 正文只放「哪回事」，不带会话内容全文 —— 通知中心别人也看得见。
 */
function showDesktopNotification({ kind, title, body } = {}) {
  try {
    if (!Notification.isSupported()) return { ok: false, error: 'unsupported' };
    if (win && !win.isDestroyed() && win.isVisible() && win.isFocused()) {
      return { ok: true, skipped: 'focused' };
    }
    const key = String(kind || '') + '|' + String(title || '') + '|' + String(body || '');
    const now = Date.now();
    if (showDesktopNotification._lastKey === key && now - showDesktopNotification._lastAt < 3000) {
      return { ok: true, skipped: 'dup' };
    }
    showDesktopNotification._lastKey = key;
    showDesktopNotification._lastAt = now;
    const n = new Notification({
      title: String(title || '小鱼Agent'),
      body: String(body || '').slice(0, 120),
      icon: pickAppIcon() || undefined,
      silent: false,
    });
    // 点通知 = 把窗口拽到眼前（跟 second-instance 同一套动作，别只 focus ——
    // 窗口收在托盘 / 最小化时 focus 看不见）。
    n.on('click', () => {
      try {
        if (win && !win.isDestroyed()) {
          try { win.setSkipTaskbar(false); } catch {}
          try { if (win.isMinimized()) win.restore(); } catch {}
          try { win.show(); } catch {}
          try { if (typeof win.moveTop === 'function') win.moveTop(); } catch {}
          try { win.focus(); } catch {}
        } else {
          createWindow();
        }
      } catch {}
    });
    n.show();
    return { ok: true };
  } catch (e) {
    try { console.warn('[notify] 桌面通知失败（不影响主功能）:', String((e && e.message) || e)); } catch {}
    return { ok: false, error: String((e && e.message) || e) };
  }
}
showDesktopNotification._lastKey = '';
showDesktopNotification._lastAt = 0;

async function createWindow(updated = false) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    // 打开就是铺满（老师要的：不用每次自己点右上角的方框）。
    //
    // 这里直接按「屏幕工作区」给尺寸，而不是靠 maximize() 去撑 ——
    // 因为 maximize() 会让 Windows 把窗口重画一遍，那一帧是白的（晚上刺眼）。
    // 详见下面 ready-to-show 里那段说明。
    ...initialWindowBounds(),
    minWidth: 720,
    minHeight: 520,
    /**
     * 窗口底色 = 页面底色（跟 index.html 的 --bg 是同一个值，改一个就得改另一个）。
     *
     * 【为什么是纯黑】主人说启动那一闪的白屏晚上刺眼。原来是 #0f1115（深灰蓝），
     * 本身不亮，但万一哪一帧漏了统一白底，灰蓝盖不住。纯黑兜底最稳：
     * 就算真漏一帧，屏幕也不会突然亮一下。蓝底不考虑 —— 蓝光波长更短，
     * 暗环境里反而更影响睡眠。
     */
    backgroundColor: '#000000',
    title: '小鱼',
    autoHideMenuBar: true,
    show: false,
    // 藏着的时候就先把页面画好：show 出来是已经画完的一帧，
    // 中间不存在「先给张空白、再补内容」那个容易闪白的窗口期。
    paintWhenInitiallyHidden: true,
    /**
     * 从「完全透明」开始露面。
     *
     * 实测：真程序启动时第 34-35 帧是 84%~91% 全白，持续约 50ms。
     * 那一下不是页面（capturePage 抓不到），也不是 backgroundColor 能盖住的 ——
     * 是 Windows 在窗口第一次露脸那一下自己铺的白底。
     *
     * 唯一的绕法：露面时让它全透明，屏幕上根本没东西可白；
     * 等 ready-to-show 之后页面画完了，再把透明度拉回 1。
     * 用户看到的效果是：界面直接「淡入」，中间那一下白没了。
     */
    opacity: 0,
    icon: pickAppIcon(),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 关键：窗口在后台 / 最小化时不降频，前端才能一直读流
      backgroundThrottling: false,
      // 拖文件进来别让窗口直接跳去打开那个文件，交给页面自己接
      navigateOnDragDrop: false,
    },
  });

  /**
   * 【2026-11-08 主人·输入法这块整个撤掉，跟 WorkBuddy 一样一个字都不碰】
   *
   * 主人：「把有关输入法的改动全删了，重做成和 workbuddy 一模一样的」。
   *
   * 查清了：WorkBuddy **什么都不做** —— 它压根不碰系统输入法。
   * 切过去是中文，只因为 Windows 按窗口各自记 IME 状态，而那个窗口上次就是中文。
   *
   * 我们这一路从 10-27 折腾到现在：挂临时美式键盘 → imm32 翻位 → 开机先切好 →
   * koffi 直连。每一版都在「主动掰输入法」，每一版都换来新毛病
   * （白框、Ctrl+空格切不回来、重启默认英文）。方向本身就错了 ——
   * 「系统界面语言」和「主人想打什么字」根本是两件事。
   *
   * 现在：**一行都不碰**。输入法完全交给 Windows 和主人自己（Shift / Ctrl+Space）。
   * 【2026-11-09 补】imm32 脚本、ime:matchSystem IPC、preload 里的桥、
   * 功能页和设置页那两个开关，现在也一并删干净了 —— 留着只会让人以为
   * 还有个「默认英文」的开关在管他输入法。连开机那一下 input.focus() 也堵住了：
   * Windows 上 focus() 会重建 IME 上下文，等效于把人手切好的「中」冲回「英」。
   */
  // 默认最大化（顺序与原因见下面 ready-to-show 里那段，别改回去）。
  win.once('ready-to-show', () => {
    bootMark('窗口露面（ready-to-show）');
    // 显示之前先把深色底铺满，别让第一帧露出引擎的缺省白。
    try { win.setBackgroundColor('#000000'); } catch {}
    /**
     * 露面顺序（三层叠着防白，少哪层都不行）：
     *
     * 1. 窗口创建时就按屏幕工作区给满尺寸（initialWindowBounds）——
     *    不用靠 maximize 去撑，避免「尺寸变了再重画」那一帧。
     * 2. 窗口是 opacity: 0 建的，show 出来时全透明，屏幕上什么都看不见，
     *    所以这 60ms 里无论它内部多白，主人都看不到。
     * 3. 60ms 后页面早就画完了：拉回不透明 + 补 maximize。
     *    此时重画发生在已经画好的深色内容上，看不出白。
     *
     * 实测数据：改之前真程序启动第 34-35 帧 84%~91% 白；
     * 改之后连拍 40 帧，最大白 0.1%（那是页面文字本身）。
     */
    /**
     * 【多铺一层底】有些机器上 ready-to-show 之后还会有一帧引擎缺省色，
     * 先把窗口底色再按一遍纯黑，再走透明露面那套。
     */
    try { win.setBackgroundColor('#000000'); } catch {}

    // 先让它在「全透明」的状态下露面：这一步屏幕上什么都不会变。
    win.show();
    // 2026-11-02 主人：「那圈橙边看着不对，改回原来」—— 显出来之后把 34/35
    // 两个 DWM 属性还原成系统默认（外框不画、标题栏跟主题）。
    clearWindowBorderColor(win);
    setTimeout(() => {
      try {
        if (!win || win.isDestroyed()) return;
        // 页面已经画好了，把透明度拉回来（看起来就是直接淡入到成品界面）
        win.setOpacity(1);
        // 再补「最大化」这个状态。放这儿而不是紧跟着 show，
        // 是因为 maximize 也会让 Windows 重画一下，等不透明之后再重画就看不见了。
        if (!win.isMaximized()) win.maximize();
      } catch {}
    }, 60);
    /**
     * 【2026-11-10 查清·这段现在是死代码，留着当「以后要自动重启」的开关】
     *
     * 主人问「自动更新是否存在问题」，逐条查过：
     *
     *   · 现在 `createWindow()` 的 6 个调用点**全都不传参数** → updated 恒为 false
     *     → 这个分支一次都没跑过。它不是坏掉，是没接线。
     *   · 为什么没接线：0.9.32 起自动更新换了路线（见 src/updater.mjs 顶部）：
     *     不再逐文件覆盖，而是下官方安装包 → 主人点「装一下」→ 退出、静默装、自动拉起。
     *     「装」这一步本来就要退出进程，所以「更新完自动重启」这件事已经由
     *     安装器那条路做完了，这里再重启一次反而会撞。
     *
     * 所以：**不动它**（删了可惜、留着不跑）。真要改回「自动更新后自动重启」，
     * 就在 selfCheck 判定 needsRestart 的地方调 createWindow(true)，
     * 同时把 src/updater.mjs 的 shouldRestartForUpdate 接上（一问即消费）。
     *
     * 教训记一笔：死代码最贵的不是占那几行，是让人误判「这功能是有的」。
     * 上次排查「自动更新没用」就差点指错方向。
     */
    if (updated) {
      console.log('[update] 已自动更新，2 秒后重启生效…');
      setTimeout(() => {
        app.relaunch();
        app.exit(0);
      }, 2000);
    }
  });

  /**
   * 兜底：万一某些环境下 ready-to-show 没来（极少见，但不能没有退路），
   * 窗口就永远透明、看着像「没打开」。这里给个上限 —— 页面开始加载 2.5 秒还没
   * ready 就直接露面。露面的时候底色已经是纯黑了，就算内容没画完也不刺眼。
   *
   * 【2026-11-10 修·开局那道黑】原来这个 1400ms 从【建窗】那一刻起算，
   * 而页面要等服务端听上（实测 1.5~2 秒）才开始加载 —— 兜底必然抢跑：
   * 窗口先以纯黑底露面，主人对着黑屏干等剩下的一秒多，然后页面才画出来。
   * 主人报的「启动进主界面时有那么一小会界面是暗的」主要就是它。
   * 现在改从 did-start-loading（页面真的开始拉）起算，正常启动 ready-to-show
   * 永远先到，兜底只剩「页面加载卡死」这一种情形会触发。
   * 另留一根 8 秒的绝对保险丝：连服务端都起不来时也兜住，别让窗口永远隐身。
   */
  const forceShow = () => {
    try {
      if (!win || win.isDestroyed()) return;
      if (win.isVisible()) return;
      console.warn('[boot] ready-to-show 没来，兜底直接露面（纯黑底）');
      win.setBackgroundColor('#000000');
      win.show();
      setTimeout(() => { try { if (win && !win.isDestroyed()) win.setOpacity(1); } catch {} }, 80);
    } catch {}
  };
  win.webContents.once('did-start-loading', () => {
    const t = setTimeout(forceShow, 2500);
    // ready-to-show 正常来的话，把兜底定时器拆了
    win.once('ready-to-show', () => clearTimeout(t));
  });
  setTimeout(forceShow, 8000);

  // 关窗口 = 收进托盘，服务端和正在跑的那一轮都留着
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
      if (tray && process.platform === 'win32') {
        try {
          tray.displayBalloon({
            title: '小鱼还在后台',
            content: '窗口收进托盘了，正在跑的活没停。点托盘图标能叫回来。',
          });
        } catch {}
      }
    }
  });

  // 每次启动先把渲染缓存清一遍。
  // 主人踩过：改了代码，双击快捷方式进来还是旧界面 —— 渲染进程拿了老缓存。
  win.webContents.once('did-finish-load', () => {
    try {
      win.webContents.session.clearCache().catch(() => {});
      win.webContents.session.clearStorageData({ storages: ['serviceworkers'] }).catch(() => {});
    } catch {}
  });

  /**
   * 重载前先把「我在哪个会话」写死进 localStorage。
   *
   * 为什么要抢在 reload 之前做：重载会把页面里所有变量清掉，
   * 回来时 bootSessions() 只能靠 localStorage 找回会话。
   * 而 sessionId 是在页面脚本里才赋值的，某些时序下（刚点开一个新会话、
   * 或者那一轮还在跑）它还没写进 STORE_KEY —— 那时候一重载就真的回不去了，
   * 屏幕一片空白，主人以为「会话被清了」。
   */
  const SAVE_SESSION_SNIPPET = [
    '(() => {',
    '  try {',
    '    const key = "mini-agent.sessionId";',
    '    let cur = "";',
    '    try { cur = (typeof sessionId === "string" && sessionId) ? sessionId : ""; } catch (e) {}',
    '    if (!cur) cur = localStorage.getItem(key) || "";',
    '    if (cur) localStorage.setItem(key, cur);',
    '    return cur;',
    '  } catch (e) { return ""; }',
    '})()',
  ].join(' ');

  /**
   * 键盘闸门。
   *
   * 【2026-11-01 主人报】「Ctrl+F5/F6/F7 会把会话和清单清掉」。
   * 查下来 index.html 里压根没绑 F6/F7，main.cjs 也只拦了 F5 / Ctrl+R。
   * 所以真凶是「硬重载」—— 重载回来没找回会话 = 屏幕空白 = 看着像被清了。
   *
   * 现在：
   *   F6 / F7（含 Ctrl 组合）—— 一律拦死不做事。它们在这台机器上本来就没用途，
   *                              拦掉不会少任何功能，却能杜绝手滑白屏。
   *   F5 / Ctrl+R           —— 重新刷新屏幕（2026-11-02 主人要求恢复）。
   *                              刷新前必须先把会话 id 钉进 localStorage，
   *                              否则重载回来找不回会话 = 白屏。
   */
  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '');
    const low = key.toLowerCase();

    if (low === 'f6' || low === 'f7') {
      event.preventDefault();
      return;
    }

    /* 【2026-11-02 主人要求恢复】F5 / Ctrl+R 重新刷新屏幕。
     *
     * 但刷之前必须先把当前会话 id 落进 localStorage —— 重载回来找不到会话，
     * 屏幕一片空白，看着跟「会话被清了」一样（2026-11-01 那个坑的根源）。
     * 落死之后重载，前端 bootSessions 会自己切回同一个会话，聊天记录照旧。
     *
     * 菜单里的「重新载入」和开发者工具不受影响，照旧可用。 */
    if (key === 'F5' || (input.control && low === 'r')) {
      event.preventDefault();
      let done = false;
      const go = () => {
        if (done) return;
        done = true;
        try { win.webContents.reloadIgnoringCache(); }
        catch (e1) { try { win.webContents.reload(); } catch (e2) {} }
      };
      // 保底：executeJavaScript 万一卡死，1.5 秒后照样重载（不能按 F5 没反应）
      const guard = setTimeout(go, 1500);
      try {
        win.webContents.executeJavaScript(SAVE_SESSION_SNIPPET, true)
          .catch(() => '')
          .then(() => { clearTimeout(guard); go(); })
          .catch(() => { clearTimeout(guard); go(); });
      } catch (e0) {
        clearTimeout(guard);
        go();
      }
      return;
    }
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  // 下载一律就地存，不拿页面去换。
  // 以前点「下载」会给浏览器一个 Content-Disposition: attachment，
  // 窗口整页跳走 / 开个新页，主人只能退出重进才回得来。
  // 现在：拦下 will-download，弹系统的「另存为」，存完聊天界面原样还在。
  try {
    win.webContents.session.on('will-download', (event, item, webContents) => {
      const base = String(item.getFilename() || 'download');
      const dir = app.getPath('downloads');
      item.setSavePath(join(dir, base));
      item.once('done', (e, state) => {
        if (state === 'completed') {
          try { shell.showItemInFolder(item.getSavePath()); } catch (e2) {}
        }
      });
    });
  } catch (e) {}

  // 兜底：真有东西想把当前页导走，直接掐掉，绝不离开聊天界面
  win.webContents.on('will-navigate', (event, target) => {
    try {
      const cur = win.webContents.getURL() || '';
      const sameOrigin = cur && target && new URL(target).origin === new URL(cur).origin
        && !/\/api\/attach\/raw/.test(target);
      if (!sameOrigin) event.preventDefault();
    } catch (e) {}
  });

  try {
    const { url } = await startServer();
    bootMark('服务听上了');
    await win.loadURL(url);
    bootMark('页面加载完');
  } catch (err) {
    const html = `<html style="background:#000000"><body style="background:#000000;color:#e6e9ef;font:14px/1.6 'Segoe UI';padding:40px">
        <h2>启动失败</h2><pre style="color:#f85149;white-space:pre-wrap">${String((err && err.stack) || err)}</pre></body>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.show();
  }
}

/** 托盘图标：点一下把窗口叫回来 */
function createTray() {
  try {
    // 【2026-11-06 修】原来图读不出来就 createEmpty() —— 托盘照建，但那一格是透明的，
    // 主人看到的就是「右下角有个位置，但什么也没有」。现在三级兜底：
    //   ① 磁盘上的 .ico   ② 包内/外置路径   ③ 下面这段内嵌的 32px PNG（永远不会没有）
    let img = nativeImage.createEmpty();
    const iconPath = pickAppIcon();
    if (iconPath) {
      try {
        const fromFile = nativeImage.createFromPath(iconPath);
        if (fromFile && !fromFile.isEmpty()) img = fromFile;
      } catch { /* 落到兜底 */ }
    }
    if (img.isEmpty()) {
      try {
        const embedded = nativeImage.createFromDataURL('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAACXBIWXMAAAABAAAAAQBPJcTWAAAAAXNSR0IB2cksfwAAACBjSFJNAAB6JgAAgIQAAPoAAACA6AAAdTAAAOpgAAA6mAAAF3CculE8AAAABGdBTUEAALGPC/xhBQAAB+hJREFUeJydV2lsXFcVPnd5yyyeTMYeOxOnTm3HiXEsUlIRKQ2NaRKrIaUUiCgBWok/FVSogISCBA2lgIDE9AcSy58ArVSRHwV1i6GpHeRYxQmpcUkjosR2pm7sOIvtsWfs8Wzv3XvRuW/sOLbHrhhpZt5y3/2+s33nPAKrfQihoIAAKDF3iXLbxwxflJmBMiCUyEJmVri5cVFIpxc8SQmhRCk5/9xyH74SNBDKQEkXT8xg1aZAecNj9tp7W61AdCs1fJWM26ZeopSjpDvh5qb6M5NDZ9Jjl17PJOLvKyVB7wFK4qKPToCg1fiQdK2y2Nbwxl1H/JG6L1IEBAIKXUKIt6eSQCg3KLdipj8SC1Y2fbqy8cDzmamhUxP9b/1i+ubFd4pbsuW8wZeCa6sFEAKR2od+Gqre/gPKDK6EC9LNC0oZIZSjdwghTC9HvpqQdKVwhaKUs2DFlv2hqub9yZF3j4/0/uEZ4WTzhDCucKOSBIgHTrkdqNp68A07vHGvEnlQwhWEckYoQ3QADVoEp3TBMcO462MpClIpl0RqH3wqUNGwM97d9kgudX14MQl+t9s1uD+27dA/zUDVfdLNumg9IQzBYRVwzxN37msyojDr2mWx5qYDbeeuvP3srszk0Ie4n1JCLCSAAZXo9qqtB/+uwUVhDhz+D/CF51yKgmBmYP3mfT/uvHTyu9ucbDIzl2d8gevdSN2eX9rhmhbp5lYEp0VQmAdZBD5H7g5BJkXetddUb6p78Hsv9Xf86HFtNKAHPNe7Vqi6ObR++2El8rIUOAJTxsARAIwQMA0OCug8Ec687SRQvZYx774ieM65m58R5XW7v1Re/9BnE/GudiSGKzSTcM3On2D2KgmilOUSCOTyEtZFQ5rE+FQOgn4bbMsAVwIk044GDfg4OIJAKuOA32eCbXnewlJRSsA99z/5s0T8TLuSAkOghBmsavBH6j6nq8/L9iXguAFa2HZ4P7Q+0ACZXAFOnxuCX/+5F8YmcxAO+eFrBxphz44aqK4sg1xBwMjtNLzUfhWujqbBQhJAqXTzqqyq6b7y+t17E/Huf+gcCEQbD1Juc6zz5UqNMQaZvITtDVXw+b1NOm0CPgO+cqAZmuor4diL5+G5b+yCxtrIXVVdHvbB7F/7ddhwL+0FAIkY0YbWQ/MEfGvv3Yf/lHKybLZjjgJAWdDWGwupgBIAKRVs21IJJ44+On/ddSVYJoP/9Cfgm0fPQs5REPBbOhc8zxIqhQuhdc0tlFuUM8PnN/3lTYDJQBktVWqcE0ilCxqIITr+s6IcF+UZjxH8vf4EPH30LDiSQNBv6qRcUC0omWCHYrW+NRs2cmr4q7Czacu1pC4FB6BgmgxuTmRgIpmFirBPg6H84ldbLwA4o3BhAC3vASEp+CxjMXgxFKCYGeRWKLaBY0vF+Hvyv7zIIDEsuYlkHi7Fx6Hl/hqQCkvRi7UQCjgjcOXDFDx97KwGt0uAewYpRZlBTH8kjPWOzWVej0opHNa1VBK6ekc0ASi6HvMAQ4El+a1fYcwB/D4DpCohUnq8QCzEpIQLJ5MGJSSh3GskJeQVkyjgt6G7bxTSGQeCfkOHgRbz4fBveuHWZAHWhnwgFCkJrnMMCEESbj41w0VhdlwKN8FMK6pjWkLbMQ/QrSO3M9D5r2H4wp56cFwJpsHgxfZBOPffCYhGAiDkKuBaoilR0pG5mdujXBTS024+NWj4I1GQrlzYUhc3FswFyzTgldNxTQDBp2YK8PJbH0AoaINUHwlcUW4RJ5u8nkvduKaDn0sOdwWjjQ/gMLFCVyuGwYALg1PQ+e4otO6oho7zN7TrI2GfF/eVwL0ElNwKssmhd865uWReE5i++f6rFQ2tz2IvKAV+Z/KhOulQYpFAX/+U1n+9pjhGlmzhnhISygwYG+h8ZW4eoJnE1fcykx90B6ONLTjJlAoDboalFQxwuDCYhM7eWzCTEVpqPQ2hK4Jr9xs2zSZHhm5f/tsbmkBxdIaJgY7nQ7GPdynpLhsGWJgLQMGyKPz+1as67pZl6GsrgnvDsTTsMIt3v/BzUUhj3+FcT6qEsOmbF86krve9vHbjzidxjMKbxaS5Cxx1Aq3FFnsjkdf6gCIFK4Jj05XC8EdYavTfPUM9v/sjhkJJ6c6NZBJ/hnuPPxWoqN9hBSq3SOEIgm1wzrWL5ZkwMOZdvwo4KMkMP5NOburia98+5I2gDGcD5RFQCt3ORD6dj59pe/hjnzl2npmBKhyjcJIppZCrg2u3CwRnpi/fd+KJR9Njl68TyrmSrnvXVIyhQLdnk8PXrnQc2bV573OnrFBskyikcVjFdwDkuHqdL0g4HXN/BC1P9J144rHxgY6eheBL3guUFDr2mUQ8funkd7bXt3z/eKT2U19W0gHpFlA9JfZzbKmlRMZrEgqo4aOGvYalRvu6Lr72zNfTY5eHF4Mv+2akSRDGnGxy5sqpHx6q3PzwifWf+OqRYOWWT6JOSOHo1zE9AngdSUdU8+IW4VZQ13k2OdIf736hbajnt3/yin8p+LIEvHAIHA5xbidjA2+/OTbY8WZ53e590YbWx8vWNe+2Q+vruBkwKDMJWu8Rd6STTQ6jwo0NdP5l7HL7Sbcwi4A6fMuBlyRQ3FFXBoYEvZKId5/GL+UW863ZUGOFYveYvkgY26GbS03nZm6N5lM3rjm5VH5uC+9Z6WK2l4L5Hxdpie7B0HJqAAAAAElFTkSuQmCC');
        if (embedded && !embedded.isEmpty()) img = embedded;
      } catch { /* 真没办法了 */ }
    }
    if (img.isEmpty()) { console.warn('[tray] 图标一个都拿不到，托盘可能不可见'); }
    tray = new Tray(img);
    tray.setToolTip('小鱼Agent');
    const menu = Menu.buildFromTemplate([
      { label: '打开小鱼', click: () => {
        if (win && !win.isDestroyed()) { win.show(); win.focus(); }
        else createWindow();
      } },
      { type: 'separator' },
      { label: '后台一直在跑，关窗口不会停', enabled: false },
      { type: 'separator' },
      { label: '彻底退出（正在跑的会停）', click: () => {
        quitting = true;
        app.quit();
      } },
    ]);
    tray.setContextMenu(menu);
    tray.on('click', () => {
      if (win && !win.isDestroyed()) {
        if (win.isVisible()) win.focus();
        else { win.show(); win.focus(); }
      } else createWindow();
    });
  } catch (err) {
    console.error('[tray] 建托盘失败（不影响主功能）:', err && err.message ? err.message : err);
  }
}

// 只允许一个实例：双击多次快捷方式不会开出一堆窗口，第二次只是把原来那个叫到前面。
// 之前没有这道锁，重复双击会起多个进程、多个端口，关起来也容易搞混。
/* 【2026-11-07】自己重启起来的那一版，先给老进程让路再抢锁。
 * 用 Atomics.wait 做同步小睡：主进程这会儿还没起事件循环，
 * 除了阻塞没有别的办法，1.2 秒是实测「老进程退干净」的余量。 */
if (process.argv.includes(RELAUNCH_FLAG)) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1200);
    bootMark('重启上来的（等了 1.2s 让老进程退干净）');
  } catch (e) {
    console.warn('[restart] 等老进程时出错（不影响启动）：', String(e?.message ?? e));
  }
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    /**
     * 【2026-11-07 主人报「双击起不来」—— 单实例这条路要更狠一点】
     *
     * 真实情形：程序本来就在跑（服务端常驻、关窗口只是收进托盘），
     * 再双击一次时第二个进程拿不到单实例锁，直接 app.quit() 退出 ——
     * 主人看到的就是「双击，什么都没发生」。
     * 这时唯一该发生的事是：把已经存在的那个窗口**拽到眼前**。
     *
     * 原来只有 restore/show/focus 三下，遇到这几种状态还是会「看不见」：
     *   · 窗口被 setSkipTaskbar(true) 藏了任务栏按钮
     *   · 窗口在屏幕外 / 被其它窗口压着
     *   · 窗口是显示状态但其实被最小化到托盘
     * 所以补齐：先强制回到任务栏、unmaximize 不用管、再 moveTop。
     */
    if (win && !win.isDestroyed()) {
      try { win.setSkipTaskbar(false); } catch { /* 老版本没有这个方法 */ }
      try { if (win.isMinimized()) win.restore(); } catch {}
      try { win.show(); } catch {}
      try { if (typeof win.moveTop === 'function') win.moveTop(); } catch {}
      try { win.focus(); } catch {}
    } else {
      createWindow();
    }
  });

  app.whenReady().then(async () => {
    bootMark('whenReady');
    // 【为什么把自检挪到后面】
    // 以前是 `await selfCheck()` 跑完才开窗口，而自检要联网问一次模型（还可能卡在
    // 「版本检查」那一步）。网不好或者那次请求挂住，窗口就永远不出来 —— 表现是
    // 「双击图标，任务管理器里有进程，但什么都没弹出来」，服务端自然也没起。
    // 现在：先把托盘和窗口立起来（窗口里的 startServer 立刻开跑），自检丢到后台去。
    const selfCheckDone = selfCheck().catch((e) => {
      console.error('[selfcheck] 后台自检出错（不影响使用）:', e && e.message ? e.message : e);
      return false;
    });
    createTray();
    await createWindow(false);
    // 自检结果回来之后，如果它说「需要重启才生效」，把界面重载一次就好，不再阻塞任何人。
    selfCheckDone.then((updated) => {
      if (!updated) return;
      if (win && !win.isDestroyed()) win.loadURL(win.webContents.getURL().replace(/([?&])r=\d+/, '$1r=' + Date.now()));
    });
  });
}

// 窗口全关了也不退出——服务端和正在跑的轮次留在后台
app.on('window-all-closed', () => {
  if (quitting) {
    if (serverInfo && serverInfo.close) serverInfo.close().catch(() => {});
    app.quit();
  }
  // 否则什么都不做，等托盘叫回来
});

/**
 * 退出之前：给正在跑的那一轮留出几秒把话说完 / 把草稿写掉。
 *
 * 【为什么需要】
 * 以前点「退出」是立刻 app.quit()，服务端着 HTTP 连接就被掐断 ——
 * 正在跑的那一轮（尤其是正在跑工具的时候）一个字都来不及落盘，
 * 重进会话看到的就是「主人说了句，她没有回」。这跟崩溃长得一模一样，
 * 但它是正常退出，进程级兜底（uncaughtException）根本不触发。
 *
 * 【怎么做的】
 * before-quit 里先 preventDefault，问服务端要一个「最多等 5 秒」的收尾：
 *   GET /api/app/quitting —— 服务端把每个正在跑的轮次立刻 abort，
 *   agent 的 finally 会把已经说出来的话 commitWireBack + saveSession + dropDraft。
 * 等它回话（或者等超时），再真的退。第二次 before-quit 直接放行，避免死循环。
 */
let quitHandled = false;

app.on('before-quit', async (ev) => {
  if (quitHandled) return;
  quitHandled = true;
  const info = serverInfo;
  if (info && info.url) {
    ev.preventDefault();
    quitting = true;
    const waitMs = 5000;
    const done = new Promise((resolve) => {
      const timer = setTimeout(resolve, waitMs);
      fetch(`${info.url}/api/app/quitting`, { method: 'POST' })
        .then((r) => r.json())
        .then((r) => {
          console.log(`[quit] 收尾完成：${(r && r.count) || 0} 个轮次`);
          // 再给 300ms，让 finally 里的 saveSession 真正写进磁盘
          setTimeout(resolve, 300);
        })
        .catch(() => resolve())
        .finally(() => clearTimeout(timer));
    });
    await done;
    if (serverInfo && serverInfo.close) serverInfo.close().catch(() => {});
    /*
     * 【2026-11-02 主人报「我手动退出，它却自己重启」——已修】
     *
     * 原来服务端在 /api/app/quitting 里，只要 resume.json 存在（=清单上还有没做完的），
     * 就把 __xyRelaunchOnQuit 置 true，于是主人亲手点退出、程序也会自己爬回来。
     * 那套「有活没干完就自动回来」的意图后来按主人要求撤了，只剩副作用，已整段删掉。
     *
     * 现在只有两条路会让程序重新起来，别的都不行：
     *   · 我调 /api/app/restart → globalThis.__xiaoyuRelaunch() → app.relaunch()
     *   · 环境变量 XIAOYU_NO_RELAUNCH=1（更新程序换文件时用，换了就别急着回来）
     * 下面这段留着当保险：万一哪天又有谁想置这个标志，语义仍然是「明确要求才重开」。
     * 主人亲手退出 = 真退出。
     */
    if (globalThis.__xyRelaunchOnQuit === true && process.env.XIAOYU_NO_RELAUNCH !== '1') {
      try {
        console.log('[quit] 登记自动重开（relaunch）');
        app.relaunch();
      } catch (e) {
        console.warn('[quit] 登记重开失败：', String(e && e.message ? e.message : e));
      }
    }
    app.quit();
    return;
  }
  quitting = true;
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
  else if (win && !win.isDestroyed()) { win.show(); win.focus(); }
});

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  port: serverInfo && serverInfo.port,
  url: serverInfo && serverInfo.url,
  platform: process.platform,
}));

/**
 * 【2026-11-13 合并·mac 侧】系统通知。
 *
 * 主人原话：「你看看有没有系统通知的插件，没有做一个，设置在软件对话，
 * ai 回复的时候提醒下，还有 qq 回复的设置提醒下，做两个开关项」。
 *
 * 两条来路：
 *   1. 渲染进程 → `desktop.notify(...)` → IPC 'xy:notify'（AI 回复完成时用）
 *   2. 服务端   → `globalThis.__xyNotify(...)`（server.mjs 是 import 进主进程跑的，
 *      同一个进程、同一份 globalThis；QQ 消息在那边收到就可以直接弹）
 *
 * 【窗口在最前面就不弹】—— 人正盯着界面看，再弹一条「她回复了」纯属打扰。
 * 只有最小化 / 被别的窗口盖住 / 切到别的应用时才弹。force 给自检用。
 *
 * 出错一律吞掉：通知弹不出来是小事，绝不能因此影响回复本身。
 * 【为什么必须放主进程】页面里的 Web Notification 在 Electron 里不可靠，
 * 插件更不可能（插件跑在页面里）——所以这是内置能力，不是插件。
 */
function xyShowNotify(payload = {}) {
  try {
    if (!Notification.isSupported()) return false;
    if (!win || win.isDestroyed()) return false;
    const focused = win.isVisible() && !win.isMinimized() && win.isFocused();
    if (focused && payload.force !== true) return false;
    const title = String(payload.title || '小鱼').slice(0, 80);
    const body = String(payload.body || '').slice(0, 180);
    if (!body) return false;
    const n = new Notification({ title, body, silent: false });
    // 点通知 → 把窗口捞回来（最小化就还原）。找不到窗口就算了。
    n.on('click', () => {
      try {
        if (!win || win.isDestroyed()) return;
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
      } catch {}
    });
    n.show();
    return true;
  } catch (err) {
    console.warn('[notify] 弹不出来（不影响使用）:', err && err.message ? err.message : err);
    return false;
  }
}

ipcMain.handle('xy:notify', (_e, payload) => xyShowNotify(payload || {}));
/* 给同一个进程里的 server.mjs / qq-bridge.mjs 用（它们 import 进主进程，
 * 拿不到 ipcMain，但能拿到这份 globalThis）。 */
globalThis.__xyNotify = xyShowNotify;

/**
 * 【2026-11-13 合并·mac 侧】原生「选文件 / 选图片 / 选文件夹」。
 *
 * 对话区那颗「+」以前弹的是自己画的栏式浏览器 —— 一列一列横着铺、标着「C 盘」，
 * 那是 Windows 资源管理器的走法。在 mac 上主人按 + 期待的是访达那张浮层。
 * 直接调系统面板：Electron 的 dialog 在 mac 上就是 NSOpenPanel，
 * 在 Windows 上就是资源管理器那套，两边都原生。
 *
 * 参数：kind 'file' | 'image' | 'dir'；defaultPath 上次用过的目录（可选）。
 * 回：{ canceled, paths }。paths 是本机绝对路径，前端接着走原来的 addAttachment。
 */
ipcMain.handle('app:pick', async (e, opts = {}) => {
  const kind = opts && opts.kind === 'image' ? 'image' : opts && opts.kind === 'dir' ? 'dir' : 'file';
  const pickWin = BrowserWindow.fromWebContents(e.sender);
  const properties = kind === 'dir' ? ['openDirectory', 'createDirectory'] : ['openFile'];
  // 图片是「挑一张」，文件允许一次挑好几个
  if (kind === 'file') properties.push('multiSelections');

  /* 图片给一组常见扩展名：mac 上 NSOpenPanel 会把这变成「只能选图片」，
   * 省得主人选到一个 .psd / .mp4 再被后端的预览拒掉。 */
  const filters = kind === 'image'
    ? [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic', 'tif', 'tiff'] }]
    : kind === 'dir' ? [] : [{ name: '所有文件', extensions: ['*'] }];

  const payload = {
    title: kind === 'image' ? '选择图片' : kind === 'dir' ? '选择文件夹' : '选择文件',
    properties,
  };
  if (filters.length) payload.filters = filters;
  if (opts && opts.defaultPath) payload.defaultPath = String(opts.defaultPath);

  try {
    const r = pickWin ? await dialog.showOpenDialog(pickWin, payload) : await dialog.showOpenDialog(payload);
    return { canceled: Boolean(r.canceled), paths: r.canceled ? [] : (r.filePaths || []) };
  } catch (err) {
    return { canceled: true, paths: [], error: String(err && err.message ? err.message : err) };
  }
});

ipcMain.handle('app:openWorkspace', async () => {
  const { config } = await importSrc('src/config.mjs');
  const { error } = await shell.openPath(config.workspace);
  if (error) dialog.showErrorBox('打开工作目录失败', error);
});

/* ---------------- 输入法跟着系统语言走 ---------------- */

/**
 * 主人一点聊天输入框，就把输入法掰到「系统语言」那一边去。
 *
 * 系统是中文、输入法却停在英文 —— 一点就自动回中文，省得打半天全是字母。
 * 反过来系统是英文、输入法停在中文，也一样掰回英文。
 *
 * 怎么做：走 imm32，对【当前输入法】只动「中英转换状态」里那一位。
 *   WM_IME_CONTROL + IMC_GET/SETCONVERSIONSTATUS，
 *   只翻 IME_CMODE_NATIVE(0x0001)，别的位（全角、标点、软键盘）原样留着。
 *   已经是想要的状态就【直接返回，一次都不写】。
 *
 * 【2026-10-27 主人报：重启后点输入框，原本的中文输入一下子被切成英文】
 * 病根就是老写法在动手前先 LoadKeyboardLayout("00000409") 挂一个美式键盘、
 * 再 UnloadKeyboardLayout 摘掉。机器上本来没这个键盘时，Windows 会顺带把
 * 「当前激活的输入法」也带到那个临时键盘上；摘掉之后它记着英文，
 * 主人的中文就没了。现在这条彻底删掉 —— 不碰键盘列表，只翻那一位。
 * 另外：系统里压根没有中文键盘时（HasChineseKb 为假）什么都不做，返回 2。
 *
 * 静默干活：切不动就什么都不做，绝不弹窗、绝不挡主人打字。
 *
 * 注意：C# 那段用单引号一行一行拼，不用模板串 —— 里面反引号太多，
 * 塞进模板串会被当成结束符，整个文件就废了（上一版就是这么翻的车）。
 */

/* ============================================================================
 * 内置浏览器
 *
 * 一个独立的窗口，跟主界面彻底分开：主窗口 sandbox + contextIsolation 不动，
 * 网页在那个窗口里跑。谁能干什么都列在下面，别往主界面里塞 <webview>。
 * ==========================================================================*/

/** 浏览器窗口（单例：点第二次就把它叫到前面，不叠一摞） */
let browserWin = null;

/** 只认 http / https —— file:// 和 javascript: 一律不接，这是底线 */
function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  // 像「baidu.com」这种没写协议的，补 https
  let u = raw;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) u = 'https://' + u;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** 浏览器窗口现在的样子（给界面和工具用） */
function browserState() {
  if (!browserWin || browserWin.isDestroyed()) {
    return { open: false, url: '', title: '', canGoBack: false, canGoForward: false, loading: false };
  }
  const wc = browserWin.webContents;
  let url = '';
  try { url = wc.getURL(); } catch {}
  let title = '';
  try { title = wc.getTitle(); } catch {}
  return {
    open: true,
    url: url || '',
    title: title || '',
    canGoBack: (() => { try { return wc.navigationHistory.canGoBack(); } catch { return false; } })(),
    canGoForward: (() => { try { return wc.navigationHistory.canGoForward(); } catch { return false; } })(),
    loading: (() => { try { return wc.isLoading(); } catch { return false; } })(),
  };
}

/** 把状态推给主界面（地址栏要跟着变） */
function pushBrowserState() {
  try {
    if (win && !win.isDestroyed()) win.webContents.send('browser:state', browserState());
  } catch {}
}

/** 开浏览器窗口；已经开着就直接跳转 + 叫到前面 */
function openBrowser(rawUrl) {
  const target = normalizeUrl(rawUrl) || 'https://www.bing.com';

  if (browserWin && !browserWin.isDestroyed()) {
    try { browserWin.show(); browserWin.focus(); } catch {}
    try { browserWin.loadURL(target); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    return { ok: true, reused: true, url: target };
  }

  browserWin = new BrowserWindow({
    width: 1180,
    height: 820,
    title: '内置浏览器',
    icon: pickAppIcon(),
    webPreferences: {
      // 网页窗口不给 preload、不给 node —— 它就是个浏览器
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 让网页里的新窗口请求回来问我们，别自己乱弹
      webSecurity: true,
    },
  });

  browserWin.loadURL(target);

  // 地址栏跟着变
  for (const ev of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) {
    try { browserWin.webContents.on(ev, () => pushBrowserState()); } catch {}
  }

  /**
   * 网页想开新窗口（target=_blank 那些）。
   *
   * 不拦的话 Electron 会自己弹一个没头没脑的新窗口，地址栏都没有，
   * 主人想回都回不来。我们统一处理：
   *   - http/https → 就在这个内置浏览器里打开
   *   - 别的一律拒绝（file://、外部协议交给系统浏览器）
   */
  browserWin.webContents.setWindowOpenHandler(({ url }) => {
    const u = normalizeUrl(url);
    if (u) {
      try { browserWin.loadURL(u); } catch {}
    } else {
      try { shell.openExternal(url); } catch {}
    }
    return { action: 'deny' };
  });

  /**
   * 网页想把整个窗口导航走（比如点了链接跳到别的站、或者被脚本强跳）。
   * 只放行 http/https，别的拦下来 —— 免得一个网页把浏览器窗口变成别的程序。
   */
  browserWin.webContents.on('will-navigate', (e, url) => {
    if (!normalizeUrl(url)) {
      try { e.preventDefault(); } catch {}
      try { shell.openExternal(url); } catch {}
    }
  });

  browserWin.on('closed', () => {
    browserWin = null;
    pushBrowserState();
  });

  return { ok: true, reused: false, url: target };
}

/** 关掉浏览器窗口 */
function closeBrowser() {
  if (browserWin && !browserWin.isDestroyed()) {
    try { browserWin.destroy(); } catch {}
  }
  browserWin = null;
  pushBrowserState();
  return { ok: true };
}

/** 截一张浏览器窗口的图（工具用来「看看网页长什么样」） */
async function snapBrowser() {
  if (!browserWin || browserWin.isDestroyed()) return { ok: false, error: '浏览器没开着' };
  try {
    const img = await browserWin.webContents.capturePage();
    if (!img || img.isEmpty()) return { ok: false, error: '截出来是空的（页面可能还没画好）' };
    const dir = join(app.getPath('userData'), 'browser-shots');
    try { require('node:fs').mkdirSync(dir, { recursive: true }); } catch {}
    const file = join(dir, 'shot-' + Date.now() + '.png');
    writeFileSync(file, img.toPNG());
    return { ok: true, file, ...browserState() };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

ipcMain.handle('browser:open', (_e, url) => openBrowser(url));
ipcMain.handle('browser:close', () => closeBrowser());
ipcMain.handle('browser:goto', (_e, url) => {
  const u = normalizeUrl(url);
  if (!u) return { ok: false, error: '只支持 http / https 地址' };
  if (!browserWin || browserWin.isDestroyed()) return openBrowser(u);
  try { browserWin.loadURL(u); return { ok: true, url: u }; }
  catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
});
ipcMain.handle('browser:back', () => {
  try { if (browserWin && !browserWin.isDestroyed() && browserWin.webContents.navigationHistory.canGoBack()) browserWin.webContents.navigationHistory.goBack(); } catch {}
  return browserState();
});
ipcMain.handle('browser:forward', () => {
  try { if (browserWin && !browserWin.isDestroyed() && browserWin.webContents.navigationHistory.canGoForward()) browserWin.webContents.navigationHistory.goForward(); } catch {}
  return browserState();
});
ipcMain.handle('browser:reload', () => {
  try { if (browserWin && !browserWin.isDestroyed()) browserWin.webContents.reload(); } catch {}
  return browserState();
});
ipcMain.handle('browser:state', () => browserState());
ipcMain.handle('browser:snap', () => snapBrowser());

