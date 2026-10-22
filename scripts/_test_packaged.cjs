// 打包后实测：起 exe → 找端口 → 健康/设置/模型三种回环 → 报结果
// 用法：node scripts/_test_packaged.cjs
const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EXE = path.join(__dirname, '..', 'dist', 'installer', 'win-unpacked', '小鱼Agent.exe');
const DATA = path.join(process.env.APPDATA, 'xiaoyu-mini-agent', 'data');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function envClean() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MINI_AGENT_DATA;
  return env;
}

/** 用小鱼的 pid 去 netstat 里找监听端口（不依赖 PowerShell） */
function listeningPortsOfImage(imageName) {
  try {
    const tl = execSync(`tasklist /FI "IMAGENAME eq ${imageName}.exe" /FO CSV /NH`, { encoding: 'utf8', windowsHide: true });
    const pids = new Set(
      tl
        .split(/\r?\n/)
        .map((l) => l.split('","')[1])
        .filter((x) => x && /^\d+$/.test(x)),
    );
    if (!pids.size) return [];
    const ns = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true });
    const ports = new Set();
    for (const line of ns.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && pids.has(m[3])) ports.add(Number(m[2]));
    }
    return [...ports];
  } catch (e) {
    console.log('   (找端口失败: ' + e.message + ')');
    return [];
  }
}

async function health(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/health`);
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

async function waitHealth(port, tries = 40) {
  for (let i = 0; i < tries; i++) {
    const h = await health(port);
    if (h) return h;
    await sleep(500);
  }
  return null;
}

function kill() {
  try {
    execSync(`pwsh -NoProfile -Command "Get-Process -Name '小鱼Agent' -ErrorAction SilentlyContinue | Stop-Process -Force"`);
  } catch {}
}

(async () => {
  const log = [];
  const say = (s) => {
    console.log(s);
    log.push(s);
  };

  kill();
  await sleep(1500);

  // 清一遍上次的数据目录，模拟全新安装（会备份）
  if (fs.existsSync(DATA)) {
    const bak = DATA + '.bak-' + Date.now();
    fs.renameSync(DATA, bak);
    say(`旧数据目录已备份 → ${path.basename(bak)}`);
  }

  say(`\n【1】启动 ${path.basename(EXE)}（不带 ELECTRON_RUN_AS_NODE）`);
  const child = spawn(EXE, [], { env: envClean(), detached: true, stdio: 'ignore' });
  child.unref();
  await sleep(8000);

  const ports = listeningPortsOfImage('小鱼Agent');
  say(`   进程存活=${!child.killed} 监听端口=[${ports.join(',')}]`);
  if (!ports.length) {
    say('   ✗ 没有监听端口，启动失败');
    process.exit(1);
  }
  const port = ports[0];
  const h1 = await waitHealth(port);
  say(`   health: ${JSON.stringify(h1)}`);
  if (!h1) {
    say('   ✗ 健康检查不通');
    process.exit(1);
  }

  say(`\n【2】数据目录 ${DATA}`);
  const stateDir = path.join(DATA, '.state');
  say(`   .state 存在=${fs.existsSync(stateDir)} 内容=${fs.existsSync(stateDir) ? fs.readdirSync(stateDir).join(',') : '-'}`);
  say(`   workspace 存在=${fs.existsSync(path.join(DATA, 'workspace'))}`);

  say('\n【3】设置写盘回环 POST /api/settings');
  const before = await (await fetch(`http://127.0.0.1:${port}/api/settings`)).json();
  const lines = [].concat(before.settings.bottomLines || []);
  const probe = lines.concat(['【打包自测行】本次写入']);
  const w = await (
    await fetch(`http://127.0.0.1:${port}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bottomLines: probe, safeWords: before.settings.safeWords, safeWordNote: before.settings.safeWordNote }),
    })
  ).json();
  const onDisk = JSON.parse(fs.readFileSync(path.join(stateDir, 'settings.json'), 'utf8'));
  say(`   写入后最后一行=${onDisk.bottomLines.at(-1)}`);
  say(`   落盘文件确实在数据目录=${fs.existsSync(path.join(stateDir, 'settings.json'))}`);
  // 还原
  await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bottomLines: lines, safeWords: before.settings.safeWords, safeWordNote: before.settings.safeWordNote }),
  });
  say('   已还原');

  say('\n【4】配置模型（走界面同一条接口 /api/models/save）');
  const envTxt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const pick = (k) => (envTxt.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1];
  const key = (pick('WANZI_API_KEY') || '').trim();
  const baseURL = (pick('BASE_URL') || '').trim();
  const model = (pick('MODEL') || '').trim();
  const saved = await (
    await fetch(`http://127.0.0.1:${port}/api/models/save`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseURL, model, apiKey: key, label: '打包自测' }),
    })
  ).json();
  say(`   save 返回: ${JSON.stringify(saved).slice(0, 200)}`);
  const h2 = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  say(`   health 现在: hasKey=${h2.hasKey} model=${h2.model} source=${h2.source}`);

  say('\n【5】真调一次模型 /api/models/test');
  const t = await (
    await fetch(`http://127.0.0.1:${port}/api/models/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
  ).json();
  say(`   test 返回: ${JSON.stringify(t).slice(0, 400)}`);

  say('\n【6】关实例');
  kill();
  say('   done');
  fs.writeFileSync(path.join(__dirname, '..', '.state', 'packaged-test.log'), log.join('\n'), 'utf8');
})();
