/**
 * 【2026-11-12 端到端实测·硬杀后续跑账还在不在（主人钦定修续跑机制）】
 * 流程：起隔离实例 → 造黑洞端点 → 建会话 → 发消息（轮子挂住）→ 查 resume.json 有账
 *   → taskkill 硬杀服务 → 同数据目录再起服务 → 等 boot-resume → 查 diag 日志证明自动续跑真的触发。
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log('  [ok]', name, detail); }
  else { fail++; console.log('  [!!]', name, detail); }
};

/* ① 黑洞端点：accept 但永不回话，让轮子一直挂着 */
const bh = net.createServer((s) => { /* 故意不响应 */ s.on('error', () => {}); });
const BH_PORT = Number(process.env.XY_BH_PORT || 0) || (18000 + Math.floor(Math.random() * 900));
await new Promise((r) => bh.listen(BH_PORT, '127.0.0.1', r));
const BH_BASE = 'http://127.0.0.1:' + BH_PORT + '/v1';

const { startIsolated } = await import(pathToFileURL(join(ROOT, 'scripts', '_test-instance.mjs')).href);
const iso = await startIsolated({ appPort: 8997, cdpPort: 9397 });
let spawned = null;
try {
  /* ② 把激活模型换成黑洞（真实 key 一分不花） */
  const mpath = join(iso.dataDir, '.state', 'models.json');
  writeFileSync(mpath, JSON.stringify({
    models: [{ id: 'm_blackhole', name: '黑洞', model: 'fake-model', baseURL: BH_BASE, apiKey: 'test' }],
    activeId: 'm_blackhole',
  }, null, 2));

  /* ③ 建会话（屋里必须有能说话的人，开机续跑有这道闸） */
  const sess = await fetch(iso.base + '/api/sessions/new', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: '续跑账实测', agentIds: ['xiaoyu'] }),
  }).then((r) => r.json());
  const sid = sess?.session?.id || sess?.id;
  ok('建会话', Boolean(sid), sid || JSON.stringify(sess).slice(0, 120));
  if (!sid) throw new Error('没建出会话');

  /* ④ 发消息（不 await 轮子跑完） */
  fetch(iso.base + '/api/chat', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, message: '续跑账本实测：这轮要被硬杀' }),
  }).catch(() => {});

  /* ⑤ 轮开局就该写账 */
  let entry = null;
  for (let i = 0; i < 30; i++) {
    await sleep(300);
    const p = join(iso.dataDir, '.state', 'resume.json');
    if (existsSync(p)) {
      try { const arr = JSON.parse(readFileSync(p, 'utf8')); entry = (arr.items || arr || []).find?.((x) => x?.sessionId === sid) || (Array.isArray(arr) ? arr.find((x) => x?.sessionId === sid) : null); } catch {}
      if (entry) break;
    }
  }
  ok('轮开局写了续跑账（autoResume:true）', Boolean(entry), entry ? `intent=${entry.intent} autoResume=${entry.autoResume} taskLine=${String(entry.taskLine || '').slice(0, 40)}` : 'resume.json 里没有这条');

  /* ⑥ 硬杀服务（taskkill /F，不走任何优雅路径） */
  const { execSync } = await import('node:child_process');
  const out = execSync(`netstat -ano | findstr :${new URL(iso.base).port} | findstr LISTENING`, { encoding: 'utf8' });
  const pid = String(out).trim().split(/\s+/).pop();
  ok('找到服务 PID', /^\d+$/.test(pid), pid);
  execSync(`taskkill /F /PID ${pid} /T`, { stdio: 'ignore' });
  await sleep(1500);

  const p2 = join(iso.dataDir, '.state', 'resume.json');
  let after = null;
  try { const arr = JSON.parse(readFileSync(p2, 'utf8')); after = (Array.isArray(arr) ? arr : arr.items || []).find((x) => x?.sessionId === sid); } catch {}
  ok('硬杀后账还在（残留的账=待续轮）', Boolean(after), after ? `intent=${after.intent} autoResume=${after.autoResume}` : '账没了');

  /* ⑦ 同数据目录再起服务，等开机自续 */
  spawned = spawn(process.execPath, [join(ROOT, 'src', 'server.mjs')], {
    env: { ...process.env, MINI_AGENT_DATA: iso.dataDir, PORT: '8998', XY_TEST_INSTANCE: '1', XY_REQUIRE_ISOLATED: '0' },
    stdio: 'ignore',
  });
  await sleep(15000);   // boot-resume 启动 8 秒后自续
  const diag = existsSync(join(iso.dataDir, '.state', 'diag.log')) ? readFileSync(join(iso.dataDir, '.state', 'diag.log'), 'utf8') : '';
  const tail = diag.split('\n').filter((l) => /boot-resume|resume-enter|resume-skip|resume-fail/.test(l)).slice(-6);
  ok('开机续跑真的触发（不是 skip:none）', /boot-resume-enter/.test(diag) && !/boot-resume-skip:none/.test(diag.split('boot-resume-enter').pop() || ''), tail.join(' | ').slice(0, 400));
  console.log('  续跑日志：\n    ' + tail.join('\n    '));
} catch (e) {
  fail++;
  console.error('实测炸了：', String(e && e.message || e).slice(0, 300));
} finally {
  try { if (spawned) spawned.kill(); } catch {}
  try { bh.close(); } catch {}
  try { await iso.stop(); } catch {}
  /* iso.stop 会删数据目录；硬杀服务后它的句柄可能还占着，稍等一下 */
  await sleep(800);
}
console.log(`\n硬杀续跑端到端：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
