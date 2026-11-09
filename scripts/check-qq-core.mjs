#!/usr/bin/env node
/**
 * 【QQ 小鱼 · 核心回归】2026-11-09
 *
 * 这一份只看四件「线上真会出事」的事，全部在临时数据目录里跑（不碰主人的 qq.json）：
 *
 *   A 主人号只有一个真源
 *       面板上「你的 QQ 号」是一个输入框，但会被两个按钮存到两处
 *       （gate.ownerQq / onebot.ownerQq）。从 1.5「连上自己注册的号」一路配下来的人，
 *       号填了、也连上了，可认主和白名单读的是 gate —— 空的。
 *       表现：「连上了但她不理我」，而且界面上看不出为什么。
 *
 *   B QQ 收到的附件从来不删
 *       qq-media.mjs 早写好了 pruneMediaDir()，但没有任何地方调用它。
 *
 *   C 发消息失败原来是静默的
 *       一次失败整条就丢了，面板上只有一行没人看的灰字。
 *
 *   D 出错原文会被甩到 QQ
 *       「出错了：<原始错误>」可能带接口地址/栈/key 片段，群里谁都看得见。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-qq-core-'));
process.env.MINI_AGENT_DATA = dataDir;

let pass = 0;
let fail = 0;
const t = {
  ok(name, cond, extra) {
    if (cond) { pass++; console.log('  OK  ' + name); }
    else { fail++; console.log('  [!!] ' + name + (extra ? '  →  ' + extra : '')); }
  },
};

/* Windows 上 import() 不认裸的绝对路径（D:\…），得转成 file:// URL */
const { pathToFileURL } = await import('node:url');
const mod = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const qq = await mod('src/qq.mjs');
const ob = await mod('src/qq-onebot.mjs');
const bridge = await mod('src/qq-bridge.mjs');
const media = await mod('src/qq-media.mjs');

const OWNER = '1249015675';
const sid = 'smqqtest0001';

/** 造一条 OneBot 形状的私聊消息 */
const oneMsg = (qqNum, text = '你好') => ({
  senderId: String(qqNum),
  senderQq: String(qqNum),
  senderName: 'doro',
  content: text,
  kind: 'private',
  messageId: 'm1',
  replyTarget: { scope: 'c2c', targetId: String(qqNum), msgId: 'm1' },
});

/** 收发言的假 bot */
const collector = (failTimes = 0) => {
  const out = [];
  let left = failTimes;
  return {
    out,
    bot: {
      async sendText(target, text) {
        if (left > 0) { left -= 1; throw new Error('消息发送频率超限（模拟）'); }
        out.push({ target, text });
      },
    },
  };
};

const deps = (runChat) => ({
  ensureSession: async () => ({ sessionId: sid }),
  runChat,
});

console.log('\nA 主人号：只填一处也算数');

{
  /* 清空重来：模拟「只在 1.5 那格填了号」 */
  fs.rmSync(path.join(dataDir, '.state', 'qq.json'), { force: true });
  ob.setOneBotConf({ enabled: true, ownerQq: OWNER });

  t.ok('1.5 存号时同步进了 gate（认主/白名单读的那一格）',
    qq.qqGate().ownerQq === OWNER, JSON.stringify(qq.qqGate().ownerQq));
  t.ok('同步时也并进了私聊白名单',
    qq.qqGate().allowQq.includes(OWNER), JSON.stringify(qq.qqGate().allowQq));
  t.ok('isOwnerQq 认得他', qq.isOwnerQq(OWNER) === true);
  const v = qq.qqAllowed({ qqId: OWNER, groupId: '' });
  t.ok('他自己私聊被放行（不再是 not-in-whitelist）', v.ok === true && v.why === 'owner', JSON.stringify(v));
}

{
  /* 老数据：只有 onebot.ownerQq，gate 是空的（已经踩过这个坑的人） */
  fs.writeFileSync(path.join(dataDir, '.state', 'qq.json'), JSON.stringify({
    version: 2,
    gate: { ownerQq: '', allowQq: [], allowGroup: [], strict: true },
    onebot: { enabled: true, mode: 'forward', url: 'ws://127.0.0.1:3001', token: '', ownerQq: OWNER, autoStart: false },
  }, null, 2));
  t.ok('老文件：gate 空时回退 onebot.ownerQq，照样认主', qq.isOwnerQq(OWNER) === true);
  t.ok('老文件：他自己私聊也放行', qq.qqAllowed({ qqId: OWNER }).ok === true);
  t.ok('别人仍然进不来', qq.qqAllowed({ qqId: '100000001' }).ok === false);
}

