/**
 * check-hint-name.mjs — 「<智能体名>正在发送消息」不许被裸文案偷家
 *
 * 【2026-11-12 主人报：提示行在【xxx正在发送消息】与【正在发送消息】之间频繁切换】
 * 真凶（真机拦截 span 写入实锤）：3 秒巡检每拍写**裸的**「正在发送消息」，
 * 秒表 tick 每秒写「<名字>正在发送消息」—— 两个写手对轰。
 * 修法：巡检改走同一个 _hintSetText(_hintWho()...) 出口。
 *
 * 钉两条（改前会红）：
 *  ① 全文件不许再有任何「裸写」正在发送消息 的 JS 赋值（静态模板那一份除外）；
 *  ② 带名字的写手至少两处（showSending + 3 秒巡检），同一个出口。
 */
import { readFileSync } from 'node:fs';

const s = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log('  [ok] ' + m + (d ? '  ' + d : '')); } else { fail++; console.log('  [!!] ' + m + (d ? '  ' + d : '')); } };

/* ① 裸赋值（= '正在发送消息'，前面不是别的字）一个都不许有 */
const bare = [];
{
  const re = /textContent\s*=\s*['"]正在发送消息['"]/g;
  let m;
  while ((m = re.exec(s))) bare.push(s.slice(0, m.index).split('\n').length);
}
ok('没有裸写「正在发送消息」的赋值', bare.length === 0, bare.map((n) => 'L' + n).join(' '));

/* ② 带名字的写手走同一出口，至少 2 处 */
const named = (s.match(/_hintSetText\(_hintWho\(\) \+ '正在发送消息'\)/g) || []).length;
ok('带名字的写手走 _hintSetText(_hintWho()…)（showSending + 3 秒巡检）', named >= 2, '共 ' + named + ' 处');

console.log('\n── 提示行名字：' + pass + '/' + (pass + fail) + (fail ? ' 有失败' : ' 全过') + ' ──');
process.exit(fail ? 1 : 0);
