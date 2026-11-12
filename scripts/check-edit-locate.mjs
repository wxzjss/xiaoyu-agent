// 改/删消息按时间戳定位 —— 防回归站岗
//
// 【2026-11-12 主人报】上下文整理把历史折短（575→384）后，界面旧气泡还挂着
// 折叠前的下标，点改/删对到别的消息甚至 system 段 ——「这句不能改」「system 那段不能删」。
// 修法：请求带 msgAt（消息时间戳，会随漂移的只有下标），服务端优先按时间戳定位。
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { locateByMsgAt, editMessage } from '../src/edit.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✅', name); }
  else { fail++; console.log('  ❌', name, extra); }
};

/* ── ① locateByMsgAt 纯单测 ─────────────────────────────── */
{
  const list = [
    { role: 'system', content: 'sys', at: 1000 },
    { role: 'user', content: 'A', at: 2000 },
    { role: 'assistant', content: 'B', at: 3000 },
    { role: 'user', content: 'C', at: 4000 },
  ];
  ok('时间戳命中正确下标', locateByMsgAt(list, 3000, -1) === 2);
  ok('at 与 _at 差 2ms 内也算命中', locateByMsgAt([{ role: 'user', content: 'x', at: 0, _at: 5000 }], 5001, -1) === 0);
  ok('同一毫秒两条取离 hint 近的', locateByMsgAt(
    [{ role: 'user', content: 'x', at: 9000 }, { role: 'user', content: 'y', at: 9000 }], 9000, 1) === 1);
  ok('时间戳无效返回 -1', locateByMsgAt(list, 0, -1) === -1 && locateByMsgAt(list, undefined, -1) === -1);
  ok('system/tool 消息不参与定位', locateByMsgAt([{ role: 'system', content: 's', at: 7000 }], 7000, -1) === -1);
}

/* ── ② editMessage 走时间戳路径（下标故意错位） ───────────── */
{
  const session = { messages: [
    { role: 'system', content: 'sys', at: 1000 },
    { role: 'user', content: '旧话A', at: 2000 },
    { role: 'assistant', content: '答B', at: 3000 },
  ] };
  // 界面以为「旧话A」在下标 1，折叠后其实还在 1 —— 反过来：折叠后它跑到 1，界面拿的是老下标 2
  const out = editMessage(session, 2, '新话A', 2000);   // 老下标 2 指到 assistant 答B
  ok('下标错位时按 msgAt 找到真正的 user 消息', out.ok === true && session.messages[1].content === '新话A');
  const out2 = editMessage(session, 99, '改答B', 3000);  // 下标越界但时间戳有效
  ok('下标越界时间戳有效也能改', out2.ok === true && session.messages[2].content === '改答B');
  const out3 = editMessage(session, 1, 'x', 99999999);   // 时间戳真不存在
  ok('时间戳不存在时给「收进摘要」人话（不再是系统消息误导）', out3.ok === false && out3.gone === true && /摘要/.test(out3.error));
}

/* ── ③ 服务端两处请求体都收 msgAt 并下传 ─────────────────── */
{
  const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf-8');
  ok('/api/sessions/edit 收 msgAt', /pathname === '\/api\/sessions\/edit'[\s\S]{0,200}msgAt/.test(server));
  ok('editMessage 调用带第四参 msgAt', /editMessage\(session, at, text, msgAt\)/.test(server));
  ok('/api/sessions/message-delete 收 msgAt 且 locateByMsgAt 定位',
    /pathname === '\/api\/sessions\/message-delete'[\s\S]{0,900}locateByMsgAt\(all, msgAt/.test(server));
}

/* ── ④ 前端三处气泡 + 删除按钮都把时间戳带上 ─────────────── */
{
  for (const f of ['src-ui/UserBubble.jsx', 'src-ui/AssistantBubble.jsx', 'src-ui/MateBubble.jsx']) {
    const s = readFileSync(new URL('../' + f, import.meta.url), 'utf-8');
    ok(f + ' EditArea 带 msgAt={it.ts}', s.includes('msgAt={it.ts}'));
  }
  const ub = readFileSync(new URL('../src-ui/UserBubble.jsx', import.meta.url), 'utf-8');
  ok('UserBubble 删除按钮带时间戳', /attachDelBtn\(w, it\.rewindId, it\.ts\)/.test(ub));
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf-8');
  ok('attachDelBtn 签名收 msgAt', /function attachDelBtn\(wrap, at, msgAt\)/.test(html));
  ok('删除请求体带 msgAt', /message-delete[\s\S]{0,400}msgAt: Number\(msgAt\)/.test(html));
}

console.log('\n改/删时间戳定位：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
