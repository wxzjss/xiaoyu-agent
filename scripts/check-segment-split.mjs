#!/usr/bin/env node
/**
 * 【2026-11-09 主人报·多段消息堆一块】
 *
 * 症状：长时间做任务做久了，好几轮的话堆进同一个气泡里（跟「正在发送消息」
 * 自己消失是同一个时间点发生的）。
 *
 * 病根：排队轮（插话 / 定时任务 / 续跑）复用同一份 live 续写，
 * 可 `done` 不是分段线 —— 下一轮的第一段正文接着上一轮最后那段往下拼。
 *
 * 这条检查把三份规则抽出来单独跑（不启服务、不连浏览器）：
 *   ① src/server.mjs 的 appendLiveItem（增量攒清单，界面一直在读它）
 *   ② src/server.mjs 的 buildLiveItems（从头重算）
 *   ③ public/index.html 的 itemsFromEvents（前端镜像）
 * 三份都必须把 done/aborted/error 当分段线，且结果一致。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRV = fs.readFileSync(path.join(ROOT, 'src/server.mjs'), 'utf8').replace(/\r\n/g, '\n');
const UI = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const t = {
  ok(name, cond, extra) {
    if (cond) { pass++; console.log('  OK  ' + name); }
    else { fail++; console.log('  [!!] ' + name + (extra ? '  →  ' + extra : '')); }
  },
};

/** 从源码里按大括号配平抠出一个函数体 */
function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('源码里找不到 ' + name);
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error(name + ' 大括号没配平');
}

const srvMod = new Function(
  grab(SRV, 'appendLiveItem') + '\n' + grab(SRV, 'buildLiveItems')
  + '\nreturn { appendLiveItem, buildLiveItems };',
)();
/* 【2026-11-09 换框架】前端那份 itemsFromEvents 已经**删掉**了 ——
 * 那是「同一件事两边各算一遍」的第二本账：段落划分稍有不同，屏幕上就是
 * 「跑着的时候三个气泡、刷新一下变两个」。现在前端只用服务端给的 items，
 * 所以这条检查只剩服务端两份实现要对齐，外加一条「前端别再长出第三份」的守卫。 */
