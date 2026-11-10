/**
 * 守卫：「功能开关按会话生效」这条规矩，不许在代码里被悄悄做坏。
 *
 * 【这个脚本钉的四件事】
 *   1. src/ 里（除白名单外）不许再出现「裸 getEnabledMap()[某个 id]」当功能开没开的判据。
 *      这条最阴：开关写的是会话表，判定读的是全局表，界面亮着、功能不生效，
 *      而代码里一个字都不会报错。2026-11-10 改造时就靠人肉扫出来的 4 处。
 *   2. 白名单那 5 个「机器级」的 id 永远不该出现在 feature-by-session.json 里
 *      —— 写的时候就得绕开，不然会留下一份永远没人读的脏数据。
 *   3. featureOnFor 的三级回退（会话 → 全局 raw → defaultOn）不许被「简化」。
 *      少第 ② 级 = 升级那一刻主人关掉的功能自己全开，比不按会话还烦。
 *   4. setFeatureScoped 必须在，且非白名单功能缺 sessionId 时要抛，不许静默写全局。
 *
 * 另外顺手钉一条「文档和代码别各说各话」：规则文档里那张例外表，必须跟
 * src/features.mjs 的 GLOBAL_ONLY_FEATURES 完全一致（两个方向都比）。
 *
 * 【为什么纯静态 + 纯函数，不连服务、不开浏览器】
 * 全项目硬规矩：`node scripts/check-feature-readpaths.mjs` 在任何机器上都要能直接跑。
 * 落盘只在系统临时目录里做，跑完删干净，绝不碰主人真实的 .state。
 *
 * 跑法：node scripts/check-feature-readpaths.mjs
 */
import { readFileSync, readdirSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  [ok] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
};
/** 只打印、不计分的细节行（红的时候用来看清「到底哪几处」） */
const detail = (line) => console.log('         ' + line);

const readSrc = (rel) => {
  try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; }
};

/** src/ 下所有 .mjs（含 harness 子目录），跳过备份文件 */
function listSrcFiles() {
  const out = [];
  const walk = (dir) => {
    let ents = [];
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (!e.isFile() || !e.name.endsWith('.mjs')) continue;
      if (/\.bak[-.]/.test(e.name)) continue;
      out.push(full);
    }
  };
  walk(join(ROOT, 'src'));
  return out;
}

/**
 * 去掉注释（行号保持不变）。
 *
 * 为什么必须去：这个文件里到处是「以前这里用 getEnabledMap()[id] 判，后来改成……」这种
 * 注释。不去掉的话守卫会被自己的注释判红，那就成了笑话。
 * 做法：块注释整段抹成空格（保留换行）；`//` 只抹「行首就是注释」的行，
 * 避免把 'https://…' 这种字符串里的双斜线也吃掉。
 */
function stripComments(src) {
  const noBlock = src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  return noBlock
    .split('\n')
    .map((line) => {
      const t = line.trimStart();
      if (t.startsWith('//') || t.startsWith('*')) return '';
      return line;
    })
    .join('\n');
}

/* ============================================================
 * ① 静态：白名单、文档一致性、三级回退、裸判定
 * ============================================================ */
console.log('=== 1. 静态：白名单与文档一致，三级回退没被简化 ===');

const featSrc = readSrc('src/features.mjs');
const docSrc = readSrc('skills/coding-discipline/SKILL.md');
check('src/features.mjs 读得到', featSrc.length > 1000, `${featSrc.length} 字`);
check('规则文档读得到', docSrc.length > 1000, `${docSrc.length} 字`);

