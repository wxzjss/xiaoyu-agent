/**
 * 加号附件：只读地列目录、读图片。
 *
 * 主人要在聊天框里直接挑文件和图片，所以这里允许浏览整个 C 盘（不止工作区）。
 * 因此这个模块**只读**：不写、不删、不执行。
 */
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, parse, resolve, isAbsolute } from 'node:path';

/** 图片扩展名（小写） */
const IMAGE_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg',
]);

/** 单个图片预览上限：8MB */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
};

function extOf(p) {
  const s = String(p || '');
  const i = s.lastIndexOf('.');
  return i >= 0 ? s.slice(i).toLowerCase() : '';
}

export function isImagePath(p) {
  return IMAGE_EXT.has(extOf(p));
}

/** 磁盘根目录（Windows 是 C:\） */
function rootDrive() {
  return parse(process.cwd()).root || 'C:\\';
}

/**
 * 本机还有哪些盘。
 *
 * 以前只认「工作目录所在的盘」，于是加号里翻到 C:\ 就到头了，D 盘 E 盘根本进不去。
 * 这里把 A~Z 挨个 statSync 一下，存在的才算；Windows 上没插盘的盘符会直接报错，正好跳过。
 *
 * @returns {{name:string, path:string}[]} 形如 [{name:'C:', path:'C:\\'}, ...]
 */
export function drives() {
  const out = [];
  if (process.platform !== 'win32') {
    const root = rootDrive();
    out.push({ name: root, path: root });
    return out;
  }
  for (let i = 65; i <= 90; i++) { // A..Z
    const letter = String.fromCharCode(i);
    const p = letter + ':\\';
    try {
      if (statSync(p).isDirectory()) out.push({ name: letter + ':', path: p });
    } catch {
      // 没这个盘 / 没权限，跳过
    }
  }
  return out;
}

/**
 * 这个路径是不是盘符根（C:\、D:\ 这种）。
 * 是的话，界面上要把别的盘也列出来，不然只能困在一个盘里。
 */
function isDriveRoot(p) {
  // 别去数反斜杠有几个（不同地方传进来的写法不一样：C:  C:\  C:\\）。
  // 把所有分隔符统统去掉，剩下如果正好是「字母+冒号」，那就是盘符根。
  const t = String(p || '').trim().replace(/[\\/]+/g, '');
  return /^[A-Za-z]:$/.test(t);
}

/**
 * 主人的图片目录。
 *
 * 顺序：图片库 → 桌面 → 用户主目录 → 盘根。
 * 以前只认「Pictures」和主目录，主目录不在了就直接甩到盘根，
 * 于是图片模式打开后经常停在一个跟图片八竿子打不着的地方。
 */
function picturesDir() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    for (const name of ['Pictures', 'Desktop']) {
      const p = join(home, name);
      if (existsSync(p)) return p;
    }
    if (existsSync(home)) return home;
  }
  return rootDrive();
}

/** 某一类附件的默认起点：文件 -> 盘根，图片 -> 图片库 */
export function defaultDir(kind) {
  return kind === 'image' ? picturesDir() : rootDrive();
}

/**
 * 列一个目录。
 * @param {string} target 目录绝对路径；空则用默认目录
 * @param {'file'|'image'} kind
 */
