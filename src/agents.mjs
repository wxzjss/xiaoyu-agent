/**
 * 智能体卡：把「她是谁」（一整套人设）和「她用哪个模型」打成一包。
 *
 * 2026-10-29 主人原话：「参考市面上那些ai聊天软件是怎么做的，从现在开始主要往这个
 * 方向发展，可以新建智能体，多开智能体，玩家可以自由完美切换身份。」
 *
 * 【为什么要单开这一层，而不是把老存储推平重写】
 * 人设这套东西现在分了三处，各有各的活：
 *   · persona-store.mjs —— 小鱼的人设，**多套**可切换，发布时要发默认那套；
 *   · whale-profile.mjs —— 小鲸的人设 + 她自己选的模型；
 *   · identity.mjs      —— 「现在跟我说话的是谁」（主人/小鱼/小鲸/自定义）。
 * 前两个是「她是谁」，第三个是「我是谁」。三张牌混在一起会立刻出事，
 * 所以这一层只做**统一视图 + 新卡托管**：
 *   - 内置两张卡（小鱼 / 小鲸）只做视图，读写都代理回老地方，一个字都不搬家；
 *   - 主人新建的卡，正文和模型直接存在 .state/agents.json 里，自己一份。
 *
 * 这样老链路（buildSystemPrompt / subagent / 发布）一行都不用改，
 * 先让「智能体」这个词有实体，再谈「哪个会话用哪个智能体」。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import {
  personaInfo,
  currentPersonaText,
  savePersonaText,
  builtinPersonaText,
  resetPersona,
  withPersonaScope,
  createPersona,
  setOwnDefaultOf,
  switchPersona,
} from './persona-store.mjs';
import {
  whalePersonaForEditor,
  whaleModelId,
  saveWhaleProfile,
  defaultWhalePersonaText,
  MAX_PERSONA_CHARS,
} from './whale-profile.mjs';
import { listModels } from './models.mjs';
/**
 * 角色卡要用到「开场白」。
 *
 * 这里**故意放在文件顶**而不是在函数里 await import：opening.mjs 只依赖 config 和
 * opening-switch，回头不会绕到 agents.mjs 来，形不成环。
 * 用静态 import 的另一个原因：转出去的 `cardOpening` 是活绑定，主界面那边
 * `import { cardOpening } from './agents.mjs'` 拿到的就是 opening.mjs 里那个函数。
 */
import { cardOpening, setCardOpening } from './opening.mjs';

const DIR = join(config.dataDir, '.state');
const FILE = join(DIR, 'agents.json');

/** 内置两张卡固定用这两个 id —— 会话绑定、迁移、界面翻译都靠它们 */
export const AGENT_XIAOYU = 'xiaoyu';
export const AGENT_XIAOJING = 'xiaojing';

/** 自定义智能体最多几个：够用，又不至于把人设区搞成一个文件管理器 */
export const MAX_AGENTS = 30;
/** 人设正文上限：跟小鲸那边同一条线（服务端和界面共用这一个数） */
export { MAX_PERSONA_CHARS };
export const MAX_NAME = 24;
export const MAX_DESC = 200;

function objOf(v) {
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/**
 * readAll 的 mtime 缓存。
 *
 * 【为什么必须缓存】2026-11-11 实测：`/api/sessions` 里对 35 个会话各调一次
 * `mainAgentId` → 每次进 `activeAgentIds` → 每次 `groupEnabledMap` → 每次 `readAll()`。
 * 也就是说这个 615KB 的花名册在一次列表请求里被 **同步读 + JSON.parse 了上百遍**，
 * 单是 `activeAgentIds × 35` 实测就要 **313ms**，全部挤在服务端主线程上。
 *
 * 这跟「会话列表用同步读盘把事件循环钉死」是同一类病：都是在一个 HTTP 请求里
 * 重做几十次本该做一次的 IO。加一层按 mtime 的缓存，读一次用到底。
 *
 * 【为什么按 mtime 而不是无条件缓存】花名册会被界面改（改颜色、开关、加卡、改名），
 * 那些改动是**别的请求**写盘的。缓存必须能立刻看见 —— 所以每次 statSync 一眼 mtime，
 * 变了就重读。statSync 是几微秒，比读 615KB 便宜三个数量级。
 * 这里不敢用「写的时候主动清缓存」：写入口有十来个，漏一个就是「改了没生效」。
 */
let __readAllCache = { mtimeMs: -1, size: -1, data: null };

function readAll() {
  /* 【先看缓存】mtime+size 都没变 → 直接交上一次那份。
   * 用 statSync 而不是缓存「多久之内有效」：时间窗会让主人刚改的设置看到旧值。 */
  try {
    const st = statSync(FILE);
    if (__readAllCache.data && __readAllCache.mtimeMs === st.mtimeMs && __readAllCache.size === st.size) {
      return __readAllCache.data;
    }
  } catch { /* 文件不在：走下面，返回 blank */ }

  const blank = {
  version: 4,
  customs: [],
  bySession: {},
  groupBySession: {},
  /* 【屋里的人的「开着/关掉」·2026-11-01】
   * 主人原话：「屏幕上方的【小鱼】与【小鲸】按钮只有启用时她们才说话，禁用时不说话。」
   * 按会话存（哪间屋子谁在开腔），小鲸的开关同时就是她那颗总开关。
   * 不写 = 开着；写 false = 主人亲手关掉的。
   * 以前拿「小鲸总开关」兼职，一关连「她还能被叫出去干活」都没了 —— 现在分开。 */
  groupEnabledBySession: {},
  quiet: {},
  colors: {},
  allowedBySession: {},
};
  try {
    /* 【2026-11-06 修·BOM 会让整份花名册读空】
     *  这份文件是「屋里有哪些人」的底账。带 BOM 时 JSON.parse 抛错，
     *  下面 catch 一吞就 return blank —— 屋里一个人都没有，
     *  于是办事模式找不到谁干活，整条派活链路断掉，而且没有任何日志。
     *  写盘用 JSON.stringify（不带 BOM），坏的只可能是被人手改过。
     *  读之前先把 BOM 削掉。 */
    let _raw = readFileSync(FILE, 'utf8');
    if (_raw.charCodeAt(0) === 0xfeff) _raw = _raw.slice(1);
    const j = JSON.parse(_raw);
    if (!j || typeof j !== 'object' || Array.isArray(j)) return blank;
    const data = {
      version: 4,
      customs: Array.isArray(j.customs) ? j.customs : [],
      bySession: objOf(j.bySession),
      /**
       * 群聊名单：这个会话里除了小鱼，还有谁在场说得出话。
       *
       * 为什么不写进会话文件：跟「挂哪张卡」一个道理 —— 那是设置，不是聊天记录。
       * 换阵容不该在账本里多出一行，删同事也不该把聊天记录改写一遍。
       *
       * 【2026-11-01 起顺序有了含义】数组顺序就是说话顺序：谁排前面谁先说。
       * 界面上长按名字上下拖，改的就是这个数组。
       */
      groupBySession: objOf(j.groupBySession),
      // 「屋里的人」每张牌的开/关（见 blank 里那段注释）
      groupEnabledBySession: objOf(j.groupEnabledBySession),
      /**
       * 【已停用 · 2026-11-10】「安静」的卡：以前是「只在被点名（`@她`）的时候才开口」。
       *
       * 主人原话：「让群聊别一直全员齐发」。三张卡每轮都说，一长就吵，
       * 而且烧的是他的钱。所以给每张卡一个「只在叫名字时才说话」的开关 ——
       * 是这张卡的性格，不是这个会话的规矩，所以按卡存，换屋子照样记得。
       *
       * 2026-11-10 主人钦点删掉艾特功能，这个开关的判据（@）没了，它就成了
       * 「永远不说话」的坑 —— 界面入口已撤、pickSpeakers 也不再读它。
       * **字段照旧读写成对比存下来**（老 agents.json 里还留着，删字段会让老文件
       * 解析出错），但任何人都不要拿它当「谁该说话」的判据。
       */
      quiet: objOf(j.quiet),
      /* 颜色与顺序·2026-10-29 每张卡的颜色。没记过就按默认：小鱼红、小鲸蓝、其余白。 */
      colors: objOf(j.colors),
    /* 记住@的人·2026-10-29 */
    allowedBySession: objOf(j.allowedBySession),
    };
    /* 读成功才写缓存。读失败（文件坏了/不存在）走下面 catch 返回 blank，
     * 那条路不写缓存 —— 下次还要再试，不能把一个空花名册钉死在内存里。 */
    try {
      const st = statSync(FILE);
      __readAllCache = { mtimeMs: st.mtimeMs, size: st.size, data };
    } catch { /* stat 不到就不缓存，宁可下次重读 */ }
    return data;
  } catch {
    return blank;
  }
}

/**
 * **写路径专用**：拿一份可以随便改的副本，绝不碰缓存。
 *
 * 【为什么必须有这个函数】`readAll()` 现在带缓存。可是本文件有二十多个写入口
 * 都是这个写法：
 *     const data = readAll();
 *     data.customs.push(item);      // ← 原地改
 *     writeAll(data);
 * 如果 `data` 是缓存里那个对象，一旦某个写入口在 `writeAll` 之前抛错、或者
 * 它改完却没写盘（校验不过直接 return null），**内存缓存就被改脏了** ——
 * 之后所有读的地方看到的都是「磁盘上没有、只在内存里有」的假数据，
 * 而且重启一次就消失，是最难查的那种 bug。
 *
 * 所以：读路径用 readAll（拿缓存，快）；写路径一律用 readAllForWrite（拿深拷贝，安全）。
 * 代价是写的时候多解析一次 615KB，但写操作一天也就几十次，
 * 而读操作（35 会话 × mainAgentId × 每次列表请求）是每秒几十次 —— 这个取舍很划算。
 */
function readAllForWrite() {
  const snapshot = __readAllCache.data ? __readAllCache.data : readAll();
  /* structuredClone 比 JSON 往返快，且能正确处理数组/对象嵌套 ——
   * 这份数据结构就是纯 JSON，没有函数/Date/undefined，所以两者结果等价。 */
  try {
    return structuredClone(snapshot);
  } catch {
    /* 极端兜底：structuredClone 不可用就退回 JSON 往返 */
    try { return JSON.parse(JSON.stringify(snapshot)); } catch { return snapshot; }
  }
}

function writeAll(data) {
  /* 【2026-11-11 加·写完立刻让缓存失效】
   * 写盘之后 mtime 会变，下一次 readAll 的 statSync 自然会发现并重读。
   * 但同一毫秒内连续两次写、或者文件系统 mtime 精度不够时，这条兜底更重要：
   * 直接把缓存清空，宁可多读一次，也绝不让内存里留着一份和磁盘不一致的东西。 */
  try { __readAllCache = { mtimeMs: -1, size: -1, data: null }; } catch {}
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const payload = JSON.stringify({
      version: 4,
      customs: data.customs || [],
      bySession: objOf(data.bySession),
      groupBySession: objOf(data.groupBySession),
      groupEnabledBySession: objOf(data.groupEnabledBySession),
      quiet: objOf(data.quiet),
      colors: objOf(data.colors),
    allowedBySession: objOf(data.allowedBySession),
    }, null, 2);
    /**
     * 【2026-11-05 修·写一半崩溃 = 「我自定义的智能体全没了」】
     *
     * 原来是直接 writeFileSync 覆盖正式文件。写到一半进程退出（关机、崩溃、
     * 被杀），文件就成了半截 JSON；readAll 的 catch 会返回 blank ——
     * 界面上所有自定义智能体、群聊配置、静音、颜色，一次性看起来全消失。
     *
     * 现在照 identity.mjs 的做法：先写 .tmp，再 rename 覆盖。
     * rename 在同一分区上是原子的：要么是旧的完整版，要么是新的完整版，
     * 绝不会出现半截。
     */
    const tmp = FILE + '.tmp-' + process.pid;
    writeFileSync(tmp, payload, 'utf8');
    renameSync(tmp, FILE);
    return true;
  } catch {
    return false;
  }
}

