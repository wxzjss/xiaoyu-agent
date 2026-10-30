#!/usr/bin/env node
/**
 * 把小改动同步到「打包后真正会生效」的那两层。
 *
 * 为什么需要这个脚本
 * ------------------
 * 打包之后，程序不是只认 asar。它有三层，越前面的越优先：
 *
 *   1. <数据目录>/code/        —— js / mjs 都从这里加载（main.cjs 的 importSrc）
 *   2. <数据目录>/public/      —— 网页从这里读（server.mjs 的 PUBLIC_OVERRIDE）
 *   3. app.asar 里的那份        —— 兜底，上面没有才用它
 *
 * 踩过的坑：改了源码、重打了 asar，一启动发现改动没生效 ——
 * 因为 code/ 里那份旧的先被加载了。反过来也有：更新流程往 code/ 写了新文件，
 * 但你只改了 asar，两边就此分家，谁也说不清在跑哪份。
 *
 * 这个脚本干一件事：把源码目录里「该同步的」推到 1 和 2，
 * 让三层永远一致。
 *
 * 比较用「归一化后的内容」而不是文件字节 ——
 * 不然 git / 更新流程写进去的 CRLF，跟本地 LF 一撞，每个文件都报「不同」，
 * 天天满屏差异，真有问题反而看不见了。
 *
 * 用法
 * ----
 *   node scripts/sync-live.mjs            # 同步
 *   node scripts/sync-live.mjs --dry      # 只看看会动哪些文件，不写
 *   node scripts/sync-live.mjs --check    # 只检查三层一致不一致，不写
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const CHECK = args.includes('--check');
// 同步之前先过一遍预检：会把白屏的错误挡在「进到安装版」之前。
// 真需要硬推的时候加 --no-gate（比如只想补一个无关紧要的文件）。
const SKIP_GATE = args.includes('--no-gate');
/** 数据目录校验的逃生口：确认那个目录就是目标时用 */
const FORCE_DIR = args.includes('--force-dir');

if (!CHECK && !DRY && !SKIP_GATE) {
  /**
   * 为什么把闸设在这里
   * ------------------
   * sync-live 是「源码 → 安装版」的唯一通路，也是这次事故的扩散通道：
   * 小鱼的改动直接落在数据目录、没进源码，于是源码是干净的、git 是干净的，
   * 一读 `node --check` 全过，谁都不知道安装版里那个页面已经打不开了。
   *
   * 在唯一的出口上装一道闸，比事后靠人记得跑检查可靠。
   */
  const { execFileSync } = await import('node:child_process');
  try {
    execFileSync(process.execPath, [join(HERE, 'check-ui.mjs')], { stdio: 'inherit' });
  } catch {
    console.error('');
    console.error('页面自检没过，同步已中止。');
    console.error('（确认只是无关改动、要强行同步的话，加 --no-gate）');
    process.exit(1);
  }
}

/** 数据目录：跟 src/config.mjs 一个规矩 */
function dataDir() {
  if (process.env.MINI_AGENT_DATA) return process.env.MINI_AGENT_DATA;
  const appData = process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
  return join(appData, '小鱼Agent', 'data');
}

const DATA = dataDir();
const CODE = join(DATA, 'code');
const PUBLIC = join(DATA, 'public');

function DEFAULT_DATA_HINT() {
  const appData = process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
  return join(appData, '小鱼Agent', 'data');
}

/**
 * 数据目录是不是真的「小鱼Agent 的数据目录」。
 *
 * 为什么加这道：2026-10-30 我在同一个 shell 里跑过测试探针，那探针设了
 *   MINI_AGENT_DATA=<临时目录>\obprobe1
 * 环境变量留在了 shell 里。之后跑 sync-live，它老老实实照着环境变量算，
 * 把 102 个文件往那个临时目录里同步 —— 真正的安装版一个字节没动，
 * 而屏幕上刷满「差异 102 个」，看起来像正常同步。
 *
 * 试过但不够的两条判据（探针目录是从真目录拷出来的，全都过）：
 *   ✘ 「有 .state 或 code 或 public」 —— 三样都有
 *   ✘ 「.state 下有 ≥2 个真标记」 —— features.json / memory / personas 全有
 *
 * 最终判据：**默认位置存在时，只认默认位置。**
 * 想同步到别处，必须显式加 --force-dir，让人有意识地做这个决定。
 */
