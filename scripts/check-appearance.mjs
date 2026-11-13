/**
 * 【2026-11-13 合并 mac 侧·外观中心】钉死接线三件：
 *   服务端 plugins.mjs 路由、前端 appearance.js 模块与入口按钮、
 *   主题变量骨架（8 个分层变量）与壁纸层共存规则。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0, fail = 0;
const ok = (name, cond) => {
  if (cond) { pass++; console.log('  ✔', name); }
  else { fail++; console.log('  ✘', name); }
};

const server = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
let plugins = '', appearance = '';
try { plugins = readFileSync(join(ROOT, 'src', 'plugins.mjs'), 'utf8'); } catch {}
try { appearance = readFileSync(join(ROOT, 'public', 'ui', 'appearance.js'), 'utf8'); } catch {}

/* ── 服务端 ── */
ok('plugins.mjs 存在且导出八件', /export function pluginsView/.test(plugins)
  && /export function togglePlugin/.test(plugins)
  && /export function getAppearance/.test(plugins)
  && /export function setAppearance/.test(plugins)
  && /export async function importPlugins/.test(plugins)
  && /export function createPluginFromCode/.test(plugins));
ok('server.mjs import plugins.mjs 八件', /pluginsView,\s*\n\s*togglePlugin/.test(server) && /getAppearance,\s*\n\s*setAppearance,?\s*\n?\} from '\.\/plugins\.mjs'/.test(server));
ok('插件固定路径排在 <id> 之前（import/open-dir 先认）',
  server.indexOf('/api/plugins/import') < server.indexOf('([^/]+)'));
ok('plugin-assets 静态路由在（js 给 text/javascript）',
  server.includes('plugin-assets') && /text\/javascript; charset=utf-8/.test(server));
ok('POST /api/appearance 在', /POST' && url\.pathname === '\/api\/appearance'/.test(server));

/* ── 前端 ── */
ok('顶栏有「外观」入口按钮', /<button id="openAppearance" title="外观：主题、壁纸、插件">外观<\/button>/.test(html));
ok('引入 /ui/appearance.js 模块', /<script type="module" src="\/ui\/appearance\.js"><\/script>/.test(html));
ok('appearance.js 在（自建面板，含 THEMES/WALLPAPERS）', appearance.length > 30000 && /export const THEMES/.test(appearance) && /WALLPAPERS/.test(appearance));

/* ── 主题变量骨架 + 壁纸共存 ── */
for (const v of ['--panel-2', '--raise', '--hover:', '--scroll:', '--scroll-hover', '--bg-rgb', '--panel-rgb', '--hover-rgb']) {
  ok(`:root 有主题骨架变量 ${v.replace(':', '')}`, new RegExp(v.replace(':', '') + ':').test(html));
}
ok('壁纸层 #xyWall 在 DOM + CSS', /<div id="xyWall"><\/div>/.test(html) && /#xyWall \{/.test(html));
ok('选壁纸藏视频（body.wall #bgVideo）', /body\.wall #bgVideo \{ display: none !important; \}/.test(html));
ok('wall 透底走 rgb 分量（换主题不分裂）', /--panel: rgba\(var\(--panel-rgb\)/.test(html));

console.log(`\n外观中心接线：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
