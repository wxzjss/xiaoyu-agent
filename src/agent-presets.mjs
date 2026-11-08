/**
 * 出厂自带的智能体卡（随包发布）。
 *
 * 【为什么要有这一层·2026-11-03 主人原话】
 *   「给小白曦与旁白也连带着出厂人设一起发布」
 *
 * 以前只有「小鱼」「小鲸」两张内置卡是随包走的；主人自己建的小白曦、旁白
 * 只活在他这台机器的 `.state/agents.json` 里 —— 换台电脑、重装一次就没了。
 *
 * 这里把她们做成**发布物**：
 *   · 人设正文放进仓库 persona/agents 下（`build.files` 已经带了整个 persona 目录，自动进包）；
 *   · 每台机器第一次启动时铺成一张卡，并把正文同时写成她自己的「默认人设」与
 *     `.factory.json`，这样「恢复出厂默认」永远有东西可回；
 *   · 用一本账记下「已经铺过哪几张」—— **主人删了就是删了**，
 *     下次启动不会再冒出来（跟多套人设那边的 PERSONA_PRESETS 同一个道理）。
 *
 * 【id 为什么听 addAgent 自己生成】
 * addAgent 内部用 newId() 出 id，主人在自己机器上建的那两张卡 id 是随机的
 * （`ag_mvs72e9v3cfc` / `ag_mvtn23b55dqv`）。这里**不硬塞固定 id**：一旦硬塞，
 * 老机器上就会出现「同一张小白曦两个 id」的鬼影。判重用名字：
 * 库里已经有同名卡就只补出厂正文、不再建第二张。
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { addAgent, listAgents, factoryPersonaOf } from './agents.mjs';

const DIR = join(config.dataDir, '.state');
const LEDGER = join(DIR, 'agent-presets-made.json');

/** 资源根（开发时 = 项目目录；装 exe 后 = app.asar 里那份只读的） */
const ROOT = (() => {
  try {
    // config.mjs 没导出 ROOT，用 workspace 反推是不行的；这里按「数据目录 vs 资源目录」的既有约定办：
    // persona/ 一定跟着代码走，所以从 config.root 拿（它本来就是代码根）。
    return config.root;
  } catch {
    return process.cwd();
  }
})();

/**
 * 出厂卡清单。
 *
 * key   —— 账本里的名字，也是文件名（`persona/agents/<key>.md`）
 * id    —— 卡 id（固定，方便对账）
 * name  —— 界面上显示的名字
 * desc  —— 卡片下面那行小字
 */
export const AGENT_PRESETS = [
  {
    key: 'xiaobaixi',
    id: 'ag_xiaobaixi',
    name: '小白曦',
    desc: '一只被主人收养的白猫娘。软软糯糯、爱撒娇，最怕被抛弃。',
  },
  {
    key: 'pangbai',
    id: 'ag_pangbai',
    name: '旁白',
    desc: '屋子里的另一位存在。只写看得见听得见的，不猜心、不推进剧情。',
  },
];

function presetFile(key) {
  return join(ROOT, 'persona', 'agents', `${key}.md`);
}

function readLedger() {
  try {
    const j = JSON.parse(readFileSync(LEDGER, 'utf8'));
    return Array.isArray(j && j.made) ? j.made.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function writeLedger(made) {
  try {
    if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true });
    writeFileSync(LEDGER, JSON.stringify({ made, at: Date.now() }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 把一份人设正文落成「这张卡自己的出厂」。
 *
 * 只写「出厂可回」的两处，**不碰主人当前用的正文**：
 *   · `.state/personas/<id>/defaults.json` —— `factoryPersonaOf(id)` 第一顺位读的就是它，
 *     「恢复出厂默认」最后回到的就是这份；
 *   · `.state/personas/<id>/.factory.json` —— 最后一道兜底（也是历史遗留那份的位置）。
 *
 * 【为什么这里不再调 createPersona】建卡时 `addAgent` 已经给这张卡建好了「以她名字命名
 * 的那一套人设」并把正文定成了那套自己的默认。这里再建一次会在多套人设面板里多出一套
 * 同名同内容的 —— 那不是发布，那是往主人抽屉里塞垃圾。
 */
function seedPersonaFiles(id, name, text) {
  const key = String(id || '');
  if (!key) return;
  try {
    const dir = join(DIR, 'personas', key);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const body = String(text).trim();
    writeFileSync(join(dir, 'defaults.json'), JSON.stringify({ persona: body, at: Date.now() }, null, 2), 'utf8');
    writeFileSync(join(dir, '.factory.json'), JSON.stringify({ name, persona: body, at: Date.now() }, null, 2), 'utf8');
  } catch { /* 出厂写不进去不该挡住铺卡 */ }
}

/**
 * 铺出厂卡。每台机器只铺一次（账本记着），返回这次真的新建了几张。
 * 已经用过这台机器、库里已有同名/同 id 的卡时也只记一笔，不重复建。
 */
export function ensureAgentPresets() {
  if (!AGENT_PRESETS.length) return 0;
  const made = readLedger();
  let added = 0;
  for (const preset of AGENT_PRESETS) {
    if (made.includes(preset.key)) continue;
    let text = '';
    try {
      text = String(readFileSync(presetFile(preset.key), 'utf8')).replace(/\r\n/g, '\n').trim();
    } catch {
      /* 包里没有这个文件（比如别人把 persona/agents 删了）—— 记一笔跳过，别每轮都试 */
      made.push(preset.key);
      continue;
    }
    if (!text) {
      made.push(preset.key);
      continue;
    }
    /* 判重用名字 —— 老机器上主人自己建的那两张卡 id 是随机的，硬比 id 会认不出来。 */
    let same = null;
    try {
      same = listAgents().find((a) => String(a.name || '').trim() === preset.name) || null;
    } catch {
      same = null;
    }
    if (!same) {
      const item = addAgent({ name: preset.name, desc: preset.desc, persona: text });
      if (!item) {
        /* 建卡失败（写盘失败 / 超上限）：**不记账**，下次启动再试一次 */
        continue;
      }
      seedPersonaFiles(String(item.id || ''), preset.name, text);
      added += 1;
    } else if (!factoryPersonaOf(String(same.id || ''))) {
      /* 已经有了、但没有出厂可回（老机器上那两张卡的 .factory.json 是历史遗留，
         可能缺）：补一份。**不动主人改过的当前正文**。 */
      seedPersonaFiles(String(same.id || ''), preset.name, text);
    }
    made.push(preset.key);
  }
  writeLedger(made);
  return added;
}