# 小鱼Agent

一个自用的极简 Agent 平台：**Electron 桌面应用 + OpenAI 兼容 API + 工具循环**，除 Electron 外零依赖。

会读文件、写文件、跑命令、开网页、拆任务清单，聊天记录存本地，模型随便换。

![界面](assets/xiaoyu-256.png)

## 快速开始

```powershell
npm install          # 装 Electron（只装这一个）
npm start            # 桌面窗口；或者双击 start.bat
```

想要一个双击就能用的 exe：

```powershell
npm run pack:dir     # 只出免安装目录 dist/installer/win-unpacked/小鱼Agent.exe
npm run pack:exe     # 出 NSIS 安装包 + 免安装单文件，都在 dist/installer/
```

打包版的数据（会话、设置、人设、工作目录）放在可写目录，不跟程序混：
免安装版在 exe 旁边的 `data\`，安装版在 `%APPDATA%\xiaoyu-mini-agent\data`。
源码目录里的 `.state` 和它们是两份，别指望自动同步。

第一次打开**没有任何模型**，点右上角【模型】→ 添加 → 填一个 OpenAI 兼容接口（接口地址、模型名、API Key）
→ 测连通 → 保存，就能聊了。也可以复制 `.env.example` 成 `.env` 填 `WANZI_API_KEY`。

> 建议在界面里配：可以存好几套，随时切，Key 只留服务端。

## 第一次启动会自己检查一遍

怕换台电脑就跑不起来，所以做了启动自检：

- **第一次**（或版本升级后）跑**深度自检**，该查的全查：源码齐不齐、`.state` 能不能写、`.env` 里的路径是不是别人电脑的、
  工作目录在不在、图片目录/文件浏览起点能不能读、Electron 装没装、PowerShell 通不通、临时目录能不能写、模型配了没…
- **以后每次**跑**快速自检**，只查「缺了就用不了」的那几项。
- **每次启动**都顺手看一眼桌面快捷方式：没有就建，指向旧目录（搬过家）就重建。

能自己修的会当场修掉（`.env` 里指向别人电脑的 `WORKSPACE` 会自动注释掉、工作目录不存在会自动建、
坏掉的快捷方式会重建、损坏的功能开关文件会重置）。

修不了的会记到 `.state/selfcheck-pending.json`，等你配好模型开口说话时，**交给 AI 自己处理**——
它能看到这份清单，会主动说一声然后动手。

想手动看/重跑：

```powershell
npm run selfcheck            # 快速
npm run selfcheck -- --deep  # 深度
```

## 界面

顶栏几个按钮：

| 按钮 | 干什么 |
|---|---|
| 会话 | 新建 / 切换 / 改名 / 删除会话，自动回到上次那个 |
| 功能 | 列出当前所有能力，**每条能单独停用**（见下） |
| 设置 | 改人设卡、底线、安全词 |
| 模型 | 存多套 OpenAI 兼容端点，点一行就切，支持测连通 |
| 清空当前 | 清掉当前会话的聊天记录（会话本身留着） |

### 功能开关

关掉的功能是**真关**：那个工具不再交给模型（模型连看都看不到），万一它硬调也会被拒。
改完下一句生效，状态存 `.state/features.json`。（视频背景是纯界面的，改完立刻生效。）

| 功能 | 工具 |
|---|---|
| 联网功能 | `fetch_url` |
| 读文件 / 写文件 / 看目录 | `read_file` / `write_file` / `list_dir` |
| 跑命令 | `run_command` |
| 任务清单 | `plan` |
| 便签 | `note` |
| 视频背景 | ——（纯界面：短片铺成聊天背景，无声循环；右下角小圆钮调亮度，可随时关掉） |

## 视频背景

照 [dsh-video-skin] 的思路做的：一段无声 mp4 用 `object-fit: cover` 铺满窗口，永远在最底下三层
（`video` → 黑色蒙版 → 暗色薄纱），所以不挡点击、不影响任何面板。面板和输入区跟着变半透明，
对话框保持实心好读字。

- 素材默认用 `assets/background.mp4`；想换自己的片子，把路径写进 `.state/skin.json` 的 `file`
  （相对路径按工作目录算），指哪放哪。
- 右下角 `◐` 是调节钮：面板暗度 / 蒙版两个滑杆，另有三档预设（原色 / 均衡 / 透明）。
- 想彻底关掉：【功能】→ 视频背景 → 停用，立刻撤掉，连视频都不再加载。
- 打包版第一次启动会把内置短片整份复制到**可写数据目录**的 `assets/background.mp4`
  （免安装版在 exe 旁边的 `data\`，安装版在 `%APPDATA%\xiaoyu-mini-agent\data\`），之后只播那份。
  不直接播 asar 里的、也不靠 `asarUnpack`：免安装版会把整包解到 %TEMP% 的随机目录再删掉，
  实测那样一开就 ENOENT 弹窗。
- 视频走带 `Range` 的接口，浏览器才能边下边播、循环拖动；接口只认这一份素材，
  不接受前端传任意路径。

## 结构

```
electron/main.cjs     Electron 主进程：启动自检 → 起服务 → 开窗口
electron/preload.cjs  安全桥（contextIsolation + sandbox，只暴露 2 个方法）
public/index.html     界面：流式输出、工具卡片、附件选择、会话/模型/功能/设置面板
src/config.mjs        .env / 环境变量
src/llm.mjs           /chat/completions 流式客户端（SSE）
src/tools.mjs         工具：读/写/列目录/跑命令/清单/便签/抓网页
src/agent.mjs         工具循环：模型 → 调工具 → 回灌结果 → 继续
src/persona.mjs       系统提示拼装：人设卡 + 底线/安全词（设置里能看到什么，就发什么）
src/selfcheck.mjs     启动自检 + 自动修复
src/features.mjs      功能开关
src/skin.mjs          视频背景：旋钮读写 + 该播哪个文件
src/models.mjs        多套模型端点
src/sessions-core.mjs 会话落盘
src/settings.mjs      底线 / 安全词
src/persona-store.mjs 人设卡读写
src/compress.mjs      上下文压缩
src/server.mjs        HTTP 服务 + 所有 API
scripts/publish.mjs   发布到 GitHub（脱敏 + 打包 + 推送）
scripts/auto-publish.mjs  改完自动发布
```

## 配置（.env）

| 变量 | 说明 | 默认 |
|---|---|---|
| `WANZI_API_KEY` | LLM 的 API Key（也可用 `API_KEY`） | 空 |
| `BASE_URL` | OpenAI 兼容接口根地址 | `https://napi.wanzij.cn/v1` |
| `MODEL` | 模型名 | `deepseek-v4.1-flash` |
| `PORT` | 网页版端口（桌面版用随机端口） | `8787` |
| `WORKSPACE` | 工具能操作的工作目录（越界会被拒） | 项目里的 `sandbox/` |
| `MAX_ROUNDS` | 单轮工具调用上限，`unlimited` = 不限 | `unlimited` |
| `CONTEXT_LIMIT` | 历史超过这么多 token 就压缩旧对话，`off` = 关 | `120000` |
| `CONTEXT_KEEP_RATIO` | 压缩后保留的尾部比例 | `0.25` |

