/**
 * 小鲸的「身份卡」：她自己的人设 + 她自己用的模型。
 *
 * 【要解决什么】
 * 主人原话：「能在功能页的子智能体那栏增加修改人设与模型的功能吗？」
 *
 * 以前这两样都是死的：
 *   · 人设写死在 subagent.mjs 里，想改一个字得动代码；
 *   · 模型只能跟主人当前用的那个走（opts.model 传了也没人接）。
 *
 * 现在抽出来单独存，存在 .state/whale-profile.json：
 *   {
 *     persona: '',
 *     personaCustom: false,
 *     modelId: '',
 *   }
 * 空串都表示「用内置默认」：人设用 subagent.mjs 那套，模型跟主人当前用的那个。
 *
 * 【为什么模型不塞在 session-overrides 里】
 * 那个文件是按会话 id 记的，而小鲸没有会话 —— 她可能从任何一个会话被叫出来。
 * 硬要借用就会变成「在 A 会话里给她换了模型，B 会话里又变回去」。
 * 她是同一个小鲸，模型也该是同一个。所以单独存一份。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state');
const FILE = join(DIR, 'whale-profile.json');

/**
 * 内置默认人设：原来写死在 subagent.mjs 的那一整套，2026-10-26 搬成了 whale-default-persona.md。
 * 优先级：主人自己写的（whale-profile.json 的 persona）> 这个文件 > 空。
 */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PERSONA_FILE = (() => {
  const cands = [
    join(SELF_DIR, 'whale-default-persona.md'),
    join(config.root, 'src', 'whale-default-persona.md'),
    join(config.dataDir, 'code', 'src', 'whale-default-persona.md'),
  ];
  for (const p of cands) {
    try { if (existsSync(p)) return p; } catch {}
  }
  return cands[0];
})();

/** 读内置默认人设正文；读不出来返回空串（人设文件坏了也不能把她整个人搞没） */
export function defaultWhalePersonaText() {
  try {
    let t = readFileSync(DEFAULT_PERSONA_FILE, 'utf8');
    t = t.replace(/^<!--[\s\S]*?-->\s*/, '').trim();
    return t;
  } catch {
    return '';
  }
}

/** 默认人设文件在哪（排查用） */
export function defaultWhalePersonaPath() {
  return DEFAULT_PERSONA_FILE;
}

/** 人设最长多少字。够写得很细了，再长就是往里灌资料，不是人设。 */
export const MAX_PERSONA_CHARS = 20000;

function readAll() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeAll(data) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 读她的身份卡。
 * 读不出来就当「全默认」—— 绝不能因为一个坏文件把她整个人搞没了。
 */
export function getWhaleProfile() {
  const j = readAll();
  return {
    persona: typeof j.persona === 'string' ? j.persona : '',
    personaCustom: Boolean(j.personaCustom),
    modelId: typeof j.modelId === 'string' ? j.modelId : '',
    path: FILE,
  };
}

/**
 * 她自定义的人设。空串 = 人设栏空着 —— 调用方只给骨架，不编性格（内置那套 2026-10-26 已删）。
 */
/**
 * 多套人设接线·2026-10-30
 * 小鲸现在有「多套人设」了（personas/whale/ 下的库）。
 * 库里选中那一套优先，库里没有才回落 profile.persona。
 * 这样在界面上切人设她是真的换，不是摆样子。
 */
function personaFromLibrary() {
  try {
    const idxFile = join(DIR, 'personas', 'whale.json');
    if (!existsSync(idxFile)) return '';
    const idx = JSON.parse(readFileSync(idxFile, 'utf8'));
    const id = String(idx?.current || '').trim();
    if (!id) return '';
    const f = join(DIR, 'personas', 'whale', id + '.md');
    if (!existsSync(f)) return '';
    return readFileSync(f, 'utf8').trim();
  } catch { return ''; }
}

