// 插件仓库 + 外观设置（主题 / 壁纸 / 功能插件，2026-11-11）。
//
// 【形态】
//   每个插件 = <数据目录>/plugins/<id>/ 目录，里面必须有 plugin.json：
//     {
//       "id": "night-ink",            // 目录名一致
//       "type": "theme",              // theme | wallpaper | feature
//       "name": "夜青",
//       "version": "1.0.0",
//       "description": "一句话说明",
//       "entry": "main.js",           // 可选，前端模块脚本
//       "css": "style.css"            // 可选，前端样式
//     }
//   启用状态存 <数据目录>/.state/plugins.json；外观（用哪个主题/壁纸、导航栏收没收起）
//   存 <数据目录>/.state/appearance.json。
//
// 【为什么插件放数据目录而不是打包进 asar】
// asar 只读、升级会被覆盖；插件是主人自己的东西，要能装、能删、能改。
//
// 【内置主题不走这套】内置主题直接在前端用 CSS 变量定义（见 public/ui/appearance.js），
// 免得「出厂状态还要先拷文件」；磁盘插件只放增量。

import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, statSync, rmSync, cpSync } from 'node:fs';
import { join, resolve, extname, basename, normalize } from 'node:path';
import { config } from './config.mjs';

const PLUGINS_DIR = join(config.dataDir, 'plugins');
const STATE_FILE = join(config.dataDir, '.state', 'plugins.json');
const APPEARANCE_FILE = join(config.dataDir, '.state', 'appearance.json');

/* ---------------- 状态读写 ---------------- */

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  try { mkdirSync(resolve(file, '..'), { recursive: true }); } catch {}
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function enabledMap() {
  const s = readJson(STATE_FILE, {});
  return (s && typeof s.enabled === 'object' && s.enabled) || {};
}
function setEnabled(id, on) {
  const s = readJson(STATE_FILE, {});
  const m = (s.enabled = s.enabled || {});
  if (on) m[id] = true; else delete m[id];
  writeJson(STATE_FILE, s);
}

/* ---------------- 插件清单 ---------------- */

