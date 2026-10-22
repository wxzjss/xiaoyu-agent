// Minimal web server: static UI + one SSE endpoint that runs the agent.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { runAgent, systemPrompt, repairHistory } from './agent.mjs';
import { browse, readImageDataUrl, readImageBytes, composeUserContent, isImagePath } from './attach.mjs';
import { getOverride, setOverride } from './session-overrides.mjs';
import {
  getSettings,
  saveSettings,
  matchSafeWord,
  safeWordNoteFor,
  DEFAULT_SETTINGS,
  resetBottomLines,
  resetSafeWords,
  effectiveContextLimit,
} from './settings.mjs';
import {
  personaInfo,
  saveUserPersona,
  resetUserPersona,
  switchPersona,
  createPersona,
  savePersonaText,
  renamePersona,
  deletePersona,
  resetPersona,
} from './persona-store.mjs';
import { getFeatures, setFeature } from './features.mjs';
import { getSkinState, writeSkin, skinVideoPath, ensureBundledVideo } from './skin.mjs';
import { getThinking, setThinking, LEVELS } from './thinking.mjs';
import { getChatStyle, setChatStyle } from './chatstyle.mjs';
import {
  getRetry429,
  setRetry429,
  retryState,
  startCooldown,
  isRateLimited,
  handoffMessage,
  recordMigration,
  setMigrating,
  getMigrating,
} from './retry429.mjs';
import { runSelfCheck, decideMode, lastSelfCheck, pendingIssues } from './selfcheck.mjs';
import {
  listModels,
  saveModel,
  deleteModel,
  selectModel,
  testModel,
  activeEndpoint,
  endpointFor,
  restoreEnvModel,
} from './models.mjs';
import { loadRewinds, effectiveIndexes, createRewind, undoLastRewind, restoreWorkspace } from './rewind.mjs';
import {
  isSessionId,
  newSessionId,
  loadSession,
  saveSession,
  listSessions,
  deleteSession,
  renameSession,
  getLastSessionId,
  setLastSessionId,
  titleFromMessage,
} from './sessions-core.mjs';

const PUBLIC = join(config.root, 'public');

/** 静默模式下少打日志（自检、测试用） */
const quietBoot = process.env.MINI_AGENT_QUIET === '1';

// Sessions are stored on disk (.state/sessions/<id>.json); this Map is only a hot cache.
const sessions = new Map();

/** Session from memory, else from disk, else null. */
function getSession(id) {
  if (!isSessionId(id)) return null;
  const hot = sessions.get(id);
  if (hot) return hot;
  const cold = loadSession(id);
  if (!cold) return null;
  sessions.set(id, cold);
  return cold;
}

/** What the UI needs to redraw a session: bubbles only, no tool/reasoning noise. */
function publicSession(session) {
  const turns = [];
  // 回退：只按「有效下标」画气泡，被撤回的那些直接不出现。
  const all = Array.isArray(session.messages) ? session.messages : [];
  const alive = new Set(effectiveIndexes(all, loadRewinds(session)).keep);
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (!m || m.context) continue;
    if (!alive.has(i)) continue;
    // content 可能是多模态数组（只在内存里出现过），取文字段
    const raw = m.content;
    const text = (Array.isArray(raw) ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : String(raw ?? '')).trim();
    const atts = [
      ...(Array.isArray(m._files) ? m._files.map((p) => ({ path: p, kind: 'file' })) : []),
      ...(Array.isArray(m._images) ? m._images.map((p) => ({ path: p, kind: 'image' })) : []),
    ].map((a) => ({ ...a, name: String(a.path).split(/[\\/]/).pop() }));
    if (!text && !atts.length) continue;
    if (m.role === 'user') {
      // 有 _text 就用它（那是主人真打的字）。
      // 老消息可能没存 _text，那就把拼进去的附件说明块剥掉，别糊在气泡里。
      let shown = typeof m._text === 'string' ? m._text : text;
      if (typeof m._text !== 'string' && atts.length) {
        // 附件说明块从它出现的地方一直到最后，整块切掉
        const mark = shown.indexOf('【主人随这条消息一起发来的');
        if (mark >= 0) shown = shown.slice(0, mark).trim();
      }
      turns.push({ role: 'user', text: shown, atts, rewindId: i });
    }
    else if (m.role === 'assistant') turns.push({ role: 'assistant', text, rewindId: i });
  }
  // 撤回记录本身也交出去，界面才能提示「还能撤销回退」
  const rewinds = loadRewinds(session);
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns,
    rewinds: rewinds.map((r) => ({ at: r.at, hidden: r.hidden })),
  };
}
/** 迁移完之后进冷却，别连环交接（配置里 cooldownMs=0 就不冷却） */
function startCooldownSafe() {
  try {
    const ms = getRetry429().cooldownMs;
    if (ms > 0 && typeof startCooldown === 'function') startCooldown(ms);
  } catch {}
}

