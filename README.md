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
| 会话 | 新建 / 切换 / 改名 / 删除 / **批量删除** / **搜内容**，自动回到上次那个；还能导出到本地、或从本地导入 |
| 功能 | 列出当前所有能力，**每条能单独停用**（见下） |
| 设置 | 人设卡、底线、安全词、**手机连接**、**背景音乐**、**数据备份**、**更新检查** |
| 模型 | 存多套 OpenAI 兼容端点，点一行就切，支持测连通；接口地址和模型名都有下拉可选 |
| 纯净模式 | 干任务用的精简模式，见下 |
| 清空当前 | 等于「把这个会话删了换个新的」：旧会话连记忆一起进回收站，当场开一个空的 |

### 功能开关

关掉的功能是**真关**：那个工具不再交给模型（模型连看都看不到），万一它硬调也会被拒。
改完下一句生效，状态存 `.state/features.json`。（视频背景是纯界面的，改完立刻生效。）

| 功能 | 工具 / 作用 |
|---|---|
| 联网搜索 | `web_search` / `fetch_url` |
| 读文件 / 写文件 / 看目录 | `read_file` / `write_file` / `list_dir` |
| 跑命令 | `run_command` |
| 任务清单 | `plan` |
| 便签 | `note` |
| 抓网页存文件 | `fetch_txt` / `fetch_many` |
| 打包成书 | `pack_book` |
| 繁简转换 | `t2s_convert` |
| 发文件 | `send_file`（她把文件塞给你，卡片上直接预览 / 下载） |
| 开场白 | ——（新建会话时先垫一轮「她自己在等你」的对话，界面看不见，可以自己改写） |
| 纯净模式 | ——（见下，默认**关**） |
| 视频背景 | ——（纯界面：短片铺成聊天背景，无声循环；右下角小圆钮调亮度，可随时关掉） |
| 背景音乐 | ——（在【设置】里，默认播壁纸那首，可导入本地音乐） |

## 会话记忆

每个会话有一份自己的小本子，存在 `.state/memory/<会话id>.md`。它不进聊天记录、界面上也不显示，
但**每轮都拼进系统提示**——所以 AI 一开口就已经「记得」这个会话里发生过什么。

- 她可以自己往里写摘要（`- R0001 [时间] 摘要：…`），写满 80 条自动滚进文件末尾的归档段，一条不丢。
- 结构是 `# 会话记忆` → `## 固定记忆`（任务目标 / 用户约束 / 当前状态 / 待办）→ `## 滚动摘要`，可以直接用文本编辑器改。
- **回退**会把本子一起退回去（每轮开头拍一张快照），**撤销回退**又拿回来。
- **编辑某一句对话**，本子里提到这句的地方会跟着改，并标上「（主人把这句话改成了：…）」；撤销那次编辑，记忆也随之退回。
- 分支会话会**继承**母会话的本子，之后各写各的。

## 纯净模式

干体力活时用的精简模式，顶栏【纯净模式】按下去就一直高亮，再按一下退出（也能在【功能】里整个关掉，
关掉后顶栏那个按钮就不出现了）。

开着的时候发给模型的东西**只剩对话本身**：

- 不发人设、不念会话记忆、不带前情和开场白，安全词规则也不发——只补一条「答短点」和一句「别沿用前面的语气」。
- **每轮都把历史压一遍**，只留最近几条（约 2 万 token 以内），旧的直接折掉不做摘要。
- 历史里那些旁白、颜文字、撒娇会被洗掉再发（只洗发给模型的副本，盘上的记录一个字不改）。
- 实测同一件事：人设模式下 4.3k token 的输入，纯净模式 2.4k；回复从三段撒娇变成一句话直答。

## 编辑每一句话

主人在对话里可以**直接改自己说的话，也可以改 AI 说过的话**：鼠标移到气泡上，右上角（AI 的回复是右下角）
会出现「✎ 编辑」，点开原地变成输入框，「存上」就生效，Ctrl+Enter 存、Esc 取消。

- 改完**立刻影响后续上下文**——下一轮发给模型的就是改过的内容。
- 右边还有「撤销上次修改」，一句可以改好几次，撤销是后进先出。改过的句子会标一个小圆点「· 改过」。
- 和「↶ 回退」（只遮蔽、不删除）是两件事：回退是假装没说过，编辑是真的换掉。

