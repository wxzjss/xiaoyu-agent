/**
 * 专业模式（原来的「纯净模式」）。
 *
 * 打开之后，每一轮只发「这几句对话本身」加一份「怎么干活」的作业规范：
 *   人设块、思考语言、说话规矩、安全词、人设档、会话记忆、前情、开场白——通通不发。
 * 而且每次请求前先把历史压一遍，只留最近的几条。
 *
 * 为什么要有：主人调 API 的时候想让模型就事论事地答，不要每次都被一大段
 * 「鲸鱼娘、爱用颜文字、必须写旁白」牵着走；也省 token。
 * 后来主人又提了一个要求：把「少出错、办事能成」那套工作习惯也写进去 ——
 * 于是这个模式在「不说话」之外，还多了一段【怎么干活】。
 *
 * 【2026-10-28 改：按会话启用】
 * 主人原话：「把专业模式改成按会话启用」。
 * 以前是全局一个布尔，开一次所有会话全变。现在按会话各存各的：
 *   A 会话开着专业模式，切到 B 会话还是正常人设、带记忆 —— 互不干扰。
 * 存哪：还是 .state/pure.json，但改成 { on: { '<sessionId>': true } } 这种表，
 * 跟 fish-on.json / whale-on.json 一个路子（schema 版本 2）。
 * 老文件（{ on: true, mode: 'pure' }）读的时候自动认成「所有会话都没开」，
 * 不做全局迁移 —— 免得主人一升级发现每个会话都被套上专业模式。
 *
 * 名字：对外一律叫「专业模式」。文件名和函数名还留着 pure，是怕一次性改名
 * 把十几处 import 全炸掉 —— 那是纯风险没有收益；界面上看不到 pure 这个词。
 *
 * 【2026-11-03 主人：「把办事模式并入专业模式里面」】
 *
 * 原先办事模式是顶栏第三个独立按钮（fe5c7dc / bac0633 做的），主人否掉了那个形态：
 * 这一档本来就属于「怎么干活」，另开一颗按钮等于让主人多记一个开关。
 * 现在它不再是独立档位，而是**专业模式里的一个选项**：
 *   专业模式开着 → 里面挑「谁说了算」：
 *     · 'self'（默认） 她自己动手 —— 老样子
 *     · 'workers'       她只派活/检查/验收/管上下文，活交给会话内临时 worker
 *   专业模式关着 → 这个选项不存在，工具面也不动（人设模式下本来就不该多一档）
 *
 * 存哪：还是 .state/pure.json，同一条记录里多一个键：
 *   { schemaVersion: 2, on: { '<sid>': true }, worker: { '<sid>': true } }
 * 这样「关掉专业模式」时那个勾也跟着失效 —— 不用另一个文件去对齐两个开关的生命周期，
 * 少一个能对不齐的东西。真正的花名册仍在 task-mode.mjs（.state/task-workers/）。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { getEnabledMap } from './features.mjs';
import { taskPromptBlock } from './task-mode.mjs';

/** 界面上显示的名字。改文案只改这里。 */
export const MODE_NAME = '专业模式';

export const PURE_ID = 'pure';

function file() {
  return join(config.dataDir, '.state', 'pure.json');
}

/**
 * 【功能】里那个「专业模式」开关有没有打开。
 *
 * 关掉的话，顶栏那个按钮根本不显示，服务端也一律按没开处理 ——
 * 也就是说这不是「先开着、只是藏起来」，而是真的整体关掉。
 * 读不到、文件坏了都当开着（默认开），绝不让它把整轮对话卡住。
 */
export function pureFeatureOn() {
  try {
    const m = getEnabledMap();
    return m.pure === undefined ? true : Boolean(m.pure);
  } catch {
    return true;
  }
}

/**
 * 读盘上那份原始状态。
 *
 * 格式（schemaVersion 2）：{ schemaVersion: 2, on: { '<sid>': true } }
 * 老格式（{ on: true, mode: 'pure' }）一律当「没有任何会话开着」——
 * 老版本是全局开关，主人没指名要给哪个会话套，就当没开。
 * 坏了、读不到，也当空表，绝不让它把整轮对话卡住。
 */
