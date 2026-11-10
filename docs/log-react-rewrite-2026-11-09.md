# 对话区换框架重写规格（2026-11-09 终版）

> 主人的原话：「我现在已经彻底对前端没有信任了，我不怕工作量大，我要的是一劳永逸的根治。」
> 主理人决定：**换框架，重写对话区（#log）**。不再打补丁。

## 一、为什么必须换（不是修）

`D:\小鱼Agent` 的前端**没有框架**：`public/index.html` 20388 行 + `public/ui/chat.js` 2894 行，
全部手写 `document.createElement` / `appendChild` / `remove`。

对照证据（本机实测）：

| 应用 | 前端实现 | 证据 |
|---|---|---|
| WorkBuddy | React | `resources/app.asar` → `renderer/assets/react-dom-*.js`、`react-markdown-*.js` |
| DeepSeek Harness | React + 虚拟滚动 | `dsh-web-frontend/dist/assets/index-CN7WNw.js`（940KB）：`createRoot`×3、`useSyncExternalStore`×10、`vita`/`virtua`×1、`memo(`×3 |
| 小鱼Agent | 手写 DOM | 全仓 `node_modules` 无 react/vue，`public/ui/*.js` 是模块化手写 |

手写 DOM 必须自己维护：节点身份、复用池、指纹判重、滚动锚点、展开态、清理时机。
「先删后建」这个动作**必然产生中间态**，这就是下面所有症状的共同根：

- 多段消息堆一块（同一段被两套账各画一份）
- F5 / 切会话后重复
- 展开柜子后滚动回弹
- 鼠标移到灰字上抖动（文本每次重写 → ellipsis 位置变 → 重排）
- 未操作也自发堆叠（两条路径同时写）

**根治 = 让「屏幕 = f(数据)」成立，节点身份由 key 决定，不存在删除重建。**

## 二、范围（只换对话区，别扩大）

**重写**：`#log` 里的全部内容（消息、思考块、工具卡、子任务卡、系统提示、附件卡）。

**不动**：侧栏、会话列表、设置面板、各种 dialog、顶栏、视频背景、TTS、QQ 面板。

理由：缩小风险面，且这些区域不是 bug 来源。

## 三、技术选型（主理人定，不再讨论）

- **React 18 + ReactDOM**（`react@18`、`react-dom@18`），用 `createRoot`。
  不用 19（18 更稳，且 `useSyncExternalStore` 已够）。
- **打包**：`esbuild`（已有 node_modules 里没有，需 `npm i -D esbuild`，registry 已是 npmmirror）。
  产物：`public/ui/log.bundle.js`（IIFE 或 ESM 单文件），**提交进仓库** —— 发布物不带 node_modules，
  所以必须预构建，运行时不依赖构建工具。
- **不引入** antd/MUI 等 UI 库（体积大、样式冲突）。样式沿用现有 CSS 类名，React 只负责节点结构。
- **不引入**状态库。数据来自两个源：`turns`（历史）+ `liveItems`（当前轮），用
  `useSyncExternalStore` 桥接现有的 `LOG_STATE`。

## 四、架构（必须严格照这个）

### 4.1 单一数据源

```
LOG_STATE = { sid, turns, liveItems }
```

- `turns`：服务端 `/api/sessions/:id` 给的落盘历史（已有 `publicSession()` 的 turn 形状）
- `liveItems`：服务端 `/api/chat/live` 给的 items（当前轮）
- **屏幕 = f(turns, liveItems)**，没有任何其他写入 DOM 的路径

### 4.2 分段规则只算一次

历史边界：跑着的时候 `turns` 只取到「最后一条 user turn」（已有 `trimTurnsForLive`，逻辑搬进 React 层）。
`liveItems` 直接用服务端的，**前端不再自己合并事件**（`liveItemsFeed` 删除）。

> 这一步是关键：现在前端有一份 `liveItemsFeed`、服务端有 `appendLiveItem`，
> 两边都对一遍是「两套账」。**改为：前端不合成，只渲染服务端给的 items。**
> 服务端 items 缺的兜底由服务端修（已在做），前端不做二次加工。

### 4.3 组件结构

```jsx
<LogView turns liveItems running busy>
  {merged.map(item => <ItemRow key={item.key} it={item} />)}
</LogView>
```

`merged` 由 `useMemo` 算：`turns` 的每条 → key `t-<i>`；`liveItems` 的每条 → key `l-<i>`。
**key 一旦生成就不变**（同一段文字 key 不变 = 节点复用 = 不闪不跳不重复）。

`ItemRow` 按 `it.kind` 分派：
- `user` → `<UserBubble>`（含附件、改名、回退）
- `assistant` → `<AssistantBubble>`（markdown 渲染沿用现有 `renderMd`）
- `think` → `<ThinkBlock>`（`<details>`，展开态存 React state，**按 key 记**）
- `tool` → `<ToolCard>`
- `worker` → `<WorkerCard>`
- `note` → `<SysNote>`
- `say` → `<MateBubble>`

### 4.4 滚动（这是回弹的根治点）

