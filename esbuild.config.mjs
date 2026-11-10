/**
 * 对话区（#log）React 版的预构建脚本。
 *
 * 为什么要预构建而不是运行时打包：
 *   发布物（electron-builder 的 files 白名单）**不带 node_modules**，
 *   所以浏览器里拿不到 react/react-dom —— 必须在这里把 React 一起打进
 *   一个自包含的 IIFE 文件 `public/ui/log.bundle.js`，并**提交进仓库**。
 *
 * 用法：npm run build:ui
 * 约定：minify: false（出问题时要能在 DevTools 里直接读到源码级堆栈）
 */
import { build } from 'esbuild';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [join(root, 'src-ui', 'main.jsx')],
  outfile: join(root, 'public', 'ui', 'log.bundle.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  jsx: 'automatic',
  jsxDev: false,
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  // React 的 dev 分支（警告、检查）在发布物里没有意义，还会让包大一倍
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
});
