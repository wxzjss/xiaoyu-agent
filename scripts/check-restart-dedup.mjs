/**
 * check-restart-dedup.mjs — 「同一个会话连着要求重启，第二次不许再杀一次」站岗
 *
 * 【2026-11-12 主人问「为什么你突然停下了」】查 diag.log 定性：
 *   16:35:14 quit → 记断点 → 16:35:15 重开 → 16:35:25 自动续跑
 *   → 16:35:50 又被要求重启 → 续跑跑到一半被掐 → [resume-fail] quit
 *   → 界面上留「断在：重启了」，看起来就像我话说到一半自己停了。
 *
 * 根子：/api/app/restart 不挡「同一个会话自己在短时间内反复要求重启」。
 *
 * 这里钉死四件事：
 *  ① 闸存在，而且用的是 _reqSid（读 body 之后的那个），不是未定义的变量
 *  ② 闸的位置在真正执行重启之前（先挡后杀）
 *  ③ 45 秒窗口、回 202 + skipped:true，不是 500 也不是 401
 *  ④ __restartGuard 在模块顶层声明（不是函数里，作用域得对）
 *
 * 只做静态检查，不需要起服务；真机行为另跑 check-restart-dedup-live.mjs。
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log('  [ok] ' + m + (d ? '  ' + d : '')); } else { fail++; console.log('  [!!] ' + m + (d ? '  ' + d : '')); } };

/* ── ④ 顶层声明 ── */
const declIdx = src.indexOf('const __restartGuard = new Map();');
ok('__restartGuard 在模块顶层声明', declIdx > 0);
if (declIdx > 0) {
  const before = src.slice(Math.max(0, declIdx - 400), declIdx);
  ok('声明紧跟在 runningTurns 那一批顶层 Map 后面（没跑进函数里）',
    before.includes('const runningTurns = new Map();'));
}

/* ── ① 闸存在，用的是 _reqSid ── */
const guardIdx = src.indexOf('__restartGuard.get(_reqSid)');
ok('闸存在，键是 _reqSid', guardIdx > 0);
ok('闸里往表里写回时间戳', /__restartGuard\.set\(_reqSid,\s*_nowRs\)/.test(src));

/* _reqSid 必须先赋值再用 */
const assignIdx = src.indexOf("_reqSid = String(_b?.sessionId || '');");
ok('_reqSid 先赋值（读 body 之后）', assignIdx > 0);
ok('闸在 _reqSid 赋值之后（不会用到 undefined）', assignIdx > 0 && guardIdx > assignIdx,
  assignIdx > 0 ? 'assign L' + (src.slice(0, assignIdx).split('\n').length) + ' → guard L' + (src.slice(0, guardIdx).split('\n').length) : '');

/* ── ② 位置：在真正执行重启之前 ── */
/* 这条路的重启顺序是：闸 → 读 body 拿 _reqSid → _want = _reqSid → 挑续跑候选 → 写 resume.json → 让主进程 relaunch。
   所以只要闸在 `const _want = _reqSid;` 之前，就一定是「先挡后杀」。 */
const wantIdx = src.indexOf('const _want = _reqSid;');
ok('闸在「挑续跑候选（_want）」之前', wantIdx > 0 && guardIdx < wantIdx,
  wantIdx > 0 ? 'guard L' + (src.slice(0, guardIdx).split('\n').length) + ' < _want L' + (src.slice(0, wantIdx).split('\n').length) : '');
/* 这条路真正开杀的两处：返回 200（让工具那头当成功）和喊主进程 __xiaoyuRelaunch。
   闸必须都在它们前面 —— 否则第二次请求会先把进程杀了再发现该挡。 */
const okIdx = src.indexOf('json(res, 200, { ok: true })', guardIdx);
ok('闸在「回 200 让它真重启」之前', okIdx > 0);
const rlIdx = src.indexOf('globalThis.__xiaoyuRelaunch', guardIdx);
ok('闸在「喊主进程 relaunch」之前', rlIdx > 0);

/* ── ③ 45 秒 + 202 + skipped ── */
const guardSeg = src.slice(guardIdx - 1500, guardIdx + 1500);
ok('窗口是 45 秒', /45000/.test(guardSeg));
ok('挡下来回 202（不是 200 不是 500）', /json\(res, 202,/.test(guardSeg));
ok('回包里带 skipped: true', /skipped:\s*true/.test(guardSeg));
ok('带原因码，日志/前端能认', /same-session-recent-restart/.test(guardSeg));
ok('清理过期条目，表不会无限涨', /__restartGuard\.delete\(k\)/.test(guardSeg));

/* ── 不许把 409「别的会话在跑」那条挡路改坏 ── */
ok('原来那条 409（别的会话在跑）还在', /409/.test(src) && src.indexOf('409') < guardIdx);

/* ── 不许删掉续跑意图 ── */
ok('restart 路径还带着 autoResume（没被这次改动误删）',
  /autoResume:\s*Boolean\(_live\)/.test(src));

console.log('\n── 重启去重闸：' + pass + '/' + (pass + fail) + (fail ? ' 有失败' : ' 全过') + ' ──');
process.exit(fail ? 1 : 0);
