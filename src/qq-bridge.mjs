/**
 * QQ 的桥 —— 把「QQ 来一句话」接成「小鱼的一轮对话」。
 *
 * 这个文件只管**连**和**转向**，不碰会话存储本身（那是 server.mjs 的地盘），
 * 所以它拿三个回调当参数：
 *
 *   ensureSession(openid, peer, userText) → { sessionId } | null
 *       给这个人找一个会话（主人定了「共用一个」就都进那一个；
 *       否则第一次说话就给他开一个新的）。返回 null = 现在不能聊。
 *   runChat({ sessionId, text, onEvent }) → Promise<void>
 *       跑一轮真正的对话（跟界面里发一句话走同一条路）。
 *       事件里 `{type:'chunk'}` 是增量文字，`{type:'done'}` 是这轮结束。
 *   upsertPeer(openid, patch) → 记账（认人表在 qq.mjs 里）
 *   onLog(line) → 面板上那行「最近发生什么」
 *
 * ── 为什么不用 SDK 的 QQBot 类直接跑 ─────────────────────────
 *
 * `@tencent-connect/qqbot-nodejs` 是主人机器上 dsh 插件带的包，
 * 小鱼Agent 发布物里没有它（发布只带 src/ + public/，不装 npm 依赖）。
 * 所以这里写成**动态 import**：装了就用它的全套（网关、重连、媒体上传）；
 * 没装就报一句人话「这台机器上没装 QQ 的 SDK，两条路：装它，或者手填凭据」。
 *
 * 真要长连，靠 `start()`；没有凭据 / 没启动过就跑 `status()` 看状态。
 */

import { join } from 'node:path';
import {
  qqBot, qqBotPublic, qqBind, qqPeer, noteQqPeer, tryClaim, chunkText, isOwnerOpenid, readQq, setQqBot,
  qqGate, qqAllowed, normQqNum,
} from './qq.mjs';
import { saveInboundAttachments, describeInbound, transcodeVoiceToMp3 } from './qq-media.mjs';

const SDK_PKG = '@tencent-connect/qqbot-nodejs';

/** 进程内的那一份运行状态（不是持久化状态，重启就没了） */
const rt = {
  bot: null,
  phase: 'idle', // idle | starting | online | error | stopped
  error: '',
  startedAt: 0,
  me: null,
  log: [],
  stats: { in: 0, out: 0, turns: 0, blocked: 0 },
};

const LOG_MAX = 120;

