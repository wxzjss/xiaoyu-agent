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
import { existsSync, appendFileSync, mkdirSync, statSync, renameSync, unlinkSync } from 'node:fs';
import { config } from './config.mjs';
import {
  qqBot, qqBotPublic, qqBind, qqPeer, noteQqPeer, isOwnerQq, chunkText, splitSay, isOwnerOpenid, readQq, setQqBot,
  qqGate, qqAllowed, normQqNum, normPeerId, normGroupId,
} from './qq.mjs';
import { notifyNow } from './notify.mjs';
import { saveInboundAttachments, describeInbound, transcodeVoiceToMp3 } from './qq-media.mjs';

const SDK_PKG = '@tencent-connect/qqbot-nodejs';

/**
 * QQ 允许「对着同一条消息被动回复」最多 5 条（官方限制）。
 * 超了的话返回的错和「主动消息失败」长得一样，界面上就成了「说了五句只回三句」。
 * 所以一轮最多发 5 条，剩下的并进第 5 条（2026-11-12）。
 */
const MAX_PASSIVE = 5;

/** 让上下两条之间喘口气 —— 分多条发的时候用（2026-11-06） */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程内的那一份运行状态（不是持久化状态，重启就没了） */
const rt = {
  bot: null,
  phase: 'idle', // idle | starting | online | error | stopped
  error: '',
  startedAt: 0,
  me: null,
  log: [],
  stats: { in: 0, out: 0, turns: 0, blocked: 0, fail: 0 },
  /**
   * 【2026-11-12 加】最近一次「这一轮没答完」的原因。
   *
   * 主人报「LLM 接口报错，后续群里就不回复了」，可面板上的日志只在内存里 ——
   * 重启一次就什么都查不到了。现在留一份带时间的记录，并且**同时写进
   * `.state/qq.log`**（见 appendLogFile），下次再出这种「忽然不回了」，
   * 至少能翻到是哪一条、什么错、后面还有没有别的尝试。
   */
  lastError: null,
  /**
   * 【2026-11-12 加】最近被门挡回去的几条。
   *
   * 主人原话：「显示已经连上，我在群里 @ 它怎么没有反应」。门上挡掉是设计如此，
   * 但**主人看不见**挡了谁、为什么挡 —— 只能看到「她不回我」。
   * 现在留一份内存里的账（最多 20 条，同一个人/同一个群只留最新的那条），
   * 面板上直接列出来，配一个「放行」按钮：点一下就把这个群/这个人写进白名单。
   */
  blocked: [],
};

const LOG_MAX = 120;

/**
 * 【2026-11-09 加·把「可能带密钥的文字」擦一遍再往外说】
 *
 * 给主人回的那句原因是从原始报错里截的，而报错里常常带着
 * `apiKey=sk-xxxx`、`Authorization: Bearer xxx`、或一整串 32 位以上的随机 token。
 * QQ 那边是聊天窗口（群里谁都看得见），这些东西不该出现在那儿。
 */
function scrubSecrets(input) {
  return String(input ?? '')
    .replace(/(sk-|Bearer\s+)[A-Za-z0-9._-]{6,}/gi, '$1***')
    .replace(/(api[-_]?key|token|secret|passwd|password|authorization)\s*[:=]\s*\S+/gi, '$1=***')
    .replace(/[A-Za-z0-9_-]{32,}/g, '***');
}

function log(line) {
  const now = new Date();
  const s = `[${now.toLocaleTimeString('zh-CN', { hour12: false })}] ${String(line ?? '')}`;
  rt.log.push(s);
  if (rt.log.length > LOG_MAX) rt.log.splice(0, rt.log.length - LOG_MAX);
  try { console.log('[qq]', s); } catch {}
  // 同时落盘：面板那份是内存的，重启就没了；出事之后要能翻账。
  appendLogFile(`${now.toISOString()} ${String(line ?? '')}`);
}

/**
 * 【2026-11-12 加】QQ 这条线的日志落盘到 `<data>/.state/qq.log`。
 *
 * 「群里忽然不回了」这种问题，光看内存日志没用 —— 主人往往是在**重启之后**
 * 才来问的，那时内存里只剩「连上了」。之前只能靠主人截图，能拿到的东西太少。
 *
 * 写盘失败一律忽略：日志不能反过来把聊天搞挂。
 * 超过 1MB 就轮转一份 `.1`（只留一代，够查最近一次事故了）。
 */
const LOG_FILE_MAX = 1024 * 1024;

function appendLogFile(line) {
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const file = join(dir, 'qq.log');
    try {
      if (existsSync(file) && statSync(file).size > LOG_FILE_MAX) {
        const old = file + '.1';
        try { if (existsSync(old)) unlinkSync(old); } catch {}
        renameSync(file, old);
      }
    } catch { /* 轮转失败就继续往后写，别因为这行字丢了 */ }
    appendFileSync(file, line + '\n');
  } catch { /* 盘满 / 没权限：静默 */ }
}

