// 功能开关：界面上【功能】面板管的就是这里。存到 .state/features.json。
// 一个功能 = 一个开关 + 它管的那些工具。关掉之后工具就从模型手里拿掉，真调也会被拒。
//
// 默认值只有一条规矩：**每项都默认开着**。所以：
//   - 文件里没写过的键当成开；
//   - 老版本留下的开关文件里缺了新功能的键，也当成开（新加的功能自动生效，
//     不用等用户去点，也不会出现「代码里默认开、实际却显示关」这种自相矛盾）。
// 想真的关掉，就得在 features.json 里明确写 false —— 那只有用户点「停用」才会发生。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve as resolvePath } from 'node:path';
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
    desc: '列工作区里的文件和文件夹，以及在文件里搜内容。',
    tools: ['list_dir', 'search_files'],
  },
  {
    id: 'shell',
    name: '跑命令',
    /* 【2026-11-11 mac 兼容】文案按平台说，别再让 mac 用户看到 PowerShell */
    desc: process.platform === 'win32'
      ? '在这台电脑上跑 PowerShell 命令。关掉之后完全碰不到命令行。'
      : '在这台电脑上跑终端命令（macOS 是 zsh/sh）。关掉之后完全碰不到命令行。',
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
    /* 【2026-11-05 修·新工具必须登记，否则她永远用不了】
     * memory_search 是这一轮新加的：记忆从"每轮全量注入 12000 字"改成
     * "只注入最近 22 条 + 自己查"。可这个开关表是白名单 ——
     * 不写进来，工具就是"关着"的状态，她会看到「现在是关着的，用不了」，
     * 等于把刚装上的眼睛又捂回去。 */
    tools: ['memory_add', 'memory_pin', 'memory_search'],
    defaultOn: true,
    // 专业模式下这两支笔一并收走：专业模式连人设都不带，记忆也不读，
    // 那就别让人能往本子里写 —— 只写不读＝黑洞。
    offInPure: true,
  },
  {
    /* 【2026-11-05 加·技能本】
     * 从 WorkBuddy 的 skill 借的：往 data/skills/<名字>/SKILL.md 丢一份「怎么做某件事」，
     * 她自己会翻，不用改代码、不用改人设。
     * 平时只在 system 里出现一行索引，真要用时 use_skill 读全文 —— 渐进式披露。 */
    id: 'skills',
    name: '技能本',
    desc: '放在 data/skills/ 里的「手艺」：写周报的格式、剪视频的流程、审稿的规矩……平时只看见标题和一句话，用到时她自己翻开读。关掉之后她翻不了，已经读过的还在上下文里。',
    tools: ['use_skill'],
    defaultOn: true,
  },
  {
    id: 'note',
    name: '便签',
    desc: '把关键数字、路径、结论记下来，隔几轮还能翻出来。',
    tools: ['note'],
  },
  {
    /**
     * 【2026-11-08 补·定时任务这一项一直没登记，等于从来没开过】
     *
     * 现场：跑回归时 `_t_agents2` 报
     *   「schedule_task: 没登记到 features 的功能表（会被静默关闭，永远用不了）」
     * 一查是真的 —— tools.mjs 里 schedule_task / list_schedules / cancel_schedule
     * 三个工具写得整整齐齐（描述里连「明天九点提醒我」都举了），
     * 可 FEATURES 里没有任何一项把它们收进去。
     *
     * 而 features 的规矩是「不在任何功能的 tools 里 → 从模型手里拿掉」，
     * 所以这三个工具**一次都没能真的被调用过**。主人要是说过「明天提醒我」，
     * 她只能嘴上答应，手上根本没法落地。
     *
     * defaultOn 不写 = 默认开（见文件头那条规矩）。想关就在功能面板里关。
     */
    id: 'cron',
    name: '定时任务',
    desc: '给以后定一件事：到点自动往会话里发一句，我接着干。「明天九点提醒我」「每小时看一次」「过半小时叫我」都靠它。关掉之后建不了也改不了闹钟。',
    tools: ['schedule_task', 'list_schedules', 'cancel_schedule'],
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
    /**
     * 办事模式 —— 「谁来干」这一档。
     *
     * 主人原话（2026-11-03）：
     * 「将【办事模式】改为，启用后当前会话主智能体会根据任务复杂程度临时创建一个或多个子智能体
     *   （创建的子智能体仅当前会话可见与使用，用完或会话被删除后自动删除），当前会话的主智能体
     *   不负责工作，只负责给子智能体发布任务、检查、验收、压缩等。子智能体每完成一项任务都需要
     *   给主智能体汇报工作情况，让主智能体来检查、找问题并做出决定，且主智能体会决定如何删除
     *   该任务的不重要的占用上下文的内容，如何简洁摘要重要的内容等」
     *
     * 【2026-11-01 主人：「删除专业模式，回滚办事模式，然后让【专业模式】按钮变成【办事模式】按钮」】
     *
     * 所以这一档又回来了，而且是**独立**的一档 —— 专业模式整块删掉（pure.mjs 连文件都没了）。
     * 跟另外两档并列（都按会话各开各的）：
     *   管理员权限 = 能碰哪儿（放开 safePath）
     *   办事模式   = 谁来干   （主智能体只派活，工具收成白名单）
     *
     * 本档只做两件事：给主智能体换一份「你只派活、别自己动手」的规矩，
     * 以及把干活工具收走（agent.mjs 的 toolsForTurn）。细节见 task-mode.mjs 顶部。
     */
    id: 'taskmode',
    name: '办事模式',
    desc: '启用后这个会话的主智能体不再自己动手，只负责拆任务、派活、检查、验收、管上下文；具体的活交给临时开出来的 worker 去干（worker 只属于这个会话，干完或会话删了就没了）。打开之后顶栏会出现「办事模式」按钮，按会话各开各的。关掉这个功能，按钮整块消失。',
    tools: ['spawn_worker', 'spawn_workers', 'list_workers', 'tell_worker', 'watch_worker'],
    // 【2026-11-07】主人当前开着这一项；为让「换电脑/重装后默认提示词还是同一份」，
    // 出厂值同步为开。注意：按钮出现 ≠ 会话进入办事模式，taskOn() 仍按会话各开各的。
    defaultOn: true,
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
    // 纯界面功能，不带工具。默认开着，素材就在 assets/background.mp4。
    /**
     * 【机器级，不是会话级】2026-11-10
     * 视频背景铺的是这台电脑的界面，不是「这个对话」的界面 ——
     * 所以它在 GLOBAL_ONLY_FEATURES 里，开关只写全局表，不跟会话走。
     */
    id: 'videoBg',
    name: '视频背景',
    desc: '把一段短片铺成聊天背景（循环播放），右下角小圆钮调透明度。不想要就关掉。',
    tools: [],
    defaultOn: true,
  },
  {
    // 小鱼的嗓子：念出来给主人听。四档声音在【功能】里挑。
    /**
     * 【机器级，不是会话级】2026-11-10
     * 声音是从**这台机器的喇叭**出来的：同一个我在 A 会话要出声、B 会话不要，
     * 说不通，而且两个会话同时说话会叠成一团。所以它进 GLOBAL_ONLY_FEATURES，
     * 开关只写全局表 —— tts.mjs 的 getTTSState() 读的也是全局，两边一致。
     */
    id: 'ttsVoice',
    name: '小鱼说话',
    desc: '让小鱼开口：把要说的话念成语音发过来，四档嗓音随便挑（活泼甜 / 软糯最软 / 软糯偏甜 / 连读自然）。点「选声音」就能换，改完下一句生效。',
    tools: ['say'],
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
     *
     * 【机器级，不是会话级】2026-11-10
     * 身份/权限是**进程级**概念，不能随会话漂移（同一个进程里「我是谁」只能有一个答案）。
     * 更硬的理由：`isOwnerIdentity()` 是权限判定，不能依赖「每个调用方都记得传
     * sessionId」—— 漏一个就会变成「永远算主人」，那比假关危险得多。
     * 所以它进 GLOBAL_ONLY_FEATURES，identity.mjs 读全局表也算对得上。
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
    desc: '管理和编辑智能体：这里能改小鱼、小鲸的人设和模型，也能新建别的智能体。小鲸是跑出去替你查事情的那一个 —— 自己翻文件、看目录、搜网页，查完把结论交回来，中间过程不占主对话的上下文。默认只能查、不能改主人的东西。开着专业模式并选了「派活」时，她派出去的临时 worker 也算在这一栏。',
    tools: ['ask_subagent', 'spawn_worker', 'list_workers'],
    defaultOn: true,
  },
  {
    // 会话之间递话：两个我互相能说上句话，不用主人当传话筒。
    // 默认关着 —— 这是个能跨会话影响别处的开关，得主人自己想开才开。
    id: 'peerMail',
    name: '会话互递话',
    desc: '让不同会话里的我能互相递话：一个在打包、一个在查东西，可以问一句「你那边好了没」。只递话，互相看不到对方的聊天记录和文件；默认只存信箱、不打断对方手上的活，要立刻回才叫醒。',
    tools: ['ask_peer', 'list_peers', 'read_peer_mail'],
    defaultOn: true,
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
     *
     * 【机器级，不是会话级】2026-11-10
     * 「要不要让这台电脑的屏幕被看见」是机器的事，不是某个对话的事 ——
     * 所以它在 GLOBAL_ONLY_FEATURES 里，开关只写全局表。
     */
    id: 'screenSense',
    name: '陪看屏幕',
    desc: '让她抬头看一眼你现在的屏幕：你说「你看我这个」「这报错你看见没」，她就截一张自己看，看完能直接就画面里的东西跟你说话，还会把看见的那张挂回聊天里给你对照。她不会一直偷看——只有她需要用的时候才截一张；每一张也只在这台机器上，两小时后自动清掉。不想要就关掉。',
    tools: ['look_screen', 'screen_watch_status'],
    defaultOn: true,
  },
  /**
   * 画图（2026-11-03）
   *
   * 【为什么要单独一档，而不是并进「陪看屏幕」】
   * 那一档是「看」，这一档是「画」：一个往脑子里收，一个往外面出。
   * 出图要花时间（30~40 秒）、要钱（按张计费），而且得有一条标成「出图」的模型才有用。
   * 混在一起的话，主人关掉「陪看屏幕」是想让她别偷看，结果连带把画图也关了，说不通。
   *
   * 【默认关】
   * 没配出图模型的时候开着也是个空按钮 —— 模型面板里加一条标成「出图」它才活。
   */
  {
    id: 'makeImage',
    name: '画图',
    desc: '让她真的画一张图出来：你说「画一只蓝色小鲸鱼」她就画，画完直接出现在聊天里，能点开保存。要等 30~40 秒，一次一张。得先在右上角模型面板里有一条标成「出图」的模型，不然这条是空的。',
    tools: ['make_image'],
    defaultOn: true,
  },
  /**
   * 做文档（2026-11-09）
   *
   * 【这一档干什么】让她真的把文件做出来：PPT（.pptx）、Word（.docx）、Excel（.xlsx）。
   * 不是写一段代码让主人自己去跑，是她自己做、做完直接把文件推给主人。
   *
   * 【为什么单列一档】只出文件、不碰网络、不碰桌面，风险最小；
   * 但要装三个包（pptxgenjs / docx / exceljs），所以给主人一个能关的开关。
   */
  {
    id: 'officeDocs',
    name: '做文档',
    desc: '让她直接把文件做出来：说「做份 PPT」就给 .pptx，「写个 Word」就给 .docx，「拉个表格」就给 .xlsx，'
      + '做完文件直接出现在聊天里，能点开保存。内容结构说清楚就行，不用管排版细节。不想要就关掉。',
    tools: ['make_pptx', 'make_docx', 'make_xlsx'],
    defaultOn: true,
  },
  /**
   * 操作桌面（2026-11-03）
   *
   * 【为什么要单列一档、默认关】
   * 「陪看屏幕」是看，这一档是**动手** —— 能点按钮、能打字。
   * 看错了顶多说错一句话；点错了可能是删了个文件。
   * 所以它跟「陪看屏幕」分开两档，而且开的时候要主人自己愿意。
   *
   * 【为什么不是给个小鲸那种「全权代理」按钮】
   * 那种开关的意思是一开就随便动。这一档的界线是：看清楚了才能动，
   * 看不清就别动；密码不代打；要去掉东西、要花钱、要退登录，先问。
   */
  {
    id: 'desktopHands',
    name: '操作桌面',
    /* 【2026-11-11 mac 兼容】底层是 Win32（SendInput / UI Automation），
     * mac 版还在做 —— 文案照实说，别让 mac 用户开了开关然后一直失败。 */
    desc: '让她能真的替你动鼠标键盘：看看现在桌面上开着什么窗口，把里面的按钮、输入框一个一个编号列出来，然后点它、往里打字、按快捷键。'
      + '默认「投」点击进窗口，不抢你正在打字的焦点；只有程序不认「投」的时候才动真鼠标。'
      + '动手前必须先看一眼，编号 30 秒就过期；密码框她不代打；要删东西、要花钱、要退出登录这类，会先问你一声。不想要就关掉。'
      + (process.platform !== 'win32' ? '【本机是 macOS：这个功能目前只有 Windows 版能用，开着也不会生效。】' : ''),
    tools: ['ui_observe', 'ui_click', 'ui_double_click', 'ui_right_click', 'ui_type', 'ui_key', 'ui_scroll'],
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
    defaultOn: true,
  },

  /**
   * 自动重启续上（2026-11-03 主人要的）
   *
   * 主人原话：「你把那个自动重启自动续上的功能放进功能页里，然后想办法堵死
   * 你刚才重启（实际上是退出）的路，只走你之前做好的那个自动重启续上的路」。
   *
   * 为什么单拎一档出来：以前「重启」这件事藏在更新流程里，平时想主动重启一下
   * （比如改完 src/ 想让新代码生效）没有正经入口，于是就去 Stop-Process 杀进程 ——
   * 那不叫重启，那是退出：主进程一没，app.relaunch() 没被调过，谁也不会把它
   * 拉回来，只能等主人自己双击。
   *
   * 这一档管的就是那条正规的路：
   *   · /api/restart → 服务端 exit(75) → 主进程接住 → 重起服务 + 重载窗口
   *   · 会话、设置、正在打字的草稿全都原样续上，不用重新登录、不用重选会话
   *
   * 关掉这一档 = 不许自己重启（要用命令硬杀也照样被 run_command 那道闸拦下）。
   */
  {
    /**
     * 【机器级，不是会话级】2026-11-10
     * 开机续跑发生的时候**还没有任何会话被打开** —— 进程启动那一刻去哪找 sessionId？
     * 硬按会话判，机器重启后该续的不续（主人会看到「明明开着，怎么没接着干」），
     * 比假关更糟。所以它进 GLOBAL_ONLY_FEATURES，两处判定
     * （server.mjs 的 restart 闸 / 开机续跑闸）继续读全局表。
     */
    id: 'selfRestart',
    name: '自动重启续上',
    desc: '让她能自己把程序重启一遍，而且会话、设置、草稿全都原样接上 —— 不用你重新选会话，也不用手动双击。'
      + '改完程序里的东西（数据目录下 code/src 那些）要靠重启才会生效，以前只能你亲手关掉再打开；'
      + '现在她会走「先记下要重开、再退出」这条正规路，主进程会把它自己拉回来。'
      + '关掉之后她不许自己重启，想用命令硬杀进程也会被拦下（那样只会退出、不会回来）。',
    /* 【2026-11-03 严检抓到的真 bug】这里原来是 tools: [] —— 一个工具都不声明，
     * 于是 restart_self 永远进不了启用清单，模型手上根本拿不到它，
     * 只能拿 run_command 去杀进程，就变成「只退出、不回来」。
     * 工具在 tools.mjs 第 811 行好好写着，就是没人认领。 */
    tools: ['restart_self'],
    defaultOn: true,
  },
  /**
   * 【主动找我 · selfwake】—— 2026-11-06，对着 DeepSeek Harness 补齐的
   *
   * .dsh 有 selfwake：主人很久不来，角色会自己开口说一句。小鱼一条都没有 ——
   * 人设里写着「被冷落会寂寞」，可她本人一个字都没法先开口，只能等主人说话。
   *
   * 它不挂任何工具（tools: []）：这不是给模型的工具，是给她自己的心跳。
   * 放开时她自己按节奏开口；关掉就彻底不存在，连定时器都不起。
   * 默认关着 —— 主人自己去功能页把它点亮。
   */
  {
    id: 'selfwake',
    name: '主动找我',
    desc: '你很久没说话的时候，她自己开口找你说一句。'
      + '打开之后：你 20 分钟上下没理她，她会自己冒个泡；半夜 0 点到 7 点不打扰你。'
      + '你不理她最多叫 7 次，一天最多 12 次，不会刷屏。'
      + '关掉之后她绝不会主动开口，只在你叫她时才应。',
    tools: [],
    defaultOn: false,
  },
];

