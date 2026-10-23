// 发布 GitHub Release 并上传附件（桌面 exe ×2 + 手机 APK）
// 用法：node scripts/release.mjs
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const REPO = 'wxzjss/xiaoyu-agent';
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
const TAG = 'v' + VERSION;
const NAME = '小鱼Agent v' + VERSION;

// token 从环境变量或本机的 ghp.txt 读，绝不写进仓库
function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  const cands = [
    join(homedir(), 'GitHub仓库', 'ghp.txt'),
    'C:\\GitHub仓库\\ghp.txt',
  ];
  for (const f of cands) {
    if (!existsSync(f)) continue;
    const m = readFileSync(f, 'utf8').match(/gh[pousr]_[A-Za-z0-9]{20,}/);
    if (m) return m[0];
  }
  return null;
}

const BODY = `这一版是「能带出门」的一版：手机能连上电脑跑了，还加了一键数据备份。

## 下载哪个

| 文件 | 是什么 |
|---|---|
| **小鱼Agent-${VERSION}-x64.exe** | 安装版。装完有开始菜单/桌面快捷方式，数据在 \`%APPDATA%\\小鱼Agent\\data\` |
| **小鱼Agent-免安装版-${VERSION}.exe** | 单文件免安装，双击就跑，数据在 exe 旁边的 \`data\\\`，整个文件夹能拷走 |
| **小鱼Agent-手机端-${VERSION}.apk** | 安卓手机用的壳（见下） |

第一次打开**没有任何模型**：点右上角【模型】→ 添加 → 填 OpenAI 兼容接口（地址、模型名、API Key）→ 测试连接 → 保存，就能聊了。
界面里预置了 20 家厂商的地址和常用模型名，选一下就行。

## 新功能：手机连电脑

电脑上【设置】→【手机连接】打开开关，会出二维码。

- **同一个 Wi-Fi**：手机扫码就连上，地址形如 \`http://192.168.x.x:8787\`
- **不在一个网**：两边都装组网工具（Radmin / Tailscale / ZeroTier 之类），加进同一个网络，扫「跨网络」那个码，用流量也能连

装好 APK 点【扫一下】对着码扫，或者手填地址 + 配对码。

手机端不是独立 App，它就是电脑上那个界面的另一个窗口 —— 所以**会话是同一份**，
电脑上聊到一半，拿起手机能接着聊。反过来也一样。

APK 也支持**不连电脑**的模式：填一个 API Key 直接在手机上聊，不共享电脑的会话。

> 手机端和电脑端要同一个版本才能配上对。电脑更新了，APK 也跟着换一下。

## 新功能：数据备份

【设置】最下面多了「数据备份」。

- **备份成文件** — 把会话、人设、模型配置（含 Key）、所有设置打成一个 json
- **从备份恢复** — 两种方式：只补缺的（安全，现有会话不动）/ 同名的覆盖

换电脑、重装、从安装版换免安装版，都用它。以前只能自己摸 \`%APPDATA%\` 里翻。

> 顺带说明：**卸载不会删数据**（安装包设了 \`deleteAppDataOnUninstall: false\`）。
> 覆盖安装、卸载重装，会话和人设都还在。只有换"安装版 ↔ 免安装版"会换目录。

## 新功能：每一句都能改

每条消息右边有个 ✎，点开就地改。

- 改了 **你说的话**：她看到的下一轮就是改过的内容
- 改了 **她说的话**：她之后照改过的版本继续往下接
- 如果这句话被写进了**会话记忆**，记忆也跟着改；改错了能「撤销上次修改」

## 会话记忆

每个会话有自己的本子，存在 \`.state/memory/<会话id>.md\`。

- 每轮自动往里记一条摘要，满 80 条自动归档
- 可以手动编辑，改错了有回退
- 删会话时记忆一起进回收站，不是直接删

## 开场白

新建会话时，她已经在那边等你了 —— 盘里真的垫了一轮对话，但界面上看不见。

**她本人也不知道那是垫的**：那两条在上下文里跟真实的对话长得一模一样，没有"隐藏""开场"之类的标记。
所以你问「你刚才说什么来着」，她会真的懵。

【功能】面板里点【改开场白】可以换成你自己写的内容，也能一键恢复默认。不想要就整个关掉。

## 其它

- 上下文压缩阈值统一成 **128000**，文案改成「填多少压多少，填0关闭」
- 安全词和底线支持「设为默认」，新会话自动带上你调过的那份
- 报错不再往她的气泡里塞（以前会看到 \`⚠ LLM HTTP 502...\` 混在她的话里），改成单独的提示条，不进历史
- 会话选择改成**按设备记**：以前手机和电脑共用一份"上次打开的会话"，互相覆盖，看起来像"我的话丢了"
- 切走再切回来不会中断正在生成的回复（以前会杀掉整页）

## 一直有的功能

- 聊天：流式输出、思考强度可调、上下文自动压缩
- 干活：读/写文件、看目录、跑 PowerShell、联网搜索 + 抓网页、任务清单、便签，每条都能在【功能】里单独停
- 会话：新建/切换/改名/删除/回退，自动回到上次那个
- 附件：图片 + 文件，分栏目录浏览器
- 视频背景：一段短片铺成聊天背景，右下角圆钮调暗度，默认开着
- 底线 + 安全词：写进设置就生效，说了安全词立刻停手
`;

