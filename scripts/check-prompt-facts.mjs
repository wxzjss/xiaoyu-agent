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
t.ok('不提「专业模式」（功能已删，改叫办事模式）', !prompt.includes('专业模式'));
t.ok('提的是「办事模式」', prompt.includes('办事模式'));
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
const listLine = (prompt.split(/\r?\n/).find((l) => l.startsWith('read_file、write_file、')) || '');
const listed = listLine.split('、').map((x) => x.trim()).filter(Boolean);
t.ok('能解析出工具清单那一行', listed.length > 30, listed.length + ' 个');
t.ok('清单里每个工具都真的注册了', listed.every((n) => registered.has(n)),
  listed.filter((n) => !registered.has(n)).join(',') || '全部存在');
for (const n of ['send_file', 'video_probe', 'video_sheet', 'video_read', 'use_skill', 'restart_self', 'read_file', 'search_files']) {
  t.ok('手写提到的 ' + n + ' 存在', prompt.includes(n) ? registered.has(n) : true);
}

// ── 6. 只读工具数量是动态的，别写死 ────────────────────────────────
const { enabledToolSchemas } = await import('../src/tools.mjs');
const { buildToolIndex } = await import('../src/harness/tool-spec.mjs');
const nPar = buildToolIndex(enabledToolSchemas()).filter((x) => x.parallelSafe).length;
t.ok('提示词里的只读工具数与实际一致', prompt.includes('等 ' + nPar + ' 个只读工具'), '实际 ' + nPar);
t.ok('「只读命令也算」只在 run_command 真启用时才说',
  !prompt.includes('只读命令如 git status') || enabledToolSchemas().some((s) => (s.function || s).name === 'run_command'));

// ── 7. 预算 / 红线 ─────────────────────────────────────────────────
t.ok('提示词在 5500 字预算内', prompt.length <= 5500, prompt.length + ' 字');
for (const k of ['SAFE_MODE_FALLBACK', 'PERSONA_WORD', 'safeMode', 'safeWord', 'loadPersona']) {
  t.ok('红线符号 ' + k + ' 没被动', src.includes(k));
}

// ── 8. 出厂文件没被回退成旧版 ──────────────────────────────────────
const xiaoyu = fs.readFileSync(path.join(ROOT, 'persona', 'xiaoyu.md'), 'utf8');
t.ok('出厂人设是定稿（含「对主人的称呼」）', xiaoyu.includes('对主人的称呼：主人'));
t.ok('出厂人设不含旧的 PERSONA_LOAD 头', !xiaoyu.includes('【PERSONA_LOAD】'));
const { DEFAULT_SETTINGS } = await import('../src/settings.mjs');
t.ok('出厂底线 10 条（不是旧长版 15 条）', DEFAULT_SETTINGS.bottomLines.length === 10);

t.done();
