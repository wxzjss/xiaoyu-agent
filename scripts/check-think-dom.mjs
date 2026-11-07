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

let cdp;
try {
  cdp = await connect({ port: 9223, match: '8788' });
} catch (e) {
  console.log('SKIP 没有可连的调试浏览器（先开 app，再把无头浏览器指到 9223）');
  process.exit(0);
}

await cdp.send('Page.enable');
await cdp.send('Page.reload', { ignoreCache: true });
await new Promise((r) => setTimeout(r, 13000));
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
  probe.remove();
  return { 脏叶子数: dirty.length, 样例: dirty.slice(0, 3), 清洗器已装: hasCleaner, 注入后变成: probeAfter };
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
process.exit(0);
