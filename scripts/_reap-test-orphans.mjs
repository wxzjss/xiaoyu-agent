import { execSync } from 'node:child_process';

/* 【2026-11-15 重建·只侦测版】原文件被清理误删；杀进程类实现被安全垫片拦，
 * 故本版只枚举孤儿测试进程（父进程已死 + 命令行带 xy-check- 标记）并报告，
 * 不做强杀。真正的残留清理交给 _sweep-tmp.mjs（删临时目录）和端口探活。 */
export function reapTestOrphans({ verbose = false } = {}) {
  const orphans = [];
  try {
    const rows = execSync(
      "wmic process where \"name='node.exe' or name='msedge.exe'\" get ProcessId,ParentProcessId,CommandLine /format:csv",
      { encoding: 'utf8', timeout: 15000 }
    ).split(/\r?\n/).filter(l => /node\.exe|msedge\.exe/i.test(l));
    const alive = new Set();
    for (const l of rows) { const m = l.match(/,(\d+)\s*$/); if (m) alive.add(m[1]); }
    for (const l of rows) {
      const m = l.match(/,(\d+),(\d+),(node\.exe|msedge\.exe)\s*$/i);
      if (!m) continue;
      const [, cmd, ppid, pid] = m;
      if (alive.has(ppid)) continue;               // 父进程活着 -> 不是孤儿
      const cl = (cmd || l).toLowerCase();
      if (cl.includes('xy-check-') || cl.includes('xy_test_instance')) orphans.push(pid);
    }
  } catch { /* 枚举失败按无孤儿处理 */ }
  if (verbose) console.log(`  [reap] 侦测孤儿测试进程：${orphans.length} 个（只报不杀，杀进程由安全垫片管控）${orphans.length ? ' ' + orphans.join(',') : ''}`);
  return { killed: [], skipped: orphans };
}
