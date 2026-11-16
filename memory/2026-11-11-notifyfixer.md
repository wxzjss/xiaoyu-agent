# notify-fixer 工作记忆（2026-11-11）

提交：`c69b467`（桌面通知 + 危险词 KNOWN_EDGE 治理，4 文件）

## 一、桌面通知（新功能）

**链路**：`src/server.mjs notifyDesktop()`（触发点只喊话）→ `globalThis.__xiaoyuNotify`（主进程挂）→ `electron/main.cjs showDesktopNotification()` → Electron `Notification`。

**关键认知**：
- 服务端跑在 Electron 主进程里（`importSrc` 同进程 import），**不需要走渲染进程 IPC** —— 走 globalThis 桥（`__xiaoyuBrowser`/`__xiaoyuRelaunch` 同一套既有规矩），比「SSE→前端→ipcRenderer」少两个环节、浏览器直开模式天然降级。
- Windows 通知必须有 `app.setAppUserModelId`，用的 `com.xiaoyu.mini-agent`（= package.json build.appId，必须一致）。
- 防轰炸三道闸：done 天然一轮一次；窗口可见+有焦点则跳过；同内容 3 秒去重。点击通知走 second-instance 同款「拽回前台」动作（restore+show+moveTop+focus）。
- 触发点：turn done 在 `send({type:'done'})` 处（server.mjs ~11441）；ask_approval 在 SSE 推送后（~10560）。正文只报会话名/工具名，不带内容全文。

**验证**：Electron 33 冒烟 `isSupported=true`、`notification shown OK`。坑两个：① 本环境 `ELECTRON_RUN_AS_NODE=1`（WorkBuddy 注入），electron.exe 直接退化成 node，必须 `env -u`；② Git Bash 管道接不到 GUI stdout，结果要写文件或用 PowerShell Start-Process 读；③ `app.getAppUserModelId` getter 在 Electron 33 不存在（只有 setter）。

## 二、危险词 KNOWN_EDGE 治理（9 → 1）

- 6 条真文档误拦：`_DOC_END` 补复合词（使用手册/说明书/操作说明/用户指南/快速参考/User Guide）。
- 核心设计：文档后缀**分强/弱两档**。强后缀（手册类，真确认框不会这么命名）不看「动作+物件」否决直接放行；弱后缀（help/帮助/guide）维持原否决。光补词表不够 —— `删除文件 - 使用手册` 会被 `_LEAD_VERB_NOUN_CN`（删除+文件）拦回危险类。
- 2 条真危险漏拦：第 1 类标题词表补 `remove|removal`（`Remove File - Guide` 此前整条链没人接，不是豁免问题）；`_LEAD_CN` 宾语补「数据」（`清空数据 - 帮助`）。
- 结果：`check-ui-danger-words` 224/224 全绿，只剩 `Delete.ts` 控件名 1 条边界。危险词表（DANGER_WORDS/BTN_EN/APPS）一字未放宽。新增 5 条回归钉子钉住双向约束。

## 边界备注

- `src/features.mjs` 有别人未提交的改动（team defaultOn false→true），**我没有提交它**，提交用显式路径。
- 未碰：public/index.html、src-ui/、sessions-core、whale/fish-presence、/api/sessions。
