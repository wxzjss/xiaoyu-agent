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

const { app, BrowserWindow, shell, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFileSync, writeFileSync, existsSync: fsExists } = require('node:fs');
const { Worker } = require('node:worker_threads');

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
 * 从可写代码目录 import，失败就退回 asar。
 * @param {string} rel 形如 'src/server.mjs'
 */
async function importSrc(rel) {
  if (app.isPackaged) {
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
    console.log('[restart] 主进程准备重启（app.relaunch）');
    try { app.relaunch(); } catch (e) { console.warn('[restart] relaunch 失败：', String(e?.message ?? e)); }
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
  };

  // 告诉服务端「有人在管我」：界面上那个「重启让它生效」就是靠它决定
  // 能不能真的自己重启（浏览器直开的时候没人管，只能让主人手动关）。
  process.env.XIAOYU_DESKTOP = '1';
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
 * 【2026-10-30 主人要】小鱼自己画的那只鲸鱼娘，也应该能当图标 —— 设置里能切。
 * 设置存在 data/.state/settings.json（跟主程序同一个设置文件），
 * 这里不 import 主程序的模块（那是 ESM，这是 CJS），自己读一遍就够，
 * 读不到就退回原来那张，绝不因为图标把程序搞得起不来。
 */
function pickAppIcon() {
  try {
    const fs2 = require('node:fs');
    const p2 = require('node:path');
    const dataDir = process.env.MINI_AGENT_DATA || (function () {
      const base = process.env.APPDATA || p2.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
      return p2.join(base, '小鱼Agent', 'data');
    })();
    const sp = p2.join(dataDir, '.state', 'settings.json');
    let style = 'classic';
    if (fs2.existsSync(sp)) {
      const j = JSON.parse(fs2.readFileSync(sp, 'utf8'));
      style = String(j.iconStyle || 'classic');
    }
    const name = (style === 'drawn') ? 'xiaoyu-whale.ico' : 'xiaoyu.ico';
    const full = p2.join(__dirname, '..', 'assets', name);
    if (fs2.existsSync(full)) return full;
    return p2.join(__dirname, '..', 'assets', 'xiaoyu.ico');
  } catch {
    try {
      const p2 = require('node:path');
      return p2.join(__dirname, '..', 'assets', 'xiaoyu.ico');
    } catch { return ''; }
  }
}

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

  // 默认最大化（顺序与原因见下面 ready-to-show 里那段，别改回去）。
  win.once('ready-to-show', () => {
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
    // 后台自动更新过 → 重启一次让新代码生效（防抖在 src/updater.mjs 里，不会无限重启）
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
   * 窗口就永远透明、看着像「没打开」。这里给个上限 —— 3 秒还没 ready 就直接露面。
   * 露面的时候底色已经是纯黑了，就算内容没画完也不刺眼。
   */
  setTimeout(() => {
    try {
      if (!win || win.isDestroyed()) return;
      if (!win.isVisible()) {
        console.warn('[boot] ready-to-show 没来，兜底直接露面（纯黑底）');
        win.setBackgroundColor('#000000');
        win.show();
        setTimeout(() => { try { if (win && !win.isDestroyed()) win.setOpacity(1); } catch {} }, 80);
      }
    } catch {}
  }, 3000);

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

  // 硬刷新兜底：Ctrl+F5 / F5 都能强制重载
  win.webContents.on('before-input-event', (event, input) => {
    const key = String(input.key || '');
    if (key === 'F5' || (input.control && key.toLowerCase() === 'r')) {
      event.preventDefault();
      win.webContents.reloadIgnoringCache();
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
    await win.loadURL(url);
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
    const iconPath = pickAppIcon();
    let img = nativeImage.createFromPath(iconPath);
    if (img.isEmpty()) {
      // 图标读不出来也别让程序起不来
      img = nativeImage.createEmpty();
    }
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
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    } else {
      createWindow();
    }
  });

  app.whenReady().then(async () => {
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
}));

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

const IME_CS_LINES = [
  'using System;',
  'using System.Runtime.InteropServices;',
  '',
  'public class XiaoYuIme',
  '{',
  '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);',
  '  [DllImport("imm32.dll")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr h);',
  '  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint tid);',
  '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
  '  [DllImport("user32.dll")] public static extern int GetKeyboardLayoutList(int nBuff, [Out] IntPtr[] lpList);',
  '',
  '  const uint WM_IME_CONTROL = 0x0283;',
  '  const int IMC_GETCONVERSIONSTATUS = 0x0001;',
  '  const int IMC_SETCONVERSIONSTATUS = 0x0002;',
  '',
  '  // IME_CMODE_NATIVE = 0x0001 : 0 means alphanumeric(EN), 1 means native(CN)',
  '  const long CMODE_NATIVE = 0x0001;',
  '',
  '  static IntPtr DefImeWnd()',
  '  {',
  '    IntPtr fg = GetForegroundWindow();',
  '    if (fg == IntPtr.Zero) return IntPtr.Zero;',
  '    return ImmGetDefaultIMEWnd(fg);',
  '  }',
  '',
  '  // any Chinese keyboard layout loaded? (0x0804 zh-CN, 0x0404 zh-TW, 0x0C04 zh-HK, 0x1004 zh-SG)',
  '  public static bool HasChineseKb()',
  '  {',
  '    int n = GetKeyboardLayoutList(0, null);',
  '    if (n <= 0) return false;',
  '    IntPtr[] list = new IntPtr[n];',
  '    n = GetKeyboardLayoutList(n, list);',
  '    for (int i = 0; i < n; i++)',
  '    {',
  '      int id = (int)(list[i].ToInt64() & 0xFFFF);',
  '      if (id == 0x0804 || id == 0x0404 || id == 0x0C04 || id == 0x1004) return true;',
  '    }',
  '    return false;',
  '  }',
  '',
  '  // read raw conversion status, -1 when unavailable',
  '  public static long RawStatus()',
  '  {',
  '    IntPtr def = DefImeWnd();',
  '    if (def == IntPtr.Zero) return -1;',
  '    long st = SendMessage(def, WM_IME_CONTROL, new IntPtr(IMC_GETCONVERSIONSTATUS), IntPtr.Zero).ToInt64();',
  '    if (st < 0) return -1;',
  '    return st;',
  '  }',
  '',
  '  // 1 = native(CN) on, 0 = alphanumeric(EN), -1 = cannot tell',
  '  public static long ReadChineseMode()',
  '  {',
  '    long st = RawStatus();',
  '    if (st < 0) return -1;',
  '    return (st & CMODE_NATIVE) == CMODE_NATIVE ? 1 : 0;',
  '  }',
  '',
  '  // flip ONLY the NATIVE bit, keep every other bit as it was',
  '  public static long SetChineseMode(bool zh)',
  '  {',
  '    IntPtr def = DefImeWnd();',
  '    if (def == IntPtr.Zero) return -1;',
  '    long st = RawStatus();',
  '    if (st < 0) return -1;',
  '    long want = zh ? (st | CMODE_NATIVE) : (st & ~CMODE_NATIVE);',
  '    if (want == st) return zh ? 1 : 0;',
  '    SendMessage(def, WM_IME_CONTROL, new IntPtr(IMC_SETCONVERSIONSTATUS), new IntPtr(want));',
  '    return ReadChineseMode();',
  '  }',
  '',
  '  public static long Apply(string mode)',
  '  {',
  '    if (!HasChineseKb()) return 2;   // no Chinese keyboard at all: do nothing',
  '    bool wantZh = (mode == "zh");',
  '    long cur = ReadChineseMode();',
  '    if (cur < 0) return -1;',
  '    if (wantZh && cur == 1) return 1;  // already Chinese: touch nothing',
  '    if (!wantZh && cur == 0) return 0; // already English: touch nothing',
  '    return SetChineseMode(wantZh);',
  '  }',
  '}',
];

const IME_NATIVE_SRC = IME_CS_LINES.join('\n');

/** 系统界面语言，取前两位：zh-CN -> zh */
function systemLangCode() {
  try {
    return String(app.getLocale() || '').slice(0, 2).toLowerCase() || 'en';
  } catch {
    return 'en';
  }
}

let imeScriptPath = null;

/**
 * 把 C# 那段落成 .ps1，第一次用到时写一次，后面复用。
 *
 * 坑：这段 C# 里【一个汉字都不能有】。
 * 我们写出去的是 UTF-8，可 powershell.exe 默认拿 GBK 去读，
 * 中文注释会被按字节切坏，编译器当场报一堆「标记无效」，Add-Type 直接失败 ——
 * 整个切输入法的功能就静默失效了（真踩过）。说明写在外面这层就行。
 */
function ensureImeScript() {
  if (imeScriptPath) return imeScriptPath;
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const dir = path.join(os.tmpdir(), 'xiaoyu-agent');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const file = path.join(dir, 'ime.ps1');
  const body =
    "$ErrorActionPreference='SilentlyContinue'\r\n" +
    "Add-Type -TypeDefinition @'\r\n" +
    IME_NATIVE_SRC +
    "\r\n'@\r\n" +
    "if (-not ('XiaoYuIme' -as [type])) { exit 3 }\r\n" +
    '$m = $args[0]\r\n' +
    'if (-not $m) { $m = (Get-Culture).Name.Substring(0,2).ToLower() }\r\n' +
    'Write-Output ([XiaoYuIme]::Apply($m))\r\n';
  fs.writeFileSync(file, body, 'utf8');
  imeScriptPath = file;
  return file;
}

/** 掰输入法。返回 { ok, lang, chinese }，失败也不影响聊天。 */
function matchImeToSystem() {
  const lang = systemLangCode();
  const wantZh = lang === 'zh';
  const { execFile } = require('child_process');
  let script;
  try {
    script = ensureImeScript();
  } catch (e) {
    return Promise.resolve({ ok: false, lang, chinese: null, detail: 'script:' + e.message });
  }
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, wantZh ? 'zh' : 'en'],
      { timeout: 6000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim().split(/\r?\n/).pop() || '';
        const n = Number(out);
        if (!err && !Number.isNaN(n) && n >= 0) {
          // 2 = 这台机器压根没装中文输入法，什么都没动（不算失败，也不算成功）
          if (n === 2) {
            resolve({ ok: false, skipped: true, lang, chinese: null, detail: 'no-chinese-keyboard' });
            return;
          }
          resolve({ ok: (n === 1) === wantZh, lang, chinese: n === 1 });
        } else {
          resolve({ ok: false, lang, chinese: null, detail: (out || String(stderr || err || '')).slice(0, 200) });
        }
      }
    );
  });
}

ipcMain.handle('ime:systemLang', () => systemLangCode());
ipcMain.handle('ime:matchSystem', () => matchImeToSystem());

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

