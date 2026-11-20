/**
 * 隔离测试实例：独立的服务进程 + 独立数据目录 + 独立无头浏览器。
 *
 * 【2026-11-19 重做·封住「测试影响正式实例」的四条路】
 *
 * 1) 配置复制会带出运行状态。以前只挡 sessions 和凭据，却把 child-pids.json
 *    （上一进程留下的子进程 PID 名单）、mobile.json（手机配对配置）一并复制进去。
 *    前者会让隔离实例开机去 kill 正式实例的子进程，后者会影响监听地址。
 *    现在单独一份「运行状态」名单，一律不带；服务端在测试模式下也强制只绑 127.0.0.1。
 *
 * 2) 起不来时浏览器会留成孤儿。以前 catch 里只 server.kill() + 删目录，
 *    已经拉起来的 Edge 及其一串子进程没人管。现在统一走 stop()：先杀进程树，
 *    等真的退出，再删目录，任何一步失败都如实抛错，绝不静默吞掉。
 *
 * 3) 端口靠「先探再绑」有竞态。应用端口改成真去 bind 一次确认（exclusive），
 *    浏览器调试端口改成 --remote-debugging-port=0，由浏览器自己原子领号，
 *    再从 profile 里的 DevToolsActivePort 读回来。
 *
 * 4) 「这个实例是不是我的」只靠端口猜。现在启动时生成一次性 token 写进服务端 env，
 *    /api/health 只有带着匹配的 header 才回自己的 pid；requireIsolatedTarget()
 *    用它核对 pid、工作区、地址，核对不上就拒绝写入。手动跑检查同样走这道闸。
 *
 * 默认用本地回环模型，不复制机器上的配置。生成隔离的 models.json 和 .env。
 * 只有显式设置 XY_TEST_LOCAL_MODEL=0，才使用机器上已有的模型配置。
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import net from 'node:net';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, existsSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const WINDOWS = process.platform === 'win32';
const SIGNALS = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 };

const USER_DATA = process.env.XY_USER_DATA
  || join(process.env.APPDATA || join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Roaming'), '小鱼Agent', 'data');

const BROWSERS = [
  process.env.XY_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe') : '',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
].filter(Boolean);
const BROWSER = BROWSERS.find((p) => { try { return existsSync(p); } catch { return false; } });

/** 凭据、账号、记忆、断点：绝不带进临时目录 */
const SENSITIVE_RE = /qq|onebot|napcat|bot|token|secret|cred|passwd|password|apikey|api[-_]?key|admin[-_]?mode|license|account|cookie|resume|my-memory|whale-on|deepseek|github|^\./i;
/**
 * 运行状态：带了会让隔离实例去动正式实例的东西。
 *   · child-pids / *.pid —— 开机清理孤儿子进程时，会照着这份名单去杀进程；
 *   · mobile —— 手机配对配置，决定监听 0.0.0.0 还是 127.0.0.1（服务端另有强制）；
 *   · live / inbox —— 上一轮没跑完的实时柜子与插话信箱，属于正在进行的会话；
 *   · diag / *.log —— 排查日志，读进来只会误导读日志的检查。
 *
 * 【2026-11-19 补·update.json 是个真洞】它原来不在名单里，于是每轮测试都把
 * 主人那份「自动更新状态」复制进临时目录，里面常带 `status:'ready'` 和一条
 * **指向主人机器上安装包的绝对路径**。隔离实例的 updater 读到 ready 且 to 比
 * 本地新，就会 `dropInstaller(info.file)` —— 一句话删掉主人下好的安装包。
 * 同类还有：selfcheck-pending（自检结论会进系统提示词）、xy-cdp.*（浏览器调试口）、
 * crash-count（崩溃计数，会触发降级策略）、*.cpuprofile / *.heapsnapshot（采样垃圾）。
 */
const RUNTIME_RE = /child-pids|\.pid$|^mobile|^live$|^inbox$|^diag|\.log$|^last-session|^update\.json$|^selfcheck|^xy-cdp|^crash-count|\.cpuprofile$|\.heapsnapshot$|^restart-log/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function writeState(root, name, value) {
  writeFileSync(join(root, '.state', name), JSON.stringify(value, null, 2));
}

