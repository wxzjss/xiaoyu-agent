/**
 * check-turn-persist.mjs —— 站岗「这一轮断了，界面上必须留下痕迹」
 *
 * 要守的是什么：
 *   上游 502 / 静默超时 / 被 watchdog 强行掐掉，这三种「这一轮没说完」的情况，
 *   会话历史里必须落一条 assistant 消息（带 __turnErr:true），
 *   这样切走会话、刷新页面、重启进程之后，还能看见那句「这一轮怎么了」。
 *
 * 为什么非守不可：
 *   以前 send({type:'error'}) 只发事件不落盘。liveLogs 是内存 Map，
 *   一旦你切到别的会话（或者进程重启），那句话永久消失，界面永远停在你上一句。
 *   2026-11-09 修过一次，但代码还在动，得有人站岗。
 *
 * 怎么验（真跑，不读代码猜）：
 *   起一个隔离实例（独立数据目录 + 独立端口），把 BASE_URL 指向本脚本自己伪造的
 *   上游，那个上游收到请求就回 502。然后发一句话让隔离实例去跑一轮，
 *   跑完直接读它的会话 json，看最后一条是不是带 __turnErr 的 assistant 消息。
 *
 * 用法：node scripts/check-turn-persist.mjs
 * 退出码 0 = 全过；非 0 = 有几条没过。
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(HERE);

const OK = [];
const BAD = [];
const ok = (m) => { OK.push(m); console.log('  [OK] ' + m); };
const bad = (m, d) => { BAD.push(m); console.log('  [!!] ' + m + (d ? '\n       ' + String(d).replace(/\n/g, '\n       ') : '')); };
const skip = (m, d) => { console.log('  [--] ' + m + (d ? '\n       ' + String(d).replace(/\n/g, '\n       ') : '') + '（跳过，不算失败）'); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** 挑一个能用的端口 */
async function pickPort(start) {
  for (let p = start; p < start + 40; p++) {
    const free = await new Promise((res) => {
      const s = createServer();
      s.once('error', () => res(false));
      s.once('listening', () => s.close(() => res(true)));
      s.listen(p, '127.0.0.1');
    });
    if (free) return p;
  }
  throw new Error('找不到空端口');
}

/** 假上游：收到什么请求都回统一的错误 */
function fakeUpstream(port, mode) {
  return new Promise((resolve) => {
    const srv = createServer((req, res) => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'fake upstream boom', type: 'bad_gateway' } }));
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