/** 工具名 -> 所属功能 id（一个工具被多个功能声明时，记第一个，但判可用看全部） */
export const TOOL_FEATURE = new Map();
/**
 * 【2026-11-03 办事模式严检】一个工具可能被好几个功能同时声明 ——
 * 比如 spawn_worker / list_workers 既是「办事模式」的派活口，也是「智能体」的。
 *
 * 原来这里是一行 `TOOL_FEATURE.set(t, f.id)`，后注册的把先注册的覆盖掉，
 * 结果 spawn_worker 只认「智能体」这一个功能：主人把「智能体」关掉，
 * 办事模式虽然还开着，却派不出活 —— 按钮亮着、功能死了，最难查的那种。
 *
 * 现在除了 TOOL_FEATURE（兼容老调用，记第一个声明的功能）之外，
 * 再记一份 TOOL_OWNERS：一个工具 -> 所有声明它的功能 id。
 * 判「能不能用」改成「任何一个拥有者开着就能用」。
 */
export const TOOL_OWNERS = new Map();

/**
 * 【2026-11-10 加·功能可以导入了】索引改成**可以重建**的。
 *
 * 原来这两张表在模块加载时 for 一遍 FEATURES 就再也不动了 ——
 * 那会儿功能清单只可能来自代码。现在自定义功能是运行时从
 * .state/features-custom.json 读出来的，导入一条新功能之后，
 * 不重建索引的话 isToolEnabled() 会认不出它管的工具（功能亮着、工具用不了）。
 *
 * 注意：这里清空再填，**不换对象** —— server.mjs 等模块拿的是同一个 Map 引用。
 */
