#!/usr/bin/env node
/**
 * upload-0.9.50.mjs — 把 0.9.50 的安装包 + 源码包传到 GitHub Release。
 *
 * 中文文件名在 uploads.github.com 会被吞，所以上传用 ASCII 名、label 带中文
 * （跟 scripts/release-assets.mjs 一个套路，那个脚本的产物名对不上，另写一份）。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { basename } from 'node:path';

const REPO = 'wxzjss/xiaoyu-agent';
const VERSION = '0.9.50';
const TAG = 'v' + VERSION;

const raw = existsSync('C:\\GitHub仓库\\ghp.txt') ? readFileSync('C:\\GitHub仓库\\ghp.txt', 'utf8') : '';
const token = (process.env.GITHUB_TOKEN || (raw.match(/gh[pousr]_[A-Za-z0-9]{20,}/) || [])[0] || '').trim();
if (!token) throw new Error('no token');

const H = {
  Authorization: `token ${token}`,
  'User-Agent': 'xiaoyu-release',
  Accept: 'application/vnd.github+json',
};

const plan = [
  {
    file: `dist/installer/XiaoyuAgent-${VERSION}-Setup-x64.exe`,
    name: `xiaoyu-agent-setup-${VERSION}-x64.exe`,
    label: `小鱼Agent 安装版 ${VERSION} (x64)`,
  },
  {
    file: `dist/installer/XiaoyuAgent-${VERSION}-Portable.exe`,
    name: `xiaoyu-agent-portable-${VERSION}.exe`,
    label: `小鱼Agent 免安装版 ${VERSION} (单文件)`,
  },
  {
    file: `dist/installer/xiaoyu-agent-${VERSION}-src.zip`,
    name: `xiaoyu-agent-src-${VERSION}.zip`,
    label: `小鱼Agent 源码 ${VERSION}`,
  },
];

// 1) 找到 release
const relRes = await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H });
if (!relRes.ok) throw new Error('release 查不到：' + relRes.status);
const rel = await relRes.json();
console.log('release id=' + rel.id + ' tag=' + rel.tag_name);

const existing = new Set((rel.assets || []).map((a) => a.name));

for (const p of plan) {
  if (!existsSync(p.file)) {
    console.log('✗ 缺文件：' + p.file);
    continue;
  }
  if (existing.has(p.name)) {
    console.log('· 已存在，跳过：' + p.name);
    continue;
  }
  const buf = readFileSync(p.file);
  const url = `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(p.name)}&label=${encodeURIComponent(p.label)}`;
  const up = await fetch(url, {
    method: 'POST',
    headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) },
    body: buf,
  });
  const j = await up.json().catch(() => ({}));
  console.log((up.ok ? '✓ ' : '✗ ') + p.label + '  ' + (up.ok ? Math.round((j.size || 0) / 1048576) + 'MB' : up.status + ' ' + (j.message || '')));
}

// 2) 收尾：列一下最终附件
const fin = await (await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H })).json();
console.log('\n最终附件：');
for (const a of fin.assets || []) console.log('  · ' + a.name + '  ' + Math.round(a.size / 1048576) + 'MB  ' + a.label);
console.log('\nRelease 页：' + fin.html_url);