/**
 * 按版本号临时覆盖发布说明。
 *
 * 为什么不把每一版都写进一个 if：以前的说明留在文件里也是一份「变更记录」，
 * 真要翻旧账能直接看 git 历史，不必让这个脚本越写越长。
 * 查得到就返回 null，走上面那份通用的。
 */
function changelogFor(v) {
  if (v === '0.9.0') {
    return `这一版加了**背景音乐**，还有一堆看不见的稳定性修补。

## 下载哪个

| 文件 | 是什么 |
|---|---|
| **XiaoyuAgent-${v}-Setup-x64.exe** | 安装版。装完有开始菜单/桌面快捷方式，数据在 \`%APPDATA%\\小鱼Agent\\data\` |
| **XiaoyuAgent-${v}-Portable.exe** | 单文件免安装，双击就跑，数据在 exe 旁边的 \`data\\\` |
| **XiaoyuAgent-${v}-Mobile.apk** | 安卓手机壳 |

第一次打开没有模型：右上角【模型】→ 添加 → 选厂商（预置 20 家）→ 填 Key → 测试 → 保存。

## 新功能：背景音乐

【设置】→【背景音乐】。

- **默认放的就是你桌面壁纸那首** —— 从 Wallpaper Engine 那个壁纸的 mp4 里把音轨抽出来的，
  长短、音质都照原样（2 分 05 秒，AAC 48kHz 立体声）
- **导入本地音乐**：mp3 / m4a / wav / ogg / flac 都行，会拷进 \`.state/bg-music/\`
- **恢复默认**：一键换回壁纸那首
- 音量滑杆，右下角那个调背景的小圆钮里也能拖
- 浏览器规定页面得先被点一下才许出声，所以是「点一下界面就开始放」，不会一打开就轰一声

手机端（不连电脑的模式）也有【外观】按钮，能开关音乐、调音量、选手机里的歌。
连电脑的那个模式本来就是电脑端的界面，背景音乐跟着电脑走。

## 稳定性：三个「她突然没了」的真凶

1. **没有任何进程兜底** —— 整个项目之前连 \`uncaughtException\` / \`unhandledRejection\` 都没挂。
   Node 15 以后，一个没人接的 Promise 拒绝就能直接把进程杀掉。现在单次异常记进
   \`.state/crash.log\` 然后继续跑，同类错误 60 秒内连犯 5 次才退，且退出前先把草稿落盘。
2. **一轮回复只在整轮跑完才存盘** —— 中途被杀，整轮一个字都不剩。实测真出过：
   一个任务跑了两小时、107 次工具调用，崩了之后那轮全没了。
   现在每 1.5 秒写一次草稿到 \`.state/drafts/\`，下次打开会话自动接回来，
   末尾标一句「（说到这儿断了一下——当时程序被关了，这段话是接回来的。）」
3. **手机壳按返回键就把网页销毁了** —— 电脑还在跑，手机这边 fetch 流已经断了，
   看着像「一切换就中断」。现在改成把网页"停"起来而不是销毁，回去接着用。

## 修：视频/音频附件重进后只剩一个纸片

以前别人（或你自己）发的视频，重进会话只显示一个 📄 图标，点了没反应。
现在直接用播放器 + 一行「🎬 文件名 · 5.9 MB · 下载」，跟「发文件」那套卡片长得一样。

## 其它

- 「清空当前」改成「删掉这个会话再新开一个」——跟真的删了再建完全等价
- 会话面板加【批量删除】，可以全选
- 纯净模式加了答复长度约束：能一句话就一句话，不再比人设模式还啰嗦
  （实测同一句话：关了 1695 字，开了 191 字）
- 版本检查从自检节流里拆出来了，以前 SELFCHECK_VERSION 没变就永远不查更新
- 发文件：同一轮分几次发不会被后一批冲掉前一批；发过什么也会记进会话记忆

## 一直有的功能

- 聊天：流式输出、思考强度可调、上下文自动压缩、每轮显示花了多少 token 和多少钱
- 干活：读/写文件、看目录、跑 PowerShell、联网搜索 + 抓网页、任务清单、便签、发文件
- 会话：新建/切换/改名/删除/回退/分支，每句可编辑，每个会话有独立记忆本子
- 手机：扫码连电脑，或干脆不连、自己填 Key 当独立客户端
- 数据备份：一个 json 打包所有东西，换电脑/重装都能一次搬完
`;
  }
  return null;
}


