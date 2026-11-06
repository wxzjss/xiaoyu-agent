/**
 * 检查器自检：故意把前端改坏，看守门的几关能不能抓到。
 *
 * 【为什么要有这个】
 * 「检查通过」这四个字本身不值钱 —— 一个只会说 OK 的检查器和没有检查器一样。
 * 2026-11-05 严检时就是这么发现的：stripCommentsAndStrings 把正则字面量里的
 * 引号误当成字符串开头，剥完之后整段代码都被吞了，于是「有没有未声明变量」
 * 这一关永远报「没有」。要不是故意塞一个坏名字进去试，这个瞎点会一直藏着。
 *
 * 改完 public/index.html 或任何 check-* 之后，这个必须先过。
 * 无论成功失败，都会把原文件还原（长度比对确认）。
 */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const ROOT = 'D:/小鱼Agent';
const HTML = ROOT + '/public/index.html';
const GATES = ['scripts/check-ui.mjs', 'scripts/check-identifiers.mjs', 'scripts/check-frontend-refs.mjs'];

const orig = fs.readFileSync(HTML, 'utf8');

/* 【锁 · 2026-11-05】这个脚本会临时改写正式页面。
 * 如果同时还有别的检查在读它（或者两个自己撞上），另一个会读到「故意改坏」
 * 的那一版 —— 轻则误报，重则把坏版本当成原文备份回去。
 * 所以开工前先抢一把锁，抢不到就直接跳过，绝不并行。 */
const LOCK = 'D:/小鱼Agent/sandbox/.gates-self.lock';
/**
 * 抢锁。抢不到先别急着跳过：上一把锁很可能是被强杀留下的死锁
 * （进程没了，锁文件还在）。那种情况下永远跳过，等于这一关永久失效 ——
 * 所以看一眼锁里那个 PID 还活着没，没活着就当废锁清掉重抢。
 */
function pidAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
let gotLock = false;
for (let attempt = 0; attempt < 2 && !gotLock; attempt++) {
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
    gotLock = true;
  } catch (e) {
    let holder = 0;
    try { holder = parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10); } catch {}
    if (pidAlive(holder)) {
      console.log('· 另一个自检正在跑（锁主 PID ' + holder + '），这次跳过，不并行改文件。');
      process.exit(0);
    }
    console.log('· 清掉上一把死锁（PID ' + (holder || '?') + ' 已经不在了）');
    try { fs.unlinkSync(LOCK); } catch {}
  }
}
if (!gotLock) { console.log('· 抢锁失败，跳过。'); process.exit(0); }
const dropLock = () => { try { fs.unlinkSync(LOCK); } catch {} };
process.on('exit', dropLock);
process.on('SIGINT', () => { dropLock(); process.exit(130); });


/* 【安全】这个脚本会临时改写正式页面。万一中途被 Ctrl+C / 断电打断，
 * 页面就留在「故意改坏」的版本上 —— 那是最糟的情况。
 * 所以动手前先落一份备份；启动时如果发现上次留了备份，先还原再干活。 */
const BAK = ROOT + '/sandbox/_gateself-backup.html';
if (fs.existsSync(BAK)) {
  const b = fs.readFileSync(BAK, 'utf8');
  const cur = fs.readFileSync(HTML, 'utf8');
  /* 【2026-11-06 修】原来只在「备份比现在长」时才还原。
   * 可有些破坏是把字改短（少个右括号、换个符号），那份永远还原不了，
   * 被 SIGTERM 杀掉之后残骸就留在页面上了。备份在 = 上次没跑完，一律还原。 */
  if (b !== cur) {
    fs.writeFileSync(HTML, b, 'utf8');
    console.log('⚠ 发现上次被打断留下的备份，已先还原页面');
  }
  fs.unlinkSync(BAK);
}
fs.writeFileSync(BAK, orig, 'utf8');
/* 【2026-11-06 修】原来只监听 SIGINT（Ctrl+C）。
 * 但被「跑命令超时被杀」时收到的是 SIGTERM —— 那条路没人管，
 * 破坏就留在页面上了：addSysNote 里被塞进 zzzMissingVarX，一调就抛 ReferenceError。
 * 几种退出方式统一走同一个还原函数，一个都不许漏。 */
const _restore = (code) => {
  try { fs.writeFileSync(HTML, orig, 'utf8'); } catch {}
  try { fs.unlinkSync(BAK); } catch {}
  process.exit(code);
};
process.on('SIGINT', () => _restore(130));
process.on('SIGTERM', () => _restore(143));
process.on('SIGBREAK', () => _restore(149));
process.on('SIGHUP', () => _restore(129));
process.on('uncaughtException', () => _restore(1));
process.on('unhandledRejection', () => _restore(1));

