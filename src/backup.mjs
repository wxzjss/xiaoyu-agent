// 整份数据的备份与恢复：会话、人设、模型配置、设置、功能开关、皮肤……全都要。
//
// 为什么单独做，而不是让用户自己拷 %APPDATA%：
//   · 很多人根本不知道数据在哪；
//   · 免安装版的数据在 exe 旁边、安装版在 %APPDATA%，路径还不一样；
//   · 换电脑 / 重装 / 换安装方式时，一不小心就把几十个会话弄没了。
//
// 文件格式（备份包）：
//   {
//     "format": "xiaoyu-agent-backup",
//     "version": 1,
//     "appVersion": "0.8.0",
//     "at": "2026-10-23T18:00:00.000Z",
//     "files": { "<相对 .state 的路径>": "<文本内容>" }
//   }
// 一律按文本存：.state 里全是 json / md，没有二进制，这样包小、可读、好排查。
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { config, appVersion } from './config.mjs';

export const BACKUP_FORMAT = 'xiaoyu-agent-backup';
export const BACKUP_VERSION = 1;

/** `.state` 的绝对路径。 */
function stateDir() {
  return join(config.dataDir, '.state');
}

// 备份哪些东西：全是「用户的」，程序本身不要。
// 按前缀 / 后缀筛，新增文件时记得回来加一行。
const KEEP_DIRS = [
  'sessions',   // 会话记录
  'memory',     // 每个会话的记忆本子
  'personas',   // 人设文件
  'prelude',    // 前情对话
  'plan',       // 任务计划
];

const KEEP_FILES = [
  'settings.json',            // 底线 / 安全词 / 压缩阈值
  'defaults.json',            // 主人定的「默认值」
  'models.json',              // 模型配置（含 API Key）
  'model.json',               // 老版本的单模型配置，别丢
  'persona.md',               // 当前用的人设正文
  'personas.json',            // 人设列表
  'features.json',            // 功能开关
  'skin.json',                // 皮肤
  'thinking.json',            // 思考强度
  'chatstyle.json',           // 聊天样式
  'openings.json',            // 哪些会话垫过开场白
  'session-overrides.json',   // 单会话覆盖
  'mobile.json',              // 手机连接（配对码等）
  'selfcheck.json',           // 自检开关
];

// 明确不要的：缓存、日志、截图、临时文件、备份自己的备份。
const SKIP_EXT = /\.(log|png|jpg|jpeg|gif|webp|mp4|mp3|bak|lock|tmp)$/i;
const SKIP_NAME = /^(\.trash|_edgeprof|mojibake-backup|backup-sessions-|removed-rules)/;

function shouldSkip(relPath) {
  if (SKIP_NAME.test(relPath)) return true;
  // 回收站里的东西不算数据，别把垃圾打进备份包
  if (relPath.includes('/.trash/') || relPath.startsWith('.trash/')) return true;
  if (SKIP_EXT.test(relPath)) return true;
  // 自己生成的备份文件别再套娃
  if (/\.bak[-.]/.test(relPath)) return true;
  return false;
}

/** 递归收集 .state 下要备份的文件，返回相对路径数组。 */
function collect() {
  const root = stateDir();
  const out = [];
  if (!existsSync(root)) return out;

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = join(dir, ent.name);
      const rel = relative(root, full).split(sep).join('/');
      if (shouldSkip(rel)) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        out.push(rel);
      }
    }
  };

  for (const d of KEEP_DIRS) {
    const p = join(root, d);
    if (existsSync(p) && statSync(p).isDirectory()) walk(p);
  }
  for (const f of KEEP_FILES) {
    const p = join(root, f);
    if (existsSync(p) && statSync(p).isFile()) out.push(f);
  }
  // 去重 + 排序，包里顺序稳定
  return [...new Set(out)].sort();
}

/** 造一份备份对象（不写盘）。 */
export function buildBackup() {
  const root = stateDir();
  const files = {};
  let bytes = 0;
  for (const rel of collect()) {
    try {
      const text = readFileSync(join(root, rel), 'utf8');
      files[rel] = text;
      bytes += Buffer.byteLength(text, 'utf8');
    } catch {
      // 单个文件读不到就跳过，别让整份备份失败
    }
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    appVersion,
    at: new Date().toISOString(),
    dataDir: config.dataDir,
    count: Object.keys(files).length,
    bytes,
    files,
  };
}

/** 备份概览：不造整包，只看会备份多少东西（界面用来显示）。 */
export function backupSummary() {
  const list = collect();
  let bytes = 0;
  const root = stateDir();
  for (const rel of list) {
    try {
      bytes += statSync(join(root, rel)).size;
    } catch {}
  }
  const sessions = list.filter((r) => r.startsWith('sessions/') && r.endsWith('.json')).length;
  return { count: list.length, bytes, sessions, dataDir: config.dataDir };
}

function looksLikeBackup(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (obj.format === BACKUP_FORMAT) return true;
  // 宽容点：老包或手改过的包，只要有 files 这个对象且键看着像路径，就认
  return obj.files && typeof obj.files === 'object' && !Array.isArray(obj.files);
}

/**
 * 把备份写回去。
 * mode:
 *   'merge'    —— 只补没有的，已存在的留着（默认，最安全）
 *   'replace'  —— 同名文件覆盖；不删任何东西（比 merge 更彻底，但不会毁掉现有会话）
 */
export function restoreBackup(raw, { mode = 'merge' } = {}) {
  let obj = raw;
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw);
    } catch {
      const e = new Error('文件内容不是合法 JSON');
      e.status = 400;
      throw e;
    }
  }
  if (!looksLikeBackup(obj)) {
    const e = new Error('这不像小鱼Agent的备份文件');
    e.status = 400;
    throw e;
  }
  const files = obj.files || {};
  const keys = Object.keys(files);
  if (!keys.length) {
    const e = new Error('备份里一个文件都没有');
    e.status = 400;
    throw e;
  }

  const root = stateDir();
  const written = [];
  const kept = [];
  const failed = [];
  for (const rel of keys) {
    // 防目录穿越：备份包的键一律当成 .state 下的相对路径
    const norm = String(rel).replace(/\\/g, '/');
    if (norm.startsWith('/') || norm.includes('..')) {
      failed.push(norm);
      continue;
    }
    const dest = join(root, norm);
    const exists = existsSync(dest);
    if (exists && mode === 'merge') {
      kept.push(norm);
      continue;
    }
    try {
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, String(files[rel] ?? ''), 'utf8');
      written.push(norm);
    } catch {
      failed.push(norm);
    }
  }

  const sessions = written.filter((r) => r.startsWith('sessions/') && r.endsWith('.json')).length;
  return {
    ok: true,
    wrote: written.length,
    kept: kept.length,
    failed,
    sessions,
    mode,
    // 恢复完必须重启服务：会话列表、人设、设置都是启动时/首次读时缓存的
    needRestart: true,
  };
}