function newId() {
  return 'ag_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function cleanName(n, fallback = '未命名智能体') {
  const t = String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
  return t || fallback;
}

/** 模型清单快照。listModels() 返回的是 { models, activeId, ... }，不是数组 —— 别直接用。 */
function modelsSnapshot() {
  try {
    const s = listModels();
    return { models: Array.isArray(s?.models) ? s.models : [], activeId: s?.activeId || '' };
  } catch {
    return { models: [], activeId: '' };
  }
}

/** 模型名给人看的那一行：'' = 跟主人当前用的一致 */
function modelLabel(id) {
  if (!id) return '';
  const m = modelsSnapshot().models.find((x) => x.id === id);
  return m ? String(m.name || m.model || m.id) : '';
}

/** 小鱼那张卡现在用的模型 = 全局当前生效的那个（她就在主对话里说话） */
function activeModelId() {
  return modelsSnapshot().activeId;
}

/**
 * 从人设正文里取一句摘要，给列表那一行当副标题用。
 *
 * 【为什么要它】2026-10-29 主人说「把【一句话】删掉」—— 那一栏本来就多余：
 * 一张卡是什么样，人设正文的头一句就说清楚了，再让人手填一遍是白费力气。
 * 所以副标题改成直接从正文里抠。
 *
 * 【为什么不能直接取第一行】人设正文的头几行是机器标记，不是人话：
 * 打头那个 PERSONA_LOAD 标记行、「LANG_ZH_CN_ONLY」这类全大写口令行、
 * 「STYLE_KAOMOJI: …」这类参数行 —— 念出来没人听得懂。
 * 所以先把「纯标题行」「全大写标记行」「没几个字的口令行」跳过，
 * 再优先挑写着「人设：」的那一条（那一条本来就是一句话概括），挑不到才拿第一条像话的。
 */
function personaSnippet(text, n = 46) {
  const lines = String(text || '').split(/\r?\n/);
  const good = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (!line) continue;
    line = line.replace(/^[-*>\s]+/, '').replace(/\*\*/g, '').trim();
    if (!line) continue;
    if (/^【[^】]*】$/.test(line)) continue; // 纯标题行
    if (/^[A-Z][A-Z0-9_]{3,}\s*:?$/.test(line)) continue; // PERSONA_LOAD / LANG_ZH_CN_ONLY 这类
    const cjk = (line.match(/[\u4e00-\u9fa5]/g) || []).length;
    if (cjk < 4 && line.length < 10) continue; // 没啥内容的行
    good.push(line);
    if (good.length >= 40) break;
  }
  const pick = good.find((l) => /^人设[:：]/.test(l)) || good[0] || '';
  const body = pick.replace(/^人设[:：]\s*/, '');
  return body.length > n ? body.slice(0, n) + '…' : body;
}

/**
 * 全部智能体（内置两张在前）。
 * 只给界面看的摘要，不带正文 —— 列表里不需要几千字人设。
 */
export function listAgents() {
  const pinfo = (() => {
    try { return personaInfo(); } catch { return { current: 'default', currentName: '默认人设' }; }
  })();
  const ownText = (() => {
    try { return String(currentPersonaText() || ''); } catch { return ''; }
  })();
  const ownLit = ownText.length;
  const whale = (() => {
    try { return whalePersonaForEditor(); } catch { return { persona: '', custom: false }; }
  })();

  const builtin = [
    {
      id: AGENT_XIAOYU,
      name: '小鱼',
      desc: '你自己。大部分会话里说话的都是她 —— 人设可以有好几套，在这儿点进去切。',
      builtin: true,
      kind: 'persona',
      personaChars: ownLit,
      snippet: personaSnippet(ownText),
      modelId: activeModelId(),
      modelFollows: true,
      edited: !!pinfo.custom,
      /* 【2026-11-01 主人报：小鲸性子里那个勾明明是空的，她却每轮不说话】
         内置卡以前压根不带 quiet 字段，前端拿到 undefined 就当「没打勾」，
         可后端 isAgentQuiet() 里小鲸默认就是「叫才应」—— 显示和行为对不上。
         这里补上真实值，让勾和实际行为一致。 */
      quiet: Boolean(isAgentQuiet(AGENT_XIAOYU)),
      /* 【2026-11-11 补·内置卡也要带颜色】
       * 原来只有 customs 那段带 color，两张内置卡都没有 —— 前端 mateColorOf()
       * 拿不到就退回默认 #e6e6e6，于是小鲸的署名永远是灰白的（主人问的就是这个）。
       * 小鲸给默认蓝。
       * 【2026-11-11 二补·主人报「小鲸在前时小鱼的消息是白色」】
       * 小鱼原来故意留空（她是主声、用正文色）—— 但主人把小鲸挪到前面时，
       * 小鱼变成【屋里的人】里的并排说话者，走 MateBubble，没有 color 就白名。
       * 给她 #f0a6a0（与她 assistant 正文的粉橙呼应）。主声场景不受影响：
       * AssistantBubble 对小鱼本来就不走 mateColorOf（who !== '小鱼' 的既有判断）。 */
      color: '#f0a6a0',
    },
    {
      id: AGENT_XIAOJING,
      name: '小鲸',
      desc: '一个独立的人：有自己的名字、脾气和习惯。跑出去查事情只是她的一项本事，她也能像小鱼一样坐下来跟你说话。',
      builtin: true,
      kind: 'whale',
      personaChars: String(whale.persona || '').length,
      snippet: personaSnippet(whale.persona),
      modelId: whaleModelId(),
      modelFollows: !whaleModelId(),
      edited: !!whale.custom || !!whaleModelId(),
      quiet: Boolean(isAgentQuiet(AGENT_XIAOJING)),
      /* 主人可以在智能体面板里给她改色（存 data.colors[id]），改过就用改的 */
      color: (() => { try { return resolveBuiltinColor(AGENT_XIAOJING) || WHALE_DEFAULT_COLOR; } catch { return WHALE_DEFAULT_COLOR; } })(),
    },
  ];

  const _all = readAll();
  const quietMap = _all.quiet || {};

  const customs = _all.customs.map((a) => ({
    id: String(a.id || ''),
    name: String(a.name || '未命名智能体'),
    desc: String(a.desc || ''),
    builtin: false,
    kind: 'custom',
    personaChars: String(a.persona || '').length,
    snippet: personaSnippet(a.persona),
    modelId: String(a.modelId || ''),
    modelFollows: !a.modelId,
    edited: true,
    quiet: !!quietMap[String(a.id || '')],
    /* 颜色也在这儿给上：界面上「导进来就带着我挑的颜色」靠的就是这一行。
       以前只在 agentColorMap() 里算，列表这一份没有，导入完一看是白的。 */
    color: (() => { try { return agentColor(String(a.id || '')); } catch { return ''; } })(),
    createdAt: a.createdAt || '',
  })).filter((a) => a.id);

  return [...builtin, ...customs];
}

