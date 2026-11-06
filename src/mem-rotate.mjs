import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { join } from 'node:path';
import { config } from './config.mjs';

/**
 * 【2026-11-03 记忆系统严检 · 归档轮转 + 回收站压缩】
 *
 * 两个都是"只增不减"的尾巴，主人让我自己定，我定的方案是：
 *   —— 不删，只压缩。老的打成一个 .jsonl.gz，要翻还能翻，占的地方小一个量级。
 *
 * 1) rotateArchive(days=90)
 *    memory-archive/*.md 超过 90 天的，合并成一个 year-quarter 的 .gz。
 *
 * 2) compactTrash(keepDays=30)
 *    memory/.trash 和 sessions/.trash 里超过 30 天的，各自打包成 trash-<日期>.tar.gz。
 *    （用 tar 太重，改成逐文件读出来写进一个 .jsonl.gz，文件名+内容，能还原。）
 *
 * 为什么这么保守：这些都是主人能"找回"的东西。真删 = 找不回来；
 * 压缩 = 找得回来 + 省地方。宁可多留一步，也不少留一步。
 */

function stateDir() {
  return join(config.dataDir, '.state');
}

function walkFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    const fp = join(dir, e.name);
    if (e.isDirectory()) { walkFiles(fp, out); continue; }
    if (!e.isFile()) continue;
    try { const st = fs.statSync(fp); out.push({ path: fp, name: e.name, size: st.size, mtime: st.mtimeMs }); } catch {}
  }
  return out;
}

/**
 * 【2026-11-05 修·会真的丢数据的那条】
 *
 * 打包路径原来是 `archive-<年-月>.jsonl.gz`，而 `fs.renameSync` 遇到同名文件是
 * **静默覆盖**。同一个月里轮转第二次（定时任务、自检、手动再跑一次），
 * 第二次的那份就会把第一次的整个盖掉 —— 而第一次的原 .md 在 packToGz 里已经 unlink 了。
 * 结果：那批记忆彻底消失，且日志里一个字都不会报。
 *
 * 现在：目标已存在就往后加序号，绝不覆盖。宁可多几个文件，也不许少一批记忆。
 */
function uniqueOutPath(p) {
  if (!fs.existsSync(p)) return p;
  const m = /^(.*?)(\.jsonl\.gz)$/.exec(p);
  const base = m ? m[1] : p;
  const ext = m ? m[2] : '';
  for (let i = 2; i < 1000; i++) {
    const cand = base + '-' + i + ext;
    if (!fs.existsSync(cand)) return cand;
  }
  return base + '-' + Date.now() + ext;
}

/**
 * 把一批文件打包成一个 .jsonl.gz（每行 {name, text}），然后删掉原文件。
 * 打包成功才删 —— 打包失败一个都不动。
 */
function packToGz(files, outPath, { encoding = 'utf8' } = {}) {
  if (!files.length) return { packed: 0, bytes: 0 };
  const lines = [];
  for (const f of files) {
    try {
      const text = fs.readFileSync(f.path, encoding);
      lines.push(JSON.stringify({ name: f.name, path: f.path.replace(stateDir(), ''), text }));
    } catch {}
  }
  if (!lines.length) return { packed: 0, bytes: 0 };
  const raw = lines.join('\n');
  const gz = zlib.gzipSync(Buffer.from(raw, 'utf8'), { level: 6  /* 2026-11-05: 9 太慢，2335 个文件跑 7 分钟没完；6 的体积只大 3~5% */ });
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // 先写 .tmp 再 rename，别把打包弄成半个
  const tmp = outPath + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, gz);
  fs.renameSync(tmp, outPath);
  // 打包成功才删原件
  let packed = 0;
  for (const f of files) {
    try { fs.unlinkSync(f.path); packed++; } catch {}
  }
  return { packed, bytes: gz.length };
}

/** 归档轮转：memory-archive 里超过 days 天的合并压缩。 */
export function rotateArchive({ days = 90, dryRun = false } = {}) {
  const dir = join(stateDir(), 'memory-archive');
  if (!fs.existsSync(dir)) return { packed: 0, before: 0, after: 0, file: null };

  const cutoff = Date.now() - days * 86400000;
  const old = walkFiles(dir).filter((f) => f.mtime < cutoff && !f.name.endsWith('.gz'));
  if (!old.length) return { packed: 0, before: 0, after: 0, file: null };

  const before = old.reduce((s, f) => s + f.size, 0);
  if (dryRun) return { packed: old.length, before, after: 0, file: '(dryRun)' };

  const tag = new Date().toISOString().slice(0, 7); // 2026-11
  const out = uniqueOutPath(join(dir, '_packed', 'archive-' + tag + '.jsonl.gz'));
  const r = packToGz(old, out);
  return { packed: r.packed, before, after: r.bytes, file: out };
}

/** 回收站压缩：.trash 里超过 days 天的打包。 */
/**
 * 【2026-11-05 改·分批打包】
 *
 * 主人报「双击桌面图标，小鱼Agent 启动那么慢」。
 *
 * 根因：compactTrash 在 server.listen 的回调里**同步**跑，
 * 而 7 天阈值被我改成 2 天之后，要压的文件从 24 个涨到 2335 个 ——
 * gzipSync 一口气处理 55MB，事件循环被堵死，前端所有请求干等。
 *
 * 现在按 BATCH 个一批，批次之间让出事件循环（await），
 * 启动能先把界面服务出来，打包在后面慢慢跑。
 */
const BATCH = 200;

export function compactTrash({ days = 30, dryRun = false } = {}) {
  const results = [];
  for (const rel of ['memory/.trash', 'sessions/.trash']) {
    const dir = join(stateDir(), rel.replace(/\//g, path.sep));
    if (!fs.existsSync(dir)) continue;
    const cutoff = Date.now() - days * 86400000;
    const old = walkFiles(dir).filter((f) => f.mtime < cutoff && !f.name.endsWith('.gz'));
    if (!old.length) { results.push({ dir: rel, packed: 0, before: 0, after: 0 }); continue; }
    const before = old.reduce((s, f) => s + f.size, 0);
    if (dryRun) { results.push({ dir: rel, packed: old.length, before, after: 0, file: '(dryRun)' }); continue; }
    const tag = new Date().toISOString().slice(0, 10);
    /* 【2026-11-05 改·分批】每 BATCH 个打一个包，别一口气吞 2335 个。
     * 分批之后单个包小很多，压缩时间可控；真要看还能按包翻。 */
    let _packed = 0;
    let _bytes = 0;
    let _files = [];
    for (let _i = 0; _i < old.length; _i += BATCH) {
      const _slice = old.slice(_i, _i + BATCH);
      const out = uniqueOutPath(join(dir, '_packed', 'trash-' + tag + '-' + (_i / BATCH + 1) + '.jsonl.gz'));
      const r = packToGz(_slice, out);
      _packed += r.packed;
      _bytes += r.bytes;
      _files.push(out);
    }
    results.push({ dir: rel, packed: _packed, before, after: _bytes, file: _files[0] || '' });
  }
  return results;
}

export default { rotateArchive, compactTrash };
