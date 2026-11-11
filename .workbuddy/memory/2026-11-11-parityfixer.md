# 2026-11-11 · parity-fixer（排查工程师）

## ① check-live-items-parity.mjs：37 过 / 3 挂 → 40 过 / 0 挂

### 现象
三条失败，全都是「服务端增量（appendLiveItem）== 从头重算（buildLiveItems）」：
1. 第一组「边界形状：把长得像分段线的东西一次塞满」→ 增量 == 重算
2. `(b) 200 串（含 whale*/worker 突发）：服务端增量 == 从头重算`
3. `③ text→worker→text→worker→text → 服务端两份逐字相等`

三条的共同点：**事件里都有 `type:'worker'`**。（(a) 组没有 worker，一直绿。）

### 根因（精确到分支）
diff 原文（`#8 A=… B=…`）：

```
A = {"k":"worker","id":"1","name":"干活","status":"run","steps":[…],"note":"","startedAt":0,"endedAt":0}
B = {"k":"worker","id":"1","name":"干活","status":"run","steps":[…],"note":""}
```

- `src/server.mjs` `appendLiveItem()` 的 worker 分支（团队模式 854ed10 加的两个字段）：
  建卡时 `{ … note:'', startedAt: 0, endedAt: 0 }`，收尾时 `it.endedAt = Date.now()`。
- `src/server.mjs` `buildLiveItems()` 的 worker 分支**没跟上**：
  建卡时 `{ … note:'' }` —— 少了 `startedAt` / `endedAt` 两个键，也没有收尾赋值。

于是同一张 worker 卡，增量那份比重算那份多两个键 → `JSON.stringify` 不等 → parity 必红。
这不是测试口径问题，是**真 bug**：刷新页面（items 空 → 走 buildLiveItems）后
worker 卡会丢掉「跑了多久」，和直播时不是同一张卡。

### 还发现一处更深的：endedAt 用 Date.now() 天生不可重算
`if (ev.kind === 'end') it.endedAt = Date.now();` —— 就地取钟。
重算路径拿的是**事件数组**，没有「收尾那一刻」可问，就算补上字段也补不出同一个数。
修法：时间戳由**生产者在收尾时打进事件**，两条路径都只读事件。

### 改了什么
1. `src/server.mjs` · `appendLiveItem` worker 分支：
   `if (ev.kind === 'end') it.endedAt = Number(ev.endedAt) || 0;`（原来 `Date.now()`）。
2. `src/server.mjs` · `buildLiveItems` worker 分支：
   建卡补 `startedAt: 0, endedAt: 0`；补
   `if (e.startedAt && !it.startedAt) …` 和 `if (e.kind === 'end') it.endedAt = Number(e.endedAt) || 0;`
   —— 与增量侧逐字同口径。
3. `src/team.mjs` · `dispatchWorker` 的 `pushEv('end', …)` 带上 `endedAt: Date.now()`。
4. `src/tools.mjs` · 两处 worker `kind:'end'` 也带上 `endedAt: Date.now()`（同步派活的旧路径）。
5. 没碰 `public/index.html`、`src-ui/`、`/api/screen/off` 那段。

### 验证
- `node scripts/check-live-items-parity.mjs` → **40 过 / 0 挂**。
- 额外自测（临时脚本，已删）：start(带 startedAt) → step → mail → note → end(带 endedAt)
  这条真实团队模式序列，增量与重算的 worker 卡逐字相等，
  `startedAt=1700000000000`、`endedAt=1700000060000` 两侧都在。

### 结论
三条失败 = 一个根因：**buildLiveItems 的 worker 分支少两个字段、且 endedAt 取了不可重算的时钟**。
重算路径是刷新后主人看到的那份，所以按「补齐重算侧 + 时间戳进事件」修，不是改测试。

## ② check-no-spontaneous-dup.mjs：不是并发问题，是「三次尝试共用一间会话」

### 现象
单跑 → 「结果: 干净」（连跑 3 次尝试全绿）。全量 run-all 里挂，挂在**第 3 次尝试**。

### 证据（全量失败日志，%TEMP%/xy-runall-logs/50-check-no-spontaneous-dup.mjs.log）
```
第 3 次：取样 54 帧，✘ 出现重复（两个气泡开头一样（2 个）：QAT01END（把三个标记重新摆好）
违规 40 帧：· 第 1 轮 第 1823ms：两个气泡开头一样（2 个）：QAT01END（把三个标记重新摆好
第一次出现时：assistant 容器 4 个（其中直播 0 个）
那一刻屏幕上这些 assistant 容器：
  [历史] 218 字 小鱼QAT01END（把三个标记在心里排好队）三段、
  [历史] 184 字 小鱼QAT04END（把标记换了一茬，重新排好）三段
  [历史] 165 字 小鱼QAT01END（把三个标记重新摆好）还是三段、
  [历史] 172 字 小鱼QAT04END（这次把标记往后错了一位，重新排
屏幕上的次数 == 落盘次数（没有被重画多出来的）✔
```
- 4 个容器**全是 [历史]**、直播 0 个、token 次数与落盘一致 —— **没有任何东西被多画**。
- 那 4 条 = 前两次尝试留下的回答。第三次开始时它们就躺在屏幕上。

### 根因（测试口径，不是产品 bug）
脚本默认连跑 3 次（老 bug 是间歇性的，跑一次判绿会漏）。但三次**只 Page.navigate，
会话仍是服务端 lastSessionId 那一间** → 前几次的回答留在历史里。
模型的措辞高度一致（同一句提示词），第 3 次的回答前 40 字跟第 1 次几乎一字不差，
于是被「两个气泡开头一样 = 重画」这条判据判红。**那是两次不同的发言。**

为什么不是并发/端口：dup 用的是 `startIsolated()`（端口 pickFree 探测 + mkdtemp 独立数据目录），
run-all 是 `spawnSync` 串行；日志里隔离实例起在 8796（run-all 的父实例占 8795），
说明端口规避是生效的。失败点也不在起不来，而在断言。

### 改了什么（只改脚本，src 一个字没动）
`scripts/check-no-spontaneous-dup.mjs` · `runReal()`：
1. 页面就绪后抓一次**基线**：`#log .msg.assistant .bubble` 的全部正文（这次跑之前就有的历史）；
2. 判重时 `fresh = s.asst.filter(x => !baseline.has(norm(x.text)))`，
   「前 40 字相同」和「两条完全一样」两条判据都只在这个 fresh 集合上算。
3. 打了基线条数的日志行（实测：第 2 次排除 2 条、第 3 次排除 4 条 —— 正是原来判红的那些）。

本意没变：**这次跑的过程中**长出来的两个一样的泡泡照样红。
已知取舍：若「把上一轮的历史又画一遍」，新副本原文与基线相同 → 会被基线吃掉；
换成按 DOM 节点标记能覆盖，但 React 重挂会丢标记、反而退回原来的假红，所以按原文排除。

### 验证
- 单跑第一次：3 次尝试全 ✔，第 2/3 次打印「基线：已有 2 / 4 条历史气泡（判重时排除）」。
- 单跑第二次：结果: 干净。
- 没跑全量 run-all（会与其他人的检查抢机器，且他们正在改 public/index.html、
  未提交的关屏功能也在工作区）；按日志证据这次修的正是那 40 帧。

## 提交
`86e56aa fix: parity——buildLiveItems 的 worker 卡补齐耗时字段，endedAt 改为读事件`
（server.mjs 只提交了我的两个 hunk，用 `git apply --cached` 单独暂存；
别人未提交的 /api/screen/off、/api/enhance-prompt 原样留在工作区。）
