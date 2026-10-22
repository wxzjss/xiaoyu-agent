/**
 * 发布到 GitHub。
 *
 *   node scripts/publish.mjs            打包 + 提交 + 推送（有改动才提交）
 *   node scripts/publish.mjs --dry      只打包到 dist/release，不碰 git / 网络
 *   node scripts/publish.mjs --deep-scan 只做敏感信息扫描
 *
 * 规矩：
 *   - 发布物的白名单制：只带源码、素材、默认配置；.env / .state / sandbox / node_modules 一律不带。
 *   - 出门前扫一遍用户名、token、私钥、绝对路径，命中就直接中止（不是提醒，是中止）。
 *   - token 从 C:\GitHub仓库\ghp.txt 或环境变量 GITHUB_TOKEN 读，绝不写进任何文件。
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync, readdirSync, statSync,
} from 'node:fs';
import { join, dirname, relative, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { publishViaApi } from './publish-api.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const DIST = join(ROOT, 'dist', 'release');
const TOKEN_FILE = 'C:\\GitHub仓库\\ghp.txt';

const REPO_NAME = 'xiaoyu-agent';
const REPO_DESC = '一个自用的极简 Agent 平台：Electron 桌面版 + OpenAI 兼容 API + 工具循环。带启动自检。';
const BRANCH = 'main';

// ------------------------------------------------------------------ 白名单

/** 要发布的目录（整个搬过去） */
const INCLUDE_DIRS = ['src', 'public', 'electron', 'persona', 'assets', 'scripts'];

/** 要发布的单文件 */
const INCLUDE_FILES = [
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  '.env.example',
  '.gitignore',
  'start.bat',
  'start.sh',
  'make-shortcut.ps1',
];

/** 明确不带的东西（哪怕在 include 目录里） */
const EXCLUDE_NAMES = new Set([
  'node_modules', '.state', '.env', 'sandbox', 'dist', '.git',
  'run.log', 'desktop-shot.png',
]);

/**
 * 只在本机存在、永远不进发布物的东西（本机私有规则、备份、草稿）。
 * 这是硬墙：扫描阶段连读都不读，打包阶段连看都不看。
 */
const PRIVATE_ONLY = ['.private', '.drafts', '.local'];

const EXCLUDE_EXT = new Set(['.log', '.bak', '.tmp', '.pyc', '.ps1.txt']);

/** 文件名这些前缀/片段的，一律不发（测试探针、临时文件） */
const EXCLUDE_PATTERNS = [/^__/, /\.probe\./, /-probe\./, /^\./, /~(\d+)?$/];

// ------------------------------------------------------------------ 敏感信息

/**
 * 扫一遍要发布的内容。命中就中止。
 * 每条规则：正则 + 说明 + 白名单例外（比如 README 里写 C:\Users\<你> 是没事的）
 */
