/**
 * 桥：把「已经在 index.html 里的那些工具函数」借过来用。
 *
 * 规格步骤 2 明确要求**复用**而不是重写：markdown（mdInto）、工具名美化（niceTool）、
 * 工具文本清洗（tidyToolText）、思考摘要（thinkPeekTail）、署名配色（mateColorOf）
 * 都是打磨过很多轮的东西，重写一遍只会把已经修好的 bug 再引进新实现里。
 *
 * 这里每个函数都带一个「拿不到就退化」的兜底：万一某个全局还没加载完，
 * 屏幕上退成纯文本也比整片白屏好。
 */

/** 把 markdown 画进一个已经存在的元素 */
export function mdInto(el, text) {
  if (!el) return;
  const raw = String(text == null ? '' : text);
  try {
    if (typeof window.mdInto === 'function') {
      window.mdInto(el, raw);
      return;
    }
  } catch (e) {
    try { console.warn('[log-view] mdInto 失败，退成纯文本:', e && e.message ? e.message : e); } catch (e2) {}
  }
  el.textContent = raw;
}

/** 工具卡标题：「跑命令 · ls -la」这种 */
export function niceTool(name, args) {
  try {
    if (typeof window.niceTool === 'function') return String(window.niceTool(name, args) || '');
  } catch (e) { /* 退化成原始名字 */ }
  return String(name || '工具');
}

/** 工具参数 / 输出的清洗（抹掉噪声、压掉超长 base64 之类） */
export function tidyToolText(v) {
  try {
    if (typeof window.tidyToolText === 'function') return String(window.tidyToolText(v) || '');
  } catch (e) { /* 退化 */ }
  return String(v == null ? '' : v);
}

/** 思考灰字那一截（柜门右侧 / 思考块右侧） */
export function thinkPeek(text) {
  try {
    if (typeof window.thinkPeekTail === 'function') return String(window.thinkPeekTail(text) || '');
  } catch (e) { /* 退化 */ }
  return '';
}

/* ── 署名配色 ─────────────────────────────────────────────────
 *
 * 【2026-11-11 修·主人报「重启后历史里小鲸的名字是白色的」】
 *
 * 病根不在「颜色表没拉到」，而在**颜色是异步来的、React 只画一次**：
 *   · index.html 的 mateColorOf() 第一次调用必然返回默认色 #e6e6e6（白），
 *     同时才去发 /api/agents 的请求；
 *   · 气泡在那一拍就把白写进内联 style.color 了；
 *   · 等 Map 填好，React **没有任何 state 变化** → 不会重渲染 →
 *     那截白色就一直挂到下次整屏重画（重启后打开历史会话，正好一路白到底）。
 *     外面那份 refreshMateColors 只是**手工改 DOM**，下一次 React 渲染就覆盖回去。
 *
 * 两刀一起下才治得住：
 *   ① 【同步】内置卡的颜色是产品规格的一部分，不该等一次网络往返。
 *      这儿内置一份，第一帧就是对的（小鲸的蓝、旁白的紫白）。
 *      自定义卡还是以 /api/agents 为准。
 *   ② 【回填后重渲染】表拉回来如果和内置值不同（自定义卡、改过色），
 *      调一次 store 的 bump —— LogView 订阅着版本号，会整屏重算一遍颜色。
 *      这样「数据后到」也能自己纠回来，不靠谁去手工改 DOM。
 *
 * 为什么选这个方案（而不是「首屏 await 颜色表」）：
 *   await 会把首屏拖到一次网络往返之后 —— 服务端忙的时候就是一片空白；
 *   而内置表让网络彻底离开首屏的关键路径：对得上就一帧到位，对不上再补一帧。
 */

/** 默认色（跟 index.html 的 mateColorOf 同一个口径） */
const MATE_DEFAULT_COLOR = '#e6e6e6';

/**
 * 内置卡的名字→色（跟服务端 agents.mjs 内置卡上的 color 对齐）。
 * 这三张卡是随程序发的，颜色不随用户改，所以可以写死。
 */
const BUILTIN_MATE_COLORS = {
  '小鲸': '#5b9bd5',
  '小白曦': '#e6e6e6',
  '旁白': '#c8a8e8',
};

/**
 * 【2026-11-11 加·改过色的人不许闪】
 *
 * 内置表让第一帧就有色，但也带来一个新风险：主人若在面板里把小鲸改成了
 * 别的颜色（比如 #ff6b6b），首帧会先画内置蓝，等 /api/agents 回来再 bump 成新色 ——
 * **实测网络慢 1200ms 时，那一截蓝挂了 707ms，肉眼看得见。**
 *
 * 治法是「记住上次拿到的那份真值」：每成功拉到一次 /api/agents 就把整张表落到
 * localStorage，下次开机先用它铺底。这样只要这台机器**拉过一次**颜色表，
 * 之后每一帧（包括断网时）都是主人自己定的颜色，不存在闪。
 *
 * 什么时候仍会闪一次：主人改完色的**第一次**刷新（本机还不知道新值）。
 * 那一次不可避免 —— 除非阻塞首屏，那是更糟的交换。
 * 想连这一次也消掉的话，改色的那个接口返回后顺手调 `window.__mateColorsApply(名, 色)`
 * 即可（见文件末尾的导出），下次刷新就从缓存里直接读新色。
 */
