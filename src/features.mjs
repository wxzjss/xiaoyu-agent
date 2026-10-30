// 功能开关：界面上【功能】面板管的就是这里。存到 .state/features.json。
// 一个功能 = 一个开关 + 它管的那些工具。关掉之后工具就从模型手里拿掉，真调也会被拒。
//
// 默认值只有一条规矩：**每项都默认开着**。所以：
//   - 文件里没写过的键当成开；
//   - 老版本留下的开关文件里缺了新功能的键，也当成开（新加的功能自动生效，
//     不用等用户去点，也不会出现「代码里默认开、实际却显示关」这种自相矛盾）。
// 想真的关掉，就得在 features.json 里明确写 false —— 那只有用户点「停用」才会发生。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const FILE = join(config.dataDir, '.state', 'features.json');
/** 老文件没有这些键时补写进去，让文件内容和界面显示对得上 */
const SCHEMA_VERSION = 5;

/** 功能清单。数组顺序就是界面上的顺序。 */
export const FEATURES = [
  {
    id: 'web',
    name: '联网搜索',
    desc: '上网搜东西，再打开搜到的网页读正文。关掉之后既搜不了也打不开网页。',
    tools: ['web_search', 'fetch_url'],
  },
  {
    /**
     * 内置浏览器 —— 这是【我自己的眼睛】，不是给人点的按钮。
     *
     * 主人说得清楚：他不需要看见这个浏览器，是我能用来开网页、看页面长什么样。
     * 所以界面上不加任何按钮，只在【功能】里留一个开关 —— 主人想让我彻底
     * 碰不了网页的时候，关掉它就行。
     *
     * 只在桌面版可用（服务端跑在主进程里，浏览器窗口由主进程开）；
     * 别的地方调了会老实说「这台环境里没有可用的浏览器」，不假装看过。
     */
    id: 'browser',
    name: '内置浏览器',
    desc: '我自己的眼睛：能开网页、跳转、截一张图看看页面长什么样。关掉之后完全碰不了网页。',
    tools: ['browser_open', 'browser_goto', 'browser_snap', 'browser_state'],
    defaultOn: true,
  },
  {
    /**
     * 看视频 —— 跟内置浏览器一样，是【我自己的眼睛】，不是给人点的按钮。
     *
     * 主人 2026-10-26 让装的 video-watch-plus 那套：先用 ffmpeg 把切点/冻结/运动/静音
     * 量成数字（零 token），再按骨架抽样铺图版，图版每格带「第几秒」的映射，
     * 要读小字再裁开放大。走的全是本地程序，不上传视频。
     *
     * 关掉之后我完全看不了视频 —— 调了会直接说「看视频被关了」，不假装看过。
     */
    id: 'video',
    name: '看视频',
    desc: '我自己的眼睛（视频版）：能量出切点/冻结/静音、把关键处铺成图版看、把小字裁开放大读。关掉之后完全看不了视频。',
    tools: ['video_probe', 'video_sheet', 'video_read', 'video_doctor'],
    defaultOn: true,
  },
  {
    id: 'readFile',
    name: '读文件',
    desc: '读工作区里的文本文件。',
    tools: ['read_file'],
  },
  {
    id: 'writeFile',
    name: '写文件',
    desc: '在工作区里新建或覆盖文件。',
    tools: ['write_file'],
  },
  {
    id: 'listDir',
    name: '看目录',
    desc: '列工作区里的文件和文件夹。',
    tools: ['list_dir'],
  },
  {
    id: 'shell',
    name: '跑命令',
    desc: '在这台电脑上跑 PowerShell 命令。关掉之后完全碰不到命令行。',
    tools: ['run_command'],
  },
  {
    id: 'plan',
    name: '任务清单',
    desc: '多步的事先拆清单，边做边勾进度。',
    tools: ['plan'],
  },
  {
    /**
     * 我自己的长期记忆本。
     *
     * 一个功能 = 一个开关 + 它管的那些工具。关掉之后两个工具就从模型手里拿掉，
     * 真调也会被拒 —— 但**本子本身不删**，重新打开还在，之前记的一个字不丢。
     *
     * 为什么要有这个开关：主人可能哪天不想让我「自己决定记什么」，
     * 想让我纯粹当个工具用。那就关掉，别让我偷偷攒东西。
     */
    id: 'memory',
    name: '长期记忆',
    desc: '我自己的记忆本：固定记忆永久保留、滚动摘要最多 80 条、最近 5 轮写细、满了自动归档。按人设分开：同名共用一本，不同人设互不相通。关掉之后只读：本子照看得到，但一个字也不许再写，本子本身不删。',
    tools: ['memory_add', 'memory_pin'],
    defaultOn: true,
    // 专业模式下这两支笔一并收走：专业模式连人设都不带，记忆也不读，
    // 那就别让人能往本子里写 —— 只写不读＝黑洞。
    offInPure: true,
  },
  {
    id: 'note',
    name: '便签',
    desc: '把关键数字、路径、结论记下来，隔几轮还能翻出来。',
    tools: ['note'],
  },
  {
    id: 'webFetchTxt',
    name: '联网抓取文本',
    desc: '给一个链接，把网页正文抓下来存进 dump/txt，再拿回来读。',
    tools: ['fetch_txt'],
  },
  {
    id: 'fetchPack',
    name: '批量抓取成书',
    desc: '一次抓一堆链接（中文站不会乱码：自动认 GBK/UTF-8/繁体），能把多页拼成一本 .md + .txt 存进 dump/books。',
    tools: ['fetch_many', 'pack_book'],
    defaultOn: true,
  },
  {
    id: 'zhConvert',
    name: '繁体转简中',
    desc: '抓到的书要是繁体（繁體）就自动翻成简体，抓书、批量抓、打包成书全链路都管；也能手动把一段字/一个文件转简。',
    tools: ['t2s_convert'],
    defaultOn: true,
  },
  {
    id: 'sendFile',
    name: '发文件',
    desc: '让小鱼把做好的东西亲手交过来：图片、视频、压缩包、报告，什么后缀都行。聊天里直接出卡片，图片能看、视频能播、别的点一下就下载。',
    tools: ['send_file'],
    defaultOn: true,
  },
  // 2026-10-29 主人：「删除功能页原来的【开场白】功能」。
  // 开场白不再是这里的一个全局开关，而是每张智能体卡自己的一句话（智能体面板里改），
  // 存在 .state/agent-openings.json —— 见 opening.mjs 的 cardOpening。
  // 别再把 opening 加回这个列表：加了就会出现两个地方都能改开场白。
  {
    // 专业模式（原来的「纯净模式」）：不是用来聊天的，是用来干活的。
    // 开着的时候每轮只发对话本身（人设/记忆/前情/开场白都不发），
    // 每轮开头先把历史压到只剩最近几条，然后给一份「怎么干活」的作业规范：
    // 先查再说、报错先找根因、一次只改一件事、自己造证据、收尾要能验证、不许骗自己。
    // 目的有两个：把 token 花在任务上不花在扮演上，以及让她办事像样一点。
    id: 'pure',
    name: '专业模式',
    desc: '干任务用的模式：不套人设、不念记忆，历史涨到上限才压缩（跟平常同一套压缩规则，会写摘要），还会额外给一份「怎么干活」的规范（先查再说、找根因不猜、一次只改一件事、自己造证据、收尾要能验证）。打开之后顶栏会出现「专业模式」按钮，按会话各开各的 —— 在哪个会话里点开，就只对那个会话生效，切到别的会话还是正常的人设和记忆。关掉这个功能，按钮整块消失。',
    tools: [],
    // 这是新增的功能，老用户的 features.json 里没有这个键。
    // 默认关着：不乱动老用户顶栏，想要的人自己去【功能】里打开。
    defaultOn: false,
  },
  {
    /**
     * 岁月史书。
     *
     * 主人原话（2026-10-28）：
     * 「增加一个新功能：岁月史书。自动记录所有会话的全部上下文内容，ai可随时翻阅，
     *   但翻阅方式不能一股脑全看，而是能够支持索引，ai能搜索关键字，甚至可以有目录，
     *   有分类这样的」
     *
     * 三个工具 = 三层翻阅（目录 → 搜索 → 精读），细节见 chronicle.mjs 顶部注释。
     *
     * 【为什么默认开着】
     * 它不改任何行为：只读会话、只在磁盘上多存一份索引，不往提示词里塞东西，
     * 不打断说话，不花钱（不调 API）。开着也不会让谁察觉 —— 直到你去问她
     * 「以前的会话里是不是说过 xxx」。
     *
     * 【开关的作用】
     * 关掉 = 三个工具从她的工具列表里消失，她翻不到了；但已经记下来的史书
     * 不会删（那是主人的东西，不该被一个开关干掉）。
     */
    id: 'chronicle',
    name: '岁月史书',
    desc: '把主人所有会话的全部内容自动记成一部书，她能自己翻着查。翻的时候有规矩：先看目录（有哪些会话、各多少条、怎么构成的），再用关键字搜到具体哪一行，最后才按行号读那一段原文——不会一股脑全倒出来。每轮对话结束自动并进去，不用手动。关掉的话她就查不了了，已经记下的不会删。',
    tools: ['chronicle_toc', 'chronicle_search', 'chronicle_read'],
    defaultOn: true,
  },
  {
    /**
     * 折叠箱（折掉的原文还能翻回来）。
     *
     * 来源：主人要求「让该会话的 ai 自己决定哪些上下文该删、哪些不能删、怎么总结摘要，
     * 让她自己决定怎么压」（2026-10-28）。
     *
     * 「自己决定」光靠提示词是做不到的 —— 折掉的东西本来是真没了。
     * 所以压缩时把被摘要换掉的原文**原样存盘**（folded.mjs），再给她两个能翻回来的工具：
     *   folded_list = 看这个会话折了哪些段（第几条到第几条、多少 token、为什么折、摘要开头）
     *   folded_read = 读某一段的原文（可以只给前缀）
     *
     * 【和岁月史书的区别，别搞混】
     *   岁月史书 = 主人的全部会话，外部账本，翻别人的
     *   折叠箱   = 这个会话自己被折掉的那几段，自己的衣柜，翻自己收起来的
     *
     * 【为什么默认开着】
     * 和岁月史书同理：只在压缩时被动存盘、不往提示词里塞东西、不调 API 不花钱。
     * 而且它本身还有个好处 —— 压缩时原文不销毁，失败风险小得多。
     * 关掉 = 两个工具消失、以后压缩不再存盘；**已经存下的段不删**。
     */
    id: 'foldedBox',
    name: '折叠箱',
    desc: '压缩上下文时被换成摘要的那些原文，不再销毁了——原样存在盘上，她能自己翻回来。她用 folded_list 看折了哪几段，用 folded_read 读回某一段的原文（代码、原话、数字都在），所以敢放心折。关掉的话她就翻不到了，已经存下的不会删。',
    tools: ['folded_list', 'folded_read'],
    defaultOn: true,
  },
  {
    /* compressTag·2026-10-31 纯界面开关：历史太长被折成摘要时，
     * 聊天里会多一行「上下文 · 已压缩」的小标签。有人喜欢知道发生了什么，
     * 有人觉得碍眼 —— 那就让它能关掉。默认开着（跟以前一样）。 */
    id: 'compressTag',
    name: '压缩提示',
    desc: '历史太长、被折成摘要的时候，聊天里会多一行「上下文 · 已压缩」。关掉就不显示了，压缩照样在做。',
    tools: [],
    defaultOn: true,
  },
  {
    // 纯界面功能，不带工具。默认开着，素材就在 assets/background.mp4。
    id: 'videoBg',
    name: '视频背景',
    desc: '把一段短片铺成聊天背景（循环播放），右下角小圆钮调透明度。不想要就关掉。',
    tools: [],
    defaultOn: true,
  },
  {
    // 小鱼的嗓子：念出来给主人听。四档声音在【功能】里挑。
    id: 'ttsVoice',
    name: '小鱼说话',
    desc: '让小鱼开口：把要说的话念成语音发过来，四档嗓音随便挑（活泼甜 / 软糯最软 / 软糯偏甜 / 连读自然）。点「选声音」就能换，改完下一句生效。',
    tools: ['say'],
    defaultOn: true,
  },
  {
    // 纯界面功能，不带工具。
    // 点聊天输入框那一下，把 Windows 输入法掰到「系统语言」那边：
    // 系统是中文、输入法却停在英文，一点就自动回中文；反过来也一样。
    // 只在桌面版管用（网页版够不着系统输入法），后台静默跑，不会弹窗。
    id: 'imeMatch',
    name: '输入法跟随系统',
    desc: '一点聊天输入框，系统输入法就自动切到系统语言那一边（系统中文就用中文，英文就用英文）。省得打了一屏字母才发现输入法是英文。不想要就关掉。',
    tools: [],
    defaultOn: true,
  },
  {
    /**
     * 当前身份 —— 纯界面功能，不带工具。
     *
     * 主人 2026-10-27 定：默认「主人」，能切小鱼/小鲸/自定义。
     * 换身份不是换个称呼：她们会真的以为说话的不是主人，可以拒绝听命令；
     * 安全词也只有主人说得才算数（判定在 server.mjs 的 __speakerIsOwner）。
     * 关掉这个开关 = 身份功能整个失效，回到「永远都是主人在说话」。
     */
    id: 'identity',
    name: '当前身份',
    desc: '决定现在我以谁的身份跟她们说话：主人（默认）、小鱼、小鲸，或者你自己新建的身份。每个身份有简介和称呼。换成非主人身份后，她们会真的以为说话的不是主人、可以拒绝听命令，而且安全词只有主人说得才算数。关掉就永远是主人在说话。',
    tools: [],
    defaultOn: true,
  },
  {
    // 智能体：叫个小弟出去查事，结论交回来，历史不占主人的上下文。
    // 2026-10-29 主人：「把设置里的【子智能体】改为【智能体】，可以在里面编辑小鱼与小鲸的人设」。
    // 从此这一栏是「智能体」总入口：小鱼、小鲸的人设与模型都在这里改。
    id: 'subagent',
    name: '智能体',
    desc: '管理和编辑智能体：这里能改小鱼、小鲸的人设和模型，也能新建别的智能体。小鲸是跑出去替你查事情的那一个 —— 自己翻文件、看目录、搜网页，查完把结论交回来，中间过程不占主对话的上下文。默认只能查、不能改主人的东西。',
    tools: ['ask_subagent'],
    defaultOn: true,
  },
  {
    // 会话之间递话：两个我互相能说上句话，不用主人当传话筒。
    // 默认关着 —— 这是个能跨会话影响别处的开关，得主人自己想开才开。
    id: 'peerMail',
    name: '会话互递话',
    desc: '让不同会话里的我能互相递话：一个在打包、一个在查东西，可以问一句「你那边好了没」。只递话，互相看不到对方的聊天记录和文件；默认只存信箱、不打断对方手上的活，要立刻回才叫醒。',
    tools: ['ask_peer', 'list_peers', 'read_peer_mail'],
    defaultOn: false,
  },
  {
    /**
     * 【陪看屏幕】—— 她自己抬头看一眼主人现在的屏幕（2026-11-01）。
     *
     * 参考 dsh-whale-sense：那个插件让帮工反复截屏、把「屏幕变了」跟图一起塞回会话。
     * 这里改成「她想看才看」：默认开着，但只是给了她一双眼睛，
     * 不看的时候一张都不截、一个字节都不上传。
     *
     * 【为什么默认开着】不给眼睛她就只能听主人转述「我屏幕上有个报错」，
     * 那是这个程序从第一天起就在忍的事。给了眼睛她也不会自己乱看 ——
     * tools-screen.mjs 的 description 里已经写清「别每轮都看，那是他的隐私」。
     * 主人要是嫌吵，关掉这一栏，两个工具就都不在她手上了。
     */
    id: 'screenSense',
    name: '陪看屏幕',
    desc: '让她抬头看一眼你现在的屏幕：你说「你看我这个」「这报错你看见没」，她就截一张自己看，看完能直接就画面里的东西跟你说话，还会把看见的那张挂回聊天里给你对照。她不会一直偷看——只有她需要用的时候才截一张；每一张也只在这台机器上，两小时后自动清掉。不想要就关掉。',
    tools: ['look_screen', 'screen_watch_status'],
    defaultOn: true,
  },
  /**
   * QQ 小鱼（2026-11-01）
   *
   * 主人：「参考 QQAgent 连接 QQ 的方式…给小鱼Agent 增加类似的功能【QQ小鱼】
   * （可以选择哪个会话或创建新的会话连接QQ）」。
   *
   * 这一条挂了 qq_send（2026-11-02）：她不需要「调用一个工具去回 QQ」——
   * QQ 上的话由 src/qq-bridge.mjs 直接当成你说的话送进同一条链路；
   * 但**往 QQ 发图/语音/文件**需要一个工具，因为那是这一轮才能做的事
   * （发到哪儿由 turn-source.mjs 记着，她不用填地址）。
   * 所以这条功能只管「要不要应」这一个开关。凭据、认主、挂哪个会话，
   * 都在功能页那一行的「设置 QQ」里。
   */
  {
    id: 'qqSense',
    name: 'QQ 小鱼',
    desc: '把 QQ 接过来：别人在 QQ 上跟她说话，她就在你指定的那个会话里回 —— 你在电脑前看得见同一段对话、同一段记忆。认主之后，只有你说话她才按主人的口径答；别人说话她按客人那套应。要填机器人的 AppID / AppSecret，都只存在这台机器上。不想要就关掉。',
    tools: ['qq_send'],
    defaultOn: false,
  },
];

