#!/usr/bin/env node
/**
 * 【2026-11-10 主人问「为什么是 0MB」】：语音引擎设置页话术守卫（纯静态）
 *
 * 真 bug（已修，这里钉住别复发）：
 *   · 这台机器本来就有 python + edge_tts + ffmpeg，静默安装走了「本机已有的」短路，
 *     一份东西都没往 data/runtime 里放（那个目录压根不存在），标记文件里 bytes 硬编码 0；
 *   · 而 runtimeInfo() 把 RUNTIME 当成「Python 和 ffmpeg 的目录」报出去，
 *     前端照着拼 → 「Python 和 ffmpeg 都在 <不存在的目录>，占 0 MB」。
 *     主人一看就懵：为什么是 0MB？
 *
 * 只做静态断言：不连 CDP、不起浏览器（历史教训：检查里连 CDP 会拖垮全量回归）。
 * 行为层由人肉 + check-ui / check-frontend-refs 覆盖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const vr = read('src/voice-runtime.mjs');
const html = read('public/index.html');

/* 只截 runtimeInfo() 函数体，别把整个文件当上下文（installRuntime 里也有 dirSize(RUNTIME)，
   那是真的在统计自己装的东西，合法）。 */
function fnBody(src, name) {
  const i = src.indexOf('export function ' + name + '(');
  const j = i >= 0 ? i : src.indexOf('function ' + name + '(');
  if (j < 0) return '';
  // 从函数头往后找第一个顶格（行首无缩进）的 '}' —— 本文件的函数都是顶层导出
  const k = src.indexOf('\n}', j);
  return k > j ? src.slice(j, k + 2) : src.slice(j, j + 4000);
}

const info = fnBody(vr, 'runtimeInfo');
const paintI = html.indexOf('function vrPaint(');
const paint = paintI >= 0 ? html.slice(paintI, html.indexOf('\n}\n', paintI) + 2) : '';

console.log('\n一、后端 runtimeInfo()：using / pythonRealPath / ffmpegRealPath 都得有');
{
  ok(Boolean(info), 'src/voice-runtime.mjs 里找得到 export function runtimeInfo()');
  ok(/using\s*,/.test(info) || /\busing\s*:/.test(info), 'status 返回里带 using 字段（前端靠它换话术）');
  ok(/pythonRealPath\s*:/.test(info), 'status 返回里带 pythonRealPath（真正在用的解释器，不是 runtime 下的占位）');
  ok(/ffmpegRealPath\s*:/.test(info), 'status 返回里带 ffmpegRealPath');
  ok(/mark\.using/.test(info), 'using 是从标记文件里读出来的，不是写死的');
  ok(/mark\.python/.test(info) && /mark\.ffmpeg/.test(info),
    '本机已有时 pythonRealPath / ffmpegRealPath 取自标记文件里存下来的真实路径');
}

console.log('\n二、后端 bytes 语义：不再无条件 dirSize(RUNTIME)');
{
  /* 老写法（会报 0MB 的根源）：bytes: hasPy || hasFf ? dirSize(RUNTIME) : 0 */
  ok(!/bytes\s*:\s*hasPy\s*\|\|\s*hasFf\s*\?\s*dirSize\(RUNTIME\)\s*:\s*0/.test(info),
    'status 里的 bytes 不是「hasPy||hasFf 就统计 RUNTIME」的老写法');
  const m = info.match(/bytes\s*:\s*([^\n]*)/);
  const expr = m ? m[1] : '';
  ok(/\bexternal\b/.test(expr), 'bytes 的取值受 external（本机已有的）约束', '现在是：bytes: ' + expr.trim());
  ok(/dirSize\(RUNTIME\)/.test(info),
    'dir 仍然指向我们自己的 runtime 目录（只在「自己装的」那一路才谈体积）');
}

console.log('\n三、前端 vrPaint()：按 using 分三套话术');
{
  ok(Boolean(paint), 'public/index.html 里找得到 function vrPaint(');
  ok(/r\.using/.test(paint), 'vrPaint 用到了 r.using（以前后端存了、前端一个字都没用）');
  ok(/'本机已有的'/.test(paint), 'vrPaint 认得「本机已有的」这个值');
  ok(/pythonRealPath/.test(paint) && /ffmpegRealPath/.test(paint),
    '「本机已有的」那套话术报的是真实路径（pythonRealPath / ffmpegRealPath）');
}

