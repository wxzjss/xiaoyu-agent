/**
 * 生效同步检查：改了代码，程序真的会用到吗？
 *
 * 【为什么要有这个 · 2026-11-05 严检踩到】
 * 这个程序是打包版在跑。它加载代码的位置和仓库不是同一个地方：
 *
 *   后端 src/*.mjs   → <数据目录>/code/src/   （main.cjs 的 importSrc 优先从这儿加载）
 *   前端 public/*    → <数据目录>/public/     （server.mjs 的 PUBLIC_OVERRIDE 优先读这儿）
 *
 * 而我在仓库 D:\小鱼Agent 里改了半天 index.html、跑了一堆检查全绿 ——
 * 界面一点没变，因为程序读的根本不是那一份。
 * 「改了不生效」比「没改」更坑：主人以为好了，其实什么都没发生。
 *
 * 这个脚本就守这一条：仓库里的正式文件和真正生效的那份，必须逐字节一致。
 * 不一致就报 FAIL，并告诉怎么同步。只读，不改任何文件。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = 'D:/小鱼Agent';
const DATA = path.join(process.env.APPDATA || '', '小鱼Agent', 'data');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };

console.log('生效同步检查');
console.log('  仓库：' + REPO);
console.log('  生效：' + DATA);

if (!fs.existsSync(DATA)) {
  console.log('\n· 这台机器没有数据目录，说明仓库就是生效的，跳过。');
  console.log('\n断言：1/1');
  process.exit(0);
}

/* 【2026-11-08 加】全量回归里有脚本会临时把文件改坏再还原（check-gates-self），
 * 那一小段时间正好被这里读到，就会假红。不一致时等 300ms 重读一次，
 * 仍不一致才判真不一致 —— 别把别人的中间态当成自己的错。 */
function same(a, b) {
  if (!fs.existsSync(a) || !fs.existsSync(b)) return null;
  const eq = () => {
    try {
      const x = fs.readFileSync(a);
      const y = fs.readFileSync(b);
      return x.length === y.length && x.equals(y);
    } catch {
      return null;
    }
  };
  if (eq()) return true;
  /* 真睡 300ms：Atomics.wait 不烧 CPU（while 空转会顶满一个核） */
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  } catch {}
  return eq();
}

console.log('\n=== 1. 前端页面 ===');
{
  const a = path.join(REPO, 'public/index.html');
  const b = path.join(DATA, 'public/index.html');
  const r = same(a, b);
  if (r === null) {
    console.log('  · 只有一边有 index.html，跳过');
  } else {
    ok(r, r ? 'public/index.html 两边一致' : 'public/index.html 两边不一致 —— 改了仓库那份，程序读的是数据目录那份，改了等于没改');
    if (!r) {
      console.log('     仓库 ' + fs.statSync(a).size + ' 字节 / 生效 ' + fs.statSync(b).size + ' 字节');
      console.log('     同步：Copy-Item "' + a + '" "' + b + '" -Force');
    }
  }
}

console.log('\n=== 2. 后端源码 ===');
{
  const dirA = path.join(REPO, 'src');
  const dirB = path.join(DATA, 'code/src');
  if (!fs.existsSync(dirB)) {
    console.log('  · 数据目录下没有 code/src，后端跑的就是仓库这份，跳过。');
  } else {
    const files = fs.readdirSync(dirA).filter((f) => f.endsWith('.mjs'));
    const diff = [];
    for (const f of files) {
      if (same(path.join(dirA, f), path.join(dirB, f)) === false) diff.push(f);
    }
    ok(diff.length === 0, diff.length === 0
      ? files.length + ' 个 .mjs 两边一致'
      : '这些文件两边不一致（改了不生效）：' + diff.join(', '));
  }
}

console.log('\n=== 3. 生效那份不能是坏的 ===');
{
  const live = path.join(DATA, 'public/index.html');
  if (fs.existsSync(live)) {
    const s = fs.readFileSync(live, 'utf8');
    const bad = [];
    if (!/function\s+sentTailRow\s*\(/.test(s) && /sentTailRow\s*\(/.test(s)) bad.push('sentTailRow 只调不声明');
    if (!/(?:let|const|var)\s+sentThisTurn/.test(s) && /sentThisTurn\s*\.push/.test(s)) bad.push('sentThisTurn 没声明就 push');
    ok(bad.length === 0, bad.length === 0 ? '生效那份没有已知的致命写法' : '生效那份有致命写法：' + bad.join('、'));
  } else {
    console.log('  · 生效那份不存在，跳过');
  }
}

console.log('\n断言：' + pass + '/' + (pass + fail));
console.log(fail ? 'FAIL 仓库改了但没同步到生效那一份' : 'PASS 改的和跑的是同一份');
process.exit(fail ? 1 : 0);