## 其它入口

```powershell
node src/server.mjs         # 纯网页版 → http://127.0.0.1:8787
node src/cli.mjs "你的指令"   # 终端单轮
node src/cli.mjs            # 终端交互，/exit 退出
```

## 发布（维护者用）

```powershell
npm run publish:dry    # 只打包到 dist/release，不联网
npm run scan           # 只做敏感信息扫描
npm run publish        # 打包 + 提交 + 推送
npm run autopublish    # 有改动就发布一次
npm run autopublish -- --watch    # 常驻监听，改完自动发布
npm run autopublish -- --install  # 装成开机自启（Windows）
```

发布是**白名单制**：只带源码、素材、默认配置；`.env` / `.state` / `sandbox` / `node_modules` 一律不带。
出门前会扫一遍真实用户名、token、私钥、API Key、明文密码、邮箱——**命中就中止**，不是提醒。

## 环境注意

如果系统里设了用户级环境变量 `ELECTRON_RUN_AS_NODE=1`（某些工具会留下），Electron 会退化成纯 Node 运行、
报 `Cannot read properties of undefined (reading 'whenReady')`。`start.bat` 已经清掉这个变量；
直接 `npm start` 报这个错时，先 `set ELECTRON_RUN_AS_NODE=` 再启动。

## 许可

MIT。
