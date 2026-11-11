/**
 * 【2026-11-09 加·自检不许再碰主人正在用的那份】
 *
 * 主人当天截图问：「为什么要用我的会话来测试」—— 查下来是我的自检一直连着
 * 8788（主人开着的那个实例），CDP 浏览器也打开的是同一个页面。于是：
 *   · 真机检查在主人窗口的输入框里塞字、按回车 → 真的发出去了，
 *     在「办事鱼」会话里留下几条「你好」和一串小白曦口吻的回复；
 *   · 造临时会话、开关智能体、切换面板，全都改在主人那份数据上。
 *
 * 这个模块提供一套「用完就扔」的隔离环境：
 *   · 独立服务进程：MINI_AGENT_DATA 指向临时目录，PORT 指到 8795；
 *   · 临时目录里只复制配置（models/settings/卡表…），**绝不带 sessions/**；
 *   · 独立 Edge（headless + 独立 profile），打开的是隔离实例的页面；
 *   · stop() 杀干净两个进程、删掉临时目录。
 *
 * 调用方（run-all-checks.mjs）必须把返回的 env 传给每一个检查子进程。
 * 起不来就抛错，绝不「自动探测」退回 8788 —— 静默退回等于这道闸白装。
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, copyFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(process.cwd());
/**
 * 【2026-11-10 修·本机路径写死】
 *
 * 原来 USER_DATA 写死 'C:/Users/35453/AppData/Roaming/小鱼Agent/data'，
 * EDGE 写死 'C:/Program Files (x86)/...'。
 * 主人问「我这台能跑的在别人电脑上会不会有问题」——这就是典型：
 * 别人机器上用户名不是 35453，路径不存在 → 隔离实例起不来、所有 CDP 检查全废。
 * 而且这两个路径跟着源码发布出去了。
 *
 * 现在：
 *   · USER_DATA 从 %APPDATA% 推（Windows 上就是 C:\Users\<谁>\AppData\Roaming）
 *   · EDGE 依次找常见安装位置，都没有就留空（调用方自己报「没找到浏览器」）
 *   · 都支持环境变量覆盖：XY_USER_DATA / XY_EDGE
 */
const USER_DATA = process.env.XY_USER_DATA
  || join(process.env.APPDATA || join(process.env.USERPROFILE || process.env.HOME || '', 'AppData', 'Roaming'), '小鱼Agent', 'data');

const EDGE = (() => {
  if (process.env.XY_EDGE) return process.env.XY_EDGE;
  const cands = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    join(process.env.LOCALAPPDATA || '', 'Microsoft/Edge/Application/msedge.exe'),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ];
  for (const c of cands) {
    try { if (c && existsSync(c)) return c; } catch { /* 试下一个 */ }
  }
  return '';
})();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 只带配置、不带任何会话：主人的聊天记录一个字节都不进临时目录 */
function seedConfig(dst) {
  const srcState = join(USER_DATA, '.state');
  const dstState = join(dst, '.state');
  mkdirSync(dstState, { recursive: true });
  /* 空目录，但得存在：有些检查（check-reset）直接 writeFileSync 造测试会话。 */
  mkdirSync(join(dstState, 'sessions'), { recursive: true });
  if (!existsSync(srcState)) return 0;
  let n = 0;
  for (const name of readdirSync(srcState)) {
    if (name === 'sessions') continue;                 // 会话：绝不复制
    if (/\.bak|backup|orphan/i.test(name)) continue;   // 备份/垃圾：不带
    const p = join(srcState, name);
    try {
      if (!statSync(p).isFile()) continue;             // 只复制散装配置文件
      if (statSync(p).size > 4 * 1024 * 1024) continue;
      copyFileSync(p, join(dstState, name));
      n++;
    } catch {}
  }
  /* 根目录下几个散装配置（persona 之类）也带上，但同样排除会话 */
  try {
    for (const name of readdirSync(USER_DATA)) {
      if (name === '.state' || name === 'sessions' || name === 'code' || name === 'public') continue;
      const p = join(USER_DATA, name);
      if (!statSync(p).isFile()) continue;
      if (statSync(p).size > 4 * 1024 * 1024) continue;
      if (/\.bak|backup/i.test(name)) continue;
      copyFileSync(p, join(dst, name));
      n++;
    }
  } catch {}
  /* 运行版网页直接用仓库的 public/：
   * ① 隔离实例打开的就是最新前端，不会验了一份旧页面；
   * ② check-chat-e2e 要「仓库 == 生效版逐字节」，源和目标本来就是同一份文件。
   *
   * 【2026-11-09 坑】这里原来用 cpSync(recursive) —— 环境的「安全写入」垫片
   * 会直接把整个 node 进程静默干掉（退出码 127、一行输出都没有，catch 也接不到）。
   * 改成逐文件 copyFileSync，四个文件，快且不碰垫片。 */
  try {
    const pubSrc = join(ROOT, 'public');
    const pubDst = join(dst, 'public');
    mkdirSync(pubDst, { recursive: true });
    const copyFlat = (srcDir, dstDir) => {
      mkdirSync(dstDir, { recursive: true });
      for (const name of readdirSync(srcDir)) {
        const sp = join(srcDir, name);
        const dp = join(dstDir, name);
        const st = statSync(sp);
        if (st.isDirectory()) { copyFlat(sp, dp); continue; }
        if (st.isFile()) { copyFileSync(sp, dp); n++; }
      }
    };
    copyFlat(pubSrc, pubDst);
  } catch {}
  return n;
}

async function portFree(port) {
  try {
    const r = await fetch('http://127.0.0.1:' + port + '/api/health', { signal: AbortSignal.timeout(1200) });
    return !r.ok; // 有服务在听就不能用
  } catch { return true; }
}

