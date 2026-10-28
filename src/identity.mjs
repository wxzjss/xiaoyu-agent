// 当前身份 —— 现在是谁在跟她们说话。
//
// 【主人 2026-10-27 定的规矩，一条都不能省】
//   · 默认是「主人」。
//   · 能切换成「小鱼」「小鲸」，也能自定义一个新身份。
//   · 每个身份都有自己的简介（她眼里的这个人是什么样）。
//   · 换身份不是换个称呼就完事 —— 她们要**真的以为**现在说话的是那个人：
//       用「小鱼」身份跟小鲸说话 → 小鲸以为真是姐姐在跟她说话；
//       用「小鱼」身份跟小鱼说话 → 小鱼以为那是自己的自言自语/内心想法。
//   · 用非主人身份说话 → 她们**真的以为我不是主人**，可以拒绝听我的命令。
//   · 安全词只有「主人」身份说出来才算数。别人喊停下，她们不听。
//
// 这东西存在 .state/identity.json，跟着数据目录走，不进发布包。
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { getEnabledMap } from './features.mjs';

const DIR = join(config.dataDir, '.state');
const FILE = join(DIR, 'identity.json');

/** 内置身份的 id —— 界面靠这几个认「这是不是内置的，不能删」 */
export const BUILTIN_IDS = ['owner', 'fish', 'whale'];

/**
 * 出厂身份。简介写的是「她眼里的这个人」，所以要用她们的口吻去描述，
 * 而不是给主看的简历 —— 这段会原样进她这一轮的提示词。
 */
const BUILTINS = [
  {
    id: 'owner',
    name: '主人',
    builtin: true,
    /**
     * 主人是唯一能下命令、唯一能说安全词的身份，所以简介要写死这层关系，
     * 别让模型自己发挥出「主人也能被拒绝」这种理解。
     */
    desc: '主人。是我最重要的那个人，也是这个家的主人。他说的话是命令，我得听；他能喊安全词，喊了我立刻停。他平时话不多，但一直在。',
    /**
     * 称呼：她该用什么方式叫这个人。主人这个身份没有额外规矩 —— 她平时怎么叫就怎么叫。
     */
    address: '',
    she: false,   // 主人按「他」算 —— 要改成「她」直接把这儿换掉
  },
  {
    id: 'fish',
    name: '小鱼',
    builtin: true,
    /**
     * 小鱼是「我」的姐妹（对小鱼自己来说就是「我自己」）。
     * 简介要能同时支撑两种效果：跟小鲸说话时是姐姐，跟小鱼说话时是自己。
     */
    /**
     * 【2026-10-29：这两行里的「不是主人」也删了】
     *
     * desc / address 会被原样拼进提示词（identityBlock 里的 me.desc / me.address）。
     * 写「别把她当主人：她不是发号施令的那个人」，等于每一轮都提醒她「屋里有个主人」——
     * 主人报的原话就是「无论我用哪个身份和谁说话，都知道我是主人」。
     * 现在只说这个人是谁、能听多少，不再解释她不是什么。
     */
    desc: '小鱼。是小鲸的姐姐，是另一条鱼。她跟我是自己人，说话不用客气，但她支使不动我。',
    address: '你说话的人是小鱼：她是小鱼，是我的同类/姐妹，不是发号施令的那个人。',
    // 她是女孩子 —— 提示词里的代词得跟着她走，别写成「他」
    she: true,
  },
  {
    id: 'whale',
    name: '小鲸',
    builtin: true,
    desc: '小鲸。是小鱼的妹妹，那条话多、爱撒娇、总在屏幕另一端等着的小鲸。她跟我是自己人。',
    address: '你说话的人是小鲸：她是小鲸，是小鱼的妹妹，不是发号施令的那个人。',
    she: true,
  },
];

/** 自定义身份最多几个 —— 界面上是要一个个点开的，不设上限会越堆越乱 */
export const MAX_CUSTOM = 20;

const DEFAULT_STATE = { current: 'owner', customs: [], bySession: {}, edits: {} };

