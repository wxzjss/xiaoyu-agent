// Minimal, safe bridge: the renderer only gets these few calls.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('app:info'),
  openWorkspace: () => ipcRenderer.invoke('app:openWorkspace'),

  /* 【2026-11-09】输入法相关的 IPC 全删了。应用一行都不碰系统输入法，
   * 交给 Windows 和主人自己（Shift / Ctrl+Space）。留着两个没人接的
   * invoke 只会让设置页以为还能「跟随系统」，误导人。 */
  /**
   * 系统通知（2026-11-12）。
   *
   * { kind: 'chat' | 'qq', title, body } → true 表示真弹了，false 表示
   * 「开关关着 / 窗口就在最前面 / 系统不支持」。弹不弹的最终判断在主进程
   * （那里才知道窗口有没有被挡住），前端只管把要说的话递过去。
   *
   * 浏览器里直接打开页面时这个字段不存在，调用方写 `desktop.notify?.(…)`。
   */
  notify: (payload) => ipcRenderer.invoke('xy:notify', payload || {}),

  /**
   * 拖进来的文件，拿它在本机上的真实路径。
   *
   * 为什么非得走这层：Electron 32 起，渲染进程里的 File 不带 path 了，
   * 只能问 webUtils 要。没有它，拖进来就只剩个名字，后端不知道文件在哪。
   *
   * 不是本机文件（网页里拖来的、内存里造的）拿不到路径就返回空串，
   * 调用方自己看着办 —— 绝不猜路径。
   */
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  /**
   * 原生选择面板（2026-11-12）：{ kind: 'file' | 'image' | 'dir', defaultPath? }
   * 回 { canceled, paths }。mac 上是访达的 NSOpenPanel，Windows 上是资源管理器，
   * 都是系统自己的那张脸 —— 界面不再自己画文件浏览器。
   * 浏览器里直接打开（没有 preload）时这个字段不存在，调用方要自己回落。
   */
  pick: (opts) => ipcRenderer.invoke('app:pick', opts || {}),

  /**
   * 开发模式（F12）。
   *
   * 键盘事件是【前端】听的，这里只负责把「要开 / 要关」这句话递给主进程 ——
   * 真正 openDevTools 的动作在主进程做（渲染进程拿不到 BrowserWindow）。
   *
   * 为什么不让渲染进程直接开：这个窗口是 sandbox + contextIsolation 的，
   * 渲染进程里既没有 node 也没有 BrowserWindow，只有这条 IPC。
   * 谁按的 F12 就开谁的窗口：主进程用 event.sender 反查，不写死窗口。
   *
   * onState 是回程：从菜单（Ctrl+Shift+I / Cmd+Option+I）开关的调试器，
   * 前端也要知道，不然「开发模式」的提示会跟实际状态对不上。
   */
  dev: {
    /** 切换（不传参数）/ 指定开关（{ open: true|false }） */
    toggle: (opts) => ipcRenderer.invoke('dev:toggle', opts || {}),
    open: () => ipcRenderer.invoke('dev:open'),
    close: () => ipcRenderer.invoke('dev:close'),
    state: () => ipcRenderer.invoke('dev:state'),

    /** 把前端的一行日志转到主进程终端（调试器关着时也能看到报错） */
    log: (text) => {
      try { ipcRenderer.send('dev:log', String(text == null ? '' : text).slice(0, 4000)); } catch {}
    },

    /** 调试器开关状态变了就叫一下；返回取消订阅的函数 */
    onState: (fn) => {
      if (typeof fn !== 'function') return () => {};
      const h = (_e, st) => { try { fn(st); } catch {} };
      ipcRenderer.on('dev:state', h);
      return () => { try { ipcRenderer.removeListener('dev:state', h); } catch {} };
    },
  },

  /**
   * 内置浏览器。
   *
   * 网页跑在【另一个窗口】里，不塞进主界面 —— 主窗口是 sandbox 的，
   * 往里塞 <webview> 等于把安全边界往下拉。这里只给界面留几个发指令的按钮。
   *
   * 地址只收 http / https，主进程那边也会再挡一遍（两处都挡，不靠单点）。
   */
  browser: {
    open: (url) => ipcRenderer.invoke('browser:open', url),
    close: () => ipcRenderer.invoke('browser:close'),
    goto: (url) => ipcRenderer.invoke('browser:goto', url),
    back: () => ipcRenderer.invoke('browser:back'),
    forward: () => ipcRenderer.invoke('browser:forward'),
    reload: () => ipcRenderer.invoke('browser:reload'),
    state: () => ipcRenderer.invoke('browser:state'),
    snap: () => ipcRenderer.invoke('browser:snap'),

    /**
     * 浏览器窗口状态变了（地址、标题、能不能后退）就叫一下。
     * 返回一个「取消订阅」的函数，界面关掉时记得调，免得越挂越多。
     */
    onState: (fn) => {
      if (typeof fn !== 'function') return () => {};
      const h = (_e, st) => { try { fn(st); } catch {} };
      ipcRenderer.on('browser:state', h);
      return () => { try { ipcRenderer.removeListener('browser:state', h); } catch {} };
    },
  },
});