function looksLikeDataDir(d) {
  const appData = process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
  const DEFAULT = join(appData, '小鱼Agent', 'data');
  const norm = (p) => String(p).replace(/[\\/]+/g, '\\').replace(/\\$/, '').toLowerCase();
  const isDefault = norm(d) === norm(DEFAULT);
  const hasDefault = existsSync(DEFAULT);

  // 已经有真安装版放在默认位置了 —— 那就不许同步到别的目录去
  if (hasDefault && !isDefault) return false;

  // 就是默认位置（或者这台机器还没装过）：再确认它结构上像个数据目录
  const hasState = (() => {
    try { return statSync(join(d, '.state')).isDirectory(); } catch { return false; }
  })();
  const hasCode = (() => {
    try { return statSync(join(d, 'code', 'src')).isDirectory(); } catch { return false; }
  })();
  return hasState || hasCode;
}

if (!CHECK && !DRY && !FORCE_DIR && !looksLikeDataDir(DATA)) {
  console.error('');
  console.error('✘ 数据目录不是小鱼Agent 的安装位置：' + DATA);
  console.error('  已经有安装版装在 ' + DEFAULT_DATA_HINT() + '，不该同步到别处。');
  if (process.env.MINI_AGENT_DATA) {
    console.error('  这次是从环境变量 MINI_AGENT_DATA 拿到的。');
    console.error('  多半是之前跑测试探针留下的（比如 %TEMP%\\obprobe1）。');
    console.error('  清掉再跑：PowerShell → Remove-Item Env:\\MINI_AGENT_DATA');
  }
  console.error('  确认这个目录是对的、就是要往这儿同步，加 --force-dir。');
  process.exit(1);
}

