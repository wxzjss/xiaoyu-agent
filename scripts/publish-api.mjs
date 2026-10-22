/**
 * 通过 GitHub API 发布（不走 git push）。
 *
 * 为什么要这个：某些网络下 git push 到 github.com:443 会被掐断（Connection reset），
 * 但 api.github.com 还通。那就用 Git Data API 直接造 commit：
 *   blobs → tree → commit → 更新 ref
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = 'wxzjss/xiaoyu-agent';
const BRANCH = 'main';
const API = 'https://api.github.com';

function headers(token) {
  return {
    Authorization: `token ${token}`,
    'User-Agent': 'xiaoyu-publisher',
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
  };
}

async function api(token, path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method ?? 'GET',
    headers: headers(token),
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) {
    const msg = json?.message || text.slice(0, 200);
    throw new Error(`GitHub API ${opts.method ?? 'GET'} ${path} -> ${res.status} ${msg}`);
  }
  return json;
}

/** 判断是不是二进制（别拿 utf8 读图片） */
const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.zip', '.exe', '.dll']);

function collect(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collect(p, base, out);
    else out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

/**
 * 把 dir 里的所有文件同步成仓库最新一次提交。
 * @returns {Promise<{commit:string, files:number, changed:number}|null>} null 表示没变化
 */
export async function publishViaApi(dir, token, message) {
  // 1) 当前分支头
  let headSha = null;
  let baseTree = null;
  try {
    const ref = await api(token, `/repos/${REPO}/git/ref/heads/${BRANCH}`);
    headSha = ref.object.sha;
    const commit = await api(token, `/repos/${REPO}/git/commits/${headSha}`);
    baseTree = commit.tree.sha;
  } catch (err) {
    // 空仓库：连 ref 都没有，那就从零建
    if (!/404/.test(String(err.message))) throw err;
  }

  // 2) 每个文件造 blob
  const files = collect(dir);
  const entries = [];
  for (const rel of files) {
    const abs = join(dir, rel);
    const isBin = BINARY_EXT.has(rel.slice(rel.lastIndexOf('.')).toLowerCase());
    const buf = readFileSync(abs);
    const blob = await api(token, `/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: { content: buf.toString('base64'), encoding: 'base64' },
    });
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // 3) 一棵完整的树（不带 base_tree = 完全以这里为准，仓库里多出来的会被清掉）
  const tree = await api(token, `/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: { tree: entries },
  });

  // 4) 没变化就不提交
  if (baseTree && tree.sha === baseTree) return null;

  // 5) commit
  const commit = await api(token, `/repos/${REPO}/git/commits`, {
    method: 'POST',
    body: { message, tree: tree.sha, parents: headSha ? [headSha] : [] },
  });

  // 6) 更新 ref
  if (headSha) {
    await api(token, `/repos/${REPO}/git/refs/heads/${BRANCH}`, {
      method: 'PATCH',
      body: { sha: commit.sha, force: true },
    });
  } else {
    await api(token, `/repos/${REPO}/git/refs`, {
      method: 'POST',
      body: { ref: `refs/heads/${BRANCH}`, sha: commit.sha },
    });
  }

  return { commit: commit.sha, files: files.length, changed: 1 };
}

/** 直接用 API 试一下通不通（发布脚本用它决定走哪条路） */
export async function apiReachable(token) {
  try {
    await api(token, `/repos/${REPO}`);
    return true;
  } catch {
    return false;
  }
}
