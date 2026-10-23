// 繁体字自动转简体中文。
//
// 抓书的时候经常碰到繁體站（導航、章節標題全是繁體），抓下来是能读，但读着费劲。
// 这里给一个统一的出口：toSimplified(text) —— 传一段字，回一段简体。
//
// 用的是 opencc-js（OpenCC 的 JS 版，词级转换，"頭髮"→"头发" 这种不会转错）。
// 三个配置档：
//   tw  -> 台湾正体
//   hk  -> 香港繁体
//   twp -> 台湾正体 + 台湾用词（"軟體"→"软件"、"滑鼠"→"鼠标"），默认用这个，最贴简体习惯
//
// 转换器第一次用才建，建好缓存住。opencc-js 不在就直接原样返回，绝不把抓书流程搞挂。
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(HERE, '..');
const requireFromApp = createRequire(resolve(APP_ROOT, 'package.json'));

const CONFIGS = {
  tw: { from: 'tw', to: 'cn' },
  hk: { from: 'hk', to: 'cn' },
  twp: { from: 'twp', to: 'cn' },
};

const cache = new Map();
let opencc = null;
let openccTried = false;

function loadOpenCC() {
  if (openccTried) return opencc;
  openccTried = true;
  try {
    opencc = requireFromApp('opencc-js');
  } catch {
    try {
      opencc = requireFromApp(resolve(APP_ROOT, 'node_modules', 'opencc-js'));
    } catch {
      opencc = null;
    }
  }
  return opencc;
}

/** 这个配置档的转换器（拿不到就返回 null）。 */
function converter(from) {
  const key = CONFIGS[from] ? from : 'twp';
  if (cache.has(key)) return cache.get(key);
  const o = loadOpenCC();
  let fn = null;
  if (o && typeof o.Converter === 'function') {
    try {
      fn = o.Converter(CONFIGS[key]);
    } catch {
      fn = null;
    }
  }
  cache.set(key, fn);
  return fn;
}

/** 繁体字装得多不多（用来判断「这页值不值得转」）。 */
const TRAD_HINTS =
  /[們這來時說會裡後髮麼樣個國語開關門東車馬長見覺寫讀聽買賣錢點無為與體聲書畫學醫藥號幾歲萬億網頁資電電腦軟體]|[\u3400-\u9FFF]/;

/** 常见繁体字表（只看「只有繁体才会出现」的那批高频字，宁可少认不误判）。 */
const TRAD_SET = new Set(
  '們這來時說會裡後髮麼樣個國語開關門東車馬長見覺寫讀聽買賣錢點無為與體聲書畫學醫藥號幾歲萬億網頁資電軟臺灣龍鳳靈魂劍彈藥戰爭處壞嗎呢誰從曾經歷應該總當辦務員機構條件樂園憂傷愛戀歡樂團圓離別鄉親義氣戰爭權勢藝術風景雲霧飄飛揚讓認識語言詞彙譯戲劇場觀眾廳廁廚房臥室牆壁門窗簾鏡燈籠'.split(
    '',
  ),
);

/**
 * 这段文本「繁」不「繁」。roughly 0~1，越大越像繁体。
 * 只是给个判断，别拿它当科学测量。
 */
export function traditionalRatio(text) {
  const s = String(text || '');
  let cjk = 0;
  let trad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (c < 0x3400 || c > 0x9fff) continue;
    cjk++;
    if (TRAD_SET.has(ch)) trad++;
  }
  if (!cjk) return 0;
  return trad / cjk;
}

/** 是不是值得转（有汉字 + 繁体字占比过线）。 */
export function looksTraditional(text, threshold = 0.02) {
  const s = String(text || '');
  if (!TRAD_HINTS.test(s)) return false;
  return traditionalRatio(s) >= threshold;
}

/**
 * 繁体 -> 简体。
 * @param {string} text
 * @param {{from?: 'tw'|'hk'|'twp'}} [opts]
 * @returns {string} 简体文本；转换器不在就原样返回
 */
export function toSimplified(text, opts = {}) {
  const s = String(text ?? '');
  if (!s) return s;
  const fn = converter(opts.from || 'twp');
  if (!fn) return s;
  try {
    return fn(s);
  } catch {
    return s;
  }
}

/**
 * 需要才转：先看像不像繁体，像就转，不像就一字不动。
 * 抓书流程里用这个 —— 简体页面走原路，繁体页面自动变成简体。
 * @returns {{text: string, converted: boolean, ratio: number}}
 */
export function autoToSimplified(text, opts = {}) {
  const s = String(text ?? '');
  const ratio = traditionalRatio(s);
  if (!looksTraditional(s, opts.threshold ?? 0.02)) return { text: s, converted: false, ratio };
  const out = toSimplified(s, opts);
  return { text: out, converted: out !== s, ratio };
}

/** 转换器装没装好（给自检 / 功能面板显示用）。 */
export function converterReady() {
  return Boolean(converter('twp'));
}
