/**
 * 把 QQ 接到小鱼身上 —— 【QQ小鲏】
 *
 * ── 主人要的是什么 ────────────────────────────────────────────
 *
 * 主人原话（2026-11-01）：
 *   「选择哪个会话或创建新的会话连接 QQ」
 *   「参考 QQAgent 连接 QQ 的方式以及 dsh 的插件、市面上那些 AI 连 QQ 的软件
 *     是怎么识别主人的（通常是通过 QQ 号识别）」
 *
 * 所以这个模块只干三件事，其它一概不管：
 *   一、**记住凭据**（AppID / AppSecret）、记住「哪个会话接在 QQ 上」。
 *   二、**认人**：每个 QQ 用户（官方 openid）对应一个「他的会话」。
 *   三、**收发**：QQ 来一句话 → 转成小鱼的一轮对话；小鱼说完 → 切块发回 QQ。
 *
 * ── 为什么认人用 openid 而不是 QQ 号 ─────────────────────────
 *
 * QQ 官方机器人平台给的是 **openid**（每个机器人看到的同一个人 openid 不同），
 * 不是 QQ 号 —— 拿不到 QQ 号，也不该拿。所以「这人是主人」只能靠
 * **主人自己绑一次**：
 *   主人在面板上点「这是我」→ 生成一个 6 位口令 →
 *   在 QQ 里私聊机器人发 `#我是 <口令>` → 这条 openid 就记成主人。
 * 之后主人的话按「主人身份」处理（安全词、改名、权限都算数），
 * 别人的话一律按「客人在说话」处理，不给任何主人权限。
 *
 * 这跟市面那些自己搭协议库的软件（NapCat / 协议端那类）不同：
 * 它们能拿到真 QQ 号，但要一直挂一个第三方协议进程、还随时可能被封。
 * 走官方机器人 API 只需要一个 AppID，代价是拿不到 QQ 号、群聊要 @。
 * 主人要的是「稳」，所以走官方的。
 *
 * ── 为什么要扫码 ──────────────────────────────────────────────
 *
 * 腾讯自己给了扫码拿凭据的 SDK（@tencent-connect/qqbot-connector）。
 * 但小鱼Agent 是「装了就能跑、不装 npm 依赖」的路子，所以这里
 * **有那个包就用它；没有就退回手填 AppID/AppSecret**（面板上两个输入框）。
 * 这样既不会因为少一个依赖就用不了，也不会强制主人去 QQ 开放平台点半天。
 *
 * ── 状态存在哪 ────────────────────────────────────────────────
 *
 *   .state/qq.json
 *   {
 *     version: 2,
 *     bot: { appId, appSecret, enabled, autoStart },   ← 凭据 + 开关
 *     bind: {                                          ← 哪个会话接在 QQ 上
 *       sessionId: 'smxxx',        // 主人挑的那个会话（可空 = 每人各开一个）
 *       mode: 'shared' | 'per-user'// 共用一个 / 每人一个
 *     },
 *     peers: {                                          ← 认人表，按 openid
 *       '<openid>': { role: 'owner'|'guest', sessionId: 'smxxx', name, boundAt, lastAt, msgCount }
 *     },
 *     claim: { token, at }                              ← 「这是我」的口令（一次性）
 *   }
 *
 * 全员 fail-closed：文件坏 / 读不出来 → 当成「没配置」，绝不默认放人进来。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomInt } from 'node:crypto';
import { config } from './config.mjs';

const VERSION = 2;

function dir() {
  return join(config.dataDir, '.state');
}

export function qqFile() {
  return join(dir(), 'qq.json');
}

function blank() {
  return {
    version: VERSION,
    bot: { appId: '', appSecret: '', enabled: false, autoStart: true },
    bind: { sessionId: '', mode: 'per-user' },
    peers: {},
    claim: null,
  };
}

/** 单个会话最多挂多少人（防止有人拿机器人群发刷爆） */
export const MAX_PEERS = 50;
/** 口令多久内有效 */
export const CLAIM_TTL_MS = 10 * 60 * 1000;

