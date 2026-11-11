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
