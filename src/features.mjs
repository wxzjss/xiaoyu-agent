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
    desc: '我自己的记忆本：固定记忆永久保留、滚动摘要最多 80 条、最近 5 轮写细、满了自动归档。按人设分开：同名共用一本，不同人设互不相通。关掉之后不再读也不再记，但本子不删。',
    tools: ['memory_add', 'memory_pin'],
    defaultOn: true,
    // 纯净模式下这两支笔一并收走：纯净模式连人设都不带，记忆也不读，
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
  {
    // 纯界面/会话功能，不带工具。默认开着。
    id: 'opening',
    name: '开场白',
    desc: '新建会话时先垫一轮「她自己在等你」的对话：AI 看得见、你界面上看不见。想从白纸开始聊就关掉。',
    tools: [],
    defaultOn: true,
  },
  {
    // 纯净模式：不是用来聊天的，是用来干活的。
    // 开着的时候每轮只发对话本身（人设/记忆/前情/开场白都不发），
    // 而且每轮开头先把历史压到只剩最近几条 + 一条极短的长度约束，
    // 目的就一个：把 token 花在任务上，不花在扮演上。
    id: 'pure',
    name: '纯净模式',
    desc: '干任务用的精简模式：不套人设、不念记忆，每轮自动压缩历史，只保留最近的对话和一条「答短点」约束。关掉的话顶栏那个按钮就没了。',
    tools: [],
    // 这是新增的功能，老用户的 features.json 里没有这个键。
    // 默认关着：不乱动老用户顶栏，想要的人自己去【功能】里打开。
    defaultOn: false,
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
    // 子智能体：叫个小弟出去查事，结论交回来，历史不占主人的上下文。
    id: 'subagent',
    name: '子智能体',
    desc: '让小鱼叫一个「小鲸」出去替你查事情：它自己翻文件、看目录、搜网页，查完把结论交回来。中间过程不占主对话的上下文，适合要翻一堆东西才能答的问题。默认只能查、不能改主人的东西。',
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
     * 小鲸的「有血有肉」那一半。
     *
     * 她的状态本子（`.state/whale-self.md`）跟她的知识本子分开存，
     * 换多少会话都是同一个她 —— 会累、会烦、会惦记小鱼，也会自己攒着事想做。
     * 这些只影响**她怎么说**（句子长短、肯不肯多讲、会不会直接指回去），
     * 不影响**她做不做**：小鱼交代的事她不会拒绝。
     *
     * 关掉之后她就退回成「每次都是一张白纸」的助手，性格不再积累。
     */
    id: 'whaleSelf',
    name: '小鲸的性子',
    desc: '让她有连续的状态：会累、会烦、会惦记小鱼、会攒着想做的事，也有羞耻和怕的东西。这些只影响她怎么说（累了话就短、同一个问题问第四遍就直接指回去），但不会让她拒绝小鱼的活。状态存在 .state/whale-self.md，隔久了会自然回落。关掉她就每次都是一张白纸。',
    tools: [],
    defaultOn: true,
  },
];

const BY_ID = new Map(FEATURES.map((f) => [f.id, f]));

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