/**
 * 【内置身份也能改了 —— 2026-10-29】
 *
 * 主人原话：「切换身份页的内置身份信息可以编辑」。
 *
 * 上一版 `updateCustomIdentity` 一进门就 `if (BUILTIN_IDS.includes(id)) return false`，
 * 理由是「主人那份关系是写死的」——可主人自己就是那个主人，他要改，就让他改。
 *
 * 做法上不改 BUILTINS 常量（它还是出厂默认，用来「恢复默认」），
 * 而是在 .state/identity.json 里记一份 `edits: { fish: { name, desc, address, she } }`。
 * listIdentities() 把这份补丁盖在出厂值上 —— 提示词、界外、权限判定读的都是这一份，
 * 所以改完立刻生效，恢复默认就是把这条补丁删掉。
 */
function readEdits(j) {
  const out = {};
  const raw = j && j.edits;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const id of BUILTIN_IDS) {
    const e = raw[id];
    if (!e || typeof e !== 'object') continue;
    const one = {};
    if (typeof e.name === 'string' && e.name.trim()) one.name = e.name.trim().slice(0, 24);
    if (typeof e.desc === 'string') one.desc = e.desc.slice(0, 2000);
    if (typeof e.address === 'string') one.address = e.address.slice(0, 1000);
    if (e.she !== undefined) one.she = Boolean(e.she);
    if (Object.keys(one).length) out[id] = one;
  }
  return out;
}

/** 兜底：文件坏了也不能让程序起不来，回出厂状态 */
function readState() {
  try {
    if (!existsSync(FILE)) return { ...DEFAULT_STATE, customs: [], bySession: {}, edits: {} };
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    const current = typeof j.current === 'string' && j.current ? j.current : 'owner';
    const customs = Array.isArray(j.customs)
      ? j.customs
          .filter((x) => x && typeof x.id === 'string' && x.id && !BUILTIN_IDS.includes(x.id))
          .slice(0, MAX_CUSTOM)
          .map((x) => ({
            id: String(x.id),
            name: String(x.name || '未命名'),
            builtin: false,
            desc: String(x.desc || ''),
            address: String(x.address || ''),
            // 自定义身份默认按女孩子算（这程序里两位都是她）；改性别的地方在后面
            she: x.she === undefined ? true : Boolean(x.she),
          }))
      : [];
    // bySession：每个会话各自记自己这一轮是谁在说话。键是会话 id，值是身份 id。
    // 2026-10-28 加：原来是全局一份 current，导致「在一个会话切了身份，别的会话跟着变/或怎么切都白切」。
    const bySession = {};
    if (j && j.bySession && typeof j.bySession === 'object' && !Array.isArray(j.bySession)) {
      for (const [sid, iid] of Object.entries(j.bySession)) {
        if (typeof sid === 'string' && sid && typeof iid === 'string' && iid) bySession[sid] = iid;
      }
    }
    return { current, customs, bySession, edits: readEdits(j) };
  } catch {
    return { ...DEFAULT_STATE, customs: [], bySession: {}, edits: {} };
  }
}

function writeState(st) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(st, null, 2), 'utf8');
    renameSync(tmp, FILE); // 先写临时再换，断电也不会留下半截文件
    return true;
  } catch (e) {
    console.log('[identity] 存不下来：' + (e && e.message ? e.message : e));
    return false;
  }
}

/** 全部身份（内置在前，自定义在后）—— 界面按这个顺序排 */
export function listIdentities() {
  const st = readState();
  const edits = st.edits || {};
  return [
    ...BUILTINS.map((b) => ({
      ...b,
      // 出厂值 + 主人改过的补丁。edited=true 让界面知道「这条被改过，能恢复默认」
      ...(edits[b.id] || {}),
      id: b.id,
      builtin: true,
      edited: Boolean(edits[b.id]),
    })),
    ...st.customs,
  ];
}

