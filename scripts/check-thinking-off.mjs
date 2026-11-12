/**
 * 【思考档位：按 provider 分派，发出去的字段一个都不许错】
 *
 * 起因（2026-11-09，两台网关四种写法逐个试出来的）：
 *
 *   | 请求体                          | 飞鱼 ai.feiyuapi.top | 丸子 napi.wanzij.cn        |
 *   |--------------------------------|----------------------|----------------------------|
 *   | 什么都不发                       | 19 reasoning tok ❌  | 22 tok ❌                  |
 *   | reasoning_effort:"none"         | 0 ✅                 | 49 tok ❌（静默忽略）      |
 *   | thinking:{type:"disabled"}      | 0 ✅                 | 0 ✅                       |
 *   | reasoning_effort:"off"          | 200 / 0 tok          | **HTTP 400** ❌            |
 *
 * 两条铁律：
 *   1. 「关」必须带 thinking.type='disabled'（唯一全网关都认的写法）；
 *   2. reasoning_effort 只在 openai 方言下发，且**永不发 'off' 字面值**。
 *
 * 这个检查做两件事：
 *   · 纯函数矩阵：四种方言 × 四个档位，字段逐个对；
 *   · 真发一遍：起一个**本地假网关**（127.0.0.1），把 streamChat / chat 真正跑过去，
 *     看它到底往线上发了什么。**全程不联网**，也不碰主人的 8788。
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('thinking / 关思考与方言分派');

/* ── 假网关：把收到的请求体原样记下来 ───────────────────────── */
const REQS = []; // 本轮的请求（每次 run 前清空）
let PAGE = [];   // 整个检查收到的全部请求（最后统一验「永不发 off」）

const srv = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch { body = { __unparsed: raw.slice(0, 200) }; }
    const rec = { url: req.url, body };
    REQS.push(rec);
    PAGE.push(rec);

    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '好' } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: '好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }));
  });
});

const PORT = await new Promise((ok, bad) => {
  srv.on('error', bad);
  srv.listen(0, '127.0.0.1', () => ok(srv.address().port));
});
const FAKE_BASE = 'http://127.0.0.1:' + PORT + '/v1';
const FAKE_HOST = '127.0.0.1:' + PORT;

/* ── 隔离数据目录：配置全写临时目录，绝不碰主人那份 ─────────── */
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'xy-think-'));
const STATE = path.join(DATA, '.state');
fs.mkdirSync(STATE, { recursive: true });

function writeState(name, obj) {
  fs.writeFileSync(path.join(STATE, name), JSON.stringify(obj, null, 2), 'utf8');
}

function setModels(models, activeId) {
  writeState('models.json', { models, activeId, hideEnv: true });
}

function setThinkingState(obj) {
  writeState('thinking.json', obj);
}

/* config.mjs 在 import 的那一刻就把 dataDir 定下来了，
 * 所以环境变量必须在 import 之前设好。 */
process.env.MINI_AGENT_DATA = DATA;

let mod = null;
let llm = null;
let overrides = null;

setModels([
  {
    id: 'fake_openai',
    name: '假网关',
    model: 'deepseek-v4.1-flash',
    baseURL: FAKE_BASE,
    apiKey: 'sk-test',
  },
], 'fake_openai');
setThinkingState({ level: 'off', perModel: {} });

