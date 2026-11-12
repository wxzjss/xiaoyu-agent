#!/usr/bin/env node
/**
 * 【QQ 小鱼 · mac 适配自检】2026-11-12
 *
 * 为什么单独一份：check-qq-core.mjs 管的是业务逻辑（认主、附件清理、报错脱敏），
 * 问的是「逻辑对不对」；这一份问的是「在 mac 上跑不跑得起来」——
 * 平台分支、路径拼接、进程探测这些，Windows 上全绿也不代表 mac 上能走。
 *
 * 2026-11-12 实测到的三个真 bug 都属于这一类，而且都不会报错、只会静默失效：
 *   ① DIR 拼成 ~/AppData/Local/...（mac 上根本不该有这个目录）
 *   ② 二维码路径用 '\\napcat\\cache' 拼 → 反斜杠成了文件名，永远读不到码
 *   ③ 用 pgrep -f 'QQ.app' 判断协议端在不在 → QQ 开着就误报「协议端在跑」
 *
 * 覆盖：
 *   A  目录/探测：DIR、二维码路径、status 的 platform 字段
 *   B  伪装已装：XIAOYU_NAPCAT_ROOT 指到临时目录，验 detect / 读码
 *   C  启动分支：没装时 start 的说法是 mac 说法（不提 exe），kill 不杀 QQ
 *   D  协议层：起一个假 OneBot 协议端，验握手 / 收私聊 / 发消息
 *
 * 不覆盖（也测不了）：
 *   · 真 NapCat 扫码登录 —— 要改 QQ 入口 + 系统授权，只能人来做
 *   · deploy() 没装时打开安装器下载页 —— 会真开浏览器，脚本不干这事
 *   · kill() 真去 open -a QQ —— 会抢你正在用的窗口焦点，只做静态断言
 *
 * 用法：
 *   node scripts/check-qq-mac.mjs
 *   非 mac 平台直接跳过（Windows 上跑不出结论，别给假绿灯）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const ROOT = path.resolve(import.meta.dirname, '..');
const isMac = process.platform === 'darwin';

if (!isMac) {
  console.log('跳过：这份自检只对 macOS 有意义（当前 ' + process.platform + '）。');
  console.log('Windows 的 QQ 链路请跑 node scripts/check-qq-core.mjs');
  process.exit(0);
}

let pass = 0;
let fail = 0;
let skip = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  [!!] ' + name + (extra ? '  →  ' + extra : '')); }
};
const skipped = (name, why) => { skip++; console.log('  --   ' + name + '（跳过：' + why + '）'); };

const tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-qq-mac-'));
process.env.MINI_AGENT_DATA = tmpData;

const { pathToFileURL } = await import('node:url');
const load = (p) => import(pathToFileURL(path.join(ROOT, p)).href);

const proto = await load('scripts/qq-protocol.mjs');
const mac = await load('src/napcat-mac.mjs');
const qrMod = await load('src/qq-qrcode.mjs');

/* ---------- A 目录与探测 ---------- */
console.log('\nA 目录与探测');
const DIR = String(proto.DIR);
ok('协议端目录不再拼出 ~/AppData', !DIR.includes('/AppData/'), DIR);
ok('目录落在 ~/Library/Application Support 下',
  DIR === path.join(os.homedir(), 'Library', 'Application Support', 'XiaoyuAgent', 'qq-protocol'), DIR);
ok('目录里没有反斜杠', !DIR.includes('\\'), DIR);

const st0 = await proto.status();
ok('status 带 platform=darwin', st0.platform === 'darwin', JSON.stringify(st0.platform));
ok('status 字段齐全（installed/running/webui/websocket 都是布尔）',
  typeof st0.installed === 'boolean' && typeof st0.running === 'boolean'
  && typeof st0.webui === 'boolean' && typeof st0.websocket === 'boolean');
ok('QQ 装在 /Applications/QQ.app 时能认出来', st0.qq === '/Applications/QQ.app' || !fs.existsSync('/Applications/QQ.app'), st0.qq);

const qr0 = await qrMod.loginQrcode();
ok('没装时读码不抛异常、返回结构完整', qr0 && typeof qr0.ok === 'boolean');
ok('二维码路径里没有反斜杠（原来会变成文件名）',
  !String(qr0.file || '').includes('\\'), String(qr0.file || ''));
ok('二维码路径挂在 napcat/cache 下',
  String(qr0.file || '').replace(/\/+$/, '').endsWith('/napcat/cache/qrcode.png'), String(qr0.file || ''));

/* ---------- B 伪装已装 ---------- */
console.log('\nB 伪装已装（XIAOYU_NAPCAT_ROOT 指到临时目录）');
const fakeRoot = path.join(tmpData, 'fake-napcat');
fs.mkdirSync(path.join(fakeRoot, 'cache'), { recursive: true });
fs.mkdirSync(path.join(fakeRoot, 'config'), { recursive: true });

// 拿仓库里一张真图当二维码用（1×1 的假图验不出 base64 是否真能用）
const realPng = path.join(ROOT, 'assets', 'xiaoyu-256.png');
fs.copyFileSync(realPng, path.join(fakeRoot, 'cache', 'qrcode.png'));

process.env.XIAOYU_NAPCAT_ROOT = fakeRoot;
const cat = mac.detectMacNapCat();
ok('detect 认出了指定目录', cat.found === true && cat.dir === fakeRoot, JSON.stringify(cat));
ok('二维码候选目录里有 cache/', Array.isArray(cat.qrDirs) && cat.qrDirs.includes(path.join(fakeRoot, 'cache')),
  JSON.stringify(cat.qrDirs));

const st1 = await proto.status();
ok('status.installed 跟着变 true', st1.installed === true, JSON.stringify(st1.installed));

