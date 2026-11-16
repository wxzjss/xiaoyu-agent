/**
 * check-stall-and-resume.mjs — 守两件事（2026-11-16 主人报的两个问题）。
 *
 * ① 「我发子Agent跑回归时有非常大概率会卡住」
 *    真因：子Agent 等上游回话的静默上限沿用主轮的 8 分钟（LLM_IDLE_MS），
 *    期间 progress 一个字都不写 —— 界面上就是「干活中」一动不动，
 *    和真卡死分不出来。修法：子Agent 单独 2 分钟上限 + 等的时候写心跳 +
 *    超时后允许换连接重试（但主人喊停不重试）。
 *
 * ② 「重启续上时会把我说过的话再以我的署名发一遍给ai吗？」
 *    界面不会（前端过滤 context），但提示一直留在 session.messages 里：
 *    收尾摘除的判据写的是「程序崩了，进程被强杀」，而正文是
 *    「上一轮跑到一半被打断了…」—— 条件永不成立，实测攒了 36 条。
 *    修法：判据按真实文案 + 启动时清一次存量。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const llm = readFileSync(new URL('../src/llm.mjs', import.meta.url), 'utf8');
const sub = readFileSync(new URL('../src/subagent.mjs', import.meta.url), 'utf8');
const srv = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const agent = readFileSync(new URL('../src/agent.mjs', import.meta.url), 'utf8');
const items = readFileSync(new URL('../src-ui/items.js', import.meta.url), 'utf8');

let pass = 0;
let fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/* ── ① 子Agent 的「等上游」上限 ─────────────────────────── */
ok('llm.streamChat 接受 idleMs 参数', /function\* streamChat\(\{[^}]*idleMs[^}]*\}\)/.test(llm));
ok('idleMs 不传时维持主轮那套（LLM_IDLE_MS）',
  /_idleCap = [^;]*idleMs[^;]*\?\s*Number\(idleMs\)\s*:\s*LLM_IDLE_MS/.test(llm));
ok('等响应头那一步用的是 _idleCap（不再写死 LLM_IDLE_MS）',
  /_idleCap,\s*\n\s*\{ what: '等上游开始回话' \}/.test(llm));
ok('吐字期看门狗也用 _idleCap', /limitMs: _idleCap/.test(llm));

ok('子Agent 声明了 SUB_IDLE_MS', /const SUB_IDLE_MS =/.test(sub));
{
  const m = /const SUB_IDLE_MS =[\s\S]{0,160}?:\s*(\d+)\s*\*\s*60\s*\*\s*1000/.exec(sub);
  const mins = m ? Number(m[1]) : NaN;
  ok('SUB_IDLE_MS 不超过 5 分钟（再长就是「看着卡住」）', Number.isFinite(mins) && mins <= 5, '解析到 ' + mins + ' 分钟');
}
ok('子Agent 调 streamChat 时传了 idleMs', /idleMs: SUB_IDLE_MS/.test(sub));

ok('等上游期间有心跳（写 progress，别让她看起来像死了）',
  /等上游回话…（已 /.test(sub));
ok('心跳定时器在 finally 里清掉（不然后续轮会被继续写）',
  /\} finally \{[\s\S]{0,200}clearInterval\(_waitTimer\)/.test(sub));
ok('收到第一个事件就停心跳', /_waitBeats = -1/.test(sub));

ok('等上游超时算「可重试」（换一条连接往往就通了）',
  /_stalled =/.test(sub) && /_retriable = !_userStopped && \(_stalled \|\| _netBroken\)/.test(sub));
ok('主人喊停 / 整轮超时不许重试（别把停了的活又拉起来）',
  /_userStopped = _stopReason === 'stop' \|\| _stopReason === 'timeout'/.test(sub));
ok('连接类错误补了 UND_ERR_CONNECT_TIMEOUT / ECONNREFUSED', /UND_ERR_CONNECT_TIMEOUT/.test(sub));

