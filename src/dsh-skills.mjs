/**
 * 【2026-11-16 主人：让小鱼Agent兼容 dsh 插件，可以导入 dsh 插件】
 *
 * ── 先说结论（评估过程见 docs/dsh-插件兼容评估.md）─────────────────────
 *
 * dsh 的「插件」不是「一个工具定义」，是 **cordis IoC 插件**。看它内置的 47 个源码
 * （dump/dsh-src/）就很清楚：run 体里直接吃
 *     exec.agent.session.append('todo/write', …)
 *     ctx.sessionProjections.stateOf(session, 'turnBoundary')
 *     ctx.agents.currentInitiator() / agent.status === 'running'
 * 也就是「会话事件溯源 + projections + agent registry + 开轮边界 + authority 校验」
 * 这一整套运行时。小鱼是「扁平工具表 + 会话 messages 数组」，没有那套模型。
 *
 * 要真的把 dsh 插件跑起来，等于把 dsh-base / cordis / dsh-tools / dsh-session
 * 那一层重写一遍 —— 工作量以周计，换来的能力小鱼 89 个工具已经全覆盖，
 * 而且更细（比如 dsh 的 todo_write 是整表替换，小鱼的 plan 有
 * create/update/add/view/clear、钉死、留档、重复检测）。
 *
 * 所以：**插件运行时不做兼容**（不值得），但 dsh 生态里有一类资产是纯文本、
 * 拿来就能用 —— **skill 包**：
 *
 *     dsh :  ~/.dsh/<profile>/skills/active-scan.md    单文件 + frontmatter
 *     小鱼:  <data>/skills/active-scan/SKILL.md        目录 + SKILL.md
 *
 * 差一层目录、差一个字段名（dsh 写 whenToUse，小鱼认 when）。这个文件补的就是这段。
 *
 * ── 另外两种形态也认 ──────────────────────────────────────────────
 *   · 目录 + SKILL.md  （跟小鱼一样，dsh 里也有一部分是这种）
 *   · 目录 + <同名>.md
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, basename, extname, dirname } from 'node:path';
import { homedir } from 'node:os';
import { config } from './config.mjs';

/** 名字只许字母数字横线点，防路径穿越（跟 skills.mjs 一个口径） */
function safeName(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,60}$/.test(s) ? s : '';
}

/** dsh 那个 frontmatter 解析：只认最简单的 key: value，认不出就跳过（坏一行不能废整份） */
export function parseDshFrontmatter(text) {
  const s = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(s);
  if (!m) return { meta: {}, body: s.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!mm) continue;
    let v = mm[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    meta[mm[1]] = v;
  }
  return { meta, body: s.slice(m[0].length).trim() };
}

/**
 * 自动找 dsh 的 skills 目录。
 *
 * 本机实测的几种放法（都认）：
 *   ~/.dsh/skills
 *   ~/.dsh/<任意一层>/skills          （redteam/skills、dsh-market/skills …）
 *   ~/.dsh/profiles/<profile>/skills
 *
 * 只探 3 层，不做全盘 find —— 那会在几千个文件上耗好几秒，而技能目录本来就在浅层。
 */
export function discoverDshSkillDirs(root) {
  const base = root || join(homedir(), '.dsh');
  const out = [];
  const push = (p) => {
    try {
      if (!existsSync(p)) return;
      if (!statSync(p).isDirectory()) return;
      if (!out.includes(p)) out.push(p);
    } catch { /* 没权限就当没有 */ }
  };

  push(join(base, 'skills'));
  let lvl1 = [];
  try { lvl1 = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { lvl1 = []; }
  for (const a of lvl1) {
    push(join(base, a, 'skills'));
    let lvl2 = [];
    try { lvl2 = readdirSync(join(base, a), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { lvl2 = []; }
    for (const b of lvl2) push(join(base, a, b, 'skills'));
  }
  return out;
}

/**
 * 扫一个目录，把里面每条「像 skill 的东西」整理出来。
 * 返回 [{ file, name, description, when, enabled, kind, bytes }]
 */
export function scanOneSkillDir(dir) {
  const rows = [];
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return rows; }

  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isFile()) {
      if (extname(e.name).toLowerCase() !== '.md') continue;
      /* 说明性文件不算技能 */
      if (/^(index|readme|contributing|license|changelog)\b/i.test(e.name)) continue;
      const info = readSkillFile(full);
      if (info) rows.push(Object.assign({ kind: 'file' }, info));
    } else if (e.isDirectory()) {
      /* 目录形态：目录里的 SKILL.md 或 <目录名>.md */
      const cand = [join(full, 'SKILL.md'), join(full, e.name + '.md')].find((p) => existsSync(p));
      if (!cand) continue;
      const info = readSkillFile(cand);
      if (info) rows.push(Object.assign({ kind: 'dir', dirName: e.name }, info));
    }
  }
  return rows;
}

function readSkillFile(file) {
  try {
    const raw = readFileSync(file, 'utf8');
    const { meta, body } = parseDshFrontmatter(raw);
    if (!body.trim()) return null;
    const fb = basename(file, extname(file));
    const name = safeName(meta.name || fb) || safeName(fb) || fb;
    return {
      file,
      name,
      description: String(meta.description || '').slice(0, 300),
      when: String(meta.whenToUse || meta.when || meta.when_to_use || '').slice(0, 300),
      enabled: !/^(false|0|no)$/i.test(String(meta.enabled ?? 'true')),
      bytes: raw.length,
      meta,
      body,
    };
  } catch { return null; }
}