/**
 * 正在跑那一轮的「直播缓存」：sessionId -> { events: [...], startedAt }
 *
 * 为什么要它：窗口关掉 / 切走 / 最小化之后，前端可能一条事件都没收到，
 * 或者只收到一半。等它回来看的时候，得能把错过的内容补回来——
 * 所以每一轮的事件都先在服务端记一份，前端要就整个重放。
 *
 * 只留最近这一轮；轮次结束不清空，留着让「刚回来看」的前端也能补上尾巴。
 */
const liveLogs = new Map();

/** 一轮能缓存多少事件（防止超长轮次吃内存） */
const LIVE_MAX_EVENTS = 20000;

// In-flight turns: sessionId -> { ac: AbortController, done: Promise<void> }
// 插话要先 abort，再等这一轮真的收尾（历史写完盘）后才能把新话接上去。
const runningTurns = new Map();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/**
 * 背景视频。必须支持 Range：
 * - <video loop> 要靠 206 才能边下边播，整段 200 会让它等到下载完；
 * - 只播 skin.mjs 认定的那一份（内置素材，或用户自己填的路径），
 *   前端塞 path 参数我一律不认，免得变成任意文件读取。
 */
function serveSkinVideo(req, res) {
  const file = skinVideoPath();
  if (!file) return json(res, 404, { error: '没有视频素材' });

  let size = 0;
  try {
    const st = statSync(file);
    if (!st.isFile()) return json(res, 404, { error: '没有视频素材' });
    size = st.size;
  } catch {
    return json(res, 404, { error: '读不到视频素材' });
  }

  const head = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  // 流必须挂 error：文件在播放途中消失（老的 portable 临时解包目录就是这样）时，
  // 不处理会变成主进程未捕获异常弹窗，还连带把服务拖死。
  const pipe = (opts) => {
    const s = createReadStream(file, opts);
    s.on('error', (e) => {
      console.warn('[skin] 视频读取中断：' + (e && e.message));
      try {
        res.destroy();
      } catch {}
    });
    s.pipe(res);
  };

  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (!m) {
    res.writeHead(200, { ...head, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    pipe();
    return;
  }

  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null) {
    // bytes=-N：要最后 N 个字节
    const n = end ?? 0;
    start = Math.max(0, size - n);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  res.writeHead(206, {
    ...head,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end();
  pipe({ start, end });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (name.includes('..')) return json(res, 400, { error: 'bad path' });
  try {
    const data = await readFile(join(PUBLIC, name));
    const type = name.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : name.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : name.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// 打包版首启把内置短片复制到可写的数据目录，之后只从那份读。
// 必须赶在第一个 /api/skin/video 请求之前。
ensureBundledVideo();

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const ep = activeEndpoint();
    return json(res, 200, {
      ok: true,
      version: config.version,
      model: ep.model,
      baseURL: ep.baseURL,
      hasKey: Boolean(ep.apiKey),
      source: ep.source,
      workspace: config.workspace,
    });
  }

  // ---- 模型：列表 / 新增或修改 / 删除 / 切换 / 试连通 ----
  if (req.method === 'GET' && url.pathname === '/api/models') {
    return json(res, 200, listModels());
  }

  if (req.method === 'POST' && url.pathname === '/api/models/save') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const saved = saveModel(payload ?? {});
      return json(res, 200, { model: saved, ...listModels() });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/models/delete') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, deleteModel(String(payload?.id ?? '')));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/models/select') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, selectModel(String(payload?.id ?? '')));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/models/test') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, await testModel(payload ?? {}));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 聊天风格：少说教开关 ----
  if (req.method === 'GET' && url.pathname === '/api/chatstyle') {
    const cur = getChatStyle();
    return json(res, 200, {
      ...cur,
      // 界面上要展示的两个开关，顺手把说明带上
      options: [
        {
          id: 'plainTalk',
          name: '少说教',
          desc: '不主动讲道理、不加免责声明、不因为题材就跳出来拒绝；底线不跟着变',
          value: cur.plainTalk,
        },
      ],
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/chatstyle/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, setChatStyle(payload ?? {}));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 正在跑那一轮的直播缓存（重启窗口后补画用） ----
  if (req.method === 'GET' && url.pathname === '/api/chat/live') {
    const sid = url.searchParams.get('sessionId') || '';
    if (!isSessionId(sid)) return json(res, 400, { error: 'bad sessionId' });
    const live = liveLogs.get(sid);
    if (!live) return json(res, 200, { sessionId: sid, running: false, events: [] });
    return json(res, 200, {
      sessionId: sid,
      running: !live.done,
      startedAt: live.startedAt,
      endedAt: live.endedAt ?? null,
      events: live.events,
    });
  }

  // ---- 哪些会话正在跑（界面切回来时用得上） ----
  if (req.method === 'GET' && url.pathname === '/api/running') {
    const list = [];
    for (const [id, t] of runningTurns.entries()) {
      const live = liveLogs.get(id);
      list.push({
        sessionId: id,
        startedAt: t.startedAt ?? 0,
        events: live ? live.events.length : 0,
      });
    }
    return json(res, 200, { running: list });
  }

  // ---- 429 自动回退：状态 / 开关 / 立即迁移 ----
  if (req.method === 'GET' && url.pathname === '/api/retry429') {
    const sid = url.searchParams.get('sessionId') || '';
    return json(res, 200, retryState(sid));
  }

  if (req.method === 'POST' && url.pathname === '/api/retry429/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      setRetry429(payload ?? {});
      return json(res, 200, retryState(String(payload?.sessionId ?? '')));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 手动「立即换会话」：主人不想等了，直接把当前会话交接到新会话
  if (req.method === 'POST' && url.pathname === '/api/retry429/migrate-now') {
    const { sessionId: sid = '' } = await body(req).catch(() => ({}));
    if (!isSessionId(sid)) return json(res, 400, { error: 'bad sessionId' });
    if (getMigrating()) return json(res, 409, { error: '已经有一个会话在交接了，等它跑完' });

    const cur = getSession(sid);
    if (!cur) return json(res, 404, { error: 'session not found' });
    // 正在跑的先停手，别并行
    const running = runningTurns.get(sid);
    if (running?.ac) {
      running.ac.abort();
      await Promise.race([running.done, new Promise((r) => setTimeout(r, 8000))]);
    }

    try {
      setMigrating(sid);
      const { handoffSummary } = await import('./retry429.mjs');
      const summaryText = handoffSummary(cur.messages ?? []);
      const newId = newSessionId();
      const fresh = {
        id: newId,
        title: titleFromMessage('（手动接续）' + (cur.title ?? '')),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          { role: 'system', content: systemPrompt(newId) },
          { role: 'user', content: handoffMessage(summaryText, cur.title ?? '') },
        ],
      };
      sessions.set(newId, fresh);
      saveSession(fresh);
      setLastSessionId(newId);
      startCooldownSafe();
      const info = recordMigration({ from: sid, to: newId, manual: true, summaryChars: summaryText.length });
      return json(res, 200, { ok: true, from: sid, to: newId, session: publicSession(fresh), migration: info });
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    } finally {
      setMigrating(null);
    }
  }

  // ---- 思考档位：读 / 改 ----
  if (req.method === 'GET' && url.pathname === '/api/thinking') {
    return json(res, 200, { ...getThinking(), levels: LEVELS });
  }

  if (req.method === 'POST' && url.pathname === '/api/thinking/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, { ...setThinking(payload ?? {}), levels: LEVELS });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 把删掉的 .env 模型恢复回列表 ----
  if (req.method === 'POST' && url.pathname === '/api/models/restore-env') {
    try {
      return json(res, 200, restoreEnvModel());
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 自检：看结果 / 手动重跑 ----
  if (req.method === 'GET' && url.pathname === '/api/selfcheck') {
    return json(res, 200, { last: lastSelfCheck(), pending: pendingIssues() });
  }

  if (req.method === 'POST' && url.pathname === '/api/selfcheck/run') {
    // 手动重跑一次 AI 自检（界面上的「重新自检」调这个）
    try {
      return json(res, 200, await runSelfCheck());
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 功能：列表 / 开 / 关 ----
  if (req.method === 'GET' && url.pathname === '/api/features') {
    return json(res, 200, getFeatures());
  }

  if (req.method === 'POST' && url.pathname === '/api/features/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, setFeature(payload?.id, payload?.enabled));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 视频背景：状态 / 旋钮 / 片子本身 ----
  if (req.method === 'GET' && url.pathname === '/api/skin') {
    return json(res, 200, getSkinState());
  }

  if (req.method === 'POST' && url.pathname === '/api/skin') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      writeSkin(payload ?? {});
      return json(res, 200, getSkinState());
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  }

  // 背景片子走这一条：带 Range，浏览器才能边下边播、循环拖动
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/skin/video') {
    return serveSkinVideo(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    return json(res, 200, { settings: getSettings(), defaults: DEFAULT_SETTINGS });
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    return json(res, 200, { settings: saveSettings(payload ?? {}) });
  }

  // 只恢复「底线」，安全词 / 人设 / 模型一概不动
  if (req.method === 'POST' && url.pathname === '/api/settings/reset-bottomlines') {
    try {
      return json(res, 200, resetBottomLines());
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 只恢复「安全词 + 触发说明」，底线 / 人设 / 模型一概不动
  // ---- 加号附件：只读地列目录 / 取图片预览 ----
  if (req.method === 'GET' && url.pathname === '/api/attach/browse') {
    const target = url.searchParams.get('path') || '';
    const kind = url.searchParams.get('kind') === 'image' ? 'image' : 'file';
    try {
      return json(res, 200, browse(target, kind));
    } catch (err) {
      return json(res, 400, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/attach/preview') {
    const target = url.searchParams.get('path') || '';
    try {
      return json(res, 200, readImageDataUrl(target));
    } catch (err) {
      return json(res, 400, { error: String(err?.message ?? err) });
    }
  }
  // <img src> 用这个：直接吐图片字节
  if (req.method === 'GET' && url.pathname === '/api/attach/raw') {
    const target = url.searchParams.get('path') || '';
    try {
      const img = readImageBytes(target);
      res.writeHead(200, { 'Content-Type': img.mime, 'Content-Length': img.size, 'Cache-Control': 'no-cache' });
      res.end(img.buf);
      return;
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(err?.message ?? err));
      return;
    }
  }


  if (req.method === 'POST' && url.pathname === '/api/settings/reset-safewords') {
    try {
      return json(res, 200, resetSafeWords());
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/persona') {
    return json(res, 200, personaInfo());
  }

  if (req.method === 'POST' && url.pathname === '/api/persona') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const info = payload?.reset === true
        ? resetUserPersona()
        : saveUserPersona(payload?.text ?? '');
      return json(res, 200, info);
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---------------- 会话级：这个会话用哪个模型 / 哪个思考强度 ----------------
  // 左上角那两个框改的就是这里。只影响当前会话，不碰右上角面板的设置。

  if (req.method === 'GET' && url.pathname === '/api/session-config') {
    const sid = url.searchParams.get('sessionId') || '';
    const ov = getOverride(sid);
    const epNow = activeEndpoint();
    const th = getThinking();

    // 模型名：会话临时切过就显示那个，否则显示右上角当前那个
    let modelId = ov.modelId || '';
    let modelName = epNow.name || epNow.model;
    if (ov.modelId) {
      const picked = endpointFor(ov.modelId);
      if (picked) modelName = picked.name || picked.model;
      else modelId = ''; // 那个模型被删了，回落
    }

    const level = ov.level || '';
    const levelName = level
      ? (LEVELS.find((l) => l.id === level)?.name || level)
      : '默认';

    return json(res, 200, {
      sessionId: sid,
      modelId,
      modelName: modelName || '没配模型',
      hasKey: Boolean(epNow.apiKey),
      level,
      levelName,
      isModelCustom: Boolean(modelId),
      isLevelCustom: Boolean(level),
      // 给下拉用
      models: listModels().models.map((m) => ({ id: m.id, name: m.name || m.model, active: m.active })),
      levels: LEVELS.map((l) => ({ id: l.id, name: l.name, desc: l.desc })),
      defaultLevelName: LEVELS.find((l) => l.id === (th.perModel[epNow.id] ?? th.level))?.name || '默认',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/session-config/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const sid = payload?.sessionId;
    if (!sid) return json(res, 400, { error: '没给 sessionId' });

    try {
      const patch = {};
      if (payload.modelId !== undefined) patch.modelId = payload.modelId;
      if (payload.level !== undefined) patch.level = payload.level;
      setOverride(sid, patch);

      const ov = getOverride(sid);
      const epNow = activeEndpoint();
      let modelName = epNow.name || epNow.model;
      if (ov.modelId) {
        const picked = endpointFor(ov.modelId);
        if (picked) modelName = picked.name || picked.model;
      }
      return json(res, 200, {
        sessionId: sid,
        modelId: ov.modelId || '',
        modelName,
        level: ov.level || '',
        levelName: ov.level ? (LEVELS.find((l) => l.id === ov.level)?.name || ov.level) : '默认',
        isModelCustom: Boolean(ov.modelId),
        isLevelCustom: Boolean(ov.level),
      });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---------------- 人设：多套、一键切换 ----------------
  // 老的两个 /api/persona 保持不动（存/恢复「当前这套」），下面这些是新加的。

  if (req.method === 'GET' && url.pathname === '/api/personas') {
    try {
      return json(res, 200, personaInfo());
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/new') {
    try {
      const payload = await body(req);
      return json(res, 200, createPersona({
        name: payload?.name,
        text: payload?.text,
        copyCurrent: payload?.copyCurrent !== false,
      }));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/switch') {
    try {
      const payload = await body(req);
      return json(res, 200, switchPersona(payload?.id));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/save') {
    try {
      const payload = await body(req);
      return json(res, 200, savePersonaText(payload?.id, payload?.text ?? ''));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/rename') {
    try {
      const payload = await body(req);
      return json(res, 200, renamePersona(payload?.id, payload?.name));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/delete') {
    try {
      const payload = await body(req);
      return json(res, 200, deletePersona(payload?.id));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/reset') {
    try {
      const payload = await body(req);
      return json(res, 200, resetPersona(payload?.id));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const list = listSessions();
    const last = getLastSessionId();
    const fallback = list.length ? list[0].id : null;
    return json(res, 200, {
      sessions: list,
      lastSessionId: last && list.some((s) => s.id === last) ? last : fallback,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/new') {
    const payload = await body(req).catch(() => ({}));
    const id = isSessionId(payload?.id) ? payload.id : newSessionId();
    const now = Date.now();
    const session = {
      id,
      title: String(payload?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || '\u65b0\u4f1a\u8bdd',
      createdAt: now,
      updatedAt: now,
      messages: [{ role: 'system', content: systemPrompt(id) }],
    };
    saveSession(session);
    sessions.set(id, session);
    setLastSessionId(id);
    return json(res, 200, { session: publicSession(session) });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/select') {
    const { id } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    setLastSessionId(id);
    return json(res, 200, { session: publicSession(session) });
  }

  // ---- 对话回退 ----
  // 只遮蔽不删除：往会话里追加一个回退点，老消息原样留在日志里。
  if (req.method === 'POST' && url.pathname === '/api/sessions/rewind') {
    const { id, at } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    if (runningTurns.get(id) && !runningTurns.get(id).ac.signal.aborted) {
      return json(res, 409, { error: '这个会话正在跑，先点停止再回退' });
    }
    repairHistory(session.messages);
    const out = createRewind(session, at);
    if (!out.ok) return json(res, 400, { error: out.error });
    // 文件按快照还原（以快照为准，只动真正不一致的文件）
    const files = restoreWorkspace(out.rewind.ws || {});
    saveSession(session);
    return json(res, 200, { ok: true, session: publicSession(session), files });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/rewind-undo') {
    const { id } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const out = undoLastRewind(session);
    if (!out.ok) return json(res, 400, { error: out.error });
    saveSession(session);
    return json(res, 200, { ok: true, session: publicSession(session) });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/rewind-preview') {
    const { id, at } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const all = Array.isArray(session.messages) ? session.messages : [];
    const view = effectiveIndexes(all, loadRewinds(session));
    const idx = Number(at);
    const cut = view.keep.filter((i) => i >= idx).length;
    // 目标那条往后的文件快照并起来，作为「会还原哪些文件」的清单
    const paths = new Set();
    for (const [k, v] of Object.entries(all[idx]?._ws || {})) if (v !== undefined) paths.add(k);
    for (const r of loadRewinds(session)) {
      if (r.at < idx) continue;
      for (const k of Object.keys(r.ws || {})) paths.add(k);
    }
    return json(res, 200, {
      ok: true,
      at: idx,
      text: typeof all[idx]?._text === 'string' ? all[idx]._text : '',
      removed: cut,
      files: [...paths],
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/rename') {
    const { id, title } = await body(req).catch(() => ({}));
    const saved = renameSession(id, title);
    if (!saved) return json(res, 400, { error: 'rename failed' });
    const hot = sessions.get(id);
    if (hot) hot.title = saved.title;
    return json(res, 200, { session: { id: saved.id, title: saved.title, updatedAt: saved.updatedAt } });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/delete') {
    const { id } = await body(req).catch(() => ({}));
    const ok = deleteSession(id);
    sessions.delete(id);
    const list = listSessions();
    const last = getLastSessionId();
    return json(res, 200, {
      ok,
      lastSessionId: last && list.some((s) => s.id === last) ? last : (list[0]?.id ?? null),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const { sessionId = 'default', message = '', resume = false } = payload;
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    // 允许「只发附件、不打字」
    if (!resume && !String(message).trim() && !attachments.length) {
      return json(res, 400, { error: 'empty message' });
    }
    const ep = activeEndpoint();
    if (!ep.apiKey) {
      return json(res, 400, { error: '还没配置模型：打开顶部「模型」按钮，填一份 API Key' });
    }

    if (!isSessionId(sessionId)) return json(res, 400, { error: 'bad sessionId' });

    // resume：接着已经落盘的历史继续跑（插话之后用），不再追加新消息。
    const existing = getSession(sessionId);
    if (resume && !existing) return json(res, 404, { error: 'session not found' });

    const session = existing ?? {
      id: sessionId,
      title: titleFromMessage(String(message).trim() || attachments.map((a) => a?.name).filter(Boolean).join(' ')),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ role: 'system', content: systemPrompt(sessionId) }],
    };
    const history = session.messages;
    let userMsgRef = null;
    if (!Array.isArray(history) || !history.length) {
      history.length = 0;
      history.push({ role: 'system', content: systemPrompt(sessionId) });
    }
    if (resume) {
      // 插话途中被打断，尾巴可能不齐，先修好再喂给模型。
      repairHistory(history);
    } else {
      const firstUserTurn = !history.some((m) => m.role === 'user' && !m.context);
      const userMsg = { role: 'user', content: composeUserContent(message, attachments) };
      // 图片路径单独记一份：落盘只留路径，发请求前再读成 base64
      const imgPaths = attachments.map((a) => a && a.path).filter((p) => p && isImagePath(p));
      const filePaths = attachments.map((a) => a && a.path).filter((p) => p && !isImagePath(p));
      if (imgPaths.length) userMsg._images = imgPaths;
      if (filePaths.length) userMsg._files = filePaths;
      // 主人原话单独留一份：气泡只显示这句，附件说明不往气泡里塞
      userMsg._text = String(message).trim();
      history.push(userMsg);
      userMsgRef = userMsg;
      if (firstUserTurn) session.title = titleFromMessage(message);
    }
    sessions.set(sessionId, session);
    saveSession(session);
    setLastSessionId(sessionId);

    const safeWord = resume ? null : matchSafeWord(message);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 这一轮的所有事件都先记进直播缓存，再往连接上写
    const live = { sessionId, events: [], startedAt: Date.now(), done: false };
    liveLogs.set(sessionId, live);

    const send = (ev) => {
      if (live.events.length < LIVE_MAX_EVENTS) live.events.push(ev);
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        // 连接早断了也无所谓：事件已经进缓存，人回来看的时候还能补
      }
    };
    // 带上这个词自己的说明：四个安全词干的事不一样，界面不能一律显示同一句
    if (safeWord) send({ type: 'safe_word', word: safeWord, note: safeWordNoteFor(safeWord) });

    const ac = new AbortController();
    let finishTurn;
    const done = new Promise((r) => { finishTurn = r; });
    /**
     * 这一轮不再跟 HTTP 连接绑死。
     *
     * 以前：浏览器一切走会话（或者刷新、关标签），req 的 close 就 abort，
     * 这一轮直接废掉——回复丢了，历史里只剩用户那句话。
     *
     * 现在：连接断了只是「没人看直播了」，模型继续跑、工具继续调、结果照常落盘。
     * 要真的停下，只有两条路：点「停止」按钮（/api/stop），或者插话（/api/interject）。
     *
     * 代价：没人看的轮次也会把 token 花完。所以界面上切走的会话会标个「在跑」，
     * 切回去还能看到进度。真不想让它跑，点停止就行。
     */
    runningTurns.set(sessionId, { ac, done, startedAt: Date.now(), sessionId });
    // 断线不 abort；只在记一笔，方便排查
    req.on('close', () => {
      if (!ac.signal.aborted) {
        if (!quietBoot) console.log(`[chat] 连接断了，但这一轮继续跑（session ${sessionId}）`);
      }
    });

    // 回退：发给模型的只有「有效历史」那份拷贝，日志本身一条不动。
    const view = effectiveIndexes(history, loadRewinds(session));
    const wireMessages = [...view.head.map((i) => history[i]), ...view.keep.map((i) => history[i])];
    // 这一轮改过的文件先记在这条消息身上；回退到它时一起还原。
    const snap = {};
    if (userMsgRef) userMsgRef._ws = snap;

    try {
      const { usage } = await runAgent({
        messages: wireMessages,
        sessionId,
        snap,
        safeMode: Boolean(safeWord),
        safeWord: safeWord || '',
        signal: ac.signal,
        onEvent: (ev) => {
          if (ev.type === 'aborted') send({ type: 'aborted' });
          else if (ev.type === 'compressed') send({ type: 'compressed', before: ev.before, after: ev.after, removed: ev.removed, error: ev.error });
          else if (ev.type === 'reasoning') send({ type: 'reasoning', text: ev.text });
          else if (ev.type === 'text') send({ type: 'text', text: ev.text });
          else if (ev.type === 'tool_start') send({ type: 'tool_start', id: ev.id, name: ev.name, args: ev.args });
          else if (ev.type === 'tool_end') send({ type: 'tool_end', id: ev.id, name: ev.name, ok: ev.ok, output: ev.output });
        },
      });
      send({ type: 'done', usage });
    } catch (err) {
      // 用户点了「停止」：不是错误，照实报一句就收尾。
      if (ac.signal.aborted) {
        send({ type: 'aborted' });
      } else if (err?.handoff) {
        // 撞限流太多次 → 换一个新会话接着干（交接，不并行）
        try {
          const oldId = sessionId;
          setMigrating(oldId);
          const summaryText = String(err.summary ?? '');
          const newId = newSessionId();
          const firstMsg = handoffMessage(summaryText, String(err.originalTask ?? ''));

          const fresh = {
            id: newId,
            title: titleFromMessage('（限流后接续）' + (String(err.originalTask ?? '').slice(0, 30) || '接着干')),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [
              { role: 'system', content: systemPrompt(newId) },
              { role: 'user', content: firstMsg },
            ],
          };
          sessions.set(newId, fresh);
          saveSession(fresh);
          setLastSessionId(newId);
          startCooldownSafe();

          const info = recordMigration({
            from: oldId,
            to: newId,
            streak: err.streak ?? 0,
            summaryChars: summaryText.length,
          });

          send({
            type: 'migrated',
            from: oldId,
            to: newId,
            title: fresh.title,
            summary: summaryText,
            streak: err.streak ?? 0,
            at: info.at,
          });
        } catch (e) {
          send({ type: 'error', message: '撞限流了，想换会话接着跑，但没换成功：' + String(e?.message ?? e) });
        } finally {
          setMigrating(null);
        }
      } else {
        const status = Number(err?.status ?? 0);
        const text = String(err?.text ?? err?.message ?? '');
        if (isRateLimited(status, text)) {
          send({ type: 'rate_limited', message: String(err?.message ?? err), streak: err?.streak ?? 0 });
        } else {
          send({ type: 'error', message: String(err?.message ?? err) });
        }
      }
    } finally {
      live.done = true;
      live.endedAt = Date.now();
      if (runningTurns.get(sessionId)?.ac === ac) runningTurns.delete(sessionId);
      saveSession(session);
      finishTurn();
    }
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const { sessionId = 'default' } = await body(req).catch(() => ({}));
    const turn = runningTurns.get(sessionId);
    if (turn?.ac) turn.ac.abort();
    return json(res, 200, { ok: true, stopped: Boolean(turn?.ac) });
  }

  // 生成中插话：先把这句落盘，再停住当前这一轮，让前端带着新话接着跑。
  if (req.method === 'POST' && url.pathname === '/api/interject') {
    const { sessionId = 'default', message = '' } = await body(req).catch(() => ({}));
    if (!isSessionId(sessionId)) return json(res, 400, { error: 'bad sessionId' });
    if (!message.trim()) return json(res, 400, { error: 'empty message' });

    const session = getSession(sessionId);
    if (!session) return json(res, 404, { error: 'session not found' });

    const turn = runningTurns.get(sessionId);
    if (turn?.ac) {
      turn.ac.abort();
      // 等这一轮真的收尾：历史写完盘、热缓存里的数组也定型了，才好往后接。
      await Promise.race([turn.done, new Promise((r) => setTimeout(r, 8000))]);
    }

    const history = session.messages;
    repairHistory(history);
    history.push({ role: 'user', content: message });
    sessions.set(sessionId, session);
    saveSession(session);
    setLastSessionId(sessionId);
    return json(res, 200, { ok: true, stopped: Boolean(turn?.ac), count: history.length });
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    const { sessionId = 'default' } = await body(req).catch(() => ({}));
    const session = getSession(sessionId);
    if (session) {
      session.messages = [{ role: 'system', content: systemPrompt(sessionId) }];
      saveSession(session);
    }
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET') return serveStatic(req, res);
  json(res, 405, { error: 'method not allowed' });
});

export function startServer({ port = config.port, quiet = false, selfCheck = true } = {}) {
  // 启动自检：异步跑，不挡服务起来。桌面版由 electron 先跑过一次，这里复用结果。
  if (selfCheck) {
    // 自检后台跑，不挡服务起来。环境检查由 AI 自己做（要调模型，可能慢几秒）。
    Promise.resolve()
      .then(() => (decideMode() === 'skip' ? null : runSelfCheck()))
      .then((r) => {
        if (!r || quiet) return;
        const s = r.summary;
        console.log(`[selfcheck] AI 自检 ${Math.round((r.tookMs ?? 0) / 100) / 10}s: ${s.okCount} ok / ${s.warnCount} warn / ${s.failCount} fail` + (s.fixedCount ? ` (${s.fixedCount} 项已自动修好)` : ''));
        if (r.skipped) console.log(`[selfcheck] 跳过：${r.skipped}`);
        if (r.summaryText) console.log(`[selfcheck] 结论：${r.summaryText}`);
        for (const i of r.items) {
          if (i.level === 'ok') continue;
          console.log(`[selfcheck] ${i.level === 'fail' ? '✗' : '!'} ${i.name}: ${i.detail}${i.fixed ? ' [已自动修复]' : ''}`);
        }
        if (r.needsRestart) {
          console.log('[update] 代码已自动更新，重启这个进程后生效。');
        }
      })
      .catch(() => {});
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      const url = `http://127.0.0.1:${actual}`;
      if (!quiet) {
        console.log(`小鱼Agent running: ${url}`);
        const bootEp = activeEndpoint();
        console.log(`  model    : ${bootEp.model}${bootEp.source === 'user' ? '（界面里选的）' : '（.env）'}`);
        console.log(`  endpoint : ${bootEp.baseURL}`);
        console.log(`  workspace: ${config.workspace}`);
        console.log(`  api key  : ${bootEp.apiKey ? 'loaded' : 'MISSING -> 打开界面顶部「模型」按钮配置'}`);
        console.log(`  rounds   : ${Number.isFinite(config.maxRounds) ? config.maxRounds : 'unlimited'}`);
        {
          // 真正生效的阈值是「设置面板里那个」，不是 config 里的兜底值，日志得说真话
          const ctx = effectiveContextLimit();
          console.log(`  context  : ${Number.isFinite(ctx) ? `${ctx} tokens, compress at ${Math.floor(ctx * config.contextTriggerRatio)} (${Math.round(config.contextTriggerRatio * 100)}%), keep ${config.contextKeepRatio}` : 'no limit'}`);
        }
      }
      resolve({ port: actual, url, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

// Auto-start when launched directly (node src/server.js).
const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/server.mjs');
if (isDirectRun) startServer().catch((err) => {
  console.error('failed to start:', err?.message ?? err);
  process.exit(1);
});
