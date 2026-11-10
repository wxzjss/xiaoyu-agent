import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2];
/* 【2026-11-10 修】默认输出目录原来写死 'D:\\小鱼Agent\\dump\\txt'（作者本机）。
 * 现在默认落在仓库自己的 dump/txt（脚本位置向上推一层），谁放哪都对。 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[3] || join(REPO_ROOT, 'dump', 'txt');
if (!url) { console.error('用法: node fetch-txt.mjs <url> [输出目录]'); process.exit(1); }
mkdirSync(outDir, { recursive: true });

const res = await fetch(url, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
  }
});
if (!res.ok) { console.error('HTTP', res.status); process.exit(1); }
let html = await res.text();

// 粗提正文：去掉脚本样式标签，把段落换行保留下来
html = html.replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<\/(p|div|h[1-6]|li|br)>/gi, '\n')
          .replace(/<[^>]+>/g, '')
          .replace(/&nbsp;/g, ' ')
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/\n{3,}/g, '\n\n')
          .trim();

const name = 'txt_' + Date.now() + '.txt';
const fp = join(outDir, name);
writeFileSync(fp, html, 'utf8');
console.log('已保存:', fp, '长度', html.length);
