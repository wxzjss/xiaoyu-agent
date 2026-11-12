#!/usr/bin/env node
/**
 * QQ 出站回归：一轮回复被切成好几条时，**每一条都得能到对面**。
 *
 * 【为什么要单独写这个】2026-11-12 主人报「群里 @ 她，群里没回复，
 * 切到那个会话去就有了」。真凶在 send()：
 *   为了让多条回复不像复读，从第 2 条起把 msgId 摘掉。
 * 而 QQ 的语义是「带 msg_id = 被动回复（有权限），不带 = 主动推送（群聊无权限）」，
 * 于是群里永远只有第 1 条到，后面全 400「主动消息失败, 无权限」。
 *
 * 这个脚本用一个**照着官方行为**的假 bot 把这件事钉死：
 *   · 群聊 + 没有 msgId  → 抛「主动消息失败, 无权限」
 *   · 其他情况          → 收下并记账
 * 然后断言一轮 3 条回复全部送达、每条都带 msgId。
 *
 * 跑：npm run check:qq:send
 */
import { rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DIR = join('/tmp', 'xy-check-qq-send');
process.env.MINI_AGENT_DATA = DIR;
rmSync(DIR, { recursive: true, force: true });

const qq = await import('../src/qq.mjs');
const bridge = await import('../src/qq-bridge.mjs');

const GROUP = '6958d44069631eca2b5867666de1b656';
const SENDER = 'senderopenid0000000000000000000';
const MSG_ID = 'MSGID-ABC-123';

let pass = 0;
const fail = [];
const ok = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✔ ${name}${extra ? ' —— ' + extra : ''}`); }
  else { console.log(`  ✘ ${name}${extra ? ' —— ' + extra : ''}`); fail.push(name); }
};

// 放行这个群 + 关掉「只理白名单」对私聊的连带影响（这里只测群）
qq.setQqGate({ ownerQq: '', allowQq: [], allowGroup: [GROUP], strict: true });

/** 照官方行为造的假 bot：没 msgId 的群消息一律 400。 */
const sent = [];
const bot = {
  async sendText(target, text) {
    const scope = String(target?.scope || 'c2c');
    const hasId = Boolean(target?.msgId);
    if (scope === 'group' && !hasId) {
      throw new Error('API Error [/v2/groups/x/messages]: 主动消息失败, 无权限');
    }
    sent.push({ scope, targetId: String(target?.targetId || ''), msgId: String(target?.msgId || ''), text });
    return { ok: true };
  },
};

const deps = {
  ensureSession: async () => ({ sessionId: 'S1' }),
  renameGroupSession: async () => true,
  setSpeakerOwner: () => {},
  async runChat({ onEvent }) {
    // 一轮在 QQ 里说三条 —— 模型用空行分段（splitSay 就按空行切）
    const FULL = '在的。\n\n我在呢，刚在忙。\n\n你说吧。';
    for (const s of ['在的。\n\n', '我在呢，刚在忙。\n\n', '你说吧。']) {
      onEvent({ type: 'text', text: s });
      await new Promise((r) => setTimeout(r, 10));
    }
    onEvent({ type: 'done', text: FULL });
    return { ok: true, text: FULL };
  },
};

const msg = {
  kind: 'group',
  senderId: SENDER,
  senderName: '主人',
  groupOpenid: GROUP,
  groupQq: GROUP,
  messageId: MSG_ID,
  content: '在吗',
  rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  replyTarget: { scope: 'group', targetId: GROUP, msgId: MSG_ID },
};

console.log('── 群聊：一轮切三条，每条都要送达');
await bridge.handleInbound({ msg, bot, deps });

ok('三条都发出去了', sent.length === 3, `实际 ${sent.length} 条：${sent.map((x) => x.text).join(' | ')}`);
ok('全部落在群里', sent.every((x) => x.scope === 'group'), JSON.stringify(sent.map((x) => x.scope)));
ok('全部发到那个群', sent.every((x) => x.targetId === GROUP));
ok('每一条都带 msgId（被动回复）', sent.every((x) => x.msgId === MSG_ID), JSON.stringify(sent.map((x) => x.msgId)));
ok('正文按句切开，没粘成一坨', sent.length > 1 && sent.every((x) => x.text.length > 0));

const st = bridge.qqStatus();
ok('stats.fail 没增加（没有静默丢消息）', Number(st.stats.fail || 0) === 0, `fail=${st.stats.fail}`);
ok('stats.out 与实发条数一致', Number(st.stats.out) === 3, `out=${st.stats.out}`);

console.log('\n── 私聊：同样每条都带 msgId');
sent.length = 0;
const c2c = {
  kind: 'c2c',
  senderId: SENDER,
  senderName: '主人',
  messageId: 'MSGID-C2C-9',
  content: '在吗',
  replyTarget: { scope: 'c2c', targetId: SENDER, msgId: 'MSGID-C2C-9' },
};
qq.setQqGate({ allowQq: [SENDER] });
await bridge.handleInbound({ msg: c2c, bot, deps });
ok('私聊三条都发出去了', sent.length === 3, `实际 ${sent.length}`);
ok('私聊每条都带 msgId', sent.every((x) => x.msgId === 'MSGID-C2C-9'));

console.log('\n── 话很多（8 段）：最多发 5 条，内容不能丢');
sent.length = 0;
const EIGHT = Array.from({ length: 8 }, (_, i) => `第${i + 1}句。`).join('\n\n');
const depsMany = {
  ...deps,
  async runChat({ onEvent }) {
    onEvent({ type: 'text', text: EIGHT });
    onEvent({ type: 'done', text: EIGHT });
    return { ok: true, text: EIGHT };
  },
};
await bridge.handleInbound({ msg: c2c, bot, deps: depsMany });
ok('条数没超过 QQ 的 5 条上限', sent.length <= 5, `实际 ${sent.length} 条`);
const joined = sent.map((x) => x.text).join('').replace(/\s/g, '');
ok('每一句都还在（没被截断丢掉）', joined === EIGHT.replace(/\s/g, ''),
  joined === EIGHT.replace(/\s/g, '') ? '' : `少了「${EIGHT.replace(/\s/g, '')}」里的内容`);
ok('超出的部分并进了最后一条', sent.length === 5, `实际 ${sent.length}`);

console.log('\n── LLM 挂了（502）：话要说对，更不能一声不吭');
sent.length = 0;
const deps502 = {
  ...deps,
  async runChat() {
    throw new Error('LLM HTTP 502: Upstream service temporarily unavailable');
  },
};
await bridge.handleInbound({ msg: c2c, bot, deps: deps502 });
ok('至少回了一句（不是完全静默）', sent.length >= 1, `实际 ${sent.length} 条`);
const said502 = sent.map((x) => x.text).join(' ');
ok('说清是上游/网关抽风', /网关|上游/.test(said502), said502);
ok('没把「LLM HTTP 502」原样甩到聊天里', !/LLM HTTP/i.test(said502), said502);
const st502 = bridge.qqStatus();
ok('qqStatus 记下了这一轮失败', Boolean(st502.turnError) && st502.turnError.gateway === true,
  JSON.stringify(st502.turnError));
ok('失败记录里留着原始原因（排查用）', /502/.test(String(st502.turnError && st502.turnError.message || '')),
  String(st502.turnError && st502.turnError.message));

// 日志落盘：内存那份重启就没了，出事后要能翻账
try {
  const logFile = join(DIR, '.state', 'qq.log');
  const txt = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  ok('日志写进了 .state/qq.log', txt.includes('这一轮没答完'), txt ? `共 ${txt.length} 字符` : '文件不存在');
} catch (e) {
  ok('日志写进了 .state/qq.log', false, String(e?.message ?? e));
}

console.log('\n── 说到一半才挂：别让对面以为「整轮都没跑」');
sent.length = 0;
const HALF = '我先说前半句，这句话我特意写得长一些，长到超过六十个字，好让它立刻发出去，'
  + '后面那条错误提示才能接在后面，不至于让对面以为整轮都没跑。';
const depsHalf = {
  ...deps,
  async runChat({ onEvent }) {
    onEvent({ type: 'text', text: HALF });
    await new Promise((r) => setTimeout(r, 30));
    throw new Error('LLM HTTP 502: Upstream service temporarily unavailable');
  },
};
await bridge.handleInbound({ msg: c2c, bot, deps: depsHalf });
const halfAll = sent.map((x) => x.text).join(' ');
ok('前半句发出去了', halfAll.includes('前半句'), halfAll);
ok('补了一句「说到一半断了」', /说到一半|断了|接着说/.test(halfAll), halfAll);

console.log('\n── 会话文件早就被删了：安静当「没有」，别刷故障日志');
try {
  const { loadSession } = await import('../src/sessions-core.mjs');
  const warns = [];
  const oldWarn = console.warn;
  console.warn = (...a) => { warns.push(a.join(' ')); };
  const got = loadSession('smwde99zzzzzzz');
  console.warn = oldWarn;
  ok('读不存在的会话返回 null', got === null, String(got));
  ok('ENOENT 不再当成故障刷日志', warns.length === 0, warns.join(' | '));
} catch (e) {
  ok('读不存在的会话不吵', false, String(e?.message ?? e));
}

console.log('\n── 没料到的异常：不能一声不吭，至少回一句');
sent.length = 0;
const depsBoom = {
  ...deps,
  async ensureSession() { throw new Error('会话那层炸了'); },
};
await bridge.handleInboundSafe({ msg: c2c, bot, deps: depsBoom });
ok('异常时也回了一句', sent.length >= 1, `实际 ${sent.length} 条：${sent.map((x) => x.text).join(' | ')}`);
ok('说的是人话（不是错误栈）', /岔子|再发一次/.test(sent.map((x) => x.text).join(' ')),
  sent.map((x) => x.text).join(' '));

console.log('\n── 真 SDK 契约：带 msgId 必须走「被动回复」，不是主动推送');
try {
  const { QQBot } = await import('@tencent-connect/qqbot-nodejs');
  const realBot = new QQBot({ appId: '1', appSecret: 'x' });
  const calls = [];
  realBot.messageApi.sendMessage = async (scope, targetId, content, creds, opts) => {
    calls.push({ via: 'passive', scope, targetId, msgId: opts?.msgId, content });
    return {};
  };
  realBot.messageApi.sendProactiveMessage = async (scope, targetId, content) => {
    calls.push({ via: 'proactive', scope, targetId, content });
    return {};
  };
  const tgt = { scope: 'group', targetId: GROUP, msgId: MSG_ID };
  await realBot.sendText(tgt, '第一条');
  await realBot.sendText(tgt, '第二条');
  ok('两条都走了 sendMessage（被动回复）', calls.length === 2 && calls.every((c) => c.via === 'passive'),
    JSON.stringify(calls.map((c) => c.via)));
  ok('两条带的是同一个 msgId', calls.every((c) => c.msgId === MSG_ID), JSON.stringify(calls.map((c) => c.msgId)));
  ok('没有一条退化成主动推送', calls.every((c) => c.via !== 'proactive'));
} catch (e) {
  console.log(`  – 跳过（这台机器没装 ${'@tencent-connect/qqbot-nodejs'}）：${e?.message ?? e}`);
}

console.log('');
if (fail.length) {
  console.log(`✘ ${fail.length} 项没过：${fail.join('、')}`);
  process.exitCode = 1;
} else {
  console.log(`✔ 全部通过（${pass} 项）`);
}
rmSync(DIR, { recursive: true, force: true });
