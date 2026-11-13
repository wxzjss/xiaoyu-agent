/**
 * 外观中心：主题 / 壁纸 / 插件（2026-11-11）
 *
 * 【三样东西是一套机制】
 *   主题  = 一组 CSS 变量（--bg / --panel / --border / --text / --dim / --accent ...）
 *   壁纸  = body 的 background-image（内置的是纯 CSS 纹理，插件可以给图片/视频）
 *   功能  = 一段前端模块脚本（plugin.json 的 entry）
 * 三者都可以是「内置」的，也可以是 <数据目录>/plugins/<id>/ 里主人自己放的。
 *
 * 【为什么不用一个大 JSON 主题文件】
 * 内置主题写在这里（换主题 = setProperty 十次，零网络请求、零闪烁）；
 * 磁盘插件只放增量 —— 出厂状态不该依赖「先拷文件」这一步。
 *
 * 【视觉口径（别改成 AI 味）】
 * 中性灰阶打底，一套主题只给一个有彩色的强调色；卡片用 1px 描边分界，不用投影堆层次；
 * 预览块用真实配色渲染，不用渐变贴图糊弄。
 */

const $ = (s, r = document) => r.querySelector(s);

/* ============================ 内置主题 ============================ */

/**
 * 每套主题就是一组变量。键名跟 index.html 的 :root 一一对应。
 *
 * 【要改就改全套】顶栏 / 气泡 / 输入框 / 弹窗 / 侧栏 / 滚动条全吃这几个变量，
 * 少写一个就会露出「换了一半」的底色 —— 那比不做主题还难看。
 * 语义色（红/金/青、角色身份色）故意不在这里：它们不随主题漂。
 */
export const THEMES = [
  {
    id: 'graphite',
    name: '石墨',
    soul: '纯黑打底，蓝作强调。最中性的一套，长时间看不累。',
    vars: {
      '--bg': '#000000', '--panel': '#171a21', '--border': '#262b36',
      '--text': '#e6e9ef', '--dim': '#8b95a7', '--accent': '#4f8cff',
      '--panel-2': '#0f1319', '--raise': '#1b2129', '--hover': '#1d2430',
      '--scroll': '#2c333f', '--scroll-hover': '#3b4553',
      '--toolhub-bg': '#1e232c', '--toolhub-bg2': '#232935',
      '--input-bg': 'rgba(10, 12, 17, .55)',
    },
  },
  {
    id: 'ink',
    name: '墨蓝',
    soul: '底色偏靛，强调色是更亮一档的蓝。夜里最像纸上的墨。',
    vars: {
      '--bg': '#05070d', '--panel': '#101521', '--border': '#1f2839',
      '--text': '#e3e8f2', '--dim': '#7f8ca3', '--accent': '#5b8def',
      '--panel-2': '#0a0f1a', '--raise': '#161d2b', '--hover': '#1a2331',
      '--scroll': '#222c3d', '--scroll-hover': '#2e3a4e',
      '--toolhub-bg': '#161d2b', '--toolhub-bg2': '#1b2334',
      '--input-bg': 'rgba(7, 10, 17, .6)',
    },
  },
  {
    id: 'pine',
    name: '松绿',
    soul: '墨绿灰，强调色是偏冷的青绿。适合白天用，不刺眼。',
    vars: {
      '--bg': '#050a08', '--panel': '#0f1714', '--border': '#1e2c26',
      '--text': '#e2eae6', '--dim': '#7e8f87', '--accent': '#3fa87a',
      '--panel-2': '#080f0c', '--raise': '#152019', '--hover': '#19261f',
      '--scroll': '#20302a', '--scroll-hover': '#2b3d35',
      '--toolhub-bg': '#152019', '--toolhub-bg2': '#1a2620',
      '--input-bg': 'rgba(8, 14, 11, .6)',
    },
  },
  {
    id: 'clay',
    name: '陶土',
    soul: '暖褐底，赭橙强调。偏纸质书那种温度，晚上不冷。',
    vars: {
      '--bg': '#0a0705', '--panel': '#181310', '--border': '#2b231d',
      '--text': '#ece6df', '--dim': '#9a8d80', '--accent': '#d08b5b',
      '--panel-2': '#100b08', '--raise': '#211a15', '--hover': '#271f19',
      '--scroll': '#2f2620', '--scroll-hover': '#3d322a',
      '--toolhub-bg': '#211a15', '--toolhub-bg2': '#271f19',
      '--input-bg': 'rgba(16, 12, 9, .6)',
    },
  },
  {
    id: 'slate',
    name: '石板',
    soul: '冷灰偏青，强调色是天青。最接近编辑器默认配色的一套。',
    vars: {
      '--bg': '#07080a', '--panel': '#14171b', '--border': '#232830',
      '--text': '#e5e8ec', '--dim': '#868e9b', '--accent': '#58b6c9',
      '--panel-2': '#0c0e12', '--raise': '#1b1f25', '--hover': '#20252c',
      '--scroll': '#2a3038', '--scroll-hover': '#363d47',
      '--toolhub-bg': '#1b1f25', '--toolhub-bg2': '#20252c',
      '--input-bg': 'rgba(10, 12, 15, .6)',
    },
  },
  {
    id: 'ember',
    name: '炭红',
    soul: '暗红褐打底，朱红强调。只在真的想用红色时选它。',
    vars: {
      '--bg': '#0a0506', '--panel': '#190f11', '--border': '#2d1c1f',
      '--text': '#eee3e5', '--dim': '#9c8489', '--accent': '#e05a5a',
      '--panel-2': '#120a0b', '--raise': '#221417', '--hover': '#281a1d',
      '--scroll': '#322024', '--scroll-hover': '#402a2e',
      '--toolhub-bg': '#221417', '--toolhub-bg2': '#281a1d',
      '--input-bg': 'rgba(16, 9, 10, .6)',
    },
  },
];

/* ============================ 内置壁纸 ============================ */

