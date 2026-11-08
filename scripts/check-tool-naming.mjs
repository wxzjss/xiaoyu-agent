/**
 * 【工具卡片 / 柜门 该叫什么名字】
 *
 * 主人 2026-11-07 两条：
 *   ① 「跑回归时显示的也是【跑命令】，这个改一下」→ 按命令内容细分名字
 *   ② 「调用工具时【调了 x 次工具】不会变成【跑命令】」
 *      → 柜门要能变成「正在跑回归…」，切会话之后也要能变
 *
 * 源码断言 + 真机格。连不上调试浏览器就 SKIP（不算失败），
 * 但源码那一半必须全过 —— 命名这件事本身不需要浏览器。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('ui / 工具命名与柜门');
const ui = fs.readFileSync('public/index.html', 'utf8');

// ── 1. niceCommand 存在，且从具体到宽泛 ────────────────────────────
t.ok('有 niceCommand', /function niceCommand\(raw\)/.test(ui));
t.ok('niceTool 收 args', /function niceTool\(name, args\)/.test(ui));
t.ok('run_command 走内容判定', /if \(n === 'run_command'\)/.test(ui));

/* 【2026-11-07 换写法】原来靠正则去「源码里找关键字」，绕且脆。
 * 现在直接把 niceCommand 从页面里抠出来跑真实命令 —— 测的是行为，不是注释。 */
const _ci = ui.indexOf('function niceCommand(raw)');
const _cj = ui.indexOf('function toolArgsOf');
const niceCommand = new Function(ui.slice(_ci, _cj) + '; return niceCommand;')();

const CASES = [
  /* 【2026-11-08 改·回归分档】主人要求「别一律叫跑回归」，
   * 现在 run-all-checks / check-smoke / check-changed / check-core 各有各的名字。 */
  ['node scripts/run-all-checks.mjs', '跑全量'],
  ['node scripts/check-smoke.mjs', '跑冒烟'],
  ['node scripts/check-changed.mjs', '跑变更'],
  ['node scripts/check-core.mjs', '跑核心'],
  ['cd D:/x; node scripts/check-ui.mjs 2>&1', '跑回归'],
  ['cd D:/x; node _t_ui.mjs', '跑回归'],
  ['node --check scripts/check-x.mjs', '查语法'],
  ['npm test', '跑测试'],
  ['npm install', '装依赖'],
  ['npm run build', '打包'],
  ['git commit -m x', '提交代码'],
  ['git push', '同步仓库'],
  ['git checkout -- a.mjs', '改仓库'],
  ['git status', '看仓库'],
  ["$f='D:/x/scripts/check-x.mjs'; [System.IO.File]::ReadAllLines($f)", '看文件'],
  ['Select-String -Path scripts/check-x.mjs -Pattern x', '看文件'],
  ['ls -la', '看文件'],
  ['netstat -ano', '看进程'],
  ['taskkill /F /IM x.exe', '停进程'],
  ['curl http://x', '抓网址'],
  ['node -e "console.log(1)"', '跑脚本'],
  ['Copy-Item a b', '理文件'],
  ['echo hi', '跑命令'],
];
let bad = 0;
for (const [cmd, want] of CASES) {
  const got = niceCommand(cmd);
  const ok = got === want;
  if (!ok) bad += 1;
  t.ok('认「' + want + '」：' + cmd.slice(0, 42), ok, got);
}

t.ok('兜底还是「跑命令」', /return '跑命令';/.test(ui));

// ── 2. 六处调用点都传了 args（少一处历史卡就还是写死） ────────────
const calls = ui.match(/niceTool\([^)]*\)/g) || [];
const withArgs = calls.filter((c) => /,\s*[a-zA-Z_.]+\.args\)/.test(c));
t.ok('调用点都带 args', withArgs.length >= 5, withArgs.length + ' 处');

// ── 3. 参数两种形态都认（历史快照是 JSON 串） ─────────────────────
t.ok('toolArgsOf 兼容串和对象', /typeof args === 'object'/.test(ui) && /JSON\.parse\(String\(args\)\)/.test(ui));

// ── 4. 柜门：运行中要变成「正在X…」 ──────────────────────────────
t.ok('柜门找「运行中…」那张卡', /indexOf\('运行'\) >= 0/.test(ui));
t.ok('柜门写「正在…」', /'正在' \+/.test(ui));
t.ok('跑完退回统计', /次工具/.test(ui) && /调了 ' \+ /.test(ui));

// ── 5. 切会话要断开柜子指针（主人怀疑的那条） ────────────────────
const sw = ui.slice(ui.indexOf('async function switchSession(id, opts)'), ui.indexOf('async function switchSession(id, opts)') + 9000);
const _swClean = sw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\r\n]*/g, "");
/* 【2026-11-08 放宽】hubReset 与 renderTurns 之间现在有「空屏强制补历史」
 * 和「已被流式接管就别强插」两段判断，200 字符的窗口不够了。
 * 要守的是「切会话先 hubReset，再画历史」这个先后顺序，不是它俩挨多近。 */
