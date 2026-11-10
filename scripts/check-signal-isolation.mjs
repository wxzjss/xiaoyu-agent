/**
 * 守卫：子智能体的「这一轮上下文」不许串到别的会话去。
 *
 * 【这个脚本钉的是什么】
 *
 * 2026-11-10 审计实测发现的 P0：`subagent.mjs` 用的是 `setToolContext()` /
 * `pushToolContext()`，**两个都只写全局 `CTX`**；而读侧 `ctxNow()` 优先读
 * AsyncLocalStorage。于是在真实链路里（server 先把整轮包进 ALS，再进 subagent）
 * 子智能体的上下文切换**整个是空操作**，只能从全局 `CTX` 兜底。
 *
 * 兜底的结果分三类，全部实测过：
 *
 *   · 兜到**别人的** —— `snap` / `signal`
 *     `signal` 串了最要命：`run_command` 是唯一真的消费 signal 的工具，
 *     它收到 abort 会 `taskkill /T /F` 杀整棵进程树。所以
 *     **B 会话点「停止」→ A 会话的 worker 正在跑的命令被杀掉**。
 *     反过来 A 点停止，A 自己的 worker 照跑（它拿的是 B 的 signal）。
 *   · 兜**不到** —— `outbox` / `stashFile` / `subagentDepth`
 *     （全局初值就是 null，继承不到）
 *   · 兜到且正确 —— `pushEvent` / `wakePeer`（进程级单例，本来就不按会话分）
 *
 * 【为什么这个脚本现在是红的】
 *
 * **这是故意的。** 它钉的是「应该是什么样」，不是「现在是什么样」。
 * 修好之前它会一直红 —— 红着比悄悄错着好：这条 bug 的表现是
 * 「另一个会话点停止，这边的命令莫名其妙被杀了」，不写脚本根本没人能复现。
 *
 * 修完之后它应该转绿；转绿之前**不许**把它从 run-all-checks 里摘掉。
 *
 * 【跑法】
 *   node scripts/check-signal-isolation.mjs
 *
 * 纯内存 + 临时数据目录，不起服务、不联网、不碰主人真实的 .state。
 */
import { mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

/* ---------------------------------------------------------------- 断言小工具 */

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  [ok] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
};

/* ---------------------------------------------------------------- 临时数据目录 */

