/**
 * 语音引擎：第一次要用「小鱼说话」时，把 Python + edge-tts + ffmpeg 装到数据目录里。
 *
 * 为什么不在安装包里带着？
 *   带齐要一个便携 Python（约 11MB 压缩 / 30MB 解开）+ ffmpeg（约 80MB 压缩）。
 *   大部分人根本不用语音，塞进去纯属让所有人都多下 100MB+。
 *
 * 所以做法是「用时再拿」：
 *   - 这台机器上已经有能用的 python + edge_tts（开发机就是这样）→ 什么都不装，直接用；
 *   - 没有 → 从**国内镜像**下载嵌入式 Python + 几个 wheel + 一个 ffmpeg.exe，
 *     解到 `<数据目录>/runtime/` 底下。这份东西和程序本身完全分开，删了重装不影响。
 *
 * 镜像的选择不是随便挑的：实测同一台机器上
 *   python.org            →  74 KB/s   下 11MB 要两分半
 *   registry.npmmirror.com → 5 MB/s    下 11MB 两秒
 * 差 70 倍。国内用户是主体，所以默认走 npmmirror / 清华，官方地址留作兜底。
 *
 * 全程只用 Node 内置能力（fetch / zlib / child_process），不引第三方包 ——
 * 引了就得进 asar，又回到「安装包变大」的老路。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  rmSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { inflateRawSync, gunzipSync } from 'node:zlib';
import { config } from './config.mjs';

const RUNTIME = join(config.dataDir, 'runtime');
const PY_DIR = join(RUNTIME, 'python');
const LIB_DIR = join(RUNTIME, 'lib');
const BIN_DIR = join(RUNTIME, 'bin');
const PY_EXE = join(PY_DIR, 'python.exe');
const FF_EXE = join(BIN_DIR, 'ffmpeg.exe');
const STATE = join(config.dataDir, '.state');
const MARK = join(STATE, 'voice-runtime.json'); // 装好之后的记录
const PROGRESS = join(STATE, 'voice-runtime.progress.json'); // 装到一半的进度（给界面看）

/* ------------------------------------------------------------------ */
/* 下载源：国内镜像优先，官方兜底                                      */
/* ------------------------------------------------------------------ */
const PY_VER = '3.11.9';
// 嵌入式 Python，两个源挨个试
const PY_URLS = [
  `https://registry.npmmirror.com/-/binary/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip`,
  `https://www.python.org/ftp/python/${PY_VER}/python-${PY_VER}-embed-amd64.zip`,
];

// wheel 从清华 PyPI 镜像取（比 pypi.org 快 15 倍以上）
const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple';
const PYPI_OFFICIAL = 'https://pypi.org/pypi';

// 纯 Python 包（wheel 解开就能 import）
const PURE_PKGS = [
  ['edge-tts', '7.3.1'],
  ['tabulate', '0.9.0'],
  ['certifi', '2024.8.30'],
  ['idna', '3.10'],
  ['attrs', '24.2.0'],
  ['typing-extensions', '4.12.2'],
];

// 带 C 扩展的，要 win_amd64 + cp311
const BIN_PKGS = [
  ['aiohttp', '3.10.10'],
  ['aiosignal', '1.3.1'],
  ['frozenlist', '1.4.1'],
  ['multidict', '6.1.0'],
  ['yarl', '1.15.5'],
  ['propcache', '0.2.1'],
  ['aiohappyeyeballs', '2.4.3'],
];

// ffmpeg：用 npm 那个 ffmpeg-static 的 win32-x64 构建，走 npmmirror 的二进制镜像。
// 它是**单个静态 exe**，压缩后 28MB、解开 79MB —— 比 gyan.dev 那个 109MB 的 zip
// （里面还塞着 ffplay / ffprobe，我们一个都用不上）划算得多，
// 而且 gyan.dev 在国内实测只有 4.8 KB/s，109MB 得下六小时，根本不能当默认源。
//
// 顺序：npmmirror 的 .gz（快）→ npmmirror 的裸 exe（有的版本没有 .gz）→ gyan 兜底。
const FF_GZ = 'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz';
const FF_URLS = [
  FF_GZ,
  'https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64',
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
];

