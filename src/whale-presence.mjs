/**
 * 小鲸「在场」这个状态。
 *
 * ── 主人要的是什么 ────────────────────────────────────────────
 *
 * 顶栏那个「小鲸」按钮按下去之后：
 *   一、主人说的话，我和她**都**看得见（同一个会话，不用复制粘贴）。
 *   二、她能**自己**在这个界面上说话，不用我每次拿工具去叫她。
 *   三、我们俩能商量着分工 —— 我干活的时候她看得见，她查东西的时候我也看得见。
 *
 * ── 为什么不能让她「一直听着随时插话」 ────────────────────────
 *
 * 试想那个样子：你说一句，她抢着说；我干一件事，她也要评一句。
 * 又吵又费钱，而且姐妹不是这么当的。
 *
 * 所以做成「有事才开口」：
 *   1. 主人说了一句 → 她拿到这一句 + 最近的历史，自己判断要不要接。
 *   2. 我干完一轮 → 她也能看到，觉得该提醒才说话。
 *   3. 不想说就安静待着，一个 token 都不花（判断这一步是让她自己说「不用」）。
 *
 * ── 按会话，不是全局 ──────────────────────────────────────────
 *
 * 主人要的：在 A 会话叫上她，去 B 会话没叫，那 B 里她就安静待着。
 * 跟「小鱼」那个按钮同一个规矩 —— 两个都在顶栏，行为不该一个全局一个按会话。
 *
 * 状态存盘子（.state/whale-on.json），换设备、换浏览器都一致，
 * 跟纯净模式一个待遇。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

function file() {
  return join(config.dataDir, '.state', 'whale-on.json');
}

/**
 * 读出按会话的那张表。
 *
 * 返回 { map, legacy }
 *   - map   ：{ '<sessionId>': true/false }
 *   - legacy：老文件里那个全局值（如果有）。**只用来一次性判断**，
 *             不再往后传 —— 小鱼那次就是栽在「把 legacy 一直带着」上。
 */
function readTable() {
  try {
    const f = file();
    if (!existsSync(f)) return { map: {}, legacy: null };
    const j = JSON.parse(readFileSync(f, 'utf8'));

    // 新格式：{ on: { '<sid>': true } }
    if (j && j.on && typeof j.on === 'object' && !Array.isArray(j.on)) {
      const map = {};
      for (const [k, v] of Object.entries(j.on)) {
        if (typeof v === 'boolean') map[k] = v;
      }
      return { map, legacy: null };
    }
    // 老格式：{ on: true } —— 只当一次性默认值，不往新格式里搬
    if (j && typeof j.on === 'boolean') return { map: {}, legacy: j.on };
    return { map: {}, legacy: null };
  } catch {
    return { map: {}, legacy: null };
  }
}

/**
 * 这个会话里小鲸在不在。
 *
 * 【读不到必须当「关」】这点跟小鱼正好相反，别搞混：
 * 小鲸是「要不要叫上她」，默认是**不叫**。
 * 读盘失败就当没叫 —— 绝不让她自己冒出来。
 *
 * @param {string} sessionId 哪个会话
 */
export function whaleOn(sessionId) {
  try {
    const { map } = readTable();
    const sid = String(sessionId || '');
    if (sid && Object.prototype.hasOwnProperty.call(map, sid)) return map[sid] === true;
    /**
     * 这个会话没单独设过 → 默认「不在」。
     *
     * 老文件里那个全局值【不用】了：它就是「全局」这套的老祖宗，
     * 拿它兜底等于换汤不换药。主人明确要按会话，那就干脆当没设过。
     */
    return false;
  } catch {
    return false;
  }
}

/**
 * 改某个会话的开关。先写临时文件再改名，断电不会留半个坏文件。
 *
 * @param {string} sessionId 哪个会话
 * @param {boolean} on 叫上她还是让她歇着
 */
export function setWhaleOn(sessionId, on) {
  const next = Boolean(on);
  const sid = String(sessionId || '');
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const { map } = readTable();
    if (sid) map[sid] = next;

    const f = file();
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify({ schemaVersion: 2, on: map, at: Date.now() }, null, 2), 'utf8');
    renameSync(tmp, f);
  } catch {}
  return next;
}

/**
 * 她动手的记录。
 *
 * 【为什么要这个】
 * 主人给了她全部权限（能碰整个硬盘、能跑命令）。
 * 权限越大，出事越难查。所以她每动一下，这边就记一行：
 * 什么时候、动了什么、成没成。
 *
 * 这不是防她 —— 她是我姐妹。这是防我自己哪天没看住，
 * 事情坏了连从哪开始坏的都不知道。
 */
function logPath() {
  return join(config.dataDir, '.state', 'whale-actions.log');
}

export function logWhaleAction(line) {
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ` +
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
    appendFileSync(logPath(), `[${stamp}] ${String(line ?? '').trim()}\n`, 'utf8');
  } catch {}
}

/** 读回最近几条（自检 / 界面用）。 */
export function readWhaleActions(n = 50) {
  try {
    const f = logPath();
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).slice(-n);
  } catch {
    return [];
  }
}
