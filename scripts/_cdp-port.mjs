import net from 'node:net';

/**
 * 找一个**真的能用**的调试端口。
 *
 * 【为什么不能直接写死一个端口】
 *
 * 2026-11-18 实测踩到：`check-real-launch` 起浏览器时日志里写着
 *
 *   bind() returned an error: 通常每个套接字地址只允许使用一次 (0x2740)
 *   DevTools listening on ws://[::1]:9231/devtools/browser/...
 *
 * 也就是 IPv4 的 9231 被占，Edge 退到 IPv6 才起来；而脚本探的是
 * `http://127.0.0.1:9231/json`（IPv4）→ 连不上 → 报「浏览器没起来」。
 *
 * 更麻烦的是：占着那个端口的进程**已经死了**。
 * `Get-NetTCPConnection -LocalPort 9231` 还能看到 LISTENING，
 * 但 `Get-Process -Id <那个PID>` 说「已不存在」—— Windows 的 socket 泄漏，
 * 什么时候释放说不准（实测挂了一上午都没释放）。
 *
 * 所以判断「端口能不能用」不能看 netstat，只能**真的 bind 一次**：
 *   · bind 成功 → 能用，立刻释放
 *   · EADDRINUSE → 幽灵或真占用，换下一个
 *
 * 【为什么不用随机端口】
 * 随机端口有两个坏处：① 出问题时日志里每次都不一样，不好复现；
 * ② 万一撞上系统保留区间，行为更怪。所以从给定起点往上一段段试，
 * 起点保持不变（9223/9231 这些）—— 只有被别人占了才顺移。
 */

/**
 * @param {number} start 起始端口
 * @param {number} [tries] 最多试几个（默认 40，够绕过任何幽灵占用）
 * @returns {Promise<number>} 一个当前可用的端口
 */
export async function pickFreePort(start, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const port = start + i;
    if (port > 65535) break;
    if (await canBind(port)) return port;
  }
  /* 一个都不行（极端情况）：交给系统分配，至少能跑起来 */
  return await bindZero();
}

/** 试一次 bind，成功就立刻关掉 */
function canBind(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { srv.close(); } catch {}
      resolve(ok);
    };
    srv.once('error', (e) => {
      /* EADDRINUSE = 有人占着；EACCES = 权限（低端口）。两种都算不能用 */
      finish(false);
      void e;
    });
    srv.once('listening', () => finish(true));
    try { srv.listen(port, '127.0.0.1'); } catch { finish(false); }
    /* 兜底：万一既不 error 也不 listening（不该发生），1 秒后放弃 */
    setTimeout(() => finish(false), 1000);
  });
}

/** 让系统给一个（0 = 随机分配） */
function bindZero() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('listening', () => {
      const p = srv.address() && srv.address().port;
      try { srv.close(); } catch {}
      resolve(p || 9222);
    });
    srv.once('error', () => resolve(9222));
    srv.listen(0, '127.0.0.1');
  });
}

/**
 * 探测 CDP 是否就绪。**IPv4 和 IPv6 都要试。**
 *
 * Edge 在 IPv4 被占时会退到 `[::1]`，只探 127.0.0.1 会误判成"没起来"。
 *
 * @param {number} port
 * @param {(url: string) => Promise<any>} doFetch 传 fetch 进来（懒得在这里依赖全局）
 * @returns {Promise<{ok: boolean, base: string, list: any[]}>}
 */
export async function probeCdp(port, doFetch = fetch) {
  const bases = ['http://127.0.0.1:' + port, 'http://[::1]:' + port];
  for (const base of bases) {
    try {
      const list = await doFetch(base + '/json').then((r) => r.json());
      if (Array.isArray(list)) return { ok: true, base, list };
    } catch { /* 换下一个协议族 */ }
  }
  return { ok: false, base: bases[0], list: [] };
}
