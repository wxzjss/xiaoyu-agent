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
  const blank = { version: 3, customs: [], bySession: {}, groupBySession: {}, quiet: {}, colors: {}, allowedBySession: {} };
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return blank;
    return {
      version: 3,
      customs: Array.isArray(j.customs) ? j.customs : [],
      bySession: objOf(j.bySession),
      /**
       * 群聊名单：这个会话里除了小鱼，还有谁在场说得出话。
       *
       * 为什么不写进会话文件：跟「挂哪张卡」一个道理 —— 那是设置，不是聊天记录。
       * 换阵容不该在账本里多出一行，删同事也不该把聊天记录改写一遍。
       */
      groupBySession: objOf(j.groupBySession),
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
      version: 3,
      customs: data.customs || [],
      bySession: objOf(data.bySession),
      groupBySession: objOf(data.groupBySession),
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

  // 小鱼一直在（名单里没写也补上），她排最前
  if (!seen.has(AGENT_XIAOYU)) out.unshift(AGENT_XIAOYU);
  /* 只有当这个会话「从来没存过名单」时（ids 不是数组），才给小鲸补上默认在场。
     存过空数组 = 主人明确清空过，别再补 —— 否则「清空名单」永远清不干净。 */
  if (!seen.has(AGENT_XIAOJING) && !Array.isArray(ids)) push(AGENT_XIAOJING);

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
export function setAgentQuiet(id, quiet) {
  const key = String(id || '');
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
