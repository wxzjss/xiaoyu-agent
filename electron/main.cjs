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
if (process.env.ELECTRON_RUN_AS_NODE) {
  try {
    const { spawn } = require('node:child_process');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    spawn(process.execPath, process.argv.slice(1), { env, detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    console.error('[boot] 环境里有 ELECTRON_RUN_AS_NODE，自救重启失败:', err && err.message ? err.message : err);
  }
  process.exit(0);
}

const { app, BrowserWindow, shell, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { readFileSync, writeFileSync } = require('node:fs');

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
    // 窗口底色 = 页面底色。这里和 index.html 的 --bg 是同一个值，改一个就得改另一个。
    // 它管的是「页面还没画出来」那几百毫秒：窗口已经是深色，不会先露一版白的。
    backgroundColor: '#0f1115',
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
    icon: join(__dirname, '..', 'assets', 'xiaoyu.ico'),
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
    try { win.setBackgroundColor('#0f1115'); } catch {}
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
    // 先让它在「全透明」的状态下露面：这一步屏幕上什么都不会变。
    win.show();
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
    const html = `<html style="background:#0f1115"><body style="background:#0f1115;color:#e6e9ef;font:14px/1.6 'Segoe UI';padding:40px">
        <h2>启动失败</h2><pre style="color:#f85149;white-space:pre-wrap">${String((err && err.stack) || err)}</pre></body>`;
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    win.show();
  }
}

/** 托盘图标：点一下把窗口叫回来 */
function createTray() {
  try {
    const iconPath = join(__dirname, '..', 'assets', 'xiaoyu.ico');
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
    // 看门狗等程序彻底醒过来再上岗：太早装的话，启动阶段的小毛病会被它误判成崩溃。
    setTimeout(() => armWatchdog(), 8000).unref?.();
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
 * 怎么做：
 *   一、输入法语言（中文还是英文）—— 渲染进程够不着，只能主进程来。
 *       系统里没装英文键盘就临时挂一个（LoadKeyboardLayout），掰完就摘。
 *   二、中文输入法的「中文/英文」状态 —— 走 imm32，
 *       WM_IME_CONTROL + IMC_SETCONVERSIONSTATUS 直接把状态位写过去。
 *       这条最稳；ImmSetOpenStatus 那个在微软拼音上经常原地不动。
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
  '  [DllImport("user32.dll")] public static extern IntPtr LoadKeyboardLayout(string id, uint flags);',
  '  [DllImport("user32.dll")] public static extern bool UnloadKeyboardLayout(IntPtr hkl);',
  '  [DllImport("imm32.dll")] public static extern IntPtr ImmGetDefaultIMEWnd(IntPtr h);',
  '',
  '  const uint WM_IME_CONTROL = 0x0283;',
  '  const int IMC_GETCONVERSIONSTATUS = 0x0001;',
  '  const int IMC_SETCONVERSIONSTATUS = 0x0002;',
  '',
  '  const long CN_STATUS = 1025;',
  '',
  '  static IntPtr DefImeWnd()',
  '  {',
  '    IntPtr fg = GetForegroundWindow();',
  '    if (fg == IntPtr.Zero) return IntPtr.Zero;',
  '    return ImmGetDefaultIMEWnd(fg);',
  '  }',
  '',
  '  public static long ReadChineseMode()',
  '  {',
  '    IntPtr def = DefImeWnd();',
  '    if (def == IntPtr.Zero) return -1;',
  '    long st = SendMessage(def, WM_IME_CONTROL, new IntPtr(IMC_GETCONVERSIONSTATUS), IntPtr.Zero).ToInt64();',
  '    return (st & 1) == 1 ? 1 : 0;',
  '  }',
  '',
  '  public static long SetChineseMode(bool zh)',
  '  {',
  '    IntPtr def = DefImeWnd();',
  '    if (def == IntPtr.Zero) return -1;',
  '    long want = zh ? CN_STATUS : 0;',
  '    SendMessage(def, WM_IME_CONTROL, new IntPtr(IMC_SETCONVERSIONSTATUS), new IntPtr(want));',
  '    return ReadChineseMode();',
  '  }',
  '',
  '  public static long AttachEnglish()',
  '  {',
  '    IntPtr hkl = LoadKeyboardLayout("00000409", 0x00000001);',
  '    if (hkl == IntPtr.Zero) return 0;',
  '    return hkl.ToInt64();',
  '  }',
  '',
  '  public static void DetachEnglish(long hkl)',
  '  {',
  '    if (hkl != 0) UnloadKeyboardLayout(new IntPtr(hkl));',
  '  }',
  '',
  '  public static long Apply(string mode)',
  '  {',
  '    bool wantZh = (mode == "zh");',
  '    if (wantZh)',
  '    {',
  '      long before = ReadChineseMode();',
  '      if (before == 1) return 1;',
  '      long en = AttachEnglish();',
  '      if (en != 0) DetachEnglish(en);',
  '      long r = SetChineseMode(true);',
  '      return r;',
  '    }',
  '    if (ReadChineseMode() == 0) return 0;',
  '    return SetChineseMode(false);',
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
          resolve({ ok: (n === 1) === wantZh, lang, chinese: n === 1 });
        } else {
          resolve({ ok: false, lang, chinese: null, detail: (out || String(stderr || err || '')).slice(0, 200) });
        }
      }
    );
  });
}

