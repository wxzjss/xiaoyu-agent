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
for (const sub of ['src', 'public', 'electron', 'persona', 'assets', 'scripts']) {
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
  if (!/^(src|electron|persona|scripts|package\.json)/.test(rel)) continue;
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
