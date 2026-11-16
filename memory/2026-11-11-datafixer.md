
## 2026-11-11 data-fixer：插话防重闸 + user 消息时间戳

### 改动（全部在 src/server.mjs，commit 见 git log）
1. **插话防重闸**（/api/chat 主流程，userMsg 建好后、history.push 前，约 :9228）：
   - push 前倒扫尾部 6 条；判据：`同 content + 同 _who + 对方不是 _steer`，且这中间**没有不带 tool_calls 的 assistant**（带工具调用的中间过程不算"答过话"）。
   - 命中 → 不 push，`userMsgRef` 直接挂到旧那条上 → 后续 :10320 补 `_ws/_mem` 照常落在原对象上，不会再长出第二条。
   - 两个条件不能丢的原因：
     · 「中间没有 assistant 人话」——她答过了再发同句是**有意重发**，必须两条都落（S3 实测 2 条 ✓）；
     · 「同 _who」——群聊别的成员发同句不是重发，不能吞（S2 实测 2 条 ✓）。
   - 修复目标：watchdog 掐断（userMsg 已落盘但没补 _ws/_mem）+ 前端兜底重发（interject/resumeOrResend）→ 同句落盘两次（如 smvz2fosnib5k 的 [497]/[498]）。
2. **user 消息补时间戳**：userMsg 建的时候带 `at: Date.now()`；publicSession turns 的 ts 读取兜底 `_at`（`m.at` → `m._at` → 0）。历史数据文件没动，老消息照旧。

### 验证
- 新写 `_t_dedup_gate.mjs`（被 `_*.mjs` gitignore，不进库）用 `scripts/_test-instance.mjs` 隔离实例端到端：**18 过 / 0 挂**
  · S1 中断重发：stop 模拟 watchdog → 重发同句 → 盘上只 1 条，`_ws`/`_mem` 都补在原条上 ✓
  · S2 换身份（fish）发同句：两条都落、_who 不同 ✓
  · S3 她答过话后再发同句：两条都落 ✓
  · S4 新 user 气泡 turns.ts > 0、messages 带 at ✓
- 回归：check-syntax 281 全过；check-live-items-parity **40/0**；_t_agents2.mjs 失败 0。
- `git diff src/server.mjs` 自查：只动了 :618 turns ts、:9197 userMsg 加 at、:9228 防重闸三处。

### 备注
- saveUserMessage（:746）的防重判据（只看最后一条）**没有放宽**：它是群聊/外部入口，没有 _who 参数，放宽到尾部 12 条有吞真发言风险，按"拿不准别硬改"原则保留原样；主流程闸门已覆盖 /api/chat 这条重复来源。
- 没碰 src/sessions-core.mjs（队友正在改）。