- **删掉**所有 `stickBottom` / `hardScrollBottom` / 滚动锚定补偿的代码。
- 用标准做法：
  ```js
  const atBottomRef = useRef(true);
  useLayoutEffect(() => {
    if (atBottomRef.current) listEl.scrollTop = listEl.scrollHeight;
  }, [merged.length, lastItemTextLength]);
  ```
  - `atBottomRef` 只在用户**真的往上滚**（`scrollTop` 变小且不是程序造成的）时置 false
  - 到底部时置 true
- `overflow-anchor: none` 保留（避免浏览器自己插一脚），改为由上面的 effect 统一管。

### 4.5 思考灰字抖动（根治）

- 灰字**不做 CSS ellipsis**，改为：`white-space: nowrap; overflow: hidden;`
  这样文字变长不会改变已渲染字形的宽度（ellipsis 会重新计算截断点 → 重排 → 抖动）。
- 灰字内容用 `React.memo` 包，只有文本变化才重渲染。
- 柜门标题同理。

### 4.6 展开态与「主人正看着的地方」

- `details` 的 `open` 由 React state 控（`openSet`，按 item key 记），**不由 DOM 事件反推**。
- 重渲染时 React 只更新文本节点，`<details>` 的 `open` 属性不变 → **不会收起、不会回弹**。

## 五、实施步骤（工程师按顺序）

### 步骤 0：准备
- `npm i -D esbuild`（只加 devDependency）
- 建 `src-ui/` 目录 + `esbuild.config.mjs`（entry `src-ui/main.jsx` → `public/ui/log.bundle.js`，`minify: false` 便于排查，`format: 'iife'`，`jsx: 'automatic'`）
- `package.json` 加脚本 `"build:ui": "node esbuild.config.mjs"`

### 步骤 1：数据桥
- 新 `src-ui/store.js`：用 `useSyncExternalStore` 桥接现有 `LOG_STATE`
- **不删** `LOG_STATE` 的定义与已有调用（`logSetHistory` / `logSetLive` 照旧被外部调用），
  只在 `logSetHistory` / `logSetLive` 里加一句「通知订阅者」

### 步骤 2：组件
- `src-ui/LogView.jsx`、`ItemRow.jsx`、`ThinkBlock.jsx`、`ToolCard.jsx`、`WorkerCard.jsx`、`UserBubble.jsx`、`AssistantBubble.jsx`
- markdown / 颜文字清理 / 工具名美化这些**复用现有的 `window.*` 函数**（`renderMd`、`niceTool`、`tidyToolText`），不要重写

### 步骤 3：切换
- `public/index.html`：`<div id="log"></div>` 保持不变，由 `log.bundle.js` 里 `createRoot` 接管
- **删除**这些函数（整段删，不留双路）：
  - `public/ui/chat.js` 的：`paintSnapshot`、`paintSnapshotInner`、`paintSnapshot0`、`followLive`、`replayInFlight`、`tryLiveAppendFast`、`adoptThink`、`adoptTool`、`renderTurns`（替代品：React 渲染）
  - `public/index.html` 的：`addAssistant`、`addAssistantAuto`、`openThink`、`addTool`、`addWhaleBubble`、`addSysNote`、`pushStreamText`、`paintHistWorkerCard`、`_paintWorkerCardCore`、`stampSpeechNode`、`flushSpeech`、`hubRefreshTitle` 里所有「找 DOM」的分支
  - `public/ui/hub.js`：如果柜子（toolhub）也在 #log 里，一并迁进 React；若判定太重，**先保留 hub 但改成「不参与渲染，只算数据」**
- 所有 `window.addXxx` 的调用点改成「往 store 里塞数据」

### 步骤 4：清理手写 DOM 残留
- 全仓搜 `document.createElement`、`.appendChild(`、`.innerHTML =`，凡是**作用于 #log 内部**的，一律改掉
- 加一条检查 `scripts/check-log-no-manual-dom.mjs`：断言上述写法的目标不是 `#log`

## 六、验收（缺一不可）

1. `node scripts/preflight.mjs`、`node scripts/sync-live.mjs`、`node scripts/check-live-sync.mjs` 全过
2. `node scripts/run-all-checks.mjs` 全过（**注意：会有一批旧检查断言手写 DOM 的结构，需要按 4.2/4.6 的口径改判据 —— 改检查，不改实现来迁就**）
3. 新增 `scripts/check-log-react.mjs`：
   - 源码层：`#log` 内不许有手写 DOM 创建
   - 行为层（真浏览器 + CDP）：同一段文字在 `#log` 里**只出现一次**；节点数 == items 条数
4. 真机四场景（隔离实例 + 独立 Edge）：
   - a 正常一轮（说→工具→说）：段数对、每段一份
   - b 流式中 F5：刷新后不重复、不堆叠、**滚动位置不在顶部**
   - c 展开柜子后她发新消息：**柜子保持展开、滚动不往旧位置弹**
   - d 鼠标移到思考灰字上：**位置不抖**（取两次 `getBoundingClientRect()` 比较，位移 < 1px）
5. 性能：300 turn 的会话切换，首屏渲染 < 500ms

## 七、禁区

- 不许保留「双路」：新框架上线后，旧的 `paintSnapshot*` 一个都不许留。
- 不许为了省事把 React 只包一层壳、里面继续手写 DOM —— 那就白换了。
- 不许改服务端 items 的合成规则（除非发现新缺陷，另开任务）。
- 不碰 8788；所有真机验证走隔离实例。