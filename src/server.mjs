// Minimal web server: static UI + one SSE endpoint that runs the agent.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { join, isAbsolute as isAbsolutePath } from 'node:path';
import { config } from './config.mjs';
import { runAgent, systemPrompt, repairHistory } from './agent.mjs';
import { browse, readImageDataUrl, readImageBytes, composeUserContent, isImagePath } from './attach.mjs';
import { mimeOf, fileKindOf, fmtSize, outboxPath, sendCheck } from './outbox.mjs';
import { getOverride, setOverride } from './session-overrides.mjs';
// 前情：一进来就记得的那段对话。只贴给模型看，不进会话记录，界面也不会画出来。
import { preludeContextMessage, preludeInfo, addPreludeFromPath } from './prelude.mjs';
// 会话记忆文件：一个会话一份自己的本子，每轮拼进系统提示（见 persona.mjs 的 memoryBlock）。
import { ensureMemory, copyMemory, trashMemory, memoryInfo, readMemory, writeMemory, appendDigest, wipeMemory, snapMemory, SKELETON } from './session-memory.mjs';
import { editMessage, undoEdit, editInfo, editDigest, digestLines, syncMemoryAfterEdit, unsyncMemoryAfterEdit } from './edit.mjs';
// 整份数据备份：会话 / 人设 / 模型配置 / 设置，换电脑或重装时救命用。
import { backupSummary, buildBackup, restoreBackup } from './backup.mjs';
// 进行中那一轮的草稿：边跑边落，进程被杀也不会把已经说出来的话全丢。
import { saveDraft, readDraft, dropDraft, makeDraftThrottle } from './turn-draft.mjs';
// 进程兜底：一处没 catch 的异常不该让整个程序消失。
import { installGuards, crashSummary } from './crash-guard.mjs';
// 版本检查：每次启动跑一次（selfcheck 节流也照样查），界面上也能手动点。
import { quickCheck, updateStatus } from './updater.mjs';
import { buildSessionLog } from './session-log.mjs';
import { applySafeWord, sessionModeWord } from './mode.mjs';
import {
  getSettings,
  saveSettings,
  matchSafeWord,
  safeWordNoteFor,
  DEFAULT_SETTINGS,
  resetBottomLines,
  setDefaultBottomLines,
  setDefaults,
  defaultBottomLines,
  defaultSafeWords,
  defaultSafeWordNote,
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
  setPersonaAsBuiltinDefault,
  wipePersonaText,
  setPersonaAsDefault,
} from './persona-store.mjs';
import { getFeatures, setFeature } from './features.mjs';
// 纯净模式开关（见 pure.mjs）
import { pureModeOn, setPureMode, pureSystemPrompt } from './pure.mjs';
import {
  getSkinState,
  writeSkin,
  skinVideoPath,
  skinMusicPath,
  importMusic,
  ensureBundledVideo,
  ensureBundledMusic,
} from './skin.mjs';
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
  hasOpening,
  markOpened,
  seedOpeningMessages,
  finishOpening,
  openingEnabled,
  openingTexts,
  setOpeningTexts,
  resetOpeningTexts,
  openingHeadIndexes,
  isOpeningMessage,
} from './opening.mjs';
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
import { loadRewinds, effectiveIndexes, createRewind, undoLastRewind, restoreWorkspace, restoreMemory } from './rewind.mjs';
import {
  publicMobileState,
  enableMobile,
  disableMobile,
  rotateMobileToken,
  forgetDevice,
  checkAccess,
  touchDevice,
  pairingInfo,
  lanAddresses,
} from './mobile.mjs';
import { qrSvg, pairingUrl } from './qrcode.mjs';
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
  exportSession,
  exportAllSessions,
  parseImport,
  importSessions,
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
  // 哪些句子主人手动改过（下标 → 最后一次改的时间），界面据此点「· 改过」
  const editedAt = editInfo(session);
  // 会话开头那一对 user→assistant 是新建时垫的：它们在历史里就是两条真实的对话，
  // 模型看到的就是这一份完整的记录（不带任何记号），只有界面从开头把它们跳过。
  // 用位置判断而不是在消息上打标记，是为了让盘里的历史干干净净、看不出人工痕迹。
  const headSkip = openingHeadIndexes(all);
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (!m || m.context) continue;
    if (headSkip.has(i)) continue;
    if (!alive.has(i)) continue;
    // content 可能是多模态数组（只在内存里出现过），取文字段
    const raw = m.content;
    const text = (Array.isArray(raw) ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : String(raw ?? '')).trim();
    const atts = [
      ...(Array.isArray(m._files) ? m._files.map((p) => ({ path: p, kind: 'file' })) : []),
      ...(Array.isArray(m._images) ? m._images.map((p) => ({ path: p, kind: 'image' })) : []),
    ].map((a) => {
      const name = String(a.path).split(/[\\/]/).pop();
      // 顺手带上大小：界面要靠它显示「名字 · 12.3 MB · 下载」，跟「发文件」那套卡片一致。
      // stat 失败（文件被挪走）就不给 size，界面那一栏自动空着。
      let size = 0;
      try {
        size = statSync(a.path).size;
      } catch {}
      return { ...a, name, size };
    });
    if (!text && !atts.length) continue;
    const edited = Object.prototype.hasOwnProperty.call(editedAt, i);
    if (m.role === 'user') {
      // 有 _text 就用它（那是主人真打的字）。
      // 老消息可能没存 _text，那就把拼进去的附件说明块剥掉，别糊在气泡里。
      let shown = typeof m._text === 'string' ? m._text : text;
      if (typeof m._text !== 'string' && atts.length) {
        // 附件说明块从它出现的地方一直到最后，整块切掉
        const mark = shown.indexOf('【主人随这条消息一起发来的');
        if (mark >= 0) shown = shown.slice(0, mark).trim();
      }
      turns.push({ role: 'user', text: shown, atts, rewindId: i, edited });
    }
    else if (m.role === 'assistant') turns.push({ role: 'assistant', text, rewindId: i, edited, out: Array.isArray(m._out) ? m._out : [] });
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
 * 收原始字节（导入音乐用）。
 *
 * 跟 body() 的区别：这个不解析 JSON，直接把请求体攒成 Buffer。
 * 加了上限，免得有人误传一个 2GB 的文件把内存吃光。
 */
