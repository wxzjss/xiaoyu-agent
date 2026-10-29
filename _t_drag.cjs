// 临时：在真 Electron 里模拟「按住 → 等长按 → 往上拖 → 松手」，看「屋里的人」顺序到底变不变。
// 这是上一版最缺的一步：以前只验证过 CSS 和接口，从来没真的用指针事件拖过。
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!app.isReady()) app.disableHardwareAcceleration();

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-drag-'));
fs.mkdirSync(path.join(data, '.state'), { recursive: true });
fs.writeFileSync(path.join(data, '.state', 'models.json'), JSON.stringify({ models: [], activeId: '', hideEnv: true }));

const envPort = fs.readFileSync(path.join('D:\\小鱼Agent', '.env'), 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m);
const port = envPort ? Number(envPort[1]) : 8787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = [];
const say = (s) => { log.push(s); console.log(s); };

(async () => {
  await (app.isReady() ? Promise.resolve() : app.whenReady());
  const srv = spawn(process.execPath, ['src/server.mjs'], {
    cwd: 'D:\\小鱼Agent', env: { ...process.env, MINI_AGENT_DATA: data }, stdio: 'ignore',
  });
  for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/')).ok) break; } catch {} await sleep(250); }

  const api = async (p, body) => {
    const o = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const r = await fetch('http://127.0.0.1:' + port + p, o);
    return r.json().catch(() => null);
  };

  const ns = await api('/api/sessions/new', {});
  const sid = ns?.session?.id;
  const a1 = await api('/api/agents/add', { name: '阿蓝', persona: '我是阿蓝。' });
  const a2 = await api('/api/agents/add', { name: '阿绿', persona: '我是阿绿。' });
  await api('/api/agents/group', { sessionId: sid, agentIds: ['xiaoyu', 'xiaojing', a1.agent.id, a2.agent.id] });
  const before = (await api('/api/agents/group?sessionId=' + encodeURIComponent(sid)))?.agentIds;
  say('拖动前顺序：' + JSON.stringify(before));

  const win = new BrowserWindow({ width: 1240, height: 900, show: true });
  await win.loadURL('http://127.0.0.1:' + port + '/');
  await sleep(2500);
  await win.webContents.executeJavaScript(`(async () => {
    window.sessionId = ${JSON.stringify(sid)};
    await loadTopCfg();
    await refreshWhoRail();
    return true;
  })()`);
  await sleep(800);

  const rects = await win.webContents.executeJavaScript(`(() => {
    const rail = document.getElementById('whoRail');
    return [...rail.querySelectorAll('.whoBtn')].map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.dataset.agentId, name: b.textContent, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
  })()`);
  say('牌子位置：' + JSON.stringify(rects));

  // 从最后一颗（阿绿）按住 → 等 400ms → 一路往上挪到第一颗上面 → 松手
  const from = rects[rects.length - 1];
  const to = rects[0];
  win.webContents.sendInputEvent({ type: 'mouseDown', x: from.x, y: from.y, button: 'left', clickCount: 1 });
  await sleep(420);
  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const y = Math.round(from.y + (to.y - 12 - from.y) * (i / steps));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: from.x, y, button: 'left', movementX: 0, movementY: 0 });
    await sleep(30);
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: from.x, y: to.y - 12, button: 'left', clickCount: 1 });
  await sleep(1200);

  const railNow = await win.webContents.executeJavaScript(`(() => {
    const rail = document.getElementById('whoRail');
    return [...rail.querySelectorAll('.whoBtn')].map((b) => b.dataset.agentId);
  })()`);
  say('拖完界面上的顺序：' + JSON.stringify(railNow));
  const after = (await api('/api/agents/group?sessionId=' + encodeURIComponent(sid)))?.agentIds;
  say('服务端记下的顺序：' + JSON.stringify(after));

  const movedUp = railNow[0] === from.id;
  say((movedUp ? 'ok  ' : 'FAIL') + '她真的被拖到最上面了');
  say((JSON.stringify(after) === JSON.stringify(railNow) ? 'ok  ' : 'FAIL') + '服务端跟界面一致');

  // 再验一次：拖到中间
  await sleep(200);
  const r2 = await win.webContents.executeJavaScript(`(() => {
    const rail = document.getElementById('whoRail');
    return [...rail.querySelectorAll('.whoBtn')].map((b) => {
      const r = b.getBoundingClientRect();
      return { id: b.dataset.agentId, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    });
  })()`);
  const f2 = r2[0], t2 = r2[2];
  win.webContents.sendInputEvent({ type: 'mouseDown', x: f2.x, y: f2.y, button: 'left', clickCount: 1 });
  await sleep(420);
  for (let i = 1; i <= 10; i++) {
    const y = Math.round(f2.y + (t2.y - f2.y) * (i / 10));
    win.webContents.sendInputEvent({ type: 'mouseMove', x: f2.x, y, button: 'left', movementX: 0, movementY: 0 });
    await sleep(30);
  }
  win.webContents.sendInputEvent({ type: 'mouseUp', x: f2.x, y: t2.y, button: 'left', clickCount: 1 });
  await sleep(1200);
  const rail3 = await win.webContents.executeJavaScript(`(() => {
    const rail = document.getElementById('whoRail');
    return [...rail.querySelectorAll('.whoBtn')].map((b) => b.dataset.agentId);
  })()`);
  const after3 = (await api('/api/agents/group?sessionId=' + encodeURIComponent(sid)))?.agentIds;
  say('第二次拖完界面：' + JSON.stringify(rail3));
  say('第二次服务端：' + JSON.stringify(after3));
  say((JSON.stringify(after3) === JSON.stringify(rail3) ? 'ok  ' : 'FAIL') + '第二次也存上了');

  const png = await win.capturePage();
  fs.writeFileSync('D:\\小鱼Agent\\_drag.png', Buffer.from(png.toPNG()));
  say('---- ' + log.filter((x) => x.startsWith('ok')).length + ' 过 / ' + log.filter((x) => x.startsWith('FAIL')).length + ' 败');
  try { srv.kill(); } catch {}
  try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  app.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
