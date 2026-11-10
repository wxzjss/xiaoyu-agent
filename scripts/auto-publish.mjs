#!/usr/bin/env node
/**
 * 自动发布：源码一改就发。
 *
 * 用法（两种）：
 *   1) 手动跑一次：  npm run autopublish
 *   2) 挂成常驻监听： npm run autopublish -- --watch
 *      改完文件等 8 秒自动打包推送，一次都不用手动发。
 *
 * 只在 Windows 上装开机自启（可选）：npm run autopublish -- --install
 *
 * 安全：改动的全是白名单里的源码才算数；.env / .state 一概不理。
 */
import { readdirSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const WATCH_DIRS = ['src', 'public', 'electron', 'persona', 'rules', 'assets'];
const WATCH_FILES = ['package.json', 'README.md', '.env.example', 'start.bat', 'make-shortcut.ps1'];
const IGNORE = new Set(['node_modules', '.git', '.state', 'dist', 'sandbox']);

const argv = process.argv.slice(2);
const WATCH = argv.includes('--watch');
const INSTALL = argv.includes('--install');
const DEBOUNCE_MS = 8000;

/** 白名单里所有文件的「路径:大小:修改时间」，用来判断有没有改 */
function snapshot() {
  const map = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        walk(p);
        continue;
      }
      try {
        const st = statSync(p);
        map.set(relative(ROOT, p).replace(/\\/g, '/'), `${st.size}:${st.mtimeMs}`);
      } catch {}
    }
  };
  for (const d of WATCH_DIRS) walk(join(ROOT, d));
  for (const f of WATCH_FILES) {
    const p = join(ROOT, f);
    if (!existsSync(p)) continue;
    try {
      const st = statSync(p);
      map.set(f, `${st.size}:${st.mtimeMs}`);
    } catch {}
  }
  return map;
}

/** 两次快照之间变了哪些文件 */
function diff(a, b) {
  const changed = [];
  for (const [k, v] of b) if (a.get(k) !== v) changed.push(k);
  for (const k of a.keys()) if (!b.has(k)) changed.push(k);
  return changed;
}

/** 真发布一次 */
function publish() {
  const started = Date.now();
  try {
    const out = execFileSync(process.execPath, [join(HERE, 'publish.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
    const ms = Date.now() - started;
    const line = out.trim().split('\n').filter(Boolean).pop() || '';
    if (/没有变化/.test(out)) {
      console.log(`[autopublish] 没有实质变化，跳过（${ms}ms）`);
    } else {
      console.log(`[autopublish] ✓ 已发布（${ms}ms） ${line}`);
    }
    return true;
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`;
    console.error('[autopublish] ✗ 发布失败：');
    console.error(out.trim().split('\n').slice(0, 20).join('\n'));
    return false;
  }
}

if (INSTALL) {
  if (process.platform !== 'win32') {
    console.error('--install 只支持 Windows');
    process.exit(1);
  }
  // 往启动文件夹里放一个 vbs，开机静默挂后台监听
  const startup = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  const vbs = join(startup, 'xiaoyu-autopublish.vbs');
  const nodeExe = process.execPath;
  const script = join(HERE, 'auto-publish.mjs');
  const cmd = `CreateObject("WScript.Shell").Run """${nodeExe}"" ""${script}"" --watch", 0, False`;
  mkdirSync(startup, { recursive: true });
  writeFileSync(vbs, cmd + '\r\n', 'utf8');
  console.log(`已装开机自启：${vbs}`);
  console.log('下次开机自动在后台监听改动，改完自动发布。想关掉就把这个 vbs 删了。');
  process.exit(0);
}

if (!WATCH) {
  const ok = publish();
  process.exit(ok ? 0 : 1);
}

// ---- watch 模式 ----
console.log(`[autopublish] 监听中：${WATCH_DIRS.join(', ')}（改完 ${DEBOUNCE_MS / 1000} 秒自动发布，Ctrl+C 退出）`);
let last = snapshot();
let timer = null;
let pendingChanges = new Set();

setInterval(() => {
  const now = snapshot();
  const changed = diff(last, now);
  if (changed.length) {
    for (const c of changed) pendingChanges.add(c);
    last = now;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...pendingChanges];
      pendingChanges = new Set();
      timer = null;
      console.log(`[autopublish] 检测到 ${files.length} 个文件改动：${files.slice(0, 6).join(', ')}${files.length > 6 ? ' …' : ''}`);
      publish();
      last = snapshot(); // 发布本身也会写文件，吃掉这些变化
    }, DEBOUNCE_MS);
  }
}, 2500);