function log(line) {
  const s = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${String(line ?? '')}`;
  rt.log.push(s);
  if (rt.log.length > LOG_MAX) rt.log.splice(0, rt.log.length - LOG_MAX);
  try { console.log('[qq]', s); } catch {}
}

/** 不给外面看密钥的运行状态 */
export function qqStatus() {
  return {
    phase: rt.phase,
    error: rt.error,
    startedAt: rt.startedAt,
    me: rt.me,
    bot: qqBotPublic(),
    bind: qqBind(),
    gate: qqGate(),
    peers: qqPeerList(),
    stats: { ...rt.stats },
    log: rt.log.slice(-40),
  };
}

export function qqRunning() {
  return rt.phase === 'online' || rt.phase === 'starting';
}

/** 这台机器上有没有那个 SDK（只探测，不加载）。 */
export async function sdkAvailable() {
  return Boolean(await loadSdk());
}

/**
 * 找到 QQ 的 SDK。
 *
 * 【为什么要这么麻烦】发布物只带 src/ + public/，不带 node_modules，
 * 所以 `npm i` 装到项目里能 import 到；可主人这台机器又有可能只在 dsh 的
 * profile 里装过它（C:\Users\<用户>\.dsh\profiles\qqbot\node_modules\…）——
 * 那也是同一份包，直接拿来用，省得再多装一份。
 *
 * 两条路都不通就返回 null，调用方把它变成一句人话显示在面板上。
 */
let sdkCache = null;
async function loadSdk() {
  if (sdkCache !== null) return sdkCache || null;
  sdkCache = false;
  // ① 项目自己装的
  try {
    sdkCache = await import(SDK_PKG);
    if (sdkCache && sdkCache.QQBot) return sdkCache;
  } catch { /* 继续试下一条 */ }
  // ② dsh profile 里那份（主人在 dsh 里装过 qqbot 插件才有）
  try {
    const { homedir } = await import('node:os');
    const { pathToFileURL } = await import('node:url');
    const { existsSync } = await import('node:fs');
    const p = join(homedir(), '.dsh', 'profiles', 'qqbot', 'node_modules', SDK_PKG, 'dist', 'index.js');
    if (existsSync(p)) {
      const mod = await import(pathToFileURL(p).href);
      if (mod && mod.QQBot) { sdkCache = mod; return mod; }
    }
  } catch { /* 没装就没装 */ }
  sdkCache = false;
  return null;
}

/**
 * 启动。已经起着就直接返回。
 *
 * deps 见文件头的说明。任何一步失败都把 phase 放到 'error' 并记下原因，
 * 不往上抛 —— 面板要能显示「为什么没连上」，而不是让整个服务器挂掉。
 */
export async function startQq(deps = {}) {
  if (qqRunning()) return qqStatus();
  const cred = qqBot();
  if (!cred.appId || !cred.appSecret) {
    rt.phase = 'error';
    rt.error = '还没填 AppID / AppSecret';
    return qqStatus();
  }
  rt.phase = 'starting';
  rt.error = '';
  rt.log.length = 0;
  log(`准备连接 QQ（AppID ${cred.appId}）`);

  let sdk = null;
  try {
    sdk = await loadSdk();
  } catch { sdk = null; }
  if (!sdk || !sdk.QQBot) {
    rt.phase = 'error';
    rt.error = `这台机器上没装 ${SDK_PKG}（npm i ${SDK_PKG} 之后再来）`;
    log(rt.error);
    return qqStatus();
  }
  const { QQBot } = sdk;

  try {
    const bot = new QQBot({
      appId: cred.appId,
      appSecret: cred.appSecret,
      markdownSupport: false,
      logger: {
        info: (m) => log(`· ${m}`),
        error: (m) => log(`! ${m}`),
        warn: (m) => log(`! ${m}`),
        debug: () => {},
      },
    });
    rt.bot = bot;

    bot.on('ready', (payload) => {
      rt.phase = 'online';
      rt.startedAt = Date.now();
      rt.error = '';
      try {
        rt.me = {
          id: payload?.user?.id ? String(payload.user.id) : '',
          name: payload?.user?.username ? String(payload.user.username) : '',
        };
      } catch { rt.me = null; }
      log(`连上了${rt.me?.name ? `，我是「${rt.me.name}」` : ''}`);
    });
    bot.on('disconnected', () => {
      rt.phase = 'starting';
      log('连接断了，SDK 自己在重连……');
    });
    bot.on('error', (err) => {
      rt.phase = 'error';
      rt.error = String(err?.message ?? err);
      log(`出错：${rt.error}`);
    });

    bot.on('message', async (ctx, msg) => {
      try {
        await handleInbound({ msg, bot, deps });
      } catch (err) {
        log(`处理一条消息失败：${String(err?.message ?? err)}`);
      }
    });

    await bot.start();
    if (rt.phase === 'starting') rt.phase = 'online';
    return qqStatus();
  } catch (err) {
    rt.phase = 'error';
    rt.error = String(err?.message ?? err);
    log(`没连上：${rt.error}`);
    return qqStatus();
  }
}

export async function stopQq() {
  try { await rt.bot?.stop?.(); } catch {}
  try {
    if (rt.bot?.__onebot) {
      const onebot = await import('./qq-onebot.mjs');
      await onebot.stopOneBot();
    }
  } catch {}
  rt.bot = null;
  rt.phase = 'stopped';
  log('停了');
  return qqStatus();
}

/**
 * 一条进来的消息。
 *
 * 分层跟 dsh-qqbot 一个思路（这是实践里最不容易出错的形状）：
 *   ① 认人（是不是主人）
 *   ② 群聊要 @ 才理（省额度、也免得在别人的群里插话）
 *   ③ 认领口令「#我是 123456」
 *   ④ 转给会话引擎，边收边发
 */
async function handleInbound({ msg, bot, deps }) {
  const openid = String(msg?.senderId ?? '').trim();
  if (!openid) return;
  const text = String(msg?.content ?? '').replace(/^<@!?[^>]+>\s*/g, '').trim();
  const isGroup = msg?.kind === 'group';

  // ⓪ 白名单（2026-11-03 主人要的「只允许白名单的 QQ 号私聊、白名单的群号群聊」）
  //
  // 这一层放在最前面，**连 @ 都不看** —— 不在名单里的群，被 @ 了也不吭声。
  // 网关给的号可能是数字也可能是字符串，qq.mjs 的 qqAllowed 会统一归一化再比。
  // 主人的号（面板上手动填的那个）永远放行，免得主人自己被自己关在外面。
  const gateVerdict = (() => {
    try {
      return qqAllowed({
        qqId: msg?.senderQq ?? msg?.userOpenid ?? msg?.senderId,
        groupId: isGroup ? (msg?.groupQq ?? msg?.groupOpenid ?? msg?.groupId) : '',
        isOwner: isOwnerOpenid(openid),
      });
    } catch {
      return { ok: false, why: 'gate-error' };
    }
  })();
  if (!gateVerdict.ok) {
    // 不在白名单 —— 一个字都不回（回了就等于告诉对方「这里有人」，
    // 主人要的是「清净」，不是「礼貌地拒绝」）。
    rt.stats.blocked = (Number(rt.stats.blocked) || 0) + 1;
    log(`挡掉一条（${gateVerdict.why}）${isGroup ? '[群] ' : ''}${gateVerdict.qq || openid.slice(0, 8)}`);
    return;
  }

  // ② 群聊没 @ 就不接（QQ 自己在网关层也会过滤大部分，这里再兜一层）
  if (isGroup) {
    const you = String(rt.me?.id || '');
    const mentioned = Array.isArray(msg?.mentions) && msg.mentions.some((m) => m && (m.is_you === true || (you && String(m.id || m.user_openid || '') === you)));
    const atRaw = /@\S+/.test(String(msg?.content ?? ''));
    if (!mentioned && !atRaw) return;
  }

  const peer = qqPeer(openid);
  const name = String(msg?.senderName ?? '').trim();

  // ③ 认领口令
  if (tryClaim(openid, text, name)) {
    rt.stats.in += 1;
    log(`「${name || openid.slice(0, 8)}」认成了主人`);
    await send(bot, msg, '记下了。以后你说的话我按主人来对待。');
    deps?.onLog?.('认领成功');
    return;
  }

  // 空话（纯图片/纯表情没文字）不再一棒打死 —— 2026-11-02 起图/语音/文件能收了，
  // 下面统一走「附件先下到本地，再拼一句给她」这条路。
  const rawAttachments = Array.isArray(msg?.attachments) ? msg.attachments : [];
  if (!text && !rawAttachments.length) return;

  // 附件落地：QQ 的图/视频/文件是 https 链接，语音是 voice.url。
  // 下到 <dataDir>/qq-media 再把**绝对路径**告诉她（不是 base64，别把上下文炸了）。
  let saved = [];
  if (rawAttachments.length) {
    try {
      saved = await saveInboundAttachments(rawAttachments);
    } catch (err) {
      log(`附件没下下来：${String(err?.message ?? err)}`);
    }
    for (const one of saved) {
      if (!one.ok) log(`附件失败：${one.kind} ${one.why || ''}`);
    }
    // 语音顺手转成 mp3：不转的话模型/界面都播不了（silk 没人认）
    for (const one of saved) {
      if (one.ok && one.kind === 'voice') {
        try {
          const mp3 = await transcodeVoiceToMp3(one.localPath);
          if (mp3 && mp3 !== one.localPath) one.localPath = mp3;
        } catch {}
      }
    }
  }
  const keptMedia = saved.filter((x) => x.ok);
  const mediaLine = saved.map(describeInbound).join(' ');

  // 只有一个图、又没有文字时的兜底提示：不提她一句，她可能以为这是空消息
  if (!text && !keptMedia.length) {
    await send(bot, msg, '这个附件我没接住（可能太大或者过期了），你换一个或者打字跟我说？');
    return;
  }
  // 纯附件（没打字）：给她一句明确的话，让她知道该看图/听语音
  const turnText = text || (keptMedia.length ? '（发来东西给你看，没打字）' : '');

  rt.stats.in += 1;
  log(`← ${isGroup ? '[群] ' : ''}${name || openid.slice(0, 8)}：${(text || `[${keptMedia.length} 个附件]`).slice(0, 40)}`);

  // ① 认人 + ④ 找会话
  const ensured = await deps?.ensureSession?.({ openid, peer, userText: turnText, isGroup, name });
  if (!ensured || !ensured.sessionId) {
    await send(bot, msg, '这会儿接不上会话（主人还没把 QQ 接好），等我一下。');
    return;
  }
  const { sessionId } = ensured;
  noteQqPeer(openid, { sessionId, name });

  // 主人身份：按主人来（安全词、权限都算数）
  if (isOwnerOpenid(openid)) {
    try { deps?.setSpeakerOwner?.(sessionId);
    } catch {}
  }

  // ④ 跑一轮，边跑边发
  const out = [];
  let sentParts = 0;
  const flush = async () => {
    const all = out.join('');
    const parts = chunkText(all, 1200);
    // 增量发送：只发还没发出去的那几块
    for (let i = sentParts; i < parts.length - 1; i++) {
      await send(bot, msg, parts[i]);
      rt.stats.out += 1;
    }
    sentParts = Math.max(sentParts, Math.max(0, parts.length - 1));
  };
  try {
    await deps?.runChat?.({
      sessionId,
      // 附件那一行拼在正文后面：模型看到的是「图在哪」，不是一串二进制
      text: mediaLine ? `${turnText}\n\n${mediaLine}` : turnText,
      // 2026-11-02：把「回哪儿」也带进去，qq_send 工具才知道该往哪个会话发东西
      replyTarget: msg?.replyTarget
        || (isGroup
          ? { scope: 'group', targetId: String(msg?.groupOpenid ?? msg?.groupQq ?? ''), msgId: msg?.messageId }
          : { scope: 'c2c', targetId: String(msg?.senderId ?? openid), msgId: msg?.messageId }),
      media: keptMedia,
      fromQq: { openid, name, isOwner: isOwnerOpenid(openid) },
      onEvent: async (ev) => {
        if (!ev) return;
        if (ev.type === 'chunk' && typeof ev.text === 'string') {
          out.push(ev.text);
          // 攒够一条就发（别等整轮说完 —— QQ 里等着没反馈很难受）
          if (out.join('').length - (sentParts ? 0 : 0) > 1200) await flush();
        } else if (ev.type === 'done') {
          await flush();
        }
      },
    });
    rt.stats.turns += 1;
    // 收尾：把最后那一块发掉
    const parts = chunkText(out.join(''), 1200);
    for (let i = sentParts; i < parts.length; i++) {
      await send(bot, msg, parts[i]);
      rt.stats.out += 1;
    }
    if (!parts.length) await send(bot, msg, '（这一轮她没说话）');
  } catch (err) {
    const m = String(err?.message ?? err);
    log(`这一轮没答完：${m}`);
    await send(bot, msg, `出错了：${m}`);
  }
}

/** 发一条（被动回复优先，没有 msgId 才走主动）。 */
async function send(bot, msg, content) {
  const t = String(content ?? '').trim();
  if (!t) return;
  try {
    if (msg?.replyTarget) await bot.sendText(msg.replyTarget, t);
    else if (msg?.kind === 'group' && msg?.groupOpenid) {
      await bot.sendText({ scope: 'group', targetId: String(msg.groupOpenid), msgId: msg.messageId }, t);
    } else {
      await bot.sendText({ scope: 'c2c', targetId: String(msg.senderId), msgId: msg.messageId }, t);
    }
  } catch (err) {
    log(`发不出去：${String(err?.message ?? err)}`);
  }
}

/** 给别的模块（qq_send 工具）用的：现在那个活着的 bot 实例 */
export function currentQqBot() {
  return rt.bot || null;
}

// ───────────────────────── 自己注册的号（OneBot v11）─────────────────────────

/**
 * OneBot 的「bot 外壳」—— 让 `handleInbound` 不用改一行就能走这条路。
 *
 * 为什么值得这么绕：`handleInbound` 里那一整套（白名单、认领口令、附件落地、
 * 拆段发、replyTarget、媒体回传）是踩了很多坑才对的；OneBot 那条道要重写一遍
 * 就一定会漏掉其中几条。所以只把「发」这一层换掉，剩下的全复用。
 *
 * 它有官方 SDK 的 bot 里**唯一被用到**的接口：`sendText(replyTarget, text)`。
 */
function oneBotShell() {
  return {
    __onebot: true,
    async sendText(replyTarget, content) {
      const scope = String(replyTarget?.scope || 'c2c');
      const target = String(replyTarget?.targetId || '');
      if (!target) throw new Error('没有收件人');
      const isGroup = scope === 'group';
      const msgId = replyTarget?.msgId;
      // 有 msgId 就引用着回（对方一眼知道在回哪句）
      const { sendText, replyQuote } = await import('./qq-onebot.mjs');
      return msgId
        ? replyQuote({ isGroup, target, messageId: msgId, text: String(content ?? '') })
        : sendText({ isGroup, target, text: String(content ?? '') });
    },
  };
}

/** 启动「自己注册的号」。 */
export async function startQqOneBot(deps = {}) {
  if (rt.phase === 'online') return qqStatus();
  const onebot = await import('./qq-onebot.mjs');
  const conf = onebot.oneBotConf();
  rt.phase = 'starting';
  rt.error = '';
  rt.log.length = 0;
  log(`准备连接自己注册的号（${conf.mode} ${conf.url}）`);
  try {
    const st = await onebot.startOneBot(async (inbound) => {
      const shell = oneBotShell();
      // 回哪儿：群里回群、私聊回人；msgId 用来引用
      inbound.replyTarget = inbound.kind === 'group'
        ? { scope: 'group', targetId: String(inbound.groupId || ''), msgId: inbound.messageId }
        : { scope: 'c2c', targetId: String(inbound.senderId || ''), msgId: inbound.messageId };
      try {
        await handleInbound({ msg: inbound, bot: shell, deps });
      } catch (err) {
        log(`处理一条消息失败：${String(err?.message ?? err)}`);
      }
    });
    rt.bot = oneBotShell();
    // 拨号是异步的：startOneBot 返回时往往还在 connecting。这里不能再把
    // online 降级成 starting —— 否则刚连上就被自己抹掉，状态栏永远显示
    // 「正在连…」，而且面板上「断开」按钮会在真连上之后还不亮。
    if (st.phase === 'online') rt.phase = 'online';
    else if (st.phase === 'error') rt.phase = 'error';
    else if (rt.phase !== 'online') rt.phase = 'starting';
    rt.startedAt = Date.now();
    rt.error = st.error || '';
    rt.me = st.selfId ? { id: st.selfId, name: st.nickname || '' } : rt.me;
    if (st.selfId) log(`登录的号：${st.nickname || '(无名)'}（${st.selfId}）`);
    return qqStatus();
  } catch (err) {
    rt.phase = 'error';
    rt.error = String(err?.message ?? err);
    log(`没连上：${rt.error}`);
    return qqStatus();
  }
}

/** 给面板用：最近这些人的名字、是不是主人、什么时候来过。 */
export function qqPeerList() {
  const peers = readQq().peers;
  return Object.entries(peers).map(([openid, p]) => ({
    openid,
    short: `${openid.slice(0, 6)}…${openid.slice(-4)}`,
    role: p.role,
    isOwner: p.role === 'owner',
    name: p.name,
    sessionId: p.sessionId,
    boundAt: p.boundAt,
    lastAt: p.lastAt,
    msgCount: p.msgCount,
  })).sort((a, b) => b.lastAt - a.lastAt);
}

/** 供测试 / 命令行：把「是不是配好了」打出来。 */
export function qqSelfCheck() {
  const b = qqBotPublic();
  return {
    configured: b.configured,
    enabled: b.enabled,
    appId: b.appId,
    sandbox: b.sandbox,
    useGateway: b.useGateway,
    running: qqRunning(),
    phase: rt.phase,
    peers: Object.keys(readQq().peers).length,
    gate: qqGate(),
  };
}

export { setQqBot };
