# 【团队模式】前后端完整设计

> 2026-11-10 21:40 定稿。替代【办事模式】。
> 设计原则：**后端把"并行"做实，前端只反映状态，不加额外按钮。**

---

## 零、一句话说清这个功能

【团队模式】= 小鱼干活时可以**拉一支小队一起上，而且她自己不停手**。

和【办事模式】的根本区别：

| | 办事模式（删） | 团队模式（新） |
|---|---|---|
| 主智能体的手 | **被砍掉**（`write_file`/`run_command` 从 schema 摘走） | **留着**，和平时一样全 |
| 派活方式 | `spawn_worker` **同步阻塞**，派完就卡住等 | 后台派发，**立刻返回**，继续干自己的 |
| 界面入口 | 顶栏一颗珊瑚橙按钮 | **没有按钮**，功能页一个开关 |
| 触发 | 主人点按钮 | 主人说一句 / 她自己判断 |
| 结果 | 只能旁观 worker 干 | 主 Agent 和 worker **真并行** |

---

## 一、后端：要实现的 6 件事

### 1.1 前置改造（绕不过去，先做）

#### A. `subagent.mjs` 上下文切换 —— 结论：原设计方向对，但漏了一个必须先改的地方

**三轮实测，结论收敛了。我把过程记下来，因为中间我自己判断错过一次。**

**实测 1 · 「worker 的上下文切换现在是空操作」** —— 成立。
生产路径上 server 早就套了 ALS，而 `subagent.mjs` 用的是 `setToolContext`（改全局 CTX）：
```
runWithToolContext({sessionId:'PARENT'}, () => {
  ctxNow().sessionId → 'PARENT'          ✔
  setToolContext('SUB')                  ← subagent 现在就是这么切的
  ctxNow().sessionId → 'PARENT'          ← 空操作，还是父会话
})
```
**病因**：`ctxNow()` 优先返回 ALS store，只在没有 ALS 时退回全局 CTX。所以 worker 的会话 id **从来没生效过**——这不是后台化带来的，现在就坏着。

**实测 2 · 嵌套 `runWithToolContext` 会丢 5 个字段** —— 成立，**我一开始判断错了**。
```
runWithToolContext({sessionId:'PARENT', snap, outbox, signal, pushEvent, stashFile}, () => {
  runWithToolContext({sessionId:'SUB'}, () => {
    ctxNow().sessionId → 'SUB'   ✔
    snap / outbox / signal / pushEvent / stashFile → 全 ❌ 丢
  })
})
```
**为什么**：`runWithToolContext` 的 `merged = { ...CTX, ...ctx }` 是**以全局 CTX 为基底**，不是以外层 ALS 为基底。
（我先前测出「不丢」是因为我把值塞在了全局 CTX 里 —— 那是另一种情况，不能类推。）

**所以正确做法是两步，缺一不可**：
```js
// 第一步：改 runWithToolContext 的基底（tools.mjs:126）
const base = CTX_STORE.getStore() || CTX;          // ← 有外层就用外层
const merged = (ctx && typeof ctx === 'object') ? { ...base, ...ctx } : base;

// 第二步：subagent 用 ALS 而不是 setToolContext
await runWithToolContext({ sessionId: subId }, () => runSubagent({...}));
```

#### ⚠️ A1·b 只改基底还不够 —— 全局 CTX 会被别的会话顶掉（我实测出来的，四级后果）

**实测**（复刻真实顺序：A 开 ALS → `setToolContext(A)` → **B 会话开始，把全局 CTX 顶成 B** → A 的 worker 进内层）：
```
A 的 worker 看到:
  sessionId = SUB-A      ✔（ALS 生效了）
  snap.owner = B         ✘ 串到 B 会话
  signal.tag = B         ✘ 串到 B 会话
  outbox     = null      ❌ 丢
  stashFile  = 丢
```

**为什么**：`{ ...base, ...ctx }` 的 `base` 是**全局 CTX（那一刻被 B 顶过）**，而 ctx 里只有 `sessionId` → 其余字段全从 B 拿。

