/**
 * 【知识史书】—— 2026-11-14 主人钦点
 *
 * 主人原话：「增加一个和【岁月史书】一样的【知识史书】，会自动记录所有会话的
 * 【会话知识库】里的内容」。
 *
 * 与岁月史书（chronicle.mjs）的分工：
 *   · 岁月史书记「对话本身」—— 每轮收尾把会话编成书，她用 chronicle_* 工具翻；
 *   · 知识史书记「手路的每一版」—— 知识库（know.mjs）的每一条记/改/删/淘汰
 *     都自动落账在这里，她用 know_chronicle_* 工具翻。
 *
 * 为什么要有它：知识库同 trigger 覆盖更新、满了淘汰——**最新版是对的，
 * 但旧版一页不灭**（和史书版本化归档同一精神）。新写法要是不好使，
 * 翻史书找旧写法，照旧 steps 重新 know_add 一次就恢复。
 *
 * 存储：.state/knowledge-chronicle.jsonl，追加式，一行一笔：
 *   { ts, action: add|update|delete|evict|seed, trigger, steps, prevSteps?, source?, by? }
 *
 * 初建自动播种：史书文件不存在时，把现有 knowledge.json 的存量整批导入成
 * add 事件（用各自的 createdAt 记时）——「自动记录所有会话的知识库内容」
 * 从第一笔就成立，存量不漏。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, statSync, unlinkSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

/** 史书体积上限：超过就从最旧开始截到 1500 笔（档案也要防无限膨胀） */
const MAX_BYTES = 2 * 1024 * 1024;
const TRIM_TO = 1500;

function chronFile() {
  return join(config.dataDir, '.state', 'knowledge-chronicle.jsonl');
}

/** 简易分词：与 know.mjs 同款（英文按词、中文 2-gram）。不 import 它避免循环依赖。 */
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

function readKnowledgeRaw() {
  try {
    const p = join(config.dataDir, '.state', 'knowledge.json');
    if (!existsSync(p)) return [];
    const j = JSON.parse(readFileSync(p, 'utf8'));
    const raw = Array.isArray(j) ? j : Array.isArray(j?.items) ? j.items : [];
    return raw.filter((x) => x && String(x.trigger || '').trim());
  } catch {
    return [];
  }
}

/** 初建播种：史书还不存在时，把知识库存量整批导入（存量不漏）。 */
function ensureSeeded() {
  const p = chronFile();
  if (existsSync(p)) return;
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const items = readKnowledgeRaw();
    const lines = [];
    if (items.length) {
      lines.push(JSON.stringify({ ts: Date.now(), action: 'seed', note: '史书初建，把知识库存量整批导入', count: items.length }));
      for (const it of items) {
        lines.push(JSON.stringify({
          ts: Number(it.createdAt) || Date.now(),
          action: 'add',
          trigger: String(it.trigger || '').slice(0, 200),
          steps: String(it.steps || '').slice(0, 3000),
          source: String(it.source || '').slice(0, 80),
          by: it.source || '史书初建导入',
        }));
      }
    }
    writeFileSync(p, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
  } catch { /* 播种失败不挡正常记账 */ }
}

/** 记一笔（内部用；know.mjs 的增改删淘汰会调）。失败静默——史书不能拖垮知识库本身。 */
export function appendKnowEvent(ev) {
  try {
    ensureSeeded();
    const rec = {
      ts: Date.now(),
      action: String(ev?.action || 'add'),
      trigger: String(ev?.trigger || '').slice(0, 200),
      steps: String(ev?.steps || '').slice(0, 3000),
    };
    if (ev?.prevSteps) rec.prevSteps = String(ev.prevSteps).slice(0, 3000);
    if (ev?.source) rec.source = String(ev.source).slice(0, 80);
    if (ev?.by) rec.by = String(ev.by).slice(0, 80);
    const p = chronFile();
    appendFileSync(p, JSON.stringify(rec) + '\n', 'utf8');
    trimIfNeeded(p);
    return true;
  } catch {
    return false;
  }
}

/** 体积防膨胀：超 2MB 截到最近 1500 笔（原子替换）。 */
function trimIfNeeded(p) {
  try {
    if (!existsSync(p)) return;
    if (statSync(p).size <= MAX_BYTES) return;
    const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
    const keep = lines.slice(-TRIM_TO);
    const tmp = p + '.tmp';
    writeFileSync(tmp, keep.join('\n') + '\n', 'utf8');
    renameSync(tmp, p);
  } catch { /* 截不动就先攒着 */ }
}

/** 读全账（坏行跳过）。 */
function readAllEvents() {
  try {
    ensureSeeded();
    const p = chronFile();
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((ln) => {
        try { return JSON.parse(ln); } catch { return null; }
      })
      .filter((x) => x && x.action);
  } catch {
    return [];
  }
}