/* 主轮不许跟着变短 —— 模型深想是正常的，8 分钟是给它的 */
{
  const call = agent.slice(agent.indexOf('for await (const ev of streamChat({'));
  const head = call.slice(0, 400);
  ok('主轮（agent.mjs）不传 idleMs，维持 8 分钟', !/idleMs:/.test(head));
}

/* ── ② 续跑引子不许留在历史里 ───────────────────────────── */
ok('收尾判据按真实文案（两种历史文案都覆盖）',
  /_resumeMarks = \['（上一轮跑到一半被打断了', '程序崩了，进程被强杀'\]/.test(srv));
ok('收尾用 _resumeMarks.some 逐条摘（不是写死一句话）',
  /_resumeMarks\.some\(\(mk\) => _c\.includes\(mk\)\)/.test(srv));
ok('启动时清一次存量', /sweepResumeHintResidue\(\)/.test(srv) && /function sweepResumeHintResidue\(\)/.test(srv));
ok('清理只动带 context 的 user 条目（不能误删早期摘要）',
  /if \(!m \|\| !m\.context \|\| m\.role !== 'user'\) continue;/.test(srv));
ok('前端不画 context 条目（所以界面上不会「再以我的署名发一遍」）',
  /turn\.context/.test(items));

/* ── ②.5 退出记账不许把「本来就该续」的降级成清单老账 ──────
 *
 * 【2026-11-16 主人让核查「有没有没续上的」——查出来一个】
 * 检查鱼（smvwf26l5ap3c）11:21:30 被续上，准备耗时 104 秒；可第二个进程 11:23:13
 * 已经起来了，退出记账在 11:23:14 跑 —— 那一刻它还没进 runningTurns（准备中），
 * `_qlive` 是 null，于是记成「清单老账」+ autoResume=false。下一个进程只续
 * autoResume=true 的，它就再没人管了：断点还在，但永远不会自动接上。
 *
 * 修法：继承盘上原有那条账的 autoResume。 */
ok('退出记账会继承「原本就该续」（_shouldAuto）',
  /const _shouldAuto = Boolean\(_qlive\) \|\| Boolean\(_prev && _prev\.autoResume === true\)/.test(srv));
ok('autoResume 用的是继承后的值（不是裸 Boolean(_qlive)）',
  /autoResume: _shouldAuto,/.test(srv) && !/autoResume: Boolean\(_qlive\),/.test(srv));

/* ── ③ 动态：库里不许有「早就该摘掉」的残留 ────────────────
 * 只查「文件 10 分钟没动过」的会话 —— 正在跑的那一轮还没来得及收尾，
 * 它的引子是正常存在的，不能算残留。 */
{
  const DIR = join(process.env.APPDATA || '', '小鱼Agent', 'data', '.state', 'sessions');
  let stale = 0;
  let sessions = 0;
  try {
    const now = Date.now();
    for (const f of readdirSync(DIR).filter((x) => x.endsWith('.json') && !x.startsWith('_'))) {
      const full = join(DIR, f);
      let st = null;
      try { st = statSync(full); } catch { continue; }
      if (now - st.mtimeMs < 10 * 60 * 1000) continue;      // 还在动，跳过
      let j = null;
      try { j = JSON.parse(readFileSync(full, 'utf8')); } catch { continue; }
      sessions += 1;
      const bad = (j.messages || []).filter((m) => m && m.context && m.role === 'user'
        && /上一轮跑到一半被打断了|程序崩了，进程被强杀/.test(String(m.content || ''))).length;
      if (bad) { stale += bad; console.log('       ' + f.slice(0, 14) + ' 残留 ' + bad + ' 条'); }
    }
  } catch { /* 没有目录（新机器）就跳过 */ }
  ok('静止会话里没有续跑引子残留', stale === 0, '查到 ' + stale + ' 条（检查了 ' + sessions + ' 个静止会话）');
}

console.log('\n子Agent 卡顿 + 续跑引子：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
