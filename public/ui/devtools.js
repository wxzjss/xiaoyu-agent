/**
 * 开发模式：F12 开 / 关调试器。
 *
 * 谁在管什么：
 *   这里（前端）—— 只听键盘。按下 F12 就说一句「切一下」，别的什么都不做。
 *   preload     —— 把这句话转成 IPC（window.desktop.dev.toggle）。
 *   主进程      —— 认准「是谁按的」，给那个窗口 openDevTools / closeDevTools，
 *                  再把真实状态（devtools-opened / -closed）推回来。
 *
 * 为什么分成三段：窗口是 sandbox + contextIsolation 的，前端碰不到
 * BrowserWindow，也不该碰；主进程也不知道主人此刻在哪个窗口上按键。
 * 让按的人报一句、主进程按事件源动手，是最不容易错的分法。
 *
 * 这个文件不引入任何依赖，浏览器里直接打开页面时（没有 window.desktop）静默失效。
 */
(() => {
  const dev = window.desktop && window.desktop.dev;
  // 没有桥就当没这回事：浏览器里打开、或者用了旧版 preload
  if (!dev || typeof dev.toggle !== 'function') return;
  // 同一个页面只绑一次（热重载、重复引入都不至于按一下开两回）
  if (window.__xyDevModeBound) return;
  window.__xyDevModeBound = true;

  /** 调试器现在是不是开着（以主进程推回来的为准） */
  let devOpen = false;
  /** 上一次弹提示时的状态，避免来回推同一个值时闪个不停 */
  let lastTipState = null;

  /**
   * 右下角的一行小提示，1.4 秒自己消失。
   *
   * 为什么不复用界面里的组件：那些都是对话区 / 设置页的，样式互相牵连；
   * 调试提示只在开发时出现，独立一份、删掉也不影响任何功能。
   */
  function flash(text) {
    try {
      let el = document.getElementById('__xyDevTip');
      if (!el) {
        el = document.createElement('div');
        el.id = '__xyDevTip';
        el.style.cssText = [
          'position:fixed', 'right:18px', 'bottom:18px', 'z-index:99999',
          'padding:8px 14px', 'border-radius:10px',
          'background:rgba(20,22,28,.92)', 'color:#e8ecf4',
          'font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif',
          'border:1px solid rgba(255,255,255,.14)',
          'box-shadow:0 6px 20px rgba(0,0,0,.45)',
          'pointer-events:none', 'opacity:0', 'transition:opacity .18s ease',
          'white-space:nowrap',
        ].join(';');
        document.body.appendChild(el);
      }
      el.textContent = text;
      el.style.opacity = '1';
      clearTimeout(flash._t);
      flash._t = setTimeout(() => { try { el.style.opacity = '0'; } catch (e) {} }, 1400);
    } catch (e) {
      // 提示画不出来不影响功能，忽略
    }
  }

  /**
   * 把控制台里的报错转一份到主进程终端。
   *
   * 调试器一关，前端报错就只剩 DevTools 里那一行；而开发态是终端起的 app，
   * 顺手打在那儿最省事。只在调试器开着时转发 —— 平时别去打扰终端。
   */
  function relay(kind, args) {
    if (!devOpen) return;
    try {
      const parts = [];
      for (const a of args) {
        if (a instanceof Error) parts.push(a.stack || a.message || String(a));
        else if (typeof a === 'string') parts.push(a);
        else {
          try { parts.push(JSON.stringify(a)); } catch { parts.push(String(a)); }
        }
      }
      dev.log(kind + ' ' + parts.join(' '));
    } catch (e) {}
  }

  /**
   * 切一下。
   *
   * 不自己算「现在该开还是该关」—— 主进程比前端更清楚真实状态
   * （可能刚被菜单打开、也可能窗口还没画完）。这里不带 open 参数，
   * 让主进程取反，响应里带回结果。
   */
  async function toggle(source) {
    try {
      const st = await dev.toggle();
      if (!st || st.ok === false) {
        flash('调试器没打开：' + ((st && st.error) || '原因不明'));
        return null;
      }
      devOpen = !!st.open;
      lastTipState = devOpen;
      flash(devOpen ? '开发模式：开（F12 关掉）' : '开发模式：关');
      if (devOpen) {
        try { console.log('[dev] 调试器已打开，来源：' + (source || 'unknown')); } catch (e) {}
      }
      return st;
    } catch (e) {
      flash('调试器没打开：' + ((e && e.message) || e));
      return null;
    }
  }

  /* ---------------- 键盘 ---------------- */

  /**
   * F12 的判定。
   *
   * 三个条件都认，是为了兼容不同键盘 / 输入法下的 e.key 差异：
   *   key === 'F12' —— 标准
   *   code === 'F12' —— 某些布局下 key 会被本地化
   *   keyCode === 123 —— 老路径兜底
   *
   * 注意 macOS：没开「将 F1、F2 等键用作标准功能键」时，F12 会被系统当音量键
   * 吃掉，页面根本收不到 keydown。那边用菜单里的「切换开发者工具」
   * （Cmd+Option+I）就行，主进程会把状态推回来，界面逻辑照样对。
   */
  function isF12(e) {
    const k = String(e.key || '');
    return k === 'F12' || e.code === 'F12' || e.keyCode === 123;
  }

  window.addEventListener('keydown', (e) => {
    // 长按不连发：按住 F12 只切一次，不然开关会疯狂抖动
    if (e.repeat) return;
    if (!isF12(e)) return;
    // 拦掉系统默认（有些环境下 F12 会触发浏览器自己的面板）
    e.preventDefault();
    e.stopPropagation();
    toggle('F12');
  }, true);

  /* ---------------- 状态回程 ---------------- */

  /**
   * 主进程也会改状态（菜单、或者以后加的工具入口）。
   * 收到推送就以它为准，并把提示更新一下 —— 但同一状态不重复提示。
   */
  if (typeof dev.onState === 'function') {
    dev.onState((st) => {
      const open = !!(st && st.open);
      devOpen = open;
      if (lastTipState === open) return;
      lastTipState = open;
      flash(open ? '开发模式：开（F12 关掉）' : '开发模式：关');
    });
  }

  // 先把当前状态拉一次：页面刷新时调试器可能是开着的
  try {
    Promise.resolve(dev.state()).then((st) => {
      if (!st || st.ok === false) return;
      devOpen = !!st.open;
      lastTipState = devOpen;
    }).catch(() => {});
  } catch (e) {}

  /* ---------------- 全局错误转发 ---------------- */

  window.addEventListener('error', (e) => {
    const msg = e && e.message ? e.message : '脚本报错';
    const where = e && e.filename ? ` @ ${e.filename}:${e.lineno || 0}` : '';
    relay('ERROR', [msg + where]);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const r = e && e.reason;
    relay('REJECT', [r instanceof Error ? r : String(r)]);
  });

  /**
   * 给控制台留个口子：F12 打不开时（比如 mac 上 F12 被系统吃了），
   * 可以在控制台里手动敲 `xyDev.open()` / `xyDev.close()`。
   */
  window.xyDev = {
    toggle,
    open: () => (typeof dev.open === 'function' ? dev.open() : null),
    close: () => (typeof dev.close === 'function' ? dev.close() : null),
    state: () => (typeof dev.state === 'function' ? dev.state() : null),
    get isOpen() { return devOpen; },
  };
})();