const qr1 = await qrMod.loginQrcode();
ok('读到了二维码', qr1.ok === true, JSON.stringify({ reason: qr1.reason, file: qr1.file }));
ok('认出了 PNG 尺寸', qr1.width > 0 && qr1.height > 0, `${qr1.width}x${qr1.height}`);
ok('base64 非空（前端能直接塞 img）', String(qr1.base64 || '').length > 100);

// 一行半截的坏图：不能当二维码喂给前端
fs.writeFileSync(path.join(fakeRoot, 'cache', 'qrcode.png'), Buffer.from([0x89, 0x50, 0x00]));
const qrBad = await qrMod.loginQrcode();
ok('读到坏图时不假装成功', qrBad.ok === false, JSON.stringify(qrBad.reason));

/* ---------- C 启动分支 ---------- */
console.log('\nC 启动 / 停止分支');
delete process.env.XIAOYU_NAPCAT_ROOT;
const emptyRoot = path.join(tmpData, 'empty-napcat');
fs.mkdirSync(emptyRoot, { recursive: true });
process.env.XIAOYU_NAPCAT_ROOT = emptyRoot;

let err = '';
try { proto.start(); } catch (e) { err = String(e?.message ?? e); }
ok('没装时 start 抛错', err.length > 0, err);
ok('这条错误是 mac 的说法（不提 exe / UAC）', /还没装协议端/.test(err) && !/exe|UAC/i.test(err), err);
ok('错误里指了下一步（准备协议端 / 安装器）', /准备协议端|安装器/.test(err), err);

// kill 会真去 open -a QQ（抢焦点），这里只看实现，不实际调用
const src = fs.readFileSync(path.join(ROOT, 'scripts', 'qq-protocol.mjs'), 'utf8');
const killBlock = src.slice(src.indexOf('function kill()'), src.indexOf('async function status()'));
ok('kill 的 mac 分支不杀 QQ 进程', /IS_MAC/.test(killBlock) && !/taskkill[\s\S]{0,80}IS_MAC[\s\S]{0,40}taskkill/.test(killBlock));
ok('mac 分支明确返回 killed:false', /killed:\s*false/.test(killBlock));
skipped('kill() 实跑', '会 open -a QQ 抢走你当前窗口焦点');

/* ---------- D 协议层 ---------- */
console.log('\nD 协议层（假 OneBot 协议端）');
let WSS = null;
try { ({ WebSocketServer: WSS } = await import('ws')); } catch { /* 没装就跳过 */ }

if (!WSS) {
  skipped('假协议端收发', '没装 ws 依赖');
} else {
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });

  const seen = { actions: [], texts: [] };
  const wss = new WSS({ port, host: '127.0.0.1' });
  let sock = null;
  wss.on('connection', (ws) => {
    sock = ws;
    ws.on('message', (buf) => {
      let j = null;
      try { j = JSON.parse(String(buf)); } catch { return; }
      seen.actions.push(j.action);
      const reply = (data) => ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: j.echo }));
      if (j.action === 'get_login_info') return reply({ user_id: 10086, nickname: '假协议端' });
      if (j.action === 'get_friend_list' || j.action === 'get_group_list') return reply([]);
      if (j.action === 'send_private_msg' || j.action === 'send_group_msg') {
        seen.texts.push(j.params?.message ?? '');
        return reply({ message_id: 42 });
      }
      return reply({});
    });
  });
  await new Promise((r) => wss.once('listening', r));

  const ob = await load('src/qq-onebot.mjs');
  ob.setOneBotConf({ enabled: true, mode: 'forward', url: `ws://127.0.0.1:${port}`, token: '', autoStart: false });

  const got = [];
  let startErr = '';
  let state = null;
  try {
    state = await ob.startOneBot((ev) => { got.push(ev); });
  } catch (e) {
    startErr = String(e?.message ?? e);
  }
  ok('能连上协议端（phase=online）', !startErr && state?.phase === 'online',
    startErr || JSON.stringify(state));
  ok('握手调了 get_login_info', seen.actions.includes('get_login_info'));
  ok('拿到了自己的号', String(state?.selfId || '') === '10086', String(state?.selfId));

  // 协议端推一条私聊进来
  if (sock) {
    sock.send(JSON.stringify({
      post_type: 'message',
      message_type: 'private',
      self_id: 10086,
      user_id: 20001,
      message_id: 7,
      raw_message: '在吗',
      time: Math.floor(Date.now() / 1000),
      sender: { nickname: '测试客人' },
      message: [{ type: 'text', data: { text: '在吗' } }],
    }));
  }
  await new Promise((r) => setTimeout(r, 600));
  ok('收到并解析了私聊消息', JSON.stringify(got).includes('在吗'), JSON.stringify(got).slice(0, 200));

  try {
    await ob.sendText({ isGroup: false, target: 20001, text: '在的呀' });
    ok('发出去的消息到了协议端', seen.texts.some((t) => String(t).includes('在的呀')), JSON.stringify(seen.texts));
  } catch (e) {
    ok('发出去的消息到了协议端', false, String(e?.message ?? e));
  }

  await ob.stopOneBot().catch(() => {});
  wss.close();
}

/* ---------- 汇总 ---------- */
console.log('\n' + '='.repeat(48));
console.log(`通过 ${pass}   失败 ${fail}   跳过 ${skip}`);
if (fail) {
  console.log('有失败项：mac 上的 QQ 链路现在不能交付。');
  process.exit(1);
}
console.log('mac 侧能自动验的都过了。真扫码登录还得人手走一遍：');
console.log('  面板「准备协议端」→ 装官方安装器 → 「启动协议端」→ 手机扫码 → 「连上」');
fs.rmSync(tmpData, { recursive: true, force: true });