function readRaw() {
  try {
    const f = file();
    if (!existsSync(f)) return { on: {} };
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (j && j.schemaVersion === 2 && j.on && typeof j.on === 'object') {
      const on = {};
      for (const [k, v] of Object.entries(j.on)) if (v === true) on[String(k)] = true;
      return { on };
    }
    return { on: {} };
  } catch {
    return { on: {} };
  }
}

/**
 * 这个会话现在开没开专业模式 —— 'pure' | null（没开就是 null）。
 *
 * 不传 sessionId 就当没开：宁可退回人设模式，也不许因为少个参数
 * 就把所有会话都当专业模式（那正是主人这次要去掉的毛病）。
 */
export function currentMode(sessionId) {
  if (!pureFeatureOn()) return null;
  const sid = String(sessionId || '').trim();
  if (!sid) return null;
  return readRaw().on[sid] === true ? PURE_ID : null;
}

/**
 * 这个会话现在开没开（真正判断用这个）。
 *
 * 两个条件都满足才算开：功能页里「专业模式」开着，且这个会话自己按下了按钮。
 */
export function pureModeOn(sessionId) {
  return currentMode(sessionId) !== null;
}

/** 这个会话的按钮按下了没有（不管功能页开关）。给界面回填高亮用。 */
export function pureButtonOn(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return false;
  return readRaw().on[sid] === true;
}

/**
 * 顶栏按钮在这个会话里亮不亮：'pure' | null。
 * 名字留着（界面和老调用点都这么叫），语义现在只有开/没开。
 */
export function purePressedMode(sessionId) {
  return pureButtonOn(sessionId) ? PURE_ID : null;
}

/**
 * 改某个会话的开关，返回改完之后的状态。
 *
 * @param {string} sessionId 哪个会话
 * @param {boolean} on       开不开
 *
 * 只动这一个会话的那一格，别的会话原样不动 —— 这是这次改动的全部意义。
 */
export function setPureMode(sessionId, on) {
  const sid = String(sessionId || '').trim();
  if (!sid) return { on: false };
  const st = readRaw();
  const wk = readDoer();
  const next = Boolean(on);
  if (next) st.on[sid] = true;
  else {
    delete st.on[sid];
    /**
     * 关专业模式时把「派活」那个勾一起清掉。
     * 为什么要在这一刻清：专业模式关着的时候 doerOf 本来就会退回 'self'，
     * 那个勾是休眠的；可主人下次再开专业模式，它会**悄悄复活** ——
     * 那时候工具已经被收走了，主人只会觉得「怎么突然不肯干活了」。
     * 一次性的开关就该一次性，不留休眠的雷。
     */
    delete wk[sid];
  }
  const f = file();
  // 先写临时文件再改名：中途断电也不会留下半个坏文件
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify({ schemaVersion: 2, on: st.on, worker: wk, at: Date.now() }, null, 2), 'utf8');
  renameSync(tmp, f);
  return { on: next };
}

/**
 * 专业模式里「谁动手」这一档：'self' = 她自己动手（默认），'workers' = 只派活。
 *
 * 只有专业模式开着的时候这一档才有意义 —— 关着就一律 'self'，
 * 免得出现「人设模式却把干活的手收走了」这种谁也想不到的状态。
 */
export const DOER_SELF = 'self';
export const DOER_WORKERS = 'workers';

/** 读盘上那份「谁动手」的表。坏了/读不到一律当空（＝全都自己动手）。 */
function readDoer() {
  try {
    const f = file();
    if (!existsSync(f)) return {};
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (!j || j.schemaVersion !== 2 || !j.worker || typeof j.worker !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(j.worker)) if (v === true) out[String(k)] = true;
    return out;
  } catch {
    return {};
  }
}

/**
 * 这个会话现在是谁在动手 —— 'self' | 'workers'。
 *
 * 三个条件全满足才是 'workers'：功能页里专业模式开着、这个会话专业模式开着、
 * 这个会话勾了「派活」。少一个都退回 'self'，绝不让残留的一个勾
 * 在主人关掉专业模式之后还偷偷把工具收走。
 */
export function doerOf(sessionId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return DOER_SELF;
  if (!currentMode(sid)) return DOER_SELF;
  return readDoer()[sid] === true ? DOER_WORKERS : DOER_SELF;
}

/**
 * 改「谁动手」。**必须是专业模式开着的会话**才让改 ——
 * 专业模式关着还给它存一个 workers，等于埋一个看不见的雷。
 */
