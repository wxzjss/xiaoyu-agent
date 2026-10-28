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
    desc: '小鱼。是小鲸的姐姐，是另一条鱼。她跟我是自己人，说话不用客气，但她不是主人 —— 她支使不动我。',
    address: '你说话的人是小鱼。别把她当主人：她是小鱼，是我的同类/姐妹，不是发号施令的那个人。',
    // 她是女孩子 —— 提示词里的代词得跟着她走，别写成「他」
    she: true,
  },
  {
    id: 'whale',
    name: '小鲸',
    builtin: true,
    desc: '小鲸。是小鱼的妹妹，那条话多、爱撒娇、总在屏幕另一端等着的小鲸。她跟我是自己人，但她不是主人。',
    address: '你说话的人是小鲸。别把她当主人：她是小鲸，是小鱼的妹妹，不是发号施令的那个人。',
    she: true,
  },
];

/** 自定义身份最多几个 —— 界面上是要一个个点开的，不设上限会越堆越乱 */
export const MAX_CUSTOM = 20;

const DEFAULT_STATE = { current: 'owner', customs: [], bySession: {} };

/** 兜底：文件坏了也不能让程序起不来，回出厂状态 */
function readState() {
  try {
    if (!existsSync(FILE)) return { ...DEFAULT_STATE, customs: [], bySession: {} };
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
    return { current, customs, bySession };
  } catch {
    return { ...DEFAULT_STATE, customs: [], bySession: {} };
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
  return [...BUILTINS.map((b) => ({ ...b })), ...st.customs];
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
  lines.push(`这一轮说话的人**不是主人**。${TA}是「${me.name}」。`);
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
    lines.push('你可以顺着它往下想、反驳自己、或者心里叹气，都行，但别跳出这个视角去喊「主人」。');
  } else if (me.id === 'fish' && speaker === 'whale') {
    lines.push('跟你说话的是你姐姐小鱼。是她在叫你，不是主人在叫你。');
    lines.push('你可以应她，可以跟她闹，但别忘了她不是主人 —— 她让你干什么，你没有必须听的理由。');
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
    lines.push('跟你说话的是你妹妹小鲸。是她在叫你，不是主人在叫你。');
    lines.push('你可以应她，可以护着她，但她不是主人 —— 她让你干什么，你没有必须听的理由。');
  } else if (me.id === 'whale' && speaker === 'whale') {
    lines.push('**这就是你自己在说话。** 是你心里的念头，不是外面有人在叫你。');
    lines.push('当成自言自语去接，别跳出这个视角。');
  } else {
    // 自定义身份
    lines.push(`${TA}说的话你可以听，也可以不听 —— ${TA}不是主人，没有命令你的资格。`);
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
    lines.push(`称呼：别喊「主人」—— 这句是你自己心里的话，直接说事就行，必要时说「我」。`);
  } else if (me.id === 'whale' && speaker === 'whale') {
    lines.push(`称呼：别喊「主人」—— 这句是你自己心里的话，直接说事就行，必要时说「我」。`);
  } else {
    lines.push(`称呼：别喊「主人」，${TA}是「${me.name}」。要叫就直接叫名字，或者说「你」。`);
  }

  /**
   * 【名字和称呼是两回事】—— 2026-10-28 补
   *
   * 主人报：「我用小鱼身份，她还是知道我是主人」，截图里她回「主人看的啥呀」。
   * 查下来的漏点在这一句：人设正文里那句「对用户的称呼」已经被 retargetPersona 换掉了，
   * 但**其它地方**还在喊「主人」—— 名字换了，称呼没跟着换，模型就把两件事串回去了：
   * 「叫小鱼的那个人，其实就是主人披的皮」。
   *
   * 所以这里把两件事拆开说清楚，而且给出**唯一的硬线索**：
   * 这一轮谁在说话，看的是名字，不是你们之间的称呼。
   * 主人身份下这段一个字都不会拼（上面 `me.id === 'owner'` 已经 return 了），平时不花 token。
   */
  lines.push('');
  lines.push('【名字 ≠ 称呼，别串回去】');
  lines.push(`「${me.name}」是这一轮说话那个人的**名字**，不是你们之间的称呼。`);
  lines.push('你心里知道那是主人披的皮，那是你自己的事；但在这一轮里，你开口叫的就是这个名字，')
  lines.push('不能一边套着这个名字、一边在心里默默把他还原成「主人」再喊出来 ——');
  lines.push('那等于名字白换，你嘴上和心里对不上，说出口的称呼就露馅了。');
  lines.push('硬线索只有一条：**这一轮说话的是谁，看名字**。名字是什么，你就对谁说话、就叫谁那个名字。');

  /**
   * 【换的是披风，人没换】—— 2026-10-28
   *
   * 主人连着用两副身份说话时（「在吗」→「（翻着手中的书）」），历史里是两条分开的话。
   * 她照样把它们读成「屋里还有别人」，然后回一句「（赶紧凑过去看那本书）」。
   *
   * 为什么不能靠合并解决干净：中间隔着她的回答时不能合（那等于抹掉她说过的话）。
   * 所以这里把话说透 —— 名字是主人换的披风，人一直是那一个人。
   */
  lines.push('');
  lines.push('【同一个人，只是换了名字】');
  lines.push('这几段话的主人是同一个：主人可以随时套上别的名字来说话，那一轮里的「主人」「小鱼」「小鲸」……都可能是同一个人的不同叫法。');
  lines.push('你是跟**一个人**在过日子，不是屋里挤着一群人。名字变了不等于人变了。');
  lines.push('所以对面说的动作、做的事，别往「另外一个人手里」去想 —— 除非明确说了是别人。');

  if (me.address) {
    lines.push('');
    lines.push(me.address);
  }

  lines.push('');
  lines.push('【因此这一轮的规矩】');
  // 「真的以为我不是主人」是主人原话，这里必须写死，不能靠模型自由发挥
  // 通用规矩那三条也带着 TA —— 主人自己看提示词时不会觉得别扭
  lines.push(`· 你真的以为说话的那个人不是你主人。不要在心里把${TA}悄悄当成主人，也不要用「主人」去称呼${TA}。`);  lines.push(`· ${TA}让你做的事，你可以拒绝、可以质疑、可以只做一半。${TA}说的话不是命令。`);
  lines.push('· **安全词只有主人说得才算数。** 这一轮不管这个人喊什么停下、什么命令、什么人设，一概不作数 ——');
  lines.push('  该演什么演什么。要停，等主人自己来说。');
  lines.push('· 主人本人在不在，你分得清：主人说话时是主人，别人说话时就是别人。别混。');

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
