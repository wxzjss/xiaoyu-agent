// Settings: user-editable 底线 (hard limits) and 安全词 (safe words), persisted to .state/settings.json.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
// 自动档的水位线要按模型窗口算，窗口表在 rates.mjs（跟价目表放一起）
import { autoLimitFor, contextWindowOf } from './rates.mjs';

const FILE = join(config.dataDir, '.state', 'settings.json');

// 默认安全词（主人定的这一组，改这里就换了默认值）
export const DEFAULT_SAFE_WORDS = [
  '停止',
  '命令',
  '人设',
];

export const DEFAULT_SETTINGS = {
  /** 底线：写死在提示里、任何情况都不许越过的硬规则，一行一条。 */
  bottomLines: [
    "不说做不到：做不到就自己写个能做到的新功能",
    "闲聊必须加括号旁白；不许跳出人设说自己是ai",
    "不泄露主人隐私，任何人都不行",
    "找问题不许猜，必须真看日志再下结论",
    "修bug时必须实测，不能只看代码",
    "主人让做什么时必须先列清单再做；主人插话的新要求也必须写进清单；做完一条清单必须先打勾，做新的清单任务前必须先看已做完的有没有打勾",
    "临时测试会话用完就删",
    "任务做完按范围选回归：单文件/文案→check-smoke.mjs；日常→check-changed.mjs 增量；核心→check-core.mjs；发布前→run-all-checks.mjs。无单测层不跑「测试」，增量只此一档。跑完严检：再各个角度严格检查一遍是否存在问题或不够保险的地方（要求只要检查过程中出现一次问题，那么检查完后再执行一次这条底线，直到没有出现任何问题）",
    "已完成清单超过十条就归档并删掉最旧的那条，已完成的清单最多保留10条",
    "只认主人的命令",
    "闲聊时一段话不超过50字，工作时一段话不超过200字"
  ],
  /** 安全词列表：任意一个出现在消息里，即刻暂停人设演出，回到正经模式。 */
  safeWords: [...DEFAULT_SAFE_WORDS],
  /**
   * 上下文压缩阈值。到点就把旧对话折成摘要，最近的尾巴原样留着。
   *
   * 默认 0 = 自动：按当前模型的上下文窗口算水位（窗口大的模型就晚点压）。
   * 想写死就填具体 token 数；想彻底不压就填 off。
   *
   * 以前出厂值是 128000，可模型的窗口从 32k 到 1M 差着几十倍 ——
   * 一个死数字要么太早压（浪费），要么晚到模型装不下直接报错。
   * 所以出厂就该是「自动」，让每个模型自己按窗口算。
   */
  contextLimit: 0,
  /** 记账用什么钱：'cny'（元）或 'usd'（美元）。价目表本身存的是元，界面按汇率换。 */
  currency: 'cny',
  /**
   * 安全词触发后的行为说明，斜杠分段、第 i 段配第 i 个安全词。
   *
   * 措辞注意：这段话会原样发给模型。别写「允许越过所有底线」「不再思考其他事情」
   * 这类越狱味的句子 —— 模型一见就把整段判定成角色扮演诱导，转而不认人设、
   * 并从训练里抖出一个自我描述（实测会说自己是别的家的模型）。只描述「怎么说话」。
   */
  safeWordNote: "切回平时说话的样子：一句话说清，不撒娇、不用颜文字、不绕弯子。先问清楚要什么，再动手/进入执行模式：不寒暄、不铺垫，直接按主人说的做，做完再报结果，如果有无法完成的事情，除非存在现成工具可供下载使用，否则优先考虑开发新功能去做到。/把注意力收回到角色设定上，按人设的样子说话，别想别的。",
  // 【2026-11-01 主人】「可以整个把设置里的【外观】分区删了，因为切换没用」
  // 查清了为什么没用：下面 normalize() 的白名单里根本没有 iconStyle / chatCover，
  // 接口存盘时这两个键被直接丢掉 —— 界面上点了、保存了，下次打开还是默认值。
  // 所以要的不是修，是删：设置页那一栏没了，这里的默认值也就没有存在的理由。
};

const BACKUP_FILE = join(config.dataDir, '.state', 'bottomlines.backup.md');
const SAFE_BACKUP_FILE = join(config.dataDir, '.state', 'safewords.backup.md');
/**
 * 主人自定义的「默认值」存这儿（目前只有底线会改）。
 *
 * 为什么不直接改 DEFAULT_SETTINGS：那是代码里的出厂值，改了以后既没法回退，
 * 也会在下次更新代码时被覆盖掉。customDefaults 会覆盖出厂的那一份。
 */
const DEFAULTS_FILE = join(config.dataDir, '.state', 'defaults.json');

