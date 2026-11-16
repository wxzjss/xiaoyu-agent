/**
 * 借鉴来的工具（2026-11-15）
 *
 * 来源：DeepSeek Harness / WorkBuddy / Claude Code 三家，挑出来重新写过的。
 * 名字一律按小鱼的习惯起中文名，跟「写文件」「读文件」对齐。
 *
 * 这里面每一个都是「实在没法用现有工具凑出来」才做的；
 * 能拿 run_command / write_file 凑的，就别往这儿加。
 */

import { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import { resolve, isAbsolute, join, basename, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';

const clip = (s, n = 30000) => {
  const t = String(s ?? '');
  if (t.length <= n) return t;
  return t.slice(0, n) + `\n\n…（太长，只给了前 ${n} 字，全文 ${t.length} 字）`;
};

// ══════════════════════════════════════════════════════════
//  一、常驻终端 —— bash-persistent / terminal_* 的合并版
//  一把「开着的 shell」，cd 和环境变量不会每条命令丢一次
// ══════════════════════════════════════════════════════════

const TERMS = new Map(); // id -> { proc, buf, cwd, alive }
let termSeq = 0;

export function killAllTerminals() {
  for (const [, t] of TERMS) {
    try { t.alive = false; t.proc.kill(); } catch {}
  }
  TERMS.clear();
}

function termStart({ cwd, shell } = {}) {
  const id = 'sh' + (++termSeq);
  const isWin = process.platform === 'win32';
  const exe = shell || (isWin ? 'powershell.exe' : 'bash');
  const args = isWin ? ['-NoLogo', '-NoProfile', '-Command', '-'] : [];
  const c = cwd ? (isAbsolute(cwd) ? cwd : resolve(process.cwd(), cwd)) : process.cwd();
  if (!existsSync(c)) throw new Error('目录不存在：' + c);

  const proc = spawn(exe, args, {
    cwd: c,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const t = { id, proc, buf: '', cwd: c, alive: true, shell: exe };
  proc.stdout.on('data', (d) => { t.buf += d.toString('utf8'); });
  proc.stderr.on('data', (d) => { t.buf += d.toString('utf8'); });
  proc.on('exit', (code) => {
    t.alive = false;
    t.buf += `\n[终端已退出，code=${code}]`;
  });
  TERMS.set(id, t);
  return { id, cwd: c, shell: exe };
}

function termSend(id, input) {
  const t = TERMS.get(id);
  if (!t) throw new Error('没有这个终端：' + id + '（可能已经关了，或者重启过）');
  if (!t.alive) throw new Error('终端 ' + id + ' 已经退出了');
  try {
    t.proc.stdin.write(String(input).replace(/\r?\n/g, '\r\n') + '\r\n');
  } catch (e) {
    throw new Error('往终端里写字失败：' + String(e?.message ?? e));
  }
  return true;
}

function termRead(id) {
  const t = TERMS.get(id);
  if (!t) throw new Error('没有这个终端：' + id);
  const out = t.buf;
  t.buf = '';
  return { alive: t.alive, output: out };
}

function termClose(id) {
  const t = TERMS.get(id);
  if (!t) return false;
  try { t.alive = false; t.proc.kill(); } catch {}
  TERMS.delete(id);
  return true;
}

function listTerminals() {
  return [...TERMS.values()].map((t) => ({ id: t.id, cwd: t.cwd, alive: t.alive, shell: t.shell }));
}

// ══════════════════════════════════════════════════════════
//  二、按筛选找文件 —— fs-search
// ══════════════════════════════════════════════════════════

function findFiles({ dir, pattern, ignore, maxResults, maxDepth, withContent }) {
  const start = dir ? (isAbsolute(dir) ? dir : resolve(process.cwd(), dir)) : process.cwd();
  if (!existsSync(start)) throw new Error('目录不存在：' + start);
  const re = pattern ? new RegExp(pattern, 'i') : null;
  const ign = (ignore || ['node_modules', '.git', 'dist', '.cache', 'dump'])
    .map((x) => String(x).toLowerCase());
  const limit = Math.min(Number(maxResults) || 200, 2000);
  const depthLimit = Number.isFinite(Number(maxDepth)) ? Number(maxDepth) : 12;
  const out = [];
  let scanned = 0;

  const walk = (d, depth) => {
    if (out.length >= limit || depth > depthLimit) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      const nm = e.name;
      if (ign.includes(nm.toLowerCase())) continue;
      const full = join(d, nm);
      if (e.isDirectory()) { walk(full, depth + 1); continue; }
      if (!e.isFile()) continue;
      scanned++;
      let hit;
      if (withContent) {
        try {
          const sz = statSync(full).size;
          if (sz > 2 * 1024 * 1024) continue;
          const txt = readFileSync(full, 'utf8');
          hit = re ? re.test(txt) : true;
        } catch { continue; }
      } else {
        hit = re ? (re.test(nm) || re.test(full)) : true;
      }
      if (hit) {
        let size = 0;
        try { size = statSync(full).size; } catch {}
        out.push({ path: full, size });
      }
    }
  };
  walk(start, 0);
  return { start, scanned, found: out, truncated: out.length >= limit };
}

// ══════════════════════════════════════════════════════════
//  三、读图 —— read_image
// ══════════════════════════════════════════════════════════

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function readImage(path) {
  const p = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(p)) throw new Error('文件不存在：' + p);
  if (!IMG_EXT.test(p)) throw new Error('这不是图片：' + p + '（认得的：png/jpg/jpeg/gif/webp/bmp）');
  const st = statSync(p);
  if (st.size > 12 * 1024 * 1024) throw new Error('图太大了（' + (st.size / 1048576).toFixed(1) + 'MB），先压一下');
  const ext = (p.match(IMG_EXT) || [])[1].toLowerCase();
  const mime = 'image/' + (ext === 'jpg' ? 'jpeg' : ext);
  // 不在这儿算 base64 —— tools.mjs 里 read_file 是走 images:[绝对路径] 这条通道直接把图递进去的，
  // 算一遍 44 万字的 dataUrl 纯属白烧 CPU。
  return { path: p, size: st.size, mime };
}

// ══════════════════════════════════════════════════════════
//  四、目标常驻 —— 一口气干到一半上下文被压掉，目标不该跟着没
// ══════════════════════════════════════════════════════════

const GOAL_FILE = join(config.dataDir, '.state', 'goals.json');

function _readGoals() {
  try { return JSON.parse(readFileSync(GOAL_FILE, 'utf8')); } catch { return {}; }
}
function _writeGoals(o) {
  mkdirSync(dirname(GOAL_FILE), { recursive: true });
  const tmp = GOAL_FILE + '.tmp' + process.pid;
  writeFileSync(tmp, JSON.stringify(o, null, 2), 'utf8');
  renameSync(tmp, GOAL_FILE);
}

function goalSet(sessionId, text, done) {
  if (!sessionId) throw new Error('没有会话 id，存不了目标');
  const o = _readGoals();
  const cur = o[sessionId] || { history: [] };
  if (text === undefined && done === undefined) return cur;
  if (done === true || done === 'done') {
    if (cur.text) cur.history = [...(cur.history || []), { text: cur.text, at: Date.now(), state: 'done' }];
    cur.text = '';
    cur.done = true;
    cur.updatedAt = Date.now();
  } else if (text) {
    if (cur.text && cur.text !== text) {
      cur.history = [...(cur.history || []), { text: cur.text, at: Date.now(), state: 'replaced' }];
    }
    cur.text = String(text);
    cur.done = false;
    cur.updatedAt = Date.now();
  }
  o[sessionId] = cur;
  _writeGoals(o);
  return cur;
}

// ══════════════════════════════════════════════════════════
//  五、发一组文件 —— 一次发好几个
// ══════════════════════════════════════════════════════════

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.pdf': 'application/pdf', '.zip': 'application/zip',
  '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.csv': 'text/csv', '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.ts': 'text/javascript',
};

function describeForSend(p) {
  const abs = isAbsolute(p) ? p : resolve(process.cwd(), p);
  if (!existsSync(abs)) return { path: abs, ok: false, error: '文件不存在' };
  const st = statSync(abs);
  if (st.isDirectory()) {
    const kids = readdirSync(abs, { withFileTypes: true }).filter((e) => e.isFile());
    return { path: abs, ok: true, size: st.size, dir: true, count: kids.length };
  }
  const ext = (abs.match(/\.[^.\\/]+$/) || [''])[0].toLowerCase();
  return { path: abs, ok: true, size: st.size, mime: MIME_BY_EXT[ext] || 'application/octet-stream' };
}


export {
  termStart, termSend, termRead, termClose, listTerminals,
  findFiles, readImage, goalSet, describeForSend, clip,
};