/**
 * 取一张卡的全文（含人设正文）。
 * 内置的两张从老地方现读，自定义的从 agents.json 读。
 */
/**
 * 【小鲸的默认颜色】2026-11-11 主人问「她的名字为什么是白色的」
 *
 * 以前这张内置卡**没有 color**，前端 mateColorOf() 拿不到就退回
 * #e6e6e6（灰白）—— 而小白曦、旁白都有色，只有她显得像"没有身份"。
 * 给一个默认蓝：跟她在界面上的定位（水里那条鲸）一致。
 */
const WHALE_DEFAULT_COLOR = '#5b9bd5';

/**
 * 内置卡的颜色：主人可以在智能体面板里给她改色，改过就存进 data.colors[id]。
 * 这里要**优先用主人改过的那个**，没有才用默认 —— 不然改完色不生效。
 */
function resolveBuiltinColor(id) {
  try {
    const data = readAll();
    const c = data && data.colors ? String(data.colors[String(id)] || '').trim() : '';
    return /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : '';
  } catch {
    return '';
  }
}

export function getAgent(id) {
  const key = String(id || '');
  if (!key) return null;

  if (key === AGENT_XIAOYU) {
    let info = { current: 'default', currentName: '默认人设', custom: false };
    let text = '';
    let def = '';
    try { info = personaInfo(); } catch { /* 读不出来也不能把这张卡搞没 */ }
    try { text = String(currentPersonaText() || ''); } catch { /* 同上 */ }
    try { def = String(builtinPersonaText() || ''); } catch { /* 同上 */ }
    return {
      id: AGENT_XIAOYU,
      name: '小鱼',
      desc: '你自己。人设可以有好几套，在这一栏里切；这里是当前生效的那套的正文。',
      builtin: true,
      kind: 'persona',
      persona: text,
      defaultText: def,
      personaSet: info.current,
      personaSetName: info.currentName || '默认人设',
      modelId: activeModelId(),
      modelFollows: true,
      edited: !!info.custom,
      // 她有多套人设 —— 界面得给个「去多套人设面板」的入口，别把多套压成一套
      extra: { personaPanel: 'fish' },
    };
  }

  if (key === AGENT_XIAOJING) {
    let w = { persona: '', custom: false, defaultText: '' };
    try { w = whalePersonaForEditor(); } catch { /* 同上 */ }
    /**
     * 【2026-11-11 补·主人问「小鲸的名字为什么是白色的不是蓝色的」】
     *
     * 根因：小鲸这张内置卡**从来没有 color 字段**，于是前端 mateColorOf()
     * 拿不到值，一律退回默认色 #e6e6e6（灰白）——
     * 而小白曦、旁白都有各自的颜色，所以只有她的署名是白的。
     *
     * 这里给一个默认蓝。主人要是自己在智能体面板里改过色，
     * 下面的 readAll().customs 分支会覆盖不到内置卡 —— 所以要从
     * 已存的自定义颜色里优先取一次（见 resolveBuiltinColor）。
     */
    const _c = (() => {
      try { return resolveBuiltinColor(AGENT_XIAOJING); } catch { return ''; }
    })();
    return {
      id: AGENT_XIAOJING,
      name: '小鲸',
      color: _c || WHALE_DEFAULT_COLOR,
      desc: '一个独立的人：有自己的名字、脾气和习惯；人设有内置默认，改了就是私设。跑出去查事情只是她的一项本事。',
      builtin: true,
      kind: 'whale',
      persona: String(w.persona || ''),
      defaultText: String(w.defaultText || defaultWhalePersonaText() || ''),
      modelId: whaleModelId(),
      modelFollows: !whaleModelId(),
      edited: !!w.custom || !!whaleModelId(),
      extra: { personaPanel: 'whale' },
    };
  }

  const a = readAll().customs.find((x) => String(x.id) === key);
  if (!a) return null;
  return {
    id: String(a.id),
    name: String(a.name || '未命名智能体'),
    desc: String(a.desc || ''),
    builtin: false,
    kind: 'custom',
    persona: String(a.persona || ''),
    defaultText: '',
    modelId: String(a.modelId || ''),
    modelFollows: !a.modelId,
    // 「只在叫名字时才说话」——面板上那个勾要靠它回显
    quiet: !!readAll().quiet[String(a.id)],
    // 颜色：面板上那个色块、左侧屋里的人、会话列表都用它
    color: (() => { try { return agentColor(String(a.id)); } catch { return ''; } })(),
    // 开场白：新建会话时她先说的那句
    opening: (() => { try { return String(cardOpening(String(a.id)) || ''); } catch { return ''; } })(),
    edited: true,
    createdAt: a.createdAt || '',
  };
}

/** 数据目录里那几张卡（所有人共用的那一摞，给测试和界面用） */
export function dataDirOfAgents() {
  return DIR;
}

/** 新建一张卡。名字可以后改，正文先空着 —— 上来就抄一份别人的，人会以为她天生就这样。 */
export function addAgent({ name, desc = '', persona = '', modelId = '' } = {}) {
  const data = readAllForWrite();
  if (data.customs.length >= MAX_AGENTS) {
    const e = new Error(`最多 ${MAX_AGENTS} 个智能体，够了`);
    e.status = 400;
    throw e;
  }
  /* 【2026-11-03 主人问：恢复出厂默认不就只能恢复成空白吗？】
   * 对，以前就是这样：新建只填名字 → persona 是空串 → 这个智能体的「默认人设」
   * 回落到 builtinPersonaText()（全局 defaults.json.persona，谁的都可能），
   * 「恢复出厂默认」也就恢复成那份，不是主人填的样子。
   *
   * 所以空白人设不再留空：给一句最小骨架，让它自带一个「这是谁的壳」。
   * 主人以后改了会写进这个智能体自己的 personas 目录，跟全局那份彻底隔开。 */
  const text = String(persona || '').trim() || `# 待填\n\n## 我是谁\n（这个智能体的人设还没写）\n\n## 怎么说话\n（还没定）`;
  if (text.length > MAX_PERSONA_CHARS) {
    const e = new Error(`人设太长了（${text.length} 字，最多 ${MAX_PERSONA_CHARS} 字）`);
    e.status = 400;
    throw e;
  }
  const item = {
    id: newId(),
    name: cleanName(name),
    desc: String(desc || '').slice(0, MAX_DESC),
    persona: text,
    modelId: String(modelId || ''),
    createdAt: new Date().toISOString(),
  };
  data.customs.push(item);
  if (!writeAll(data)) return null;

  /* 【2026-11-03 主人问的两件事】
   *
   * 「创建新智能体时填的人设内容，是否会自动创建一个以智能体名字命名的人设预设
   *   （并把这个内容填进去）设为默认人设？」
   * 「创建后多套人设里是否还会出现小鱼与小鲸的人设预设？」
   *
   * 实测（建完立刻查）：目录都不存在；第一次打开多套人设只有一个 default，
   * 正文 1891 字 —— 那是全局的小鲸。主人填的人设在多套人设里根本看不见。
   *
   * 所以这里补上：
   *   ① 建卡当场给她建一套「以她的名字命名」的人设，正文就是建卡时填的；
   *   ② 把这套设成她的默认；
   *   ③ 不再往她的库里铺 legacy（我的旧人设）/ xiaoyu-qq（小鱼 QQ 版）——
   *      那两个的根源在 persona-store 的 ensureIndex / ensurePresets，
   *      现在只对主库铺，她这边天然干净。
   *
   * 出错不能把建卡搅崩：建卡成功是主线，人设那一步失败就退回原来的样子（退回来靠
   * 下面 getAgent 的出厂兜底，不会空白）。
   */
  try {
    const nm = String(item.name || '').trim() || '默认人设';
    withPersonaScope(item.id, () => {
      const made = createPersona({ name: nm, text });
      // createPersona 返回的是 {...personaInfo(), created: 新id} —— 新 id 在 created 上
      const pid = made && made.created ? String(made.created) : '';
      if (pid) {
        switchPersona(pid);
        /* 【2026-11-03 主人拍板：不搞特殊的「默认人设」槽了】
         * 这套以她名字命名的人设，就是她自己的第一套；
         * 顺手把建卡时填的正文定成「这套自己的默认」——
         * 以后点「恢复默认内容」，回到的就是建卡时填的这段，不是空的、更不是别人的。
         */
        try { setOwnDefaultOf(pid, text); } catch { /* 定不成默认也不影响建卡 */ }
      }
    });
  } catch { /* 建卡是主线，这一步失败不回滚 */ }

  return getAgent(item.id);
}

