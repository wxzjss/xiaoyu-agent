/**
 * 纯净模式。
 *
 * 打开之后，每一轮只发「这几句对话本身」：
 *   人设块、思考语言、说话规矩、安全词、人设档、会话记忆、前情、开场白——通通不发。
 * 而且每次请求前先把历史压一遍，只留最近的几条。
 *
 * 为什么要有：主人调 API 的时候想让模型就事论事地答，不要每次都被一大段
 * 「鲸鱼娘、爱用颜文字、必须写旁白」牵着走；也省 token。
 *
 * 存在哪：`.state/pure.json`，一个布尔，全局一份（跟皮肤、思考强度一个待遇）。
 * 状态放服务端而不是 localStorage，是因为换设备、换浏览器要一致，
 * 而且服务端拼系统提示的时候必须知道当前开没开。
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { getEnabledMap } from './features.mjs';

function file() {
  return join(config.dataDir, '.state', 'pure.json');
}

/**
 * 【功能】里那个「纯净模式」开关有没有打开。
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
 * 两个条件都满足才算开：功能页里「纯净模式」开着，且顶栏那个按钮是按下状态。
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
 * 纯净模式下的「答短点」提示。
 *
 * 为什么要有这条：纯净模式把系统提示清空了，模型就没有任何「该说多长」的锚点，
 * 默认会拉着长篇大论。这里补一条极短的约束，把长度压下去。
 *
 * 注意：这是纯净模式里**唯一**发出去的东西，所以必须只有长度要求，
 * 不能夹带人设、语气、称谓——不然纯净就白开了。
 */
export const BRIEF_RULE = [
  '回答尽量短：能一句话说完就一句话，最多不超过三句。',
  '不要开场白、不要客套、不要复述我的问题、不要解释你在做什么。',
  '不要分点、不要标题、不要总结段。直接给答案。',
].join('\n');

/**
 * 「别被前面的对话带跑」。
 *
 * 为什么单独一条：主人常常是在聊到一半才点开纯净模式，这时候历史里全是
 * 撒娇、旁白、颜文字的对话。光说「不套人设」拦不住 —— 模型会顺着前文的腔调继续演，
 * 实测中途开启后仍然是一大段旁白 + 颜文字 + 反问，token 一点没省。
 * 所以要把「前面那些不是现在的说话方式」这件事说破。
 */
export const STYLE_RESET_RULE = [
  '前面那些对话里的说话方式（旁白、颜文字、撒娇、称呼）是之前的，不是现在的要求。',
  '从这一条开始换成中性、直接的说法：不用括号写动作，不加颜文字，不撒娇。',
  '主人要的是结果，不是陪你演。',
].join('\n');

/**
 * 纯净模式下发给模型的系统提示。
 *
 * 两块：先说自己是谁、在哪（不这样它会不知道自己运行在什么平台上，
 * 主人问「纯净模式是什么」它只能反问「你说的是哪个软件」），再压长度。
 *
 * 注意：这里**不能**夹带人设和语气 —— 不许出现名字、颜文字、旁白、称呼，
 * 不然「纯净」就白开了。只讲事实：你是什么、在哪儿、能调哪些工具、回答要多短。
 */
export function pureSystemPrompt() {
  if (!pureModeOn()) return '';
  const tools = toolNames();
  const lines = [
    '你跑在主人电脑上的「小鱼Agent」程序里，不是网页版聊天窗口。',
    '现在开着「纯净模式」：这一轮不套人设、不用特定语气，只说事实、只干活。',
  ];
  if (tools.length) {
    lines.push(
      `你可以直接用这些工具动手：${tools.join('、')}。要读写文件、跑命令、上网抓东西就直接调，别只在嘴上说。`,
    );
  }
  lines.push('主人问到这个程序的功能、你自己能干什么，就照实说，不要反问「你说的是哪个软件」。');
  return lines.join('\n') + '\n\n' + STYLE_RESET_RULE + '\n\n' + BRIEF_RULE;
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