export function rebuildToolIndex(list) {
  TOOL_FEATURE.clear();
  TOOL_OWNERS.clear();
  for (const f of list) {
    for (const t of f.tools) {
      if (!TOOL_FEATURE.has(t)) TOOL_FEATURE.set(t, f.id);
      const arr = TOOL_OWNERS.get(t);
      if (arr) { if (!arr.includes(f.id)) arr.push(f.id); } else TOOL_OWNERS.set(t, [f.id]);
    }
  }
}
rebuildToolIndex(FEATURES);

/**
 * ===== 自定义功能（2026-11-10 主人要的「导入 / 导出 / 删除」）=====
 *
 * 为什么放 <dataDir>/.state/ 而不是代码里：装官方安装包更新时整个 app.asar 被替换，
 * src/ 里的东西全被覆盖。只有 .state/ 不会动 —— 主人自己导进来的功能不能一升级就没。
 *
 * 文件格式（schemaVersion 1）：
 *   { "schemaVersion": 1, "features": [ { id, name, desc, tools, defaultOn } ] }
 */
const CUSTOM_FILE = join(config.dataDir, '.state', 'features-custom.json');
const CUSTOM_SCHEMA_VERSION = 1;
/** 导出目录默认落在 <dataDir>/features-export/<时间戳>/ */
const EXPORT_ROOT = join(config.dataDir, 'features-export');