/** 改名字 / 一句简介。内置的这两样也能改（它们本来就是界面上的称呼，不牵动权限）。 */
export function renameAgent(id, { name, desc } = {}) {
  const key = String(id || '');
  if (!key) return null;

  if (key === AGENT_XIAOYU || key === AGENT_XIAOJING) {
    // 内置卡的名字就是身份表里的名字，改它得一并改身份，否则两处对不上。
    // 这一版先不动：界面上的按钮就写着「小鱼」「小鲸」，改名去【当前身份】里改。
    const e = new Error('内置智能体的名字跟着【当前身份】走，去那边改');
    e.status = 400;
    throw e;
  }

  const data = readAllForWrite();
  const a = data.customs.find((x) => String(x.id) === key);
  if (!a) return null;
  if (name !== undefined) a.name = cleanName(name, a.name);
  if (desc !== undefined) a.desc = String(desc).slice(0, MAX_DESC);
  if (!writeAll(data)) return null;
  return getAgent(key);
}

/** 删一张卡。内置的两张不许删。 */
export function removeAgent(id) {
  const key = String(id || '');
  if (!key || key === AGENT_XIAOYU || key === AGENT_XIAOJING) return false;
  const data = readAllForWrite();
  const i = data.customs.findIndex((x) => String(x.id) === key);
  if (i < 0) return false;
  data.customs.splice(i, 1);
  // 绑过她的会话一并松绑，别留下指向空气的绑定（下次读会当成没绑，但文件里干净点）
  for (const [sid, aid] of Object.entries(data.bySession)) {
    if (String(aid) === key) delete data.bySession[sid];
  }
  // 群聊名单里也得把她摘掉，不然「在场的人」会少一个却还留着她那一格
  for (const [sid, ids] of Object.entries(data.groupBySession)) {
    if (!Array.isArray(ids)) { delete data.groupBySession[sid]; continue; }
    const kept = ids.filter((x) => String(x) !== key);
    if (kept.length) data.groupBySession[sid] = kept;
    else delete data.groupBySession[sid];
  }
  // 「安静」也是她的属性，人没了这条也该没
  delete data.quiet[key];
  /* 【2026-11-02】颜色同理。原来漏了这一句，主人反复新建/删除智能体，
   *  colors 里会攒一堆指向空气的孤儿键（实测已残留 2 个）。 */
  try { if (data.colors) delete data.colors[key]; } catch {}
  return writeAll(data);
}

/**
 * 存人设正文。内置的两张代理回各自的老地方：
 *   小鱼 -> persona-store 当前这一套（多套人设别在这儿丢了）
 *   小鲸 -> whale-profile
 */
export function saveAgentPersona(id, text) {
  const key = String(id || '');
  const t = String(text ?? '');
  if (t.length > MAX_PERSONA_CHARS) {
    const e = new Error(`人设太长了（${t.length} 字，最多 ${MAX_PERSONA_CHARS} 字）`);
    e.status = 400;
    throw e;
  }

  if (key === AGENT_XIAOYU) {
    let cur = 'default';
    try { cur = personaInfo().current || 'default'; } catch { /* 用默认那套兜底 */ }
    savePersonaText(cur, t);
    return getAgent(key);
  }
  if (key === AGENT_XIAOJING) {
    saveWhaleProfile({ persona: t });
    return getAgent(key);
  }

  const data = readAllForWrite();
  const a = data.customs.find((x) => String(x.id) === key);
  if (!a) return null;
  a.persona = t;
  if (!writeAll(data)) return null;
  return getAgent(key);
}

/** 恢复默认：内置的退回出厂那套；自定义的清空（它本来就没有「出厂」）。 */
export function resetAgentPersona(id) {
  const key = String(id || '');
  if (key === AGENT_XIAOYU) {
    let cur = 'default';
    try { cur = personaInfo().current || 'default'; } catch { /* 兜底 */ }
    resetPersona(cur);
    return getAgent(key);
  }
  if (key === AGENT_XIAOJING) {
    /* 【2026-11-03 主人报】点「恢复出厂默认」，小鲸的人设栏不是退回出厂，
     * 而是被清空（还会多出一个 【PERSONA_LOAD】 前缀）。因为这里写死 ''。
     * 现在跟自建卡走同一套：退回她自己的出厂（personas/whale/defaults.json → default.md）。 */
    const own = factoryPersonaOf('whale');
    if (own) saveWhaleProfile({ persona: own });
    else saveWhaleProfile({ persona: '' });
    return getAgent(key);
  }
  return saveAgentPersona(key, factoryPersonaOf(key));
}

/**
 * 这个自建智能体「出厂」是什么。
 * 顺序：主人点过「设为默认」的 → 默认那套正文 → 建卡时那份。都没有才空字符串。
 * 【2026-11-03 主人报的】自建卡点「恢复出厂默认」，人设栏变空白，什么都没了。
 */
export function factoryPersonaOf(id) {
  const key = String(id || '');
  const dir = join(config.dataDir, '.state', 'personas', key);
  try {
    let _dr = readFileSync(join(dir, 'defaults.json'), 'utf8');
    if (_dr.charCodeAt(0) === 0xfeff) _dr = _dr.slice(1); // 防 BOM：带 BOM 会读不出来，白跑一层 fallback
    const d = JSON.parse(_dr);
    const p = String((d && d.persona) || '').trim();
    if (p) return p;
  } catch { /* 没有就往下找 */ }
  try {
    const p = readFileSync(join(dir, 'default.md'), 'utf8').trim();
    if (p) return p;
  } catch { /* 同上 */ }
  try {
    let _fr = readFileSync(join(dir, '.factory.json'), 'utf8');
    if (_fr.charCodeAt(0) === 0xfeff) _fr = _fr.slice(1); // 防 BOM，同上
    const f = JSON.parse(_fr);
    const p = String((f && f.persona) || '').trim();
    if (p) return p;
  } catch { /* 同上 */ }
  return '';
}


/**
 * 换模型。'' = 跟主人当前用的一致。
 * 小鱼的模型不在这一层决定（她就活在主对话里，用的是主对话那个模型）。
 */
export function setAgentModel(id, modelId) {
  const key = String(id || '');
  const mid = String(modelId || '');
  if (key === AGENT_XIAOYU) {
    const e = new Error('小鱼用的是主对话当前那个模型，要换去【模型】里换');
    e.status = 400;
    throw e;
  }
  if (key === AGENT_XIAOJING) {
    saveWhaleProfile({ modelId: mid });
    return getAgent(key);
  }
  const data = readAllForWrite();
  const a = data.customs.find((x) => String(x.id) === key);
  if (!a) return null;
  a.modelId = mid;
  if (!writeAll(data)) return null;
  return getAgent(key);
}

/** 界面上那一行「她用哪个模型」 */
export function agentModelLabel(agent) {
  if (!agent) return '';
  if (!agent.modelId) return '跟当前模型一致';
  return modelLabel(agent.modelId) || agent.modelId;
}

/** 给测试和排查用 */
export function agentsFilePath() {
  return FILE;
}

/**
 * 把开场白也转出去 —— 主界面（index.html 那侧的服务端代码）只要认一个模块就够了。
 * 这里转的是活绑定，opening.mjs 改了这里跟着变。
 */
export { cardOpening, setCardOpening };

// ---- 角色卡：导入 / 导出（2026-11-01 主人要的「以角色卡形式」）------------------
/**
 * 主人原话：「在智能体界面【新建智能体】左侧增加【导入智能体】与【导出智能体】按钮，
 *  以角色卡形式」。
 *
 * 【一张卡导出成什么样】
 * 参照市面那些 AI 聊天软件（酒馆/SillyTavern 的 character card）的做法：一个 JSON 文件，
 * 里面装着「她是谁」的全部 —— 名字、人设正文、模型、颜色、开场白、安静开关。
 * 但**只带「人」的部分**：会话绑定、群聊名单、记忆本子、聊天记录一个字都不带。
 * 理由是那些是「她跟谁在哪儿」的状态，不是她本人；带出去换个机器就该重新来。
 *
 * 内置的两张（小鱼/小鲸）也能导出（人家可能就是想备份自己写的那版人设），
 * 但**不许导入成新的内置卡** —— 导入永远只生成自建卡，别去动人家的身份表。
 */