**这条的后果比「丢字段」严重得多，按顺序是**：
1. **文件和图片挂到别人会话上**（`outbox` 是 B 的）→ 最痛，会发错文件
2. **worker 把主人的话当成自己的**（`snap` 是 B 的快照）
3. **在 B 会话点停止，A 的 worker 跟着断**（`signal` 是 B 的）→ 跨会话串扰
4. 状态回溯全丢（`snap`）

**所以 worker 必须显式传齐这 6 个字段，不能只传 sessionId**：
```js
await runWithToolContext({
  sessionId: subId,
  snap: null,                    // worker 不继承主人的快照（它是独立任务）
  outbox: [],                    // 自己的收件数组 —— 别用别人的
  signal: workerCtrl.signal,     // 自己的 controller（见 A2）
  pushEvent, stashFile,          // 从外层继承（这两个是"管道"，共用没问题）
}, () => runSubagent({...}));
```
**注意 `snap` 给 `null` 而不是继承** —— worker 是独立任务，拿主人的回退快照没有意义，反而会让"回退"指到错的地方。

**一句话**：`snap` / `outbox` / `signal` 三个 **必须新造或显式给 null**，不能指望继承；`pushEvent` / `stashFile` 可以从外层继承。

**顺带收益**：这两步做完，「两个 worker 串板」也一起修好了 —— 但病因是它现在就坏着，不是后台化导致的。

#### A2. `subagentDepth` 必须进 ALS（我实测确认）
`subagentDepth()` 读 `CTX.subagentDepth`，是**进程级共享**。实测：
```
初始 0 → A 起 1 → B 起 2 → 第三个想派活：depth>=2 → 拦
```
`spawn_workers` 并发 4 个 → **第 3、4 个直接返回「已经套到 2 层了」**。这解释了为什么 `spawn_workers` 一直没人用——它本来就跑不顺。
更糟：任一 worker 没走到 `finally` 的 `dropSubagentDepth()`（崩溃/abort），depth 永久留在 >0 → **整台机器再也派不出 worker**，只能重启。

---

#### A2. worker 的 signal 必须自己 new（不能挂主轮的）
`subagent.mjs:490` 自己 `new AbortController()`，`:492-495` 只是把外部 signal **单向转发进来**（`signal.addEventListener('abort', () => abortCtrl.abort('stop'))`），**没有反向传播**。
- 停 worker **不会**影响主智能体 ✅
- 但**后台 worker 绝不能拿 `ctxNow().signal` 当入参** —— 那是主智能体这一轮的 signal，主人点停止会让 worker 跟着断
- 正确做法：worker 池存 `Map<sid, Map<wid, AbortController>>`，`/api/team/stop` 从池里取

---

#### B. worker 进度写盘加队列
**为什么**：`.state/task-workers/<sid>.json` 是「读 → 改 → 写」（`task-mode.mjs:242`），**中间没锁**。后台 worker 每步都写 `noteWorkerProgress`，多 worker 同时写会**丢进度行**。

**改法**：进程内一个 `Map<sid, Promise>` 做写队列（Node 单线程，队列化就够，不用文件锁）。

---

### 1.2 新增：后台派发

#### 工具签名变更
```
spawn_worker   { task, name?, accept?, scope?, background?: boolean }
spawn_workers  { tasks[], background?: boolean }
```
`background: true` 时：
- **立刻返回** `#wid`（不等 `runSubagent`）
- 把那个 Promise 挂到会话级池：`Map<sid, Map<wid, Promise>>`
- 主智能体拿到 wid 就能继续干别的

**返回文案**（要让她知道"可以接着干"）：
```
【#3 派出去了，正在后台干】
它跑它的，你别停 —— 有别的活就接着做；想看看进度用 watch_worker 3；想补话用 tell_worker 3。
干完我会主动告诉你。
```

#### 干完之后怎么通知主智能体（两个通道，都要）

