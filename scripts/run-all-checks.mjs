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
 *   · 而且消息数很少（<= 20），不可能是主人认真聊过的
 *
 * 【2026-11-05 加】某个脚本挂了就把它的输出尾巴打出来。以前只打 FAIL
 * 不打原因，等于逼着人再单跑一遍去猜 —— 那不算查，算赌。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const DATA = process.env.MINI_AGENT_DATA || 'C:/Users/35453/AppData/Roaming/小鱼Agent/data';
const SESS_DIR = path.join(DATA, '.state', 'sessions');

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
      if (t.startsWith('__') && cnt <= 20) {
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
const tails = [];
for (const f of scripts) {
  process.stdout.write(f.padEnd(36));
  const r = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', f)], {
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  });
  if (r.status === 0) {
    console.log(' OK');
  } else {
    fail++;
    failed.push(f);
    console.log(' FAIL');
    const out = String(r.stdout || '') + String(r.stderr || '');
    const ls = out.trim().split(/\r?\n/);
    tails.push('──── ' + f + ' 尾巴 ────\n' + ls.slice(-30).join('\n'));
  }
}

/* ─────────────────────────────────────────────────────────────

   【2026-11-05 加】真机 UI 自检
   check-ui.mjs 只能证明"不会白屏"。真正渲染出来对不对，得在浏览器里看。
   这条路已经抓到过：markdown 代码块压根不渲染、大图关闭键压在图角上 ——
   两个静态检查全部漏掉的 bug。

   跑不了的时候（App 没开 / 没有 Edge）**明确说跳过**，不装作通过。
   要强制跳过用 --no-ui。
   ───────────────────────────────────────────────────────────── */
/* 【2026-11-05 加】POST 接口健壮性：自己起一个隔离实例（临时数据目录），
 * 空 body 打一遍，看有没有「没校验就 5xx」的。不碰主人正在用的那份。 */
process.stdout.write('_t_post.mjs（POST）'.padEnd(36));
const rp = spawnSync(process.execPath, [path.join(process.cwd(), '_t_post.mjs')], {
  encoding: 'utf8',
  timeout: 6 * 60 * 1000,
});
if (rp.status === 0) {
  console.log(' OK');
} else {
  fail++;
  failed.push('_t_post.mjs');
  console.log(' FAIL');
  const po = String(rp.stdout || '') + String(rp.stderr || '');
  const pt = po.trim().split(String.fromCharCode(10)).filter((l) => l.includes("✘") || l.includes("共测")).join(String.fromCharCode(10));
  tails.push('──── _t_post.mjs ────' + String.fromCharCode(10) + pt);
}

if (!process.argv.includes('--no-ui')) {
  let alive = false;
  try {
    execFileSync(process.execPath, ['-e',
      "fetch('http://127.0.0.1:8788/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"],
      { timeout: 6000, stdio: 'ignore' });
    alive = true;
  } catch { alive = false; }

  if (!alive) {
    console.log('');
    for (const _f of ['_t_ui.mjs（真机）', '_t_api.mjs（接口）', '_t_tools.mjs（工具）', '_t_write.mjs（写类）', '_t_agents2.mjs（办事/智能体）', '_t_prompt.mjs（system 预算）']) {
      console.log(_f.padEnd(36) + ' 跳过：App 没在跑（8788 连不上）');
    }
  } else {
    process.stdout.write('_t_ui.mjs（真机）'.padEnd(36));
    const rui = spawnSync(process.execPath, [path.join(process.cwd(), '_t_ui.mjs')], {
      encoding: 'utf8',
      timeout: 4 * 60 * 1000,
    });
    if (rui.status === 0) {
      console.log(' OK');
    } else {
      fail++;
      failed.push('_t_ui.mjs');
      console.log(' FAIL');
      const out = String(rui.stdout || '') + String(rui.stderr || '');
      const _tail = out.trim().split(String.fromCharCode(10)).slice(-30).join(String.fromCharCode(10));
      tails.push('──── _t_ui.mjs 尾巴 ────' + '\n' + _tail);
    }

    /* 【2026-11-05 加】接口全量 + 只读工具：都只读，不会改任何状态 */
    for (const _extra of ['_t_api.mjs', '_t_tools.mjs', '_t_write.mjs', '_t_agents2.mjs', '_t_prompt.mjs']) {
      process.stdout.write(_extra.padEnd(36));
      const _rr = spawnSync(process.execPath, [path.join(process.cwd(), _extra)], {
        encoding: 'utf8',
        timeout: 3 * 60 * 1000,
      });
      if (_rr.status === 0) {
        console.log(' OK');
      } else {
        fail++;
        failed.push(_extra);
        console.log(' FAIL');
        const _o = String(_rr.stdout || '') + String(_rr.stderr || '');
        const _t2 = _o.trim().split(String.fromCharCode(10)).slice(-25).join(String.fromCharCode(10));
        tails.push('──── ' + _extra + ' 尾巴 ────' + String.fromCharCode(10) + _t2);
      }
    }
  }
}

console.log('');
console.log('=== 跑完再清一遍 ===');
sweep('after');

console.log('');
console.log('──────');
if (tails.length) {
  console.log('=== 失败详情 ===');
  console.log(tails.join('\n\n'));
  console.log('');
}
console.log('回归：' + (scripts.length - fail) + '/' + scripts.length + ' 通过');
if (fail) console.log('失败：' + failed.join(', '));
process.exit(fail ? 1 : 0);