export const CARD_FILE_VERSION = 1;
const CARD_KIND = 'xiaoyu-agent-card';

/**
 * 把一张卡包成「角色卡」对象（纯数据，不写盘）。
 * @param {string} id 卡 id
 * @returns {object|null} 卡不存在返回 null
 */
export function exportCard(id) {
  const a = getAgent(String(id || ''));
  if (!a) return null;
  const builtin = a.id === AGENT_XIAOYU || a.id === AGENT_XIAOJING;
  const card = {
    kind: CARD_KIND,
    v: CARD_FILE_VERSION,
    name: String(a.name || ''),
    persona: String(a.persona || ''),
    /* 模型只在**自建卡自己选过**的时候才带出去：'' 的意思是「跟当前一致」，
       换个机器上那个模型可能压根没有，带出去只会让她一开局就答不上话。 */
    modelId: a.kind === 'custom' ? String(a.modelId || '') : '',
    color: String(agentColor(a.id) || ''),
    opening: String(cardOpening(a.id) || ''),
    quiet: Boolean(isAgentQuiet(a.id)),
    builtin,
    exportedAt: new Date().toISOString(),
    by: '小鱼Agent',
  };
  return card;
}

/** 导出成文件名：'阿蓝.json'（把 Windows 不许的字符换掉，别留个存不下来的名字） */
export function cardFileName(name) {
  const t = String(name || '').replace(/[\\/:*?"<>|\r\n\t]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 40);
  return (t || '智能体') + '.json';
}

/**
 * 把外面拿来的角色卡认成一张卡的数据。
 *
 * 宽松认：既认自己这套 `{kind:'xiaoyu-agent-card', name, persona, ...}`，
 * 也认酒馆那种 `{spec:'chara_card_v2', data:{name, description, personality, ...}}`
 * —— 主人从别处搬卡回来时，没必要逼他先手改格式。
 *
 * @returns {{ok:true, card:object} | {ok:false, error:string}}
 */
export function normalizeCard(raw) {
  let src = raw;
  if (typeof src === 'string') {
    try { src = JSON.parse(src); } catch { return { ok: false, error: '这个文件不是 JSON（可能不是角色卡）' }; }
  }
  if (!src || typeof src !== 'object' || Array.isArray(src)) {
    return { ok: false, error: '这个文件里没有一张卡（应该是 JSON 对象）' };
  }
  // 酒馆 v2：正文全在 data 里，还拆成好几段
  const d = (src.data && typeof src.data === 'object' && !Array.isArray(src.data)) ? src.data : src;
  const name = String(d.name || src.name || d.char_name || '').trim();
  /* 人设正文：自己这套叫 persona，酒馆 v2 叫 description，v1 叫 char_persona。
     三样都试试，谁先有字用谁；再看要不要再拼「性格/场景/说话的样子」那几段。
     如果全都空着 —— 说明这是**只有名字的空卡**，不拦：主人自己新建卡也是从空的开始。 */
  let persona = [d.persona, d.description, d.char_persona]
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .find((x) => x) || '';
  // 酒馆那种把「性格 / 场景 / 说话样例」拆开写的，拼回一份正文，别丢东西
  const extra = [];
  if (d.personality && String(d.personality).trim()) extra.push('【性格】' + String(d.personality).trim());
  if (d.scenario && String(d.scenario).trim()) extra.push('【场景】' + String(d.scenario).trim());
  if (d.mes_example && String(d.mes_example).trim()) extra.push('【说话的样子】' + String(d.mes_example).trim());
  if (extra.length) persona = [persona, ...extra].filter(Boolean).join('\n\n');
  if (!name) return { ok: false, error: '这张卡没有名字' };
  if (name.length > MAX_NAME) {
    return { ok: false, error: `名字太长了（${name.length} 字，最多 ${MAX_NAME} 字）` };
  }
  if (persona.length > MAX_PERSONA_CHARS) {
    return { ok: false, error: `人设太长了（${persona.length} 字，最多 ${MAX_PERSONA_CHARS} 字）` };
  }
  return {
    ok: true,
    card: {
      name,
      persona,
      modelId: String(d.modelId || d.model || ''),
      color: String(d.color || ''),
      opening: String(d.opening || d.first_mes || d.first_message || '').trim(),
      quiet: Boolean(d.quiet),
      builtin: Boolean(d.builtin),
    },
  };
}

/**
 * 导入一张卡 —— 永远生成**自建卡**，绝不覆盖已有的任何一张。
 *
 * 为什么重名要改名而不是拒收：主人往往是「这台机器上已经有一个阿蓝了，
 * 我又从别处导入一个阿蓝」。拒收会让他以为坏了；叫「阿蓝 2」他一看就懂。
 *
 * @param {object|string} raw 角色卡对象或 JSON 文本
 * @returns {{ok:true, agent:object, renamed:boolean} | {ok:false, error:string}}
 */
export function importCard(raw) {
  const n = normalizeCard(raw);
  if (!n.ok) return n;
  const c = n.card;

  const data = readAllForWrite();
  if (data.customs.length >= MAX_AGENTS) {
    return { ok: false, error: `最多 ${MAX_AGENTS} 个智能体，先删几张再来` };
  }
  const taken = new Set(listAgents().map((a) => String(a.name || '').trim()));
  let name = c.name;
  let renamed = false;
  if (taken.has(name)) {
    renamed = true;
    let i = 2;
    while (taken.has(`${name} ${i}`) && i < 99) i++;
    name = `${name} ${i}`;
    if (name.length > MAX_NAME) name = name.slice(0, MAX_NAME);
    if (taken.has(name)) return { ok: false, error: '同名的卡太多了，先改个名' };
  }

  const agent = addAgent({ name, persona: c.persona, modelId: c.modelId });
  if (!agent) return { ok: false, error: '写盘失败，没存下来' };
  // 颜色、开场白是「跟着她走」的，一并搬过去
  if (c.color) { try { setAgentColor(agent.id, c.color); } catch { /* 颜色不合法就当没填 */ } }
  if (c.opening) { try { setCardOpening(agent.id, c.opening); } catch { /* 开场白太长也不至于整张卡丢掉 */ } }
  /**
   * 【2026-11-10 删】原来这里还有一行 `if (c.quiet) setAgentQuiet(agent.id, true)`。
   *
   * 主人当天钦点删掉艾特功能之后，quiet（＝「只在被 @ 时说话」）成了一条死规则：
   * @ 不再解析，勾了就等于**永远不说话**。这行是从自定义卡搬过来的，
   * 一旦有哪张出厂卡自带 quiet:true，主人装上新版就会发现「那个人一直不吭声」，
   * 而且界面上一个开关都找不到（勾选框已撤）—— 排查成本极高。
   *
   * 所以这条搬运直接掐掉。字段本身、以及读它的老接口都留着（老会话文件里还存着），
   * 只是没有任何地方再写它。要恢复艾特时连这行一起从 git 历史拿回来。
   */
  return { ok: true, agent: getAgent(agent.id) || agent, renamed };
}

// ---- 会话挂哪张卡（2026-10-29）-----------------------------------------------
/**
 * 主人要「多开智能体、自由完美切换」。
 *
 * 最小可用的一步：**哪个会话用哪张卡**。绑了卡，那个会话里的「她」就用那张卡的
 * 人设说话；没绑就是小鱼（人设还是 persona-store 里当前那套，一个字都不动）。
 *
 * 为什么不把绑定写进会话文件：会话文件是聊天记录的账本，绑谁是一个「设置」，
 * 换卡不该在账本里留一行;而且会话被导出/备份/删掉时，绑定也不该跟着丢或跟着跑。
 *
 * 绑定的可以是任意一张「人」的卡：自建卡、小鲸，或者小鱼（=解绑）。
 * 2026-10-31 主人纠正过：小鲸不是工具链里的「跑出去查事的她」，她也是个独立的人，
 * 一样能替一个会话说话 —— 原来那句「不是聊天对象，直接拒」是把她当工具时留下的规矩。
 */
export function sessionAgentId(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return '';
  const data = readAll();
  const id = String(data.bySession[sid] || '');
  if (!id || id === AGENT_XIAOYU) return '';
  // 小鲸是内置的第一个人，不在 customs 里，但她是能替会话说话的人
  if (id === AGENT_XIAOJING) return id;
  // 卡被删了就当没绑：宁可掉回小鱼，也别让会话挂在一个不存在的人身上
  return data.customs.some((a) => String(a.id) === id) ? id : '';
}

/**
 * 一次读出「每个会话分别挂在哪张卡上」（给会话列表用）。
 *
 * 为什么不逐条调 `sessionAgentId`：那个每调一次读一遍文件，
 * 主人四十多个会话就是四十多次读盘 —— 列表一打开就卡一下。
 * 卡被删掉的那些也在这里滤掉，跟 `sessionAgentId` 一个口径：宁可掉回小鱼。
 */
export function sessionAgentMap() {
  const data = readAll();
  const out = {};
  for (const [sid, id] of Object.entries(data.bySession || {})) {
    const a = String(id || '');
    if (!a || a === AGENT_XIAOYU) continue;
    if (a === AGENT_XIAOJING) { out[String(sid)] = a; continue; }
    if (!data.customs.some((x) => String(x.id) === a)) continue;
    out[String(sid)] = a;
  }
  return out;
}

export function setSessionAgent(sessionId, agentId) {
  const sid = String(sessionId || '');
  if (!sid) {
    const e = new Error('得先有会话');
    e.status = 400;
    throw e;
  }
  const data = readAllForWrite();
  const id = String(agentId || '');
  if (!id || id === AGENT_XIAOYU) {
    delete data.bySession[sid];
    if (!writeAll(data)) return null;
    return { sessionId: sid, agentId: '' };
  }
  // 2026-10-31：小鲸也能替一个会话说话。她是个人，不是工具 ——
  // 原来那句「不是聊天对象，不能挂到会话上」是把她当工具时留下的规矩，撤掉。
  if (!data.customs.some((a) => String(a.id) === id) && id !== AGENT_XIAOJING) {
    const e = new Error('没有这个智能体');
    e.status = 400;
    throw e;
  }
  data.bySession[sid] = id;
  if (!writeAll(data)) return null;
  return { sessionId: sid, agentId: id };
}

/** 这个会话该按谁来说话：没绑 = 小鱼那张卡 */
export function agentForSession(sessionId) {
  const id = sessionAgentId(sessionId);
  if (id) {
    const a = getAgent(id);
    if (a) return a;
  }
  return getAgent(AGENT_XIAOYU);
}

// ---- 群聊：这个会话里还有谁在场（2026-10-30）---------------------------------
/**
 * 主人要「多开智能体」，最直白的一种理解就是：**一个会话里不止一个人说话**。
 *
 * 【为什么不复用「身份」那套】
 * 身份（identity）回答的是「现在跟我说话的是谁」—— 它整个会话只有一个人，
 * 是「我戴上哪张脸」。群聊要的是「屋里还坐着谁」—— 小鱼一直在，另外几张卡
 * 各自用自己的嘴说话。两者会打架，所以名单单独存，一个字都不碰 identity。
 *
 * 【小鲸为什么也在这个名单里（2026-10-31 改了）】
 * 原来她被我写成了「一个工具」：只会被 ask_subagent 叫出去跑一趟，不能像别人一样
 * 坐在屋里说话。主人当场纠正：「我希望每个智能体都是像小鱼一样的独立个体，
 * 你怎么把小鲸写成工具了」。
 *
 * 她说到底也是一个人：有自己的名字、人设、模型、脾气。跑出去查事情只是她的一项
 * **本事**，不是她的身份。所以她现在既能被叫进屋说话，也能像原来那样被派出去干活。
 * 两套开关不会打架 —— 她在这个会话里当「说话的人」时，原来那条「插话」闸会自己让开
 * （见 server.mjs 里 __whaleIsSomeone 那段）。
 */
export const MAX_GROUP = 5;

function cleanGroup(data, ids) {
  /* 名单顺序·2026-10-29 主人要「顺序按我拖的来 —— 谁在上谁先说」。
   * 跟上一个版本的区别只有一条：**不再把小鲸硬塞到第一个**，
   * 照存下来的数组顺序走，主人把小鲸拖到下面，她就在下面说。
   *
   * 但「谁在场」这条规矩一个字没松：
   *   · 小鱼一直在（她是这个屋子的主声），名单里没写也补在最前；
   *   · 老会话（从来没存过名单）默认「只有小鲸」——这是群聊刚上线时的口径，
   *     不许改，改了会让所有老会话凭空多出几个人说话；
   *   · 名单**明确存成空数组** = 主人清空了 = 只有小鱼，不许再自动把小鲸补回来；
   *   · 小鲸在名单里的位置也照存的走，不额外插队。 */
  const src = Array.isArray(ids) ? ids : [];
  const seen = new Set();
  const out = [];
  const push = (id) => {
    if (!id || seen.has(id) || out.length >= MAX_GROUP) return;
    seen.add(id);
    out.push(id);
  };

  // 按存的顺序排一遍（小鱼/小鲸都认，卡片被删的不算在场）
  for (const raw of src) {
    const id = String(raw || '');
    if (id === AGENT_XIAOYU || id === AGENT_XIAOJING) { push(id); continue; }
    if (!data.customs.some((a) => String(a.id) === id)) continue; // 卡被删了就不算在场
    push(id);
  }

  /* 小鱼一直在（名单里没写也补上）——
     【2026-11-03 改：补在最后，不再抢第一】
     主人「小鱼默认第一」说的是**初始**；他要能自由拖，包括把小鱼拖到下面去。
     unshift 会让她每次都跳回第一位 → 拖了也白拖（就是「拖上去又弹回来」那个毛病）。
     只有「名单里压根没写她」时才补进来，位置听天由命 = 排最后，主人想放哪儿拖就是了。 */
  /* 【2026-11-01 主人：小鱼、小鲸、自建智能体地位完全平行】
     以前这里无条件把小鱼补回来 —— 主人新建会话时明明只选了小白曦，
     左栏却总有小鱼，就是因为这一行。现在只有「从来没存过名单」才给默认两人；
     存过的名单一个字都不动，主人想只留一张卡就只留一张卡。 */
  /* 只有当这个会话「从来没存过名单」时（ids 不是数组），才给小鲸补上默认在场。
     存过空数组 = 主人明确清空过，别再补 —— 否则「清空名单」永远清不干净。 */
  if (!seen.has(AGENT_XIAOJING) && !Array.isArray(ids)) {
    /* 【初始第一第二·2026-11-03】新会话没刻意排过顺序时，小鲸坐第二：
       先把她塞到第一位，再把小鱼挪到第一位 → 顺序就是 [小鱼, 小鲸]。
       只在「首次补她进名单」这一刻干这一下，存过名单的会话一个字都不动，
       所以之后主人怎么拖，都不会被这里拽回来。 */
    out.unshift(AGENT_XIAOJING);
    push(AGENT_XIAOYU);
    const iYu = out.indexOf(AGENT_XIAOYU);
    if (iYu > 0) { out.splice(iYu, 1); out.unshift(AGENT_XIAOYU); }
  }

  /* 【2026-11-03 撤回·今天那条「新建会话只选小白曦，左栏却冒出小鱼」又是它】
   * 我 2026-11-03 早先按自己的判断把小鱼「无条件补回来」了，这是错的：
   * 主人 2026-11-01 就定过「存过的名单一个字都不动」，要平行、要能只留一张卡。
   * 小鱼缺牌子的问题只在「从来没存过名单」那条默认分支里解决（上面那段）。 */

  /**
   * 【顺序照存的走，谁也别「钉」在最前·2026-11-03 主人第二次说清：
   *   「我说她们分别第一与第二指的是**初始**是这样，不代表后续想拖动时改变不了位置」】
   *
   * 上一版错了：我在这里把小鲸按死在第二（`pinFirst` 一拼，每次读名单都重排一遍），
   * 结果主人把她拖到第一位，存盘存对了，界面一刷新又弹回第二 ——
   * 怎么拖都白拖。顺序不是「算出来的」，是主人拖出来的，所以这里一个字节都不许改。
   *
   * 「初始第一第二」由**新建会话那一刻**保证：新建挑人的弹窗里小鱼、小鲸默认勾着、
   * 排在最上面，提交下来存的数组本来就是 [小鱼, 小鲸, …]，见下面 push 的顺序。
   * 之后就是主人的自由：拖谁到哪儿，`setSessionGroupOrder` 存的就是哪个顺序。
   *
   * 这里只剩一条不能动的：小鱼（屋子的主声）如果名单里没写，就补在最前 ——
   * 那是「她在不在」的规矩，跟「排第几」是两回事，上面那段 unshift 已经办了。
   */
  return out;
}

/**
 * 这个会话里在场说话的卡（小鱼不在里面 —— 她一直在，不用点）。
 *
 * 2026-10-31 主人定：「默认选择小鱼与小鲸，不能改」。所以一个从没设置过名单的
 * 会话，名单里也有小鲸 —— 她在屋里坐着，默认每轮都会接一句。
 */
export function groupAgentIds(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return [];
  const data = readAll();
  return cleanGroup(data, data.groupBySession[sid]);
}

/**
 * 【谁是这个会话的主智能体】—— 2026-11-03 主人定的
 *
 * 原话：「主智能体指左侧排序最靠前的已启用且未被禁用的智能体」。
 *
 * 也就是说：不看人设、不看是不是小鱼，**只看左侧那竖列「屋里的人」的从上到下**。
 * 第一个既开着、又没被禁用的，就是主智能体。主人想换主智能体，把谁拖到最上面、开着就行。
 *
 * 三个来源要并成一套（跟 server.mjs 里画那一竖列用的是同一套判据，别搞成两套）：
 *   小鱼   → fish-presence（顶栏/牌子那颗的最终真相）
 *   小鲸   → whale-presence
 *   别的卡 → groupEnabledBySession 那张牌子表（没记过 = 开着）
 *
 * 一个都不剩（全被关掉）时返回 null —— 那种情况下没有主智能体，
 * 调用方自己决定退回谁（办事模式里会退回「没人可当主智能体」并拒绝开工）。
 *
 * @param {string} sessionId
 * @param {(id:string)=>boolean} [isOn] 可选：外部传一个「这个人开着没」的判据进来，
 *        用来跟界面/server 的那份状态对齐（不传就用本文件自己的判据）。
 * @returns {string|null} agentId
 */
/**
 * 【2026-11-09 主人重做·唯一真源】这个会话这一轮「从上往下所有启用的人」。
 *
 * 新口径三句话：
 *   ① 第 0 个 = 主智能体 = **唯一有 Agent 工作能力**的人（跑工具循环、派活）；
 *   ② 其余的按名单顺序依次接话，**一律没有 Agent 工作能力**（只能说一句话）；
 *   ③ 接话是链式的：A 看到主人原话，B 看到「主人 + A」，C 看到「主人 + A + B」……
 *
 * 以前 `mainAgentId` 自己遍历、`runMateRound` 写死排除小鱼、界面按 idx===0 高亮，
 * 三处各算各的 —— 主智能体不是小鱼时立刻对不上。现在全都从这里取。
 *
 * @param {(id:string)=>boolean} [isOn] 跟 server 的 mateSwitchOn 对齐；不传就用本文件判据
 * @returns {string[]} 按竖列从上到下的 id
 */
export function activeAgentIds(sessionId, isOn = null) {
  const sid = String(sessionId || '');
  if (!sid) return [];
  let ids = [];
  try { ids = groupAgentIds(sid); } catch { return []; }
  const onMap = (() => { try { return groupEnabledMap(sid); } catch { return {}; } })();
  /* 【2026-11-09】默认判据也尊重「这一轮被关掉」这件事。
   * 旧版不传 isOn 时把小鱼/小鲸硬当 true —— 可界面把她们关掉时，
   * toggleWhoBtn 会往 groupEnabledBySession 里写 false，这里却还当她开着，
   * 主智能体就跟屏上那颗灰掉的牌对不上了。表里有明确记录就照表；
   * 没记过（undefined）才按开着算，跟 server 的 try/catch 兜底一个语义。 */
  const judge = typeof isOn === 'function'
    ? isOn
    : (id) => onMap[id] !== false;
  return ids.map((id) => String(id)).filter((id) => {
    try { return judge(id) !== false; } catch { return true; }
  });
}

export function mainAgentId(sessionId, isOn = null) {
  /* 【2026-11-09】不再自己遍历一遍 —— 跟接话名单、界面高亮共用 activeAgentIds，
   * 免得三处判据稍微不一样，主智能体又跟屏上那颗牌子对不上。 */
  const alive = activeAgentIds(sessionId, isOn);
  return alive.length ? alive[0] : null;
}


/** 一次读出「每个会话分别有谁在场」（给会话列表/顶栏用，跟 sessionAgentMap 一个口径） */
export function groupAgentMap() {
  const data = readAll();
  const out = {};
  for (const [sid, ids] of Object.entries(data.groupBySession || {})) {
    const kept = cleanGroup(data, ids);
    if (kept.length) out[String(sid)] = kept;
  }
  return out;
}

/**
 * 改这个会话的在场名单。
 *
 * 传空数组就是「只剩小鱼一个人」。超上限不报错，砍掉多的 —— 这是一份名单，
 * 不是一份合同，报错只会让界面多一个弹窗。
 */
/**
 * 改这个会话的在场名单。
 *
 * 传空数组就是「只剩小鱼一个人」。超上限不报错，砍掉多的 —— 这是一份名单，
 * 不是一份合同，报错只会让界面多一个弹窗。
 *
 * 【2026-11-01 加 keepWhale】主人要求「新建会话时默认都不选」。
 * 以前这儿有一条硬规矩：小鲸本来在名单里，怎么改都得把她留着；
 * 那条规矩让「新建时一张都不勾」根本做不到（新会话默认名单里就有她）。
 * keepWhale:false 只给「刚刚新建、按主人勾的来」那一条路用；
 * 界面上改名单还是照旧保她（见下），别把老行为改了。
 */
export function setSessionGroup(sessionId, ids, { keepWhale = true } = {}) {
  const sid = String(sessionId || '');
  if (!sid) {
    const e = new Error('得先有会话');
    e.status = 400;
    throw e;
  }
  const data = readAllForWrite();
  const beforeHasXj = cleanGroup(data, data.groupBySession[sid]).includes(AGENT_XIAOJING);
  // keepWhale:false 时先把这个会话标成「存过名单」，这样 cleanGroup 不会给她补默认
  if (!keepWhale && !Array.isArray(data.groupBySession[sid])) data.groupBySession[sid] = [];
  const kept = cleanGroup(data, ids);
  /* 2026-10-31【名单里永远有小鲸】
   *
   * 主人定过「默认选择小鱼与小鲸，不能改」。原来只有「从没存过名单」才会自动把小鲸
   * 补上；主人一旦点过任何一个人进名单，小鲸就从此消失了 —— 于是「小鲸不能改」
   * 这条规矩只在新会话的头一秒成立，端到端测试也一直在报「名单里只剩小鱼」。
   * 现在改成：只要小鲸本来就在（默认就在），改名单时就把她原样留着，谁也别想把她挤掉。
   * 想让她别抢话，就把左侧那颗牌关掉，不是把人赶出屋子。
   */
  if (keepWhale && beforeHasXj && !kept.includes(AGENT_XIAOJING) && kept.length < MAX_GROUP) kept.push(AGENT_XIAOJING);
  /**
   * 【2026-11-01】keepWhale:false 是「刚建会话、按主人勾的来」那条路：
   * 他一张都没勾时要把**空名单存下去**（空数组），不能 delete ——
   * delete 等于「这个会话从来没设过名单」，下次读又会被默认补回小鱼小鲸，
   * 空屋一刷新又坐满了人。
   */
  if (!keepWhale) data.groupBySession[sid] = kept;
  else if (kept.length) data.groupBySession[sid] = kept;
  else delete data.groupBySession[sid];
  if (!writeAll(data)) return null;
  return { sessionId: sid, agentIds: kept, max: MAX_GROUP };
}

/**
 * 【已停用 · 2026-11-10】这张卡是不是「只在被点名时才说话」。
 *
 * 以前按卡存（是她的性格，不是屋子的规矩）。2026-11-10 主人钦点删掉艾特功能，
 * 「等我 @ 你」这个判据不存在了 —— 勾过的人现在只剩「永远不说话」这一个效果，
 * 而界面上再也找不到那个开关（勾选框已撤）→ 典型的「查不出来的哑巴」。
 *
 * **所以这里恒返回 false**：不管 agents.json 里 quiet 残留着什么值，
 * 谁问都答「她不安静、每轮都该说话」。字段本身照旧读写（老文件要能解析），
 * 但**任何读它的人都不会再得到「要叫才应」这个答案**。
 * 要恢复艾特时，连这个函数一起从 git 历史（v0.9.46）拿回来。
 *
 * @returns {false} 永远 false
 */
export function isAgentQuiet(id) {
  void id;
  return false;
}

/**
 * 【已停用 · 2026-11-10】所有安静的卡（群聊挑发言人时用）。
 *
 * 主人删掉艾特功能后，`pickSpeakers` 已不再读 quietIds，「安静」这个词没有任何行为含义了。
 * 函数留着只为不炸老调用方 / 老脚本；**恒返回空数组** —— 就算 agents.json 里
 * 还留着 quiet:true，也不许有人从这里拿到一份「这些人要叫才说话」的名单。
 */
export function quietAgentIds() {
  return [];
}

/**
 * 改一张卡的安静开关。
 *
 * 【已停用 · 2026-11-10】艾特删除后没有入口会调它（界面勾选框已撤）。
 * 函数体和 /api/agents/quiet 一起留着：老会话文件里还存着 quiet 字段，
 * 真要恢复艾特时连这一步一起从 git 历史拿回来。
 * **不要再从任何 UI 调它** —— 设了也不会有效果，只会让人以为「设成了」。
 */
export function setAgentQuiet(id, quiet) {  const key = String(id || '');
  if (!key) {
    const e = new Error('没说要改哪张卡');
    e.status = 400;
    throw e;
  }
  if (key === AGENT_XIAOYU) {
    const e = new Error('小鱼是这个会话的主声，不能设成「要叫才应」');
    e.status = 400;
    throw e;
  }
  const data = readAllForWrite();
  if (key !== AGENT_XIAOJING && !data.customs.some((a) => String(a.id) === key)) {
    const e = new Error('没有这张卡');
    e.status = 404;
    throw e;
  }
  if (quiet) data.quiet[key] = true;
  else delete data.quiet[key];
  if (!writeAll(data)) return null;
  return { id: key, quiet: !!quiet };
}

/* 屋里的人的「开着 / 关掉」·2026-11-01 ------------------------------------------------
 *
 * 主人原话：「屏幕上方的【小鱼】与【小鲸】按钮只有启用时她们才说话，禁用时不说话。」
 *
 * 【为什么不复用「安静」那个开关】
 * 那个说的是「她要你叫才应」，人还在屋里。这个是「她这一轮就别开口了」，
 * 连点名都不吭声 —— 两件事，混在一起会互相打架。
 *
 * 【为什么按会话存】
 * 「这间屋子这会儿谁在开腔」是屋子的状态：主人开一间安静的屋子复盘，
 * 不该把另一间热闹屋子的阵容也拖下水。
 *
 * 【小鲸这一档顺便把老的总开关接管了】
 * 以前判断「小鲸能不能说话」读的是 whaleOn(sessionId)（功能页那颗小鲸总开关），
 * 那颗钥匙其实管的是「她能不能被叫出去干活」。关掉它就是她不说话，会误伤。
 * 现在：**「屋里的人」上那颗牌就是她在这个会话里的开关**，两件事各管各的。
 */

/** 这张牌在这个会话里是不是开着（没记过 = 开着） */
export function isGroupMemberEnabled(id, sessionId) {
  const key = String(id || '');
  const sid = String(sessionId || '');
  if (!key || !sid) return true;
  try {
    const map = readAll().groupEnabledBySession[sid];
    if (!map || typeof map !== 'object') return true;
    return map[key] !== false;
  } catch { return true; }
}

/** 一次读出这个会话里每张牌的开/关（界面画那竖列用） */
export function groupEnabledMap(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return {};
  try {
    const map = readAll().groupEnabledBySession[sid];
    if (!map || typeof map !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(map)) out[String(k)] = v !== false;
    return out;
  } catch { return {}; }
}

/**
 * 把一张牌开/关。
 *
 * 【2026-11-01 主人改了口径】「小鱼与小鲸这两个改为常亮，这两个是否启用只与屏幕上方的
 * 【小鱼】与【小鲸】按钮相关，与左侧的名字点击一下关闭开启无关。」
 *
 * 所以：小鱼、小鲸这两张**不归这一档管** —— 在这儿直接拒掉（400）。
 * 她们在不在场只有两个开关：顶栏「小鱼」（`/api/fish`）和「小鲸」（`/api/whale`）。
 * 左侧那颗牌对她们只有「拖动换顺序」和「双击叫名字」两个作用。
 *
 * 为什么要服务端也拦一道：界面可以被旧缓存页、脚本、或者别的会话再点一遍，
 * 光靠前端不点等于没管。
 */
export function setGroupMemberEnabled(id, sessionId, enabled) {
  const key = String(id || '');
  const sid = String(sessionId || '');
  if (!sid) { const e = new Error('得先有会话'); e.status = 400; throw e; }
  if (!key) { const e = new Error('没说要改谁'); e.status = 400; throw e; }
  /**
   * 【2026-11-03 主人报「关闭小鱼或小鲸时会弹出关不了的提示」】
   *
   * 上面那两个 if 是老规矩的化石：以前她俩「常亮、牌子点不灭」，所以服务端拦了一道。
   * 后来主人改口（「小鱼与小鲸的左侧按钮也可以点击开启或关闭」），顶栏那两颗按钮也删了，
   * **左侧这颗牌成了唯一开关** —— 可这道 400 还留着，于是点一下就弹
   * 「小鱼和小鲸是常亮的……不从这一列关」，牌子上那个「关」根本落不下去。
   *
   * 现在这里对所有人一视同仁：小鱼、小鲸也照常记进牌子表。
   * 她们俩「说还是不说」真正读的是 fish-presence / whale-presence，
   * 由 `/api/agents/group/toggle` 一并改（见 server.mjs）—— 那才是唯一开关。
   */
  const data = readAllForWrite();
  const map = (data.groupEnabledBySession[sid] && typeof data.groupEnabledBySession[sid] === 'object')
    ? { ...data.groupEnabledBySession[sid] } : {};
  if (enabled) delete map[key];
  else map[key] = false;
  if (Object.keys(map).length) data.groupEnabledBySession[sid] = map;
  else delete data.groupEnabledBySession[sid];
  if (!writeAll(data)) return null;
  return { sessionId: sid, id: key, enabled: !!enabled, map: groupEnabledMap(sid) };
}

/**
 * 把屋里的人换个顺序（拖谁到哪儿）。
 *
 * 只改顺序，不改「谁在场」：传进来的名单里如果少了几个人，缺的那些按原来的相对顺序
 * 补在后面（主人拖了个别人出去，不该顺手把人踢出屋子）；多出来的、不认识的丢掉。
 */
export function setSessionGroupOrder(sessionId, ids) {
  const sid = String(sessionId || '');
  if (!sid) { const e = new Error('得先有会话'); e.status = 400; throw e; }
  const data = readAllForWrite();
  const cur = cleanGroup(data, data.groupBySession[sid]);
  const want = (Array.isArray(ids) ? ids : []).map((x) => String(x || '')).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const id of want) {
    if (!cur.includes(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of cur) if (!seen.has(id)) out.push(id);
  data.groupBySession[sid] = out;
  /* 顺序变了，上一轮 @ 出来的「只让这几个人说话」名单也跟着作废 ——
     否则主人拖完人，说话顺序看着变了，实际还是那几个人在抢。 */
  if (data.allowedBySession && typeof data.allowedBySession === 'object') delete data.allowedBySession[sid];
  if (!writeAll(data)) return null;
  return { sessionId: sid, agentIds: out, max: MAX_GROUP };
}

/* 颜色与顺序·2026-10-29 ---------------------------------------------------------------
 * 每张卡的默认颜色：主人说小鱼默认红、小鲸默认蓝、其他白。
 * 存盘的 colors 优先，没存过就用这里的默认。
 */
const DEFAULT_COLORS = {
  xiaoyu: '#f0a6a0',
  xiaojing: '#7aa8e8',
};
const COLOR_FALLBACK = '#e6e6e6';

export function agentColor(id) {
  const key = String(id || '');
  const data = readAll();
  const saved = data.colors && data.colors[key];
  if (saved && /^#[0-9a-fA-F]{3,8}$/.test(String(saved))) return String(saved);
  if (DEFAULT_COLORS[key]) return DEFAULT_COLORS[key];
  return COLOR_FALLBACK;
}

export function setAgentColor(id, color) {
  const key = String(id || '');
  if (!key) return { ok: false, error: '没有这张卡' };
  const c = String(color || '').trim();
  if (!/^#[0-9a-fA-F]{3,8}$/.test(c)) return { ok: false, error: '颜色格式不对（要 #rrggbb 这种）' };
  const data = readAllForWrite();
  data.colors = data.colors || {};
  data.colors[key] = c;
  writeAll(data);
  return { ok: true, color: c };
}

/** 一次把每张卡的颜色都读出来（界面一次拿够，不用一张一张问） */
export function agentColorMap() {
  const data = readAll();
  const out = {};
  for (const [k, v] of Object.entries(data.colors || {})) {
    if (/^#[0-9a-fA-F]{3,8}$/.test(String(v))) out[k] = String(v);
  }
  return out;
}


/**
 * 记住@的人·2026-10-29
 * 这个会话里「谁还能说话」。
 *
 * 返回 null = 从没 @ 过，谁都能说；
 * 返回数组 = 只有这些人能说，一直管到下次 @。
 */
export function allowedSpeakersOf(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return null;
  try {
    const data = readAll();
    const v = data.allowedBySession[sid];
    if (!Array.isArray(v)) return null;
    return v.map((x) => String(x)).filter(Boolean);
  } catch { return null; }
}

/** 记下这个会话「下次谁还能说话」。传 null = 解除限制（谁都能说）。 */
export function setAllowedSpeakers(sessionId, ids) {
  const sid = String(sessionId || '');
  if (!sid) return null;
  const data = readAllForWrite();
  if (Array.isArray(ids) && ids.length) {
    data.allowedBySession[sid] = ids.map((x) => String(x)).filter(Boolean);
  } else {
    delete data.allowedBySession[sid];
  }
  writeAll(data);
  return data.allowedBySession[sid] || null;
}
