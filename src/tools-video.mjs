/**
 * 看视频的眼睛 —— 把 video-watch-plus 那套「可核算的证据」接成我的工具。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么不是「给模型加个感官」
 * ─────────────────────────────────────────────────────────────
 * 现在多模态模型确实能看几帧图，但看完之后说的话**没法核**：
 * 它说「第 12 秒有个转场」，没人知道那是真看见的还是编的。
 *
 * video-watch-plus 提供的是另一条路：先用 ffmpeg 一帧一帧**量**（切点、冻结、
 * 运动、静音），全部是数字，零 token；再按骨架抽样铺成图版让我看；看的时候
 * 每张图都带着「这是第几秒」的映射。于是「我看见的」和「片子里的时间」能对上账。
 *
 * 所以这里的工具全部是**两步走**：
 *   video_probe  → 出数字（时间轴）
 *   video_sheet  → 出图（带位置映射）
 *   video_read   → 小字裁切放大（读字幕/水印/角标）
 * 我拿到图和数字之后自己在脑子里对上，而不是让它直接给我一段描述。
 *
 * ─────────────────────────────────────────────────────────────
 * 两条铁律（来自技能本身的实测记录，必须守住）
 * ─────────────────────────────────────────────────────────────
 * 一、**图版里的小字不能「读」，只能「裁下来放大读」**。
 *     实测过：16px 的时间码在图版里「看」出九个不同的值，放大后发现九格字面
 *     完全一样。所以需要读字的地方一律走 video_read，不许硬猜。
 *
 * 二、**互不重叠的时间窗里出现完全相同的话，一律判幻觉**。
 *     纯 BGM 的视频关掉 VAD 强制出字时，Whisper 对三个互不重叠的时间窗给出了
 *     完全相同的字幕，而模型自报「没有语音」的概率是 0.44~0.74。
 *     所以 ASR 的结果要么跟声学侦察对上，要么就别用。
 *
 * ─────────────────────────────────────────────────────────────
 * 为什么要把技能拷进 vendor/ 而不是直接调外面的
 * ─────────────────────────────────────────────────────────────
 * 技能装在 `~/.dsh/profiles/<profile>/skills/`，那是**我这台开发机**上的路径。
 * 主人把程序发出去、装到别人电脑上时，那个目录根本不存在。
 * 所以把 vw.py 和 vwtools.py 整个抄进 `vendor/video-watch/`，跟着程序走。
 *
 * 拷进来的两份是原样不动的（MIT 许可，见 vendor/video-watch/LICENSE），
 * 唯一多出来的是 `tools/magick.bat` + `tools/magick.cjs` 那个 ffmpeg 替身 ——
 * 因为主人这台机器没装 ImageMagick，而 vw.py 只用到它四类最基础的操作。
 * 替身的来历和四个坑写在 `vendor/video-watch/README-替身.md`。
 */

