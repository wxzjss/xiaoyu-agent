#!/usr/bin/env node
/**
 * 守一条：【.state 下的本子不许被 BOM 咬】
 *
 * 2026-11-06 事故：用 PowerShell 的 Set-Content -Encoding utf8 写 admin-mode.json
 * 带上 EF BB BF，JSON.parse 直接抛，catch 一吞就变成空表 —— 管理员权限凭空消失
 * （表现是 read_file 报 path outside workspace，查半天查不到原因）。
 *
 * 2026-11-07 又咬一次：记忆本 memory/*.md 不在开服清扫范围内（只扫根目录 .json），
 * 写带 BOM 之后 "# 会话记忆" 不再是标题，整份本子哑掉。
 *
 * 所以这里守三件事：
 *   ① 盘上现存的 .state 文件，开头不许有 BOM
 *   ② 读端三处（session-memory / my-memory / whale-memory）都得削 BOM
 *   ③ 开服自愈要递归扫、要认 .md，不能只扫根目录 .json
 */
import fs from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
function check(ok, name, detail = '') {
  if (ok) {
    pass++;
    console.log('  ✔ ' + name);
  } else {
    fail++;
    console.log('  ✘ ' + name + (detail ? '  → ' + detail : ''));
  }
}

const STATE = 'C:/Users/35453/AppData/Roaming/小鱼Agent/data/.state';
const SRC = 'C:/Users/35453/AppData/Roaming/小鱼Agent/data/code/src';

function hasBom(p) {
  try {
    const b = fs.readFileSync(p);
    return b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf;
  } catch {
    return false;
  }
}

// ── ① 盘上现存文件不许带 BOM ──
console.log('=== 1. 盘上 .state 里的文件不许带 BOM ===');
const bad = [];
let scanned = 0;
const walk = (dir, depth) => {
  if (depth > 4) return;
  let es = [];
  try {
    es = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of es) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
        // outbox 放的是命令输出原文，本来就该原样保留，带 BOM 也照样是对的
      if (!/^(slim|archive|trash|sessions|logs|tmp|test|_history|outbox)$/i.test(e.name)) walk(p, depth + 1);
      continue;
    }
    if (!/\.(json|md|jsonl|txt)$/i.test(e.name)) continue;
    if (/\.bak|\.tmp$/i.test(e.name)) continue;
    scanned++;
    if (hasBom(p)) bad.push(p.replace(STATE, '.state'));
  }
};
walk(STATE, 0);
check(bad.length === 0, `扫了 ${scanned} 个文件，没有带 BOM 的`, bad.slice(0, 3).join(', '));

// 记忆本单独点名（这是最容易出事的）
const memDir = join(STATE, 'memory');
let memBad = [];
try {
  for (const f of fs.readdirSync(memDir)) {
    if (f.endsWith('.md') && hasBom(join(memDir, f))) memBad.push(f);
  }
} catch {}
check(memBad.length === 0, '记忆本 memory/*.md 全都不带 BOM', memBad.join(', '));

// ── ② 读端三处都要削 BOM ──
console.log('');
console.log('=== 2. 读本子的地方都得削 BOM ===');
const sm = fs.readFileSync(join(SRC, 'session-memory.mjs'), 'utf8');
check(/charCodeAt\(0\)\s*===\s*0xfeff/.test(sm), 'session-memory.readMemory 会削 BOM');
check((sm.match(/0xfeff/g) || []).length >= 2, 'session-memory.snapMemory 也削（' + (sm.match(/0xfeff/g) || []).length + ' 处）');

const mm = fs.readFileSync(join(SRC, 'my-memory.mjs'), 'utf8');
check(/function readTextNoBom/.test(mm), 'my-memory 有 readTextNoBom');
check(!/JSON\.parse\(readFileSync\(/.test(mm), 'my-memory 没有裸的 JSON.parse(readFileSync(...))');

const wm = fs.readFileSync(join(SRC, 'whale-memory.mjs'), 'utf8');
check(/function readTextNoBom/.test(wm), 'whale-memory 有 readTextNoBom');

// ── ③ 开服自愈要递归、要认 .md ──
console.log('');
console.log('=== 3. 开服自愈扫得够宽 ===');
const sv = fs.readFileSync(join(SRC, 'server.mjs'), 'utf8');
const bomBlock = sv.slice(sv.indexOf('BOM 根治'), sv.indexOf('BOM 根治') + 4200);
check(/readdirSync|__diagReaddir/.test(bomBlock), '开服清扫会列目录（递归）');
check(/md/i.test(bomBlock) && /jsonl/i.test(bomBlock), '开服清扫认 .md / .jsonl，不只 .json');
check(/depth/.test(bomBlock), '开服清扫有深度保护，不会扫穿');

// ── ④ 真做一次：造一个带 BOM 的文件，读端要能读对 ──
console.log('');
console.log('=== 4. 真造一个带 BOM 的文件，看读端认不认 ===');
const tmp = join(STATE, 'test-bom-tmp.md');
try {
  fs.writeFileSync(tmp, '\ufeff# 会话记忆\n\n内容', 'utf8');
  check(hasBom(tmp), '造出来的文件确实带 BOM');
  // 直接用 session-memory 的读法验
  const raw = fs.readFileSync(tmp, 'utf8');
  const cut = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  check(cut.startsWith('# 会话记忆'), '削过之后 "# 会话记忆" 能对上标题', JSON.stringify(cut.slice(0, 12)));
} finally {
  try {
    fs.unlinkSync(tmp);
  } catch {}
}

console.log('');
console.log('断言：' + pass + '/' + (pass + fail));
if (fail) {
  console.log('\u2605 失败 ' + fail + ' 条');
  process.exit(1);
}
console.log('PASS BOM 咬不动本子');