/**
 * 全部是纯 CSS 纹理，没有图片文件。
 * 一律用白色极低透明度叠加 —— 这样六套主题都能配，不用给每套主题单独做一套壁纸。
 *
 * 【image 里不许写 position/size】
 * CSSOM 的 background-image 只收「图层」本身，写 `... 0 0 / 22px 22px` 会整条被丢掉，
 * 结果就是 backgroundImage 设了个空串、壁纸看起来「选了没反应」。
 * 平铺尺寸一律走 size / repeat 两个字段（这条踩过一次，别合并回去）。
 *
 * 【pv 是给缩略图用的加重版】
 * 真正铺满首页时 3% 的白刚刚好，但缩到 168×76 的卡片里就完全看不见了 ——
 * 七张卡看起来一模一样，等于让人闭着眼睛选。pv 用同样的纹理、把透明度提到 3~6 倍、
 * 格子缩一半，缩略图才看得出「网点」和「方格」不是一回事。落款(pv)只画预览，不上墙。
 */
export const WALLPAPERS = [
  /**
   * 【第一张叫「默认」而不是「无」】2026-11-12 主人：「我的默认壁纸你给我弄没了」。
   * 出厂就是这个状态：不铺任何纹理 —— 开着「视频背景」时露出的就是那段深海片子
   * （assets/background.mp4，主人桌面壁纸那支），关着就是主题底色。
   * 写成「无」会被当成「什么都没有」，一选就以为把背景删了。
   *
   * 【2026-11-13 重设计·主人报「壁纸之间区别非常小、样式简陋」】
   * 原来那几张全是 .02~.07 透明度的白点白线，铺在黑底上肉眼几乎一样。
   * 现在这一套：每张都带**自己的色相和明显结构**（渐变色斑 / 光带 / 织纹 / 星野），
   * 并排看一眼就能分清；预览卡（pv）用更强的对比版本，挑起来不用眯眼。
   * 全部纯 CSS 渐变，零图片资源，跟主题底色叠加也不出戏。
   */
  { id: '', name: '默认', soul: '不铺纹理：开着视频背景就露背景片，关着就是主题底色。', image: '' },

  {
    id: 'aurora', name: '深空极光', soul: '蓝紫两团极光色斑沉在深空里，右上还有一撮星尘。夜航感。',
    image: 'radial-gradient(52% 44% at 18% 12%, rgba(64, 92, 255, .20), transparent 70%),'
      + 'radial-gradient(46% 40% at 82% 24%, rgba(168, 85, 247, .16), transparent 72%),'
      + 'radial-gradient(38% 30% at 62% 86%, rgba(56, 189, 248, .10), transparent 70%),'
      + 'radial-gradient(1.2px 1.2px at 12% 32%, rgba(255,255,255,.5), transparent),'
      + 'radial-gradient(1px 1px at 34% 68%, rgba(255,255,255,.36), transparent),'
      + 'radial-gradient(1.4px 1.4px at 72% 18%, rgba(255,255,255,.44), transparent),'
      + 'radial-gradient(1px 1px at 88% 55%, rgba(255,255,255,.3), transparent)',
    size: 'cover, cover, cover, 100% 100%, 100% 100%, 100% 100%, 100% 100%',
    repeat: 'no-repeat, no-repeat, no-repeat, no-repeat, no-repeat, no-repeat, no-repeat',
    pv: 'radial-gradient(52% 44% at 18% 12%, rgba(64, 92, 255, .55), transparent 70%),'
      + 'radial-gradient(46% 40% at 82% 24%, rgba(168, 85, 247, .48), transparent 72%),'
      + 'radial-gradient(38% 30% at 62% 86%, rgba(56, 189, 248, .30), transparent 70%),'
      + 'radial-gradient(2px 2px at 12% 32%, rgba(255,255,255,.9), transparent),'
      + 'radial-gradient(1.6px 1.6px at 34% 68%, rgba(255,255,255,.7), transparent),'
      + 'radial-gradient(2.2px 2.2px at 72% 18%, rgba(255,255,255,.85), transparent),'
      + 'radial-gradient(1.6px 1.6px at 88% 55%, rgba(255,255,255,.6), transparent)',
  },

  {
    id: 'ember', name: '暮霞', soul: '地平线上升起的暖橙余晖，越往上越沉入夜色。像傍晚关窗前最后那眼天空。',
    image: 'linear-gradient(to top, rgba(251, 146, 60, .16) 0%, rgba(190, 84, 66, .10) 26%,'
      + 'rgba(30, 27, 48, .05) 58%, transparent 80%),'
      + 'radial-gradient(60% 30% at 50% 100%, rgba(253, 186, 116, .14), transparent 74%)',
    size: 'cover, cover',
    repeat: 'no-repeat, no-repeat',
    pv: 'linear-gradient(to top, rgba(251, 146, 60, .50) 0%, rgba(190, 84, 66, .30) 26%,'
      + 'rgba(30, 27, 48, .12) 58%, transparent 80%),'
      + 'radial-gradient(60% 30% at 50% 100%, rgba(253, 186, 116, .40), transparent 74%)',
  },

  {
    id: 'moss', name: '翠谷', soul: '深谷里一层青苔绿雾，左下还有一汪更亮的潭水。白天看不刺眼。',
    image: 'radial-gradient(56% 46% at 78% 82%, rgba(52, 211, 153, .16), transparent 72%),'
      + 'radial-gradient(50% 40% at 14% 88%, rgba(20, 134, 108, .14), transparent 70%),'
      + 'radial-gradient(40% 34% at 50% 10%, rgba(6, 78, 59, .22), transparent 74%)',
    size: 'cover, cover, cover',
    repeat: 'no-repeat, no-repeat, no-repeat',
    pv: 'radial-gradient(56% 46% at 78% 82%, rgba(52, 211, 153, .48), transparent 72%),'
      + 'radial-gradient(50% 40% at 14% 88%, rgba(20, 134, 108, .42), transparent 70%),'
      + 'radial-gradient(40% 34% at 50% 10%, rgba(6, 78, 59, .55), transparent 74%)',
  },

  {
    id: 'rose', name: '蔷薇暮色', soul: '左下一团蔷薇红晕往右上淡出，配一点紫。比深空极光更暖一档。',
    image: 'radial-gradient(46% 40% at 16% 84%, rgba(244, 114, 182, .17), transparent 72%),'
      + 'radial-gradient(44% 38% at 80% 20%, rgba(129, 90, 240, .13), transparent 74%)',
    size: 'cover, cover',
    repeat: 'no-repeat, no-repeat',
    pv: 'radial-gradient(46% 40% at 16% 84%, rgba(244, 114, 182, .50), transparent 72%),'
      + 'radial-gradient(44% 38% at 80% 20%, rgba(129, 90, 240, .40), transparent 74%)',
  },

  {
    id: 'blueprint', name: '蓝图', soul: '亮蓝细网格铺满，像一张摊开的工程图纸。格子是真看得清的那种。',
    image: 'linear-gradient(rgba(96, 165, 250, .10) 1px, transparent 1px),'
      + 'linear-gradient(90deg, rgba(96, 165, 250, .10) 1px, transparent 1px),'
      + 'linear-gradient(rgba(96, 165, 250, .05) 1px, transparent 1px),'
      + 'linear-gradient(90deg, rgba(96, 165, 250, .05) 1px, transparent 1px)',
    size: '96px 96px, 96px 96px, 24px 24px, 24px 24px',
    repeat: 'repeat, repeat, repeat, repeat',
    pv: 'linear-gradient(rgba(96, 165, 250, .42) 1.4px, transparent 1.4px),'
      + 'linear-gradient(90deg, rgba(96, 165, 250, .42) 1.4px, transparent 1.4px),'
      + 'linear-gradient(rgba(96, 165, 250, .18) 1px, transparent 1px),'
      + 'linear-gradient(90deg, rgba(96, 165, 250, .18) 1px, transparent 1px)',
  },

  {
    id: 'weave', name: '织布', soul: '斜向织纹叠一层柔光，像闭着眼能摸到的那种布面质感。',
    image: 'repeating-linear-gradient(45deg, rgba(255,255,255,.045) 0 2px, transparent 2px 6px),'
      + 'repeating-linear-gradient(-45deg, rgba(255,255,255,.035) 0 2px, transparent 2px 6px),'
      + 'radial-gradient(90% 70% at 50% 30%, rgba(255,255,255,.06), transparent 72%)',
    size: 'auto, auto, cover',
    repeat: 'repeat, repeat, no-repeat',
    pv: 'repeating-linear-gradient(45deg, rgba(255,255,255,.24) 0 2px, transparent 2px 6px),'
      + 'repeating-linear-gradient(-45deg, rgba(255,255,255,.18) 0 2px, transparent 2px 6px),'
      + 'radial-gradient(90% 70% at 50% 30%, rgba(255,255,255,.22), transparent 72%)',
  },

  {
    id: 'spotlight', name: '聚光', soul: '正中一盏柔聚光灯，四周沉沉压暗。注意力全钉在正文上。',
    image: 'radial-gradient(56% 46% at 50% 40%, rgba(255, 244, 214, .11), transparent 58%),'
      + 'radial-gradient(130% 100% at 50% 48%, transparent 38%, rgba(0, 0, 0, .62) 100%)',
    size: 'cover, cover',
    repeat: 'no-repeat, no-repeat',
    pv: 'radial-gradient(56% 46% at 50% 40%, rgba(255, 244, 214, .34), transparent 58%),'
      + 'radial-gradient(130% 100% at 50% 48%, rgba(255,255,255,.08) 30%, rgba(0, 0, 0, .86) 100%)',
  },

  {
    id: 'dune', name: '沙丘', soul: '几条大弧线从左下往右上滚过去，像夜里被风吹平的沙。',
    image: 'repeating-radial-gradient(120% 90% at -20% 110%, transparent 0 46px,'
      + ' rgba(231, 190, 138, .06) 46px 92px, transparent 92px 138px),'
      + 'radial-gradient(70% 50% at 80% 0%, rgba(217, 160, 96, .07), transparent 70%)',
    size: 'cover, cover',
    repeat: 'no-repeat, no-repeat',
    pv: 'repeating-radial-gradient(120% 90% at -20% 110%, transparent 0 46px,'
      + ' rgba(231, 190, 138, .26) 46px 92px, transparent 92px 138px),'
      + 'radial-gradient(70% 50% at 80% 0%, rgba(217, 160, 96, .24), transparent 70%)',
  },
];

