#!/usr/bin/env node
/**
 * 会话互递话（peer mail）的自测。
 *
 * 跑法：
 *     node scripts/test-peer.mjs
 *
 * 为什么要有这个：
 *   peer.mjs 写的是「两个我互相递话」这条链路。它不像界面上点一下就能看出来对不对 ——
 *   信箱是磁盘上的文件，收发顺序、取走即删、清理过期，任何一处写错都会表现成
 *   「她好像没收到」或者「同一句话被她说两遍」，很难当场看出来。
 *   所以把关键行为固化成断言，改完跑一遍。
 *
 * 这个脚本只碰 .state/peers 下自己造的两个临时信箱，
 * 不读写任何真实会话、不改设置、不联网。
 */

import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { config } from '../src/config.mjs';
import {
  postMail,
  peekMail,
  takeMail,
  mailCount,
  formatMail,
  peerInfo,
  sweep,
} from '../src/peer.mjs';

const ME = 'peertest-from-' + process.pid;
const YOU = 'peertest-to-' + process.pid;

let pass = 0;
let fail = 0;

function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log('  \u2713 ' + name + (extra ? '  ' + extra : ''));
  } else {
    fail++;
    console.log('  \u2717 ' + name + (extra ? '  ' + extra : ''));
  }
}

function cleanup() {
  // takeMail 会把信箱文件删掉；再 sweep 一遍收掉全空/全坏的残骸。
  for (const id of [ME, YOU]) {
    try {
      takeMail(id);
    } catch {}
  }
  try {
    sweep();
  } catch {}
  // 上次跑挂了留下的临时信箱也一起清掉，别影响本次断言。
  try {
    const d = join(config.dataDir, '.state', 'peers');
    for (const n of readdirSync(d)) {
      if (n.startsWith('peertest-')) rmSync(join(d, n), { force: true });
    }
  } catch {}
}

// ---- 开跑 ----
cleanup();
console.log('信箱目录：' + join(config.dataDir, '.state', 'peers'));
console.log('');

console.log('【一、收发】');
const sent = postMail({ from: ME, to: YOU, text: '你在吗？', fromTitle: '自测' });
ok('发信成功', sent.ok === true, JSON.stringify(sent));
ok('给了 id', Boolean(sent.id));
ok('对方信箱里 1 封', mailCount(YOU) === 1, '实际 ' + mailCount(YOU));
ok('自己信箱没被塞东西', mailCount(ME) === 0);

console.log('');
console.log('【二、看一眼不算取走】');
const peeked = peekMail(YOU);
ok('peek 拿得到', peeked.length === 1);
ok('peek 之后还在', mailCount(YOU) === 1);
ok('内容对得上', peeked[0].text === '你在吗？');
ok('记下了是谁发的', peeked[0].from === ME);
ok('记下了对方标题', peeked[0].fromTitle === '自测');
ok('带了时间戳', Number.isFinite(peeked[0].at));

console.log('');
console.log('【三、取走即删】');
const taken = takeMail(YOU);
ok('取到 1 封', taken.length === 1);
ok('取走之后信箱空了', mailCount(YOU) === 0);
ok('再取一次是空的', takeMail(YOU).length === 0);
ok('信箱文件也删了', !readdirSync(join(config.dataDir, '.state', 'peers')).includes(YOU + '.jsonl'));

console.log('');
console.log('【四、把话拼成给模型看的文字】');
const text = formatMail([
  { from: ME, to: YOU, text: '帮我看看打包好了没', fromTitle: 'dsh', at: Date.now() },
]);
ok('说清了不是主人在说话', text.includes('不是主人在说话'));
ok('说明了是另一个会话里的我', text.includes('另一个会话'));
ok('带上了原话', text.includes('帮我看看打包好了没'));
ok('告诉了怎么回', text.includes('ask_peer'));
ok('带上了对方会话 id', text.includes(ME));

console.log('');
console.log('【五、该拒的得拒】');
ok('不给自己发', postMail({ from: ME, to: ME, text: '喂' }).ok === false);
ok('不发空话', postMail({ from: ME, to: YOU, text: '   ' }).ok === false);
ok('不发非字符串', postMail({ from: ME, to: YOU, text: 12345 }).ok === false);
ok('id 不合法要拒', postMail({ from: ME, to: '../../etc/passwd', text: 'x' }).ok === false);

console.log('');
console.log('【六、过长的信要截断，不能把整段塞进提示词】');
const long = postMail({ from: ME, to: YOU, text: '长'.repeat(10000) });
ok('长信能发出去', long.ok === true);
const longBox = takeMail(YOU);
// 截断保留 4000 字正文，末尾再加一行提示，所以总长会略超 4000。
ok('长信正文被截到 4000 字', longBox.length === 1 && longBox[0].text.length > 4000 && longBox[0].text.length < 4100, '实际 ' + (longBox[0] ? longBox[0].text.length : '?'));
ok('截断后看得出来被截了', longBox.length === 1 && longBox[0].text.includes('…'));

console.log('');
console.log('【七、清理过期信箱】');
const dir = join(config.dataDir, '.state', 'peers');
const day = 24 * 3600 * 1000;
postMail({ from: ME, to: 'peertest-sweep-new-' + process.pid, text: '新的' });
writeFileSync(
  join(dir, 'peertest-sweep-old-' + process.pid + '.jsonl'),
  JSON.stringify({ id: 'a', from: ME, to: 'x', text: '旧的', at: Date.now() - 40 * day }) + '\n',
  'utf8'
);
writeFileSync(join(dir, 'peertest-sweep-empty-' + process.pid + '.jsonl'), '\n', 'utf8');
writeFileSync(join(dir, 'peertest-sweep-bad-' + process.pid + '.jsonl'), '这不是 json\n', 'utf8');
const swept = sweep();
ok('清掉了旧/空/坏', swept >= 3, '实际清了 ' + swept);
// 只看本次跑造的那几个，别被上次跑剩的干扰
const mine = 'peertest-sweep-new-' + process.pid + '.jsonl';
const left = readdirSync(dir).filter((n) => n.startsWith('peertest-sweep-') && n.includes(String(process.pid)));
ok('新的留着', left.length === 1 && left[0] === mine, left.join(',') || '(没有)');

console.log('');
console.log('【八、界面摘要】');
postMail({ from: ME, to: YOU, text: '摘要测试' });
const info = peerInfo(YOU);
ok('有目录', typeof info.dir === 'string' && info.dir.length > 0);
ok('有封数', info.count === 1);
ok('有明细', Array.isArray(info.items) && info.items.length === 1);
// 摘要只给前 60 字的 preview，不给全文（界面只需要看个大概）
ok('明细带原话摘要', info.items[0].preview === '摘要测试');

cleanup();

console.log('');
if (fail === 0) {
  console.log('\u2705 全部通过（' + pass + ' 项）');
  process.exit(0);
} else {
  console.log('\u274c ' + fail + ' 项没过，' + pass + ' 项通过');
  process.exit(1);
}
