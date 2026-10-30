/**
 * 出件箱：把文件「交」给主人。
 *
 * 以前小鱼只能读、只能列目录，生成出来的东西停在磁盘上，得主人自己去翻。
 * 现在发文件走这条路：
 *   1) 工具 send_file 把路径收进来（顺手检查存在、多大、能不能读）；
 *   2) 这一轮跑完，server 把登记的条目挂到那条回复的 _files 上，跟着会话存盘；
 *   3) 界面上那条回复下面长出卡片：图片直接缩略图、视频能当场播、别的就是一行下载。
 *
 * 还有兜底箱：发出去的东西复制一份进 .state/outbox，会话记录丢了也还能点回来。
 *
 * 发文件本身不危险（主人自己点才下载），所以允许工作区外的绝对路径，
 * 但程序自己的机密不发：.env、.env.*、node_modules、.state 里的一律不发。
 */
import { statSync, existsSync, mkdirSync, copyFileSync, readdirSync } from "node:fs";
import { join, basename, extname, resolve, isAbsolute, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { config } from "./config.mjs";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 单个文件最大 2GB，再大浏览器下起来也费劲，先卡住并说清楚 */
export const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;

/** 常见后缀对应类型；没收录的按二进制下载（照样能存下来） */
const MIME = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp", ".ico": "image/x-icon", ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mov": "video/quicktime", ".avi": "video/x-msvideo", ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv",
  ".ts": "video/mp2t", ".mpg": "video/mpeg", ".mpeg": "video/mpeg",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".flac": "audio/flac", ".m4a": "audio/mp4",
  ".ogg": "audio/ogg", ".aac": "audio/aac",
  ".pdf": "application/pdf", ".zip": "application/zip", ".rar": "application/vnd.rar",
  ".7z": "application/x-7z-compressed", ".gz": "application/gzip", ".tar": "application/x-tar",
  ".txt": "text/plain; charset=utf-8", ".md": "text/markdown; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".xml": "application/xml; charset=utf-8",
  ".mobi": "application/x-mobipocket-ebook", ".epub": "application/epub+zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".apk": "application/vnd.android.package-archive",
};

export function mimeOf(p) {
  return MIME[extname(String(p || "")).toLowerCase()] || "application/octet-stream";
}

export function fileKindOf(p) {
  const m = mimeOf(p);
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("text/") || m.includes("json")) return "text";
  if (m === "application/pdf") return "pdf";
  return "file";
}

/** 这个绝对路径是不是程序自己的隐私（密钥 / 依赖树 / 状态库） */
export function isPrivatePath(p) {
  const abs = resolve(String(p || ""));
  if (!abs.toLowerCase().startsWith(APP_ROOT.toLowerCase())) return false;
  const rel = abs.slice(APP_ROOT.length).replace(/\\/g, "/").toLowerCase();
  if (/^\/\.env/.test(rel)) return true;
  if (rel.startsWith("/node_modules")) return true;
  if (rel.startsWith("/.state") || rel.startsWith("/.build")) return true;
  return false;
}

/**
 * 哪些盘让发：工作区、用户目录、程序自己所在的盘。
 * 别的一律不发 —— 系统盘（C:）只有主人在用的那块地方（用户目录）算数，
 * 别的目录连问都不用问，直接挡回去。
 */
function allowedDrives() {
  const set = new Set();
  const push = (p) => {
    const m = /^([A-Za-z]):/.exec(String(p || ""));
    if (m) set.add(m[1].toUpperCase());
  };
  push(config.workspace);
  push(process.env.USERPROFILE);
  push(APP_ROOT);
  if (!set.size) { set.add("C"); set.add("D"); }
  return set;
}

/**
 * 相对路径怎么算绝对路径：
 * 1) 先按工作区（sandbox）算；
 * 2) 工作区里没有、但相对程序根目录有，就用那个（主人嘴里常说的 "assets/x.mp4"、「dump/txt」都在那儿）；
 * 3) 都没有就按工作区算，报错里给出的路径才跟主人想的一样。
 */
function toAbs(raw) {
  const s = String(raw);
  if (isAbsolute(s)) return resolve(s);
  const ws = config.workspace || process.cwd();
  const a = resolve(ws, s);
  if (existsSync(a)) return a;
  const b = resolve(APP_ROOT, s);
  if (existsSync(b)) return b;
  return a;
}

/** 发之前拦一道；返回空串就是没问题 */
export function sendCheck(p) {
  const s = String(p || "");
  if (!isAbsolute(s)) return "要发文件得给绝对路径（相对路径只在工作区里认）";
  const m = /^([A-Za-z]):/.exec(s);
  if (m && !allowedDrives().has(m[1].toUpperCase())) return "不许往 " + m[1].toUpperCase() + ": 盘发东西";
  if (isPrivatePath(s)) return "这个是我们自己的机密文件，不发（换一个）";
  return "";
}

/**
 * 把一条路径检查成可发的条目。是文件夹就当场把这一层展开（不往下钻，免得卡死）。
 * @returns {{entry?:object, skip?:string, kids?:object[]}}
 */
export function normalizeSend(p) {
  const raw = String(p || "").trim();
  if (!raw) return { skip: "空路径" };
  const abs = toAbs(raw);
  const bad = sendCheck(abs);
  if (bad) return { skip: bad };
  let st;
  try {
    st = statSync(abs);
  } catch {
    return { skip: "找不到这个文件：" + abs };
  }
  if (st.isDirectory()) {
    let kids = [];
    try {
      kids = readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => normalizeSend(join(abs, e.name)).entry)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh"))
        .filter(Boolean);
    } catch { kids = []; }
    return { skip: "「" + basename(abs) + "」是文件夹，我只发里面这一层的文件", kids };
  }
  if (!st.isFile()) return { skip: "不是一个文件：" + abs };
  if (st.size > MAX_FILE_BYTES) {
    return { skip: "文件太大（" + (st.size / 1024 / 1024 / 1024).toFixed(2) + "GB），超过 2GB 不发" };
  }
  if (st.size === 0) return { skip: "这是个空文件：" + abs };
  return {
    entry: {
      path: abs,
      name: basename(abs),
      size: st.size,
      mtime: st.mtimeMs,
      kind: fileKindOf(abs),
      mime: mimeOf(abs),
      key: "",
    },
  };
}

/** 发出去的文件抄一份进兜底箱，返回兜底箱里那个文件名 */
export function stash(entry) {
  try {
    const dir = join(config.dataDir || ".", ".state", "outbox");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tag = createHash("sha1").update(entry.path + ":" + entry.mtime).digest("hex").slice(0, 10);
    const safe = String(entry.name).replace(/[\\/:*?"<>|]/g, "_").slice(-80);
    const out = join(dir, "o-" + tag + "-" + safe);
    if (!existsSync(out)) copyFileSync(entry.path, out);
    return basename(out);
  } catch {
    return "";
  }
}

/** 兜底箱里的文件，按名字取（只认文件名，防跳目录） */
export function outboxPath(key) {
  const k = basename(String(key || ""));
  if (!k) return "";
  const p = join(config.dataDir || ".", ".state", "outbox", k);
  return existsSync(p) ? p : "";
}

/** 界面上要用的形状 */
export function publicEntry(e) {
  return {
    path: e.path,
    name: e.name,
    size: e.size,
    kind: e.kind,
    mime: e.mime,
    key: e.key || "",
  };
}

export function fmtSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + " B";
  if (v < 1024 * 1024) return (v / 1024).toFixed(v < 10240 ? 1 : 0) + " KB";
  if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
  return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
}

export function checkAbs(p) { return sendCheck(p); }
