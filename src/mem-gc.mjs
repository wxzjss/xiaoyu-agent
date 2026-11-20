import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { join } from 'node:path';
import { config } from './config.mjs';

/**
 * 【2026-11-18 加·孤儿回收（mem-gc）】
 *
 * ── 为什么要它 ──────────────────────────────────────
 * 实测这台机器（2026-11-18）：
 *   chronicle   5871 个文件，**5839 个是孤儿**（84.3% 空间 / 77.7MB 里的 65.5MB）
 *   selfnote    65 个里 64 个孤儿（98.5%）
 *   folded / slim / tool-out 也各有一半以上
 *
 * 根因不是「忘了写清理」，是**清理从来没被设计过**：
 * `mem-rotate` 只管 memory-archive 和两个 .trash，别的目录一个都没覆盖；
 * 而删会话的时候只删 sessions/<id>.json，**不会顺手清掉这六个目录里属于它的那份**。
 * 所以每跑一次测试会话就留一堆，越积越多 —— 这是唯一会随时间恶化的地方。
 *
 * ── 为什么不直接删 ──────────────────────────────────
 * 主人的规矩是「不删，只压缩」（mem-rotate 文件头写着）。这里照办，但分两类：
 *
 *   ① 打包类（先 gz 再删，随时能还原）：chronicle / folded / selfnote
 *      这三样都是「对话的衍生内容」—— 史书、压缩存档、她亲手写的笔记。
 *      万一哪天主人想翻某个删掉的会话，从 .gz 里还能捞出来。
 *
 *   ② 直删类（不打包）：slim / tool-out
 *      这两个是**工具输出的副本**，会话 json 里本来就有截断版，工具重跑也能重生。
 *      打包它们等于把垃圾再存一份，纯浪费。
 *
 *   ③ 绝不碰：memory/
 *      那是主人的记忆本。**哪怕会话没了，记忆本也可能是唯一的一份**。
 *      宁可多占几十兆，也不许自动清掉一个字。这条是硬约束，不给开关。
 *
 * ── 安全阀（缺一不可，宁可漏删不可误删） ──────────────
 *   · 只认已知的目录与文件名形态（下面 KINDS 里写死的）
 *   · 孤儿判定 = 会话 id 不在 sessions/ 里，**也不在 sessions/.trash 里**
 *     （移进回收站的会话还可能被还原，它的档案不能当成孤儿）
 *   · 必须超过 days 天没动（默认 14 天）—— 刚删的会话，主人可能明天就后悔
 *   · 一次最多处理 maxFiles 个（默认 3000），别一口气卡死事件循环
 *   · dryRun 能先看清单，不写一个字
 */

/** 目录 → 怎么处理。表里没有的目录，这个模块一个字都不碰。 */
const KINDS = [
  {
    /* 史书：docs/<会话>.jsonl，另有 index/ 和 manifest.json 不能动 */
    rel: 'chronicle/docs',
    match: /^(.+)\.jsonl$/,
    mode: 'pack',
    /* 这些不是会话 id，是索引的伴生文件 */
    skip: /^(index|manifest)/,
  },
  {
    /* 压缩存档：<会话>.md 或 <会话>/ 目录 */
    rel: 'folded',
    match: /^(.+)\.md$/,
    mode: 'pack',
  },
  {
    /* 她亲手写的压缩记忆完整存档 */
    rel: 'selfnote',
    match: /^(.+)\.txt$/,
    mode: 'pack',
  },
  {
    /* 工具输出瘦身副本：<会话>/ 目录 */
    rel: 'slim',
    dirMode: true,
    mode: 'drop',
  },
  {
    /* 工具输出原始件：<会话>/ 目录 */
    rel: 'tool-out',
    dirMode: true,
    mode: 'drop',
  },
];

/** 绝不自动清理的目录（写在这里是为了让人一眼看到这条硬约束） */
export const NEVER_TOUCH = ['memory', 'memory-archive', 'sessions'];