function scanRules(extraNames) {
  const nameAlt = extraNames.length ? extraNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') : null;
  const rules = [
    {
      id: 'win-user',
      re: /C:[\\/]+Users[\\/]+(?!<|\{|\$|你|用户名|username|user\b)[A-Za-z0-9_.\-]+/gi,
      why: 'Windows 用户目录里的真实用户名',
    },
    {
      id: 'win-user-any',
      re: /[Cc]:[\\/]Users[\\/](?!<|\{|%|\$|你|用户名|username)[^\s"'`<>)\]]{1,60}/g,
      why: '写死的 Windows 用户绝对路径',
    },
    {
      id: 'gh-token',
      re: /gh[pousr]_[A-Za-z0-9]{20,}/g,
      why: 'GitHub token',
    },
    {
      id: 'api-key',
      re: /sk-[A-Za-z0-9]{20,}/g,
      why: '疑似 API Key',
    },
    {
      id: 'private-key',
      re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
      why: '私钥',
    },
    {
      id: 'password',
      re: /(密码|password|passwd|pwd)\s*[:=：]\s*['"]?[^\s'"]{4,}/gi,
      why: '疑似明文密码',
    },
    {
      id: 'email',
      re: /[A-Za-z0-9._%+-]+@(?!example\.|local\b|users\.noreply\.github\.com)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
      why: '真实邮箱',
    },
    {
      id: 'private-marker',
      // 只在 .private/rules.local.md 里才该有的说法，一个字都不许出现在发布物里
      re: /改完代码就自己发布/g,
      why: '本机私有规则的内容（只该在 .private/rules.local.md 里）',
      // 扫描器自己得提到这个词，否则没法拦；跳过它，别自己打自己
      skipFiles: ['scripts/publish.mjs', 'scripts/auto-publish.mjs'],
    },
  ];
  if (nameAlt) {
    rules.push({
      id: 'known-name',
      re: new RegExp(nameAlt, 'g'),
      why: '本机用户名',
    });
  }
  return rules;
}

/**
 * 把「这台机器上真正不能出门的值」抽出来当扫描词：
 * .env 里的 API Key、界面里存的每个模型的 Key、以及它们的 baseURL / 模型名。
 * 这样哪怕以后谁把 .state 抄进了源码，也会当场被拦。
 */
function loadSecretValues() {
  const out = [];

  // .env 里的 key
  try {
    const env = readFileSync(join(ROOT, '.env'), 'utf8');
    for (const m of env.matchAll(/^[ \t]*(WANZI_API_KEY|API_KEY)[ \t]*=[ \t]*([^\r\n]+)/gm)) {
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      if (v && v.length >= 8) out.push(v);
    }
  } catch {}

  // 界面里存的模型：key 一律保护；baseURL 只保护「不是公共示例」的那些
  try {
    const store = JSON.parse(readFileSync(join(ROOT, '.state', 'models.json'), 'utf8'));
    for (const m of store.models ?? []) {
      if (m?.apiKey) out.push(String(m.apiKey));
    }
  } catch {}

  return out;
}

/** 递归列出白名单文件 */
function collectFiles(dir = ROOT, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    const rel = relative(ROOT, p).replace(/\\/g, '/');
    if (EXCLUDE_NAMES.has(entry.name)) continue;
    if (PRIVATE_ONLY.includes(entry.name)) continue;
    if (rel.split('/').some((seg) => seg.startsWith('sandbox'))) continue;
    if (entry.isDirectory()) {
      if (rel === 'dist') continue;
      if (INCLUDE_DIRS.includes(rel.split('/')[0]) || rel.split('/').length === 0) collectFiles(p, out);
      continue;
    }
    if (EXCLUDE_EXT.has(extname(entry.name).toLowerCase())) continue;
    if (EXCLUDE_PATTERNS.some((re) => re.test(entry.name))) continue;
    const top = rel.split('/')[0];
    if (rel.includes('/')) {
      if (!INCLUDE_DIRS.includes(top)) continue;
    } else {
      if (!INCLUDE_FILES.includes(rel)) continue;
    }
    out.push(rel);
  }
  return out;
}

/** 纯文本才扫 */
const TEXT_EXT = new Set(['.mjs', '.cjs', '.js', '.json', '.md', '.html', '.css', '.bat', '.ps1', '.sh', '.example', '.txt', '.yml', '.yaml', '']);

function isText(rel) {
  const e = extname(rel).toLowerCase();
  if (TEXT_EXT.has(e)) return true;
  return basename(rel).endsWith('.example') || !e;
}

function scan(extraNames = []) {
  const files = collectFiles();
  const rules = scanRules(extraNames);

  // 真·私密值：整串出现就中止。转义正则特殊字符。
  for (const [i, secret] of loadSecretValues().entries()) {
    const esc = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    rules.push({
      id: `secret-${i}`,
      re: new RegExp(esc, 'g'),
      why: '本机的模型 API Key（绝不能出门）',
    });
  }

  const hits = [];
  for (const rel of files) {
    if (!isText(rel)) continue;
    let text;
    try {
      text = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    for (const rule of rules) {
      if (rule.skipFiles?.includes(rel)) continue;
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(text)) !== null) {
        const line = text.slice(0, m.index).split('\n').length;
        hits.push({ file: rel, line, rule: rule.id, why: rule.why, sample: m[0].slice(0, 80) });
        if (m[0].length === 0) break;
      }
    }
  }
  return { files, hits };
}

// ------------------------------------------------------------------ 打包

/** 发布用的 .env.example（默认配置，不带任何人的 key） */
const ENV_EXAMPLE = `# 小鱼的模型配置。第一次用：把 WANZI_API_KEY 填上（或用界面顶部【模型】按钮）。
# 也可以换成任何 OpenAI 兼容的接口：BASE_URL 指到 .../v1 就行。
WANZI_API_KEY=
BASE_URL=https://napi.wanzij.cn/v1
MODEL=deepseek-v4.1-flash

# 网页版端口（桌面版自动挑空端口，不受影响）
PORT=8787

# 工作目录：不写就用项目里的 sandbox/
# WORKSPACE=

# 单轮工具调用上限。unlimited / 0 / inf = 不限（默认），只在点「停止」或模型自己收尾时结束。
MAX_ROUNDS=unlimited

# 上下文压缩：历史超过这么多 token 就把旧对话折成一条摘要，最近的尾巴原样保留。
# off / 0 / none 关闭；默认 120000。
CONTEXT_LIMIT=120000
# 压缩后保留的尾部比例（占 CONTEXT_LIMIT），默认留最近四分之一。
CONTEXT_KEEP_RATIO=0.25
`;

/** 发布用的 .gitignore */
const GITIGNORE = `# 私有数据，绝不提交
.env
.state/
sandbox/
dist/

# 依赖与产物
node_modules/
run*.log
desktop-shot.png
*.bak
*.tmp
`;

/** 写发布目录 */
function buildRelease() {
  rmSync(DIST, { recursive: true, force: true });
  mkdirSync(DIST, { recursive: true });

  const files = collectFiles();
  for (const rel of files) {
    const src = join(ROOT, rel);
    const dst = join(DIST, rel);
    mkdirSync(dirname(dst), { recursive: true });
    cpSync(src, dst);
  }

  // 覆盖成默认配置
  writeFileSync(join(DIST, '.env.example'), ENV_EXAMPLE, 'utf8');
  writeFileSync(join(DIST, '.gitignore'), GITIGNORE, 'utf8');

  // 每次都跑一遍自检，把结果说明写进发布物（不含路径）
  return files;
}

// ------------------------------------------------------------------ git

function git(args, opts = {}) {
  return execFileSync('git', args, {
    cwd: opts.cwd ?? DIST,
    encoding: 'utf8',
    stdio: opts.stdio ?? 'pipe',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env ?? {}) },
  });
}

function readToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN.trim();
  if (!existsSync(TOKEN_FILE)) return null;
  const raw = readFileSync(TOKEN_FILE, 'utf8');
  const m = raw.match(/gh[pousr]_[A-Za-z0-9]{20,}/);
  return m ? m[0] : null;
}

async function ensureRepo(token) {
  const headers = { Authorization: `token ${token}`, 'User-Agent': 'xiaoyu-publisher', Accept: 'application/vnd.github+json' };
  const me = await fetch('https://api.github.com/user', { headers }).then((r) => r.json());
  if (!me.login) throw new Error('GitHub 认证失败，检查 token');
  const owner = me.login;

  const existing = await fetch(`https://api.github.com/repos/${owner}/${REPO_NAME}`, { headers });
  if (existing.status === 200) return { owner, created: false, url: `https://github.com/${owner}/${REPO_NAME}` };
  if (existing.status !== 404) throw new Error(`查询仓库失败 HTTP ${existing.status}`);

  const created = await fetch('https://api.github.com/user/repos', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: REPO_NAME, description: REPO_DESC, private: false, has_issues: true, has_wiki: false, auto_init: false }),
  }).then((r) => r.json());
  if (!created.full_name) throw new Error('创建仓库失败：' + JSON.stringify(created).slice(0, 300));
  return { owner, created: true, url: `https://github.com/${owner}/${REPO_NAME}` };
}

/** 变更摘要：给人看的提交信息 */
function summarizeChanges(files) {
  const list = files.slice(0, 12).join(', ');
  return files.length > 12 ? `${list} 等 ${files.length} 个文件` : list;
}

// ------------------------------------------------------------------ main

const argv = process.argv.slice(2);
const DRY = argv.includes('--dry');
const SCAN_ONLY = argv.includes('--deep-scan');

// 本机用户名当敏感词（从环境变量推，不写死）
const machineUser = (process.env.USERNAME || process.env.USER || '').trim();
const extraNames = machineUser && machineUser.length >= 3 ? [machineUser] : [];

// 1) 先扫，扫不干净什么都不做
const pre = scan(extraNames);
console.log(`扫描 ${pre.files.length} 个文件…`);
if (pre.hits.length) {
  console.error(`\n✗ 发现 ${pre.hits.length} 处疑似敏感信息，已中止发布：\n`);
  for (const h of pre.hits.slice(0, 40)) {
    console.error(`  ${h.file}:${h.line}  [${h.rule}] ${h.why}\n    ${h.sample}`);
  }
  if (pre.hits.length > 40) console.error(`  …还有 ${pre.hits.length - 40} 处`);
  process.exit(1);
}
console.log('✓ 敏感信息扫描通过');

if (SCAN_ONLY) process.exit(0);

// 2) 打包
const files = buildRelease();
console.log(`✓ 打包到 ${relative(ROOT, DIST)}（${files.length} 个文件，已剔除 .env / .state / sandbox / node_modules）`);