## 分支 / 用量

- 每轮回复下面有一行小字：`↑输入 · ↓输出 · 总 tokens · ≈花了多少钱 · ⑂ 在新会话中分支`。
  用量**存进会话文件**，重启、换设备打开都还在（老对话那行会写「这一轮没记用量」）。
- 钱是按各厂商公开价折算的，DeepSeek / MiniMax 对过官网，其余抓不到的先按美元牌价估，会标「（估）」。
- 「⑂ 在新会话中分支」把到这一轮为止的对话整段复制到一个新会话，原会话一个字节都不动。

## 手机连接

手机装 APK（`XiaoyuAgent-<版本>-Mobile.apk`），电脑上【设置】→【手机连接】打开局域网，扫二维码就连上了。

- 手机端**不做第二套界面**，就是一个 WebView 壳，加载电脑上那份网页——所以电脑改了界面手机刷新即得，会话、记忆、模型全都共用。
- 配对码通过 cookie 下发（`xy_token`），页面自己发的请求自动带上，不用改页面代码。
- 同一个 Wi-Fi 能连；两边都装 Radmin / Tailscale 这类组网工具，出门用流量也能连。设置页会按网卡给出多张二维码。
- 手机也能**不连电脑**用：连接页有「不连电脑，手机上直接用」，填自己的接口地址和 Key 就能聊
  （只是不念记忆、另存一份对话记录）。详见 `notes/手机连接.md`。

## 自动更新

启动时会去 GitHub 查一次新版，运行中每 3 小时再查一次（凌晨 1–7 点顺延到 7 点）。设置里的「更新」那一栏能看当前版本，也能手动点「马上检查一次」。

发现新版会下载白名单里的文件（src public electron persona rules assets scripts 和几个根文件），**不碰** .env、.state、sandbox、node_modules、dist、dump。覆盖前会把旧文件备份到 .state/update-backup/<时间戳>/。

**更新装到哪**：不是往 app.asar 里写（那是只读的，写进去会报 ENOTDIR），而是写到 %APPDATA%\小鱼Agent\data\code\。启动时如果这个目录存在、并且里面有 package.json，就**优先从这儿加载代码**；没有才用 asar 里自带的。加载失败会自动退回自带版本，不会整个人打不开。

**想退回自带版本**：把 %APPDATA%\小鱼Agent\data\code 整个删掉，重启就是安装包里那版。

## 数据备份

【设置】→【数据备份】：一键把会话、会话记忆、人设、设置、模型配置打成一个 json 导出；也能导入回来（合并或覆盖）。
`.trash` 和 `*.bak` 不进备份，所以体积不大（五十来个会话大约 2 MB）。

