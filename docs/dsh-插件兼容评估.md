# dsh 插件兼容评估（2026-11-16）

> 主人原话：「还有就是让小鱼Agent兼容dsh插件，可以导入dsh插件」，
> 随后补了一句：「或者如果你觉得不值得就不做」。
>
> **结论：插件运行时不做兼容（不值得），dsh 的 skill 包已经能导入了。**

---

## 一、为什么不兼容 dsh 插件

dsh 的「插件」不是「一个工具定义」，是 **cordis IoC 插件**。看它自带插件的源码就很清楚
（`dump/dsh-src/` 共 47 个文件，是从 dsh 安装包里扒出来的）：

```js
// todo__lib_index.js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
const inject = ["tools", "sessionProjections"];
...
exec.agent.session.append("todo/write", { todos });
```

```js
// goal__lib_index.js
const events = agent.session.snapshotEvents();
const boundary = ctx.sessionProjections.stateOf(agent.session, "turnBoundary");
if (ctx.agents.currentInitiator() !== agent) reject("...");
```

也就是说，一个插件要跑起来，宿主必须提供：

| 宿主能力 | 用来干什么 | 小鱼有吗 |
|---|---|---|
| `session.snapshotEvents()` + event seq | 会话事件溯源，按 seq 切片看「这一轮发生了什么」 | ✗（小鱼是 `messages` 数组） |
| `sessionProjections.stateOf()` | 从事件流派生出状态（开轮边界等） | ✗ |
| `agents.get/roots/currentInitiator` | 谁是当前发起人、authority 校验 | ✗ |
| `exec.agent.session.append(type, data)` | 工具往会话里追加自定义事件 | ✗ |
| schemastery + zod 双 schema | 参数校验 | ✗（用 JSON Schema） |
| `presentCall()` 卡片协议 | 前端怎么渲染这次调用 | 部分（工具卡，协议不同） |

依赖也是硬的（`grep 'from "'` 统计）：

```
24  @deepseek-ai/dsh-tools        21  @deepseek-ai/schemastery
 8  @deepseek-ai/dsh-llm           6  @deepseek-ai/dsh-output-retention
 5  @deepseek-ai/dsh-timeout       4  @deepseek-ai/dsh-sandbox
 3  @deepseek-ai/dsh-fs            2  @deepseek-ai/dsh-session / shell / subagent
```

`@deepseek-ai/dsh-tools` 在 npm 上只有 `0.0.1-rc.1`，其余多半没公开发布；
就算装得上，缺的仍是**那套事件溯源运行时**。

而且主人实际装的第三方插件（`~/.dsh/profiles/desktop/package.json`）是这类东西：

```
dsh-context  dsh-orb  dsh-rewind-plugin  dsh-video-skin
dsh-whale-widget  dshmarket  @tencent-connect/dsh-qqbot  dsh-browser
```

它们除了工具，还带**前端挂载点**（皮肤、挂件）、**LLM provider**（dsh-commandcode-provider）、
**会话中间件**（rewind、migrate-on-429）—— 跨架构，不是"适配一层"能解决的。

**代价 vs 收益**：实现这套 ≈ 重写半个 dsh（周级工作量），换来的能力小鱼已有（见下表）。

---

## 二、能力对照：dsh 的 25 个内置插件 vs 小鱼 89 个工具