const FE_MIRROR_GONE = !/function\s+itemsFromEvents\s*\(/.test(UI);

const textsOf = (items) => items.filter((x) => x && x.k === 'text').map((x) => x.t);
const buildBoth = (evs) => {
  const inc = [];
  for (const e of evs) srvMod.appendLiveItem(inc, e);
  return { inc, one: srvMod.buildLiveItems(evs) };
};

console.log('\n一、轮末就是分段线');

const twoRounds = [
  { type: 'text', text: '第一轮说的话' },
  { type: 'done' },
  { type: 'text', text: '插话之后的第二轮' },
];
{
  const { inc, one } = buildBoth(twoRounds);
  t.ok('增量版：两轮的正文分成两条', textsOf(inc).length === 2, JSON.stringify(textsOf(inc)));
  t.ok('一次性版：两轮分成两条', textsOf(one).length === 2, JSON.stringify(textsOf(one)));
  t.ok('前端不再自己合成 items（只有服务端算一遍）', FE_MIRROR_GONE);
  t.ok('分段后正文一个字都没丢',
    textsOf(inc).join('') === '第一轮说的话插话之后的第二轮'
    && textsOf(one).join('') === textsOf(inc).join(''));
}

{
  const evs = [{ type: 'text', text: 'A' }, { type: 'aborted' }, { type: 'text', text: 'B' }];
  const { inc, one } = buildBoth(evs);
  t.ok('aborted 也分段（两份一致）',
    textsOf(inc).length === 2 && textsOf(one).length === 2);
}

{
  const evs = [{ type: 'text', text: 'A' }, { type: 'error', message: 'x' }, { type: 'text', text: 'B' }];
  const { inc, one } = buildBoth(evs);
  t.ok('error 也分段（两份一致）',
    textsOf(inc).length === 2 && textsOf(one).length === 2);
}

{
  /* rate_limited 是同一轮里的重试：不许断开，否则一句话被劈成两个气泡 */
  const evs = [{ type: 'text', text: '前半句' }, { type: 'rate_limited', streak: 1 }, { type: 'text', text: '后半句' }];
  const { inc, one } = buildBoth(evs);
  t.ok('rate_limited 不断开（同一轮重试）',
    textsOf(inc).length === 1 && textsOf(one).length === 1,
    JSON.stringify([textsOf(inc), textsOf(one)]));
}

console.log('\n二、一轮之内：工具卡该断，正文不该丢');

{
  const evs = [
    { type: 'text', text: '先说话' },
    { type: 'tool_start', id: 'c1', name: 'run_command', args: '{}' },
    { type: 'tool_end', id: 'c1', ok: true, output: 'ok' },
    { type: 'text', text: '再说一句' },
    { type: 'done' },
    { type: 'text', text: '下一轮' },
  ];
  const { inc, one } = buildBoth(evs);
  const want = ['先说话', '再说一句', '下一轮'];
  t.ok('工具隔开的正文分段 + 轮末再分段（增量）', JSON.stringify(textsOf(inc)) === JSON.stringify(want), JSON.stringify(textsOf(inc)));
  t.ok('工具隔开的正文分段 + 轮末再分段（一次性）', JSON.stringify(textsOf(one)) === JSON.stringify(want));
  t.ok('顺序仍是「正文→工具→正文」，没被重排',
    inc.map((x) => x.k).join(',') === 'text,tool,text,text');
}

console.log('\n三、两份合成器长期等价（含轮末事件）');

{
  const evs = [];
  for (let n = 1; n <= 200; n++) {
    evs.push({ type: 'text', text: n + '. 第' + n + '句。\n' });
    if (n % 9 === 0) { evs.push({ type: 'tool_start', id: 'c' + n, name: 'run_command', args: '{}' }); evs.push({ type: 'tool_end', id: 'c' + n, ok: true, output: 'ok' }); }
    if (n % 25 === 0) evs.push({ type: 'done' });          // 排队轮续写
    if (n % 40 === 0) evs.push({ type: 'reasoning', text: '想' + n });
    if (n % 17 === 0) evs.push({ type: 'text', notice: true, text: '（还在跑）' });
  }
  const { inc, one } = buildBoth(evs);
  t.ok('增量版 == 一次性版（JSON 逐字相等）', JSON.stringify(inc) === JSON.stringify(one), inc.length + ' vs ' + one.length);
  /* 8 个 done → 至少 8 条正文段 */
  t.ok('8 次轮末真的断出了 8 段以上正文', textsOf(inc).length >= 8, String(textsOf(inc).length));
  t.ok('正文首尾都在（不受压薄影响）',
    textsOf(inc).join('').includes('第1句') && textsOf(inc).join('').includes('第200句'));
}

console.log('\n四、源码层面钉住「这个洞别再开」');

{
  t.ok('服务端增量版认轮末（done/aborted/error）',
    /if \(ev\.type === 'done' \|\| ev\.type === 'aborted' \|\| ev\.type === 'error'\)/.test(SRV));
  t.ok('服务端一次性版认轮末',
    /if \(e\.type === 'done' \|\| e\.type === 'aborted' \|\| e\.type === 'error'\) \{ flush\(\); continue; \}/.test(SRV));
  /* 【2026-11-09 判据改口径】原来这条查「前端镜像也认轮末」。
   * 前端那份合成器已经整段删了，所以该守的变成**反面**：
   * 别再长出第三份（那正是这一轮要根治的东西）。 */
  t.ok('前端不再有第三份合成器（itemsFromEvents 已删）', FE_MIRROR_GONE);
  t.ok('轮末标记不会被 JSON 带出去（不可枚举）',
    /Object\.defineProperty\(it, '__segEnd', \{ value: true, enumerable: false/.test(SRV));
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
