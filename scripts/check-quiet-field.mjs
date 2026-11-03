import * as A from 'file:///D:/小鱼Agent/src/agents.mjs';

let ok = 0;
const fail = [];
const chk = (name, cond, extra) => {
  if (cond) { ok++; console.log('  [ok] ' + name + (extra ? '  ' + extra : '')); }
  else { fail.push(name); console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
};

console.log('=== 安静勾：显示要和行为一致 ===');

const list = A.listAgents();
const byName = Object.fromEntries(list.map((a) => [a.name, a]));

// 1. 每张卡都要有 quiet 字段（不能是 undefined，否则前端勾是空的）
for (const a of list) {
  chk(a.name + ' 有 quiet 字段', typeof a.quiet === 'boolean', 'quiet=' + a.quiet);
}

// 2. isAgentQuiet 和列表里的 quiet 必须一致
for (const a of list) {
  chk(a.name + ' 的 isAgentQuiet 与列表一致', A.isAgentQuiet(a.id) === a.quiet,
    'is=' + A.isAgentQuiet(a.id) + ' list=' + a.quiet);
}

// 3. quietAgentIds 必须和 isAgentQuiet 一致
const quietIds = A.quietAgentIds().sort();
const expectQuiet = list.filter((a) => A.isAgentQuiet(a.id)).map((a) => a.id).sort();
chk('quietAgentIds 与 isAgentQuiet 一致', JSON.stringify(quietIds) === JSON.stringify(expectQuiet),
  'ids=' + JSON.stringify(quietIds) + ' 期望=' + JSON.stringify(expectQuiet));

// 4. 主人原话：小鲸性子里没打勾 → 就该每轮都说话
chk('小鲸默认不安静（勾没打就每轮说话）', A.isAgentQuiet('xiaojing') === false,
  'isAgentQuiet(xiaojing)=' + A.isAgentQuiet('xiaojing'));

console.log('');
console.log('── 断言：' + ok + '/' + (ok + fail.length) + ' ──');
if (fail.length) { console.log('失败: ' + fail.join(', ')); process.exit(1); }
