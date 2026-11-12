/**
 * check-restart-dedup-live.mjs — 真机实测：同会话连打两次重启，第二次必须被挡
 *
 * 【2026-11-12 主人问「你为什么突然停下了」】
 * 查 diag.log 定下来的链条：
 *   16:35:14 打 /api/app/restart → 这一轮被杀、记 autoResume
 *   16:35:15 进程起来 → 16:35:25 boot-resume 自动续跑
 *   16:35:50 我又打了一次重启 → 续跑跑到一半被掐 → [resume-fail] quit
 *   → 界面上留在断点「断在：重启了」
 * 修法是给 /api/app/restart 加一道「同一会话 45 秒内只准杀一次」的闸。
 * 这个脚本真起一个隔离实例，连打两次，验证第二次确实被挡（202 + skipped），
 * 而不是又杀一次。
 */
import { startIsolated } from './_test-instance.mjs';

let pass = 0; let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  [ok] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [!!] ' + name + (extra ? '  ' + extra : '')); }
};

const inst = await startIsolated({ appPort: 8806, cdpPort: 9233 });
const base = inst.base;
const sid = 'test-dedup-' + Date.now();

const post = async (path, body) => {
  const t0 = Date.now();
  try {
    const r = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(6000),
    });
    let j = null;
    try { j = await r.json(); } catch { j = null; }
    return { status: r.status, json: j, ms: Date.now() - t0 };
  } catch (e) {
    return { status: 0, error: String(e && e.message || e), ms: Date.now() - t0 };
  }
};

console.log('\n── 重启去重闸 · 真机 ──');

/* ① 第一次：隔离实例里没有真 electron 主进程，XIAOYU_DESKTOP 不是 1，
 *    所以会走到 501「这个窗口不是从桌面图标打开的」。这本身是对的，
 *    但我要验的是闸在它前面还是后面 —— 闸在 501 后面，就挡不到。
 *    先确认这条路径的先后，再看 ② 能不能挡住。 */
const r1 = await post('/api/app/restart', { sessionId: sid, byTool: true });
console.log('  第一次 → ' + r1.status + '  ' + JSON.stringify(r1.json || r1.error).slice(0, 130));
ok('第一次没把实例搞崩（有响应）', r1.status === 200 || r1.status === 202 || r1.status === 501 || r1.status === 409);

/* ② 紧接着第二次：必须被闸挡下 */
const r2 = await post('/api/app/restart', { sessionId: sid, byTool: true });
console.log('  第二次 → ' + r2.status + '  ' + JSON.stringify(r2.json || r2.error).slice(0, 130));

if (r1.status === 501) {
  /* 隔离环境里没有 electron，走不到真重启。那么去验闸本身的行为：
   * 闸在 501 之前的话，第二次应该被闸挡成 202。如果还是 501，
   * 说明闸在 501 后面 —— 那顺序就错了，得挪。 */
  ok('第二次被闸挡住（202 + skipped），不是又走到 501', r2.status === 202,
    '实际 ' + r2.status);
  ok('回包里带 skipped', !!(r2.json && r2.json.skipped));
} else {
  ok('第二次被闸挡住（202）', r2.status === 202, '实际 ' + r2.status);
  ok('回包里带 skipped', !!(r2.json && r2.json.skipped));
}

/* ③ 换个会话，不该被上一个会话的闸连坐 */
const r3 = await post('/api/app/restart', { sessionId: 'other-' + Date.now(), byTool: true });
ok('别的会话不受影响（不是 202 skipped）', !(r3.json && r3.json.skipped),
  '实际 ' + r3.status);

console.log('\n── 重启去重闸真机：' + pass + '/' + (pass + fail) + (fail ? ' 有失败' : ' 全过') + ' ──');
try { await inst.stop(); } catch { /* 已经关了 */ }
process.exit(fail ? 1 : 0);