/* ============================ 状态 ============================ */

const state = {
  plugins: [],
  appearance: { themeId: 'graphite', wallpaperId: '', railCollapsed: false, railOn: true },
  tab: 'theme',
  loaded: false,
};

const themeById = (id) => THEMES.find((t) => t.id === id) || null;
const wallById = (id) => WALLPAPERS.find((w) => w.id === id) || WALLPAPERS[0];
const pluginById = (id) => state.plugins.find((p) => p.id === id) || null;

/* ============================ 应用：主题 ============================ */

/** 内置主题的 id 前缀；插件主题直接用自己的目录名，撞了就以插件的为准 */
let activeThemeEls = [];   // 插件主题注入的 <link>/<style>，切走时要摘掉

/** 主题会碰的变量名（清 inline 时按这个名单来，不动别的） */
const THEME_KEYS = [
  '--bg', '--panel', '--border', '--text', '--dim', '--accent',
  '--panel-2', '--raise', '--hover', '--scroll', '--scroll-hover',
  '--bg-rgb', '--panel-rgb', '--hover-rgb',
  '--toolhub-bg', '--toolhub-bg2', '--input-bg',
];

function clearPluginTheme() {
  for (const el of activeThemeEls) { try { el.remove(); } catch {} }
  activeThemeEls = [];
}

/**
 * 把内联变量全撤掉，退回 index.html 里 :root 的默认值（那套就是石墨）。
 *
 * 【为什么插件主题必须撤内联】
 * 内联 style 的优先级高于任何样式表 —— 内置主题写过的 --accent: #4f8cff 会盖掉
 * 插件 CSS 里的 :root { --accent: #ff9f43 }，表现是「选了插件主题，颜色一点没变」。
 * 插件主题只提供它想改的那几个变量，剩下靠默认值补齐。
 */
function clearInlineThemeVars() {
  const root = document.documentElement;
  for (const k of THEME_KEYS) root.style.removeProperty(k);
}