| dsh 插件 | 能力 | 小鱼对应 |
|---|---|---|
| tool-todo | 待办清单 | **plan**（更强：create/update/add/view/clear、钉死、留档、重复检测） |
| tool-bash / pwsh / terminal | 执行命令 / 常驻终端 | run_command、term_start/term_send/term_read/term_close |
| tool-fs / fs-search | 读写文件、搜索 | read_file/write_file/edit_file/list_dir/search_files/find_files |
| tool-str-replace-editor | 精确替换 | edit_file |
| tool-web | 联网检索 | web_search / fetch_url / fetch_many |
| tool-skill | 技能库 | use_skill（同一套 SKILL.md 机制） |
| tool-subagent / subagent-control | 派子 Agent | spawn_worker / spawn_workers / watch_worker / tell_worker / stop_worker |
| tool-schedule | 定时任务 | schedule_task / list_schedules / cancel_schedule |
| tool-goal | 目标 | goal_set |
| tool-ralph | 反复迭代 | ralph |
| tool-present | 产出物呈现 | make_pptx / make_docx / make_xlsx / look_screen |
| tool-session-query | 查历史会话 | trace_turns / folded_list / folded_read / chronicle_* |
| tool-jobs | 后台作业 | **已按主人要求删除**（后台一律改子 Agent） |
| tool-ask-user | 反问用户 | 无（桌面端她直接说话问，不需要弹表单） |
| tool-workflow | 编排 DSL | 无（plan + spawn_worker 覆盖） |
| tool-cordis | 插件自省 | 无（不跑 cordis，不需要） |
| tool-workspace-dependencies / working-directory | 工作区依赖 / 目录 | 无（config.root + 相对路径） |

**结论：唯一真缺的是 todo，而小鱼的 plan 比 dsh 的 todo_write 更细。**
（dsh 的 todo_write 是整表覆盖，`plan` 支持增量、钉死步骤不被压缩吃掉、历史留档。）

---

## 三、能兼容的那部分：skill 包（已实现）

dsh 生态里有一类资产是**纯文本**，拿来就能用：

| | 形态 | 字段 |
|---|---|---|
| dsh | `~/.dsh/<profile>/skills/active-scan.md`（单文件 + frontmatter） | `name` / `description` / **`whenToUse`** / `role` / `enabled` |
| 小鱼 | `<data>/skills/active-scan/SKILL.md`（目录 + SKILL.md） | `name` / `description` / **`when`** |

只差：一层目录 + 一个字段名。这就是 `src/dsh-skills.mjs` 干的事。

**本机实测量：4 个目录、75 条可导**（`~/.dsh/profiles/*/skills` 与 `~/.dsh/redteam/skills`）。

### 怎么用（三种）

**① 让她自己导**（推荐，最省事）：

> 「把 dsh 里的 redteam 技能导进来」
> 「先看看 dsh 有什么技能」

她会调 `import_dsh_skills`：`action:"scan"` 先列（只读），`action:"import"` 真导。
可以 `names:["active-scan","apk-reverse"]` 只导几条。

**② 手动拷**（不经过工具）：
把 `~/.dsh/xxx/skills/foo.md` 变成 `<data>/skills/foo/SKILL.md`，
frontmatter 里 `whenToUse:` 改成 `when:` 即可。

**③ 代码里调**：

```js
import { scanDshSkills, importDshSkills, summarizeImport } from './src/dsh-skills.mjs';
console.log(summarizeImport(importDshSkills({ names: ['active-scan'] })));
```

### 导入规矩（宁可少导，不许弄坏现有的）

- 已有同名技能 → **跳过，不覆盖**（那可能是主人改过的）
- dsh 里标 `enabled: false` → 跳过（人家自己关掉的）
- `INDEX.md` / `README.md` / `CONTRIBUTING.md` 这类说明文件 → 不当技能
- 正文原样保留，不改一个字
- 目标目录里技能超过 12 条 → 摘要里提醒（system 索引每条约 80 字，75 条全进会顶爆预算）

---

## 四、守住在哪

`scripts/check-dsh-skills.mjs`（21 条）：

- **结论钉住**：源码里出现 `@deepseek-ai/*` 或 cordis 就红 —— 逼着后来的人重新评估；
- **行为**：字段映射（whenToUse→when）、目录形态也认、INDEX.md 不算、
  enabled:false 跳过、幂等、不覆盖手改过的、dryRun 不落盘、摘要可读；
- **控制字符**：上次正则 `\b` 变成退格符（0x08）导致闸失效，现在源码里出现控制字符直接红。