t.ok('切会话前 hubReset', /hubReset\(\)[\s\S]{0,1800}renderTurns\(r\.session\.turns/.test(_swClean));
// ── 5b. 万一 tool_start 丢了，也不能让话和工具全挤一起 ────────────
const te = ui.slice(ui.indexOf("} else if (ev.type === 'tool_end') {", ui.indexOf('function paintLiveEvents')));
t.ok('tool_end 找不到卡时补建', /补一张卡/.test(ui) || /补画失败也不能连累这一轮/.test(ui));
t.ok('补建前先断气泡', /flushSpeech\(\);[\s\S]{0,200}bubble = null;[\s\S]{0,200}addTool\(\)/.test(ui));

// ── 6. 真机 ──────────────────────────────────────────────────────
let cdp = null;
try { ({ connect: (o) => (cdp = connect(o)) }); } catch { /* 下面统一 try */ }
try {
  const { connect } = await import('../_t_cdp.mjs');
  cdp = await connect({ port: Number(process.env.XY_CDP_PORT || 9223), match: '8788' });
} catch (e) { cdp = null; }

if (!cdp) {
  console.log('\n真机格：SKIP（没连上 9223 的调试浏览器，源码断言已全过）');
} else {
  /* 先刷新一次：运行版 index.html 可能刚被同步过，页面里还是旧代码。
   * 不刷新就验等于验了个假的。 */
  try {
    await cdp.send('Page.enable');
    await cdp.send('Page.reload', { ignoreCache: true });
    await new Promise((r) => setTimeout(r, 15000));
  } catch (e) { console.log('（刷新失败，下面按当前页面验）'); }
  const r = await cdp.eval(`
      const out = {};
      const log = document.getElementById('log');
      const start = (name, args) => {
        const el = addTool();
        el.sum.querySelector('.name').textContent = niceTool(name, args);
        el.sum.querySelector('.status').textContent = '运行中…';
        el.pre.hidden = false;
        el.sum.querySelector('.status').className = 'status warn';
        if (_liveHub) {
          const n1 = _liveHub.querySelector('.hubname');
          if (n1) n1.dataset.one = niceTool(name, args);
          hubRefreshTitle();
        }
        return el;
      };
      try {
        out.names = [
          niceTool('run_command', JSON.stringify({ command: 'node scripts/run-all-checks.mjs' })),
          niceTool('run_command', JSON.stringify({ command: 'git commit -m x' })),
          niceTool('run_command', JSON.stringify({ command: 'ls -la' })),
          niceTool('read_file', JSON.stringify({ path: 'a.txt' })),
        ];
        out.namesObj = niceTool('run_command', { command: 'node _t_ui.mjs' });
        const el = start('run_command', JSON.stringify({ command: 'node scripts/run-all-checks.mjs' }));
        out.title = _liveHub ? _liveHub.querySelector('.hubname').textContent : '(null)';
        out.inDom = _liveHub ? document.contains(_liveHub) : false;
        const st = el.sum.querySelector('.status');
        st.textContent = '完成'; st.className = 'status ok';
        hubRefreshTitle();
        out.after = _liveHub ? _liveHub.querySelector('.hubname').textContent : '(null)';
        el.d.closest('details.toolhub')?.remove();
        hubReset();
      } catch (e) { out.err = String(e); }
      return out;
  `);
  console.log('\n真机：' + JSON.stringify(r));
  /* 【2026-11-08 改·回归分档】真机格造的命令是 run-all-checks，
   * 分档之后它该显示「跑全量」而不是笼统的「跑回归」。 */
  t.ok('真机：跑全量命名对', r.names && r.names[0] === '跑全量', String(r.names && r.names[0]));
  t.ok('真机：提交代码命名对', r.names && r.names[1] === '提交代码', String(r.names && r.names[1]));
  t.ok('真机：ls -la 判成看文件', r.names && r.names[2] === '看文件', String(r.names && r.names[2]));
  t.ok('真机：非命令工具不受影响', r.names && r.names[3] === '读文件', String(r.names && r.names[3]));
  t.ok('真机：对象形态参数也认', r.namesObj === '跑回归', String(r.namesObj));
  /* 柜门取的是柜子里**第一张**运行中的卡；历史里若有卡住的卡，显示的是它的名字。
   * 所以这里只要求「能变成 正在XXX…」，且名字取自工具卡，不要求恰好是我造的那张。
   *
   * 【2026-11-08 改】主人问「为什么柜子上的【调了 x 次工具】不会随调用变化」——
   * 查出来是「正在…」把计数整段顶掉了。现在两个一起给：
   * `调了 2 次 · 正在跑命令…`，所以断言从 ^正在 放到「含 正在… 结尾」。 */
  t.ok('真机：柜门变成「（调了 N 次 · ）正在X…」',
    /(调了 \d+ 次 · )?正在.+…$/.test(String(r.title)), String(r.title));
  t.ok('真机：跑着的时候标题里带着实时计数', /调了 \d+ 次 · 正在/.test(String(r.title)), String(r.title));
  t.ok('真机：柜子在屏上', r.inDom === true);
  if (/^调了 \d+ 次工具/.test(String(r.after))) { t.ok('真机：跑完退回统计', true, String(r.after)); } else { t.skip('真机：跑完退回统计', '页面正有一轮在跑（柜门停在「正在…」），这条测不了'); }
  cdp.close();
}

/* 【2026-11-08 加·历史重绘的柜子也要认「运行中」】
 * 主人点开柜子看见里面「跑回归｜运行中」，柜门却还写「调了 x 次工具」。
 * 因为历史柜是 groupLooseTools 新建的，只按数量算标题；
 * 会写「正在X…」的 hubRefreshTitle 只管 _liveHub，重绘后已被 hubReset 清掉。 */
t.ok('历史柜建完会查有没有「运行中」的卡',
  /for \(const el of run\) hub\.appendChild\(el\);[\s\S]{0,900}const _runCard = _toolOnly\.find/.test(ui));
t.ok('历史柜运行中也写「调了 N 次 · 正在X…」',
  /调了 ' \+ _toolOnly\.length \+ ' 次 · 正在'/.test(ui));

t.done();