function copyTree(src, dst) {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const sp = join(src, name);
    const dp = join(dst, name);
    const st = statSync(sp);
    if (st.isDirectory()) { copyTree(sp, dp); continue; }
    if (st.isFile()) copyFileSync(sp, dp);
  }
}

/** 只带配置、不带任何会话：主人的聊天记录一个字节都不进临时目录 */
function seedConfig(dst) {
  const srcState = join(USER_DATA, '.state');
  const dstState = join(dst, '.state');
  mkdirSync(dstState, { recursive: true });
  /* 空目录，但得存在：有些检查（check-reset）直接 writeFileSync 造测试会话。 */
  mkdirSync(join(dstState, 'sessions'), { recursive: true });
  let copied = 0;
  /* 【2026-11-19 加·让自检能真的验】光看「临时目录里有没有 child-pids.json」
   * 验不出东西：那个文件是实例**自己运行时写出来的**（内容 `[]`），存在才是正常的。
   * 真正要守的是「复制清单里不许出现运行状态/凭据」—— 所以把清单带出去，
   * 让 check-test-isolation 断言清单本身，而不是拿目录内容猜。 */
  const names = [];
  const take = (name, from, to) => {
    if (/\.bak|backup|orphan/i.test(name)) return;
    if (SENSITIVE_RE.test(name)) return;
    if (RUNTIME_RE.test(name)) return;
    try {
      const st = statSync(from);
      if (!st.isFile() || st.size > 4 * 1024 * 1024) return;
      copyFileSync(from, join(to, name));
      copied++;
      names.push(name);
    } catch { /* 单个配置读不到就跳过，不拖垮整轮 */ }
  };
  if (existsSync(srcState)) {
    for (const name of readdirSync(srcState)) {
      if (name === 'sessions') continue;              // 会话：绝不复制
      if (name.startsWith('.')) continue;             // .env（真 key）、.factory.json 之类
      take(name, join(srcState, name), dstState);
    }
  }
  /* 根目录下几个散装配置（persona 之类）也带上，同样排除会话与凭据 */
  try {
    for (const name of readdirSync(USER_DATA)) {
      if (name === '.state' || name === 'sessions' || name === 'code' || name === 'public') continue;
      if (name.startsWith('.')) continue;
      take(name, join(USER_DATA, name), dst);
    }
  } catch {}
  /* 运行版网页直接用仓库的 public/：验的就是最新前端，且 check-chat-e2e
   * 要「仓库 == 生效版逐字节」，源和目标本来就是同一份。 */
  try { copyTree(join(ROOT, 'public'), join(dst, 'public')); } catch {}
  return { count: copied, names };
}

/** 完全离线的一套夹具：本地回环模型 + 少量确定性卡，够 UI 检查跑 */
function seedLocalFixtures(dataDir, modelBase) {
  writeFileSync(join(dataDir, '.env'), '');
  writeState(dataDir, 'models.json', {
    activeId: 'qa-model', hideEnv: true,
    models: [{ id: 'qa-model', name: 'QA model', model: 'qa-model', apiKey: 'qa-local', baseURL: modelBase }],
  });
  writeState(dataDir, 'agents.json', {
    version: 4,
    customs: [
      { id: 'ag_qa_bx', name: '小白曦', persona: '你是小白曦，用简短中文回答。' },
      { id: 'ag_qa_narrator', name: '旁白', persona: '你是旁白，用简短中文回答。' },
    ],
    colors: { ag_qa_bx: '#3377aa', ag_qa_narrator: '#775599' },
  });
  writeState(dataDir, 'agent-openings.json', { ag_qa_bx: '小白曦在这里。' });
}

function startMockModel() {
  return createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'qa-model' }] }));
      return;
    }
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
    try {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4 * 1024 * 1024) { res.writeHead(413).end(); return; }
      }
      const body = JSON.parse(raw);
      const isEnhancement = body.messages?.some((message) => message.role === 'system'
        && typeof message.content === 'string'
        && message.content.startsWith('你的任务只有一句话：润色这段话，或增强这段提示词。'));
      const parts = isEnhancement
        ? ['请梳理原需求，明确目标、约束和预期结果。']
        : ['这是本地回归模型的第一段回复。', '这是后续流式内容。', '回归回复结束。'];
      if (!body.stream) {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: parts.join('') }, finish_reason: 'stop' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      for (const content of parts) {
        if (res.destroyed) return;
        res.write('data: ' + JSON.stringify({ id: 'qa-reply', choices: [{ index: 0, delta: { role: 'assistant', content } }] }) + '\n\n');
        await sleep(350);
      }
      if (res.destroyed) return;
      res.end('data: ' + JSON.stringify({
        id: 'qa-reply',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 },
      }) + '\n\ndata: [DONE]\n\n');
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  });
}

