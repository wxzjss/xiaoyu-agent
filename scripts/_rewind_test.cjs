// 回退功能的端到端测试：造几轮对话 → 回退 → 校验磁盘/接口三者一致
const http = require('node:http');

const PORT = 8787;
const SID = process.argv[2];

function req(method, path, obj) {
  return new Promise((r) => {
    const d = obj ? JSON.stringify(obj) : null;
    const q = http.request(
      { host: '127.0.0.1', port: PORT, path, method, headers: d ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } : {} },
      (res) => {
        let b = '';
        res.on('data', (c) => (b += c));
        res.on('end', () => r({ status: res.statusCode, body: b }));
      },
    );
    q.on('error', (e) => r({ status: 0, body: 'ERR ' + e.message }));
    if (d) q.write(d);
    q.end();
  });
}

/** 跑一轮对话，等到 done */
function chat(sessionId, message) {
  return new Promise((resolve) => {
    const d = JSON.stringify({ sessionId, message });
    const events = [];
    const q = http.request(
      { host: '127.0.0.1', port: PORT, path: '/api/chat', method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } },
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
              if (ev.type === 'done' || ev.type === 'error' || ev.type === 'aborted') {
                res.destroy();
                resolve({ events });
                return;
              }
            } catch {}
          }
        });
        res.on('end', () => resolve({ events }));
      },
    );
    q.on('error', () => resolve({ events }));
    q.write(d);
    q.end();
  });
}

(async () => {
  const say = (m) => console.log(m);

  // 轮 1：纯聊天
  const r1 = await chat(SID, '记住一个数字：42。只回「好」。');
  say('turn1 events=' + r1.events.map((e) => e.type).join(','));
  say('turn1 text=' + r1.events.filter((e) => e.type === 'text').map((e) => e.text).join('').slice(0, 80));

  // 轮 2：写文件（触发快照）
  const r2 = await chat(SID, '在工作区写一个文件 rewind-demo.txt，内容写 hello-rewind。');
  say('turn2 tools=' + r2.events.filter((e) => e.type === 'tool_start').map((e) => e.name).join(','));

  // 轮 3：纯聊天
  const r3 = await chat(SID, '刚才让你记的数字是多少？只回数字。');
  say('turn3 text=' + r3.events.filter((e) => e.type === 'text').map((e) => e.text).join('').slice(0, 80));

  const before = await req('GET', '/api/sessions');
  const sess = JSON.parse(before.body).sessions.find((s) => s.id === SID);
  say('turns before rewind: ' + JSON.stringify(sess));

  // 取完整会话，找第 1 条用户消息的下标
  const full = await req('POST', '/api/sessions/select', { id: SID });
  const turns = JSON.parse(full.body).session.turns;
  say('turn list: ' + turns.map((t) => t.role + '#' + t.rewindId + ':' + String(t.text).slice(0, 18).replace(/\n/g, ' ')).join(' | '));

  const user1 = turns.find((t) => t.role === 'user');
  const preview = await req('POST', '/api/sessions/rewind-preview', { id: SID, at: user1.rewindId });
  say('preview: ' + preview.body);

  const rw = await req('POST', '/api/sessions/rewind', { id: SID, at: user1.rewindId });
  const rwj = JSON.parse(rw.body);
  say('rewind status=' + rw.status + ' turns=' + (rwj.session?.turns || []).length + ' files=' + JSON.stringify(rwj.files));

  const after = await req('POST', '/api/sessions/select', { id: SID });
  const at = JSON.parse(after.body).session;
  say('turns after rewind: ' + at.turns.map((t) => t.role + '#' + t.rewindId + ':' + String(t.text).slice(0, 18).replace(/\n/g, ' ')).join(' | '));
  say('rewinds: ' + JSON.stringify(at.rewinds));

  // 磁盘上老消息是否还在（只遮蔽不删除）
  const fs = require('node:fs');
  const raw = JSON.parse(fs.readFileSync('D:/小鱼Agent/.state/sessions/' + SID + '.json', 'utf8'));
  say('messages on disk: ' + raw.messages.length + ' (should still contain every turn)');
  say('rewind-demo.txt exists: ' + fs.existsSync('D:/小鱼Agent/sandbox/rewind-demo.txt'));

  // 撤销回退
  const un = await req('POST', '/api/sessions/rewind-undo', { id: SID });
  const unj = JSON.parse(un.body);
  say('undo status=' + un.status + ' turns=' + (unj.session?.turns || []).length);
})();