export function browse(target, kind = 'file') {
  const root = rootDrive();
  const pics = picturesDir();
  let dir = target && String(target).trim() ? String(target).trim() : defaultDir(kind);
  if (!isAbsolute(dir)) dir = resolve(dir);

  let st;
  try {
    st = statSync(dir);
  } catch {
    dir = defaultDir(kind); // 路径没了就退回默认，别把界面卡死
    st = statSync(dir);
  }
  if (!st.isDirectory()) {
    dir = dirname(dir);
    st = statSync(dir);
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  const dirs = [];
  const files = [];

  for (const e of entries) {
    const full = join(dir, e.name);
    let isDir = e.isDirectory();
    let size = 0;
    let mtime = 0;
    try {
      const s = statSync(full);
      isDir = s.isDirectory();
      if (!isDir) size = s.size;
      mtime = s.mtimeMs;
    } catch {
      continue; // 没权限就跳过
    }
    if (isDir) {
      dirs.push({ name: e.name, path: full, drive: false });
    } else {
      const isImg = IMAGE_EXT.has(extOf(e.name));
      if (kind === 'image' && !isImg) continue; // 图片模式只列图片
      files.push({ name: e.name, path: full, size, mtime, isImage: isImg });
    }
  }

  // 站在盘根上：把其余几个盘也摆进来，点了就能跳过去
  if (isDriveRoot(dir)) {
    const self = dir.replace(/[\\/]+$/, '').toUpperCase();
    for (const d of drives()) {
      const key = d.path.replace(/[\\/]+$/, '').toUpperCase();
      if (key === self) continue;
      if (dirs.some((x) => String(x.path).replace(/[\\/]+$/, '').toUpperCase() === key)) continue;
      dirs.push({ name: d.name, path: d.path, drive: true });
    }
  }

  // 盘符排最前面，然后是普通文件夹
  dirs.sort((a, b) => {
    if (a.drive !== b.drive) return a.drive ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  if (kind === 'image') files.sort((a, b) => b.mtime - a.mtime);
  else files.sort((a, b) => a.name.localeCompare(b.name, 'zh'));

  const up = dirname(dir);
  const parent = resolve(up) === resolve(dir) ? null : up;

  return {
    dir,
    parent,
    kind,
    defaults: { root, pictures: pics },
    dirs,
    files,
  };
}

/**
 * 读一张图，返回 data URL 给界面做缩略图 / 给模型看。
 * @param {string} target 绝对路径
 */
export function readImageDataUrl(target) {
  const p = String(target || '').trim();
  if (!p) throw new Error('没给图片路径');
  if (!isAbsolute(p)) throw new Error('只接受绝对路径');
  if (!isImagePath(p)) throw new Error('不是图片文件：' + p);
  const st = statSync(p);
  if (!st.isFile()) throw new Error('不是一个文件：' + p);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片太大（${(st.size / 1024 / 1024).toFixed(1)}MB），超过 8MB 就不读了`);
  }
  const ext = extOf(p);
  const buf = readFileSync(p);
  const mime = MIME[ext] || 'application/octet-stream';
  return {
    path: p,
    name: p.split(/[\\/]/).pop(),
    size: st.size,
    mime,
    dataUrl: `data:${mime};base64,${buf.toString('base64')}`,
  };
}

/**
 * 把附件拼成一条用户消息的文本部分。
 * 只写路径，不塞 base64 —— 会话要落盘，塞了会把 jsonl 撑爆。
 * 图片路径另外记在 _images，发请求之前由 inflateImages 现读现编码。
 */
export function composeUserContent(text, attachments = []) {
  const list = Array.isArray(attachments) ? attachments.filter((a) => a && a.path) : [];
  const typed = String(text || '').trim();
  if (!list.length) return typed;

  const files = [];
  const images = [];
  for (const a of list) {
    const p = String(a.path);
    if (isImagePath(p)) images.push(p);
    else files.push(p);
  }

  const lines = [];
  if (typed) lines.push(typed);
  // 没打字就别留空行，第一行直接是附件说明
  if (files.length) {
    if (typed) lines.push('');
    lines.push('【主人随这条消息一起发来的文件】');
    for (const f of files) lines.push('- ' + f);
    lines.push('（看得见就用 read_file 读；路径在工作区外也要按绝对路径试一下）');
  }
  if (images.length) {
    if (typed) lines.push('');
    lines.push('【主人随这条消息一起发来的图片】');
    for (const p of images) lines.push('- ' + p);
    lines.push('（能从图里看到东西就结合图说；看不到就直说看不到，别瞎猜图里是什么）');
  }
  return lines.join('\n');
}

/** 这条消息带的图片路径。 */
export function imagesOf(msg) {
  if (!msg || msg.role !== 'user') return [];
  return Array.isArray(msg._images) ? msg._images : [];
}

/**
 * 发请求前把 _images 现读现编码，拼成多模态 content。
 * 读不到的图就跳过。返回新对象，不改原消息。
 */
export function inflateImages(msg) {
  const imgs = imagesOf(msg);
  if (!imgs.length) return msg;
  const textPart = typeof msg.content === 'string' ? msg.content : '';
  const parts = [{ type: 'text', text: textPart }];
  for (const p of imgs) {
    try {
      const img = readImageDataUrl(p);
      parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
    } catch {
      // 图没了 / 太大 -> 只在文字里留路径
    }
  }
  if (parts.length === 1) return msg;
  return { ...msg, content: parts };
}

/** 整个 history 过一遍，给 llm 调用用。 */
export function inflateHistory(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || typeof m !== 'object') return m;
    if (Array.isArray(m.content)) return m;
    return inflateImages(m);
  });
}

/**
 * 读图片原始字节，给 <img src> 直接用（返回 JSON 的预览接口不能直接当图片地址）。
 * @param {string} target 绝对路径
 */
export function readImageBytes(target) {
  const p = String(target || '').trim();
  if (!p) throw new Error('没给图片路径');
  if (!isAbsolute(p)) throw new Error('只接受绝对路径');
  if (!isImagePath(p)) throw new Error('不是图片文件：' + p);
  const st = statSync(p);
  if (!st.isFile()) throw new Error('不是一个文件：' + p);
  if (st.size > MAX_IMAGE_BYTES) {
    throw new Error(`图片太大（${(st.size / 1024 / 1024).toFixed(1)}MB），超过 8MB 不预览`);
  }
  return {
    buf: readFileSync(p),
    mime: MIME[extOf(p)] || 'application/octet-stream',
    mtime: st.mtimeMs,
    size: st.size,
  };
}
