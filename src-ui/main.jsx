import React from 'react';
import { createRoot } from 'react-dom/client';
/* 【注意】flushSync 在 react-dom 主入口里，不在 react-dom/client ——
 * 从 client 里 import 会拿到 undefined，然后开机第一句就 TypeError。 */
import { flushSync } from 'react-dom';
import LogView from './LogView.jsx';
import * as storeApi from './store.js';
import { primeMateColors, applyMateColor } from './bridge.js';

/**
 * 接管 #log。
 *
 * 页面里 `<div id="log"></div>` 保持不变（规格步骤 3）——
 * 变的是：**里面的每一个节点从此由 React 按 key 管**。
 *
 * 挂载前把容器清空一次：静态 HTML 里的那点东西（以及上一次生命留下的残骸）
 * 一条都不留，否则「两套账」就还在。
 */
function mount() {
  const el = document.getElementById('log');
  if (!el) return false;
  if (window.__logRoot) return true;
  try { el.replaceChildren(); } catch (e) { el.textContent = ''; }
  const root = createRoot(el);
  window.__logRoot = root;
  /**
   * 【为什么首帧必须同步提交（flushSync）】
   *
   * 这个包在 index.html 的经典脚本**之前**执行，所以「React 挂上去」和
   * 「boot 把历史塞进 store」之间只隔几毫秒。而 React 18 的 createRoot 是并发根：
   * `root.render()` 只是排队，真正的首帧提交在下一个微任务里。
   *
   * 于是有这么个窗口：数据先到了，React 还没提交过第一棵树 ——
   * 提交时它按「上一棵树」去删节点，可那棵树从没进过 DOM，于是
   * `removeChild` 抛 NotFoundError。那个异常发生在提交阶段，没有边界接得住，
   * **整棵树被卸载，屏幕一片空白**。
   *
   * 实测（隔离实例上直连 CDP）：页面刚起来那一刻往 store 写一次历史，
   * 屏幕上一条都不剩，控制台只有一句 removeChild NotFoundError。
   *
   * flushSync 把首帧当场提交掉，这个窗口就不存在了；之后每次 bump 都是
   * 「已有树 → 新树」的正常更新。（顺带一句：首帧本来就只有几十个节点，
   * 同步提交的代价可以忽略。）
   */
  flushSync(() => root.render(<LogView />));
  try { console.info('[log] React 已接管 #log'); } catch (e) {}
  return true;
}

if (!mount()) {
  document.addEventListener('DOMContentLoaded', mount, { once: true });
}

/* 【2026-11-11 加·颜色预热】署名配色的拉取从「第一次问颜色」提前到开机。
 * 内置卡的颜色已经在 bridge.js 里写死了（第一帧就对），这里只是把自定义卡的颜色
 * 早点拿回来；拿回来如果跟屏幕上的不一样，bridge 会 bump 一次让 React 重画。 */
try { primeMateColors(); } catch (e) {}

/* 面板改完色要立刻同步进缓存，否则下一次刷新会先画旧色再跳新色（闪一帧）。 */
window.__mateColorsApply = applyMateColor;

/* 【自检用】把 React 和组件挂出来，真机探针可以拿它做「换一个容器重挂一次」这类验证。
 * 只挂引用，不改任何行为。 */
window.__logDebug = { React, createRoot, LogView, store: storeApi };
