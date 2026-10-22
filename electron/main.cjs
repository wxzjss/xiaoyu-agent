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
    const { runSelfCheck, decideMode } = await import('../src/selfcheck.mjs');
    if (decideMode() === 'skip') return false;

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
    return Boolean(r.needsRestart);
  } catch (err) {
    console.error('[selfcheck] 跑挂了（不影响使用）:', err && err.message ? err.message : err);
    return false;
  }
}

async function startServer() {
  const { startServer: run } = await import('../src/server.mjs');
  // 自检在 selfCheck() 里已经跑过了，这里别跑第二遍
  serverInfo = await run({ port: 0, quiet: true, selfCheck: false });
  return serverInfo;
}

async function createWindow(updated = false) {
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }

  win = new BrowserWindow({
    // 打开就是最大化（老师要的：不用每次自己点右上角的方框）
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 520,
    backgroundColor: '#0f1115',
    title: '小鱼',
    autoHideMenuBar: true,
    show: false,
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

  // 默认最大化。
  // 注意别在 show 之前 maximize：Windows 上对着一个还没显示的窗口最大化，
  // 会得到一个一百多像素的怪尺寸（踩过）。所以先正常显示，再最大化。
  win.once('ready-to-show', () => {
    win.show();
    win.maximize();
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

  try {
    const { url } = await startServer();
    await win.loadURL(url);
  } catch (err) {
    const html = `<body style="background:#0f1115;color:#e6e9ef;font:14px/1.6 'Segoe UI';padding:40px">
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
    const updated = await selfCheck();
    createTray();
    await createWindow(updated);
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

app.on('before-quit', () => {
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
  const { config } = await import('../src/config.mjs');
  const { error } = await shell.openPath(config.workspace);
  if (error) dialog.showErrorBox('打开工作目录失败', error);
});
