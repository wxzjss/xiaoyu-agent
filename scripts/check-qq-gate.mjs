/**
 * QQ 准入门（白名单）回归检查 —— 2026-11-12
 *
 * 【为什么要有这个脚本】
 *
 * 主人报：「显示已经连上，我在群里 @ 它怎么没有反应」，
 * 日志是 `挡掉一条（not-in-whitelist）[群] ED6F3300`。
 *
 * 根因是「id 形态」：官方机器人那条道给的是 **group_openid / member_openid**
 * （一长串字母数字），老代码一律过 normQqNum（只留纯数字）→ openid 被洗成空串
 * → 群聊掉进私聊分支 → 私聊又没有 QQ 号 → 永远 not-in-whitelist。
 * 也就是说：白名单里填什么都对不上，而主人只会看到「她不回我」。
 *
 * 这个脚本把那条链路钉住：
 *   ① 群 openid 能存进白名单、能对上（大小写不敏感）
 *   ② 数字群号（OneBot 那条道）照旧能用
 *   ③ 私聊的 openid 能存、能对上，且不会被削成假 QQ 号
 *   ④ 群消息被挡时，状态里要有可放行的记录（blocked）
 *   ⑤ 走一遍 handleInbound：挡 → 放行 → 通过；非 @ 的群消息不接
 *
 * 用临时数据目录，不碰主人真配置。跑：npm run check:qq:gate
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = mkdtempSync(join(tmpdir(), 'xy-qq-gate-'));
process.env.MINI_AGENT_DATA = DIR;

const fail = [];
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else { console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); fail.push(name); }
};

const qq = await import(join(ROOT, 'src/qq.mjs'));
const bridge = await import(join(ROOT, 'src/qq-bridge.mjs'));

const GID = 'ED6F33001234567890ABCDEF';
const USER = 'USEROPENID9AAAAAAAA';

console.log('\n── ① 群 openid 存得进、对得上');
qq.setQqGate({ ownerQq: '2064320087', allowQq: '2064320087', allowGroup: '746749887,' + GID.toLowerCase(), strict: true });
const gate = qq.qqGate();
ok('群 openid 进了名单', gate.allowGroup.includes(GID.toLowerCase()), JSON.stringify(gate.allowGroup));
ok('群 openid 放行（大小写不敏感）', qq.qqAllowed({ groupId: GID, openid: 'M1', isGroup: true }).ok === true);
ok('没填的群照样挡', qq.qqAllowed({ groupId: 'FFAA00112233', openid: 'M1', isGroup: true }).why === 'group-not-allowed');

console.log('\n── ② 数字群号（自己注册的号那条道）照旧');
ok('数字群号放行', qq.qqAllowed({ qqId: '2397482854', groupId: '746749887', isGroup: true }).ok === true);

console.log('\n── ③ 私聊 openid');
ok('未放行的 openid 被挡', qq.qqAllowed({ openid: USER }).why === 'not-in-whitelist');
qq.setQqGate({ allowQq: '2064320087, ' + USER.toLowerCase() });
ok('存进白名单后放行', qq.qqAllowed({ openid: USER }).ok === true);
ok('openid 不会被削成假 QQ 号', qq.qqAllowed({ openid: 'ZZZ12345QQQQ' }).qq === 'zzz12345qqqq');

console.log('\n── ④ 群消息被挡 → 状态里有可放行的记录');
const bot = { sendText: async () => {} };
const calls = [];
const deps = {
  ensureSession: async (a) => { calls.push(a); return { sessionId: 'smtest0001' }; },
  renameGroupSession: async () => {},
  runChat: async () => {},
  setSpeakerOwner: () => {},
};
const mkMsg = (over = {}) => ({
  kind: 'group',
  rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  senderId: 'MEMBEROPENID1',
  senderName: '主人',
  content: '你好呀',
  groupOpenid: 'ED6FAAAA0000BBBB1111',
  ...over,
});
await bridge.handleInbound({ msg: mkMsg(), bot, deps });
let st = bridge.qqStatus();
ok('挡掉计入 stats.blocked', st.stats.blocked === 1, String(st.stats.blocked));
const rec = st.blocked[0] || {};
ok('记录里带群 id', rec.id === 'ED6FAAAA0000BBBB1111', JSON.stringify(rec));
ok('记录里说明原因', rec.why === 'group-not-allowed', String(rec.why));
ok('挡下的没进会话', calls.length === 0, String(calls.length));

console.log('\n── ⑤ 放行之后就能接；没 @ 的群消息不接');
qq.setQqGate({ allowGroup: '746749887,' + GID + ',ED6FAAAA0000BBBB1111' });
await bridge.handleInbound({ msg: mkMsg(), bot, deps });
ok('放行后进了会话', calls.length === 1, String(calls.length));
await bridge.handleInbound({ msg: mkMsg({ rawEventType: 'GROUP_MESSAGE_CREATE', groupOpenid: GID }), bot, deps });
ok('普通群消息（没 @）不接', calls.length === 1, String(calls.length));

console.log('\n── ⑥ 主人身份：官方那条道只能填 openid');
qq.setQqGate({ ownerQq: USER.toUpperCase(), allowQq: '2064320087', allowGroup: GID });
ok('openid 能存成主人（落盘转小写）', qq.qqGate().ownerQq === USER.toLowerCase(), qq.qqGate().ownerQq);
ok('主人私聊按主人对待（大小写不敏感）', qq.qqAllowed({ openid: USER }).why === 'owner', JSON.stringify(qq.qqAllowed({ openid: USER })));
ok('isOwnerOpenid 认这个 openid', qq.isOwnerOpenid(USER) === true);
qq.setQqGate({ ownerQq: '2064320087' });
ok('数字号仍是主人（另一条道）', qq.qqAllowed({ qqId: '2064320087' }).why === 'owner');
// 换主人不会把旧主人踹出白名单（只并进、不剔除）—— 但身份必须不再是 owner
ok('换回数字号后 openid 不再算主人', qq.qqAllowed({ openid: USER }).why === 'whitelist',
  JSON.stringify(qq.qqAllowed({ openid: USER })));
let badOwner = null;
try { qq.setQqGate({ ownerQq: '!!!' }); } catch (e) { badOwner = e; }
ok('乱填被拒（不会静默清空）', Boolean(badOwner) && badOwner.status === 400, badOwner ? badOwner.message : '没报错');

// 回归：openid 中间夹着一串数字时，不能被「削首尾非数字」削成假 QQ 号
// （实测踩过：meopenid00000aaa… 被存成 00000，于是 00000 成了主人）
qq.setQqGate({ ownerQq: 'MEOPENID00000AAAAAAAAAAAAAAAAAAA', allowQq: '' });
ok('带数字的 openid 不被削成假号', qq.qqGate().ownerQq === 'meopenid00000aaaaaaaaaaaaaaaaaaa', qq.qqGate().ownerQq);
ok('假号 00000 不会因此被放行', qq.qqAllowed({ qqId: '00000' }).ok === false, JSON.stringify(qq.qqAllowed({ qqId: '00000' })));

console.log('\n── ⑦ 「找过她的人」那列的身份判定');
qq.setQqGate({ ownerQq: USER });          // 先把 openid 认成主人
qq.noteQqPeer(USER, { name: '我' });
qq.noteQqPeer('GUESTOPENID999', { name: '路人' });
const meRow = bridge.qqPeerList().find((p) => p.id === USER.toLowerCase());
ok('主人那行标成 owner', Boolean(meRow) && meRow.role === 'owner', JSON.stringify(meRow));
ok('行里带完整身份 p.id（openid）', Boolean(meRow) && meRow.id === USER.toLowerCase(), meRow && meRow.id);
qq.setQqGate({ allowQq: '2064320087, GUESTOPENID999' });
const knownRow = bridge.qqPeerList().find((p) => p.id === 'guestopenid999');
ok('白名单里的人标成 known（不再冒充主人）', Boolean(knownRow) && knownRow.role === 'known', JSON.stringify(knownRow));
ok('白名单里的人 isOwner=false', Boolean(knownRow) && knownRow.isOwner === false && knownRow.whitelisted === true);

/* 【2026-11-12 加】面板上「同一个名字出现两行」。
 *
 * 认人表里群会话的 key 是 'group:<群 openid>'，名字记的是**最后在群里说话的人**。
 * 以前它跟人混在同一个列表里，于是 doro 在群里 @ 一次，面板上就有两行 doro；
 * 更糟的是群那行也带「填成主人」—— 点下去群 openid 就成了主人。
 * 现在群单独成类，排在人后面，只给「放行这个群」。 */
