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

/**
 * 【2026-11-08 修·分档入口不能被当成单项检查】
 *
 * 主人要「跑冒烟 / 跑变更 / 跑核心 / 跑全量」四档分清楚。
 * 可 check-smoke / check-changed / check-core 也长成 check-*.mjs 的样子，
 * 于是全量会**把它们当普通检查再跑一遍**：
 *   全量 → check-core → 里面又跑 11 个 → 56 秒白花，还跟正在跑的服务抢资源
 * （实测那 4 个红里有 2 个就是这么撞出来的）。
 * 这三个是**入口**，不是单项，全量只跑真正的一条条检查。
 */
const TIER_ENTRY = new Set(['check-smoke.mjs', 'check-changed.mjs', 'check-core.mjs']);
/* 【2026-11-08 加】check-gates-self 不进全量回归。
 * 它会把 public/index.html 改坏再还原（验证检查器抓得住），
 * 跑的那几秒里别的脚本读到的是坏文件 —— 全量回归里反复因此爆假红。
 * 它验的是「检查器本身」，属于元测试，单独跑：node scripts/check-gates-self.mjs */
const META_ONLY = new Set(["check-gates-self.mjs"]);

const scripts = fs
  .readdirSync(path.join(process.cwd(), 'scripts'))
  .filter((f) => /^check-.*\.mjs$/.test(f) && !TIER_ENTRY.has(f) && !META_ONLY.has(f))
  .sort();

console.log('=== 开始前先清一遍 ===');
sweep('before');

let fail = 0;
const failed = [];
const tails = [];
/* 【2026-11-08 加】每个检查记一笔耗时，末尾报最慢的几个。
 * 主人问「为什么每次跑回归都这么慢」—— 以前只打印 OK/FAIL，
 * 70 个串行跑完根本看不出时间花在哪。 */
const durations = [];
for (const f of scripts) {
  process.stdout.write(f.padEnd(36));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(process.cwd(), 'scripts', f)], {
    encoding: 'utf8',
    timeout: 15 * 60 * 1000,
  });
  const ms = Date.now() - t0;
  durations.push([f, ms]);
  if (r.status === 0) {
    console.log(' OK  ' + (ms / 1000).toFixed(1) + 's');
  } else {
    fail++;
    failed.push(f);
    console.log(' FAIL  ' + (ms / 1000).toFixed(1) + 's');
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
  const _head = '_t_post status=' + rp.status + ' signal=' + rp.signal;
  const _lines = po.trim() ? po.trim().split(String.fromCharCode(10)) : [];
  const _pick = _lines.filter((l) => l.includes("✘") || l.includes("共测") || l.includes("Error"));
  const pt = [_head].concat(_pick.length ? _pick : _lines.slice(-12)).join(String.fromCharCode(10));
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
/* 最慢的几个单独列出来：慢一次就知道该优化谁，不用靠猜 */
const slow = durations.slice().sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('耗时合计 ' + (durations.reduce((a, b) => a + b[1], 0) / 1000).toFixed(1)
  + 's，最慢的几个：');
for (const [f, ms] of slow) console.log('  ' + (ms / 1000).toFixed(1).padStart(7) + 's  ' + f);
if (fail) console.log('失败：' + failed.join(', '));
process.exit(fail ? 1 : 0);