/**
 * 守卫：备份清单里必须包含「换机器时会丢」的那几个功能相关文件。
 *
 * 【这个脚本钉的是什么】
 * src/backup.mjs 的 KEEP_FILES 是一串**文件名字符串**。它是全项目最容易静默失效的地方：
 *
 *   · 谁把 features-custom.json 改名了（比如改成 feature-custom.json），备份清单不会报错，
 *     备份照样能生成、恢复也照样成功 —— 只是自定义功能一个都没进包；
 *   · 等到主人换电脑恢复备份，发现「我自己加的功能全没了」，那时候数据已经找不回来了。
 *
 * 所以这里干两件事：
 *   ① **名字从源码里取**，不写死。features.mjs 的 FILE / CUSTOM_FILE / BY_SESSION_FILE、
 *      agents.mjs 的 FILE 是什么，就要求备份清单里有同名的。改了名 check 立刻红。
 *   ② 真跑一次 buildBackup()（数据目录指到系统临时目录），确认这四个文件真的**进包了** ——
 *      只比对字符串还不够，万一是词写对了但 collect() 的逻辑变了呢。
 *
 * 【为什么是纯静态 + 纯函数，不连服务、不开浏览器】
 * 全项目硬规矩：回归基线要能在任何机器上 `node scripts/check-backup-covers.mjs` 直接跑。
 * 落盘只在系统临时目录里做，跑完删干净，绝不碰主人真实的 .state。
 *
 * 跑法：node scripts/check-backup-covers.mjs
 */
import { readFileSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
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

const readSrc = (rel) => {
  try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; }
};

/**
 * 从一个 `const X = join(..., '名字.json')` 里取出最后那个字符串字面量。
 *
 * 为什么取「最后一个」而不是写死 join(a, b, c) 的形状：
 * features.mjs 里 FILE 是 `join(config.dataDir, '.state', 'features.json')`，
 * agents.mjs 里 FILE 是 `join(DIR, 'agents.json')` —— 参数个数不一样，但名字都在末尾。
 *
 * 取不到就返回空串，由调用方判 FAIL —— **绝不允许「取不到就当通过」**，
 * 那样常量一改名，这个守卫就自己哑了。
 */
function fileNameOf(src, constName) {
  const re = new RegExp('(?:const|let|var)\\s+' + constName + '\\s*=\\s*([^;\\n]+)');
  const m = re.exec(src);
  if (!m) return '';
  const lits = [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] ?? x[2]);
  return lits.length ? lits[lits.length - 1] : '';
}

