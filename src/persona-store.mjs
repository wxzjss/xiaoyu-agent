// Persona store：多套人设，一套一个文件，外加「当前用哪套」。
//
// 存法（都放 .state/）：
//   .state/personas/<id>.md     一套人设一个文件，文件名就是 id
//   .state/personas.json        { current: '<id>', list: [{id, name, builtin, updatedAt}] }
//
// 「默认人设」是内置的，永远存在、不许删；它的内容来自 persona/xiaoyu.md（发布物自带的），
// 主人把它改了也只会写到 personas/default.md，原来那份发布文件一个字都不碰。
//
// 旧数据怎么接：以前只有 .state/persona.md 一个文件。第一次读的时候如果见到它、
// 又没有 personas.json，就自动搬成「我的旧人设」这一套，并设成当前用的，
// 旧文件原样留着不删（万一搬错了还能捞回来）。
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';
// 【2026-11-01】人设按会话：谁在哪个会话里用了哪一套，记在 persona-session.mjs
import { sessionPersonaId, setSessionPersona } from './persona-session.mjs';

const STATE_DIR = join(config.dataDir, '.state');
/** 小鲸那份出厂人设模板放在源码 src/ 下，跟小鱼的 persona/xiaoyu.md 各管各的 */
const WHALE_DEFAULT_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * 按智能体分·2026-10-30
 * 谁的哪套人设 —— '' 是主人自己（小鱼），其他是智能体 id。
 * 小鱼继续用老地方，旧数据一个字节都不用搬。
 */
let _scope = '';

/** 只许字母数字下划线横线，防止拼出 ../ */
function scopeOk(x) {
  return typeof x === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(x);
}

/** 临时切到某个智能体的人设库干活，干完切回来（同步函数用） */
/** 小鱼的几个别名 —— 它们都该落在主库，不该另开一个库 */
const FISH_SCOPES = new Set(['xiaoyu', 'fish', 'xiaoyu-qq']);

export function withPersonaScope(scope, fn) {
  const prev = _scope;
  let s = scopeOk(scope) ? String(scope || '') : '';
  /* 【2026-11-03 主人报的大 bug】「点小鱼的【恢复出厂默认】后变成小鲸的人设了」
   *
   * 真凶：界面那条路把 scope 传成 'xiaoyu'，而小鱼的人设一直住在【主库】
   * （状态目录下的 personas.json + personas/*.md，scope 为空）。
   * 传了 'xiaoyu' 就等于另开一个空库 personas/xiaoyu.json（current:"", list:[]），
   * 里面一套人设都没有 → 一路兜底 → 兜到小鲸那份。主人眼前就"变成小鲸"了。
   *
   * 这里把小鱼的所有别名都折回空 scope：她永远只在主库。 */
  if (FISH_SCOPES.has(s)) s = '';
  _scope = s;
  try {
    return fn();
  } finally {
    _scope = prev;
  }
}

/** 当前 scope（调试用） */
export function personaScope() {
  return _scope;
}

function pDir() {
  return _scope ? join(STATE_DIR, 'personas', _scope) : join(STATE_DIR, 'personas');
}

function indexFile() {
  return _scope ? join(STATE_DIR, 'personas', _scope + '.json') : join(STATE_DIR, 'personas.json');
}

function baseFile() {
  /* 按谁的人设库取出厂模板·2026-10-30
   * 小鲸以前借的是小鱼的 persona/xiaoyu.md，所以她那栏「默认人设」一点开满屏是小鱼的口吻。
   * 现在各用各的：小鲸 → src/whale-default-persona.md，小鱼 → persona/xiaoyu.md。
   *
   * 【2026-11-03 主人报的大 bug】「点小鱼的【恢复出厂默认】后变成小鲸的人设了」
   *
   * 真凶就在下面这一行：原来写的是 if (_scope)，只要进了任何一个智能体的作用域
   * 就返回小鲸那份。可小鱼自己也是会进作用域的（/api/agents/persona/reset 传 scope=xiaoyu，
   * 或者界面上任何一次 withPersonaScope），于是小鱼一"恢复出厂"，读到的是小鲸。
   *
   * 改成只认小鲸自己的 scope。别的智能体各自读自己的目录（见 factoryPersonaOf /
   * textOf 那几条），小鱼读发布物 persona/xiaoyu.md。 */
  if (_scope === 'whale') {
    const whaleDef = join(WHALE_DEFAULT_DIR, 'whale-default-persona.md');
    if (existsSync(whaleDef)) return whaleDef;
  }
  /* 【2026-11-03】别的自建智能体不该借小鱼的发布物当出厂。
   * 它们自己的出厂在 personas/<id>/defaults.json.persona 或 .factory.json（见 agents.mjs 的
   * factoryPersonaOf）。这里返回小鱼那份会让"恢复出厂默认"把别人的脸换成小鱼。
   * 找不到自己的文件时返回空串 —— 上层再兜，总比给错人强。 */
  if (_scope) return '';
  return join(config.root, 'persona', 'xiaoyu.md');
}

