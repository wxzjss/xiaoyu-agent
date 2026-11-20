// 重新上传附件：中文文件名在 uploads.github.com 被吞掉，改用 ASCII 名 + label 显示中文
import { readFileSync, existsSync, createReadStream, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

const files = plan.map((p) => {
  const abs = fileURLToPath(new URL('../' + p.file, import.meta.url));
  const info = statSync(abs);
  if (!info.isFile() || !info.size) throw new Error('Invalid attachment: ' + p.file);
  return { ...p, abs, size: info.size };
});
const response = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H });
if (!response.ok) throw new Error('Release lookup failed HTTP ' + response.status);
const rel = await response.json();
if (!rel.id || rel.draft !== true || rel.tag_name !== TAG || !Array.isArray(rel.assets)) {
  throw new Error('Expected a draft release for ' + TAG);
}
if (files.some((p) => rel.assets.some((a) => a.name === p.name))) {
  throw new Error('Release already has a planned attachment; use a new version');
}

for (const p of files) {
  const { abs, size } = p;
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
  if (!up.ok || out.state !== 'uploaded' || out.size !== size) {
    throw new Error(`Attachment upload failed validation: ${p.name} (HTTP ${up.status})`);
  }
  console.log('  ✓ ' + out.browser_download_url);
}

console.log('done: https://github.com/' + REPO + '/releases/tag/' + TAG);
