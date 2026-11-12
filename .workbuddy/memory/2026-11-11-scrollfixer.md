# 2026-11-11 滚动弹回修复（scroll-fixer）

## 主人症状
1) 展开思考链后向上小幅滚动 → 视图立刻弹回最新消息
2) 向上小幅滚动时一来新消息 → 被强制跳回底部

## 根因（探针实测，不是猜）
`src-ui/LogView.jsx` 的 onScroll 里 `d <= 24` 就算「在底部」：
向上滚 20px 左右根本不算「在翻历史」，pin/effect 照样贴底。
两个症状同一根因（都是「小幅滚动」）。探针 `scripts/_t_scrollfix.mjs`
（隔离实例 + CDP 真 wheel 事件）改前复现：滚 20px + 追加内容 → 弹回底部。
滚 300px 的场景改前本来就守住 —— 「新消息弹回」只在小幅滚动里发生。

## 修法（src-ui/LogView.jsx，提交 07879c4）
- atBottom / userScrolled 复位阈值 24 → 8（只留物理贴底余量）
- userScrolledRef 复位改为「连续两次 scroll 都贴底」才清
- 高度变矮（收缩 clamp）夹出来的 scroll 一律不记账：
  `lastHeightRef` 检出 shrank 就跳过 atBottom/userScrolled/lastScrollTopRef 更新
- 没加 programmaticScrollRef：实测 pin/restore 自己触发的 scroll 更新的
  状态本来就是对的（B/B2/P3 全守住），加了反而可能吞掉真用户的滚动事件

## 回归
改后探针 8/0：A（20px）不弹回 / B（300px+新消息）/ B2（整屏重画）/
C（大幅收缩）守住；正向 P1 跟随贴底 / P2 F5 停半路最终贴底 /
P3 restore / P4 滚回恢复跟随全过。
check-ui ✔ / check-syntax 285 ✔ / parity 40/0 / render-dom 38/0。sync-live 已跑。

## 坑
- 探针若撞端口：默认 879x 段被其他隔离实例占，startIsolated 换段
  （探针用 8995/9323），connect 要传 match: iso.base。
- 转发 wheel 用 CDP `Input.dispatchMouseEvent {type:'mouseWheel'}`，
  合成 `new WheelEvent` 不产生真实滚动。
- C 场景想行为级区分「clamp 到底部」和「状态被偷」做不到（视觉一样），
  守住靠代码级防误清 + 中等收缩（无 clamp）断言位置不动。