const LEGACY_FILE = join(STATE_DIR, 'persona.md');
const LEGACY_BACKUP = join(STATE_DIR, 'persona.backup.md');

/**
 * 主人自定义的「默认值」存这儿，跟 settings.mjs 用的是同一个文件。
 *
 * 目前两个键：
 *   bottomLines  这个项目里的一套底线（见 settings.mjs 的 setDefaultBottomLines）
 *   persona      这个项目里的一套人设正文（见本文件的 setPersonaAsBuiltinDefault）
 * 为什么不直接改 persona/xiaoyu.md：那是发布物，改了下次更新就被覆盖，
 * 而且主人想「回到原厂」时就没得回了。
 */
const DEFAULTS_FILE = join(STATE_DIR, 'defaults.json');

/**
 * 默认人设也是「谁有谁的」·2026-10-30
 * 主人报：「在小鲸的多套人设里，默认人设是小鱼」。
 * 原来 DEFAULTS_FILE 全局就一份（.state/defaults.json，主人定过的小鱼版 973 字），
 * 小鲸也跟着读那一份 → 她那边「默认人设」永远是小鱼。
 * 现在：小鱼留老地方（旧数据一字节不搬），小鲸单独一份在自己的库里。
 */
function defaultsFile() {
  const s = personaScope();
  return s ? join(pDir(), 'defaults.json') : DEFAULTS_FILE;
}