export function applyTheme(id) {
  const root = document.documentElement;
  clearPluginTheme();

  const builtin = themeById(id);
  if (builtin) {
    for (const [k, v] of Object.entries(withRgbVars(builtin.vars))) root.style.setProperty(k, v);
    document.body.dataset.xyTheme = builtin.id;
    return;
  }

  // 插件主题
  const p = pluginById(id);
  if (p && p.type === 'theme') {
    clearInlineThemeVars();
    document.body.dataset.xyTheme = p.id;
    if (p.css) activeThemeEls.push(addLink(assetUrl(p.id, p.css)));
    if (p.entry) loadFeature(p, 'theme');
    applyPluginRgb(p);
    return;
  }

  // 都没找到（插件被删了 / 状态脏了）：回落石墨
  const fallback = themeById('graphite');
  for (const [k, v] of Object.entries(withRgbVars(fallback.vars))) root.style.setProperty(k, v);
  document.body.dataset.xyTheme = 'graphite';
}

/** 插件里的一个文件 → 可访问的 URL（逐段 encode，避免中文/空格文件名出问题） */
function assetUrl(id, rel) {
  return `/plugin-assets/${encodeURIComponent(id)}/${String(rel).split('/').map(encodeURIComponent).join('/')}`;
}

/* ---------------- 插件主题的真实配色 ---------------- */

/**
 * 主题卡上那条色带要显示「这套主题真实长什么样」。
 *
 * 内置主题的颜色是 JS 里的对象，直接读；插件主题的颜色只写在它自己的 CSS 里，
 * 所以这里去把那份 CSS 取回来、正则扫一遍变量。
 *
 * 【为什么不用 getComputedStyle 试】
 * 得先把样式表挂进 DOM 才能算，而同一时刻只能挂一套主题 —— 为了画预览把别的主题
 * 挨个挂一遍再摘，会闪。取文本扫一遍既没有副作用，也能在样式还没载完时就画出来。
 *
 * 【plugin.json 可以自己写 preview】{ "preview": { "bg": "#0b0f16", "accent": "#35c2a8" } }
 * 有就用它（作者最清楚想秀哪几个色），没有才去扫 CSS。
 */
const cssTextCache = new Map();
async function pluginCssText(p) {
  if (!p || !p.css) return '';
  if (cssTextCache.has(p.id)) return cssTextCache.get(p.id);
  let txt = '';
  try { txt = await fetch(assetUrl(p.id, p.css)).then((r) => (r.ok ? r.text() : '')); } catch { txt = ''; }
  cssTextCache.set(p.id, txt);
  return txt;
}

/** 从一段 CSS 里抠出几个颜色变量（只认 #rgb / #rrggbb / rgb[a](...)） */
function cssColorVars(text) {
  const pick = (name) => {
    const m = new RegExp('--' + name + '\\s*:\\s*([^;{}]+)').exec(text || '');
    if (!m) return '';
    const v = m[1].trim();
    return /^(#[0-9a-f]{3,8}|rgba?\([^)]*\))$/i.test(v) ? v : '';
  };
  return {
    bg: pick('bg'), panel: pick('panel'), border: pick('border'),
    text: pick('text'), accent: pick('accent'),
    bgRgb: pick('bg-rgb'), panelRgb: pick('panel-rgb'), hoverRgb: pick('hover-rgb'),
    hover: pick('hover'),
  };
}

/** 给插件主题补上 __colors（面板画预览、落半透明底色都要用） */
async function hydratePluginColors(list) {
  await Promise.all((list || []).map(async (p) => {
    if (p.type !== 'theme' || p.__colors) return;
    const pv = p.preview && typeof p.preview === 'object' ? p.preview : null;
    if (pv && (pv.bg || pv.panel || pv.accent)) {
      p.__colors = {
        bg: pv.bg || '', panel: pv.panel || '', border: pv.border || '',
        text: pv.text || '', accent: pv.accent || '',
        bgRgb: '', panelRgb: '', hoverRgb: '', hover: '',
      };
      return;
    }
    p.__colors = cssColorVars(await pluginCssText(p));
  }));
}

/**
 * 插件主题没写 --panel-rgb 时，从它自己的 --panel 算出来。
 *
 * 开着壁纸/视频背景时面板要半透明（rgba(var(--panel-rgb), α)），分量写不出来就会
 * 退回内置主题那三个数 —— 表现是「换了插件主题，半透明的地方还是原来那个颜色」。
 * 作者只写 hex 是常态，所以缺的分量由这里补，且只在作者没写时才补。
 */
async function applyPluginRgb(p) {
  const v = p.__colors || cssColorVars(await pluginCssText(p));
  p.__colors = v;
  /* await 之后可能已经被换成别的主题了 —— 这时候落这套 rgb 就是给别人染色 */
  if (document.body.dataset.xyTheme !== p.id) return;
  const root = document.documentElement;
  const hex2rgb = (hex) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : '';
  };
  const fill = (rgbKey, hexKey, declared) => {
    if (declared) return;                       // 作者自己写了，听作者的
    const rgb = hex2rgb(v[hexKey]);
    if (rgb) root.style.setProperty('--' + rgbKey, rgb);
  };
  fill('bg-rgb', 'bg', v.bgRgb);
  fill('panel-rgb', 'panel', v.panelRgb);
  fill('hover-rgb', 'hover', v.hoverRgb);
}

/**
 * 从主题的 --bg / --panel / --hover 自动派生 rgb 分量。
 *
 * 干嘛要这个：开着壁纸或视频背景时，面板得半透明才看得见画面，而 rgba() 里那个
 * 颜色分量没法写成 var。手写「每套主题三行 rgb」迟早写错一个 —— 干脆从已有的
 * hex 算出来，主题改颜色时分量自动跟上。
 */
function withRgbVars(vars) {
  const hex2rgb = (hex) => {
    const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '').trim());
    return m ? `${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}` : '';
  };
  const out = { ...vars };
  for (const [key, rgbKey] of [['--bg', '--bg-rgb'], ['--panel', '--panel-rgb'], ['--hover', '--hover-rgb']]) {
    const rgb = hex2rgb(vars[key]);
    if (rgb) out[rgbKey] = rgb;
  }
  return out;
}

/* ============================ 应用：壁纸 ============================ */