/**
 * 【2026-11-18 加】测试残留：不用等 days 天，看到就能收。
 *
 * 为什么单独拎出来：`__probe_compact_note_12452.txt` 这种是**检查脚本自己造的**，
 * 会话 id 叫 `__probe_*` / `test-<pid>`，永远不可能是主人要恢复的东西。
 * 而 days=14 的保护期是为了「刚删的会话主人可能明天后悔」——
 * 这条理由对测试残留完全不成立。
 *
 * 实测：光 selfnote 里就积了 72 个这种文件，每个 check 一跑就多几个。
 * 这也是为什么 selfnote 的孤儿率能到 98.5% —— 大头全是测试垃圾。
 */
const TEST_ARTIFACT = /^(__probe|_probe|probe_|test-\d)/;

function stateDir() {
  return join(config.dataDir, '.state');
}

/**
 * 现在还有哪些会话「算活着」。
 * 包括 sessions/ 里的，也包括 sessions/.trash 里的 —— 回收站里的还能还原。
 */
function liveSessions() {
  const set = new Set();
  for (const rel of ['sessions', join('sessions', '.trash')]) {
    const dir = join(stateDir(), rel);
    let list = [];
    try { list = fs.readdirSync(dir); } catch { continue; }
    for (const f of list) {
      const m = /^(.+)\.json$/.exec(f);
      if (m) set.add(m[1]);
      /* .trash 里可能被改成 <id>.json.bak 之类，宽松一点也认 */
      else if (!f.startsWith('.') && !f.startsWith('_')) {
        const m2 = /^([A-Za-z0-9_-]{6,})/.exec(f);
        if (m2) set.add(m2[1]);
      }
    }
  }
  return set;
}

/** 打包一批文件成 .jsonl.gz（每行 {name, path, text}），成功才删 */
function packToGz(files, outPath) {
  if (!files.length) return { packed: 0, bytes: 0 };
  const base = stateDir();
  const lines = [];
  for (const f of files) {
    try {
      lines.push(JSON.stringify({
        name: f.name,
        path: String(f.path).replace(base, ''),
        text: fs.readFileSync(f.path, 'utf8'),
      }));
    } catch { /* 读不出来的跳过，不影响别的 */ }
  }
  if (!lines.length) return { packed: 0, bytes: 0 };
  const gz = zlib.gzipSync(Buffer.from(lines.join('\n'), 'utf8'), { level: 6 });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const tmp = outPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, outPath);      // 先落稳再删原件，绝不留半个包
  let packed = 0;
  for (const f of files) {
    try { fs.unlinkSync(f.path); packed++; } catch {}
  }
  return { packed, bytes: gz.length };
}

/**
 * 扫一遍，返回该回收什么。**只统计，不动手。**
 *
 * @param {{days?: number, maxFiles?: number}} opts
 */
