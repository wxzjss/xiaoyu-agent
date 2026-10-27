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
 * 存在哪：`.state/pure.json`，一个布尔，全局一份（跟皮肤、思考强度一个待遇）。
 * 状态放服务端而不是 localStorage，是因为换设备、换浏览器要一致，
 * 而且服务端拼系统提示的时候必须知道当前开没开。
 *
 * 名字：对外一律叫「专业模式」。文件名和函数名还留着 pure，是怕一次性改名
 * 把十几处 import 全炸掉 —— 那是纯风险没有收益；界面上看不到 pure 这个词。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { getEnabledMap } from './features.mjs';

/** 界面上显示的名字。改文案只改这里。 */
export const MODE_NAME = '专业模式';

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
 * 现在开没开（真正判断用这个）。
 *
 * 两个条件都满足才算开：功能页里「专业模式」开着，且顶栏那个按钮是按下状态。
 * 读不到、文件坏了都当「没开」，绝不让它把整轮对话卡住。
 */
export function pureModeOn() {
  if (!pureFeatureOn()) return false;
  try {
    const f = file();
    if (!existsSync(f)) return false;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return j && j.on === true;
  } catch {
    return false;
  }
}

/** 顶栏那个按钮按下了没有（不管功能页开关）。给界面回填高亮用。 */
export function pureButtonOn() {
  try {
    const f = file();
    if (!existsSync(f)) return false;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    return j && j.on === true;
  } catch {
    return false;
  }
}

/** 改开关，返回改完之后的状态。 */
export function setPureMode(on) {
  const next = Boolean(on);
  const f = file();
  // 先写临时文件再改名：中途断电也不会留下半个坏文件
  const tmp = f + '.tmp';
  writeFileSync(tmp, JSON.stringify({ on: next, at: Date.now() }, null, 2), 'utf8');
  renameSync(tmp, f);
  return next;
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
export function pureSystemPrompt() {
  if (!pureModeOn()) return '';
  const tools = toolNames();
  const lines = [
    '你跑在主人电脑上的「小鱼Agent」程序里，不是网页版聊天窗口。',
    '现在开着「专业模式」：这一轮不套人设、不用特定语气，只说事实、只干活。',
  ];
  if (tools.length) {
    lines.push(
      `你可以直接用这些工具动手：${tools.join('、')}。要读写文件、跑命令、上网抓东西就直接调，别只在嘴上说。`,
    );
  }
  lines.push('主人问到这个程序的功能、你自己能干什么，就照实说，不要反问「你说的是哪个软件」。');
  return lines.join('\n') + '\n\n' + STYLE_RESET_RULE + '\n\n' + PRO_MODE_RULE;
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
