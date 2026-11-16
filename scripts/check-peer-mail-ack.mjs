// check-peer-mail-ack.mjs —— 信件「取走即删」改「落盘确认后再清」的回归
// 实测两条路径：①正常签收 → 信真的没了；②取走但没签收 → 信还在，下一轮能重投
// 用法：cd scripts && node check-peer-mail-ack.mjs
//
// 【坑】隔离数据目录的环境变量是 MINI_AGENT_DATA（config.mjs 只认这个）。
// 写成 XIAOYU_DATA_DIR 的话 config 照样落到真实 APPDATA 目录，
// 测试会在主人真信箱里建文件 —— 看着全 PASS，其实测的是真数据。
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DATA = join(tmpdir(), 'xy-peer-ack-' + Date.now());
process.env.MINI_AGENT_DATA = DATA;
mkdirSync(join(DATA, '.state', 'peers'), { recursive: true });

const peer = await import('../src/peer.mjs');
const { config } = await import('../src/config.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ← ' + extra : '')); }
};

// 第 0 项：先证明真的隔离了，否则后面全是在主人真数据上瞎跑
console.log('=== 0. 隔离检查 ===');
ok('dataDir 指向临时目录', config.dataDir === DATA, 'dataDir=' + config.dataDir);

const ME = 'smtest0001x', OTHER = 'smtest0002y';
const f = join(DATA, '.state', 'peers', ME + '.jsonl');
const clean = () => { if (existsSync(f)) rmSync(f, { force: true }); };

console.log('=== 1. 基线：投递能进信箱 ===');
clean();
const r = peer.postMail({ from: OTHER, to: ME, text: '第一条测试信', fromTitle: '对方' });
ok('postMail 返回 ok', r && r.ok === true, JSON.stringify(r));
ok('信箱里有 1 封', peer.mailCount(ME) === 1, 'count=' + peer.mailCount(ME));

console.log('=== 2. 取走但不签收（模拟这一轮被掐断）→ 信不能丢 ===');
const t1 = peer.takeMail(ME);
ok('takeMail 给了 1 封', t1.length === 1, 'len=' + t1.length);
ok('取走后信箱原文还在（不再立即删）', peer.mailCount(ME) === 1, 'count=' + peer.mailCount(ME));
const t2 = peer.takeMail(ME);
ok('同一封不会被重复投给同一轮（占用生效）', t2.length === 0, 'len=' + t2.length);
peer.releaseClaimedMail(ME);
const t3 = peer.takeMail(ME);
ok('释放占用后能重新取到（下一轮会重投）', t3.length === 1, 'len=' + t3.length);

console.log('=== 3. 正常签收 → 信真的清掉 ===');
peer.ackSessionMail(ME);
ok('签收后信箱文件被删掉', !existsSync(f), '文件还在');
ok('签收后 mailCount = 0', peer.mailCount(ME) === 0, 'count=' + peer.mailCount(ME));

console.log('=== 4. 两封信：取走后签收，全部清掉 ===');
clean();
peer.postMail({ from: OTHER, to: ME, text: '信A' });
peer.postMail({ from: OTHER, to: ME, text: '信B' });
const a = peer.takeMail(ME);
ok('取到 2 封', a.length === 2, 'len=' + a.length);
peer.ackSessionMail(ME);
ok('签收后清空', peer.mailCount(ME) === 0, 'count=' + peer.mailCount(ME));

console.log('=== 5. 坏数据不炸 ===');
clean();
ok('不存在的 id 取信返回空数组', Array.isArray(peer.takeMail('')) && peer.takeMail('').length === 0);
ok('ack 不存在的会话不抛', (() => { try { peer.ackSessionMail('nobody-here'); return true; } catch { return false; } })());
writeFileSync(f, 'bad-line-here\n{"id":"m1","from":"x","text":"好的"}\n', 'utf8');
const bad = peer.takeMail(ME);
ok('坏行被跳过、好行留下', bad.length === 1, 'len=' + bad.length);

console.log('=== 6. 占用不会永久卡住（模拟进程崩在中间） ===');
// 拿一封、不签收不释放，直接换一个"新会话"取 —— 老占用同 id 已占，应当取不到；
// 但 releaseClaimedMail 之后必须能取到（模拟进程重启后占用清零）
clean();
peer.postMail({ from: OTHER, to: ME, text: '崩在半路的信' });
peer.takeMail(ME);
peer.releaseClaimedMail(ME);   // 进程重启后内存里的占用天然全没了，等价于这一步
const again = peer.takeMail(ME);
ok('进程重启后这封信还能取到', again.length === 1, 'len=' + again.length);

clean();
rmSync(DATA, { recursive: true, force: true });

console.log('\n结果：' + pass + ' 过 / ' + fail + ' 没过');
process.exit(fail ? 1 : 0);
