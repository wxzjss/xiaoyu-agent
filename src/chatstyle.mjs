/**
 * 「少说教」开关。
 *
 * 打开之后：不再动不动讲道理、加免责声明、说「作为 AI 我不能」、因为题材就跳出来拒绝或岔开。
 * 角色扮演好好演，语气和内容都不打折扣。
 *
 * 注意边界：**底线那几条不归这个开关管**。不碰隐私、不碰真钱、不可逆要先问——
 * 这些照旧压在人设最上面，任何档位都不许越过。这里只是把「啰嗦」关掉，不是把「刹车」拆掉。
 *
 * 存在 .state/chatstyle.json：{ plainTalk: true|false }
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const FILE = join(config.dataDir, '.state', 'chatstyle.json');

function readRaw() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function getChatStyle() {
  const raw = readRaw();
  return {
    /** 少说教：默认开（主人自己用的东西，默认就别啰嗦） */
    plainTalk: raw.plainTalk === undefined ? true : Boolean(raw.plainTalk),
  };
}

export function setChatStyle(input = {}) {
  const cur = getChatStyle();
  const next = { plainTalk: input.plainTalk === undefined ? cur.plainTalk : Boolean(input.plainTalk) };
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 「少说教」现在只保存开关状态，**不再往提示词里塞任何文字**。
 *
 * 主人要求：系统提示里只留设置面板看得见的东西（人设 / 底线 / 安全词）。
 * 这一段以前会往系统提示里加 5 行「不主动说教、不因为题材拒绝……」的隐藏规则，
 * 属于界面上看不到却一直在生效的约束，已经删掉。开关留在界面上只作为偏好记录，
 * 想让这条真的生效，就写进「底线」或人设卡里——那样才看得见。
 */
export function chatStylePromptBlock() {
  return '';
}
