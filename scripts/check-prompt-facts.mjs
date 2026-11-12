/**
 * 【提示词事实核查】把 2026-11-07 逐条人工核对的结论固化成自动检查，
 * 以后谁改提示词、谁删功能，这里会当场报出来，不用再靠人肉对一遍。
 */
import { makeChecker } from './_harness_util.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const t = makeChecker('prompt / 事实核查');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prompt = fs.readFileSync(path.join(ROOT, 'persona', 'FACTORY-PROMPT.md'), 'utf8')
  .replace(/^<!--[\s\S]*?-->\r?\n/, '');
const src = fs.readFileSync(path.join(ROOT, 'src', 'persona.mjs'), 'utf8');
const skillsSrc = fs.readFileSync(path.join(ROOT, 'src', 'skills.mjs'), 'utf8');

// ── 1. 已经删掉的功能，不许再出现在提示词里 ────────────────────────
t.ok('不提「专业模式」（功能已删）', !prompt.includes('专业模式'));
t.ok('不提「办事模式」（2026-11-11 整档删除）', !prompt.includes('办事模式'));
t.ok('「开场白」说成卡上的一句话，不是功能开关', /「开场白」是每张智能体卡上的一句话/.test(prompt));

// ── 2. 数字 / 条件不能再写错 ───────────────────────────────────────
t.ok('不写死「22 条断言」（实际 30 条）', !prompt.includes('22 条断言'));
t.ok('也不写死任何断言条数，免得再漂移', !/真机 \d+ 条断言/.test(prompt));
t.ok('回归那条写明会跳过的条件', prompt.includes('--no-ui'));
t.ok('不吹「把全文读进来」（12000 字会截断）', !prompt.includes('把全文读进来'));
t.ok('技能索引改成「把正文读进来」', skillsSrc.includes('把正文读进来'));

// ── 3. 并行规矩只许有一处 ──────────────────────────────────────────
t.ok('并行规矩只出现一处', (prompt.match(/一起发，别排队/g) || []).length === 1);
t.ok('旧的那段 PARALLEL_TOOL_BLOCK 标题没了', !prompt.includes('【能一起做的事'));
t.ok('没有自我否定的「拿不准就一定一次一个」', !prompt.includes('拿不准就一定一次一个'));
t.ok('没有「写文件和跑命令一次只做一件」', !prompt.includes('写文件和跑命令一次只做一件'));
t.ok('明确写了调度由程序算', prompt.includes('程序按依赖算'));

// ── 4. `;` 串命令必须走 PowerShell（cmd 不认 ;） ────────────────────
const { pickShell, shellLabel } = await import('../src/harness/exec-shell.mjs');
t.ok('提示词仍教用 ; 串检查', prompt.includes('用 ; 串成一条'));
t.ok('; 串命令回老路，不会送进 cmd', shellLabel('node -v; node -v') === 'powershell', shellLabel('node -v; node -v'));
t.ok('简单命令仍走快路', shellLabel('node -v') === 'cmd');

// ── 5. 提示词里提到的工具，必须真的注册 ────────────────────────────
const { tools } = await import('../src/tools.mjs');
const registered = new Set(tools.map((x) => x.name));
/* 【2026-11-10 改·工具名长名单已经删了】
 *
 * 原来的断言是「解析提示词里那行 `read_file、write_file、…`，逐个查有没有注册」。
 * 但那行是纯冗余（每个工具的 name 都随 tools 字段逐条发过去了），11-10 已删，
 * 断言随之失去对象（会红在「能解析出工具清单那一行」）。
 *
 * 现在改成查**真数据源**：`tools` 注册表本身。
 * 这比原来更硬 —— 原来查的是「提示词抄的名单对不对」，现在直接查「注册表有没有坏」。
 */
t.ok('工具注册表非空', tools.length > 30, tools.length + ' 个');
t.ok('工具名唯一（没有重复注册）', new Set(tools.map((x) => x.name)).size === tools.length,
  tools.length + ' 个名字 / ' + new Set(tools.map((x) => x.name)).size + ' 个唯一');
t.ok('提示词里没再抄工具全名单（省了 687 字预算）',
  !/^read_file、write_file、/m.test(prompt),
  '提示词里仍有以 read_file、write_file、 开头的名单行');
for (const n of ['send_file', 'video_probe', 'video_sheet', 'video_read', 'use_skill', 'restart_self', 'read_file', 'search_files']) {
  t.ok('手写提到的 ' + n + ' 存在', prompt.includes(n) ? registered.has(n) : true);
}

// ── 6. 只读工具那一行：别写死数量，也别点名不存在的 ──────────────
// 桌面那几个工具（ui_*）是按功能开关启用的：全新机器默认关着、当前机器开着。
// 所以在提示词里写死「等 25 个只读工具」必然和出厂快照对不上 —— 2026-11-11 改成
// 不带数字的写法，这里只核对「点名的样板工具确实都是只读的」。
const { enabledToolSchemas } = await import('../src/tools.mjs');
const { buildToolIndex } = await import('../src/harness/tool-spec.mjs');
const parNames = new Set(buildToolIndex(enabledToolSchemas()).filter((x) => x.parallelSafe).map((x) => x.name));
t.ok('只读工具那一行不带写死数量', !/等 \d+ 个只读工具/.test(prompt), '提示词里仍有「等 N 个只读工具」');
const parLine = (prompt.split(/\r?\n/).find((l) => l.includes('可以一起发：')) || '');
const named = parLine.replace(/^.*可以一起发：/, '').split(/等只读工具|；/)[0].split('、').map((x) => x.trim()).filter(Boolean);
t.ok('只读样板工具名都真实存在且只读', named.length >= 3 && named.every((n) => parNames.has(n)),
  named.join('、') + ' → 不在只读表里的：' + named.filter((n) => !parNames.has(n)).join('、'));
t.ok('「只读命令也算」只在 run_command 真启用时才说',
  !prompt.includes('只读命令如 git status') || enabledToolSchemas().some((s) => (s.function || s).name === 'run_command'));

// ── 7. 预算 / 红线 ─────────────────────────────────────────────────
t.ok('提示词在 5600 字预算内', prompt.length <= 5600, prompt.length + ' 字');
for (const k of ['SAFE_MODE_FALLBACK', 'PERSONA_WORD', 'safeMode', 'safeWord', 'loadPersona']) {
  t.ok('红线符号 ' + k + ' 没被动', src.includes(k));
}

// ── 8. 出厂文件没被回退成旧版 ──────────────────────────────────────
const xiaoyu = fs.readFileSync(path.join(ROOT, 'persona', 'xiaoyu.md'), 'utf8');
t.ok('出厂人设是定稿（含「对主人的称呼」）', xiaoyu.includes('对主人的称呼：主人'));
t.ok('出厂人设不含旧的 PERSONA_LOAD 头', !xiaoyu.includes('【PERSONA_LOAD】'));
const { DEFAULT_SETTINGS } = await import('../src/settings.mjs');
// 2026-11-11：主人把设置里那一版（11 条，含「修bug时必须实测」）设成了出厂默认。
// 条数以 .state/defaults.json 为真相，这里钉住它没被回退成旧长版 15 条。
t.ok('出厂底线 11 条（不是旧长版 15 条）', DEFAULT_SETTINGS.bottomLines.length === 11);

t.done();
