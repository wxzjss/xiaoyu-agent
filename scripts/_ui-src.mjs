/**
 * 【2026-11-08 加·拆分配套】
 *
 * 页面脚本现在分散在 public/index.html 和 public/ui/*.js 里。
 * 检查脚本原来一律 `readFileSync('public/index.html')` —— 函数一搬走，
 * 它们就报「找不到 run live / 找不到某个函数」，全是假红。
 *
 * 统一从这里读：HTML 在前，ui/*.js 按文件名顺序接在后面。
 * 语义上就是「这个页面最终交给浏览器的那份脚本」。
 *
 * 顺序很重要：ui/ 里的文件是普通 <script>，在主脚本之前加载，
 * 所以超集按「HTML + ui」拼，对正则断言没有影响（它们不是按位置匹配的）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function readUISource(root = process.cwd()) {
  const html = join(root, 'public', 'index.html');
  let s = existsSync(html) ? readFileSync(html, 'utf8') : '';
  const dir = join(root, 'public', 'ui');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir).sort()) {
      if (f.endsWith('.js')) s += '\n' + readFileSync(join(dir, f), 'utf8');
    }
  }
  return s;
}