/**
 * @returns {Promise<{base:string, dataDir:string, env:object, stop:()=>Promise<void>}>}
 */
export async function startIsolated({ appPort = 8795, cdpPort = 9223 } = {}) {
  /* 【2026-11-09 加·上一轮没退干净，下一轮整个跑不起来】
   * 自检中途被打断（Ctrl+C、被停、进程被强杀）时，临时实例和它的无头浏览器
   * 会活下来占着 8795 / 9223。以前这里直接抛「端口被占用」→ 后面每一轮回归
   * 都起不来，只能手工去杀进程。
   *
   * 现在：**换一个空闲端口**（8795→8796→…），既不碰别人的实例，也不卡死自己。
   * 只有整段都被占满才报错 —— 那说明真有问题，该人来看。 */
  const pickFree = async (start, probe) => {
    for (let p = start; p < start + 12; p++) {
      if (await probe(p)) return p;
    }
    throw new Error('端口 ' + start + '~' + (start + 11) + ' 全被占用，没法起隔离实例');
  };
  appPort = await pickFree(appPort, portFree);
  cdpPort = await pickFree(cdpPort, portFreeProbe);

  const dataDir = mkdtempSync(join(tmpdir(), 'xy-check-'));
  const copied = seedConfig(dataDir);
  const profile = join(dataDir, 'edge-profile');
  mkdirSync(profile, { recursive: true });

  let boot = '';
  const server = spawn(process.execPath, ['src/server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, MINI_AGENT_DATA: dataDir, PORT: String(appPort), XY_TEST_INSTANCE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  /* 【2026-11-11 加·诊断通道】检查脚本排 e2e 问题时需要看服务端日志。
   * 默认不转发（别污染回归输出）；设 XY_INSTANCE_LOG=1 才转发。 */
  if (process.env.XY_INSTANCE_LOG) {
    server.stdout.on('data', (d) => process.stdout.write('[srv] ' + String(d)));
    server.stderr.on('data', (d) => process.stdout.write('[srv!] ' + String(d)));
  }
  server.stdout.on('data', (d) => { boot += String(d); });
  server.stderr.on('data', (d) => { boot += String(d); });

  let base = '';
  try {
    for (let i = 0; i < 60; i++) {
      const m = /running:\s*http:\/\/127\.0\.0\.1:(\d+)/.exec(boot);
      if (m) {
        const tryBase = 'http://127.0.0.1:' + m[1];
        try { if ((await fetch(tryBase + '/api/health')).ok) { base = tryBase; break; } } catch {}
      }
      await sleep(300);
    }
    if (!base) throw new Error('隔离实例没起来：' + boot.split('\n').slice(-6).join(' | ').slice(0, 240));

    /* 浏览器打开的是隔离实例，不是主人窗口 */
    const edge = spawn(EDGE, [
      '--headless=new', '--disable-gpu', '--no-first-run',
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--remote-debugging-port=' + cdpPort,
      '--user-data-dir=' + profile,
      base,
    ], { stdio: 'ignore', windowsHide: true });

    /* 等 CDP 里真出现这个页面；连不上就失败，不许偷偷用旧窗口 */
    let pageOk = false;
    for (let i = 0; i < 50; i++) {
      try {
        const list = await fetch('http://127.0.0.1:' + cdpPort + '/json/list').then((r) => r.json());
        if (list.some((t) => t.type === 'page' && String(t.url || '').startsWith(base))) { pageOk = true; break; }
      } catch {}
      await sleep(300);
    }
    if (!pageOk) throw new Error('调试浏览器没打开隔离页面（' + base + '）');

    const env = {
      ...process.env,
      BASE: base,                       // detectBase() 优先读它，所有检查自动指向隔离实例
      XY_CDP_PORT: String(cdpPort),
      XY_TEST_DATA: dataDir,            // sweep() 只清这个目录里的垃圾
      XY_REQUIRE_ISOLATED: '1',         // detectBase() 的保险：没 BASE 就抛错
      MINI_AGENT_DATA: dataDir,
    };

    const kill = (proc) => {
      if (!proc || proc.killed || proc.exitCode != null) return;
      try { spawnSyncKill(proc.pid); } catch {}
      try { proc.kill(); } catch {}
    };
    const wipe = async () => {
      /* Windows 上 Edge 的一串子进程会短暂 hold 住 edge-profile 目录，一次删不掉就重试 */
      for (let i = 0; i < 8; i++) {
        try { rmSync(dataDir, { recursive: true, force: true }); return true; } catch {}
        await sleep(250);
      }
      return false;
    };
    /* 【2026-11-11 补】脚本被掐断/异常退出时不一定走 stop()，那样目录就永远留着。
     * 之前攒了 676 个 xy-check-* 死目录没人清。这里挂个兜底：进程退出时同步删。 */
    const onExit = () => { try { rmSync(dataDir, { recursive: true, force: true }); } catch {} };
    process.once("exit", onExit);
    const stop = async () => {
      kill(edge);
      kill(server);
      await sleep(600);
      process.removeListener("exit", onExit);
      await wipe();
    };

    return { base, dataDir, cdpPort, copied, env, stop };
  } catch (e) {
    try { server.kill(); } catch {}
    try { rmSync(dataDir, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

/** Windows 上 Edge 会带一串子进程，只 kill 主进程会留一堆 */
function spawnSyncKill(pid) {
  try {
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {}
}

/** CDP 端口占没占：能 /json/version 就是占着 */
async function portFreeProbe(port) {
  try {
    await fetch('http://127.0.0.1:' + port + '/json/version', { signal: AbortSignal.timeout(1200) });
    return false;
  } catch { return true; }
}
