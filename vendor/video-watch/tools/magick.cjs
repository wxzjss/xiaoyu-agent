#!/usr/bin/env node
/**
 * magick.cjs —— 给 video-watch-plus 用的 ImageMagick 替身，内部转调 ffmpeg
 *
 * 为什么需要它：
 *   上游 vw.py 用 ImageMagick 做四件事：差异对比、竖向拼接、拼网格、取标准差。
 *   这台机器上没有 ImageMagick，而它的 Windows 包在 github release 上
 *   (objects.githubusercontent.com) 下不动；imagemagick.org 的镜像也不通。
 *   但这四件事 ffmpeg 全都能做，而且 ffmpeg 本机已有（9.0.2-full）。
 *
 *   所以不装 ImageMagick，写一个同名壳子，用 VW_MAGICK 指过来，
 *   vw.py 一个字节都不用改。
 *
 * 支持的调用（只覆盖 vw.py 里实际出现的那 8 处，别的一概不做）：
 *   convert A B -compose difference -composite OUT
 *   convert A B C ... -append OUT
 *   montage A B C ... -tile CxR -geometry +G+G -background #rgb OUT
 *   identify -format %[fx:standard_deviation] FILE
 *
 * 故意不做的：不做通用 ImageMagick 兼容。碰到没见过的写法就报错退出，
 * 免得悄悄返回一个错的结果 —— 这个技能整套方法论就是「不许编」，
 * 替身自己先编就说不过去了。
 */
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// ffmpeg 来源优先级：环境变量 > 技能自带 tools/ > PATH
function findFfmpeg() {
  const cands = [];
  if (process.env.VW_FFMPEG) cands.push(process.env.VW_FFMPEG);
  cands.push(path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg.exe'));
  cands.push(path.join(__dirname, 'ffmpeg', 'bin', 'ffmpeg'));
  for (const c of cands) if (fs.existsSync(c)) return c;
  return 'ffmpeg'; // 落到 PATH
}
function findFfprobe() {
  const ff = findFfmpeg();
  if (path.isAbsolute(ff)) {
    const p = ff.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1');
    if (fs.existsSync(p)) return p;
  }
  if (process.env.VW_FFPROBE) return process.env.VW_FFPROBE;
  return 'ffprobe';
}

const FF = findFfmpeg();
const FP = findFfprobe();

function die(msg) {
  process.stderr.write('[magick-shim] ' + msg + '\n');
  process.exit(2);
}

function ff(args, opts = {}) {
  // ffmpeg 9 的 image2 muxer 要求：写单张图片必须显式 -update 1，
  // 否则报 "does not contain an image sequence pattern"（旧版不用，新版才报）。
  const a = args.includes('-frames:v') && !args.includes('-update')
    ? [...args.slice(0, -1), '-update', '1', args[args.length - 1]]
    : args;
  const r = spawnSync(FF, ['-hide_banner', '-loglevel', 'error', ...a], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (r.status !== 0) {
    const tail = (r.stderr || '').trim().split('\n').slice(-3).join(' | ');
    die('ffmpeg 失败（' + a.join(' ').slice(0, 120) + '）：' + tail);
  }
  return r;
}

/** 读图片尺寸，返回 {w, h} */
function dims(file) {
  const r = spawnSync(FP, [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file,
  ], { encoding: 'utf8' });
  const m = (r.stdout || '').trim().match(/^(\d+),(\d+)$/);
  if (!m) die('读不出尺寸：' + file);
  return { w: Number(m[1]), h: Number(m[2]) };
}

/** 解析 "#111" / "#111111" / "black" 之类的背景色成 ffmpeg 认的写法 */
function normColor(s) {
  if (!s) return '0x111111';
  s = String(s).trim();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    return '0x' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3];
  }
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return '0x' + s.slice(1);
  return s; // 交给 ffmpeg 自己认命名色
}