import { existsSync } from 'node:fs';
import { mkdir, stat, readFile, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, resolve, dirname, isAbsolute, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 资源根（程序自己的目录，打包后是 app.asar 里面） */
const APP_ROOT = dirname(HERE);
/** 工作区根（主人让我干活的地方） */
const ROOT = resolve(config.workspace);

/** 技能本体（跟着程序走的那份） */
const VW_DIR = join(APP_ROOT, 'vendor', 'video-watch');
const VW_PY = join(VW_DIR, 'vendor', 'vw.py');
const MAGICK_BAT = join(VW_DIR, 'tools', 'magick.bat');

/** 可接受的视频后缀。ffmpeg 能解的远不止这些，这里只列常见的。 */
const VIDEO_EXT = new Set([
  '.mp4', '.mov', '.mkv', '.avi', '.webm', '.flv', '.wmv', '.m4v',
  '.ts', '.mts', '.m2ts', '.mpg', '.mpeg', '.3gp', '.ogv', '.rmvb', '.rm', '.gif',
]);

/** 一个命令最多跑多久。量长片（探一小时的视频）确实慢，但总有上限。 */
const RUN_MAX_MS = 10 * 60 * 1000;

// ─────────────────────────── 找 python ───────────────────────────
/**
 * 找一个能用的 python。
 *
 * 为什么不能只写 `python`：这台机器 PATH 上的 `python` 是 Windows 应用商店的
 * 那个占位 stub，跑起来只会弹商店、返回 exit code 9009。必须按顺序试真身。
 */
function pythonCandidates() {
  const out = [];
  if (process.env.VW_PYTHON) out.push(process.env.VW_PYTHON);
  // 这台机器上实测可用的那个（Python 3.14.5 用户安装）
  const local = join(process.env.LOCALAPPDATA || '', 'Python', 'bin', 'python.exe');
  if (process.env.LOCALAPPDATA) out.push(local);
  out.push('python3', 'python', 'py');
  return out.filter(Boolean);
}

let _pythonOk = null;
/** 试出一个真的能跑起来的 python（只试一次，之后记住）。 */
async function findPython() {
  if (_pythonOk) return _pythonOk;
  for (const exe of pythonCandidates()) {
    const ok = await new Promise((done) => {
      execFile(exe, ['-c', 'import sys;print(sys.version_info[0])'], { timeout: 15000, windowsHide: true }, (err, stdout) => {
        done(!err && String(stdout).trim() === '3');
      });
    });
    if (ok) { _pythonOk = exe; return exe; }
  }
  return null;
}

// ─────────────────────────── 路径处理 ───────────────────────────
/** 主人给的路径可能是工作区相对路径，也可能是绝对路径。绝对路径原样用。 */
function mediaPath(p) {
  const s = String(p ?? '').trim().replace(/^["']|["']$/g, '');
  if (!s) return '';
  const abs = isAbsolute(s) ? s : resolve(ROOT, s);
  return abs;
}

/**
 * 每次干活开一个自己的目录，别互相踩。
 *
 * 技能默认写 `vw_out/` 这种相对当前目录的名字，两个会话同时对同一个视频
 * 开工就会互相覆盖。所以改成 `dump/video/<名字>-<时间戳>/`，一个活一个坑。
 */
function workDirFor(abs) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const name = basename(abs, extname(abs)).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40) || 'video';
  return join(ROOT, 'dump', 'video', `${name}-${stamp}`);
}

// ─────────────────────────── 跑 vw.py ───────────────────────────
/**
 * 跑一条 vw.py 子命令。
 *
 * 三件事必须在环境里设好，否则技能在自己的目录外跑不起来：
 *   VW_MAGICK  —— 指到 ffmpeg 替身（用的必须是 .bat，Python 的 subprocess 要能直接 exec）
 *   PYTHONUTF8 —— 不然中文输出在这台机器上直接乱码
 *   cwd        —— 技能的 vendor 目录，vw.py 里有些相对 import
 *
 * 退出码非 0 时把 stderr 原样带回去。**不吞错误、不返回猜测结果** ——
 * 这个技能整套方法论就是「不许编」，工具层先编就没意义了。
 */
function runVw(python, args, cwd) {
  return new Promise((done) => {
    const env = {
      ...process.env,
      VW_MAGICK: MAGICK_BAT,
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    };
    execFile(
      python,
      [VW_PY, ...args],
      { cwd: cwd || VW_DIR, timeout: RUN_MAX_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, env },
      (err, stdout, stderr) => {
        const out = String(stdout || '');
        const errText = String(stderr || '');
        if (err && (err.killed || err.signal)) {
          done({ ok: false, code: -1, out, err: errText, why: `跑了超过 ${Math.round(RUN_MAX_MS / 60000)} 分钟没结束，我掐了。视频是不是特别长？` });
          return;
        }
        done({ ok: !err, code: err ? (err.code ?? 1) : 0, out, err: errText });
      },
    );
  });
}

/** 技能在不在（打包时容易漏，漏了要老实说，别假装看过） */
function skillReady() {
  if (!existsSync(VW_PY)) {
    return `看视频的本体没找到（应该在 ${VW_PY}）。这是打包时漏了 vendor/video-watch 目录，不是视频的问题。`;
  }
  return '';
}

/** 视频文件在不在、是不是视频 */
async function checkMedia(abs) {
  if (!abs) return '没给视频路径。';
  try {
    const st = await stat(abs);
    if (!st.isFile()) return `不是文件：${abs}`;
    if (st.size === 0) return `这个文件是空的（0 字节）：${abs}`;
  } catch {
    return `找不到这个文件：${abs}（工作区是 ${ROOT}，相对路径按它算）`;
  }
  const ext = extname(abs).toLowerCase();
  if (!VIDEO_EXT.has(ext)) {
    return `这个后缀（${ext}）不像视频。能看的：${[...VIDEO_EXT].join(' ')}`;
  }
  return '';
}

// ─────────────────────────── 输出整理 ───────────────────────────
/**
 * 把 timeline.json 压成几行人能读的话。
 *
 * 原始文件几十 KB，全塞回上下文是浪费 —— 我要的是「哪一秒切了、哪里冻住、
 * 哪里没人说话」这几件事，其余细节留在文件里，需要时我自己去读。
 */
function summarizeTimeline(tl) {
  const s = (v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v);
  const lines = [];
  const info = tl.info || {};
  if (tl.duration) lines.push(`时长：${s(tl.duration)} 秒`);
  if (info.width && info.height) lines.push(`画面：${info.width}×${info.height}`);
  if (info.fps) lines.push(`帧率：${s(info.fps)}`);
  if (tl.content_kind) lines.push(`内容判型：${tl.content_kind}`);

  const cuts = Array.isArray(tl.cuts) ? tl.cuts : [];
  lines.push(cuts.length ? `切点（硬切/转场）：${cuts.map(s).join('、')} 秒，共 ${cuts.length} 处` : '切点：没检测到硬切（可能是单镜头）');

  const freezes = Array.isArray(tl.freezes) ? tl.freezes : [];
  lines.push(freezes.length ? `画面冻住的位置：${freezes.map(s).join('、')} 秒` : '画面冻住：没有');

  /**
   * 静音事件在 timeline 里的真实形状是 [{kind:'start'|'end', t:秒}]，
   * 不是 {start,end} 那种成对的区间 —— 一开始按区间写，界面上就出来一串 [object Object]。
   * 这里按事件流还原成区间：遇到 start 记下起点，遇到 end 收一段；没配上的落单也照实说。
   */
  const sil = Array.isArray(tl.silences) ? tl.silences : [];
  if (sil.length) {
    const spans = [];
    let open = null;
    for (const x of sil) {
      if (typeof x === 'number') { spans.push({ from: x, to: null }); continue; }
      if (!x || typeof x !== 'object') continue;
      if (x.kind === 'start' || (x.start !== undefined && x.end === undefined)) {
        open = typeof x.t === 'number' ? x.t : x.start;
      } else if (x.kind === 'end' || (x.start === undefined && x.end !== undefined)) {
        const to = typeof x.t === 'number' ? x.t : x.end;
        if (open !== null) { spans.push({ from: open, to }); open = null; }
        else spans.push({ from: null, to });
      }
    }
    if (open !== null) spans.push({ from: open, to: null });
    const parts = spans.map((p) => {
      if (p.from !== null && p.to !== null) return `${s(p.from)}~${s(p.to)}秒`;
      if (p.from !== null) return `从 ${s(p.from)}秒 起（到片尾）`;
      return `到 ${s(p.to)}秒 止`;
    });
    lines.push(`没人说话的段：${parts.join('、')}（共 ${spans.length} 段）`);
  } else {
    lines.push('没人说话的段：没检测到（要么一直在说，要么没音轨）');
  }

  if (typeof tl.motion_p95 === 'number') lines.push(`运动量（95 分位）：${s(tl.motion_p95)}`);
  if (typeof tl.active_ratio === 'number') lines.push(`有动作的时间占比：${(tl.active_ratio * 100).toFixed(1)}%`);
  if (Array.isArray(tl.advice) && tl.advice.length) lines.push(`建议怎么看：${tl.advice.join('；')}`);
  return lines.join('\n');
}

/** 从 sheet 的 manifest 里抠几行关键信息 */
async function summarizeSheet(sheetDir) {
  const mp = join(sheetDir, 'manifest.json');
  if (!existsSync(mp)) return '（没有 manifest.json，图版可能没生成成功）';
  try {
    const m = JSON.parse(await readFile(mp, 'utf8'));
    const files = await readdir(sheetDir).catch(() => []);
    const pngs = files.filter((f) => f.toLowerCase().endsWith('.png')).sort();
    const lines = [];
    lines.push(`图版 ${pngs.length} 张：${pngs.join('、')}`);
    const tiles = Array.isArray(m.tiles) ? m.tiles : Array.isArray(m.items) ? m.items : [];
    if (tiles.length) {
      const times = tiles.map((t) => (typeof t.t === 'number' ? t.t : null)).filter((x) => x !== null);
      if (times.length) {
        lines.push(`覆盖时间：${Math.min(...times).toFixed(2)} ~ ${Math.max(...times).toFixed(2)} 秒，共 ${tiles.length} 格`);
      }
      // 每格是第几秒 —— 这是「看见的」跟「片子里的时间」对账的唯一凭据
      const brief = tiles.slice(0, 40).map((t, i) => {
        const idx = t.index ?? t.idx ?? i;
        const tt = typeof t.t === 'number' ? t.t.toFixed(2) + 's' : '?';
        return `第 ${idx} 格 = ${tt}`;
      });
      lines.push('位置映射：' + brief.join('，') + (tiles.length > 40 ? ` ……（还有 ${tiles.length - 40} 格，见 manifest.json）` : ''));
    }
    return lines.join('\n');
  } catch (e) {
    return `（manifest.json 读不动：${String(e?.message ?? e)}）`;
  }
}

// ─────────────────────────── 工具 ───────────────────────────
/**
 * 让工具的结果能带上图片。
 *
 * 【为什么必须有】
 * 之前 video_read 只把「面板的**路径**」当文字返回，模型拿到一串路径根本看不见图 ——
 * 她想去开，就调 read_file，可 read_file 读的是文本，PNG 进去只能得到乱码，
 * 于是她如实说「一片毛玻璃似的糊，不敢瞎猜」。她没撒谎，是真的什么都没看见。
 * 同一张图我自己用 read_image 看，时间码清清楚楚。
 *
 * 这跟「小字必须放大再读」是同一条原则的两半：
 *   光把图切好不够，得真的递到眼睛前面。
 *
 * 返回 { text, images } 的形状由 agent.mjs 认（那边会拼成多模态 content）；
 * 没有 images 字段时行为跟以前完全一样，所以别的工具不受影响。
 */
function withImages(text, images) {
  const list = (Array.isArray(images) ? images : []).filter((p) => typeof p === 'string' && p && existsSync(p));
  if (!list.length) return text;
  return { text, images: list };
}

export const videoTools = [
  {
    name: 'video_probe',
    description:
      '先「量」一遍视频，不花 token 也不靠猜：算出多长、哪里硬切/转场、哪里画面冻住、哪几段没人说话、运动量多大，以及这片子大概是什么类型（影视/演示/短视频/监控）。'
      + '\n\n这是看视频的**第一步**，必须走它。它给我的全是数字，后面铺图版时按这些数字挑关键处看，才不至于平均到 3 秒一帧什么都没看清。'
      + '\n\n量长片可能要几十秒。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '视频文件路径（工作区相对路径或绝对路径都行）' },
        noAudio: { type: 'boolean', description: '不查音频（片子没声音或者只看画面时用，能快一点）' },
      },
      required: ['path'],
    },
    async run({ path, noAudio }) {
      const bad = skillReady();
      if (bad) return bad;
      const abs = mediaPath(path);
      const bad2 = await checkMedia(abs);
      if (bad2) return bad2;
      const py = await findPython();
      if (!py) return '找不到 python。这台机器得先装个 Python 3 我才能量视频。';

      const outDir = workDirFor(abs);
      await mkdir(outDir, { recursive: true });
      // vw.py 的 --out 要的是**目录**（timeline.json 由它自己写进这个目录）。
      // 传成文件路径它会照着建一个叫 timeline.json 的目录，然后在里面再写 timeline.json。
      const args = ['probe', abs, '--out', outDir];
      const timeline = join(outDir, 'timeline.json');
      if (noAudio) args.push('--no-audio');
      const r = await runVw(py, args);
      if (!r.ok) {
        return `量不了这个视频。\n\n命令：vw probe\n退出码 ${r.code}\n${r.err || r.out || r.why || '（没有错误输出）'}`.trim();
      }
      if (!existsSync(timeline)) {
        return `跑完了但没出 timeline.json，不装懂。\n\n${r.out || ''}\n${r.err || ''}`.trim();
      }
      let tl = null;
      try {
        tl = JSON.parse(await readFile(timeline, 'utf8'));
      } catch (e) {
        return `timeline.json 生成了但读不动：${String(e?.message ?? e)}`;
      }
      return [
        `量完了：${basename(abs)}`,
        '',
        summarizeTimeline(tl),
        '',
        `时间轴落在：${timeline}`,
        '',
        '下一步用 video_sheet（把关键处铺成图给我看）—— 记得带上这个 path 和 timelinePath，铺的时候会照着切点挑帧。',
      ].join('\n');
    },
  },

  {
    name: 'video_sheet',
    description:
      '把视频铺成图版（联络表）：若干张 3×3 / 5×5 的拼图，每格一帧，配一份「第几格是第几秒」的映射清单。'
      + '\n\n这是「看见」的主通道。返回的图片路径你可以直接发给主人看，也可以自己接着用 video_read 读小字。'
      + '\n\n【关键】每格的时间**不要从图上看**——图里的小字会读错（实测 16px 时间码读出九个不同值，放大后九格字面完全一样）。时间一律以映射清单为准。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '视频文件路径' },
        from: { type: 'number', description: '从第几秒开始铺（不填从头）' },
        to: { type: 'number', description: '铺到第几秒（不填到片尾）' },
        frames: { type: 'number', description: '一共铺几帧，默认按技能自己的骨架抽样' },
        cols: { type: 'number', description: '一行几格（3 / 5 / 6），不填按技能默认' },
      },
      required: ['path'],
    },
    async run({ path, from, to, frames, cols }) {
      const bad = skillReady();
      if (bad) return bad;
      const abs = mediaPath(path);
      const bad2 = await checkMedia(abs);
      if (bad2) return bad2;
      const py = await findPython();
      if (!py) return '找不到 python。';

      const outDir = workDirFor(abs);
      await mkdir(outDir, { recursive: true });

      // 先量一遍拿到切点（如果调用方没给时间范围，就靠切点挑关键帧）
      const timeline = join(outDir, 'timeline.json');
      if (!existsSync(timeline)) {
        const rp = await runVw(py, ['probe', abs, '--out', outDir]);
        if (!rp.ok) return `铺图之前得先量一遍，但量失败了：\n${rp.err || rp.out || rp.why}`.trim();
      }
      const shotlist = join(outDir, 'shotlist.json');
      const rplan = await runVw(py, ['plan', timeline]);
      if (!rplan.ok) return `抽样计划没算出来：\n${rplan.err || rplan.out || rplan.why}`.trim();
      // plan 默认把 shotlist 写在 timeline 旁边；确认一下
      if (!existsSync(shotlist)) {
        const alt = join(VW_DIR, 'vw_out', 'shotlist.json');
        if (existsSync(alt)) {
          // 技能默认写到当前目录，这里统一挪到我自己的工作目录
          try {
            const { copyFileSync } = await import('node:fs');
            copyFileSync(alt, shotlist);
          } catch { /* 下面会老实报错 */ }
        }
      }
      if (!existsSync(shotlist)) {
        return `抽样计划跑完但没找到 shotlist.json，不装懂。\n\n${rplan.out || ''}\n${rplan.err || ''}`.trim();
      }

      const sheetDir = join(outDir, 'sheets');
      await mkdir(sheetDir, { recursive: true });
      const args = ['sheet', shotlist, abs, '--out', sheetDir];
      // 时间范围/帧数/列数：技能支持就直接透传，不支持就靠它自己的骨架抽样
      const extra = [];
      if (typeof from === 'number') extra.push('--t0', String(from));
      if (typeof to === 'number') extra.push('--t1', String(to));
      if (typeof frames === 'number') extra.push('--frames', String(frames));
      if (typeof cols === 'number') extra.push('--cols', String(cols));
      if (extra.length) args.push(...extra);

      let r = await runVw(py, args);
      if (!r.ok && extra.length) {
        // 技能这个子命令可能不认这些参数 → 退回纯骨架抽样，别让调用白跑一趟
        r = await runVw(py, ['sheet', shotlist, abs, '--out', sheetDir]);
        if (r.ok) r.out += '\n（你给的范围/帧数这个技能不认，已经按它自己的骨架抽样铺好了）';
      }
      if (!r.ok) return `铺图版失败：\n${r.err || r.out || r.why}`.trim();

      const summary = await summarizeSheet(sheetDir);
      const files = await readdir(sheetDir).catch(() => []);
      const pngs = files.filter((f) => f.toLowerCase().endsWith('.png')).sort().map((f) => join(sheetDir, f));
      if (!pngs.length) return `跑完了但一张图都没生成，不装懂。\n\n${r.out || ''}\n${r.err || ''}`.trim();

      /**
       * 图版也直接递过去。只给路径的话她看不见图，所谓「看见的主通道」就断了 ——
       * 她会去 read_file 读 PNG，读成乱码，然后说「我看不到图」。
       * 图版本来就设计成「一次看个大概」，几张全给出去正合适。
       */
      const text = [
        `铺好了：${basename(abs)}`,
        '',
        summary,
        '',
        pngs.length ? `图版就在下面（${pngs.length} 张，每格对应的秒数见上面的位置映射）。` : '',
        '',
        '图在这里（也可以直接发给主人看）：',
        ...pngs.map((p) => '  ' + p),
        '',
        `映射清单：${join(sheetDir, 'manifest.json')}`,
        '要读图里的字（字幕、水印、角标、时间码），别硬看 —— 用 video_read 把那一块裁下来放大。',
      ].filter(Boolean).join('\n');
      return withImages(text, pngs);
    },
  },

  {
    name: 'video_read',
    description:
      '把视频某一段切成小块、裁开放大，专门用来**读小字**：字幕、水印、角标、界面上的文字、时间码。'
      + '\n\n为什么不能直接看图版：实测过 16px 的时间码在图版里「看」出九个不同值，放大后发现九格字面完全一样。小字必须裁下来放大读，不许硬猜。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '视频文件路径' },
        from: { type: 'number', description: '从第几秒开始' },
        to: { type: 'number', description: '到第几秒（不填就到片尾，别偷懒给太长，会切出一堆图）' },
        shotlistPath: { type: 'string', description: '不填会自动用最近一次 video_sheet 的清单' },
        times: { type: 'string', description: '直接点名要读哪几个时刻，逗号分隔，如 "2.33,5.1"。要读某一格的字就用这个 —— 比给 from/to 更准，出的面板也少、好找' },
        region: { type: 'string', description: '只切画面里的一块，写 "x,y,w,h"（像素）。读角落的时间码/角标、读字幕条就用它，别整帧均分碰运气' },
        zoom: { type: 'number', description: '放大倍数，默认 2。字特别小就上 3 或 4' },
      },
      required: ['path'],
    },
    async run({ path, from, to, times, region, zoom, shotlistPath }) {
      const bad = skillReady();
      if (bad) return bad;
      const abs = mediaPath(path);
      const bad2 = await checkMedia(abs);
      if (bad2) return bad2;
      const py = await findPython();
      if (!py) return '找不到 python。';

      // 找 shotlist：显式给的 > 这个视频最近一次铺图留下的
      let shot = shotlistPath ? mediaPath(shotlistPath) : '';
      if (!shot || !existsSync(shot)) {
        const base = join(ROOT, 'dump', 'video');
        if (existsSync(base)) {
          const dirs = (await readdir(base).catch(() => []))
            .filter((d) => d.startsWith(basename(abs, extname(abs)).replace(/[^\w\u4e00-\u9fff-]+/g, '_').slice(0, 40)))
            .sort();
          for (const d of dirs.reverse()) {
            const cand = join(base, d, 'shotlist.json');
            if (existsSync(cand)) { shot = cand; break; }
          }
        }
      }
      if (!shot) {
        return '还没铺过图版，找不到抽样清单。先调 video_sheet（同一段范围），再来读字。';
      }

      const outDir = workDirFor(abs);
      await mkdir(outDir, { recursive: true });
      const readDir = join(outDir, 'read');
      const args = ['read', '--media', abs, '--shotlist', shot, '--out', readDir];
      /**
       * --times 是点名要哪几个时刻；vw.py 原生支持，之前没往外暴露。
       * 为什么重要：默认走 shotlist 的全部采样点，一次能切几十张，模型拿到「前 24 张」
       * 的路径列表根本不知道该看哪一张 —— 让她读 2.33 秒的字，她可能翻到 0.05 秒那张
       * 然后如实说「一片纯色读不出」。这不是她笨，是没给准头。
       */
      const timesArg = typeof times === 'string' ? times.trim() : '';
      if (timesArg) args.push('--times', timesArg);
      /**
       * --region 只切画面里的一块。角落的时间码只有十几个像素宽，
       * 按整帧均分去切等于碰运气；点名区域才有足够的放大倍数。
       */
      const regionArg = typeof region === 'string' ? region.trim() : '';
      if (regionArg) args.push('--region', regionArg);
      if (typeof zoom === 'number' && zoom > 0) args.push('--zoom', String(zoom));
      if (typeof from === 'number') args.push('--t0', String(from));
      if (typeof to === 'number') args.push('--t1', String(to));
      let r = await runVw(py, args);
      if (!r.ok && (typeof from === 'number' || typeof to === 'number' || timesArg || regionArg)) {
        // 退一步：去掉可选参数再来一次，至少给回东西（但要说清是退回了默认）
        r = await runVw(py, ['read', '--media', abs, '--shotlist', shot, '--out', readDir]);
        if (r.ok) r.out = (r.out || '') + '\n（注：--times/--region/--zoom 这次没被接受，退回了默认整帧均分）';
      }
      if (!r.ok) return `切面板失败：\n${r.err || r.out || r.why}`.trim();

      const files = (await readdir(readDir).catch(() => [])).filter((f) => f.toLowerCase().endsWith('.png')).sort();
      if (!files.length) {
        const hint = /跳过空白\s*[1-9]/.test(r.out || '')
          ? '\n\n（看着像是被当成空白跳过了：region 开得太小、字只占一点点面积时，纯色底会把标准差压到阈值以下。把 region 放大一圈再试，比如 \"0,0,300,60\"；或者干脆不填 region 让它按整帧均分。）'
          : '';
        return `跑完了但没切出面板，不装懂。\n\n${r.out}\n${r.err}${hint}`.trim();
      }
      // 面板动辄几十张，一次别全塞回去
      const shown = files.slice(0, 24).map((f) => join(readDir, f));
      const skipLine = /跳过空白\s*[1-9]/.test(r.out || '') ? ('（有 ' + String((r.out.match(/跳过空白\s*(\d+)/) || [])[1] || '?') + ' 块因为太像纯色被跳过了，那些位置大概率确实没内容。）') : '';
      /**
       * 面板图直接递过去，别只给路径。
       * 只给路径的时候她会去调 read_file，PNG 读成乱码，然后如实说「一片糊」。
       * 上限 6 张：图很吃 token，一次几十张会把这轮预算吃干净。
       * 多出来的照旧在文字里列路径，她需要哪张可以再点名读一次。
       */
      const MAX_IMG = 6;
      const attach = files.slice(0, MAX_IMG).map((f) => join(readDir, f));
      const text = [
        `切好了 ${files.length} 张面板（每张是一块放大后的区域）。`,
        skipLine,
        attach.length ? `其中前 ${attach.length} 张直接给你看了（就是下面这几张图）。` : '',
        '',
        '全部在这：',
        ...shown.map((p) => '  ' + p),
        files.length > shown.length ? `\n还有 ${files.length - shown.length} 张在 ${readDir}` : '',
        '',
        '读的时候记住：图上看见的字直接抄，看不清就说看不清，别拿上下文猜。',
        /**
         * 这条提醒是实测撞出来的：她读到画面上烧着的「00:00:01.500」，
         * 以为跟我要她读的 4.5 秒对不上，专门回了一句「时间码对不太上哦」。
         * 其实画面里那些数字是**素材自己烧上去的**，跟着片子走，不是我们切的时刻 ——
         * 我们 -ss 4.5 取的就是 4.5 秒那一帧，两者本来就该各说各的。
         * 不写清楚的话，模型每读一次时间码就要多解释一轮，还容易自己怀疑切错了。
         */
        '（提醒一句：画面里印的时间码/帧号是**原片自己烧上去的**，它不等于我让你读的那个时刻。',
        '  两者对不上是正常的，别以为自己读错或者切错了，按实际看见的报就行。）',
      ].filter(Boolean).join('\n');
      return withImages(text, attach);
    },
  },

  {
    name: 'video_doctor',
    description: '检查「看视频」这套东西还能不能用：python、ffmpeg、替身 magick 各在不在，哪些子命令可用。哪天看视频报错了先跑这个。',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      const bad = skillReady();
      if (bad) return bad;
      const py = await findPython();
      if (!py) return '找不到 python —— 这是根子问题，先装 Python 3。';
      const r = await runVw(py, ['doctor']);
      return [
        `python：${py}`,
        '',
        (r.out || r.err || '（没有输出）').trim(),
      ].join('\n');
    },
  },
];
