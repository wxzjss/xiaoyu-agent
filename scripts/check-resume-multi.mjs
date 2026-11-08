/**
 * 【重启/续跑这一整套】
 *
 * 主人 2026-11-07 连着报了四件，全是同一个链条上的：
 *
 *   ① 「有时候只自动重启，没有续跑」
 *      → peekInterrupted() 是白名单，偏偏漏了 intent；server 那句
 *        _explicitIntent 永远 false，"上一轮看起来说完了"就直接跳过。
 *
 *   ② 「一个会话续跑了，另一个正在跑的会话就停了」
 *      → resume.json 老结构只有一个坑位；退出时那段更直接，找到第一个有活的会话
 *        就 break。两个会话同时跑，必丢一个。
 *
 *   ③ 「有其他会话在跑时，重启得问主人」（主人自己定的底线）
 *      → 原来没有这道闸，模型一声不吭就把所有会话一起掐断。
 *
 *   ④ 「说是重启，其实只是退出了，得我手动双击」
 *      → 老实现 `app.relaunch(); app.exit(0);`：
 *        exit 是硬退，跳过 before-quit 的 5 秒收尾（草稿没落盘 → 续跑信息本来就是残的）；
 *        而且新进程抢单实例锁抢早了，拿不到就直接退。
 *
 * 这个检查盯的是「行为」，不只是代码在不在 —— 续跑那部分用独立数据目录真跑一遍。
 */
import { makeChecker } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const t = makeChecker('resume / 重启与续跑');
const resume = fs.readFileSync('src/resume.mjs', 'utf8');
const server = fs.readFileSync('src/server.mjs', 'utf8');
const tools = fs.readFileSync('src/tools.mjs', 'utf8');
const main = fs.readFileSync('electron/main.cjs', 'utf8');

// ── 1. 源码守卫：这四件的关键接线 ─────────────────────────────
t.ok('① intent 在读取白名单里', /intent: String\(j\.intent \|\| ''\)/.test(resume));
t.ok('① 续跑判定用的是 intent', /String\(info && info\.intent \|\| ''\) === 'continue'/.test(server));
t.ok('② 记录支持多条（v2 格式）', /v: 2, items/.test(resume));
t.ok('② 写入是按会话 upsert，不覆盖', /filter\(\(x\) => String\(x\.sessionId\) !== sessionId\)/.test(resume));
/* 【2026-11-07 改口径】现在先取全部、再按 autoResume 过滤：
 * 只有「真被打断」的自动续，清单老账留着等主人手动点。
 * （原来的断言是「遍历 listInterrupted」，一字不差地匹配旧写法，改动就报红。） */
t.ok('② 开机取全部待续，再按 autoResume 过滤',
  /const pendingAll = listInterrupted\(\)/.test(server)
  && /pendingAll\.filter\(\(x\) => x && x\.autoResume === true\)/.test(server));
t.ok('② 只有「真被打断」才标 autoResume', /autoResume: Boolean\(_qlive\)/.test(server));
t.ok('② 续跑函数能指定会话', /async function resumeInterruptedTurn\(onlySessionId\)/.test(server));
t.ok('② 跑完只删自己那条', /dropInterrupted\(sessionId\)/.test(server));
t.ok('② 退出时遍历每个有活的会话', /const _cand = \[\];/.test(server) && /for \(const _qsid of _cand\)/.test(server));
t.ok('③ 有别 的会话在跑时回 409 拦一道', /needConfirm: true/.test(server) && /409/.test(server));
t.ok('③ 重启工具带 force 参数', /force: Boolean\(force\)/.test(tools));
t.ok('③ 工具能识别 409 并去问主人', /r\.status === 409/.test(tools));
t.ok('④ 重启走 quit 而不是硬退', /app\.relaunch\(\{ args:/.test(main) && /quitting = true;[\s\S]{0,120}app\.quit\(\)/.test(main));
t.ok('④ 自家重启起来时先等老进程让锁', /RELAUNCH_FLAG/.test(main) && /Atomics\.wait/.test(main));

// ── 2. 行为验证：真的写两条、真的只删一条 ────────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const tmpData = mkdtempSync(join(tmpdir(), 'resume-probe-'));
const probe = spawnSync(process.execPath, [join(__dir, 'resume-probe.mjs')], {
  cwd: join(__dir, '..'),
  env: { ...process.env, MINI_AGENT_DATA: tmpData },
  encoding: 'utf8',
  timeout: 60000,
});
try { rmSync(tmpData, { recursive: true, force: true }); } catch {}

let got = null;
try { got = JSON.parse(String(probe.stdout || '').trim().split('\n').pop()); } catch {}
t.ok('探针跑起来了', probe.status === 0 && !!got, String(probe.status) + ' ' + String(probe.stderr || '').slice(0, 160));
if (got) {
  t.ok('两个会话各留一条（后写不覆盖先写）', got.count === 2, String(got.count));
  t.ok('intent 能读出来（「只重启不续跑」的根）', got.intentA === 'continue', String(got.intentA));
  t.ok('只删一条，另一条还在', got.leftAfterDrop === 'sidB', String(got.leftAfterDrop));
  t.ok('无参 peek 仍返回剩下那条（老调用点不坏）', got.anyId === 'sidB', String(got.anyId));
  t.ok('v1 老格式照样读得出来', got.legacyId === 'legacy', String(got.legacyId));
  t.ok('探针内部无失败项', got.ok === true, (got.steps || []).join(' | ').slice(0, 200));
}

/* 【2026-11-08 加·点重启时别把别的会话丢下】
 *
 * 主人问：「A 会话自动重启续上时，另一个正在运行中的 B 会话在自动重启后也会续上吗？」
 * 查下来原来答案是「不会」：前端那个重启按钮一定带 sessionId，
 * 后端 `_cands = _want ? [_want] : [...runningTurns.keys()]` 于是只记当前这一个，
 * 同时跑的 B 连续跑意图都没写。
 *
 * 现在要求：带 id 时，_want 排第一，其余 running 的一个不落跟在后面。 */
{
  const srv = fs.readFileSync('src/server.mjs', 'utf8');
  t.ok('点重启时：其余正在跑的会话也跟着记',
    /_want\s*\n?\s*\?\s*\[_want,\s*\.\.\.\[\.\.\.runningTurns\.keys\(\)\]/.test(srv));
  t.ok('点重启时：目标会话排在第一个（优先续）',
    /\[_want,\s*\.\.\.\[\.\.\.runningTurns\.keys\(\)\]\.filter\(\(x\) => x !== _want\)\]/.test(srv));
  /* 前端那条路必须还在带 sessionId —— 上面那条断言的存在意义就靠它 */
  const ui = readUISource();
  t.ok('前端点重启确实会带 sessionId（所以上面那条才必须）',
    /api\/app\/restart',\s*\{[\s\S]{0,200}sessionId:/.test(ui));
}

t.done();
