#!/usr/bin/env node
/**
 * 【2026-11-13 修·重启慢】开屏快车道站岗。
 *
 * 根因（boot.log + 外部探针实测）：
 *   皮肤视频 10.6MB + 背景音乐，前端用 `?t=Date.now()` 防缓存 + 服务端 no-store，
 *   每次开屏全量重下；带 src 的媒体元素又拖住 did-finish-load ——
 *   窗口要等它才露面，实测「页面加载完 +19.7s / +20.1s」。
 *   服务端本身 11ms 就把页面喂完了（外部探针实锤），隔离实例没开皮肤 0.6s——全链路闭环。
 *
 * 修法：①媒体 URL 版本号 = 文件 mtime（不变就吃缓存）②服务端 immutable ③媒体 src 延到页面 load 事件后。
 * 这三条谁回退一条，这里就红。
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'public', 'index.html'), 'utf8');
const server = readFileSync(join(ROOT, 'src', 'server.mjs'), 'utf8');
const skin = readFileSync(join(ROOT, 'src', 'skin.mjs'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' —— ' + detail : '')); }
}

/* ── ① 防缓存时间戳禁入（媒体 URL 一律用版本号） ── */
ok('媒体 URL 不再用 Date.now() 防缓存戳（改 ?v=文件mtime）',
  !/"\?t=' \+ Date\.now\(\)/.test(html) && !/'\?t=' \+ Date\.now\(\)/.test(html));
ok('视频 URL 带 videoVer 版本号',
  /vurl = want \+ '\?v=' \+ \(Number\(skinState\.videoVer\) \|\| 0\)/.test(html));
ok('音乐 URL 带 musicVer 版本号',
  /murl = want \+ '\?v=' \+ \(Number\(skinState\.musicVer\) \|\| 0\)/.test(html));
ok('/api/skin 返回 videoVer/musicVer（skin.mjs 用 statSync mtime）',
  /videoVer,/.test(skin) && /musicVer,/.test(skin) && /statSync\(videoPath\)\.mtimeMs/.test(skin));

/* ── ② 服务端缓存策略：immutable，不再 no-store ── */
{
  const vSeg = server.slice(server.indexOf('function serveSkinVideo'), server.indexOf('function serveSkinMusic'));
  const mSeg = server.slice(server.indexOf('function serveSkinMusic'), server.indexOf('function serveSkinMusic') + 3000);
  const noStoreHead = (seg) => /'Cache-Control':\s*'no-store'/.test(seg);
  ok('视频端点 Cache-Control=immutable（不再 no-store）',
    /'Cache-Control': 'public, max-age=31536000, immutable'/.test(vSeg) && !noStoreHead(vSeg));
  ok('音乐端点 Cache-Control=immutable（不再 no-store）',
    /'Cache-Control': 'public, max-age=31536000, immutable'/.test(mSeg) && !noStoreHead(mSeg.slice(0, 800)));
}

/* ── ③ 媒体加载延到页面 load 事件之后（不许拖 did-finish-load） ── */
ok('视频 src 延到 load 事件后（document.readyState 分派）',
  /if \(document\.readyState === 'complete'\) startVideo\(\);/.test(html)
  && /window\.addEventListener\('load', startVideo, \{ once: true \}\)/.test(html));
ok('音乐 src 同样延后',
  /if \(document\.readyState === 'complete'\) setMusic\(\);/.test(html));
ok('版本号没变就不重设 src（缓存复用的前提）',
  /if \(now !== vurl\) \{/.test(html) && /if \(musicEl\.getAttribute\('src'\) !== murl\) \{/.test(html));

/* ── ④ 启动仪表还在（下次慢了数据自己说话） ── */
ok('事件循环卡顿探测器（boot-lag）在岗',
  /boot-lag', `启动第/.test(server));
ok('boot-resume 注册时刻仪表（boot-resume-sched）在岗',
  /boot-resume-sched/.test(server));

console.log('\n开屏快车道：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