console.log('\n── ⑧ 群里那条记录不能冒充「一个人」');
const GKEY = 'group:' + GID.toUpperCase();
qq.setQqGate({ ownerQq: USER, allowQq: USER, allowGroup: GID });
qq.noteQqPeer(GKEY, { name: 'doro' });              // 群会话（名字=最后说话的人）
qq.noteQqPeer('DOROOPENIDBBBBBBBBBBBBBBB', { name: 'doro' }); // 本人
const list = bridge.qqPeerList();
const gRow = list.find((p) => p.kind === 'group');
const pRow = list.find((p) => p.id === 'doroopenidbbbbbbbbbbbbbbb');
ok('群那条标成 kind=group / role=group', Boolean(gRow) && gRow.role === 'group', JSON.stringify(gRow));
ok('群那条的 id 就是群 openid（不是 ' + 'group: 前缀）', Boolean(gRow) && gRow.id === GID.toLowerCase(), gRow && gRow.id);
ok('群已放行时 groupAllowed=true', Boolean(gRow) && gRow.groupAllowed === true);
ok('群那条不会被当成主人', Boolean(gRow) && gRow.isOwner === false && gRow.role !== 'owner');
ok('群里那个人仍然是一条独立的人（kind=person）', Boolean(pRow) && pRow.kind === 'person' && pRow.role === 'guest', JSON.stringify(pRow));
ok('群排在人的后面（想点「填成主人」时不会误点群）', list.length >= 2 && list[list.length - 1].kind === 'group',
  list.map((x) => x.kind).join(','));
