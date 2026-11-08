/**
 * 【增量回归 · 2026-11-08 加】
 *
 * 主人：「回归有那么多种类……【跑增量】指的是跑基于变更/影响的回归」，
 * 而且要求「不要搞混了」。
 *
 * 这一档和「冒烟」「核心」「全量」的区别：
 *   · 冒烟 = 固定的一组纯源码断言（跟改了什么无关，永远跑那一批）
 *   · **变更 = 按你这次真改到的文件，反查出可能被影响的检查**（每次不一样）
 *   · 核心 = 固定的一组核心链路检查（跟改了什么无关）
 *   · 全量 = 70 个 + 真机格 + 接口扫描
 *
 * 怎么知道「哪个检查受哪个文件影响」—— 不靠手工维护映射表（一定会漏），
 * 而是扫每个检查脚本里 `readFileSync / existsSync / readdirSync('...')`
 * 的字面量路径，自动建「文件 → 检查」的反向索引。
 * 检查脚本读它，就说明那个文件一旦变了它就可能要重跑。
 *
 * 用法：
 *   node scripts/check-changed.mjs            # 对比 HEAD（工作区改动 + 未跟踪文件）
 *   node scripts/check-changed.mjs --staged   # 只看已暂存
 *   node scripts/check-changed.mjs --base origin/master
 *   node scripts/check-changed.mjs --dry      # 只列出会跑哪些，不执行
 */
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';

const DIR = path.join(process.cwd(), 'scripts');
/** 这三档自己不算「被影响的检查」，别递归 */
const SELF = new Set(['check-smoke.mjs', 'check-changed.mjs', 'check-core.mjs']);

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd: process.cwd() }).trim();
  } catch { return ''; }
}

/** 1) 这次改到哪些文件 */
function changedFiles() {
  const base = (() => {
    const i = argv.indexOf('--base');
    return i >= 0 && argv[i + 1] ? argv[i + 1] : '';
  })();
  let out = [];
  if (argv.includes('--staged')) {
    out = git(['diff', '--cached', '--name-only']).split('\n');
  } else if (base) {
    out = git(['diff', '--name-only', base]).split('\n');
  } else {
    out = [
      ...git(['diff', '--name-only', 'HEAD']).split('\n'),
      ...git(['ls-files', '--others', '--exclude-standard']).split('\n'),
    ];
  }
  return [...new Set(out.map((x) => x.trim().replace(/\\/g, '/')).filter(Boolean))];
}

