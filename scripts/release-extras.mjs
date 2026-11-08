// 补传 electron-updater 那一套：blockmap + latest.yml
// 历史每个 release 都有，保持一样，别让自动更新那套觉得这版是缺的。
import { readFileSync, createReadStream, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const REPO = 'wxzjss/xiaoyu-agent';
const VERSION = JSON.parse(readFileSync('package.json', 'utf8')).version;
const TAG = 'v' + VERSION;
const TOKEN_FILE = 'C:\\GitHub仓库\\ghp.txt';

const raw = existsSync(TOKEN_FILE) ? readFileSync(TOKEN_FILE, 'utf8') : '';
const token = (process.env.GITHUB_TOKEN || (raw.match(/gh[pousr]_[A-Za-z0-9]{20,}/) || [])[0] || '').trim();
if (!token) throw new Error('no token');

const H = { Authorization: `token ${token}`, 'User-Agent': 'xiaoyu-release', Accept: 'application/vnd.github+json' };

// 找 release
const rr = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H });
const rel = await rr.json();
if (!rel.id) throw new Error('release not found');

const setup = `dist/installer/小鱼Agent-${VERSION}-x64.exe`;
const setupAscii = `xiaoyu-agent-setup-${VERSION}-x64.exe`;

// latest.yml：url 必须跟 release 上实际那个 ASCII 名字对得上，否则下载 404
const buf = readFileSync(setup);
const sha512 = createHash('sha512').update(buf).digest('base64');
const size = statSync(setup).size;
const yml = `version: ${VERSION}
files:
  - url: ${setupAscii}
    sha512: ${sha512}
    size: ${size}
path: ${setupAscii}
sha512: ${sha512}
releaseDate: '${new Date().toISOString()}'
`;
writeFileSync('dist/installer/latest.yml', yml, 'utf8');
console.log('latest.yml 已生成');

const plan = [
  { file: 'dist/installer/latest.yml', name: 'latest.yml', label: '自动更新清单' },
  { file: `dist/installer/小鱼Agent-${VERSION}-x64.exe.blockmap`, name: `${setupAscii}.blockmap`, label: '差量更新块索引' },
];

for (const p of plan) {
  if (!existsSync(p.file)) { console.log('skip missing ' + p.file); continue; }
  const st = statSync(p.file);
  console.log(`uploading ${p.name} (${(st.size / 1024).toFixed(0)} KB)…`);
  const up = await fetch(
    `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(p.name)}&label=${encodeURIComponent(p.label)}`,
    {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(st.size) },
      body: createReadStream(p.file),
      duplex: 'half',
    },
  );
  const out = await up.json();
  if (out.state === 'uploaded') console.log('  ✓ ' + out.name);
  else console.error('  ✗ ' + JSON.stringify(out).slice(0, 300));
}