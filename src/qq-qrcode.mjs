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

/**
 * 二维码可能落在哪儿（按可能性排序，逐个试）。
 *
 * 【2026-11-12 mac】原来这里写死了 `DIR + '\\napcat\\cache'`：
 *   ① 用反斜杠拼路径，在 mac/linux 上那不是分隔符，会被当成文件名的一部分
 *      （实测读出来是 `...qq-protocol\napcat\cache/qrcode.png`，永远 ENOENT）；
 *   ② mac 的 NapCat 根本不装在 DIR 里 —— 它在 QQ 的容器里，
 *      见 src/napcat-mac.mjs。
 * 所以改成「一串候选目录 + path.join」。
 */
async function cacheDirs() {
  const path = await import('node:path');
  const out = [];
  try {
    const p = await import('../scripts/qq-protocol.mjs');
    if (process.platform === 'darwin') {
      const mac = await import('./napcat-mac.mjs');
      const cat = mac.detectMacNapCat();
      for (const d of cat.qrDirs || []) out.push(d);
    }
    out.push(path.join(String(p.DIR), 'napcat', 'cache'));
  } catch (e) {
    if (!out.length) throw e;
  }
  return out;
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
  let dirs = [];
  try {
    dirs = await cacheDirs();
  } catch (e) {
    return { ok: false, exists: false, reason: 'no-protocol', error: String(e?.message ?? e) };
  }

  /* 逐个候选目录试：mac 上可能落在 napcat/cache、napcat/temp 或 napcat 根下。
   * 挑「最新的那一张」—— 换码时旧图还在，取到旧的会让人扫一张过期码。 */
  let best = null;
  let firstFile = '';
  for (const dir of dirs) {
    const file = path.join(dir, QR_NAME);
    if (!firstFile) firstFile = file;
    try {
      const st = fs.statSync(file);
      if (!st.size) continue;
      if (!best || st.mtimeMs > best.mtimeMs) best = { file, st };
    } catch { /* 这个目录没有，看下一个 */ }
  }

  if (!best) return { ok: false, exists: false, reason: 'not-yet', file: firstFile };

  const { file, st } = best;
  try {
    const buf = fs.readFileSync(file);
    /* 只认「成型的 PNG」。
     * 【2026-11-12 修】原来只看头两个字节 0x89 0x50，NapCat 正写到一半时
     * 我们读到的就是 `89 50 00` 这种残片 —— 也会被判成合法，base64 塞进 <img>
     * 变成一张破图，面板上看着像「码没出来」，实际是读早了。
     * 现在要求：8 字节签名全对 + 第 12~16 字节是 IHDR + 能读出正的宽高。 */
    const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    const headOk = buf.length >= 33
      && PNG_SIG.every((b, i) => buf[i] === b)
      && buf.toString('latin1', 12, 16) === 'IHDR';
    const width = headOk ? buf.readUInt32BE(16) : 0;
    const height = headOk ? buf.readUInt32BE(20) : 0;
    if (!headOk || !width || !height) {
      return { ok: false, exists: true, reason: 'not-png', size: st.size, file };
    }
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
