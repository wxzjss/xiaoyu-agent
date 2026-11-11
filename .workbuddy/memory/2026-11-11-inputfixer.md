# input-fixer · 2026-11-11 · @ 提及浮层 + 空状态示例 chips

## 做了什么

**① @ 提及文件浮层（对标 WorkBuddy Mention files/symbols）**
- 数据源：`GET /api/files/mention?q=&dir=`（src/server.mjs 新路由）。没有可复用的现成路由——`/api/attach/browse` 是故意放开全盘的「+」附件路，不能用；照 `tools.mjs safePath` 的核心判据自己写：`relative(root, abs)` 出 `..` 或绝对路径直接 400。
- 踩坑：第一版深度优先遍历，a-test-data 几千个文件把扫描预算（3000）吃光，根目录下真想要的文件永远搜不到。改成 **BFS 队列**，浅层永远优先；只打 `@` 没打字时浅列一层。
- 前端（index.html 末尾 IIFE `mentionFiles`）：镜子 div 量 textarea 光标坐标；`window.__mentionKeyHook` 挂在原 input keydown 第一行——弹层开着时 Enter/Tab/↑↓/Esc 先归它，**回车不会把消息发出去**；IME 用同一个 `_imeComposing` 状态机；文件名一律 textContent。
- 真 bug 被实测抓出来：`mStart = caret - token.length` 漏了 `@` 本身，替换后残留 `@`。要 `- 1`。

**② 空状态示例 chips（对标 welcome.quickAction）**
- footer 里 `#startChips`（HTML+CSS+JS 都在 index.html），2 组 × 4 条口语化示例 + 「换一批」轮换；点击只填输入框并 focus，**不自动发送**。
- 显隐判据：`#log` 里没有 `.msg`/`details.toolhub` 且 `sessionId` 存在；MutationObserver 盯 #log，renderLog 一动就重判，老会话/有历史自动藏。
- 真 bug：一开始只在 IIFE 末尾调 `refresh()` 没调 `paint()`，chips 空着等「换一批」才有内容——实测抓出来的。

## 真机实测（隔离实例 + CDP，_t_mention.mjs，17/17 PASS）

- HTTP：空 q 列 20 条；q=mention-a 命中；`dir=../..` 与 `..%2f..%5c..` 均 400（不泄露上级内容）；`&'()` 特殊字符文件名原样返回。
- 弹层：出现→过滤（目录组+文件组 3 条）→↓选中→Enter 替换 @ 段为 `mention-test-src/mention-a.mjs `，弹层关，`log .msg=0`（没发消息）。
- XSS：Windows 文件系统造不出 `<script>` 文件名（连 `\\?\` 前缀都不行）——改用 fetch mock 喂 `<img src=x onerror=...>` 和 `<script>...</script>` 两条恶意 name 走**真实渲染路径**：textContent 字面显示、浮层里 0 个 img/script 元素、`window.__mentionXssHit` 从未被置 1。
- chips：空状态出现 4 条→换一批换另一组→点击填入且焦点回输入框→插入 `.msg` 后立即隐藏。

## 环境坑（省下后来人时间）

- `_t_cdp.mjs` 的 `eval()` 把表达式包成 `(async () => { expr })()`——**表达式里必须写 `return`**，不然永远是 undefined（我以为是 CDP 坏了查了半小时）。
- 隔离实例 workspace 不是 `dataDir/workspace`，这台机器指到 `D:/小鱼Agent/sandbox`（seedConfig 带过去的配置决定）——以 `/api/health` 的 `workspace` 字段为准。
- 隔离实例会继承主人的模型配置，新会话开场白**真的会跑一轮 LLM** 画成 `.msg`——测「空状态」要先手动清掉。
- 队友并发改同一个 index.html：我的大部分改动被 deep-fixer 的「补上当前已验证版」提交(51e26af)顺手带进了 HEAD，我的提交 bedacb0 只剩最后两行修复。共享文件提交前一定 `git diff` 看清哪些已经是 HEAD。

## 提交
- `bedacb0` index.html（最后两行修复）；mention 路由随队友提交已进 HEAD。
- sync-live 已跑（1 写入 146 一致）；check-ui / check-syntax / build:ui 全绿。
