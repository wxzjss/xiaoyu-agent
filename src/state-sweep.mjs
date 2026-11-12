import fs from 'node:fs';
import path from 'node:path';
import { join } from 'node:path';
import { config } from './config.mjs';

/**
 * 【2026-11-03 记忆系统严检】目录体检 + 孤儿记忆本回收。
 *
 * 背景：严检时量了一遍 .state，5 天攒到 1GB+、两万多个文件，而且那些目录
 * 全是"只增不减"。一个个看下来，它们其实都是证据 ——
 *   slim/folded  压缩前的原话（丢了就找不回来）
 *   tool-out     工具输出的完整原文
 *   ui           陪看截图
 *   outbox       已经发给主人的文件副本
 *   plan/_history 清单历史（主人明说只增不删）
 * 所以这里**一个都不删**，只做两件事：
 *   1. healthReport()  量一下哪个目录胖了，超线就在日志里喊一声
 *   2. pruneOrphans()  把"会话早就没了"的记忆本挪进 .trash（可恢复，不真删）
 *
 * 为什么孤儿要清：记忆本在会话创建时就生成了。正常删会话走
 * /api/sessions/delete，接口会顺手把记忆本挪进 .trash；但只要有谁绕过接口
 * 直接删 sessions/*.json（测试脚本最容易这么干），记忆本就留在硬盘上 ——
 * 严检时实测攒出了 953 个。这既是垃圾，也是隐私问题（主人以为删干净了）。
 */

function stateDir() {
  return join(config.dataDir, '.state');
}

function dirStats(p) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const fp = join(d, e.name);
      if (e.isDirectory()) { walk(fp); continue; }
      if (!e.isFile()) continue;
      files++;
      try { bytes += fs.statSync(fp).size; } catch {}
    }
  };
  if (fs.existsSync(p)) walk(p);
  return { files, bytes };
}