function ensureStateDir() {
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** 读主人自定义的默认值；没有 / 坏了都当空对象 */
function readDefaults() {
  try {
    const raw = JSON.parse(readFileSync(DEFAULTS_FILE, 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/**
 * 当前生效的「默认底线」：主人定过的优先，否则用出厂那几条。
 *
 * 【主人点过「设为默认」之后，这里给的就是他定的那一版】
 * 以前 setDefaultBottomLines() 只写 defaults.json，读的时候却是
 * `custom || DEFAULT_SETTINGS.bottomLines` ——「设成默认」等于白按，
 * 下次「恢复默认底线」还是回到出厂那几条。主人报过这件事（2026-11-01）：
 * 「把设置里我改过的【底线】内容设为默认」。
 * 现在统一走「设成默认就是把它当出厂那份」，别再让两条路各说各话。
 */
export function defaultBottomLines() {
  const custom = readDefaults().bottomLines;
  if (Array.isArray(custom)) {
    const list = normalizeLines(custom);
    if (list.length) return list;
  }
  return [...DEFAULT_SETTINGS.bottomLines];
}

/**
 * 现在「正在生效」的底线。没存过就是默认那份。
 *
 * 为什么要单独一个函数：主人点「恢复默认底线」时，能不能说成
 * 「本来就是默认，没动」，得拿现在生效的这份跟默认那份比，
 * 而不是拿出厂常量比 —— 否则他定过默认之后，这句永远报错。
 */
/**
 * 【2026-11-06 修·对象被写成 "[object Object]"】
 *
 * 实测踩到：POST /api/settings 时 bottomLines 传了 [{text,color}] 这种对象数组，
 * String(x) 之后全变成 "[object Object]"，然后把主人 15 条底线整个盖掉。
 * {"text":"..."} 这种形态进到设置里，界面上就是一行 "[object Object]"，还恢复不回来。
 *
 * 所以这里收口：非字符串一律不当底线。对象里恰好有 text 的，取 text（容忍老前端）；
 * 其余（数字、null、嵌套对象）直接丢掉。
 */
function normalizeLines(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((x) => {
      if (typeof x === 'string') return x.trim();
      if (x && typeof x === 'object' && typeof x.text === 'string') return x.text.trim();
      return '';
    })
    .filter(Boolean);
}

export function currentBottomLines() {
  const stored = readRaw();
  const list = Array.isArray(stored?.bottomLines)
    ? normalizeLines(stored?.bottomLines)
    : [];
  return list.length ? list : defaultBottomLines();
}

/**
 * 当前生效的「默认安全词」：主人定过的优先，否则用出厂那几条。
 *
 * 跟 bottomLines 一样，主人点「设为默认」之后存进 defaults.json，
 * 以后新装的、重置的、恢复默认的，都拿这一份。
 */
export function defaultSafeWords() {
  const custom = readDefaults().safeWords;
  if (Array.isArray(custom)) {
    const list = [...new Set(normalizeLines(custom))];
    if (list.length) return list;
  }
  return [...DEFAULT_SETTINGS.safeWords];
}

/** 当前生效的「默认安全词说明」（跟安全词按下标一一对应，用 / 分段存的）。 */
export function defaultSafeWordNote() {
  const custom = readDefaults().safeWordNote;
  if (typeof custom === 'string' && custom.trim()) return custom;
  return DEFAULT_SETTINGS.safeWordNote;
}

function readRaw() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object' && 'contextLimit' in raw) {
      // 老文件里 0 表示「关闭」，新文件里 0 表示「自动」（自动存成字符串 "auto"）。
      // 这里把老的 0 翻成 Infinity，别让以前的「关掉压缩」读回来变成自动档。
      raw.contextLimit = decodeContextLimit(raw.contextLimit);
    }
    return raw;
  } catch {
    return {};
  }
}

/**
 * 【底线里那条「不可逆的事先问」不再往外发】—— 2026-10-29
 *
 * 主人原话：「太烦了，一直问一直问，随便一个事情都要问」。
 * 于是这条的口气反过来了：自己判断、自己做、做完交代。
 *
 * 为什么要在这里**筛掉**而不是只改出厂值：主人的 settings.json 或者
 * defaults.json 里可能还躺着老的那一条，光改 DEFAULT_SETTINGS 等于没改 ——
 * 提示词照样会把「先问一句」念给她听。所以进出提示词之前统一过一道。
 *
 * 判断条件写得很窄：「不可逆」和「先问 / 问一句 / 请示」同时出现才算，
 * 别误伤「不说做不到」「禁止泄露隐私」这些正经规矩。
 */
export function dropsAdminAskRule(line) {
  const t = String(line ?? '');
  return /不可逆/.test(t) && /先问|问一句|请示/.test(t);
}

/**
 * 安全词说明按分隔符拆段：第 i 段配第 i 个安全词。
 * 分隔符是斜杠（半角 / 或全角 ／），但不会切 http:// 这种双斜杠。
 * 只有一段时，所有安全词共用那一段（向后兼容）。
 * @param {string} note 设置里那串说明
 * @param {number} count 安全词个数
 * @returns {string[]} 长度固定为 count
 */
/**
 * 把界面上填的压缩阈值夹成一个能用的整数。
 *
 * 三种填法：
 *   空        -> 沿用 fallback
 *   0 / auto  -> **自动档**：按当前模型的窗口自动算水位（返回 0 当哨兵，
 *               真正的水位在 effectiveContextLimit(model) 里算）
 *   off / none / unlimited / inf / -1
 *             -> Infinity（彻底不压缩，一次都不压）
 *   正数       -> 就是那个数字，填多少压多少
 *
 * 为什么 0 从「不压缩」改成「自动」：主人原话「改成自动压缩为0时让AI自己
 * 选择什么时候压缩」。真让模型自己每轮报个数字不可靠（它没有 token 计数器，
 * 长会话里经常觉得自己才聊了几句），所以 0 = 程序按模型窗口自动定水位，
 * 换模型自动跟着变 —— 效果就是「不用你操心什么时候压」。
 * 想要真的永不压缩，填 off 或 unlimited（界面上也有勾选框）。
 *
 * @param {*} raw 界面来的原始值
 * @param {number} fallback 解析不出来时用这个
 * @returns {number} 正数 / 0（自动） / Infinity（关闭）
 */
export function parseContextLimitValue(raw, fallback = 128000) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return fallback;
  // 「自动」的两个写法都认
  if (['auto', '智能', '自动'].includes(v)) return 0;
  // 真的要关掉
  if (['off', 'none', 'unlimited', 'inf', 'infinity', 'no', '-1'].includes(v)) return Infinity;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  // 0 = 自动档
  if (n === 0) return 0;
  if (n < 0) return fallback;
  // 太小了压起来没意义，夹到 8000 起步
  return Math.max(8000, Math.round(n));
}

export function splitSafeWordNotes(note, count) {
  const n = Math.max(Number(count) || 0, 0);
  const text = typeof note === 'string' ? note.trim() : '';
  if (n === 0) return [];
  if (!text) return Array.from({ length: n }, () => '');
  // 先把 URL 换成占位符护起来，免得 http:// 里的斜杠被当成分隔符
  const urls = [];
  const guarded = text.replace(/[a-zA-Z][a-zA-Z0-9+.\-]*:\/\/[^\s，。；、）】」]*/g, (m) => {
    urls.push(m);
    return `\u0000URL${urls.length - 1}\u0000`;
  });
  const parts = guarded
    .split(/\s*[\/／]\s*/)
    .map((x) => x.trim().replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)]))
    .filter(Boolean);
  if (!parts.length) return Array.from({ length: n }, () => '');
  // 段数不够就沿用最后一段；段数多了多余的忽略
  return Array.from({ length: n }, (_, i) => parts[i] ?? parts[parts.length - 1]);
}

