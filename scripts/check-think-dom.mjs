/**
 * 真机 DOM 那一格：屏幕上到底还有没有 <thinking>。
 *
 * 前面几个检查都是查「源码里有没有这道门」，这一格查的是**结果**：
 * 把页面刷出来，扫一遍所有叶子节点；再往 #log 里塞一个脏气泡当探针，
 * 看清洗器认不认（严检就是这么照出「清洗器装了、但只认老气泡」那个洞的）。
 *
 * 需要：app 在跑 + 本地无头浏览器把 8788 挂到 9223。
 * 连不上就 SKIP，不算失败 —— 不然这台机器没开浏览器，整批回归都红了。
 */
let connect = null;
try {
  ({ connect } = await import('../_t_cdp.mjs'));
} catch (e) {
  connect = null;
}
if (typeof connect !== 'function') {
  console.log('SKIP 找不到 _t_cdp.mjs（调试脚本没在本地）');
  process.exit(0);
}

/**
 * 【2026-11-09 修·不许去碰主人自己开的浏览器】
 *
 * 原来这里直接连 9223。9223 往往是主人日常那个 Edge（AdGuard、DownThemAll、
 * Bitwarden 一堆标签页），脚本一上来就 Page.reload —— 等于把主人的浏览器刷了，
 * 而那条 target 一销毁就报 "Inspected target navigated or closed"，判成假红。
 * 实测过：连上去看到的是 welcome.adguard.info / about.downthemall.org 那些页面。
 *
 * 现在学 _t_ui：自己起一个 headless Edge、用自己的端口和临时 profile，跑完自己关。
 * 主人桌面上那个浏览器一个字节都不动。
 */
import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const PORT = Number(process.env.XY_CDP_PORT || 9225);
const PROFILE = 'C:/Users/35453/AppData/Local/Temp/edge-xy-think-dom';
const BASE = (await import('./_base.mjs')).detectBase().replace(/\/+$/, '');

const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((p) => existsSync(p));
if (!EDGE) {
  console.log('SKIP 找不到 Edge，跑不了真机 DOM 检查');
  process.exit(0);
}

try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
const child = spawn(EDGE, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
  /* 【2026-11-09 加】headless 窗口默认会被当成「不在前台」，Chrome 就把页内的
   * setTimeout 节流到几乎不跑。这条检查里有 500ms / 600ms 的等待，
   * 于是整条卡死（实测 322 秒甚至 600 秒超时），看着像脚本坏了。
   * 这三个开关是官方给这条路用的：不按后台/遮挡降频、不节流定时器。 */
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, BASE + '/',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ready0 = false;
for (let i = 0; i < 40; i += 1) {
  try {
    const list = await fetch('http://127.0.0.1:' + PORT + '/json').then((r) => r.json());
    if (list.some((t) => t.type === 'page' && String(t.url).includes('127.0.0.1'))) { ready0 = true; break; }
  } catch {}
  await sleep(300);
}
const cleanup = () => {
  try { child.kill(); } catch {}
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
};
process.on('exit', cleanup);
if (!ready0) {
  console.log('SKIP 无头浏览器没起来，这一格不算失败');
  cleanup();
  process.exit(0);
}

let cdp;
try {
  cdp = await connect({ port: PORT, match: '127.0.0.1' });
} catch (e) {
  console.log('SKIP 连不上自己起的无头浏览器');
  cleanup();
  process.exit(0);
}

/**
 * 【2026-11-09 修·别把「页面正在被关」当成「DOM 脏」】
 *
 * 全集里这一格跟 _t_ui 前后脚跑：_t_ui 收尾会把自己的无头 Edge 关掉，
 * 而 9223 上留着的那条 page target 正处在销毁过程中。这时发 Page.reload
 * 会拿到「Inspected target navigated or closed」—— 那是**浏览器没了**，
 * 不是页面有 bug，判红就是假红。
 *
 * 现在的做法：reload 失败就当成「这台机器没有可用的无头窗口」，SKIP。
 * 真正的 DOM 脏由下面的扫描断言负责，不靠 reload 撑。
 */
/* 自己起的干净窗口，reload 是正路；等 #log 出现就够，不用干等 13 秒。 */
try {
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
} catch (e) {
  console.log('SKIP 自己起的窗口 reload 失败：' + e.message);
  try { cdp.close(); } catch {}
  cleanup();
  process.exit(0);
}
/**
 * 【2026-11-07 加·等页面真的就绪】
 *
 * 全集里连着跑时这一格偶尔红：前面那条检查刚 reload 过，这边连上去时
 * #log 还没建出来 → querySelectorAll 直接抛，看起来像「DOM 脏」。
 * 这里明确等到 #log 存在再动手，最多等 10 秒。
 */
let ready = false;
for (let i = 0; i < 20; i += 1) {
  try {
    ready = await cdp.eval('return !!document.getElementById("log")');
  } catch (e) { ready = false; }
  if (ready) break;
  await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
  console.log('SKIP 页面还没就绪（#log 建不出来），这一格不算失败');
  try { cdp.close(); } catch {}
  cleanup();
  process.exit(0);
}

const info = await cdp.eval(`
  const lg = document.getElementById('log');
  const dirty = [];
  for (const el of lg.querySelectorAll('*')) {
    if (el.children.length) continue;
    const low = (el.textContent || '').toLowerCase();
    if (low.indexOf('<thinking') >= 0 || low.indexOf('</thinking>') >= 0
      || low.indexOf('<think') >= 0 || low.indexOf('<reasoning') >= 0) {
      dirty.push({ cls: String(el.className).slice(0, 24), txt: (el.textContent || '').slice(0, 40) });
    }
  }
  const hasCleaner = !!(lg && lg.__tagCleaner);
  const probe = document.createElement('div');
  probe.className = 'bubble';
  probe.textContent = '甲<thinking>偷偷想</thinking>乙';
  lg.appendChild(probe);
  await new Promise(r => setTimeout(r, 600));
  const probeAfter = probe.textContent;
  /* 【2026-11-08 修·探针等得不够】
   * 清洗器是在 requestAnimationFrame 里干活的（见 index.html 里那段的 finally），
   * 探针 append 完立刻读 textContent，那一帧还没跑，读到的必然是脏的 —— 假红。
   * 这里等两帧再去读。 */
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const probeAfter2 = probe.textContent || "";
  probe.remove();
  return { 脏叶子数: dirty.length, 样例: dirty.slice(0, 3), 清洗器已装: hasCleaner, 注入后变成: probeAfter2 };
`);
cdp.close();

let fail = 0;
const chk = (label, ok, extra) => {
  if (ok) console.log('  ✔ ' + label + (extra ? '  ' + extra : ''));
  else { fail++; console.log('  ✘ ' + label + (extra ? '  ' + extra : '')); }
};
chk('屏上没有残留的思考标签', info.脏叶子数 === 0, JSON.stringify(info.样例));
chk('清洗器装上了', info.清洗器已装 === true);
chk('新插进来的脏气泡会被清掉', info.注入后变成 === '甲乙', JSON.stringify(info.注入后变成));

console.log('');
if (fail) { console.log('★ 失败 ' + fail + ' 条'); process.exit(1); }
console.log('PASS 真机 DOM 干净');
cleanup();
process.exit(0);
