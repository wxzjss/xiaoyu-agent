/**
 * 【办事模式 · 开关与白名单】
 *
 * 主人 2026-11-07 让【检查鱼】严检办事模式，清单第 29-34 步。
 * 那条会话后来卡住了（等模型一个字都没回），这几步由这边接手做完。
 *
 * 这个检查先钉死最容易出事、又最便宜验证的三块：
 *   ① 开关：能不能开、存不存盘、换会话会不会串、重启还在不在、BOM 会不会让它静默失效
 *   ② 白名单 KEEP_TOOLS：里面写的名字是不是都真实存在
 *      （名字写错一个，那个工具就永远拿不到 —— 2026-11-03 那个 `tools: []`
 *        让 restart_self 永远进不了启用清单，就是这么来的）
 *   ③ 提示词与白名单不能自相矛盾（让它验收却不给读文件那种）
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const t = makeChecker('task / 办事模式');
const src = fs.readFileSync('src/task-mode.mjs', 'utf8');

const tm = await import('../src/task-mode.mjs');
const tl = await import('../src/tools.mjs');

// ── 1. 白名单里的名字必须真实存在 ─────────────────────────────
const names = new Set(tl.tools.map((x) => x.name));
const keep = tm.KEEP_TOOLS;
const missing = keep.filter((n) => !names.has(n));
t.ok('白名单里没有写错的工具名', missing.length === 0, missing.join(', '));
t.ok('白名单没有重复项', new Set(keep).size === keep.length);
t.ok('白名单至少留了派活的手', keep.includes('spawn_worker') && keep.includes('spawn_workers'));
t.ok('白名单留了验收用的只读手', keep.includes('read_file') && keep.includes('list_dir'));
t.ok('主人叫得动她（restart_self / send_file 没被收走）',
  keep.includes('restart_self') && keep.includes('send_file'));

// ── 2. 提示词不能自相矛盾 ────────────────────────────────────
const prompt = tm.taskPromptBlock('__probe__', '小鱼');
t.ok('提示词里有「小事自己做」这条', /小事你自己做|小事自己顺手做/.test(prompt));
t.ok('提示词要求真去核（不是凭汇报采信）', /真去读|核一遍/.test(prompt));
t.ok('提示词要求退回同一个 worker（不新开）', /同一个子智能体|别另开|别新开/.test(prompt));
t.ok('提示词没写「你必须全部派出去」这种一刀切',
  !/你不动手|一律派出去/.test(prompt));

// ── 3. 行为：开关真的开/关/落盘/不串会话/BOM ────────────────
const __dir = dirname(fileURLToPath(import.meta.url));
const tmpData = mkdtempSync(join(tmpdir(), 'task-probe-'));
const probe = spawnSync(process.execPath, [join(__dir, 'task-probe.mjs')], {
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
  t.ok('默认是关的', got.defaultOff === true);
  t.ok('开了之后读得到', got.afterOn === true);
  t.ok('开 A 不会把 B 也带开', got.otherOff === true);
  t.ok('真的落盘了（不只是内存）', got.fileExists === true && String(got.fileBody || '').includes('sidA'));
  t.ok('关了之后读不到', got.afterOff === true);
  t.ok('带 BOM 的文件照样读得出来', got.bomRead === true);
  t.ok('探针内部无失败项', got.ok === true, (got.steps || []).join(' | ').slice(0, 200));
}

t.done();
