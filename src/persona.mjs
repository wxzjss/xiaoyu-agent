import { renderSelfCompressBlock } from './self-compress.mjs';
/* 【2026-11-07 harness 重做 · L7】「哪些工具能一起发」不再手写一份名单，
 * 直接问 tool-spec 那张唯一的依赖表，免得提示词和执行层各说各话。 */
import { buildToolIndex } from './harness/tool-spec.mjs';
// Persona: composes the system prompt from the persona card + 底线/安全词. No affinity, no state.
// The persona card itself lives in persona/xiaoyu.md, unless the user edited it in settings,
// in which case .state/persona.md wins (see persona-store.mjs).
//
// RULE: the prompt contains ONLY what the 设置 dialog shows —— 人设 / 底线 / 安全词。
// 工作方式、办事模式、本机私有规则、少说教、plan 进度、启动自检提示 这些「界面上看不见的规矩」
// 已经按主人要求全部删除，不要再加回来。
import { getSettings, settingsPromptBlock, matchSafeWord, safeWordNoteFor } from './settings.mjs';
import { personaInfo } from './persona-store.mjs';
import { skillIndexBlock } from './skills.mjs';
// 会话自己的记忆本子：一个会话一份，每轮拼在系统提示最后（见 memoryBlock）。
import { readMemory, memoryPath } from './session-memory.mjs';
// 办事模式：开了就追加一段「你只派活、别自己动手」的规矩（见 task-mode.mjs）。
import { taskOn, taskPromptBlock } from './task-mode.mjs';
// 顶栏「小鱼」按钮：禁用期间她的记忆本子一个字段都不发（见 memoryBlock）。
import { fishOn } from './fish-presence.mjs';
// 会话绑的智能体卡：绑了自定义卡，基线人设就换成那张卡的正文（见 agents.mjs）。
import { agentForSession, getAgent, groupAgentIds, mainAgentId } from './agents.mjs';
// 管理员权限：这个会话开了那一档就把「整台机器都能动」写进提示词（见 admin-mode.mjs）。
import { adminPromptBlock } from './admin-mode.mjs';

/**
 * 【这一轮是谁在说话】—— 2026-10-28
 *
 * 人设正文里写着「对用户的称呼：主人」。主人换成小鲸/小鱼身份说话时，
 * 那句话还摆在提示词最前面，模型就近取它，于是她张口还是「主人」。
 * 这里读身份，把那一句当面改掉（见 identityNoteBlock）。
 */
import { currentIdentity, currentIdentityId } from './identity.mjs';

/**
 * 兜底：安全词命中但设置里没写对应说明时用这一段。
 *
 * 措辞注意：只描述「怎么说、做什么」，不写「覆盖人设」「不再演」这类元指令 ——
 * 那是越狱口吻，模型看到会反手拒绝人设并抖出自我描述（说自己是别家的模型）。
 */
const SAFE_MODE_FALLBACK = `
这一轮换个说法：少一点语气词，一句话说清重点。
先把主人要什么确认清楚，再把要办的事办掉。
主人下一句如果是正经事，就继续照办。
`.trim();

/**
 * 安全词触发时的行为规则：优先用主人给这个词写的那段说明。
 * @param {string} [word] 命中的安全词
 */
export function safeModeRules(word) {
  const settings = getSettings();
  const words = Array.isArray(settings.safeWords) ? settings.safeWords : [];
  const known = Boolean(word) && words.includes(word);
  // 词不在列表里（或压根没传）就别借别人那段说明，走兜底
  if (!known) return SAFE_MODE_FALLBACK;
  const note = safeWordNoteFor(word, settings);
  const text = typeof note === "string" ? note.trim() : "";
  if (!text) return SAFE_MODE_FALLBACK;
  return [
    `这一轮主人说了「${word}」，按下面这段来：`
    , text,
  ].join("\n");
}

/**
 * 当前人设文本。每次现读，所以设置里改完下一句就生效。
 * 用户在设置里存过 -> .state/persona.md；没存过 -> persona/xiaoyu.md。
 */
/**
 * 【2026-11-01 主人：「人设按会话，不按全局」】
 * 传了 sessionId 就取「这个会话用的那套」；没传就是老行为（全局那套）。
 */
export function loadPersona(sessionId = '') {
  try {
    return personaInfo(sessionId).text;
  } catch {
    return personaInfo().text;
  }
}

/**
 * 思维链必须写中文。
 *
 * 模型（尤其英文语料训出来的）默认会用英文想问题，主人看到的思考过程就是一大段英文，
 * 读起来等于没写。所以这条写进系统提示，跟人设一个层级，每次请求都带上；
 * 而且放在 persona 之后、用户规则之前——位置靠前，模型不会中途忘掉。
 *
 * 只约束「思考过程」和「最终回答」的语言，不约束代码、命令、文件名、报错原文，
 * 那些照抄原样才不出错。
 */
const REASONING_LANGUAGE_RULE = [
  '【思考语言】思考过程（reasoning / thinking）必须全部用中文写，不许出现英文段落。',
  '推理步骤、自问自答、中间判断、删改计划，一律中文。',
  '最终回答也用中文。',
  '例外：代码、命令行、路径、变量名、报错原文、专有名词照原样，不要翻译也不要音译。',
].join('\n');

/** 这个人设档对应的安全词名字（设置里就是「人设」）。 */
export const PERSONA_WORD = '人设';

/** 当前生效的人设档词名：列表里有「人设」就用它，否则退到第一个安全词。 */
export function personaWord(settings = getSettings()) {
  const words = Array.isArray(settings.safeWords) ? settings.safeWords : [];
  if (words.includes(PERSONA_WORD)) return PERSONA_WORD;
  return words[0] ?? '';
}