/**
 * 壁纸 = 铺满首页那一层（#xyWall，跟视频背景同档负层级）。
 *
 * 【为什么不是 body 的 background】
 * body 是最底下那层，内容全压在它上面 —— 设上去等于白设，一个字都看不见。
 * 首页那张固定的画面本来就是独立一层（#bgVideo / #bgVeil / #bgTint），
 * 壁纸必须跟它站在同一个高度，所以另开 #xyWall。
 *
 * 【选了壁纸就把视频藏起来】
 * 视频盖在壁纸上谁也看不见。body.wall 会让 #bgVideo display:none，
 * 同时让面板半透明（跟 body.skin 共用同一套规则），画面才透得出来。
 */
export function applyWallpaper(id) {
  const el = document.getElementById('xyWall');
  if (!el) return;

  const builtin = WALLPAPERS.find((w) => w.id === id) || null;
  const plugin = pluginById(id);
  const pluginOk = plugin && plugin.type === 'wallpaper' && plugin.wallpaper && plugin.wallpaper.kind !== 'video';
  const on = Boolean(id) && (builtin ? builtin.id !== '' : Boolean(pluginOk));

  document.body.classList.toggle('wall', on);

  if (!on) {
    el.style.backgroundImage = '';
    el.style.backgroundSize = '';
    el.style.backgroundRepeat = '';
    document.body.dataset.xyWall = '';
    return;
  }

  if (builtin) {
    el.style.backgroundImage = builtin.image || '';
    el.style.backgroundSize = builtin.size || '';
    el.style.backgroundRepeat = builtin.repeat || '';
    document.body.dataset.xyWall = builtin.id;
    return;
  }

  el.style.backgroundImage = `url("${assetUrl(plugin.id, plugin.wallpaper.file)}")`;
  el.style.backgroundSize = 'cover';
  el.style.backgroundRepeat = 'no-repeat';
  document.body.dataset.xyWall = plugin.id;
}

/* ============================ 应用：两处收缩 ============================ */

/**
 * 两件事分开管（2026-11-12 主人纠正过一次，别再合回去）：
 *
 *   railOn         左上角那颗「侧栏」图标 → 管下面那列「屋里的人」（人设/牌子）。
 *                  关掉 = 整列不显示（CSS: body.railOff #whoRail）；按钮本身在顶栏里，
 *                  所以永远点得回来。
 *   railCollapsed  顶栏右端那颗小箭头 → 管整条 header 收起（只留「小鱼」）。
 *                  窗口窄的时候一顶栏按钮挤成一团，收起来正文能多一行。
 *
 * 【踩过的坑】这两件事曾经都挂在左上那颗按钮上：图标画的是侧栏，点下去收的却是顶栏，
 * 主人第一反应就是「我的人设列怎么管不了了」。
 */
function applyRail() {
  document.body.classList.toggle('hdrMini', state.appearance.railCollapsed === true);
  document.body.classList.toggle('railOff', state.appearance.railOn === false);
}

/** 左上角那颗：左侧「屋里的人」展开 ↔ 收起；返回 true 表示现在是收起的 */
export function toggleRail() {
  state.appearance.railOn = state.appearance.railOn === false;
  applyRail();
  save({ railOn: state.appearance.railOn });
  return state.appearance.railOn === false;
}

/** 顶栏右端那颗：整条顶栏展开 ↔ 收起；返回 true 表示现在是收起的 */
export function toggleHeader() {
  state.appearance.railCollapsed = !state.appearance.railCollapsed;
  applyRail();
  save({ railCollapsed: state.appearance.railCollapsed });
  return state.appearance.railCollapsed === true;
}

/**
 * 插件清单变了（刚导入 / 刚启用 / 刚停用）就重读一遍并重挂。
 *
 * 不给外面用「刷新页面」这种说法：主人刚写完一段插件代码点「写入并启用」，
 * 结果要按 F5 才看得见 —— 那这个功能就等于没做完。
 */
export async function reloadPlugins() {
  await refresh();
  applyAllPlugins();
}

/* ============================ 插件加载 ============================ */

const loadedFeatures = new Set();

function addLink(href) {
  const l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = href;
  document.head.appendChild(l);
  return l;
}

/**
 * 功能插件：import 它的入口模块，把宿主能力递进去。
 * 约定：默认导出是一个函数，收到 { root, api, toast } 就自己往页面上挂东西。
 * 加载失败只打一行日志 —— 一个坏插件不该让整个界面起不来。
 */
async function loadFeature(p, kind) {
  if (!p.entry || loadedFeatures.has(p.id)) return;
  loadedFeatures.add(p.id);
  try {
    const mod = await import(assetUrl(p.id, p.entry));
    const fn = mod?.default || mod?.mount || mod?.activate;
    if (typeof fn === 'function') {
      await fn({
        root: document.body,
        kind,
        meta: p,
        toast: (t) => tip(String(t)),
        api: {
          getAppearance: () => ({ ...state.appearance }),
          setAppearance: (patch) => { Object.assign(state.appearance, patch); save(patch); },
          listPlugins: () => state.plugins.slice(),
        },
      });
    }
  } catch (err) {
    // 加载失败要允许重试：不然一个当时的临时错误（文件刚放进去、语法刚改好）
    // 会让这个插件在本次运行里永远起不来，主人只能重启
    loadedFeatures.delete(p.id);
    console.warn(`[plugin] ${p.id} 载入失败：`, err);
  }
}

function unloadFeature(p) {
  // 模块没法卸载，只能记住「已经加载过」，关掉时不再执行；页面上留下的节点由插件自己在
  // 挂载时监听 'xy:disable' 事件清理（约定，不是强制）。
  loadedFeatures.delete(p.id);   // 停用后允许重新启用时再挂一次
  try { window.dispatchEvent(new CustomEvent('xy:disable', { detail: { id: p.id } })); } catch {}
}

/** 把「启用的插件」落地：功能插件挂载；主题/壁纸由 applyTheme / applyWallpaper 负责 */
function applyAllPlugins() {
  for (const p of state.plugins) {
    if (!p.enabled) { unloadFeature(p); continue; }
    // 【注意】这里不碰 type==='theme' 的 CSS：同时启用两个主题插件会互相盖，
    // 主题样式只由 applyTheme(当前选中的那个) 注入，别在这里再注一遍。
    if (p.type === 'feature') loadFeature(p, 'feature');
  }
}

/* ============================ 与后端通信 ============================ */