/** 代码里的白名单 */
const wlMatch = /GLOBAL_ONLY_FEATURES\s*=\s*new\s+Set\(\s*\[([^\]]*)\]\s*\)/.exec(featSrc);
const codeWhitelist = wlMatch
  ? [...wlMatch[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((m) => m[1] ?? m[2])
  : [];
check('features.mjs 里找得到 GLOBAL_ONLY_FEATURES', !!wlMatch, codeWhitelist.join(','));

/** 文档里那张例外表（只在「例外：机器级应用开关」那一节里找） */
const secStart = docSrc.indexOf('### 例外：机器级应用开关');
const secEnd = secStart < 0 ? -1 : (() => {
  const rest = docSrc.slice(secStart + 3);
  const next = rest.indexOf('\n### ');
  return next < 0 ? docSrc.length : secStart + 3 + next;
})();
const secText = secStart < 0 ? '' : docSrc.slice(secStart, secEnd);
const docWhitelist = [...secText.matchAll(/^\|\s*`([A-Za-z0-9_-]+)`\s*\|/gm)].map((m) => m[1]);
check('规则文档里找得到例外表', secStart >= 0 && docWhitelist.length > 0, docWhitelist.join(','));

const missingInDoc = codeWhitelist.filter((id) => !docWhitelist.includes(id));
const extraInDoc = docWhitelist.filter((id) => !codeWhitelist.includes(id));
check(
  '文档例外表 == 代码 GLOBAL_ONLY_FEATURES（两个方向）',
  codeWhitelist.length > 0 && missingInDoc.length === 0 && extraInDoc.length === 0,
  missingInDoc.length || extraInDoc.length ? `文档缺 [${missingInDoc}] / 文档多 [${extraInDoc}]` : `${codeWhitelist.length} 个`,
);

/* ---- 白名单里每一条都得是「真的功能」，而且写了「为什么它是全局」 ----
 *
 * 【为什么要钉这个】名单是个 Set，往里塞个 id 零成本。没有这条的话，
 * 下一个人想让自己那个功能走全局，只要往 Set 里加一行就绿了 —— 理由一个字不用写，
 * 半年后谁也不知道它凭什么例外。所以要求：条目本身在 FEATURES 里存在（不许拼错），
 * 且它的功能定义里得有一句人类能读的理由（机器级 / 进程级 / 点名 GLOBAL_ONLY_FEATURES）。
 */
function arrayText(src, name) {
  const at = src.indexOf('const ' + name + ' = [');
  if (at < 0) return '';
  const open = src.indexOf('[', at);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}
const featuresArr = arrayText(featSrc, 'FEATURES');
check('features.mjs 里取得出 FEATURES 数组', featuresArr.length > 1000, `${featuresArr.length} 字`);

for (const id of codeWhitelist) {
  const at = featuresArr.indexOf("id: '" + id + "'");
  check(`白名单 ${id} 是真存在的功能（不是拼错的 id）`, at >= 0);
  if (at < 0) continue;
  /* 理由都写在 id 上面那段块注释里，所以往前看一小段 */
  const around = featuresArr.slice(Math.max(0, at - 1400), at + 200);
  check(
    `白名单 ${id} 写了「为什么只能是全局」的理由`,
    /机器级|进程级|GLOBAL_ONLY_FEATURES/.test(around),
    /机器级|进程级|GLOBAL_ONLY_FEATURES/.test(around) ? '' : '条目上方没找到 机器级 / 进程级 / GLOBAL_ONLY_FEATURES 任何一种说法',
  );
}

/** 三级回退：从 resolveEnabled 的函数体里按顺序找三级的痕迹 */
function funcBody(src, name) {
  const at = src.indexOf('function ' + name);
  if (at < 0) return '';
  const open = src.indexOf('{', at);
  if (open < 0) return '';
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open, i + 1); }
  }
  return '';
}
const resolveBody = stripComments(funcBody(featSrc, 'resolveEnabled'));
check('features.mjs 里有 resolveEnabled（三级回退的实现处）', resolveBody.length > 0, `${resolveBody.length} 字`);