async function bodyBuffer(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw Object.assign(new Error(`文件太大了（超过 ${Math.round(limit / 1024 / 1024)} MB）`), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 导出文件名里用的时间戳：20261023-034512 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 新建会话时垫在历史最前面那几条。
 *
 * 一般就是一条 system（人设 + 规矩）。**纯净模式下系统提示是空串，那就一条都别放** ——
 * 空的 system 发出去有的网关会 400，留在盘里也只是个占位的空壳。
 * 关掉纯净模式之后，runAgent 的 refreshSystem 会在这一轮开头把 system 补回来。
 */
function sysSeed(sessionId) {
  const text = systemPrompt(sessionId);
  return text ? [{ role: 'system', content: text }] : [];
}

/**
 * 把开场那一轮的结果落到会话里，并让它对后面这一轮「算数」。
 *
 * @param {object} session 会话
 * @param {object} openingUser 开场用的那条 user（模型输出暂存在它的 _got 上）
 * @param {object[]} [wire] 这一轮要发给模型的数组；给了就把开场两条插进去
 *                           （不给就是新建时后台跑，那时候还没有 wire）
 */
function applyOpening(session, openingUser, wire) {
  const text = String(openingUser && openingUser._got ? openingUser._got : '').trim();
  if (openingUser) delete openingUser._got;
  if (!text) {
    // 一个字都没说出来：把占位那条摘掉，别留个空 user 在历史里
    const at = session.messages.indexOf(openingUser);
    if (at >= 0) session.messages.splice(at, 1);
    if (wire) {
      const wat = wire.indexOf(openingUser);
      if (wat >= 0) wire.splice(wat, 1);
    }
    markOpened(session.id);
    delete session._openingUser;
    return false;
  }
  finishOpening(session, openingUser, text);
  if (wire) {
    // 开场那两条必须出现在这一轮发给模型的数组里，不然模型看不到自己刚说过的话。
    // 插的是 history 里的那一条对象（不是副本）——commitWireBack 只接
    // 「session.messages 里没有的新对象」，对象一致才不会重复接一次。
    const idx = session.messages.indexOf(openingUser);
    const reply = idx >= 0 ? session.messages[idx + 1] : null;
    const at = wire.indexOf(openingUser);
    if (at >= 0 && reply && wire[at + 1] !== reply) wire.splice(at + 1, 0, reply);
  }
  delete session._openingUser;
  return true;
}

/**
 * 新建会话时把开场那两轮接进历史。
 *
 * 主人要的是「新建那一瞬间就已经历过第一轮」。以前是让模型现场编开场白，
 * 每次都不一样；主人 2026-10-23 给了定稿（`D:\小鱼\第一轮对话` 里那个新会话的
 * 前两条），改成写死 —— 所以现在不需要跑模型、不需要等，建完立刻就有这两条。
 *
 * 保留 async 签名：调用方是 fire-and-forget 的 .catch()，改成同步会炸它。
 */
async function startOpening(sessionId) {
  // 功能面板里关掉「开场白」就什么都不垫，新建会话直接是白纸。
  if (!openingEnabled()) return;
  // 纯净模式：开场白那两条也是「设定」，而且它前面那句「在吗」对模型来说
  // 就是一段来历不明的前情。纯净模式下不垫 —— 新会话就是真的空。
  if (pureModeOn()) return;
  const session = getSession(sessionId);
  if (!session || hasOpening(session)) return;
  const { userMsg, assistantText } = seedOpeningMessages();
  const at = session.messages.findIndex((m) => m && m.role !== 'system' && !m.context);
  const pair = [userMsg, { role: 'assistant', content: assistantText }];
  if (at < 0) session.messages.push(...pair);
  else session.messages.splice(at, 0, ...pair);
  markOpened(session.id);
  saveSession(session);
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

/** 按扩展名给音乐一个像样的 Content-Type，浏览器才肯直接播 */
function musicMime(file) {
  const ext = String(file).split('.').pop().toLowerCase();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a' || ext === 'aac' || ext === 'mp4') return 'audio/mp4';
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'webm') return 'audio/webm';
  return 'application/octet-stream';
}

/**
 * 背景音乐。跟视频一样必须支持 Range（音频播放器要拖进度条），
 * 而且只播 skin.mjs 认定的那一份，不接受前端传路径。
 */
function serveSkinMusic(req, res) {
  const file = skinMusicPath();
  if (!file) return json(res, 404, { error: '没有背景音乐' });

  let size = 0;
  try {
    const st = statSync(file);
    if (!st.isFile()) return json(res, 404, { error: '没有背景音乐' });
    size = st.size;
  } catch {
    return json(res, 404, { error: '读不到背景音乐' });
  }

  const head = {
    'Content-Type': musicMime(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  const pipe = (opts) => {
    const s = createReadStream(file, opts);
    s.on('error', (e) => {
      console.warn('[skin] 音乐读取中断：' + (e && e.message));
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
    const head = { 'Content-Type': type, 'Cache-Control': 'no-store' };

    /**
     * 手机壳第一次进来时地址里带 ?token=…，这里顺手把它种成 cookie。
     *
     * 为什么要 cookie：WebView 里页面自己发的 fetch 带不上自定义头（loadUrl 的
     * Map 只对主框架生效），token 放 URL query 也不行 —— 页面代码全是绝对路径
     * '/api/xxx'，绝对路径不继承文档的 query。只有 cookie 是浏览器自动带的，
     * 页面一行都不用改。种上之后后面所有请求 checkAccess 都能认出来。
     *
     * httpOnly 关掉是故意的：页面自己不需要读它，但关掉便于以后在手机上排查；
     * 这是内网自建服务，token 本来也只在局域网里有意义。
     */
    const qTok = (url.searchParams.get('token') || '').trim();
    if (qTok && name.endsWith('.html')) {
      head['Set-Cookie'] =
        `xy_token=${encodeURIComponent(qTok)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    }

    res.writeHead(200, head);
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// 打包版首启把内置短片复制到可写的数据目录，之后只从那份读。
// 必须赶在第一个 /api/skin/video 请求之前。
ensureBundledVideo();
// 内置背景音乐同理（壁纸那首抽出来的曲子），赶在 /api/skin/music 之前。
ensureBundledMusic();

/** 本机请求？手机配对守卫用它决定要不要记设备、要不要放行 */
function isLoopbackReq(req) {
  const a = String(req.socket?.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** 现在监听的实际端口（listen 之前是 0，配对页拿到也没用，所以用它兜底） */
let listeningPort = 0;
function currentPort() {
  try {
    const a = server.address();
    if (a && typeof a === 'object' && a.port) return a.port;
  } catch {}
  return listeningPort || config.port;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  /**
   * 局域网（手机）那一侧不在 HTTP 上做跨域。
   *
   * 为什么要专门写：APK 里的 WebView 加载的就是 http://192.168.x.x:8787 本身（同源，本来用不上 CORS）。
   * 可要是给局域网来的请求发 `Access-Control-Allow-Origin: *`，手机浏览器里随便哪个网页、
   * 别的 App 的 WebView 就能跨域读写这台电脑 —— token 又是能塞进 ?token= 的。
   * 所以干脆一条 CORS 头都不给（WebSocket 握手不受 CORS 限制，照常能连）。
   * 桌面版/本机回环不受影响：它跟页面同源，也不需要这些头。
   */
  const isLocalReq = isLoopbackReq(req);
  const rawSetHeader = res.setHeader.bind(res);
  if (!isLocalReq) {
    res.setHeader = (k, v) => {
      if (!String(k).toLowerCase().startsWith('access-control-')) rawSetHeader(k, v);
      return res;
    };
  }

  /**
   * 手机配对守卫。只有一句话：**开了局域网，就必须带对 token**。
   *
   * 为什么自己写而不是交给 WebView / 反向代理：这台服务能读能写文件、能跑命令，
   * 局域网里谁都能访问等于把机器交出去。token 是唯一的门。
   *
   * 例外（有意为之）：
   *  - 本机回环地址永远放行，桌面版自己要用；
   *  - /api/health 放行，手机靠它探「这台电脑在不在」，它不含任何隐私；
   *  - /api/mobile/ping 放行，配对页要用它判断「地址对不对」。
   */
  const openPaths = new Set(['/api/health', '/api/mobile/ping']);
  if (!openPaths.has(url.pathname)) {
    const gate = checkAccess(req);
    if (!gate.ok) {
      return json(res, 401, {
        error: 'unauthorized',
        reason: gate.reason,
        hint:
          gate.reason === 'off'
            ? '这台服务只监听本机。要在手机上用，先在电脑上打开【设置 → 手机连接】开启局域网。'
            : '配对码不对。在电脑上打开【设置 → 手机连接】重新扫码。',
      });
    }
    if (gate.ok && !isLocalReq) touchDevice(req);
  }

  // ---- 手机配对 ----
  // 这几条只让本机访问（配对页在电脑上开）。手机那边只认 token，不需要这些接口。
  if (url.pathname.startsWith('/api/mobile/')) {
    const local = isLoopbackReq(req);
    if (req.method === 'GET' && url.pathname === '/api/mobile/ping') {
      // 手机用：只回「到了没、要不要 token」，不泄露地址和设备信息。
      // needToken 问的是「有没有开局域网」，不是命中计数（那个变量根本不存在，别再用）。
      return json(res, 200, {
        ok: true,
        app: 'xiaoyu-agent',
        version: config.version,
        needToken: publicMobileState().enabled,
      });
    }
    if (!local) {
      return json(res, 403, { error: '只能在电脑上操作配对' });
    }
    if (req.method === 'GET' && url.pathname === '/api/mobile/state') {
      return json(res, 200, { ...publicMobileState(), port: currentPort(), hosts: lanAddresses() });
    }
    if (req.method === 'POST' && url.pathname === '/api/mobile/enable') {
      const b = await body(req).catch(() => ({}));
      const s = enableMobile({ resetToken: Boolean(b?.resetToken) });
      return json(res, 200, { ...publicMobileState(), token: s.token, port: currentPort(), hosts: lanAddresses() });
    }
    if (req.method === 'POST' && url.pathname === '/api/mobile/disable') {
      disableMobile();
      return json(res, 200, publicMobileState());
    }
    if (req.method === 'POST' && url.pathname === '/api/mobile/rotate') {
      const s = rotateMobileToken();
      return json(res, 200, { ...publicMobileState(), token: s.token });
    }
    if (req.method === 'POST' && url.pathname === '/api/mobile/forget') {
      const b = await body(req).catch(() => ({}));
      forgetDevice(String(b?.id || ''));
      return json(res, 200, publicMobileState());
    }
    // 配对页要展示的完整信息（含 token 明文、二维码 SVG，只在本机给）
    if (req.method === 'GET' && url.pathname === '/api/mobile/pairing') {
      const info = pairingInfo(currentPort());
      /**
       * 每个能连的地址各配一个二维码。
       *
       * 以前只给 urls[0] 一个码，地址一多就会「扫到的那个连不上」——
       * 排第一的是 Wi-Fi，可人可能在别的网络里；Radmin 那种跨网络的地址
       * 反而排第二，扫不到就以为连不上。现在一次全给，界面上并排列出来。
       *
       * hosts 是 [{name, address, kind}]，用 address 拼 URL；别直接拼对象
       * （会变成 http://[object Object]:8787）。
       */
      const urls = info.hosts.map((h) => `http://${typeof h === 'string' ? h : h.address}:${info.port}`);
      const endpoints = info.hosts.map((h, i) => {
        const url = urls[i];
        const kind = typeof h === 'string' ? 2 : Number(h.kind) || 0;
        return {
          name: typeof h === 'string' ? '' : String(h.name || ''),
          address: typeof h === 'string' ? h : h.address,
          url,
          kind,
          label: kind === 0 ? '同一个 Wi-Fi' : kind === 1 ? '跨网络（组网工具）' : '其它网络',
          qr: info.token ? qrSvg(pairingUrl(url, info.token), { scale: 5, margin: 2 }) : '',
        };
      });
      return json(res, 200, {
        ...info,
        urls,
        endpoints,
        qr: endpoints[0]?.qr || '',
      });
    }
    return json(res, 404, { error: 'no such mobile endpoint' });
  }

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
    // 「还在跑」以真正登记在跑的轮次为准，不能只看这份缓存标记。
    // 缓存只活在内存里：进程一崩/一重启，那份 done=false 就留在了旧对象上；
    // 界面照着它当「还在跑」，就会一直等一条永远不会来的回复。
    const alive = runningTurns.has(sid);
    return json(res, 200, {
      sessionId: sid,
      running: alive && !live.done,
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
          ...sysSeed(newId),
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

  // ---- 纯净模式：读状态 / 切换 ----
  //
  // 状态存在服务端（.state/pure.json），不放 localStorage：
  // 换设备、换浏览器都得一致，而且服务端拼系统提示时自己要知道开没开。
  if (req.method === 'GET' && url.pathname === '/api/pure') {
    return json(res, 200, { on: pureModeOn() });
  }

  if (req.method === 'POST' && url.pathname === '/api/pure') {
    let payload = {};
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      // 不传 on 就当作「翻一下」，前端点按钮不用自己算当前值
      const next = typeof payload?.on === 'boolean' ? payload.on : !pureModeOn();
      return json(res, 200, { on: setPureMode(next) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 开场白那两段隐藏对话：读 / 改 / 恢复默认 ----
  if (req.method === 'GET' && url.pathname === '/api/opening') {
    return json(res, 200, openingTexts());
  }

  if (req.method === 'POST' && url.pathname === '/api/opening') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, setOpeningTexts(payload || {}));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/opening/reset') {
    return json(res, 200, resetOpeningTexts());
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

  // 背景曲子走这条：同样带 Range，音频要能循环、能拖进度条
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/skin/music') {
    return serveSkinMusic(req, res);
  }

  // 导入一首自己的音乐：整个请求体就是文件字节，文件名放在 ?name=
  //
  // 为什么不用 multipart：解析 multipart 要引依赖，而这边前端用 FormData 之外
  // 直接 fetch(file) 就能把 File 当 body 送过来，简单又不会出错。
  if (req.method === 'POST' && url.pathname === '/api/skin/music/import') {
    const name = url.searchParams.get('name') || 'music.m4a';
    let buf;
    try {
      buf = await bodyBuffer(req, 64 * 1024 * 1024);
    } catch (err) {
      return json(res, err?.status ?? 400, { error: String(err?.message ?? err) });
    }
    try {
      const dest = importMusic(name, buf);
      return json(res, 200, { ok: true, file: dest, ...getSkinState() });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 把音乐恢复成内置那首（壁纸那首）
  if (req.method === 'POST' && url.pathname === '/api/skin/music/reset') {
    try {
      writeSkin({ musicFile: '', musicOn: true });
      return json(res, 200, { ok: true, ...getSkinState() });
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  }

  // 背景片子走这一条：带 Range，浏览器才能边下边播、循环拖动
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/skin/video') {
    return serveSkinVideo(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    // defaults 交的是「当前生效的默认值」：主人定过就用主人定的那版
    return json(res, 200, {
      settings: getSettings(),
      defaults: { ...DEFAULT_SETTINGS, bottomLines: defaultBottomLines() },
    });
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

  // 把「现在生效的」底线 / 安全词 / 安全词说明一起定成默认（三样独立判定）
  if (req.method === 'POST' && url.pathname === '/api/settings/defaults') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const out = setDefaults({
        bottomLines: payload?.bottomLines,
        safeWords: payload?.safeWords,
        safeWordNote: payload?.safeWordNote,
      });
      return json(res, 200, {
        ...out,
        defaults: {
          ...DEFAULT_SETTINGS,
          bottomLines: defaultBottomLines(),
          safeWords: defaultSafeWords(),
          safeWordNote: defaultSafeWordNote(),
        },
        settings: getSettings(),
      });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/settings/default-bottomlines') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const out = setDefaultBottomLines(payload?.bottomLines ?? []);
      return json(res, 200, { ...out, settings: getSettings() });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
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
  // 出件箱兜底：/api/attach/outbox-out?key=xxx
  // 发出去的文件都会往 .state/outbox 抄一份；消息里的路径没了（换了机器、原文件删了）就点这个
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/attach/outbox-out') {
    const key = url.searchParams.get('key') || '';
    const op = outboxPath(key);
    if (!op) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('兜底箱里没有这个文件了');
      return;
    }
    const ost = statSync(op);
    const oname = String(key).replace(/^o-[0-9a-f]{10}-/, '') || 'file';
    res.writeHead(200, {
      'Content-Type': mimeOf(op),
      'Content-Length': ost.size,
      'Cache-Control': 'no-cache',
      'Content-Disposition': "inline; filename*=UTF-8''" + encodeURIComponent(oname),
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(op).pipe(res);
    return;
  }

  // 文件的字节：<img src> / <video src> / 点一下下载，全走这个。
  // 「发文件」功能发出去的也在这里出（任何后缀都行）：
  // download=1 就当场存盘（文件名原样给回去），不带就 inline（缩略图 / 播放用）。
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/attach/raw'
      && (url.searchParams.get('download') === '1' || !isImagePath(url.searchParams.get('path') || ''))) {
    const abs = String(url.searchParams.get('path') || '');
    try {
      if (!abs || !isAbsolutePath(abs)) throw new Error('只接受绝对路径');
      // 跟「发文件」一个规矩：只给放行的盘，程序自己的机密（.env / .state / node_modules）不给
      const bad = sendCheck(abs);
      if (bad) throw new Error(bad);
      const fst = statSync(abs);
      if (!fst.isFile()) throw new Error('不是一个文件：' + abs);
      const fname = abs.split(/[\\/]/).pop() || 'file';
      const cd = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
      res.writeHead(200, {
        'Content-Type': mimeOf(abs),
        'Content-Length': fst.size,
        'Cache-Control': 'no-cache',
        'Content-Disposition': cd + "; filename*=UTF-8''" + encodeURIComponent(fname),
      });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(abs).pipe(res);
      return;
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(err?.message ?? err));
      return;
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

  // 把当前这套人设存成默认（以后「恢复成默认内容」就回到这套）
  if (req.method === 'POST' && url.pathname === '/api/personas/set-default') {
    try {
      const payload = await body(req);
      return json(res, 200, setPersonaAsDefault(payload?.id));
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

  // 把「现在这套人设」定成默认（以后「恢复成默认内容」回到它）
  if (req.method === 'POST' && url.pathname === '/api/personas/as-default') {
    try {
      const payload = await body(req);
      return json(res, 200, setPersonaAsBuiltinDefault(payload?.id));
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
      messages: sysSeed(id),
      // 这个会话还没开过场：下面 /api/chat 收到第一次 resume 时会先补一轮开场白。
      // （不在新建接口里直接跑模型 —— 新建要立刻返回，不能让界面等十几秒）
      _openingPending: true,
    };
    saveSession(session);
    sessions.set(id, session);
    // 新会话当场就有一份自己的记忆本子（骨架），不用等到第一次开口才建
    try {
      ensureMemory(id);
    } catch (err) {
      console.warn('[memory] 新会话本子没建起来：', String(err?.message ?? err));
    }
    setLastSessionId(id);
    // 建完就立刻去跑开场（后台跑，不等它）。主人要的是「新建那一瞬间就已经历过第一轮」，
    // 所以不能等主人先开口 —— 但也不能让新建接口卡十几秒，所以 fire-and-forget。
    // 失败无所谓：开场跑不出来就当没开过场，主人第一句话照样能聊。
    startOpening(id).catch((err) => console.warn('[opening] 后台开场没跑成：', String(err?.message ?? err)));
    return json(res, 200, { session: publicSession(session), memory: memoryInfo(id) });
  }

  /**
   * 在当前会话的某一轮之后「开一个新会话接着往下聊」（DSH 的 branch）。
   *
   * 跟 rewind 不一样：**不动原会话**，把原会话到这一轮为止的消息复制一份到新会话里，
   * 手动复制那几个文件也不动。主人想从某个岔路口往另一个方向试，原会话还在。
   *
   * 新会话要先过一遍压缩历史：原会话里可能已经有旧的 context 消息，
   * 再叠一份新的系统提示就成两套规则了，模型会挑着看。
   */
  if (req.method === 'POST' && url.pathname === '/api/sessions/branch') {
    const { id, at, title } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const src = getSession(id);
    if (!src) return json(res, 404, { error: 'session not found' });
    repairHistory(src.messages);

    const msgs = Array.isArray(src.messages) ? src.messages : [];
    // at 是「用户那句话」在 messages 里的下标（前端 done 事件里就带的这个数）。
    // 不传 / 传坏了就整段复制。
    let end = Number.isFinite(Number(at)) ? Math.floor(Number(at)) : msgs.length - 1;
    if (end < 0 || end >= msgs.length) end = msgs.length - 1;

    const newId = newSessionId();
    const now = Date.now();
    // 拷一份，别把原会话的消息对象换个会话继续共用（后面会被改写 content）
    const copied = msgs.slice(0, end + 1).map((m) => JSON.parse(JSON.stringify(m)));
    // 分支点之后的「回退点」与文件快照不再适用，丢掉
    const keptRewinds = (Array.isArray(src.rewinds) ? src.rewinds : []).filter(
      (r) => Number.isFinite(Number(r?.at)) && Number(r.at) <= end,
    );
    const session = {
      id: newId,
      title:
        String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) ||
        (src.title ? `${src.title} (分支)` : '分支会话'),
      createdAt: now,
      updatedAt: now,
      messages: copied.length ? copied : sysSeed(newId),
      rewinds: keptRewinds,
      // 档位跟着过来：原会话要是在「停下」档，分支也接着那一档
      mode: src.mode?.word ? { word: src.mode.word, since: now } : null,
      branchedFrom: { id, at: end },
    };
    saveSession(session);
    sessions.set(newId, session);
    // 分支继承原会话的记忆本子：这一段对话是接着往下长的，前情该记得的一样得记得。
    try {
      copyMemory(id, newId);
    } catch (err) {
      console.warn('[memory] 分支记忆没继承成：', String(err?.message ?? err));
    }
    setLastSessionId(newId);
    return json(res, 200, { session: publicSession(session), from: id, at: end });
  }

  // ---- 会话记忆（一个会话一份本子） ----------------------------------------
  // 放在会话那一组接口旁边：它跟会话同生共死，删除时一起进回收站、分支时一起继承。

  // 读：没建过就先建骨架再返回（新建会话走不到这里也不怕）
  if (req.method === 'GET' && url.pathname === '/api/sessions/memory') {
    const id = url.searchParams.get('id') || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    try {
      const text = ensureMemory(id);
      return json(res, 200, { id, text, ...memoryInfo(id) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 写：整份覆盖（界面上的编辑器、我改文件都用这条）
  if (req.method === 'POST' && url.pathname === '/api/sessions/memory') {
    const payload = await body(req).catch(() => ({}));
    const id = payload?.id || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    if (typeof payload?.text !== 'string') return json(res, 400, { error: '没有正文' });
    try {
      writeMemory(id, payload.text);
      return json(res, 200, { ok: true, id, ...memoryInfo(id) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 加一条滚动摘要：编号自己算，满 80 条自动把最旧的挪进归档
  if (req.method === 'POST' && url.pathname === '/api/sessions/memory/digest') {
    const payload = await body(req).catch(() => ({}));
    const id = payload?.id || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    try {
      const out = appendDigest(id, payload?.summary);
      return json(res, 200, { ok: true, id, index: out.index, folded: out.folded.length, ...memoryInfo(id) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 清空：回到骨架。删之前备份，返回备份路径
  if (req.method === 'POST' && url.pathname === '/api/sessions/memory/wipe') {
    const payload = await body(req).catch(() => ({}));
    const id = payload?.id || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    try {
      const out = wipeMemory(id);
      return json(res, 200, { ok: true, id, ...out, ...memoryInfo(id) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 下载：存成 .md，主人能拿去看
  if (req.method === 'GET' && url.pathname === '/api/sessions/memory/export') {
    const id = url.searchParams.get('id') || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const text = ensureMemory(id);
    const name = encodeURIComponent(`会话记忆-${id}.md`);
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${name}`,
      'cache-control': 'no-store',
    });
    return res.end(text);
  }

  // ---- 改某一句 / 撤销修改 ------------------------------------------------
  // 「改一句」有两种：改对话本身、改它在记忆本子里那条摘要。都记进 session.edits，
  // 撤销时按后进先出还原，只动那一句，别的一句不碰。

  if (req.method === 'POST' && url.pathname === '/api/sessions/edit') {
    const { id, at, text } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    // 跑着的时候不让改：「改一句」和「模型正在读这一句」抢同一份 messages，
    // 落盘顺序一乱就会互相覆盖。判断的是这一轮真的还在跑（signal 没 abort）。
    // 注意 runningTurns 是在 res.writeHead 之后才 set 的，这里只是拦「已经开始跑」的。
    const busyTurn = runningTurns.get(id);
    if (busyTurn && !busyTurn.ac.signal.aborted) {
      return json(res, 409, { error: '这个会话正在跑，先点停止再改' });
    }
    const out = editMessage(session, at, text);
    if (!out.ok) return json(res, 400, { error: out.error });
    if (!out.unchanged) saveSession(session);
    // 改完对话，把这个会话记忆本子里提到这句话的地方也换成新的（主人明确要的）
    let mem = null;
    if (!out.unchanged) {
      try {
        const s = syncMemoryAfterEdit(id, out.before, out.after);
        mem = { changed: s.changed, lines: s.changed, where: s.where };
        // 改了本子哪几行、原来长什么样，抄一份到这次改动记录上。
        // 撤销时就按这份记录原样写回去 —— 不能靠拿原话再去本子里匹配，
        // 本子里存的是截断后的新内容，原话开头已经没了，匹配必然失败（踩过）。
        if (s.changed) {
          const stack = Array.isArray(session.edits) ? session.edits : [];
          const last = stack[stack.length - 1];
          if (last) {
            last.memNote = s.hits;
            saveSession(session);
          }
        }
      } catch (e) {
        mem = { changed: 0, lines: 0, where: [], error: e.message };
      }
    }
    return json(res, 200, {
      ok: true,
      unchanged: Boolean(out.unchanged),
      session: publicSession(session),
      edits: editInfo(session),
      memory: mem,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/edit-undo') {
    const { id, at } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const out = undoEdit(session, at);
    if (!out.ok) return json(res, 400, { error: out.error });
    saveSession(session);
    // 撤销也要把记忆一起退回去，不然本子里留着「改成了…」会很怪
    let mem = null;
    try {
      const s = unsyncMemoryAfterEdit(id, out.memNote);
      mem = { changed: s.changed };
    } catch (e) {
      mem = { changed: 0, error: e.message };
    }
    return json(res, 200, {
      ok: true, at: out.idx, text: out.text, unchanged: false,
      session: publicSession(session), edits: editInfo(session), memory: mem,
    });
  }

  // 改摘要：lineNo 是摘要行 `- R0001 …` 里的编号
  if (req.method === 'POST' && url.pathname === '/api/sessions/memory/digest/edit') {
    const { id, index, summary } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const out = editDigest(id, index, summary);
    if (!out.ok) return json(res, 400, { error: out.error });
    return json(res, 200, { ok: true, ...out, ...memoryInfo(id), digests: digestLines(id) });
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions/memory/digests') {
    const id = url.searchParams.get('id') || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    return json(res, 200, { id, digests: digestLines(id) });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/select') {
    const { id } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    setLastSessionId(id);
    // 上次这一轮没跑完（进程被杀 / 断电 / 点了退出）留下的草稿：
    // 把已经说出来的话补成一条正式的助手消息，别让主人以为「记忆丢了」。
    // 只在没有在跑的时候补 —— 正在跑的那一轮草稿是活着的，补进去就重复了。
    let recovered = false;
    const runningNow = runningTurns.get(id);
    if (!runningNow || runningNow.ac.signal.aborted) {
      const draft = readDraft(id);
      if (draft && draft.text.trim()) {
        const last = session.messages[session.messages.length - 1];
        // 只有「最后一句话是主人说的」才补：说明确实缺了这条回复。
        // 否则草稿多半是以前遗留的脏数据，补进去反而多一条。
        if (last && last.role === 'user') {
          session.messages.push({
            role: 'assistant',
            content: draft.text.trim() + '\n\n（说到这儿断了一下——当时程序被关了，这段话是接回来的。）',
            _recovered: true,
          });
          session.updatedAt = Date.now();
          saveSession(session);
          recovered = true;
        }
        dropDraft(id);
      }
    }
    // 顺带把本子的状态带回去，界面不用再单发一次请求就知道有没有记忆
    return json(res, 200, { session: publicSession(session), memory: memoryInfo(id), recovered });
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
    // 记忆跟着一起退回这一轮开始时的样子，否则对话退回去了、记忆还记着后来那些事
    const memory = restoreMemory(session, out.rewind);
    saveSession(session);
    return json(res, 200, { ok: true, session: publicSession(session), files, memory });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/rewind-undo') {
    const { id } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    // undoLastRewind 会把被摘掉那个回退点的 mem / ws 一起带回来（它在删之前取的），
    // 所以这里拿到的是真快照。撤销回退 = 记忆也回到「还没退」的样子。
    const out = undoLastRewind(session);
    if (!out.ok) return json(res, 400, { error: out.error });
    let memory = null;
    if (out.hasMem) {
      try {
        memory = snapMemory(id, out.mem ?? null);
      } catch {
        memory = null;
      }
    }
    saveSession(session);
    return json(res, 200, { ok: true, session: publicSession(session), memory });
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
    // 本子跟着会话走：挪进 .state/memory/.trash，不直接删（主人可能想找回）
    try {
      trashMemory(id);
    } catch {}
    sessions.delete(id);
    const list = listSessions();
    const last = getLastSessionId();
    return json(res, 200, {
      ok,
      lastSessionId: last && list.some((s) => s.id === last) ? last : (list[0]?.id ?? null),
    });
  }

  // 批量删除：POST /api/sessions/delete-many  { ids: [...] }
  // 跟单个删除一模一样，只是循环一遍、一次把结果报回去（前端不用发几十个请求）。
  if (req.method === 'POST' && url.pathname === '/api/sessions/delete-many') {
    const { ids } = await body(req).catch(() => ({}));
    const want = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [];
    if (!want.length) return json(res, 400, { error: '没有选中要删的会话' });
    const done = [];
    const failed = [];
    for (const id of want) {
      try {
        const ok = deleteSession(id);
        try {
          trashMemory(id);
        } catch {}
        sessions.delete(id);
        if (ok) done.push(id);
        else failed.push(id);
      } catch (e) {
        failed.push(id);
      }
    }
    const list = listSessions();
    const last = getLastSessionId();
    return json(res, 200, {
      ok: true,
      deleted: done.length,
      failed,
      lastSessionId: last && list.some((s) => s.id === last) ? last : (list[0]?.id ?? null),
      remaining: list.length,
    });
  }

  // ---- 整份数据备份 / 恢复 -------------------------------------------------
  // 会话、人设、模型配置、设置……全在这里。换电脑 / 重装 / 换安装方式时用。
  // 概览：GET /api/backup/info
  if (req.method === 'GET' && url.pathname === '/api/backup/info') {
    return json(res, 200, { ok: true, ...backupSummary() });
  }
  // 版本情况：GET /api/update/status  → 当前版本、上次更新什么时候、失败的话什么时候重试
  if (req.method === 'GET' && url.pathname === '/api/update/status') {
    return json(res, 200, { ok: true, ...(await updateStatus()) });
  }
  // 马上查一次：POST /api/update/check { force?: true }
  // force 默认 true —— 人主动点的，就别管那个「失败后歇 6 小时」的节流了
  if (req.method === 'POST' && url.pathname === '/api/update/check') {
    const bodyJson = await body(req).catch(() => null);
    const force = bodyJson?.force !== false;
    const r = await quickCheck({ force });
    return json(res, 200, { ok: true, ...r });
  }
  // 下载整包：GET /api/backup/export
  if (req.method === 'GET' && url.pathname === '/api/backup/export') {
    const payload = buildBackup();
    if (!payload.count) return json(res, 404, { error: '没有可备份的数据' });
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    const filename = `小鱼Agent-数据备份-${stamp()}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(buf.length),
      'Content-Disposition': `attachment; filename="xiaoyu-backup-${stamp()}.json"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }
  // 恢复：POST /api/backup/restore  { data: <包内容，对象或字符串>, mode: 'merge' | 'replace' }
  if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
    const bodyJson = await body(req).catch(() => null);
    if (!bodyJson) return json(res, 400, { error: '请求体不是合法 JSON' });
    const mode = bodyJson.mode === 'replace' ? 'replace' : 'merge';
    try {
      const out = restoreBackup(bodyJson.data, { mode });
      return json(res, 200, out);
    } catch (e) {
      return json(res, e.status || 500, { error: e.message || '恢复失败' });
    }
  }

  // ---- 会话日志（.zip）------------------------------------------------------
  // GET /api/sessions/log?id=xxx  → 把这个会话的原始记录 + 附件打成压缩包下载
  //
  // 跟上面那个 /api/sessions/export 不是一回事：
  //   export 给的是「能再导进来」的 JSON；log 给的是「能拿去看、拿去查」的压缩包，
  //   消息一条不删（系统提示、隐藏的开场轮都在），附带的图片文件也一并塞进去。
  // 同一条路也认 HEAD：前端点「下载日志」时先探一下，好提前把错误摆出来
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/sessions/log') {
    const id = url.searchParams.get('id') || getLastSessionId() || '';
    const s = id ? getSession(id) : null;
    if (!s) return json(res, 404, { error: '找不到这个会话' });
    try {
      const out = buildSessionLog(s);
      if (!out.ok) return json(res, 400, { error: out.error });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': String(out.bytes),
        'Content-Disposition': `attachment; filename="xiaoyu-session-log.zip"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
        'Cache-Control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : out.buffer);
    } catch (e) {
      return json(res, 500, { error: '打包失败：' + (e && e.message ? e.message : e) });
    }
  }

  // ---- 会话导入 / 导出 -----------------------------------------------------
  // 导出单会话：GET /api/sessions/export?id=xxx  → 直接当文件下载
  // 导出全部：  GET /api/sessions/export?all=1   → 整包
  if (req.method === 'GET' && url.pathname === '/api/sessions/export') {
    const wantAll = url.searchParams.get('all') === '1';
    let payload;
    let filename;
    if (wantAll) {
      payload = exportAllSessions();
      filename = `小鱼Agent-全部会话-${stamp()}.json`;
      if (!payload.sessions.length) return json(res, 404, { error: '一个会话都没有' });
    } else {
      const id = url.searchParams.get('id') || '';
      payload = exportSession(id);
      if (!payload) return json(res, 404, { error: '找不到这个会话' });
      const safe = payload.session.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '会话';
      filename = `小鱼Agent-${safe}-${stamp()}.json`;
    }
    const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(buf.length),
      // 中文文件名走 filename* （RFC 5987），别用裸 filename，Windows 下载会变乱码
      'Content-Disposition': `attachment; filename="xiaoyu-session-${stamp()}.json"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  // 导入：POST /api/sessions/import  { data: <导出文件的内容，对象或字符串> }
  if (req.method === 'POST' && url.pathname === '/api/sessions/import') {
    const bodyJson = await body(req).catch(() => null);
    if (!bodyJson) return json(res, 400, { error: '请求体不是合法 JSON' });
    let raw = bodyJson.data;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: '文件内容不是合法 JSON' });
      }
    }
    const drafts = parseImport(raw);
    if (!drafts.length) return json(res, 400, { error: '里面没有能用的会话（要么没消息，要么格式不对）' });
    const made = importSessions(drafts);
    if (!made.length) return json(res, 500, { error: '写文件失败，一个都没导进来' });
    return json(res, 200, { ok: true, imported: made, count: made.length });
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
    // 这个会话已经在跑就别再起一轮：两轮同时改同一个 messages 数组，改一句话也会打架。
    // 注意判断要用「这里的 sessionId」——别处的接口用的是 id 变量，名字不一样。
    if (runningTurns.has(sessionId)) {
      return json(res, 409, { error: '这个会话还在跑，等它跑完（或者点停止）再发' });
    }
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
      messages: sysSeed(sessionId),
    };
    const history = session.messages;
    let userMsgRef = null;
    if (!Array.isArray(history) || !history.length) {
      history.length = 0;
      history.push(...sysSeed(sessionId));
    }
    if (resume) {
      // 插话途中被打断，尾巴可能不齐，先修好再喂给模型。
      repairHistory(history);
    }
    // 这个会话还没开场：先把开场那两轮补上。
    //
    // 正常情况下 /api/sessions/new 已经写好了（startOpening 是同步的、不调模型），
    // 只有老会话（这功能上线之前建的）或文件被手改过才会走到这里。补进去的两条
    // 跟新建时一模一样，都对模型可见；气泡不画 —— publicSession 按开头位置跳过那一对。
    //
    // 条件：从没开过场、功能面板里没关掉它，而且这不是「接着跑」（resume）。
    // resume 是插话/续跑，那时候补开场会把顺序搞乱。
    const wantOpening = !resume && openingEnabled() && !hasOpening(session) && session._openingPending !== false
      // 纯净模式：开场白也是「设定」，开场白连着它前面那段用户消息一起不发
      && !pureModeOn();
    if (wantOpening) {
      const { userMsg: openingUser, assistantText } = seedOpeningMessages();
      // 插在 system（+可能的 context）之后、现有对话之前，顺序才对
      const at = history.findIndex((m) => m && m.role !== 'system' && !m.context);
      const pair = [openingUser, { role: 'assistant', content: assistantText }];
      if (at < 0) history.push(...pair);
      else history.splice(at, 0, ...pair);
      delete session._openingPending;
    }
    if (!resume) {
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
    // 这一轮该处在哪一档：没喊别的词就继续当前档（新会话默认人设档），
    // 喊了就切过去并记住，下一轮还是那一档。
    const modeInfo = resume ? { word: sessionModeWord(session), switched: false } : applySafeWord(session, message);
    const changedMode = modeInfo.switched || modeInfo.backToBase;
    if (changedMode) saveSession(session);
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
    // 安全词提示不在这个位置发：send 还没定义，以前就是在这儿炸掉整轮的（见下面 send 之后那段）。

    const ac = new AbortController();
    let finishTurn;
    const done = new Promise((r) => { finishTurn = r; });
    /**
     * 安全词提示：必须等 send 定义好之后再发。
     * 以前这两行写在上面（send 声明之前），只要这轮点了「命令」这种会切档的词，
     * 一进 /api/chat 就抛 ReferenceError，被外层 catch 接走 ——
     * 界面看到的就是「只回了个空字 / 问了没反应」。modeInfo 到这里还没被重新赋值，
     * 用的仍是 applySafeWord 的结果，发出去的档位跟以前一模一样。
     */
    if (modeInfo.switched) send({ type: 'safe_word', word: modeInfo.word, note: safeWordNoteFor(modeInfo.word) });
    else if (modeInfo.backToBase) send({ type: 'safe_word', word: modeInfo.word, note: safeWordNoteFor(modeInfo.word), back: true });
    /**
     * 先把这轮登记进 runningTurns，再往下跑。
     *
     * 以前是等 try 里拼好 ac 之后才 sessions.set/登记，中间那几步（补开场、写历史、
     * 匹配安全词）任何一处抛错，界面就只有一条「用户说了话、我一个字没回」。
     * 现在登记放前面：哪怕下面立刻炸了，界面也知道这一轮「结束了」，
     * 而不是看着一份永远 done=false 的缓存以为它还在跑。
     */
    // 先占个位（ac 还没有，下面建好再换成真的）；收尾时按「对象」摘，不按 ac 比。
    const reg = { ac: null, done: Promise.resolve(), startedAt: live.startedAt, sessionId };
    // 这一轮已经说出来的字，实时挂在这儿。
    // 进程级兜底（installGuards 的 onFatal）在退出前会读这个字段补写最后一份草稿，
    // 免得「正好在两次自动写盘之间崩溃」时丢掉最后一小段。
    reg.draft = { text: '', reasoning: '', tools: [], startedAt: reg.startedAt };
    runningTurns.set(sessionId, reg);

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
    reg.ac = ac;
    reg.done = done;
    runningTurns.set(sessionId, reg);
    // 断线不 abort；只在记一笔，方便排查
    req.on('close', () => {
      if (!ac.signal.aborted) {
        if (!quietBoot) console.log(`[chat] 连接断了，但这一轮继续跑（session ${sessionId}）`);
      }
    });

    // 回退：发给模型的只有「有效历史」那份拷贝，日志本身一条不动。
    const view = effectiveIndexes(history, loadRewinds(session));
    let wireMessages = [...view.head.map((i) => history[i]), ...view.keep.map((i) => history[i])];
    // 纯净模式：把开场那两条（user + assistant）从这一轮真正发出去的内容里摘掉。
    //
    // 为什么不从 history 里删：那是会话记录，主人还能翻回来看；
    // 而且一删下次又「没开过场」，会再补一遍。所以只在这一刻的拷贝上摘。
    if (pureModeOn()) {
      wireMessages = wireMessages.filter((m) => !isOpeningMessage(m));
      // 系统提示一律不发：老会话盘里存的是完整人设，不摘掉就等于
      // 一边说"纯净"一边还带着人设说话。context 那条规则副本同理。
      wireMessages = wireMessages.filter((m) => !(m && (m.role === 'system' || m.context)));
      // 然后只补一条「答短点」。为什么还要发点什么：系统提示全空的话，
      // 模型没有任何长度锚点，纯净模式反而变得比人设模式还能唠。
      // 注意顺序——先摘干净再补，否则刚补的这条会被上面那个 filter 一起摘掉。
      const brief = pureSystemPrompt();
      if (brief) wireMessages.unshift({ role: 'system', content: brief });
    }
    // 前情：只贴给模型看，不进会话记录。
    // 位置在 system（+上下文说明）之后、真正的对话之前 —— 模型读起来就是「之前聊过的」。
    //
    // 插入点为什么是 2 而不是 view.head.length：
    //   head 是 [system] 或 [system, context]，那个 context 是「设定与规则」的副本
    //   （agent.mjs 的 contextMessage，很多网关会丢 system，所以规则要发两遍）。
    //   插在 1 会把规则副本和前情拆开，规则副本就不挨着 system 了；插在 2 才是
    //   「设定 → 设定副本 → 前情 → 真正的对话」，读起来顺序对。
    //
    // 为什么不能插在 messages 上：runAgent 每轮开头会重建那两条（agent.mjs 61-80 行），
    //   而重建时会 map 出新对象、把带 context 的消息挤到 1 号位 —— 前情会被顶掉。
    //   所以前情是在「已经重建完之后」才贴上去的，就一次，不参与重建。
    // 会话里的 system 永远是设置里那套人设，前情一个字都不往里塞。
    {
      const pm = preludeContextMessage();
      // 纯净模式：前情也是「设定」，不发。
      if (pm && !pureModeOn()) wireMessages.splice(2, 0, pm);
    }
    /** 前情那条消息的引用，日志里好认（纯净模式没插，就是 undefined） */
    const preludeRef = pureModeOn() ? undefined : wireMessages[2];
    // 这一轮真正交给模型的形状，日志里留一份，排查时一眼看得出前情在不在
    console.log(
      '[prelude] 条数=' + wireMessages.length + ' 形状=' +
        wireMessages.map((m) => m.role + (m === preludeRef ? '(前情)' : m.context ? '(规则)' : '')).join(' → '),
    );
    /**
     * wireMessages 是给模型的副本：回退掉的那些不能出现在上下文里。
     * 但模型这一轮新说的话（assistant / tool 轮）是 push 到 wireMessages 上的，
     * 必须接回 history，否则 session.messages 永远只有用户那句话 ——
     * 重启后打开会话就只剩自己的话（这个 bug 真发生过，别再删这段）。
     *
     * 为什么不用下标：runAgent 开头遇到「没有 context 消息」时会把整个数组清空重建
     * （见 agent.mjs 第 76-78 行），下标全错位，用下标会把 user 消息重复接一次。
     * 所以这里记「跑之前有哪些消息对象」的 Set，跑完只接不在集合里的那些。
     */
    const seenBefore = new Set(history);
    const wireSeenBefore = new Set(wireMessages);
    const committed = new Set();
    const commitWireBack = () => {
      let n = 0;
      for (const m of wireMessages) {
        if (!m || wireSeenBefore.has(m) || committed.has(m)) continue;
        committed.add(m);
        // 只接对话轮次；system / context 是每轮重算的，不进历史
        if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
        if (m.context) continue;
        // 开场那两条自己走 finishOpening，不走这里。
        // 不然开场白会被接两次：一次是 finishOpening 插的，一次是这里接的，
        // 历史里就出现两条一模一样的助手消息（这个 bug 真发生过，别删这段）。
        // 历史里已经有了这条（同一对象）就不用再接；
        // 开场那两条走 applyOpening / finishOpening 插进 history，对象一致，会走到这一句。
        if (seenBefore.has(m)) continue;
        history.push(m);
        n++;
      }
      return n;
    };
    // 这一轮改过的文件先记在这条消息身上；回退到它时一起还原。
    const snap = {};
    if (userMsgRef) {
      userMsgRef._ws = snap;
      // 记忆本子也拍一张：回退到这一句时，本子退回到这一轮开始前的样子。
      // 记在消息上而不是 rewinds 里，是因为消息本身会被 saveSession 原样存下来。
      userMsgRef._mem = readMemory(sessionId);
    }

    try {
      // 先补开场轮：这一次模型调用只让小鱼说开场白，别的话一句都不要。
      //
      // 一般情况下开场在「新建会话」那一刻就已经后台跑完了（startOpening），
      // 走到这里说明那时候没跑成（没配模型、断网、进程刚好被打断）——
      // 那就趁主人第一次开口这一轮补上，补不上就算了，别耽误回主人。
      if (wantOpening && !ac.signal.aborted) {
        const openingUser = session._openingUser;
        try {
          // 开场轮跑的是深拷贝：runAgent 会往传进去的数组里 push 一条 assistant
          // （agent.mjs:208），共用对象的话它会跟 wireMessages 里那条打架，
          // 历史里就会出现两条一模一样的开场白（真出过，别改回去）。
          const openingWire = wireMessages.slice(0, wireMessages.indexOf(openingUser) + 1).map((m) => ({ ...m }));
          await runAgent({
            messages: openingWire,
            sessionId,
            safeMode: false,
            safeWord: '',
            signal: ac.signal,
            // 开场的字一个都不往界面上发：主人视角里看不到这一轮
            onEvent: (ev) => { if (ev.type === 'text') openingUser._got = (openingUser._got || '') + ev.text; },
          });
        } catch (err) {
          console.warn('[opening] 开场白没跑成：', String(err?.message ?? err));
        }
        applyOpening(session, openingUser, wireMessages);
        saveSession(session);
      }

      // 这一轮的草稿：边跑边落，进程中途没了也能把已经说的话捡回来。
      // 只在这一轮内部有效，整轮收尾时（下面 finally）会删掉。
      let draftText = '';
      let draftReasoning = '';
      const draftTools = [];
      const draftStartedAt = Date.now();
      const shouldDraft = makeDraftThrottle();

      const { usage, files: sentFiles } = await runAgent({
        messages: wireMessages,
        sessionId,
        snap,
        // 没喊别的安全词就是「待在当前档」——新会话天然是「人设」档；
        // 喊了别的词就临时切过去，这句话说完仍继续保持那一档，直到再切回来。
        safeMode: modeInfo.switched,
        safeWord: modeInfo.word || '',
        signal: ac.signal,
        onEvent: (ev) => {
          // 边收边存草稿：进程被杀 / 断电时，已经说出来的字不至于全丢。
          // 正式历史仍然只在整轮跑完后接（commitWireBack），草稿只是保险。
          if (ev.type === 'text') {
            draftText += ev.text;
            // 同步到 reg.draft：进程兜底退出前会读它补写最后一份，见 installGuards
            if (reg.draft) reg.draft.text = draftText;
            if (shouldDraft(draftText.length)) {
              saveDraft(sessionId, {
                text: draftText,
                reasoning: draftReasoning,
                toolCalls: draftTools,
                startedAt: draftStartedAt,
              });
            }
          } else if (ev.type === 'reasoning') {
            draftReasoning += ev.text;
            if (reg.draft) reg.draft.reasoning = draftReasoning;
          } else if (ev.type === 'tool_start' || ev.type === 'tool_end') {
            draftTools.push({ type: ev.type, name: ev.name, at: Date.now() });
            if (reg.draft) reg.draft.tools = draftTools;
            if (shouldDraft(draftText.length, true)) {
              saveDraft(sessionId, {
                text: draftText,
                reasoning: draftReasoning,
                toolCalls: draftTools,
                startedAt: draftStartedAt,
              });
            }
          }

          if (ev.type === 'aborted') send({ type: 'aborted' });
          else if (ev.type === 'compressed') send({ type: 'compressed', before: ev.before, after: ev.after, removed: ev.removed, error: ev.error });
          else if (ev.type === 'reasoning') send({ type: 'reasoning', text: ev.text });
          else if (ev.type === 'text') send({ type: 'text', text: ev.text });
          else if (ev.type === 'tool_start') send({ type: 'tool_start', id: ev.id, name: ev.name, args: ev.args });
          else if (ev.type === 'tool_end') send({ type: 'tool_end', id: ev.id, name: ev.name, ok: ev.ok, output: ev.output });
        },
      });
      // 把这一轮模型说的话接回正式历史，再算「用户那句话」的下标
      commitWireBack();
      // 「发文件」发出去的东西挂到最后那条助手消息身上：
      // 跟着会话一起落盘，重开窗口还画得出来；点一下就能预览 / 下载。
      {
        const sent = Array.isArray(sentFiles) ? sentFiles.filter(Boolean) : [];
        if (sent.length) {
          const msgs = session.messages;
          let idx = -1;
          for (let k = msgs.length - 1; k >= 0; k--) {
            const m = msgs[k];
            if (m && m.role === 'assistant' && !m.context) { idx = k; break; }
          }
          if (idx >= 0) {
            // 合并而不是覆盖：同一轮可能分几次发，前一批不能被后一批冲掉。
            const prev = Array.isArray(msgs[idx]._out) ? msgs[idx]._out : [];
            const merged = prev.slice();
            for (const it of sent) {
              const dup = merged.some((x) => x && x.key && it && x.key === it.key);
              if (!dup) merged.push(it);
            }
            msgs[idx]._out = merged;
            // 顺手在会话记忆本子里记一笔：消息万一丢了，记忆里还留着
            // 「这一轮发过什么、在出件箱里叫什么名字」，主人还能从兜底箱捞回来。
            // 只记文件名和 key，不记完整路径（路径换机器就失效了）。
            // 记忆写失败不能影响发文件本身，但也不能悄悄吞掉——记一条日志方便查。
            try {
              const names = sent.map((x) => String(x?.name || '文件')).join('、');
              appendDigest(sessionId, `发了文件：${names}`);
            } catch (e) {
              console.warn('[sendfile] 记忆本子没记上：', String(e?.message ?? e), 'sessionId =', sessionId);
            }
            send({ type: 'files', items: sent, at: idx });
            saveSession(session);
          }
        }
      }
      // 带上这一轮用户消息的下标：前端据此给刚画出来的气泡补「↶ 回退」按钮
      const doneAt = userMsgRef ? session.messages.indexOf(userMsgRef) : -1;
      // 带上真正用的模型名（不是主人起的外号）—— 前端要拿它查价目表算这一轮花多少钱。
      // 界面上写的是「DeepSeek官方」，价目表里认的是 deepseek-flash，不传这个就永远算不出来。
      send({ type: 'done', usage, at: doneAt, model: ep.model });
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
              ...sysSeed(newId),
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
        // 交接成功也是「这一轮到此为止」：换会话之前说过的话得接回历史，
        // 不然重启之后打开旧会话，会只剩主人的问题、没有我的回答。
        try {
          commitWireBack();
        } catch {}
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
      // 收尾时把自己这一条登记摘掉（提前登记过、ac 可能还是 null，所以认对象不认 ac）
      {
        const mine = runningTurns.get(sessionId);
        if (mine === reg || (mine && mine.ac === ac)) runningTurns.delete(sessionId);
      }
      // 正常结束那条路已经接过一次；出错 / 被中止时这里兜底，
      // 不然「半截回答」也跟着丢。commitWireBack 内部用 Set 记账，重复调不会重复接。
      try {
        commitWireBack();
      } catch {}
      saveSession(session);
      // 这一轮已经进了正式历史，草稿没用了，删掉。
      // 注意顺序：saveSession 必须在 dropDraft 之前 —— 万一存盘失败，
      // 草稿还在，下次打开还能救回来。
      dropDraft(sessionId);
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
    /**
     * 「清空当前」= 把这个会话删掉、当场开一个新的。
     *
     * 为什么改成这样（主人原话：清空当前只等于把这个会话删了再建一个新的）：
     *   以前的实现是在**原会话**上把 messages 重置回 system 那一条 —— 会话 id 不变、
     *   创建时间不变、记忆本子也不动。于是「清空」之后那个会话还带着旧名字、
     *   旧记忆，看着就不像新开的。而且原来还挂着两个勾选框（清会话记忆 / 清人设），
     *   主人明确不要那两个选项了，一并去掉。
     *
     * 现在的语义跟「删除 + 新建」完全一致：
     *   - 旧会话整个挪进 .trash（跟 /api/sessions/delete 一条路，能找回）
     *   - 它的记忆本子也挪进 .trash
     *   - 新会话拿新 id、新标题、新建时间，system 提示按当前设置重新拼一份
     *   - 新会话也照常排队开场白（跟新建接口一样 fire-and-forget）
     * 返回新会话的 id，前端拿它切过去。
     */
    const old = getSession(sessionId);
    if (old) {
      try {
        deleteSession(sessionId);
      } catch (e) {
        console.warn('[reset] 旧会话没删成：', String(e?.message ?? e));
      }
      try {
        trashMemory(sessionId);
      } catch {}
      sessions.delete(sessionId);
    }

    const id = newSessionId();
    const now = Date.now();
    const session = {
      id,
      title: '新会话',
      createdAt: now,
      updatedAt: now,
      messages: sysSeed(id),
      _openingPending: true,
    };
    saveSession(session);
    sessions.set(id, session);
    try {
      ensureMemory(id);
    } catch (err) {
      console.warn('[memory] 清空后新会话的本子没建起来：', String(err?.message ?? err));
    }
    setLastSessionId(id);
    startOpening(id).catch((err) => console.warn('[opening] 清空后的开场没跑成：', String(err?.message ?? err)));

    return json(res, 200, {
      ok: true,
      // 旧会话的 id 一并给出去，前端要用它把界面上的旧东西撤掉
      cleared: old ? sessionId : null,
      session: publicSession(session),
      memory: memoryInfo(id),
    });
  }

  if (req.method === 'GET') return serveStatic(req, res);
  json(res, 405, { error: 'method not allowed' });
});

export function startServer({ port = config.port, quiet = false, selfCheck = true } = {}) {
  // 第一件事：装上进程兜底。
  // 以前整个项目没有 uncaughtException / unhandledRejection 处理，
  // Node 15 之后一个没人接的 Promise 拒绝就能把进程直接杀掉——
  // 表现就是「聊着聊着她突然没了」，跑长任务时那一轮回复全丢。
  // 退出之前先把每个正在跑的会话的草稿落盘，草稿会在下次打开时接回来。
  installGuards({
    onFatal: () => {
      for (const id of runningTurns.keys()) {
        try {
          const s = runningTurns.get(id);
          const d = s && s.draft;
          if (d && String(d.text || '').trim()) {
            saveDraft(id, { text: d.text, reasoning: d.reasoning || '', toolCalls: d.tools || [], startedAt: d.startedAt });
          }
        } catch {}
      }
    },
  });

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
    /**
     * 监听地址：默认只监听 127.0.0.1（本机）。
     * 开了手机配对（.state/mobile.json 里 enabled=true）之后才监听 0.0.0.0，
     * 局域网里的手机连得上；此时所有请求都要过 checkAccess 的 token 校验。
     */
    const lanOn = publicMobileState().enabled;
    const bindHost = lanOn ? '0.0.0.0' : '127.0.0.1';
    server.listen(port, bindHost, () => {
      const actual = server.address().port;
      listeningPort = actual;
      const url = `http://127.0.0.1:${actual}`;
      if (!quiet) {
        console.log(`小鱼Agent running: ${url}`);
        if (lanOn) {
          for (const h of lanAddresses()) console.log(`  手机访问 : http://${h.address}:${actual}/  （配对码在 设置→手机连接）`);
          if (!lanAddresses().length) console.log('  手机访问 : 没找到局域网 IPv4 地址，检查 Wi-Fi/网线');
        }
        const bootEp = activeEndpoint();
        console.log(`  model    : ${bootEp.model}${bootEp.source === 'user' ? '（界面里选的）' : '（.env）'}`);
        console.log(`  endpoint : ${bootEp.baseURL}`);
        console.log(`  workspace: ${config.workspace}`);
        console.log(`  api key  : ${bootEp.apiKey ? 'loaded' : 'MISSING -> 打开界面顶部「模型」按钮配置'}`);
        console.log(`  rounds   : ${Number.isFinite(config.maxRounds) ? config.maxRounds : 'unlimited'}`);
        {
          // 真正生效的阈值是「设置面板里那个」，不是 config 里的兜底值，日志得说真话。
          // 填多少就是多少，所以不再乘什么比例，直接报 limit。
          const ctx = effectiveContextLimit();
          console.log(`  context  : ${Number.isFinite(ctx) ? `${ctx} tokens, compress at exactly ${ctx} (100%), keep last ~${config.contextKeepTokens} tokens` : 'no limit'}`);
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