console.log('\nB 附件目录要有人清');

{
  const dir = path.join(dataDir, 'qq-media');
  fs.mkdirSync(dir, { recursive: true });
  const oldFile = path.join(dir, 'old.png');
  const newFile = path.join(dir, 'new.png');
  fs.writeFileSync(oldFile, 'x');
  fs.writeFileSync(newFile, 'y');
  const eightDays = Date.now() - 8 * 86400_000;
  fs.utimesSync(oldFile, new Date(eightDays), new Date(eightDays));

  const n = media.pruneMediaDir(7);
  t.ok('7 天前的被删掉', n === 1 && !fs.existsSync(oldFile), '删了 ' + n + ' 个');
  t.ok('新的留着', fs.existsSync(newFile));

  const srv = fs.readFileSync(path.join(ROOT, 'src/server.mjs'), 'utf8');
  t.ok('开机真的会调它（不然函数写了等于没写）',
    /bootPruneQqMedia\(quiet\)/.test(srv) && /pruneMediaDir\(7\)/.test(srv));
  t.ok('之后每天一次（不是只在开机那一下）', /setInterval\([\s\S]{0,80}24 \* 3600_000/.test(srv));
}

console.log('\nC 发不出去不许静默');

{
  qq.setQqGate({ ownerQq: OWNER, allowQq: [OWNER], strict: true });
  const c = collector(1);   // 第一次失败，重试成功
  await bridge.handleInbound({
    msg: oneMsg(OWNER),
    bot: c.bot,
    deps: deps(async ({ onEvent }) => {
      onEvent({ type: 'text', text: '第一句。' });
      onEvent({ type: 'done', text: '第一句。' });
    }),
  });
  t.ok('失败一次会自动重试，字还是送到了', c.out.length >= 1 && /第一句/.test(c.out[0].text), JSON.stringify(c.out));
  t.ok('重试成功后不算失败', Number(bridge.qqStatus().stats.fail || 0) === 0, String(bridge.qqStatus().stats.fail));

  const c2 = collector(99);  // 一直失败
  await bridge.handleInbound({
    msg: oneMsg(OWNER, '第二句'),
    bot: c2.bot,
    deps: deps(async ({ onEvent }) => {
      onEvent({ type: 'text', text: '这句发不出去。' });
      onEvent({ type: 'done', text: '这句发不出去。' });
    }),
  });
  t.ok('彻底发不出去会计数（面板能看见，不再是静默丢）',
    Number(bridge.qqStatus().stats.fail || 0) >= 1, String(bridge.qqStatus().stats.fail));
}

console.log('\nD 出错别把技术细节甩到 QQ');

{
  qq.setQqGate({ ownerQq: OWNER, allowQq: [OWNER], strict: true });

  /* 会话正忙（409）：说人话 */
  const c = collector();
  await bridge.handleInbound({
    msg: oneMsg(OWNER),
    bot: c.bot,
    deps: deps(async () => { throw Object.assign(new Error('这个会话正在跑别的，等一下再发'), { status: 409 }); }),
  });
  const said = c.out.map((x) => x.text).join(' ');
  t.ok('409 → 说「等我说完这句就来」', /等我说完这句/.test(said), said.slice(0, 60));
  t.ok('409 → 不再出现「出错了：」', !/出错了：/.test(said));

  /* 客人那边出错：不给原因 */
  qq.setQqGate({ ownerQq: OWNER, allowQq: [OWNER, '100000001'], strict: true });
  const c2 = collector();
  await bridge.handleInbound({
    msg: oneMsg('100000001'),
    bot: c2.bot,
    deps: deps(async () => { throw new Error('ECONNREFUSED 127.0.0.1:18599 apiKey=sk-abc'); }),
  });
  const said2 = c2.out.map((x) => x.text).join(' ');
  t.ok('客人看到的是人话，不含地址/key', !/127\.0\.0\.1|sk-abc|ECONNREFUSED/.test(said2), said2.slice(0, 80));

  /* 主人本人：可以带一句短原因，但也不许带 key */
  const c3 = collector();
  await bridge.handleInbound({
    msg: oneMsg(OWNER),
    bot: c3.bot,
    deps: deps(async () => { throw new Error('接口 500 apiKey=sk-abc'); }),
  });
  const said3 = c3.out.map((x) => x.text).join(' ');
  t.ok('主人能看到一句原因（好排查）', /没跑通/.test(said3), said3.slice(0, 80));
  t.ok('但原始 key 不会漏出去', !/sk-abc/.test(said3), said3.slice(0, 80));
}

fs.rmSync(dataDir, { recursive: true, force: true });
console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
