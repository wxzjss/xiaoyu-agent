// Minimal, safe bridge: the renderer only gets these few calls.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  info: () => ipcRenderer.invoke('app:info'),
  openWorkspace: () => ipcRenderer.invoke('app:openWorkspace'),

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
});