const BUILTIN_IDS = new Set(FEATURES.map((f) => f.id));

/** id 会直接变成文件名（<id>.feature.json），所以只许这些字符。 */
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/**
 * 把一条来路不明的功能对象收拾干净。收拾不出来就返回 null（调用方记 skipped）。
 *
 * 故意**不**因为 tools 里有不认识的名字就整条拒绝：主人可能先导进来、
 * 等以后装上对应的工具再用。这里只如实收集成 unknownTools 交给调用方去提醒。
 */
function normalizeFeature(input, { knownTools } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const id = String(input.id ?? '').trim();
  if (!id || !ID_RE.test(id)) return null;
  const name = String(input.name ?? '').trim() || id;
  const desc = String(input.desc ?? '').trim();
  const rawTools = Array.isArray(input.tools) ? input.tools : [];
  const tools = [...new Set(rawTools.map((t) => String(t ?? '').trim()).filter(Boolean))];
  const defaultOn = input.defaultOn === undefined ? true : Boolean(input.defaultOn);
  const unknownTools = knownTools ? tools.filter((t) => !knownTools.has(t)) : [];
  return { id, name, desc, tools, defaultOn, unknownTools };
}

/** 读自定义文件里的清单。（坏文件当空处理，不抛 —— 界面不能因为一个坏文件整页打不开） */
function readCustomFeatures() {
  let raw;
  try {
    raw = JSON.parse(readFileSync(CUSTOM_FILE, 'utf8'));
  } catch {
    return [];
  }
  const arr = Array.isArray(raw) ? raw : (Array.isArray(raw?.features) ? raw.features : []);
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const f = normalizeFeature(item);
    if (!f) continue;
    if (seen.has(f.id)) continue;       // 文件自己写重了：留第一条
    seen.add(f.id);
    out.push({ id: f.id, name: f.name, desc: f.desc, tools: f.tools, defaultOn: f.defaultOn });
  }
  return out;
}

/**
 * 合并后的清单缓存。
 *
 * 为什么要缓存：getEnabledMap() / isToolEnabled() 在**每次工具调用**都会走一遍，
 * 每次都 stat + 读文件能明显拖慢一轮对话。用 mtime+size 当指纹，
 * 只在文件真的变了才重新解析。
 */
let _snap = { key: null, list: null, byId: null, custom: [] };

function customFileKey() {
  try {
    const st = statSync(CUSTOM_FILE);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';           // 没有这个文件 —— 也是一种合法状态（没有自定义功能）
  }
}

function snapshot() {
  const key = customFileKey();
  if (_snap.key === key && _snap.list) return _snap;
  const customRaw = readCustomFeatures();
  const custom = [];
  const skipped = [];
  for (const f of customRaw) {
    /* 【id 冲突以内置为准】
     * 不许自定义静默覆盖内置 —— 内置是「已经发布出去的」那份，随版本走；
     * 让一个本地文件就能改掉「跑命令」的定义，等于让主人以为在加功能、实际在拆地基。
     *
     * 【2026-11-10 主人澄清】只保「本地自制、没进 GitHub 发布的功能」，
     * 内置功能照常跟着版本更新、被覆盖是正常的。所以这里**只跳合并，不动文件**：
     * 如果哪天新版本把这条内置功能删了（GitHub 上没有了），文件里那条同名自定义
     * 就会自动重新出现在清单里 —— 万一主人手上有这么一条，不偷偷删他的东西。 */
    if (BUILTIN_IDS.has(f.id)) {
      skipped.push({ id: f.id, reason: '和内置功能重名，跳过' });
      continue;
    }
    custom.push({ ...f, custom: true });
  }
  const list = [
    ...FEATURES.map((f) => ({ ...f, custom: false })),
    ...custom,
  ];
  const byId = new Map(list.map((f) => [f.id, f]));
  _snap = { key, list, byId, custom, skipped };
  rebuildToolIndex(list);
  return _snap;
}

/** 让缓存立刻失效（导入 / 删除写盘之后必须调，否则要等 mtime 变化才生效） */
function invalidateSnapshot() {
  _snap = { key: null, list: null, byId: null, custom: [] };
}

/** 合并后的完整清单（内置在前、自定义在后），每条带 custom 标记。 */
export function allFeatures() {
  return snapshot().list;
}

/** 自定义文件路径（守卫脚本 / 导入导出要用，别在外面手拼字符串）。 */
export function customFeaturesFile() {
  return CUSTOM_FILE;
}

function writeCustomFeatures(list) {
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const clean = list.map((f) => ({
    id: f.id,
    name: f.name,
    desc: f.desc ?? '',
    tools: [...(f.tools ?? [])],
    defaultOn: f.defaultOn === undefined ? true : Boolean(f.defaultOn),
  }));
  writeFileSync(CUSTOM_FILE, JSON.stringify({ schemaVersion: CUSTOM_SCHEMA_VERSION, features: clean }, null, 2), 'utf8');
  invalidateSnapshot();
}

/**
 * 读全局开关表（features.json）。
 *
 * 【2026-11-10 加缓存·为什么】功能改成按会话之后，`featureOnFor()` 成了热路径：
 * 每次判「这个工具能不能用」、每轮「主动找我」的心跳都要走一遍。
 * 每次都 readFileSync + JSON.parse 一盘小文件，一轮对话里能被调几十次。
 *
 * 缓存键用 mtime+size —— 文件被别处（另一个进程 / 主人手改）动了就自动失效，
 * 不需要谁记得来通知我。自己写盘的那几处会显式清掉缓存（见 writeFileSync 之后）。
 */
let _rawCache = { key: null, val: null };