/** 只认回环地址，且不许落到正式实例的两个端口 */
function canonicalBase(raw) {
  const u = new URL(String(raw || ''));
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || !u.port) throw new Error('隔离实例地址不是回环地址：' + raw);
  if (u.port === '8787' || u.port === '8788') throw new Error('隔离实例地址指向正式实例：' + raw);
  if (u.username || u.password || u.pathname !== '/' || u.search || u.hash) throw new Error('隔离实例地址格式不对：' + raw);
  return u.origin;
}

/**
 * 核对「现在这个 BASE 到底是不是本轮隔离实例」。
 * 白名单检查只防写错地址，这一道防的是「地址对、但那上面跑的是别的进程」。
 */
export async function requireIsolatedTarget(env = process.env) {
  const token = String(env.XY_TEST_INSTANCE_TOKEN || '');
  const pid = Number(env.XY_TEST_INSTANCE_PID);
  if (env.XY_REQUIRE_ISOLATED !== '1') throw new Error('没有开启隔离要求（XY_REQUIRE_ISOLATED=1），拒绝运行');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('缺少隔离实例 token，请通过 qa-run-isolated.mjs 或 run-all-checks.mjs 运行');
  if (!Number.isInteger(pid) || pid <= 0) throw new Error('缺少隔离实例 pid');
  if (!env.XY_TEST_DATA) throw new Error('缺少隔离数据目录');
  const base = canonicalBase(env.BASE);
  const health = await fetch(base + '/api/health', {
    headers: { 'X-XY-Test-Instance': token },
    redirect: 'error',
    signal: AbortSignal.timeout(2500),
  }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!health?.ok) throw new Error('隔离实例无响应：' + base);
  if (health.testInstancePid !== pid) throw new Error('目标实例 pid 不符（期望 ' + pid + '，实际 ' + health.testInstancePid + '）');
  const expected = resolve(env.XY_TEST_DATA, 'workspace');
  if (resolve(String(health.workspaceShared || '')) !== expected) {
    throw new Error('目标实例工作区不符（期望 ' + expected + '，实际 ' + health.workspaceShared + '）');
  }
  return base;
}

function launch(command, args, options) {
  const child = spawn(command, args, { windowsHide: true, ...options });
  child.on('error', (e) => { child.spawnError = e; });
  return child;
}

function hasExited(child) {
  return !child || child.pid == null || child.exitCode !== null || child.signalCode !== null;
}

/** 连子进程一起收掉：Windows 上 taskkill /T，POSIX 上用独立进程组 */
function killTree(child) {
  if (!child || child.pid == null) return;
  if (WINDOWS) {
    if (hasExited(child)) return;
    try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 8000 }); } catch {}
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
  if (!hasExited(child)) { try { child.kill('SIGKILL'); } catch {} }
}

async function waitFor(child, timeoutMs, probe, message) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child?.spawnError) throw new Error(message + '：' + child.spawnError.message);
    if (child && hasExited(child)) throw new Error(message + '：进程已退出（' + (child.signalCode || child.exitCode) + '）');
    try {
      const got = await probe();
      if (got) return got;
    } catch { /* 还没就绪，继续等 */ }
    await sleep(150);
  }
  throw new Error(message + '：等待超时');
}

function bindOnce(port) {
  return new Promise((resolveBind, rejectBind) => {
    const srv = net.createServer();
    srv.once('error', rejectBind);
    srv.listen({ port, host: '127.0.0.1', exclusive: true }, () => srv.close(() => resolveBind(port)));
  });
}

async function pickFreePort(start) {
  if (!Number.isInteger(start) || start < 1024 || start > 65535) throw new Error('无效的隔离应用端口：' + start);
  for (let p = start; p <= Math.min(start + 63, 65535); p++) {
    if (p === 8787 || p === 8788) continue;      // 正式实例：永远不碰
    try { return await bindOnce(p); } catch (e) {
      if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
    }
  }
  throw new Error('找不到可用的隔离应用端口，起始端口：' + start);
}