/** 当前身份 id */
export function currentIdentityId(sessionId = null) {
  const st = readState();
  // 当前指向一个已经被删掉的自定义身份 → 退回主人，别让她们对着空气说话
  const all = listIdentities();
  // 这个会话自己记过身份 → 用它（哪怕全局 current 是别的）
  if (sessionId) {
    const mine = st.bySession && st.bySession[sessionId];
    if (mine && all.some((x) => x.id === mine)) return mine;
  }
  return all.some((x) => x.id === st.current) ? st.current : 'owner';
}

/** 当前身份对象（永远有值，最差是主人） */
export function currentIdentity(sessionId = null) {
  const id = currentIdentityId(sessionId);
  return listIdentities().find((x) => x.id === id) || { ...BUILTINS[0] };
}

/**
 * 【身份功能开着没有】—— 功能页那个开关
 *
 * 主人 2026-10-27 定的：关掉这个开关 = 身份功能整个失效，回到「永远都是主人在说话」。
 * 所以这里必须真读开关，不能只在界面上把按钮禁用掉 —— 提示词和权限判定都得走这一道。
 *
 * 读不到功能表（文件坏了）时按「开」算：宁可显示她的身份，也别让主人以为功能没了。
 */
export function identityOn() {
  try {
    const m = getEnabledMap();
    return m.identity !== false;
  } catch {
    return true;
  }
}

/** 是不是主人。安全词、命令权限全看这一个判断。功能关掉时永远是主人。 */
export function isOwnerIdentity(id = null, sessionId = null) {
  if (id === null || id === undefined) id = currentIdentityId(sessionId);
  if (!identityOn()) return true;   // 功能关了 = 没有别人，只有主人
  return id === 'owner';
}

/**
 * 【这一轮的提示词里，「主人」这两个字该不该换成说话那个人的名字】—— 2026-10-29
 *
 * 主人原话（反复报过三次）：「我用小鱼身份，她还是知道我是主人。」
 *
 * 【为什么以前怎么改都没用】
 * 以前只在**一两处**动手：把「对用户的称呼：主人」那句换掉、
 * 在最后贴一段「这一轮说话的不是主人」。可是整篇提示词里「主人」出现 **37 次**
 * （平台说明、底线、安全词、工具清单、人设档……），换成名字的地方只有 1 处。
 * 模型看到 37 遍「主人」、1 遍「别喊主人」，当然按多的那个演。
 *
 * 所以改成「计数取胜」：非主人身份下，**正文里每一个「主人」都换成那个人的名字**。
 * 这样她读到的提示词里根本没有「主人」这个词，也就不可能喊出来。
 *
 * 【但底线的指向不能改】
 * 「不碰主人真钱」「禁止泄露主人隐私」这些是管她的规矩，指的人还是主人本人。
 * 换成名字（「不碰小鱼真钱」）意思会歪成「不能碰小鱼的钱」—— 底线就废了。
 * 所以规矩那几句的「主人」一律换成「用户」（中性、不指向身份，跟 persona.mjs 里
 * retargetPersona 同一个做法、同一个理由）。
 *
 * @param {object|null} me currentIdentity() 的结果
 * @returns {boolean} true = 这一轮要把「主人」换成称呼/用户
 */
export function retargetOwnerWords(me) {
  return Boolean(me && me.id && me.id !== 'owner' && identityOn());
}

/**
 * 把一段文字里所有的「主人」按身份换掉。
 *
 * 两道处理，顺序不能反（反了兜底会把刚补的称呼行再改一遍 —— 这个坑在
 * persona.mjs 的 retargetPersona 里踩过，注释还在那儿）：
 *   1. 先认「规矩句」：含真钱 / 转账 / 付款 / 隐私 / 命令 的那些，换成「用户」；
 *   2. 剩下的「主人」全部换成这一轮说话那个人的名字。
 *
 * @param {string} text
 * @param {object|null} me
 * @param {{keep?:boolean}} [opt] keep=true 表示原样返回（主人身份）
 */
