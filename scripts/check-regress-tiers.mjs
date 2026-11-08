/**
 * 【回归分档 · 2026-11-08 加】
 *
 * 主人：「跑回归怎么只显示一个【跑回归】？回归有那么多种类……
 *   【跑冒烟】【跑测试】【跑变更】【跑增量】【跑核心】【跑全量】。
 *   具体你自己看着办，保留哪些不保留哪些你自己决定，但要求不要搞混了」。
 *
 * 这个检查守三件事：
 *   ① 四档入口真的存在、各自语义真的不同（不是换个名字跑同一批）
 *   ② 工具卡命名真的分开了（屏幕上看得出来跑的是哪一档）
 *   ③ 没做的两档（测试 / 增量）在底线和代码里都写清了理由，别以后又被「补」回来
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const t = makeChecker('harness / 回归分档');
const ROOT = process.cwd();
const ui = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const settings = fs.readFileSync(path.join(ROOT, 'src', 'settings.mjs'), 'utf8');

// ── 1. 四档入口存在，且能列出自己要跑什么 ────────────────────
const smoke = fs.existsSync(path.join(ROOT, 'scripts', 'check-smoke.mjs'));
const changed = fs.existsSync(path.join(ROOT, 'scripts', 'check-changed.mjs'));
const core = fs.existsSync(path.join(ROOT, 'scripts', 'check-core.mjs'));
const full = fs.existsSync(path.join(ROOT, 'scripts', 'run-all-checks.mjs'));
t.ok('冒烟入口存在', smoke);
t.ok('变更入口存在', changed);
t.ok('核心入口存在', core);
t.ok('全量入口存在', full);

// ── 2. 语义必须真的不同（不是同一批换个名字） ────────────────
if (smoke && core) {
  const s = fs.readFileSync(path.join(ROOT, 'scripts', 'check-smoke.mjs'), 'utf8');
  const c = fs.readFileSync(path.join(ROOT, 'scripts', 'check-core.mjs'), 'utf8');
  /* 冒烟必须是「自动筛轻量」，核心必须是「固定清单」——两种做法一眼能分 */
  t.ok('冒烟是自动筛轻量的（不是固定清单）',
    /HEAVY\s*=/.test(s) && /\.filter\(\(f\)\s*=>\s*\{[\s\S]{0,120}!HEAVY\.test/.test(s));
  t.ok('核心是固定清单（不是自动筛）',
    /const CORE = \[/.test(c) && /check-chat-e2e\.mjs/.test(c) && !/HEAVY/.test(c));
}
if (changed) {
  const ch = fs.readFileSync(path.join(ROOT, 'scripts', 'check-changed.mjs'), 'utf8');
  /* 变更必须真的读 git diff，并且按「检查读了哪些文件」反查 —— 不是按名字猜 */
  t.ok('变更是按 git diff 拿改动的', /git\(\[.{0,30}diff/.test(ch) || /execFileSync\('git',\s*\['diff'/.test(ch));
  t.ok('变更按「检查读了哪些文件」反查（不靠手工映射表）',
    /readFileSync\|existsSync\|readdirSync\|statSync/.test(ch) && /byFile/.test(ch));
  t.ok('改到核心文件时会补一组核心（兜住不读文件的真机格）',
    /CORE_TRIGGERS/.test(ch) && /coreHit/.test(ch));
}

// ── 3. 工具卡命名真的分开了 ──────────────────────────────────
for (const [label, re] of [
  ['跑冒烟', /check-smoke\\\.mjs[\s\S]{0,40}return '跑冒烟'/],
  ['跑变更', /check-changed\\\.mjs[\s\S]{0,40}return '跑变更'/],
  ['跑核心', /check-core\\\.mjs[\s\S]{0,40}return '跑核心'/],
  ['跑全量', /run-all-checks\\\.mjs[\s\S]{0,40}return '跑全量'/],
]) {
  t.ok('工具卡能显示「' + label + '」', re.test(ui));
}
t.ok('跑全量排在「跑回归（单体）」前面（否则又被吞掉）',
  ui.indexOf("return '跑全量'") > 0 && ui.indexOf("return '跑全量'") < ui.indexOf("return '跑回归'"));

// ── 4. 没做的两档要写清理由，别以后被「补」回来 ──────────────
t.ok('代码里写明「跑测试」为什么不存在（没有单元测试层）',
  /没有单元测试层|没有单元测试/.test(ui) && /没有单元测试层|无单元测试|没有 tests\//.test(settings) === false || /没有单元测试层/.test(settings));
t.ok('代码里写明「跑增量」为什么不单独做（与变更重叠）',
  /「增量」与「变更」重叠|增量：语义和「跑变更」重叠/.test(settings + ui));

// ── 5. 四档都要能在不执行的情况下自检（--dry / 空改动不空跑） ──
if (changed) {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-changed.mjs'), '--dry'], {
    encoding: 'utf8', timeout: 60 * 1000, cwd: ROOT,
  });
  t.ok('变更入口 --dry 能跑（不真跑检查）', r.status === 0, String(r.stderr || '').slice(0, 120));
}
if (core) {
  const r2 = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-core.mjs'), '--dry'], {
    encoding: 'utf8', timeout: 60 * 1000, cwd: ROOT,
  });
  t.ok('核心入口 --dry 能列出清单', r2.status === 0 && /核心回归/.test(String(r2.stdout || '')),
    String(r2.stderr || '').slice(0, 120));
}

// ── 5. 全量不许把三个入口当单项再跑一遍（会嵌套、会抢资源） ──
{
  const fullSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'run-all-checks.mjs'), 'utf8');
  t.ok('全量排除三个分档入口（不嵌套）',
    /TIER_ENTRY/.test(fullSrc) && /check-smoke\.mjs'/.test(fullSrc)
    && /check-changed\.mjs'/.test(fullSrc) && /check-core\.mjs'/.test(fullSrc)
    && /!TIER_ENTRY\.has\(f\)/.test(fullSrc));
}

t.done();
