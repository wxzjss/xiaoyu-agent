#!/usr/bin/env node
/**
 * upload-one.mjs — 单个附件上传（流式，带重试）。
 *
 * 【为什么另写一份】
 * upload-0.9.50.mjs 用 readFileSync 把 99MB 整个读进内存再 fetch body，
 * 实测在上传第二个大文件时 ECONNRESET（连接被重置）。
 * 这里改成**流式** body（createReadStream），内存占用恒定，
 * 并带 3 次重试（每次先删掉残留的半截附件）。
 *
 * 用法：node scripts/upload-one.mjs 本地文件> 附件ASCII名> [显示label]
 */
import { createReadStream, statSync, existsSync, readFileSync } from 'node:fs';

const REPO = 'wxzjss/xiaoyu-agent';
const TAG = 'v0.9.50';

const [file, name, label] = process.argv.slice(2);
if (!file || !name) {
  console.error('用法：node scripts/upload-one.mjs 文件> 附件名> [label]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error('文件不存在：' + file);
  process.exit(2);
}

const raw = existsSync('C:\\GitHub仓库\\ghp.txt') ? readFileSync('C:\\GitHub仓库\\ghp.txt', 'utf8') : '';
const token = (process.env.GITHUB_TOKEN || (raw.match(/gh[pousr]_[A-Za-z0-9]{20,}/) || [])[0] || '').trim();
if (!token) throw new Error('no token');

const H = {
  Authorization: `token ${token}`,
  'User-Agent': 'xiaoyu-release',
  Accept: 'application/vnd.github+json',
};

const rel = await (await fetch(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`, { headers: H })).json();
if (!rel.id) throw new Error('release 查不到');

/** 删掉同名残留（上次失败留下的半截/失败态） */
async function dropAsset(nm) {
  const cur = await (await fetch(`https://api.github.com/repos/${REPO}/releases/${rel.id}/assets?per_page=100`, { headers: H })).json();
  for (const a of Array.isArray(cur) ? cur : []) {
    if (a.name === nm) {
      await fetch(`https://api.github.com/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE', headers: H });
      console.log('· 删掉残留附件 ' + nm);
    }
  }
}

const size = statSync(file).size;
console.log(`上传 ${file}（${Math.round(size / 1048576)}MB）→ ${name}`);

let ok = false;
for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
  try {
    if (attempt > 1) await dropAsset(name);
    const url = `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}&label=${encodeURIComponent(label || name)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { ...H, 'Content-Type': 'application/octet-stream', 'Content-Length': String(size) },
      body: createReadStream(file),
      duplex: 'half',
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      console.log('✓ 成功：' + name + '  ' + Math.round((j.size || 0) / 1048576) + 'MB');
      ok = true;
    } else {
      console.log('✗ 第 ' + attempt + ' 次失败：' + res.status + ' ' + (j.message || ''));
    }
  } catch (e) {
    console.log('✗ 第 ' + attempt + ' 次异常：' + String(e?.cause?.code || e?.message || e));
  }
  if (!ok && attempt < 3) await new Promise((r) => setTimeout(r, 5000));
}

process.exit(ok ? 0 : 1);
