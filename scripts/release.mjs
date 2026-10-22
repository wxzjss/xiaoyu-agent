// 发布 GitHub Release 并上传两个 exe 附件
// 用法：node scripts/release.mjs
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'wxzjss/xiaoyu-agent';
const TAG = 'v0.7.1';
const NAME = '小鱼Agent v0.7.1';
const TOKEN_FILE = 'C:\\GitHub仓库\\ghp.txt';

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (!existsSync(TOKEN_FILE)) return null;
  const m = readFileSync(TOKEN_FILE, 'utf8').match(/gh[pousr]_[A-Za-z0-9]{20,}/);
  return m ? m[0] : null;
}

const BODY = `第一个能用的版本。

## 下载哪个
- **小鱼Agent-0.7.1-x64.exe** — 安装版，装完有开始菜单/桌面快捷方式，数据在 \`%APPDATA%\\xiaoyu-mini-agent\\data\`。
- **小鱼Agent-免安装版-0.7.1.exe** — 单文件免安装，双击就跑，数据在 exe 旁边的 \`data\\\`，整个文件夹能拷走。

第一次打开**没有任何模型**：点右上角【模型】→ 添加 → 填 OpenAI 兼容接口（地址、模型名、API Key）→ 测试连接 → 保存，就能聊了。

## 这一版有什么
- 聊天：流式输出、思考强度可调（关掉就真的不想）、上下文自动压缩（默认按 1M 算）
- 干活：读/写文件、看目录、跑 PowerShell、抓网页、任务清单、便签，每条都能在【功能】里单独停
- 会话：新建/切换/改名/删除，自动回到上次那个
- 附件：图片 + 文件，分栏目录浏览器（照 DeepSeek Harness 的手感做的）
- 视频背景：一段短片铺成聊天背景，右下角圆钮调暗度，默认开着
- 底线 + 安全词：写进设置就生效，说了安全词立刻停手
- 启动自检：第一次启动自己查一遍环境，修不了的留给 AI 回头处理
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
  const files = ['dist/installer/小鱼Agent-0.7.1-x64.exe', 'dist/installer/小鱼Agent-免安装版-0.7.1.exe'];
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
