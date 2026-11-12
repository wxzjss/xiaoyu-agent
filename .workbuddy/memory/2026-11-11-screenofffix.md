# 2026-11-11 关屏解除键改造（screenoff-fix）

## 主人要求
功能页「关闭显示屏」的解除按钮只保留 Esc 与右键，相关描述同步改。

## 改动（提交 88924c6）
- `scripts/screen-off.ps1`
  - :44 `$ExitKeys` 默认值 `@(0x1B,0x2C,0x2E,0x2D,0x24,0x23,0x21,0x22,0x90)` → `@(0x1B)`（只留 Esc）
  - :517 预启动文案 →「这期间按 Esc 或右键可取消」
  - :594 等待解除日志 →「等待解除（Esc / 鼠标右键；锁屏时遮罩自动让开）」
  - :13-18 头部注释 lead 已改（PrtSc/Delete/Insert/Home/End/PgUp/PgDn/NumLock 移除，仍可用 -ExitKeys 传回）
  - :316-329 键名映射、:404-420 SelfTest/DetectKey 探针保留不动
- `src/features.mjs:372` screenOff desc →「恢复：按 Esc 或鼠标右键；锁屏/刷指纹时遮罩自动让开。」
- `src/tools-screen.mjs:191/213/217` 注释与返回文案同步（去掉 PrtSc/Delete/指纹列举）
- `public/index.html:15362` toast →「恢复：鼠标右键 / Esc」（精确 Edit，未碰他人块）

## 验证
- SelfTest 通过；PSParser 语法 OK；node --check + check-syntax.mjs 284 文件全过
- 真机实测（主人本人在场实测）：
  - 18:39:45 黑屏中右键解除，亮度还原 70%
  - 18:40:13 黑屏 → 18:40:21「解除方式: Esc」，亮度还原 70%
  - 日志文件 scripts/logs/monitor_off_2026-11-11.log 可查
- PrtSc「不解除」未能主动注入验证：沙箱拦截 Add-Type/Reflection/COM/cscript 等全部按键合成通道；
  结构上 ExitKeys 只剩 0x1B，键扫描只遍历 ExitKeys，右键与锁屏兜底是独立路径，PrtSc 无触发面

## 坑：git index 并发互吞（第二次踩）
- `git commit -- <pathspec>` 提交的是**工作区**内容，会把队友/他人工作区改动（defaultOn）一起带上——
  即使 `git diff --cached` 显示暂存区干净。多提交务必用纯 `git commit`（只认 index）。
- 重放期间队友又插了新提交（8387a27），软重置把它摘下后用暂存区内容原样重放（76b003a），
  message 用 `git log <hash> --format=%B` + `git commit -F` 保真。
- features.mjs 的 defaultOn（team 默认开，主人待确认）按 lead 要求留在工作区未提交。

## 提交
- 88924c6：关屏解除键只留 Esc 与右键（我的 4 文件）
- 76b003a：队友 xiaoyu-color 的署名色修复原样重放

## 加码验证（lead 二次要求）
- 按键注入全被沙箱拦 → 改用插桩副本 scripts/screen-off-test.ps1（未提交，用完删）：
  两个轮询循环加「负向探针」，8 个被移除键+左键+空格+Esc+右键按下只记日志不解除
- 真机实按证据（日志 monitor_off_2026-11-11.log）：
  - 黑屏中右键×15「未解除」（测试轮禁用）+ Esc「未解除」(-ExitKeys 0x14 轮 18:55:42)
    + Delete「未解除」(18:56:41) + 左键×3「未解除」(18:57:03 等)
  - 正向：Esc 解除 18:40:21、右键解除 18:39:45/18:53:46（真机三次）
  - 倒计时阶段左键×2 未取消 (18:59:41/43)；Esc 取消未获实按
  - -ExitKeys 参数回归：自定义 0x14 后 Esc 不解除（对比默认轮 Esc 解除）→ 参数生效；
    CapsLock 正向解除待主人实按
  - 95 秒超时自动恢复 ✓ (19:01:25)
- 坑：PowerShell 工具后台任务有 **120 秒硬上限**，到点强杀进程且不走还原路径
  （第 2 轮被杀，屏幕暗了 1 分钟，靠 -Restore 救回）。长跑要么 -TimeoutSec <115，
  要么分段跑。
- 剩余 PrtSc/Insert/Home/End/PgUp/PgDn/NumLock/空格 走结构级证明：
  两个循环的全部退出条件只有 4 类（ExitKeys 扫描/右键 0x02/锁屏+指纹/超时），
  这些 VK 码全文只出现在 VkName 键名映射里；鼠标移动无光标判定，天然不解除。
- 文案全扫干净：ps1/features.mjs/tools-screen.mjs/index.html/src-ui 无 PrtSc/Delete
  解除方式残留；index.html:20506-20509 注释写的正是「解除键保持 Esc / 右键不变」。
