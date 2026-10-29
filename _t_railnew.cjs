// 临时：Electron 的 sendInputEvent 里鼠标拖动只送得出第一个 move（指针捕获也不生效），
// 所以「真拖一下」在这套工具下验证不了。改成 **直接派发 pointer 事件**，把
// 长按 + 连续 move + 松手整条链路走一遍 —— 这才是拖动逻辑真正吃的输入。
const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!app.isReady()) app.disableHardwareAcceleration();

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-drag4-'));
fs.mkdirSync(path.join(data, '.state'), { recursive: true });
fs.writeFileSync(path.join(data, '.state', 'models.json'), JSON.stringify({ models: [], activeId: '', hideEnv: true }));

const envPort = fs.readFileSync(path.join('D:\\小鱼Agent', '.env'), 'utf8').match(/^\s*PORT\s*=\s*(\d+)/m);
const port = envPort ? Number(envPort[1]) : 8787;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const say = (ok, name, extra = '') => { console.log((ok ? 'ok   ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); if (ok) pass++; else fail++; };

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
  const sid = ns && ns.session && ns.session.id;
  const a1 = await api('/api/agents/add', { name: '阿蓝', persona: '我是阿蓝。' });
  const a2 = await api('/api/agents/add', { name: '阿绿', persona: '我是阿绿。' });
  await api('/api/agents/group', { sessionId: sid, agentIds: ['xiaoyu', 'xiaojing', a1.agent.id, a2.agent.id] });

  const win = new BrowserWindow({ width: 1240, height: 900, show: true });
  await win.loadURL('http://127.0.0.1:' + port + '/');
  await sleep(2500);
  await win.webContents.executeJavaScript(`(async () => {
    // 别用 window.sessionId —— 页面里 sessionId 是用 let 声明的模块级变量，
    // 挂到 window 上根本改不到它，页面自己会挑一个会话（就是「会话列表第一个」），
    // 于是拖动存的顺序全存到别人的会话上去了。用页面给出的专用窗口换。
    window.__xySetSessionId(${JSON.stringify(sid)});
    await loadTopCfg();
    await refreshWhoRail();
    window.__drag = async (idFrom, yTo) => {
      const rail = document.getElementById('whoRail');
      const btn = [...rail.querySelectorAll('.whoBtn')].find((b) => b.dataset.agentId === idFrom);
      if (!btn) return { err: '没这颗牌' };
      const r0 = btn.getBoundingClientRect();
      const x = Math.round(r0.x + r0.width / 2);
      const y0 = Math.round(r0.y + r0.height / 2);
      const mk = (type, y, extra) => new PointerEvent(type, Object.assign({
        bubbles: true, cancelable: true, composed: true,
        pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1,
        clientX: x, clientY: y,
      }, extra || {}));
      btn.dispatchEvent(mk('pointerdown', y0));
      await new Promise((r) => setTimeout(r, 320));
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const y = Math.round(y0 + (yTo - y0) * (i / steps));
        const target = document.elementFromPoint(x, y) || document;
        target.dispatchEvent(mk('pointermove', y));
        await new Promise((r) => setTimeout(r, 25));
      }
      const upTarget = document.elementFromPoint(x, yTo) || document;
      upTarget.dispatchEvent(mk('pointerup', yTo, { buttons: 0 }));
      await new Promise((r) => setTimeout(r, 500));
      return { order: [...rail.querySelectorAll('.whoBtn')].map((b) => b.dataset.agentId) };
    };
    return true;
  })()`);

  const order0 = await win.webContents.executeJavaScript(`[...document.getElementById('whoRail').querySelectorAll('.whoBtn')].map((b) => b.dataset.agentId)`);
  say(true, '一开始的顺序', JSON.stringify(order0));

  const yTop = await win.webContents.executeJavaScript(`(() => {
    const b = document.querySelector('#whoRail .whoBtn');
    const r = b.getBoundingClientRect();
    return Math.round(r.top + 2);
  })()`);
  const lastId = order0[order0.length - 1];
  const r1 = await win.webContents.executeJavaScript(`window.__drag(${JSON.stringify(lastId)}, ${yTop})`);
  say(r1.order[0] === lastId, '最后一颗被拖到最上面', JSON.stringify(r1.order));

  const after1 = await api('/api/agents/group?sessionId=' + encodeURIComponent(sid));
  say(JSON.stringify(after1.agentIds) === JSON.stringify(r1.order), '服务端跟界面一致', JSON.stringify(after1.agentIds));

  const yMid = await win.webContents.executeJavaScript(`(() => {
    const bs = [...document.querySelectorAll('#whoRail .whoBtn')];
    const r = bs[2].getBoundingClientRect();
    return Math.round(r.top + r.height / 2);
  })()`);
  const r2 = await win.webContents.executeJavaScript(`window.__drag(${JSON.stringify(lastId)}, ${yMid})`);
  say(r2.order[2] === lastId || r2.order[1] === lastId, '再拖回中间也动得了', JSON.stringify(r2.order));

  const beforeClick = r2.order;
  const clicked = await win.webContents.executeJavaScript(`(() => {
    const rail = document.getElementById('whoRail');
    const b = [...rail.querySelectorAll('.whoBtn')][0];
    const r = b.getBoundingClientRect();
    const y = Math.round(r.y + r.height / 2);
    const x = Math.round(r.x + r.width / 2);
    const mk = (t, e) => new PointerEvent(t, Object.assign({ bubbles: true, cancelable: true, pointerId: 2, pointerType: 'mouse', isPrimary: true, button: 0, buttons: 1, clientX: x, clientY: y }, e || {}));
    return (async () => {
      b.dispatchEvent(mk('pointerdown'));
      await new Promise((res) => setTimeout(res, 80));
      b.dispatchEvent(mk('pointerup', { buttons: 0 }));
      b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await new Promise((res) => setTimeout(res, 900));
      return { order: [...rail.querySelectorAll('.whoBtn')].map((x2) => x2.dataset.agentId), id: b.dataset.agentId };
    })();
  })()`);
  say(JSON.stringify(clicked.order) === JSON.stringify(beforeClick), '短按一下不该改顺序', JSON.stringify(clicked.order));

  const grp = await api('/api/agents/group?sessionId=' + encodeURIComponent(sid));
  const first = grp.members.find((m) => m.id === clicked.id);
  say(first && first.enabled === false, '短按一下她该被关掉（小鱼小鲸现在也点得灭）', JSON.stringify(first));

  await win.webContents.executeJavaScript(`(() => {
    const rail = document.getElementById('whoRail');
    const b = [...rail.querySelectorAll('.whoBtn')].find((x) => x.dataset.agentId === ${JSON.stringify(clicked.id)});
    b.click();
    return true;
  })()`);
  await sleep(900);
  const grp2 = await api('/api/agents/group?sessionId=' + encodeURIComponent(sid));
  const again = grp2.members.find((m) => m.id === clicked.id);
  say(again && again.enabled !== false, '再点一下她又开着', JSON.stringify(again));

  console.log('---- ' + pass + ' 过 / ' + fail + ' 败');
  try { srv.kill(); } catch {}
  try { fs.rmSync(data, { recursive: true, force: true }); } catch {}
  app.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
