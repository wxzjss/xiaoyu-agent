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

// ── 3. 删除契约：办事模式已整档删除（2026-11-11 主人指令）────
/* 原来这里探测「开关开/关/落盘/不串会话」—— 功能删了，探针换成
 * 「闸门必须钉死 + 派活工具必须拒 + 功能表里没有这个键」。
 * 为什么要钉死：老机器功能表里残留 taskmode:true，featureOnFor 对
 * 不认识的 id 按「记过就按记的」会返回 true —— 光删定义关不掉它，
 * taskOn() 里必须显式 return false。 */
t.ok('taskOn() 恒为 false（任意会话）',
  tm.taskOn('probe-a') === false && tm.taskOn('') === false && tm.taskOn('default') === false);
const __F = await import('../src/features.mjs');
t.ok('功能表里没有 taskmode 这个键', !__F.allFeatures().some((f) => f.id === 'taskmode'));
const __refuse = await tl.runTool('spawn_worker', { task: '随便什么活' }, 'probe-a');
/* 口径更新（2026-11-11）：团队模式（854ed10）上线后，闸门文案从「派活功能正在重做」
 * 改成「团队模式现在是关着的」。断言跟着改，但守的东西没变：
 *   ① 必须闸死（ok === false），不能悄悄放行；
 *   ② 必须说人话 —— 指到现存的那个开关（「团队模式」）并告诉她现在自己动手做；
 *   ③ 不许提已经删掉的「办事模式」按钮（提了就是让她去点一个不存在的入口）。 */
const __refuseText = String((__refuse && __refuse.output) || '');
t.ok('spawn_worker 被闸死且说人话（指到团队模式，不提已删的按钮）',
  __refuse && __refuse.ok === false
    && /团队模式/.test(__refuseText) && /关着|关的|没开/.test(__refuseText)
    && /自己动手做/.test(__refuseText)
    && !/办事模式/.test(__refuseText),
  __refuseText.slice(0, 80));
t.ok('task-mode.mjs 不再读功能表的 taskmode 键',
  !/featureOnFor\([^)]*taskmode/.test(src));

t.done();