const cases = [
  { name: '少一个右括号', apply: (s) => s.replace('function addSysNote(text, actions) {', 'function addSysNote(text, actions) {{') },
  { name: '写个中文分号', apply: (s) => s.replace('function addSysNote(text, actions) {', 'function addSysNote(text, actions) {；') },
  { name: '调用一个没声明的函数', apply: (s) => s.replace('function addSysNote(text, actions) {', 'function addSysNote(text, actions) { zzzMissingFn();') },
  { name: '引用一个没声明的驼峰变量', apply: (s) => s.replace('function addSysNote(text, actions) {', 'function addSysNote(text, actions) { const q = zzzMissingVarX + 1;') },
];

/* 【2026-11-05 记录·已知边界，别当 FAIL】
 *
 * 下面这一条是 check-ui「疑似未定义变量」这项能力的真实边界：它靠裸名的**用法规格**认变量
 * （名字后面跟左括号 / && / || / ? / . / =），而注入点在函数体里、且是 `zzzMissingFn();`
 * 这种形态时，剥离注释和字符串之后那一段被它整段跳过，于是认不出来。
 *
 * 以前这里看着是「4 条全抓到」，其实是虚的：页面里常年有一条 uFFFD 的误报，输出里总有
 * 一个 ✘，于是这四条不管真的抓到没抓到，都被判定成「抓到了」。2026-11-05 把那条误报
 * 从源头消掉（页面里坏的替换字符改用 \u{FFFD} 的写法，函数行为逐字不变）之后，
 * 真相才露出来：函数体里注入的裸名，这条检查器认不出。驼峰那条是真能抓到的，所以没列进来。
 *
 * 不修它，是因为要修就得重写那段的裸名提取（会带出一大片误报，收益不划算）。标成已知
 * 边界：照样打印、照样看得见，但不算 FAIL —— 真正的防线是 check-identifiers 扫全部文件，
 * 以及这四条里另外三条（括号、中文分号、驼峰变量）依然实打实地抓 —— 其中驼峰那条
 */
/* 【2026-11-06 更新】上面这段说的边界已经不作数了。
 * 修 stripCommentsAndStrings 不认正则字面量那个 bug 之后，裸代码保留率从 16.6% 回到 64.5%，
 * 「调用一个没声明的函数」这条也实打实抓得住了 —— 实测四条全 ✔。
 * 所以这里清空：一条已知边界都不留，以后再有放过就是真回归。 */
const KNOWN_GAPS = new Set();

let bad = 0;
try {
  for (const c of cases) {
    const broken = c.apply(orig);
    if (broken === orig) { console.log('✘ 用例没生效（锚点变了）：' + c.name); bad++; continue; }
    fs.writeFileSync(HTML, broken, 'utf8');
    const hit = [];
    for (const g of GATES) {
      const r = spawnSync('node', [g], { cwd: ROOT, encoding: 'utf8' });
      if (r.status !== 0) {
        const out = (r.stdout || '') + (r.stderr || '');
        const flagged = /✘|致命|没声明|未声明|没有声明|SyntaxError|Unexpected/.test(out);
        if (flagged) hit.push(g.replace('scripts/check-', '').replace('.mjs', ''));
      }
    }
    fs.writeFileSync(HTML, orig, 'utf8');
    console.log((hit.length ? '✔ 抓到了' : '✘ 全放过') + ' — ' + c.name + (hit.length ? '（' + hit.join(', ') + '）' : ''));
    if (!hit.length) {
      if (KNOWN_GAPS.has(c.name)) { console.log('    （这条是上面写明的已知边界，不算 FAIL）'); }
      else bad++;
    }
  }
} finally {
  fs.writeFileSync(HTML, orig, 'utf8');
}

const diff = fs.readFileSync(HTML, 'utf8').length - orig.length;
console.log('\n原文已还原，长度差 = ' + diff);
console.log('· 已知边界：纯小写未声明变量（如 zzzmissingvar）查不出来 —— 小写裸名误报太多，不做。');
try { fs.unlinkSync(BAK); } catch {}
if (diff !== 0) { console.log('✘ 还原失败，长度不对，赶紧手工核对！'); process.exit(1); }
console.log(bad ? 'FAIL 有 ' + bad + ' 处破坏没人管' : 'PASS 破坏都被检查器抓到');
process.exit(bad ? 1 : 0);
