/**
 * 验收：工具调用的参数也要被瘦身。
 *
 * 【为什么要有这份】
 * 2026-11-01 量出来：「修理鱼」会话瘦身后还剩 91.8 万 token，
 * 其中 48.9 万（53% 以上）是 assistant 消息里 tool_calls 的 arguments ——
 * 比工具结果本身还大。压缩（compressHistory）不碰 assistant 的 tool_calls，
 * 瘦身（slimRoundMessages）原来也只压 role==='tool'，两边都没人管它。
 *
 * 第一版补丁只压「本轮之后」的调用，实测一点没省：from=2055，
 * 1025 次调用全在那之前。所以还得有跨轮兜底（KEEP_TOTAL_TOOLS）。
 *
 * 用法：node scripts/check-tool-call-slim.mjs
 */
import { slimRoundMessages, shrinkToolArguments, measureMessages } from '../src/turn-slim.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  \u2714 ${name}`);
  } else {
    fail++;
    console.log(`  \u2718 ${name}${extra ? '  ← ' + extra : ''}`);
  }
};
const head = (s) => {
  console.log('');
  console.log('\u2500'.repeat(60));
  console.log(s);
  console.log('\u2500'.repeat(60));
};

// ── 1. shrinkToolArguments 不能把定位线索压没 ────────────────
head('一、压参数的时候，路径/命令这些定位线索要留全');

{
  const args = JSON.stringify({
    path: 'D:/小鱼Agent/src/server.mjs',
    content: 'x'.repeat(30000),
  });
  const out = shrinkToolArguments(args);
  ok(`30k 的 content 被压短（${args.length} → ${out.length}）`, out.length < 2000, `实际 ${out.length}`);
  ok('路径一个字没丢', out.includes('D:/小鱼Agent/src/server.mjs'));
}

{
  const args = JSON.stringify({
    cmd: 'node scripts/check-ui.mjs --all',
    body: 'y'.repeat(20000),
  });
  const out = shrinkToolArguments(args);
  ok('命令行原样保留', out.includes('node scripts/check-ui.mjs --all'));
}

{
  const args = JSON.stringify({
    path: 'D:/a.mjs',
    old_string: 'a'.repeat(5000),
    new_string: 'b'.repeat(5000),
  });
  const out = shrinkToolArguments(args);
  ok(`edit 的 old/new 都被压（${args.length} → ${out.length}）`, out.length < 2000);
  ok('edit 的路径还在', out.includes('D:/a.mjs'));
  ok('压过之后还是能解析的 JSON', (() => {
    try {
      JSON.parse(out);
      return true;
    } catch {
      return false;
    }
  })());
}

{
  const short = '{"path":"a.mjs"}';
  ok('短参数一个字不动', shrinkToolArguments(short) === short);
}

// ── 2. 跨轮兜底：老调用要被压 ────────────────────────────────
head('二、老的工具调用要被压，别只看本轮');

{
  // 造 100 圈：每圈一条 assistant(带大参数) + 一条 tool 结果
  const msgs = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 100; i++) {
    msgs.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: `D:/f${i}.mjs`, content: 'z'.repeat(5000) }),
          },
        },
      ],
    });
    msgs.push({ role: 'tool', content: 'w'.repeat(3000), tool_call_id: `c${i}` });
  }
  msgs.push({ role: 'user', content: '接着说' });

  const r = slimRoundMessages(msgs, { from: msgs.length - 1 });
  const before = measureMessages(msgs);
  const after = measureMessages(r.messages);
  ok(`100 圈 → 压掉一大半（${before.chars} → ${after.chars}）`, after.chars < before.chars * 0.35, `只剩 ${(after.chars / before.chars * 100).toFixed(0)}%`);
  ok('确实改了东西', r.changed > 50, `改了 ${r.changed} 条`);

  // 最近的调用必须原样留着（模型正要用）
  const lastCall = r.messages.filter((m) => Array.isArray(m.tool_calls)).slice(-2);
  ok('最近 2 圈的调用参数原样保留', lastCall.every((m) => m.tool_calls[0].function.arguments.includes('z'.repeat(5000))));
}

// ── 3. 路径线索在压过的老调用里也还在 ────────────────────────
head('三、压过的老调用里，还是看得出改的是哪个文件');

{
  const msgs = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 40; i++) {
    msgs.push({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          function: {
            name: 'write_file',
            arguments: JSON.stringify({ path: `D:/小鱼Agent/src/mod${i}.mjs`, content: 'q'.repeat(5000) }),
          },
        },
      ],
    });
    msgs.push({ role: 'tool', content: 'ok', tool_call_id: `c${i}` });
  }
  const r = slimRoundMessages(msgs, { from: 0 });
  const first = r.messages.find((m) => Array.isArray(m.tool_calls));
  ok('第一条老调用的路径还认得出来', first.tool_calls[0].function.arguments.includes('D:/小鱼Agent/src/mod0.mjs'));
}

// ── 4. 不能改坏原数组 ────────────────────────────────────────
head('四、瘦身只动「发出去的那一份」，别改原数组');

{
  const msgs = [{ role: 'system', content: 'S' }];
  for (let i = 0; i < 40; i++) {
    msgs.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'write_file', arguments: JSON.stringify({ path: `D:/f${i}.mjs`, content: 'z'.repeat(5000) }) } }],
    });
    msgs.push({ role: 'tool', content: 'w'.repeat(3000), tool_call_id: `c${i}` });
  }
  const snapshot = JSON.stringify(msgs);
  slimRoundMessages(msgs, { from: 0 });
  ok('原 messages 一个字节没变（落盘要用它）', JSON.stringify(msgs) === snapshot);
}

console.log('');
console.log('\u2500'.repeat(60));
console.log(`结果：${pass} 项通过，${fail} 项失败`);
console.log('\u2500'.repeat(60));
process.exit(fail ? 1 : 0);