/** 体检：哪些目录占地方。只量不删。 */
export function healthReport() {
  const base = stateDir();
  const DIRS = [
    'memory', 'memory/.trash', 'memory-archive', 'folded', 'chronicle',
    'slim', 'outbox', 'ui', 'plan', 'plan/_history', 'summary-audit',
    'tool-out', 'tool-out', 'sessions', 'sessions/.trash',
  ];
  const items = [];
  let stateMB = 0;
  let stateFiles = 0;
  const total = dirStats(base);
  stateMB = +(total.bytes / 1048576).toFixed(1);
  stateFiles = total.files;

  for (const d of DIRS) {
    const p = join(base, d.replace(/\//g, path.sep));
    if (!fs.existsSync(p)) continue;
    const s = dirStats(p);
    items.push({ dir: d, files: s.files, mb: +(s.bytes / 1048576).toFixed(1) });
  }
  items.sort((a, b) => b.mb - a.mb);
  return { stateMB, stateFiles, items };
}

/**
 * 孤儿记忆本回收：memory/<id>.md 对应的会话已经不在了 → 挪进 .trash。
 * 只挪不删，主人反悔还能捞回来。
 */
export function pruneWorkerFiles(opts = {}) {
  const dryRun = opts.dryRun === true;
  const st = join(config.dataDir, ".state");
  const wDir = join(st, "task-workers");
  const sDir = join(st, "sessions");
  if (!fs.existsSync(wDir)) return { moved: 0, files: [] };
  const alive = new Set();
  try {
    for (const f of fs.readdirSync(sDir)) {
      if (f.endsWith(".json") && !f.includes(".bak")) alive.add(f.replace(/\.json$/, ""));
    }
  } catch { return { moved: 0, files: [] }; }
  const out = [];
  for (const f of fs.readdirSync(wDir)) {
    if (!f.endsWith(".json")) continue;
    const sid = f.replace(/\.json$/, "");
    if (alive.has(sid)) continue;
    out.push(f);
    if (dryRun) continue;
    try { fs.renameSync(join(wDir, f), join(wDir, f + ".gone")); } catch {}
  }
  if (!dryRun && out.length) console.log("[state-sweep] worker 名册孤儿 " + out.length + " 个 → 改名 .gone");
  return { moved: out.length, files: out };
}

export function pruneOrphans({ dryRun = false } = {}) {
  const base = stateDir();
  const sessDir = join(base, 'sessions');
  const memDir = join(base, 'memory');

  if (!fs.existsSync(sessDir) || !fs.existsSync(memDir)) return { moved: 0, files: [] };

  const alive = new Set(
    fs.readdirSync(sessDir)
      .filter((f) => f.endsWith('.json') && !f.includes('.bak'))
      .map((f) => f.replace(/\.json$/, '')),
  );

  const trash = join(memDir, '.trash', '_orphans-' + new Date().toISOString().slice(0, 10));
  const moved = [];
  for (const f of fs.readdirSync(memDir)) {
    if (!f.endsWith('.md')) continue;
    const id = f.replace(/\.md$/, '');
    if (alive.has(id)) continue;
    const src = join(memDir, f);
    moved.push(f);
    if (dryRun) continue;
    try {
      fs.mkdirSync(trash, { recursive: true });
      fs.renameSync(src, join(trash, f));
    } catch {
      try { fs.copyFileSync(src, join(trash, f)); fs.unlinkSync(src); } catch {}
    }
  }
  if (moved.length && !dryRun) {
    console.log('[state-sweep] 孤儿记忆本挪进回收站: ' + moved.length + ' 个 → ' + trash);
  }
  return { moved: moved.length, files: moved, trash };
}

/**
 * 启动时挂上：先清孤儿，再报一次体检。
 *
 * 【2026-11-07 修·启动卡 16~35 秒】
 * 原来这个函数是**同步**跑完才返回的，而 healthReport() 会把整个 .state
 * 递归走一遍做统计。主人这台机器 .state 到了 1.3GB / 3.4 万个文件，
 * 光这一步就要十几秒，而且它卡在服务起来之前 —— 表现就是
 * 「双击图标，进程有了、端口也在听，但窗口十几秒不出来」。
 *
 * 现在改成：先同步做那件**必须马上做**的事（清孤儿记忆本，它只读 sessions/ 和
 * memory/ 两个平铺目录，几百个文件，快），然后体检丢到后台去，
 * 等主线程闲了再量 —— 量出来只是往日志里写一行，早一秒晚一秒无所谓。
 */
export function startHealthWatch() {
  try {
    const r = pruneOrphans();
    if (r.moved) console.log('[state-sweep] 清理孤儿记忆本 ' + r.moved + ' 个');
  } catch (e) {
    console.warn('[state-sweep] 清孤儿失败:', e && e.message ? e.message : e);
  }
  // 体检放到后台：它要递归走完整个 .state，是启动阶段最重的一步，别挡着开窗。
  const runReport = () => {
    try {
      const h = healthReport();
      if (h.stateMB >= 500) {
        const top = h.items.slice(0, 3).map((x) => x.dir + ' ' + x.mb + 'MB').join('、');
        console.log('[state-sweep] .state 已经 ' + h.stateMB + 'MB / ' + h.stateFiles + ' 个文件（占地方前几名: ' + top + '）');
      }
    } catch {}
  };
  /* 【2026-11-13 修·重启还是慢（boot-cpu 火焰图实锤）】2026-11-07 那次改用了
   * setImmediate——但它只在当前拍之后让一次事件循环，窗口还一个像素没画呢
   * 它就开跑了：healthReport 递归 statSync 整个 .state（1.3GB / 3.4 万文件）
   * 把主进程同步卡死 11.3 秒（boot-lag：启动第 11576ms 卡 11326ms），
   * 页面加载/静态文件全被摁住 ——「双击图标十几秒窗口才出来」卷土重来。
   * 现在真往后放：等 30 秒（窗口早画完、续跑也起好轮了）再量，量完只写一行日志。 */
  try { setTimeout(runReport, 30_000).unref?.(); } catch { /* 退化成不跑，也不能卡启动 */ }
}

export default { healthReport, pruneOrphans, startHealthWatch };