/** 2) 每个检查读了哪些仓库内文件（扫字面量路径建索引） */
function buildIndex() {
  const checks = readdirSync(DIR)
    .filter((f) => /^check-.*\.mjs$/.test(f) && !SELF.has(f))
    .sort();
  const readRe = /(?:readFileSync|existsSync|readdirSync|statSync|__diagRead|readFile)\(\s*['"`]([^'"`\n]+)['"`]/g;
  const byFile = new Map(); // 文件 → Set(检查)
  const reads = new Map();  // 检查 → Set(文件)
  for (const f of checks) {
    const s = readFileSync(path.join(DIR, f), 'utf8');
    const set = new Set();
    for (const m of s.matchAll(readRe)) {
      let p = m[1].replace(/\\/g, '/').replace(/^\.\.\//, '');
      if (p.startsWith('node:')) continue;
      /* 只认仓库里的相对路径，跳过绝对路径和临时目录 */
      if (!/^(public|src|scripts|persona|electron|assets)\//.test(p)) continue;
      set.add(p);
      if (!byFile.has(p)) byFile.set(p, new Set());
      byFile.get(p).add(f);
    }
    reads.set(f, set);
  }
  return { checks, byFile, reads };
}

/** 3) 改动的文件 → 受影响检查 */
const CORE = [
  'check-chat-e2e.mjs', 'check-live-sync.mjs', 'check-turn-watchdog.mjs',
  'check-stuck-autoresume.mjs', 'check-pending-queue.mjs', 'check-think-display.mjs',
  'check-tool-naming.mjs', 'check-factory-prompt.mjs',
];
/** 改到这些「基础设施」文件时，光靠索引不够，直接补一组核心 */
const CORE_TRIGGERS = [/^src\/(server|agent|llm|tools|features|config)\.mjs$/, /^public\/index\.html$/];

function pick(changed) {
  const { checks, byFile } = buildIndex();
  const hit = new Set();
  const why = new Map(); // 检查 → 触发它的文件
  for (const c of changed) {
    for (const [file, set] of byFile) {
      if (file === c) {
        for (const f of set) { hit.add(f); if (!why.has(f)) why.set(f, file); }
      }
    }
  }
  /* 改到（或新增）某个检查脚本本身 → 直接跑它。
   * 否则「变更」会把它自己判成空：没有别的检查会去读 check-xxx.mjs，
   * 反查索引必然落空 —— 可它正是刚被改的那个，最该跑。 */
  for (const c of changed) {
    const m = /^scripts\/(check-[a-z0-9-]+\.mjs)$/.exec(c);
    if (m && checks.includes(m[1])) { hit.add(m[1]); if (!why.has(m[1])) why.set(m[1], c); }
  }
  /* 改到核心文件时，把核心那组补进来（索引可能漏掉不读文件的检查，
   * 比如真机格只连 CDP） */
  const coreHit = changed.some((c) => CORE_TRIGGERS.some((re) => re.test(c)));
  const extra = [];
  if (coreHit) {
    for (const f of CORE) {
      if (checks.includes(f) && !hit.has(f)) { hit.add(f); extra.push(f); }
    }
  }
  /* 一个都没命中（改了不认识的文件）→ 退回冒烟那批，别什么都不跑 */
  if (!hit.size) {
    return { list: [], why, extra, empty: true, all: checks };
  }
  return { list: [...hit].sort(), why, extra, empty: false, all: checks };
}

const changed = changedFiles();
console.log('=== 增量回归 ===');
if (!changed.length) {
  console.log('  工作区没有改动。要看别的：--staged / --base origin/master');
  console.log('  什么都不跑是**对的** —— 没有变更就没有「基于变更的回归」。');
  process.exit(0);
}
for (const c of changed.slice(0, 20)) console.log('  改 ' + c);
if (changed.length > 20) console.log('  …还有 ' + (changed.length - 20) + ' 个');

const r = pick(changed);
if (r.empty) {
  console.log('\n没有检查在读这些文件（可能是文档 / 素材 / 新脚本本身）。');
  if (DRY) { console.log('--dry：这种情况会退回跑冒烟那一批。'); process.exit(0); }
  console.log('退回冒烟那批：');
  const r0 = spawnSync(process.execPath, [path.join(DIR, 'check-smoke.mjs')], { stdio: 'inherit' });
  process.exit(r0.status || 0);
}

console.log('\n受影响 ' + r.list.length + ' 个检查' + (r.extra.length ? '（其中 ' + r.extra.length + ' 个是改到核心文件补进来的）' : '') + '：');
for (const f of r.list) {
  const w = r.why.get(f);
  console.log('  ' + f + (w ? ('   ← ' + w) : '   ← 核心文件'));
}
if (DRY) { console.log('\n--dry：只列不跑。'); process.exit(0); }

let fail = 0;
const t0 = Date.now();
for (const f of r.list) {
  const one = Date.now();
  const x = spawnSync(process.execPath, [path.join(DIR, f)], {
    encoding: 'utf8', timeout: 15 * 60 * 1000,
  });
  const ms = Date.now() - one;
  if (x.status === 0) {
    console.log('  OK   ' + f + '  ' + (ms / 1000).toFixed(1) + 's');
  } else {
    fail++;
    console.log('  FAIL ' + f + '  ' + (ms / 1000).toFixed(1) + 's');
    console.log(String(x.stdout || '').trim().split('\n').slice(-10).join('\n'));
    console.log(String(x.stderr || '').trim().split('\n').slice(-6).join('\n'));
  }
}
console.log('———— 增量回归：' + (r.list.length - fail) + '/' + r.list.length
  + ' 通过，' + ((Date.now() - t0) / 1000).toFixed(1) + 's ————');
console.log('注意：增量回归只覆盖「可能被影响」的那些。发布前仍要跑 run-all-checks.mjs 全量。');
process.exit(fail ? 1 : 0);