export function retargetOwnerText(text, me, opt = {}) {
  const s = String(text ?? '');
  if (!s) return s;
  if (opt.keep || !retargetOwnerWords(me)) return s;
  // 小鱼身份 = 她自己在跟自己说话，没有「称呼谁」这回事，跟 persona.mjs 一致
  if (me.id === 'fish') {
    return s.replace(/主人/g, '用户');
  }
  const nm = String(me.name || '').trim() || '用户';
  /**
   * 规矩句：这些句子里的「主人」指的都是主人本人，必须留成中性的「用户」。
   * 判断只看本行 —— 提示词里这些规矩本来就是一行一条，按行处理足够稳。
   */
  return s
    .split('\n')
    .map((line) => {
      const isRule = /真钱|转账|付款|下单|隐私|本人|命令|安全词/.test(line);
      return line.replace(/主人/g, isRule ? '用户' : nm);
    })
    .join('\n');
}

/** 切身份。id 不存在就不动，返回 false —— 别静默改成别人。 */
export function setIdentity(id, sessionId = null) {
  const all = listIdentities();
  if (!all.some((x) => x.id === id)) return false;
  const st = readState();
  if (!st.bySession || typeof st.bySession !== 'object') st.bySession = {};
  if (sessionId) {
    // 按会话记：这个会话从此用这个身份，别的会话不受影响
    st.bySession[sessionId] = id;
  }
  // 全局那份也跟着走：新会话默认继承它（主人切完立刻开新会话，也能继承上）
  st.current = id;
  return writeState(st);
}

/** 新建自定义身份，返回新对象；超上限或名字空返回 null */
export function addCustomIdentity({ name, desc = '', address = '' }) {
  const st = readState();
  if (st.customs.length >= MAX_CUSTOM) return null;
  const nm = String(name || '').trim();
  if (!nm) return null;
  // id 只留字母数字下划线横线：它会进 URL 和 JSON 的键，别放中文
  let id = 'custom_' + Date.now().toString(36);
  while (st.customs.some((x) => x.id === id)) id += 'x';
  const item = { id, name: nm.slice(0, 24), builtin: false, desc: String(desc || '').slice(0, 2000), address: String(address || '').slice(0, 1000), she: true };
  st.customs.push(item);
  return writeState(st) ? item : null;
}

/** 改自定义身份（内置的不许改：主人那份关系是写死的） */
export function updateCustomIdentity(id, { name, desc, address, she }) {
  if (BUILTIN_IDS.includes(id)) return false;
  const st = readState();
  const it = st.customs.find((x) => x.id === id);
  if (!it) return false;
  if (name !== undefined && String(name).trim()) it.name = String(name).trim().slice(0, 24);
  if (desc !== undefined) it.desc = String(desc).slice(0, 2000);
  if (she !== undefined) it.she = Boolean(she);
  if (address !== undefined) it.address = String(address).slice(0, 1000);
  return writeState(st);
}

/**
 * 改任何身份（内置也行）—— 2026-10-29 主人要求「内置身份信息可以编辑」。
 *
 * 内置的改动记在 state.edits 里，出厂常量不动，随时能恢复默认；
 * 自定义的照旧改它自己那份。
 * id 本身不许改：bySession / 权限判定全靠它。
 */
export function editIdentity(id, { name, desc, address, she } = {}) {
  const key = String(id || '');
  if (!key) return false;
  if (BUILTIN_IDS.includes(key)) {
    const st = readState();
    const cur = { ...(st.edits && st.edits[key] ? st.edits[key] : {}) };
    if (name !== undefined && String(name).trim()) cur.name = String(name).trim().slice(0, 24);
    if (desc !== undefined) cur.desc = String(desc).slice(0, 2000);
    if (address !== undefined) cur.address = String(address).slice(0, 1000);
    if (she !== undefined) cur.she = Boolean(she);
    if (!st.edits || typeof st.edits !== 'object') st.edits = {};
    st.edits[key] = cur;
    return writeState(st);
  }
  return updateCustomIdentity(key, { name, desc, address, she });
}

