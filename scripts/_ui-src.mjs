/**
 * _ui-src.mjs —— 把「界面真源码」拼成一段字符串给断言用。
 *
 * 【为什么又建了这个文件（2026-11-15）】
 * 主人这边跑冒烟时，check-think-display / check-hidden-messages / check-screen-exit-keys
 * 一起红，报错都是同一句：Cannot find module .../scripts/_ui-src.mjs。
 * 这个帮助文件从没进过 git（untracked），某次清理临时文件时被一起删了 ——
 * 于是八个依赖它的检查全都在 import 那一行就崩，看上去像"界面坏了"，其实是缺工具。
 *
 * 语义（跟原来一致，别改）：
 *   readUISource() 返回**实际部署的界面**（public/index.html + public/ui/*.js）拼起来的文本，
 *   断言里直接 ui.includes('...') / ui.match(...) 用。
 *
 * 刻意**不**把 src-ui/*.jsx 拼进来：那是编译前的源码，同一段逻辑会出现两次，
 * 会让「这个函数只该定义一次」这类计数断言直接假红。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export function readUISource() {
  const parts = [];
  const add = (p) => {
    try {
      parts.push('/* ==== ' + p + ' ==== */\n' + fs.readFileSync(p, 'utf8'));
    } catch { /* 缺哪个文件就跳过，别让断言脚本整体崩掉 */ }
  };
  add(path.join(ROOT, 'public', 'index.html'));
  const uiDir = path.join(ROOT, 'public', 'ui');
  try {
    for (const f of fs.readdirSync(uiDir)) {
      if (f.endsWith('.js')) add(path.join(uiDir, f));
    }
  } catch { /* 目录不在就算了 */ }
  return parts.join('\n\n');
}

export default { readUISource };
