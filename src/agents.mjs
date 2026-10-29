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

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import {
  personaInfo,
  currentPersonaText,
  savePersonaText,
  builtinPersonaText,
  resetPersona,
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

function readAll() {
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
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return blank;
    return {
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
       * 「安静」的卡：只在被点名（`@她`）的时候才开口。
       *
       * 主人原话：「让群聊别一直全员齐发」。三张卡每轮都说，一长就吵，
       * 而且烧的是他的钱。所以给每张卡一个「只在叫名字时才说话」的开关 ——
       * 是这张卡的性格，不是这个会话的规矩，所以按卡存，换屋子照样记得。
       */
      quiet: objOf(j.quiet),
      /* 颜色与顺序·2026-10-29 每张卡的颜色。没记过就按默认：小鱼红、小鲸蓝、其余白。 */
      colors: objOf(j.colors),
    /* 记住@的人·2026-10-29 */
    allowedBySession: objOf(j.allowedBySession),
    };
  } catch {
    return blank;
  }
}

function writeAll(data) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify({
      version: 4,
      customs: data.customs || [],
      bySession: objOf(data.bySession),
      groupBySession: objOf(data.groupBySession),
      groupEnabledBySession: objOf(data.groupEnabledBySession),
      quiet: objOf(data.quiet),
      colors: objOf(data.colors),
    allowedBySession: objOf(data.allowedBySession),
    }, null, 2), 'utf8');
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
    return {
      id: AGENT_XIAOJING,
      name: '小鲸',
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
  const data = readAll();
  if (data.customs.length >= MAX_AGENTS) {
    const e = new Error(`最多 ${MAX_AGENTS} 个智能体，够了`);
    e.status = 400;
    throw e;
  }
  const text = String(persona || '');
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

  const data = readAll();
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
  const data = readAll();
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

  const data = readAll();
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
    saveWhaleProfile({ persona: '' });
    return getAgent(key);
  }
  return saveAgentPersona(key, '');
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
  const data = readAll();
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

  const data = readAll();
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
  // 颜色、开场白、安静这几样是「跟着她走」的，一并搬过去
  if (c.color) { try { setAgentColor(agent.id, c.color); } catch { /* 颜色不合法就当没填 */ } }
  if (c.opening) { try { setCardOpening(agent.id, c.opening); } catch { /* 开场白太长也不至于整张卡丢掉 */ } }
  if (c.quiet) { try { setAgentQuiet(agent.id, true); } catch { /* 自定义卡不该抛，兜底 */ } }
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
  const data = readAll();
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
  if (!seen.has(AGENT_XIAOYU)) push(AGENT_XIAOYU);
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
 * 会话，名单里也有小鲸 —— 她在屋里坐着，只是默认「叫她才应」（见 isAgentQuiet）。
 */
export function groupAgentIds(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return [];
  const data = readAll();
  return cleanGroup(data, data.groupBySession[sid]);
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
export function setSessionGroup(sessionId, ids) {
  const sid = String(sessionId || '');
  if (!sid) {
    const e = new Error('得先有会话');
    e.status = 400;
    throw e;
  }
  const data = readAll();
  const beforeHasXj = cleanGroup(data, data.groupBySession[sid]).includes(AGENT_XIAOJING);
  const kept = cleanGroup(data, ids);
  /* 2026-10-31【名单里永远有小鲸】
   *
   * 主人定过「默认选择小鱼与小鲸，不能改」。原来只有「从没存过名单」才会自动把小鲸
   * 补上；主人一旦点过任何一个人进名单，小鲸就从此消失了 —— 于是「小鲸不能改」
   * 这条规矩只在新会话的头一秒成立，端到端测试也一直在报「名单里只剩小鱼」。
   * 现在改成：只要小鲸本来就在（默认就在），改名单时就把她原样留着，谁也别想把她挤掉。
   * 想让她别抢话，用「安静」（叫她才应）那个开关，不是把人赶出屋子。
   */
  if (beforeHasXj && !kept.includes(AGENT_XIAOJING) && kept.length < MAX_GROUP) kept.push(AGENT_XIAOJING);
  if (kept.length) data.groupBySession[sid] = kept;
  else delete data.groupBySession[sid];
  if (!writeAll(data)) return null;
  return { sessionId: sid, agentIds: kept, max: MAX_GROUP };
}

/**
 * 【安静开关】这张卡是不是「只在被点名时才说话」。
 *
 * 为什么按卡存而不是按会话存：
 * 这是她的性格（「阿绿话少，叫她才说」），不是这个屋子的规矩。主人给阿绿定了
 * 这个性子，换个会话她该还是这样。按会话存的话，每开一间屋子都得重新设一遍。
 */
export function isAgentQuiet(id) {
  const key = String(id || '');
  if (!key) return false;
  const data = readAll();
  const v = data.quiet[key];
  if (typeof v === 'boolean') return v;
  // 小鲸默认「叫她才应」：她在屋里，但不抢话。
  // 主人想让她每轮都接，在智能体面板里把那个勾去掉就行。
  return key === AGENT_XIAOJING;
}

/** 所有安静的卡（群聊挑发言人时用） */
export function quietAgentIds() {
  const data = readAll();
  return Object.keys(data.quiet || {}).filter((k) => data.quiet[k]);
}

/** 改一张卡的安静开关。传假就是「还是照常每次都接」。 */
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
  const data = readAll();
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
  if (key === AGENT_XIAOYU || key === AGENT_XIAOJING) {
    const e = new Error('小鱼和小鲸是常亮的：她俩在不在场只看顶栏那两颗按钮，不从这一列关');
    e.status = 400;
    throw e;
  }
  const data = readAll();
  const map = (data.groupEnabledBySession[sid] && typeof data.groupEnabledBySession[sid] === 'object')
    ? { ...data.groupEnabledBySession[sid] } : {};
  // 顺手把历史上给小鱼/小鲸记下的「关」清掉（前一版允许关，可能已经存了 false）
  delete map[AGENT_XIAOYU];
  delete map[AGENT_XIAOJING];
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
  const data = readAll();
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
  const data = readAll();
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
  const data = readAll();
  if (Array.isArray(ids) && ids.length) {
    data.allowedBySession[sid] = ids.map((x) => String(x)).filter(Boolean);
  } else {
    delete data.allowedBySession[sid];
  }
  writeAll(data);
  return data.allowedBySession[sid] || null;
}
