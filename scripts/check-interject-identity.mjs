/**
 * check-interject-identity.mjs —— 插话的署名不许退回「主人」
 *
 * 【主人报的 bug（2026-11-15 晚）】
 *   「切换小鲸身份和小鱼说话时没有问题，但小鱼工作时用小鲸身份插话发消息会变回主人」
 *
 * 【病根】两条路各写各的：
 *   · /api/chat（正常发消息）→ 服务端用 currentIdentity(sessionId) 现取身份，
 *     写进消息的 `_who` / `_whoId`。所以平时一切换身份就对了。
 *   · /api/interject（小鱼正在跑时插话）→ steer 进信箱，agent loop 取走 push 成
 *     user 消息。**这一整条链一个身份字段都没带**，前端只能兜底成「主人」。
 *   实测：`{text, at, atChars}` —— 没有 who。
 *
 * 这个检查钉四件事（任何一处回退都会红）：
 *   ① 信箱：steer 带 who → drainSteps 原样取回（extra 不被吞）；
 *   ② 服务端：interject 的 steer 调用里必须带 currentIdentity 取到的 who；
 *   ③ agent：把信箱条目落成消息时，_who/_whoId 必须跟着走；
 *   ④ 界面：liveToItems 认 it.who（缺了就兜底主人 —— 那正是 bug 现象）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
};

/* ── ① 信箱：extra 必须原样带回来 ─────────────────────────── */
console.log('\n[信箱] steer 带身份 → drainSteps 取回');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-inbox-who-'));
  process.env.MINI_AGENT_DATA = tmp;
  const inbox = await import('../src/inbox.mjs?t=' + Date.now());
  const sid = 'smwho_check_1';
  inbox.steer(sid, '我用小鲸身份插一句', { who: '小鲸', whoId: 'xiaojing', atChars: 12 });
  const got = inbox.drainSteps(sid);
  ok(got.length === 1, '取回 1 条', 'got=' + got.length);
  ok(got[0] && got[0].who === '小鲸', 'who 跟着回来了', JSON.stringify(got[0] && got[0].who));
  ok(got[0] && got[0].whoId === 'xiaojing', 'whoId 跟着回来了', JSON.stringify(got[0] && got[0].whoId));
  ok(got[0] && got[0].atChars === 12, 'atChars 没被吞（插话位置仍能算）', String(got[0] && got[0].atChars));
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

/* ── ② 服务端：interject 那段必须取 currentIdentity ───────── */
console.log('\n[服务端] interject → steer 带身份');
{
  const s = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
  const start = s.indexOf("if (req.method === 'POST' && url.pathname === '/api/interject')");
  ok(start > 0, '找到 interject 路由', '');
  /* 截到下一个路由定义为止，只看这一段 */
  const rest = s.slice(start);
  const endRel = rest.indexOf("url.pathname === '/api/", 40);
  const block = endRel > 0 ? rest.slice(0, endRel) : rest.slice(0, 20000);
  ok(/currentIdentity\(sessionId\)/.test(block), 'interject 里取了 currentIdentity(sessionId)');
  ok(/steer\(sessionId, message,[\s\S]{0,600}?who:/.test(block), 'steer 的 extra 里带了 who');
  ok(/const _steerEv = \{[\s\S]{0,400}?who:/.test(block), '直播清单那条 steer 事件带了 who（屏幕上那颗气泡的署名）');
}

/* ── ③ agent：落盘两条路都要带 _who ──────────────────────── */
console.log('\n[落盘] agent 把信箱条目写成消息');
{
  const a = fs.readFileSync(path.join(ROOT, 'src', 'agent.mjs'), 'utf8');
  const hits = (a.match(/_who: String\(it\.who\)/g) || []).length;
  ok(hits >= 2, '两处 push（工具轮 / 收尾 drain）都带 _who', 'hits=' + hits);
  ok(/_whoId: String\(it\.whoId\)/.test(a), '带 _whoId（重画时能认出是哪个身份）');
}

/* ── ④ 界面：认 it.who ───────────────────────────────────── */
console.log('\n[界面] 直播气泡的署名');
{
  const it = fs.readFileSync(path.join(ROOT, 'src-ui', 'items.js'), 'utf8');
  ok(/who: String\(it\.who \|\| '主人'\)/.test(it), 'liveToItems 用 it.who（服务端给了就不兜底）');
}

/* ── ⑤ 一轮**跑到一半**才切身份插话：模型那边也要看出换人了 ──
 *
 * 【2026-11-15 主人问】「切换小鲸身份发插话消息其实就是把【主人】的名字文本
 * 改成【小鲸】？还是说不能在工作过程中切换身份？」
 *
 * 实情：署名确实换了（_who），但模型读到的只是一句光秃秃的话 —— 这一轮的系统
 * 提示/重定向在开跑那一刻就定成「主人」了，于是她照样喊「主人」（截图实锤）。
 * 修法是给消息本身带 `[小鲸]` 前缀，跟 server 拼 wire 的规矩一致。 */
console.log('\n[模型视角] 半路插话也要带身份前缀');
{
  const a = fs.readFileSync(path.join(ROOT, 'src', 'agent.mjs'), 'utf8');
  ok(/const _needTag = Boolean\(_whoName\)/.test(a), '插话落地时算 needTag');
  ok(/content: _needTag \? \('\[' \+ _whoName \+ '\] ' \+ _body\) : _body/.test(a), '正文拼上 [名字] 前缀');
  ok(/_needTag \? \{ _text: String\(it\.text \|\| ''\) \}/.test(a), '原件留在 _text（气泡里不许出现方括号前缀）');
  ok(/_whoName !== '主人' && _whoName !== '小鱼'/.test(a), '主人/小鱼不自称前缀（不然就是自言自语被标成第三方）');
}

console.log('\n结果：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
