/**
 * 协议端（NapCat）的登录二维码 —— 直接读它自己写出来的那张图。
 *
 * 为什么要走文件而不是 WebUI 接口：
 *   NapCat 4.x 的 /api/QQLogin/* 全都被一层凭证中间件挡着（_ue），
 *   那个凭证要用只有进程自己知道的 secretKey 做 HMAC 才能签出来
 *   （`static secretKey = process.env.NAPCAT_WEBUI_JWT_SECRET_KEY || Math.random()...`），
 *   外面无论拿 webui.json 里的 token 还是 Authorization: Bearer 都进不去。
 *   所以别去碰那扇门 —— 它自己在扫码那一下会把同一张图落到 cache/qrcode.png，
 *   我们读那张图就行，稳定、无鉴权、还不用求它开会话。
 *
 * 状态怎么判：缓存图的新鲜度 + 3001 端口通不通（= QQ 已经登上了、OneBot 开好了）。
 */

const QR_NAME = 'qrcode.png';

/** 目录：%LOCALAPPDATA%\XiaoyuAgent\qq-protocol\napcat\cache */
async function cacheDir() {
  const p = await import('../scripts/qq-protocol.mjs');
  return String(p.DIR) + '\\napcat\\cache';
}

function stamp(st) {
  return st && st.mtime ? st.mtime.getTime() : 0;
}

/**
 * 读缓存里的二维码。
 *
 * 返回 { ok, exists, base64, mtime, ageMs, size }
 *   - ok=false 时 reason 说明为什么没有：没装 / 还没弹出二维码 / 读不动
 */
export async function loginQrcode() {
  const fs = await import('node:fs');
  const path = await import('node:path');
  let dir = '';
  try {
    dir = await cacheDir();
  } catch (e) {
    return { ok: false, exists: false, reason: 'no-protocol', error: String(e?.message ?? e) };
  }
  const file = path.join(dir, QR_NAME);
  try {
    const st = fs.statSync(file);
    if (!st.size) return { ok: false, exists: false, reason: 'empty' };
    const buf = fs.readFileSync(file);
    // 只认 PNG（防止读到半截写坏的图）
    if (buf[0] !== 0x89 || buf[1] !== 0x50) return { ok: false, exists: true, reason: 'not-png' };
    let width = 0;
    let height = 0;
    try {
      width = buf.readUInt32BE(16);
      height = buf.readUInt32BE(20);
    } catch {}
    return {
      ok: true,
      exists: true,
      base64: buf.toString('base64'),
      mtime: stamp(st),
      ageMs: Date.now() - stamp(st),
      size: st.size,
      width,
      height,
      file,
    };
  } catch (e) {
    if (e?.code === 'ENOENT') return { ok: false, exists: false, reason: 'not-yet', file };
    return { ok: false, exists: false, reason: 'read-failed', error: String(e?.message ?? e), file };
  }
}

/** 二维码是不是太久没更新（默认 3 分钟算过期，NapCat 自己 2 分钟左右会换一张） */
export const QR_STALE_MS = 3 * 60 * 1000;

/**
 * 一句话说清「现在扫码这一步行不行」。
 *
 * protocol: qq-onebot.protocolState() 的结果
 * qr: loginQrcode() 的结果
 * online: OneBot 的 ws 是不是已经连上了（连上=已经登录成功，不用扫了）
 */
export function qrcodeHint({ protocol, qr, online } = {}) {
  if (online) return '这个号已经登上了，不用扫码。';
  if (!protocol?.installed) return '这台机器上还没装协议端，先点「准备协议端」。';
  if (!protocol?.running) return '协议端进程没在跑 —— 点「准备协议端」，或者等它自己拉起来。';
  if (!qr?.ok) {
    if (qr?.reason === 'not-yet') return '协议端刚起来，二维码还没弹出来，过几秒再刷新。';
    if (qr?.reason === 'not-png') return '二维码图还没写完，过几秒再刷新。';
    return '还没拿到二维码。';
  }
  if (qr.ageMs > QR_STALE_MS) return '这张二维码有点旧了，可能已过期 —— 在 QQ 窗口里点一下刷新，或者关掉重开协议端。';
  return '拿手机 QQ 扫这张码，扫完在手机上点确认，这边会自动连上。';
}