// 没放行的群：groupAllowed=false，前端据此给「放行这个群」
qq.setQqGate({ allowGroup: '746749887' });
const gRow2 = bridge.qqPeerList().find((p) => p.kind === 'group');
ok('群没放行时 groupAllowed=false', Boolean(gRow2) && gRow2.groupAllowed === false);
// group:unknown（连群 id 都没有）不该占一行
qq.noteQqPeer('group:unknown', { name: '?' });
ok('group:unknown 不进列表', !bridge.qqPeerList().some((p) => p.id === 'unknown'));
// 同一个人被记成两条（大小写不同）→ 合一
qq.noteQqPeer('DOROOPENIDBBBBBBBBBBBBBBB', { name: 'doro' });
const dupRows = bridge.qqPeerList().filter((p) => p.id === 'doroopenidbbbbbbbbbbbbbbb');
ok('同一个人大小写两条记录合成一行', dupRows.length === 1, String(dupRows.length));
// 有 qq 号的记录跟 openid 记录是同一个 id 时也合一
qq.setQqGate({ allowQq: USER + ',2064320087' });
qq.noteQqPeer('2064320087', { name: '号那条道' });
const numRows = bridge.qqPeerList().filter((p) => p.id === '2064320087');
ok('QQ 号一条 + openid 一条不会互相顶掉', numRows.length === 1, String(numRows.length));

rmSync(DIR, { recursive: true, force: true });

console.log('');
if (fail.length) {
  console.log(`✗ ${fail.length} 项没过：${fail.join('；')}`);
  process.exit(1);
}
console.log('✔ QQ 准入门检查全部通过');