export function whalePersonaOverride() {
  const lib = personaFromLibrary();
  if (lib) return lib;
  const p = getWhaleProfile();
  const t = String(p.persona || '').trim();
  if (t) return t;
  // 人设栏空着 = 主人还没写过 -> 用内置默认人设
  return defaultWhalePersonaText();
}

/** 人设栏里该显示什么：主人写过的显示那套，没写过就显示默认人设 */
export function whalePersonaForEditor() {
  const p = getWhaleProfile();
  const own = String(p.persona || '').trim();
  const def = defaultWhalePersonaText();
  return { persona: own || def, custom: Boolean(own), defaultText: def };
}

/**
 * 她该用哪个模型 id。空串 = 跟主人当前用的那个。
 */
export function whaleModelId() {
  return getWhaleProfile().modelId || '';
}

/**
 * 存她的身份卡。只改传进来的那几项，没传的不动。
 *
 * @param {object} input
 * @param {string} [input.persona]  人设正文；传空串 = 恢复内置默认
 * @param {string} [input.modelId]  模型 id；传空串 = 跟主人当前用的那个
 */
export function saveWhaleProfile(input = {}) {
  const cur = getWhaleProfile();
  const out = {
    persona: cur.persona,
    personaCustom: cur.personaCustom,
    modelId: cur.modelId,
  };

  if (input.persona !== undefined) {
    const t = String(input.persona ?? '');
    if (t.length > MAX_PERSONA_CHARS) {
      const e = new Error(`人设太长了（${t.length} 字，最多 ${MAX_PERSONA_CHARS} 字）`);
      e.status = 400;
      throw e;
    }
    // 空白当「没改」：主人手滑打了个回车不该把整套人设清空
    if (!t.trim()) {
      out.persona = '';
      out.personaCustom = false;
    } else {
      out.persona = t;
      /**
       * 【存下来跟默认一字不差 = 不算私设】
       *
       * 2026-10-26：人设栏现在打开就填好默认人设，主人经常原样点「存上」。
       * 以前这会记成「改过」，然后发布出去的就是他那份「看着像默认」的副本 ——
       * 往后我们修默认人设，他的程序会一直用旧副本，改了等于没改。
       * 现在按内容判定：跟当前默认一样，就不算改过。
       */
      out.personaCustom = t.trim() !== defaultWhalePersonaText().trim();
    }
  }

  if (input.modelId !== undefined) {
    out.modelId = String(input.modelId ?? '').trim();
  }

  // 没改过的项不往文件里塞空串，文件读起来干净；全默认时写 {} 也正好
  const clean = {};
  if (out.persona) clean.persona = out.persona;
  if (out.personaCustom) clean.personaCustom = true;
  if (out.modelId) clean.modelId = out.modelId;

  if (!writeAll(clean)) {
    const e = new Error('写不进去（磁盘或权限问题）');
    e.status = 500;
    throw e;
  }
  return getWhaleProfile();
}

/**
 * 把她现在这份人设设成默认（2026-10-29 主人要的）。
 *
 * 「现在这份」拿的是 effective —— 改过就用改过的，没改过就是文件本身，写回去等于没动。
 * 写之前留一份 .bak，手滑能捡回来。
 */
export function setWhalePersonaAsDefault() {
  const cur = String(whalePersonaForEditor().persona || '').trim();
  if (!cur) {
    const e = new Error('她现在没有可设为默认的人设正文');
    e.status = 400;
    throw e;
  }
  try {
    if (existsSync(DEFAULT_PERSONA_FILE)) {
      const bak = DEFAULT_PERSONA_FILE + '.bak-' + Date.now();
      writeFileSync(bak, readFileSync(DEFAULT_PERSONA_FILE, 'utf8'), 'utf8');
    }
  } catch { /* 备份失败不挡正事 */ }
  mkdirSync(dirname(DEFAULT_PERSONA_FILE), { recursive: true });
  writeFileSync(DEFAULT_PERSONA_FILE, cur, 'utf8');
  return { ok: true, chars: cur.length, path: DEFAULT_PERSONA_FILE };
}
