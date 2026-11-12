/**
 * 系统通知回归检查 —— 2026-11-12
 *
 * 主人：「你看看有没有系统通知的插件，没有做一个，设置在软件对话，ai 回复的时候提醒下，
 * 还有 qq 回复的设置提醒下，做两个开关项」。
 *
 * 这个脚本钉住三件事：
 *   ① 两个开关存得住、读得回；文件坏了回默认，不把提醒永久关死；
 *   ② 开关关着就不弹；没有弹窗能力（浏览器 / 单独跑 node）时静默返回 false，绝不抛；
 *   ③ QQ 那条链路：有人找她会提醒、被白名单挡掉的不提醒、主人自己发的不提醒。
 *
 * 用临时数据目录，不碰主人真配置。跑：npm run check:notify
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = mkdtempSync(join(tmpdir(), 'xy-notify-'));
process.env.MINI_AGENT_DATA = DIR;
mkdirSync(join(DIR, '.state'), { recursive: true });

const fail = [];
const ok = (name, cond, extra = '') => {
  if (cond) console.log(`  ✔ ${name}`);
  else { console.log(`  ✗ ${name}${extra ? ' —— ' + extra : ''}`); fail.push(name); }
};

const N = await import(join(ROOT, 'src/notify.mjs'));
const qq = await import(join(ROOT, 'src/qq.mjs'));
const bridge = await import(join(ROOT, 'src/qq-bridge.mjs'));

console.log('\n── ① 默认值与存取');
const d0 = N.getNotifyPrefs();
ok('默认两个都开（装完不用再点一次）', d0.chat === true && d0.qq === true, JSON.stringify(d0));
N.setNotifyPrefs({ qq: false });
const d1 = N.getNotifyPrefs();
ok('关掉 QQ 后读回 false', d1.qq === false, JSON.stringify(d1));
ok('关 QQ 不影响对话提醒', d1.chat === true, JSON.stringify(d1));
N.setNotifyPrefs({ chat: false });
const d2 = N.getNotifyPrefs();
ok('两个都能单独关', d2.chat === false && d2.qq === false, JSON.stringify(d2));
N.setNotifyPrefs({ qq: true });
ok('只改一个，另一个保持原样', N.getNotifyPrefs().chat === false && N.getNotifyPrefs().qq === true);

console.log('\n── ② 文件坏了不能把提醒永久关死');
writeFileSync(join(DIR, '.state', 'notify.json'), '{ 这不是 JSON', 'utf8');
const d3 = N.getNotifyPrefs();
ok('坏文件回默认（都开）', d3.chat === true && d3.qq === true, JSON.stringify(d3));
ok('坏文件时 set 不崩', (() => { try { N.setNotifyPrefs({ qq: false }); return true; } catch { return false; } })());

console.log('\n── ③ 开关 / 没有能力时都不许抛');
N.setNotifyPrefs({ chat: true, qq: true });
let got = [];
globalThis.__xyNotify = (p) => { got.push(p); return true; };
ok('开着时真的递出去', N.notifyNow('chat', '小鱼', '你好呀') === true && got.length === 1, String(got.length));
ok('title / body 原样带到', got[0] && got[0].title === '小鱼' && got[0].body === '你好呀', JSON.stringify(got[0]));
ok('kind 归一化', got[0] && got[0].kind === 'chat');
N.setNotifyPrefs({ chat: false });
ok('关掉后不递', N.notifyNow('chat', '小鱼', '你好') === false && got.length === 1, String(got.length));
ok('另一个开关不受牵连', N.notifyNow('qq', 'QQ', '有人找你') === true && got.length === 2, String(got.length));
ok('空内容不弹', N.notifyNow('qq', 'QQ', '   ') === false);
delete globalThis.__xyNotify;
ok('没有弹窗能力时静默 false（不抛）', N.notifyNow('qq', 'QQ', '有人找你') === false);
ok('notifyAvailable 能反映能力', N.notifyAvailable() === false);

console.log('\n── ④ QQ 有人找她 → 提醒；挡掉的不提醒');
const notified = [];
globalThis.__xyNotify = (p) => { notified.push(p); return true; };
const GID = 'ED6F33001234567890ABCDEF';
const BOT_USER = 'USEROPENID9AAAAAAAA';
const MEMBER = 'MEMBEROPENIDBBBBBBBBBBBBB';
qq.setQqGate({ ownerQq: BOT_USER, allowQq: BOT_USER, allowGroup: GID, strict: true });

const bot = { sendText: async () => {} };
const deps = {
  ensureSession: async () => ({ sessionId: 'smtest0001' }),
  renameGroupSession: async () => {},
  runChat: async () => {},
  setSpeakerOwner: () => {},
};
const mkMsg = (over = {}) => ({
  kind: 'group',
  rawEventType: 'GROUP_AT_MESSAGE_CREATE',
  senderId: MEMBER,
  senderName: 'doro',
  senderQq: '',
  content: '在吗',
  groupOpenid: GID,
  ...over,
});

notified.length = 0;
await bridge.handleInbound({ msg: mkMsg(), bot, deps });
ok('群里有人 @ 她 → 弹一条', notified.length === 1, String(notified.length));
ok('标题带群和说话人', Boolean(notified[0]) && /QQ 群/.test(notified[0].title), JSON.stringify(notified[0]));
ok('内容带说了什么', Boolean(notified[0]) && /在吗/.test(notified[0].body), JSON.stringify(notified[0]));

notified.length = 0;
await bridge.handleInbound({ msg: mkMsg({ groupOpenid: 'OTHERGROUP0000000000000000' }), bot, deps });
ok('被白名单挡掉的群不弹', notified.length === 0, String(notified.length));

notified.length = 0;
await bridge.handleInbound({ msg: mkMsg({ kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: 'STRANGER00000000000000000', senderName: '路人', content: '你好' }), bot, deps });
ok('未放行的私聊不弹', notified.length === 0, String(notified.length));

notified.length = 0;
await bridge.handleInbound({ msg: mkMsg({ kind: 'c2c', rawEventType: 'C2C_MESSAGE_CREATE', senderId: BOT_USER, senderName: '主人', content: '在忙吗' }), bot, deps });
ok('主人自己发的不弹', notified.length === 0, String(notified.length));

notified.length = 0;
N.setNotifyPrefs({ qq: false });
await bridge.handleInbound({ msg: mkMsg(), bot, deps });
ok('QQ 开关关掉后不弹', notified.length === 0, String(notified.length));
N.setNotifyPrefs({ qq: true });

delete globalThis.__xyNotify;
rmSync(DIR, { recursive: true, force: true });

console.log('');
if (fail.length) {
  console.log(`✗ ${fail.length} 项没过：${fail.join('；')}`);
  process.exit(1);
}
console.log('✔ 系统通知检查全部通过');