console.log('\n四、前端不许再出现「都在 <dir>，占 0 MB」这类拼接');
{
  /* 可疑 1：说「都在 ${...dir}」—— 「都」意味着 python+ffmpeg 在那个目录里，
     本机已有时那个目录根本不存在。 */
  const bad1 = /\$\{[^}]*\.dir[^}]*\}[\s\S]{0,40}?占\s*\$\{[^}]*\.bytes/.test(paint)
    || /都在\s*\$\{[^}]*dir/.test(paint);
  ok(!bad1, '没有「都在 ${...dir} … 占 ${...bytes}」这种把 0MB 和 runtime 目录拼一起的写法');

  /* 可疑 2：直接拿 r.bytes 算体积而没经过任何 > 0 判定（0MB 就是这么报出来的） */
  ok(!/\$\{mb\(r\.bytes\)\}/.test(paint),
    '模板里没有裸的 ${mb(r.bytes)}（必须先判 bytes > 0，否则 0MB 会漏到界面上）');

  /* 自己装的那一路仍然要说清「装在哪 + 占多少」，别矫枉过正把信息全删了 */
  ok(/r\.dir/.test(paint) && /mb\(ownBytes\)/.test(paint),
    '自己装的那套话术还在：装到 ${r.dir}、占 mb(ownBytes) MB');

  /* 「有 python + ffmpeg 但没装好记录」那条分支，也不许报 0MB / 报 runtime 目录 */
  ok(!/环境齐了（\$\{r\.dir\}）/.test(paint), '「环境齐了」那条分支不再把 r.dir 当路径报出去');
}

console.log('\n五、删除/说明文案：不许写死「108 MB」（本机已有时根本没那么多东西可删）');
{
  /* 本机已有 → 删的只是一个标记文件 + 一个不存在的目录，什么都不省。
     所以界面文案里不许再出现「108 MB」这种硬编码的体积。 */
  const userText = html
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)) // 剔掉纯注释行（代码注释里的 108 不算界面文案）
    .join('\n');
  ok(!/108\s*MB/.test(userText), 'index.html 界面文案里没有写死的「108 MB」',
    '仍有：' + (userText.split('\n').find((l) => /108\s*MB/.test(l)) || '').trim().slice(0, 160));

  /* 删除确认框必须按 using 分两套：本机已有的那套要明说「原有的一点不动 / 腾不出空间」 */
  const remI = html.indexOf('rem.onclick');
  const remSeg = remI >= 0 ? html.slice(remI, remI + 2200) : '';
  ok(Boolean(remSeg), 'index.html 里找得到删除按钮 rem.onclick');
  ok(/cur\.using\s*===\s*'本机已有的'/.test(remSeg),
    '删除确认框读取了 using（先查状态再问人，不是盲删）');
  ok(/原有|不会动/.test(remSeg), '删除确认框里有「你原有的 Python 不动」这类交代');
  ok(/mbTxt/.test(remSeg) && /ownBytes/.test(remSeg),
    '自己装的那套按实际 bytes 算体积（mbTxt），不是写死的数');
  ok(!/约\s*108|省了\s*108/.test(remSeg), '删除确认框 / 删除成功提示里没有「约 108 / 省了 108」');

  /* 设置页那段静态说明也不许把体积说成固定的 108，得提「本来就有就用现成的」 */
  const descI = html.indexOf('从国内镜像下');
  const descSeg = descI >= 0 ? html.slice(descI, descI + 400) : '';
  ok(Boolean(descSeg), '找得到语音引擎那段静态说明');
  ok(/本来就有|现成/.test(descSeg), '静态说明里提到「机器上本来就有就用现成的，不额外占空间」');
  ok(!/大约\s*108\s*MB/.test(descSeg), '静态说明不写死「大约 108 MB」');
}

console.log('\n六、指向性文案：别把人指到不存在的地方（2026-11-10 全仓扫描查出）');
{
  /* 界面文案（不含注释行）—— 这两条都是「说了个不存在的东西」，主人照着找会找不到。 */
  const uiText = html
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\/\*|\*|<!--)/.test(l))
    .join('\n');

  /* 1) 鱼/鲸开关 2026-11-02 按主人要求从顶栏撤了（只剩左侧「屋里的人」那列牌子）。
        再说「按下顶栏那颗按钮」，人会去顶栏翻半天。 */
  ok(!/顶栏那颗按钮/.test(uiText),
    '界面文案里没有「顶栏那颗按钮」（鱼/鲸开关早撤了，开关在左边「屋里的人」）',
    '仍有：' + (uiText.split('\n').find((l) => /顶栏那颗按钮/.test(l)) || '').trim().slice(0, 160));
  ok(/屋里的人/.test(uiText) && /牌子/.test(uiText),
    '「没人应」那条提示改成指左侧「屋里的人」牌子了');

  /* 2) 汇率是环境变量（server.mjs 的 XY_USD_PER_CNY），设置页里根本没有这个数。
        再说「汇率读的是设置里那个数」，等于让人去设置里找一个不存在的输入框。 */
  ok(!/设置里那个数/.test(uiText),
    '界面文案里没有「设置里那个数」（汇率来自配置/环境变量，界面上改不了）',
    '仍有：' + (uiText.split('\n').find((l) => /设置里那个数/.test(l)) || '').trim().slice(0, 160));
  ok(/在配置里定死|界面上改不了/.test(uiText),
    '汇率说明交代了「这个值在配置里定死、界面上改不了」');

  /* 3) ⏹ 在「发送」左边，别写「右边」 */
  ok(!/点右边 ⏹/.test(uiText), '没有「点右边 ⏹」（停止键实际在发送键左边）');
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);