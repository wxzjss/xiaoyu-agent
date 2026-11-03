/**
 * 跑全部 check-*.mjs，前后各清一遍测试留下的脏会话。
 *
 * 【为什么要这个】
 * 有几个检查脚本会 /api/sessions/new 造临时会话。它们本来在末尾自己删，
 * 但脚本中途抛错就跳过删除 —— 2026-11-02 就因为这个在主人会话列表里
 * 留下了 6 个标题叫 __ord__ 的空会话。
 *
 * 这里不指望每个脚本自己收拾干净：跑前先扫一遍，跑完再扫一遍。
 * 判定「是测试垃圾」的规矩（宁可漏删，绝不误删主人的会话）：
 *   · 标题以 __ 开头（__ord__ / __e2e_mate_speaks__ 这类）
 *   · 或者标题正好是下面白名单里那些写死的测试名
 *   · 而且消息数很少（<= 20），不可能是主人认真聊过的
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const DATA = process.env.MINI_AGENT_DATA || 'C:/Users/35453/AppData/Roaming/小鱼Agent/data';
const SESS_DIR = path.join(DATA, '.state', 'sessions');

const TITLE_OK = new Set(['普通会话']);

function sweep(tag) {
  if (!fs.existsSync(SESS_DIR)) return 0;
  const files = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith('.json') && !f.includes('.bak'));
  let n = 0;
  for (const f of files) {
    const p = path.join(SESS_DIR, f);
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const t = String(j.title || '');
      const cnt = Array.isArray(j.messages) ? j.messages.length : 0;
      const looksTest = t.startsWith('__') || TITLE_OK.has(t);
      if (looksTest && cnt <= 20) {
        fs.unlinkSync(p);
        n++;
        console.log('  [sweep:' + tag + '] 删测试会话 ' + f + ' title=' + JSON.stringify(t) + ' msgs=' + cnt);
      }
    } catch { /* 读不了就跳过，别把主人的东西删了 */ }
  }
  if (n) console.log('  [sweep:' + tag + '] 共清 ' + n + ' 个');
  return n;
}

const scripts = fs
  .readdirSync(path.join(process.cwd(), 'scripts'))
  .filter((f) => /^check-.*\.mjs$/.test(f))
  .sort();

console.log('=== 开始前先清一遍 ===');
sweep('before');

let fail = 0;
const failed = [];
for (const f of scripts) {
  process.stdout.write(f.padEnd(36));
  const r = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', f)], { encoding: 'utf8' });
  if (r.status === 0) {
    console.log(' OK');
  } else {
    fail++;
    failed.push(f);
    console.log(' FAIL');
  }
}

console.log('');
console.log('=== 跑完再清一遍 ===');
sweep('after');

console.log('');
console.log('──────');
console.log('回归：' + (scripts.length - fail) + '/' + scripts.length + ' 通过');
if (fail) console.log('失败：' + failed.join(', '));
process.exit(fail ? 1 : 0);
