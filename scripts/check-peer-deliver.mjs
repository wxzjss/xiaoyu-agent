#!/usr/bin/env node
/**
 * 站岗：信箱递话即时可见 + 仅AI可见系统提示（2026-11-12 主人钦定）
 *
 * 主人两条原话：
 *   「信箱不是即时能看到的，改一下：在运行过程中就类似插话的形式；
 *     不在运行就走发消息唤醒路径」
 *   「递话不要以我的署名，要用类似压缩提醒一样的仅AI可见的系统提示形式」
 *
 * 三层钉住：
 *   ① tools.mjs：CTX.peerDeliver 钩子 + setPeerDeliver + ask_peer 默认即时递送
 *   ② server.mjs：deliverMailNow 两路（在跑 → steer+_sysNote+notice 直播条；
 *      没在跑 → wakePeer 叫醒）
 *   ③ 反向断言：旧文案「等她下次说话」不许当默认路径
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
function ok(label, cond, detail = '') {
  if (cond) { pass++; console.log('  ✅', label, detail ? '｜' + detail : ''); }
  else { fail++; console.log('  ❌', label, detail ? '｜' + detail : ''); }
}

const tools = readFileSync(join(ROOT, 'src', 'tools.mjs'), 'utf8');
const server = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8');

console.log('\n递话即时可见：\n');

/* ── ① tools.mjs ── */
ok('CTX 有 peerDeliver 槽位', /peerDeliver:\s*null,/.test(tools));
ok('setPeerDeliver 注入口', /export function setPeerDeliver\(fn\)\s*\{\s*\n\s*CTX\.peerDeliver = typeof fn === 'function' \? fn : null;/.test(tools));
ok('ask_peer 默认走即时递送（不再要显式 wake 传参）',
  /const r = postMail\(\{ from: me, to: String\(to\), text, fromTitle: title \}\);[\s\S]{0,300}const deliver = ctxNow\(\)\.peerDeliver;/.test(tools));
ok('递送成功/失败都有人话回执（信不丢）',
  /已即时递到/.test(tools) && /信留在信箱里，她下次说话时会看到/.test(tools));

/* ── ② server.mjs：deliverMailNow ── */
ok('deliverMailNow 存在且被注入（setPeerDeliver）',
  /async function deliverMailNow\(to, fromTitle, text\)/.test(server) && /setPeerDeliver\(deliverMailNow\);/.test(server));
ok('判据只看 ac（在跑 = 有没被 abort 的 ac，跟 interject 同判据）',
  /deliverMailNow[\s\S]{0,300}turn\.ac && !turn\.ac\.signal\.aborted/.test(server));
ok('在跑：steer 进 steps 槽带 _sysNote（仅AI可见，不打主人署名）',
  /deliverMailNow[\s\S]{0,600}steer\(to, sysText, \{ _sysNote: true \}\)/.test(server));
ok('系统提示文案：说明是程序转交的信、不是主人说的 + 指路 ask_peer 回信',
  /这是程序转交的信，不是主人说的/.test(server) && /要回话用 ask_peer 递回去/.test(server));
ok('在跑：直播清单立刻推 notice（前端画系统提示条，跟压缩提醒同款）',
  /deliverMailNow[\s\S]{0,1200}appendLiveCache\(lv, \{ notice:/.test(server));
ok('没在跑：走 wakePeer 叫醒路径',
  /deliverMailNow[\s\S]{0,1600}await wakePeer\(to\)/.test(server));
ok('递话事件写 diag（可追溯）',
  /peer-deliver-live/.test(server));
ok('import 已带 setPeerDeliver',
  /setPeerDeliver[,}]/.test(server.split("from './tools.mjs'")[0]));

/* ── ③ 反向断言 ── */
ok('旧默认文案降级为兜底（只在递送钩子缺失时出现）',
  tools.indexOf('const deliver = ctxNow().peerDeliver;') < tools.indexOf('if (!wake) {'));

console.log('\n递话即时可见：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
