#!/usr/bin/env node
/**
 * 【2026-11-13 #42 主人钦点】LLM 请求级重试（WorkBuddy 分类学搬运）站岗。
 *
 * 背景：主人对比两个产品——WorkBuddy 断线会显示【等待模型响应】直到连上，
 * 小鱼Agent 断了就断了。挖 WorkBuddy CLI 引擎（codebuddy-lite-wb.mjs）拿到
 * 三件套：可重试状态码 {408,429,502,503,529}、连接错误码清单、
 * 指数退避 min(base×2ⁿ,30s)±20% 抖动。本站岗钉死搬运成果，谁删谁红。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const llm = readFileSync(join(ROOT, 'src', 'llm.mjs'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' —— ' + detail : '')); }
}

/* ── ① WorkBuddy 分类学三件套都在 ── */
ok('可重试状态码清单 {408,429,502,503,504,529} 在',
  /RETRY_STATUS = new Set\(\[408, 429, 502, 503, 504, 529\]\)/.test(llm));
ok('连接错误码清单在（ECONNREFUSED/EHOSTUNREACH/UND_ERR_CONNECT_TIMEOUT/ECONNRESET…）',
  /ECONNREFUSED/.test(llm) && /EHOSTUNREACH/.test(llm) && /UND_ERR_CONNECT_TIMEOUT/.test(llm) && /UND_ERR_HEADERS_TIMEOUT/.test(llm));
ok('指数退避公式 min(base×2ⁿ,30s) ± 20% 抖动在',
  /Math\.min\(base \* 2 \*\* Math\.max\(0, attempt\), 30000\)/.test(llm)
  && /0\.2 \* raw \* \(2 \* Math\.random\(\) - 1\)/.test(llm));

/* ── ② 三件套真的被接到 streamChat 主流程 ── */
ok('连接错误有 try/catch 接住并重试（不再一抛整轮完蛋）',
  /catch \(e\) \{[\s\S]{0,200}signal\?\.aborted \|\| e\?\.name === 'AbortError'[\s\S]{0,300}isRetryableConnectError\(e\) && netRetried < NET_RETRY_MAX/.test(llm));
ok('AbortError（主人点停）绝不重试',
  /signal\?\.aborted \|\| e\?\.name === 'AbortError'\) throw e;/.test(llm));
ok('状态码重试走 isRetryableStatus（429/529 进来了）',
  /if \(isRetryableStatus\(r\.status\)\) \{[\s\S]{0,300}netRetried\+\+/.test(llm));
ok('429 带 Retry-After 头就听它指挥（封顶 120s）',
  /Number\(r\.headers\?\.get\?\.\('retry-after'\)\)[\s\S]{0,200}ra <= 120/.test(llm));
ok('重试次数上限 NET_RETRY_MAX = 5',
  /const NET_RETRY_MAX = 5;/.test(llm));

/* ── ③ 语义边界 ── */
{
  const list = (llm.match(/RETRY_STATUS = new Set\(\[([^\]]+)\]/)?.[1] ?? '').split(',').map((s) => s.trim());
  const has = (n) => list.includes(n);
  ok('409 不可重试（语义冲突重试没意义）', !has('409'));
  ok('422 不可重试（我们发的东西不合规）', !has('422'));
}
ok('用户主动停的 AbortError 不在 isStreamDropError 里（老规矩没丢）',
  /name === 'AbortError'\) return false;/.test(llm));

console.log('\nLLM 请求级重试（WorkBuddy 搬运）：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
