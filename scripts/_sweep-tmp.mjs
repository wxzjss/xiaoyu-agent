/**
 * _sweep-tmp.mjs — 回归临时目录磁盘闸
 * 背景：被掐断的回归会留 xy-check-* 目录，攒多了 C 盘 ENOSPC，所有回归起不来。
 * 用法：sweepTmpDirs({ verbose: true }) → { scanned, removed, kept, failed }
 * 规矩（宁可漏删，绝不误删正在用的）：最近 10 分钟内有改动的目录一律保留。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const KEEP_MS = 10 * 60 * 1000; // 最近 10 分钟动过的视为正在用

function dirMtime(dir) {
  let latest = 0;
  try {
    const st = fs.statSync(dir);
    latest = st.mtimeMs;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      try {
        const s = e.isDirectory() ? fs.statSync(p) : fs.statSync(p);
        if (s.mtimeMs > latest) latest = s.mtimeMs;
      } catch {}
    }
  } catch {}
  return latest;
}

export function sweepTmpDirs({ verbose = false } = {}) {
  const tmp = os.tmpdir();
  let scanned = 0, removed = 0, kept = 0, failed = 0;
  const now = Date.now();
  let names = [];
  try {
    names = fs.readdirSync(tmp).filter((n) => n.startsWith('xy-check-'));
  } catch (e) {
    if (verbose) console.log('  [sweep-tmp] 扫不动 tmp：' + e.message);
    return { scanned, removed, kept, failed };
  }
  for (const n of names) {
    const p = path.join(tmp, n);
    scanned++;
    if (now - dirMtime(p) < KEEP_MS) { kept++; continue; }
    try {
      fs.rmSync(p, { recursive: true, force: true, maxRetries: 2, retryDelay: 200 });
      removed++;
    } catch { failed++; }
  }
  if (verbose && scanned) {
    console.log(`  [sweep-tmp] 扫 ${scanned} 个 xy-check-*：删 ${removed}，留存(正在用) ${kept}，删不掉 ${failed}`);
  }
  return { scanned, removed, kept, failed };
}
