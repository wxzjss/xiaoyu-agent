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
const SCHEMA_VERSION = 3;

/** 功能清单。数组顺序就是界面上的顺序。 */
export const FEATURES = [
  {
    id: 'web',
    name: '联网搜索',
    desc: '上网搜东西，再打开搜到的网页读正文。关掉之后既搜不了也打不开网页。',
    tools: ['web_search', 'fetch_url'],
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
    desc: '把一段短片铺成聊天背景（无声循环播放），右下角小圆钮调透明度。不想要就关掉。',
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
