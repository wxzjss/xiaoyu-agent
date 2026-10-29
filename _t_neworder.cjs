// 验收：新建会话的挑人框里，勾上的人会落到「已勾那一串」的末尾、能按住上下拖，
// 提交之后左侧「屋里的人」就按这个从上往下排。
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!app.isReady()) app.disableHardwareAcceleration();

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-nsord-'));
fs.mkdirSync(path.join(data, '.state'), { recursive: true });
fs.writeFileSync(path.join(data, '.state', 'models.json'), JSON.stringify({ models: [], activeId: '', hideEnv: true }));
const envPort = fs.readFileSync(path.join('D:\\小鱼Agent', '.env'), 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m);
const port = envPort ? Number(envPort[1]) : 8787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const say = (ok, name, extra) => { if (ok) pass++; else fail++; console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };

(async () => {
  await (app.isReady() ? Promise.resolve() : app.whenReady());
  const srv = spawn(process.execPath, ['src/server.mjs'], { cwd: 'D:\\小鱼Agent', env: { ...process.env, MINI_AGENT_DATA: data }, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) { try { if ((await fetch('http://127.0.0.1:' + port + '/')).ok) break; } catch {} await sleep(250); }
  const api = async (p, body) => {
    const o = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    return (await fetch('http://127.0.0.1:' + port + p, o)).json().catch(() => null);
  };
  const a1 = await api('/api/agents/add', { name: '阿甲', persona: '我是阿甲。' });
  const a2 = await api('/api/agents/add', { name: '阿乙', persona: '我是阿乙。' });
  const a3 = await api('/api/agents/add', { name: '阿丙', persona: '我是阿丙。' });
  const ids = [a1.agent.id, a2.agent.id, a3.agent.id];

  const win = new BrowserWindow({ width: 1240, height: 900, show: true });
  await win.loadURL('http://127.0.0.1:' + port + '/');
  await sleep(2500);

  // 1) 打开挑人框，按 阿丙 → 阿甲 的顺序勾（先勾的该排前面）
  const pick = await win.webContents.executeJavaScript(`(async () => {
    await openNewSessionDlg();
    const list = document.getElementById('nsList');
    const rows = [...list.querySelectorAll('.nsRow')];
    const byName = (n) => rows.find((r) => r.querySelector('.nm').textContent === n);
    const click = (n) => { const cb = byName(n).querySelector('input[type="checkbox"]'); cb.click(); };
    click('阿丙');
    await new Promise((r) => setTimeout(r, 60));
    click('阿甲');
    await new Promise((r) => setTimeout(r, 60));
    const picked = [...list.querySelectorAll('.nsRow.picked')].map((r) => r.querySelector('.nm').textContent);
    const ords = [...list.querySelectorAll('.nsRow.picked')].map((r) => r.querySelector('.ord').textContent);
    return { picked, ords };
  })()`);
  say(JSON.stringify(pick.picked) === JSON.stringify(['阿丙', '阿甲']), '勾的先后就是列表从上往下的次序', JSON.stringify(pick.picked));
  say(JSON.stringify(pick.ords) === JSON.stringify(['1', '2']), '勾上的人带上了序号', JSON.stringify(pick.ords));

  // 2) 按住「阿甲」拖到「阿丙」上面
  const drag = await win.webContents.executeJavaScript(`(async () => {
    const list = document.getElementById('nsList');
    const rows = [...list.querySelectorAll('.nsRow')];
    const byName = (n) => rows.find((r) => r.querySelector('.nm').textContent === n);
    const from = byName('阿甲'), to = byName('阿丙');
    const rf = from.getBoundingClientRect(), rt = to.getBoundingClientRect();
    const x = Math.round(rf.x + rf.width / 2);
    const y0 = Math.round(rf.y + rf.height / 2);
    const yTo = Math.round(rt.y + 2);
    const mk = (t, y, extra) => new PointerEvent(t, Object.assign({ bubbles: true, cancelable: true, pointerId: 5, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }, extra || {}));
    from.dispatchEvent(mk('pointerdown', y0));
    await new Promise((r) => setTimeout(r, 40));
    for (let i = 1; i <= 6; i++) {
      const y = Math.round(y0 + (yTo - y0) * (i / 6));
      document.dispatchEvent(mk('pointermove', y));
      await new Promise((r) => setTimeout(r, 30));
    }
    document.dispatchEvent(mk('pointerup', yTo, { buttons: 0 }));
    await new Promise((r) => setTimeout(r, 80));
    return {
      picked: [...list.querySelectorAll('.nsRow.picked')].map((r) => r.querySelector('.nm').textContent),
      ords: [...list.querySelectorAll('.nsRow.picked')].map((r) => r.querySelector('.ord').textContent),
    };
  })()`);
  say(JSON.stringify(drag.picked) === JSON.stringify(['阿甲', '阿丙']), '拖一下，次序跟着换', JSON.stringify(drag.picked));
  say(JSON.stringify(drag.ords) === JSON.stringify(['1', '2']), '序号跟着重排', JSON.stringify(drag.ords));

  // 3) 提交 → 左侧「屋里的人」按这个排
  await win.webContents.executeJavaScript(`(async () => { await submitNewSession(); return true; })()`);
  await sleep(1800);
  const rail = await win.webContents.executeJavaScript(`(() => {
    const sid = window.__xyGetSessionId();
    return { sid, order: [...document.querySelectorAll('#whoRail .whoBtn')].map((b) => b.textContent) };
  })()`);
  say(JSON.stringify(rail.order) === JSON.stringify(['小鱼', '阿甲', '阿丙', '小鲸']),
    '左侧「屋里的人」按挑人框的次序排下来了', JSON.stringify(rail.order));
  const api2 = await api('/api/agents/group?sessionId=' + encodeURIComponent(rail.sid));
  say(JSON.stringify(api2.names) === JSON.stringify(['小鱼', '阿甲', '阿丙', '小鲸']),
    '服务端存的就是这个次序', JSON.stringify(api2.names));

  console.log('---- ' + pass + ' 过 / ' + fail + ' 败');
  try { srv.kill(); } catch {}
  try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  app.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
