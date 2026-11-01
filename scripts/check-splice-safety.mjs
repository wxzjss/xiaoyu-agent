/**
 * 严检：摘旧提醒用 messages.splice 删一条，
 * 会不会删到「tool_calls 和 tool 结果之间」，把配对弄断？
 */
import fs from 'node:fs';

const p = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\agent.mjs';
const src = fs.readFileSync(p, 'utf8');

let pass = 0, total = 0;
const chk = (l, c) => { total++; c ? (pass++, console.log('  [ok] ' + l)) : console.log('  [FAIL] ' + l); };

console.log('=== 风险分析：被删的是什么样的消息 ===');
// 量线提醒是 role:'user' + _sysNote:true，它永远不是 tool 结果，也不会带 tool_calls
chk('只删 _sysNote===true 的消息（不是 tool 结果）', /mm\._sysNote === true/.test(src));
chk('还要求内容是〔量线开头（双重收窄）', /indexOf\('〔量线'\) !== -1/.test(src));

console.log('\n=== 真跑配对校验 ===');
// 构造真实场景：assistant(tool_calls) -> tool(结果) -> 量线提醒(user) -> 下一个 assistant
function makeHistory() {
  return [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '主人的话' },
    { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'read_file' } }] },
    { role: 'tool', tool_call_id: 't1', content: '结果' },
    { role: 'user', content: '〔量线 70% 极限〕旧的', _sysNote: true },
    { role: 'assistant', content: '好的' },
  ];
}

function stripOldWarn(msgs) {
  for (let mi = msgs.length - 1; mi >= 0; mi--) {
    const mm = msgs[mi];
    if (mm && mm._sysNote === true && typeof mm.content === 'string'
        && mm.content.indexOf('〔量线') !== -1) {
      msgs.splice(mi, 1);
    }
  }
}

// 校验 tool 配对是否完整
function pairingOk(msgs) {
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const found = msgs.slice(i + 1).some((x) => x.role === 'tool' && x.tool_call_id === tc.id);
        if (!found) return false;
      }
    }
  }
  return true;
}

const h = makeHistory();
console.log('  删之前配对完整 =', pairingOk(h));
stripOldWarn(h);
console.log('  删之后条数 =', h.length);
console.log('  删之后配对完整 =', pairingOk(h));
chk('删掉量线提醒后 tool 配对依然完整', pairingOk(h));

// 极端：提醒恰好夹在 assistant(tool_calls) 和 tool 结果中间（现实中不该发生，但要保证不炸）
const h2 = [
  { role: 'assistant', content: '', tool_calls: [{ id: 't2', function: { name: 'x' } }] },
  { role: 'user', content: '〔量线 70% 极限〕夹在中间', _sysNote: true },
  { role: 'tool', tool_call_id: 't2', content: '结果' },
];
stripOldWarn(h2);
chk('即便提醒夹在配对中间，删掉后配对也不受影响（它本就不是配对成员）', pairingOk(h2));

console.log('\n────────────');
console.log(`断言：${pass}/${total}`);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