/** 扫全部候选目录（去重：同一个 name 只留第一条，靠前的优先） */
export function scanDshSkills({ root, dirs } = {}) {
  const list = Array.isArray(dirs) && dirs.length ? dirs : discoverDshSkillDirs(root);
  const seen = new Set();
  const items = [];
  for (const d of list) {
    for (const r of scanOneSkillDir(d)) {
      const k = String(r.name || '').toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      items.push(Object.assign({ from: d }, r));
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return { dirs: list, items };
}

/** 目标技能目录 */
function skillsDest(destDir) {
  return destDir || join(config.dataDir, 'skills');
}

/**
 * 导入。
 *
 * 规矩（宁可少导，不许弄坏她已有的东西）：
 *   · 已存在同名目录 → **跳过**，不覆盖（那可能是主人自己改过的）；
 *   · enabled:false 的 dsh 技能 → 跳过（人家自己关掉的）；
 *   · 正文原样保留（不截断），只在回报里提一句超长；
 *   · 写入前 mkdir -p，写完用 listSkills 那种解析口径反读一次确认能读出来。
 */
export function importDshSkills(opts = {}) {
  const { names, dryRun = false, destDir, root, dirs } = opts;
  const want = Array.isArray(names) ? names.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
  const scan = scanDshSkills({ root, dirs });
  const dest = skillsDest(destDir);
  const result = { dirs: scan.dirs, total: scan.items.length, picked: [], imported: [], skipped: [], failed: [] };

  for (const it of scan.items) {
    if (want.length && !want.includes(String(it.name).toLowerCase())) continue;
    result.picked.push(it);
  }

  if (!result.picked.length) return result;

  if (!dryRun) {
    try { mkdirSync(dest, { recursive: true }); } catch { /* 下面写的时候会再报 */ }
  }

  for (const it of result.picked) {
    const dirName = safeName(it.dirName || it.name) || it.name;
    const targetDir = join(dest, dirName);
    const target = join(targetDir, 'SKILL.md');

    if (!it.enabled) { result.skipped.push({ name: it.name, why: 'dsh 里标了 enabled:false' }); continue; }
    if (existsSync(target)) { result.skipped.push({ name: it.name, why: '已经有同名技能了（不覆盖）' }); continue; }
    if (!safeName(dirName)) { result.failed.push({ name: it.name, why: '名字不合法' }); continue; }

    if (dryRun) { result.imported.push({ name: it.name, target, dryRun: true, bytes: it.bytes }); continue; }

    try {
      mkdirSync(targetDir, { recursive: true });
      /* frontmatter 重写成小鱼认的（when ← whenToUse），正文原样 */
      const head = [
        '---',
        'name: ' + it.name,
        'description: ' + String(it.description || it.name).replace(/\s+/g, ' '),
        it.when ? 'when: ' + String(it.when).replace(/\s+/g, ' ') : '',
        'source: dsh（' + basename(it.file) + '）',
        '---',
        '',
      ].filter((x) => x !== '').join('\n');
      writeFileSync(target, head + it.body + '\n', 'utf8');

      /* 反读确认：写进去的东西真能被解析出来才算成 */
      const back = readSkillFile(target);
      if (!back || !String(back.body || '').trim()) throw new Error('写完读不回来');
      result.imported.push({ name: it.name, target, bytes: it.bytes, big: it.bytes > 12000 });
    } catch (e) {
      result.failed.push({ name: it.name, why: String((e && e.message) || e) });
    }
  }

  /* 目标目录里现在一共几个技能 —— 索引每条要占约 80 字 system，
   * 75 条全进去就是 6000 多字，会把预算闸顶爆。所以超过 12 条要出言提醒。 */
  try {
    result.destCount = readdirSync(dest, { withFileTypes: true })
      .filter((e) => e.isDirectory() && safeName(e.name))
      .filter((e) => existsSync(join(dest, e.name, 'SKILL.md'))).length;
  } catch { result.destCount = 0; }
  return result;
}

/** 给人看的一句话摘要（工具回报用） */
export function summarizeImport(r) {
  const lines = [];
  lines.push('扫描到 ' + r.total + ' 条 dsh 技能（' + r.dirs.length + ' 个目录）');
  if (r.imported.length) {
    lines.push('导入 ' + r.imported.length + ' 条：' + r.imported.map((x) => x.name).join('、'));
    const big = r.imported.filter((x) => x.big);
    if (big.length) lines.push('（其中 ' + big.length + ' 条超过 12000 字，她 use_skill 时会被截断到 12000 —— 正文本身没动）');
  }
  if (r.skipped.length) lines.push('跳过 ' + r.skipped.length + ' 条：' + r.skipped.map((x) => x.name + '（' + x.why + '）').join('；'));
  if (r.failed.length) lines.push('失败 ' + r.failed.length + ' 条：' + r.failed.map((x) => x.name + '（' + x.why + '）').join('；'));
  if (!r.imported.length && !r.skipped.length && !r.failed.length) lines.push('没有可导入的条目。');
  if (r.destCount > 12) {
    lines.push('');
    lines.push('⚠ 现在一共有 ' + r.destCount + ' 个技能。system 里的索引每条约 80 字，太多了会把上下文预算顶掉；') ;
    lines.push('建议只留正在用的那几份（不用的把目录挪走或删掉）。');
  }
  return lines.join('\n');
}
