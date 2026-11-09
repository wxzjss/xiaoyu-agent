# 消息显示 bug 根治规格（2026-11-09）

> 目标：不是再修一条路径，而是让「屏幕该长什么样」只剩一个来源、一个出口。
> 仓库：`D:\小鱼Agent`（前端主文件 `public/index.html` 约 2 万行 + `public/ui/chat.js`、`public/ui/hub.js`）

## 一、症状清单（主人报的，全部已复现或已定位）

| # | 症状 | 触发场景 |
|---|---|---|
| 1 | 好几段话堆进一个气泡 | 长任务里排队轮续跑 |
| 2 | F5 之后又堆一块 | 调用工具 / 思考 / 发消息过程中刷新 |
| 3 | 「正在发送消息」自己消失且不再回来 | 流结束 + 服务端接着跑下一轮 |
| 4 | 思考结束后柜门那行灰字缩回一小截 | 思考刚结束 |

1 和 3 已在 0.9.43 修（`done` 分段线 / 延迟复核），4 已在 0.9.44 修（`hubPeekOf` 去掉 30 字截断）。
2 目前只做了「边界修正」（`trimTurnsForLive`），**结构性病根还在**，本条要求根治。

## 二、根因（结构性）

屏幕上的「当前这一轮」有两套画法，各记各的账：

1. **老路：SSE 直写 DOM**
   `public/index.html` 的 `chat()` 里，`onEvent` 收到 `text/reasoning/tool_start/...`
   就 `addAssistantAuto()` / `pushStreamText()` / `openThink()` / `addTool()` **直接建节点**。
2. **新路：快照重画**
   `public/ui/chat.js` 的 `renderLog()` → `paintSnapshot()`，照服务端 `live.items`
   **先删后画**（keyed diff 复用节点）。

两条路对「一段话算一段」的判据不同（一个看事件类型切换，一个看 items 合并），
任何一处判据不一致，屏幕上就出现「两份」或「多段挤一块」。
F5 / 切会话 / 补拉 只是把两条路撞在一起的时机变得更容易命中。

> 关键观察：`turnRec.parts` 其实**已经**是一份「这一轮该显示什么」的模型
> （见 `public/index.html` 约 10480–10515：reasoning / text / tool / whale 都在往里记）。
> 但它只用来「切走再回来重放」，没被拿来当渲染输入 —— 这才是重复记账的来源。

## 三、改造口径（不变式，必须写进代码注释）

1. **唯一权威**：服务端 `live.items` 是「当前这一轮屏幕上该有什么」的唯一权威。
   前端自己也维护同形状的一份（SSE 增量写进去），形状必须与 `itemsFromEvents` 完全一致。
2. **唯一出口**：只有 `renderLog()`（`public/ui/chat.js`）能建/删 `#log` 里的对话节点。
   SSE 路径**不再直接建节点**。
3. **历史边界**：跑着的时候，历史只画到「最后一条 `role:'user'` 的 turn」为止
   （已实现：`trimTurnsForLive`）。没在跑 → 历史全画，直播清空。
4. **幂等**：同一份输入画一百次结果一样；重复内容绝不出现两次。

## 四、实施步骤（工程师执行）

### 步骤 1：SSE 改成「只更新模型」
在 `public/index.html` 的 `chat()` 事件循环里（约 10515–10760）：

- 保留 `turnRec.parts` 的累积逻辑（它是切走再回来的兜底）。
- **删除**这些直接建 DOM 的调用：`addAssistantAuto()`、`pushStreamText()`、
  `openThink()`、`addTool()`、`whaleStream*`、`addWhaleBubble()`、`whaleStreamFinish()`，
  以及 `bubble` / `think` 局部变量相关的分支（`bubble = null`、`bubble.classList.remove('streaming')` 等）。
- 改为：把事件按 `itemsFromEvents` 的合并规则写进 `clientItems`（新数组，初值 = 空或服务端 items），
  然后节流（16ms 或每 8 个事件）调用一次：
  ```js
  logSetLive(turnSession, { running: true, items: clientItems, startedAt });
  ```
  `logSetLive` 内部会调 `renderLog()`，由 `paintSnapshot` 做 keyed diff（不闪、不重建）。
- `done / error / aborted`：flush 一次（`logSetLive(sid, { running: true, items })`），
  再走现有 `scheduleSendingRecheck(sessionId)`；**不要**在这里把 items 清空。

⚠️ 注意：`renderLog` 需要 `LOG_STATE.turns` 有值（历史）。SSE 开始时若 `LOG_STATE.turns`
为空，先调 `logSetHistory(turnSession, currentTurns)`（`currentTurns` 是页面已有变量）。

### 步骤 2：把「直接画」的残留路径交回同一出口
- `paintLiveEvents` / `replayInFlight` / `tryLiveAppendFast`：只更新 `LOG_STATE`，不碰 DOM。
- `whale`（别的卡说话）：也走 items（`k:'say'`），不要单独 `addWhaleBubble`。
- 若某条路径确实需要「立刻画」，唯一允许的做法是更新 items + `renderLog({forceLive:true})`。

### 步骤 3：守住历史边界
确认 `renderLog` 里 `running` 的判据是：
```js
const running = !!(live && live.running !== false && Array.isArray(live.items) && live.items.length);
```
`live` 为空但 `turnRec` 还在跑的情况（刚发出去、items 还没长出来）→ 仍然 `running: true`
但 `items: []`，历史全画。**不要**因为 items 为空就把整轮历史砍掉。

### 步骤 4：注释与防回归
- 在 `chat.js` 顶部把上面「三条不变式」写成注释块（已有类似段落，补充「只有 renderLog 能建节点」）。
- 在 `public/index.html` 的 SSE 段开头写明：**这里只更新模型，不许建节点**。

## 五、验收标准（QA 执行）

必须全绿，缺一不可：

1. `node scripts/check-core.mjs` — 全过。
2. `node scripts/run-all-checks.mjs` — 全过（隔离实例，会自动跑真机/接口类检查）。
3. 新增场景检查 `scripts/check-no-dup-render.mjs`（工程师写）：
   - 造一轮 items（text → tool → text → done → text），断言：
     - `itemsFromEvents` 与前端累积的 `clientItems` 逐条相等；
     - 屏幕节点数与 items 的 `text` 条数一致（用 `paintSnapshot` 的纯逻辑或 DOM 断言）；
     - 同一段文字在 `#log` 里只出现一次（`innerText` 里该片段计数 === 1）。
4. 四个场景真机验证（隔离实例 + 真实一轮，允许用现有 `check-chat-e2e` 的方式）：
   - a 正常一轮（说→工具→说）：段数与服务端 items 一致
   - b 流式中 F5：刷新后不重复、不堆叠
   - c 流式中插话（steer）：已说出的字不被截断，插话出现在正确位置
   - d 排队轮续跑：下一轮另起气泡
5. `node scripts/check-live-sync.mjs` 通过（改完必须 `node scripts/sync-live.mjs`）。

## 六、禁区（别碰）

- 不要改服务端 `appendLiveItem` / `buildLiveItems` 的合并规则（0.9.43 已定：`done/aborted/error` 是分段线）。
- 不要动 `check-*` 里已有的断言去「迁就」实现；实现错就改实现。
- 不要为了省事把 `renderLog` 的指纹缓存关掉（会每秒重排，滚动位置会跳）。
- 提交前必须 `node scripts/preflight.mjs` + `node scripts/sync-live.mjs`。