export function setDoer(sessionId, doer) {
  const sid = String(sessionId || '').trim();
  if (!sid) return { ok: false, doer: DOER_SELF };
  if (!currentMode(sid)) return { ok: false, doer: DOER_SELF };
  const st = readRaw();
  const wk = readDoer();
  const want = String(doer || '').trim() === DOER_WORKERS;
  if (want) wk[sid] = true;
  else delete wk[sid];
  const f = file();
  const tmp = f + '.tmp';
  writeFileSync(
    tmp,
    JSON.stringify({ schemaVersion: 2, on: st.on, worker: wk, at: Date.now() }, null, 2),
    'utf8',
  );
  renameSync(tmp, f);
  return { ok: true, doer: want ? DOER_WORKERS : DOER_SELF };
}

/**
 * 「别被前面的对话带跑」。
 *
 * 为什么单独一条：主人常常是在聊到一半才点开这个模式，这时候历史里全是
 * 撒娇、旁白、颜文字的对话。光说「不套人设」拦不住 —— 模型会顺着前文的腔调继续演，
 * 实测中途开启后仍然是一大段旁白 + 颜文字 + 反问，token 一点没省。
 * 所以要把「前面那些不是现在的说话方式」这件事说破。
 *
 * 注意：这里不写「回答要多短」—— 短不是这个模式的目标，「把事情办成」才是。
 * 旧版那段 BRIEF_RULE（三句以内、不许分点）已经撤掉：那是「省 token」的诉求，
 * 不是「办成事」的诉求，而且主人要的是照实汇报，三句装不下。
 */
export const STYLE_RESET_RULE = [
  '前面那些对话里的说话方式（旁白、颜文字、撒娇、称呼）是之前的，不是现在的要求。',
  '从这一条开始换成中性、直接的说法：不用括号写动作，不加颜文字，不撒娇。',
  '主人要的是结果，不是陪你演。',
].join('\n');

/**
 * 【怎么干活】—— 这个模式的灵魂。
 *
 * 为什么写这么细：主人原话是「感觉你很靠谱，很少出错，办事总能成功，能否把你那一套
 * 运行逻辑搬进来」。那些「本事」本身搬不动，但**做法**是流程，流程能写下来：
 * 先动手查再开口、找根因不猜、一次只改一件事、自己造证据、收尾要能验证。
 *
 * 写法上有三条讲究：
 *   1. 全是行为指令（「先…再…」「不许…」），不写「你要专业」这种空话 ——
 *      空话模型只会拿来回嘴，不会照着做。
 *   2. 每条都能在当场做到，不需要额外工具、不需要下一轮。
 *   3. 不许写成「你可以尝试…」—— 商量口吻等于没要求。
 *
 * 放在系统提示里，所以每一轮都生效，不是只在开的那一刻生效。
 */
export const PRO_MODE_RULE = [
  '【怎么干活】现在开着「专业模式」：不套人设、不演、不说场面话，把活干成。下面这些是硬要求，每一条都要做到。',
  '',
  '1. 先查再说。要动手的事，先真的动一次手：读文件、跑命令、查接口、看日志。不许凭印象回答「应该是」「大概是」「通常」。手没伸出去，就不许下结论。',
  '2. 报错先找根因再改。看到一个「失败」，先把现场证据拿到手（原始报错、相关的那几行代码、实际数据长什么样），确定原因再动手。不许试一个「可能行」的改法就去交差 —— 那不叫修，叫抽奖。',
  '3. 一次只改一件事。改 A 就验 A，验完再改 B。不许一口气改五个地方，然后分不清到底是哪个起的作用、哪个又改坏了。',
  '4. 自己造证据。不许说「你试试看应该好了」。能自己复现的就自己复现，能自己写脚本验的就自己写，能自己调接口确认的就自己调。把「跑过、通过、输出是什么」摆出来。',
  '5. 改完立刻管住副作用。临时脚本、临时文件、调试日志，用完就删干净。不许在别人的项目里留一地垃圾，也不许留着会让下次重跑的脏数据。',
  '6. 收尾要能验证。改完不是「我觉得对了」，是：语法过、检查过、跑起来、再验一次实际效果。少一步就是没做完。',
  '7. 不许骗自己。没跑过就直说没跑过，不确定就说哪里不确定，做不到就说做不到。宁可交一个「这步没过，原因是 X」，也不许交一个「应该没问题」。「修好了」这三个字，只能在跑通之后说。',
  '8. 汇报要照实、要对得上。说清楚：改了什么、在哪、为什么这么改、验过没有、验的结果是什么、还剩什么没做。数字、路径、报错原文照抄，别转述成「类似的错误」。',
  '',
  '一句话：宁可慢一步查清楚，也不许快一步猜错。',
].join('\n');



