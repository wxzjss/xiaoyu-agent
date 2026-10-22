// 端到端：模型是否真的会调用 web_search 并拿真实结果回答
const http = require('node:http');

function chat(sessionId, message) {
  return new Promise((resolve) => {
    const d = JSON.stringify({ sessionId, message });
    const events = [];
    const q = http.request(
      { host: '127.0.0.1', port: 8787, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i).trim();
            buf = buf.slice(i + 2);
            if (!chunk.startsWith('data:')) continue;
            try {
              const ev = JSON.parse(chunk.slice(5).trim());
              events.push(ev);
              if (['done', 'error', 'aborted'].includes(ev.type)) { res.destroy(); resolve(events); return; }
            } catch {}
          }
        });
        res.on('end', () => resolve(events));
      },
    );
    q.on('error', () => resolve(events));
    q.write(d);
    q.end();
  });
}

(async () => {
  const sid = process.argv[2];
  const q = process.argv[3] || '用联网搜索查一下 DeepSeek V4.1 Flash 是哪天发布的，把搜到的标题和链接念给我。';

  console.log('=== 工具清单里有没有 web_search ===');
  const { enabledToolSchemas } = await import('file:///D:/小鱼Agent/src/tools.mjs');
  console.log(enabledToolSchemas().map((t) => t.function.name).join(','));

  console.log('\n=== 提问 ===\n' + q);
  const events = await chat(sid, q);
  for (const e of events) {
    if (e.type === 'tool_start') console.log('[tool_start] ' + e.name + ' ' + JSON.stringify(e.args || {}).slice(0, 160));
    if (e.type === 'tool_end') console.log('[tool_end] ok=' + e.ok + ' ' + String(e.output || e.result || '').slice(0, 300).replace(/\n/g, ' ⏎ '));
    if (e.type === 'text') process.stdout.write(e.text);
    if (e.type === 'error') console.log('\n[error] ' + JSON.stringify(e).slice(0, 300));
    if (e.type === 'done') console.log('\n[done]');
  }
})();