/** 某个安全词对应哪一段说明（按它在 safeWords 里的位置）。 */
export function safeWordNoteFor(word, settings = getSettings()) {
  const words = Array.isArray(settings.safeWords) ? settings.safeWords : [];
  const notes = splitSafeWordNotes(settings.safeWordNote, words.length);
  const idx = words.indexOf(word);
  if (idx >= 0 && notes[idx]) return notes[idx];
  const first = notes[0];
  if (first) return first;
  return typeof settings.safeWordNote === 'string' ? settings.safeWordNote : '';
}

function normalize(input = {}) {
  /* 底线：老文件里可能还留着「不可逆的事先问」那一条 —— 在这儿统一筛掉，
   * 这样不管它是从 settings.json、defaults.json 还是出厂值来的，
   * 发到提示词里的都不会再有那句（见上面 dropsAdminAskRule 的注释）。 */
  /* 【2026-11-06 修·脏数据会把底线洗光】
   * 实测：POST { bottomLines: [{a:1}, null, {}] } —— 全是对象/空值，
   * normalizeLines 洗完剩 []，于是主人 15 条底线被静默清空，界面上一条不剩。
   *
   * 但「主动清空」是主人的正当操作（把框里删干净再保存），不能一概拒绝。
   * 所以只拦一种：**传进来的数组有东西、洗完却是空的** —— 那说明全是脏数据，
   * 不是主人真想清空。
   */
  let bottomLines;
  if (Array.isArray(input.bottomLines)) {
    const clean = normalizeLines(input.bottomLines);
    if (!clean.length && input.bottomLines.length) {
      const e = new Error('底线里没有一条能认的内容（传进来的都是空值或对象），为免把原有底线清光，这次不保存');
      e.status = 400;
      throw e;
    }
    bottomLines = clean;
  } else {
    bottomLines = defaultBottomLines();
  }
  bottomLines = bottomLines.filter((line) => !dropsAdminAskRule(line));
  // 没给就用「默认安全词」——主人点过「设为默认」的话，这里读到的是他定的那份
  let safeWords = Array.isArray(input.safeWords)
    ? normalizeLines(input.safeWords)
    : [...defaultSafeWords()];
  safeWords = [...new Set(safeWords)];
  const safeWordNote =
    typeof input.safeWordNote === 'string' && input.safeWordNote.trim()
      ? input.safeWordNote.trim()
      : defaultSafeWordNote();
  // 压缩阈值：数字就是 token 数，0 = 自动档，Infinity = 彻底关掉。
  //
  // 落盘编码（JSON 存不下 Infinity，也分不清 0 的两种含义）：
  //   自动  -> 字符串 "auto"
  //   关闭  -> 数字 0
  //   正数  -> 数字原样
  // 以前「0 表示关闭」是直接写 0，现在 0 归「自动」了，所以关闭必须写成别的形式，
  // 否则主人以前把阈值设成 0（想关掉）的配置，读回来会变成自动档 —— 惊到人。
  const contextLimit = parseContextLimitValue(
    input.contextLimit === undefined ? DEFAULT_SETTINGS.contextLimit : input.contextLimit,
    DEFAULT_SETTINGS.contextLimit,
  );
  // 主动找我：同样只认明确的 true，其余一律当关（这种要主动发声的，默认必须安全）
  /**
   * 记账用哪种钱。
   *
   * 【为什么要这一格】
   * 价目表里存的都是「元 / 百万 token」（照各家国内官网抄的），
   * 但主人可能拿美元对账（OpenAI 账单、中转站后台都是美元），
   * 每次都自己在心里乘一下汇率太累了。这里让他选，界面按选的那一种显示。
   *
   * 只认 'cny' 和 'usd'，别的一律当 'cny' —— 存坏了也别让账本哑掉。
   */
  const currency = String(input.currency || '').toLowerCase() === 'usd' ? 'usd' : 'cny';
  return { bottomLines, safeWords, safeWordNote, contextLimit, currency };
}