/** 把 KEEP_FILES 数组里所有单引号字符串抠出来。 */
function keepFilesOf(src) {
  const m = /const\s+KEEP_FILES\s*=\s*\[([\s\S]*?)\n\];/.exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

/* ============================================================
 * ① 静态：名字从源码里取，再跟备份清单比对
 * ============================================================ */
console.log('=== 1. 静态：备份清单覆盖「会丢的那几个文件」（名字取自源码）===');

const featSrc = readSrc('src/features.mjs');
const agentSrc = readSrc('src/agents.mjs');
const backupSrc = readSrc('src/backup.mjs');

check('src/features.mjs 读得到', featSrc.length > 1000, `${featSrc.length} 字`);
check('src/agents.mjs 读得到', agentSrc.length > 1000, `${agentSrc.length} 字`);
check('src/backup.mjs 读得到', backupSrc.length > 1000, `${backupSrc.length} 字`);

const keep = keepFilesOf(backupSrc);
check('backup.mjs 里找得到 KEEP_FILES 数组', Array.isArray(keep), keep ? `${keep.length} 项` : '没找到');

/**
 * 要钉住的四个文件。
 * `from` 写清「这个名字是从哪个文件的哪个常量抽出来的」——
 * 出红的时候一眼能看出是源码改名了，还是备份清单漏了。
 */
const WANT = [
  { key: 'features.json', src: 'src/features.mjs', srcText: featSrc, constName: 'FILE', why: '功能开关全局表（老会话的兜底）' },
  { key: 'feature-by-session.json', src: 'src/features.mjs', srcText: featSrc, constName: 'BY_SESSION_FILE', why: '按会话的功能开关' },
  { key: 'features-custom.json', src: 'src/features.mjs', srcText: featSrc, constName: 'CUSTOM_FILE', why: '本机自加的功能定义（换机器不备份就没了）' },
  { key: 'agents.json', src: 'src/agents.mjs', srcText: agentSrc, constName: 'FILE', why: '主人自己建的智能体卡' },
];

const resolved = [];
for (const w of WANT) {
  const actual = fileNameOf(w.srcText, w.constName);
  resolved.push({ ...w, actual });
  check(
    `${w.src} 的 ${w.constName} 能抽出文件名`,
    !!actual,
    actual ? `${w.key} → ${actual}` : `抽不到（常量改名了？这个守卫已经瞎了，赶紧修脚本）`,
  );
  check(
    `${w.key} 拼的是 数据目录/.state/ 下的相对名`,
    !!actual && !/[\\/]/.test(actual),
    actual && /[\\/]/.test(actual) ? `名字里带路径分隔符：${actual}` : '',
  );
}

for (const w of resolved) {
  /* 用**源码里真实的那个名字**去比对，而不是用 w.key。
   * 这样 features-backend 哪天把 features-custom.json 改成别的名字：
   *   · 备份清单没跟着改 → 这里立刻红；
   *   · 两边都改了 → 绿，而且不需要改这个脚本。
   * 这正是「不许写死」的意义。 */
  const name = w.actual || w.key;
  check(`备份清单包含 ${name}（${w.why}）`, Array.isArray(keep) && keep.includes(name));
}

/* 名字一致但语义反了的兜底：确认这四个都在，且没有重复项 */
if (Array.isArray(keep)) {
  const dup = keep.filter((n, i) => keep.indexOf(n) !== i);
  check('备份清单没有重复项', dup.length === 0, dup.join(','));
  check('备份清单没有空项', keep.every((n) => n && n.trim()), keep.filter((n) => !n || !n.trim()).join(','));
}

/* ============================================================
 * ② 真跑：临时数据目录里造这四个文件，看 buildBackup 收不收
 *
 * 必须在 import backup.mjs **之前**设 MINI_AGENT_DATA ——
 * config.mjs 在模块加载时就把 dataDir 定死了。
 * ============================================================ */
console.log('');
console.log('=== 2. 真跑：临时数据目录里 buildBackup() 收不收这四个文件 ===');

const TMP = join(tmpdir(), `xy-backup-guard-${process.pid}-${Date.now()}`);
const TMP_STATE = join(TMP, '.state');
mkdirSync(TMP_STATE, { recursive: true });
process.env.MINI_AGENT_DATA = TMP;

/* 造文件时用**源码里的真名**，别用 w.key —— 名字改了这里也得跟着改才行 */
const made = [];
for (const w of resolved) {
  const name = w.actual || w.key;
  if (!name) continue;
  try {
    writeFileSync(join(TMP_STATE, name), JSON.stringify({ guard: name }), 'utf8');
    made.push(name);
  } catch (e) {
    console.log('  [FAIL] 造不出测试文件 ' + name + '：' + String(e?.message ?? e));
    fail++;
  }
}

let B;
try {
  B = await import('../src/backup.mjs');
} catch (e) {
  console.log('  [FAIL] backup.mjs 加载不了：' + String(e?.message ?? e));
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

try {
  const pack = B.buildBackup();
  const keys = Object.keys(pack.files || {});
  check('buildBackup 造出包了', keys.length > 0, `${keys.length} 个文件`);
  for (const name of made) {
    check(`${name} 真的进了备份包`, keys.includes(name));
  }
  check('包格式没变（format/version/files）', pack.format === B.BACKUP_FORMAT && typeof pack.version === 'number' && !!pack.files);

  /* 反向确认：临时目录里**没造**的文件不该凭空出现（防止 collect 退化成「全收」，
   * 那样再塞多少垃圾进 .state 都会被打包） */
  check('没造的文件没被硬塞进包', !keys.includes('definitely-not-a-real-file.json'));

  /* 恢复侧：备份包里的键会被原样写回 .state，所以「名字对不对」直接决定能不能恢复。
   * 分两步验，才说明「真能救回来」，而不是只验「不抛错」：
   *   a) 文件都在时走 merge → 一个都不覆盖（kept）
   *   b) 先删掉一个，再 restore → 那个文件被写回来（wrote）
   * 注意返回值字段叫 wrote / kept（不是 written），merge 模式下已存在的文件会被跳过。 */
  const probe = made[made.length - 1];
  let r1 = null;
  try { r1 = B.restoreBackup(pack, { mode: 'merge' }); } catch (e) { r1 = { err: e }; }
  check('restoreBackup 能吃下这份包（不因新文件报错）', r1 && r1.ok === true && r1.failed.length === 0, JSON.stringify(r1.failed || []).slice(0, 200));
  check('merge 模式不覆盖已存在的文件', r1 && r1.wrote === 0 && r1.kept === made.length, r1 && `wrote=${r1.wrote} kept=${r1.kept}`);

  if (probe) {
    rmSync(join(TMP_STATE, probe), { force: true });
    let r2 = null;
    try { r2 = B.restoreBackup(pack, { mode: 'merge' }); } catch (e) { r2 = { err: e }; }
    check(`删掉 ${probe} 后 restore 能把它写回来`, r2 && r2.ok === true && r2.wrote === 1 && existsSync(join(TMP_STATE, probe)), r2 && `wrote=${r2.wrote} failed=${JSON.stringify(r2.failed)}`);
  }
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log('');
console.log('断言：' + pass + '/' + (pass + fail));
if (fail) {
  console.log('\u2605 失败 ' + fail + ' 条');
  process.exit(1);
}
console.log('PASS 备份清单覆盖了功能相关的四个文件，且名字跟源码一致（改名会立刻变红）');