**通道 1 · 自动推（不漏）**：复用 `src/inbox.mjs` 的 `steer(sid, text)`
- 它本来就是给「主人插话」做的：`agent.mjs:1227` 每圈请求模型前 `drainSteps()` → push 成一条 user 消息
- **零新代码**，而且落盘（`.state/inbox/<sid>.json`），进程重启不丢
- ⚠️ **必须写清"这不是主人说的"**，否则她会当成主人在催：
  ```
  【你派出去的 #3 回来了 —— 这是它的汇报，不是主人说的】
  结果：…
  ```

**通道 2 · 主动查（不被动）**：`watch_worker` 保持非阻塞，读文件即可（已经是这样）

**为什么不用 `pushWhaleSays` / `postMail`**：
- `pushWhaleSays` 绑定 `whaleMaybeReply` 的节流和"冒充身份"逻辑，错配
- `postMail` 在 `peer.mjs:87` 明确 `from === to` 直接拒绝

#### worker 池
**不用新建**：现有 `.state/task-workers/<sid>.json` 已经落盘，字段够用：
```js
{ id, name, task, status, startedAt, endedAt, rounds, tools, said, mails[], progress[] }
```
`status`: `running` | `reported` | `failed`

---

### 1.3 删【办事模式】

| 删什么 | 位置 |
|---|---|
| 功能定义 | `src/features.mjs:202` `id:'taskmode'` 整条 |
| 工具被摘的分支 | `src/agent.mjs:159 toolsForTurn()` 里 `if (taskOn(sessionId))` 整段 |
| 派活前的闸 | `src/tools.mjs:2100`、`:2225` 的 `if (!taskOn(sid)) return 'ERROR：【现在不是办事模式】…'` |
| 顶栏按钮 | `public/index.html:3326` `<button id="taskBtn">` + `:138` 珊瑚橙 `.on` 样式 + 点击/状态同步逻辑 |
| 提示词段落 | `src/task-mode.mjs` 的 `taskPromptBlock()`（"你只派活别动手"那套） |
| 引用清理 | `agent.mjs` / `agents.mjs` / `group.mjs` / `llm.mjs` / `persona.mjs` / `pick-helper.mjs` / `subagent.mjs` / `tools.mjs` / `harness/tool-spec.mjs` / `public/ui/chat.js` / `src-ui/items.js` 里的 taskmode 分支 |
| 检查脚本 | `check-feature-readpaths.mjs` / `check-features-portable.mjs` / `check-no-response.mjs` / `check-prompt-facts.mjs` 里的 taskmode 断言 |

**保留**（迁到 `src/team/` 或就留在 task-mode.mjs 改名）：
- worker 生命周期：`noteWorker` / `finishWorker` / `dropWorker` / `listWorkers` / `sendWorkerMail` / `drainWorkerMail` / `noteWorkerProgress` / `workerDetail`
- 文件存储：`.state/task-workers/<sid>.json`

**文件重命名建议**：`src/task-mode.mjs` → `src/team.mjs`（573 行里砍掉 taskOn/TASK_KEEP_TOOLS/taskPromptBlock 后约剩 380 行）

---

### 1.4 新增功能定义

```js
{
  id: 'team',
  name: '团队模式',
  scope: 'session',
  defaultOn: false,          // 新功能默认关（11-10 定的规矩）
  ownerOnly: false,          // 所有身份可用（聊天辅助性质）
  tools: ['spawn_worker', 'spawn_workers', 'list_workers', 'tell_worker', 'watch_worker'],
  desc: '开了之后我干活时可以拉一支小队一起上：你说一句「帮我查三份资料」，我自己判断要不要拆、拆几份、派给谁。派出去之后我不停下来等——它们跑它们的，我该干别的干别的，想起来就看看进度、补两句话。所有子智能体只属于这个会话，干完或会话删了就没了。这个开关没有顶栏按钮，全程我说了算；关掉之后我只会一个人干活。',
}
```

---

### 1.5 数据接口（前端要用的）