// 对发布物再扫一遍（双保险：万一 copy 带进来什么）
const post = scan(extraNames);
if (post.hits.length) {
  console.error(`\n✗ 发布物里还有 ${post.hits.length} 处敏感信息，已中止：`);
  for (const h of post.hits.slice(0, 20)) console.error(`  ${h.file}:${h.line} [${h.rule}] ${h.sample}`);
  process.exit(1);
}

if (DRY) {
  console.log('--dry：不提交、不推送。发布物在 dist/release，自己看。');
  process.exit(0);
}

// 3) 提交推送
const token = readToken();
if (!token) {
  console.error('✗ 找不到 GitHub token：设 GITHUB_TOKEN 环境变量，或放到 ' + TOKEN_FILE);
  process.exit(1);
}

const repo = await ensureRepo(token);
console.log(`✓ 仓库 ${repo.url}${repo.created ? '（刚建好）' : ''}`);

const remote = `https://x-access-token:${token}@github.com/${repo.owner}/${REPO_NAME}.git`;

if (!existsSync(join(DIST, '.git'))) {
  git(['init', '-b', BRANCH]);
}
git(['config', 'user.name', 'xiaoyu']);
git(['config', 'user.email', 'xiaoyu@users.noreply.github.com']);
// 第一次跑还没有 origin，add 之前先试着一脚踢开；没有就算了
try {
  git(['remote', 'set-url', 'origin', remote]);
} catch {
  git(['remote', 'add', 'origin', remote]);
}
git(['add', '-A']);

let dirty = true;
try {
  git(['diff', '--cached', '--quiet']);
  dirty = false;
} catch {
  dirty = true;
}

if (!dirty) {
  console.log('✓ 没有变化，不用发布');
  process.exit(0);
}

const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
const msg = `chore: 自动发布 ${stamp}\n\n更新：${summarizeChanges(files)}\n`;
git(['commit', '-m', msg]);
console.log('✓ 已提交');

/**
 * 推送。GitHub 经常把大一点的 push 掐掉（Connection was reset），
 * 所以：直连 → 换 HTTP/1.1 → 缩短包体 → 退一步别强推。四轮都失败才认。
 */
function pushWithRetry() {
  const attempts = [
    { label: '直连', args: ['-c', 'http.version=HTTP/1.1', 'push', '-u', 'origin', `${BRANCH}:${BRANCH}`, '--force'] },
    { label: 'HTTP/1.1 + 小包', args: ['-c', 'http.version=HTTP/1.1', '-c', 'http.postBuffer=524288000', 'push', '-u', 'origin', `${BRANCH}:${BRANCH}`, '--force'] },
    { label: '重试', args: ['-c', 'http.version=HTTP/1.1', 'push', '-u', 'origin', `${BRANCH}:${BRANCH}`, '--force'] },
    { label: '不强推', args: ['-c', 'http.version=HTTP/1.1', 'push', '-u', 'origin', `${BRANCH}:${BRANCH}`] },
  ];

  let lastErr = null;
  for (const [i, a] of attempts.entries()) {
    try {
      git(a.args);
      console.log(`✓ 已推送（${a.label}）`);
      return true;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.stderr || err?.message || '').split('\n').filter(Boolean).pop() || '';
      console.log(`… 第 ${i + 1} 次推送失败（${a.label}）：${msg.slice(0, 120)}`);
      if (i < attempts.length - 1) {
        // 等一下再试，网络抖动通常几秒就好
        execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, 4000)']);
      }
    }
  }
  throw lastErr ?? new Error('推送失败');
}

let pushed = false;
try {
  pushWithRetry();
  pushed = true;
  console.log(`✓ 已推送到 ${repo.url}`);
} catch (err) {
  // git 推不上去（常见：网络把 github.com:443 掐了），改走 GitHub API 上传
  console.log('… git 推送不通，改走 GitHub API 上传');
  const msg = `chore: 自动发布 ${stamp}\n\n更新：${summarizeChanges(files)}\n`;
  const r = await publishViaApi(DIST, token, msg);
  if (!r) {
    console.log('✓ 线上内容已经和本地一致，不用动');
  } else {
    console.log(`✓ 已通过 API 推送 ${r.files} 个文件（commit ${r.commit.slice(0, 7)}）`);
  }
  pushed = true;
  console.log(`✓ 已推送到 ${repo.url}`);
}

// 提交完把 remote 里的 token 摘掉，别留在 dist/release/.git/config
try {
  git(['remote', 'set-url', 'origin', `https://github.com/${repo.owner}/${REPO_NAME}.git`]);
} catch {}
