// @ts-check
/* 【2026-11-09 · 换框架】
 *
 * 这个文件原来是「柜子（toolhub）」的实现：一群 DOM 操作（syncHubHead /
 * hubRefreshTitle / groupLooseTools / adoptThink / adoptTool / addTool / foldLiveTools），
 * 目的是把散落的工具卡**就地搬进** <details class="toolhub"> 里，且不闪。
 *
 * 换 React 之后，这件事由渲染层直接做掉：
 *   · 哪些工具在一段话之后 → `src-ui/items.js` 按 item 顺序算
 *   · 柜门那一行（调了 N 次工具 / 运行中 / 灰字摘要）→ `src-ui/ToolCard.jsx` 算
 *   · 不闪 → key，不需要「只登记不摘」那套手法
 *
 * 所以这里**只留纯函数**（不算 DOM、不动 DOM），其余全变成空实现：
 * 外面（index.html / chat.js）还有几十处在按名字调它们，删了会 ReferenceError，
 * 留着空壳既能编译，也能让「谁还在指望这些函数」一眼可见。
 *
 * 规格 5.3 的原话：「若判定太重，先保留 hub 但改成不参与渲染，只算数据」。
 */

/** 灰字那一截：取最后一小段（才会「不断变化」），太长前面加省略号 */
export function thinkPeekTail(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > 160 ? '…' + flat.slice(-160) : flat;
}

/** 思考标题：取第一句，上限 400 字（真正的截断交给 CSS） */
export function thinkTitleOf(flat) {
  const s = String(flat || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  const m = /^[^。！？!?；;]{1,400}/.exec(s);
  return String((m && m[0]) || s).trim();
}

/**
 * 【已废】柜门灰字摘要原来靠扫柜子里的 DOM 算。
 * 现在柜门由 React 从数据算（`ToolCard.jsx`），这个函数没有调用者了；
 * 保留空实现只是为了别让老调用点抛错。
 */
export function hubPeekOf() {
  return '';
}

/** 【已废】柜门标题原来是「扫 DOM 再写进去」。React 直接从 items 算。 */
export function hubRefreshTitle() {
  return false;
}

/** 【已废】把散卡收进柜子 —— 现在是渲染期分组，屏幕上的中间态不存在。 */
export function groupLooseTools() {
  return 0;
}

/** 【已废】复用旧节点改字 —— React 按 key 复用，不需要这层。 */
export function adoptThink() {
  return null;
}

/** 【已废】同上 */
export function adoptTool() {
  return null;
}

/** 【已废】建工具卡 —— 由 `ToolCard.jsx` 建 */
export function addTool() {
  return null;
}

/** 【已废】「她说话了就把工具收起来」—— 收不收是数据的事，不是 DOM 的事 */
export function foldLiveTools() {
  return 0;
}

/** 【已废】柜门标题同步（被 syncHubHead 用） */
export function syncHubHead() {
  return false;
}

/* 经典脚本（index.html 里那段）还要按名字直接调这些函数。 */
Object.assign(window, {
  thinkPeekTail,
  hubPeekOf,
  syncHubHead,
  hubRefreshTitle,
  groupLooseTools,
  thinkTitleOf,
  adoptThink,
  adoptTool,
  addTool,
  foldLiveTools,
});