| 接口 | 方法 | 返回 | 用途 |
|---|---|---|---|
| `/api/features?sessionId=` | GET | `features[]` 里多一条 `{id:'team', ...}` | 功能页显示开关 |
| `/api/features/set` | POST | `{ok, id, on, scope, sessionId}` | 开关切换（已有） |
| `/api/team/workers?sessionId=` | **新增** GET | `{workers:[{id,name,task,status,startedAt,endedAt,rounds,tools,said,mails[],progress[]}], running:number, total:number}` | 前端轮询/初始加载 |
| `/api/team/stop` | **新增** POST | `{ok, id}` | 主人手动停一个 worker（**新增能力，见 2.4**） |
| SSE `/api/chat/live` | 已有 | `{type:'worker', wid, name, kind:'start'\|'step'\|'mail'\|'end', text, status?, note?}` | 实时推送 |

#### 后台化必须补的一条（SSE）
现在 worker 事件走 `ctxNow().pushEvent`，**只在主智能体那一轮活着时有 live 缓冲**。后台 worker 在主 Agent 这轮结束后还在跑时，`send` 里 `if (!live) return;` → **事件直接丢掉，界面看不见**。

**改法**：worker 事件要落到该会话的 `liveLogs` 缓存，而不是只走当前这一轮的 `send`。

---

## 二、前端：怎么呈现

### 2.1 设计原则（三条）

1. **不加按钮**：主人明确要求"不设按钮"。入口只有功能页那个开关。
2. **不抢主流程**：worker 卡是**消息流里的一部分**，跟工具卡同级，不弹窗、不占侧栏。
3. **状态要好认**：一眼能看出"有几个在跑、各自干到哪一步、有没有回来"。

### 2.2 界面布局（三处）

#### ① 功能页（唯一入口）
```
┌─ 功能 ────────────────────────────────────┐
│ 团队模式                              [开] │
│ 开了之后我干活时可以拉一支小队一起上：你说  │
│ 一句「帮我查三份资料」，我自己判断要不要拆、│
│ 拆几份、派给谁。派出去之后我不停下来等——   │
│ 它们跑它们的，我该干别的干别的…            │
│                                            │
│ · 没有顶栏按钮，全程我说了算                │
└────────────────────────────────────────────┘
```
- 和现有 31 个功能条目同款式（`renderFeatList`）
- **不标「整台机器」**（它是按会话的，26 个普通功能之一）

#### ② 聊天流里的 worker 卡（核心，改造现有 WorkerCard）
现有 `src-ui/WorkerCard.jsx`（41 行）已经做了基础版，改造点：

```
┌─ ▶ #3 查资料  干活中… · 5 步 ──────────────┐   ← 折叠态（summary）
└────────────────────────────────────────────┘
展开后：
┌─ ▶ #3 查资料  干活中… · 5 步 ──────────────┐
│  ▶ 开始干：查 DeepSeek V4 的定价            │
│  · 第 1 步 → 打开官网                       │
│  ✉ 收到补话：顺便看看有没有免费额度          │
│  · 第 2 步 → 抓到了，正在整理                │
└────────────────────────────────────────────┘
```

**改造点**：
| 现状 | 改成 | 为什么 |
|---|---|---|
| 状态只三档（`回来了`/`没干成`/`干活中…`） | 四档：`干活中…`（黄）/`回来了`（绿）/`没干成`（红）/`停了`（灰） | 后台化多一个"停"状态 |
| 卡片按 taskmode 判断显示 | 按「有没有 worker 在跑」判断 | 删了办事模式后不能靠它 |
| 不显示耗时 | 折叠态右侧显示 `· 2分13秒` | 后台跑主人不知道要等多久 |
| 不显示进度条 | 有 `rounds`/`tools` 就显示 `· 12轮/8次工具` | 判断"卡住还是真慢" |

**关键**：收口态显示"还有几个在跑"，方便主人在长对话里扫一眼：
```
┌─ ▶ #3 查资料  干活中… · 2分13秒 ──────────┐
└────────────────────────────────────────────┘
```
如果同一条消息里有多张卡，**在最后一张上面加一行小字**：
```
「3 个在跑 · 1 个回来了」
```
（这一行只在同一轮有多 worker 时出现，避免噪音）

