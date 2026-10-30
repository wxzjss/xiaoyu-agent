/**
 * QQ 的「自己注册的号」这条道 —— OneBot v11。
 *
 * ── 为什么要有这个文件 ─────────────────────────────────────────
 *
 * 官方机器人（`@tencent-connect/qqbot-nodejs`）能力是阉割的：能发文字、图、
 * 语音、文件，但**没有戳一戳、没有 QQ 收藏表情包、没有群精华、没有群管理**。
 * 主人 2026-11-03 要的「戳一戳 / 表情包 / 引用 / 扫码连自己注册的号」，官方那套
 * 给不了。参考 dsh-channel-qq 的做法：挂一个协议端（NapCat / LLOneBot /
 * Lagrange），小鱼Agent 这边当 OneBot 客户端，能力就全了。
 *
 * ── 连接哪一种 ────────────────────────────────────────────────
 *
 * OneBot v11 的 WebSocket 有两种方向（dsh-channel-qq 也是这两种）：
 *
 *   forward  协议端开 ws 服务，我们拨号过去。NapCat 默认就是这种，
 *            地址 `ws://127.0.0.1:3001`。**默认走这个**，省事。
 *   reverse  我们开 ws 服务，协议端拨过来。NapCat 配置里填反向地址，
 *            地址 `ws://127.0.0.1:8082`（这里是我们监听的端口）。
 *
 * ── 为什么不装 npm 依赖 ────────────────────────────────────────
 *
 * 跟 `qq-bridge.mjs` 一个理由：发布物只带 src/ + public/，不装 npm 依赖。
 * 所以 WebSocket 走 Node 22 自带的全局 `WebSocket`（Electron 的主进程里没有它，
 * 那边会走兜底：先试 `import('ws')`）。
 *
 * ── 一条消息长什么样 ──────────────────────────────────────────
 *
 * 收（OneBot 事件，已经在这文件里转成 `qq-bridge.mjs` 认的形状）：
 *   { post_type:'message', message_type:'private'|'group', user_id, group_id,
 *     raw_message, message:[{type:'text'|'image'|'at'|'face'|'reply'|'record', data:{...}}],
 *     sender:{nickname, card, role} }
 * 发：`send_private_msg` / `send_group_msg`，`message` 收 CQ 码字符串
 *    （`[CQ:image,file=base64://...]`、`[CQ:record,file=...]`、`[CQ:poke,qq=...]`）。
 *    直接用 CQ 码是因为它比消息段数组省事，而且 OneBot 所有实现都吃。
 */

import { readQq, writeQq } from './qq.mjs';

/** 进程内的连接状态（不落盘）。 */
const rt = {
  client: null, // { send, close, mode }
  phase: 'idle', // idle | connecting | online | error | stopped
  error: '',
  selfId: '',
  nickname: '',
  startedAt: 0,
  lastAt: 0,
  logs: [],
  /** echo -> { resolve, reject, timer } */
  pending: new Map(),
  seq: 0,
};

const MAX_LOGS = 60;

function log(line) {
  const s = String(line ?? '').trim();
  if (!s) return;
  rt.logs.push({ at: Date.now(), line: s });
  if (rt.logs.length > MAX_LOGS) rt.logs.splice(0, rt.logs.length - MAX_LOGS);
}

/** 配置读出来（永远返回一个能用的对象，不会 throw）。 */
export function oneBotConf() {
  let conf = {};
  try {
    conf = readQq()?.onebot || {};
  } catch {
    conf = {};
  }
  const mode = conf.mode === 'reverse' ? 'reverse' : 'forward';
  const url = String(conf.url || '').trim() || (mode === 'reverse' ? 'ws://127.0.0.1:8082' : 'ws://127.0.0.1:3001');
  return {
    enabled: conf.enabled === true,
    mode,
    url,
    token: String(conf.token || ''),
    /** 主人 QQ 号（白名单那块也有一个；这个优先给 OneBot 认主人用） */
    ownerQq: String(conf.ownerQq || '').trim(),
  };
}

