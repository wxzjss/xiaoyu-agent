/**
 * XML 形态工具调用的解析测试。
 *
 * 有的模型 / 网关不用 JSON 的 tool_calls，而是把调用写成 XML 塞在正文里。
 * 后端原来只认 JSON，于是这串东西被当正文画到屏幕上、工具一次都没执行。
 * llm.mjs 里加的 parseXmlToolCalls 就是兜底。
 *
 * 这个脚本不走网络，只验解析逻辑。
 */
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../src/llm.mjs', import.meta.url), 'utf8');
const start = src.indexOf('function parseXmlToolCalls');
if (start < 0) { console.log('✘ 找不到 parseXmlToolCalls'); process.exit(1); }
// 找到函数结尾（下一个顶格 }）
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = src.slice(start, end);
const parse = new Function(fnSrc + '\nreturn parseXmlToolCalls;')();

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ✔ ' + name); } else { fail++; console.log('  ✘ ' + name); } };

// 1. 标准形态
const r1 = parse('<call><invoke name="run_command"><parameter name="command">ls -la</parameter></invoke></call>');
t('标准 <call><invoke> 能解析出 1 条', r1.length === 1);
t('工具名对', r1[0] && r1[0].name === 'run_command');
t('参数是 JSON 字符串', (() => { try { return JSON.parse(r1[0].arguments).command === 'ls -la'; } catch { return false; } })());

// 2. 没有外层 call
const r2 = parse('<invoke name="read_file"><parameter name="path">a.txt</parameter></invoke>');
t('没有 <call> 也能解析', r2.length === 1 && r2[0].name === 'read_file');

// 3. 多个 invoke
/* 【2026-11-07】名字换成真实的：新解析器加了一道「工具名像不像话」的校验
 * （挡的是模型在回复里**讲解**这段格式时被当成真调用执行）。
 * 这条测的是「多个 invoke 都认」，不是「单字母假名字也认」。 */
const r3 = parse('<invoke name="read_file"><parameter name="path">1</parameter></invoke>\n<invoke name="write_file"><parameter name="path">2</parameter></invoke>');
t('多个 invoke 都认', r3.length === 2);

// 4. 没有 invoke 的普通文字
const r4 = parse('就是一句话，没有调用');
t('普通文字返回空', Array.isArray(r4) && r4.length === 0);

// 5. 有 invoke 但没有 parameter
const r5 = parse('<invoke name="noargs"></invoke>');
t('无参数也能认', r5.length === 1 && JSON.parse(r5[0].arguments) && Object.keys(JSON.parse(r5[0].arguments)).length === 0);

// 6. 空输入不炸
t('空输入不炸', parse('').length === 0 && parse(null).length === 0);

console.log('\n结果：' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
