#!/usr/bin/env node
/**
 * 【2026-11-10 D1 · 会话列表增量协议】scripts/check-sessions-rev.mjs
 *
 * 病根：/api/sessions 每次都把每个会话文件整个读出来解析（主人四十多个会话，
 * 列表轮询一次就是一轮全量 IO），前端 B5 的 keyed diff 也只能建立在全量响应上。
 *
 * 修法：/api/sessions 加 rev 指纹（会话集拓扑 + 每会话文件 mtime/size
 * + 在跑集合 + 智能体卡/设置文件 mtime + 最近会话 id）。
 *   · rev 没变 → 绝不重算 sessions 数组（带 ?rev= 回轻量 304 语义；不带 rev 回缓存 payload）
 *   · rev 变了 → 全量计算并刷新缓存
 *
 * 这个检查起一个**隔离的服务进程**（临时 MINI_AGENT_DATA + 空闲端口，
 * 绝不碰主人的 8788 与数据），对真接口断言四件事：
 *   ① 首拉回全量（带 rev / unchanged 字段，向后兼容：sessions / lastSessionId 照旧）
 *   ② rev 未变：带 ?rev= 的响应是轻量的 —— **没有 sessions 数组**（304 语义，
 *      「不重算数组」的可观察面就是它）
 *   ③ 变更之后（新建 / 改名 / 删除）：rev 必变，重拉回全量，内容跟着变
 *   ④ 源码守卫：指纹函数里不许出现 listSessions（便宜指纹，不许读会话内容），
 *      路由里缓存短路必须发生在 listSessions 之前
 *
 * 用法：node scripts/check-sessions-rev.mjs
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('sessions / 会话列表增量协议（rev 指纹）');
const ROOT = path.resolve(import.meta.dirname, '..');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 源码守卫（不依赖服务进程） ─────────────────────────────── */
const srvSrc = fs.readFileSync(path.join(ROOT, 'src/server.mjs'), 'utf8');
t.ok('指纹函数存在', /function sessionsFingerprint\(/.test(srvSrc));
t.ok('有响应缓存（指纹没变不重算）', /__sessionsCache\s*=\s*\{\s*fp/.test(srvSrc));
{
  /* 指纹必须便宜：函数体里不许读会话内容 */
  const i = srvSrc.indexOf('function sessionsFingerprint(');
  const j = srvSrc.indexOf('{', i);
  let d = 0, body = '';
  for (let k = j; k < srvSrc.length; k++) {
    if (srvSrc[k] === '{') d++;
    else if (srvSrc[k] === '}') { d--; if (!d) { body = srvSrc.slice(j, k + 1); break; } }
  }
  t.ok('指纹函数不读会话内容（不调 listSessions / loadSession / readFileSync 会话）',
    !/listSessions|loadSession|\.state', 'sessions'/.test(body));
  t.ok('指纹覆盖在跑集合', /runningTurns/.test(body));
  t.ok('指纹覆盖智能体卡与设置（agentId/crew 依赖它们）',
    /agents\.json/.test(body) && /settings\.json/.test(body));
}
/* 路由里：缓存短路必须出现在 listSessions 之前（指纹没变就绝不碰全量计算） */
{
  const i = srvSrc.indexOf("url.pathname === '/api/sessions'");
  const route = srvSrc.slice(i, srvSrc.indexOf("url.pathname === '/api/sessions/search'"));
  const atCache = route.indexOf('__sessionsCache.fp === fp');
  const atList = route.indexOf('listSessions().map');
  t.ok('路由先看缓存指纹、再全量计算（短路在 listSessions 之前）',
    atCache >= 0 && atList > atCache, 'cache@' + atCache + ' list@' + atList);
  t.ok('轻量响应不带 sessions 数组（304 语义）',
    /unchanged:\s*true,[\s\S]{0,200}lastSessionId/.test(route) && !/unchanged: true,[\s\S]{0,300}sessions:/.test(route));
}

/* ── 起隔离服务进程（不带浏览器：这里只测接口，不需要真机） ── */
function pickFreePort(start) {
  return start; // 起不来会换，见下
}

async function waitBase(child, buf) {
  for (let i = 0; i < 100; i++) {
    const m = /running:\s*http:\/\/127\.0\.0\.1:(\d+)/.exec(buf());
    if (m) {
      const base = 'http://127.0.0.1:' + m[1];
      try { if ((await fetch(base + '/api/health')).ok) return base; } catch {}
    }
    await sleep(300);
  }
  return '';
}

let child = null;
let DATA = '';
try {
  DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-sessions-rev-'));
  fs.mkdirSync(path.join(DATA, '.state', 'sessions'), { recursive: true });

  let base = '';
  for (let port = 8796; port < 8808 && !base; port++) {
    const out = [];
    child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: ROOT,
      env: { ...process.env, MINI_AGENT_DATA: DATA, PORT: String(port), XY_TEST_INSTANCE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => out.push(String(d)));
    child.stderr.on('data', (d) => out.push(String(d)));
    base = await waitBase(child, () => out.join(''));
    if (!base) {
      try { child.kill(); } catch {}
      child = null;
    }
  }
  t.ok('隔离服务进程起来了（不碰 8788）', Boolean(base), base);

  const get = async (q = '') => {
    const r = await fetch(base + '/api/sessions' + q, { signal: AbortSignal.timeout(10000) });
    return { status: r.status, body: await r.json() };
  };
  const post = async (p, payload) => {
    const r = await fetch(base + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: AbortSignal.timeout(10000),
    });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };

  /* ① 首拉：全量 + rev */
  const first = await get();
  const R1 = first.body.rev;
  t.ok('① 首拉回 200', first.status === 200);
  t.ok('① 首拉带 rev 指纹', typeof R1 === 'string' && R1.length >= 8, String(R1));
  t.ok('① 首拉带 sessions 数组（向后兼容）', Array.isArray(first.body.sessions), String(first.body.sessions?.length));
  t.ok('① 首拉带 lastSessionId（向后兼容）', 'lastSessionId' in first.body);
  t.ok('① 首拉 unchanged:false', first.body.unchanged === false);

  /* ② rev 未变：轻量响应，不重算数组 */
  const same = await get('?rev=' + encodeURIComponent(R1));
  t.ok('② rev 未变 → unchanged:true', same.body.unchanged === true, JSON.stringify(same.body).slice(0, 120));
  t.ok('② 轻量响应不带 sessions 数组（没重算）', !('sessions' in same.body));
  t.ok('② rev 与首拉一致', same.body.rev === R1);

  /* 不带 rev 的重复请求：回缓存 payload（也不重算），sessions 照旧在（老前端兼容面） */
  const again = await get();
  t.ok('② 不带 rev 的重复请求也不重算（回缓存），sessions 照旧给',
    again.body.unchanged === false && Array.isArray(again.body.sessions) && again.body.rev === R1);

  /* ③ 新建会话：rev 必变 */
  const created = await post('/api/sessions/new', { title: '增量协议测试' });
  const sid = String(created.body?.session?.id || created.body?.id || '');
  t.ok('③ 新建成功', created.status === 200 && Boolean(sid), JSON.stringify(created.body).slice(0, 80));
  const afterNew = await get('?rev=' + encodeURIComponent(R1));
  t.ok('③ 新建后 rev 必变', afterNew.body.unchanged === false && afterNew.body.rev !== R1,
    'old=' + R1 + ' new=' + afterNew.body.rev);
  t.ok('③ 重拉回全量且多了一条', Array.isArray(afterNew.body.sessions) && afterNew.body.sessions.length === 1,
    String(afterNew.body.sessions?.length));
  const R2 = afterNew.body.rev;
  const same2 = await get('?rev=' + encodeURIComponent(R2));
  t.ok('③ 新 rev 再问又是轻量的', same2.body.unchanged === true && !('sessions' in same2.body));

  /* ③-b 改名（改会话文件内容 → mtime/size 变 → rev 必变） */
  const rn = await post('/api/sessions/rename', { id: sid, title: '改名后的会话' });
  t.ok('③-b 改名成功', rn.status === 200, JSON.stringify(rn.body).slice(0, 80));
  const afterRename = await get('?rev=' + encodeURIComponent(R2));
  t.ok('③-b 改名后 rev 必变（会话文件 mtime/size 反映进指纹）',
    afterRename.body.unchanged === false && afterRename.body.rev !== R2);
  t.ok('③-b 全量里标题跟着变了',
    afterRename.body.sessions?.[0]?.title === '改名后的会话', String(afterRename.body.sessions?.[0]?.title));

  /* ③-c 删除：拓扑变化 → rev 必变 */
  const del = await post('/api/sessions/delete', { id: sid });
  t.ok('③-c 删除成功', del.status === 200, JSON.stringify(del.body).slice(0, 80));
  const afterDel = await get('?rev=' + encodeURIComponent(afterRename.body.rev));
  t.ok('③-c 删除后 rev 必变、列表空了',
    afterDel.body.unchanged === false && afterDel.body.rev !== afterRename.body.rev
    && Array.isArray(afterDel.body.sessions) && afterDel.body.sessions.length === 0,
    String(afterDel.body.sessions?.length));

  /* ④ 老前端兼容：从头到尾不带 rev 的请求拿到的形状跟以前一样 */
  const legacy = await get();
  t.ok('④ 不带 rev 永远回全量（老前端只认 sessions/lastSessionId 也照常工作）',
    Array.isArray(legacy.body.sessions) && 'lastSessionId' in legacy.body && typeof legacy.body.rev === 'string');
} catch (err) {
  t.ok('检查脚本本身没崩', false, String((err && err.stack) || err));
} finally {
  if (child) { try { child.kill(); } catch {} }
  await sleep(300);
  try { if (DATA) fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
  t.done();
}