export function scanGc({ days = 14, maxFiles = 3000 } = {}) {
  const base = stateDir();
  const live = liveSessions();
  const cutoff = Date.now() - days * 86400000;
  const found = [];
  const missing = [];

  for (const k of KINDS) {
    const dir = join(base, k.rel.replace(/\//g, path.sep));
    if (!fs.existsSync(dir)) { missing.push(k.rel); continue; }
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }

    for (const e of list) {
      const fp = join(dir, e.name);

      /* ── 目录形态（slim/<id>/、tool-out/<id>/、folded/<id>/） ── */
      if (e.isDirectory()) {
        if (e.name.startsWith('_')) continue;         // _packed / _gc 这些是收纳盒
        if (live.has(e.name)) continue;
        let st;
        try { st = fs.statSync(fp); } catch { continue; }
        /* 测试残留不受 days 保护（它不可能是主人要恢复的数据） */
        const isTest = TEST_ARTIFACT.test(e.name);
        if (!isTest && st.mtimeMs >= cutoff) continue;   // 还新鲜，可能是别人正在写
        found.push({ kind: k.rel, name: e.name, path: fp, isDir: true, size: dirSize(fp), mode: k.mode, isTest });
        continue;
      }

      if (!e.isFile()) continue;
      if (k.kindIsDirOnly) continue;
      if (k.skip && k.skip.test(e.name)) continue;
      const m = k.match ? k.match.exec(e.name) : null;
      if (!m) continue;
      const id = m[1];
      if (live.has(id)) continue;
      let st;
      try { st = fs.statSync(fp); } catch { continue; }
      const isTest = TEST_ARTIFACT.test(id);
      if (!isTest && st.mtimeMs >= cutoff) continue;
      found.push({ kind: k.rel, name: e.name, path: fp, isDir: false, size: st.size, mode: k.mode, isTest });
    }
  }

  /* 大的先处理：一次限流时，优先清占地方最多的 */
  found.sort((a, b) => b.size - a.size);
  const over = found.length > maxFiles ? found.length - maxFiles : 0;
  const take = found.slice(0, maxFiles);

  const byKind = {};
  let testN = 0;
  let testBytes = 0;
  for (const f of found) {
    if (!byKind[f.kind]) byKind[f.kind] = { n: 0, bytes: 0, test: 0 };
    byKind[f.kind].n++;
    byKind[f.kind].bytes += f.size;
    if (f.isTest) { byKind[f.kind].test++; testN++; testBytes += f.size; }
  }

  return {
    items: take,
    total: found.length,
    totalBytes: found.reduce((s, f) => s + f.size, 0),
    testN,
    testBytes,
    deferred: over,
    byKind,
    missing,
    cutoffDays: days,
  };
}

function dirSize(dir) {
  let n = 0;
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of list) {
    const fp = join(dir, e.name);
    try {
      if (e.isDirectory()) n += dirSize(fp);
      else if (e.isFile()) n += fs.statSync(fp).size;
    } catch {}
  }
  return n;
}

function rmDirSafe(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); return true; } catch { return false; }
}

/**
 * 真跑回收。
 *
 * @param {{days?: number, maxFiles?: number, dryRun?: boolean, onProgress?: Function}} opts
 */
export function runGc({ days = 14, maxFiles = 3000, dryRun = false, onProgress = null } = {}) {
  const scan = scanGc({ days, maxFiles });
  if (dryRun) {
    return { ...scan, dryRun: true, packed: 0, dropped: 0, freed: 0, files: [] };
  }

  const tag = new Date().toISOString().slice(0, 10);
  const outDirs = [];
  let packed = 0;
  let dropped = 0;
  let freed = 0;

  /* 打包类：按 kind 分组，每组打一个包（顺序处理，别把事件循环堵死） */
  for (const rel of ['chronicle/docs', 'folded', 'selfnote']) {
    const files = scan.items.filter((f) => f.kind === rel && !f.isDir);
    if (!files.length) continue;
    const out = join(stateDir(), '_gc', rel.replace(/\//g, path.sep), 'gc-' + tag + '.jsonl.gz');
    /* 同一天跑两次 → 加序号，绝不覆盖（跟 mem-rotate 的教训一致） */
    let target = out;
    for (let i = 2; fs.existsSync(target) && i < 1000; i++) {
      target = out.replace(/\.jsonl\.gz$/, '-' + i + '.jsonl.gz');
    }
    const r = packToGz(files, target);
    packed += r.packed;
    freed += files.reduce((s, f) => s + f.size, 0);
    outDirs.push(target);
    if (onProgress) { try { onProgress({ step: 'pack', kind: rel, packed: r.packed, file: target }); } catch {} }
  }

  /* 直删类：slim / tool-out 的目录形态 */
  for (const f of scan.items) {
    if (f.mode !== 'drop') continue;
    if (rmDirSafe(f.path)) { dropped++; freed += f.size; }
  }

  return {
    total: scan.total,
    packed,
    dropped,
    freed,
    files: outDirs,
    byKind: scan.byKind,
    deferred: scan.deferred,
    cutoffDays: days,
  };
}

export default { scanGc, runGc, NEVER_TOUCH };
