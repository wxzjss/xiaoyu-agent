/**
 * 【会话知识库】—— 2026-11-14 主人钦点
 *
 * 主人原话（截图输入框）：「给小鱼Agent的记忆系统添加【会话知识库】，
 * 只要做过某件事，下次再做必迅速完成」。
 *
 * 与长期记忆本（my-memory.mjs）的分工：
 *   · 记忆本记「发生了什么 / 结论 / 主人说过的话」—— 事件性；
 *   · 知识库记「**怎么做的**」—— 手路：改哪个文件哪一行、命令怎么敲、
 *     步骤顺序、有什么坑。下次遇到同类任务，线索直接递到手边，不用从头摸索。
 *
 * 三件套：
 *   · knowAdd     —— 干完有重复价值的活后记一条（同 trigger 覆盖更新）；
 *   · knowSearch  —— 按关键词搜现成手路（中文 2-gram + 英文分词打分）；
 *   · knowIndex   —— 只回 trigger 索引（system 常驻，模型据此决定要不要搜详情）。
 *
 * 存储：.state/knowledge.json，最多 50 条，满了按「命中次数少、最久没用」淘汰。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { appendKnowEvent } from './know-chronicle.mjs';

const KNOW_MAX = 50;
const TRIGGER_MAX = 120;
const STEPS_MAX = 2000;

function knowFile() {
  return join(config.dataDir, '.state', 'knowledge.json');
}

function readAll() {
  try {
    if (!existsSync(knowFile())) return [];
    const j = JSON.parse(readFileSync(knowFile(), 'utf8'));
    const raw = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : [];
    return raw
      .filter((x) => x && typeof x === 'object' && String(x.trigger || '').trim())
      .map((x) => ({
        id: String(x.id || ''),
        trigger: String(x.trigger || '').slice(0, TRIGGER_MAX),
        steps: String(x.steps || '').slice(0, STEPS_MAX),
        hits: Number(x.hits) || 0,
        lastHit: Number(x.lastHit) || 0,
        createdAt: Number(x.createdAt) || 0,
        source: String(x.source || '').slice(0, 60),
      }));
  } catch {
    return [];
  }
}

function writeAll(items) {
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    /* 原子写：先写临时文件再 rename —— 进程崩在写一半也不会留坏 JSON
     * （readAll 虽然容错，但坏一次就丢整库，能不赌就不赌）。 */
    const tmp = knowFile() + '.tmp';
    writeFileSync(tmp, JSON.stringify({ v: 1, items }, null, 2), 'utf8');
    renameSync(tmp, knowFile());
    return true;
  } catch {
    return false;
  }
}

/** 简易分词：英文按词，中文按 2-gram（单字命中太吵，整词中文常对不上）。 */
function tokenize(text) {
  const t = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of t.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!w) continue;
    if (/^[\u4e00-\u9fff]+$/.test(w)) {
      if (w.length === 1) out.add(w);
      else for (let i = 0; i < w.length - 1; i++) out.add(w.slice(i, i + 2));
    } else if (w.length >= 2) {
      out.add(w);
    }
  }
  return out;
}

/**
 * 记一条手路。同 trigger（忽略首尾空白与大小写）已存在 → 覆盖更新 steps
 * 并刷新时间（手路是越用越准的，新写法盖旧写法），hits 保留。
 */
export function knowAdd({ trigger, steps, source, by } = {}) {
  const tr = String(trigger || '').trim().slice(0, TRIGGER_MAX);
  if (!tr) return { ok: false, error: 'trigger 不能为空：写下「下次遇到什么任务该想起这条」' };
  const st = String(steps || '').trim().slice(0, STEPS_MAX);
  if (!st) return { ok: false, error: 'steps 不能为空：手路本身（文件位置 / 步骤 / 命令 / 坑）' };

  const items = readAll();
  const now = Date.now();
  const norm = (x) => String(x || '').trim().toLowerCase();
  const prev = items.find((x) => norm(x.trigger) === norm(tr));
  if (prev) {
    /* 【2026-11-14 主人钦点·知识史书】更新时史书同步落一笔：新版进知识库，
     * 被覆盖的旧版（prevSteps）留在史书里——新写法不好使时翻得回。 */
    appendKnowEvent({ action: 'update', trigger: tr, steps: st, prevSteps: prev.steps, source: prev.source, by });
    prev.steps = st;
    prev.lastHit = now;
    if (source) prev.source = String(source).slice(0, 60);
    writeAll(items);
    return { ok: true, id: prev.id, updated: true, count: items.length };
  }

  let id = 'k' + now.toString(36);
  while (items.some((x) => x.id === id)) id += 'x';
  items.push({
    id,
    trigger: tr,
    steps: st,
    hits: 0,
    lastHit: now,
    createdAt: now,
    source: String(source || '').slice(0, 60),
  });
  /* 满了淘汰：命中次数少者优先，同分淘汰最久没用的。
   * 【2026-11-14 知识史书】被淘汰的那条先在史书留底（action:'evict'），再删——
   * 淘汰不是消失，翻得回。 */
  while (items.length > KNOW_MAX) {
    let worst = 0;
    for (let i = 1; i < items.length; i++) {
      const a = items[i], b = items[worst];
      if (a.hits < b.hits || (a.hits === b.hits && (a.lastHit || 0) < (b.lastHit || 0))) worst = i;
    }
    const _out = items[worst];
    if (_out) appendKnowEvent({ action: 'evict', trigger: _out.trigger, steps: _out.steps, source: _out.source, by });
    items.splice(worst, 1);
  }
  appendKnowEvent({ action: 'add', trigger: tr, steps: st, source, by });
  writeAll(items);
  return { ok: true, id, count: items.length };
}