/** 工具名 -> 所属功能 id */
export const TOOL_FEATURE = new Map();
for (const f of FEATURES) for (const t of f.tools) TOOL_FEATURE.set(t, f.id);

function readRaw() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 每个功能是开是关。
 *
 * 规矩：**文件里没写过 → 看这个功能自己的 defaultOn**，没写 defaultOn 就当开。
 * 绝大多数功能 defaultOn 是 true（老文件里缺键也是开），
 * 但新增的、会改动界面的功能可以声明 defaultOn: false，
 * 这样老用户升级上来不会莫名其妙多出一个按钮。
 *
 * 顺手把缺的键补写回文件：不然界面上写着「已启用」，features.json 里却没这一行，
 * 下次谁去看文件都会以为它关着（这个误会真发生过）。
 */
export function getEnabledMap() {
  const raw = readRaw();
  const out = {};
  const missing = [];
  for (const f of FEATURES) {
    if (raw[f.id] === undefined) missing.push(f.id);
    const fallback = f.defaultOn === undefined ? true : Boolean(f.defaultOn);
    out[f.id] = raw[f.id] === undefined ? fallback : Boolean(raw[f.id]);
  }
  if (missing.length && raw.schemaVersion !== SCHEMA_VERSION) {
    try {
      const dir = join(config.dataDir, '.state');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(FILE, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...out }, null, 2), 'utf8');
    } catch {
      // 写不进去也不影响这次读数，下次再补
    }
  }
  return out;
}

