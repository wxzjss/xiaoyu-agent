#!/usr/bin/env node
/**
 * check-tool-out-budget.mjs — 【工具输出不许把上下文顶爆】
 *
 * 【2026-11-17 主人查上下文时揪出来的】
 * 拿桌面「小鱼的上下文.txt」跟真实生成的提示词逐段比，翻出两个洞：
 *
 *   ① `clipToolResult` 第一句 `if (typeof out !== 'string') return r;`
 *      —— 只有字符串过闸门，**对象型返回整段放行**。
 *      实测代价：查勾鱼会话里她为查「文件为什么没收到」，写脚本把整份会话
 *      dump 进工具结果，一条返回 364904 字符（会话全文才 416198，占 88%），
 *      当场顶到保命线，那一轮被掐断，她只来得及甩出半句旁白。
 *
 *   ② 单条闸只管单条（8000 字），**整轮没有总预算**。
 *      一轮调 30 个工具、每条都合规，加起来 24 万字，闸门一次都不响。
 *
 * 这个哨兵钉四件事：
 *   ① 对象型返回也会被截（不再「非字符串一律放行」）；
 *   ② 对象带 text 时**只换 text，images 等字段原样保住**
 *      （video/screen 那套靠 output.images 拼多模态，压成字符串图就没了）；
 *   ③ 没 text 的对象先序列化再截；
 *   ④ 整轮有累计预算（TOOL_OUT_TURN_BUDGET），超了就压后续结果。
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('tool / 输出预算闸');
const tools = fs.readFileSync('src/tools.mjs', 'utf8');
const agent = fs.readFileSync('src/agent.mjs', 'utf8');

/* 只看真代码，注释里写旧写法不算违规（注释要留着讲历史） */
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const toolsCode = stripComments(tools);
const agentCode = stripComments(agent);

/* ── ① clipToolResult 的判据 ── */
const at = toolsCode.indexOf('async function clipToolResult');
const fnEnd = toolsCode.indexOf('\n}', at);
const clipBody = at >= 0 ? toolsCode.slice(at, fnEnd) : '';

t.ok('找得到 clipToolResult', clipBody.length > 300);
t.ok('不再有「非字符串一律放行」', !/if \(typeof out !== 'string'\) return r;/.test(clipBody));
t.ok('有 typeof out.text 的对象分支', /typeof out\.text === 'string'/.test(clipBody));
t.ok('对象分支只换 text、不动别的字段',
  /Object\.assign\(\{\}, out, \{ text: clipped \}\)/.test(clipBody));
t.ok('没 text 的对象先序列化再截', /JSON\.stringify\(out\)/.test(clipBody));
t.ok('null / 空值安全放行', /if \(out == null\) return r;/.test(clipBody));

/* ── ② 整轮累计预算 ── */
t.ok('有整轮预算常量', /TOOL_OUT_TURN_BUDGET\s*=\s*\d+/.test(agentCode));
t.ok('有整轮累计变量', /_turnToolChars/.test(agentCode));
t.ok('有压缩函数 squeezeToolContent', /function squeezeToolContent/.test(agentCode));
t.ok('工具结果入 messages 前过了预算闸',
  /_turnToolChars \+= _len/.test(agentCode) && /squeezeToolContent\(toolContent/.test(agentCode));

/* 图片是「看见」的唯一通道，压文字可以，压图不行 */
t.ok('整轮预算压数组时图片原样保住',
  /const keep = content\.filter\(\(p\) => p && p\.type !== 'text'\)/.test(agentCode)
  && /\[{ type: 'text', text: out }, \.\.\.keep\]/.test(agentCode));

/* ── ③ 三个「整轮」计数器必须每轮归零 ── */
t.ok('_turnToolChars 每轮归零', /_turnToolChars = 0;/.test(agentCode));
t.ok('_toolCallCount 每轮归零', /_toolCallCount = 0;/.test(agentCode));
t.ok('_fillerRetried 每轮归零', /_fillerRetried = false;/.test(agentCode));

/* ── ④ 真跑一遍：五种形态 ── */
{
  const at2 = tools.indexOf('async function clipToolResult');
  const end2 = tools.indexOf('\n}\n', at2) + 2;
  const body2 = tools.slice(at2, end2);
  const harness = `
    const TOOL_OUT_MAX = 8000;
    const TOOL_OUT_READFILE = 20000;
    const TOOL_OUT_HEAD = 1200;
    const TOOL_OUT_TAIL = 900;
    const saved = [];
    async function saveToolOut(sessionId, name, text) { saved.push(text.length); return 'TMP/' + name + '.txt'; }
    ${body2}
    return { clipToolResult, saved };
  `;
  const { clipToolResult, saved } = new Function(harness)();
  const big = 'A'.repeat(30000);
  const inRange = (n) => n > 1500 && n <= 4000;

  const a = await clipToolResult('run_command', { ok: true, output: big }, 's');
  t.ok('字符串超长被截', typeof a.output === 'string' && inRange(a.output.length));

  const b = await clipToolResult('video_read', { ok: true, output: { text: big, images: ['/a.png'] } }, 's');
  t.ok('对象带 text：text 被截', typeof b.output.text === 'string' && inRange(b.output.text.length));
  t.ok('对象带 text：images 原样保住', Array.isArray(b.output.images) && b.output.images.length === 1);
  t.ok('对象带 text：形状没被压成字符串', typeof b.output === 'object' && b.output !== null);

  const c = await clipToolResult('ui_observe', { ok: true, output: { foo: big } }, 's');
  t.ok('纯对象序列化后被截', typeof c.output === 'string' && inRange(c.output.length));

  const d = await clipToolResult('say', { ok: true, output: '好的' }, 's');
  t.ok('短结果原样放行', d.output === '好的');

  const e = await clipToolResult('x', { ok: true, output: null }, 's');
  t.ok('null 不报错', e.output === null);

  t.ok('超长的三份都落了盘', saved.length === 3);
}

t.done();
