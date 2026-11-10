/**
 * 【把 check-ui 的「数组解构」识别逻辑单独锁起来】
 *
 * 为什么单独做一条：
 *
 * 2026-11-09 #15 改 React 重写时，`scripts/check-ui.mjs` 报了一个假红 ——
 * `setOpen 被当变量用，但全文没有 const/let/var/function 声明`，
 * 而 preflight 把这条判成「这个页面打开会白屏」，整条闸就红了。
 *
 * 根因：check-ui 的「已声明」集合认 `const {a, b}`（对象解构），
 * **不认 `const [open, setOpen] = useState(...)`（数组解构）**。
 * 而 React 里满屏都是数组解构 —— 那份 `public/ui/log.bundle.js` 里就有 5 处。
 *
 * 已经修了（见 check-ui.mjs 里 2026-11-09 那段注释）。但那个修法藏在
 * check-ui 里两千多行的中间，**很容易在下次改 check-ui 时被人「顺手简化」掉，
 * 而且没人会立刻发现** —— 它不像别的检查那样有独立的红灯。
 *
 * 所以这里把那段识别逻辑**照着真实输入锁一遍**：纯文本喂进去，断言认不认。
 * 一旦有人把 check-ui 的解构识别改坏，这条立刻红，而且指名道姓说是哪个形状。
 *
 * 用法：node scripts/check-ui-destructuring.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('check-ui / 解构识别');

const ROOT = process.cwd();
const CHECK_UI = path.join(ROOT, 'scripts', 'check-ui.mjs');

if (!fs.existsSync(CHECK_UI)) {
  t.ok('check-ui.mjs 存在', false, CHECK_UI);
  t.done();
  process.exit(0);
}

/**
 * 造一个最小页面，跑真实的 check-ui，读回它的「疑似未定义变量」结论。
 *
 * 为什么不直接调 check-ui 内部函数：它没 export 任何东西（纯脚本）。
 * 与其为了可测性去改它的结构，不如就按它的**真实用法**跑一遍 ——
 * 这样连「脚本怎么被调用、输出怎么被判红」一起验了，更接近线上。
 *
 * @param {string} code 塞进 <script> 的 JS
 * @returns {{flagged: Set<string>, output: string}}
 */
function runCheckUi(code) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-ui-destr-'));
  const file = path.join(dir, 'index.html');
  fs.writeFileSync(file, [
    '<!DOCTYPE html>',
    '<html><head><meta charset="utf-8"><title>destructuring probe</title></head>',
    '<body>',
    '<script>',
    code,
    '</script>',
    '</body></html>',
  ].join('\n'), 'utf8');

  let output = '';
  try {
    output = execFileSync(process.execPath, [CHECK_UI, file], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, MINI_AGENT_DATA: dir },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    /* check-ui 有致命问题时退出码是 1 —— 那正是我们要读的结论，不是崩了 */
    output = String(e.stdout || '') + String(e.stderr || '');
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 临时目录 */ }
  }

  const flagged = new Set();
  for (const m of output.matchAll(/✘\s+([A-Za-z_$][\w$]*)\s+被当变量用/g)) flagged.add(m[1]);
  return { flagged, output };
}

/* ══════════════════════════════════════════════════════════
   ① React 最常见的形状：const [x, setX] = useState(...)
   ══════════════════════════════════════════════════════════ */
{
  const { flagged } = runCheckUi([
    'const [open, setOpen] = [false, function (v) { return v; }];',
    'setOpen(open);',
  ].join('\n'));
  t.ok('const [open, setOpen] = ... 里的 setOpen 算已声明', !flagged.has('setOpen'), [...flagged].join(','));
  t.ok('const [open, setOpen] = ... 里的 open 算已声明', !flagged.has('open'), [...flagged].join(','));
}

/* ② 多个元素 */
{
  const { flagged } = runCheckUi([
    'const [a, setA, flagX, setFlagX] = [1, 2, 3, 4];',
    'setA(a); setFlagX(flagX);',
  ].join('\n'));
  t.ok('数组解构里第 3、4 个名字也算已声明', !flagged.has('flagX') && !flagged.has('setFlagX'), [...flagged].join(','));
}

/* ③ 空位跳过：const [, second] = ... */
{
  const { flagged } = runCheckUi([
    'const [, secondItem] = [1, 2];',
    'secondItem();',
  ].join('\n'));
  t.ok('空位跳过 const [, secondItem] 里的名字算已声明', !flagged.has('secondItem'), [...flagged].join(','));
}

/* ④ 默认值：const [count = 0] = ... */
{
  const { flagged } = runCheckUi([
    'const [countNum = 0] = [];',
    'countNum();',
  ].join('\n'));
  t.ok('带默认值 const [countNum = 0] 里的名字算已声明', !flagged.has('countNum'), [...flagged].join(','));
}