const ACTION_TEXT = { add: '记下', update: '更新', delete: '删除', evict: '淘汰', seed: '初建导入' };

function fmtTime(ts) {
  try {
    const d = new Date(Number(ts) || 0);
    const p2 = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  } catch { return String(ts); }
}

/** 翻目录：最近发生的事，倒序。 */
export function knowChronToc({ limit = 20 } = {}) {
  const n = Math.max(1, Math.min(Number(limit) || 20, 50));
  const evs = readAllEvents().slice(-n).reverse();
  if (!evs.length) return '知识史书还是空的——知识库还没记过、改过、删过任何东西。';
  return evs.map((ev) => {
    if (ev.action === 'seed') {
      return `${fmtTime(ev.ts)} 【初建导入】${String(ev.note || '知识库存量整批导入')}（${ev.count || 0} 条，明细见下面各条）`;
    }
    let ln = `${fmtTime(ev.ts)} 【${ACTION_TEXT[ev.action] || ev.action}】${ev.trigger}`;
    if (ev.action === 'update' && ev.prevSteps) ln += `\n   旧版：${String(ev.prevSteps).slice(0, 120).replace(/\n/g, ' ')}`;
    const _src = [...new Set([ev.by, ev.source].filter(Boolean))];
    if (_src.length) ln += `\n   来源：${_src.join(' / ')}`;
    return ln;
  }).join('\n');
}

/** 查史书：关键词搜所有版本（含被覆盖的旧版、被淘汰/删除的）。 */
export function knowChronSearch({ query, limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { ok: false, error: '没给关键词' };
  const qs = tokenize(q);
  const evs = readAllEvents().filter((ev) => {
    if (!qs.size) return false;
    const hay = tokenize([ev.trigger, ev.steps, ev.prevSteps].filter(Boolean).join(' '));
    for (const w of qs) if (hay.has(w)) return true;
    return false;
  });
  if (!evs.length) return { ok: true, text: `知识史书里没有和「${q}」相关的版本记录。` };
  const n = Math.max(1, Math.min(Number(limit) || 8, 20));
  const top = evs.slice(-n).reverse();
  const text = top.map((ev) => {
    let ln = `${fmtTime(ev.ts)} 【${ACTION_TEXT[ev.action] || ev.action}】${ev.trigger}\n${ev.action === 'delete' || ev.action === 'evict' ? '  （内容见上一次版本）' : '  ' + String(ev.steps || '').slice(0, 600)}`;
    if (ev.action === 'update' && ev.prevSteps) ln += `\n  ◇被覆盖的旧版：${String(ev.prevSteps).slice(0, 400)}`;
    return ln;
  }).join('\n\n');
  return { ok: true, text: `命中 ${evs.length} 笔（显示最近 ${top.length} 笔）：\n\n${text}` };
}

/** 读一条手路的完整一生：从第一次记下到每一次更新/删除/淘汰，按时间正序。 */
export function knowChronRead({ trigger, limit = 20 } = {}) {
  const key = String(trigger || '').trim().toLowerCase();
  if (!key) return { ok: false, error: '没给 trigger（照知识库里的原句）' };
  const evs = readAllEvents().filter((ev) => String(ev.trigger || '').trim().toLowerCase() === key);
  if (!evs.length) return { ok: true, text: `知识史书里没有「${trigger}」的记录——可能是在史书建立之前记的，或 trigger 措辞对不上。` };
  const n = Math.max(1, Math.min(Number(limit) || 20, 50));
  const top = evs.slice(-n);
  const text = top.map((ev, i) => {
    let ln = `第${i + 1}笔 ${fmtTime(ev.ts)} 【${ACTION_TEXT[ev.action] || ev.action}】`;
    if (ev.steps) ln += `\n${String(ev.steps).slice(0, 800)}`;
    if (ev.action === 'update' && ev.prevSteps) ln += `\n◇被覆盖的旧版：\n${String(ev.prevSteps).slice(0, 800)}`;
    return ln;
  }).join('\n\n');
  return { ok: true, text: `「${evs[0].trigger}」共 ${evs.length} 笔记录（显示最近 ${top.length} 笔，时间正序）：\n\n${text}\n\n想恢复某一版旧写法：照它的 steps 原文重新 know_add（同 trigger 覆盖），知识库立刻回到那一版。` };
}

/** 统计（面板 / 诊断用）。 */
export function knowChronStats() {
  const evs = readAllEvents();
  const c = { events: evs.length, add: 0, update: 0, delete: 0, evict: 0, seed: 0 };
  for (const ev of evs) if (c[ev.action] !== undefined) c[ev.action] += 1;
  return c;
}