/** 这些后缀是二进制，按原始字节比；其余按「行尾归一化后的文本」比 */
const BINARY_EXT = new Set(['.ico', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mp3', '.m4a', '.wav', '.zip', '.woff', '.woff2', '.ttf', '.otf', '.exe', '.dll', '.node']);

/** 永远不同步的目录名 / 文件名特征 */
function skipFile(name, full) {
  if (name === 'node_modules' || name === 'sandbox' || name === 'dump' || name === 'dist') return true;
  if (name === '__pycache__') return true;
  if (name.endsWith('.bak') || name.includes('.bak-')) return true;
  if (extname(name) === '.pyc') return true;
  if (name === '.env' || name === '.env.local') return true; // 密钥不进代码目录
  return false;
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (skipFile(name, join(dir, name))) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 内容指纹：文本按行尾归一化后算，二进制按原始字节算 */
function finger(file) {
  try {
    const buf = readFileSync(file);
    if (BINARY_EXT.has(extname(file).toLowerCase())) {
      return createHash('md5').update(buf).digest('hex');
    }
    const text = buf.toString('utf8').replace(/\r\n/g, '\n');
    return createHash('md5').update(text, 'utf8').digest('hex');
  } catch {
    return '';
  }
}

// 收集要同步的
const targets = [];
// vendor/ 放的是运行期要 exec 的外部程序（video-watch 的 vw.py + 替身 magick.bat），
// 跟 src 一样属于「没有就跑不起来」的那一类，必须一起同步。
for (const sub of ['src', 'public', 'electron', 'persona', 'assets', 'scripts', 'vendor']) {
  const abs = join(ROOT, sub);
  if (!existsSync(abs)) continue;
  for (const f of walk(abs)) {
    if (sub === 'scripts' && !f.includes(join('scripts', 'voice'))) continue;
    targets.push(relative(ROOT, f).replace(/\\/g, '/'));
  }
}
if (existsSync(join(ROOT, 'package.json'))) targets.push('package.json');

const report = { same: 0, written: 0, diff: 0 };

/**
 * 把一个文件从源目录同步到目标目录。
 *
 * @param {string} destRoot 目标根
 * @param {string} rel      相对源根的路径（如 'public/index.html'）
 * @param {{stripPrefix?: string}} [opts]
 *        stripPrefix：拼目标路径前，先把这个前缀从 rel 头上削掉。
 *        源路径永远用完整的 rel —— 削的只能是目标那边。
 */
function syncTo(destRoot, rel, opts = {}) {
  const srcFile = join(ROOT, rel);
  const destRel = opts.stripPrefix && rel.startsWith(opts.stripPrefix)
    ? rel.slice(opts.stripPrefix.length)
    : rel;
  const dest = join(destRoot, destRel);
  const a = finger(srcFile);
  const b = existsSync(dest) ? finger(dest) : '';
  if (a === b) {
    report.same++;
    return;
  }
  report.diff++;
  if (CHECK) {
    console.log(`  差异: ${destRel}${b ? '' : '（目标没有）'}`);
    return;
  }
  if (DRY) {
    console.log(`  会写: ${destRel}`);
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(srcFile));
  report.written++;
}

console.log('源码目录: ' + ROOT);
console.log('数据目录: ' + DATA);
console.log('');

console.log('[1/2] 同步到 code/ …');
for (const rel of targets) {
  /**
   * 【electron/ 为什么不进 code/ —— 2026-11-02 血的教训】
   *
   * 主进程 `main.cjs` 也被热更覆盖过一份带重复声明的旧稿，结果双击就弹
   * 「SyntaxError: Identifier 'TITLEBAR_SHALLOW_BLUE' has already been declared」——
   * 界面连一帧都出不来，改源码、重打安装包全白费（因为启动时读的是 code/ 那份）。
   *
   * 主进程是「壳」，换个版本本来就该跟着安装包走；让它能被热更改写，
   * 等于把「起不来」这件事装进了更新里。所以这里把 electron/ 明确排除。
   */
  if (!/^(src|persona|scripts|vendor|package\.json)/.test(rel)) continue;
  syncTo(CODE, rel);
}

console.log('[2/2] 同步到 public/ …');
for (const rel of targets) {
  if (!rel.startsWith('public/')) continue;
  /**
   * 注意：这里要传一个对象，不能直接传字符串。
   *
   * 为什么：PUBLIC 已经是 <数据目录>/public，而 rel 是 'public/index.html'，
   * 两边直接拼会变成 <数据目录>/public/public/index.html ——
   * 程序读的却是 <数据目录>/public/index.html（见 server.mjs 的 readPublic）。
   * 多这一层，界面改动就全落到没人看的地方了（踩过，血亏）。
   *
   * 但源文件那边必须保留完整的 'public/index.html' ——
   * 削前缀只能削「目标」，源路径要原样。
   * （刚才两边一起削ï¼源文件变成了根目录的 index.html，直接 ENOENT。ï¼
   */
  syncTo(PUBLIC, rel, { stripPrefix: 'public/' });
}

console.log('');
if (CHECK) {
  console.log(`检查完毕：${report.same} 个一致，${report.diff} 个有差异`);
  if (report.diff) {
    console.log('');
    console.log('跑一遍 `node scripts/sync-live.mjs` 就能补齐。');
    process.exitCode = 1;
  }
} else if (DRY) {
  console.log(`预览：${report.same} 个不用动，${report.diff} 个会写`);
} else {
  console.log(`同步完成：${report.written} 个写入，${report.same} 个本来就一致`);
}

console.log('');
console.log('提醒：同步只是让「已经装好的程序」立刻用上新代码；');
console.log('      要发版还是要重新打 asar（npm run pack:exe）。');