/**
 * 保存外观到后端。
 *
 * 【为什么排成一条队】点得快的时候（连点两下「收起人设列」、收顶栏的同时换主题）
 * 两个 POST 会同时飞出去，谁先落地不确定 —— 后一个的响应带着旧值回来，本地状态
 * 就被"倒回去"了，刷新一次又变回上一次的样子。排队之后请求按点击顺序走，
 * 最后一个一定是主人最后点的那个状态。
 */
let saveChain = Promise.resolve();

function save(patch) {
  saveChain = saveChain.then(() => saveNow(patch)).catch(() => {});
  return saveChain;
}

async function saveNow(patch) {
  try {
    const r = await fetch('/api/appearance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const j = await r.json();
    if (j?.appearance) {
      // 这次刚设过的键以本地为准：响应里那几项可能是上一拍的值
      const back = { ...j.appearance };
      for (const k of Object.keys(patch)) delete back[k];
      state.appearance = { ...state.appearance, ...back };
    }
  } catch (err) {
    console.warn('[appearance] 保存失败', err);
  }
}

async function refresh() {
  try {
    const r = await fetch('/api/plugins');
    const j = await r.json();
    state.plugins = Array.isArray(j?.plugins) ? j.plugins : [];
    if (j?.appearance) state.appearance = { ...state.appearance, ...j.appearance };
  } catch (err) {
    console.warn('[appearance] 读取失败', err);
  }
  // 主题卡上的色带要用插件自己的颜色，先把颜色捞回来再画
  await hydratePluginColors(state.plugins);
  return state;
}

/* ============================ 面板：样式 ============================ */

const PANEL_CSS = `
/* header 上的图标按钮：沿用 header button 的底色，只收紧内边距 */
header #railBtn, header #hdrFold {
  display: inline-flex; align-items: center; justify-content: center;
  padding: 4px 7px; line-height: 1;
}
header #railBtn svg, header #hdrFold svg { display: block; }
header #railBtn:hover, header #hdrFold:hover { color: var(--accent); }

/* ---- 顶栏收起态 ----
   只留「小鱼」和那两颗开关（左边那颗管屋里的人、右边那颗把顶栏放回来），
   其余按钮全藏起来。保留 #hdrPush（零宽推杆）：不留它，剩下那两个元素会贴到最左边，
   展开时整排按钮的位置会跳一下。 */
body.hdrMini header { padding: 5px 12px; gap: 8px; }
body.hdrMini header > *:not(#railBtn):not(#hdrFold):not(b):not(#hdrPush) { display: none !important; }
body.hdrMini header b { font-size: 13px; }
body.hdrMini #hdrFold { color: var(--accent); border-color: var(--border); }
body.hdrMini #hdrFold svg { transform: rotate(180deg); }
/* 收起时顶部那条分隔线也没必要那么重 */
body.hdrMini { --hdr-mini: 1; }
body.hdrMini header { border-bottom-color: var(--border); }

/* 顶栏收起后 header 只剩 35px，人设列要是还钉在 54px 就会空出一道缝 */
body.hdrMini #whoRail { top: 36px; }

/* 左侧那列「屋里的人」可以整体关掉（不是收缩，就是不显示）。
   按钮留在顶栏里，随时点回来 —— 关掉时按钮染成强调色，一眼看出「是这里关的」。 */
body.railOff #whoRail { display: none !important; }
body.railOff #railBtn { color: var(--accent); opacity: .75; }

/* ---- 外观面板 ---- */
#appearanceDlg { width: min(680px, 94vw); }
#appearanceDlg .apTabs {
  display: flex; gap: 2px; padding: 10px 16px 0; border-bottom: 1px solid var(--border);
  flex: 0 0 auto;
}
#appearanceDlg .apTabs button {
  background: transparent; border: 0; border-bottom: 2px solid transparent;
  color: var(--dim); font: inherit; font-size: 13px; padding: 7px 12px 9px;
  cursor: pointer; border-radius: 6px 6px 0 0;
}
#appearanceDlg .apTabs button:hover { color: var(--text); background: rgba(255,255,255,.04); }
#appearanceDlg .apTabs button.on { color: var(--text); border-bottom-color: var(--accent); }

#appearanceDlg .apGrid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(168px, 1fr)); gap: 10px;
}
#appearanceDlg .apCard {
  position: relative; text-align: left; padding: 0; cursor: pointer;
  background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
  overflow: hidden; font: inherit; color: var(--text);
  transition: border-color .12s, background .12s;
}
#appearanceDlg .apCard:hover { border-color: var(--dim); }
#appearanceDlg .apCard.on { border-color: var(--accent); }
#appearanceDlg .apCard.on::after {
  content: '✓'; position: absolute; top: 6px; right: 8px;
  color: var(--accent); font-size: 13px; font-weight: 700;
}
/* 主题预览：三条色带 + 一块模拟面板，用真实配色画，不用截图 */
#appearanceDlg .apSwatch { height: 62px; display: flex; }
#appearanceDlg .apSwatch i { flex: 1; display: block; }
/* 算不出配色的插件主题：斜纹底 + 一行字，比五个假灰块诚实 */
#appearanceDlg .apSwatch.q {
  align-items: center; justify-content: center;
  background: repeating-linear-gradient(135deg, rgba(255,255,255,.035) 0 6px, rgba(255,255,255,0) 6px 12px);
  border-bottom: 1px solid var(--border);
}
#appearanceDlg .apSwatchQ { font-size: 11px; color: var(--dim); }
#appearanceDlg .apCardBody { padding: 8px 10px 10px; }
#appearanceDlg .apCardName { font-size: 12.5px; font-weight: 600; display: flex; gap: 6px; align-items: baseline; }
#appearanceDlg .apCardName em {
  font-style: normal; font-size: 10px; font-weight: 400; color: var(--dim);
  border: 1px solid var(--border); border-radius: 4px; padding: 0 4px;
}
#appearanceDlg .apCardSoul {
  margin-top: 3px; font-size: 11px; color: var(--dim); line-height: 1.45;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
/* 壁纸预览块 */
#appearanceDlg .apWall { height: 76px; border-bottom: 1px solid var(--border); }

/* 插件列表 */
#appearanceDlg .apPlug {
  display: flex; gap: 12px; align-items: flex-start;
  padding: 11px 12px; border: 1px solid var(--border); border-radius: 10px;
  background: var(--panel); margin-bottom: 8px;
}
#appearanceDlg .apPlugMain { flex: 1 1 auto; min-width: 0; }
#appearanceDlg .apPlugName { font-size: 13px; font-weight: 600; display: flex; gap: 6px; align-items: baseline; }
#appearanceDlg .apPlugName em { font-style: normal; font-size: 10px; color: var(--dim); font-weight: 400; }
#appearanceDlg .apPlugDesc { font-size: 11.5px; color: var(--dim); margin-top: 3px; line-height: 1.5; }
#appearanceDlg .apPlugSide { display: flex; gap: 6px; align-items: center; flex: 0 0 auto; }
#appearanceDlg .apPlugSide button {
  background: transparent; border: 1px solid var(--border); color: var(--dim);
  border-radius: 6px; font: inherit; font-size: 11.5px; padding: 3px 8px; cursor: pointer;
}
#appearanceDlg .apPlugSide button:hover { color: var(--err, #f85149); border-color: var(--err, #f85149); }
#appearanceDlg .apEmpty {
  padding: 26px 12px; text-align: center; color: var(--dim); font-size: 12.5px; line-height: 1.8;
}
#appearanceDlg .apEmpty code {
  background: var(--input-bg); border: 1px solid var(--border); border-radius: 4px;
  padding: 1px 5px; font-size: 11.5px;
}
/* 开关（跟界面其它开关同款手感） */
#appearanceDlg .apSwitch {
  position: relative; width: 34px; height: 19px; flex: 0 0 auto;
  border-radius: 10px; background: #2a3140; border: 1px solid var(--border);
  cursor: pointer; transition: background .14s, border-color .14s; padding: 0;
}
#appearanceDlg .apSwitch i {
  position: absolute; top: 1.5px; left: 2px; width: 14px; height: 14px;
  border-radius: 50%; background: var(--dim); transition: transform .14s, background .14s;
}
#appearanceDlg .apSwitch.on { background: rgba(79,140,255,.28); border-color: var(--accent); }
#appearanceDlg .apSwitch.on i { transform: translateX(15px); background: var(--accent); }
`;

function injectCss() {
  if (document.getElementById('xyAppearanceCss')) return;
  const s = document.createElement('style');
  s.id = 'xyAppearanceCss';
  s.textContent = PANEL_CSS;
  document.head.appendChild(s);
}

/* ============================ 轻提示 ============================ */

let tipTimer = 0;
function tip(text) {
  let el = document.getElementById('xyApTip');
  if (!el) {
    el = document.createElement('div');
    el.id = 'xyApTip';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:34px', 'transform:translateX(-50%)',
    'z-index:9999', 'padding:7px 14px', 'border-radius:8px',
    'background:rgba(20,24,32,.96)', 'border:1px solid var(--border)',
    'color:var(--text)', 'font-size:12.5px', 'pointer-events:none',
    'box-shadow:0 6px 24px rgba(0,0,0,.45)', 'opacity:1', 'transition:opacity .18s',
  ].join(';');
  clearTimeout(tipTimer);
  tipTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 200);
  }, 1500);
}