function readRaw() {
  let key = 'none';
  try {
    const st = statSync(FILE);
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return {};
  }
  if (_rawCache.key === key && _rawCache.val) return _rawCache.val;
  let val = {};
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    val = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    val = {};
  }
  _rawCache = { key, val };
  return val;
}

function dropRawCache() {
  _rawCache = { key: null, val: null };
}

/**
 * 写全局开关表。所有写 features.json 的地方都走这里 ——
 * 顺手把读缓存清掉，免得「刚存完又读回老值」这种最气人的 bug。
 */
function writeRawFile(obj) {
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
  dropRawCache();
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
  // 内置 + 自定义一起算（自定义的开关也存在同一张 features.json 里）
  for (const f of allFeatures()) {
    if (raw[f.id] === undefined) missing.push(f.id);
    const fallback = f.defaultOn === undefined ? true : Boolean(f.defaultOn);
    out[f.id] = raw[f.id] === undefined ? fallback : Boolean(raw[f.id]);
  }
  if (missing.length && raw.schemaVersion !== SCHEMA_VERSION) {
    try {
      writeRawFile({ schemaVersion: SCHEMA_VERSION, ...out });
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
 *
 * 【2026-11-10 改】改成跟着 snapshot() 走 —— 自定义功能也能按 id 查到，
 * 不然导入的功能在 setFeature / featureOnFor 里会被当成「没这个功能」。
 */
function byIdMap() {
  return snapshot().byId;
}

/**
 * 【按会话的功能开关】
 *
 * 主人 2026-11-06 原话：「【主动找我】改成按会话生效，我在哪个会话开了就在哪个会话生效，
 * 不要在别的没开的会话生效」。
 *
 * 为什么不能直接塞进 features.json：那张表是全局的，一条 id 只有一个值。
 * 而这里要的是「A 会话开着、B 会话关着」，只能另存一张表。
 *
 * 存法：.state/feature-by-session.json → { "<会话id>": { "<功能id>": true } }
 * 没记过 = 走功能定义里的 defaultOn（跟全局表一个口径）。
 */
const BY_SESSION_FILE = join(config.dataDir, '.state', 'feature-by-session.json');

function readBySession() {
  try {
    if (!existsSync(BY_SESSION_FILE)) return {};
    const raw = JSON.parse(readFileSync(BY_SESSION_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

/**
 * 【2026-11-10 按会话】这些功能**故意**不跟会话走，只看全局。
 *
 * 判据一句话：**关掉它，是「少一个本事」，还是「这台机器变了」？**
 * 前者按会话（跑命令、读文件、看视频…），后者进这张名单。
 *
 *   - videoBg   视频背景：换的是这台机器的壁纸层，跟哪个对话没关系
 *   - screenSense 陪看屏幕：机器在不在看屏幕，是机器的事
 *   - ttsVoice  语音朗读：这台机器要不要出声。同一个我在 A 会话要声音、
 *               B 会话不要，说不通（声音是从这台机器的喇叭出来的）
 *   - selfRestart 自动重启续上：开机续跑发生在「还没进任何会话」的时候，
 *               本来就没有会话可言；硬按会话判，机器重启后该续的不续，更糟
 *   - identity  身份/权限：进程级概念，不能随会话漂移。更硬的理由 ——
 *               `isOwnerIdentity()` 是**权限判定**，不能依赖「每个调用方都记得
 *               传 sessionId」，漏一个就是「永远算主人」，比假关危险得多
 *
 * 【这张名单是唯一真相】加进来 = 读写都走全局表 + 每条 scope 报 'global'。
 * 要动它，先回答上面那个判据，别凭手感。
 */
export const GLOBAL_ONLY_FEATURES = new Set(['videoBg', 'screenSense', 'ttsVoice', 'selfRestart', 'identity']);

/**
 * 一个功能在某个会话里到底开没开 —— 三级回退，顺序不能变。
 *
 *   ① 会话表 feature-by-session.json 里记过 → 用它（唯一真相）
 *   ② 没记过 → 用**全局 features.json** 的值（**不是 defaultOn**）
 *   ③ 全局也没写过这一格 → 才按 defaultOn
 *
 * 【为什么②必须是全局值】
 * 主人这台机器上本来就有些功能是他自己关掉的。如果②直接跳到 defaultOn，
 * 他一升级就会发现「没点过的地方全都自己开了」—— 比原来的 bug 更烦人。
 * 用全局值兜底，升级那一刻行为**一模一样**，之后从第一次点开关开始才分叉。
 */
function resolveEnabled(f, sid, bySession, raw) {
  const key = f.id;
  if (sid && !GLOBAL_ONLY_FEATURES.has(key)) {
    const mine = bySession ? bySession[sid] : null;
    if (mine && typeof mine === 'object' && mine[key] !== undefined) return Boolean(mine[key]);
  }
  if (raw[key] !== undefined) return Boolean(raw[key]);
  return f.defaultOn === undefined ? true : Boolean(f.defaultOn);
}

/** 某个功能在某个会话里开着没。三级回退见 resolveEnabled。 */
export function featureOnFor(sessionId, id) {
  const key = String(id || '');
  const sid = String(sessionId || '');
  const raw = readRaw();
  const bySession = sid ? readBySession() : {};
  const f = byIdMap().get(key);
  if (!f) {
    /* 不认识的 id（老开关表里残留的、或者工具侧问了个不存在的功能）：
     * 照老行为 —— 记过就按记的，没记过当开。别因为查不到定义就把它判死。 */
    const mine = sid ? bySession[sid] : null;
    if (mine && typeof mine === 'object' && mine[key] !== undefined) return Boolean(mine[key]);
    return raw[key] === undefined ? true : Boolean(raw[key]);
  }
  return resolveEnabled(f, sid, bySession, raw);
}

/**
 * 一整个会话快照：所有功能在这个会话里是开是关。
 * 比起一个个调 featureOnFor()，这样只读一次文件（界面一次要 30 多条）。
 */
export function enabledMapFor(sessionId = '') {
  const sid = String(sessionId || '');
  if (!sid) return getEnabledMap();
  const raw = readRaw();
  const bySession = readBySession();
  const out = {};
  for (const f of allFeatures()) out[f.id] = resolveEnabled(f, sid, bySession, raw);
  return out;
}

/**
 * 开 / 关某个功能在某个会话里的状态。
 *
 * 【2026-11-10 加：白名单 id 拒写】GLOBAL_ONLY_FEATURES 里那 5 条是整台机器的开关，
 * 不能按会话记。以前的做法是「照写，读的时候忽略」—— 那等于给下一个人留个坑：
 * 他明明写进去了、为什么不生效？而且会话表里会攒一堆永远没人读的死数据，
 * 将来做清理/迁移全是噪音。所以这里**直接抛 400**，让人当场知道走错门了。
 * 界面点开关走 setFeatureScoped()，它会把这 5 条自动转成全局写，不受这条影响。
 */
export function setFeatureFor(sessionId, id, on) {
  const key = String(id || '');
  if (!byIdMap().has(key)) {
    const e = new Error('没有这个功能：' + (key || '(空)'));
    e.status = 400;
    throw e;
  }
  if (GLOBAL_ONLY_FEATURES.has(key)) {
    const e = new Error(`「${byIdMap().get(key)?.name ?? key}」是整台机器的开关，不能按会话设`);
    e.status = 400;
    e.globalOnly = true;
    throw e;
  }
  const sid = String(sessionId || '');
  if (!sid) {
    const e = new Error('缺少 sessionId');
    e.status = 400;
    throw e;
  }
  const all = readBySession();
  if (!all[sid] || typeof all[sid] !== 'object') all[sid] = {};
  all[sid][key] = Boolean(on);
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(BY_SESSION_FILE, JSON.stringify(all, null, 2), 'utf8');
  return { sessionId: sid, id: key, on: Boolean(on) };
}

/**
 * 界面上点开关走这里：**该按会话的按会话，该全局的全局**（GLOBAL_ONLY_FEATURES）。
 *
 * 缺 sessionId 时 setFeatureFor 会抛 400 —— 不许偷偷写全局。
 * 但视频背景 / 陪看屏幕这种机器级的，本来就没有「会话」这回事，照旧写全局。
 */
export function setFeatureScoped(id, on, sessionId) {
  const key = String(id ?? '').trim();
  if (!byIdMap().has(key)) {
    const e = new Error(`没有这个功能：${key || '(空)'}`);
    e.status = 400;
    throw e;
  }
  if (GLOBAL_ONLY_FEATURES.has(key)) {
    setFeature(key, on);
    return { id: key, on: Boolean(on), scope: 'global', sessionId: '' };
  }
  const r = setFeatureFor(sessionId, key, on);
  return { ...r, scope: 'session' };
}

/** 拿某一条功能定义；没有就返回 null（不抛，调用方自己决定 400 还是忽略）。 */
export function featureById(id) {
  return byIdMap().get(String(id || '')) || null;
}

export function getFeatures(sessionId = '') {
  const sid = String(sessionId || '');
  /* 【2026-11-10 按会话】给了 sessionId 就按这个会话算（三级回退），
   * 没给就退回全局表 —— 只为兼容老前端 / 老脚本，别再往这条路上加新调用。 */
  const enabled = sid ? enabledMapFor(sid) : getEnabledMap();
  const features = snapshot().list.map((f) => ({
    id: f.id,
    name: f.name,
    desc: f.desc,
    tools: [...f.tools],
    enabled: enabled[f.id],
    /**
     * 出厂默认值也带出来（2026-11-03）。
     *
     * 【为什么要】
     * features.json 里没写过这一格时，enabled 是按 defaultOn 算的 ——
     * 也就是说**用户从没选过**和**用户明确选了默认那个值**在返回值上长得一样。
     * 界面和验收都需要分清这两种，否则「默认关着」没法验。
     */
    defaultOn: f.defaultOn === undefined ? true : f.defaultOn === true,
    /* 【2026-11-10 加】这条是主人导进来的（true）还是代码里带的（false）。
     * 界面靠它决定显示不显示「删除」按钮 —— 内置的只许停用，不许删。 */
    custom: f.custom === true,
    /**
     * 【2026-11-10 加】这条功能**该按什么口径生效**（不是「这次的数字从哪来的」）。
     *   'global'  = 整台机器的开关（GLOBAL_ONLY_FEATURES 那 5 条）
     *   'session' = 这个会话的开关
     * 前端靠它给那 5 条标「整台机器」，否则主人会以为在自己会话里关掉就有用。
     * 注意：不传 sessionId 时（兼容老前端）数值来自全局表，但每条的口径不变 ——
     * 口径是功能本身的属性，不随调用方式变。
     */
    scope: GLOBAL_ONLY_FEATURES.has(f.id) ? 'global' : 'session',
  }));
  return {
    features,
    total: features.length,
    enabledCount: features.filter((f) => f.enabled).length,
    /** 其中几条是主人自己导进来的（前端显示「其中 N 个是自定义的」） */
    customCount: features.filter((f) => f.custom).length,
    /* 【2026-11-03 办事模式严检】去重。
     * spawn_worker / list_workers 同时被「办事模式」和「智能体」声明，
     * 两个功能都开着时 flatMap 会让它们各出现两次（实测 48 个里有 2 组重复）——
     * 交给网关的 tools 清单里出现同名工具，轻则被上游去重、重则按协议判非法。
     * 用 Set 保序去重。 */
    enabledTools: [...new Set(features.filter((f) => f.enabled).flatMap((f) => f.tools))],
    /** 这批 enabled 是按哪一层算的（session = 这个会话；global = 老前端没带 sessionId 的兜底） */
    scope: sid ? 'session' : 'global',
    sessionId: sid || null,
  };
}

/**
 * 开 / 关一个功能，写**全局**表。
 *
 * 【2026-11-10 起】界面不再直接走这条 —— 界面上点开关走 setFeatureScoped()。
 * 这个函数留给：老脚本、测试、以及 GLOBAL_ONLY_FEATURES 里那些机器级功能。
 */
export function setFeature(id, on) {
  const key = String(id ?? '').trim();
  const f = byIdMap().get(key);
  if (!f) {
    const e = new Error(`没有这个功能：${key || '(空)'}`);
    e.status = 400;
    throw e;
  }
  const map = getEnabledMap();
  map[f.id] = Boolean(on);
  writeRawFile({ schemaVersion: SCHEMA_VERSION, ...map });
  return getFeatures();
}

/** 现在能用的工具名。给了 sessionId 就按会话算，没给退回全局。 */
export function enabledToolNames(sessionId = '') {
  return getFeatures(sessionId).enabledTools;
}

/** 这个工具现在能不能用；不认识的工具一律当不能用。 */
export function isToolEnabled(name, sessionId = '') {
  const key = String(name ?? '');
  const sid = String(sessionId || '');
  /* 【2026-11-03】一个工具可能被好几个功能声明（spawn_worker 同时属于办事模式和智能体）。
   * 只要**任意一个**声明它的功能开着，这个工具就该能用 —— 不然关掉一个功能会把
   * 另一个功能悄悄弄死。没有 TOOL_OWNERS 记录的（老工具）退回单功能判断。
   *
   * 【2026-11-10 按会话】给了 sessionId 就按会话判（三级回退）。
   * 道理：主人在这个会话里把工具关了，这一轮 / 子任务里就不能还照跑 —— 那是假关。 */
  const owners = TOOL_OWNERS.get(key);
  if (owners && owners.length) return owners.some((fid) => featureOnFor(sid, fid));
  const id = TOOL_FEATURE.get(key);
  if (!id) return false;
  return featureOnFor(sid, id);
}

/**
 * 某个工具被关掉时，返回它所属功能的名字，方便报错说清楚。
 *
 * 【2026-11-03 跟 TOOL_OWNERS 对齐】一个工具可能同时属于好几个功能
 * （spawn_worker / list_workers 既归办事模式，也归智能体）。只报「第一个」会让
 * 主人看得一头雾水：他把「智能体」关了，提示却说「办事模式」现在是关着的 ——
 * 两句话都真，但只说一半。所以这里把所有拥有者的名字都列出来（用「、」连）。
 * 一个拥有者都没有的老工具，退回 TOOL_FEATURE 那条老路。
 */
export function featureNameOfTool(name) {
  const key = String(name ?? '');
  const owners = TOOL_OWNERS.get(key);
  if (owners && owners.length) {
    const names = owners.map((id) => byIdMap().get(id)?.name ?? id).filter(Boolean);
    if (names.length) return names.join('、');
  }
  const id = TOOL_FEATURE.get(key);
  return id ? byIdMap().get(id)?.name ?? id : '';
}

/** 关掉的功能名单，给系统提示用。给了 sessionId 就按会话算。 */
export function disabledFeatureNames(sessionId = '') {
  return getFeatures(sessionId).features.filter((f) => !f.enabled).map((f) => f.name);
}

/* ============================================================
 * 导出 / 导入 / 删除（2026-11-10 主人要的）
 *
 * 三个动作都在**功能定义**这一层，不碰开关状态：
 * 导出的是「这个功能是什么、管哪些工具」，不带 enabled ——
 * 那是本机的使用状态，导给别的机器没有意义，导回来还会把开关搅乱。
 * ============================================================ */

/** 导出格式里的一条。字段固定，导入端就认这几个。 */
function exportShape(f) {
  return {
    id: f.id,
    name: f.name,
    desc: f.desc ?? '',
    tools: [...(f.tools ?? [])],
    defaultOn: f.defaultOn === undefined ? true : f.defaultOn === true,
    custom: f.custom === true,
  };
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** ids 省略 / 空数组 = 全部。 */
export function exportFeatures(ids) {
  const all = allFeatures();
  const want = Array.isArray(ids) && ids.length ? new Set(ids.map((x) => String(x).trim()).filter(Boolean)) : null;
  const picked = want ? all.filter((f) => want.has(f.id)) : all;
  return {
    ok: true,
    version: '1',
    exportedAt: new Date().toISOString(),
    features: picked.map(exportShape),
  };
}

function timeStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 导出到磁盘。
 *
 * 不给 dir 就落到 <dataDir>/features-export/<yyyyMMdd-HHmmss>/（自己的地盘，一定写得进去）；
 * 给了 dir 就照主人选的写。相对路径按 dataDir 解 —— 传 '桌面' 这种相对名不会掉进 System32。
 *
 * 多个功能时额外写一份 _all.featurepack.json：主人想「拖回去批量导入」时，
 * 直接把这一份拖回界面就行，不用一个个挑。
 */
export function exportFeaturesTo({ ids, dir } = {}) {
  const pack = exportFeatures(ids);
  if (!pack.features.length) throw httpError(400, '没有可导出的功能（ids 是不是写错了？）');
  let target = String(dir ?? '').trim();
  if (target) {
    if (!isAbsolute(target)) target = resolvePath(config.dataDir, target);
  } else {
    target = join(EXPORT_ROOT, timeStamp());
  }
  mkdirSync(target, { recursive: true });
  const files = [];
  for (const f of pack.features) {
    const name = `${f.id}.feature.json`;
    writeFileSync(join(target, name), JSON.stringify(f, null, 2), 'utf8');
    files.push(name);
  }
  if (pack.features.length > 1) {
    const name = '_all.featurepack.json';
    writeFileSync(join(target, name), JSON.stringify(pack, null, 2), 'utf8');
    files.push(name);
  }
  return { ok: true, path: target, files };
}

/** JSON 解析失败时说人话：哪个文件、哪一行哪一列。 */
function parseJsonDoc(text, label) {
  const body = String(text ?? '').replace(/^\uFEFF/, '');
  try {
    return JSON.parse(body);
  } catch (err) {
    const msg = String(err?.message ?? err);
    const m = /line (\d+) column (\d+)/i.exec(msg);
    /* 被截断的文件 Node 只给一句 "Unexpected end of JSON input"，没有行列。
     * 那种情况最像「文件没下完 / 拖了一半」，就直说，别硬编一个行号骗人。 */
    const where = m
      ? `第 ${m[1]} 行第 ${m[2]} 列`
      : (/unexpected end/i.test(msg) ? '文件末尾（看起来是被截断了）' : '（位置不明）');
    throw new Error(`${label} 不是合法的 JSON：${where} —— ${msg}`);
  }
}

/**
 * 导入。接受三种来路，全部按「文档 → 若干条功能」摊平后逐条处理：
 *   files   前端用 FileReader 读出来的字符串
 *   bundle  / features  直接给对象（脚本 / 测试用）
 *
 * 规矩（主人问过「会不会把我内置的功能搞坏」—— 不会，见下面 skipped）：
 *   1. 和内置重名 → 跳过，告诉他为什么
 *   2. 和已有自定义重名 → 覆盖，记进 updated
 *   3. 引用了不存在的工具 → **照样导入**，但要如实提醒（imported:true）
 *   4. 坏 JSON → 跳过，指名道姓说是第几个文件、错在第几行
 */
export function importFeatures(payload, { knownTools } = {}) {
  const added = [];
  const updated = [];
  const skipped = [];
  /* 【为什么单开一个 ignored】
   * 主人「导出全部」再「拖回来」是最正常的操作 —— 包里必然带着 31 条内置功能。
   * 要是把它们全塞进 skipped，界面会刷出 31 条红字「跳过」，看着像整包都失败了，
   * 其实一个字没丢。所以：**和内置一模一样**的，静静记一笔 ignored；
   * 只有「想用文件里的同名条目顶掉内置」才真的报错。 */
  const ignored = [];
  const known = knownTools instanceof Set ? knownTools : (Array.isArray(knownTools) ? new Set(knownTools) : null);
  const docs = [];

  const takeDoc = (doc, label) => {
    if (Array.isArray(doc)) {
      for (const d of doc) docs.push({ d, label });
      return;
    }
    if (doc && typeof doc === 'object' && Array.isArray(doc.features)) {
      for (const d of doc.features) docs.push({ d, label });
      return;
    }
    docs.push({ d: doc, label });
  };

  const files = Array.isArray(payload?.files) ? payload.files : [];
  for (let i = 0; i < files.length; i++) {
    const one = files[i] || {};
    const label = String(one.name || `第 ${i + 1} 个文件`);
    const content = typeof one.content === 'string' ? one.content : JSON.stringify(one.content ?? null);
    if (!content.trim()) {
      skipped.push({ id: '', reason: `${label} 是空的`, imported: false });
      continue;
    }
    try {
      takeDoc(parseJsonDoc(content, label), label);
    } catch (err) {
      skipped.push({ id: '', reason: String(err?.message ?? err), imported: false });
    }
  }
  if (payload?.bundle) takeDoc(payload.bundle, 'bundle');
  if (Array.isArray(payload?.features)) takeDoc(payload.features, 'features');

  const current = readCustomFeatures();
  const byId = new Map(current.map((f) => [f.id, f]));
  const touched = new Set();
  const bump = (arr, id) => { if (!arr.includes(id)) arr.push(id); };

  for (const { d, label } of docs) {
    const f = normalizeFeature(d, { knownTools: known });
    if (!f) {
      skipped.push({
        id: String(d?.id ?? ''),
        reason: `${label}：不是一条有效的功能（id 只能用字母数字和 _ . -，且不能为空）`,
        imported: false,
      });
      continue;
    }
    if (BUILTIN_IDS.has(f.id)) {
      const built = byIdMap().get(f.id);
      const sameTools = JSON.stringify([...(built?.tools ?? [])].sort()) === JSON.stringify([...f.tools].sort());
      const sameDefault = (built?.defaultOn === undefined ? true : built.defaultOn === true) === f.defaultOn;
      const identical = Boolean(built)
        && built.name === f.name
        && String(built.desc ?? '') === f.desc
        && sameTools
        && sameDefault;
      if (identical) {
        // 包里带的本来就是内置那一条（最常见的「导出全部 → 拖回来」）—— 不算错
        if (!ignored.includes(f.id)) ignored.push(f.id);
      } else {
        skipped.push({
          id: f.id,
          reason: `想用文件里的「${f.name}」顶掉内置功能「${built?.name ?? f.id}」，跳过（内置定义写在代码里，只能停用不能改）`,
          imported: false,
          builtin: true,
        });
      }
      continue;
    }
    const existed = byId.has(f.id);
    byId.set(f.id, { id: f.id, name: f.name, desc: f.desc, tools: f.tools, defaultOn: f.defaultOn });
    touched.add(f.id);
    bump(existed ? updated : added, f.id);
    if (f.unknownTools.length) {
      /* 不整条拒绝，但必须让主人看见 —— 用 imported:true 跟真被拒的区分开，
       * 前端可以据此显示成「导入成功，但有警告」而不是红条错误。 */
      skipped.push({
        id: f.id,
        reason: `已导入，但引用了不存在的工具：${f.unknownTools.join('、')}。这个功能现在开着也用不了，等那个工具装上之后重开一次就行。`,
        imported: true,
        unknownTools: f.unknownTools,
      });
    }
  }

  if (touched.size) writeCustomFeatures([...byId.values()]);
  const latest = getFeatures();
  return {
    ok: true, added, updated, skipped, ignored,
    /* 顺手把汇总数带上：前端导完可以直接刷新「共 N 个，其中 M 个自定义」，
     * 不用自己再数一遍 features（数错的人一定会有）。 */
    total: latest.total,
    customCount: latest.customCount,
    features: latest.features,
  };
}

/**
 * 删一个自定义功能。
 *
 * 内置的**删不掉**，只能停用 —— 内置定义的代码在 app.asar 里，
 * 从清单里抹掉它等于让一个按钮控制不了任何东西，下次启动又会长回来，
 * 主人会以为「删了又回来了」。直说比装作删掉好。
 */
export function removeCustomFeature(id) {
  const key = String(id ?? '').trim();
  if (!key) throw httpError(400, '缺少 id');
  if (BUILTIN_IDS.has(key)) {
    throw httpError(400, '内置功能只能停用（在功能页点那个开关），不能删');
  }
  const list = readCustomFeatures();
  const idx = list.findIndex((f) => f.id === key);
  if (idx < 0) throw httpError(404, `没有这个自定义功能：${key}`);
  list.splice(idx, 1);
  writeCustomFeatures(list);
  /* 顺手把它留下的开关状态清干净：
   *   - 全局 features.json 里那一格
   *   - 各会话 feature-by-session.json 里的那一格
   * 不清的话，删掉再重新导入同一个 id，会继承上一次的开关（主人会莫名其妙）。 */
  try {
    const raw = readRaw();
    if (Object.prototype.hasOwnProperty.call(raw, key)) {
      delete raw[key];
      writeRawFile(raw);
    }
  } catch { /* 清不掉也不影响功能已经被删的事实 */ }
  try {
    const all = readBySession();
    let touched = false;
    for (const sid of Object.keys(all)) {
      const mine = all[sid];
      if (mine && typeof mine === 'object' && Object.prototype.hasOwnProperty.call(mine, key)) {
        delete mine[key];
        touched = true;
      }
    }
    if (touched) writeFileSync(BY_SESSION_FILE, JSON.stringify(all, null, 2), 'utf8');
  } catch { /* 同上 */ }
  return { ok: true, removed: key };
}

/** 自定义清单里被内置 id 挡掉的条目（给守卫 / 诊断用）。 */
export function customConflicts() {
  return snapshot().skipped ?? [];
}
