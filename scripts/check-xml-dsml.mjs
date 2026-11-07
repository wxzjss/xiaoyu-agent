/**
 * 【工具调用文本不许露到屏幕上 —— 含 DeepSeek 的 DSML 形态】
 *
 * 主人 2026-11-07：「看小鱼Agent【杂活鱼】会话，为什么输出
 *   <tool_call name="plan"><parameter name="action">update</｜｜DSML｜｜ parameter>」
 *
 * 那一条的真相（会话文件里是第 260 条，只有 77 字节、还是残缺的）：
 *   · 模型没吐原生 tool_calls，而是把调用写成了 DSML 文本
 *   · 后端兜底只在 `_xmlAcc.indexOf('<invoke') >= 0` 时才解析 —— 这里没有 <invoke，直接跳过
 *   · 解析器本身也只认 <invoke name=...>，不认 <tool_call name=...>
 *   · 前端清洗只剥 <call>/<invoke>
 *   → 三处全漏：文字画到气泡里，而且**那一轮的工具一次都没执行**，她白干一轮。
 *
 * 这个检查盯四件事：
 *   ① 解析器认得 DSML / <tool_call> / 缺闭合标签的残缺形态
 *   ② 白名单挡误判（模型讲解这段格式时不能被当成真调用）
 *   ③ 流式守护器：见到标记就扣住，不往屏幕上发；判定不成要原样补发（不吞话）
 *   ④ 前端清洗也认 <tool_call>，历史重画同样不漏
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('llm / 工具调用文本（含 DSML）');
const llmSrc = fs.readFileSync('src/llm.mjs', 'utf8');
const ui = fs.readFileSync('public/index.html', 'utf8');

const L = await import('../src/llm.mjs');

const KNOWN = new Set(['plan', 'run_command', 'read_file', 'write_file']);

// ── 1. 解析器：认得主人遇到的那一条（含残缺闭合标签） ──────────────
const REAL = '<tool_call name="plan">\n<parameter name="action">update</｜｜DSML｜｜ parameter>';
const r1 = L.parseXmlToolCalls(REAL, KNOWN);
t.ok('DSML 残缺那一条能解析出来', r1.length === 1, JSON.stringify(r1));
t.ok('工具名是 plan', r1[0] && r1[0].name === 'plan', String(r1[0] && r1[0].name));
t.ok('参数 action=update（没被 DSML 污染）',
  r1[0] && JSON.parse(r1[0].arguments).action === 'update', String(r1[0] && r1[0].arguments));

// ── 2. 原有形态不能被弄坏（回归） ────────────────────────────────
const r2 = L.parseXmlToolCalls('<invoke name="run_command"><parameter name="command">ls -la</parameter></invoke>', KNOWN);
t.ok('标准 <invoke> 仍能解析', r2.length === 1 && r2[0].name === 'run_command', JSON.stringify(r2));
t.ok('标准 <invoke> 参数正确', r2[0] && JSON.parse(r2[0].arguments).command === 'ls -la');

const r3 = L.parseXmlToolCalls('<call><invoke name="read_file"><parameter name="path">a.txt</parameter></invoke></call>', KNOWN);
t.ok('外层 <call> 包裹仍能解析', r3.length === 1 && r3[0].name === 'read_file', JSON.stringify(r3));

const r4 = L.parseXmlToolCalls('<tool_call name="write_file"><parameter name="path">b.txt</parameter></tool_call>', KNOWN);
t.ok('闭合完整的 <tool_call> 能解析', r4.length === 1 && r4[0].name === 'write_file');

// ── 3. 白名单：挡误判（这条最重要，否则「讲解」会变成「执行」） ──────
const r5 = L.parseXmlToolCalls('<tool_call name="not_a_real_tool"><parameter name="x">1</parameter></tool_call>', KNOWN);
t.ok('白名单外的工具名不执行', r5.length === 0, JSON.stringify(r5));

const r6 = L.parseXmlToolCalls('这种写法是 <tool_call> 里面放 <parameter>，没有 name 属性', KNOWN);
t.ok('纯讲解（没有 name 属性）不执行', r6.length === 0);

// ── 4. 流式守护器：见到标记就扣住，不往屏幕上发 ──────────────────
const g1 = L.createXmlCallGuard();
let out1 = g1.feed('主人这件事我得先捋一遍再说，先看清楚代码。');
out1 += g1.feed('然后再动手改。');
const out1All = out1 + g1.flush();   // flush 有副作用，只调一次
t.ok('正常文字照旧放行（尾巴留 24 字符等流结束）', g1.hit === false, 'hit=' + String(g1.hit));
t.ok('正常文字最终能全部放出来',
  out1All.indexOf('捋一遍') >= 0 && out1All.indexOf('动手改') >= 0, JSON.stringify(out1All.slice(-14)));

const g2 = L.createXmlCallGuard();
const a2 = g2.feed('好的，我调用一下。<tool_call name="plan">');
const b2 = g2.feed('<parameter name="action">update</parameter>');
t.ok('遇到标记：标记之前的文字放出去', a2 === '好的，我调用一下。', JSON.stringify(a2));
t.ok('遇到标记：标记之后一个字都不放', b2 === '', JSON.stringify(b2));
t.ok('守护器标记载住', g2.hit === true);
t.ok('被扣住的原文还在（判定不成要补发）', g2.heldText().indexOf('plan') >= 0);

const g3 = L.createXmlCallGuard();
g3.feed('<invoke name="run_command">');
t.ok('守护器也认 <invoke', g3.hit === true);

// ── 5. 源码守卫：接线不能只写一半 ────────────────────────────────
t.ok('流式文字过守护器', /_xmlGuard\.feed\(cleaned\)/.test(llmSrc));
t.ok('流结束 flush 尾巴', /_xmlGuard\.flush\(\)/.test(llmSrc));
t.ok('流结束用白名单解析', /parseXmlToolCalls\(_xmlAcc, _toolNames\)/.test(llmSrc));
t.ok('兜底触发条件认得 <tool_call>', /if \(!acc\.size && \/[\s\S]{0,40}tool_call/.test(llmSrc));
t.ok('解析不成要补发（不吞话）', /_xmlGuard\.hit && !_xc\.length/.test(llmSrc));
t.ok('白名单来自真实 tools 参数', /const _toolNames = new Set\(/.test(llmSrc));
t.ok('解析器认 DSML 标记', /DSML/.test(llmSrc));

// ── 6. 前端：历史重画那条路也要剥干净 ────────────────────────────
const uiA = ui.indexOf('function stripXmlToolCalls(input)');
const uiB = ui.indexOf('function stripCompressMemoryText');
t.ok('前端清洗函数还在', uiA > 0 && uiB > uiA);
const strip = new Function(ui.slice(uiA, uiB) + '; return stripXmlToolCalls;')();
t.ok('前端剥掉残缺 <tool_call>', strip(REAL) === '', JSON.stringify(strip(REAL)));
t.ok('前端保留标记前的话', strip('好的我看看。\n' + REAL) === '好的我看看。', JSON.stringify(strip('好的我看看。\n' + REAL)));
t.ok('前端剥掉闭合 <tool_call>',
  strip('先说一句。<tool_call name="plan"><parameter name="action">update</parameter></tool_call>') === '先说一句。');
t.ok('前端不误伤正常 HTML', strip('我写了 <div class="x">hi</div> 这段').indexOf('<div') >= 0);
t.ok('前端不误伤普通中文', strip('主人这件事我得先捋一遍。') === '主人这件事我得先捋一遍。');

// ── 7. 端到端：假上游真的吐那一段，看屏幕上还剩什么 ────────────────
// 源码守卫只证明「代码在」，证明不了「接上了」。这一段起一个假 OpenAI 兼容上游，
// 用独立数据目录跑子进程，把主人遇到的那三条 chunk 原样喂进去。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const e2ePath = join(__dir, 'e2e-dsml-upstream.mjs');
const tmpData = mkdtempSync(join(tmpdir(), 'dsml-e2e-'));
const e2e = spawnSync(process.execPath, [e2ePath], {
  cwd: join(__dir, '..'),
  env: { ...process.env, MINI_AGENT_DATA: tmpData },
  encoding: 'utf8',
  timeout: 60000,
});
try { rmSync(tmpData, { recursive: true, force: true }); } catch {}

const e2eOut = String(e2e.stdout || '') + String(e2e.stderr || '');
t.ok('端到端：假上游吐 DSML → 整体通过', e2e.status === 0, 'status=' + String(e2e.status) + ' ' + (e2e.status ? e2eOut.slice(-240) : ''));
t.ok('端到端：屏幕上没有 tool_call 残渣', /\[ok\] 屏幕上没有 tool_call 残渣/.test(e2eOut), e2eOut ? '' : '子进程没有输出');
t.ok('端到端：工具 plan 被真的交出去', /\[ok\] 工具名是 plan/.test(e2eOut));

t.done();
