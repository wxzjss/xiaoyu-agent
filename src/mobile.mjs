/**
 * 手机配对：让局域网里的手机能连上这台电脑上的小鱼Agent。
 *
 * 设计原则（三个必须）：
 * 1. **默认不开**。桌面版本机用 127.0.0.1，手机要连才需要监听 0.0.0.0 ——
 *    默认开等于把聊天界面（含读写文件、跑命令的能力）暴露给整个局域网。
 * 2. **开了就要有门**。开了局域网之后所有请求都要带对 token，否则 401。
 *    本机回环地址（127.0.0.1 / ::1）永远放行，免得连自己都进不去。
 * 3. **token 只在配对页上露一次面**。手机上扫码/粘贴一次，存在 localStorage 里。
 *
 * token 存哪：config.dataDir/.state/mobile.json
 *   { enabled: boolean, token: string, createdAt, lastSeenAt, devices: [{ name, ua, firstAt, lastAt }] }
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { config } from './config.mjs';

const STATE = join(config.dataDir, '.state');
const FILE = join(STATE, 'mobile.json');

/** 手机配对默认关闭：只在用户明确点「开启」之后才监听局域网 */
const DEFAULTS = {
  enabled: false,
  token: '',
  createdAt: 0,
  lastSeenAt: 0,
  devices: [],
};

function read() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return {
      ...DEFAULTS,
      ...raw,
      devices: Array.isArray(raw?.devices) ? raw.devices : [],
    };
  } catch {
    return { ...DEFAULTS, devices: [] };
  }
}

function write(patch) {
  const cur = read();
  const next = { ...cur, ...patch };
  try {
    mkdirSync(STATE, { recursive: true });
    writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  } catch (e) {
    console.warn('[mobile] 写不了配对配置：' + (e?.message ?? e));
  }
  return next;
}

/** 生成/重置 token。32 字节 base64url ≈ 43 字符，够长不用再折腾 */
function newToken() {
  return randomBytes(32).toString('base64url');
}

export function getMobileState() {
  const s = read();
  return {
    enabled: Boolean(s.enabled),
    hasToken: Boolean(s.token),
    // token 本身不下发给前端（除了配对页那一次专门要的）
    token: s.token,
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    devices: s.devices,
  };
}

/** 只给界面看的版本：不带 token 明文，只带前 4 位做「是不是同一个」的提示 */
export function publicMobileState() {
  const s = read();
  return {
    enabled: Boolean(s.enabled),
    hasToken: Boolean(s.token),
    tokenHint: s.token ? s.token.slice(0, 4) + '…' : '',
    createdAt: s.createdAt,
    lastSeenAt: s.lastSeenAt,
    devices: s.devices,
  };
}

/**
 * 开启局域网。已经开过就直接返回（保留原 token，手机不用重配）。
 * @param {{ resetToken?: boolean }} opts
 */
export function enableMobile({ resetToken = false } = {}) {
  const cur = read();
  const patch = { enabled: true };
  if (!cur.token || resetToken) {
    patch.token = newToken();
    patch.createdAt = Date.now();
  }
  write(patch);
  return getMobileState();
}

export function disableMobile() {
  write({ enabled: false });
  return getMobileState();
}

/** 轮换 token：老手机会立刻失效，得重新配对 */
export function rotateMobileToken() {
  write({ token: newToken(), createdAt: Date.now() });
  return getMobileState();
}

/** 断开某台手机（只从列表里去掉，token 不变 —— 它拿着 token 还能连） */
export function forgetDevice(tokenHashOrUa) {
  const s = read();
  const devices = s.devices.filter((d) => d.id !== tokenHashOrUa);
  write({ devices });
  return getMobileState();
}

function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * 校验一个请求能不能访问。
 * @param {import('node:http').IncomingMessage} req
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkAccess(req) {
  const s = read();
  // 没开局域网：只允许本机
  if (!s.enabled) {
    return isLoopback(req) ? { ok: true } : { ok: false, reason: 'off' };
  }
  // 开了：本机永远放行
  if (isLoopback(req)) return { ok: true };
  const given = extractToken(req);
  if (!given) return { ok: false, reason: 'no-token' };
  if (!s.token || !safeEq(given, s.token)) return { ok: false, reason: 'bad-token' };
  return { ok: true };
}