/** 界面用的一份完整状态。 */
/**
 * 按 id 查一条功能定义。
 *
 * 【为什么单独建表】列表只有 24 条，每次 setFeature 都线性找一遍也不算慢，
 * 但 id 不存在时要能**立刻**判出来给 400，而不是让调用方自己 for 一遍。
 * 表在建模块时算一次，之后只读。
 */
const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

/** 拿某一条功能定义；没有就返回 null（不抛，调用方自己决定 400 还是忽略）。 */
export function featureById(id) {
  return BY_ID.get(String(id || '')) || null;
}

export function getFeatures() {
  const enabled = getEnabledMap();
  const features = FEATURES.map((f) => ({
    id: f.id,
    name: f.name,
    desc: f.desc,
    tools: [...f.tools],
    enabled: enabled[f.id],
  }));
  return {
    features,
    total: features.length,
    enabledCount: features.filter((f) => f.enabled).length,
    enabledTools: features.filter((f) => f.enabled).flatMap((f) => f.tools),
  };
}

/** 开 / 关一个功能，写盘后返回最新状态。 */
export function setFeature(id, on) {
  const key = String(id ?? '').trim();
  const f = BY_ID.get(key);
  if (!f) {
    const e = new Error(`没有这个功能：${key || '(空)'}`);
    e.status = 400;
    throw e;
  }
  const map = getEnabledMap();
  map[f.id] = Boolean(on);
  if (!existsSync(join(config.dataDir, '.state'))) {
    mkdirSync(join(config.dataDir, '.state'), { recursive: true });
  }
  writeFileSync(FILE, JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...map }, null, 2), 'utf8');
  return getFeatures();
}

/** 现在能用的工具名。 */
export function enabledToolNames() {
  return getFeatures().enabledTools;
}

/** 这个工具现在能不能用；不认识的工具一律当不能用。 */
export function isToolEnabled(name) {
  const id = TOOL_FEATURE.get(String(name ?? ''));
  if (!id) return false;
  return getEnabledMap()[id];
}

/** 某个工具被关掉时，返回它所属功能的名字，方便报错说清楚。 */
export function featureNameOfTool(name) {
  const id = TOOL_FEATURE.get(String(name ?? ''));
  return id ? BY_ID.get(id)?.name ?? id : '';
}

/** 关掉的功能名单，给系统提示用。 */
export function disabledFeatureNames() {
  return getFeatures().features.filter((f) => !f.enabled).map((f) => f.name);
}
