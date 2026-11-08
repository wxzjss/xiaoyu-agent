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
      console.log('── ' + title + '：' + (n - bad) + '/' + n + tail + ' ' + (bad ? '有失败' : '全过') + ' ──');
      if (bad) process.exitCode = 1;
    },
  };
}
