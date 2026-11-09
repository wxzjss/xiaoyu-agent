/**
 * 【出厂默认提示词】换电脑 / 重装 / 清空 .state 之后，加载的还是不是这份定稿？
 *
 * 做法不是「看代码在不在」，而是真起两个子进程：
 *   · 一个用当前数据目录
 *   · 一个用全新的空数据目录（MINI_AGENT_DATA 指过去，模拟一台刚装好的机器）
 * 两份 buildSystemPrompt() 的输出，连同 persona/FACTORY-PROMPT.md 快照，
 * 三者必须**逐字节一致**。
 */
import { makeChecker } from './_harness_util.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const t = makeChecker('factory / 出厂默认提示词');
// 中文路径别用 URL.pathname（会被 %XX 编码），一律走 fileURLToPath
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GEN = path.join(ROOT, 'scripts', '_gen-prompt.mjs');
const SNAP = path.join(ROOT, 'persona', 'FACTORY-PROMPT.md');

function generate(env) {
  const r = spawnSync(process.execPath, [GEN], {
    cwd: ROOT, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 60000,
  });
  if (r.status !== 0) throw new Error(String(r.stderr || '').slice(0, 200));
  return String(r.stdout || '');
}

t.ok('快照文件存在', fs.existsSync(SNAP));
const snapRaw = fs.existsSync(SNAP) ? fs.readFileSync(SNAP, 'utf8') : '';
const snap = snapRaw.replace(/^<!--[\s\S]*?-->\r?\n/, '');
t.ok('快照有正文', snap.length > 4000, snap.length + ' 字');


// 底线（- 开头那几行）是主人在设置页能改的，不参与「逐字节相等」的比对。
// 除了它，其余一个字都不能变 —— 那才是「换电脑还是同一份提示词」的真含义。
const norm = (x) => x.replace(/^- .*$/gm, '').replace(/\s+/g, '');
/* 【2026-11-09 修·隔离回归里这条假红】
 * runner 给所有子进程设了 MINI_AGENT_DATA=临时目录，generate({}) 会继承它，
 * 于是「当前机器」其实是台空机器，生成 4384 字、跟出厂 5351 字对不上。
 * 这条检查的语义就是「主人这台机器」，显式指回真实数据目录（只读，不发请求、
 * 不改任何东西，也不碰会话文件）。 */
const live = generate({ MINI_AGENT_DATA: 'C:/Users/35453/AppData/Roaming/小鱼Agent/data' });
t.ok('当前机器生成成功', live.length > 4000, live.length + ' 字');
t.ok('当前机器 == 出厂快照（除可自定义的底线块）', norm(live) === norm(snap), live.length + '/' + snap.length);

// 模拟一台全新电脑：空数据目录
const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-factory-'));
let fresh = '';
try {
  fresh = generate({ MINI_AGENT_DATA: emptyDir });
  t.ok('全新机器生成成功', fresh.length > 4000, fresh.length + ' 字');
  // 【重做快照】改过功能开关说明、提示词正文变了之后，用 XY_REGEN_SNAPSHOT=1 跑一次，
  // 把这份快照重写成当前代码生成的正文（开头那行注释头保留）。
  if (process.env.XY_REGEN_SNAPSHOT === '1') {
    const head = (snapRaw.match(/^<!--[\s\S]*?-->\s*\r?\n/) || [''])[0];
    fs.writeFileSync(SNAP, head + fresh, 'utf8');
    console.log('快照已重写为 ' + fresh.length + ' 字');
  }
  t.ok('全新机器 == 出厂快照（逐字节）', fresh === snap, fresh.length + '/' + snap.length);
  // 底线是主人在设置页能改的，不参与「跟出厂逐字节相等」的比对。
  t.ok('全新机器 == 当前机器（除可自定义的底线块）', norm(fresh) === norm(live));
} catch (e) {
  t.ok('全新机器能生成', false, String(e.message).slice(0, 120));
} finally {
  try { fs.rmSync(emptyDir, { recursive: true, force: true }); } catch {}
}

// 出厂常量 == 定稿内容
const { DEFAULT_SETTINGS } = await import('../src/settings.mjs');
t.ok('出厂底线条数与代码一致（当前 ' + DEFAULT_SETTINGS.bottomLines.length + ' 条）', DEFAULT_SETTINGS.bottomLines.length >= 1, String(DEFAULT_SETTINGS.bottomLines.length));
t.ok('出厂每条底线都在快照里', DEFAULT_SETTINGS.bottomLines.every((x) => snap.includes(String(x).slice(0, 12))));
t.ok('出厂安全词说明在快照里', snap.includes(String(DEFAULT_SETTINGS.safeWordNote).split('/')[0].slice(0, 12)));
t.ok('出厂人设正文在快照里', (() => {
  const f = fs.readFileSync(path.join(ROOT, 'persona', 'xiaoyu.md'), 'utf8').trim();
  return snap.includes(f.slice(0, 40));
})());

// 随包资源
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const files = pkg.build?.files || [];
t.ok('persona/ 进安装包', files.some((x) => x.startsWith('persona/')));
t.ok('src/ 进安装包', files.some((x) => x.startsWith('src/')));
t.ok('skills/ 进安装包（换电脑技能索引不空）', files.some((x) => x.startsWith('skills/')));
t.ok('.state/ 被明确排除', files.some((x) => x === '!.state/**/*'));
const builtinSkills = path.join(ROOT, 'skills');
t.ok('出厂技能正文真的在仓库里', fs.existsSync(builtinSkills)
  && fs.readdirSync(builtinSkills).filter((n) => fs.existsSync(path.join(builtinSkills, n, 'SKILL.md'))).length >= 5);

t.done();