/** 读一个插件目录的 plugin.json；不合法就返回 null（宁可少列一个，不给前端塞脏数据） */
function readPluginMeta(dir, id) {
  const file = join(dir, 'plugin.json');
  if (!existsSync(file)) return null;
  let m = null;
  try { m = JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
  if (!m || typeof m !== 'object') return null;
  if (!['theme', 'wallpaper', 'feature'].includes(m.type)) return null;
  const name = String(m.name || '').trim() || id;
  return {
    id: String(m.id || id),
    type: m.type,
    name,
    version: String(m.version || '1.0.0'),
    description: String(m.description || ''),
    entry: m.entry ? String(m.entry) : '',
    css: m.css ? String(m.css) : '',
    /* 主题插件可以自带一组预览色（{bg,panel,border,text,accent}），面板上的色带就用它；
     * 不写的话前端自己去扫它的 CSS —— 前端一次都扫不出来才显示斜纹占位。 */
    preview: m.preview && typeof m.preview === 'object' ? m.preview : null,
    // wallpaper 专用：{ kind:'image'|'video', file:'bg.jpg' }（相对插件目录）
    wallpaper: m.type === 'wallpaper' && m.wallpaper && m.wallpaper.file
      ? { kind: m.wallpaper.kind === 'video' ? 'video' : 'image', file: String(m.wallpaper.file) }
      : null,
    builtin: false,
    dir,
  };
}

/** 磁盘上所有的插件（目录名 = id，读取失败/不合法的跳过） */
export function listPlugins() {
  const out = [];
  let names = [];
  try { names = readdirSync(PLUGINS_DIR); } catch { return out; }
  for (const name of names) {
    const dir = join(PLUGINS_DIR, name);
    try { if (!statSync(dir).isDirectory()) continue; } catch { continue; }
    const meta = readPluginMeta(dir, name);
    if (meta) out.push(meta);
  }
  return out;
}

/** 给界面的清单：带上启用状态，剥掉本地路径 */
export function pluginsView() {
  const enabled = enabledMap();
  return listPlugins().map(({ dir, ...rest }) => ({ ...rest, enabled: Boolean(enabled[rest.id]) }));
}

/** 前端加载插件文件用：校验路径别跑出插件目录 */
export function pluginFile(id, rel) {
  const clean = normalize(String(rel || '')).replace(/^(\.\.[/\\])+/, '');
  const abs = resolve(PLUGINS_DIR, id, clean);
  const root = resolve(PLUGINS_DIR, id);
  if (!abs.startsWith(root)) return null;
  if (!existsSync(abs) || !statSync(abs).isFile()) return null;
  return abs;
}

/* ---------------- 增删与开关 ---------------- */

export function removePlugin(id) {
  const dir = resolve(PLUGINS_DIR, id);
  if (!dir.startsWith(resolve(PLUGINS_DIR)) || !existsSync(dir)) {
    return { ok: false, error: '没这个插件' };
  }
  rmSync(dir, { recursive: true, force: true });
  setEnabled(id, false);
  return { ok: true };
}

export function togglePlugin(id, on) {
  const all = listPlugins();
  if (!all.some((p) => p.id === id)) return { ok: false, error: '没这个插件' };
  setEnabled(id, Boolean(on));
  return { ok: true };
}

/* ---------------- 导入插件包 ---------------- */

/**
 * 插件包 = 一个 .zip，里面是「一个文件夹一个插件」。
 *
 * 【为什么是 zip 而不是让界面选文件夹】
 * 浏览器给不了「选一个目录、连同里面的图片样式一起拷过来」的能力
 * （webkitdirectory 只能读到文件内容，拿不到相对路径的目录树，还得自己重建）。
 * 所以打包成一个 zip：主人双击解压能看到里面是什么，发给别人也只是发一个文件。
 * 包里可以带 plugin.json + css + 图片，插件目录本来就是这么长的。
 *
 * 【解压用什么】
 * 不引 npm 依赖（zip 流解析要几千行，为一个导入功能不值），直接用系统自带的：
 *   macOS / Linux：unzip（没有就退回 bsdtar，两者都认 zip）
 *   Windows：tar.exe（Win10 1803 起自带，bsdtar，认 zip）
 * 两条路都是「解到临时目录」，解完再校验、再搬 —— 解失败（坏包/非 zip）一律
 * 报「解不开」而不是把半个目录塞进插件列表。
 */

const PLUGIN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

async function unzipTo(file, dest) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile);
  const opt = { timeout: 30000, maxBuffer: 8 * 1024 * 1024 };
  if (process.platform === 'win32') {
    await run('tar', ['-xf', file, '-C', dest], opt);
    return;
  }
  try {
    await run('unzip', ['-q', '-o', file, '-d', dest], opt);
  } catch {
    await run('tar', ['-xf', file, '-C', dest], opt);
  }
}

/** 在解压结果里找 plugin.json：包里可能直接摊在根上，也可能是「插件名/plugin.json」 */
function findManifestDir(root) {
  if (existsSync(join(root, 'plugin.json'))) return root;
  let names = [];
  try { names = readdirSync(root); } catch { return null; }
  const subs = names.filter((n) => n !== '__MACOSX' && !n.startsWith('.'));
  // 只认带 manifest 的那些；有多个就当第一个（主人一次只该装一个插件）
  for (const n of subs) {
    const d = join(root, n);
    try {
      if (!statSync(d).isDirectory()) continue;
      if (existsSync(join(d, 'plugin.json'))) return d;
    } catch {}
  }
  return null;
}

/**
 * 导入一批插件包。files = [{ name, b64 }]。
 *
 * 回来的每一格都带话：进来了叫什么、覆盖了谁、哪个包没解开为什么 ——
 * 界面照实摆，不合并成一句「导入完成」。
 */
