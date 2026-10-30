// Minimal, safe bridge: the renderer only gets these few calls.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('app:info'),
  openWorkspace: () => ipcRenderer.invoke('app:openWorkspace'),

  /**
   * 点了聊天输入框，把系统输入法切到「系统语言」那一种。
   *
   * 为什么放主进程：渲染进程管不了系统输入法，只有主进程能问 Windows
   * 要列表、能点那个输入法。win 是当前窗口句柄，Windows 就在这个窗口
   * 上换输入法，跟人手点任务栏那一下是一回事。
   */
  imeMatchSystem: () => ipcRenderer.invoke('ime:matchSystem'),
  imeSystemLang: () => ipcRenderer.invoke('ime:systemLang'),

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