export function setOneBotConf(patch = {}) {
  const conf = oneBotConf();
  const next = { ...conf };
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true || patch.enabled === 'true';
  if (patch.mode !== undefined) next.mode = patch.mode === 'reverse' ? 'reverse' : 'forward';
  if (patch.url !== undefined) {
    const u = String(patch.url || '').trim();
    if (u && !/^wss?:\/\//i.test(u)) throw Object.assign(new Error('地址得是 ws:// 或 wss:// 开头'), { status: 400 });
    next.url = u || (next.mode === 'reverse' ? 'ws://127.0.0.1:8082' : 'ws://127.0.0.1:3001');
  }
  if (patch.token !== undefined) next.token = String(patch.token || '').trim();
  if (patch.ownerQq !== undefined) {
    const q = String(patch.ownerQq || '').trim();
    if (q && !/^\d{5,12}$/.test(q)) throw Object.assign(new Error('主人 QQ 号得是 5~12 位数字'), { status: 400 });
    next.ownerQq = q;
  }
  // writeQq 是「整份写」：把它读出来的东西原样带回去，只换 onebot 那一格。
  const all = readQq();
  writeQq({ ...all, onebot: next });
  log(`配置已存：${next.mode} ${next.url}${next.token ? '（带 token）' : ''}`);
  return publicConf();
}

export function publicConf() {
  const c = oneBotConf();
  return { enabled: c.enabled, mode: c.mode, url: c.url, hasToken: Boolean(c.token), ownerQq: c.ownerQq };
}

export function oneBotStatus() {
  const c = publicConf();
  return {
    ...c,
    phase: rt.phase,
    error: rt.error,
    running: rt.phase === 'online' || rt.phase === 'connecting',
    selfId: rt.selfId,
    nickname: rt.nickname,
    startedAt: rt.startedAt,
    lastAt: rt.lastAt,
    logs: rt.logs.slice(-20),
  };
}

// ───────────────────────────── WebSocket 两种来源 ─────────────────────────────

let wsImplPromise = null;
async function getWebSocketImpl() {
  if (wsImplPromise) return wsImplPromise;
  wsImplPromise = (async () => {
    if (typeof globalThis.WebSocket === 'function') return { Ctor: globalThis.WebSocket, isNode: false };
    try {
      const mod = await import('ws');
      const Ctor = mod?.WebSocket || mod?.default || mod;
      if (typeof Ctor === 'function') return { Ctor, isNode: true };
      throw new Error('ws 模块形状不认识');
    } catch (e) {
      throw new Error(
        '这台机器上的 Node 里没有可用的 WebSocket（Node 22 才自带）。要么升到 Node 22，要么在程序目录里装一个 ws。'
        + `（原始错误：${String(e?.message ?? e)}）`,
      );
    }
  })();
  return wsImplPromise;
}

/** 统一成 on(ev, fn) 的样子：Node 的 ws 与浏览器的 WebSocket 事件名不同。 */
function attach(ws, handlers) {
  const isNode = typeof ws.on === 'function';
  const bind = (name, fn) => {
    if (isNode) ws.on(name === 'open' ? 'open' : name, fn);
    else ws.addEventListener(name === 'open' ? 'open' : (name === 'close' ? 'close' : name), (ev) => {
      if (name === 'message') fn(ev?.data);
      else fn(ev);
    });
  };
  bind('open', handlers.open);
  bind('message', handlers.message);
  bind('close', handlers.close);
  bind('error', handlers.error);
  return isNode;
}

// ───────────────────────────── 建连 ─────────────────────────────

/**
 * 拨号（forward）或监听（reverse）。
 * @param {(inbound:object)=>Promise<void>} onEvent 收到一条事件（已转成 qq-bridge 认的形状）
 */
export async function startOneBot(onEvent) {
  await stopOneBot();
  const conf = oneBotConf();
  if (!conf.enabled) {
    rt.phase = 'idle';
    return oneBotStatus();
  }
  rt.phase = 'connecting';
  rt.error = '';
  rt.startedAt = Date.now();
  const { Ctor, isNode } = await getWebSocketImpl();

  const onFrame = async (raw) => {
    let obj = null;
    try {
      obj = JSON.parse(typeof raw === 'string' ? raw : String(raw?.toString?.() ?? raw));
    } catch {
      return;
    }
    if (!obj || typeof obj !== 'object') return;
    rt.lastAt = Date.now();
    // API 回执
    if (typeof obj.echo === 'string' && rt.pending.has(obj.echo)) {
      const item = rt.pending.get(obj.echo);
      rt.pending.delete(obj.echo);
      clearTimeout(item.timer);
      if (obj.status === 'ok' || obj.retcode === 0) item.resolve(obj.data);
      else item.reject(new Error(`OneBot 调 ${item.action} 失败：${obj.msg || obj.wording || `retcode ${obj.retcode}`}`));
      return;
    }
    if (obj.post_type === 'meta_event') {
      if (obj.meta_event_type === 'lifecycle' && obj.self_id) rt.selfId = String(obj.self_id);
      return;
    }
    if (obj.post_type === 'message') {
      const inbound = normalizeInbound(obj);
      if (!inbound) return;
      try {
        await onEvent?.(inbound);
      } catch (e) {
        log(`处理消息出错：${String(e?.message ?? e)}`);
      }
      return;
    }
    if (obj.post_type === 'notice') {
      const n = normalizeNotice(obj);
      if (n) log(n);
    }
  };

  if (conf.mode === 'reverse') {
    // reverse：我们起一个 http 服务接协议端的 ws 升级
    const { createServer } = await import('node:http');
    const port = Number(new URL(conf.url).port) || 8082;
    const server = createServer((req, res) => {
      res.writeHead(426, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('这里只接 OneBot 的反向 WebSocket。');
    });
    const { WebSocketServer } = isNode
      ? await import('ws').then((m) => ({ WebSocketServer: m.WebSocketServer })).catch(() => ({}))
      : {};
    if (!WebSocketServer) {
      rt.phase = 'error';
      rt.error = 'reverse 模式需要 ws 包（Node 自带的 WebSocket 只能拨号，不能监听）。要么用 forward，要么在程序目录装一个 ws。';
      return oneBotStatus();
    }
    const wss = new WebSocketServer({ server, path: '/' });
    wss.on('connection', (ws) => {
      log('协议端拨进来了（reverse）');
      attach(ws, {
        open: () => {},
        message: onFrame,
        close: () => log('协议端断开了'),
        error: (e) => log(`reverse 出错：${String(e?.message ?? e)}`),
      });
      rt.client = {
        send: (s) => ws.send(s),
        close: () => ws.close(),
      };
      rt.phase = 'online';
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', resolve);
    });
    rt.client = Object.assign(rt.client || { send: () => {}, close: () => {} }, { close: () => { try { wss.close(); } catch {} try { server.close(); } catch {} } });
    log(`已在 ${conf.url} 等协议端拨进来`);
    // 反向模式下「连上」= 有人拨进来，暂时算 connecting
    if (rt.phase !== 'online') rt.phase = 'connecting';
    return oneBotStatus();
  }

  // forward：拨号
  const headers = conf.token ? { Authorization: `Bearer ${conf.token}` } : undefined;
  const ws = headers && isNode ? new Ctor(conf.url, { headers }) : new Ctor(conf.url);
  attach(ws, {
    open: async () => {
      rt.phase = 'online';
      rt.error = '';
      log(`连上了 ${conf.url}`);
      try {
        const me = await call('get_login_info');
        rt.selfId = String(me?.user_id ?? '');
        rt.nickname = String(me?.nickname ?? '');
        if (rt.selfId) log(`登录的号：${rt.nickname || '(无名)'}（${rt.selfId}）`);
      } catch {
        /* 拿不到也不致命 */
      }
    },
    message: onFrame,
    close: () => {
      if (rt.phase === 'online') log('连接断了，30 秒后重连');
      rt.phase = rt.phase === 'stopped' ? 'stopped' : 'error';
    },
    error: (e) => {
      rt.error = `连不上 ${conf.url}：${String(e?.message ?? e)}。协议端（NapCat）开了吗？地址对吗？`;
      log(rt.error);
    },
  });
  rt.client = { send: (s) => ws.send(s), close: () => { try { ws.close(); } catch {} } };
  // 拨号是异步的：这里多数时候还是 connecting。等一小会儿再回报，
  // 让「连上」这件事在面板上第一次刷新就能看见（否则要点两下才更新）。
  if (rt.phase === 'connecting') {
    const t0 = Date.now();
    while (rt.phase === 'connecting' && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return oneBotStatus();
}

export async function stopOneBot() {
  try {
    rt.client?.close?.();
  } catch {}
  rt.client = null;
  for (const [, item] of rt.pending) {
    clearTimeout(item.timer);
    try { item.reject(new Error('OneBot 已断开')); } catch {}
  }
  rt.pending.clear();
  if (rt.phase !== 'idle') rt.phase = 'stopped';
  return oneBotStatus();
}

/** 调一个 OneBot API；resolve 出 data。 */
export async function call(action, params = {}, timeoutMs = 20_000) {
  const client = rt.client;
  if (!client) throw new Error('OneBot 没连上（先去 QQ 连接里把「自己注册的号」启动起来）');
  const echo = `xy-${Date.now()}-${rt.seq++}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      rt.pending.delete(echo);
      reject(new Error(`OneBot 调 ${action} 超时 ${timeoutMs}ms`));
    }, timeoutMs);
    rt.pending.set(echo, { resolve, reject, timer, action });
    try {
      client.send(JSON.stringify({ action, params, echo }));
    } catch (e) {
      rt.pending.delete(echo);
      clearTimeout(timer);
      reject(e);
    }
  });
}

// ───────────────────────────── 事件 → 我们的形状 ─────────────────────────────

/** CQ 码 → 段数组（只在没给 message 数组时兜底用）。 */
export function parseCq(raw) {
  const out = [];
  const s = String(raw ?? '');
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push({ type: 'text', data: { text: s.slice(last, m.index) } });
    const data = {};
    for (const kv of String(m[2] || '').split(',').filter(Boolean)) {
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i)] = kv.slice(i + 1);
    }
    out.push({ type: m[1], data });
    last = re.lastIndex;
  }
  if (last < s.length) out.push({ type: 'text', data: { text: s.slice(last) } });
  return out;
}

/** OneBot 消息事件 → qq-bridge 认的那套（senderId/content/attachments...）。 */
export function normalizeInbound(ev) {
  if (!ev || ev.post_type !== 'message') return null;
  const isGroup = ev.message_type === 'group';
  const segs = Array.isArray(ev.message) ? ev.message : parseCq(ev.raw_message);
  const texts = [];
  const attachments = [];
  let replyId = '';
  for (const seg of segs) {
    const t = String(seg?.type || '');
    const d = seg?.data || {};
    if (t === 'text') texts.push(String(d.text || ''));
    else if (t === 'at') texts.push(`@${d.qq === 'all' ? '全体成员' : d.qq}`);
    else if (t === 'reply') replyId = String(d.id || '');
    else if (t === 'image') attachments.push({ kind: 'image', url: d.url || (d.file?.startsWith('http') ? d.file : ''), file: d.file || '', caption: String(d.summary || '') });
    else if (t === 'record' || t === 'voice') attachments.push({ kind: 'voice', url: d.url || d.file || '', file: d.file || '' });
    else if (t === 'video') attachments.push({ kind: 'video', url: d.url || (d.file?.startsWith('http') ? d.file : ''), file: d.file || '' });
    else if (t === 'file') attachments.push({ kind: 'file', url: d.url || '', file: d.file || d.name || '', name: String(d.name || d.file || '') });
    else if (t === 'face') texts.push('[表情]');
    else if (t === 'mface') texts.push(String(d.summary || '[表情包]'));
  }
  const userId = String(ev.user_id ?? ev.sender?.user_id ?? '');
  if (!userId) return null;
  const sender = ev.sender || {};
  const groupId = isGroup ? String(ev.group_id ?? '') : '';
  // 群里没 @ 也照样递上去：要不要接由 qq-bridge 决定（它自己有一层判断）
  const mentions = segs.filter((s) => s?.type === 'at').map((s) => ({ id: String(s?.data?.qq ?? ''), is_you: String(s?.data?.qq ?? '') === String(ev.self_id ?? '') }));
  return {
    kind: isGroup ? 'group' : 'private',
    senderId: userId,
    senderQq: userId,
    senderName: String(sender.card || sender.nickname || userId),
    groupId,
    groupQq: groupId,
    content: texts.join(''),
    replyId,
    messageId: String(ev.message_id ?? ''),
    mentions,
    attachments,
    raw: ev,
    via: 'onebot',
  };
}

/** 通知类事件 → 一句人话（只用于日志/让她知道有人在戳她）。 */
export function normalizeNotice(ev) {
  const t = ev?.notice_type;
  const who = ev?.user_id ? `QQ${ev.user_id}` : '某人';
  if (t === 'notify' && ev?.sub_type === 'poke') return `${who} 戳了戳我`;
  if (t === 'group_increase') return `${who} 进群了`;
  if (t === 'group_decrease') return `${who} 退群了`;
  if (t === 'group_ban') return `${who} 被禁言`;
  if (t === 'friend_add') return `${who} 加了我好友`;
  return '';
}

// ───────────────────────────── 发（CQ 码）─────────────────────────────

function targetOf({ isGroup, target }) {
  return isGroup ? { group_id: Number(target) } : { user_id: Number(target) };
}

/** 发文字。`at` 可以在群里点一个人。 */
export async function sendText({ isGroup, target, text, at }) {
  let msg = String(text ?? '');
  if (at) msg = `[CQ:at,qq=${at}] ${msg}`;
  const action = isGroup ? 'send_group_msg' : 'send_private_msg';
  return call(action, { ...targetOf({ isGroup, target }), message: msg });
}

/** 发图：本地文件直接给路径（NapCat 支持 file:// 或绝对路径），base64 走 base64://。 */
export async function sendImage({ isGroup, target, filePath, base64 }) {
  const file = base64 ? `base64://${base64}` : String(filePath || '');
  if (!file) throw new Error('要发图得给 filePath 或 base64');
  const msg = `[CQ:image,file=${file}]`;
  const action = isGroup ? 'send_group_msg' : 'send_private_msg';
  return call(action, { ...targetOf({ isGroup, target }), message: msg }, 60_000);
}

/** 发语音条（silk/amr；NapCat 会自动转）。 */
export async function sendRecord({ isGroup, target, filePath }) {
  const msg = `[CQ:record,file=${String(filePath || '')}]`;
  const action = isGroup ? 'send_group_msg' : 'send_private_msg';
  return call(action, { ...targetOf({ isGroup, target }), message: msg }, 60_000);
}

/** 发文件（群文件 / 私聊文件）。 */
export async function sendFile({ isGroup, target, filePath, name }) {
  if (isGroup) return call('upload_group_file', { group_id: Number(target), file: String(filePath || ''), name: String(name || '') }, 120_000);
  return call('upload_private_file', { user_id: Number(target), file: String(filePath || ''), name: String(name || '') }, 120_000);
}

/** 戳一戳（群里戳人）。私聊用 friend_poke（部分协议端支持）。 */
export async function poke({ isGroup, groupId, target, userId }) {
  if (isGroup) return call('group_poke', { group_id: Number(groupId || target), user_id: Number(userId) });
  return call('friend_poke', { user_id: Number(userId || target) });
}

/** 引用回复：message 里带 [CQ:reply,id=...]。 */
export async function replyQuote({ isGroup, target, messageId, text }) {
  const msg = `[CQ:reply,id=${String(messageId)}]${String(text ?? '')}`;
  const action = isGroup ? 'send_group_msg' : 'send_private_msg';
  return call(action, { ...targetOf({ isGroup, target }), message: msg });
}

/** 表情包：发 CQ 表情（face id）或 mface（收藏表情包）。 */
export async function sendFace({ isGroup, target, faceId }) {
  const msg = `[CQ:face,id=${String(faceId)}]`;
  const action = isGroup ? 'send_group_msg' : 'send_private_msg';
  return call(action, { ...targetOf({ isGroup, target }), message: msg });
}

export async function sendMface({ isGroup, target, emojiId }) {
  const msg = `[CQ:mface,emoji_id=${String(emojiId)}]`;
  const action = isGroup ? 'send_group_msg' : 'send_private_msg';
  return call(action, { ...targetOf({ isGroup, target }), message: msg });
}

/** 撤回。 */
export async function recall(messageId) {
  return call('delete_msg', { message_id: Number(messageId) });
}

/** 查历史（够她「翻翻上面说的」）。 */
export async function history({ isGroup, target, count = 20 }) {
  if (isGroup) return call('get_group_msg_history', { group_id: Number(target), count });
  return call('get_friend_msg_history', { user_id: Number(target), count });
}