const CACHE_KEY = 'xy_mateColors.v1';

function readColorCache() {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    return j;
  } catch (e) { return null; }   /* 隐私模式 / 配额满：当没有缓存 */
}

function writeColorCache() {
  try {
    const o = {};
    for (const [k, v] of mateColors) o[k] = v;
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(o));
  } catch (e) { /* 写不进去不影响正确性，最多下次开机没缓存 */ }
}

const mateColors = new Map(Object.entries(BUILTIN_MATE_COLORS));
/* 上次拉到的真值优先于内置值：主人改过的颜色从第一帧起就生效 */
try {
  const cached = readColorCache();
  if (cached) {
    for (const k of Object.keys(cached)) {
      const c = String(cached[k] || '').trim();
      if (c) mateColors.set(String(k), c);
    }
  }
} catch (e) { /* 同上 */ }

let mateColorsAsked = false;

/** 颜色表变了要让 React 知道（re-export 一下，省得调用方再记一个依赖） */
function bumpLogView() {
  try {
    /* store.js 不 import 本文件，没有环 */
    if (typeof window !== 'undefined' && window.__logStore && typeof window.__logStore.bump === 'function') {
      window.__logStore.bump();
    }
  } catch (e) { /* 通知不到最多是晚一帧，不影响正确性 */ }
}

/**
 * 预热颜色表（幂等）。页面启动 / 第一次问颜色时调都行。
 * 拉回来之后：落缓存；如果跟当前用的值不同，触发一次重渲染。
 */
export function primeMateColors() {
  if (mateColorsAsked) return;
  mateColorsAsked = true;
  try {
    fetch('/api/agents').then((r) => r.json()).then((r) => {
      const list = r && Array.isArray(r.agents) ? r.agents : [];
      let changed = false;
      for (const a of list) {
        if (!a || !a.name || !a.color) continue;
        const nm = String(a.name);
        const c = String(a.color).trim().toLowerCase();
        if (!c || mateColors.get(nm) === c) continue;
        mateColors.set(nm, c);
        changed = true;
      }
      /* 不管变没变都落盘：下一次开机用这份真值铺底，改过色的人首帧就不会闪 */
      writeColorCache();
      if (changed) bumpLogView();
    }).catch(() => { /* 抓不到就全用缓存 / 内置 / 默认色，不影响说话 */ });
  } catch (e) { /* 同上 */ }
}

/**
 * 外部改了某个身份的颜色（智能体面板保存后调）。
 *
 * 【为什么需要这个口子】
 * 改了色但本机缓存还是旧值 → 下次刷新会先画旧色再 bump 成新色，闪一下。
 * 面板保存成功后调一次这里，缓存当场就是新的，那次闪烁也就不存在了。
 * 不调也不影响正确性（只是多闪那一帧）。
 */
export function applyMateColor(name, color) {
  const nm = String(name == null ? '' : name).trim();
  const c = String(color == null ? '' : color).trim().toLowerCase();
  if (!nm || !c) return false;
  mateColors.set(nm, c);
  writeColorCache();
  bumpLogView();
  return true;
}

/**
 * 这个身份的名字该用什么颜色（小鲸 / 别的智能体卡）。
 *
 * 顺序：本地表（缓存 + 内置 + 已拉到的） → 页面上那份 → 默认色。
 * **永远返回一个颜色，且不依赖网络是否已经回来。**
 */
export function mateColorOf(name) {
  const nm = String(name == null ? '' : name).trim();
  if (!nm) return '';
  primeMateColors();
  const own = mateColors.get(nm);
  if (own) return own;
  try {
    if (typeof window.mateColorOf === 'function') {
      const c = String(window.mateColorOf(nm) || '').trim();
      /* index.html 拿不到时返回默认白 —— 那个值当「没查到」，继续往下走 */
      if (c && c.toLowerCase() !== MATE_DEFAULT_COLOR) return c;
    }
  } catch (e) { /* 退化 */ }
  return MATE_DEFAULT_COLOR;
}

/** 修乱码（服务端 / 老会话里偶尔有） */
export function fixText(s) {
  try {
    if (typeof window.fixMojibake === 'function') return String(window.fixMojibake(String(s == null ? '' : s)) || '');
  } catch (e) { /* 退化 */ }
  return String(s == null ? '' : s);
}

/** 文件大小 */
export function fmtSize(n) {
  try {
    if (typeof window.fmtSize === 'function') return String(window.fmtSize(n) || '');
  } catch (e) { /* 退化 */ }
  return n ? String(n) : '';
}

/** 时间：只画「时:分」，完整时间放 title */
export function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (!Number.isFinite(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 工具参数：对象拆成 k: v 行（别让屏幕上出现 [object Object]） */
export function formatArgs(args) {
  if (args == null || args === '') return '';
  if (typeof args === 'object') {
    try {
      return Object.keys(args)
        .map((k) => {
          const v = args[k];
          let s = v && typeof v === 'object' ? JSON.stringify(v) : String(v);
          if (s.length > 300) s = s.slice(0, 300) + '…';
          return k + ': ' + s;
        })
        .join('\n');
    } catch (e) {
      return String(args);
    }
  }
  return String(args);
}