function isLoopback(req) {
  const a = String(req.socket?.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/**
 * token 可以走 Authorization: Bearer，也可以走 x-mobile-token 头，也可以走 ?token=。
 *
 * 为什么要三种：手机壳（WebView）里页面自己发的 fetch 一个请求头都带不上
 * （loadUrl 的 Map 只作用于主框架），如果把 token 放 URL 又只能靠 ?token=，
 * 而页面代码里全是绝对路径 '/api/xxx'，绝对路径不继承文档的 query —— 试过，401。
 * 所以最可靠的是 cookie：WebView 开着 DomStorage/Cookie，同源请求浏览器自动带上，
 * 页面代码一个字都不用改。cookie 由 /api/mobile/cookie 下发（见下）。
 */
export function extractToken(req) {
  const h = String(req.headers?.authorization || '');
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const q = String(req.headers?.['x-mobile-token'] || '').trim();
  if (q) return q;
  // cookie：手机壳走的这条路
  const c = cookieToken(req);
  if (c) return c;
  try {
    const u = new URL(req.url || '/', 'http://x');
    return (u.searchParams.get('token') || '').trim();
  } catch {
    return '';
  }
}

/** 从 Cookie 头里挑出配对码（名字固定 xy_token） */
function cookieToken(req) {
  const raw = String(req.headers?.cookie || '');
  if (!raw) return '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== 'xy_token') continue;
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return '';
    }
  }
  return '';
}

/** 手机连上来时记一笔，界面上能看见「有几台手机连着过」 */
export function touchDevice(req) {
  const s = read();
  if (!s.enabled) return;
  const ua = String(req.headers?.['user-agent'] || 'unknown').slice(0, 160);
  const id = Buffer.from(ua).toString('base64url').slice(0, 20);
  const now = Date.now();
  const devices = s.devices.slice();
  const i = devices.findIndex((d) => d.id === id);
  if (i >= 0) {
    devices[i] = { ...devices[i], lastAt: now, lastSeenAt: now };
  } else {
    devices.push({ id, ua, firstAt: now, lastAt: now, lastSeenAt: now });
  }
  // 最多留 20 台，别让文件无限长
  write({ devices: devices.slice(-20), lastSeenAt: now });
}

/**
 * 这台机器上的 IPv4 地址，手机要连的就是其中之一。
 *
 * 排序按「手机到底连不连得上」分三档，不是随便排的：
 *  0 真实局域网（Wi-Fi / 有线）—— 同一个路由器下最直接；
 *  1 组网工具的地址（Radmin / Tailscale / ZeroTier / 蒲公英）—— **跨网络也能连**，
 *    手机装同一个客户端、加同一个网络拿到地址，用流量也能连回电脑；
 *  2 其它（认不出来的网卡）—— 兜底。
 *
 * 纯虚拟网卡（Hyper-V 的 vEthernet、WSL、VMware、VirtualBox、docker）直接丢掉：
 * 那些地址手机永远连不进去，列出来只会让人扫到错的码然后一直转圈。
 */
export function lanAddresses() {
  const out = [];
  try {
    for (const [name, list] of Object.entries(networkInterfaces())) {
      for (const it of list || []) {
        const fam = typeof it.family === 'string' ? it.family : it.family === 4 ? 'IPv4' : String(it.family);
        if (fam !== 'IPv4' || it.internal) continue;
        // 169.254.x.x 是 DHCP 失败时的自分配地址，连不上
        if (String(it.address).startsWith('169.254.')) continue;
        // 纯虚拟网卡，手机连不进来，别列
        if (/vethernet|hyper-?v|wsl|vmware|virtualbox|docker|loopback|default switch/i.test(name)) continue;
        out.push({ name, address: it.address, kind: kindOf(name) });
      }
    }
  } catch {}
  out.sort((a, b) => a.kind - b.kind);
  return out;
}

/** 0=真实局域网  1=组网工具（能跨网络）  2=认不出来的兜底 */
function kindOf(name) {
  if (/radmin|tailscale|zerotier|hamachi|蒲公英|oray|wireguard|openvpn|n2n/i.test(name)) return 1;
  if (/wlan|wi-?fi|无线|ethernet|以太网|本地连接|network/i.test(name)) return 0;
  return 2;
}

/** 给配对页用：地址 + 端口 + token，拼成手机可以直接扫的字符串 */
export function pairingInfo(port) {
  const s = read();
  return {
    enabled: Boolean(s.enabled),
    port,
    token: s.token,
    hosts: lanAddresses(),
  };
}