async function main() {
  const token = readToken();
  if (!token) throw new Error('找不到 GitHub token（环境变量 GITHUB_TOKEN 或 GitHub仓库/ghp.txt）');
  const headers = { Authorization: `token ${token}`, 'User-Agent': 'xiaoyu-release', Accept: 'application/vnd.github+json' };

  // 1) 已有同名 release 就复用，方便重跑
  let rel = null;
  const listRes = await fetch(`https://api.github.com/repos/${REPO}/releases`, { headers });
  const list = await listRes.json();
  if (Array.isArray(list)) rel = list.find((r) => r.tag_name === TAG) || null;

  if (!rel) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ tag_name: TAG, name: NAME, body: changelogFor(VERSION) || BODY, draft: false, prerelease: false, target_commitish: 'main' }),
    });
    rel = await res.json();
    if (!rel.id) throw new Error('创建 release 失败：' + JSON.stringify(rel).slice(0, 400));
    console.log('created release ' + rel.tag_name + ' id=' + rel.id);
  } else {
    console.log('reuse release ' + rel.tag_name + ' id=' + rel.id);
  }

  // 2) 上传附件（同名先删）
  const files = [
    `dist/installer/小鱼Agent-${VERSION}-x64.exe`,
    `dist/installer/小鱼Agent-免安装版-${VERSION}.exe`,
    `dist/installer/小鱼Agent-手机端-${VERSION}.apk`,
  ];
  const have = Array.isArray(rel.assets) ? rel.assets : [];

  for (const relPath of files) {
    const abs = join(ROOT, relPath);
    if (!existsSync(abs)) {
      console.error('missing ' + relPath);
      continue;
    }
    const base = abs.split(/[\\/]/).pop();

    const dup = have.find((a) => a.name === base);
    if (dup) {
      await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${dup.id}`, { method: 'DELETE', headers });
      console.log('deleted old asset ' + base);
    }

    const size = statSync(abs).size;
    console.log(`uploading ${base} (${(size / 1048576).toFixed(1)} MB)…`);
    const res = await fetch(
      `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(base)}`,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
        body: createReadStream(abs),
        duplex: 'half',
      },
    );
    const out = await res.json();
    if (out.state === 'uploaded') console.log('  ✓ ' + out.browser_download_url);
    else console.error('  ✗ ' + JSON.stringify(out).slice(0, 300));
  }

  console.log('done: https://github.com/' + REPO + '/releases/tag/' + TAG);
}

main().catch((e) => {
  console.error('FAILED: ' + (e && e.message));
  process.exit(1);
});
