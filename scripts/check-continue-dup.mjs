#!/usr/bin/env node
/**
 * check-continue-dup.mjs — 【主人连着发「继续」，第二条不许被吞】
 *
 * 【2026-11-17 主人报】
 *   「我发现我历史里有个继续，再发一个继续会被吞」
 *
 * 实测成因（两处，都以为自己在"防双写"，实际吞掉了主人真说的话）：
 *
 *   ① saveUserMessage：
 *        const dup = last.role==='user' && last.content===said;
 *      只看"最后一条是不是同样的话"。可那一轮往往**还没答话就被掐断**
 *      （点停止 / 断流 / 空转），尾部就停在那句「继续」上；
 *      主人再发一句「继续」是本意，被判重复 → 不写 → 屏幕上没反应。
 *
 *   ② findDupUserRef：
 *      碰到 assistant **带 tool_calls** 就 continue（当作"她还在干活、不算答过"），
 *      于是「继续 → 只调了工具 → 继续」被判成同一轮兜底重发。
 *
 * 正确判据：**只有"这一句已经拿到过回复"才算重复**。
 * 路径里的 tool_calls 只是过程，不是回复。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('chat / 连发继续');
const srv = fs.readFileSync('src/server.mjs', 'utf8');

// ① findDupUserRef 必须有「这一句答过没有」的判定
t.ok('findDupUserRef 里有 answeredSince 判定', /const answeredSince = \(fromIdx\) =>/.test(srv));
t.ok('答过的同文消息不再当重复（continue，不 return）',
  /if \(answeredSince\(k\)\) continue;/.test(srv));

// ② 不许退回「碰到 tool_calls 就 break」的老写法
{
  const i = srv.indexOf('function findDupUserRef');
  const body = i >= 0 ? srv.slice(i, i + 2600) : '';
  t.ok('不再有「带 tool_calls 就 break」的老写法', !/if \(!pm\.tool_calls\) break;/.test(body));
}

// ③ saveUserMessage 的重复判据必须带上 answeredAfterLast
t.ok('saveUserMessage 用 answeredAfterLast 参与判重',
  /const answeredAfterLast = \(\(\) => \{/.test(srv)
  && /&& answeredAfterLast,/.test(srv));

// ④ 真跑一遍：模拟「继续 → 只有工具调用 → 继续」，第二条必须能写
{
  // 把 findDupUserRef 抠出来跑（跟 check-steer-dedupe 同一套路子）
  const src = srv;
  const at = src.indexOf('function findDupUserRef');
  const end = src.indexOf('\n/**', at);
  const fnText = at >= 0 ? src.slice(at, end > at ? end : at + 2600) : '';
  let fn = null;
  try { fn = new Function(fnText + '\nreturn findDupUserRef;')(); } catch (e) { fn = null; }
  t.ok('能抠出 findDupUserRef 真跑', typeof fn === 'function');

  if (typeof fn === 'function') {
    const now = Date.now();
    const history = [
      { role: 'user', content: '继续', at: now - 60000 },
      { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'plan', arguments: '{}' } }], at: now - 59000 },
      { role: 'tool', tool_call_id: 'a', content: '清单…', at: now - 58000 },
    ];
    const r = fn(history, { role: 'user', content: '继续' }, now);
    t.ok('「继续→只有工具→继续」：第二条不被判重复', r === null, r ? '被判成重复了' : 'ok');
  }

  if (typeof fn === 'function') {
    const now = Date.now();
    const history2 = [
      { role: 'user', content: '继续', at: now - 60000 },
      { role: 'assistant', content: '好，我接着做完了。', at: now - 58000 },
    ];
    const r2 = fn(history2, { role: 'user', content: '继续' }, now);
    t.ok('「继续→她真答过→继续」：有意重发，必须能写', r2 === null, '被吞了');
  }
}

// ⑤ 历史实证：同类会话里没有「连续两条一样的 user 且中间只有工具」
t.ok('源码注释写清了这次的原因（可追溯）', /再发一个「继续」会被吞/.test(srv));

t.done();
