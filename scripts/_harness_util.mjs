/** harness 系列检查共用的小断言器。下划线开头，run-all-checks 不会单独枚举它。 */
export function makeChecker(title) {
  let bad = 0;
  let n = 0;
  return {
    ok(name, cond, extra) {
      n++;
      if (!cond) bad++;
      console.log((cond ? '  [ok] ' : '  [!!] ') + name + (extra ? '  ' + extra : ''));
    },
    done() {
      console.log('── ' + title + '：' + (n - bad) + '/' + n + ' ' + (bad ? '有失败' : '全过') + ' ──');
      if (bad) process.exitCode = 1;
    },
  };
}