#### ③ 顶部状态条（轻量，不常驻）
只在**有 worker 在跑时**出现，5 秒淡出，不占布局：
```
⚑ 3 个在后台干活…
```
- 位置：聊天区顶部，跟「正在输入」同一区域
- 点它能滚到最新的 worker 卡
- **不出现时零占位**（用 `position:absolute` 或 `height:0` 过渡）

### 2.3 信息结构（worker 卡显示什么）

| 字段 | 来源 | 显示在哪 |
|---|---|---|
| `#id` + 名字 | `worker.id` / `worker.name` | 折叠态左侧，加粗 |
| 状态 | `worker.status` | 折叠态右侧，带颜色 |
| 步数 | `progress.length` | 折叠态右侧 `· N 步` |
| 耗时 | `Date.now() - startedAt`（跑着时实时算） | 折叠态右侧 `· 2分13秒` |
| 轮次/工具数 | `rounds` / `tools` | 展开态底部（可选） |
| 进度行 | `progress[]` | 展开态，前缀区分类型（见下） |
| 补话 | `mails[]` | 展开态，`✉` 前缀 |
| 最终汇报 | `said` | 展开态，`⇢` 前缀，换行压平 |

**进度行前缀**（沿用现有 `PREFIX` 常量）：
```
▶  开始
·  普通进度
✉  收到补话
⇢  最终汇报
✗  失败原因
```

### 2.4 用户操作流程

#### 场景 A：主人说一句话（主要路径）
```
主人：帮我查一下 DeepSeek、通义、Kimi 三家的最新定价，整理成一张表
  ↓
小鱼（判断：三件互不依赖，可以并行）：
  spawn_workers { tasks:[...3件...], background:true }
  ↓ 立刻返回 3 个 wid
小鱼（不停，继续干活）：我先自己把表结构搭好 →
  write_file 建表头
  ↓ 三个 worker 跑着
[界面：⚑ 3 个在后台干活… + 三张折叠的 worker 卡]
  ↓
worker 陆续回来 → steer 注入 → 小鱼下一步看到
小鱼：三家的都拿到了，我补进表里 → write_file / edit_file
  ↓
小鱼（对主人）：整理好了，三家的最新定价都在表里
```
**关键**：主人看不到"等待"，只看到表格慢慢长出来。

#### 场景 B：主人手动干预
| 操作 | 怎么做 | 后端接口 |
|---|---|---|
| 看进度 | 客户端每 3 秒轮询 `/api/team/workers`（**只在有 running 时轮询**，全停就停） | `GET /api/team/workers?sessionId=` |
| 让某个 worker 停 | worker 卡右上角 `✕ 停掉`（悬停才露，同删除按钮的交互） | `POST /api/team/stop {sessionId, wid}` |
| 给小鲸补话 | **不做界面入口** —— 主人直接跟小鱼说「让 #3 顺便看看免费额度」，小鱼自己 `tell_worker` | 现有工具 |

**「停掉」是新增能力**，需要后端配合：
- 现在 `runSubagent` 有 `signal` 参数（已有 abort 机制）
- 停 = abort 那个 worker 的 signal + `finishWorker(status:'stopped')`

#### 场景 C：会话切换 / 刷新页面
- 切会话 → worker 卡只显示该会话的（`/api/team/workers?sessionId=` 本身就按会话隔离）
- 刷新页面 → 从文件读回（worker 池已经落盘）→ **正在跑的 worker 状态是 `running`，但实际进程可能还在跑**
  - ⚠️ **风险**：页面刷新后前端看到的 `running` 是文件里的旧状态，实际 worker 可能已经结束
  - **修法**：后端在启动时把所有 `running` 但进程已重启的 worker 标成 `interrupted`（新增状态），前端显示「中断了（程序重启过）」

### 2.5 前后端衔接时序

