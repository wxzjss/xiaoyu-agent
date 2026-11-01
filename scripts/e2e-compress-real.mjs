/**
 * 端到端：压缩必须真能压下去，而且必须原地改数组（不是改一份副本）。
 *
 * 被自己坑过：改完 sessionId 作用域后压缩整个抛异常，一条没压下去，
 * 而 check-compress 是拿老会话测的，没抓到。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const base = 'C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\code\\src\\';
const m = await import('file:///' + base.replace(/\\/g, '/') + 'compress.mjs');

let pass = 0, total = 0;
const chk = (l, c, extra = '') => {
  total++;
  if (c) { pass++; console.log('  [ok] ' + l); }
  else console.log('  [FAIL] ' + l + (extra ? '  ' + extra : ''));
};

const SID = '__e2e_compress_probe__';
const NOTE = '【压缩记忆·测试】目标是验证压缩能不能真的落下去。这一路在做的是检查压缩判定口径是否与量线一致，' +
  '已经查明 estTokens 硬按 1.5、estimateTokens 带校准系数，两者差 1.6 倍，现已统一。清单：1查口径 2改代码 3跑回归。卡点：无。';

function mkMsgs(n) {
  const a = [];
  for (let i = 0; i < n; i++) {
    a.push({ role: i % 2 ? 'assistant' : 'user', content: '这是一段用来撑大上下文的测试内容。'.repeat(400) });
  }
  return a;
}

console.log('=== 1. 不给自写摘要：必须一条不动 ===');
{
  const msgs = mkMsgs(60);
  const keep = msgs.slice();
  const r = await m.compressHistory({ messages: msgs, sessionId: SID + '_a' });
  chk('没摘要就不压', r.compressed === false, 'reason=' + r.reason);
  chk('原文一条没动', msgs.length === keep.length, `${keep.length} -> ${msgs.length}`);
}

console.log('');
console.log('=== 2. 给了自写摘要：必须真压下去 ===');
{
  const msgs = mkMsgs(60);
  const beforeLen = msgs.length;
  const r = await m.compressHistory({ messages: msgs, sessionId: SID + '_b', selfNote: NOTE });
  chk('真的压了', r.compressed === true, 'reason=' + (r.reason || ''));
  chk('传入的数组被原地改小了', msgs.length < beforeLen, `${beforeLen} -> ${msgs.length}`);
  chk('token 明显降下来', r.after < r.before * 0.5, `${r.before} -> ${r.after}`);
  chk('留了摘要条', msgs.some((x) => x.summary || x.context));
  chk('摘要条在最早位置', !!(msgs[0] && (msgs[0].summary || msgs[0].context)));
  chk('尾部还留着让我接着干活', msgs.length >= 4, '剩 ' + msgs.length + ' 条');
}

console.log('');
console.log('=== 3. tool 配对不许被切断 ===');
{
  const msgs = [];
  for (let i = 0; i < 30; i++) {
    msgs.push({ role: 'user', content: '去做事' + i });
    msgs.push({
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call_' + i, type: 'function', function: { name: 'run_command', arguments: '{}' } }],
    });
    msgs.push({ role: 'tool', tool_call_id: 'call_' + i, content: '结果'.repeat(800) });
    msgs.push({ role: 'assistant', content: '做完了' + i });
  }
  const r = await m.compressHistory({ messages: msgs, sessionId: SID + '_c', selfNote: NOTE });
  let broken = 0;
  for (const msg of msgs) {
    if (msg.role === 'assistant' && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        if (!msgs.some((x) => x.role === 'tool' && x.tool_call_id === tc.id)) broken++;
      }
    }
  }
  chk('压了', r.compressed === true, 'reason=' + (r.reason || ''));
  chk('tool_calls 都能找到对应结果', broken === 0, '断了 ' + broken + ' 个');
}

// 清理测试落的折叠档
for (const suf of ['_a', '_b', '_c']) {
  const d = path.join('C:\\Users\\35453\\AppData\\Roaming\\小鱼Agent\\data\\.state\\folded', SID + suf);
  try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log('------------');
console.log('断言：' + pass + '/' + total);
console.log(pass === total ? 'PASS 全部通过' : 'FAIL 有未通过项');
process.exit(pass === total ? 0 : 1);