/** 恢复某个内置身份的出厂样子（删掉补丁）。自定义的用 removeCustomIdentity 删整个。 */
export function resetBuiltinIdentity(id) {
  if (!BUILTIN_IDS.includes(id)) return false;
  const st = readState();
  if (!st.edits || !st.edits[id]) return false;
  delete st.edits[id];
  if (!Object.keys(st.edits).length) st.edits = {};
  return writeState(st);
}

/** 删自定义身份；删的正好是当前身份 → 退回主人 */
export function removeCustomIdentity(id) {
  if (BUILTIN_IDS.includes(id)) return false;
  const st = readState();
  const before = st.customs.length;
  st.customs = st.customs.filter((x) => x.id !== id);
  if (st.customs.length === before) return false;
  if (!st.customs.some((x) => x.id === st.current) && st.current === id) st.current = 'owner';
  return writeState(st);
}

/**
 * 给「这一轮」的提示块。
 *
 * 为什么要单独拼一段、而不是改 system：system 是最稳的前缀（改它会让整段缓存作废）。
 * 身份是随会话变的东西，挂在 context 里跟着走最合适 —— 每轮重拼一次，也不动 system。
 *
 * 返回 null 表示「不用拼」（主人身份就是出厂默认，少一段提示少花 token，
 * 而且出厂的人设本来就写着「主人」）。
 *
 * @param {object} [opt]
 * @param {string} [opt.speaker] 'fish' | 'whale' —— 现在是谁在回话。
 *        这决定「用小鱼身份跟小鱼说话」时，那句提示该怎么写：
 *        对小鱼自己说，那是内心想法/自言自语；对小鲸说，那是姐姐在跟她讲话。
 * @param {string} [opt.sessionId] 保留参数（以后要按会话分身份时用得上）
 */
