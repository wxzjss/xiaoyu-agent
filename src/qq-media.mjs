/**
 * QQ 富媒体：把图 / 语音 / 文件 / 视频 从 QQ 收进来，也能从这边发出去。
 *
 * 为什么单独一个文件（2026-11-02）
 * 主人说：「最好还能让小鱼Agent在QQ里发文件语音图片」。以前 qq-bridge 里
 * 只会 `bot.sendText` —— 她只能打字。这一层专管「有二进制的那部分」：
 *
 *   收：QQ 附件带 url，要先下到本地，再把**绝对路径**告诉她（不是 base64，
 *       百兆图塞提示词里等于当场爆上下文）；语音没 url，只有 voice.url，
 *       下载后如果 ffmpeg 在，顺手转成 mp3，方便模型和界面直接播。
 *   发：本机路径 → 按后缀分派到 bot.sendImage / sendVideo / sendVoice /
 *       bot.sendFile。声音那块要注意：QQ 语音条要 silk，官方 SDK 的音频
 *       转换器会自己处理，但**它只在装了这个 SDK 的实现里**，所以这里不
 *       自己编码，只把文件交给 sendVoice 并允许它失败后降级成发文件。
 *
 * 安全：下载走 SSRF 白名单（只 https、挡内网段），和 dsh-qqbot 一个口径；
 * 发东西沿用 outbox 的 sendCheck（机密文件不发）。
 */
import { createWriteStream, existsSync, mkdirSync, statSync, unlinkSync, readdirSync } from 'node:fs';
import { basename, extname, join, resolve, isAbsolute } from 'node:path';
import { promises as dns } from 'node:dns';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';
import { sendCheck, mimeOf } from './outbox.mjs';

/** 一次下载最多 200MB —— 再大就不只是 QQ 的事了 */
export const MAX_DOWNLOAD_MB = Number(process.env.XIAOYU_QQ_MAX_MB || 200);
const TIMEOUT_MS = 120_000;

/** 收下来的东西放这儿（跟着数据目录走，卸载/换机器不会留一地垃圾） */
export function mediaRoot() {
  return join(config.dataDir, 'qq-media');
}

function ensureDir(d) {
  try {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  } catch {}
  return d;
}

/** 文件名：原名 + 时间戳 + 随机尾巴，防同名覆盖，也防别人猜到路径 */
function uniqueName(name, fallbackExt = '') {
  const base = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').slice(0, 80) || 'file';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const tail = randomBytes(3).toString('hex');
  const ext = extname(base) || fallbackExt;
  const stem = ext ? base.slice(0, -ext.length) : base;
  return `${stem}_${stamp}_${tail}${ext}`;
}

/* ---------------------------------------------------------------- */
/* 收：把 QQ 递过来的附件下到本地                                     */
/* ---------------------------------------------------------------- */

/** 按 contentType 分类；兼容裸值（'image'）和 MIME（'image/png'） */
export function kindOfAttachment(att) {
  const ct = String(att?.content_type ?? att?.contentType ?? '').toLowerCase();
  const name = String(att?.filename ?? att?.name ?? '').toLowerCase();
  const ext = extname(name);
  if (ct === 'image' || ct.startsWith('image/')) return 'image';
  if (ct === 'video' || ct.startsWith('video/')) return 'video';
  if (ct === 'voice' || ct === 'audio' || ct.startsWith('audio/')) return 'voice';
  if (ct === 'file' || ct.startsWith('application/')) return 'file';
  if (/^\.(png|jpe?g|gif|webp|bmp|heic|avif)$/.test(ext)) return 'image';
  if (/^\.(mp4|mov|avi|mkv|webm|flv)$/.test(ext)) return 'video';
  if (/^\.(mp3|wav|ogg|silk|amr|m4a|aac|flac)$/.test(ext)) return 'voice';
  return 'file';
}

/** 附件该从哪个 URL 下：图片/视频/文件在 url，语音在 voice.url */
export function attachmentUrl(att) {
  return String(att?.voice?.url ?? att?.voice_url ?? att?.url ?? att?.url_local ?? '').trim();
}

/** 私网段挡掉：QQ 的 CDN 都是公网 https，出现内网地址只可能是有人在钓鱼 */
function isPrivateIp(ip) {
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    if (a >= 224) return true;
    return false;
  }
  const s = ip.toLowerCase();
  if (s === '::1' || s === '::') return true;
  if (s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
  return false;
}

