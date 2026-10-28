/**
 * 启动自检。
 *
 * 分工：
 *   【程序自己动手的】桌面快捷方式、版本自动更新。
 *     这两件要真建 .lnk、真重启进程，模型干不了，所以留在程序里。
 *
 *   【环境检查交给 AI】缺不缺文件、依赖装没装、key 配没配、端口占没占……
 *     以前这些是代码里写死的一堆检查项：查什么、算不算合格都是硬编码的，
 *     机器不会变通——主人故意删掉的目录，它照样每次启动喊「缺文件」。
 *     现在改成：程序只把实时现状 + 一组只读探针交给模型（见 selfcheck-ai.mjs），
 *     由 AI 自己查、自己判断、自己给建议。
 *
 * 自检阶段一律只读：探针不写、不删、不发布、不装东西。
 * 没配模型 / 没网就跳过，绝不挡启动。
 *
 * 结论落 .state/selfcheck.json；没搞定的进 .state/selfcheck-pending.json，
 * 下次主人来了，persona 会把这段注入系统提示，让 AI 主动提一句。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { homedir, platform } from 'node:os';

import { config } from './config.mjs';
import { versionCheckItem } from './updater.mjs';
import { runAiSelfCheck } from './selfcheck-ai.mjs';

const ROOT = config.root;
// 结论要落盘，所以走可写的数据根（打包后 app.asar 写不了）
const STATE = join(config.dataDir, '.state');
const RESULT_FILE = join(STATE, 'selfcheck.json');
const PENDING_FILE = join(STATE, 'selfcheck-pending.json');

/** 这套自检逻辑的版本。变了 → 下次启动重跑一遍。 */
const SELFCHECK_VERSION = 5; // v5: 加 checkBootEnv（双击闪退那个 ELECTRON_RUN_AS_NODE）

const IS_WIN = platform() === 'win32';

/** 记一条结果 */
function item(id, name, level, detail, extra = {}) {
  return { id, name, level, detail, ...extra };
}
const ok = (id, name, detail) => item(id, name, 'ok', detail);
const warn = (id, name, detail, extra) => item(id, name, 'warn', detail, extra);
const fail = (id, name, detail, extra) => item(id, name, 'fail', detail, extra);