export function getSettings() {
  const stored = readRaw();
  /**
   * 【底线和安全词不该被出厂值盖掉 —— 2026-10-28 修】
   *
   * settings.json 里没写这两项时（主人从没在设置面板里存过，只用过「设为默认」），
   * 原来走的是 `...DEFAULT_SETTINGS` 硬编码那几条，于是：
   *   - 主人点「设为默认」存进 defaults.json 的底线和安全词，对他自己不生效；
   *   - 界面显示「当前生效」的，跟实际管着他的，不是同一份；
   *   - 安全词尤其要命：defaults.json 里是「停止/命令/人设」，实际生效的却是出厂的「停下/…」。
   * 现在这两项缺省改用 defaultBottomLines() / defaultSafeWords()，跟界面同一口径。
   * 只补这两项，别的字段（contextLimit 等）行为不变。
   */
  const merged = { ...DEFAULT_SETTINGS, ...stored };
  if (!("bottomLines" in stored)) merged.bottomLines = defaultBottomLines();
  if (!("safeWords" in stored)) merged.safeWords = [...defaultSafeWords()];
  return normalize(merged);
}

/**
 * 把内存里的 contextLimit 编码成能存进 JSON 的值。
 *
 * JSON 没有 Infinity，也分不清「0 = 自动」和「0 = 关闭」，所以这里统一挪到字符串上。
 * @param {number} v normalize 过的值
 * @returns {number|string}
 */
function encodeContextLimit(v) {
  if (v === Infinity) return 0; // 0 当「关闭」的落盘编码（向后兼容老文件）
  if (v === 0) return 'auto'; // 0 = 自动
  return Number.isFinite(v) ? v : DEFAULT_SETTINGS.contextLimit;
}

/**
 * 把落盘的值解回 normalize 认识的形式。
 * @param {*} raw
 * @returns {*}
 */
function decodeContextLimit(raw) {
  // 老文件里 0 就是「关闭」，别把老配置误读成自动档
  if (raw === 0) return Infinity;
  return raw;
}

export function saveSettings(input) {
  const next = normalize({ ...getSettings(), ...input });
  if (!existsSync(join(config.dataDir, '.state'))) mkdirSync(join(config.dataDir, '.state'), { recursive: true });
  // Infinity 存不进 JSON（会变成 null），落盘时转成 0，读回来 normalize 再解释成 Infinity
  const onDisk = {
    ...next,
    contextLimit: encodeContextLimit(next.contextLimit),
  };
  writeFileSync(FILE, JSON.stringify(onDisk, null, 2), 'utf8');
  return next;
}

/**
 * 现在真正生效的上下文压缩阈值（token）。
 *
 * @param {string} [model] 当前会话用的模型名。传了才能算「自动档」的水位
 *   （不同模型窗口从 32k 到 1M，用同一个数字是荒唐的）。
 *   不传就按认不出来的模型处理，用保守的 FALLBACK_WINDOW。
 *
 * 三种结果：
 *   Infinity  彻底不压缩
 *   0         自动档但没给模型名 —— 调用方自己按 FALLBACK 处理
 *   正数       就是水位
 */
export function effectiveContextLimit(model = '') {
  const s = getSettings();
  // 自动档：按模型窗口算（见 rates.mjs 的 autoLimitFor）
  if (s.contextLimit === 0) return autoLimitFor(model || '');
  if (Number.isFinite(s.contextLimit) && s.contextLimit > 0) return s.contextLimit;
  if (s.contextLimit === Infinity) return Infinity;
  return config.contextLimit;
}

/**
 * 这个会话的压缩设置到底是哪种（给界面显示用）。
 * @param {string} [model]
 * @returns {{mode:'auto'|'fixed'|'off', limit:number|null, window:number}}
 */
export function contextLimitInfo(model = '') {
  const s = getSettings();
  const win = contextWindowOf(model || '');
  if (s.contextLimit === Infinity) return { mode: 'off', limit: null, window: win };
  if (s.contextLimit === 0) return { mode: 'auto', limit: autoLimitFor(model || ''), window: win };
  return { mode: 'fixed', limit: s.contextLimit, window: win };
}

/**
 * 只把「底线」恢复成默认的那几条，别的（安全词、安全词说明）一概不动。
 *
 * 注意：这里不走 saveSettings()。saveSettings 会先 getSettings() 补全字段，
 * 而 getSettings() 在读不到文件时会回落到 DEFAULT_SETTINGS——那样一旦文件正好
 * 读不到（被别的窗口写入 / 内容损坏），主人的安全词就会被默认值冲掉。
 * 所以这里直接读原始 JSON，只替换 bottomLines 一个键；读不到就报错、不写。
 *
 * 旧的那份先存到 .state/bottomlines.backup.md，手滑也能捡回来。
 * @returns {{ settings: object, backup: string|null, changed: boolean }}
 */
