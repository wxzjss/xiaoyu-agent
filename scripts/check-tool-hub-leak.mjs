/**
 * 【工具卡会不会跑到柜子外面】
 *
 * 主人 2026-11-08：「严检调用工具显示是否会跑到柜子外面」。
 *
 * 这个现象历史上反复出现过（散卡、柜套柜、展开被挤掉、话和工具挤一起），
 * 每次都靠事后一个个调用点补 foldLiveTools —— 调用点有七八处，加一处就容易忘。
 *
 * 现在分两层守：
 *   ① 静态：历史重画出来的 DOM 里，不许有散在 log 上的 tool / think，
 *      不许柜套柜、不许空柜、内部元素不许溢出柜子边界
 *   ② 自愈：随便造一张「野卡」直接挂到 log 上，MutationObserver 必须把它收进柜子
 *      （这条是保底 —— 以后哪条路忘了合柜，用户也不会真的看到散卡）
 */
import { makeChecker } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';
import fs from 'node:fs';
import { connect } from '../_t_cdp.mjs';

const t = makeChecker('ui / 工具卡别跑出柜子');
const _uiHtml = readUISource();
// 【2026-11-08】柜子那组函数已搬进 ui/hub.js（commit c001137），守卫要跟着去新家找
const _hubJs = fs.existsSync('public/ui/hub.js') ? fs.readFileSync('public/ui/hub.js', 'utf8') : '';
const ui = _uiHtml + '\n' + _hubJs;

// ── 1. 源码守卫 ────────────────────────────────────────────────
t.ok('有自愈守卫 installToolLeakGuard', /function installToolLeakGuard\(\)/.test(ui));
t.ok('守卫挂在 foldLiveTools 上（首次合柜时装）',
  /function foldLiveTools\(\) \{[\s\S]{0,260}installToolLeakGuard\(\)/.test(ui));
t.ok('守卫用 MutationObserver 盯 log 的直接子节点',
  /new MutationObserver\(/.test(ui) && /mo\.observe\(logEl, \{ childList: true \}\)/.test(ui));
t.ok('守卫会先把散卡补登进 _liveToolEls（不然 foldLiveTools 看不见它）',
  /_liveToolEls\.push\(el\)/.test(ui));
t.ok('有防重入标志（避免 fold → 触发 → 再 fold）', /_leakGuardBusy/.test(ui));

// ── 2. 真机 ────────────────────────────────────────────────────
let cdp = null;
try { cdp = await connect({ port: Number(process.env.XY_CDP_PORT || 9223), match: '8788' }); } catch { cdp = null; }

if (!cdp) {
  console.log('\n真机格：SKIP（没连上 9223 的调试浏览器，源码断言已过）');
} else {
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 12000));

  // 2a. 历史 DOM 干净吗
  const stat = await cdp.eval(`
    const log = document.getElementById('log');
    if (!log) return { err: 'no log' };
    const kids = [...log.children];
    const looseTool = kids.filter((el) => el.tagName === 'DETAILS' && el.classList.contains('tool')).length;
    const looseThink = kids.filter((el) => el.tagName === 'DETAILS' && el.classList.contains('think')).length;
    const hubs = kids.filter((el) => el.tagName === 'DETAILS' && el.classList.contains('toolhub'));
    const emptyHubs = hubs.filter((h) => !h.querySelector('details.tool, details.think')).length;
    let overflow = 0;
    for (const hub of hubs) {
      const hr = hub.getBoundingClientRect();
      for (const kid of hub.querySelectorAll('details.tool, details.think, pre, .thinkBody, summary')) {
        const kr = kid.getBoundingClientRect();
        if (kr.right > hr.right + 2 || kr.left < hr.left - 2) overflow += 1;
      }
    }
    return {
      looseTool, looseThink,
      hubs: hubs.length,
      emptyHubs,
      nestedHub: log.querySelectorAll('details.toolhub details.toolhub').length,
      overflow,
    };
  `);
  console.log('  历史 DOM：' + JSON.stringify(stat));
  t.ok('历史里没有散在外面的工具卡', stat.looseTool === 0, String(stat.looseTool));
  t.ok('历史里没有散在外面的思考块', stat.looseThink === 0, String(stat.looseThink));
  t.ok('没有柜套柜', stat.nestedHub === 0, String(stat.nestedHub));
  t.ok('没有空柜子', stat.emptyHubs === 0, String(stat.emptyHubs));
  t.ok('柜内元素没有溢出柜子边界', stat.overflow === 0, String(stat.overflow));

  // 2b. 自愈：造一张野卡，必须被收走
  const guard = await cdp.eval(`
    const log = document.getElementById('log');
    try { foldLiveTools(); } catch (e) {}
    const installed = !!log.__leakGuard;
    const d = document.createElement('details');
    d.className = 'tool';
    d.innerHTML = '<summary class="toolHead"><span class="name">野卡</span><span class="status ok">完成</span></summary><pre>x</pre>';
    log.appendChild(d);
    const rightAfter = [...log.children].filter((x) => x.classList && x.classList.contains('tool')).length;
    await new Promise((r) => setTimeout(r, 400));
    const after = [...log.children].filter((x) => x.classList && x.classList.contains('tool')).length;
    const movedIn = !!d.closest('details.toolhub');
    d.remove();
    return { installed, rightAfter, after, movedIn };
  `);
  console.log('  自愈格：' + JSON.stringify(guard));
  t.ok('守卫装上了', guard.installed === true);
  t.ok('野卡刚挂上去时确实是散的（说明测试有效）', guard.rightAfter >= 1, String(guard.rightAfter));
  t.ok('自愈：散卡被自动收回', guard.after === 0, String(guard.after));
  t.ok('自愈：卡真的进了柜子', guard.movedIn === true);

  cdp.close();
}

t.done();
