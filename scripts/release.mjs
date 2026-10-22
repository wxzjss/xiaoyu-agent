// 发布 GitHub Release 并上传两个 exe 附件
// 用法：node scripts/release.mjs
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'wxzjss/xiaoyu-agent';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TAG = 'v' + VERSION;
const NAME = '小鱼Agent v' + VERSION;
const TOKEN_FILE = 'C:\\GitHub仓库\\ghp.txt';

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (!existsSync(TOKEN_FILE)) return null;
  const m = readFileSync(TOKEN_FILE, 'utf8').match(/gh[pousr]_[A-Za-z0-9]{20,}/);
  return m ? m[0] : null;
}

const BODY = `这一版主要修「删除会话后输入框点不了」和「换什么模型都说自己是别的家的模型」两个问题。

## 下载哪个
- **小鱼Agent-${VERSION}-x64.exe** — 安装版，装完有开始菜单/桌面快捷方式，数据在 \`%APPDATA%\\xiaoyu-mini-agent\\data\`。
- **小鱼Agent-免安装版-${VERSION}.exe** — 单文件免安装，双击就跑，数据在 exe 旁边的 \`data\\\`，整个文件夹能拷走。

第一次打开**没有任何模型**：点右上角【模型】→ 添加 → 填 OpenAI 兼容接口（地址、模型名、API Key）→ 测试连接 → 保存，就能聊了。

## 这一版修了什么
- **删除弹窗不再卡死**：删会话 / 删人设 / 清空记录 / 删模型以前用的是系统自带确认框（Electron 里它会阻塞整个页面），点完确定或取消后输入框点不了，得最小化再恢复。现在全换成页面内的确认框，关掉焦点自动回到输入框。
- **应用名不再是 mini-agent**：原生弹窗、托盘、任务管理器里统一显示「小鱼Agent」。
- **安全词措辞重写**：原来的说明里有「允许越过所有底线」「不再思考其他事情」这类句子，模型读到会当成角色扮演诱导，反过来拒绝人设、并自称是别的家的模型。现在只描述「怎么说话」，不再带越狱味。
- **换模型下拉会跟着刷新**：在【模型】面板里新增/删除模型，左上角那个换模型下拉立刻同步。

## 一直有的功能
- 聊天：流式输出、思考强度可调（关掉就真的不想）、上下文自动压缩（默认按 1M 算）
- 干活：读/写文件、看目录、跑 PowerShell、抓网页、任务清单、便签，每条都能在【功能】里单独停
- 会话：新建/切换/改名/删除，自动回到上次那个
- 附件：图片 + 文件，分栏目录浏览器（照 DeepSeek Harness 的手感做的）
- 视频背景：一段短片铺成聊天背景，右下角圆钮调暗度，默认开着
- 底线 + 安全词：写进设置就生效，说了安全词立刻停手
`;

async function main() {
  const token = readToken();
  if (!token) throw new Error('找不到 GitHub token');
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
      body: JSON.stringify({ tag_name: TAG, name: NAME, body: BODY, draft: false, prerelease: false, target_commitish: 'main' }),
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
  ];
  const have = Array.isArray(rel.assets) ? rel.assets : [];

  for (const relPath of files) {
    const abs = join(process.cwd(), relPath);
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
