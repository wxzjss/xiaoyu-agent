# UI 硬伤修补搬移记录（2026-11-10）

## 一句话

计划书 B 组（UI 硬伤）的改动**全部打在仓库根的 `index.html` 上**，而那个文件没有任何代码读它 —— 真正生效的是 `public/index.html`（打包后是 `%APPDATA%\小鱼Agent\data\public\index.html`）。所以那批改动一条都没上线。本篇记录逐条搬回来的过程。

## 为什么根 `index.html` 没人读

| 位置 | 事实 |
|---|---|
| `src/server.mjs:362` | `const PUBLIC = join(config.root, 'public')` |
| `src/server.mjs:363` | `const PUBLIC_OVERRIDE = config.packaged ? join(config.dataDir, 'public') : ''` |
| `src/server.mjs:3716` | `url.pathname === '/' ? 'index.html'` 交给 `readPublic(name)` |
| `package.json` `build.files` | 只收 `public/**/*`，根 `index.html` 不进包 |

结论：根 `index.html` 是历史遗留的旧版整页（20088 行 / 981KB，没有 React 日志前端），已经改造成一张「勿改」告示牌，原文件备份在 `.state/qa-logs/index.html.legacy-20261110.bak`。

## 搬了什么（都在 `public/index.html` 上重做）

| 编号 | 内容 | 做法 |
|---|---|---|
| B1 | `:root` 补 `--fg` / `--muted` / `--radius` | 直接追加 |
| B2 | dialog 打开时 toast 被盖住看不见 | CSS `dialog #xyToasts` 贴右下 + JS 里 toast 宿主跟着打开的 dialog 走 |
| B3 | 删身份还在用原生 `confirm()` | 换成 `await askConfirm({... danger:true})`，原生 confirm 归零 |
| B5 | 会话列表轮询每次全量读 | 前端带 `?rev=` 去问，服务端回 `{unchanged:true}` 就早退（后端 `src/server.mjs` 已支持） |
| B6 | 窗口 <1100px 时身份栏整列消失 | 改成收成 44px 圆圈，hover / focus 浮出展开 |
| B7 | 键盘 Tab 看不见焦点 | 全局 `:focus-visible` 兜底 + details/summary 处理 |
| B8 | 一坨只有注释的 `<style>` 死块 | 删掉 1576 字，留 4 行结论 |
| B9 | 跑动期间 header 高危按钮还能连点 | `syncSendBtn()` 里统一挂 `.busyLock`（CSS 压暗 + 不吃点击） |

## 没搬的（故意的）

- **`alert(...)` → `showToast(...)` 那二十来处**：`public/index.html:7507` 已经有 `window.alert = function (msg) { showToast(msg, { warn: true }); }` 全局劫持，原生框根本弹不出来。逐处改反而会丢掉 `warn` 红样式，所以保持原样。
- `var(--muted, #xxxxxx)` 的兜底色值统一成 `var(--muted)`：已做（10 处）。

## 验证

- `check-ui` / `check-ui-args` / `check-ui-destructuring` / `check-ui-modules` / `check-live-render-dom` / `check-log-no-manual-dom` / `check-gates-self` 全绿
- `check-live-sync` 3/3：改的和跑的是同一份
- 全量 `run-all-checks` 见 `.state/qa-logs/full3.log`

## 教训

改前端之前先确认改的是哪一份。判据只有一条：**`check-live-sync` 说一致的那份才算**。
