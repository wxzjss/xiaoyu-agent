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

function readAll() {
  const blank = { version: 2, customs: [], bySession: {} };
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return blank;
    const bySession = (j.bySession && typeof j.bySession === 'object' && !Array.isArray(j.bySession))
      ? j.bySession
      : {};
    return { version: 2, customs: Array.isArray(j.customs) ? j.customs : [], bySession };
  } catch {
    return blank;
  }
}

function writeAll(data) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify({
      version: 2,
      customs: data.customs || [],
      bySession: data.bySession && typeof data.bySession === 'object' ? data.bySession : {},
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
      desc: '跑出去替你查事情的那一个。她有人设，也能单独挑一个模型。',
      builtin: true,
      kind: 'whale',
      personaChars: String(whale.persona || '').length,
      snippet: personaSnippet(whale.persona),
      modelId: whaleModelId(),
      modelFollows: !whaleModelId(),
      edited: !!whale.custom || !!whaleModelId(),
    },
  ];

  const customs = readAll().customs.map((a) => ({
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
      desc: '跑出去替你查事情的那一个。人设有内置默认，改了就是私设。',
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
    edited: true,
    createdAt: a.createdAt || '',
  };
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
 * 绑定只认自定义卡和小鱼（=解绑）。小鲸是工具链里「跑出去查事的她」，不是聊天对象，
 * 挂到会话上会跟人格/身份两头打架，所以直接拒。
 */
export function sessionAgentId(sessionId) {
  const sid = String(sessionId || '');
  if (!sid) return '';
  const data = readAll();
  const id = String(data.bySession[sid] || '');
  if (!id || id === AGENT_XIAOYU) return '';
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
  if (id === AGENT_XIAOJING) {
    const e = new Error('小鲸是跑出去查事情的那个她，不是聊天对象，不能挂到会话上');
    e.status = 400;
    throw e;
  }
  if (!data.customs.some((a) => String(a.id) === id)) {
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
