# 2026-11-11 xiaoyu-color · 小鲸排前时小鱼插话署名白色 → 已修

## 主人报的错
【屋里的人】里把小鲸放在小鱼前面，小鲸署名蓝色没问题，但小鱼的消息颜色是白色。

## 根因（两条渲染路径的差）
- 小鱼当主声：走 AssistantBubble，`who !== '小鱼'` 不调 mateColorOf，署名色来自
  CSS `.assistant .role { color: #f0a6a0 }`（public/index.html:354）→ 永远不白。
- 小鲸排第一、小鱼变成并排说话者：插话消息落盘带 `_whaleSide:true` + `_whale:'小鱼'`
  → server.mjs turns 输出标成 `whale:'小鱼'`（server.mjs:655 的判据：只有
  `_whaleSide===true` 才算插话；单纯 `_whale` 但没有 `_whaleSide` 是主声）→
  前端 items.js kind:'say' → MateBubble → `mateColorOf('小鱼')` 内置表没有她
  → 退回 MATE_DEFAULT_COLOR #e6e6e6 白。
  CSS 端：`.msg.mate .role { color: var(--whoC, #e6e6e6) }`（public/index.html:402）。

## 改动（commit 8387a27）
1. `src/agents.mjs:344` listAgents 内置小鱼行 `color:'' → '#f0a6a0'`。
   AssistantBubble 的 `who !== '小鱼'` 排除**没动**（主声场景主人没抱怨）。
2. `src-ui/bridge.js:84` BUILTIN_MATE_COLORS 加 `'小鱼': '#f0a6a0'`（首帧就有色不闪）。
3. `scripts/check-whale-color.mjs` 探针补「小鱼并排说话者」断言：
   - 合成会话加一条 `{ _whaleSide:true, _whale:'小鱼', _who:'小鱼' }` 的插话消息
     （真实落盘形态；只给 `_who` 的话走 assistant 分支，复现不了 bug）；
   - 断言 `.msg.mate` 小鱼署名 computed color = `rgb(240, 166, 160)`
     （#f0a6a0 的正确换算；任务描述里的 rgb(240,166,166) 是笔误，0xa0=160），
     且不落 rgb(230,230,230)；小鲸蓝色断言原样保留。

## 实测（全部真跑，隔离实例 8795/8797，不碰主人数据）
- `node --check src/agents.mjs` / `npm run build:ui` / `node scripts/check-ui.mjs` 全过。
- `node scripts/check-whale-color.mjs`：16 过 / 0 挂。
  关键行：`msg mate mateSelf | 小鱼 | rgb(240, 166, 160) | --whoC=#f0a6a0`；
  小鲸 `msg assistant | rgb(91,155,213)` 不变；断网无缓存首拍也不白。
- 隔离实例 `/api/agents`：小鱼 #f0a6a0 / 小鲸 #5b9bd5 / 小白曦 #e6e6e6 / 旁白 #c8a8e8。
- 8788 在跑的实例还是旧代码（小鱼仍返回 `""`），**要重启小鱼Agent 才生效**
  （sync-live 已把文件同步到 live 数据目录）。

## 连带影响排查结论（都成立，没改）
- bridge.js primeMateColors「变没变」判据：服务端 #f0a6a0 与内置值相等 → 不 bump；
  若主人以后改她的色，服务端返回新值 ≠ 内置 → 正常 bump。旧 localStorage 缓存
  不可能存小鱼=#e6e6e6（旧服务端 color:'' 被 `if(!a.color) continue` 跳过）。
- MateBubble.jsx:50 `color && color !== '#e6e6e6'` → #f0a6a0 正常设 --whoC。
- `window.mateColorOf` 兜底（运行时外壳）只在 map 查不到时才走，小鱼现在 map 必命中。
- 备忘（没改，非本次问题）：listAgents 小鲸行用 `resolveBuiltinColor` 尊重主人改色，
  小鱼行是硬编码 —— 而 `/api/agents/color` 接口（server.mjs:6542）允许改任意 id
  （不过目前前端无调用方）。若以后面板开放改小鱼的颜色，这里要换成
  `resolveBuiltinColor(AGENT_XIAOYU) || '#f0a6a0'`，否则会打架。

## 加码验证（主人要求多查，第二轮，探针加码 commit 9ec7f91）
1. **反向场景**（一次性探针 scripts/_tmp-multisession-color.mjs，跑完已删，
   16 过 / 0 挂）：
   - 会话 A（小鱼主声+小鲸/小白曦/旁白插话，7 条气泡）逐条实测：
     * A2/A4 主声小鱼：`msg assistant | 小鱼 | rgb(240,166,160) | inline=空 |
       --whoC=空 | whoName=无` —— computed 与 #f0a6a0 同值但**机制未变**
       （CSS `.assistant .role` 正文色，没走 mateColorOf 途径；改动前后同值）。
     * A3 小鲸 MateBubble 插话：`msg whale whaleSelf | rgb(122,168,232)
       | --whoC=#5b9bd5`（CSS .whale .role #7aa8e8）—— 蓝不变。
     * A5 小白曦 rgb(230,230,230) 原样白；A6 旁白 rgb(200,168,232) 原样紫。
   - 会话 B（小鲸排前+小鱼插话，6 条）：
     * 小鲸主声 assistant 路径 rgb(91,155,213)（inline 直设 #5b9bd5）不变。
     * 小鱼插话 MateBubble rgb(240,166,160)，不再白。两路径互不干扰。
2. **多会话**：上面 A/B 两个会话 = 多会话覆盖。踩坑记录：外壳根本不解析 `?s=`
   URL 参数（探针原来能跑只因实例里只有一个会话+兜底取最近）；boot 取会话顺序是
   localStorage('mini-agent.sessionId') → 服务端 lastSessionId → 列表第一个
   （public/index.html:18260）；且 connect 后必须先等首屏 boot 完成再 setItem，
   否则 boot 落盘的「最近会话」会竞态覆盖。
3. **冷启动**：check-whale-color.mjs 三补小鱼断言（首拍/缓存态/全新机器态），
   22 过 / 0 挂。断网无缓存时小鱼首拍即 rgb(240,166,160)（内置表兜底）。
4. **既有检查全跑**（全部 exit 0）：
   - check-whale-color.mjs：22 过 / 0 挂
   - check-log-react.mjs：70 通过 / 0 失败
   - check-log-no-manual-dom.mjs：32 过 / 0 挂
   - check-msg-actions.mjs：27 过 / 0 挂
   - check-identifiers.mjs：104 个文件无未定义标识符
   - check-frontend-refs.mjs：1 段 15842 行 / 25 个 __ 名字，无「用了未声明」

## 铁律执行
没碰 features.mjs（主人待确认项）、screen-off.ps1、tools-screen.mjs、public/index.html
（screenoff-fix 队友的）；提交用显式路径，没用 git add -A。
