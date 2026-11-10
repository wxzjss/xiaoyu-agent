#!/usr/bin/env node
/**
 * 【2026-11-10 主人钦点「找并修所有有问题的文案描述与提示词」】守卫
 *
 * 这个脚本钉住本轮审查修掉的几类问题，不许复发。
 * 纯静态断言：不连 CDP、不起浏览器（历史教训：检查里连 CDP 会拖垮全量回归）。
 *
 * 五类判据（和审查时用的是同一套）：
 *   A 说了做不到 / B 说了但没有 / C 事实过时 / D 自相矛盾或误导 / E 暴露不该暴露的
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const html = read('public/index.html');
const htmlLines = html.split('\n');

/** 只取「真代码行」里的字符串字面量（注释不算 —— 注释里提历史问题是记录，不是文案） */
function userStrings(src) {
  const out = [];
  src.split('\n').forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return;
    for (const m of l.matchAll(/(['"`])([^'"`\n]{6,300}?)\1/g)) {
      const s = m[2];
      if (/[\u4e00-\u9fa5]/.test(s)) out.push({ line: i + 1, text: s });
    }
  });
  return out;
}

const userTexts = userStrings(html);
const allUserText = userTexts.map((x) => x.text).join('\n');

console.log('\n一、E 类：界面文案不许暴露本机路径 / 作者账号');
{
  const bad = userTexts.filter((u) => /C:[\\/]Users[\\/](?!<|%|\$)[A-Za-z0-9_.-]{2,}|D:[\\/]小鱼Agent/.test(u.text));
  ok(bad.length === 0, '用户文案里没有本机绝对路径', bad.slice(0, 5).map((b) => b.line + ': ' + b.text.slice(0, 80)).join('\n       '));
}

console.log('\n二、B 类：文案提到 #id / xxxBtn 时，那个元素必须真的存在');
{
  const ids = new Set();
  for (const m of html.matchAll(/\bid=["']([A-Za-z0-9_-]+)["']/g)) ids.add(m[1]);
  const missing = [];
  for (const u of userTexts) {
    for (const m of u.text.matchAll(/#([A-Za-z][A-Za-z0-9_-]{2,})|([a-z][A-Za-z0-9]*Btn)\b/g)) {
      const name = m[1] || m[2];
      if (name && !ids.has(name)) missing.push(u.line + ': ' + name + ' ← ' + u.text.slice(0, 70));
    }
  }
  ok(missing.length === 0, '文案不指向不存在的 id/按钮', missing.slice(0, 6).join('\n       '));
}

console.log('\n三、C 类：几处「写死的数字」必须和实现一致（本轮修过的）');
{
  /* ① 鱼/鲸开关已删（2026-11-02），文案不许再指「顶栏那颗按钮」 */
  ok(!/顶栏那颗按钮/.test(allUserText), '不再说「顶栏那颗按钮」（那两颗 2026-11-02 已删）');
  ok(/屋里的人/.test(allUserText), '改成指左侧「屋里的人」');

  /* ② 汇率不在设置里可改，来源是环境变量 XY_USD_PER_CNY */
  ok(!/设置里那个数/.test(allUserText), '不再说汇率「读的是设置里那个数」');
  ok(/配置里定死|界面上改不了/.test(allUserText), '汇率说明讲清了「界面改不了」');

  /* ③ QQ 重连：代码里没有 3/6/12/24/30 那套退避（重连是 SDK 自己管的） */
  ok(!/3\/6\/12\/24\/30/.test(allUserText), '不再编造「3/6/12/24/30 秒重拨」这套退避序列');

  /* ④ 协议端下载大小从来没有校验过，不许写死具体 MB */
  ok(!/大概 34MB|约 34MB/.test(allUserText), '不再写死「大概 34MB」');

  /* ⑤ 生图测连通的超时是 180 秒（src/models.mjs:594），不是 30~40 秒 */
  ok(!/30~40 秒|30-40 秒/.test(allUserText), '不再说生图测连通「要等 30~40 秒」');
  {
    const m = read('src/models.mjs');
    ok(/AbortSignal\.timeout\(180_000\)/.test(m), '生图测连通确实是 180 秒超时（文案依据）');
  }

  /* ⑥ 语音：本机已有时不许说「都在 runtime」+「占 0MB」 */
  ok(!/都在 \$\{r\.dir\}.*占 \$\{mb\(r\.bytes\)\}/.test(html), '语音不再把 runtime 路径和 0MB 拼一起');
}

console.log('\n四、D 类：语音删除文案必须区分「本机已有的」');
{
  ok(/cur\.using === '本机已有的'|r\.using === '本机已有的'/.test(html), '语音状态用了 using 字段区分来源');
  ok(/原有.*不会动|不会动.*原有/.test(allUserText), '删除前交代了「原有的不会动」');
  ok(!/省了 108 MB|约 108 MB/.test(allUserText), '不再出现写死的「108 MB」');
}

console.log('\n五、提示词：不许承诺工具里没有的能力');
{
  /* 把 tools.mjs 里真实注册的工具名抓出来 */
  const tools = read('src/tools.mjs');
  const realTools = new Set([...tools.matchAll(/name:\s*'([a-z_]+)'/g)].map((m) => m[1]));
  ok(realTools.size >= 20, 'tools.mjs 里解析到 ' + realTools.size + ' 个真实工具');

  /* persona / skills 里用反引号引用的名字，若长得像工具名（含下划线）就必须真存在 */
  const promptFiles = [
    'persona/FACTORY-PROMPT.md', 'persona/xiaoyu.md', 'persona/xiaoyu-qq.md',
    'persona/xiaoyu.original.md', 'persona/agents/pangbai.md', 'persona/agents/xiaobaixi.md',
    ...fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => 'skills/' + d.name + '/SKILL.md')
      .filter((p) => fs.existsSync(path.join(ROOT, p))),
  ];
  const fake = [];
  for (const f of promptFiles) {
    const src = read(f);
    for (const m of src.matchAll(/`([a-z][a-z0-9]*_[a-z0-9_]+)`/g)) {
      const name = m[1];
      /* 只查「像工具名」的（有下划线、且不是明显的数据字段名） */
      if (!realTools.has(name) && !/^(role|content|tool_calls|max_tokens|base_url|api_key|system_prompt|user_id|session_id|file_path|work_dir|cwd|run_id|task_id)/.test(name)) {
        fake.push(f + '  →  `' + name + '`');
      }
    }
  }
  ok(fake.length === 0, '提示词里引用的工具名都真实存在', fake.slice(0, 8).join('\n       '));
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);