export async function importPlugins(files) {
  const out = { ok: true, added: [], updated: [], failed: [] };
  const list = Array.isArray(files) ? files : [];
  if (!list.length) return { ok: false, error: '没有要导入的包' };

  const tmpRoot = join(config.dataDir, '.state', 'tmp-plugin');
  mkdirSync(tmpRoot, { recursive: true });
  mkdirSync(PLUGINS_DIR, { recursive: true });

  for (const f of list) {
    const label = String((f && f.name) || '插件包');
    const stage = join(tmpRoot, 'pack-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    let buf = null;
    try { buf = Buffer.from(String((f && f.b64) || ''), 'base64'); } catch { buf = null; }
    if (!buf || !buf.length) {
      out.failed.push({ name: label, reason: '这个文件是空的' });
      continue;
    }
    mkdirSync(stage, { recursive: true });
    const zipFile = stage + '.zip';
    try {
      writeFileSync(zipFile, buf);
      await unzipTo(zipFile, stage);
    } catch {
      rmSync(zipFile, { force: true });
      rmSync(stage, { recursive: true, force: true });
      out.failed.push({ name: label, reason: '解不开这个包（要 .zip；.rar / .7z 得先转成 zip）' });
      continue;
    }

    const mdir = findManifestDir(stage);
    if (!mdir) {
      rmSync(zipFile, { force: true });
      rmSync(stage, { recursive: true, force: true });
      out.failed.push({ name: label, reason: '包里没有 plugin.json —— 说明它不是插件包' });
      continue;
    }

    let meta = null;
    try { meta = JSON.parse(readFileSync(join(mdir, 'plugin.json'), 'utf8')); } catch { meta = null; }
    if (!meta || typeof meta !== 'object' || !['theme', 'wallpaper', 'feature'].includes(meta.type)) {
      rmSync(zipFile, { force: true });
      rmSync(stage, { recursive: true, force: true });
      out.failed.push({ name: label, reason: 'plugin.json 里 type 只能是 theme / wallpaper / feature' });
      continue;
    }

    // id：manifest 里的优先，没写就用包里的文件夹名（根上摊开时用包名去掉 .zip）
    const rawId = String(meta.id || (mdir === stage ? label.replace(/\.zip$/i, '') : basename(mdir)) || '').trim();
    const id = rawId.replace(/\s+/g, '-');
    if (!PLUGIN_ID_RE.test(id)) {
      rmSync(zipFile, { force: true });
      rmSync(stage, { recursive: true, force: true });
      out.failed.push({ name: label, reason: '插件 id 只能用字母数字和 . _ -（现在算出来是「' + rawId + '」）' });
      continue;
    }

    const target = resolve(PLUGINS_DIR, id);
    const existed = existsSync(target);
    try {
      if (existed) rmSync(target, { recursive: true, force: true });
      // macOS 打包会塞 __MACOSX / ._xxx 这类垃圾，别跟着搬进插件目录
      cpSync(mdir, target, {
        recursive: true,
        filter: (src) => !/(^|[/\\])__MACOSX([/\\]|$)/.test(src) && !basename(src).startsWith('._'),
      });
    } catch (err) {
      out.failed.push({ name: label, reason: '写不进插件目录：' + String(err?.message ?? err) });
      continue;
    } finally {
      rmSync(zipFile, { force: true });
      rmSync(stage, { recursive: true, force: true });
    }

    // 装进来就是拿来用的：默认直接启用。想关去列表上关一格。
    setEnabled(id, true);
    const row = {
      id,
      name: String(meta.name || id),
      type: meta.type,
      version: String(meta.version || '1.0.0'),
    };
    if (existed) out.updated.push(row); else out.added.push(row);
  }

  if (!out.added.length && !out.updated.length && out.failed.length) {
    return { ...out, ok: false, error: out.failed[0].reason };
  }
  return out;
}

/**
 * 直接从粘贴的代码建一个插件（2026-11-12）。
 *
 * 【为什么要这条】主人：「插件是 js 插件，导入应该做个 dialog，也能粘贴代码」。
 * 之前只有「选 zip / json 文件」一条路 —— 想改个颜色、调一句逻辑，得先在别处
 * 建好文件夹、写 plugin.json、再压成 zip 才能导进来，完全不是写代码的人的习惯。
 *
 * 【收两种，不做第三种】
 *   feature  一段 ES 模块，入口是 index.js，默认导出 function({root, api, toast}){}
 *   theme    一段 CSS，变量就是主题那十来个（--bg / --panel / --accent ...）
 * 壁纸这里不做：它必须有一张真的图，粘贴区放不下（要做也该走「选图片」那条）。
 *
 * 目录名 = id，跟 zip 导入完全同一套存储；重名就是覆盖（返回 updated）。
 */
export function createPluginFromCode(input) {
  const src = input && typeof input === 'object' ? input : {};
  const type = src.type === 'theme' ? 'theme' : 'feature';
  const rawId = String(src.id || '').trim();
  const id = rawId.replace(/\s+/g, '-');
  if (!PLUGIN_ID_RE.test(id)) {
    return { ok: false, error: '插件 id 只能用字母、数字和 . _ -（不要中文和空格），最长 64' };
  }
  const code = String(src.code || '');
  if (!code.trim()) return { ok: false, error: type === 'feature' ? '代码是空的' : '样式是空的' };

  const name = String(src.name || '').trim() || id;
  const description = String(src.description || '').trim();
  const fileName = type === 'feature' ? 'index.js' : 'theme.css';
  const dir = resolve(PLUGINS_DIR, id);
  const existed = existsSync(join(dir, 'plugin.json'));

  try {
    mkdirSync(dir, { recursive: true });
    // 只覆盖自己那两个文件，别的（图标、说明、图片）留着 —— 主人可能手工补过
    writeFileSync(join(dir, fileName), code, 'utf8');
    const meta = { id, type, name, version: '1.0.0', description };
    if (type === 'feature') meta.entry = fileName; else meta.css = fileName;
    writeJson(join(dir, 'plugin.json'), meta);
  } catch (err) {
    return { ok: false, error: '写不进插件目录：' + String(err?.message ?? err) };
  }

  setEnabled(id, true);
  const row = { id, name, type, version: '1.0.0' };
  return {
    ok: true,
    added: existed ? [] : [row],
    updated: existed ? [row] : [],
    plugins: pluginsView(),
    appearance: getAppearance(),
    file: fileName,
  };
}

/** 打开插件目录（Finder / 资源管理器），主人手工放文件用。
 * 服务端是普通 node 进程，没有 electron 的 shell —— 直接调系统命令，三个平台各有各的。 */
export async function openPluginsDir() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  mkdirSync(PLUGINS_DIR, { recursive: true });
  const bin = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try { await promisify(execFile)(bin, [PLUGINS_DIR], { timeout: 5000 }); return true; }
  catch { return false; }
}

/* ---------------- 外观设置 ---------------- */

export function getAppearance() {
  const a = readJson(APPEARANCE_FILE, {});
  return {
    // 'graphite' 是内置第一套主题（见 public/ui/appearance.js 的 THEMES）
    themeId: String(a.themeId || 'graphite'),
    wallpaperId: String(a.wallpaperId || ''),
    railCollapsed: a.railCollapsed === true,  // 默认展开（false）
    railOn: a.railOn !== false,               // 默认显示左侧栏
  };
}

export function setAppearance(patch) {
  const cur = readJson(APPEARANCE_FILE, {});
  const next = { ...cur, ...(patch && typeof patch === 'object' ? patch : {}) };
  writeJson(APPEARANCE_FILE, next);
  return getAppearance();
}