/** 搜现成手路：trigger 命中权重 ×3（标题对上才是真对上），steps ×1。命中顺带 hits+1。 */
export function knowSearch(query, limit = 3) {
  const q = String(query || '').trim();
  if (!q) return [];
  const qs = tokenize(q);
  if (!qs.size) return [];
  const items = readAll();
  const scored = [];
  for (const it of items) {
    const trig = tokenize(it.trigger);
    const step = tokenize(it.steps);
    let score = 0;
    for (const w of qs) {
      if (trig.has(w)) score += 3;
      if (step.has(w)) score += 1;
    }
    if (score > 0) scored.push({ score, it });
  }
  scored.sort((a, b) => b.score - a.score || (b.it.lastHit || 0) - (a.it.lastHit || 0));
  const top = scored.slice(0, Math.max(1, Math.min(Number(limit) || 3, 5))).map((x) => x.it);
  if (top.length) {
    for (const it of top) {
      it.hits = (it.hits || 0) + 1;
      it.lastHit = Date.now();
    }
    writeAll(items);
  }
  return top.map((x) => ({ id: x.id, trigger: x.trigger, steps: x.steps }));
}

/** system 常驻索引：只回 trigger（轻），模型看到「这件事有手路」再搜详情。 */
export function knowIndex(limit = 50) {
  return readAll()
    .sort((a, b) => (b.lastHit || 0) - (a.lastHit || 0))
    .slice(0, Math.max(1, Math.min(Number(limit) || 50, KNOW_MAX)))
    .map((x) => ({ trigger: x.trigger, hits: x.hits || 0 }));
}

/** 管理用（界面 / 诊断）：全量只读 */
export function knowAll() {
  return readAll().sort((a, b) => (b.lastHit || 0) - (a.lastHit || 0));
}

/** 管理用（界面）：按 trigger 删一条手路。knowAdd 按 trigger 去重，删除也按它对账。 */
export function knowDelete(trigger) {
  const key = String(trigger || '').trim();
  if (!key) return { ok: false, error: '没给 trigger' };
  const items = readAll();
  const _removed = items.find((x) => String(x.trigger || '').trim() === key);
  const next = items.filter((x) => String(x.trigger || '').trim() !== key);
  if (next.length === items.length) return { ok: false, error: '没有这条手路' };
  if (!writeAll(next)) return { ok: false, error: '写盘失败' };
  /* 【2026-11-14 主人钦点·删除不删史书】知识库里删掉只记一笔 delete；
   * 史书里这条的历次版本原样保留——「随会话删除被删时，知识史书对应的不会被删」。 */
  if (_removed) appendKnowEvent({ action: 'delete', trigger: _removed.trigger, steps: _removed.steps, source: _removed.source, by: '删除' });
  return { ok: true, removed: items.length - next.length, count: next.length };
}

/**
 * 【常驻系统提示的索引段】2026-11-14 主人钦点「只要做过某件事，下次再做必迅速完成」
 *
 * 只把 trigger 列表放进系统提示（每条截 60 字，最多 30 条，空库一个字不占）——
 * 步骤正文不常驻（会爆上下文），模型看到沾边的条目再用 know_search 现翻。
 */
export function knowIndexBlock(limit = 30) {
  const idx = knowIndex(limit);
  if (!idx.length) return '';
  const lines = idx.map((x) => `  · ${String(x.trigger).slice(0, 60)}`);
  return [
    '【会话知识库·手路索引】规矩：如果你做某件事时曾绕了很大一个弯子，如果那件事现在再做能迅速完成，那么就把它的路径写进知识库里面，写成：要做到【只要做过某件事，下次再做必迅速完成】的程度。下面是攒下来的「怎么做事」的条目名。哪一条跟当前任务沾边，就先 know_search 搜它的关键词拿步骤——照着做，别从头摸索；干完有重复价值的活也用 know_add 记一条，让下次更快：',
    ...lines,
  ].join('\n');
}
