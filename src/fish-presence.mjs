/**
 * 小鱼「在场」这个状态（顶栏那个「小鱼」按钮）。
 *
 * ── 主人要的是什么 ────────────────────────────────────────────
 *
 * 顶栏「小鱼」按钮，默认开着、一直亮着。点一下就禁用它，禁用之后：
 *   一、这个会话后面主人说的话，小鱼一条都收不到（等于她不在场）。
 *   二、小鲸说的话她也看不到。
 *   三、这些内容不进她的会话记忆。
 *
 * 也就是说「她没被叫来」跟「她压根不在这个屋」是一回事 —— 不是假装没看见，
 * 而是真的一个字都不发给她。所以她恢复之后也不会补课、不会假装记得。
 *
 * 跟小鲸那个开关的区别：小鲸是「要不要叫上她」（默认关），
 * 小鱼是「她本来就在」（默认开），所以这里读不到文件要当「开着」。
 *
 * 状态存盘子（.state/fish-on.json），跟纯净模式、小鲸在场一个待遇：
 * 换设备、换浏览器都一致，不放 localStorage。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

function file() {
  return join(config.dataDir, '.state', 'fish-on.json');
}

/**
 * 小鱼现在在不在场。
 *
 * 【读不到必须当「在」】这点跟 whaleOn 正好相反：
 * 小鱼是默认启用的，文件还没写过、被删了、内容坏了，
 * 都该回到「默认启用」—— 绝不能因为读盘失败把她静音掉，
 * 那样主人会觉得「她突然不理我了」。
 */
export function fishOn() {
  try {
    const f = file();
    if (!existsSync(f)) return true;
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (j && typeof j.on === 'boolean') return j.on;
    return true;
  } catch {
    return true;
  }
}

/** 改开关。先写临时文件再改名，断电不会留半个坏文件。 */
export function setFishOn(on) {
  const next = Boolean(on);
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const f = file();
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify({ on: next, at: Date.now() }, null, 2), 'utf8');
    renameSync(tmp, f);
  } catch {}
  return next;
}