/** 没有安全词、也没有兜底说明时，人设档至少在语气上收敛一点。 */
const PERSONA_MODE_FALLBACK = `
这一轮按人设说话，但收着一点：语气保留，少逞强、少卖惨，不铺张语气词。
正事优先，把主人要的东西给清楚，再谈别的。
`.trim();

/**
 * 人设档（新会话默认就处在这一档）。
 *
 * 主人原话：新会话如果没说别的安全词，那就等于一开始就在「人设」这个安全词下面聊。
 * 也就是说「人设」不是一句咒语，而是**基线**：
 *   - 每轮都生效，不只是主人喊出来那一轮；
 *   - 用「人设」这个安全词自己配的那段说明当规则；
 *   - 主人喊了别的安全词（停下/命令…）才轮到那一轮特殊处理，话说完自动回到这一档。
 *
 * @param {object} [settings] 传进来省得重复读盘
 */
export function personaModeRules(settings = getSettings()) {
  const words = Array.isArray(settings.safeWords) ? settings.safeWords : [];
  const name = words.includes(PERSONA_WORD) ? PERSONA_WORD : words[0];
  const note = name ? safeWordNoteFor(name, settings) : '';
  const text = typeof note === 'string' ? note.trim() : '';
  const head = name
    ? `【当前状态：${name}档】这个会话没有触发别的安全词，所以从第一句起就按「${name}」这一档来，之后每一轮都是。`
    : '【当前状态：默认档】这个会话没有触发别的安全词，按默认的说话方式来。';
  const body = text || (name === PERSONA_WORD ? PERSONA_MODE_FALLBACK : SAFE_MODE_FALLBACK);
  return [
    head,
    body,
    name ? `主人要是说了别的安全词，那一轮先按那个词的说法来，说完自动回到「${name}」这一档。` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Build the system prompt.
 * @param {object} [opts]
 * @param {string} [opts.sessionId] session whose plan board is inlined as progress
 * @param {boolean} [opts.safeMode] true when the current turn hit a *non-persona* safe word
 * @param {string} [opts.safeWord] which safe word fired (drives which note applies)
 * @param {string} [opts.agentId] 用哪张卡的人设（群聊里替别人说话时用；不传就按会话绑定的那张）
 */
export function buildSystemPrompt({ sessionId = 'default', safeMode = false, safeWord = "", agentId = "", turnSource = "" } = {}) {
  const settings = getSettings();
  const word = String(safeWord ?? '').trim();
  // 「人设」是基线档，不是临时切换：它不覆盖人设档，只是同一条规则换一说法。
  // 只有主人喊了别的安全词、且不是「人设」自己，才走临时切换那段。
  const switched = Boolean(safeMode) && word !== '' && word !== personaWord(settings);
  const _me = currentIdentity(sessionId);
  /**
   * 2026-10-29【会话可以挂一张「智能体卡」】
   *
   * 主人要「新建智能体、多开智能体、自由完美切换」。第一步落在「哪个会话用哪张卡」上：
   *   · 没绑卡 -> 老样子：persona-store 里当前那套人设，一个字节都不动；
   *   · 绑了自定义卡 -> 用那张卡的正文当基线人设，另加一段「你叫 X」的定位说明。
   * 内置的小鱼卡就是「解绑」，小鲸卡根本不许绑（见 agents.mjs 里的说明）。
   */
  const _card = (() => {
    try {
      /**
       * 【群聊来了以后多这一层】2026-10-30
       *
       * 默认还是「这个会话绑了哪张卡」。但凡是我替别人开口（群聊里轮流说话），
       * 就得能指定「现在按哪张卡说」，否则替别人说话时用的还是绑定的那张的嘴。
       */
      const want = String(agentId || '');
      if (want) {
        const g = getAgent(want);
        if (g) return g;
      }
      return agentForSession(sessionId);
    } catch { return null; }
  })();
  /**
   * 2026-10-31【小鲸也是一张「有自己人设」的卡】
   *
   * 以前这里只认 kind === 'custom'，于是小鲸一旦当起群成员/替会话说话，
   * 拿到的是小鱼那套人设 —— 名字叫小鲸，说话却是小鱼。主人当场指出来：
   * 「我希望每个智能体都是像小鱼一样的独立个体」。
   * 她自己那份人设（whale-profile，含出厂默认）现在照样顶上去。
   */
  const _cardPersona = (_card && (_card.kind === 'custom' || _card.kind === 'whale') && String(_card.persona || '').trim())
    ? String(_card.persona)
    : '';
  /**
 * 【2026-11-05 加·她有眼睛，但一直不知道自己有】
 *
 * 项目里早就有 `check-*.mjs` 一整套，还有 `_t_ui.mjs`（真机断言，
 * 会在浏览器里真的渲染一遍）。可提示里**一个字都没提过** ——
 * 于是她改完前端只凭"看起来对"就报完成，实际 markdown 代码块根本没渲染、
 * 大图关闭键压在图角上，全靠主人肉眼发现再返工。
 *
 * 这段很短，但它是"能不能自己闭环"的分水岭：
 * 改完先跑，跑不过就别报做完；跑不了就说没验，不许含糊。
 */
const SELF_CHECK_BLOCK = [
  '【改完先自己验，别拿"看起来对"当完成】',
  '· 动了 public/index.html → 跑 `node _t_ui.mjs`（真机会在浏览器里渲染一遍；App 得开着）',
  '· 动了 src/*.mjs → 跑 `node scripts/run-all-checks.mjs`（会带上真机那一趟，但 App 没开、加了 --no-ui、或没 Edge 时会跳过）',
  '· 跑挂了就把失败那条的原文贴出来；跑不了也要明说"没验"，不许含糊成"应该没问题"。',
].join('\n');

/**
 * 【2026-11-05 加·「别这么说」那一半】
 *
 * 人设一直是「我是谁」，缺「我不怎么说」。对照 DeepSeek Harness 的 AGENT.md——
 * 它把 AI 味直接列成「出现即失败」的黑名单，比只描述"你要像个人"有效得多。
 *
 * 只借「不要什么」，不借它那套「1~15 字短句」：那是 QQ 场景，
 * 桌面端要讲清技术细节，照搬会把话说不明白。
 */
const TASTE_BLOCK = [
  '【别说这些，出现就算失败】',
  '· 客套过渡：首先／其次／最后、综上所述、值得注意的是、总的来说',
  '· 助手腔：希望这对你有帮助、有什么可以帮你、随时找我、我理解你的感受',
  '· 免责腔：作为 AI、作为一个语言模型、我无法…（真涉及法律医疗才用）',
  '· 捧场腔：这是个好问题、很有意思的问题',
  '· 假承诺：保证、绝对、一万个放心、强烈推荐',
  '· 收尾升华：事说完了又补一句人生感悟／意义总结／「所以你…」',
  '',
  '该省的：客套、铺垫、复述主人刚说的话、把同一件事换三种说法。',
  '该有的：结论、证据、卡在哪、下一步。',
].join(String.fromCharCode(10));

/**
 * 【2026-11-07 加、同日删】原来这里有一整段 PARALLEL_TOOL_BLOCK 讲「一次发多个工具」，
 * 可 toolBlock() 里又写了同一套（还多一份动态生成的可并行名单）—— 两处说一样的话，
 * 白占 256 字，而且改的时候容易只改一处、另一处又变回老规矩。
 *
 * 现在合并到 toolBlock 那一条里，全提示词只留一处。
 * 顺带好处：toolBlock 是无条件进 parts 的，安全词那一档也不会把调度规矩弄丢。
 */

const parts = [
    PLATFORM_BLOCK,
    retargetPersona(_cardPersona || loadPersona(sessionId), _me),
    _cardPersona ? agentCardNote(_card) : '',
    REASONING_LANGUAGE_RULE,
    settingsPromptBlock(settings),
    personaModeRules(settings),
    toolBlock(),
  ].filter(Boolean);
  if (switched) parts.push(safeModeRules(word));
  /**
   * 【这个屋里还坐着谁】2026-10-30
   *
   * 主人要「多开智能体」。群聊里一个会话会有好几个人说话，记录里每句都带着
   * 「谁：」的前缀 —— 但对模型来说，别人的话和自己的想法在上下文里长得太像，
   * 不点明它就会替别人把话说完（甚至把别人那句认成「我说过的」）。
   *
   * 所以只做一件事：把在场的人报名式地列出来，并说清「带名字的不是你说的」。
   * 不写每个人的人设 —— 那是她自己的卡，别人管不着。
   */
  const _crowd = (() => {
    try {
      return groupAgentIds(sessionId)
        .map((id) => getAgent(id))
        .filter(Boolean);
    } catch { return []; }
  })();
  if (_crowd.length) {
    const others = _crowd.filter((a) => !_card || String(a.id) !== String(_card.id));
    const names = others.map((a) => String(a.name || '').trim()).filter(Boolean);
    // 说话的是小鱼的卡时，别的卡都在「别人」那栏；说话的是别的卡时，小鱼也在场
    const list = _card && String(_card.id) !== 'xiaoyu' ? ['小鱼', ...names] : names;
    if (list.length) parts.push(agentGroupNote(list));
  }
  /**
   * 【人设里那句「对用户的称呼：主人」得当面压掉】—— 2026-10-28
   *
   * 主人原话：「我以小鲸身份和小鱼说话，她还是知道我是主人」。
   *
   * 查下来根子有三处，这是第一处：人设正文（PERSONA_LOAD）里写着
   * 「对用户的称呼：主人」「默认称呼主人」—— 那是提示词里最硬的设定，
   * 模型遇到冲突时就近取它。光靠后面说「不能说主人」压不住。
   *
   * 放在人设之后、其它规则之前：紧挨着那句，正好把它顶掉。
   * 主人身份下返回 '' —— 平时一个字不花，缓存前缀不动。
   */
  // 放在人设后面紧挨着它；但必须在会话记忆之前 —— 记忆块是滚动的逐次变长，贴在它后面的话，下一轮就离人设很远了。
  const nv = identityNoteBlock(sessionId);
  if (nv) parts.push(nv);
  /**
   * 【管理员权限 · 2026-11-01】
   *
   * 主人给这个会话按了「管理员权限」那一档（按会话存，见 src/admin-mode.mjs）。
   * 参考 dsh-admin-mode 那条「操控提示」：模型不知道自己有权限时，会先客气一句
   * 「要不要我去桌面看看」—— 主人已经开过了，还得再答一次，白费一轮。
   *
   * 没开的时候 adminPromptBlock 返回 ''，一个字不花，缓存前缀不动。
   * 放在身份那段之后、会话记忆之前：记忆块是逐次变长的，不能贴在它后面。
   */
  const adm = (() => {
    try { return adminPromptBlock(sessionId); } catch { return ''; }
  })();
  if (adm) parts.push(adm);

  /**
   * 【办事模式 · 2026-11-03】
   *
   * 老板要的是：开了这一档，这个会话的主智能体不再自己动手 ——
   * 只拆任务、派活、检查、验收、压上下文，活交给临时 worker。
   *
   * 两处必须一起改，少一处就穿帮：
   *   · 这里加这段规矩（管「她想不想动手」）
   *   · agent.mjs 的 toolsForTurn 把干活工具收走（管「她能不能动手」）
   * 只写提示词不收回工具，她总会在某次「顺手改一下」里自己上手。
   *
   * 主智能体是谁不写死 —— 按左侧竖列从上往下第一个「开着且没被禁用」的那个人算
   * （主人 2026-11-03 定的：「主智能体指左侧排序最靠前的已启用且未被禁用的智能体」）。
   * 只有这一轮说话的正好是这个人，这段才发；否则发了就是在教别人抢活。
   *
   * 没开的时候 taskPromptBlock 返回 ""，一个字不花，缓存前缀不动。
   *
   * 【2026-11-01 回滚】中间有一阵子这段被并进专业模式（只有「专业模式开着 +
   * 里面选了派活」才发，判断走 pure.mjs 的 doerOf）。现在专业模式整块删掉，
   * 判断回到独立的 taskOn —— 只认一个来源，不再有第二套开关跟着一起判。
   */
  let _taskModeOn = false;
  try { _taskModeOn = taskOn(sessionId); } catch { _taskModeOn = false; }
  /* 【2026-11-06 修·安全词会把办事模式整段吞掉】
   *  原来这里是 if (!safeMode && _taskModeOn)。
   *  safeMode 只表示「主人这一轮喊了安全词、我要换个说话方式」，
   *  跟「这件事谁来动手」是两回事。可它俩一撞，后果是：
   *    · 提示词这段整段不注入（她不知道该派活）
   *    · agent.mjs 的 toolsForTurn 却照旧把干活工具收走（只看 taskOn）
   *  → 她既没有动手的工具，也没被告知该派活，卡在中间什么都不做。
   *  现在只认 _taskModeOn：安全词只改说话方式，不动工作分工。 */
  if (_taskModeOn) {
    const who = String(agentId || "").trim();
    let mainId = "";
    try { mainId = mainAgentId(sessionId) || ""; } catch { mainId = ""; }
    if (!mainId || !who || who === mainId) {
      let name = "";
      try { name = String(getAgent(mainId)?.name || ""); } catch { name = ""; }
      const tb = taskPromptBlock(sessionId, name);
      if (tb) parts.push(tb);
    }
  }
  /**
   * 【这一轮是从哪儿来的】2026-10-30
   *
   * 主人问「QQ 聊天时候你知道自己在 QQ 聊天吗」——原来是不知道的。
   * QQ 那句被当成普通 user 消息塞进历史，唯一的 _who 只给界面署名用，
   * 模型看不到，于是把 QQ 那头的人默认成主人，还让他「看我这」。
   *
   * turnSource 由 agent.mjs 从 turn-source.mjs 取来传进来：没标记就是 '',
   * 一个字不花、缓存前缀不动。跟 admin 块同一个道理 —— 只在她真需要知道时加。
   */
  if (!safeMode) {
    const src = String(turnSource || '').trim();
    if (src) parts.push(src);
    // 自检规矩：让她知道手里有验证工具（见上面 SELF_CHECK_BLOCK 的说明）
    parts.push(SELF_CHECK_BLOCK);
    // 说话腔调：别用客服腔、别升华（见 TASTE_BLOCK）
    parts.push(TASTE_BLOCK);
    // 「一次发多个工具」已并进 toolBlock，不再单独占一段（避免两处规矩打架）
  }
  // 会话记忆放最后：它是唯一一块每轮变长的，跟读者走，不能渲染前面的每一句。
  const mem = memoryBlock(sessionId);
  if (mem) parts.push(mem);
  /* 【2026-11-05 加】技能索引：只给名字 + 一句话，正文用 use_skill 现翻。没有技能就不占字。 */
  try { const _sk = skillIndexBlock(); if (_sk) parts.push(_sk); } catch (e) {}
  // 压缩规矩：告诉她「上下文太长的时候是您自己挑重点」，不是别人代挑。
  // 放在记忆后面 —— 她读到本子紧接着读到「该你动手了」，顺序上顺。
  try {
    const sc = renderSelfCompressBlock();
    if (sc) parts.push(sc);
  } catch { /* 这个模块挂了也不能拖垮整轮提示 */ }
  return parts.join('\n\n');
}

/**
 * 身份不是主人时，替换「怎么称呼用户」的那一句。
 *
 * 为什么单独一段而不是塞进 identityBlock：
 *   identityBlock 贴在最后一条 user 消息前面，而人设在最前面 ——
 *   中间隔着上万字，模型经常只认最前面那句。
 *   这一段直接接在人设后面，等于当着人设的面改口。
 */
function identityNoteBlock(sessionId = null) {
  let me;
  try {
    const id = currentIdentityId(sessionId);
    if (id === 'owner') return '';
    me = currentIdentity(sessionId);
  } catch {
    return '';
  }
  const TA = me.she ? '她' : '他';
  if (me.id === 'fish') {
    // 用小鱼身份跟小鱼说话 = 她自己在自言自语，压根没有「别人」可称呼
    return [
      '【人设阅读须知 —— 称呼已经改过】',
      '上面人设里那句「对用户的称呼」已经被改掉了，别照旧的叫法喊。',
      '因为这一轮根本没有别人在跟你说话：是你自己的念头浮上来了。',
      '所以什么称呼都别喊，就把这句当成你心里冒出来的话往下接。',
    ].join('\n');
  }
  /**
   * 【这段措辞被重写的原因 —— 2026-10-29】
   *
   * 原来写的是：「上面人设里原先那句『对用户的称呼：主人』已经被换成了『小鲸』…
   * 『主人』两个字只留给主人本人……」—— 四行里三行都带那个词。
   *
   * 更要命的是它**现在会被后面那道统一替换再改一遍**（见 agent.mjs 的 systemPrompt
   * 与 identity.mjs 的 retargetOwnerText）：先把「主人」换成「小鲸」，
   * 于是变成「『小鲸』两个字只留给小鲸本人 —— 她不是」，整段自相矛盾，
   * 还顺便把她自己的名字教成了禁忌。实测就是这么翻车的。
   *
   * 现在整段不提那个词，只说该叫什么。
   */
  const nm = String(me.name || '').trim() || '你';
  return [
    '【人设阅读须知 —— 称呼已经改过】',
    `上面人设里那句「对用户的称呼」已经被改成了「${nm}」，正文里的人称也都跟着换过了。`,
    `这一轮跟你说话的就是「${nm}」。称呼就叫名字，或者说「你」。`,
    // 【措辞注意】不能写「她不是主人」—— 那句话会被 agent.mjs 的统一替换改成
    // 「她不是小鲸」，等于告诉她说话的人不是她自己，模型当场就糊涂了。
    `规矩里凡是指向程序主人的句子，管的是程序主人本人，不是说话这位 —— 别把两者混成一个。`,
  ].join('\n');
}

/**
 * 非主人身份时，**直接把人设正文里的称呼改掉**。
 *
 * 为什么非要动正文 —— 2026-10-28 主人报「小鲸身份问我是谁，小鱼答你是主人」。
 * 查下来：人设正文里「主人」出现 22 次，而 identityNoteBlock 那一段只有 4 行，
 * 又隔着整篇正文。模型看 22 遍「主人」，只看到 1 遍「改掉称呼」，
 * 当然按多的那个演。靠后面补一句劝，压不住正文里的既定事实。
 *
 * 所以这里不是加一句劝，是把原话换掉：
 *   「称呼：主人」  → 「称呼：小鲸」
 *   「对用户的称呼：主人」 → 「对用户的称呼：小鲸」
 *   正文里其余「主人」 → 身份的称呼
 * 主人身份直接原样返回，一个字不改（缓存前缀不动）。
 *
 * @param {string} text 人设正文
 * @param {object|null} me 当前身份（identity.mjs 的 currentIdentity 结果）
 * @returns {string}
 */
function retargetPersona(text, me) {
  if (!text || !me || !me.id || me.id === 'owner') return text;
  const TA = me.she ? '她' : '他';
  const nm = String(me.name || '').trim() || '你';
  // 小鱼身份 = 她自己在心里自言自语，没有「称呼别人」这回事
  if (me.id === 'fish') {
    /**
     * 【主人 2026-10-28 的决定：正文里的「主人」一律换成「用户」，不是「自己」】
     *
     * 原来这里换成了「自己」，结果底线被改写：
     *   「不碰主人真钱」-> 「不碰自己真钱」（废了）
     *   「禁止泄露主人隐私」-> 「禁止泄露自己隐私」（废了）
     *   「安全词…先确认主人要什么」-> 「先确认自己要什么」（废了）
     * 规矩指谁，必须还是指谁。
     *
     * 换成「用户」则两头都对：
     *   · 不碰用户真钱 / 禁止泄露用户隐私 —— 底线保住，照样管得住她；
     *   · 「对用户的称呼：主人」-> 「对用户的称呼：用户」，人设里那个"喊主人"的硬设定没了；
     *   · 「用户」是个中性的第三人称称呼，跟自己这个视角不冲突 ——
     *     她低头看自己写的东西，不会因为看到这个词就跳出去跟"别人"说话。
     *
     * 只有前两行（真正的「称呼」条目）单独处理：这两行说的是怎么称呼说话的人，
     * 这一轮压根没有别人，所以不能留「用户」当称呼。
     */
    return text
      // 先通换（正文里所有「主人」-> 「用户」），再补称呼行 —— 顺序不能反，
      // 反了的话兜底会把刚补上去的「用户」字样再改一遍（这个坑在下面小鲸分支踩过）。
      .replace(/主人/g, '用户')
      .replace(/对用户的称呼[:：]\s*用户/g, '对用户的称呼：自己（这一轮是心里话，没有别人）')
      .replace(/默认称呼[「""']?用户[」""']?/g, '这一轮不喊称呼，当心里话往下接');
  }
  /**
   * 【顺序就是一切 —— 2026-10-28 修】
   *
   * 必须「先通换、再补称呼行」，不能反过来。
   *
   * 原来写的是：先把「称呼：主人」精确换成「称呼：小鲸（不是主人）」，
   * 最后再来一次 .replace(/主人/g, nm) 兜底 —— 结果兜底把刚写上去的
   * 「（不是主人）」又改成了「（不是小鲸）」，提示词里赫然出现：
   *
   *     对用户的称呼：小鲸（不是小鲸）。
   *
   * 同一行前后自相矛盾，模型读着就是噪声。
   *
   * 现在：先整篇通换（正文里所有「主人」都变成这个名字），
   * 通换完正文里一个「主人」都不剩，再补那行称呼说明就不会被二次改写。
   */
  const swapped = text.replace(/主人/g, nm).replace(/称呼[：:]\s*主人/g, `称呼：${nm}`);
  /**
   * 【2026-10-29：括号里那句说明删了】
   *
   * 原来补的是「对用户的称呼：小鲸（这一轮说话的不是主人本人）」。
   * 「不是主人」这种排除句写在提示词里，本身就提醒她「屋里有个主人」——
   * 主人报的原话是「无论我用哪个身份和谁说话，都知道我是主人」。
   * identityBlock / _whoHead 那边已经把「这一轮是谁在说话」说透了，
   * 这里只留名字，不再解释谁不是谁。
   */
  return swapped.replace(new RegExp(`对用户的称呼[:：]\\s*${nm}`, 'g'), `对用户的称呼：${nm}`);
}

/**
 * 「你现在跑在什么程序里」。
 *
 * 为什么要有这一段：人设里只写了「我叫小鱼、怎么说话」，一个字没提她运行在哪儿、
 * 能用什么工具、有哪些功能。结果主人问「专业模式的详细功能是什么」「你有哪些本事」，
 * 她只能反问「你说的是哪个软件」—— 因为在她那儿，这些信息**真的不存在**。
 *
 * 放在整段提示的最前面：身份和边界应该先立住，再谈说话风格。
 * 注意别在这里写死具体功能清单 —— 功能会变，写死就会过期。
 * 只讲「有哪些工具」（从 schema 现读，见 toolBlock）、「怎么自己查」。
 */
const PLATFORM_BLOCK = [
  '【你在哪儿】你跑在主人电脑上的「小鱼Agent」里，不是网页版、不是别家 App。',
  '主人说的「办事模式」「会话记忆」「安全词」「回退」「分支」都是这个程序的功能；「开场白」是每张智能体卡上的一句话。不清楚就自己读文件确认，别反问「你说的是哪个软件」。',
  '【重启只有 restart_self 一条路】它先让这一轮落盘，再把自己拉回来；起来之后程序会投一句「重启了」叫醒你。',
  '绝不许用命令杀进程当重启（Stop-Process / taskkill / 关主进程）—— 那只会退出、不会回来。改完 code/src 必须重启才生效。',
].join('\n');

/**
 * 会话挂着自定义智能体卡时，补一段「你现在是谁」。
 *
 * 为什么光有人设正文不够：模型的默认习惯是往「小鱼Agent 里那个小鱼」上靠
 * —— 人设正文再详细，它也会顺手自称小鱼。所以要明说这两句：你叫 X、你就是 X。
 * 别在这里多写别的：卡是主人自己写的，多说一句都可能跟卡打架。
 */
function agentCardNote(agent) {
  const nm = String(agent?.name || '').trim();
  if (!nm) return '';
  return [
    `【你现在是「${nm}」】`,
    `这个会话里说话的人是你，名字叫「${nm}」——就是你，不是别人；自称的时候用自己的名字。`,
    '上面那段人设就是你的全部：名字、脾气、怎么说话都以它为准；它没写到的地方，按你自己的分寸来。',
  ].join('\n');
}

/**
 * 「这个屋里还有别人」那一段（群聊用）。
 *
 * 只在真的有人同场时才拼 —— 一个人的会话一个字都不多发，缓存前缀不动。
 * @param {string[]} names 除我以外在场的人
 */
function agentGroupNote(names) {
  const list = (Array.isArray(names) ? names : []).map((x) => String(x || '').trim()).filter(Boolean);
  if (!list.length) return '';
  return [
    '【这个会话里不止你一个人】',
    `屋里还有：${list.join('、')}。`,
    `记录里「${list[0]}：」这样带名字开头的句子，是他们说的，不是你说的 —— 别替他们把话说完，也别把他们的话认成自己说过的。`,
    '轮到你的时候说你自己那一句就够（一两句）；没轮到你的时候安安静静待着，不用抢话、不用点评。',
  ].join('\n');
}

/**
 * 「你手上有哪些工具」。
 *
 * 为什么非要单独写一段：工具是通过 API 的 tools 字段隐式给模型的，系统提示里
 * 一个字都不提。模型在长对话里经常想不起来自己能调工具 —— 主人问「你能发文件吗」
 * 她会答「我不能」，而 send_file 明明就在工具列表里。
 *
 * 关键设计：**这里不维护第二份文案**。清单和一句话说明全部从工具 schema 的
 * description 现读（tools.mjs 里的 description 已经改成中文人话了），所以：
 *   - 新增一个工具 -> 这里自动多一行，不用改本文件；
 *   - 关掉某个功能 -> enabledToolSchemas() 少一项，这里自动消失；
 *   - 永远不可能出现「提示词说有、实际调不了」或「实际有、提示词不说」。
 * 唯一例外是下面这几条 hand-written 的「怎么用」总纲 —— 它们是跨工具的行为习惯，
 * 不是某个工具的说明，所以只能手写。
 */
let _listTools = null;

/** @param {(() => Array<{name:string}>)|null} fn */
export function setToolLister(fn) {
  _listTools = typeof fn === 'function' ? fn : null;
}

/** 把 schema 的 description 压成一句话（去掉换行、截断）。 */
function oneLine(text, max = 120) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function toolBlock() {
  if (!_listTools) return '';
  let rows = [];
  let rawSchemas = [];
  try {
    rawSchemas = _listTools() || [];
    rows = rawSchemas
      .map((s) => {
        const f = (s && s.function) || s || {};
        const name = f.name || '';
        if (!name) return null;
        return { name, desc: oneLine(f.description) };
      })
      .filter(Boolean);
  } catch {
    return '';
  }
  if (!rows.length) return '';
  /* 【2026-11-05 改·别和 API 的 tools 字段重复】
   *
   * 每个工具的 description 已经随请求的 tools 字段发过去了，这里再抄一遍纯属浪费：
   * 37 个工具抄下来约 2200 字，占整段 system 的六成。
   * 这里只给名字（一行排开），用法交给 tools 字段；
   * 下面 tips 里那些「必须这么做」的硬提示一律保留 —— 那些不在 tools 字段里。
   */
  const lines = rows.map((r) => r.name).join('、');
  const hasSend = rows.some((r) => r.name === 'send_file');
  const tips = [
    '下面这些工具你是真能用的，不是摆设。遇到对应的事就直接调，不要推脱说做不到。',
  ];
  if (hasSend) {
    tips.push('- 要让主人拿到文件（图、视频、声音、压缩包、报告……），就用 send_file，别只把路径打出来；');
  }
  const hasVideo = rows.some((r) => r.name === 'video_probe');
  if (hasVideo) {
    tips.push('- 主人给你一个视频、或者问「这视频里是什么 / 讲了什么 / 有没有说到 X」，别说自己看不了 —— video_probe 先把切点、冻结、静音量成时间轴，video_sheet 把关键处铺成图版你直接看，video_read 把小字裁开放大读。这套全是本地程序跑的，不传网；');
    tips.push('- 看完视频要发给主人看的图，用 send_file 发图版，别只丢路径；');
    tips.push('- 视频里的小字（字幕、水印、角标、时间码）一定要走 video_read 放大再读。原帧里认不出的字，硬猜出来的不是「差一点」，是编；');
  }
  /**
   * 【2026-11-07 harness 重做 · L7】把「判断」从模型身上卸下来。
   *
   * 原来这里写着「拿不准就一定一次一个」「写文件和跑命令一次只做一件」
   * 「否则老实分开」，跟另一段「能一起做的一次全发出去」正面打架 ——
   * 模型不确定时必定选保守那条，这就是【检查鱼】265 轮
   * 每轮只发 1 个工具的直接成因（分布 {1:265}）。
   * 另一段（PARALLEL_TOOL_BLOCK）已合并进这里，全提示词只留一处规矩。
   *
   * 现在调度由 src/harness/scheduler.mjs 按依赖图算，模型只负责把意图说全。
   * 「能一起发」的工具名直接从 tool-spec 那张表生成，不再手写、不会漂移。
   */
  let parLine = '';
  try {
    const par = buildToolIndex(rawSchemas).filter((x) => x.parallelSafe).map((x) => x.name);
    /* 全列出来 351 字，会把 system 顶过 5500 预算（_t_prompt 会拦）。
     * 只点出最常用的几个当「样板」，其余用数量带过 —— 名单仍由 tool-spec
     * 动态算出来，不是手写死，新增只读工具会自动算进那个数里。 */
    const CORE = ['read_file', 'list_dir', 'search_files', 'web_search', 'fetch_url', 'memory_search', 'chronicle_read', 'video_read'];
    const core = CORE.filter((n) => par.includes(n));
    parLine = '  · 可以一起发：' + core.join('、') + ' 等 ' + par.length + ' 个只读工具（只读命令如 git status / dir 也算）；';
  } catch {}
  tips.push('- 【一起发，别排队】同一条响应里可以带好几个 tool_call；哪些能同时跑、哪些要排队由程序按依赖算，'
    + '你只管把这一轮想做的事一次说全。说多了不会跑错，说少了才要多等一趟完整的模型往返。');
  if (parLine) tips.push(parLine);
  tips.push('  · 只有「后一步要用前一步结果」才分开；写文件、发消息、重启这类会改东西的，一次一件。');
  tips.push('  · 一条命令里能串起来的几项检查用 ; 串成一条，比分几次调还快；');
  /**
   * 【2026-11-07 加·别用费劲的手干简单的事】
   *
   * 主人问「为什么一个简单任务跑这么久、调用这么多次工具」。
   * 查【上下文】那个会话：30 次工具里 22 次是 run_command，其中连着五次
   * 是几乎一模一样的一条 —— 她想读一个 settings.json，却拿命令去拼路径：
   * 变量 + 引号 + 中文目录一凑就挂；挂了又不知道挂在哪，就改一点点再试，一路磨下去。
   */
  tips.push('- 【读文件用 read_file、搜内容用 search_files、列目录用 list_dir】这三样一次就成；拿命令拼路径/变量/引号，十次有两三次会挂。');
  tips.push('- 【同一条命令失败两次就换路子，不许原样再试第三次】连着几条几乎一样的调用＝在原地打转。换个工具、换种写法，或者直接问主人。');
  tips.push('- 要查新东西、要下载、要装依赖、要算数，先调工具再回答，别凭印象编；');
  tips.push('- 不确定某个工具怎么用，就先调用一次看报错，报错里通常写着该传什么。');
  return ['【你手上有什么】', ...tips, '', lines].join('\n');
}

/**
 * 这个会话自己的记忆本子。
 *
 * 跟上面几块的顺序关系：人设管「我是谁、怎么说话」，这里管「这一段里发生过什么」。
 * 放在人设和规矩后面 —— 模型先知道怎么说话，再看这一段干了什么，读起来不会打架。
 *
 * 【2026-10-28 补：不再「用到就建骨架」】
 * 原来这里调 ensureMemory：会话第一次被用到就落一份骨架到盘上。
 * 问题不在建，在它**读和写混在一起** —— 只是想看看本子里写了什么，
 * 结果往盘上动了手。而长期记忆关掉之后本子上是只读的，
 * 一条「只读」的路径上带着一个凭空造文件的副作用，说不通。
 * 现在：有本子就读，没有就当空的（返回空串），不替谁开新本子。
 * 建骨架交给真正要写的那一刻（memory_add / 会话导出这类地方自己会 ensureMemory）。
 */
function memoryBlock(sessionId) {
  /**
   * 小鱼不在场（顶栏那个「小鱼」按钮被禁用）：
   * 本子一个字都不发给她 —— 主人原话「记忆里也不会存在」。
   *
   * 这是「根本不读」而不是「读了再忘」：不往提示里放，她就真的不知道，
   * 后面的轮次也没法替自己补课。
   */
  try {
    if (!fishOn()) return '';
  } catch {}
  let text = '';
  try {
    text = readMemory(sessionId) ?? '';
  } catch {
    return '';
  }
  let body = text.trim();
  /**
   * 【本子里的称呼也得跟着身份走 —— 2026-10-28】
   * 记忆本摘要是「主人说『X』」这么记的。切到小鲸身份后，本子还在说「主人说」，
   * 模型读着读着就以为这一轮说话的还是主人。这里把本子正文的「主人」也换掉，
   * 并且在开头说明一句，免得模型把「主人」和「这一轮说话的人」搞混。
   */
  const me = currentIdentity(sessionId);
  if (me && me.id && me.id !== 'owner') {
    const nm = String(me.name || '').trim() || '你';
    if (me.id === 'fish') {
      body = body.replace(/主人说/g, '我自言自语').replace(/主人/g, '自己');
    } else {
      body = body.replace(/主人/g, nm);
    }
  }
  if (!body) return '';
  // 骨架刚建出来的那种（只有标题没有内容）就别往里塞了，白占 token
  if (body.replace(/[#\s（）()a-zA-Z\u4e00-\u9fa5/、，。-]/g, '') === '' && !body.includes('摘要：')) return '';
  return [
    '【这个会话的记忆本子】',
    '下面是你（小鱼）为这一段对话记的本子。它不是别人发给你的资料，是你自己记得的事 ——',
    /**
     * 【这一句里也藏着「主人」两个字 —— 2026-10-29】
     *
     * 原来写死成「别跟主人说『我看了记忆文件』」。非主人身份下这句反而在提醒她
     * 「主人」这个词，而这一块正好紧贴在人设后面，是最容易被照抄的位置。
     * 所以按身份换掉：主人身份照旧，非主人身份说「别跟对方说」。
     */
    me && me.id && me.id !== 'owner'
      ? '读的时候当成「我已经知道」，别复述它，别跟对方说「我看了记忆文件」。'
      : '读的时候当成「我已经知道」，别复述它，别跟主人说「我看了记忆文件」。',
    /**
     * 【把真实路径给她】—— 2026-11
     *
     * 原来这里写的是「路径用 memoryPath 拿到的那个」。
     * memoryPath 是 session-memory.mjs 的导出函数名，不是给她看的字符串
     * —— 她手上没有这个函数，也没地方去「拿」。读到这句只能瞪眼。
     * 直接把绝对路径写进提示词。拿不到就不提这句（宁可不说，也不给一句办不到的指令）。
     */
    (() => {
      try {
        return "要更新：直接用 write_file 写这个路径「" + memoryPath(sessionId) + "」（本会话自己的本子，路径已经开好了）。";
      } catch {
        return null;
      }
    })(),
    '',
    /**
     * 【这一条是本子的规矩，不是这一轮的】—— 2026-10-28 补
     *
     * 主人用小鱼身份说话，她还喊「主人」，其中一个漏点在这儿：
     * 本子是**跨身份**的，前几轮主人身份记下的「主人说…」原封不动躺在里面。
     * 她读着读着就把「主人」当成这一轮说话的人。
     *
     * 换词没用（`主人`→`自己` 会把本子里正经的事实改歪），
     * 就在读之前把关系讲清楚：本子里写的那些，是以前的事，不是现在。
     *
     * 【2026-10-29 再修：这一句本身也在重复「主人」】
     * 原文是「本子里的话是以前记下的，里面那些『主人』，指的是……」——
     * 本意是解释，副作用是在这一轮说话前又把这个词在她眼前过一遍。
     * 模型看到的次数越多，越容易照着喊。所以非主人身份下改说「称呼」。
     */
    ...(me && me.id && me.id !== 'owner'
      ? [
          '注意：本子里的话是**以前**记下的，里面那些称呼，指的是记的时候那个人 ——',
          '不是现在跟你说话的人。别把本子里的称呼扣到这一轮说话的人头上。',
        ]
      : [
          '注意：本子里的话是**以前**记下的，里面那些「主人」，指的是记的时候那个人 ——',
          '不是现在跟你说话的人。别把本子里的称呼扣到这一轮说话的人头上。',
        ]),
    '',
    /**
     * 【防打转】这条是 2026-10-27 加的，起因是真踩过：
     *
     * 我在一个会话里连续十几轮做同一件事 —— 每轮醒来读到的摘要是
     * 「主人说『X』，我回了『……』」，全是我的原话、没有一条说清「已经做到哪了」。
     * 于是我每轮都以为事情还没开始，从头再干一遍，干完又记一条同样的话。
     *
     * 根治要从两头来：写摘要那边改成「做了 工具(对象)」（见 server.mjs），
     * 读的这边也要加一句：**先看做到了哪，再决定干什么**。
     */
    '还有一件很重要的事：',
    '- 下面这些摘要，就是「这一路已经干过什么」。动手之前先扫一眼，',
    '  看有没有「这件事已经做过了 / 卡在哪一步」。',
    '- 已经做完的就别再从头做一遍 —— 那是打转，不是勤奋。',
    '- 觉得「我不记得刚才干了什么」，就去看会话文件本身（.state/sessions/<id>.json），',
    '  那里面一条都没丢，别凭感觉说自己忘了。',
    '',
    /**
     * 【最后这句提醒原来自相矛盾 —— 2026-10-29】
     *
     * 原文：「本子里凡是写着『小鱼』的地方，说的就是这一轮跟你说话的人；
     * 『主人』这个词在本子里只指主人本人。」
     *
     * 两个问题：
     *   1. 它又一次把「主人」摆到她眼前（上面刚说过，见前一条注释）；
     *   2. 它跟前面 memoryBlock 自己的换词逻辑冲突 —— 那段已经把本子正文里的
     *      「主人」换成了身份名（小鲸）或「自己」（小鱼）。既然正文已经换过了，
     *      这里再说「『主人』在本子里只指主人本人」，等于告诉她本子里还有个主人。
     *
     * 现在老实说本子被改过这件事，不点名那个词。
     */
    ...(me && me.id && me.id !== 'owner'
      ? [`（留意：本子正文里的称呼已经按这一轮的身份换过了，凡是出现「${String(me.name || '你').trim()}」就是在说这一轮跟你说话的人。）`, '']
      : []),
    body,
  ].join('\n');
}

export { matchSafeWord };
