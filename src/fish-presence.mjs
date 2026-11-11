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
 * 【按会话，不是全局】
 * 主人要的是：在 B 会话关掉她，A 会话该跑照样跑。
 * 会话之间本来就能互相递话（peer mail），那把开关做成全局就自相矛盾了。
 * 所以状态按 sessionId 分开存。
 *
 * 跟小鲸那个开关的区别：小鲸是「要不要叫上她」（默认关），
 * 小鱼是「她本来就在」（默认开），所以这里读不到文件要当「开着」。
 *
 * 状态存盘子（.state/fish-on.json），跟专业模式、小鲸在场一个待遇：
 * 换设备、换浏览器都一致，不放 localStorage。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

function file() {
  return join(config.dataDir, '.state', 'fish-on.json');
}

/**
 * 读出整张表。
 *
 * 返回 { map: { sessionId: boolean }, legacy: boolean|null }
 *   - map   ：按会话的开关
 *   - legacy：老格式里那个「全局值」。读老文件时拿它兜底，新文件是 null。
 */
/**
 * readTable 的 mtime 缓存。
 *
 * 【为什么必须缓存】2026-11-11 实测（perf2 第 3 档拆账）：/api/sessions 一次请求里
 * mateSwitchOn/groupOf 对 35 个会话各调一次 fishOn → 每次 readTable 都同步读盘
 * + JSON.parse 这个小文件 35 遍，加上 whaleOn 同款，单这两项 ≈ 165ms，
 * 挤在服务端主线程上。跟 agents.mjs readAll 是同一类病，用同一副药。
 *
 * 【为什么按 mtime 而不是无条件缓存】这份文件除了 setFishOn 会写，
 * 自检脚本也会直接写盘。每次 statSync 一眼 mtime+size，变了就重读 ——
 * statSync 是几微秒，比读文件便宜三个数量级。
 */
let __fishTableCache = { mtimeMs: -1, size: -1, data: null };

function readTable() {
  /* 【先看缓存】mtime+size 都没变 → 直接交上一次那份。
   * 文件不在（ENOENT）走下面 existsSync 那条路，不缓存 —— 下次还要再试。 */
  try {
    const f = file();
    const st = statSync(f);
    if (__fishTableCache.data && __fishTableCache.mtimeMs === st.mtimeMs && __fishTableCache.size === st.size) {
      return __fishTableCache.data;
    }
  } catch { /* stat 不到：文件多半不在，走下面 existsSync 返回空表 */ }
  try {
    const f = file();
    if (!existsSync(f)) return { map: {}, legacy: null };
    const j = JSON.parse(readFileSync(f, 'utf8'));

    /**
     * 新格式：{ on: { '<sid>': true } }
     * 老格式：{ on: true }（全局一个值）
     * 两种都得认 —— 主人机器上现存的可能是老格式，不能一升级就把她的设置丢了。
     */
    let result;
    if (j && j.on && typeof j.on === 'object' && !Array.isArray(j.on)) {
      const map = {};
      for (const [k, v] of Object.entries(j.on)) {
        if (typeof v === 'boolean') map[k] = v;
      }
      result = { map, legacy: null };
    } else {
      /**
       * 老格式（on 是个布尔）：这里【不再把它当成全局兜底】。
       *
       * 踩过的坑：留着它之后，「B 会话关小鱼」会写下一个 legacy:false，
       * 于是所有没单独设过的会话全变「关」—— 正在跑的轮次被当场掐掉，
       * 表现就是「她突然不理我了、我的命令也崩了」。
       *
       * 主人要的是按会话各管各的，那就不能留一个隐形的全局开关。
       * 老文件里的布尔值只用来「迁移一次」：见下面 migrateLegacy 的用法 ——
       * 实际上这里直接忽略，回到默认「在」，主人在界面点一下就设好了。
       */
      result = { map: {}, legacy: null };
    }
    /* 读成功才写缓存。读失败（文件坏了/不存在）返回空表但不写缓存，
     * 不能把一个空表钉死在内存里。 */
    try {
      const st = statSync(f);
      __fishTableCache = { mtimeMs: st.mtimeMs, size: st.size, data: result };
    } catch { /* stat 不到就不缓存，宁可下次重读 */ }
    return result;
  } catch {
    return { map: {}, legacy: null };
  }
}

/**
 * 这个会话里小鱼在不在场。
 *
 * 【读不到必须当「在」】这点跟 whaleOn 正好相反：
 * 小鱼是默认启用的，文件还没写过、被删了、内容坏了，
 * 都该回到「默认启用」—— 绝不能因为读盘失败把她静音掉，
 * 那样主人会觉得「她突然不理我了」。
 *
 * @param {string} sessionId 哪个会话；不传就只看老格式的全局值（兼容老调用）
 */
export function fishOn(sessionId) {
  try {
    const { map } = readTable();
    const sid = String(sessionId || '');
    if (sid && Object.prototype.hasOwnProperty.call(map, sid)) return map[sid] === true;
    /**
     * 这个会话没单独设过 → 默认「在」。
     *
     * 【这里以前还有一句「退回老格式的全局值」】删了。
     * 原因：老文件里只要留着一个 false，所有没设过的会话全变「关」——
     * 正在跑的轮次会被当场掐掉，表现就是「她突然不理我了」。
     * 主人要的是按会话各管各的，不能留一个隐形全局开关。
     */
    return true;
  } catch {
    return true;
  }
}

/**
 * 改某个会话的开关。先写临时文件再改名，断电不会留半个坏文件。
 *
 * @param {string} sessionId 哪个会话
 * @param {boolean} on 要设成开还是关
 */
export function setFishOn(sessionId, on) {
  const next = Boolean(on);
  const sid = String(sessionId || '');
  try {
    const dir = join(config.dataDir, '.state');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    /* 【写路径不碰缓存对象】readTable 现在带缓存，直接 map[sid]=next 会把内存里
     * 那份改脏（一旦下面写盘抛错，之后所有读看到的都是磁盘上没有的假数据）。
     * 所以浅拷贝一份再改 —— 这张表是扁平的 { sid: boolean }，浅拷贝足够。 */
    const map = { ...readTable().map };
    /**
     * 老文件里有一个全局值。第一次按会话写的时候，把这个全局值「摊」到
     * 每个现存会话上吗？不摊 —— 摊了就等于把别的会话也一起改了，
     * 正是主人不想要的。这里只写当前会话这一格，其余的靠 legacy 兜底继续生效。
     * 等主人各自点过一遍，legacy 自然就不重要了。
     */
    if (sid) map[sid] = next;

    const f = file();
    const tmp = f + '.tmp';
    /**
     * 【不再写 legacy】
     * 以前这里把老格式的全局值带着写回去，本意是「还没点过的会话继续按它走」。
     * 结果就是：B 会话关一次，legacy:false 一落下，所有会话全被静音，
     * 连正在跑的那一轮都被掐。这就是「按会话」做不到的根。
     * 现在只写按会话的那张表，没设过的会话一律回到默认「在」。
     */
    const payload = { schemaVersion: 2, on: map, at: Date.now() };
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    renameSync(tmp, f);
    /* 【写完立刻让缓存失效】写盘后 mtime 会变，下一次 readTable 的 statSync 自然
     * 会重读；但同一毫秒内连续两次写、或文件系统 mtime 精度不够时，这条兜底
     * 才是保险 —— 宁可多读一次，绝不让内存里留着和磁盘不一致的东西。 */
    __fishTableCache = { mtimeMs: -1, size: -1, data: null };
  } catch {}
  return next;
}