```
[主智能体一轮]
  │
  ├─ 调 spawn_workers{background:true}
  │     ├─ noteWorker(sid, {...status:'running'})       → 落盘
  │     ├─ 立刻 return "#3 #4 #5 派出去了"
  │     └─ 后台：runWithToolContext(ALS) → runSubagent
  │           ├─ onProgress → noteWorkerProgress（写队列）
  │           ├─ push({type:'worker', kind:'step'})     → SSE → 前端实时加行
  │           └─ 完成 → finishWorker + steer(sid, '【#3 回来了】…')
  │
  └─ 主智能体继续干自己的（read_file / write_file / …）
        ↓ 这一轮结束时
        └─ 下一轮开头 drainSteps() → 看到 worker 汇报

[前端]
  ├─ 打开会话 → GET /api/team/workers → 渲染历史 worker 卡
  ├─ SSE 收到 worker 事件 → 增量更新对应卡片（按 wid 匹配，不重建）
  ├─ 有 running → 每 3 秒轮询兜底（SSE 漏了也能补上）
  └─ 全停 → 停止轮询
```

---

## 三、对其他功能的影响（主人问的）

| 影响 | 判断 | 处理 |
|---|---|---|
| **智能体（ask_subagent）** | ⚠️ 有交叉：`spawn_worker`/`list_workers` 同时被 taskmode 和 agents 声明（`features.mjs:494` 有专门注释说这个坑） | 改成 team + agents 共享，但要保证"关一个不会连带关另一个"（现有 `TOOL_OWNERS` 逻辑要核） |
| **功能页计数** | 31 → 31（删 1 加 1） | 无影响 |
| **顶栏布局** | ✅ 少一颗按钮 | 顺便缓解手机端 643px 溢出 |
| **WorkerCard 渲染** | ⚠️ 现在按 taskmode 判断 | 改成按「有没有 worker」判断 |
| **提示词字数** | ➖ 删掉"你只派活别动手"那套后**变短** | 顺带收益 |
| **历史会话** | ⚠️ `feature-by-session.json` 里有 `taskmode` 键 | 读时忽略（不报错、不迁移），加注释 |
| **检查脚本** | ⚠️ 4 个脚本有 taskmode 断言 | 同步改 |
| **`spawn_workers` 描述里的假话** | ⚠️ 「等它们的时候可以先 watch_worker」 | 必须改成「派出去立刻回来，你可以接着干别的」 |

---

## 四、验收清单（实机，不是看代码）

### 后端
- [ ] `spawn_worker {background:true}` 立刻返回（计时 < 500ms），不等 worker 干完
- [ ] 派 2 个后台 worker → 主智能体同一轮里能继续调 `write_file`（查会话记录确认有 tool_call）
- [ ] worker 干完 → 下一轮主智能体的上下文里出现「【#3 回来了】」
- [ ] 两个 worker 同时跑，各自 `note` 落盘到**自己的** sub 板（不串）
- [ ] worker 事件在主 Agent 这轮结束后仍能被前端收到（`liveLogs` 落缓存）
- [ ] 主人在 A 会话关掉 team 功能 → 子智能体也拿不到派活工具
- [ ] 关掉「智能体」功能不影响 team，反之亦然

### 前端
- [ ] 功能页能看到【团队模式】，开关能点，描述是新的
- [ ] 顶栏**没有**办事模式按钮了
- [ ] 派活后出现 worker 卡，状态从「干活中」变「回来了」
- [ ] 多 worker 时显示「N 个在跑 · M 个回来了」
- [ ] 点「停掉」能真的停（worker 不再产生新进度）
- [ ] 切换会话：只看到本会话的 worker
- [ ] 刷新页面：能看到历史 worker 卡片
- [ ] 程序重启后：原来的 running worker 显示「中断了（程序重启过）」

### 文案
- [ ] 界面里搜不到「办事模式」三个字
- [ ] `spawn_workers` 描述里没有「等它们的时候可以先 watch_worker」这句假话
- [ ] 提示词里没有「你只派活别动手」那套
