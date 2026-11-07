/**
 * 续跑记录的探针（被 check-resume-multi.mjs 用独立数据目录 spawn 起来跑）。
 * 只做真事：往临时 .state 里写、读、删，把结果打成 JSON 给上面断言。
 */
import fs from 'node:fs';
import path from 'node:path';
import { markInterrupted, peekInterrupted, listInterrupted, dropInterrupted } from '../src/resume.mjs';

const DATA = process.env.MINI_AGENT_DATA;
const out = { ok: true, steps: [] };
const fail = (m) => { out.ok = false; out.steps.push('✘ ' + m); };

try {
  /* ① 两个会话各记一条 —— 老实现是后写覆盖先写，这里必须都在 */
  markInterrupted({ sessionId: 'sidA', reason: 'A 在跑', openSteps: [{ n: 1, text: 'a1' }] });
  markInterrupted({ sessionId: 'sidB', reason: 'B 在跑' });
  const all = listInterrupted();
  out.count = all.length;
  if (all.length !== 2) fail('两条应同时存在，实际 ' + all.length);
  const ids = all.map((x) => x.sessionId).sort().join(',');
  if (ids !== 'sidA,sidB') fail('会话 id 不对：' + ids);

  /* ② 指定会话能单独取到，且 intent 读得出来（白名单漏字段那个坑） */
  const a = peekInterrupted('sidA');
  out.intentA = a ? a.intent : null;
  if (!a) fail('取不到 sidA');
  else {
    if (a.intent !== 'continue') fail('intent 没读出来（白名单漏了？）实际=' + JSON.stringify(a.intent));
    if (!a.openSteps || a.openSteps.length !== 1) fail('openSteps 丢了');
  }

  /* ③ 删一条，另一条必须留着 */
  dropInterrupted('sidA');
  const after = listInterrupted();
  out.leftAfterDrop = after.map((x) => x.sessionId).join(',');
  if (after.length !== 1 || after[0].sessionId !== 'sidB') fail('只删 sidA 之后应只剩 sidB，实际 ' + out.leftAfterDrop);
  if (peekInterrupted('sidA') !== null) fail('sidA 应该已经没了');

  /* ④ 无参 peek 仍然可用（老调用点的语义） */
  const any = peekInterrupted();
  out.anyId = any ? any.sessionId : null;
  if (!any || any.sessionId !== 'sidB') fail('无参 peek 应返回剩下那条');

  /* ⑤ 旧格式（v1 单条）照样读得出来 */
  const FILE = path.join(DATA, '.state', 'resume.json');
  fs.writeFileSync(FILE, JSON.stringify({ sessionId: 'legacy', at: Date.now(), reason: '老格式', intent: 'continue' }), 'utf8');
  const leg = peekInterrupted();
  out.legacyId = leg ? leg.sessionId : null;
  if (!leg || leg.sessionId !== 'legacy') fail('v1 老格式读不出来');
  if (leg && leg.intent !== 'continue') fail('v1 的 intent 没读出来');

  /* ⑥ 清空 */
  dropInterrupted();
  if (listInterrupted().length !== 0) fail('全清之后还有残留');
} catch (e) {
  fail('抛错：' + String(e && e.message ? e.message : e));
}

console.log(JSON.stringify(out));