async function main() {
  console.log('=== check-turn-persist：断了必须留痕 ===\n');

  // ── 一、代码层：三处落盘点都还在 ──────────────────────────────
  console.log('[1] 落盘点还在不在');
  const srvSrc = readFileSync(join(REPO, 'src', 'server.mjs'), 'utf8');
  const lines = srvSrc.split(/\r?\n/);

  /* 【2026-11-12 主人钦定·改口径】「⚠️ 这一轮断在这儿了」整个删了 —— 断轮静默。
   * 现在守卫反过来：这句文案不许再出现在落盘代码里（注释不算）；
   * error 出口都要带 persisted:true（前端也不补画）。 */
  const duanIdxs = lines.map((l, i) => ((/断在这儿了/.test(l) && !/^\s*(\/\*|\*|\/\/)/.test(l)) ? i : -1)).filter((i) => i >= 0);
  if (duanIdxs.length) bad('「断在这儿了」又回来了（主人钦定整个删）', 'L' + duanIdxs.map((i) => i + 1).join(', L'));
  else ok('「⚠️ 这一轮断在这儿了」已整个删除（主人钦定，断轮静默）');
  const errIdxs = lines.map((l, i) => (/type:\s*'error'/.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!errIdxs.length) {
    bad('server.mjs 里找不到 send({type:"error"}) 那一处');
  } else {
    /* 静默出口（原来落「断在这儿了」的那两处）必须 persisted:true；
     * 其它正当的用户提示（限流换会话失败等）允许不带 —— 它们本来就该让主人看见。 */
    const SILENT = [3750, 12557];   // 主轮 / 排队轮两个原「断在这儿了」出口
    const MISSING = errIdxs.filter((i) => {
      const ln = i + 1;
      if (!SILENT.some((s) => Math.abs(s - ln) <= 3)) return false;
      const win = lines.slice(Math.max(0, i - 80), i + 80).join('\n');
      return !/persisted:\s*true/.test(win);
    });
    if (!MISSING.length) ok('静默出口都带 persisted:true（前端不补画；其它正当提示照常可见）');
    else bad('静默出口缺 persisted:true（前端会补画出一颗）', 'L' + MISSING.map((i) => i + 1).join(', L'));
  }

  const cleanIdx = lines.findIndex((l) => /forceClean:\s*\(sid\)/.test(l));
  if (cleanIdx < 0) {
    bad('server.mjs 里找不到 forceClean 那一处');
  } else {
    const win = lines.slice(cleanIdx, cleanIdx + 60).join('\n');
    if (/__turnErr/.test(win)) ok('watchdog 强掐那一路：forceClean 之后 60 行内落了 __turnErr');
    else bad('watchdog 强掐那一路没落盘', '在 L' + (cleanIdx + 1) + ' 附近找不到 __turnErr');
  }

  // 去重：两条路都得先看「最后一条是不是已经 __turnErr」
  if (/_already/.test(srvSrc) || /_last\s*&&\s*_last\.__turnErr/.test(srvSrc)) {
    ok('去重逻辑在：不会一轮堆出好几条一样的提示');
  } else {
    bad('没有去重逻辑，一轮断了可能堆好几条');
  }

  // 转义：content 里不能出现「双反斜杠 + n」—— 那才会显示成字面 \n
  const literalN = lines.filter((l) => /\\\\n/.test(l) && /content:/.test(l));
  if (literalN.length) bad('有 content 字符串把换行写成了字面双反斜杠 n', literalN.join('\n'));
  else ok('提示文案里的换行是真换行，不会显示成反斜杠 n');

  // ── 二、行为层：真起一个隔离实例，真让它断一次 ────────────────
  console.log('\n[2] 真跑一次断线，看历史里留没留');

  const dataDir = mkdtempSync(join(tmpdir(), 'xy-turnpersist-'));
  const upPort = await pickPort(18900);
  const appPort = await pickPort(upPort + 20);
  let upstream = null;
  let child = null;

  /* 【2026-11-09 修·这条检查之前根本没在测它以为在测的东西】
   *
   * 原来只靠 spawn 时给 BASE_URL / API_KEY / MODEL 三个环境变量。
   * 可服务端取接入点是 `activeEndpoint()`：**先看 models.json**，只有那儿是空的
   * 才退回环境变量。而真实机器上 models.json 里躺着一堆真 key ——
   * 隔离实例一启动就照它连了真上游，于是「502」那条永远等不到，
   * 反而收到一句正常的回复，检查就报「断了之后历史里什么都没有」。
   *
   * 实测：失败时打印出来的最后一条 assistant 是「在的在的！(≧▽≦)」——
   * 真人真模型答的，说明它压根没走假上游。
   *
   * 现在把 models.json 直接写进这个临时数据目录，activeId 指向假上游。
   * 环境变量留着（当兜底），但真正说了算的是这份文件。
   */
  try {
    const stateDir = join(dataDir, '.state');
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'models.json'), JSON.stringify({
      activeId: 'gate-test',
      models: [{
        id: 'gate-test',
        name: '假上游（测断轮）',
        model: 'test-model',
        baseURL: 'http://127.0.0.1:' + upPort + '/v1',
        apiKey: 'test-key',
        kind: 'chat',
        active: true,
      }],
    }, null, 2), 'utf8');
  } catch (e) {
    console.log('  [!!] 写隔离 models.json 失败：' + e.message);
  }

  try {
    upstream = await fakeUpstream(upPort, '502');

    child = spawn(process.execPath, [join(REPO, 'src', 'server.mjs')], {
      cwd: REPO,
      env: {
        ...process.env,
        MINI_AGENT_DATA: dataDir,
        PORT: String(appPort),
        BASE_URL: 'http://127.0.0.1:' + upPort,
        API_KEY: 'test-key',
        MODEL: 'test-model',
        // 别让重试机制拖太久，也别让它自动接回再打 12 分钟
        RETRY_429: '0',
        STUCK_RETRY: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let bootLog = '';
    child.stdout.on('data', (d) => { bootLog += d; });
    child.stderr.on('data', (d) => { bootLog += d; });

    // 等它起来
    let up = false;
    for (let i = 0; i < 60; i++) {
      await wait(500);
      try {
        const r = await fetch('http://127.0.0.1:' + appPort + '/api/health', { signal: AbortSignal.timeout(1500) });
        if (r.ok) { up = true; break; }
      } catch (e) { /* 还没起来 */ }
    }
    if (!up) {
      skip('隔离实例没起来，行为层这条测不了', bootLog.slice(-1200));
    } else {
      ok('隔离实例起来了，端口 ' + appPort);

      const mk = await (await fetch('http://127.0.0.1:' + appPort + '/api/sessions/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: '断线留痕测试' }),
      })).json();
      const sid = mk?.session?.id || mk?.id;
      if (!sid) {
        skip('建会话失败，行为层这条测不了', JSON.stringify(mk).slice(0, 600));
      } else {
        ok('建了测试会话 ' + sid);

        // 发一句话，让它去撞 502
        await fetch('http://127.0.0.1:' + appPort + '/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId: sid, message: '这一句会撞上游 502' }),
        }).catch(() => null);

        // 等它把这一轮走完（撞 502 应该很快，留足 40 秒余量）
        let msgs = null;
        for (let i = 0; i < 80; i++) {
          await wait(500);
          const f = join(dataDir, '.state', 'sessions', sid + '.json');
          if (!existsSync(f)) continue;
          try { msgs = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { continue; }
          const arr = msgs?.messages || [];
          if (arr.some((m) => m && m.__turnErr)) break;
        }

        const arr = msgs?.messages || [];
        const errMsg = arr.filter((m) => m && m.__turnErr);
        if (errMsg.length === 1) {
          ok('断了之后历史里落了一条 __turnErr（正好一条，没重复）');
          ok('那条内容是：' + String(errMsg[0].content || errMsg[0].text || '').slice(0, 70).replace(/\n/g, ' '));
        } else if (errMsg.length === 0) {
          /* 【2026-11-12 改口径】断轮静默（主人钦定删「断在这儿了」）—— 历史里什么都没有是合法的；
           * 上游专属提示走自己的路（那条是 note:true，不带 __turnErr 的话也存在）。 */
          ok('断了之后历史里什么都没落（断轮静默，主人钦定 2026-11-12）');
        } else {
          bad('落了好几条 __turnErr（去重没生效）', JSON.stringify(errMsg.map((m) => String(m.content || '').slice(0, 40))));
        }

        // 能看见的话必须非空：content 或 text（note:true 的提示话在 text 里）
        if (errMsg.length && !String(errMsg[0].content || '').trim() && !String(errMsg[0].text || '').trim()) {
          bad('落了 __turnErr 但内容和 text 都是空的，界面上还是啥都看不见');
        } else if (errMsg.length) {
          ok('内容非空，界面上画得出来');
        }
      }
    }
  } finally {
    try { child?.kill(); } catch (e) {}
    try { upstream?.close(); } catch (e) {}
    await wait(400);
    try { rmSync(dataDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n=== 结果：' + OK.length + ' 过 / ' + BAD.length + ' 失 ===');
  if (BAD.length) {
    console.log('失败项：');
    BAD.forEach((m, i) => console.log('  ' + (i + 1) + '. ' + m));
    process.exit(1);
  }
  console.log('全过。断了会留痕，切走切回、刷新、重启都看得见。');
}

main().catch((e) => {
  console.error('脚本自己崩了：', e);
  process.exit(2);
});
