/**
 * 用 GitHub API 把「本地 HEAD 那棵树」原样推到远端 main。
 *
 * 为什么不直接 git push：这台机器的网络会把 github.com:443 的连接掐断
 * （Recv failure: Connection was reset），但 api.github.com 通。
 * publish-api.mjs 是按目录造树，语义是「目录快照」；这里不一样，
 * 这里是把本地 git 里 **已经 commit 过的那棵树** 整个复制过去，
 * 所以远端结果和本地 HEAD 一定逐字节一致，也不会误删远端别的文件。
 */
import { readFileSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';

const REPO = 'wxzjss/xiaoyu-agent';
const BRANCH = 'main';
const API = 'https://api.github.com';

const token = readFileSync('C:/GitHub仓库/ghp.txt', 'utf8')
  .split(/\r?\n/)
  .map((s) => s.trim())
  .filter((s) => s.startsWith('ghp_'))[0];
if (!token) throw new Error('ghp.txt 里找不到 ghp_ 开头的 token');

const H = {
  Authorization: `token ${token}`,
  'User-Agent': 'xiaoyu-publisher',
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
};

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    method: opts.method ?? 'GET',
    headers: H,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}
  if (!res.ok) throw new Error(`API ${opts.method ?? 'GET'} ${path} -> ${res.status} ${json?.message || text.slice(0, 200)}`);
  return json;
}

/** 本地 HEAD 的文件清单：路径 / 模式 / blob sha */
function localTree() {
  const out = execSync('git ls-tree -r HEAD', { cwd: 'D:/小鱼Agent', encoding: 'utf8' });
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const m = line.match(/^(\d+)\s+(\w+)\s+([0-9a-f]+)\t(.+)$/);
      if (!m) throw new Error('看不懂 ls-tree 行: ' + line);
      return { mode: m[1], type: m[2], sha: m[3], path: m[4] };
    });
}

const localHead = execSync('git rev-parse HEAD', { cwd: 'D:/小鱼Agent', encoding: 'utf8' }).trim();
const localMsg = execSync('git log -1 --pretty=%B', { cwd: 'D:/小鱼Agent', encoding: 'utf8' }).trim();
const files = localTree();
console.log('本地 HEAD      :', localHead);
console.log('本地文件数      :', files.length);

// 远端现状
const ref = await api(`/repos/${REPO}/git/ref/heads/${BRANCH}`);
const remoteHead = ref.object.sha;
const remoteCommit = await api(`/repos/${REPO}/git/commits/${remoteHead}`);
console.log('远端 main       :', remoteHead);
if (remoteHead === localHead) {
  console.log('已经是同一个 commit，不用推。');
  process.exit(0);
}

// 远端已有树（用来复用，不重复传）
const remoteTree = await api(`/repos/${REPO}/git/trees/${remoteCommit.tree.sha}?recursive=1`);
const remoteByPath = new Map(
  (remoteTree.tree || []).filter((x) => x.type === 'blob').map((x) => [x.path, x.sha]),
);

let uploaded = 0;
let reused = 0;
const entries = [];
for (const f of files) {
  if (remoteByPath.get(f.path) === f.sha) {
    reused++;
  } else {
    // 本地 git 里有、但工作区可能读不到（理论上不会），用 git cat-file 取原始字节
    const buf = execSync(`git cat-file blob ${f.sha}`, {
      cwd: 'D:/小鱼Agent',
      maxBuffer: 64 * 1024 * 1024,
    });
    const blob = await api(`/repos/${REPO}/git/blobs`, {
      method: 'POST',
      body: { content: buf.toString('base64'), encoding: 'base64' },
    });
    if (blob.sha !== f.sha) {
      throw new Error(`blob sha 不一致: ${f.path} 本地 ${f.sha} / 远端算出来 ${blob.sha}`);
    }
    uploaded++;
    process.stdout.write(`  ↑ ${f.path}\n`);
  }
  entries.push({ path: f.path, mode: f.mode === '100755' ? '100755' : '100644', type: 'blob', sha: f.sha });
}
console.log(`上传 ${uploaded} 个，复用 ${reused} 个`);

/**
 * 删掉「远端有、本地已经没有了」的文件。
 *
 * 【2026-10-27 踩到的坑：只加不删，删掉的文件在远端永远活着】
 * 建树时带了 base_tree，GitHub 会把远端原来的条目合并进来 ——
 * entries 里没有的路径**不会消失**，只是没被覆盖。
 * 所以本地 `git rm` 掉的文件（这次的 whale-self.mjs 和三个测试脚本），
 * 推完之后还在远端躺着，仓库看着就像没删干净。
 *
 * 解法：对每个「远端独有」的路径显式发一条 sha:null 的条目，
 * 那才是 GitHub API 里「删除这个文件」的写法。
 *
 * 安全线：只删本地 git 追踪树里确实没有的；
 * 另外跳过 .git 目录和明显的手写配置（万一远端有别人加的东西，别一推就没）。
 */
const localPaths = new Set(files.map((f) => f.path));
const KEEP_ALWAYS = [/^\.git\//, /^LICENSE/i, /^\.github\//];
const toDelete = [...remoteByPath.keys()].filter(
  (p) => !localPaths.has(p) && !KEEP_ALWAYS.some((re) => re.test(p)),
);
for (const p of toDelete) {
  entries.push({ path: p, mode: '100644', type: 'blob', sha: null });
  console.log(`  × ${p}（本地已删除，远端一并删掉）`);
}
if (toDelete.length) console.log(`删除 ${toDelete.length} 个`);

// 建树（带 base_tree 无所谓：这里 entries 就是全集，但带上更安全）
const tree = await api(`/repos/${REPO}/git/trees`, {
  method: 'POST',
  body: { tree: entries, base_tree: remoteCommit.tree.sha },
});
console.log('新树            :', tree.sha);

if (tree.sha === remoteCommit.tree.sha) {
  console.log('树内容完全相同，不需要新 commit。');
  process.exit(0);
}

const commit = await api(`/repos/${REPO}/git/commits`, {
  method: 'POST',
  body: { message: localMsg, tree: tree.sha, parents: [remoteHead] },
});
console.log('新 commit       :', commit.sha);

await api(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
  method: 'PATCH',
  body: { sha: commit.sha, force: false },
});
console.log('✔ 远端 main 已更新');
console.log('');
console.log('注意：远端 commit sha 和本地不会相同（父提交不是同一个历史线），');
console.log('      但**文件内容逐字节一致**，这是 API 路线的固有限制。');