/* ============================ 面板：渲染 ============================ */

function hexOf(v, fallback) {
  // 预览色块只处理 #rrggbb；带 alpha 的（--input-bg）不参与预览
  return /^#[0-9a-f]{6}$/i.test(String(v || '')) ? v : fallback;
}

function renderThemeTab() {
  const cur = state.appearance.themeId;
  const pluginThemes = state.plugins.filter((p) => p.type === 'theme');

  const card = (t, isPlugin) => {
    // 内置主题的键带 -- 前缀，插件主题是扫 CSS 得到的裸名，这里对齐成同一份
    const raw = isPlugin ? (t.__colors || {}) : (t.vars || {});
    const c = {};
    for (const k of ['bg', 'panel', 'border', 'text', 'accent']) {
      c[k] = hexOf(isPlugin ? raw[k] : raw['--' + k], '');
    }
    /* 一条色带都算不出来（插件只给了 js 入口、没写 CSS）时，不要用五个灰块糊弄 ——
     * 那看起来像加载失败。改成一块斜纹 + 一行字，说明「配色在样式里，装上才知道」。 */
    const unknown = isPlugin && !c.bg && !c.panel && !c.accent;
    const bands = unknown
      ? '<span class="apSwatchQ">配色在插件样式里</span>'
      : [c.bg || '#0b0d11', c.panel || '#171a21', c.border || '#262b36', c.text || '#e6e9ef', c.accent || '#4f8cff']
        .map((x) => `<i style="background:${x}"></i>`).join('');
    const on = cur === t.id ? ' on' : '';
    return `<button class="apCard${on}" data-theme="${esc(t.id)}" type="button">
      <div class="apSwatch${unknown ? ' q' : ''}">${bands}</div>
      <div class="apCardBody">
        <div class="apCardName">${esc(t.name)}${isPlugin ? '<em>插件</em>' : ''}</div>
        <div class="apCardSoul">${esc(t.soul || t.description || '')}</div>
      </div>
    </button>`;
  };

  return `<div class="apGrid">${THEMES.map((t) => card(t, false)).join('')}${pluginThemes.map((p) => card(p, true)).join('')}</div>`;
}

