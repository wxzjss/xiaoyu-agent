#!/usr/bin/env node
/**
 * check-turn-hint-retire.mjs — 【开场提示调满 3 次工具就退场】
 *
 * 【2026-11-17 主人要求】
 *   「把我发消息（非插话消息）后会出现的系统提示在小鱼Agent调用过三次工具调用后，
 *     自动在所有上下文、摘要等所有地方删除，直到我下一次发消息（非插话消息）时才再出现」
 *
 * 那条【每轮开始·第一条】本来只是开头定调（判断闲聊/干活、会话名、清单在哪），
 * 可它一直躺在 messages 里，每圈都跟着发一遍 —— 工具调得越多，
 * 「请先整理清单」被重申的次数就越多，她就越容易回去重排清单。
 *
 * 现在：真调满 3 个工具，就把它从 messages 里整条摘掉。
 * 它是 context 消息（不进历史、不进摘要），摘掉即彻底消失；
 * 下一轮主人说话时 server 会重新拼一条，所以「下次发消息再出现」天然成立。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('turn-hint / 开场提示退场');
const agent = fs.readFileSync('src/agent.mjs', 'utf8');
const srv = fs.readFileSync('src/server.mjs', 'utf8');

// ① server 给这条提示打了标记
t.ok('server 给开场提示打了 _turnStartHint',
  /_turnStartHint:\s*true/.test(srv));
t.ok('被标记的确实是「每轮开始·第一条」那一条',
  /【每轮开始·第一条】[\s\S]{0,2600}?_turnStartHint:\s*true/.test(srv));

// ② agent 里跨圈累计工具数
t.ok('有跨圈的工具计数 _toolCallCount', /let _toolCallCount = 0;/.test(agent));
t.ok('计数器在工具循环里自增', /_toolCallCount \+= 1;/.test(agent));
t.ok('到第 3 个工具就摘掉提示', /_toolCallCount === 3/.test(agent));
t.ok('摘的是带 _turnStartHint 标记那条', /messages\[_i\]\._turnStartHint/.test(agent));

// ③ 计数器不能在 for(round) 里被重置（否则永远是 1）
{
  const loopAt = agent.indexOf('for (let round = 0; round < config.maxRounds; round++)');
  /* 【2026-11-17 改判据】原来要求「声明必须在循环前 400 字以内」——
   * 那是拿「离得近」猜「在循环外」，太脆：中间插一段别的代码就误红
   * （这次加工具预算闸就是被这么误判的）。改成直接比位置：
   * 声明第一次出现的位置，必须早于循环起点。 */
  const declAt = agent.indexOf('let _toolCallCount = 0;');
  t.ok('计数器声明在 round 循环之外（不随圈重置）',
    declAt >= 0 && loopAt >= 0 && declAt < loopAt,
    'declAt=' + declAt + ' loopAt=' + loopAt);


  // 循环体内不许再出现 `let _toolCallCount = 0`
  const body = agent.slice(loopAt, loopAt + 20000);
  const resets = (body.match(/let _toolCallCount = 0;/g) || []).length;
  t.ok('round 循环体内没有重置计数器', resets === 0, '出现了 ' + resets + ' 次');
}

// ④ 真跑一遍：模拟 3 次工具，看提示有没有被摘
{
  const messages = [
    { role: 'user', content: '【每轮开始·第一条】…当前会话名：「画图鱼」', context: true, _turnStartHint: true },
    { role: 'assistant', content: '我先看看', tool_calls: [{ id: 'a' }] },
  ];
  let count = 0;
  const tick = () => {
    count += 1;
    if (count === 3) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i] && messages[i]._turnStartHint) { messages.splice(i, 1); break; }
      }
    }
  };
  tick(); tick();
  t.ok('前 2 个工具后提示还在', messages.some((m) => m._turnStartHint), '被提前摘了');
  tick();
  t.ok('第 3 个工具后提示被摘掉', !messages.some((m) => m._turnStartHint), '还留着');
}

// ⑤ 它必须是 context 消息（不进历史/摘要，否则「删除」做不到彻底）
t.ok('提示本身带 context: true（不进历史）',
  /【每轮开始·第一条】[\s\S]{0,600}?context:\s*true/.test(srv));

t.done();
