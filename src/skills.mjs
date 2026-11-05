/**
 * 【2026-11-05 加·技能系统】
 *
 * 为什么要有：从 WorkBuddy 的 skill 机制借的 —— **加一份"怎么做事"的知识，
 * 不用改一行代码**。
 *
 * 之前想让她多会一样东西，只有两条路：
 *   ① 写进人设（但那是身份，塞满会稀释）
 *   ② 写进 system（每轮都发，胖）
 * 现在多第三条：丢一个 `SKILL.md` 进 `data/skills/<名字>/`，她自己会翻。
 *
 * 渐进式披露（跟 WorkBuddy 一个路子）：
 *   · 平时只有索引 —— 名字 + 一句话描述，几十字；
 *   · 真要用的时候用 `use_skill` 把正文读进上下文。
 *
 * 目录约定：
 *   <dataDir>/skills/<skill-name>/SKILL.md
 *   frontmatter 至少要有 name 和 description；when 可选（写"什么时候该用我"）。
 *   正文随便写，建议分步骤、带例子。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const MAX_BODY = 12000; // 单个 skill 正文最多读这么多字，防止一口气撑爆上下文

function skillsDir() {
  return join(config.dataDir, 'skills');
}

/** 名字只许字母数字横线，防路径穿越 */
function safeName(raw) {
  const s = String(raw || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,40}$/.test(s) ? s : '';
}

/**
 * 解析 frontmatter（只认最简单的 `key: value`，不引第三方 yaml）。
 * 认不出的行原样跳过 —— 宁可少读一个字段，也别让整份 skill 打不开。
 */
function parseFrontmatter(text) {
  const s = String(text || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(s);
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

let _cache = { at: 0, list: [] };

/**
 * 扫一遍技能目录。
 *
 * 带 1.5 秒缓存：persona 每轮都会问一次，而磁盘几乎不会在这 1.5 秒里变。
 * 真改了 skill 想立刻生效，重启一次或者等两秒。
 */
export function listSkills({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - _cache.at < 1500) return _cache.list;

  const dir = skillsDir();
  const out = [];
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((n) => safeName(n));
  } catch {
    _cache = { at: now, list: [] };
    return [];
  }

  for (const n of names) {
    const file = join(dir, n, 'SKILL.md');
    if (!existsSync(file)) continue;
    try {
      const st = statSync(file);
      const { meta } = parseFrontmatter(readFileSync(file, 'utf8'));
      out.push({
        name: String(meta.name || n),
        dirName: n,
        description: String(meta.description || '').slice(0, 160),
        when: String(meta.when || '').slice(0, 120),
        size: st.size,
        mtime: st.mtimeMs,
      });
    } catch {
      /* 某一份坏了不影响别的 */
    }
  }

  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  _cache = { at: now, list: out };
  return out;
}

/** 读一份技能的正文（不含 frontmatter） */
export function readSkill(name) {
  const want = String(name || '').trim();
  if (!want) return { ok: false, error: '没给 skill 名字' };
  const all = listSkills({ force: true });
  const hit = all.find((s) => s.name === want || s.dirName === want);
  if (!hit) {
    const names = all.map((s) => s.name).join('、') || '（一个都没有）';
    return { ok: false, error: '没有这个 skill：' + want + '。现有：' + names };
  }
  try {
    const raw = readFileSync(join(skillsDir(), hit.dirName, 'SKILL.md'), 'utf8');
    const { body } = parseFrontmatter(raw);
    if (!body.trim()) return { ok: false, error: '这份 skill 正文是空的：' + hit.name };
    const cut = body.length > MAX_BODY;
    return {
      ok: true,
      name: hit.name,
      text: body.slice(0, MAX_BODY),
      truncated: cut,
      total: body.length,
    };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 拼进 system 的索引。
 *
 * 【为什么只有一行一条】技能多了会撑 system —— 主体在 SKILL.md 里，
 * 这里只回答"有这么个东西、大概干什么"，要不要用、怎么用，她自己调 use_skill 看。
 */
export function skillIndexBlock() {
  let all = [];
  try { all = listSkills(); } catch { return ''; }
  if (!all.length) return '';
  /* 【2026-11-05 收短】索引里每条只给 80 字。5 条技能原本吃掉 411 字，
   * system 只剩 25 字余量 —— 再多两个技能就顶到预算闸了。
   * 描述是"要不要翻它"的判断依据，80 字够说明白；细节本来就在正文里。 */
  const rows = all.map((s) => {
    const d = String(s.description || '');
    return '- ' + s.name + (d ? '：' + (d.length > 80 ? d.slice(0, 80) + '…' : d) : '');
  });
  return [
    '【你还会这些（按需翻）】',
    '下面这些是「怎么做某件事」的手艺，不是工具。要用的时候先 use_skill 把全文读进来再动手，别凭名字猜。',
    ...rows,
  ].join('\n');
}

/** 给自检用：返回格式有问题的技能 */
export function checkSkills() {
  const problems = [];
  const dir = skillsDir();
  let names = [];
  try {
    names = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return problems;
  }
  for (const n of names) {
    if (!safeName(n)) { problems.push(n + ': 目录名不合法（只许字母数字横线）'); continue; }
    const file = join(dir, n, 'SKILL.md');
    if (!existsSync(file)) { problems.push(n + ': 缺 SKILL.md'); continue; }
    try {
      const { meta, body } = parseFrontmatter(readFileSync(file, 'utf8'));
      if (!meta.name) problems.push(n + ': frontmatter 缺 name');
      if (!meta.description) problems.push(n + ': frontmatter 缺 description（没有描述她不知道什么时候该翻）');
      if (!body.trim()) problems.push(n + ': 正文是空的');
    } catch (e) {
      problems.push(n + ': 读不出来 ' + String(e?.message ?? e));
    }
  }
  return problems;
}
