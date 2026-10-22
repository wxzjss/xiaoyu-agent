// 打包版真跑一轮对话（SSE），证明 agent 循环 + 工具 + 落盘都在 exe 里能用
const port = Number(process.argv[2] || 55120);
const sid = 'smvpacksmoke0001';

async function turn(message) {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: sid, message }),
  });
  if (!res.ok) {
    console.log('HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let text = '';
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = raw.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(6));
      } catch {
        continue;
      }
      events.push(ev.type);
      if (ev.type === 'text') text += ev.text || '';
    }
  }
  console.log('--- 事件类型: ' + [...new Set(events)].join(', '));
  console.log('--- 回复: ' + text.trim().slice(0, 400));
}

(async () => {
  console.log('【轮 1】问身份');
  await turn('你是谁呀，一句话说');
  console.log('\n【轮 2】让它动工具（写文件到工作目录）');
  await turn('在工作目录里建一个 pack-smoke.txt，内容写成 ok，然后用一句话告诉我结果');
  console.log('\n【轮 3】回读会话，确认落盘');
  const s = await (await fetch(`http://127.0.0.1:${port}/api/sessions`)).json();
  const mine = (s.sessions || []).find((x) => x.id === sid);
  console.log('会话存在=' + Boolean(mine) + ' 标题=' + (mine && mine.title) + ' 条数=' + (mine && mine.messageCount));
})();
