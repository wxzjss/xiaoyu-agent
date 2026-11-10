/**
 * 【定时器守卫：跑完一轮不许留下存活的 setInterval】
 *
 * 为什么要这条检查（2026-11-09 的教训）：
 *
 * `stalledPromise()` 里那个 setInterval 原来**只在看门狗开火时**才被 clear。
 * 可绝大多数情况是 `it.next()` 先赢 —— 那个 interval 就没人管，而且它
 * 故意不能 unref（unref 了进程闲着时压根不跑，race 就白等）。
 *
 * 后果：**每读一块流就漏一个永久定时器**（每 800ms 空转一次）。
 * 服务端是长驻进程，等于「越聊越漏」；表现出来是进程永远退不出去。
 * 实测方式很朴素：本地假网关跑一遍 streamChat，脚本挂到超时被杀。
 *
 * 现在 `stalledPromise` 返回的 promise 上挂了 `stop()`，`guardedStream`
 * 在 race 有结果后于 finally 里收掉它。这条检查就是给那个修法上锁：
 *
 *   ① 把全局 setInterval / clearInterval 打桩，记账每个还活着的定时器
 *   ② 拿假的流跑三种真实场景（正常读完 / 中途放弃 / 看门狗开火）
 *   ③ 断言：跑完之后，账上一个活着的 interval 都不许剩
 *
 * 这个检查**不联网**、不碰 8788、不起服务，纯本地。
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('deadline / 定时器不许泄漏');

/* ══════════════════════════════════════════════════════════
   打桩：从这一刻起，每个 setInterval 都要记账
   ══════════════════════════════════════════════════════════ */
const REAL_SET = globalThis.setInterval;
const REAL_CLEAR = globalThis.clearInterval;

/** 现在活着的 interval 句柄 */
const ALIVE = new Set();
let created = 0;
let cleared = 0;

globalThis.setInterval = function patchedSetInterval(fn, ms, ...rest) {
  const h = REAL_SET(fn, ms, ...rest);
  created++;
  ALIVE.add(h);
  return h;
};
globalThis.clearInterval = function patchedClearInterval(h) {
  if (ALIVE.delete(h)) cleared++;
  return REAL_CLEAR(h);
};

function restore() {
  globalThis.setInterval = REAL_SET;
  globalThis.clearInterval = REAL_CLEAR;
}

function aliveNow() {
  /* 只数真正还在跑的那些：被 clear 掉的句柄在 Node 里也不会再触发 */
  return ALIVE.size;
}

try {
  const { guardedStream, stallGuard } = await import('../src/deadline.mjs');

  /* ── 假流：能吐 n 块，然后正常结束 ─────────────────────── */
  function makeStream(chunks) {
    let i = 0;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            if (i >= chunks) return { done: true, value: undefined };
            i++;
            return { done: false, value: '块' + i };
          },
          async return() {
            i = chunks;
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  /* ── 假流：永远不动（专治「看门狗该开火」那条路）───────── */
  function makeStuckStream() {
    return {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise(() => {}); // 永不 settle
          },
          async return() {
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  async function drain(stream, guard, { abandonAfter = 0 } = {}) {
    const got = [];
    for await (const c of guardedStream(stream, guard)) {
      got.push(c);
      if (abandonAfter && got.length >= abandonAfter) break; // 模拟调用方不收尾
    }
    return got;
  }

  /* ══════════════════════════════════════════════════════════
     ① 正常读完：这块最常发生 —— 也是原来泄漏最狠的那条路
     ══════════════════════════════════════════════════════════ */
  const before1 = created;
  const guard1 = stallGuard({ what: '测试-正常读', limitMs: 5000 });
  const got1 = await drain(makeStream(50), guard1);
  t.ok('① 正常读完 50 块，内容都收到了', got1.length === 50, String(got1.length));
  t.ok('① 跑完没有存活的 interval', aliveNow() === 0, '活着 ' + aliveNow() + ' 个');
  t.ok('① 中途确实建过 interval（证明桩子接上了）', created - before1 > 0, '+' + (created - before1));

  /* ══════════════════════════════════════════════════════════
     ② 调用方不收尾就跑（break）：finally 也得把定时器收干净
     ══════════════════════════════════════════════════════════ */
  const guard2 = stallGuard({ what: '测试-中途放弃', limitMs: 5000 });
  const got2 = await drain(makeStream(50), guard2, { abandonAfter: 5 });
  t.ok('② 只收到 5 块就走了', got2.length === 5, String(got2.length));
  t.ok('② 中途放弃也不留 interval', aliveNow() === 0, '活着 ' + aliveNow() + ' 个');

  /* ══════════════════════════════════════════════════════════
     ③ 看门狗开火：流永远不动
     ══════════════════════════════════════════════════════════ */
  const guard3 = stallGuard({ what: '测试-僵死', limitMs: 300 });
  let stalledErr = null;
  try {
    await drain(makeStuckStream(), guard3);
  } catch (e) {
    stalledErr = e;
  }
  t.ok('③ 僵死的流会被看门狗掐断（不是永远挂着）', Boolean(stalledErr), String(stalledErr?.message ?? '').slice(0, 60));
  t.ok('③ 抛出来的是超时错误', Boolean(stalledErr?.isTimeout), String(stalledErr?.isTimeout));
  t.ok('③ 掐断之后没有存活的 interval', aliveNow() === 0, '活着 ' + aliveNow() + ' 个');

  /* ══════════════════════════════════════════════════════════
     ④ 反复跑 20 轮：账上不许越攒越多（这是「每块漏一个」的正面证据）
     ══════════════════════════════════════════════════════════ */
  for (let k = 0; k < 20; k++) {
    const g = stallGuard({ what: '测试-反复' + k, limitMs: 5000 });
    await drain(makeStream(10), g);
  }
  t.ok('④ 连跑 20 轮 × 10 块之后，存活 interval 仍是 0',
    aliveNow() === 0, '活着 ' + aliveNow() + ' 个');

  /* ══════════════════════════════════════════════════════════
     ⑤ 源码上锁：修法本身不许被人「顺手简化」掉
     ══════════════════════════════════════════════════════════ */
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'deadline.mjs'), 'utf8');
  t.ok('⑤ stalledPromise 仍然带 stop()', /stalled\.stop\s*=\s*\(\)\s*=>/.test(src));
  t.ok('⑤ guardedStream 在 finally 里调了 stalled.stop()', /finally\s*\{[\s\S]{0,120}?stalled\.stop\(\)/.test(src));
  t.ok('⑤ 每轮都自己拿住叫醒器（不是直接塞进 race）',
    /const stalled = stalledPromise\(guard, tickMs\);/.test(src)
    && !/Race\(\[it\.next\(\), stalledPromise\(/.test(src));

  /* ══════════════════════════════════════════════════════════
     ⑥ 记账总数：建了多少、清了多少，差值为 0
     ══════════════════════════════════════════════════════════ */
  t.ok('⑥ 建了的 interval 全部被清掉（账平）',
    created === cleared, '建 ' + created + ' / 清 ' + cleared);
} catch (err) {
  t.ok('检查脚本本身没崩', false, String((err && err.stack) || err));
} finally {
  restore();
  t.done();
}