// ---------------------------------------------------------------- convert
function doConvert(args) {
  const out = args[args.length - 1];
  const body = args.slice(0, -1);

  // 形式一：convert A B -compose difference -composite OUT
  if (body.includes('-compose') && body.includes('-composite')) {
    const inputs = body.filter((a) => !a.startsWith('-') && a !== 'difference');
    if (inputs.length !== 2) die('difference 只支持两张图，收到 ' + inputs.length);
    // 先把两张图都 scale 到第一张的尺寸 —— blend 要求上下两路尺寸一致，
    // 上游传的虽然通常同尺寸，但替身不该替调用方赌这一点。
    const d0 = dims(inputs[0]);
    ff([
      '-i', inputs[0], '-i', inputs[1],
      '-filter_complex',
      '[0:v]format=rgb24,scale=' + d0.w + ':' + d0.h + ':flags=neighbor[x];' +
      '[1:v]format=rgb24,scale=' + d0.w + ':' + d0.h + ':flags=neighbor[y];' +
      '[x][y]blend=all_mode=difference',
      '-frames:v', '1', '-y', out,
    ]);
    return;
  }

  // 形式二：convert A B C ... -append OUT —— 竖向拼接
  if (body.includes('-append')) {
    const inputs = body.filter((a) => !a.startsWith('-'));
    if (inputs.length < 1) die('append 没有输入');
    if (inputs.length === 1) {
      fs.copyFileSync(inputs[0], out);
      return;
    }
    // 宽度对齐到第一张（-append 语义是保持各自尺寸竖排，
    // 但 ffmpeg 的 vstack 要求同宽 —— 上游 cropped 图都是同尺寸裁切，
    // 所以这里 scale 到第一张的宽度，避免 vstack 直接报错）
    const w0 = dims(inputs[0]).w;
    const parts = [];
    for (let i = 0; i < inputs.length; i++) parts.push('[' + i + ':v]scale=' + w0 + ':-2[v' + i + ']');
    const stackIn = inputs.map((_, i) => '[v' + i + ']').join('');
    const fc = parts.join(';') + ';' + stackIn + 'vstack=inputs=' + inputs.length;
    const argv = [];
    for (const f of inputs) argv.push('-i', f);
    ff([...argv, '-filter_complex', fc, '-frames:v', '1', '-y', out]);
    return;
  }

  die('不认识的 convert 用法：' + args.join(' '));
}

// ---------------------------------------------------------------- montage
function doMontage(args) {
  const out = args[args.length - 1];
  const body = args.slice(0, -1);
  const files = [];
  let tile = null;      // "CxR"
  let geometry = '+2+2';
  let background = '#111';

  for (let i = 0; i < body.length; i++) {
    const a = body[i];
    if (a === '-tile') { tile = body[++i]; }
    else if (a === '-geometry') { geometry = body[++i]; }
    else if (a === '-background') { background = body[++i]; }
    else if (!a.startsWith('-')) files.push(a);
  }
  if (!files.length) die('montage 没有输入图');
  if (!tile) die('montage 缺少 -tile');

  // 只有一张输入的退化情形：xstack 要求至少 2 路，直接复制过去。
  // （vw.py 的 read 子命令在只有一帧时就会走到这里）
  if (files.length === 1) {
    const gm1 = String(geometry || '+2+2').match(/^\+(\d+)\+(\d+)$/);
    const pad1 = gm1 ? Number(gm1[1]) : 2;
    if (pad1 === 0) {
      fs.copyFileSync(files[0], out);
      return;
    }
    const d1 = dims(files[0]);
    ff(['-i', files[0], '-vf',
      'pad=' + (d1.w + pad1 * 2) + ':' + (d1.h + pad1 * 2) + ':' + pad1 + ':' + pad1 + ':' + normColor(background),
      '-frames:v', '1', '-y', out]);
    return;
  }

  const mm = String(tile).match(/^(\d+)x(\d*)$/);
  if (!mm) die('看不懂的 -tile：' + tile);
  const cols = Number(mm[1]);
  // 行数留空（如 "1x"）时按图片数自动算
  const rows = mm[2] ? Number(mm[2]) : Math.ceil(files.length / cols);

  const gm = String(geometry).match(/^\+(\d+)\+(\d+)$/);
  const pad = gm ? Number(gm[1]) : 2;
  const bg = normColor(background);

  // 每格统一到同一尺寸（取第一张），加 pad 边距，然后铺成 cols x rows
  const d0 = dims(files[0]);
  const cellW = d0.w + pad * 2;
  const cellH = d0.h + pad * 2;

  const parts = [];
  const pads = [];
  for (let i = 0; i < files.length; i++) {
    parts.push(
      '[' + i + ':v]scale=' + d0.w + ':' + d0.h + ':force_original_aspect_ratio=decrease,' +
      'pad=' + cellW + ':' + cellH + ':' + pad + ':' + pad + ':' + bg + '[c' + i + ']'
    );
    pads.push('[c' + i + ']');
  }

  // 空位用纯背景色补齐到 cols*rows
  const total = cols * rows;
  for (let i = files.length; i < total; i++) {
    parts.push('color=c=' + bg + ':s=' + cellW + 'x' + cellH + ':d=1[c' + i + ']');
    pads.push('[c' + i + ']');
  }
  const layoutTags = pads.join('');
  // xstack 的 layout 语法：每格 "X_Y"，X/Y 是表达式。
  // 实测：w0/h0 只在单独出现时表示第 0 路输入的宽/高；
  // 写成 "w0*2_0" 这类乘式不会报错，但结果不对（拼出 508x288 而不是 762x432）。
  // 所以这里直接用绝对像素 —— cell 尺寸本来就是我们自己算的，没必要绕表达式。
  const layout = Array.from({ length: total }, (_, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    return (col * cellW) + '_' + (row * cellH);
  }).join('|');
  parts.push(layoutTags + 'xstack=inputs=' + total + ':layout=' + layout + ',format=rgb24');

  const argv = [];
  for (const f of files) argv.push('-i', f);
  ff([...argv, '-filter_complex', parts.join(';'), '-frames:v', '1', '-y', out]);
}

