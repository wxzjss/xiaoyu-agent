#!/usr/bin/env node
/**
 * 站岗：知识库·书架（2026-11-12 主人钦点）
 *
 * 主人原话：
 *   「界面上方增加一个【知识库】按钮，点击后打开一个新界面，在里面可以
 *    【创建知识卡】【导入知识卡】【导出知识卡】，每个知识卡上都有
 *    【编辑知识卡】【复制提示词】按钮，点击创建后是一个可以填写知识卡
 *    标题、作者名、知识内容的界面。这就像【岁月史书】一样，可供所有
 *    会话的智能体浏览创建、学习里面的知识。」
 *   「打开后是一个大界面，像一个书架一样，里的知识卡是书的UI外观」
 *
 * 钉三层：服务端模块/路由、工具、前端书架。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label, detail ? '｜' + detail : ''); }
  else { fail++; console.log('  ❌', label, detail ? '｜' + detail : ''); }
}

const kb = readFileSync(join(ROOT, 'src', 'knowledge.mjs'), 'utf8');
const server = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8');
const tools = readFileSync(join(ROOT, 'src', 'tools.mjs'), 'utf8');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');

console.log('\n知识库·书架：\n');

/* ── ① 服务端模块 ── */
ok('卡结构带 title/author/content/tags/createdAt/updatedAt',
  /id, title, author, content, tags, createdAt, updatedAt/.test(kb));
ok('存储落 .state/knowledge/cards.json',
  /knowledge['"],\s*'cards\.json|'\.state',\s*'knowledge'/.test(kb.replace(/\s+/g, ' ')) || /join\(config\.dataDir, '\.state', 'knowledge'\)/.test(kb));
ok('首次初始化写入内置踩坑卡（seed）',
  /DEFAULT_CARDS/.test(kb) && /export function initKnowledge/.test(kb) && /existsSync\(FILE\)\) return;/.test(kb));
ok('导入：同 id 较新者胜、其余追加（added/updated 回执）',
  /export function importCards/.test(kb) && /added,\s*updated/.test(kb));
ok('导出与导入同一格式（闭环）',
  /export function exportCards/.test(kb) && /\{ v: SCHEMA_VERSION, exportedAt/.test(kb));
ok('智能体浏览文本 digestForAgent（目录+精读两路）',
  /export function digestForAgent\(query, id/.test(kb));

/* ── ② server 路由与启动 ── */
ok('旧书架 6 条 /api/knowledge/* 路由已删除',
  /* 只认「真正的路由定义」（url.pathname === '/api/knowledge…'），
   * 注释里提到这个名字不算 —— 注释本来就要留着讲历史。 */
  !/url\.pathname\s*===\s*'\/api\/knowledge/.test(server));
ok('server 只从 knowledge.mjs 引 initKnowledge（其余函数已无调用方）',
  server.includes("import { initKnowledge } from './knowledge.mjs'"));