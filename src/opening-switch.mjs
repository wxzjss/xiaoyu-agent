/**
 * 开场白开关（2026-10-31 主人要的）
 *
 * 原来开场白只有一个「填了就开场、空着就不开场」的隐式开关 ——
 * 想暂时关掉，得把整段话删了，回头还得重新打一遍，太笨。
 * 现在给每张卡单独记一个布尔：关掉之后稿子还在，只是新建会话时不开口。
 *
 * 存在 .state/agent-opening-switch.json：{ [agentId]: true|false }
 * 没记过 = 默认开（小鱼的出厂段仍然会自动开场，跟以前一致）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const SWITCH_FILE = () => join(config.dataDir, '.state', 'agent-opening-switch.json');

function readSwitchMap() {
  try {
    const j = JSON.parse(readFileSync(SWITCH_FILE(), 'utf8'));
    if (!j || typeof j !== 'object') return {};
    const out = {};
    for (const [k, v] of Object.entries(j)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 这张卡的开场白是开着的吗？没记过默认 true。 */
export function cardOpeningEnabled(agentId) {
  const id = String(agentId || '');
  if (!id) return true;
  const map = readSwitchMap();
  if (Object.prototype.hasOwnProperty.call(map, id)) return map[id] !== false;
  return true;
}

/** 打开/关掉这张卡的开场白。 */
export function setCardOpeningEnabled(agentId, enabled) {
  const id = String(agentId || '');
  if (!id) {
    const err = new Error('没说要改哪张卡的开场白开关');
    err.status = 400;
    throw err;
  }
  const map = readSwitchMap();
  map[id] = !!enabled;
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(SWITCH_FILE(), JSON.stringify(map, null, 2), 'utf8');
  } catch (e) {
    const err = new Error('存不进去：' + e.message);
    err.status = 500;
    throw err;
  }
  return { agentId: id, enabled: !!enabled };
}
