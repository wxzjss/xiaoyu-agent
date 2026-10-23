// Tiny config loader: .env file > process.env > defaults.
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 资源根：开发时 = 项目目录；装了 exe 之后 = app.asar 里面（只读） */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 数据根：可写的那一层。
 * 开发时就是 ROOT；打成 exe 跑的时候 app.asar 只读，写 .state 会失败，
 * 所以 electron/main.cjs 用 MINI_AGENT_DATA 把它指到 %APPDATA%\xiaoyu-mini-agent。
 */
const DATA = process.env.MINI_AGENT_DATA ? resolve(process.env.MINI_AGENT_DATA) : ROOT;
const PACKAGED = DATA !== ROOT;

/** 打包后默认干活目录放在数据目录下的 workspace，别用 cwd（那可能是 System32） */
const DEFAULT_WORKSPACE = PACKAGED ? join(DATA, 'workspace') : process.cwd();

/** 应用版本：只从资源根的 package.json 读，界面底部用它显示，省得再写死一份到处漂 */
function readAppVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    return typeof pkg?.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
export const appVersion = readAppVersion();

function loadEnvFile() {
  // 数据目录里的 .env 优先（打包后用户能改的就是这一个），再退回资源目录
  const file = [join(DATA, '.env'), join(ROOT, '.env')].find((p) => existsSync(p));
  if (!file) return {};
  const out = {};
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fileEnv = loadEnvFile();

export function get(key, fallback) {
  const v = fileEnv[key] ?? process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

/**
 * 单轮工具调用上限。0 / inf / infinity / unlimited / none / off 都表示不限，
 * 只在用户手动「停止」、或模型自己收尾时才结束这一轮。
 */
export function parseMaxRounds(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['0', 'inf', 'infinity', 'unlimited', 'none', 'off', '-1', 'no'].includes(v)) return Infinity;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

/**
 * 上下文压缩阈值（token）。0 / off / none / unlimited 表示不压缩。
 * 历史超过这个数，就把旧对话折成一条摘要，最近的尾巴原样保留。
 */
function parseContextLimit(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (['0', 'off', 'none', 'unlimited', 'inf', 'infinity', 'no', '-1'].includes(v)) return Infinity;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

/** 打包后数据目录/工作目录可能还不存在，这里顺手建好（失败不致命） */
if (PACKAGED) {
  for (const dir of [DATA, join(DATA, '.state'), DEFAULT_WORKSPACE]) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {}
  }
}

export const config = {
  version: appVersion,
  /** 资源根（只读）：public、persona、assets 都从这里读 */
  root: ROOT,
  /** 数据根（可写）：.state / 会话 / 设置 全写这里 */
  dataDir: DATA,
  packaged: PACKAGED,
  apiKey: get('API_KEY', get('WANZI_API_KEY', '')),
  // 默认走 DeepSeek 官方。想在别处跑，改 .env 的 BASE_URL / MODEL 就行。
  baseURL: get('BASE_URL', 'https://api.deepseek.com').replace(/\/+$/, ''),
  model: get('MODEL', 'deepseek-flash'),
  port: Number(get('PORT', 8787)),
  workspace: get('WORKSPACE', DEFAULT_WORKSPACE),
  maxRounds: parseMaxRounds(get('MAX_ROUNDS', 'unlimited')),
  /** 模型上下文上限（token）。默认 128000；Infinity = 不压缩。 */
  contextLimit: parseContextLimit(get('CONTEXT_LIMIT', '128000')),
  /**
   * 用到上限的这个比例就自动压缩旧对话。
   * 只有 1.0 是有意义的：设置里填多少就压到多少，不打折。
   * 留着这个键只是为了兼容老 .env，小于 1 的值在 compress.mjs 里会被忽略。
   */
  contextTriggerRatio: 1.0,
  /** 压缩后原样保留的尾部 token 数（绝对数，默认 8000）。填多少不跟着 limit 变。 */
  contextKeepTokens: (() => {
    const n = Number(get('CONTEXT_KEEP_TOKENS', 8000));
    return Number.isFinite(n) && n > 0 ? n : 8000;
  })(),
  /** 老配置：尾部保留占 limit 的比例。只有在没设 CONTEXT_KEEP_TOKENS 时才兜底。 */
  contextKeepRatio: Number(get('CONTEXT_KEEP_RATIO', 0.25)),
};