const iSession = resolveBody.search(/bySession/);
const iGlobalRaw = resolveBody.search(/raw\s*\[/);
const iDefault = resolveBody.search(/defaultOn/);
check(
  '三级回退第①级（会话表）还在',
  iSession >= 0,
  iSession >= 0 ? `位置 ${iSession}` : '找不到 bySession —— 会话那一级被删了？',
);
check(
  '三级回退第②级（全局 raw 值）还在',
  iGlobalRaw >= 0,
  iGlobalRaw >= 0 ? `位置 ${iGlobalRaw}` : '找不到 raw[...] —— 被简化成直接 defaultOn 了？这就是升级后功能自己全开的那个 bug',
);
check(
  '三级回退第③级（defaultOn）还在',
  iDefault >= 0,
  iDefault >= 0 ? `位置 ${iDefault}` : '找不到 defaultOn',
);
check(
  '三级顺序没被打乱：会话 → 全局 raw → defaultOn',
  iSession >= 0 && iGlobalRaw > iSession && iDefault > iGlobalRaw,
  iSession >= 0 && iGlobalRaw >= 0 && iDefault >= 0 ? `${iSession} < ${iGlobalRaw} < ${iDefault}` : '',
);

/* ---- 裸 getEnabledMap 单条判定 ---- */
console.log('');
console.log('=== 2. 静态：除白名单外，不许裸读 getEnabledMap()[单个功能] ===');

const files = listSrcFiles();
check('扫到了 src 下的源文件', files.length > 20, `${files.length} 个 .mjs`);

/** 要跳过判定的文件：features.mjs 自己就是这套机制的实现 */
const SKIP_FILES = new Set(['src/features.mjs']);

const violations = [];
for (const full of files) {
  const rel = relative(ROOT, full).split(sep).join('/');
  if (SKIP_FILES.has(rel)) continue;
  const raw = readFileSync(full, 'utf8');
  const src = stripComments(raw);
  const lines = src.split('\n');

  /* 整表读法的别名：`const m = getEnabledMap();` 之后 m.memory 这种最难查，
   * 光扫「getEnabledMap().xxx」会漏掉它（identity / task-mode / tts 都是这个写法）。 */
  const aliases = new Set();
  for (const m of src.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*getEnabledMap\(\s*\)/g)) {
    aliases.add(m[1]);
  }

  lines.forEach((line, i) => {
    const hit = [];
    for (const m of line.matchAll(/getEnabledMap\(\)\s*\??\.\s*([A-Za-z_$][\w$]*)/g)) hit.push(m[1]);
    for (const m of line.matchAll(/getEnabledMap\(\)\s*\[\s*(['"])([^'"]+)\1\s*\]/g)) hit.push(m[2]);
    for (const a of aliases) {
      /* 两种写法都要抓：`m.memory` 和 `m['memory']`（以及可选链 `m?.memory`）。
       * 这里别用「?\.」当「可选的点」—— 那是「问号 + 任意字符」，会把正常写法漏掉。 */
      const reDot = new RegExp('\\b' + a + '\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*)', 'g');
      const reIdx = new RegExp('\\b' + a + '\\s*\\[\\s*([\'"])([^\'"]+)\\1\\s*\\]', 'g');
      for (const m of line.matchAll(reDot)) hit.push(m[1]);
      for (const m of line.matchAll(reIdx)) hit.push(m[2]);
    }
    for (const id of hit) {
      if (codeWhitelist.includes(id)) continue; // 白名单本来就是全局的，允许裸读
      violations.push({ rel, line: i + 1, id, text: line.trim().slice(0, 110) });
    }
  });
}

check(
  '除白名单外没有裸 getEnabledMap 单条判定',
  violations.length === 0,
  violations.length ? `${violations.length} 处` : '干净',
);
for (const v of violations) {
  detail(`${v.rel}:${v.line}  读的是全局表里的「${v.id}」→ 应改成 featureOnFor(sessionId, '${v.id}')`);
  detail('    ' + v.text);
}

/* ============================================================
 * ② 真跑：临时数据目录里验行为（三级语义 / 白名单不落会话表 / 缺 sessionId 要抛）
 *
 * 必须在 import features.mjs **之前**设 MINI_AGENT_DATA —— config.mjs 加载时就定死 dataDir。
 * ============================================================ */
console.log('');
console.log('=== 3. 真跑：临时数据目录里的行为 ===');

const TMP = join(tmpdir(), `xy-readpaths-${process.pid}-${Date.now()}`);
const ST = join(TMP, '.state');
mkdirSync(ST, { recursive: true });
process.env.MINI_AGENT_DATA = TMP;

let F;
try {
  F = await import('../src/features.mjs');
} catch (e) {
  console.log('  [FAIL] features.mjs 加载不了：' + String(e?.message ?? e));
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

const BY_SESSION = join(ST, 'feature-by-session.json');
const FEATURES = join(ST, 'features.json');
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };

check('setFeatureScoped 存在（界面点开关的唯一入口）', typeof F.setFeatureScoped === 'function');
check('featureOnFor 存在', typeof F.featureOnFor === 'function');
check('enabledMapFor 存在（批量版）', typeof F.enabledMapFor === 'function');

try {
  /* --- ③ 缺 sessionId 要抛，不许静默写全局 --- */
  let e1 = null;
  try { F.setFeatureFor('', 'web', true); } catch (e) { e1 = e; }
  check('setFeatureFor 缺 sessionId → 400（不静默写全局）', e1 && e1.status === 400, e1 ? String(e1.message) : '(没抛)');

  let e2 = null;
  try { F.setFeatureScoped('web', true, ''); } catch (e) { e2 = e; }
  check('setFeatureScoped 非白名单功能缺 sessionId → 抛', e2 && e2.status === 400, e2 ? String(e2.message) : '(没抛)');
  check('上面那次没把 web 写进全局表', !readJson(FEATURES) || readJson(FEATURES).web === undefined);

  /* --- ② 白名单永远不进会话表 --- */
  for (const id of codeWhitelist) {
    let r = null;
    let err = null;
    try { r = F.setFeatureScoped(id, false, 'sidA'); } catch (e) { err = e; }
    check(`白名单 ${id} 走全局（不抛、scope=global）`, !err && r && r.scope === 'global', err ? String(err.message) : JSON.stringify(r));
    const bySess = readJson(BY_SESSION) || {};
    const dirty = Object.keys(bySess).some((sid) => bySess[sid] && Object.prototype.hasOwnProperty.call(bySess[sid], id));
    check(`白名单 ${id} 没有落进 feature-by-session.json`, !dirty);

    /* 白名单的开关写到全局表之后，读回来必须是关的（这是主人真能看到的） */
    check(`白名单 ${id} 写全局后 featureOnFor 读到关`, F.featureOnFor('anySid', id) === false);
  }

  /* --- 非白名单：只写当前会话那一条，别的会话不许冒出来 --- */
  F.setFeatureScoped('web', false, 'sidA');
  const bySess1 = readJson(BY_SESSION) || {};
  check('非白名单功能写进了会话表', bySess1.sidA && bySess1.sidA.web === false, JSON.stringify(bySess1));
  check('会话表里没有冒出别的会话 id（前端传错 sessionId 的典型症状）', Object.keys(bySess1).length === 1 && Object.keys(bySess1)[0] === 'sidA', Object.keys(bySess1).join(','));
  check('A 会话关掉之后，A 读到关', F.featureOnFor('sidA', 'web') === false);
  check('B 会话没设过 → 走全局兜底（不是被 A 带跑）', F.featureOnFor('sidB', 'web') !== false);

  /* --- ③ 三级的语义，一条一条验（光看源码顺序不够） --- */
  F.setFeature('web', false);                       // ② 全局关
  check('② 没有会话记录时，全局关 → 读到关', F.featureOnFor('sidC', 'web') === false);
  F.setFeatureScoped('web', true, 'sidC');          // ① 会话关着但会话里打开
  check('① 会话设过 → 盖过全局（读到开）', F.featureOnFor('sidC', 'web') === true);
  check('① 只影响 sidC，sidD 仍跟着全局（读到关）', F.featureOnFor('sidD', 'web') === false);

  /* ③ 全局表里没有这一格 → defaultOn。挑一个 defaultOn:false 的功能最清楚：selfwake */
  const rawFeat = readJson(FEATURES) || {};
  delete rawFeat.selfwake;
  writeFileSync(FEATURES, JSON.stringify(rawFeat, null, 2), 'utf8');
  check('③ 全局没写这一格 → 按 defaultOn（selfwake=false）', F.featureOnFor('sidE', 'selfwake') === false);

  const rawFeat2 = readJson(FEATURES) || {};
  delete rawFeat2.web;
  writeFileSync(FEATURES, JSON.stringify(rawFeat2, null, 2), 'utf8');
  check('③ 全局没写这一格 → 按 defaultOn（web 默认开）', (() => {
    /* sidE 对 web 没有会话记录，全局也删了 → 应当落回 defaultOn=true */
    try { return F.featureOnFor('sidE', 'web') === true; } catch { return false; }
  })());
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log('');
console.log('断言：' + pass + '/' + (pass + fail));
if (fail) {
  console.log('\u2605 失败 ' + fail + ' 条');
  process.exit(1);
}
console.log('PASS 功能开关的读路径都是按会话（白名单除外），三级回退和缺参抛错都还在');
