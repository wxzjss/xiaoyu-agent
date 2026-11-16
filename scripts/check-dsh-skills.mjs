/**
 * check-dsh-skills.mjs — 守「导入 dsh 技能」这条链。
 *
 * 主人 2026-11-16 原话：「还有就是让小鱼Agent兼容dsh插件，可以导入dsh插件」，
 * 并给了余地：「或者如果你觉得不值得就不做」。
 *
 * 评估结论（详见 docs/dsh-插件兼容评估.md）：
 *   · dsh 的**插件运行时**不兼容 —— 那是 cordis IoC + 会话事件溯源，
 *     run 体直接吃 exec.agent.session.append / ctx.sessionProjections /
 *     ctx.agents.currentInitiator，小鱼没有那套模型；真做等于重写半个 dsh，
 *     而能力小鱼 89 个工具已全覆盖且更细。
 *   · dsh 的 **skill 包**兼容 —— 那是纯文本，差一层目录 + 一个字段名，
 *     本机就有 75 条可导（~/.dsh/*\/skills）。
 *
 * 这个脚本守两件事：
 *   ① 那条「不做运行时兼容」的结论没被后来的人（或我自己）悄悄推翻 ——
 *      如果哪天真的加了 cordis，这里会红，逼着重新评估；
 *   ② 导入器本身的行为：字段映射、幂等、跳过关掉的、不覆盖已有的、能被小鱼读出来。
 */
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const src = readFileSync(new URL('../src/dsh-skills.mjs', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/* ── ① 结论钉住：不做插件运行时兼容 ───────────────────── */
ok('没有偷偷引 cordis / dsh-base 运行时',
  !/from '@deepseek-ai\/|require\('@deepseek-ai\//.test(src) && !/cordis/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('模块自己的注释里写清了「为什么不兼容插件」',
  /cordis IoC/.test(src) && /事件溯源/.test(src));

/* ── ② 工具已注册 ──────────────────────────────────── */
ok('tools.mjs 里注册了 import_dsh_skills',
  /name: 'import_dsh_skills'/.test(tools));
ok('工具有 scan（只看）和 import（真导）两个动作',
  /enum: \['scan', 'import'\]/.test(tools) && /act === 'scan'/.test(tools) && /action \|\| 'import'/.test(tools));
ok('工具描述写明了「不覆盖已有的」', /不覆盖/.test(tools));

/* ── ③ 行为测试：造一个 dsh 形态的目录，真导一遍 ──────── */
const root = mkdtempSync(join(tmpdir(), 'xy-dsh-'));
const srcDir = join(root, 'skills');
const destDir = join(root, 'dest');
mkdirSync(srcDir, { recursive: true });

/* 正常的一条：单文件 + whenToUse */
writeFileSync(join(srcDir, 'active-scan.md'), [
  '---',
  'name: active-scan',
  'description: 主动端口扫描',
  'whenToUse: 需要确认资产存活时',
  'enabled: true',
  '---',
  '',
  '## 步骤',
  '1. nmap -sn <cidr>',
].join('\n'), 'utf8');

/* 关掉的一条：enabled:false 不许进 */
writeFileSync(join(srcDir, 'disabled-one.md'), [
  '---', 'name: disabled-one', 'description: 关掉的', 'enabled: false', '---', '', '正文',
].join('\n'), 'utf8');

/* 目录形态的一条：目录 + SKILL.md */
mkdirSync(join(srcDir, 'dir-skill'), { recursive: true });
writeFileSync(join(srcDir, 'dir-skill', 'SKILL.md'), [
  '---', 'name: dir-skill', 'description: 目录形态', '---', '', '目录形态的正文',
].join('\n'), 'utf8');

/* 说明性文件：不该被当成技能 */
writeFileSync(join(srcDir, 'INDEX.md'), '# 索引\n这不是技能。\n', 'utf8');

const M = await import('file://' + new URL('../src/dsh-skills.mjs', import.meta.url).pathname.replace(/^\//, ''));
const scan = M.scanDshSkills({ dirs: [srcDir] });
ok('scan 认出 3 条（INDEX.md 不算技能）', scan.items.length === 3, '实际 ' + scan.items.length);
ok('whenToUse 被读进 when',
  (scan.items.find((x) => x.name === 'active-scan') || {}).when === '需要确认资产存活时');
ok('enabled:false 被标出来',
  (scan.items.find((x) => x.name === 'disabled-one') || {}).enabled === false);
ok('目录形态（目录 + SKILL.md）也认',
  !!scan.items.find((x) => x.name === 'dir-skill'));

const r1 = M.importDshSkills({ dirs: [srcDir], destDir });
ok('导入 2 条（关掉的那条不进）', r1.imported.length === 2, '实际 ' + r1.imported.length);
ok('关掉的进了 skipped 并写明原因',
  r1.skipped.some((x) => x.name === 'disabled-one' && /enabled/.test(x.why)));

const f = join(destDir, 'active-scan', 'SKILL.md');
ok('落成 <名字>/SKILL.md（小鱼要的结构）', existsSync(f));
const body = existsSync(f) ? readFileSync(f, 'utf8') : '';
ok('frontmatter 里 whenToUse 映射成 when', /\nwhen: 需要确认资产存活时/.test(body));
ok('正文原样保留（含命令）', /nmap -sn <cidr>/.test(body));
ok('小鱼的口径能读出来：有 name / description / 正文非空',
  /\nname: active-scan/.test(body) && /\ndescription: /.test(body) && /nmap/.test(body));

/* 幂等 + 不覆盖 */
writeFileSync(f, body + '\n（主人手改过的一行）', 'utf8');
const r2 = M.importDshSkills({ dirs: [srcDir], destDir });
ok('二次导入跳过（不重复写）', r2.imported.length === 0 && r2.skipped.length >= 2);
ok('不覆盖已有的（手改那行还在）', /主人手改过的一行/.test(readFileSync(f, 'utf8')));

/* dryRun 不落盘 */
const dest2 = join(root, 'dest-dry');
const r3 = M.importDshSkills({ dirs: [srcDir], destDir: dest2, dryRun: true });
ok('dryRun 只演不写', r3.imported.length === 2 && !existsSync(dest2) ? true : !existsSync(join(dest2, 'active-scan', 'SKILL.md')));

/* ── ③.5 拼字符串不许写出「+ +」（一元加号 → 整串变 NaN） ──────
 * 【2026-11-16 真踩过】scan 分支里有一行以 `+ rows.join(...)` 开头，
 * 上一行结尾也是个 `+`，于是变成 `... + + rows.join(...)` —— 一元加号把
 * 字符串转数字，整段回报就成了一个 NaN。语法检查完全查不出来。 */
const unaryPlus = (() => {
  const ls = tools.split(String.fromCharCode(10));
  for (let k = 1; k < ls.length; k += 1) {
    const prev = ls[k - 1].replace(/\s+$/, '');
    const cur = ls[k].replace(/^\s+/, '');
    if (prev.endsWith('+') && cur.startsWith('+ ')) return (k + 1) + ': ' + cur.slice(0, 40);
  }
  return '';
})();
ok('没有「一行结尾 + 下一行开头 +」的一元加号写法', !unaryPlus, unaryPlus);

/* ── ④ 源码里不许有控制字符（上次 \b 变退格符的坑） ──── */
const hasCtrl = (s) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s);
ok('dsh-skills.mjs 没有控制字符', !hasCtrl(src));
ok('tools.mjs 没有控制字符', !hasCtrl(tools));

try { rmSync(root, { recursive: true, force: true }); } catch {}

console.log('\ndsh 技能导入：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
