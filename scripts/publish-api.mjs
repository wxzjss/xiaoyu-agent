/**
 * 通过 GitHub API 发布（不走 git push）。
 *
 * 为什么要这个：某些网络下 git push 到 github.com:443 会被掐断（Connection reset），
 * 但 api.github.com 还通。那就用 Git Data API 直接造 commit：
 *   blobs → tree → commit → 更新 ref
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
    // 大文件 blob 的 base64 body 不小，60s 会刚好卡在超时上，放宽到 3 分钟
    signal: AbortSignal.timeout(180000),
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

  // 2) 每个文件造 blob（先按内容 SHA 去重：同一个 blob 只传一次）
  const files = collect(dir);
  const entries = [];
  const seen = new Map(); // contentSha -> blob.sha
  for (const rel of files) {
    const abs = join(dir, rel);
    const buf = readFileSync(abs);
    const ext = rel.slice(rel.lastIndexOf('.')).toLowerCase();
    // BINARY_EXT 只用于日志区分，base64 传输对两者都成立
    void BINARY_EXT.has(ext);
    const contentSha = createHash('sha1')
      .update('blob ' + buf.length + '\0')
      .update(buf)
      .digest('hex');
    let blobSha = seen.get(contentSha);
    if (!blobSha) {
      const blob = await api(token, `/repos/${REPO}/git/blobs`, {
        method: 'POST',
        body: { content: buf.toString('base64'), encoding: 'base64' },
      });
      blobSha = blob.sha;
      seen.set(contentSha, blobSha);
    }
    entries.push({ path: rel, mode: '100644', type: 'blob', sha: blobSha });
  }

  /**
   * 3) 建树 —— 必须带 base_tree。
   *
   * 【为什么】不带 base_tree 时 GitHub 会把这棵树当成「完整快照」：仓库里
   * 有、但这棵树里没有的路径会被**静默删掉**。而 dir 一般是发布包
   * （dist/release），是筛过的子集 —— 安卓工程 mobile/、插件源码
   * vendor/、persona.mjs 这些不在发布包里的东西就会整个消失。
   * 2026-10-26 真踩过：一次 API 发布把仓库里 58 个文件全清了，还得
   * 再用 git push --force 补回来。
   *
   * 带上 base_tree 之后语义变成「在现有树上覆盖/新增这些文件」，
   * 不在这次上传范围内的路径原样保留。
   */
  const treeBody = { tree: entries };
  if (baseTree) treeBody.base_tree = baseTree;
  const tree = await api(token, `/repos/${REPO}/git/trees`, {
    method: 'POST',
    body: treeBody,
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
