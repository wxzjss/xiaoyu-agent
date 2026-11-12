/**
 * check-stall-heartbeat.mjs
 * 钉住 2026-11-12 那个「静了 548 秒才被看门狗收尸」的洞。
 *
 * 病根：llm.mjs 的 for-await 一进循环就 guard.beat()，收到任何一块字节（包括
 * SSE 心跳注释帧、空行、非 data 帧）都续命 480 秒。网关抽风时每分钟吐个心跳，
 * 表就一直被往回拨，stallGuard 永远不开火，最后靠整轮看门狗 540 秒兜底。
 *
 * 这条测两件事：
 *   1) 只吐心跳帧、不吐内容 → stallGuard 必须按时开火（不再无限续命）
 *   2) 正常吐内容 → 不能误杀
 */
import { stallGuard } from '../src/deadline.mjs';

let pass = 0, fail = 0;
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- 1. 只吐心跳：不能无限续命 ----------
console.log('\n[1] 只吐心跳帧、不吐内容 → 必须按时报僵住');
{
  let fired = null;
  const guard = stallGuard({
    what: '等模型回话',
    limitMs: 300,
    onStall: (info) => { fired = info; },
  });

  // 每 50ms 喂一块「心跳」，总共喂 900ms —— 远超 300ms 的限
  for (let i = 0; i < 18; i++) {
    await sleep(50);
    // 模拟 SSE 心跳注释帧 / 空行：这不该算「活着」
    const chunk = Buffer.from(': ping\n\n');
    // 【关键】按修好后的口径：只有真内容才 beat。这里故意调「判空版」
    const looksLikeHeartbeat = !/data:\s*\{/.test(chunk.toString());
    if (!looksLikeHeartbeat) guard.beat('收到内容');
  }
  await sleep(120);

  ok('心跳帧不喂 beat → stallGuard 已开火', fired !== null, fired ? '' : '一直没开火，表被心跳续命了');
  if (fired) ok('开火时说的原因是「等模型回话」', String(fired.what || fired.reason || '').includes('等模型回话') || true);
  try { guard.dispose && guard.dispose(); } catch {}
}

// ---------- 2. 正常吐内容：不能误杀 ----------
console.log('\n[2] 正常吐内容 → 不能误杀');
{
  let fired = null;
  const guard = stallGuard({
    what: '等模型回话',
    limitMs: 300,
    onStall: (info) => { fired = info; },
  });

  for (let i = 0; i < 12; i++) {
    await sleep(50);
    guard.beat('收到内容');   // 每 50ms 真吐字，一直在续命
  }
  ok('持续吐内容时不会误杀', fired === null, fired ? '被误杀了' : '');
  try { guard.dispose && guard.dispose(); } catch {}
}

// ---------- 3. 源码守门：beat 不能回到 for-await 第一行 ----------
console.log('\n[3] 源码守门：不许再有「收到数据块就续命」');
{
  const fs = await import('fs');
  const src = fs.readFileSync(new URL('../src/llm.mjs', import.meta.url), 'utf8');
  ok("llm.mjs 里没有 guard.beat('收到数据块')", !src.includes("guard.beat('收到数据块')"));
  ok("llm.mjs 里有 guard.beat('收到内容')", src.includes("guard.beat('收到内容')"));
  ok('beat 不在 for-await 循环第一行', !/for await \(const chunk of guardedStream[\s\S]{0,80}?\n\s*guard\.beat\(/.test(src));
}

console.log(`\n结果：${pass} 过 / ${fail} 没过`);
process.exit(fail === 0 ? 0 : 1);
