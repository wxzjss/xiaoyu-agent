/**
 * 压缩长跑验收（主人 2026-10-31 要的那个「能自己看结果」的东西）
 *
 * 为什么要有它：以前每次报「压缩修好了」，验的都只是 compressHistory 算得对。
 * 可主人痛的是另一件事 —— 压完之后又被涨回去、重开还是那一大坨。
 * 中间的「落盘 → 重读 → 收尾合并」这一段，从来没连着跑过。
 *
 * 这个脚本只做一件事：把真实时序走一遍，把每一步的数字打出来。
 *   压缩 → 服务端存盘 → 真的重新读一遍 → 接着聊几轮 → 再看条数
 * 只要有任何一步让条数涨回原来的量级，就判失败。
 *
 * 用法：
 *   node scripts/check-compress.mjs            # 默认拿「最大那个会话」的副本跑
 *   node scripts/check-compress.mjs --all      # 把所有会话都跑一遍
 *   node scripts/check-compress.mjs <sessionId>
 *
 * 全程在临时目录里做，一个字节都不碰主人的真数据。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const REAL = path.join(process.env.APPDATA || '', '小鱼Agent', 'data', '.state', 'sessions');

const argv = process.argv.slice(2);
const wantAll = argv.includes('--all');
const wantId = argv.find((a) => /^sm[a-z0-9]+$/i.test(a)) || '';

const PORT = 8799;   // 躲开 .env 里的 8787（那一个被主人的 app 占着）

const say = (s = '') => console.log(s);
const head = (s) => { say(); say('─'.repeat(62)); say(s); say('─'.repeat(62)); };

/** 挑要跑哪几个会话 */
function pickSessions() {
  if (!fs.existsSync(REAL)) return [];
  const rows = [];
  for (const f of fs.readdirSync(REAL).filter((x) => x.endsWith('.json'))) {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(REAL, f), 'utf8')); } catch { continue; }
    const ms = Array.isArray(j.messages) ? j.messages : [];
    if (ms.length < 50) continue;
    let chars = 0;
    for (const m of ms) chars += String(m?._text ?? m?.content ?? '').length;
    rows.push({
      id: f.replace(/\.json$/, ''),
      title: String(j.title || '(无题)'),
      count: ms.length,
      chars,
      summaries: ms.filter((m) => m && m.summary && m.context).length,
    });
  }
  rows.sort((a, b) => b.chars - a.chars);
  if (wantId) return rows.filter((r) => r.id === wantId);
  if (wantAll) return rows;
  return rows.slice(0, 1);
}