try {
  mod = await import('../src/thinking.mjs');
  llm = await import('../src/llm.mjs');
  overrides = await import('../src/session-overrides.mjs');

  /* ══════════════════════════════════════════════════════════
     ① 方言判定：地址 → 哪一家
     ══════════════════════════════════════════════════════════ */
  const FMT_CASES = [
    ['https://napi.wanzij.cn/v1', 'openai'],
    ['https://ai.feiyuapi.top/v1', 'openai'],
    ['https://api.deepseek.com', 'deepseek'],
    ['https://api.deepseek.com/v1', 'deepseek'],
    ['https://open.bigmodel.cn/api/paas/v4', 'zai'],
    ['https://bigmodel.cn/api/paas/v4', 'zai'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'qwen'],
    ['https://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'qwen'],
    ['', 'openai'],
    ['这不是个地址', 'openai'],
  ];
  for (const [baseURL, want] of FMT_CASES) {
    const got = mod.thinkingFormatOf({ baseURL });
    t.ok('方言 ' + (baseURL || '(空)') + ' → ' + want, got === want, got);
  }
  t.ok('配置里显式写 thinkingFormat 时听配置的',
    mod.thinkingFormatOf({ baseURL: 'https://napi.wanzij.cn/v1', thinkingFormat: 'deepseek' }) === 'deepseek');
  t.ok('thinkingFormat 写了认不出的值就退回按地址判断',
    mod.thinkingFormatOf({ baseURL: 'https://api.deepseek.com', thinkingFormat: '胡写' }) === 'deepseek');

  /* ══════════════════════════════════════════════════════════
     ② 纯函数矩阵：四种方言 × 四个档位
     ══════════════════════════════════════════════════════════ */
  const EPS = {
    openai: { baseURL: 'https://napi.wanzij.cn/v1', model: 'deepseek-v4.1-flash' },
    deepseek: { baseURL: 'https://api.deepseek.com', model: 'deepseek-chat' },
    zai: { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4.6' },
    qwen: { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-max' },
  };

  /* 期望值写全，一条不省略 —— 这几行就是「发什么」的唯一说明书 */
  const WANT = {
    off: {
      openai: { thinking: { type: 'disabled' }, reasoning_effort: 'none' },
      deepseek: { thinking: { type: 'disabled' } },
      zai: { thinking: { type: 'disabled', clear_thinking: false } },
      qwen: { thinking: { type: 'disabled' }, enable_thinking: false },
    },
    low: {
      openai: { reasoning_effort: 'low' },
      deepseek: { thinking: { type: 'enabled' } },
      zai: { thinking: { type: 'enabled', clear_thinking: false } },
      qwen: { enable_thinking: true },
    },
    high: {
      openai: { reasoning_effort: 'high' },
      deepseek: { thinking: { type: 'enabled' } },
      zai: { thinking: { type: 'enabled', clear_thinking: false } },
      qwen: { enable_thinking: true },
    },
    max: {
      openai: { reasoning_effort: 'max' },
      deepseek: { thinking: { type: 'enabled' } },
      zai: { thinking: { type: 'enabled', clear_thinking: false } },
      qwen: { enable_thinking: true },
    },
  };

  for (const lv of ['off', 'low', 'high', 'max']) {
    for (const fmt of ['openai', 'deepseek', 'zai', 'qwen']) {
      const got = mod.fieldsForLevel(lv, EPS[fmt]).fields;
      t.ok(fmt + ' / ' + lv + ' 字段对得上',
        JSON.stringify(got) === JSON.stringify(WANT[lv][fmt]),
        JSON.stringify(got));
    }
  }

  /* 铁律：不管哪种方言，off 一定带 thinking.type='disabled' */
  for (const fmt of ['openai', 'deepseek', 'zai', 'qwen']) {
    const f = mod.fieldsForLevel('off', EPS[fmt]).fields;
    t.ok(fmt + ' / off 一定带 thinking.type=disabled', f?.thinking?.type === 'disabled', JSON.stringify(f));
    t.ok(fmt + ' / off 绝不发 reasoning_effort=off',
      f.reasoning_effort !== 'off', String(f.reasoning_effort));
  }
  /* 铁律：只有 openai 方言才发 reasoning_effort */
  for (const fmt of ['deepseek', 'zai', 'qwen']) {
    for (const lv of ['low', 'high', 'max']) {
      const f = mod.fieldsForLevel(lv, EPS[fmt]).fields;
      t.ok(fmt + ' / ' + lv + ' 不发 reasoning_effort', f.reasoning_effort === undefined, JSON.stringify(f));
    }
  }
  /* 老档位不许漏到线上 */
  t.ok('老值 on → 关（发 none + thinking.disabled）',
    mod.fieldsForLevel('on', EPS.openai).fields.reasoning_effort === 'none');
  t.ok('老值 medium → 关（同上）', mod.fieldsForLevel('medium', EPS.openai).fields.reasoning_effort === 'none');
  t.ok('老值 xhigh → 最高', mod.fieldsForLevel('xhigh', EPS.openai).fields.reasoning_effort === 'max');
  /* 不传接入点时按 openai 方言（老调用点的行为不能变） */
  t.ok('不传接入点 = openai 方言',
    JSON.stringify(mod.fieldsForLevel('high').fields) === JSON.stringify({ reasoning_effort: 'high' }),
    JSON.stringify(mod.fieldsForLevel('high').fields));

  /* deepseek 官方三档等价 —— 这是**上游的限制**，我们用断言把它钉住，
   * 免得以后有人以为这是 bug、顺手往 deepseek 分支加 reasoning_effort。
   * 实测证据见 thinking.mjs 方言表下方（2026-11-09，交错采样 10 轮）。 */
  const dsLow = JSON.stringify(mod.fieldsForLevel('low', EPS.deepseek).fields);
  const dsHigh = JSON.stringify(mod.fieldsForLevel('high', EPS.deepseek).fields);
  const dsMax = JSON.stringify(mod.fieldsForLevel('max', EPS.deepseek).fields);
  t.ok('deepseek 官方 低/高/最高 发出去一模一样（上游不认 effort，已知限制）',
    dsLow === dsHigh && dsHigh === dsMax, dsHigh);
  t.ok('deepseek 官方 / 关 与 / 开 是两个不同的东西',
    JSON.stringify(mod.fieldsForLevel('off', EPS.deepseek).fields) !== dsHigh);

  /* ══════════════════════════════════════════════════════════
     ③ 真发一遍：本地假网关，看线上到底收到什么
     ══════════════════════════════════════════════════════════ */
  async function runStream(opts = {}) {
    REQS.length = 0;
    const events = [];
    for await (const ev of llm.streamChat({
      messages: [{ role: 'user', content: '你好' }],
      ...opts,
    })) events.push(ev);
    return { body: REQS[0]?.body ?? {}, events, url: REQS[0]?.url ?? '' };
  }

  async function runChat(opts = {}) {
    REQS.length = 0;
    const res = await llm.chat({ messages: [{ role: 'user', content: '你好' }], ...opts });
    return { body: REQS[0]?.body ?? {}, res };
  }

  const OPENAI_EP = {
    id: 'fake_openai',
    name: '假网关',
    model: 'deepseek-v4.1-flash',
    baseURL: FAKE_BASE,
    apiKey: 'sk-test',
  };

  /* ③-1 streamChat + 关：必须真的把思考关掉 */
  setThinkingState({ level: 'off', perModel: {} });
  const sOff = await runStream();
  t.ok('streamChat 打到了 /v1/chat/completions', /\/chat\/completions$/.test(sOff.url), sOff.url);
  t.ok('streamChat(off)：thinking.type=disabled', sOff.body?.thinking?.type === 'disabled', JSON.stringify(sOff.body.thinking));
  t.ok('streamChat(off)：reasoning_effort=none 兜底', sOff.body.reasoning_effort === 'none', String(sOff.body.reasoning_effort));
  t.ok('streamChat(off)：正文还是收得到', sOff.events.some((e) => e.type === 'text'));

  /* ③-2 streamChat + 高：openai 方言发 reasoning_effort，不带 disabled */
  setThinkingState({ level: 'high', perModel: {} });
  const sHigh = await runStream();
  t.ok('streamChat(high)：reasoning_effort=high', sHigh.body.reasoning_effort === 'high', String(sHigh.body.reasoning_effort));
  t.ok('streamChat(high)：不带 thinking.disabled', sHigh.body?.thinking?.type !== 'disabled', JSON.stringify(sHigh.body.thinking));

  /* ③-3 deepseek 方言的接入点：高 → thinking.enabled，且没有 reasoning_effort */
  setModels([
    {
      id: 'fake_deepseek',
      name: '假 deepseek',
      model: 'deepseek-chat',
      baseURL: FAKE_BASE,
      apiKey: 'sk-test',
      thinkingFormat: 'deepseek',
    },
  ], 'fake_deepseek');
  setThinkingState({ level: 'high', perModel: {} });
  const sDs = await runStream();
  t.ok('deepseek 方言(high)：thinking.type=enabled', sDs.body?.thinking?.type === 'enabled', JSON.stringify(sDs.body.thinking));
  t.ok('deepseek 方言(high)：不发 reasoning_effort', sDs.body.reasoning_effort === undefined, String(sDs.body.reasoning_effort));

  setThinkingState({ level: 'off', perModel: {} });
  const sDsOff = await runStream();
  t.ok('deepseek 方言(off)：thinking.type=disabled', sDsOff.body?.thinking?.type === 'disabled', JSON.stringify(sDsOff.body.thinking));

  /* ③-4 zai 方言 */
  setModels([
    {
      id: 'fake_zai',
      name: '假 glm',
      model: 'glm-4.6',
      baseURL: FAKE_BASE,
      apiKey: 'sk-test',
      thinkingFormat: 'zai',
    },
  ], 'fake_zai');
  setThinkingState({ level: 'max', perModel: {} });
  const sZai = await runStream();
  t.ok('zai 方言(max)：thinking.type=enabled',
    sZai.body?.thinking?.type === 'enabled', JSON.stringify(sZai.body.thinking));
  t.ok('zai 方言(max)：clear_thinking=false',
    sZai.body?.thinking?.clear_thinking === false, JSON.stringify(sZai.body.thinking));

  /* ③-5 qwen 方言 */
  setModels([
    {
      id: 'fake_qwen',
      name: '假 qwen',
      model: 'qwen-max',
      baseURL: FAKE_BASE,
      apiKey: 'sk-test',
      thinkingFormat: 'qwen',
    },
  ], 'fake_qwen');
  setThinkingState({ level: 'off', perModel: {} });
  const sQwen = await runStream();
  t.ok('qwen 方言(off)：enable_thinking=false', sQwen.body.enable_thinking === false, String(sQwen.body.enable_thinking));
  t.ok('qwen 方言(off)：thinking.type 仍带 disabled',
    sQwen.body?.thinking?.type === 'disabled', JSON.stringify(sQwen.body.thinking));

  /* ③-6 chat()（非流式那条）也必须走同一套 —— 摘要、测连通都走它 */
  setModels([
    {
      id: 'fake_openai',
      name: '假网关',
      model: 'deepseek-v4.1-flash',
      baseURL: FAKE_BASE,
      apiKey: 'sk-test',
    },
  ], 'fake_openai');
  setThinkingState({ level: 'off', perModel: {} });
  const cOff = await runChat();
  t.ok('chat(off)：thinking.type=disabled', cOff.body?.thinking?.type === 'disabled', JSON.stringify(cOff.body.thinking));
  t.ok('chat(off)：不发 reasoning_effort=off', cOff.body.reasoning_effort !== 'off', String(cOff.body.reasoning_effort));

  /* ══════════════════════════════════════════════════════════
     ④ perModel 的键：稳定键优先，老 id 键还能读
     ══════════════════════════════════════════════════════════ */
  const STABLE = FAKE_HOST + '/deepseek-v4.1-flash';
  t.ok('稳定键 = 主机/模型名', mod.perModelKeyOf(OPENAI_EP) === STABLE, String(mod.perModelKeyOf(OPENAI_EP)));

  /* 全局是「关」，模型自己存了「最高」—— 稳定键必须赢 */
  setThinkingState({ level: 'off', perModel: { [STABLE]: 'max' } });
  const sStable = await runStream();
  t.ok('稳定键优先：reasoning_effort=max', sStable.body.reasoning_effort === 'max', String(sStable.body.reasoning_effort));

  /* 只有老 id 键（主人现在盘上就是这种）—— 兼容读，不许失效 */
  setThinkingState({ level: 'off', perModel: { fake_openai: 'low' } });
  const sLegacy = await runStream();
  t.ok('老 id 键仍能读：reasoning_effort=low', sLegacy.body.reasoning_effort === 'low', String(sLegacy.body.reasoning_effort));

  /* 两个键都有时，稳定键优先（免得老值把新设置盖住） */
  setThinkingState({ level: 'off', perModel: { fake_openai: 'low', [STABLE]: 'max' } });
  const sBoth = await runStream();
  t.ok('两个键都在时稳定键优先', sBoth.body.reasoning_effort === 'max', String(sBoth.body.reasoning_effort));

  /* ══════════════════════════════════════════════════════════
     ⑤ 会话级覆盖：读出来就是四档之一（老值不许盖住「关」）
     ══════════════════════════════════════════════════════════ */
  writeState('session-overrides.json', {
    ov_on: { level: 'on' },
    ov_off: { level: 'off' },
    ov_medium: { level: 'medium' },
  });
  t.ok('会话里存着 on → 读出来是 off（老值归关）', overrides.getOverride('ov_on').level === 'off', overrides.getOverride('ov_on').level);
  t.ok('会话里存着 off → 读出来还是 off（不被老值盖住）', overrides.getOverride('ov_off').level === 'off', overrides.getOverride('ov_off').level);
  t.ok('会话里存着 medium → 读出来是 off（老值归关）', overrides.getOverride('ov_medium').level === 'off', overrides.getOverride('ov_medium').level);

  /* 会话级「关」压过全局「高」，而且真的发出去 */
  setThinkingState({ level: 'high', perModel: {} });
  const sOv = await runStream({ sessionId: 'ov_off' });
  t.ok('会话选「关」→ 线上收到 thinking.disabled', sOv.body?.thinking?.type === 'disabled', JSON.stringify(sOv.body.thinking));
  const sOvOn = await runStream({ sessionId: 'ov_on' });
  t.ok('会话存的老值 on → 按「关」发', sOvOn.body?.reasoning_effort === 'none' && sOvOn.body?.thinking?.type === 'disabled', JSON.stringify({ e: sOvOn.body?.reasoning_effort, t: sOvOn.body?.thinking }));

  /* ══════════════════════════════════════════════════════════
     ⑥ 全局兜底：整场下来一个 off 字面值都没发出去
     ══════════════════════════════════════════════════════════ */
  const offLiteral = PAGE.filter((r) => r.body && r.body.reasoning_effort === 'off');
  t.ok('整场没有一条请求发过 reasoning_effort="off"（丸子会回 400）',
    offLiteral.length === 0, String(offLiteral.length) + ' 条');
  const noThinkOff = PAGE.filter((r) => r.body && r.body.reasoning_effort === 'none' && r.body?.thinking?.type !== 'disabled');
  t.ok('凡是发 none 的也都带了 thinking.disabled', noThinkOff.length === 0, String(noThinkOff.length) + ' 条');
} catch (err) {
  t.ok('检查脚本本身没崩', false, String((err && err.stack) || err));
} finally {
  t.done();
  /* 【别在这儿挂住】fetch（undici）会把连接保活，光调 srv.close() 等不到回调，
   * 脚本就永远不退出 —— 回归里表现成「这个检查跑了 15 分钟」。
   * 先掐掉所有连接，再关。 */
  try { srv.closeAllConnections?.(); } catch { /* 老 Node 没有这个方法 */ }
  await new Promise((ok) => {
    srv.close(ok);
    /* 双保险：真等不到回调就自己往下走 */
    setTimeout(ok, 1000).unref?.();
  });
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch { /* 临时目录，删不掉也无所谓 */ }
}