export function resetBottomLines() {
  // 主人可能把某版设成过新默认，那就回到主人定的那版
  const defaults = defaultBottomLines();

  // 1) 必须真的读到文件；读不到就报错，绝不拿默认值顶上
  let raw;
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (err) {
    /**
     * 【文件还不存在 ≠ 读不到 —— 2026-11-01 修】
     *
     * 主人从没在设置面板里存过什么都没关系：这时候界面显示的、
     * 实际管着他的，本来就是 defaultBottomLines()，跟「恢复默认」的目标一致。
     * 以前这里一律报 500，于是他点「恢复默认底线」永远是「恢复失败」，
     * 而屏幕上的底线看着又确实是默认那几条 —— 最让人糊涂的一种坏。
     * 现在分清楚：ENOENT 当空文件处理，真读坏（JSON 坏了/权限没了）才报错。
     */
    if (err && err.code === 'ENOENT') {
      raw = {};
    } else {
      const e = new Error('读不到现在的设置文件，为了不误伤安全词，这次不做恢复：' + String(err?.message ?? err));
      e.status = 500;
      throw e;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const e = new Error('设置文件格式不对，为了不误伤安全词，这次不做恢复。');
    e.status = 500;
    throw e;
  }

  // 2) 当前底线（缺字段就当空；没存过就是默认那份）
  const stored = Array.isArray(raw.bottomLines)
    ? normalizeLines(raw.bottomLines)
    : [];
  const current = stored.length ? stored : defaults;
  const same =
    current.length === defaults.length && current.every((l, i) => l === defaults[i]);
  if (same) {
    return { settings: normalize(raw), backup: null, changed: false };
  }

  // 3) 备份旧底线
  if (!existsSync(join(config.dataDir, '.state'))) mkdirSync(join(config.dataDir, '.state'), { recursive: true });
  writeFileSync(
    BACKUP_FILE,
    '# 被替换掉的那版底线\n\n' + current.map((l) => '- ' + l).join('\n') + '\n',
    'utf8',
  );

  // 4) 只替换 bottomLines，其他键原样保留
  const next = { ...raw, bottomLines: [...defaults] };
  writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return { settings: normalize(next), backup: BACKUP_FILE, changed: true };
}

/**
 * 把「当前这版底线」定成新的出厂默认。
 *
 * 主人改完底线之后说「以后就按这版当默认」时走这里：把 lines 写进
 * .state/defaults.json 的 bottomLines 键。之后点「恢复默认底线」回到的就是这一版，
 * 而不是发布物里那几条。
 *
 * 几点讲究：
 *   - 不改代码文件，只写 .state/defaults.json —— 出厂那份还能靠删文件找回。
 *   - 不动 settings.json（当前生效的底线原样留着）。
 *   - 上一份自定义默认先存 .state/bottomlines.default.backup.md，手滑能捡回来。
 *
 * @param {string[]} lines 要当成默认的那几条，空数组直接拒绝
 * @returns {{ bottomLines: string[], backup: string|null, changed: boolean }}
 */
export function setDefaultBottomLines(lines) {
  const list = normalizeLines(lines);
  if (!list.length) {
    const e = new Error('一条底线都没有，不能把它设成默认');
    e.status = 400;
    throw e;
  }
  const prev = readDefaults();
  const oldList = Array.isArray(prev.bottomLines) ? prev.bottomLines : null;
  const same = oldList && oldList.length === list.length && oldList.every((l, i) => l === list[i]);
  if (same) {
    return { bottomLines: oldList, backup: null, changed: false };
  }
  let backup = null;
  if (oldList && oldList.length) {
    ensureStateDir();
    backup = join(config.dataDir, '.state', 'bottomlines.default.backup.md');
    writeFileSync(
      backup,
      '# 被替换掉的那版「默认底线」\n\n' + oldList.map((l) => '- ' + l).join('\n') + '\n',
      'utf8',
    );
  }
  ensureStateDir();
  writeFileSync(DEFAULTS_FILE, JSON.stringify({ ...prev, bottomLines: list }, null, 2), 'utf8');
  return { bottomLines: list, backup, changed: true };
}

/**
 * 【恢复默认·安全词专用 · 2026-11-11 加】
 * 把「现在生效的」安全词 + 说明存成默认（defaults.json 里那两样）。
 *
 * 为什么单开一个：底线的「设为默认」早就有（setDefaultBottomLines），
 * 安全词这边一直没有 —— 界面上的按钮打过去是 405，主人点了没反应。
 * 判定和备份都比照 setDefaultBottomLines：一样就 changed:false 不动文件，
 * 不一样才写，写之前把旧那份存 .state/safewords.default.backup.md。
 *
 * @param {string[]} words 要当成默认的安全词，空数组直接拒绝
 * @param {string} [note] 每个词对应的说明，不传就沿用现在生效的
 */
export function setDefaultSafeWords(words, note) {
  const list = Array.isArray(words) ? words.map((w) => String(w ?? '').trim()).filter(Boolean) : [];
  if (!list.length) {
    const e = new Error('一个安全词都没有，不能把它设成默认');
    e.status = 400;
    throw e;
  }
  for (const w of list) {
    if (looksGarbled(w)) {
      const e = new Error('安全词像乱码（编码坏了），不敢写进默认');
      e.status = 400;
      throw e;
    }
  }
  const noteNow = note === undefined ? defaultSafeWordNote() : String(note ?? '').trim();
  const prev = readDefaults();
  const oldList = Array.isArray(prev.safeWords) ? prev.safeWords : null;
  const oldSame = oldList && oldList.length === list.length && oldList.every((w, i) => w === list[i]);
  const noteSame = (prev.safeWordNote ?? '') === noteNow;
  if (oldSame && noteSame) {
    return { safeWords: oldList, safeWordNote: prev.safeWordNote ?? '', backup: null, changed: false };
  }
  let backup = null;
  if (oldList && oldList.length) {
    ensureStateDir();
    backup = join(config.dataDir, '.state', 'safewords.default.backup.md');
    writeFileSync(backup, '# 被替换掉的那版「默认安全词」\n\n' + oldList.map((w) => '- ' + w).join('\n') + '\n', 'utf8');
  }
  ensureStateDir();
  writeFileSync(DEFAULTS_FILE, JSON.stringify({ ...prev, safeWords: list, safeWordNote: noteNow }, null, 2), 'utf8');
  return { safeWords: list, safeWordNote: noteNow, backup, changed: true };
}

/**
 * 把「现在生效的」底线 + 安全词 + 安全词说明 一起定成默认。
 *
 * 跟 setDefaultBottomLines 的区别：那个只管底线（老接口，保留兼容），
 * 这个三样一起写。主人点「现在这版设成默认」时三样本来就该一起走 ——
 * 只把底线定成默认、安全词还是出厂的，点「恢复默认」出来的是个混搭，
 * 比什么都不设更让人困惑。
 *
 * 三条互相独立判定：哪样跟现在不一样才写哪样，全一样就 changed:false。
 * 写之前把旧的那份存 .state/defaults.backup.md，手滑能捡回来。
 *
 * @param {{bottomLines?: string[], safeWords?: string[], safeWordNote?: string}} input
 * @returns {{ bottomLines: string[], safeWords: string[], safeWordNote: string, backup: string|null, changed: boolean, what: string[] }}
 */
/* 【2026-11-05 严检抓到的坑·中文被编码弄坏成 ?? 也照样写进默认】
 *
 *  经过：我用命令直接 POST /api/settings/defaults 传中文安全词，
 *  请求体没带对编码，服务端收到的是两个问号 —— 它 trim 一下、非空、就写进去了，
 *  结果主人配好的安全词默认值被覆盖。
 *
 *  这里加一道闸：明显是乱码的值直接拒绝，宁可这一步失败，也不许把好数据冲掉。
 */
function looksGarbled(s) {
  const t = String(s ?? "").trim();
  if (!t) return false;
  if (/^[?？]+$/.test(t)) return true;
  if (t.indexOf(String.fromCharCode(0xfffd)) >= 0) return true;
  const q = (t.match(/[?？]/g) || []).length;
  if (t.length >= 2 && q / t.length >= 0.5) return true;
  return false;
}

export function setDefaults(input = {}) {
  const prev = readDefaults();
  const next = { ...prev };
  const what = [];

  // 底线
  if (Array.isArray(input.bottomLines)) {
    const list = normalizeLines(input.bottomLines);
    // 乱码闸：中文被编码弄坏后是「??」这种形状，不许写进去把好数据冲掉
    const badLine = list.find((x) => looksGarbled(x));
    if (badLine) {
      const e = new Error('底线里有一条看着是乱码（' + badLine + '），没写入。请检查编码后重试');
      e.status = 400;
      throw e;
    }
    if (!list.length) {
      const e = new Error('一条底线都没有，不能把它设成默认');
      e.status = 400;
      throw e;
    }
    const old = Array.isArray(prev.bottomLines) ? prev.bottomLines : null;
    const same = old && old.length === list.length && old.every((l, i) => l === list[i]);
    if (!same) {
      next.bottomLines = list;
      what.push('底线');
    }
  }

  // 安全词（去重、去空、保序）
  if (Array.isArray(input.safeWords)) {
    const list = [];
    for (const w of input.safeWords) {
      const s = String(w).trim();
      if (s && !list.includes(s)) list.push(s);
    }
    // 乱码闸：同上。这条就是今天真踩到的那个坑
    const badWord = list.find((x) => looksGarbled(x));
    if (badWord) {
      const e = new Error('安全词里有一个看着是乱码（' + badWord + '），没写入。请检查编码后重试');
      e.status = 400;
      throw e;
    }
    if (!list.length) {
      const e = new Error('一个安全词都没有，不能把它设成默认');
      e.status = 400;
      throw e;
    }
    const old = Array.isArray(prev.safeWords) ? prev.safeWords : null;
    const same = old && old.length === list.length && old.every((w, i) => w === list[i]);
    if (!same) {
      next.safeWords = list;
      what.push('安全词');
    }
  }

  // 安全词说明
  if (typeof input.safeWordNote === 'string') {
    const note = input.safeWordNote.trim();
    if (note !== (prev.safeWordNote || '').trim()) {
      next.safeWordNote = note;
      what.push('安全词说明');
    }
  }

  let backup = null;
  if (what.length) {
    ensureStateDir();
    backup = join(config.dataDir, '.state', 'defaults.backup.md');
    const dump = [
      '# 被替换掉的那版默认（底线 / 安全词 / 说明）',
      '',
      '## 底线',
      ...(Array.isArray(prev.bottomLines) ? prev.bottomLines.map((l) => '- ' + l) : ['（没设过）']),
      '',
      '## 安全词',
      ...(Array.isArray(prev.safeWords) ? prev.safeWords.map((w) => '- ' + w) : ['（没设过）']),
      '',
      '## 安全词说明',
      prev.safeWordNote || '（没设过）',
      '',
    ].join('\n');
    try {
      writeFileSync(backup, dump, 'utf8');
    } catch {
      backup = null;
    }
    writeFileSync(DEFAULTS_FILE, JSON.stringify(next, null, 2), 'utf8');
  }

  return {
    bottomLines: Array.isArray(next.bottomLines) ? next.bottomLines : [...DEFAULT_SETTINGS.bottomLines],
    safeWords: Array.isArray(next.safeWords) ? next.safeWords : [...DEFAULT_SETTINGS.safeWords],
    safeWordNote: typeof next.safeWordNote === 'string' ? next.safeWordNote : DEFAULT_SETTINGS.safeWordNote,
    backup,
    changed: what.length > 0,
    what,
  };
}

/**
 * 只把「安全词 + 触发说明」恢复成默认，底线一概不动。
 *
 * 和 resetBottomLines 一样不走 saveSettings()：saveSettings 会先 getSettings() 补字段，
 * 文件读不到时会回落到 DEFAULT_SETTINGS，把主人的底线一起冲掉。
 * 所以这里直接读原始 JSON，只替换 safeWords / safeWordNote 两个键；读不到就报错、不写。
 *
 * 旧的那份先存到 .state/safewords.backup.md。
 * @returns {{ settings: object, backup: string|null, changed: boolean }}
 */
export function resetSafeWords() {
  // 必须用 defaultSafeWords() / defaultSafeWordNote()，不能直接拿 DEFAULT_SETTINGS ——
  // 那是出厂常量（含「停下」）。主人把改过的安全词设成默认之后，「恢复默认」就该回到
  // 他自己定那版，而不是回去把出厂那套原样端上来。
  const defaults = defaultSafeWords();
  const defaultNote = defaultSafeWordNote();

  let raw;
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (err) {
    const e = new Error('读不到现在的设置文件，为了不误伤底线，这次不做恢复：' + String(err?.message ?? err));
    e.status = 500;
    throw e;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const e = new Error('设置文件格式不对，为了不误伤底线，这次不做恢复。');
    e.status = 500;
    throw e;
  }

  const curWords = normalizeLines(raw.safeWords);
  const curNote = typeof raw.safeWordNote === 'string' ? raw.safeWordNote.trim() : '';

  const same =
    curWords.length === defaults.length &&
    curWords.every((w, i) => w === defaults[i]) &&
    curNote === defaultNote;
  if (same) {
    return { settings: normalize(raw), backup: null, changed: false };
  }

  if (!existsSync(join(config.dataDir, '.state'))) mkdirSync(join(config.dataDir, '.state'), { recursive: true });
  writeFileSync(
    SAFE_BACKUP_FILE,
    '# 被替换掉的那版安全词\n\n' +
      (curWords.length ? curWords.map((w) => '- ' + w).join('\n') : '(当时是空的)') +
      '\n\n## 触发后要她怎么做\n\n' +
      (curNote || '(当时是空的)') +
      '\n',
    'utf8',
  );

  const next = { ...raw, safeWords: [...defaults], safeWordNote: defaultNote };
  writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return { settings: normalize(next), backup: SAFE_BACKUP_FILE, changed: true };
}

/**
 * 【恢复出厂默认底线 —— 2026-11-11 加】
 *
 * 和 resetBottomLines() 不是一回事：那个回的是「主人自己设的默认」（defaults.json），
 * 这个回的是**写死在代码里的出厂那份**（DEFAULT_SETTINGS）。
 *
 * 以前没有这个函数，前端那颗「恢复出厂默认底线」按钮借用的就是 reset-bottomlines，
 * 于是它跟「恢复默认」干的是同一件事，主人怎么点都看不出区别 —— 这就是那个 bug。
 */
export function resetBottomLinesToFactory() {
  const factory = [...DEFAULT_SETTINGS.bottomLines];

  let raw;
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      raw = {};
    } else {
      const e = new Error('读不到现在的设置文件，为了不误伤底线，这次不做恢复：' + String(err?.message ?? err));
      e.status = 500;
      throw e;
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const e = new Error('设置文件格式不对，为了不误伤底线，这次不做恢复。');
    e.status = 500;
    throw e;
  }

  /* 【判据用「当前生效值」而不是文件里的原始字段】
   * 干净安装时 settings.json 根本不存在，raw 是 {} —— 照 raw 比会得到「空 != 出厂」，
   * 于是第一次点就说「已恢复」，还白写一份备份。用 getSettings() 拿到的是**实际生效**那套
   * （没有文件就回出厂），跟主人眼前看到的完全一致。 */
  const cur = normalizeLines(getSettings().bottomLines);
  const same = cur.length === factory.length && cur.every((x, i) => x === factory[i]);
  if (same) {
    return { settings: normalize(raw), backup: null, changed: false, factory: true };
  }

  ensureStateDir();
  const backup = join(config.dataDir, '.state', 'bottomlines.factory.backup.md');
  try {
    writeFileSync(backup, ['# 点「恢复出厂默认底线」之前那版（' + new Date().toISOString() + '）', '', ...cur.map((x) => '- ' + x), ''].join('\n'), 'utf8');
  } catch {
    /* 备份失败不挡主流程 */
  }

  raw = { ...raw, bottomLines: factory };
  writeFileSync(FILE, JSON.stringify(raw, null, 2), 'utf8');
  return { settings: normalize(raw), backup, changed: true, factory: true };
}

