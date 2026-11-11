# 插话（steer）后她的回复整段不上屏 —— steer-fixer 2026-11-11

## 主人报的形态
消息A → 她回复中 → 消息B（插话）→ 屏幕只剩「消息A / 消息B」，她后面说的
（含对消息A 的收尾）一行都不出现。真实会话「抽搐」smvz8jydm27z1：
[399][400] 两条 _steer 相邻，[401][404] 回复在数据里都在 → 纯渲染层丢。

## 复现（_tmp/probe-steer.mjs，隔离实例 + headless Edge + CDP 80ms 连拍）
改前实测（场1：正文 streaming 中插话）：
- +2.0s interject 200 → live 清单立刻有 `{k:'user', 插话1}`，屏幕正确出现插话气泡；
- +8.8s 主轮 done → **屏幕塌缩**：DOM 只剩 [开场白, 消息A]，插话气泡和她已说的正文全消失
  （isRunning=false → buildMerged 丢掉整个 live 段；turns 还是旧快照）；
- +8.8s→+13.2s 排队轮（服务端 setImmediate 起的补答轮）跑了 4.4 秒，
  live.items 里她的新回复一直在长，**前端一帧都没拉**；
- +13.2s settleFromHistory 的重试碰巧抓到历史齐了才恢复。

## 根因（一句话）
主轮 done 之后没有任何人跟播排队轮：SSE 死了（nudgeLive 靠 SSE 事件驱动）、
followLive 没挂（done 分支注释写着「跟直播 followLive」但代码从没挂过）、
scheduleSendingRecheck 只管灯和 busy、settleFromHistory 只拉历史不看 running。
排队轮跑工具/长回复时 settleFromHistory 的 6 次重试全部落空 → 永久丢显示，
直到刷新。server.mjs:3136 注释「前端靠 followLive / attachLive 补画」
指的就是这条从没人兑现的契约。

## 修法（全在 public/index.html，4 处）
1. **done 分支**（~9340）：done 后标 `turnRec.streamDone=true`，并在
   [250, 800, 1800]ms 短窗内盯 /api/chat/live —— 服务端还在跑（排队轮接上了）
   就 `attachLive(sid)`：快照进 store + followLive 逐拍画，答完由 finishTurn 收尾。
2. **endTurnQuietly**（~9180）：aborted/error 路径同样标 streamDone
   （看门狗 stuck-retry 的排队轮也靠它接）。
3. **scheduleSendingRecheck**（~8745）：still===true 且无人跟播且 streamDone
   → attachLive。每 2 秒查一遍，晚起的排队轮（起轮闸最多等 90 秒）也接得住。
   还在走 SSE 的轮（没标 streamDone）不挂，避免双份轮询。
4. **settleFromHistory**（~9620）：`_lv0.running===true` 时直接 return 不抢着收尾
   （原来它会等 4.2 秒后拿旧历史 + setLive(null) 把跟播画面盖掉）；
   收尾对账判据从「历史最后一条 assistant 长度 ≥ 直播正文总和」（多段轮恒不成立，
   每次收尾白等 4.2 秒）改成「直播最后一段正文能在历史正文里找到」→ 立即收尾。

## 配套：check-live-render-dom.mjs 的桩修正
桩的 /api/chat/live 在事件全部发完（不 holdOpen）后仍永远回 running:true，
与真服务端契约不符（真服务端 running 看轮登记，流关了登记就摘）。
按真契约改：holdOpen→true；事件没发完→true；发完→留 1.2s 收尾尾窗
（真服务端发完最后一段正文还要 flush/落盘几百毫秒才摘登记）→ false。
改完 38/0 全绿。

## 验证
- check-syntax 285 文件全过；check-live-items-parity 40/0；check-live-render-dom 38/0；
  check-live-history-split 9/0；check-ui 通过；build:ui；npm run sync（147 一致 1 写入）。
- 改后探针：排队轮期间出现 setLive(running:true) 帧（改前一帧都没有），
  finishTurn 正常按历史收尾，插话气泡 + 回复全程在屏。
- 改后第三跑发现相邻数据层问题（非本次改动引入）：模型首字延迟 ~11s 的退化窗口里，
  interject 被判「没在跑」走直推历史 + 前端重发 409 → 再 steer → 信箱第二份，
  服务端历史里插话出现两遍。数据层双写，需另开任务查 /api/interject 的
  wasRunning 判据与预发送队列的 409 重发路径。

## 已知残留（上报待协调）
- chat.js finishTurn 的收尾对账有同款「sum ≥ last」判据（chat.js:288-290），
  排队轮答完后的收尾仍会空等 ~4.2 秒再落历史。chat.js 不在我的允许清单里没动，
  建议同款修法（历史全部 assistant 正文拼接后 indexOf 最后一段直播正文）。
- 主轮 done → 排队轮接上之间还有 ~0.3-1s 的塌缩闪烁（running:false 快照被写入），
  彻底消除要动 buildMerged 的 isRunning 语义，风险大没做。
