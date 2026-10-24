// 视频背景：从 DSH 插件 dsh-video-skin 移植过来的那套「聊天背景」。
// 开关在【功能】面板（features.json 的 videoBg，默认开），这里只存那几个旋钮。
//
// 素材：默认用项目里的 assets/background.mp4（无声、faststart），
// 也可以在 settings.file 里写一个自己的 mp4 绝对路径，指哪放哪。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve } from 'node:path';
import { config } from './config.mjs';
import { getEnabledMap } from './features.mjs';

const STATE = join(config.dataDir, '.state');
const FILE = join(STATE, 'skin.json');

/**
 * 内置素材的位置。
 *
 * 开发时就是项目里的 assets/background.mp4。
 * 打包后 **不能** 用 config.root：免安装版会把 asarUnpack 出来的资源解到
 * %TEMP% 下的随机目录，启动器随后删掉它，于是 <video> 一读就 ENOENT
 * （实测报错 Uncaught Exception: ENOENT ... background.mp4）。
 * 所以打包后改用数据目录里的副本：exe 旁边 / %APPDATA% 里那份，只读不删。
 */
export const BUNDLED_VIDEO = config.packaged
  ? join(config.dataDir, 'assets', 'background.mp4')
  : join(config.root, 'assets', 'background.mp4');

/**
 * 复制来源：直接在 app.asar 里读。
 *
 * 为什么不走 asarUnpack：免安装版（portable）启动时把整个包解到 %TEMP% 随机目录，
 * 实测解出来的 app.asar.unpacked/assets/ 是**空**的，<video> 一读就
 * ENOENT ... background.mp4（还因为 createReadStream 没挂 error 事件，
 * 直接抛成主进程未捕获异常弹窗）。
 * 留在 asar 里反而稳：Electron 给主进程 fs 打了 asar 补丁，readFileSync 能整份读出来。
 */
export const SOURCE_VIDEO = join(config.root, 'assets', 'background.mp4');

/**
 * 内置背景音乐的位置，规则跟视频一模一样：
 * 开发时是项目的 assets/bg-music.m4a；打包后用数据目录下那份副本。
 */
export const SOURCE_MUSIC = join(config.root, 'assets', 'bg-music.m4a');
export const BUNDLED_MUSIC = config.packaged
  ? join(config.dataDir, 'assets', 'bg-music.m4a')
  : join(config.root, 'assets', 'bg-music.m4a');

/** 主人自己导入的音乐放这儿，别污染 assets */
export const MUSIC_DIR = join(STATE, 'bg-music');

/**
 * 首启把内置短片复制到数据目录；已经有一份就不再动。
 * 复制失败不算错——真没有就退回没背景。
 */
export function ensureBundledVideo() {
  if (!config.packaged) return;
  try {
    if (existsSync(BUNDLED_VIDEO) && statSync(BUNDLED_VIDEO).size > 0) return;
  } catch {}
  try {
    if (!existsSync(SOURCE_VIDEO)) return;
    const dir = join(config.dataDir, 'assets');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // 整份读写，绕开 asar 里 createReadStream 的兼容问题
    writeFileSync(BUNDLED_VIDEO, readFileSync(SOURCE_VIDEO));
  } catch (e) {
    console.warn('[skin] 内置视频复制失败：' + (e && e.message));
  }
}

/** 旋钮默认值。surface = 面板不透明度（0 最透、1 看不见视频），veil = 黑色蒙版。 */
export const DEFAULTS = {
  surface: 0.2,
  veil: 0.14,
  playbackRate: 1,
  file: '',
  // 背景音乐：默认开、走内置那首（= 主人桌面壁纸的音乐）、音量 40%、循环
  musicOn: true,
  musicVolume: 0.4,
  musicFile: '',
};

const KEYS = Object.keys(DEFAULTS);

function clampNum(n, min, max, fb) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fb;
  return Math.min(max, Math.max(min, v));
}

/** 读盘上的旋钮，缺的项用默认值补齐，脏值一律夹回合法区间。 */
export function readSkin() {
  let raw = {};
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) raw = j;
  } catch {}
  return {
    surface: clampNum(raw.surface, 0, 1, DEFAULTS.surface),
    veil: clampNum(raw.veil, 0, 0.8, DEFAULTS.veil),
    playbackRate: clampNum(raw.playbackRate, 0.25, 4, DEFAULTS.playbackRate),
    file: typeof raw.file === 'string' ? raw.file.trim() : '',
    // 没写过就当开（老版本 skin.json 里没这几个键，升级上来也该有音乐）
    musicOn: typeof raw.musicOn === 'boolean' ? raw.musicOn : DEFAULTS.musicOn,
    musicVolume: clampNum(raw.musicVolume, 0, 1, DEFAULTS.musicVolume),
    musicFile: typeof raw.musicFile === 'string' ? raw.musicFile.trim() : '',
  };
}

