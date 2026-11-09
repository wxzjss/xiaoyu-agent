/**
 * 【2026-11-05 加】接口全量体检（只读 GET）
 *
 * 只打 GET —— 不改任何状态。带副作用的单独列出来不碰：
 * 比如 /api/tts/play 会真的出声、/api/screen/frames 会截屏、
 * /api/qq/onebot/qrcode 会让 QQ 扫码登录。
 *
 * 判定：
 *   ok    200 且能解析
 *   warn  4xx（多半是缺参数，接口本身活着）
 *   FAIL  5xx / 连不上 / 超时 / 返回了 error 但状态码是 200
 *
 * 用法：node _t_api.mjs [base]
 */
const BASE = process.argv[2] || process.env.BASE || 'http://127.0.0.1:8788';

const SKIP = new Set([
  '/api/tts/play',        // 会真的出声
  '/api/screen/frames',   // 会截屏
  '/api/frames/',         // 同上
  '/api/qq/onebot/qrcode', // 会让 QQ 出登录码
  '/api/update/status',   // 要访问 GitHub，慢且看网络
]);

const GETS = [
  '/', '/api/health', '/api/settings', '/api/models', '/api/sessions',
  '/api/sessions/search?q=test', '/api/sessions/peek?id=__none__', '/api/sessions/length',
  '/api/sessions/memory', '/api/sessions/memory/digests',
  '/api/persona', '/api/personas', '/api/identity', '/api/features',
  '/api/memory/book', '/api/plan', '/api/plan/txt', '/api/chat/live',
  '/api/running', '/api/context-limit', '/api/thinking', '/api/retry429',
  '/api/chatstyle', '/api/skin', '/api/skin/music', '/api/skin/video',
  '/api/task-mode', '/api/admin-mode', '/api/fish', '/api/whale',
  '/api/whale/profile', '/api/voice-runtime', '/api/tts', '/api/selfcheck',
  '/api/dbg/paths', '/api/resume', '/api/session-config', '/api/backup/info',
  '/api/cron', '/api/agents', '/api/agents/current', '/api/agents/colors',
  '/api/agents/group', '/api/agents/one?name=x', '/api/qq/status',
  '/api/qq/gate', '/api/qq/peers', '/api/qq/onebot', '/api/qq/onebot/protocol',
  '/api/mobile/state', '/api/mobile/pairing', '/api/mobile/ping',
  '/api/peer/mail', '/api/attach/browse?kind=file',
];

const rows = [];
let fails = 0;

for (const p of GETS) {
  if (SKIP.has(p)) { rows.push({ p, st: 'skip', ms: 0, note: '有副作用，不碰' }); continue; }
  const t0 = Date.now();
  let rec = { p, st: '?', ms: 0, note: '' };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(BASE + p, { signal: ctl.signal });
    clearTimeout(timer);
    rec.ms = Date.now() - t0;
    const txt = await r.text();
    rec.st = r.status;
    rec.len = txt.length;
    if (r.status >= 500) { rec.note = '服务端错误'; fails++; }
    else if (r.status >= 400) { rec.note = '缺参数/不存在（接口活着）'; }
    else {
      // 200 但里面写着 error，算异常
      try {
        const j = JSON.parse(txt);
        if (j && j.error && !j.ok) { rec.note = '200 但带 error：' + String(j.error).slice(0, 40); fails++; }
      } catch { /* 非 JSON（html/图片）也正常 */ }
    }
  } catch (e) {
    rec.ms = Date.now() - t0;
    rec.st = 'ERR';
    rec.note = String(e && e.message ? e.message : e).slice(0, 60);
    fails++;
  }
  rows.push(rec);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('接口', 40) + pad('状态', 8) + pad('耗时', 8) + '备注');
for (const r of rows) {
  const mark = r.st === 'ERR' || (typeof r.st === 'number' && r.st >= 500) ? '✘' : (r.note && r.note.includes('error') ? '⚠' : ' ');
  console.log(mark + ' ' + pad(r.p, 38) + pad(String(r.st), 8) + pad(r.ms + 'ms', 8) + (r.note || ''));
}

const slow = rows.filter((r) => r.ms > 1500 && r.st !== 'skip');
console.log('');
console.log('共测 ' + rows.filter((r) => r.st !== 'skip').length + ' 个，失败 ' + fails + ' 个，慢（>1.5s）' + slow.length + ' 个');
if (slow.length) console.log('慢的：' + slow.map((r) => r.p + '(' + r.ms + 'ms)').join('、'));
process.exit(fails ? 1 : 0);
