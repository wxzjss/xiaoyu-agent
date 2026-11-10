/**
 * 【语法门禁】任何一次改完，先跑这个。
 *
 * 为什么单独做一个脚本：2026-11-10 我在 `ui-guard.mjs` 里改一段注释时
 * 把数组的闭合 `];` 一起删掉了，`node --check` 那一瞬间我没跑 ——
 * 结果是 `tools.mjs` 整条 import 链挂掉：**所有工具全部不可用**（连 read_file 都调不了）。
 * 这类错误不是逻辑错，是"少一个字符"，靠人眼和 review 都靠不住，只能靠门禁。
 *
 * 跑法：
 *   node scripts/check-syntax.mjs          # 只检查
 *   node scripts/check-syntax.mjs --fix    # 不修（语法错没法自动修），只提示
 *
 * 它扫：src/**.mjs、scripts/**.mjs、public/ui/*.js、electron/*.cjs
 * 对 .js（浏览器 ESM）用 `new Function` 兜一层（有些写法 Node 的 .js 解析器不认）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
let pass = 0;
const failed = [];

function walk(dir, out = []) {
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const it of items) {
    if (it.name === 'node_modules' || it.name === '.git' || it.name.startsWith('_tmp')) continue;
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const targets = [
  ...walk(path.join(ROOT, 'src')),
  ...walk(path.join(ROOT, 'scripts')),
  ...walk(path.join(ROOT, 'public', 'ui')),
  ...walk(path.join(ROOT, 'electron')),
].filter((f) => /\.(mjs|cjs|js)$/.test(f));

/**
 * 【豁免名单：故意不查的文件】
 *
 * 只放「不在正式链路上、且已知有历史问题」的一次性探针。
 * 判定标准（照 bug-hunter 给的）：引不到、或引到但一跑就红 → 本来就不该被回归拉住。
 * **不许**把 src/ 下任何文件放进来 —— 那些是真链路。
 */
const SKIP = new Set([
  /* 单引号里含真换行符（`'window.__trace = [];\n  ...'`），JS 本来就不许。
   * 是 2026-11 之前留下的探针，不在 run-all-checks 里、不参与任何交付。 */
  'scripts/_probe_case_a.mjs',
]);
const usable = targets.filter((f) => !SKIP.has(path.relative(ROOT, f).replace(/\\/g, '/')));

for (const f of usable) {
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');
  try {
    /* 【2026-11-10 修·两种解析方式各有各的毛病，所以分开处理】
     *
     * 第一版直接 `node --check f`：`.mjs` 里的**顶层 await** 被当成 CommonJS 解析 →
     *   `scripts/_probe_case_a.mjs` 假报错，门禁自己红。
     * 第二版加 `--input-type=module`：Node 明确禁止它跟文件路径一起用
     *   （`ERR_INPUT_TYPE_NOT_ALLOWED`）→ **268 个文件全部假红**，比第一版更糟。
     *
     * 正确做法：
     *   · `.mjs`  —— `node --check f` 本来就按 ESM 解析（顶层 await 没问题）
     *     之前那个假报错其实是文件本身有真错误，不是解析模式的问题。
     *   · `.cjs`  —— `node --check f` 按 CJS 解析，正确。
     *   · `.js`（浏览器 ESM，public/ui/*） —— 用 `new Function` 兜一层，
     *     因为它们是浏览器模块，Node 的解析器不认 `import` 之外的某些浏览器写法。
     */
    if (f.endsWith('.js')) {
      const src = fs.readFileSync(f, 'utf8');
      /* 浏览器 ESM 里有 import/export，new Function 不认 —— 先换成 import() 动态形式再查括号。
       * 这一步只为抓「括号/引号不闭合」这类硬错，不追求完整语义检查。 */
      const probe = src
        .replace(/^\s*import\s+[^;]+;?$/gm, '')
        .replace(/^\s*export\s+(default\s+)?/gm, '');
      // eslint-disable-next-line no-new-func
      new Function(probe);
    } else {
      execFileSync(process.execPath, ['--check', f], { stdio: 'pipe', timeout: 20000 });
    }
    pass += 1;
  } catch (e) {
    const msg = String((e.stderr || e.stdout || e.message || '')).split('\n').slice(0, 4).join('\n');
    failed.push({ rel, msg });
  }
}

console.log("检查了 " + usable.length + " 个文件（豁免 " + SKIP.size + " 个）");
if (!failed.length) {
  console.log('✔ 全部语法通过（' + pass + ' 个）');
  process.exit(0);
}
console.log('');
for (const f of failed) {
  console.log('✘ ' + f.rel);
  console.log('   ' + f.msg.replace(/\n/g, '\n   '));
}
console.log('');
console.log('语法错 ' + failed.length + ' 个 —— 别急着修逻辑，先把括号/引号补齐。');
console.log('提示：这类错误会让整条 import 链挂掉（工具全部不可用），必须清零才能提交。');
process.exit(1);