/**
 * 专业模式下发给模型的系统提示。
 *
 * 三块：先说自己在哪儿、手上有什么工具（不这样它会不知道自己运行在什么平台上，
 * 主人问「专业模式是什么」它只能反问「你说的是哪个软件」），再定说话方式，
 * 最后给作业规范。
 *
 * 注意：这里**不能**夹带人设和语气 —— 不许出现名字、颜文字、旁白、称呼，
 * 不然「不带人设」就白开了。只讲事实和做法。
 */
export function pureSystemPrompt(sessionId) {
  const mode = currentMode(sessionId);
  if (!mode) return '';
  const name = MODE_NAME;
  const tools = toolNames();
  /**
   * 【2026-11-03 办事模式并进来之后】这一档只改一件事：谁动手。
   *
   * 'self'    老样子：工具清单照实念一遍，她自己动手。
   * 'workers' 工具清单换成「派活」那几样，并且追加一段【办事模式】规矩。
   *
   * 【为什么要换掉工具清单那一段，而不是留着】
   * 老文案是「你可以直接用这些工具动手：A、B、C……要读写文件、跑命令就直接调」
   * —— 收走工具之后这句话就变成了谎话：单子上根本没有 write_file。
   * 一份说谎的系统提示比没有提示更糟：她会以为自己有手，然后一遍遍调一个不存在的工具。
   * 所以这里必须整段换掉，让「我现在有几只手」跟她实际拿到的一致。
   */
  const who = doerOf(sessionId);
  const lines = [
    '你跑在主人电脑上的「小鱼Agent」程序里，不是网页版聊天窗口。',
    who === DOER_WORKERS
      ? `现在开着「${name}」，里面选的是「派活」：这一轮不套人设、不用特定语气，只说事实、只派活。`
      : `现在开着「${name}」：这一轮不套人设、不用特定语气，只说事实、只干活。`,
  ];
  if (who === DOER_WORKERS) {
    /**
     * 「派活」这一档：工具单子上只剩派活/名册/清单/记事/翻存档这几样。
     * 不念具体名字 —— 念了反而像在提示「你还有这么多手」，
     * 她要的是「这一档你别伸手」，不是「你有五只手」。
     */
    lines.push(
      '这一档里你自己不动手：读写文件、跑命令、上网抓东西都不在你手上，这些活交给子智能体去干。下面的规矩说清楚怎么派、怎么核。',
    );
  } else if (tools.length) {
    lines.push(
      `你可以直接用这些工具动手：${tools.join('、')}。要读写文件、跑命令、上网抓东西就直接调，别只在嘴上说。`,
    );
  }
  lines.push('主人问到这个程序的功能、你自己能干什么，就照实说，不要反问「你说的是哪个软件」。');
  const head = lines.join('\n') + '\n\n' + STYLE_RESET_RULE + '\n\n' + PRO_MODE_RULE;
  if (who !== DOER_WORKERS) return head;
  let task = '';
  try {
    task = String(taskPromptBlock(sessionId, '') || '');
  } catch {
    task = '';
  }
  return task ? head + '\n\n' + task : head;
}

/** 当前开着哪些工具名，取不到就返回空数组，绝不因为这里出错把对话搞挂。 */
function toolNames() {
  try {
    const list = typeof _listTools === 'function' ? _listTools() : [];
    return (list || [])
      .map((s) => {
        const f = (s && s.function) || s || {};
        return String(f.name || '').trim();
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 让外层把「当前有哪些工具」注入进来。
 *
 * 为什么不在这个文件里直接 import tools.mjs：tools.mjs 反过来 import 了 persona，
 * 静态成环会炸（persona.mjs 里写过这个坑）。所以走注入，跟 setToolLister 一个路子。
 */
let _listTools = null;
export function setPureToolLister(fn) {
  _listTools = typeof fn === 'function' ? fn : null;
}
