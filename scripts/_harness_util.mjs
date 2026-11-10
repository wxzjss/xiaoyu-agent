/** harness 系列检查共用的小断言器。下划线开头，run-all-checks 不会单独枚举它。 */
export function makeChecker(title) {
  let bad = 0;
  let n = 0;
  let skips = 0;
  return {
    ok(name, cond, extra) {
      n++;
      if (!cond) bad++;
      console.log((cond ? '  [ok] ' : '  [!!] ') + name + (extra ? '  ' + extra : ''));
    },
    /**
     * 这一刻测不了 —— 条件不成立，不是产品出错。
     * 【2026-11-07 加】起因：有两条真机断言（⏹ 该隐藏、柜门该退回统计）
     * 只有在页面完全闲着时才成立。跑回归时主人正在跟小鱼说话，
     * 页面本来就是活的，那两条必然红。以前只能二选一：糊成绿，或者冤枉成红。
     * 现在如实标 skip：不装绿、也不算失败。
     */
    skip(name, why) {
      skips++;
      console.log('  [--] ' + name + (why ? '  ' + why : ''));
    },
    done() {
      const tail = skips ? '，跳过 ' + skips : '';
      console.log('── ' + title + '：' + (n - bad) + '/' + n + tail + ' ' + (bad ? '有失败' : '全过') + '──');
      if (bad) process.exitCode = 1;
    },
  };
}

/**
 * 【2026-11-09 加·真机格必用的「等 store 就绪」】
 *
 * 换 React 之后，「往屏幕喂数据」只有一条路：`window.__logStore.setLive(sid, ...)`，
 * 而它第一件事是比 sid：`String(sid) !== LOG_STATE.sid` 就直接 return false（一个像素都不画）。
 *
 * 只等 `window.sessionId` 有值是**不够**的 —— 那时 chat.js 的 logSetHistory 可能还没跑完，
 * LOG_STATE.sid 还是空，喂进去等于喂给空气，然后一整排断言报「屏幕上什么都没有」的假红。
 * 我在这上面连栽三次（check-tool-naming / hub-leak / start-pair 各一次），所以收在这里。
 *
 * 就绪判据：`__logStore` 在 && `__logState.sid` 非空 && 和 `sessionId` 一致。
 * 等不到就 reload 一次再等（隔离实例里 reload 很便宜）；还不行就返回 false，
 * 调用方按「这格跳过」处理 —— 绝不让环境抖动变成产品红。
 *
 * @param {{eval:Function, send?:Function}} cdp
 * @param {{reload?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export async function ensureLogStore(cdp, opts = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const probe = async () => {
    try {
      const v = await cdp.eval('return { store: !!(window.__logStore && window.__logState), sid: String((window.__logState||{}).sid || ""), pageSid: String(window.sessionId || "") };');
      return !!(v && v.store && v.sid && v.sid === v.pageSid);
    } catch (e) { return false; }
  };
  for (let i = 0; i < 60; i++) { if (await probe()) return true; await sleep(250); }
  if (opts.reload !== false) {
    try { await cdp.send('Page.navigate', { url: (await cdp.eval('return location.href;')) }); } catch (e) { try { await cdp.eval('location.reload();'); } catch (e2) {} }
    for (let i = 0; i < 80; i++) { await sleep(250); if (await probe()) return true; }
  }
  return false;
}