// ---------------------------------------------------------------- identify
function doIdentify(args) {
  // 只支持 vw.py 用到的那一种：identify -format %[fx:standard_deviation] FILE
  const fmtIdx = args.indexOf('-format');
  if (fmtIdx < 0) die('identify 只支持 -format');
  const fmt = args[fmtIdx + 1];
  const file = args[args.length - 1];
  if (!/standard_deviation/.test(fmt || '')) {
    die('identify 只支持 %[fx:standard_deviation]，收到：' + fmt);
  }
  const sd = stddev(file);
  if (sd === null) die('算不出标准差：' + file);
  process.stdout.write(String(sd));
}

/**
 * 归一化标准差（0~1），对齐 ImageMagick 的 %[fx:standard_deviation]。
 *
 * 做法：Y = 灰度。E[Y] 由 signalstats 的 YAVG 给；
 * E[Y^2] 用 geq 把每像素换成 Y*Y/255（除以 255 防溢出），再取 YAVG 乘回 255。
 * sd = sqrt(E[Y^2] - E[Y]^2)，最后 /255 归一化。
 *
 * 实测对照：纯灰 sd=0；半黑半白 sd=127.5（归一化 0.5 正好是理论值）。
 */
function stddev(file) {
  const avgWith = (vfExtra) => {
    const vf = (vfExtra ? vfExtra + ',' : '') + 'signalstats,metadata=print:key=lavfi.signalstats.YAVG';
    const r = spawnSync(FF, ['-hide_banner', '-i', file, '-vf', vf, '-f', 'null', '-'], { encoding: 'utf8' });
    const m = (r.stderr || '').match(/YAVG=([0-9.]+)/);
    return m ? Number(m[1]) : null;
  };
  const e1 = avgWith('format=gray');
  const e2 = avgWith("format=gray,geq=lum='lum(X,Y)*lum(X,Y)/255'");
  if (e1 === null || e2 === null) return null;
  const meanSq = e2 * 255;
  const variance = meanSq - e1 * e1;
  return Math.sqrt(Math.max(0, variance)) / 255;
}

// ---------------------------------------------------------------- main
const argv = process.argv.slice(2);

/**
 * 自报身份：vw.py 的 find_magick() 会跑 `magick -version` 找 "ImageMagick N"。
 * 必须放在子命令分派之前 —— 否则 "-version" 会被当成不支持的子命令而退出。
 */
if (!argv.length || argv[0] === '-version' || argv[0] === '--version' || argv[0] === 'version') {
  if (!argv.length) die('用法：magick <convert|montage|identify> ...');
  process.stdout.write(
    'Version: ImageMagick 7.1.2-34-portable-shim (ffmpeg backend)\n' +
    'Note: magick.cjs 是 ffmpeg 替身，只实现 video-watch-plus 用到的四类操作。\n'
  );
  process.exit(0);
}

const sub = argv[0];
const rest = argv.slice(1);

// IM7 原生写法：裸入口（无子命令）等价于 convert
// vw.py 在上游补丁里会这么调，这里一并接住
if (sub === 'convert') doConvert(rest);
else if (sub === 'montage') doMontage(rest);
else if (sub === 'identify') doIdentify(rest);
else if (!sub.startsWith('-')) doConvert(argv);
else die('不支持的子命令：' + sub);