/** 与 selfcheck-ai.mjs 里同一套脱敏规则（落盘前最后一道） */
export function maskSensitive(text) {
  let t = String(text ?? '');
  t = t.replace(/([A-Za-z]:[\\/][Uu]sers[\\/])([^\\/\s"'`<>|]+)/g, '$1***');
  // 其他盘符的长绝对路径：保留盘符和最后一层，中间打码
  t = t.replace(/([A-Za-z]:\\)((?:[^\\\s"'`<>|]+\\){2,})([^\\\s"'`<>|]+)/g, (m, drive, mid, last) => drive + '***\\' + last);
  try {
    const home = homedir();
    if (home && home.length > 3) {
      const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(esc, 'gi'), '<用户目录>');
    }
  } catch {}
  t = t.replace(/([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PWD)[A-Za-z0-9_-]*\s*[=:]\s*)(\S{6,})/gi,
    (m, head, val) => head + val.slice(0, 2) + '***' + val.slice(-2));
  t = t.replace(/[A-Za-z0-9._%+-]+@(?!example\.|local\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***');
  return t;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- 快捷方式

const SHORTCUT_NAME = '小鱼Agent.lnk';

/**
 * 这个目录配不配管桌面快捷方式？
 *
 * 桌面上只该有一个「小鱼」快捷方式。要是解压出来的副本、临时测试目录也跑自检，
 * 就会把主人原来那个抢过去（真的踩过一次）。所以只有两种情况才管：
 *   1) 桌面上还没有这个快捷方式 —— 那就是第一次用，建一个应该的；
 *   2) 已有的快捷方式本来就指向这个目录 —— 那是自己的，坏了可以修。
 * 指向别处的一律不碰，只在结果里说明一句。
 */
function shortcutOwnership(desktops) {
  const bat = join(ROOT, 'start.bat').toLowerCase();
  const mine = [];
  const others = [];
  for (const dir of desktops) {
    const lnk = join(dir, SHORTCUT_NAME);
    if (!existsSync(lnk)) continue;
    const info = lnkTarget(lnk);
    const target = String(info?.target ?? '').toLowerCase();
    if (target && target === bat) mine.push({ dir, lnk, info });
    else others.push({ dir, lnk, info });
  }
  if (mine.length) return { owns: true, mine, others, reason: 'already-mine' };
  if (!others.length) return { owns: true, mine, others, reason: 'none-yet' };
  return { owns: false, mine, others, reason: 'taken-by-other' };
}

let desktopCache = null;

/** 桌面可能在 OneDrive 里，几个地方都找一遍（结果缓存，一次启动只查一次） */
function desktopDirs() {
  if (desktopCache) return desktopCache;
  const home = process.env.USERPROFILE || process.env.HOME || homedir();
  const list = [];
  const push = (p) => {
    if (p && !list.includes(p)) list.push(p);
  };
  if (IS_WIN) {
    push(join(home, 'Desktop'));
    push(join(home, '桌面'));
    push(join(home, 'OneDrive', 'Desktop'));
    push(join(home, 'OneDrive', '桌面'));
    // 注册表里那个才是权威（可能被重定向到别处）
    try {
      const out = execFileSync(
        'powershell.exe',
        ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
        { timeout: 15000, encoding: 'utf8' },
      ).trim();
      if (out) list.unshift(out);
    } catch {}
  } else {
    push(join(home, 'Desktop'));
  }
  const seen = new Set();
  desktopCache = list.filter((p) => {
    if (!existsSync(p)) return false;
    let key = p;
    try {
      key = realpathSync(p);
    } catch {}
    key = key.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return desktopCache;
}

/** 读出 .lnk 的目标路径；读不出来返回 null */
function lnkTarget(lnkPath) {
  if (!IS_WIN) return null;
  try {
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnkPath.replace(/'/g, "''")}');` +
      `Write-Output $s.TargetPath; Write-Output '---'; Write-Output $s.WorkingDirectory; Write-Output '---'; Write-Output $s.IconLocation`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 20000, encoding: 'utf8' });
    const [target = '', workdir = '', icon = ''] = String(out).split('---').map((s) => s.trim());
    return { target, workdir, icon };
  } catch {
    return null;
  }
}

/** 生成 / 覆盖快捷方式 */
function makeShortcut(lnkPath) {
  if (!IS_WIN) return false;
  const bat = join(ROOT, 'start.bat');
  const icon = join(ROOT, 'assets', 'xiaoyu.ico');
  const esc = (s) => String(s).replace(/'/g, "''");
  const ps = [
    `$ws = New-Object -ComObject WScript.Shell`,
    `$s = $ws.CreateShortcut('${esc(lnkPath)}')`,
    `$s.TargetPath = '${esc(bat)}'`,
    `$s.WorkingDirectory = '${esc(ROOT)}'`,
    `$s.Description = '启动小鱼Agent桌面版'`,
    `$s.WindowStyle = 7`,
    existsSync(icon) ? `$s.IconLocation = '${esc(icon)},0'` : '',
    `$s.Save()`,
  ]
    .filter(Boolean)
    .join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { timeout: 25000, encoding: 'utf8' });
    return existsSync(lnkPath);
  } catch {
    return false;
  }
}

/**
 * 每次启动都查：桌面上有没有「指向当前这个目录」的快捷方式。
 * 没有 / 指错了（目录搬过家、以前建过后来失效）→ 重建。
 */
export function checkShortcut() {
  if (!IS_WIN) return [ok('shortcut', '桌面快捷方式', '非 Windows，跳过')];

  const desktops = desktopDirs();
  if (!desktops.length) {
    return [fail('shortcut', '桌面快捷方式', '找不到桌面目录，没法放快捷方式', { pending: true })];
  }

  const bat = join(ROOT, 'start.bat');
  if (!existsSync(bat)) {
    return [fail('shortcut', '桌面快捷方式', `启动器 ${bat} 不在，快捷方式建了也点不开`, { pending: true })];
  }

  const own = shortcutOwnership(desktops);
  if (!own.owns) {
    // 桌面上那个快捷方式指的不是这个目录 —— 是别的副本，别抢
    const t = own.others.map((o) => o.info?.target || '(读不出目标)').join('、');
    return [ok('shortcut', '桌面快捷方式', `桌面上那个指向 ${t}，不是这份安装目录，这次不动它`)];
  }

  const found = own.mine;

  // 没有：建一个
  if (!found.length) {
    const target = join(desktops[0], SHORTCUT_NAME);
    if (makeShortcut(target)) {
      return [warn('shortcut', '桌面快捷方式', `桌面上没有，已在 ${dirname(target)} 创建一个`, { fixed: true })];
    }
    return [fail('shortcut', '桌面快捷方式', '桌面上没有，也建不出来（PowerShell 可能被拦）', { pending: true })];
  }

  // 有：逐个验证目标对不对
  const broken = [];
  for (const f of found) {
    const t = f.info?.target ?? '';
    const w = f.info?.workdir ?? '';
    const targetOk = t && t.toLowerCase() === bat.toLowerCase() && existsSync(t);
    const workOk = w && w.toLowerCase() === ROOT.toLowerCase();
    if (!targetOk || !workOk) broken.push({ ...f, reason: !t ? '.lnk 读不出目标' : !existsSync(t) ? `目标不存在：${t}` : '目标指向别处' });
  }

  if (!broken.length) return [ok('shortcut', '桌面快捷方式', `指向 ${bat}，好的`)];

  // 修：全部重建
  const results = broken.map((b) => ({ lnk: b.lnk, ok: makeShortcut(b.lnk), reason: b.reason }));
  const fixedAll = results.every((r) => r.ok);
  const detail = '发现失效快捷方式（' + broken.map((b) => b.reason).join('；') + '）→ ' + (fixedAll ? '已重建' : '重建失败');
  return [fixedAll ? warn('shortcut', '桌面快捷方式', detail, { fixed: true }) : fail('shortcut', '桌面快捷方式', detail, { pending: true })];
}

// ---------------------------------------------------------------- 启动环境

/**
 * 查「双击 exe 一闪就没」的元凶：ELECTRON_RUN_AS_NODE。
 *
 * 2026-10-28 踩到的：这个变量一旦非空，Electron 就退化成一个纯 node ——
 * 不去加载 app.asar、不建窗口、也不执行 main.cjs 里的任何一行自救代码，
 * 表现就是双击闪退、退出码 0、没有任何日志，查起来完全无从下手。
 *
 * 注意：**这里读到的是「当前进程」的环境**。如果程序本身已经因此起不来，
 * 这段代码也就跑不到 —— 所以它只能抓住「变量在注册表里、这次靠别的方式起来了」这种情况。
 * 真正兜底还是在启动器侧（开发版 start.bat 已清；打包版靠这条提示 + 一键清除）。
 *
 * 修法：删掉用户级 / 系统级注册表里的这个变量，下次启动就干净了。
 */
export function checkBootEnv() {
  if (!IS_WIN) return [ok('bootenv', '启动环境', '非 Windows，跳过')];

  const cur = String(process.env.ELECTRON_RUN_AS_NODE || '').trim();
  const reg = readRegEnv();
  const regHas = Object.entries(reg).filter(([, v]) => String(v || '').trim());

  if (!cur && !regHas.length) {
    return [ok('bootenv', '启动环境', '没有 ELECTRON_RUN_AS_NODE，双击能正常开窗口')];
  }

  const where = regHas.map(([k]) => (k === 'User' ? '当前用户环境' : '系统环境')).join('、');
  const detail = cur
    ? `ELECTRON_RUN_AS_NODE=${cur}` + (regHas.length ? `（来自${where}）` : '（只在当前进程里有）')
    : `注册表${where}里有 ELECTRON_RUN_AS_NODE，双击 exe 会闪退`;

  // 注册表里有 → 尝试清掉，清掉就是真修好了
  if (regHas.length) {
    const cleaned = regHas.map(([k]) => clearRegEnv(k));
    const allDone = cleaned.every(Boolean);
    return [allDone
      ? warn('bootenv', '启动环境', detail + ' → 已从注册表删除，重启后生效', { fixed: true, needsRestart: true })
      : fail('bootenv', '启动环境', detail + ' → 自动清除失败，请手动删（系统属性 → 环境变量）', { pending: true })];
  }

  // 只在当前进程里 → 告诉主人不用管，是启动它的那个程序带进来的
  return [warn('bootenv', '启动环境', detail + ' → 是启动它的程序带进来的，不影响双击', { pending: false })];
}

/** 读注册表里的用户级 / 系统级环境变量 */
function readRegEnv() {
  const out = {};
  for (const [key, scope] of [['HKCU\\Environment', 'User'], ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Machine']]) {
    try {
      const r = execFileSync('reg', ['query', key, '/v', 'ELECTRON_RUN_AS_NODE'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const m = r.match(/ELECTRON_RUN_AS_NODE\s+REG_[A-Z_]+\s+(.*)/i);
      if (m) out[scope] = m[1].trim();
    } catch {}
  }
  return out;
}

/** 从注册表删掉这个变量；返回是否删干净了 */
function clearRegEnv(scope) {
  const key = scope === 'User' ? 'HKCU\\Environment' : 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
  try {
    execFileSync('reg', ['delete', key, '/v', 'ELECTRON_RUN_AS_NODE', '/f'], { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
    // 通知系统环境已变，免得新进程还读旧的
    try {
      execFileSync('powershell', ['-NoProfile', '-Command',
        "[Environment]::SetEnvironmentVariable('ELECTRON_RUN_AS_NODE',$null,'" + (scope === 'User' ? 'User' : 'Machine') + "')"],
        { encoding: 'utf8', windowsHide: true, stdio: 'ignore' });
    } catch {}
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 跑一遍

/**
 * 程序自己必须动手的那几项（模型干不了），并进 AI 的结论里。
 */
async function runFixedItems() {
  const items = [];
  try {
    items.push(...checkBootEnv());
  } catch (e) {
    items.push(warn('bootenv', '启动环境', '检查时出错：' + String(e?.message ?? e)));
  }
  try {
    items.push(...checkShortcut());
  } catch (e) {
    items.push(warn('shortcut', '桌面快捷方式', '检查时出错：' + String(e?.message ?? e)));
  }
  try {
    items.push(await versionCheckItem());
  } catch (e) {
    items.push(warn('version', '版本更新', '检查时出错（多半没网）：' + String(e?.message ?? e)));
  }
  return items;
}

/**
 * 跑一次自检。
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 */
export async function runSelfCheck(opts = {}) {
  const started = Date.now();

  // 先跑程序固定项（快、纯本地/轻网络）
  const fixed = await runFixedItems();

  // 环境检查交给 AI：它自己调探针、自己判断
  const ai = await runAiSelfCheck(opts);
  const aiItems = ai.items ?? [];

  const items = [...aiItems, ...fixed.filter((i) => i.level !== 'ok')];

  const pending = items
    .filter((i) => i.level === 'fail' || i.level === 'warn')
    .map((i) => ({ id: i.id, name: i.name, detail: i.detail, fix: i.fix ?? '' }));

  const summary = {
    total: items.length,
    okCount: items.filter((i) => i.level === 'ok').length,
    warnCount: items.filter((i) => i.level === 'warn').length,
    failCount: items.filter((i) => i.level === 'fail').length,
    fixedCount: fixed.filter((i) => i.fixed).length,
  };

  const result = {
    mode: 'ai',
    at: started,
    version: SELFCHECK_VERSION,
    tookMs: Date.now() - started,
    engine: 'ai',
    summaryText: maskSensitive(ai.summary ?? ''),
    aiError: ai.error ?? null,
    skipped: ai.skipped ?? null,
    transcript: (ai.transcript ?? []).map((t) => ({
      probe: t.probe,
      args: maskSensitive(t.args),
      out: maskSensitive(t.out),
    })),
    items,
    pending,
    summary,
    needsRestart: fixed.some((i) => i.needsRestart),
  };

  try {
    if (!existsSync(STATE)) mkdirSync(STATE, { recursive: true });
    writeFileSync(RESULT_FILE, JSON.stringify(result, null, 2), 'utf8');
    writeFileSync(PENDING_FILE, JSON.stringify(pending, null, 2), 'utf8');
  } catch {}

  return result;
}

/** 上次自检结果 */
export function lastSelfCheck() {
  const r = readJson(RESULT_FILE, null);
  return r && typeof r === 'object' ? r : null;
}

/** 这次启动要不要跑：没跑过 / 版本变了 / 上次没 key 跳过了 → 跑 */
export function decideMode() {
  const last = lastSelfCheck();
  if (!last) return 'run';
  if (last.version !== SELFCHECK_VERSION) return 'run';
  if (last.skipped) return 'run';
  return 'skip';
}

/** 还没解决的问题（给 AI 看的） */
export function pendingIssues() {
  const list = readJson(PENDING_FILE, []);
  return Array.isArray(list) ? list : [];
}

/** 给系统提示用的那段文字 */
export function pendingPromptBlock() {
  const list = pendingIssues();
  if (!list.length) return '';
  const lines = [
    '【上次自检查出来的问题 · 需要你顺手处理】',
    '下面几条是你自己（启动时那次 AI 自检）查出来的。等主人来了主动提一句，能修就顺手修掉（你有工具，能自己动手）：',
  ];
  for (const p of list) {
    lines.push(`- ${p.name}：${p.detail}${p.fix ? `（建议：${p.fix}）` : ''}`);
  }
  lines.push('- 修好了就把 .state/selfcheck-pending.json 清空，再跟主人说一声。');
  return lines.join('\n');
}