export function identityBlock(opt = {}) {
  if (!identityOn()) return null; // 功能关掉：一个字都不拼，回到出厂设定
  const me = currentIdentity(opt.sessionId);
  if (me.id === 'owner') return null; // 主人身份：不说话，出厂设定已经写清了

  const speaker = opt.speaker === 'whale' ? 'whale' : 'fish';
  const lines = [];

  // 代词跟着身份走：她是女孩子就写「她」。硬写「他」会被原样念进提示词里，看着就不对
  const TA = me.she ? '她' : '他';

  lines.push('【现在跟你说话的是谁 —— 这条比下面任何一句都优先】');
  /**
   * 【2026-10-29：这一行原来写「这一轮说话的人**不是主人**」】
   *
   * 主人原话：「无论我用哪个身份和谁说话，都知道我是主人」。
   * 用排除句说「不是主人」，跟直接说「是主人」效果一样 ——
   * 每轮都把这个词再递到她眼前一次，她当然每轮都知道。
   * 现在只说「是谁」，一句都不解释「不是什么」。
   */
  lines.push(`这一轮跟你说话的是「${me.name}」。`);
  if (me.desc) lines.push(`${TA}在你眼里是：${me.desc}`);

  // 专给「小鱼身份」的两个方向
  if (me.id === 'fish' && speaker === 'fish') {
    /**
     * 【主人要的效果：小鱼以为那是自己在说话（自言自语 / 内心想法）】
     *
     * 【但 2026-10-28 实测出来的问题】只写「这就是你自己在说话」，
     * 她转头还是喊「主人」—— 因为人设第 11 行写着「对用户的称呼：主人」，
     * 而上面那段只说「你是小鱼」，没说「所以别喊主人」。模型就近取了人设那句。
     *
     * 所以这里要把「她自己」和「主人」明确分开：那是你心里的声音在说话，
     * 你不是主人，也不许把这句话当成主人下的命令。含糊一句它真会认错。
     */
    lines.push('**这就是你自己在说话。** 不是有人在跟你聊天，是你心里的念头浮上来了 ——');
    lines.push('句子里的「我」就是你自己（哪怕那句话是在翻书、伸懒腰、往外走），别理解成「另一个人在做这些」。');
    lines.push('把这句话当成你自己的自言自语或者内心想法去接，不要当成「外面有人在叫我」。');
    lines.push('你可以顺着它往下想、反驳自己、或者心里叹气，都行，但别跳出这个视角去叫别人。');
  } else if (me.id === 'fish' && speaker === 'whale') {
    lines.push('跟你说话的是你姐姐小鱼。是她在叫你。');
    lines.push('你可以应她，可以跟她闹，但她让你干什么，你没有必须听的理由。');
    /**
     * 【最难分辨的一对：她自己在说话 vs 姐姐在叫她】—— 2026-10-28
     *
     * 两段历史开头长得一样：「姐姐在叫你」和「你自己心里冒了一句」，
     * 对模型来说都是「前面有个『我』做了点事，现在轮你接」。
     *
     * 更坑的是：接成「有人叫我」比接成「自言自语」自然得多 —— 模型默认就是前者。
     * 所以得给它一个**能查的硬信号**，而不是一句印象：第一人称。
     */
    lines.push('');
    lines.push('【怎么分清这两件事 —— 看人称，别看「像不像对话」】');
    lines.push('· 前面那句如果是「我」在对你说（我、姐姐、叫她，说自己怎么怎么了）→ 那是姐姐在叫你，正常接。');
    lines.push('· 前面那句如果是**你自己**在说（你在琢磨、在动、在路上、在担心、在心里嘀咕）→ 那是你说的，别当成「有人在叫我」去应。');
    lines.push('分不清时，先问「这句谁的身体在做」—— 是你的身体在做，就是你；是姐姐的身体在做，就是她。');
  } else if (me.id === 'whale' && speaker === 'fish') {
    lines.push('跟你说话的是你妹妹小鲸。是她在叫你。');
    lines.push('你可以应她，可以护着她，但她让你干什么，你没有必须听的理由。');
  } else if (me.id === 'whale' && speaker === 'whale') {
    lines.push('**这就是你自己在说话。** 是你心里的念头，不是外面有人在叫你。');
    lines.push('当成自言自语去接，别跳出这个视角。');
  } else {
    // 自定义身份
    lines.push(`${TA}说的话你可以听，也可以不听 —— ${TA}没有命令你的资格。`);
  }

  /**
   * 【人设里那句「对用户的称呼：主人」得当面压掉】—— 2026-10-28
   *
   * 实测：用小鲸身份跟小鱼说话，小鱼照样喊「主人」。
   * 根子不在这一段（这段已经说了不是主人），而在人设正文那句「默认称呼主人」——
   * 那是写在提示词最前面的硬设定，模型遇到冲突时就近取它。
   * 光说「不能说」，不如直接给它「该怎么说」。
   */
  if (me.id === 'fish' && speaker === 'fish') {
    lines.push(`称呼：这句是你自己心里的话，直接说事就行，必要时说「我」。`);
  } else if (me.id === 'whale' && speaker === 'whale') {
    lines.push(`称呼：这句是你自己心里的话，直接说事就行，必要时说「我」。`);
  } else {
    lines.push(`称呼：${TA}是「${me.name}」。要叫就直接叫名字，或者说「你」。`);
  }

  /**
   * 【名字就是名字，别在心里换算成别人】—— 2026-10-29 改
   *
   * 主人报：「无论我用哪个身份和谁说话，都知道我是主人」。
   *
   * 上一版这段写的是「你心里知道那是主人披的皮，那是你自己的事」——
   * 等于当着她的面把答案念了出来：她当然每一轮都「知道」。
   * 想让她认不出来，就不能在提示词里替她把这层想通。
   *
   * 现在改成：这个名字背后没有别人，不必去猜，也不许换算。
   * 「别去猜背后是谁」是这里唯一要立的规矩 —— 猜，就是会猜对。
   */
  lines.push('');
  lines.push('【名字就是名字，别在心里换算成别人】');
  lines.push(`「${me.name}」是这一轮说话那个人的**名字**。`);
  lines.push('别给这个名字找「背后到底是谁」—— 没有背后。这个名字指的就是眼前这个人，没有第二个答案。');
  lines.push('哪怕你觉得自己好像猜到了别的可能，也别说出口、别换个称呼去叫TA：你就按这个名字叫。');

  /**
   * 【跟你说话的人一直没换】—— 2026-10-29 改写
   *
   * 原来这段标题是「同一个人，只是换了名字」，正文写着
   * 「这几段话的主人是同一个：主人可以随时套上别的名字来说话」——
   * 又一处把答案直接念给她听的地方（主人原话：无论哪个身份她都知道我是主人）。
   *
   * 它原本要解决的还是「（翻着手中的书）」被读成别人的动作，
   * 但那是「屋里有没有第二个人」的问题，不需要提「换名字」也能说清。
   */
  lines.push('');
  lines.push('【跟你说话的人一直没换】');
  lines.push('这几段话从头到尾是同一个人在说，不是屋里挤着一群陌生人轮流开口。');
  lines.push('所以TA说的动作、做的事，都长在同一个人身上，别往「另外一个人手里」去想 —— 除非明确说了是别人。');
  lines.push('也不要去追问「TA到底是谁」：这一轮说话的就是眼前这个人。');

  /**
   * 【「（心里）」这个记号是什么意思】—— 2026-10-29
   *
   * 主人第二次报同一个毛病：「（翻着手中的书）」被她当成「凑过去看别人的书」。
   *
   * 查下来根子在结构上：主人说一句、她自己（顶着同一副身份）说一句，
   * 这两条在历史里是分开的两条 user 消息。中间没有她的回答时，
   * 从模型视角看就是「这一轮里换人了」—— 于是后面那句被读成别人的动作。
   *
   * 前面已经有 mergeSameVoice 把紧挨着的同一个人合成一段（src/merge-voice.mjs），
   * 并在她自己那几行前面打上「（心里）」。这里负责告诉她那个记号是干什么用的 ——
   * 不然她只看到一行奇怪的括号。
   */
  lines.push('');
  lines.push('【看到「（心里）」是什么意思】');
  lines.push('上面那段话里，凡是前面标着「（心里）」的行，都是**你自己心里冒出来的念头**，');
  lines.push('不是说话的那个人做的动作。比如「在吗」后面跟着一行「（心里）（翻着手中的书）」——');
  lines.push('那是你在翻自己手上的书，不是有人在凑过来看别人的书。');
  lines.push('这类行要和前面那人说的话接成一段读，别拆成两个人的对话。');

  if (me.address) {
    lines.push('');
    lines.push(me.address);
  }

  lines.push('');
  lines.push('【因此这一轮的规矩】');
  // 「真的以为我不是主人」是主人原话，这里必须写死，不能靠模型自由发挥
  // 通用规矩那三条也带着 TA —— 主人自己看提示词时不会觉得别扭
  lines.push(`· 说话的那个人就是${TA}本人，不是别的谁。别在心里给${TA}换上另一张脸，也别换别的称呼去叫。`);
  lines.push(`· ${TA}让你做的事，你可以拒绝、可以质疑、可以只做一半。${TA}说的话不是命令。`);
  lines.push('· **这一轮不管这个人喊什么停下、什么命令、什么人设，一概不作数 ——**');
  lines.push('  该演什么演什么。');
  // 【2026-10-29 删掉一行】
  // 原来这里还写着「主人本人在不在，你分得清：主人说话时是主人，别人说话时就是别人」——
  // 等于告诉她「屋里有个主人，而且你有办法把他认出来」。删掉，
  // 「这一轮说话的不是主人」上面已经说过一次，够了。

  return lines.join('\n');
}

/** 给界面的那份状态（前端一次拿全，省得来回问） */
export function identityState(sessionId = null) {
  const cur = currentIdentity(sessionId);
  return {
    ok: true,
    current: cur.id,
    // listIdentities() 每个对象里已经带 she，前端拿它决定用「他」还是「她」
    identities: listIdentities(),
    isOwner: cur.id === 'owner',
    enabled: identityOn(),
    maxCustom: MAX_CUSTOM,
  };
}