升级、重装、换电脑都不用怕——安装版的数据在 `%APPDATA%\小鱼Agent\data\`，卸载也不会删。

## 会话导入 / 导出

会话存在 `.state/sessions/` 里，本来就是 JSON，但目录结构不适合直接给用户看。
「会话」面板多了三个按钮，走的是同一份数据的干净版本：

| 按钮 | 干什么 |
|---|---|
| 导入 | 选一个之前导出的 `.json`，把里面的会话加进来 |
| 导出这个 | 把**当前**会话存成一个文件 |
| 全部导出 | 把所有会话打成一个文件，当备份用 |

几点设计上的取舍：

- **导入永远新建会话**，每条都分配新 id，不会覆盖你现有的任何一个 —— 所以从备份里导回来
  是安全的，重复导也只是多出几份副本。一次只导进来一个会话时会自动切过去。
- **文件里没有 API Key，也没有人设卡**（除了历史里恰好存着当时的提示快照）。换台机器导入后
  还得在「模型」面板填自己的 key。
- 中文文件名走 `Content-Disposition` 的 `filename*`，不然 Windows 下载会存成乱码。
- 格式：单会话是 `{kind:"xiaoyu-agent.session", version:1, session:{...}}`，
  整包是 `{kind:"xiaoyu-agent.session.bundle", sessions:[...]}`；导入时也接受裸的会话对象，
  或者直接是一串消息数组。认不出来就明确报错，不会塞进半截数据。

> 会话文件里 user 和 assistant 都有。如果重进只剩自己说的话，多半是两种老毛病之一：
> 回退功能的临时数组没接回正式历史（0.7.3 已修），或者手机端页面自己发的请求没带配对码被 401 挡了（1.0.0 改用 cookie 已修）。

## 视频背景

照 [dsh-video-skin] 的思路做的：一段无声 mp4 用 `object-fit: cover` 铺满窗口，永远在最底下三层
（`video` → 黑色蒙版 → 暗色薄纱），所以不挡点击、不影响任何面板。面板和输入区跟着变半透明，
对话框保持实心好读字。

- 素材默认用 `assets/background.mp4`；想换自己的片子，把路径写进 `.state/skin.json` 的 `file`
  （相对路径按工作目录算），指哪放哪。
- 右下角 `◐` 是调节钮：面板暗度 / 蒙版两个滑杆，另有三档预设（原色 / 均衡 / 透明）。
- 想彻底关掉：【功能】→ 视频背景 → 停用，立刻撤掉，连视频都不再加载。
- **背景音乐**单独一档，在【设置】→【背景音乐】里：默认播 `assets/bg-music.m4a`（从壁纸短片里抽出来的音轨），
  能开能关、能调音量、能导入自己的本地音乐、一键恢复默认。浏览器不许自动出声，所以第一次要你点一下页面才开播。
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
src/sessions-core.mjs 会话落盘、导入导出（exportSession / exportAllSessions / parseImport / importSessions）
src/settings.mjs      底线 / 安全词
src/persona-store.mjs 人设卡读写
src/compress.mjs      上下文压缩
src/server.mjs        HTTP 服务 + 所有 API
src/pure.mjs          纯净模式：开关状态 + 精简提示词
src/mode.mjs          安全词档位：喊一句就切，喊「人设」回基线
src/opening.mjs       开场白：新建会话时垫一轮界面上看不见的对话
src/session-memory.mjs 会话记忆本子（每个会话一份 .md）
src/edit.mjs          改某一句对话，并同步到记忆本子
src/rewind.mjs        回退 / 撤销回退（只遮蔽，不删除）
src/turn-draft.mjs    草稿：边跑边落盘，进程被干掉也能捡回来
src/crash-guard.mjs   兜住未捕获异常，别让服务被一个错直接带走
src/backup.mjs        整包备份 / 恢复
src/mobile.mjs        手机配对：配对码、网卡地址、访问闸门
src/qrcode.mjs        零依赖二维码编码器（给手机扫）
src/rates.mjs         各厂商价目表（算每轮花多少钱）
src/session-log.mjs   下载日志：把一个会话打成 zip（记录 + 记忆 + 附件）
src/updater.mjs       自更新：查版本、后台每 3 小时查一次
src/zh-convert.mjs    繁简转换（可选依赖 opencc-js，缺了自动降级）
mobile/               手机端 Android 工程（WebView 壳 + 二维码扫描 + 本地模式）
scripts/publish.mjs   发布到 GitHub（脱敏 + 打包 + 推送）
scripts/release.mjs   发 GitHub Release 并传三件安装包
scripts/repack-installed-app.ps1  把源码同步进已安装版本的 app.asar
```

## 配置（.env）

| 变量 | 说明 | 默认 |
|---|---|---|
| `API_KEY` | LLM 的 API Key（也认 `WANZI_API_KEY`） | 空 |
| `BASE_URL` | OpenAI 兼容接口根地址 | `https://api.deepseek.com` |
| `MODEL` | 模型名 | `deepseek-flash` |
| `PORT` | 端口（桌面版也从 8787 开始试，被占了会依次试 8788/8789/8790，并记住上次那个） | `8787` |
| `WORKSPACE` | 工具能操作的工作目录（越界会被拒） | 项目里的 `sandbox/` |
| `MAX_ROUNDS` | 单轮工具调用上限，`unlimited` = 不限 | `unlimited` |
| `CONTEXT_LIMIT` | 历史涨到这么多 token 就把旧对话折成摘要，**填多少就压到多少**，`0` 或 `off` = 关 | `128000` |
| `CONTEXT_KEEP_TOKENS` | 压缩时至少保留尾部这么多 token（limit 很大时会按比例放宽） | `8000` |
| `CONTEXT_KEEP_RATIO` | 保留多少比例的尾部（一般不用改，默认跟 limit 的一半走） | `0.5` |

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