/** 只改传进来的那几项，别的一律保留。 */
export function writeSkin(patch) {
  const cur = readSkin();
  const next = { ...cur };
  const p = patch && typeof patch === 'object' ? patch : {};
  if ('surface' in p) next.surface = clampNum(p.surface, 0, 1, cur.surface);
  if ('veil' in p) next.veil = clampNum(p.veil, 0, 0.8, cur.veil);
  if ('playbackRate' in p) next.playbackRate = clampNum(p.playbackRate, 0.25, 4, cur.playbackRate);
  if ('file' in p) next.file = typeof p.file === 'string' ? p.file.trim() : '';
  if ('musicOn' in p) next.musicOn = Boolean(p.musicOn);
  if ('musicVolume' in p) next.musicVolume = clampNum(p.musicVolume, 0, 1, cur.musicVolume);
  if ('musicFile' in p) next.musicFile = typeof p.musicFile === 'string' ? p.musicFile.trim() : '';
  if (!existsSync(STATE)) {
    try {
      mkdirSync(STATE, { recursive: true });
    } catch {}
  }
  writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** 现在该播哪个文件：自定义路径优先，坏了就退回内置素材，都没有就 null。 */
export function skinVideoPath() {
  const { file } = readSkin();
  if (file) {
    const p = isAbsolute(file) ? file : resolve(config.workspace, file);
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {}
  }
  try {
    if (existsSync(BUNDLED_VIDEO) && statSync(BUNDLED_VIDEO).isFile()) return BUNDLED_VIDEO;
  } catch {}
  return null;
}

/**
 * 首启把内置那首音乐也复制到数据目录。
 * 跟视频同一个理由：打包后不能直接读 asar 里的路径。
 */
export function ensureBundledMusic() {
  if (!config.packaged) return;
  try {
    if (existsSync(BUNDLED_MUSIC) && statSync(BUNDLED_MUSIC).size > 0) return;
  } catch {}
  try {
    if (!existsSync(SOURCE_MUSIC)) return;
    const dir = join(config.dataDir, 'assets');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(BUNDLED_MUSIC, readFileSync(SOURCE_MUSIC));
  } catch (e) {
    console.warn('[skin] 内置音乐复制失败：' + (e && e.message));
  }
}

/**
 * 现在该放哪首：导入的优先，断了就退回内置那首，都没有就 null。
 * 返回绝对路径；调用方负责 404。
 */
export function skinMusicPath() {
  const { musicFile } = readSkin();
  if (musicFile) {
    const p = isAbsolute(musicFile) ? musicFile : resolve(MUSIC_DIR, musicFile);
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {}
  }
  try {
    if (existsSync(BUNDLED_MUSIC) && statSync(BUNDLED_MUSIC).isFile()) return BUNDLED_MUSIC;
  } catch {}
  return null;
}

/**
 * 收下主人导入的一首音乐：把字节写进 .state/bg-music/<safeName>，
 * 文件名用时间戳打头防止撞名，返回落盘后的绝对路径。
 */
export function importMusic(name, buffer) {
  if (!buffer || !buffer.length) throw Object.assign(new Error('这个文件是空的'), { status: 400 });
  const raw = String(name || 'music').split(/[\\/]/).pop();
  const ext = (/\.([a-z0-9]{1,5})$/i.exec(raw) || [, 'm4a'])[1].toLowerCase();
  const stem = raw.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]+/g, '_').slice(0, 40) || 'music';
  const filename = `${Date.now()}-${stem}.${ext}`;
  if (!existsSync(MUSIC_DIR)) mkdirSync(MUSIC_DIR, { recursive: true });
  const dest = join(MUSIC_DIR, filename);
  writeFileSync(dest, buffer);
  writeSkin({ musicFile: dest, musicOn: true });
  return dest;
}

/** 界面要的一份状态：开关（来自功能面板）+ 旋钮 + 有没有片子 / 音乐。 */
export function getSkinState() {
  // enabled 是「视频背景这个功能开着没」，音乐跟它绑在一起：
  // 视频背景一停，音乐也得停（主人要的是「整套背景」，不是拆开的两半）。
  const enabled = Boolean(getEnabledMap().videoBg);
  const settings = readSkin();
  const videoPath = skinVideoPath();
  const musicPath = skinMusicPath();
  const musicCustom = Boolean(settings.musicFile) && musicPath === settings.musicFile;
  return {
    enabled,
    settings,
    defaults: DEFAULTS,
    hasVideo: Boolean(videoPath),
    videoName: videoPath ? videoPath.split(/[\\/]/).pop() : '',
    hasMusic: Boolean(musicPath),
    musicName: musicPath ? musicPath.split(/[\\/]/).pop().replace(/^\d{10,}-/, '') : '',
    musicIsCustom: musicCustom,
    // 音乐实际会不会响 = 视频背景开着 且 主人自己没关它
    musicPlayable: enabled && settings.musicOn && Boolean(musicPath),
  };
}
