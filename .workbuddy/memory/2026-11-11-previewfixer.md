# preview-fixer · 2026-11-11

## 交付
- `GET /api/file?path=`（src/server.mjs）：文件预览接口。安全判定 `pvInsideWorkspace` 抄 tools.mjs safePath 的工作区那一道且更严（HTTP 无会话上下文，管理员/记忆本/tool-out 例外一律不给）；图片回 base64（>8MB 拒）、文本截 200KB、头 8KB 见 NUL 判二进制、>4MB 流式只读头段。
- `GET /api/turn/:at/diff?id=`（src/server.mjs）：某一轮文件改动 diff。anchor = 那一问的 `messages[at]._ws` 快照（rewind 快照写挂消息上、closeTurn 没人调，真正数据源在这）；手写 LCS 行级 diff（前后缀掐掉 + Int32Array 展平表，单边 >1200 行退化整段替换），3 行上下文 hunk，状态 created/modified/deleted/tooBig/unchanged/absent。
- 前端（public/index.html）：#fileView 右侧滑出抽屉（dialog + fixed inset，进场动画靠 JS 补帧加 `.in` 类，transition 在 display:none→block 时不会跑）；气泡行内 code 单击整段选中 + 双击开预览（document 委托，流式每 tick 重建节点，节点级监听必被冲掉；pre 里代码块排除）；attachRetry 里挂「± 查看改动」（ask.at 正是那一问的下标）；diff 加绿删红全走主题变量。

## 实测
- 隔离实例（MINI_AGENT_DATA+PORT+WORKSPACE）15/15：越界 `../../`、`..\..\`、`C:/Windows/`、dataDir 内文件全 403；md/图片/二进制/404 正常。脚本 `_t_previewfixer.mjs`。
- 无头 Edge CDP 9/9（`_t_previewfixer_ui.mjs`）：抽屉文本/图片/越界说人话、路径单击选中+双击预览、diff tab/加绿删红、关闭。

## 踩坑
- `_t_cdp.mjs` 的 `cdp.eval` 把表达式当**函数体**包进 `(async()=>{...})()`——直接求值必须写 `return`，不然全是 undefined（报「openFileView is not defined」其实是空返回误导）。
- modal `<dialog open>` 开着时，dialog 外的内容选区被浏览器抑制——单击选中测试要先把抽屉关掉再点。
- headless Edge 里手工 Range 选区能读回，别把环境怪癖误判成代码 bug。
- 深坑：diff 断言先点文件 tab 再读行，否则读到的是第一个文件的渲染。
- 共享工作区坑：index.html 被队友（deep-fixer 51e26af）整文件提交带走，我的前端改动随之入库——提交前先 `git diff --numstat` 看谁动了哪些块，别抢着整文件提交。
- server.mjs 第 7 行已 import `resolve`/`relative`，别重复 alias 导入。

## 验证链
node --check / build:ui / check:ui（2 处既有提示，非本次引入）/ check-syntax 284 文件 / sync-live 完成（提醒需重启进程才生效）。
提交：399ba16（仅 src/server.mjs）。