/* ⑤ 剩余：const [head, ...tailItems] = ... */
{
  const { flagged } = runCheckUi([
    'const [headItem, ...tailItems] = [1, 2, 3];',
    'tailItems(); headItem();',
  ].join('\n'));
  t.ok('剩余 const [headItem, ...tailItems] 两边都算已声明',
    !flagged.has('headItem') && !flagged.has('tailItems'), [...flagged].join(','));
}

/* ⑥ 嵌套：const [x, [y, z]] = ... */
{
  const { flagged } = runCheckUi([
    'const [outerX, [innerY, innerZ]] = [1, [2, 3]];',
    'outerX(); innerY(); innerZ();',
  ].join('\n'));
  t.ok('嵌套 const [outerX, [innerY, innerZ]] 三个名字都算已声明',
    !flagged.has('outerX') && !flagged.has('innerY') && !flagged.has('innerZ'), [...flagged].join(','));
}

/* ⑦ 函数参数里的数组解构：( [a, b] ) => ... */
{
  const { flagged } = runCheckUi([
    'const picker = ([leftVal, rightVal]) => leftVal + rightVal;',
    'picker([1, 2]);',
  ].join('\n'));
  t.ok('箭头函数参数里的数组解构算已声明',
    !flagged.has('leftVal') && !flagged.has('rightVal'), [...flagged].join(','));
}

/* ⑧ for...of 里的数组解构 */
{
  const { flagged } = runCheckUi([
    'const pairs = [[1, 2]];',
    'for (const [keyName, valName] of pairs) { keyName(); valName(); }',
  ].join('\n'));
  t.ok('for (const [keyName, valName] of ...) 两个名字算已声明',
    !flagged.has('keyName') && !flagged.has('valName'), [...flagged].join(','));
}

/* ══════════════════════════════════════════════════════════
   ⑨ 反向：真没声明的，必须照抓 —— 否则就是修成了哑巴
   ══════════════════════════════════════════════════════════ */
{
  const { flagged } = runCheckUi([
    'const [openState, setOpenState] = [1, 2];',
    'setOpenState(openState);',
    'totallyMissingFunc();',
  ].join('\n'));
  t.ok('解构认了，但真未声明的 totallyMissingFunc 仍然抓得到', flagged.has('totallyMissingFunc'), [...flagged].join(','));
  t.ok('真错存在时，解构那些名字不被冤枉',
    !flagged.has('setOpenState') && !flagged.has('openState'), [...flagged].join(','));
}

/* ⑩ 对象解构别被这次改动冲掉 */
{
  const { flagged } = runCheckUi([
    'const {alpha, beta: betaAlias} = {alpha: 1, beta: 2};',
    'alpha(); betaAlias();',
  ].join('\n'));
  t.ok('对象解构仍然算已声明（别被数组那条改动冲掉）',
    !flagged.has('alpha') && !flagged.has('betaAlias'), [...flagged].join(','));
}

/* ══════════════════════════════════════════════════════════
   ⑪ 真页面：React 打包产物在 preflight 里不许再报解构假红
   ══════════════════════════════════════════════════════════ */
{
  const bundleDir = path.join(ROOT, 'public', 'ui');
  const bundle = path.join(bundleDir, 'log.bundle.js');
  if (!fs.existsSync(bundle)) {
    t.skip('真页面里的 React bundle 检查', '没有 public/ui/log.bundle.js');
  } else {
    const src = fs.readFileSync(bundle, 'utf8');
    /* 只认「真的是数组解构声明出来的名字」，避免拿一堆无关名字误判 */
    const names = new Set();
    for (const m of src.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) {
      for (const p of m[1].split(',')) {
        const nm = p.trim().replace(/^\.\.\./, '').split(/[=:]/)[0].trim();
        if (/^[a-zA-Z_$][\w$]*$/.test(nm)) names.add(nm);
      }
    }
    console.log('  [..] bundle 里数组解构声明出 ' + names.size + ' 个名字：' + [...names].slice(0, 8).join(','));

    /* 跑真 check-ui，看它现在还会不会因为这些名字报红 */
    let out = '';
    try {
      out = execFileSync(process.execPath, [CHECK_UI], { encoding: 'utf8', timeout: 60000 });
    } catch (e) {
      out = String(e.stdout || '') + String(e.stderr || '');
    }
    const flaggedNow = new Set();
    for (const m of out.matchAll(/✘\s+([A-Za-z_$][\w$]*)\s+被当变量用/g)) flaggedNow.add(m[1]);
    const collided = [...names].filter((n) => flaggedNow.has(n));
    t.ok('真页面上，数组解构声明出来的名字一个都不该被判红', collided.length === 0, collided.join(','));
  }
}

t.done();