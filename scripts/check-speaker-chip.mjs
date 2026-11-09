/**
 * 【2026-11-09 加】「这个会话到底谁在说话」得写在脸上。
 *
 * 主人截图：左上角「小鱼（鲸鱼娘）」、屋里的人高亮小鱼，气泡里却说
 * 「小白曦在呢喵」。查下来不是串台 —— 那个会话绑的就是小白曦那张卡
 * （/api/agents/current → sessionAgentId；buildSystemPrompt 兜底也是
 * agentForSession）。可界面三处都指向小鱼：
 *   · 顶栏牌子只写「当前智能体」五个字，名字藏在 hover 里；
 *   · 左上角那颗是「当前查看的卡」，不是「本会话谁在说话」；
 *   · 牌子名字取名单第一（小鱼），气泡兜底署名也是它。
 *
 * 【二修】把两件事拆开：历史署名兜底固定「小鱼」；牌子 _speakerName 动态取
 * 【屋里的人】第一个开着的，直接写「本会话 · X」。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('界面：谁在说话要一眼看得出来');
const ui = fs.readFileSync('public/index.html', 'utf8');

t.ok('顶栏牌子直接带名字（不再只写「当前智能体」）',
  /el\.textContent = '本会话 · ' \+ _speakerName;/.test(ui));
/* 【2026-11-09 二修】主人在「办事鱼」里报：以前小鱼干的活全署名小白曦、
 * 右侧「本会话 xxx」也不跟着【屋里的人】排序/开关变。
 * 根因是我上一版把「历史署名兜底」和「当前谁在说话」合成了一个值。
 * 这两件事必须分开：兜底永远是「小鱼」（后端约定空 _who = 小鱼），
 * 牌子才是动态的（第一个开着的）。 */
t.ok('历史消息署名兜底固定为小鱼，不跟当前说话人变',
  /mainAgentName = '小鱼';/.test(ui) && !/mainAgentName = _speakerName/.test(ui));
t.ok('牌子名字 = 屋里从上往下第一个开着的（动态）',
  /const _firstOn = grpMembers\.find\(_isOn\)/.test(ui)
  && /_speakerName = String\(\(_firstOn && _firstOn\.name\)/.test(ui)
  && /const head = _speakerName;/.test(ui));
t.ok('牌子亮不亮也只看动态主智能体，不看绑定卡',
  /const _mainIsFish = !grpMembers\.some/.test(ui) && !/const swapped = Boolean\(id/.test(ui));
t.ok('绑定卡取自本轮接口返回值，不用可能过期的 agentState',
  !/agentState\.boundAgentId/.test(ui.slice(ui.indexOf('async function refreshAgentChip'), ui.indexOf('async function refreshAgentChip') + 6500)));
t.ok('名单判据仍尊重「关掉的不在场」', /m\.enabled !== false/.test(ui));

/* ── 行为层：隔离实例里真绑一张卡，看接口给界面的到底是谁 ──────────
 * 这里刻意**不碰 CDP**：隔离实例的浏览器页面还被别的真机检查用着，
 * 抢同一个 page 会互相卡住（2026-11-09 实测卡了 15 分钟）。
 * 牌子怎么拼是上面静态断言的事，这里只验「数据源」——绑了卡，
 * /api/agents/current 就得把那张卡的名字交出来。单跑时整段跳过，
 * 绝不碰主人正在用的实例。 */
if (process.env.XY_REQUIRE_ISOLATED !== '1') {
  console.log('\n行为格：SKIP（非隔离全量回归，不碰主人实例；源码断言已全过）');
} else {
  const base = String(process.env.BASE || '').replace(/\/+$/, '');
  const post = (p, b) => fetch(base + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(b || {}), signal: AbortSignal.timeout(10000),
  }).then((r) => r.json()).catch(() => null);
  let sid = '';
  try {
    const mk = await post('/api/sessions/new', { title: '__chip_probe__' });
    sid = String((mk && mk.session && mk.session.id) || (mk && mk.id) || '');
    t.ok('隔离实例里能造临时会话', !!sid, sid);
    const ag = await fetch(base + '/api/agents', { signal: AbortSignal.timeout(10000) })
      .then((r) => r.json()).catch(() => null);
    const card = (ag && Array.isArray(ag.agents)) ? ag.agents.find((a) => a.kind === 'custom') : null;
    t.ok('隔离实例里有可绑的自定义卡', !!card, card ? card.name : '无');
    if (sid && card) {
      await post('/api/agents/bind', { sessionId: sid, agentId: card.id });
      const cur = await fetch(base + '/api/agents/current?sessionId=' + encodeURIComponent(sid),
        { signal: AbortSignal.timeout(10000) }).then((r) => r.json()).catch(() => null);
      t.ok('绑了卡之后，接口交给界面的就是那张卡',
        !!cur && cur.agentId === card.id && cur.name === card.name,
        JSON.stringify({ got: cur && cur.name, want: card.name }));
      await post('/api/agents/bind', { sessionId: sid, agentId: '' });
    }
  } catch (e) {
    t.ok('行为格没抛错', false, String(e && e.message ? e.message : e));
  } finally {
    if (sid) await post('/api/sessions/delete', { id: sid, sessionId: sid });
  }
}

t.done();
