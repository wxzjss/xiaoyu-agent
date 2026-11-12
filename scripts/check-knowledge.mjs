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
ok('五条路由齐：GET 列表 / GET 导出 / save / delete / import',
  /'\/api\/knowledge'/.test(server)
  && /'\/api\/knowledge\/export'/.test(server)
  && /'\/api\/knowledge\/save'/.test(server)
  && /'\/api\/knowledge\/delete'/.test(server)
  && /'\/api\/knowledge\/import'/.test(server));
ok('启动时 initKnowledge()（seed 首卡）',
  /try \{ initKnowledge\(\); \} catch/.test(server));
ok('import 已带 initKnowledge 等',
  /initKnowledge, listCards, getCard, saveCard, deleteCard, importCards, exportCards, digestForAgent/.test(server.split("from './knowledge.mjs'")[0]));

/* ── ③ 工具 ── */
ok('knowledge_browse 工具（浏览/搜索，中文 description）',
  /name: 'knowledge_browse'/.test(tools) && /翻「知识库」的书架/.test(tools));
ok('knowledge_read 工具（带 id 精读）',
  /name: 'knowledge_read'/.test(tools));
ok('knowledge_save 工具（智能体也能创建学习）',
  /name: 'knowledge_save'/.test(tools) && /带 id 且存在=更新那张卡/.test(tools));
ok('工具实现走 knowledge.mjs（不重复造轮子）',
  (tools.match(/await import\('\.\/knowledge\.mjs'\)/g) || []).length >= 3);

/* ── ④ 前端书架 ── */
ok('顶栏有【知识库】按钮（在【功能】左边）',
  /<button id="kbBtn"[^>]*>知识库<\/button>/.test(html)
  && html.indexOf('kbBtn') < html.indexOf('id="openFeatures"'));
ok('全屏书架 overlay（不是小弹窗）',
  /<div id="kbOverlay" hidden>/.test(html) && /#kbOverlay \{\s*\n\s*position: fixed; inset: 0;/.test(html));
ok('书架样式：shelf 木板 + 书（kbBook）',
  /\.kbShelf::after/.test(html) && /\.kbBook \{/.test(html));
ok('书=卡的 UI 外观（封面色按 id hash + hover 抬起）',
  /function bookColor\(id\)/.test(html) && /translateY\(-10px\) rotate\(0deg\)/.test(html));
ok('三入口齐：创建/导入/导出',
  /id="kbCreate"/.test(html) && /id="kbImport"/.test(html) && /id="kbExport"/.test(html));
ok('创建界面三件套：标题/作者名/知识内容',
  /id="kbFTitle"/.test(html) && /id="kbFAuthor"/.test(html) && /id="kbFContent"/.test(html));
ok('每卡按钮齐：编辑知识卡/复制提示词（+删除）',
  /id="kbREdit"/.test(html) && /id="kbRCopy"/.test(html) && /id="kbRDelete"/.test(html));
ok('复制提示词是「让那边智能体学习」的完整话术',
  /请学习这张知识卡（来自知识库，所有会话共享）|请学习这张知识卡/.test(html) && /学完就记在心里/.test(html));
ok('书架尽头有「＋创建」空书入口',
  /kbBookAdd/.test(html) && /创建知识卡<\/div>/.test(html.replace(/\n/g, '').replace(/\s+/g, ' ')) || /创建知识卡/.test(html));
ok('Esc 逐层退出（表单/阅读层→书架）',
  /Esc 逐层退出/.test(html));

console.log('\n知识库·书架：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