const BLOCKED_MAX = 20;

/** 「群里没 @ 我」这条日志的节流表：群 id → 上次记的时间（同一群 60 秒最多一条）。 */
const noAtLogAt = new Map();

/** 记一条「被挡回去」的账（同一个群/同一个人只留最新一条，次数累加）。 */
function pushBlocked({ kind = 'c2c', id = '', qq = '', name = '', why = 'blocked', text = '' } = {}) {
  const key = `${kind}:${id || qq}`;
  const at = Date.now();
  const item = {
    key,
    kind,
    id: String(id || ''),
    qq: String(qq || ''),
    name: String(name || ''),
    why,
    text: String(text || '').slice(0, 60),
    at,
    count: 1,
    // 面板上要显示「几点的」和「第几次」
    when: new Date(at).toLocaleTimeString('zh-CN', { hour12: false }),
  };
  const i = rt.blocked.findIndex((x) => x.key === key);
  if (i >= 0) item.count = (Number(rt.blocked[i].count) || 1) + 1;
  rt.blocked = [item, ...rt.blocked.filter((x) => x.key !== key)].slice(0, BLOCKED_MAX);
  return item;
}

/** 不给外面看密钥的运行状态 */
export function qqStatus() {
  return {
    phase: rt.phase,
    error: rt.error,
    // 面板读的是 lastError（历史字段名），两边都给，省得再改前端
    lastError: rt.error,
    startedAt: rt.startedAt,
    me: rt.me,
    bot: qqBotPublic(),
    bind: qqBind(),
    gate: qqGate(),
    peers: qqPeerList(),
    stats: { ...rt.stats },
    /* 最近一次「这一轮没答完」—— 跟上面 lastError（连不上）是两回事：
     * 连上了、消息也收到了，但 LLM 那边 502 或者会话卡住，这一轮照样没话。
     * 面板想区分「没连上」和「连上了但答不出」时就靠这个（2026-11-12）。 */
    turnError: rt.lastError,
    // 最近被挡的几个人/几个群 —— 面板上「放行」按钮靠它（2026-11-12）
    blocked: rt.blocked.slice(0, BLOCKED_MAX),
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
      // 走 safe 版：任何没料到的异常都记日志 + 尽量回一句，别让对面完全静默
      await handleInboundSafe({ msg, bot, deps });
    });

    /* 【2026-11-12 修·点「连上」之后请求一直不返回】
     *
     * SDK 的 `start()` 在 WebSocket 模式下是「**一直连到断开才 resolve**」
     * （内部注释原话：Resolves when abortSignal fires）。原来这里 await 它，
     * 结果 `POST /api/qq/start` 这个请求永远不返回 —— 界面上就是点完一直转圈，
     * 而「连上了」只能从状态轮询里看到。开机自动连更糟：整个 boot 被它挂住。
     *
     * 现在让它在后台跑，这里只看 `ready` 有没有来（最多等 10 秒）。
     * 连不上由它 reject，重连/看门狗都在 SDK 里，不影响这里的返回。 */
    Promise.resolve()
      .then(() => bot.start())
      .catch((err) => {
        rt.phase = 'error';
        rt.error = String(err?.message ?? err);
        log(`没连上：${rt.error}`);
      });
    const waitFrom = Date.now();
    while (rt.phase === 'starting' && Date.now() - waitFrom < 10_000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    // 网关一句话都没回、也没报错：按「起了」算，面板还能点断开
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
 * 【2026-11-12 加·兜底：任何没料到的异常，至少让对面看到一句话】
 *
 * 两条通道原来都是「try { handleInbound } catch { log }」—— 异常只写进日志，
 * 对面那边**一个字都收不到**。主人报的「群里忽然就不回了」很可能就是这种：
 * 代码里某个环节抛了（会话/liveLogs/附件/身份），日志有一行，QQ 那头完全静默，
 * 而且因为是「静默」，主人根本没法判断是没收到、被挡了、还是程序坏了。
 *
 * 现在统一走这里：先记日志（落盘），再试着回一句人话。回不出去也不影响别的消息。
 */
export async function handleInboundSafe({ msg, bot, deps }) {
  try {
    await handleInbound({ msg, bot, deps });
  } catch (err) {
    const m = String(err?.message ?? err);
    log(`处理一条消息时抛错了：${m}`);
    rt.lastError = {
      at: Date.now(),
      sessionId: '',
      code: Number(err?.status) || 0,
      gateway: false,
      sentParts: 0,
      message: `[handleInbound] ${m}`.slice(0, 300),
    };
    try {
      await send(bot, msg, '这条我处理到一半出了点岔子，你再发一次？（原因我记在日志里了）');
    } catch { /* 回不出去就算了，日志已经留了 */ }
  }
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
export async function handleInbound({ msg, bot, deps }) {
  const openid = String(msg?.senderId ?? '').trim();
  if (!openid) return;
  // 群号（一次算清，后面三处都用它）：OneBot 给的是 groupQq/groupId，
  // 官方 SDK 那条路给的是 groupOpenid —— 两个名字都认。
  const groupId = String(msg?.groupQq ?? msg?.groupOpenid ?? msg?.groupId ?? '').trim();
  const text = String(msg?.content ?? '')
    // 【2026-11-01 修】旧形态 @段 / 摊平的「@QQ号」都不算话；她不该看到一串数字
    .replace(/<@!?[^>]+>\s*/g, '')
    .replace(/(^|\s)@\d{5,12}\s*/g, '$1')
    .trim();
  const isGroup = msg?.kind === 'group';

  // ⓪ 白名单（2026-11-03 主人要的「只允许白名单的 QQ 号私聊、白名单的群号群聊」）
  //
  // 这一层放在最前面，**连 @ 都不看** —— 不在名单里的群，被 @ 了也不吭声。
  // 网关给的号可能是数字也可能是字符串，qq.mjs 的 qqAllowed 会统一归一化再比。
  // 【2026-11-01 改】群聊只看群号，主人的号也不绕过 —— 主人自己没加群就 @ 她，照样不理。
  // 私聊那条才「主人的号永远放行」（免得主人自己被自己关在外面）。
  const gateVerdict = (() => {
    try {
      return qqAllowed({
        // OneBot 那条道给的是真 QQ 号；官方那条道只有 openid，分开传，
        // 别让 openid 混进「按号比」的分支（2026-11-12）
        qqId: msg?.senderQq,
        openid: msg?.userOpenid ?? msg?.senderId,
        groupId: isGroup ? groupId : '',
        isGroup,
        isOwner: isOwnerQq(msg?.senderQq) || isOwnerOpenid(msg?.userOpenid ?? msg?.senderId),
      });
    } catch {
      return { ok: false, why: 'gate-error' };
    }
  })();
  if (!gateVerdict.ok) {
    // 不在白名单 —— 一个字都不回（回了就等于告诉对方「这里有人」，
    // 主人要的是「清净」，不是「礼貌地拒绝」）。
    rt.stats.blocked = (Number(rt.stats.blocked) || 0) + 1;
    pushBlocked({
      kind: isGroup ? 'group' : 'c2c',
      id: isGroup ? (groupId || '') : String(msg?.senderId ?? ''),
      qq: gateVerdict.qq || '',
      name: String(msg?.senderName ?? ''),
      why: gateVerdict.why || 'blocked',
      text,
    });
    /* 【2026-11-09 加】「挡掉」也要说清为什么挡。
     * 官方机器人那条道拿不到 QQ 号（接口只给 openid），而白名单是按**号**比的 ——
     * 于是 strict 一开，私聊全被挡，屏面上只看到「她不回我」。
     * 这种时候日志必须点明是「没号可比」，否则主人只会以为程序坏了。 */
    if (gateVerdict.why === 'group-not-allowed') {
      log(`挡掉一条（这群不在「能说话的群」名单里）[群] ${groupId.slice(0, 12)}`
        + ` —— 到面板第 2 格点「放行这个群」就行（官方那条道的群 id 是 openid，`
        + `跟 QQ 群号不是一回事，手填群号对不上）`);
    } else if (gateVerdict.why === 'group-no-id') {
      log(`挡掉一条（群消息没带群 id，没法核对白名单）[群] ${openid.slice(0, 8)}`);
    } else {
      const _noNum = !normQqNum(msg?.senderQq);
      log(`挡掉一条（${gateVerdict.why}）${isGroup ? '[群] ' : ''}${gateVerdict.qq || openid.slice(0, 8)}`
        + (_noNum && !isGroup
          ? ' —— 这条机器人拿不到说话人的 QQ 号（官方接口只给 openid），「只理白名单」按号比不了；'
            + '要放行就点面板上的「放行这个人」，或把「只理白名单」关掉'
          : ''));
    }
    return;
  }

  // ② 群聊没 @ 就不接（QQ 自己在网关层也会过滤大部分，这里再兜一层）
  if (isGroup) {
    const you = String(rt.me?.id || '');
    const mentioned = Array.isArray(msg?.mentions) && msg.mentions.some((m) => m && (m.is_you === true || (you && String(m.id || m.user_openid || m.member_openid || '') === you)));
    // 【2026-10-30 修】原来 /@\S+/ 太宽了：群里谁 @ 谁都算 @ 我，
    // 「@张三 你吃了吗」也能把我叫起来，还得一个字一个字给我答复。
    // 现在只认两种：结构化 mentions 里明确指我（上面那行），
    // 或者正文里 <at id="我的号"> 这种真 at 段。
    const mine = String(you || '').replace(/\D/g, '');
    const atRaw = Boolean(mine) && (
      new RegExp(`<at[^>]*id\\s*=\\s*["\']?(?:qq_)?${mine}["\']?`, 'i').test(String(msg?.content ?? '')) ||
      new RegExp(`(^|[\\s、,，])@\\s*${mine}([\\s、,，]|$)`).test(String(msg?.content ?? ''))
    );
    /* 【2026-11-12 加】官方机器人在群里只推「有人 @ 我」这一种事件
     * （GROUP_AT_MESSAGE_CREATE），事件本身已经等于「被 @ 了」。
     * 而它给的 mentions 里不一定带 is_you、id 也是 openid 而不是 QQ 号，
     * 上面两条判据都可能落空 —— 于是「明明 @ 了却不回」。按事件类型兜一层。 */
    const eventSaysAtMe = /GROUP_AT_MESSAGE_CREATE/i.test(String(msg?.rawEventType ?? ''));
    if (!mentioned && !atRaw && !eventSaysAtMe) {
      /* 【2026-11-12 加】不接，但**留个痕**。
       *
       * 「群里 @ 了她，她不回」和「群里没 @ 她，本来就不该回」在主人眼里长得一模一样：
       * 都是没反应。以前这里直接 return，日志里一个字都没有，事后完全没法区分。
       * 现在记一条（同一个群 60 秒最多一条，免得活跃群里刷屏）——
       * 再遇到「怎么不回」，一眼就能看出是「没 @」还是「收到了没跑通」。 */
      const now = Date.now();
      const last = noAtLogAt.get(groupId) || 0;
      if (now - last > 60_000) {
        noAtLogAt.set(groupId, now);
        log(`群里有人说话但没 @ 我，按规矩不接（${String(groupId).slice(0, 8)}）：`
          + String(text || '[附件]').slice(0, 20));
      }
      return;
    }
  }

  /**
   * 【2026-11-01 修】认人 / 找会话的键：私聊按人，群聊按**群**。
   *
   * 以前一律按发话人 openid 找，于是主人在群里的那句话「认识」的是他跟她的私聊会话：
   * 那句话被塞进私聊会话里，还把私聊会话改名成了「QQ群 · 群名」，
   * 下一句私聊又把群里的上下文接上 —— 两条线搅成一团。
   */
  const peerKey = isGroup ? 'group:' + (groupId || 'unknown') : openid;
  const peer = qqPeer(peerKey);
  const name = String(msg?.senderName ?? '').trim();

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

  /* 【2026-11-12】系统通知：QQ 上有人找她时弹一条（面板上那个开关管着）。
   * 只提醒「真的被接住」的消息 —— 被白名单挡掉的不弹，否则等于拿通知刷屏。
   * 主人自己发的也不弹（他自己刚发完，用不着提醒）。
   * notifyNow 内部还会再看一遍开关、以及窗口是不是就在最前面。 */
  try {
    const mine = isOwnerQq(msg?.senderQq) || isOwnerOpenid(openid);
    if (!mine) {
      const who = name || (isGroup ? '群里有人' : 'QQ 上有人');
      const said = String(text || '').trim() || (keptMedia.length ? '（发来一个附件）' : '');
      notifyNow('qq', isGroup ? `QQ 群 · ${who}` : `QQ · ${who}`,
        isGroup ? `${who}：${said}` : said);
    }
  } catch {}

  // ① 认人 + ④ 找会话
  const ensured = await deps?.ensureSession?.({ openid: peerKey, peer, userText: turnText, isGroup, name, groupId });
  if (!ensured || !ensured.sessionId) {
    await send(bot, msg, '这会儿接不上会话（主人还没把 QQ 接好），等我一下。');
    return;
  }
  const { sessionId } = ensured;
  // 会话绑在 peerKey 上（群就是群、人就是人）；说话的人另外记一笔（不覆盖他私聊的那条）
  noteQqPeer(peerKey, { sessionId, name, qq: isGroup ? '' : msg?.senderQq });
  if (isGroup) noteQqPeer(openid, { name, qq: msg?.senderQq });
  // 【2026-10-30】群聊：会话名改成「群名」，不是发话人的昵称
  if (isGroup) {
    try { await deps?.renameGroupSession?.({ sessionId, groupId }); } catch {}
  }

  // 主人身份：按主人来（安全词、权限都算数）。
  // 2026-11-03 起只认号 —— 面板上「你自己的 QQ 号」填的是哪个号，哪个号的话才按主人处理。
  if (isOwnerQq(msg?.senderQq)) {
    try { deps?.setSpeakerOwner?.(sessionId);
    } catch {}
  }

  // ④ 跑一轮，边跑边发
  const out = [];
  let sentParts = 0;
  /**
   * 【2026-11-06 主人报「说了三句话，连发四十多条重复」—— 两个真凶，都在这几行里】
   *
   * 真凶一：多个 flush 同时在跑。
   *   `onEvent` 是 async 的，可 `runAgent` 里是 `onEvent({...})` 直接调、**不等它**。
   *   里面 `await send(...)` 要等网络（几百毫秒一条），这期间又来二十个 text 事件，
   *   于是二十个 flush 各自从同一个 sentParts 起步 → 同一条被发二十遍。
   *
   * 真凶二：拿「第几条」当进度。
   *   每次 flush 都把**整段文本**重新 splitSay 一遍。文本一长，切点就变：
   *   上次第 0 条是「你好主人。」，这次同样的字跟后面粘成了「你好主人。今天……」（一条），
   *   sentParts=1 于是从第 1 条发 —— 而那其实是已经发过的内容。
   *
   * 现在的做法：
   *   ① 进度改用**原文字符位置** sentChars —— 切点怎么变都不影响「发到哪了」；
   *   ② flush 串成一条链（flushing），永远只有一队在跑；
   *   ③ 只对「还没发的那段」切句。
   */
  let sentChars = 0;
  let flushing = Promise.resolve();
  /**
   * 找出「可以发出去的」那一截：到最后一个句末标点（或空行）为止。
   * 一句都没说完就返回 0，等着下一批字；
   * 太长又死活没有标点（贴代码、长单词）就整段交出去，让 splitSay 用 perMax 兜底切。
   */
  const cutReady = (s) => {
    if (!s) return 0;
    let cut = 0;
    const re = /[。！？；!?;~～…][」』"')）]*\s*|\n\s*\n/g;
    let m;
    while ((m = re.exec(s))) cut = m.index + m[0].length;
    if (cut > 0) return cut;
    return s.length > 600 ? s.length : 0;
  };
  const doFlush = async (final) => {
    const fresh = out.join('').slice(sentChars);
    if (!fresh) return;
    let cut;
    if (final) {
      cut = fresh.length;
    } else {
      cut = cutReady(fresh);
      if (cut <= 0) return;   // 一句都还没说完，先别发
    }
    const chunk = fresh.slice(0, cut);
    let parts = splitSay(chunk);
    if (!parts.length) { sentChars += cut; return; }
    /* 【2026-11-12 加】QQ 对同一个 msg_id 的被动回复**最多 5 条**。
     * 超了的那几条，返回的错和「主动消息失败」长得一模一样，界面上又是
     * 「说了五句只回三句」。所以在这儿提前合并，宁可最后一条长一点，
     * 也别把内容丢掉 —— 丢的是她真说过的话。 */
    const room = MAX_PASSIVE - sentParts;
    if (room <= 0) {
      log(`这一轮已经用满 ${MAX_PASSIVE} 条被动回复（QQ 限制），剩下的没再发`);
      sentChars += cut;
      return;
    }
    if (parts.length > room) {
      const head = parts.slice(0, room - 1);
      const tail = parts.slice(room - 1).join('');
      parts = [...head, tail];
    }
    const firstEver = sentParts === 0;
    for (let i = 0; i < parts.length; i++) {
      // quote 只对 OneBot 那条道有意义（那边「引用」是消息段）；
      // 官方这条道的 msgId 一律带上 —— 摘了就变「主动消息」，群聊没权限。
      const ok = await send(bot, msg, parts[i], { quote: firstEver && i === 0 });
      if (ok !== false) rt.stats.out += 1;
      if (i < parts.length - 1) // 【2026-11-01 主人】条与条之间也抬到 1 秒（原来 0.5 秒）
await sleep(1000 + Math.floor(Math.random() * 400));
    }
    sentParts += parts.length;
    sentChars += cut;
  };
  /**
   * 【2026-11-06 主人要求：别一个气泡塞好几句，分多轮发、一轮一句】
   *
   * 原来是 `chunkText(all, 1200)` —— 那是「撞上限才切」，1200 字以内一条不切，
   * 于是她写的一大段（几个空行分隔的段落）整段塞进一个 QQ 气泡。
   * 现在换成 splitSay：按空行/句子切成一条一句，像真人在那边一条条打字。
   *
   * `final=false`（话还没说完）时**只发已经说完整的句子** —— 半句话发出去比晚发更难堪；
   * `final=true`（这一轮结束了）才把剩下的半句也发掉。
   * 每条之间隔 0.5~0.9 秒（主人 2026-11-01 要求「至少 0.5 秒」）。
   * 跨 flush 的间隔由 qq-onebot 的 paceSend 兜底 —— 这里管的是同一次 flush 内的相邻两条。
   */
  const flush = (final = false) => {
    flushing = flushing
      .then(() => doFlush(final))
      .catch((e) => { try { log(`[qq] flush 出错：${e?.message || e}`); } catch {} });
    return flushing;
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
      fromQq: { openid, name, isOwner: isOwnerQq(msg?.senderQq) },
      onEvent: async (ev) => {
        if (!ev) return;
        // 2026-11-04 修：runAgent 吐正文用的是 type:'text'（全项目没有一处 emit 'chunk'），
        // 老代码只听 'chunk'，所以 QQ 这条路从来没收到过一个字，每轮都回「这一轮她没说话」。
        // 现在增量认 'text'，done 时再用整段 text 兜底（防漏、防重复）。
        if ((ev.type === 'text' || ev.type === 'chunk') && typeof ev.text === 'string') {
          out.push(ev.text);
          // 攒够一条就发（别等整轮说完 —— QQ 里等着没反馈很难受）
          // 【2026-11-06】原来要等 1200 字；现在按句发，攒够一条就试着发一条，
          // 但每来一个字就重算一遍 splitSay 太浪费 —— 用「已发的字数」做水位，
          // 新增超过 60 字才重算一次。
          const _pending = out.join('').length - sentChars;
          if (_pending > 60) await flush();
        } else if (ev.type === 'done') {
          // 兜底：这一轮如果一条增量都没收到，但 done 里带了整段正文，就用它
          if (!out.join('') && typeof ev.text === 'string' && ev.text.trim()) {
            out.push(ev.text);
          }
          await flush();
        }
      },
    });
    rt.stats.turns += 1;
    // 收尾：把最后那一条也发掉
    await flush(true);
    if (!sentParts) {
      log('这一轮模型没吐出任何正文（out 为空），已回兜底一句');
      await send(bot, msg, '（这一轮我没说出话，你再喊我一声？）(｡•́︿•̀｡)');
    }
  } catch (err) {
    const m = String(err?.message ?? err);
    const code = Number(err?.status) || 0;
    /**
     * 【2026-11-12 加】分清「网关自己挂了」和「我们发错了」。
     *
     * 主人贴来的日志里就是 `LLM HTTP 502: Upstream service temporarily unavailable`
     * —— llm.mjs 那边已经会自动重试两次（1.2s / 2.4s），走到这里说明那家网关
     * 连着抖了十几秒。这种错跟「配置写错了」完全不是一回事，话得说对，
     * 不然主人会去翻 key、翻模型，白折腾半天。
     */
    const isGateway = /\b(502|503|504)\b/.test(m) || /upstream service temporarily unavailable/i.test(m);
    rt.lastError = {
      at: Date.now(),
      sessionId,
      code,
      gateway: isGateway,
      sentParts,
      message: m.slice(0, 300),
    };
    log(`这一轮没答完：${m}`);
    if (sentParts > 0) log(`（已经发出去 ${sentParts} 条，剩下的没说完）`);
    /* 【2026-11-09 改·别把技术细节甩到 QQ】
     * 原来一律回「出错了：<原始错误>」，可能把接口地址、报错栈、甚至 key 的片段
     * 发给对面（群里谁都看得见）。现在：
     *   · 会话正忙（409）→ 说人话，让她知道等一会儿；
     *   · 上游网关抖动（502/503/504）→ 说清是「那边抽风」，不是主人的配置坏了；
     *   · 主人本人 → 附一句简短原因，他好排查；客人 → 只说「出了点问题」；
     *   · 完整原因一律留在面板日志 + `.state/qq.log` 里。 */
    const isOwner = isOwnerQq(msg?.senderQq);
    let say;
    if (code === 409) {
      say = '我这边手上还有一件没收尾，等我说完这句就来，你别急 (´｡• ᵕ •｡`)';
    } else if (isGateway) {
      say = sentParts > 0
        ? '说到一半，我这边上游断了一下 —— 你先看前面那几句，过一会儿我接着说。'
        : '我这边上游网关抽风了（502），不是我坏了，等十几秒再喊我一声 (´･_･`)';
    } else {
      say = isOwner
        ? `这一轮没跑通（${scrubSecrets(m).slice(0, 80)}），你回头看下日志。`
        : '我这边出了点小问题，过一会儿再喊我一声。';
    }
    const told = await send(bot, msg, say);
    /* 「群里彻底不回」最怕的就是这一种：连「我没跑通」这句都没送到。
     * 那样对面看到的就是**完全静默**，跟「她根本没收到」一模一样。
     * 这条日志必须单独打出来，否则事后翻日志只会看到上面那行错误，
     * 误以为「已经告诉主人了」。 */
    if (told === false) log('连「这一轮没跑通」这句都没送到 QQ —— 对面那边看起来就是完全没回复');
  }
}


/** 发一条（被动回复优先，没有 msgId 才走主动）。 */
/**
 * 发一条。
 *
 * `opts.quote` —— 要不要引用着主人那句话回。
 * 一轮分成好几条发的时候只在第一条引用：每条都挂着同一个引用，
 * QQ 里看着像她对着同一句话复读了五遍（2026-11-06）。
 */
/**
 * 【2026-11-01 修】「回哪儿」只在一个地方算。
 *
 * 以前 send() 里判群用的是 `msg.groupOpenid` —— 那是官方 SDK 时代的字段名，
 * OneBot 那条路只给 groupQq/groupId，于是：第一条（引用着回）走 replyTarget 进了群，
 * 第二条起全落到 c2c 分支 → 主人**私聊**也收到一句（他报的「私聊与群聊同时回了一句」）。
 *
 * 现在：有 replyTarget 就照它（要不要引用由 quote 决定，**不再因此改发到别处**）；
 * 没有就按群号/私聊分别兜底。
 */
function targetOf(msg) {
  const rt0 = msg?.replyTarget;
  if (rt0 && typeof rt0 === 'object') {
    const scope = String(rt0.scope === 'group' ? 'group' : 'c2c');
    const targetId = String(rt0.targetId || '');
    if (targetId) return { scope, targetId, msgId: rt0.msgId };
  }
  if (msg?.kind === 'group') {
    const gid = String(msg?.groupQq ?? msg?.groupOpenid ?? msg?.groupId ?? '');
    if (gid) return { scope: 'group', targetId: gid, msgId: msg?.messageId };
  }
  return { scope: 'c2c', targetId: String(msg?.senderId ?? ''), msgId: msg?.messageId };
}

async function send(bot, msg, content, opts = {}) {
  const t = String(content ?? '').trim();
  if (!t) return false;
  const base = targetOf(msg);
  const passive = Boolean(base.msgId);
  /**
   * 【2026-11-12 修·群里从第 2 条起全被 QQ 拒：主动消息失败, 无权限】
   *
   * 原来这里为了「别让每条都挂着同一个引用、看着像复读」，从第 2 条起
   * 把 msgId 摘掉再发。可 QQ 的语义是：
   *   带 msg_id  → 被动回复（对方刚说的话，你有权回，还能连回好几条）
   *   不带 msg_id → **主动推送**（群聊要单独申请权限，普通机器人一概 400）
   *
   * 于是真实日志变成了这样：
   *   17:13:12  200 OK            ← 第 1 条（带 msgId）成功
   *   17:13:13  400 主动消息失败, 无权限   ← 第 2 条起全灭
   * 群里只看到第一句，主人以为「她没回复」，切到会话才看见正文 —— 就是这条 bug。
   *
   * 现在：msgId **一律带上**（这才是能到对面那条通道）。
   * 「要不要长得像引用」是 message_reference 的事，不是 msgId 的事；
   * SDK 的 sendText 压根不传 message_reference，所以多条回复同挂一个 msgId
   * 在 QQ 里也不会显示成复读，只是 msg_seq 递增（SDK 的 getNextMsgSeq 管）。
   *
   * `opts.quote` 保留但**不再影响 msgId** —— 只有 OneBot 那条道会读它
   * （那边「引用」是消息段，不带 msg_id 也能发）。
   */
  const target = { scope: base.scope, targetId: base.targetId, msgId: base.msgId };
  const attempt = async (tgt) => bot.sendText(tgt, t);
  /* 【2026-11-09 改·发不出去原来只有一行日志，主人永远不知道】
   *
   * 真实场景里失败的大头是「消息发送频率超限」「网络抖一下」——
   * 都是**等一下再发就好**的那种。原来一次失败就整条丢了。
   *
   * 现在：① 失败先原样（同一个 msgId）隔 700ms 重试一次；
   *      ② 只有私聊才允许「摘掉 msgId 走主动推送」兜底（群聊主动必失败，别浪费请求）；
   *      ③ 还不行记进 stats.fail + 日志写清原因。
   */
  try {
    await attempt(target);
    return true;
  } catch (err1) {
    const m1 = String(err1?.message ?? err1);
    log(`发不出去（${m1}），等 700ms 再试一次`);
    await sleep(700);
    try {
      await attempt(target);
      return true;
    } catch (err2) {
      const m2 = String(err2?.message ?? err2);
      if (passive && base.scope !== 'group') {
        try {
          await attempt({ scope: base.scope, targetId: base.targetId });
          log('被动回复窗口过了，改走主动推送发出去了一条');
          return true;
        } catch { /* 主动推送也没成，往下记 */ }
      }
      rt.stats.fail = (Number(rt.stats.fail) || 0) + 1;
      log(`还是发不出去（${m2}）—— 这一条没能送到 QQ`);
      if (/主动消息/.test(m2)) {
        log('说明：QQ 群只让「被动回复」（带 msg_id 回它那句话）。'
          + '「主动消息」要单独申请权限，普通机器人发不出去 —— '
          + '这一条一般是被当成了主动消息，看看是不是 msg_id 丢了或已过期。');
      }
      return false;
    }
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
        await handleInboundSafe({ msg: inbound, bot: shell, deps });
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

/**
 * 给面板用：最近这些人的名字、是不是主人、什么时候来过。
 *
 * 「是不是主人」这里**不能**看 peers[openid].role —— 那是口令认领时代的旧账，
 * 口令退休之后 peers 里只剩 sessionId / name / 来没来过，role 永远是 guest。
 * 现在只认一条：这个号在不在主人那份名单里（面板上那个号 + 私聊白名单）。
 * 代价是：老 peer 记录里没存号的话，他得再发一句话，面板上才会亮成主人。
 */
/**
 * 「找过她的人」那一列。
 *
 * 【2026-11-12 改】以前这里只用 QQ 号认人，官方机器人那条道根本没有 QQ 号，
 * 于是所有人都是 guest、连「加进白名单」的按钮都不出现 —— 面板等于摆设。
 * 现在身份统一用 normPeerId（有号用号，没号用 openid），跟白名单同一套口径：
 *   role: owner  主人（面板上填的那个号 / 那个 openid）
 *         known  已经在白名单里
 *         guest  只是来过
 */
export function qqPeerList() {
  const data = readQq();
  const peers = data.peers;
  const ownerId = normPeerId((data.gate && data.gate.ownerQq) || '');
  const allow = Array.isArray(data.gate && data.gate.allowQq)
    ? data.gate.allowQq.map((x) => normPeerId(x)).filter(Boolean)
    : [];
  const allowGroup = Array.isArray(data.gate && data.gate.allowGroup)
    ? data.gate.allowGroup.map((x) => normGroupId(x)).filter(Boolean)
    : [];

  const rows = [];
  /* 【2026-11-12 修「面板上同一个名字出现两行」】
   *
   * 认人表里的 key 有两种：
   *   人      → openid
   *   群会话  → 'group:<群 openid>'（见上面 peerKey 那段）
   *
   * 群那条以前被当成「人」照样列出来：名字取的是**最后在群里说话的人**，
   * 于是「doro 在群里 @ 她」会在面板上变成两行 doro —— 一行是这个群，
   * 一行才是他本人。更难堪的是那行还带着「填成主人」按钮：手一滑就把
   * 群 openid 填成了主人，主人身份当场错乱。
   *
   * 现在：群单独成类（kind='group'，role='group'），排在人后面，
   * 前端只给它「放行这个群」；人那条才是人。
   */
  for (const [key, p] of Object.entries(peers)) {
    if (String(key).startsWith('group:')) {
      const gid = normGroupId(String(key).slice('group:'.length));
      // 连群 id 都没有的记录（group:unknown）对人没有任何用处，不列
      if (!gid) continue;
      const allowed = allowGroup.includes(gid);
      rows.push({
        kind: 'group',
        openid: '',
        id: gid,
        short: `${gid.slice(0, 6)}…${gid.slice(-4)}`,
        qq: '',
        role: 'group',
        isOwner: false,
        whitelisted: allowed,
        groupAllowed: allowed,
        name: p.name,
        sessionId: p.sessionId,
        boundAt: p.boundAt,
        lastAt: p.lastAt,
        msgCount: p.msgCount,
      });
      continue;
    }
    const qq = normQqNum(p.qq || '');
    const id = qq || normPeerId(key);        // 官方通道只有 openid，这就是他的「身份」
    if (!id) continue;
    const isOwner = id === ownerId;
    const known = isOwner || allow.includes(id);
    rows.push({
      kind: 'person',
      openid: key,
      id,
      short: `${String(key).slice(0, 6)}…${String(key).slice(-4)}`,
      qq,
      role: isOwner ? 'owner' : (known ? 'known' : 'guest'),
      isOwner,
      whitelisted: known && !isOwner,
      groupAllowed: false,
      name: p.name,
      sessionId: p.sessionId,
      boundAt: p.boundAt,
      lastAt: p.lastAt,
      msgCount: p.msgCount,
    });
  }

  /* 同一个人被记成两条（历史遗留：openid 大小写不同、或先有号再有 openid）
   * → 按归一化身份合一，留信息全的那条，别让人在面板上数出两个自己。 */
  const byId = new Map();
  for (const row of rows) {
    if (row.kind !== 'person') continue;
    const prev = byId.get(row.id);
    if (!prev) { byId.set(row.id, row); continue; }
    prev.lastAt = Math.max(Number(prev.lastAt) || 0, Number(row.lastAt) || 0);
    prev.msgCount = (Number(prev.msgCount) || 0) + (Number(row.msgCount) || 0);
    prev.name = prev.name || row.name;
    prev.sessionId = prev.sessionId || row.sessionId;
    prev.boundAt = Math.min(Number(prev.boundAt) || Infinity, Number(row.boundAt) || Infinity);
    // role 取「更亲」的那个：owner > known > guest
    const rank = { guest: 0, known: 1, owner: 2 };
    if (rank[row.role] > rank[prev.role]) {
      prev.role = row.role;
      prev.isOwner = row.isOwner;
      prev.whitelisted = row.whitelisted;
    }
  }
  const deduped = [...byId.values()];

  // 人在前、群在后，各自按最后说话时间倒序
  const byLast = (a, b) => (Number(b.lastAt) || 0) - (Number(a.lastAt) || 0);
  return deduped.sort(byLast).concat(rows.filter((r) => r.kind === 'group').sort(byLast));
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