async function assertSafeUrl(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw Object.assign(new Error('附件地址不合法'), { status: 400 });
  }
  if (url.protocol !== 'https:') throw Object.assign(new Error('附件地址不是 https，不下载'), { status: 400 });
  const host = url.hostname;
  const looked = await dns.lookup(host, { all: true }).catch(() => []);
  for (const it of looked) {
    if (isPrivateIp(it.address)) throw Object.assign(new Error('附件地址指向内网，拒绝下载'), { status: 400 });
  }
  return url;
}

/**
 * 下一个附件。
 * @returns {Promise<{ok:boolean, localPath?:string, bytes?:number, kind?:string, why?:string}>}
 */
export async function downloadAttachment(att, kindHint = '') {
  const url = attachmentUrl(att);
  const kind = kindHint || kindOfAttachment(att);
  if (!url) return { ok: false, kind, why: '这个附件没带下载地址' };
  let parsed;
  try {
    parsed = await assertSafeUrl(url);
  } catch (e) {
    return { ok: false, kind, why: String(e?.message ?? e) };
  }

  const dir = ensureDir(mediaRoot());
  const fallbackExt = kind === 'image' ? '.png' : kind === 'video' ? '.mp4' : kind === 'voice' ? '.silk' : '';
  const name = uniqueName(att?.filename || att?.name || `qq_${kind}`, fallbackExt);
  const dest = join(dir, name);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(parsed, { signal: ac.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, kind, why: `下载失败 HTTP ${res.status}` };
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > MAX_DOWNLOAD_MB * 1024 * 1024) {
      return { ok: false, kind, why: `文件太大（${Math.round(declared / 1048576)}MB，上限 ${MAX_DOWNLOAD_MB}MB）` };
    }
    const body = res.body;
    if (!body) return { ok: false, kind, why: '响应没有内容' };
    await pipeline(Readable.fromWeb(body), createWriteStream(dest));
    const size = statSync(dest).size;
    if (size > MAX_DOWNLOAD_MB * 1024 * 1024) {
      try { unlinkSync(dest); } catch {}
      return { ok: false, kind, why: `下下来太大（${Math.round(size / 1048576)}MB）` };
    }
    return { ok: true, kind, localPath: dest, bytes: size };
  } catch (e) {
    return { ok: false, kind, why: String(e?.message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把一条 QQ 消息里所有附件下到本地。
 * @returns {Promise<Array<{kind:string, localPath?:string, filename?:string, bytes?:number, why?:string}>>}
 */
export async function saveInboundAttachments(attachments) {
  const list = Array.isArray(attachments) ? attachments : [];
  const out = [];
  for (const att of list) {
    const kind = kindOfAttachment(att);
    const filename = String(att?.filename || att?.name || '');
    const got = await downloadAttachment(att, kind);
    out.push({ ...got, filename: filename || basename(got.localPath || '') });
  }
  return out;
}

/** 给模型看的一行（图片给路径，它自己会 read_file） */
export function describeInbound(one) {
  const kindName = { image: '图片', video: '视频', voice: '语音', file: '文件' }[one?.kind] || '附件';
  if (!one?.ok) return `[${kindName}没收到：${one?.why || '原因不明'}]`;
  const mb = one.bytes ? `，${(one.bytes / 1048576).toFixed(2)}MB` : '';
  return `[${kindName}：${one.localPath}${mb}]`;
}

/** 找 ffmpeg：先看数据目录里小鱼Agent 自己那份，再看 PATH */
export function findFfmpeg() {
  const cands = [
    join(config.dataDir, 'runtime', 'bin', 'ffmpeg.exe'),
    'ffmpeg',
  ];
  if (process.env.XIAOYU_FFMPEG) cands.unshift(process.env.XIAOYU_FFMPEG);
  for (const c of cands) {
    try {
      if (c === 'ffmpeg') {
        // 交给系统去解析：真要用的时候 execFile 会自己报错
        return c;
      }
      if (existsSync(c)) return c;
    } catch {}
  }
  return '';
}

/** silk/amr/silk 转 mp3；转不了就原样返回（还能当文件发） */
export async function transcodeVoiceToMp3(localPath) {
  const src = String(localPath || '');
  const ext = extname(src).toLowerCase();
  if (!src || !existsSync(src)) return src;
  if (ext === '.mp3' || ext === '.wav') return src;
  const ff = findFfmpeg();
  if (!ff) return src;
  const dest = src.replace(/\.[^.]+$/, '') + '.mp3';
  await new Promise((ok, bad) => {
    execFile(ff, ['-y', '-i', src, '-ar', '24000', '-ac', '1', '-b:a', '64k', dest], { timeout: 120_000 }, (err) => {
      if (err) bad(err);
      else ok();
    });
  }).catch(() => {});
  return existsSync(dest) ? dest : src;
}

/* ---------------------------------------------------------------- */
/* 发：本机文件 → QQ                                                */
/* ---------------------------------------------------------------- */

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);
const VOICE_EXTS = new Set(['.mp3', '.wav', '.ogg', '.silk', '.amr', '.m4a', '.aac']);

/** 按后缀猜发法 */
export function kindOfFile(p) {
  const ext = extname(String(p || '')).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (VOICE_EXTS.has(ext)) return 'voice';
  return 'file';
}

/**
 * 发一个本机文件到 QQ。
 * @param {object} bot  官方 SDK 的 QQBot 实例
 * @param {{scope:string,targetId:string,msgId?:string}} target
 * @param {string} p    绝对路径
 * @param {{as?:string, name?:string}} opts
 */
export async function sendFileToQq(bot, target, p, opts = {}) {
  const abs = isAbsolute(String(p || '')) ? resolve(String(p)) : '';
  if (!abs) throw Object.assign(new Error('要发的文件得给绝对路径'), { status: 400 });
  const bad = sendCheck(abs);
  if (bad) throw Object.assign(new Error(bad), { status: 400 });
  if (!existsSync(abs)) throw Object.assign(new Error('找不到这个文件：' + abs), { status: 404 });

  const kind = String(opts.as || '') || kindOfFile(abs);
  const source = { localPath: abs };
  const name = String(opts.name || '') || basename(abs);

  const tryIt = async (fn) => {
    if (typeof bot?.[fn] !== 'function') return null;
    return await bot[fn](target, source, { fileName: name });
  };

  if (kind === 'image') {
    const r = await tryIt('sendImage');
    if (r) return { sent: 'image', raw: r };
  } else if (kind === 'video') {
    const r = await tryIt('sendVideo');
    if (r) return { sent: 'video', raw: r };
  } else if (kind === 'voice') {
    // 语音条要 silk：官方 SDK 会自己转；它转不了会抛，抛了就当普通文件发，别让整轮失败
    try {
      const r = await tryIt('sendVoice');
      if (r) return { sent: 'voice', raw: r };
    } catch (e) {
      const r = await tryIt('sendFile');
      if (r) return { sent: 'file', raw: r, note: '语音条没发出去（转码失败），改成发文件：' + String(e?.message ?? e) };
      throw e;
    }
  }
  const r = await tryIt('sendFile');
  if (r) return { sent: 'file', raw: r };
  // 都不行就退回文字：把路径告诉她，至少主人知道东西在哪
  await bot.sendText(target, `文件在这台机器上：${abs}`);
  return { sent: 'text' };
}

/** 界面上「QQ 富媒体」那一块的开关（默认开：主人要的就是这个） */
export function mediaReady(bot) {
  return {
    mediaRoot: mediaRoot(),
    maxMb: MAX_DOWNLOAD_MB,
    canImage: typeof bot?.sendImage === 'function',
    canVideo: typeof bot?.sendVideo === 'function',
    canVoice: typeof bot?.sendVoice === 'function',
    canFile: typeof bot?.sendFile === 'function',
    ffmpeg: findFfmpeg() || '',
    mimeOfImage: mimeOf('a.png'),
  };
}

/** 过一段时间清一下收下来的文件，别把硬盘堆满 */
export function pruneMediaDir(keepDays = 7) {
  const dir = mediaRoot();
  if (!existsSync(dir)) return 0;
  const cut = Date.now() - keepDays * 86400_000;
  let n = 0;
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      try {
        if (statSync(p).mtimeMs < cut) {
          unlinkSync(p);
          n++;
        }
      } catch {}
    }
  } catch {}
  return n;
}
