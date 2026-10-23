// 重新上传附件：中文文件名在 uploads.github.com 被吞掉，改用 ASCII 名 + label 显示中文
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';

const REPO = 'wxzjss/xiaoyu-agent';
const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const TAG = 'v' + VERSION;
const TOKEN_FILE = 'C:\\GitHub仓库\\ghp.txt';

const raw = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8') : '';
const token = (process.env.GITHUB_TOKEN || (raw.match(/gh[pousr]_[A-Za-z0-9]{20,}/) || [])[0] || '').trim();
if (!token) throw new Error('no token');

const H = { Authorization: `token ${token}`, 'User-Agent': 'xiaoyu-release', Accept: 'application/vnd.github+json' };

const plan = [
  {
    file: `dist/installer/小鱼Agent-${VERSION}-x64.exe`,
    name: `xiaoyu-agent-setup-${VERSION}-x64.exe`,
    label: `小鱼Agent 安装版 ${VERSION} (x64)`,
  },
  {
    file: `dist/installer/小鱼Agent-免安装版-${VERSION}.exe`,
    name: `xiaoyu-agent-portable-${VERSION}.exe`,
    label: `小鱼Agent 免安装版 ${VERSION} (单文件)`,
  },
];

const r = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H });
const rel = await r.json();
if (!rel.id) throw new Error('release not found');

// 删掉之前那批名字被吞坏的附件
for (const a of rel.assets || []) {
  await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE', headers: H });
  console.log('deleted ' + a.name);
}

for (const p of plan) {
  const abs = join(process.cwd(), p.file);
  if (!existsSync(abs)) {
    console.error('missing ' + p.file);
    continue;
  }
  const size = statSync(abs).size;
  console.log(`uploading ${p.name} (${(size / 1048576).toFixed(1)} MB)…`);
  const up = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(p.name)}&label=${encodeURIComponent(p.label)}`,
    {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body: createReadStream(abs),
      duplex: 'half',
    },
  );
  const out = await up.json();
  if (out.state === 'uploaded') console.log('  ✓ ' + out.browser_download_url);
  else console.error('  ✗ ' + JSON.stringify(out).slice(0, 300));
}

console.log('done: https://github.com/' + REPO + '/releases/tag/' + TAG);
