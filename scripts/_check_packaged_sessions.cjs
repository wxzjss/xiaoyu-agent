// 打包版实测第二轮：确认会话列表里有历史
const { spawn, execSync } = require('node:child_process');
const path = require('node:path');

const EXE = path.join(__dirname, '..', 'dist', 'installer', 'win-unpacked', '小鱼Agent.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ports() {
  try {
    const tl = execSync('tasklist /FI "IMAGENAME eq 小鱼Agent.exe" /FO CSV /NH', { encoding: 'utf8', windowsHide: true });
    const pids = new Set(tl.split(/\r?\n/).map((l) => l.split('","')[1]).filter((x) => x && /^\d+$/.test(x)));
    if (!pids.size) return [];
    const ns = execSync('netstat -ano -p TCP', { encoding: 'utf8', windowsHide: true });
    const out = new Set();
    for (const line of ns.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/i);
      if (m && pids.has(m[3])) out.add(Number(m[2]));
    }
    return [...out];
  } catch {
    return [];
  }
}

(async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.MINI_AGENT_DATA;
  const c = spawn(EXE, [], { env, detached: true, stdio: 'ignore' });
  c.unref();
  await sleep(9000);
  const ps = ports();
  console.log('端口: ' + ps.join(','));
  const port = ps[0];
  if (!port) return;
  const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json();
  console.log('health: ' + JSON.stringify(h));
  const s = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
  const list = s.sessions || s;
  console.log(`会话数: ${Array.isArray(list) ? list.length : '?'}`);
  if (Array.isArray(list)) {
    for (const x of list) console.log(` - ${x.id} 「${x.title || ''}」 ${x.messageCount ?? x.count ?? ''} 条`);
  }
})();