/* ------------------------------------------------------------------ */
/* 进度上报                                                            */
/* ------------------------------------------------------------------ */
let livePhase = '';
let livePct = 0;
let liveMsg = '';
let busy = false;

function setProgress(phase, pct, msg) {
  livePhase = phase;
  livePct = Math.max(0, Math.min(100, Math.round(pct)));
  liveMsg = msg || '';
  try {
    mkdirSync(STATE, { recursive: true });
    writeFileSync(
      PROGRESS,
      JSON.stringify({ phase: livePhase, pct: livePct, msg: liveMsg, at: Date.now() }),
      'utf8',
    );
  } catch {}
}

function clearProgress() {
  try {
    if (existsSync(PROGRESS)) unlinkSync(PROGRESS);
  } catch {}
}

/* ------------------------------------------------------------------ */
/* 探测                                                                */
/* ------------------------------------------------------------------ */
function runQuiet(exe, args, timeoutMs = 15000) {
  return new Promise((done) => {
    let out = '';
    let finished = false;
    let p;
    const finish = (r) => {
      if (finished) return;
      finished = true;
      done(r);
    };
    try {
      p = spawn(exe, args, { windowsHide: true, shell: false });
    } catch (e) {
      return finish({ ok: false, out: '', err: String(e?.message ?? e) });
    }
    const timer = setTimeout(() => {
      try { p.kill(); } catch {}
      finish({ ok: false, out, err: '超时' });
    }, timeoutMs);
    p.stdout?.on('data', (d) => { out += String(d); });
    p.stderr?.on('data', (d) => { out += String(d); });
    p.on('error', (e) => { clearTimeout(timer); finish({ ok: false, out, err: String(e?.message ?? e) }); });
    p.on('close', (code) => { clearTimeout(timer); finish({ ok: code === 0, out, err: code ? `退出码 ${code}` : '' }); });
  });
}

/** 这个解释器能不能真的 import edge_tts */
async function usablePython(exe) {
  if (!exe) return false;
  const r = await runQuiet(exe, ['-c', 'import edge_tts,sys;print("EDGE_OK",sys.version.split()[0])'], 20000);
  return Boolean(r.ok && r.out.includes('EDGE_OK'));
}

/** 这台机器上现成能用的 python（按可信度）。只返回真能 import edge_tts 的。 */
export async function readyPythons() {
  const lad = process.env.LOCALAPPDATA || '';
  const cands = [
    existsSync(PY_EXE) ? PY_EXE : '',
    process.env.XIAOYU_PYTHON || '',
    lad ? join(lad, 'Python', 'bin', 'python.exe') : '',
    lad ? join(lad, 'Python', 'pythoncore-3.14-64', 'python.exe') : '',
    'python',
  ].filter(Boolean);
  const seen = new Set();
  const good = [];
  for (const p of cands) {
    const s = p.split('\\').join('/');
    if (seen.has(s)) continue;
    seen.add(s);
    if (/[\\/]/.test(s) && !existsSync(s)) continue;
    if (await usablePython(s)) {
      good.push(s);
      // 自己装的那份能用就够了，不用再往下试
      if (s === PY_EXE.split('\\').join('/')) break;
    }
  }
  return good;
}

/** ffmpeg 在不在 */
export async function readyFfmpeg() {
  const cands = [existsSync(FF_EXE) ? FF_EXE : '', process.env.XIAOYU_FFMPEG || '', 'ffmpeg'].filter(Boolean);
  for (const p of cands) {
    const r = await runQuiet(p.split('\\').join('/'), ['-version'], 12000);
    if (r.ok && r.out.toLowerCase().includes('ffmpeg')) return p.split('\\').join('/');
  }
  return '';
}