/** 读主人自定义的默认值；没有 / 坏了都当空对象 */
function readDefaults() {
  try {
    const raw = JSON.parse(readFileSync(defaultsFile(), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/* ============================================================
 * 每套人设「自己的默认」·2026-11-03 主人拍板
 *
 * 主人原话：「那就不搞默认人设了，删掉默认人设，改为每个人设预设都可以
 *   为自己这个预设设置默认并恢复自己这个预设的默认人设。」
 * 「把默认人设改为智能体自己的名字。」
 *
 * 以前：全局只有一份 .state/defaults.json.persona，谁点「设为默认」都写那一条，
 *      于是小鲸点一下就把小鱼的覆盖了；自建卡更惨，读到的是别人的脸。
 * 现在：每套套人设自己有 defaults/<套 id>.json。
 *      「设为默认」= 把当前正文抄进这套自己的默认；
 *      「恢复默认」= 从这套自己的默认抄回来。
 *      互不影响，谁也不会变成别人。
 * ============================================================ */

/** 每套人设自己的默认放在 personas/<库>/defaults/<套 id>.json */
function ownDefaultsDir() {
  return join(pDir(), 'defaults');
}
function ownDefaultFile(id) {
  return join(ownDefaultsDir(), String(id || '') + '.json');
}

/** 这套自己的默认正文；没设过就 '' */
export function ownDefaultOf(id) {
  const key = String(id || '');
  if (!key || !isPersonaId(key)) return '';
  try {
    const j = JSON.parse(readFileSync(ownDefaultFile(key), 'utf8'));
    return String((j && j.persona) || '').trim();
  } catch {
    return '';
  }
}

/** 把正文定成「这套自己的默认」 */
export function setOwnDefaultOf(id, text) {
  const key = String(id || '');
  const body = String(text || '').trim();
  if (!key || !isPersonaId(key) || !body) return false;
  try {
    ensureDirs();
    mkdirSync(ownDefaultsDir(), { recursive: true });
    writeFileSync(ownDefaultFile(key), JSON.stringify({ persona: body, at: Date.now() }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 这套有没有自己的默认 */
export function hasOwnDefault(id) {
  return ownDefaultOf(id).length > 0;
}

const DEFAULT_ID = 'default';
const DEFAULT_NAME = '默认人设';
const MAX_NAME = 40;
const MAX_TEXT = 200_000;

function readFileSafe(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function ensureDirs() {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  const d = pDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
}

/** 发布物自带的那份人设原文
 *
 * 【2026-11-03 修】自建卡的库里没有「发布物」这个概念（她的人设是主人建卡时写的），
 * baseFile() 在那种库会返回空串 —— 老代码直接 throw，整张卡的面板就白屏。
 * 现在：找不到就当空串，让上层自己的兜底去拿（ownDefaultOf / 建卡正文）。
 */
export function readBasePersona() {
  const f = baseFile();
  if (!f) return '';
  const text = readFileSafe(f);
  if (text === null) return '';
  return text.trim();
}

/** id 只许字母数字下划线横线，免得拼出 ../ 之类的东西 */
function isPersonaId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function fileFor(id) {
  return join(pDir(), `${id}.md`);
}

function cleanName(n) {
  return String(n ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function cleanText(t) {
  const s = String(t ?? '').replace(/\r\n/g, '\n').trim();
  if (!s) {
    const e = new Error('人设内容不能为空');
    e.status = 400;
    throw e;
  }
  if (s.length > MAX_TEXT) {
    const e = new Error(`人设太长（${s.length} 字），最多 ${MAX_TEXT} 字`);
    e.status = 400;
    throw e;
  }
  return s;
}

function newId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function readIndex() {
  const raw = readFileSafe(indexFile());
  if (raw === null) return null;
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return null;
    const list = Array.isArray(j.list) ? j.list.filter((x) => x && isPersonaId(x.id)) : [];
    return { current: isPersonaId(j.current) ? j.current : DEFAULT_ID, list };
  } catch {
    return null;
  }
}

function writeIndex(idx) {
  ensureDirs();
  writeFileSync(indexFile(), JSON.stringify(idx, null, 2), 'utf8');
}

/**
 * 第一次用的时候把索引建起来：内置默认人设 + （有旧文件的话）搬一份成「我的旧人设」。
 * 只在索引文件不存在时跑一次。
 */
function ensureIndex() {
  const existing = readIndex();
  if (existing) return existing;

  ensureDirs();
  /* 【2026-11-03 主人拍板】「那就不搞默认人设了，删掉默认人设，
   *   改为每个人设预设都可以为自己这个预设设置默认并恢复自己这个预设的默认人设。」
   * 「把默认人设改为智能体自己的名字。」
   *
   * 所以新库空着建：不再塞一个叫「默认人设」的特殊槽。
   * 第一套由建卡那边按智能体名字建（addAgent → createPersona({ name })），
   * 主库那边是「小鱼」，小鲸那边是「小鲸」。
   *
   * 每套自己的「默认正文」存在 defaults/<套 id>.json，互不覆盖 ——
   * 见 setPersonaAsOwnDefault / resetPersona。 */
  const idx = { current: '', list: [] };

  // 旧版单文件人设：只搬给主库（小鱼自己），别人的库里不该有
  const legacy = personaScope() ? '' : readFileSafe(LEGACY_FILE);
  if (legacy && legacy.trim()) {
    try {
      writeFileSync(fileFor('legacy'), legacy.trim() + '\n', 'utf8');
      idx.list.push({ id: 'legacy', name: '我的旧人设', builtin: false, updatedAt: Date.now() });
      idx.current = 'legacy';
    } catch { /* 搬不动就算了 */ }
  }

  /* 【2026-11-03 换电脑修】「换电脑」严检查出来的：
   * 新库这里原来就交个空 list 出去，而全项目没有任何代码去建「主库那套小鱼」，
   * 于是 saveAgentPersona('xiaoyu') / resetAgentPersona('xiaoyu') 在全新机器上一律
   * 「没有这套人设」404 —— 换台电脑第一次改人设就撞墙。
   * 现在：新库的第一套就叫这个智能体自己的名字（主库小鱼 / 小鲸库小鲸 / 自建卡库卡名），
   * 正文走 textOf 的兜底，不需要这里写文件。 */
  if (!idx.list.length) {
    idx.list.push({ id: DEFAULT_ID, name: firstSetName(), builtin: true, updatedAt: Date.now() });
    idx.current = DEFAULT_ID;
  }

  writeIndex(idx);
  return idx;
}


/** 新库第一套叫什么名字（换电脑严检：名字取自这个智能体自己） */
function firstSetName() {
  const sc = personaScope();
  if (!sc) return '小鱼';
  if (sc === 'whale') return '小鲸';
  try {
    const j = JSON.parse(readFileSync(join(STATE_DIR, 'agents.json'), 'utf8'));
    const list = Array.isArray(j && j.customs) ? j.customs : [];
    const hit = list.find((a) => a && String(a.id) === sc);
    const nm = hit && String(hit.name || '').trim();
    if (nm) return nm;
  } catch { /* 读不出来就用下面的兜底 */ }
  return '人设';
}


/** 某一套的正文：内置且没改过 -> 发布物那份；否则读文件 */
function textOf(id) {
  const key = String(id || '');
  const own = readFileSafe(fileFor(key));
  if (own !== null && own.trim()) return own.trim();

  /* 【2026-11-03 主人拍板：不搞特殊的「默认人设」了，每套各自有默认】
   * 一套人设「没自己的文件」时，先看它自己有没有存过默认（defaults/<套 id>.json）；
   * 存过就用它 —— 这是主人点「设为默认」定下来的那份，只属于这套。
   */
  const selfDef = ownDefaultOf(key);
  if (selfDef) return selfDef;

  /* 还没定过默认：只有主库的 default 才回落到全局出厂（那是小鱼本身）。
   * 自建卡一律不许借别人的 —— 以前它借到的是小鲸那 1891 字，脸都串了。 */
  /* 【2026-11-03 换电脑修】 小鲸库的 default 以前也返回空串（只给主库回落），换台电脑小鲸的人设就是空的。
   * 改成：default 一律先问 baseFile()（主库=persona/xiaoyu.md，小鲸库=whale-default-persona.md），
   * 拿不到再回落到为你那套存过的出厂值。自建卡库 baseFile() 是空串，不会借别人的脸。 */
  if (key === DEFAULT_ID) {
    const base = readBasePersona();
    if (base && String(base).trim()) return String(base).trim();
    return builtinPersonaText();
  }
  return '';
}

function brief(id, meta) {
  const t = textOf(id);
  return {
    id,
    name: meta.name || (id === DEFAULT_ID ? DEFAULT_NAME : id),
    builtin: Boolean(meta.builtin) || id === DEFAULT_ID,
    // 官方预设铺进来的那几套（2026-11-04）。界面靠它区分「我自己的」和「出厂带的」，
    // 也别让它们被当成内置那套（内置不许删，预设可以删）。
    preset: meta.preset === true,
    updatedAt: Number(meta.updatedAt) || 0,
    chars: t.length,
    preview: t.replace(/\s+/g, ' ').slice(0, 60),
  };
}

/**
 * 设置面板要的全部信息。
 *
 * 【2026-11-01 加 sessionId】传了就看「这个会话用的是哪套」，不传就是老行为（全局那套）。
 * 会话记过的那套要是已经被删了，就当没记过、回落到全局 —— 不让会话卡在半空。
 */
export function personaInfo(sessionId = '') {
  try { ensurePresets(); } catch {}
  const idx = ensureIndex();
  const list = idx.list.map((p) => brief(p.id, p));
  let current = list.some((p) => p.id === idx.current) ? idx.current : DEFAULT_ID;
  const _psid = String(sessionId || '').trim();
  if (_psid) {
    try {
      const _ov = sessionPersonaId(_scope, _psid);
      if (_ov && list.some((p) => p.id === _ov)) current = _ov;
    } catch { /* 读不出来就用全局那套 */ }
  }
  const curMeta = idx.list.find((p) => p.id === current) || { id: DEFAULT_ID, name: DEFAULT_NAME, builtin: true };
  const text = textOf(current);
  const isDefault = current === DEFAULT_ID;
  // 「改过没有」：内置那套看有没有自己的文件；其他那套基本都算改过
  const touched = existsSync(fileFor(current));
  return {
    text,
    // base = 「出厂默认」那份：主人定过就用主人定的，没定过才是发布物那份
    base: builtinPersonaText(),
    // 出厂那份的原始正文（真·原厂），给「连出厂的也看」这类场景用
    factory: readBasePersona(),
    custom: isDefault ? touched : true,
    path: existsSync(fileFor(current)) ? fileFor(current) : baseFile(),
    current,
    currentName: curMeta.name || DEFAULT_NAME,
    list,
  };
}

/**
 * 切到另一套。
 *
 * 【2026-11-01 主人：「让多套人设里的人设按会话来，而不是全局切换」】
 * 传了 sessionId 就**只改这个会话**，库的全局 current 一个字都不动 ——
 * 于是它退回「新会话的起点」这个身份：A 会话换成 QQ 版人设，B 会话照旧是默认。
 *
 * 不传 sessionId 时保持老行为（改全局那套），命令行和测试还在用它。
 */
export function switchPersona(id, sessionId = '') {
  const idx = ensureIndex();
  if (!isPersonaId(id) || !idx.list.some((p) => p.id === id)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const _ssid = String(sessionId || '').trim();
  if (_ssid) {
    setSessionPersona(_scope, _ssid, id);
    return personaInfo(_ssid);
  }
  idx.current = id;
  writeIndex(idx);
  return personaInfo();
}

/** 新建一套：可以给个起点（默认拿当前这套复制，也可以给空/给正文） */
export function createPersona({ name, text, copyCurrent = true } = {}) {
  const idx = ensureIndex();
  const id = newId();
  const body = typeof text === 'string' && text.trim()
    ? cleanText(text)
    : (copyCurrent ? textOf(idx.current) : '');
  /* 【2026-11-03 主人报】「新建人设只能填个名字然后自动退出」——
   * 除了前端没问正文，这里也有份：正文为空就直接 400，主人想先起个名字、
   * 稍后再填都做不到。改成：空的就落一份最小骨架，至少这套能被选中、能编辑。 */
  const finalBody = body || ('# ' + (cleanName(name) || '新人设') + '\n\n（这套还没写正文，点下面的框直接写）');
  ensureDirs();
  writeFileSync(fileFor(id), finalBody + '\n', 'utf8');
  /* 【2026-11-03 主人报的】新建一套后点「恢复默认」→ 正文被删光 → 再点这套一片空白。
   *
   * 真凶：createPersona 只写正文、不写这套自己的默认。于是「恢复默认」走进
   * else 分支 rmSync 把文件删了，而 textOf 既没文件也没默认 → 返回空串。
   *
   * 修：建的时候就把正文同时定成它自己的默认。这样「恢复默认」永远有东西可回，
   * 也符合主人的直觉 —— 我刚建好这套时它长什么样，就是它的默认。 */
  try { setOwnDefaultOf(id, finalBody); } catch { /* 默认写不进去也不该挡住建套 */ }
  const meta = { id, name: cleanName(name) || '新人设', builtin: false, updatedAt: Date.now() };
  idx.list.push(meta);
  /* 【2026-11-03 主人报】「新建人设填了名字和正文，结果还是原来那套」
   *
   * 真凶：这里只 push 进 list，没把 current 切到新 id。
   * 于是 createPersona 返回的 personaInfo() 还是旧那套 —— 界面显示旧名字、
   * 随后 savePersonaText(undefined) 也会存到旧那套上，主人白填。
   *
   * 建完就停在新套上，这才是「新建」该有的样子。 */
  idx.current = id;
  writeIndex(idx);
  return { ...personaInfo(), created: id };
}

/** 存某一套的正文（不传 id 就存当前这套） */
export function savePersonaText(id, text) {
  const idx = ensureIndex();
  const target = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === target)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const clean = cleanText(text);
  ensureDirs();
  writeFileSync(fileFor(target), clean + '\n', 'utf8');
  const meta = idx.list.find((p) => p.id === target);
  meta.updatedAt = Date.now();
  writeIndex(idx);
  return personaInfo();
}

/**
 * 改某一套人设的名字（id 不动，只改显示名）。
 *
 * 【2026-11-03 补回】这个函数之前被我重写 setPersonaAsDefault 时整块吃掉了，
 * server.mjs 第 114 行 import 它 → 整个服务起不来（check-compress / check-deleted 两个回归挂掉）。
 * 行为跟原来一致：找不到这套就 404；名字清洗后为空就落回「人设」。
 */
export function renamePersona(id, name) {
  const idx = ensureIndex();
  const target = id && isPersonaId(id) ? id : idx.current;
  const meta = idx.list.find((p) => p.id === target);
  if (!meta) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const next = cleanName(name);
  if (!next) {
    const e = new Error('名字不能是空的');
    e.status = 400;
    throw e;
  }
  meta.name = next;
  meta.updatedAt = Date.now();
  writeIndex(idx);
  return personaInfo();
}

/**
 * 把当前正在用的这套人设存成「默认人设」（内置那套，id = default）。
 *
 * 主人的意思很直白：现在用的这套就是我要的默认，以后点「恢复自带人设」要回到这套。
 * 所以把当前正文原样写进 personas/default.md，再把当前切到 default。
 * 原来那套不自删，留着随时能切回去。
 *
 * 注意：发布物里的 persona/xiaoyu.md **一个字都不碰** —— 那是出厂备份。
 * @param {string} [id] 要存成默认的那套，不传就存当前用的
 * @returns {{ persona: object, from: string, changed: boolean }}
 */
export function setPersonaAsDefault(id) {
  const idx = ensureIndex();
  const from = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === from)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }

  /* 【2026-11-03 主人拍板：每套各管各的默认】
   *
   * 老实现是「把正文抄进 default 那一套」—— 一份全局的，谁点谁覆盖谁。
   * 主人点小鱼、人设栏变出小鲸，就是这条链当年留下的坑。
   *
   * 现在跟 setPersonaAsBuiltinDefault 完全一致：
   * 写 personas/<库>/defaults/<这套 id>.json，只属于这套自己。
   */
  const body = cleanText(textOf(from));
  if (!body) {
    const e = new Error('这套人设是空的，没东西可以设成默认');
    e.status = 400;
    throw e;
  }

  /* 【2026-11-03 补的保险】把当前正文设成这套自己的默认。
   *
   * 踩过的坑：先在编辑框里把正文改烂（比如只剩 4 个字），再点「设为默认」，
   * 那 4 个字就成了这套的默认 —— 以后「恢复默认」回来的就是这个垃圾。
   * 所以：① 太短的正文拒收；② 旧默认一定先备份到这套自己的目录里，别只存一份全局的。
   */
  const MIN_OWN_DEFAULT = 1;
  if (body.length < MIN_OWN_DEFAULT) {
    const e = new Error('这套人设是空的，不设成默认');
    e.status = 400;
    throw e;
  }

  const prev = ownDefaultOf(from);
  if (prev && prev !== body) {
    try {
      const bdir = join(pDir(), 'defaults');
      mkdirSync(bdir, { recursive: true });
      writeFileSync(join(bdir, from + '.bak-' + Date.now() + '.json'), JSON.stringify({ persona: prev, at: Date.now() }, null, 2), 'utf8');
    } catch { /* 备份失败不挡主流程 */ }
  }

  const ok = setOwnDefaultOf(from, body);
  if (!ok) {
    const e = new Error('存不下这次默认（写文件失败）');
    e.status = 500;
    throw e;
  }

  const meta = idx.list.find((p) => p.id === from);
  if (meta) { meta.updatedAt = Date.now(); writeIndex(idx); }

  return { persona: personaInfo(), from, changed: true, own: true, chars: body.length };
}

export function deletePersona(id) {
  const idx = ensureIndex();
  if (id === DEFAULT_ID) {
    const e = new Error('默认人设删不掉');
    e.status = 400;
    throw e;
  }
  const at = idx.list.findIndex((p) => p.id === id);
  if (at < 0) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  // 删之前先留一份，别让人后悔
  const body = readFileSafe(fileFor(id));
  if (body !== null) {
    try {
      ensureDirs();
      writeFileSync(join(STATE_DIR, `persona.deleted.${id}.md`), body, 'utf8');
    } catch {}
  }
  rmSync(fileFor(id), { force: true });
  idx.list.splice(at, 1);
  if (idx.current === id) idx.current = DEFAULT_ID;
  /* 【2026-11-03 换电脑修】 删掉的要是出厂预设，立刻记进账本 —— 否则下次启动 ensurePresets 又铺回来，
   * 主人就会觉得「删了也删不掉」。 */
  try {
    if (PERSONA_PRESETS.some((p) => p.id === id)) {
      const made = readPresetLedger();
      if (!made.includes(id)) { made.push(id); writePresetLedger(made); }
    }
  } catch { /* 记不上就下次再删一遍 */ }
  writeIndex(idx);
  return personaInfo();
}

/** 把某一套恢复成默认内容（内置那套 = 回到发布物那份） */
export function resetPersona(id) {
  const idx = ensureIndex();
  const target = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === target)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const own = readFileSafe(fileFor(target));
  if (own && own.trim()) {
    try {
      ensureDirs();
      writeFileSync(LEGACY_BACKUP, own, 'utf8');
    } catch {}
  }
  /* 【2026-11-03 主人拍板】「恢复默认」= 恢复成这套自己的默认。
   *
   * 以前是 rmSync 删文件，再靠 textOf 的兜底去「找默认」——
   * 兜底一不留神就找到别人头上（主人点小鱼、人设栏变出小鲸，就是这么来的）。
   *
   * 现在：这套自己存过默认 → 抄回默认给它；
   *       没存过 → 才删文件走兜底（等于回到「还没改过」的状态）。
   */
  /* 【2026-11-03 主人报的第二个 bug】
   *
   * 「在【测试】预设里把内容改为1112后设为默认，然后点恢复默认，
   *   然后点一下名叫【测试】的人设预设后显示的人设内容空白了」
   *
   * 真凶：这一套自己没存过默认 → 走 else → rmSync 把正文删了。
   * 删完 textOf 既没文件、也没自己的默认 → 返回空串 → 界面一片空白。
   *
   * 老注释说「没存过就删文件，等于回到还没改过」——听起来对，但「还没改过」
   * 对自建套来说就是「什么都没有」，一删就真的没了。
   *
   * 现在：没存过默认就不许删。正文还在，就把它本身补记成默认（这是唯一能确定
   * 「主人当时要的就是这个」的来源）；连正文都没有，才删。 */
  /* 【2026-11-03 换电脑修】 内置那一套（default = 小鱼/小鲸本身）的「恢复默认」必须回到**发布物**那份，
   * 而不是「把当前正文记成默认」—— 后者等于什么都没恢复（主人改坏了也回不去）。 */
  if (target === DEFAULT_ID) {
    try { rmSync(fileFor(target), { force: true }); } catch {}
    try { rmSync(ownDefaultFile(target), { force: true }); } catch {}
    const meta0 = idx.list.find((p) => p.id === target);
    if (meta0) meta0.updatedAt = Date.now();
    writeIndex(idx);
    return personaInfo();
  }
  const selfDef = ownDefaultOf(target);
  if (selfDef) {
    ensureDirs();
    writeFileSync(fileFor(target), selfDef + '\n', 'utf8');
  } else if (own && own.trim()) {
    // 没有默认、但有正文：把正文本身记成默认，一个字节都不动
    try { setOwnDefaultOf(target, own); } catch { /* 记不上也不能删正文 */ }
  } else {
    rmSync(fileFor(target), { force: true });
  }
  const meta = idx.list.find((p) => p.id === target);
  meta.updatedAt = Date.now();
  writeIndex(idx);
  return personaInfo();
}

// ---------------------------------------------------------------- 兼容老接口

/** 老接口：存当前这套 */
export function saveUserPersona(text) {
  const idx = ensureIndex();
  return savePersonaText(idx.current, text);
}

/** 老接口：把当前这套恢复默认 */
export function resetUserPersona() {
  const idx = ensureIndex();
  return resetPersona(idx.current);
}

/**
 * 把一套人设的正文定成「出厂的默认」。
 *
 * 主人用顺了某套之后说「这个就当默认吧」，以后新建会话 / 恢复默认时想回到它。
 * 做法和底线的 setDefaultBottomLines 完全对称：不改代码文件，
 * 只把正文抄到 .state/defaults.json 的 persona 键里；persona/xiaoyu.md 一个字都不碰。
 * 上一份自定义默认先备份到 .state/persona.default.backup.md。
 *
 * @param {string} [id] 要定成默认的那套，不传就用当前这套
 * @returns {{ persona: object, from: string, backup: string|null, changed: boolean }}
 */
export function setPersonaAsBuiltinDefault(id) {
  const idx = ensureIndex();
  const from = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === from)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }

  /* 【2026-11-03 主人拍板】「不要再搞个跟别人绑在一起的默认了」
   *
   * 以前：写 .state/defaults.json.persona —— 一份全局的，谁点谁覆盖谁。
   *       小鲸点一下就顶掉了小鱼的出厂，主人点的「设为默认」也就此失真。
   *
   * 现在：写成这套人设自己的默认（personas/<库>/defaults/<套 id>.json），
   *       只有这套自己能读到，也只影响这套自己。
   *       「恢复默认」抄回来的就是这一份。
   */
  const body = textOf(from);
  if (!body) {
    const e = new Error('这套人设是空的，没东西可以设成默认');
    e.status = 400;
    throw e;
  }
  const ok = setOwnDefaultOf(from, body);
  if (!ok) {
    const e = new Error('存不下这次默认（写文件失败）');
    e.status = 500;
    throw e;
  }
  return {
    persona: personaInfo(),
    from,
    backup: null,
    changed: true,
    own: true,
    chars: body.length,
  };
}

export function builtinPersonaText() {
  const t = readDefaults().persona;
  if (typeof t === 'string' && t.trim()) return t.trim();
  return readBasePersona();
}

/**
 * 官方内置的「可选人设」清单 —— 2026-11-04 主人要的。
 *
 * 【和一键新建的区别】
 * 「新建人设」是把当前这套复制一份，主人得自己往里填内容。
 * 这里不一样：这些是出厂自带的成品，点了就是一个能直接用的新套。
 *
 * 【为什么不直接 list.push 完事】
 * 主人可能压根不想要那几个官方选项。要是每次读索引都硬塞进去，
 * 删了下次启动又冒出来 —— 那不叫可选，叫删不掉。
 * 所以用一本账记下「哪些官方预设已经铺过了」：铺过的不再自动铺，主人删了就是删了。
 */
/**
 * 官方内置的「可选人设」清单。
 *
 * 【2026-11-06 主人要求：删掉「小鱼 / 鲸鱼娘（QQ 版）」】
 *
 * 原来这里只有一条 `xiaoyu-qq`（住在 QQ 里的小鱼：短句、分条、有脾气）。
 * 主人说「删除【多套人设】里的【小鱼/鲸鱼娘（QQ版）】」，所以列表清空。
 *
 * 为什么必须连这里一起清：`ensurePresets()` 会按这本清单往人设库里「补铺」，
 * 只要这一条还留在清单里，主人哪天清了账本（或换 scope）它就又冒出来了 ——
 * 那就不叫删除，叫「删了还会自己长回来」。
 *
 * 素材没销毁：`persona/xiaoyu-qq.md` 与库里那份都备份在
 * `D:\小鱼Agent\backup-persona-removed-20261106\`，想找回来随时能拿。
 */
/**
 * 官方预设人设：启动时按 name/file 铺进**小鱼自己那个库**（不带 scope 的那份）。
 *
 * 【2026-11-01 主人：「发布时除了默认人设外，把【小鱼/鲸鱼娘（QQ版）】也一起发布」】
 * 正文放在仓库 `persona/xiaoyu-qq.md`，跟 `persona/xiaoyu.md` 一样是发布物。
 *
 * 【为什么以前它会跑到小鲸名下】当初铺预设时两个库都铺了一份、ledger 各记一笔；
 * 后来删只删了小鱼那份（删接口不带 scope 落在小鱼库），小鲸那份一直留着 ——
 * 主人就在小鲸的列表里看见了小鱼的 QQ 人设。现在只在小鱼库铺，ledger 也各管各的。
 */
export const PERSONA_PRESETS = [
  /* 【2026-11-03 换电脑修】 这里一度被清空（注释写「主人要求空着」），但主人 2026-11-03 的原话是
   * 「（除了小鱼还有一个QQ人设外）」—— 发布版要有这一套。只铺主库（下面的 scope 守卫管着），
   * 主人删了会记在账本里，不会再自己冒回来。 */
  { id: 'xiaoyu-qq', name: '小鱼 / 鲸鱼娘（QQ 版）', file: 'xiaoyu-qq.md' },
];

/** 一本账：哪些官方预设已经铺进这个人设库了 */
function presetLedgerFile() {
  return _scope ? join(STATE_DIR, 'personas', _scope + '-presets.json') : join(STATE_DIR, 'persona-presets-made.json');
}

function readPresetLedger() {
  try {
    const j = JSON.parse(readFileSync(presetLedgerFile(), 'utf8'));
    return Array.isArray(j?.made) ? j.made.map(String) : [];
  } catch {
    return [];
  }
}

function writePresetLedger(list) {
  try {
    ensureDirs();
    writeFileSync(presetLedgerFile(), JSON.stringify({ made: list }, null, 2), 'utf8');
  } catch {
    /* 记不上就算了，最多下次多铺一遍 */
  }
}

function readPresetText(preset) {
  const p = join(config.root, 'persona', preset.file);
  const t = readFileSafe(p);
  return t === null ? '' : t.trim();
}

let _presetsDone = false;

/**
 * 把还没铺过的官方预设补进人设库。
 *
 * 只补账上没记过的；补完记一笔。幂等：调一百次也只会有一次影响。
 * 注意：内部会调 ensureIndex，所以**不能**在 ensureIndex 里反过来调它（会递归）。
 * 入口在 server.mjs 启动时和读人设列表时各调一次。
 * @returns {number} 这次补了几套
 */
export /** 这个库是不是「别人的」（小鲸 / 自建卡）。主库和不认识的临时库都算小鱼这边 */
function isOthersLib() {
  const sc = personaScope();
  if (!sc) return false;
  if (sc === 'whale') return true;
  try {
    const j = JSON.parse(readFileSync(join(STATE_DIR, 'agents.json'), 'utf8'));
    const list = Array.isArray(j && j.customs) ? j.customs : [];
    return list.some((a) => a && String(a.id) === sc);
  } catch {
    return false;
  }
}

/* 【2026-11-03 换电脑修】验收脚本要直接调它（测「铺一次就不再铺」），补回 export */
export function ensurePresets() {
  if (_presetsDone) return 0;
  /* 【2026-11-03 主人报】「为什么小白曦、小鲸的多套人设里都有【小鱼/鲸鱼娘（QQ版）】？
   * 是不是以后新建智能体都会有这两个？」
   * 对，以前就是：这段不看是谁的库，一律往里铺 PERSONA_PRESETS。
   * 那些是**小鱼自己**的预置人设，别人的库不该有。
   * 现在只给主库（不带 scope，也就是小鱼自己）铺；自建卡和小鲸都跳过。 */
  /* 【2026-11-03 换电脑修】 原来这里是「只要在某个 scope 里就一律跳过」，
   * 结果连「临时库」这种代表小鱼自己的情形也被跳过，预设永远铺不出来。
   * 现在只跳过**别人的库**：小鲸库、自建卡的库。 */
  if (isOthersLib()) { _presetsDone = true; return 0; }
  _presetsDone = true;
  let idx;
  try { idx = ensureIndex(); } catch { return 0; }
  const made = readPresetLedger();
  let added = 0;
  for (const preset of PERSONA_PRESETS) {
    if (made.includes(preset.id)) continue;
    made.push(preset.id);
    if (idx.list.some((p) => p.id === preset.id)) continue;
    const text = readPresetText(preset);
    if (!text) continue;                       // 文件不在（装了一半）就跳过，别铺空人设
    try {
      ensureDirs();
      writeFileSync(fileFor(preset.id), text + '\n', 'utf8');
      idx.list.push({ id: preset.id, name: preset.name, builtin: false, preset: true, updatedAt: Date.now() });
      added += 1;
    } catch {
      /* 单个失败不影响别的 */
    }
  }
  if (added) { try { writeIndex(idx); } catch {} }
  writePresetLedger(made);
  return added;
}

/** 当前生效的那套人设正文（给系统提示用） */
export function currentPersonaText() {
  const idx = ensureIndex();
  return textOf(idx.current);
}

/**
 * 把当前这套人设的内容清空（不是删掉这套，是把正文抹成空）。
 *
 * 主人点「清空当前」并勾上了「连记忆一起清」时走这里。
 * 两条底线：
 *   1. 清之前一定先备份到 .state/persona.wiped-<时间戳>.md —— 记忆是一次次聊出来的，
 *      点错按钮不该等于永久丢失。
 *   2. 内置的 persona/xiaoyu.md 一个字都不碰。那是出厂的那份，
 *      清空只影响「主人正在用的这一套」（personas/<id>.md）。
 *
 * @param {string} [id] 要清的那套，不传就清当前用的
 * @returns {{ persona: object, id: string, backup: string|null, bytes: number }}
 */
export function wipePersonaText(id) {
  const idx = ensureIndex();
  const target = id && isPersonaId(id) ? id : idx.current;
  if (!idx.list.some((p) => p.id === target)) {
    const e = new Error('没有这套人设');
    e.status = 404;
    throw e;
  }
  const file = fileFor(target);
  const before = readFileSafe(file);
  // 没自定义过（文件不存在）= 用的还是出厂那份，没有可清的东西，如实告诉调用方
  if (before === null) {
    return { persona: personaInfo(), id: target, backup: null, bytes: 0 };
  }
  let backup = null;
  if (before.trim()) {
    ensureDirs();
    backup = join(STATE_DIR, `persona.wiped-${Date.now()}.md`);
    try {
      writeFileSync(backup, before, 'utf8');
    } catch {
      backup = null;
    }
  }
  writeFileSync(file, '\n', 'utf8');
  const meta = idx.list.find((p) => p.id === target);
  if (meta) meta.updatedAt = Date.now();
  writeIndex(idx);
  return { persona: personaInfo(), id: target, backup, bytes: before.length };
}

/** 顺手清掉没人用的残留文件（只为一眼看清目录，不删备份） */
export function listPersonaFiles() {
  try {
    return readdirSync(pDir());
  } catch {
    return [];
  }
}