const TMP = join(tmpdir(), 'xy-signal-iso-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6));
mkdirSync(join(TMP, '.state'), { recursive: true });
process.env.MINI_AGENT_DATA = TMP;

const T = await import(pathToFileURL(join(ROOT, 'src', 'tools.mjs')).href);

/** 造一个「能看出是谁的」signal，方便断言串没串 */
function mkSignal(tag) {
  const ac = new AbortController();
  ac.signal._ownerTag = tag;        // 只用来断言身份，不参与行为
  return ac;
}

/** 取「这条链路上」的值，null / undefined 都算没有 */
const got = (v) => v !== null && v !== undefined;

try {
  console.log('=== 1. 基线：外层 ALS 里的值必须都在 ===');
  const sigA = mkSignal('A');
  const boxA = [];

  await T.runWithToolContext(
    { sessionId: 'SESS-A', snap: { owner: 'A' }, signal: sigA.signal, outbox: boxA, pushEvent: () => {}, stashFile: () => {} },
    async () => {
      const c = T.ctxNow();
      check('外层 sessionId', c.sessionId === 'SESS-A', 'got=' + c.sessionId);
      check('外层 snap.owner', c.snap && c.snap.owner === 'A');
      check('外层 signal 是 A 的', c.signal && c.signal._ownerTag === 'A');
      check('外层 outbox 是那一份（引用相同）', c.outbox === boxA);
      check('外层 stashFile 有值', typeof c.stashFile === 'function');

      /* ------------------------------------------------------------ 2. 嵌套只传 sessionId */
      console.log('');
      console.log('=== 2. 嵌套 ALS：内层只传 sessionId 时，继承不到外层的 5 个字段 ===');
      console.log('    （这是 subagent 的写法：runWithToolContext({sessionId: subId})）');

      await T.runWithToolContext({ sessionId: 'SESS-A-SUB' }, async () => {
        const s = T.ctxNow();
        check('内层 sessionId 是自己传进去的', s.sessionId === 'SESS-A-SUB', 'got=' + s.sessionId);

        /* 【这几条是「期望」不是「现状」】
         * 想要的语义是「worker 是父会话的手，父层的 snap / signal / stashFile
         * 应该跟着走」。所以断言的是「拿得到且是父层那一份」。
         * 现在会红 —— 因为嵌套只从全局 CTX 兜，兜不到就说 null。 */
        check(
          '期望：内层 snap 继承父层（现在会红）',
          s.snap && s.snap.owner === 'A',
          got(s.snap) ? 'snap=' + JSON.stringify(s.snap) : 'snap=null（继承不到）',
        );
        check(
          '期望：内层 signal 是父层那一个（现在会红）',
          s.signal && s.signal._ownerTag === 'A',
          got(s.signal) ? 'signal 有值但不是父层的' : 'signal=null（继承不到）',
        );
        check(
          '期望：内层 stashFile 继承父层（现在会红）',
          typeof s.stashFile === 'function',
          got(s.stashFile) ? '' : 'stashFile=null（继承不到）',
        );
      });

      /* ------------------------------------------------------------ 3. 并发：signal 不许串到别的会话 */
      console.log('');
      console.log('=== 3. 两个会话并发各开 worker：谁的 signal 谁用（这条是 P0 的核心） ===');
      console.log('    复刻真实顺序：server 包 ALS → agent.setToolContext（写全局）→ subagent 内层');

      const sigB = mkSignal('B');
      const seen = {};

      const runWorker = async (tag) => {
        const mySig = mkSignal(tag);
        await T.runWithToolContext(
          { sessionId: 'SESS-' + tag, snap: { owner: tag }, signal: mySig.signal, outbox: [], pushEvent: () => {}, stashFile: () => {} },
          async () => {
            /* agent.mjs:615 每轮开头都会 setToolContext —— 它只写全局。
             * 两个会话并发时，后开跑的那个会把全局顶掉。 */
            T.setToolContext('SESS-' + tag, { owner: tag }, mySig.signal);
            /* 制造交错：让另一个 worker 有机会顶掉全局 */
            await new Promise((r) => setTimeout(r, tag === 'A' ? 5 : 25));
            await T.runWithToolContext({ sessionId: 'SESS-' + tag + '-SUB' }, async () => {
              const s = T.ctxNow();
              seen[tag] = {
                snapOwner: s.snap && s.snap.owner,
                sigTag: s.signal && s.signal._ownerTag,
                hasSig: got(s.signal),
              };
            });
          },
        );
      };

      await Promise.all([runWorker('A'), runWorker('B')]);

      console.log('    实测：A 的 worker 看到 snap.owner=' + seen.A.snapOwner + ' signal=' +
        (seen.A.hasSig ? seen.A.sigTag : 'null') + '；B 看到 snap.owner=' + seen.B.snapOwner +
        ' signal=' + (seen.B.hasSig ? seen.B.sigTag : 'null'));

      /* 【这条是本次最严重的后果，必须单独断言】
       * 如果 A 的 worker 拿到 B 的 signal，那么 B 点停止 → taskkill 杀掉 A 的命令。
       * 断言写成「A 的 worker 绝对不能拿到 B 的 signal」。 */
      check(
        'P0：A 的 worker 不能拿到 B 的 signal',
        !(seen.A.hasSig && seen.A.sigTag === 'B'),
        seen.A.hasSig ? 'A 拿到的是 ' + seen.A.sigTag + ' 的 signal' : 'A 拿不到 signal（另一种错，见下一条）',
      );
      check(
        'P0：A 的 worker 必须拿到 A 自己的 signal（现在会红）',
        seen.A.hasSig && seen.A.sigTag === 'A',
        'got=' + (seen.A.hasSig ? seen.A.sigTag : 'null'),
      );
      check(
        'P1：A 的 worker 的 snap 不能是 B 的',
        !(seen.A.snapOwner === 'B'),
        'A.snap.owner=' + seen.A.snapOwner,
      );

      /* ------------------------------------------------------------ 4. 显式传递时必须拿得到（防回归） */
      console.log('');
      console.log('=== 4. 显式传了字段就一定拿得到（这条是修好之后的形态，防回归） ===');

      const explicitSig = mkSignal('EXPLICIT');
      const explicitBox = [];
      await T.runWithToolContext(
        {
          sessionId: 'SESS-EXPLICIT-SUB',
          snap: { owner: 'EXPLICIT' },
          signal: explicitSig.signal,
          outbox: explicitBox,
          stashFile: () => {},
          subagentDepth: 1,
        },
        async () => {
          const s = T.ctxNow();
          check('显式传的 snap 拿得到', s.snap && s.snap.owner === 'EXPLICIT');
          check('显式传的 signal 拿得到', s.signal && s.signal._ownerTag === 'EXPLICIT');
          check('显式传的 outbox 是那一份（引用相同）', s.outbox === explicitBox);
          check('显式传的 stashFile 拿得到', typeof s.stashFile === 'function');
          check('显式传的 subagentDepth 拿得到', s.subagentDepth === 1, 'got=' + s.subagentDepth);
        },
      );
    },
  );

  /* ------------------------------------------------------------ 5. 深度计数不许被兄弟污染 */
  console.log('');
  console.log('=== 5. 并发兄弟 worker 的嵌套深度不许互相污染 ===');
  console.log('    （spawn_workers 派 3/4 件必被拒的根因就是这条）');

  const MAX = T.MAX_SUBAGENT_DEPTH;
  const depths = [];
  await T.runWithToolContext({ sessionId: 'SESS-DEPTH' }, async () => {
    const one = async (tag) => {
      /* 【2026-11-11 修·已获批】每个兄弟各开一条 ALS —— 复刻真实 worker 的形态
       * （subagent 现在给每个 worker 自己 runWithToolContext 一条 store）。
       * 不包的话两个任务共享同一个 store，bump 写的是同一格，谁也读不到
       * 各自的 1 —— 那是测试没模拟隔离层，不是实现的问题（普通写 A=2 B=1、
       * enterWith 克隆 A=1 B=2，都试过，共享 store 下无解）。 */
      await T.runWithToolContext({}, async () => {
        T.bumpSubagentDepth();
        await new Promise((r) => setTimeout(r, tag === 'A' ? 5 : 25));
        const d = T.subagentDepth();
        T.dropSubagentDepth();
        depths.push({ tag, d });
      });
    };
    await Promise.all([one('A'), one('B')]);
  });

  console.log('    实测：' + depths.map((x) => x.tag + '=' + x.d).join('  ') + '（期望都是 1，MAX=' + MAX + '）');
  check(
    '两个兄弟 worker 各自看到的深度都该是 1',
    depths.every((x) => x.d === 1),
    '实测 ' + depths.map((x) => x.tag + '=' + x.d).join(' '),
  );
  check(
    '并发深度不会顶到 MAX（否则第 3 件活直接被拒）',
    depths.every((x) => x.d < MAX),
    '实测最大 ' + Math.max(...depths.map((x) => x.d)),
  );
  check('全部结束后深度归零', T.subagentDepth() === 0, 'got=' + T.subagentDepth());
} catch (e) {
  fail++;
  console.log('  [FAIL] 脚本自身抛错：' + (e && e.message ? e.message : e));
} finally {
  try { rmSync(TMP, { recursive: true, force: true }); } catch {}
}

console.log('');
console.log('断言：' + pass + '/' + (pass + fail));
if (fail) {
  console.log('★ 失败 ' + fail + ' 条');
  console.log('');
  console.log('【这些红是预期的】子智能体的上下文串会话还没修：');
  console.log('   · signal 串了 → B 会话点停止会 taskkill 掉 A 会话的命令');
  console.log('   · snap 串了 → 回退点写进别人的会话');
  console.log('   · 深度计数是全局的 → 并发兄弟被算成嵌套，派 3 件拒第 3 件');
  console.log('修法：subagent 改成自己开 ALS（runWithToolContext），六处字段显式传。');
  console.log('修完之后这个脚本应该转绿；转绿之前不许把它从 run-all-checks 里摘掉。');
  process.exit(1);
}
console.log('PASS 子智能体的上下文彼此隔离（signal / snap / outbox / stashFile / depth 都不串）');