function renderWallTab() {
  const cur = state.appearance.wallpaperId;
  const pluginWalls = state.plugins.filter((p) => p.type === 'wallpaper');
  const items = [
    ...WALLPAPERS.map((w) => ({ ...w, plugin: false })),
    ...pluginWalls.map((p) => {
      const isVideo = p.wallpaper?.kind === 'video';
      const url = p.wallpaper ? assetUrl(p.id, p.wallpaper.file) : '';
      /* 这里的 url 会进 style="..." 属性，所以只能用单引号包 ——
       * 用 url("…") 的话外层那双引号会提前把属性截断，浏览器看到的是一串残渣：
       * background-image:url( + 一堆空属性，缩略图直接空白。 */
      return {
        id: p.id, name: p.name, soul: p.description || '', plugin: true,
        image: url && !isVideo ? `url('${url}')` : '',
        size: url && !isVideo ? 'cover' : '',
        repeat: url && !isVideo ? 'no-repeat' : '',
        isVideo,
      };
    }),
  ];

  // 预览块：用真实 CSS 画，跟真正生效的那层是同一份数据 —— 所见即所得
  // （内置纹理有加重版 pv，缩略图才分得清；插件壁纸没有 pv，直接用真图）
  const previewStyle = (w) => {
    const p = ['background-color:var(--bg)'];
    const img = w.pv || w.image;
    if (img) {
      p.push(`background-image:${img}`);
      const sz = w.pv ? (w.pvSize || w.size) : w.size;
      if (sz) p.push(`background-size:${sz}`);
      if (w.repeat) p.push(`background-repeat:${w.repeat}`);
      if (w.repeat === 'no-repeat') p.push('background-position:center');
    }
    return p.join(';');
  };

  const card = (w) => `<button class="apCard${cur === w.id ? ' on' : ''}" data-wall="${esc(w.id)}" type="button">
      <div class="apWall" style="${previewStyle(w)}">${
        w.isVideo ? '<span style="display:flex;height:100%;align-items:center;justify-content:center;font-size:11px;color:#cfd6e2">视频壁纸</span>' : ''
      }</div>
      <div class="apCardBody">
        <div class="apCardName">${esc(w.name)}${w.plugin ? '<em>插件</em>' : ''}</div>
        <div class="apCardSoul">${esc(w.soul || '')}</div>
      </div>
    </button>`;

  return `<div class="apGrid">${items.map(card).join('')}</div>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderBody() {
  const el = $('#apBody');
  if (!el) return;
  if (state.tab !== 'wall') state.tab = 'theme';
  el.innerHTML = state.tab === 'wall' ? renderWallTab() : renderThemeTab();
  for (const b of document.querySelectorAll('#appearanceDlg .apTabs button')) {
    b.classList.toggle('on', b.dataset.tab === state.tab);
  }
  /* 底部那句话跟着标签页换，只留一句 —— 每一页各写一段解释，读起来像说明书 */
  const foot = $('#apFoot');
  if (foot) {
    foot.textContent = state.tab === 'wall'
      ? '铺在首页最底层，正文区不吃它'
      : '选中即生效，整页跟着换';
  }
}

/* ============================ 面板：交互 ============================ */

function bindPanel(dlg) {
  dlg.addEventListener('click', async (ev) => {
    const tabBtn = ev.target.closest('.apTabs button');
    if (tabBtn) { state.tab = tabBtn.dataset.tab; renderBody(); return; }

    const themeCard = ev.target.closest('.apCard[data-theme]');
    if (themeCard) {
      const id = themeCard.dataset.theme;
      state.appearance.themeId = id;
      applyTheme(id);
      renderBody();
      save({ themeId: id });
      return;
    }

    const wallCard = ev.target.closest('.apCard[data-wall]');
    if (wallCard) {
      const id = wallCard.dataset.wall;
      state.appearance.wallpaperId = id;
      applyWallpaper(id);
      renderBody();
      save({ wallpaperId: id });
      return;
    }
  });
}

/* ============================ 对外：打开面板 ============================ */

export async function openPanel(tab) {
  if (tab) state.tab = tab;
  await refresh();
  let dlg = document.getElementById('appearanceDlg');
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.id = 'appearanceDlg';
    dlg.innerHTML = `
      <div class="dlgHead">
        <b>外观</b>
        <span class="meta" id="apHint" style="color:var(--dim);font-size:12px">主题与壁纸</span>
        <button class="x" id="apClose" type="button">关闭</button>
      </div>
      <div class="apTabs">
        <button data-tab="theme" type="button">主题</button>
        <button data-tab="wall" type="button">壁纸</button>
      </div>
      <div class="dlgBody" id="apBody"></div>
      <div class="dlgFoot">
        <span class="hint" id="apFoot">选中即生效，整页跟着换</span>
      </div>`;
    document.body.appendChild(dlg);
    bindPanel(dlg);
    $('#apClose', dlg).addEventListener('click', () => dlg.close());
  }
  renderBody();
  if (!dlg.open) dlg.showModal();
}

/* ============================ 初始化 ============================ */

export async function init() {
  if (state.loaded) return;
  state.loaded = true;
  injectCss();
  await refresh();
  applyTheme(state.appearance.themeId);
  applyWallpaper(state.appearance.wallpaperId);
  applyRail();
  applyAllPlugins();

  // header 上那两颗按钮：没登进 DOM 就等一会儿（index.html 的脚本顺序不保证）
  const bind = () => {
    const btn = document.getElementById('openAppearance');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => openPanel());
    }
    const rail = document.getElementById('railBtn');
    if (rail && !rail.dataset.bound) {
      rail.dataset.bound = '1';
      rail.addEventListener('click', () => {
        const off = toggleRail();
        rail.title = off
          ? '展开左侧「屋里的人」'
          : '收起左侧「屋里的人」（收起后随时点这里放回来）';
        tip(off ? '左侧「屋里的人」已收起' : '左侧「屋里的人」已展开');
      });
      if (state.appearance.railOn === false) {
        rail.title = '展开左侧「屋里的人」';
      }
    }
    const fold = document.getElementById('hdrFold');
    if (fold && !fold.dataset.bound) {
      fold.dataset.bound = '1';
      fold.addEventListener('click', () => {
        const mini = toggleHeader();
        fold.title = mini ? '展开顶栏' : '收起顶栏（只留标题）';
        tip(mini ? '顶栏已收起（点右上角箭头展开）' : '顶栏已展开');
      });
      if (state.appearance.railCollapsed === true) {
        fold.title = '展开顶栏';
      }
    }
  };
  bind();
  if (!document.getElementById('openAppearance')) {
    document.addEventListener('DOMContentLoaded', bind, { once: true });
    setTimeout(bind, 600);
  }
}

/* 挂在 window 上，方便在控制台/调试器里直接调 */
window.xyAppearance = {
  open: openPanel,
  init,
  themes: THEMES,
  wallpapers: WALLPAPERS,
  state: () => ({ ...state.appearance, plugins: state.plugins }),
  applyTheme,
  applyWallpaper,
  toggleRail,
  toggleHeader,
  reloadPlugins,
};

init();