/**
 * @returns {Promise<{base:string, dataDir:string, cdpPort:number, serverPid:number,
 *   browserPid:number, env:object, stop:()=>Promise<void>, killServer:()=>void}>}
 */
export async function startIsolated({ appPort = 8795, cdpPort: _legacyCdpPort, browserExecutable = BROWSER } = {}) {
  if (!browserExecutable) throw new Error('找不到测试用 Edge/Chrome（可用 XY_EDGE 指定路径）');
  const localModel = process.env.XY_TEST_LOCAL_MODEL !== '0';
  appPort = await pickFreePort(appPort);
  const base = 'http://127.0.0.1:' + appPort;
  const dataDir = mkdtempSync(join(tmpdir(), 'xy-check-'));
  const workspace = join(dataDir, 'workspace');
  const profile = join(dataDir, 'edge-profile');
  const token = randomBytes(32).toString('hex');

  let server = null;
  let edge = null;
  let mock = null;
  let stopping = null;

  const onExit = () => {
    killTree(edge);
    killTree(server);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
  };
  const signalHandlers = Object.entries(SIGNALS).map(([sig, code]) => [sig, () => process.exit(code)]);
  process.once('exit', onExit);
  for (const [sig, fn] of signalHandlers) process.once(sig, fn);

  const stop = () => stopping ??= (async () => {
    killTree(edge);
    killTree(server);
    try { mock?.closeAllConnections?.(); mock?.close(); } catch {}
    const deadline = Date.now() + 6000;
    while ((!hasExited(edge) || !hasExited(server)) && Date.now() < deadline) await sleep(50);
    process.removeListener('exit', onExit);
    for (const [sig, fn] of signalHandlers) process.removeListener(sig, fn);
    if (!hasExited(edge) || !hasExited(server)) {
      throw new Error('测试进程没退干净（server=' + server?.pid + ' browser=' + edge?.pid + '），临时目录保留：' + dataDir);
    }
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  })();

  try {
    mkdirSync(profile, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const seeded = localModel ? { count: 0, names: [] } : seedConfig(dataDir);
    if (localModel) {
      mkdirSync(join(dataDir, '.state', 'sessions'), { recursive: true });
      copyTree(join(ROOT, 'public'), join(dataDir, 'public'));
    }
    const env = {
      ...process.env,
      PORT: String(appPort),
      BASE: base,
      MINI_AGENT_DATA: dataDir,
      WORKSPACE: workspace,
      XY_TEST_INSTANCE: '1',
      XY_TEST_INSTANCE_TOKEN: token,
      XY_TEST_DATA: dataDir,
      XY_REQUIRE_ISOLATED: '1',
      /* 复制清单传给子进程：检查脚本是独立 node 进程，拿不到父进程内存。
       * 逗号分隔就够 —— 文件名里不会有逗号，而且这只是自检元数据。 */
      XY_TEST_SEEDED: seeded.names.join(','),
    };
    if (localModel) {
      mock = startMockModel();
      await new Promise((r) => mock.listen(0, '127.0.0.1', r));
      const modelBase = 'http://127.0.0.1:' + mock.address().port + '/v1';
      seedLocalFixtures(dataDir, modelBase);
      Object.assign(env, { BASE_URL: modelBase, MODEL: 'qa-model', API_KEY: 'qa-local', WANZI_API_KEY: 'qa-local' });
    }

    server = launch(process.execPath, ['src/server.mjs'], {
      cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let boot = '';
    const collect = (d) => {
      boot = (boot + String(d)).slice(-12000);
      if (process.env.XY_INSTANCE_LOG) process.stdout.write('[srv] ' + d);
    };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
    env.XY_TEST_INSTANCE_PID = String(server.pid);

    await waitFor(server, 20000, async () => {
      const pid = Number(env.XY_TEST_INSTANCE_PID);
      const health = await fetch(base + '/api/health', {
        headers: { 'X-XY-Test-Instance': token }, redirect: 'error', signal: AbortSignal.timeout(1200),
      }).then((r) => (r.ok ? r.json() : null));
      return health?.testInstancePid === pid && resolve(String(health.workspaceShared || '')) === resolve(workspace);
    }, '隔离实例没起来').catch((e) => {
      throw new Error(e.message + '\n' + boot.split('\n').slice(-8).join('\n'), { cause: e });
    });

    edge = launch(browserExecutable, [
      '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
      '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--remote-debugging-port=0',
      '--user-data-dir=' + profile,
      base,
    ], { stdio: 'ignore' });

    const cdpPort = await waitFor(edge, 20000, async () => {
      /* 端口是浏览器自己领的：从 profile 里读回来，顺便核对浏览器 websocket 路径，
       * 确保这个号没被别人的调试端口顶替。 */
      const [port, wsPath] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
      if (!/^\d+$/.test(port || '') || !String(wsPath || '').startsWith('/devtools/browser/')) return false;
      const cdpBase = 'http://127.0.0.1:' + port;
      const opts = { redirect: 'error', signal: AbortSignal.timeout(1200) };
      const version = await fetch(cdpBase + '/json/version', opts).then((r) => r.json());
      if (new URL(version.webSocketDebuggerUrl).pathname !== wsPath) return false;
      const targets = await fetch(cdpBase + '/json/list', opts).then((r) => r.json());
      return targets.some((t) => t.type === 'page' && String(t.url || '').startsWith(base)) ? Number(port) : false;
    }, '调试浏览器没打开隔离页面');

    env.XY_CDP_PORT = String(cdpPort);
    return {
      base, dataDir, cdpPort, copied: seeded.count, copiedNames: seeded.names, env,
      serverPid: server.pid, browserPid: edge.pid,
      localModel,
      stop,
      /** 给「硬杀服务」类检查用：直接拿权威 pid，不用再去 netstat 猜 */
      killServer: () => {
        if (WINDOWS) {
          try { spawnSync('taskkill', ['/F', '/PID', String(server.pid), '/T'], { stdio: 'ignore', windowsHide: true, timeout: 8000 }); } catch {}
        } else {
          try { process.kill(-server.pid, 'SIGKILL'); } catch { try { server.kill('SIGKILL'); } catch {} }
        }
      },
    };
  } catch (e) {
    try {
      await stop();
    } catch (cleanup) {
      throw new AggregateError([e, cleanup], e.message + '\n' + cleanup.message);
    }
    throw e;
  }
}

/** 兼容旧名字：有些检查从 _test-instance 之外的地方 import 过它 */
export const killOrphanGuard = RUNTIME_RE;

/**
 * 给自己起一个独立的无头浏览器（检查要动 localStorage / 装 fetch 垫片 / 反复导航时用）。
 * 端口由浏览器自己领（--remote-debugging-port=0），从 profile 里的 DevToolsActivePort 读回来，
 * 因此多轮并行也不会撞端口。
 *
 * @returns {Promise<{cdpPort:number, child:import('node:child_process').ChildProcess, close:()=>Promise<void>}>}
 */
export async function openBrowser({ url, profile, browserExecutable = BROWSER }) {
  if (!browserExecutable) throw new Error('找不到测试用 Edge/Chrome（可用 XY_EDGE 指定路径）');
  if (!profile) throw new Error('openBrowser 需要 profile 目录');
  mkdirSync(profile, { recursive: true });
  const child = launch(browserExecutable, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--mute-audio',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profile,
    url,
  ], { stdio: 'ignore' });
  const cdpPort = await waitFor(child, 20000, async () => {
    const [port, wsPath] = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').trim().split(/\r?\n/);
    if (!/^\d+$/.test(port || '') || !String(wsPath || '').startsWith('/devtools/browser/')) return false;
    const cdpBase = 'http://127.0.0.1:' + port;
    const opts = { redirect: 'error', signal: AbortSignal.timeout(1200) };
    const version = await fetch(cdpBase + '/json/version', opts).then((r) => r.json());
    if (new URL(version.webSocketDebuggerUrl).pathname !== wsPath) return false;
    const targets = await fetch(cdpBase + '/json/list', opts).then((r) => r.json());
    return targets.some((t) => t.type === 'page' && String(t.url || '').startsWith(new URL(url).origin))
      ? Number(port) : false;
  }, '调试浏览器没起来');
  return {
    child,
    cdpPort,
    close: async () => {
      killTree(child);
      const deadline = Date.now() + 5000;
      while (!hasExited(child) && Date.now() < deadline) await sleep(50);
    },
  };
}