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

function file() {
  return join(config.dataDir, '.state', 'pure.json');
}

/** 现在开没开。读不到、文件坏了都当「没开」，绝不让它把整轮对话卡住。 */
export function pureModeOn() {
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
