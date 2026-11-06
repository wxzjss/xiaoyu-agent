/**
 * 守一条：【思考标签不许漏进正文】
 *
 * 2026-11-06 主人报「你说话会带 <thinking> </thinking>」。
 * 根因在 llm.mjs：它逐块 stripThinkTags，标签被切在两块中间时，
 * 第一块被整段吃掉、第二块只剩孤零零的 </thinking> 被 replace，
 * 于是中间那段思考内容当成正文漏了出去，还落了盘。
 *
 * 修法是 agent.mjs 在累加完整后用全文再整体剥一次。
 * 这个脚本守五件事：
 *   ① llm.mjs 的 stripThinkTags 必须导出
 *   ② agent.mjs 必须真的在流结束后调它
 *   ③ 「拼完整再剥」对各种切法都要干净
 *   ④ sessions-core.mjs 读老会话时的入口要认结束标签
 *   ⑤ stripThinkTags 自己的入口也要认结束标签（两道门缺一不可）
 */
import fs from 'node:fs';
import { stripThinkTags } from '../src/llm.mjs';

let pass = 0;
let fail = 0;
const check = (ok, label) => {
  if (ok) { pass++; console.log('\u2714 ' + label); } else { fail++; console.log('\u2605 ' + label); }
};

// ① 导出
const llm = fs.readFileSync(new URL('../src/llm.mjs', import.meta.url), 'utf8');
check(/export function stripThinkTags\(/.test(llm), 'llm.mjs 导出了 stripThinkTags');

// ② agent.mjs 真的调了
const ag = fs.readFileSync(new URL('../src/agent.mjs', import.meta.url), 'utf8');
check(/import \{[^}]*stripThinkTags[^}]*\} from '\.\/llm\.mjs'/.test(ag), 'agent.mjs 从 llm 导入了 stripThinkTags');
check(/text = stripThinkTags\(text\);/.test(ag), 'agent.mjs 在流结束后整体剥了一次');

// ③ 各种切法都要干净
const cases = [
  { parts: ['<thinking>我在想一件事', '，还没想完</thinking>你好呀主人'], want: '你好呀主人', name: '标签切在两块中间' },
  { parts: ['<thin', 'king>想</thin', 'king>正文'], want: '正文', name: '标签本身被劈开' },
  { parts: ['正文<thinking>想', '</thinking>尾巴'], want: '正文尾巴', name: '正文前后各一段' },
  { parts: ['<thinking>', '纯思考', '</thinking>', '正文'], want: '正文', name: '四块完整包着' },
  { parts: ['<thinking>想', '</thinking>'], want: '', name: '整条只有思考' },
  { parts: ['没有标签的一句话'], want: '没有标签的一句话', name: '没有标签时原样不动' },
];
for (const c of cases) {
  const got = stripThinkTags(c.parts.join(''));
  check(got === c.want, '拼完整再剥：' + c.name);
}

// ④ 逐块剥（老做法）在第一种情况下必须确实漏
const perChunk = cases[0].parts.map((p) => stripThinkTags(p)).join('');
check(perChunk.includes('还没想完'), '（对照）逐块剥确实会漏 —— 证明修的地方是对的');

// ⑤ sessions-core 读老会话的两道门都要认结束标签
const sc = fs.readFileSync(new URL('../src/sessions-core.mjs', import.meta.url), 'utf8');
check(
  /const m2 = \{[^}]*\}|<\/\?\(thinking\|think\|reasoning\)\[\\s>\]\/i\.test\(m\.content\)/.test(sc),
  'sessions-core 读消息的入口认结束标签',
);
check(
  /if \(!\/<\\\/\?\(thinking\|think\|reasoning\)\[\\s>\]\/i\.test\(s\)\) return s;/.test(sc),
  'sessions-core 里 stripThinkTags 自己的入口也认结束标签',
);

// ⑥ 孤立结束标签真的能剥干净
check(stripThinkTags(' </thinking>\n正文') === ' \n正文', '孤立结束标签能被剥掉');
check(stripThinkTags('</THINKING>大写') === '大写', '大写结束标签也能剥');

console.log('');
console.log('断言：' + pass + '/' + (pass + fail));
if (fail) { console.log('\u2605 失败 ' + fail + ' 条'); process.exit(1); }
console.log('PASS 思考标签不会漏进正文');