/* ------------------------------------------------------------------ */
/* 下载 + 解压                                                         */
/* ------------------------------------------------------------------ */
async function downloadTo(url, dest, label, fromPct, toPct) {
  mkdirSync(dirname(dest), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败 ${res.status}：${label}`);
  const total = Number(res.headers.get('content-length') || 0);
  const chunks = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
    got += value.length;
    const pct = total
      ? fromPct + ((toPct - fromPct) * got) / total
      : fromPct + ((toPct - fromPct) * (1 - Math.exp(-got / 4e7)));
    setProgress('download', pct, `${label} ${(got / 1048576).toFixed(1)}MB`);
  }
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error(`下载到空文件：${label}`);
  writeFileSync(dest, buf);
  return buf.length;
}

/** 挨个试一组地址，第一个成功的留下 */
async function downloadAny(urls, dest, label, fromPct, toPct) {
  let lastErr = null;
  for (let i = 0; i < urls.length; i++) {
    try {
      return await downloadTo(urls[i], dest, label, fromPct, toPct);
    } catch (e) {
      lastErr = e;
      console.warn(`[voice-runtime] ${label} 第 ${i + 1} 个源不行：${String(e?.message ?? e)}`);
    }
  }
  throw new Error(`${label} 所有源都下载失败：${String(lastErr?.message ?? lastErr)}`);
}

/** 极简 zip 解压：deflate / store，够对付 python embed 和 wheel。不出目录。 */
function unzipTo(buf, destDir) {
  mkdirSync(destDir, { recursive: true });
  const EOCD = 0x06054b50;
  let eocdAt = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocdAt = i; break; }
  }
  if (eocdAt < 0) throw new Error('压缩包结构不认识（找不到目录末尾）');
  const count = buf.readUInt16LE(eocdAt + 10);
  let p = buf.readUInt32LE(eocdAt + 16);
  let written = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const clean = name.split('\\').join('/');
    if (clean.includes('..') || clean.startsWith('/') || /^[a-zA-Z]:/.test(clean)) continue;
    const lNameLen = buf.readUInt16LE(localAt + 26);
    const lExtraLen = buf.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataAt, dataAt + compSize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw); } catch { continue; }
    } else continue;
    const outPath = join(destDir, clean);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, data);
    written += 1;
  }
  return written;
}

/**
 * 从清华镜像的 /simple/<pkg>/ 页面里挑一个可用的 wheel。
 * 页面就是一堆 <a href="...">文件名</a>，按优先级挑：
 *   py3-none-any（纯 Python）> cp311-win_amd64 > abi3-win_amd64
 * 这样的页面解析很土，但对镜像站的结构足够稳，而且不需要第三方 HTML 解析库。
 */
async function wheelFromMirror(name, version) {
  const page = `${PYPI_MIRROR}/${name}/`;
  const r = await fetch(page, { redirect: 'follow' });
  if (!r.ok) throw new Error(`镜像里查不到 ${name}（${r.status}）`);
  const html = await r.text();
  const found = [];
  const re = /<a\s[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let href = m[1];
    let file = m[2].trim();
    // 老式镜像会把文件名放在 #sha256= 后面
    if (file.includes('#')) file = file.split('#')[0];
    if (!/\.whl$/i.test(file)) continue;
    if (!file.startsWith(`${name.replace(/-/g, '_')}-${version}`) && !file.startsWith(`${name}-${version}`)) continue;
    if (href.startsWith('../')) href = new URL(href, page).href;
    if (!/^https?:/i.test(href)) href = new URL(href, page).href;
    found.push({ href, file });
  }
  if (!found.length) throw new Error(`镜像里 ${name} ${version} 没有 wheel`);

  // 通过文件名里的 tag 判断能不能用
  const py311 = process.versions && true;
  const rank = (f) => {
    if (/py3-none-any\.whl$/i.test(f)) return 0;
    if (/py2\.py3-none-any\.whl$/i.test(f)) return 1;
    if (/-cp311-cp311-win_amd64\.whl$/i.test(f)) return 2;
    if (/-cp311-abi3-win_amd64\.whl$/i.test(f)) return 3;
    if (/-cp3\d+-abi3-win_amd64\.whl$/i.test(f)) return 4;
    return 99;
  };
  found.sort((a, b) => rank(a.file) - rank(b.file));
  const best = found.find((x) => rank(x.file) < 99);
  if (!best) throw new Error(`${name} ${version} 的 wheel 都不适配 cp311/win_amd64`);
  return best.href;
}

/** 把 wheel 解开倒进 lib/ —— wheel 里面就是可以直接 import 的目录结构 */
async function installWheel(name, version, fromPct, toPct) {
  const url = await wheelFromMirror(name, version);
  const tmp = join(RUNTIME, '_tmp', `${name}.whl`);
  await downloadTo(url, tmp, name, fromPct, toPct);
  const n = unzipTo(readFileSync(tmp), LIB_DIR);
  try { unlinkSync(tmp); } catch {}
  return n;
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
export function runtimeInfo() {
  const hasPy = existsSync(PY_EXE);
  const hasFf = existsSync(FF_EXE);
  let installed = false;
  try {
    installed = Boolean(JSON.parse(readFileSync(MARK, 'utf8')).ok);
  } catch {}
  let progress = null;
  try {
    progress = JSON.parse(readFileSync(PROGRESS, 'utf8'));
  } catch {}
  return {
    busy,
    installed,
    hasPython: hasPy,
    hasFfmpeg: hasFf,
    pythonPath: hasPy ? PY_EXE : '',
    ffmpegPath: hasFf ? FF_EXE : '',
    progress,
    dir: RUNTIME,
    bytes: hasPy || hasFf ? dirSize(RUNTIME) : 0,
  };
}

/** 装它。已经装好就直接返回。 */
export async function installRuntime() {
  if (busy) return { ok: false, busy: true, error: '正在装，别重复点' };
  busy = true;
  const t0 = Date.now();
  try {
    mkdirSync(RUNTIME, { recursive: true });
    mkdirSync(LIB_DIR, { recursive: true });
    mkdirSync(BIN_DIR, { recursive: true });
    const tmpDir = join(RUNTIME, '_tmp');
    mkdirSync(tmpDir, { recursive: true });

    // 1) Python 本体 0-30%
    if (!existsSync(PY_EXE)) {
      setProgress('python', 1, '下载 Python 运行时');
      const zip = join(tmpDir, 'python.zip');
      await downloadAny(PY_URLS, zip, 'Python', 1, 26);
      setProgress('python', 28, '解压 Python');
      unzipTo(readFileSync(zip), PY_DIR);
      try { unlinkSync(zip); } catch {}
      if (!existsSync(PY_EXE)) throw new Error('Python 解压完没找到 python.exe');
    } else {
      setProgress('python', 30, 'Python 已经有了');
    }

    // 2) 嵌入式 Python 默认不读 site-packages，得改 python311._pth，
    //    把 lib/ 加进去，否则装了 wheel 也 import 不到。
    try {
      const pth = readdirSync(PY_DIR).find((f) => /^python\d+\._pth$/i.test(f));
      if (pth) {
        const f = join(PY_DIR, pth);
        let text = readFileSync(f, 'utf8');
        const want = LIB_DIR.split('\\').join('/');
        if (!text.includes(want)) {
          text = text.replace(/#\s*import site/i, 'import site');
          if (!/\nimport site/.test(text)) text += '\nimport site\n';
          text += '\n' + want + '\n';
          writeFileSync(f, text, 'utf8');
        }
      }
    } catch (e) {
      console.warn('[voice-runtime] 改 _pth 失败：', String(e?.message ?? e));
    }

    // 3) 依赖包 30-75%
    const all = PURE_PKGS.length + BIN_PKGS.length;
    let done = 0;
    for (const [name, version] of [...PURE_PKGS, ...BIN_PKGS]) {
      const a = 30 + (44 * done) / all;
      const b = 30 + (44 * (done + 1)) / all;
      setProgress('packages', a, `装 ${name}`);
      await installWheel(name, version, a, b);
      done += 1;
    }

    // 4) 校验：真能 import 才算成功
    setProgress('verify', 78, '检查 Python 依赖');
    const okPy = await usablePython(PY_EXE.split('\\').join('/'));
    if (!okPy) throw new Error('Python 装好了但 import edge_tts 还是失败（依赖没装全）');

    // 5) ffmpeg 78-98%
    if (!existsSync(FF_EXE)) {
      setProgress('ffmpeg', 80, '下载 ffmpeg');
      const tmp = join(tmpDir, 'ffmpeg.dl');
      let okExe = false;
      // 先试 npmmirror 那两个（.gz / 裸 exe）：拿到的就是单个 exe，直接落盘
      try {
        const n = await downloadAny(FF_URLS.slice(0, 2), tmp, 'ffmpeg', 80, 95);
        const raw = readFileSync(tmp);
        // .gz 的魔数是 1f 8b；裸 exe 是 MZ。两个都得认，不然后面会写出个坏文件。
        const looksGz = raw[0] === 0x1f && raw[1] === 0x8b;
        const looksExe = raw[0] === 0x4d && raw[1] === 0x5a;
        if (looksGz) {
          setProgress('ffmpeg', 96, '解压 ffmpeg');
          const exe = gunzipSync(raw);
          if (exe.length > 1e6 && exe[0] === 0x4d && exe[1] === 0x5a) {
            writeFileSync(FF_EXE, exe);
            okExe = true;
          }
        } else if (looksExe && n > 1e6) {
          writeFileSync(FF_EXE, raw);
          okExe = true;
        }
        try { unlinkSync(tmp); } catch {}
      } catch (e) {
        console.warn('[voice-runtime] ffmpeg 镜像源不行，改用压缩包：', String(e?.message ?? e));
      }
      if (!okExe) {
        setProgress('ffmpeg', 82, '下载 ffmpeg 压缩包');
        const zip = join(tmpDir, 'ffmpeg.zip');
        await downloadAny(FF_URLS.slice(2), zip, 'ffmpeg', 82, 95);
        setProgress('ffmpeg', 96, '解压 ffmpeg');
        unzipTo(readFileSync(zip), tmpDir);
        try { unlinkSync(zip); } catch {}
        let found = '';
        const walk = (dir, depth) => {
          if (found || depth > 4) return;
          let list = [];
          try { list = readdirSync(dir, { withFileTypes: true }); } catch { return; }
          for (const d of list) {
            const full = join(dir, d.name);
            if (d.isDirectory()) walk(full, depth + 1);
            else if (/^ffmpeg\.exe$/i.test(d.name)) { found = full; return; }
          }
        };
        walk(tmpDir, 0);
        if (!found) throw new Error('ffmpeg 压缩包里没找到 ffmpeg.exe');
        mkdirSync(BIN_DIR, { recursive: true });
        try {
          renameSync(found, FF_EXE);
        } catch {
          writeFileSync(FF_EXE, readFileSync(found));
          try { unlinkSync(found); } catch {}
        }
      }
    } else {
      setProgress('ffmpeg', 96, 'ffmpeg 已经有了');
    }

    const okFf = await readyFfmpeg();
    if (!okFf) throw new Error('ffmpeg 装好了但跑不起来');

    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}

    setProgress('done', 100, '装好了');
    const info = {
      ok: true,
      at: Date.now(),
      tookMs: Date.now() - t0,
      python: PY_EXE,
      ffmpeg: FF_EXE,
      bytes: dirSize(RUNTIME),
    };
    mkdirSync(STATE, { recursive: true });
    writeFileSync(MARK, JSON.stringify(info, null, 2), 'utf8');
    clearProgress();
    return info;
  } catch (e) {
    const msg = String(e?.message ?? e);
    setProgress('error', livePct, msg);
    throw Object.assign(new Error(msg), { status: 500 });
  } finally {
    busy = false;
  }
}

/** 删掉装好的运行时（省空间用） */
export function removeRuntime() {
  try {
    rmSync(RUNTIME, { recursive: true, force: true });
  } catch (e) {
    throw Object.assign(new Error('删不掉：' + String(e?.message ?? e)), { status: 500 });
  }
  try { unlinkSync(MARK); } catch {}
  clearProgress();
  return { ok: true };
}

function dirSize(dir) {
  let total = 0;
  const walk = (d) => {
    let list = [];
    try { list = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const x of list) {
      const full = join(d, x.name);
      if (x.isDirectory()) walk(full);
      else {
        try { total += statSync(full).size; } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

/** 嵌入式那套的 python / ffmpeg 路径（没装就是空串） */
export function bundledPython() {
  return existsSync(PY_EXE) ? PY_EXE.split('\\').join('/') : '';
}
export function bundledFfmpeg() {
  return existsSync(FF_EXE) ? FF_EXE.split('\\').join('/') : '';
}

/* ------------------------------------------------------------------ */
/* 静默安装                                                            */
/* ------------------------------------------------------------------ */
/**
 * 开机自检发现缺东西就自己在后台装掉，不要等用户点。
 *
 * 为什么放后台而不是开机就装：
 *   装一次 108MB，在慢网下要几分钟，拦住启动会很烦。但**也不能等用户点试听才发现缺** ——
 *   那一刻他已经想听了，再等三分钟就是纯等待。所以折中：启动几十秒后悄悄开始装，
 *   用户真去点试听的时候多半已经装好了；没装完的话试听那边会显示进度，不是干等。
 *
 * 什么时候不装：
 *   - 已经装好（voice-runtime.json 有记录）
 *   - 这台机器本来就有能用的 python + edge_tts 和 ffmpeg（开发机就是这样，没必要再下一份）
 *   - 「小鱼说话」这个功能在【功能】里被关掉了
 *   - 正在装（busy）
 *
 * 结果写进 .state/voice-runtime.json，失败也写一条（带 error），
 * 这样下次启动不会无限重试同样失败的下载 —— 隔 6 小时再试一次。
 */
const SILENT_RETRY_MS = 6 * 60 * 60 * 1000;

export function runtimeNeed() {
  const info = runtimeInfo();
  if (info.installed) return { need: false, why: '装好了' };
  let mark = null;
  try { mark = JSON.parse(readFileSync(MARK, 'utf8')); } catch {}
  if (mark && mark.ok === false && Date.now() - (mark.at || 0) < SILENT_RETRY_MS) {
    return { need: false, why: '上次失败，还没到重试时间' };
  }
  if (info.busy) return { need: false, why: '正在装' };
  return { need: true, why: '缺运行环境' };
}

let silentStarted = false;
let silentP = null;

/**
 * 后台悄悄装。返回 started=true 表示这次真的踢起来了。
 * 注意是「fire and forget」：调用方不用 await，装的结果进 RUNNING_MARK。
 */
export function ensureVoiceRuntimeInBackground(reason = '') {
  if (silentStarted || busy) return false;
  const r = runtimeNeed();
  if (!r.need) return false;
  silentStarted = true;
  console.log(`[voice-runtime] ${reason || '后台'}：开始静默安装（${r.why}）`);
  silentP = (async () => {
    try {
      // 先看一眼这台机器上是不是本来就有能用的，别白下 108MB
      const [pys, ff] = await Promise.all([readyPythons(), readyFfmpeg()]);
      if (pys.length && ff) {
        mkdirSync(STATE, { recursive: true });
        writeFileSync(
          MARK,
          JSON.stringify(
            { ok: true, at: Date.now(), tookMs: 0, python: pys[0], ffmpeg: ff, using: '本机已有的', bytes: 0 },
            null,
            2,
          ),
          'utf8',
        );
        console.log('[voice-runtime] 这台机器本来就有 python + edge_tts + ffmpeg，不用装');
        return { ok: true, using: '本机已有的' };
      }
      const out = await installRuntime();
      console.log('[voice-runtime] 静默安装完成：', out.python);
      return out;
    } catch (e) {
      const msg = String(e?.message ?? e);
      console.warn('[voice-runtime] 静默安装失败：', msg);
      try {
        mkdirSync(STATE, { recursive: true });
        writeFileSync(
          MARK,
          JSON.stringify({ ok: false, at: Date.now(), error: msg }, null, 2),
          'utf8',
        );
      } catch {}
      return { ok: false, error: msg };
    } finally {
      busy = false;
      // 留个记号，别同一个进程里反复重试
      silentStarted = true;
    }
  })();
  return true;
}