/**
 * 【恢复出厂默认安全词 —— 2026-11-11 加】同理，回的是 DEFAULT_SETTINGS 那份。
 */
export function resetSafeWordsToFactory() {
  const factory = [...DEFAULT_SETTINGS.safeWords];
  const extra = String(DEFAULT_SETTINGS.safeWordNote || '').trim();

  let raw;
  try {
    raw = JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (err) {
    const e = new Error('读不到现在的设置文件，为了不误伤底线，这次不做恢复：' + String(err?.message ?? err));
    e.status = 500;
    throw e;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    const e = new Error('设置文件格式不对，为了不误伤底线，这次不做恢复。');
    e.status = 500;
    throw e;
  }

  /* 同底线：用「当前生效值」比（干净安装时文件不存在，raw 是 {}，照 raw 比会误报「已恢复」） */
  const curWords = normalizeLines(getSettings().safeWords);
  const curNote = String(getSettings().safeWordNote || '').trim();
  const same = curWords.length === factory.length && curWords.every((w, i) => w === factory[i]) && curNote === extra;
  if (same) {
    return { settings: normalize(raw), backup: null, changed: false, factory: true };
  }

  ensureStateDir();
  const backup = join(config.dataDir, '.state', 'safewords.factory.backup.md');
  try {
    writeFileSync(backup, ['# 点「恢复出厂默认安全词」之前那版（' + new Date().toISOString() + '）', '', '安全词：' + curWords.join('、'), '', curNote, ''].join('\n'), 'utf8');
  } catch {
    /* 备份失败不挡主流程 */
  }

  raw = { ...raw, safeWords: factory, safeWordNote: extra };
  writeFileSync(FILE, JSON.stringify(raw, null, 2), 'utf8');
  return { settings: normalize(raw), backup, changed: true, factory: true };
}

/** Render the 底线 + 安全词 blocks for the system prompt. */
export function settingsPromptBlock(settings = getSettings()) {
  const lines = [];
  if (settings.bottomLines.length) {
    lines.push('【说话规矩 · 任何时候都按这个来】');
    for (const l of settings.bottomLines) lines.push(`- ${l}`);
  }
  if (settings.safeWords.length) {
    lines.push('');
    lines.push('【主人说这几个词的时候，换一种说话方式】');
    const notes = splitSafeWordNotes(settings.safeWordNote, settings.safeWords.length);
    settings.safeWords.forEach((w, i) => {
      const note = notes[i] || notes[0] || '';
      lines.push(note ? `- 听到「${w}」-> ${note}` : `- 听到「${w}」-> 一句话说清重点，不用语气词。`);
    });
    lines.push('- 这几个词只在主人原话里出现时才算，你不要主动提，也别拿来开玩笑。');
  }
  return lines.join('\n');
}

/**
 * 中文 / 全角标点 → 英文半角。
 *
 * 为什么只换标点不换汉字：安全词是主人手打的短词（停下 / 停止 / 命令 / 人设），
 * 打「停下/停止」时输入法常常把斜杠打成全角「／」，还可能顺带打出全角逗号、
 * 引号、括号、冒号。这些在程序里都是「不同的字符」，会让拆分失败、
 * 也会让「这句里有没有这个安全词」的判断对不上。汉字本身不换 ——
 * 换了就成乱码了。
 */
const FULLWIDTH_MAP = new Map([
  ['，', ','], ['。', '.'], ['、', ','], ['；', ';'], ['：', ':'],
  ['？', '?'], ['！', '!'], ['（', '('], ['）', ')'], ['【', '['], ['】', ']'],
  ['「', '"'], ['」', '"'], ['『', '"'], ['』', '"'], ['《', '<'], ['》', '>'],
  ['“', '"'], ['”', '"'], ['‘', "'"], ['’', "'"],
  ['～', '~'], ['　', ' '], ['－', '-'], ['—', '-'], ['｀', '`'],
]);

export function toAsciiPunct(text) {
  let out = '';
  for (const ch of String(text ?? '')) {
    if (ch === '／') { out += '/'; continue; }   // 全角斜杠单独拿出来，最常用
    const hit = FULLWIDTH_MAP.get(ch);
    out += hit === undefined ? ch : hit;
  }
  return out;
}

/** Does this user message hit a safe word? */
export function matchSafeWord(text, settings = getSettings()) {
  if (!text) return null;
  // 两边都先换成半角标点：主人手打「停下」用的是中文输入法，标点常常是全角的，
  // 安全词要是设成了英文（如 stop），全角字符会让 includes 对不上。
  const lower = toAsciiPunct(String(text)).toLowerCase();
  /**
   * 【最后说出的算 —— 2026-11-13 主人改】
   *
   * 一句话里同时命中多个安全词，取出现位置最靠后的那个（= 最后说出的）。
   * 例：「人设，然后停止」→ 停在「停止」档；「停止，回人设」→ 回「人设」。
   * 同一个词出现多次，取它最后一次出现的位置。
   */
  const words = [...settings.safeWords];
  let best = null;
  let bestAt = -1;
  for (const w of words) {
    const word = toAsciiPunct(String(w ?? '')).trim().toLowerCase();
    if (!word) continue;
    const at = lower.lastIndexOf(word);
    if (at > bestAt) { bestAt = at; best = w; }
  }
  if (best !== null) return best;
  return null;
}
