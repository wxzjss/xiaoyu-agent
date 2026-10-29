const base = 'http://127.0.0.1:8787';
const call = async (m, p, b) => {
  const o = m === 'GET' ? {} : { method: m, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b || {}) };
  const r = await fetch(base + p, o);
  return { status: r.status, data: await r.json().catch(() => null) };
};
(async () => {
  const a1 = await call('POST', '/api/agents/add', { name: '阿甲', persona: '我是阿甲。' });
  const a2 = await call('POST', '/api/agents/add', { name: '阿乙', persona: '我是阿乙。' });
  const a3 = await call('POST', '/api/agents/add', { name: '阿丙', persona: '我是阿丙。' });
  const id1 = a1.data.agent.id, id2 = a2.data.agent.id, id3 = a3.data.agent.id;
  const s1 = await call('POST', '/api/sessions/new', { agentIds: [id3, id1, id2] });
  console.log('按 丙甲 乙 建会话 ->', JSON.stringify(s1.data && s1.data.groupAgentIds));
  const g1 = await call('GET', '/api/agents/group?sessionId=' + s1.data.session.id);
  console.log('再读一次 ->', JSON.stringify(g1.data.agentIds));
  console.log('名字 ->', JSON.stringify(g1.data.names));
})();