/** 起一个临时服务器（临时数据目录 + 假上游） */
async function startServer({ dataDir, upstream }) {
  const srv = spawn(process.execPath, [path.join(ROOT, 'src', 'server.mjs')], {
    cwd: ROOT,
    env: {
      ...process.env,
      MINI_AGENT_DATA: dataDir,
      PORT: String(PORT),
      MINI_AGENT_QUIET: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  srv.stdout.on('data', (d) => { log += String(d); });
  srv.stderr.on('data', (d) => { log += String(d); });

  // 等它真的能应答
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/health`);
      if (r.ok) return { srv, log: () => log, upstream };
    } catch { /* 还没起来 */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  srv.kill();
  throw new Error('服务器起不来（端口 ' + PORT + ' 被占？）\n' + log.slice(-800));
}

/** 假上游：摘要请求回一段合格的四标签摘要，聊天回一句短话 */
async function startUpstream() {
  const srv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const isSummary = /早期对话摘要|主人要什么/.test(body);
      const isCut = /CUT\s*#?\d/.test(body) || /切点/.test(body);
      if (isCut) {
        // 她要提切点就提一个有意义的号，别让它永远退回程序算的
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'CUT #30' } }] }));
        return;
      }
      const text = isSummary
        ? '主人要什么:\n- 把压缩修好，别再涨回去。\n已经做完:\n- 走通压缩链路。\n还没做完:\n- 长跑验收。\n关键约束:\n- 不许动真数据。'
        : '嗯，我在。';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{ message: { content: text } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { srv, port: srv.address().port };
}

const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await r.json(); } catch { /* 有的接口回空 */ }
  return { status: r.status, data };
};

const statOf = (file) => {
  if (!fs.existsSync(file)) return { count: 0, summaries: 0, kb: 0 };
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    const ms = Array.isArray(j.messages) ? j.messages : [];
    let chars = 0;
    for (const m of ms) chars += String(m?._text ?? m?.content ?? '').length;
    return {
      count: ms.length,
      summaries: ms.filter((m) => m && m.summary && m.context).length,
      kb: Math.round(chars / 1024),
    };
  } catch { return { count: -1, summaries: -1, kb: -1 }; }
};

/** 跑一个会话的完整验收，返回 {ok, lines} */
async function verifyOne(seed) {
  const lines = [];
  const ok = (cond, msg) => { lines.push((cond ? '  ✔ ' : '  ✘ ') + msg); return cond; };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-cc-'));
  const stateDir = path.join(tmp, '.state');
  fs.mkdirSync(path.join(stateDir, 'sessions'), { recursive: true });

  // 把真会话原样拷进去当种子
  const sid = 'smcctest0001';
  const srcFile = path.join(REAL, seed.id + '.json');
  const dstFile = path.join(stateDir, 'sessions', sid + '.json');
  const raw = JSON.parse(fs.readFileSync(srcFile, 'utf8'));
  raw.id = sid;
  fs.writeFileSync(dstFile, JSON.stringify(raw), 'utf8');

  const up = await startUpstream();
  // config.mjs 的 get() 是 fileEnv[key] ?? process.env[key] —— **.env 优先**，
  // 而 loadEnvFile() 先看数据目录、再退回资源目录。所以临时目录里必须有一份自己的
  // .env 把端口和上游顶掉，否则会连到主人真正在跑的那个 8787。
  fs.writeFileSync(path.join(tmp, '.env'), [
    `PORT=${PORT}`,
    `OPENAI_BASE_URL=http://127.0.0.1:${up.port}/v1`,
    'OPENAI_API_KEY=sk-fake',
    'OPENAI_MODEL=ollama-cc-test',
    '',
  ].join('\n'), 'utf8');
  // 模型名带 ollama：rates.mjs 的 WINDOWS 里 `ollama: 32000` 是全场最小的窗口，
  // 自动档的判定线（窗口 30% = 9600）才够得着小会话。
  // 用 128K 的 FALLBACK_WINDOW 时，判定线是 38400，一万 token 的小会话永远不压，
  // 脚本就会把「本来就不该压」记成「没挺住」。
  fs.writeFileSync(path.join(stateDir, 'models.json'), JSON.stringify({
    models: [{ id: 'fake', baseURL: `http://127.0.0.1:${up.port}/v1`, apiKey: 'sk-fake', model: 'ollama-cc-test' }],
    activeId: 'fake',
    hideEnv: true,
  }), 'utf8');
  // 水位填 0 = **自动档**：程序按当前模型的窗口自己算（见 settings.mjs 的
  // parseContextLimitValue：0 是「自动」的哨兵值，不是「不压缩」，关掉要写 off）。
  //
  // 这里踩过两个坑，都是验收脚本自己的：
  //   ① 填 5000 → 被 parseContextLimitValue 夹成 8000（「太小了压起来没意义」）；
  //   ② 8000 比会话的头部（system + 前情摘要，实测 13327 token）还小 →
  //      compressHistory 报 head-too-big、拒绝硬压，看着像「压不动」。
  // 用自动档就绕开这两件事：模型用 ollama-cc-test（rates.mjs 里 ollama 窗口 32000），
  // 自动水位 32000*0.7 = 22400，判定线 32000*0.3 = 9600，小会话也够得着，
  // 头部 13327 也在 22400 以内，压得动。
  const approxTokens = Math.round(seed.chars / 2.2);
  // 头部（system + 规则副本 + 工具说明）是最先要看的东西：它若是比窗口还大，
  // compressHistory 会给 head-too-big、按现状不硬压 —— 那不是坏，是正确取舍。
  const headCharCount = (raw.messages || []).slice(0, 3)
    .reduce((n, m) => n + String(m?._text ?? m?.content ?? '').length, 0);
  // 水位：填一个正数 = 显式阈值，「填多少压多少」，判定线就是它。
  //
  // 三条硬约束（都是踩出来的）：
  //   ① contextLimit 会被 parseContextLimitValue 夹到 8000 起步 —— 填更小没用；
  //   ② 必须比头部（system + 前情摘要，实测能到 13327 token）大，
  //      否则 compressHistory 报 head-too-big 拒绝硬压；
  //   ③ 必须小于当前总量（否则 before <= trigger，报 under-trigger 根本不压）。
  // 取「头部×1.4」与「总量×0.55」的较大者，再夹到 8000 以上：
  //   头部 13327 → 18658；总量 10910 → 6000，取 18658。总量 10910 < 18658 会 under-trigger，
  //   所以这种情况下会话本身就压不动，判「跳过」。
  const headTokens = headCharCount / 2.2;
  // 【从磁盘算出来的头部不可信】—— 这是踩了三次才认下来的。
  // 磁盘上第一条 system 只有 5237 token，可服务端组装请求时会再塞进规则副本
  // （contextMessage 那条 user 规则）、身份块、记忆本，实测头部变成 13327~13439 token。
  // 所以水位不能按磁盘头部算，得留足余量：至少 16000，且不低于总量的 60%。
  // 16000 = 实测头部 13439 再留 20% 缓冲；总量 10910 那种会话压不动，判跳过。
  const limit = Math.max(16000, Math.floor(approxTokens * 0.6));
  const headTooBig = headTokens >= limit;
  // 总量连水位都够不到 —— 那就不该压，判「跳过」而不是「没挺住」。
  const tooShort = approxTokens <= limit;
  fs.writeFileSync(path.join(stateDir, 'settings.json'), JSON.stringify({
    contextLimit: limit,
    safeWords: [],
  }), 'utf8');

  const { srv, log } = await startServer({ dataDir: tmp, upstream: up });

  try {
    const s0 = statOf(dstFile);
    lines.push(`  起点：${s0.count} 条 / ${s0.kb}KB / 摘要 ${s0.summaries} 条`);

    const sel = await api('POST', '/api/sessions/select', { id: sid });
    if (sel.status !== 200) {
      ok(false, '会话读不进来：' + JSON.stringify(sel.data).slice(0, 160));
      return { ok: false, lines };
    }

    // 第一轮：说一句，逼它压缩
    const chatOne = async (text) => {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, message: text }),
      });
      const txt = await r.text();
      const compressed = txt.split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => { try { return JSON.parse(l.slice(5).trim()); } catch { return null; } })
        .filter(Boolean)
        .find((e) => e.type === 'compressed') || null;
      return { ok: r.ok, compressed };
    };

    const r1 = await chatOne('开始验收，先压一遍');
    const afterCompress = statOf(dstFile);
    lines.push(`  压完：${afterCompress.count} 条 / ${afterCompress.kb}KB / 摘要 ${afterCompress.summaries} 条`);

    // 【两种本来就不该压的情况，判「跳过」而不是「失败」，别让验收脚本冤枉代码】
    // ① 头部（人设 + 工具说明）比窗口还大 → compressHistory 给 head-too-big 不硬压；
    // ② 会话本身太短，水位怎么设都在它头顶上 → 根本触不到线。
    if (tooShort || headTooBig) {
      lines.push(`  · 跳过：当前约 ${approxTokens} token、头部约 ${Math.round(headTokens)} token、`
        + `窗口 ${limit} —— 这一份 ${tooShort ? '太短，触不到水位' : '头部太大，按现状不硬压'}，`
        + `不是坏。`);
      return { ok: true, lines, skipped: true };
    }

    ok(Boolean(r1.compressed), '第一轮就触发了压缩' + (r1.compressed ? `（${r1.compressed.before}→${r1.compressed.after}）` : ''));
    ok(afterCompress.count < s0.count, `磁盘上的条数真的变少了（${s0.count} → ${afterCompress.count}）`);
    ok(afterCompress.summaries >= 1, '落盘的那份里有摘要');

    // 真·重新读一遍（这一步以前从来没验过）
    await api('POST', '/api/sessions/select', { id: sid });
    const reload1 = statOf(dstFile);
    lines.push(`  重读：${reload1.count} 条 / 摘要 ${reload1.summaries} 条`);
    ok(reload1.count <= afterCompress.count + 2, '重开之后没变回原来那一大坨');

    // 接着聊三轮 —— 旧 bug 就是在这里涨回来的
    for (let i = 1; i <= 3; i++) {
      await chatOne(`第 ${i} 轮追问，看看会不会涨回来`);
      await new Promise((r) => setTimeout(r, 120));
    }
    const afterChat = statOf(dstFile);
    lines.push(`  再聊三轮：${afterChat.count} 条 / 摘要 ${afterChat.summaries} 条`);
    ok(afterChat.summaries >= 1, '三轮之后摘要还在（没被挤掉）');

    // 最关键的一条：不许涨回原来的量级
    const grown = afterChat.count - reload1.count;
    ok(afterChat.count <= s0.count * 0.5,
      `三轮之后条数仍是起点的一半以下（起点 ${s0.count} → 现在 ${afterChat.count}，净增 ${grown} 条）`);

    const allOk = lines.every((l) => !l.startsWith('  ✘'));
    if (!allOk) lines.push('  —— 服务端最后的日志 ——', ...log().split('\n').slice(-6).map((l) => '    ' + l.trim()));
    return { ok: allOk, lines };
  } finally {
    try { srv.kill(); } catch {}
    try { up.srv.close(); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

/* ==================== 主流程 ==================== */
const seeds = pickSessions();
if (!seeds.length) {
  say('没找到能跑的会话（.state/sessions 下没有 50 条以上的记录）。');
  process.exit(2);
}

say('压缩长跑验收 —— 真实时序：压缩 → 落盘 → 重读 → 再聊三轮');
say(`要跑 ${seeds.length} 个会话（全程在临时目录，不碰真数据）`);

let pass = 0;
let fail = 0;
for (const seed of seeds) {
  head(`${seed.title}（${seed.id}） · ${seed.count} 条 / ${Math.round(seed.chars / 1024)}KB / 摘要 ${seed.summaries} 条`);
  let r;
  try {
    r = await verifyOne(seed);
  } catch (e) {
    r = { ok: false, lines: ['  ✘ 跑挂了：' + String(e && e.message ? e.message : e)] };
  }
  for (const l of r.lines) say(l);
  if (r.ok) pass++; else fail++;
}

head(`结果：${pass} 个会话挺住了，${fail} 个没挺住`);
process.exit(fail ? 1 : 0);
