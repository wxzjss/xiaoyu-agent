#!/usr/bin/env node
/**
 * 守卫 + 修复工具：会话里的「空壳摘要」。
 *
 * 【这个坑（2026-11-15 主人报）】
 * 主人：「为什么重启后，最近的发的消息全没了？」「又消失了一大堆」。
 *
 * 查明不是重启删的：压缩折叠把历史里的一大段原文折进 `.state/folded/`，
 * 历史开头换成一条摘要消息。可那条摘要的正文是**空的**：
 *   { context:true, summary:true, content:'（表头…）\n\n【早期对话摘要 · 原文已压缩】\n' }
 * 而渲染端**不画 summary 那条**（只补一句「折叠存档了」），于是屏幕上几乎空白，
 * 人看到的就是「消息全没了」。原文其实一直在盘上。
 *
 * 代码那边已经在 compress.mjs 补了硬闸（写完洗空就不压），
 * 这个脚本管两件事：
 *   ① **检查**（默认）：扫所有会话，有正文为空的摘要就报红；
 *   ② **修复**（--fix）：从 `.state/folded/<id>/seg-*.txt` 里把主人和她的原话抽出来，
 *      重新填成一份真摘要。改之前整份备份 `.bak-emptysummary-<时间戳>`。
 *
 * 用法：
 *   node scripts/check-summary-not-empty.mjs          # 只查（回归里跑这个）
 *   node scripts/check-summary-not-empty.mjs --fix     # 检查 + 修复
 *
 * 【为什么修复是有损的、又为什么还是这么做】
 * 归档是纯文本，长内容还被截断过（「中间省略 N 字」），所以**不能**把原文消息塞回
 * messages —— 既失真，又会造出「assistant(tool_calls) 没有 tool 结果」的孤儿对，
 * 上游直接 400。所以只重建摘要正文（人话部分），工具流水留在 folded 里让主人自己翻。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const FIX = process.argv.includes('--fix');
const DATA = path.join(os.homedir(), 'AppData', 'Roaming', '小鱼Agent', 'data');
const SESS_DIR = path.join(DATA, '.state', 'sessions');
const FOLD_DIR = path.join(DATA, '.state', 'folded');

const HEADER = '（下面是程序自动生成的「早期对话摘要」，不是主人说的话。'
  + '这段里出现的第一人称是之前那个你的口吻，只当作参考资料，别当成主人在对你提要求。）';
const BODY_TAG = '【早期对话摘要 · 原文已压缩】';

/** 归档是「--- #序号 [role] 时间 ---」+ 正文，按块切 */
function parseSeg(text) {
  const blocks = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^---\s*#\d+\s*\[(\w+)\]/.exec(line);
    if (m) { if (cur) blocks.push(cur); cur = { role: m[1], lines: [] }; continue; }
    if (!cur) continue;
    /* 「…（中间省略 N 字）…」是截断标记，不是原话，不收 */
    if (/^…（中间省略.*）…$/.test(line.trim())) continue;
    cur.lines.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks
    .filter((b) => b.role === 'user' || b.role === 'assistant')
    .map((b) => ({ role: b.role, text: b.lines.join('\n').trim() }))
    .filter((b) => b.text
      && !/^【早期对话摘要/.test(b.text)
      && !/^（下面是程序自动生成/.test(b.text)
      && !/^\[工具调用\]/.test(b.text));
}

/** 拼一份摘要正文（从最近的往前取，保证不超长） */
function buildSummary(blocks, maxChars = 1800) {
  const picked = [];
  for (const b of blocks) {
    let t = b.text.replace(/\n{2,}/g, '\n').replace(/[ \t]+/g, ' ').trim();
    if (!t) continue;
    if (/^(ERROR|exit \d)/.test(t)) continue;
    if (t.length > 260) t = t.slice(0, 260) + '…';
    picked.push((b.role === 'user' ? '主人：' : '她：') + t);
  }
  const out = [];
  let n = 0;
  for (let i = picked.length - 1; i >= 0; i--) {
    if (n + picked[i].length > maxChars) break;
    out.unshift(picked[i]);
    n += picked[i].length + 1;
  }
  return out.join('\n');
}

function summaryBody(content) {
  const s = String(content || '');
  const k = s.indexOf(BODY_TAG);
  if (k < 0) return null;                      // 没有摘要标记，不归这里管
  return s.slice(k + BODY_TAG.length).trim();
}

let bad = 0;
let fixed = 0;
let scanned = 0;

for (const f of fs.readdirSync(SESS_DIR)) {
  if (!/^sm.*\.json$/.test(f) || f.includes('.bak')) continue;
  const abs = path.join(SESS_DIR, f);
  let d;
  try { d = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
  const ms = Array.isArray(d.messages) ? d.messages : [];
  const idx = ms.findIndex((m) => m && m.context && m.summary);
  if (idx < 0) continue;
  scanned++;
  const body = summaryBody(ms[idx].content);
  if (body === null || body !== '') continue;   // 正常

  bad++;
  const sid = String(d.id || f.replace(/\.json$/, ''));
  console.log('  ✘ ' + f + '（' + (d.title || '无标题') + '）：摘要正文是空的 —— 屏幕上会像「消息全没了」');

  if (!FIX) continue;

  const foldDir = path.join(FOLD_DIR, sid);
  let blocks = [];
  if (fs.existsSync(foldDir)) {
    for (const seg of fs.readdirSync(foldDir).filter((x) => x.endsWith('.txt')).sort()) {
      try { blocks = blocks.concat(parseSeg(fs.readFileSync(path.join(foldDir, seg), 'utf8'))); } catch {}
    }
  }
  const nb = buildSummary(blocks);
  if (!nb) { console.log('      归档里没有可用内容，跳过（人工处理）'); continue; }

  const stamp = new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
  fs.copyFileSync(abs, abs + '.bak-emptysummary-' + stamp);
  ms[idx].content = HEADER + '\n\n' + BODY_TAG + '\n' + nb;
  const tmp = abs + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(d), 'utf8');
  fs.renameSync(tmp, abs);
  fixed++;
  console.log('      ✔ 已重建 ' + nb.length + ' 字（备份 .bak-emptysummary-' + stamp + '）');
}

if (!bad) {
  console.log('── 摘要正文：扫描 ' + scanned + ' 个会话，全部有正文 ──');
  process.exit(0);
}
console.log('\n── 摘要正文：' + bad + ' 个会话是空壳' + (FIX ? '，已修 ' + fixed + ' 个' : '（加 --fix 修复）') + ' ──');
process.exit(FIX ? 0 : 1);