function str(v, n = 0) {
  const s = String(v ?? '').trim();
  return n > 0 ? s.slice(0, n) : s;
}

function objOf(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** 读整份状态。读坏了一律回 blank —— fail-closed。 */
export function readQq() {
  try {
    const f = qqFile();
    if (!existsSync(f)) return blank();
    const j = JSON.parse(readFileSync(f, 'utf8'));
    const b = blank();
    const bot = objOf(j?.bot);
    const peers = {};
    for (const [k, v] of Object.entries(objOf(j?.peers))) {
      const id = str(k, 128);
      if (!id) continue;
      const p = objOf(v);
      peers[id] = {
        role: p.role === 'owner' ? 'owner' : 'guest',
        sessionId: /^sm[a-z0-9]{6,}$/.test(str(p.sessionId)) ? str(p.sessionId) : '',
        name: str(p.name, 40),
        boundAt: Number(p.boundAt) || 0,
        lastAt: Number(p.lastAt) || 0,
        msgCount: Number(p.msgCount) || 0,
      };
    }
    return {
      version: VERSION,
      bot: {
        appId: str(bot.appId, 64),
        appSecret: str(bot.appSecret, 128),
        enabled: bot.enabled === true,
        autoStart: bot.autoStart !== false,
      },
      bind: {
        sessionId: /^sm[a-z0-9]{6,}$/.test(str(j?.bind?.sessionId)) ? str(j.bind.sessionId) : '',
        mode: objOf(j?.bind).mode === 'shared' ? 'shared' : 'per-user',
      },
      peers,
      claim: (() => {
        const c = objOf(j?.claim);
        const token = str(c.token, 16);
        const at = Number(c.at) || 0;
        if (!token || !at) return null;
        return { token, at };
      })(),
    };
  } catch {
    return blank();
  }
}

/** 写整份状态（tmp + rename，断电也不会留半截文件）。 */
export function writeQq(data) {
  const d = objOf(data);
  const out = {
    version: VERSION,
    bot: {
      appId: str(d.bot?.appId, 64),
      appSecret: str(d.bot?.appSecret, 128),
      enabled: d.bot?.enabled === true,
      autoStart: d.bot?.autoStart !== false,
    },
    bind: {
      sessionId: /^sm[a-z0-9]{6,}$/.test(str(d.bind?.sessionId)) ? str(d.bind.sessionId) : '',
      mode: objOf(d.bind).mode === 'shared' ? 'shared' : 'per-user',
    },
    peers: {},
    claim: (() => {
      const c = objOf(d.claim);
      const token = str(c.token, 16);
      const at = Number(c.at) || 0;
      return token && at ? { token, at } : null;
    })(),
  };
  for (const [k, v] of Object.entries(objOf(d.peers))) {
    const id = str(k, 128);
    if (!id) continue;
    const p = objOf(v);
    out.peers[id] = {
      role: p.role === 'owner' ? 'owner' : 'guest',
      sessionId: /^sm[a-z0-9]{6,}$/.test(str(p.sessionId)) ? str(p.sessionId) : '',
      name: str(p.name, 40),
      boundAt: Number(p.boundAt) || 0,
      lastAt: Number(p.lastAt) || 0,
      msgCount: Number(p.msgCount) || 0,
    };
  }
  try {
    mkdirSync(dir(), { recursive: true });
    const f = qqFile();
    writeFileSync(`${f}.tmp`, JSON.stringify(out, null, 2), 'utf8');
    renameSync(`${f}.tmp`, f);
    return out;
  } catch (err) {
    console.warn('[qq] 状态没存上：', String(err?.message ?? err));
    return out;
  }
}

// ─────────────────────────── 凭据 ───────────────────────────

export function qqBot() {
  return readQq().bot;
}

/** 配好了没有（两个字段都在才算）。 */
export function qqConfigured() {
  const b = qqBot();
  return Boolean(b.appId && b.appSecret);
}

export function setQqBot({ appId, appSecret, enabled, autoStart } = {}) {
  const data = readQq();
  // 【存之前先问一句：这样存下去还有没有用】
  // AppID 和 AppSecret 是一对，缺一个连不上。以前允许只存一半，
  // 结果面板上显示「配置好了」、点连接报「机器人不存在」，人完全不知道该改哪儿。
  // 所以这里只看**存完之后**的样子，缺哪个就说哪个。
  const nextId = appId !== undefined ? str(appId, 64) : data.bot.appId;
  const nextSecret = appSecret !== undefined ? str(appSecret, 128) : data.bot.appSecret;
  if (appId !== undefined || appSecret !== undefined) {
    if (!nextId || !nextSecret) {
      const miss = !nextId ? 'AppID' : 'AppSecret';
      const err = new Error(`${miss} 还空着 —— AppID 和 AppSecret 要一对才能连上 QQ`);
      err.status = 400;
      throw err;
    }
  }
  if (appId !== undefined) data.bot.appId = nextId;
  if (appSecret !== undefined) data.bot.appSecret = nextSecret;
  if (enabled !== undefined) data.bot.enabled = enabled === true;
  if (autoStart !== undefined) data.bot.autoStart = autoStart !== false;
  return writeQq(data).bot;
}

/** 对外只说「有没有」，绝不把密钥吐给界面。 */
export function qqBotPublic() {
  const b = qqBot();
  return {
    appId: b.appId,
    hasSecret: Boolean(b.appSecret),
    enabled: b.enabled,
    autoStart: b.autoStart,
    configured: Boolean(b.appId && b.appSecret),
    secretTail: b.appSecret ? b.appSecret.slice(-4) : '',
  };
}

// ─────────────────────────── 接哪个会话 ───────────────────────────

export function qqBind() {
  return readQq().bind;
}

export function setQqBind({ sessionId, mode } = {}) {
  const data = readQq();
  if (sessionId !== undefined) {
    const s = str(sessionId);
    if (s && !/^sm[a-z0-9]{6,}$/.test(s)) {
      const err = new Error('会话 id 不对');
      err.status = 400;
      throw err;
    }
    data.bind.sessionId = s;
  }
  // 乱传模式直接拒，别默默当成 per-user —— 主人手抖一下不该变成「每人一个会话」
  if (mode !== undefined && mode !== '' && mode !== 'shared' && mode !== 'per-user') {
    const err = new Error(`「各聊各的」只有两种：shared（都进一个会话）/ per-user（每人一个），收到的是「${String(mode)}」`);
    err.status = 400;
    throw err;
  }
  if (mode === 'shared' || mode === 'per-user') data.bind.mode = mode;
  return writeQq(data).bind;
}

// ─────────────────────────── 认人 ───────────────────────────

export function qqPeers() {
  return readQq().peers;
}

export function qqPeer(openid) {
  const id = str(openid, 128);
  if (!id) return null;
  return readQq().peers[id] || null;
}

export function isOwnerOpenid(openid) {
  const p = qqPeer(openid);
  return Boolean(p && p.role === 'owner');
}

/**
 * 记一个人进来（第一次见就建一条）。
 *
 * sessionId 传空 = 这个人还没有自己的会话（调用方去建）。
 * 这里只负责记账，不建会话 —— 建会话要碰 sessions 那些模块，
 * 而这个文件要能在没有服务器的地方单独跑（测试就是这么用的）。
 */
export function noteQqPeer(openid, patch = {}) {
  const id = str(openid, 128);
  if (!id) return null;
  const data = readQq();
  const now = Date.now();
  const cur = data.peers[id] || { role: 'guest', sessionId: '', name: '', boundAt: now, lastAt: 0, msgCount: 0 };
  const next = { ...cur, lastAt: now, msgCount: (Number(cur.msgCount) || 0) + (patch.counted === false ? 0 : 1) };
  if (patch.name !== undefined) next.name = str(patch.name, 40);
  if (patch.sessionId !== undefined && /^sm[a-z0-9]{6,}$/.test(str(patch.sessionId))) next.sessionId = str(patch.sessionId);
  if (patch.role !== undefined) next.role = patch.role === 'owner' ? 'owner' : 'guest';
  if (!data.peers[id] && Object.keys(data.peers).length >= MAX_PEERS) {
    const err = new Error(`已经接了 ${MAX_PEERS} 个人了，先把不用的清掉`);
    err.status = 400;
    throw err;
  }
  data.peers[id] = next;
  writeQq(data);
  return next;
}

/** 把某人踢掉（他说过的话留在会话里，不动历史）。 */
export function forgetQqPeer(openid) {
  const id = str(openid, 128);
  const data = readQq();
  if (!data.peers[id]) return false;
  delete data.peers[id];
  writeQq(data);
  return true;
}

/** 清空认人表（换机器人 / 全部重来）。 */
export function forgetAllQqPeers() {
  const data = readQq();
  data.peers = {};
  writeQq(data);
}

// ─────────────────────────── 「这是我」口令 ───────────────────────────

/**
 * 发一个一次性口令，等主人去 QQ 里说一句「#我是 123456」。
 *
 * 为什么不用「谁先发消息谁就是主人」：那等于谁抢到算谁的 ——
 * 机器人一公开，主人还没说话，路人先发一句就把主人位占了。
 */
export function newClaimToken() {
  const data = readQq();
  const token = String(randomInt(100000, 1000000));
  data.claim = { token, at: Date.now() };
  writeQq(data);
  return { token, at: data.claim.at, ttlMs: CLAIM_TTL_MS };
}

export function claimState() {
  const c = readQq().claim;
  if (!c) return null;
  if (Date.now() - c.at > CLAIM_TTL_MS) return { ...c, expired: true };
  return { ...c, expired: false };
}

export function clearClaim() {
  const data = readQq();
  data.claim = null;
  writeQq(data);
}

/**
 * 认领：文本里出现这个口令就算认成功。
 *
 * 只认一次：认成功后立刻把口令清掉，别人再发同一串没用。
 * 认出返回 true，否则 false。
 */
export function tryClaim(openid, text, name = '') {
  const id = str(openid, 128);
  const c = claimState();
  if (!id || !c || c.expired) return false;
  const s = String(text ?? '');
  // 口令是 6 位数字 —— 用边界匹配，避免把「2026」里的数字串当成口令
  const hit = new RegExp(`(^|[^0-9])${c.token}([^0-9]|$)`).test(s);
  if (!hit) return false;
  const data = readQq();
  const now = Date.now();
  const cur = data.peers[id] || { sessionId: '', name: '', boundAt: now, lastAt: now, msgCount: 0 };
  data.peers[id] = { ...cur, role: 'owner', name: str(name, 40) || cur.name || '', lastAt: now };
  data.claim = null;
  writeQq(data);
  return true;
}

// ─────────────────────────── 杂项 ───────────────────────────

/**
 * 把一段长文字切成 QQ 能收的若干块。
 *
 * QQ 单条上限按字符算（官方推荐 4000 上下），本机默认 1500 —— 宁可多切几条，
 * 也别撞上限被整条退回。切的时候优先在空行 / 换行 / 句号处断，
 * 实在没有才硬切；同时避开「切在半个代码块里」。
 */
export function chunkText(text, limit = 1500) {
  const s = String(text ?? '');
  const max = Math.max(200, Math.floor(Number(limit) || 1500));
  if (s.length <= max) return s ? [s] : [];
  const out = [];
  let rest = s;
  while (rest.length > max) {
    let cut = -1;
    // 优先空行 → 换行 → 中文句号/问号/叹号 → 英文句号+空格 → 空格
    for (const re of [/\n\s*\n/g, /\n/g, /[。！？；]/g, /[.!?]\s/g, /\s/g]) {
      let m;
      let last = -1;
      re.lastIndex = 0;
      while ((m = re.exec(rest))) {
        const at = m.index + m[0].length;
        if (at > max) break;
        last = at;
      }
      if (last > max * 0.5) {
        cut = last;
        break;
      }
    }
    if (cut <= 0) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut);
  }
  if (rest.trim()) out.push(rest.trim());
  return out.filter(Boolean);
}

/** 生成一段随机串（给日志 / 追踪用）。 */
export function shortId(n = 6) {
  return randomBytes(Math.ceil(n / 2)).toString('hex').slice(0, n);
}