ipcMain.handle('ime:systemLang', () => systemLangCode());

/* ---------------- 崩溃自愈（外部看门狗） ---------------- */

/**
 * 进程自己炸了，谁来把它拉起来？
 *
 * 服务端有 src/crash-guard.mjs 兜底，但它只能接住「单个没人管的异常」；
 * 一旦同一类错误 60 秒内反复出现 5 次，它就只能 process.exit(1) ——
 * 因为服务就跑在主进程里，这一退整个程序就没了，托盘、窗口一起消失。
 * 主人看到的是「小鱼突然不见了」，还得自己去双击图标，那一轮也凉了。
 *
 * Node 进程没法在自己死后再救自己，所以这里用**外部看门狗**：
 *   起一个小 PowerShell，盯着本进程的 PID，等它退出，
 *   用一个「标记文件」判断这次退出要不要重启：
 *     - 正常退出（托盘退出 / 关了窗口真要退）→ 标记文件存在，看门狗直接收工
 *     - 意外退出（崩溃、被系统杀）→ 没有标记文件 → 重新拉起
 *
 * 防死循环：看门狗最多连拉 3 次，且两次之间至少隔 8 秒；
 * 反复秒退说明代码坏了，再拉也没用，那时候就老老实实停手。
 *
 * 为什么用 PowerShell 而不是再起一个 node：node 得再有解释器路径、打包后也没有
 * 稳定的 node.exe 可用；PowerShell 在 Windows 上一定有。
 */
const WATCHDOG_FLAG = 'watchdog.flag';
const WATCHDOG_KILL = 'watchdog.pid';

function watchdogDir() {
  try {
    return app.getPath('userData');
  } catch {
    return process.env.MINI_AGENT_DATA || process.cwd();
  }
}

/** 正常退出前调：写下标记，让看门狗**别**重启。只生效一次。 */
let watchdogDisarmed = false;
function disarmWatchdog() {
  if (watchdogDisarmed) return;
  watchdogDisarmed = true;
  try {
    writeFileSync(join(watchdogDir(), WATCHDOG_FLAG), String(Date.now()), 'utf8');
  } catch {}
  // 顺手把看门狗自己也收掉，别留一个空转的 powershell
  try {
    const pidFile = join(watchdogDir(), WATCHDOG_KILL);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    if (Number.isFinite(pid) && pid > 0) process.kill(pid);
  } catch {}
}

/**
 * 起看门狗。只在「真身」（不是被拉起来的那一次）上装，而且同一刻只有一只。
 * 用环境变量 XIAOYU_SUPERVISED 防套娃：被拉起来的进程不再装看门狗，
 * 否则崩溃一次会滚出一串 powershell。
 */
function armWatchdog() {
  if (process.env.XIAOYU_SUPERVISED === '1') return;
  const { spawn } = require('node:child_process');
  const dir = watchdogDir();
  const flag = join(dir, WATCHDOG_FLAG);
  const pidFile = join(dir, WATCHDOG_KILL);
  const exe = process.execPath;
  // 清掉上一轮留下的标记，不然这次真崩了也会被当成正常退出
  try { require('node:fs').unlinkSync(flag); } catch {}

  const script = [
    '$ErrorActionPreference = "SilentlyContinue"',
    `$target = ${process.pid}`,
    `$exe = '${exe.replace(/'/g, "''")}'`,
    `$flag = '${flag.replace(/'/g, "''")}'`,
    `$pidFile = '${pidFile.replace(/'/g, "''")}'`,
    '$tries = 0',
    'while ($tries -lt 3) {',
    '  Wait-Process -Id $target -Timeout 2147483',
    '  if (Test-Path $flag) { break }',
    '  $tries++',
    '  Start-Sleep -Seconds 2',
    '  if (Test-Path $flag) { break }',
    '  $env:XIAOYU_SUPERVISED = "1"',
    '  $env:XIAOYU_RESUMED = "1"',
    '  try { Start-Process -FilePath $exe -WorkingDirectory (Split-Path $exe) } catch { break }',
    '  Start-Sleep -Seconds 8',
    '  $p = Get-Process | Where-Object { $_.ProcessName -eq ' +
      JSON.stringify(String(require('node:path').basename(exe, '.exe'))) +
      ' } | Select-Object -First 1',
    '  if (-not $p) { break }',
    '  $target = $p.Id',
    '}',
  ].join('\r\n');

  try {
    const enc = Buffer.from(script, 'utf16le').toString('base64');
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    try { writeFileSync(pidFile, String(child.pid), 'utf8'); } catch {}
    console.log('[watchdog] 看门狗已上岗，PID', child.pid);
  } catch (e) {
    console.warn('[watchdog] 起看门狗失败（不影响使用）:', String(e?.message ?? e));
  }
}

  console.log('[watchdog] 看门狗暂不起（等窗口和服务都立住了再说）');

// 正常退出的所有出口都要先拆看门狗，否则「点退出」会被当成崩溃又拉起来。
app.on('will-quit', () => disarmWatchdog());
process.on('exit', () => disarmWatchdog());

ipcMain.handle('ime:matchSystem', () => matchImeToSystem());
