# deep-fixer · 2026-11-11 · 断网人话提示 + 工具卡动态耗时

## 任务一：断网假气泡 + 英文报错

### 改前真实表现（HEAD worktree + 隔离实例 + CDP offline，不许猜的铁规矩照办了）
- CDP `Network.emulateNetworkConditions offline:true`，页面真发一条消息：
  - **6.2s** 后屏幕冒英文「⚠ Failed to fetch↻ 把这句放回输入框」——旧正则
    `/fetch failed|network|…/` 认不出 `Failed to fetch`（词序反了），英文直接上屏
  - 转圈灯 7.2s 熄灭（offline 会立刻抛错，不是无限转；无限转的是半开连接场景）

### 改动（public/index.html）
1. 新增 `isNetErr / netDownText / humanizeErr`（tryHealAfterDisconnect 前）：
   网络错 → 「网络断了，联系不上她。恢复后她说的话会接着来。」；
   非网络错 → 「出了个内部问题：」+ 详情
2. runTurn 发 /api/chat 挂 **30 秒看门狗**（AbortController）：第一个回包
   没到就掐，掐出来的错带 `__netStall` 标记走断网人话——防半开连接无限干等
3. runTurn catch：网络错说人话（保留「放回输入框」按钮）；非屏幕路径的
   `turnRec.parts.push` 也走翻译
4. `scheduleSendingRecheck`：连续 15 次（≈30 秒）拉不到 /api/chat/live 且轮次
   还在飞 → 灯熄 + busy 放下 + 说一句断网人话（只说一次）；巡检继续跑，
   网络恢复灯自动回来
5. resumeOrResend / 插话没接上两条 addSysNote 路径同步去英文化

### 改后实测（同一探针）
- 断网 6.2s 出现「⚠ 网络断了，联系不上她。恢复后她说的话会接着来。」
- **英文报错 0 上屏**；转圈灯 7.2s 熄灭（持平）

## 任务二：工具卡动态耗时

### 改前实测
- 工具卡**是有的**（此前调研没错），跑动期间显示静态「跑命令运行中…」，
  缺的是「正在跑第几个 + 跑了多久」的动态感
- live item 无 startedAt（实测 `startedAt=undefined`）

### 改动
- `src/agent.mjs`：两处 tool_start 事件带 `ts: Date.now()`（并行批 onStart + 主循环）
- `src/server.mjs`：appendLiveItem / buildLiveItems 的 tool 条目存 `startedAt`
  （**从事件上读，不就地取钟**，与 worker 卡同口径；tool_end 兜底 push 带 startedAt:0，
  两份实现形状逐字段一致，parity 40/0 不破）；SSE 转发 tool_start 也带 ts
- `src-ui/items.js`：liveToItems 透传 startedAt
- `src-ui/ToolCard.jsx`：跑着的卡显示 `⠋ 正在跑 · Ns`（盲文点阵轮换 = 旋转标记，
  500ms 计时器只挂在跑着的卡上，完成的卡零定时器）；柜门同步显示耗时

### 改后实测
- 连拍（CDP，隔离实例真发「ping -n 9」）：
  `+1.5s ⠋ 正在跑 · 1s → +4.4s ⠸ 2s → +5.8s ⠦ 3s → +6.5s ⠧ 4s`
- 秒数序列 `[1,1,1,2,2,3,4,5,5,6,7,7,8]`，**1s → 8s 在走**，旋转字符在换

## 其他
- 手机端确认：mobile.mjs 只是局域网 + token 暴露同一个 server / 同一份前端，
  共用这套逻辑，无需单独处理
- 探针脚本 `_deepfixer_probe.mjs`（gitignore 内，不入库，想复测就 copy 一份跑）
- 改前复现用的是 `git worktree add _wt_head HEAD` + node_modules junction，
  测完已删干净

## 提交与坑
- 提交 `7ce935c`（独占文件）+ `51e26af`（index.html 修正）
- **坑**：7ce935c 把队友先前 git add 暂存的旧版 index.html 意外带进了历史
  （-331 行），51e26af 用已验证的工作区版修正。教训：共享文件提交前先看
  `git status` 第一列，staged 里可能有别人的半成品
- **src/server.mjs 未提交**：我的 3 个小 hunk（startedAt×2 + ts 转发）和队友
  280 行的改动混在同一文件，留给最终集成（工作区已验证、sync-live 已生效）

## 检查清单（全过）
node --check（agent/server/items）；build:ui；check-ui ✔（仅 2 处不致命提示，
系原有）；check-syntax 284 ✔；check-live-items-parity **40/0**；sync-live 1 写入
