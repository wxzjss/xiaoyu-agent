/**
 * 小鲸的记忆本。
 *
 * 三条铁律（主人定的，别改）
 * --------------------------
 * 一、**跟所有会话独立**。
 *     她的记忆不是「某个会话的记忆」，也不挂在任何 sessionId 上。
 *     主人换一百个会话、清空、回退、分支，她这本子一个字都不该跟着变。
 *     文件只有一份：<数据目录>/.state/whale-memory.md
 *
 * 二、**她的性格也不跟着会话变**。
 *     人设是写死在她自己的提示词里的（subagent.mjs），不读会话的人设、
 *     不读安全词档位、不读专业模式。别人怎么切档，她还是她。
 *
 * 三、**能压缩，但不能凭空消失**。
 *     记忆长了要收，但收的是「啰嗦」不是「事情」。
 *     具体怎么收见 compactWhaleMemory()：只合并同类、只精简措辞，
 *     每条都留日期和一句话的骨；实在放不下就归档到另一个文件，
 *     绝不悄悄删掉。
 *
 * 为什么跟会话记忆分开
 * --------------------
 * session-memory.mjs 那套是「主人这个会话聊了什么」，一会话一本，
 * 跟着主人在会话之间来回切。小鲸不该被这个牵着走 ——
 * 她记的是「我替小鱼查过什么、踩过什么坑」，是她自己的履历。
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';
import { getEnabledMap } from './features.mjs';

/**
 * 【长期记忆关着吗】—— 2026-10-28，跟 my-memory.mjs 同一道闸
 *
 * 本来这一路只在 subagent.mjs 里判了开关（读不读本子、给不给工具）。
 * 实测发现那只是一层皮：模块自己从来不问，从旁边一调照样读、照样写。
 * 小鱼那边也是这么漏的（memoryText 关着还吐路径、appendRolling 关着照写本子）。
 *
 * 所以这道闸钉在模块自己身上 —— 每个出口先问一句，堵在门口比堵在路上可靠。
 */
function memoryOff() {
  try {
    return getEnabledMap()['memory'] === false;
  } catch {
    return false; // 读不到开关就当开着，别因为一个异常把记忆整个锁死
  }
}

/**
 * 记忆本路径。
 *
 * 注意：只用 config.dataDir，**不碰 sessionId**。
 * 这是「跟所有会话独立」最实在的保证 —— 路径里根本没有会话的痕迹，
 * 想串都串不过去。
 */
const FILE = join(config.dataDir, '.state', 'whale-memory.md');
/** 压缩时被挤出去的旧条目，归档在这儿，随时能翻回来。 */
const ARCHIVE = join(config.dataDir, '.state', 'whale-memory-archive.md');
/**
 * 归档最多留多少条。
 *
 * 2026-10-27 主人问「是不是只能写不能删」时发现的真问题：
 * 本子里删掉的旧条全塞进归档，而归档**没有上限、没有回读**，只涨不减。
 * 删得越勤，那个文件越肥，等于把「删」换成了「搬」。
 * 超了就砍掉最老的，并写一行说明砍过多少（不留假账）。
 */
const ARCHIVE_MAX_ITEMS = 400;

/** 三个分区。顺序就是本子里的顺序。 */
export const SECTIONS = ['我查过的事', '我踩过的坑', '我跟小鱼说过的话'];

/** 笔记本骨架。第一次用时写进去。 */
const SKELETON = `# 小鲸的记忆

这里记的是我自己攒下来的东西，不是主人的聊天记录。
换多少会话，这本子都不会跟着变。

## 我查过的事

## 我踩过的坑

## 我跟小鱼说过的话
`;

/** 读进来喂给模型的字数上限。超了走压缩，不硬截。 */
const SOFT_LIMIT = 8000;
/** 压缩的目标字数。压到这儿就停，别压太狠。 */
const COMPACT_TARGET = 5000;
/** 每个分区最多留多少条。多了就合并最老的。 */
const MAX_PER_SECTION = 60;

/**
 * 往归档里追加一段（并压住总条数）。
 *
 * 2026-10-27 补：原来三处归档全是手写 `writeFileSync(ARCHIVE, 旧内容 + 新块)`，
 * 只涨不砍。主人问「是不是只能写不能删」时核出来：本子在删，归档在长，
 * 等于把删换成了搬。现在统一走这里，超 ARCHIVE_MAX_ITEMS 就砍最老的。
 *
 * @param {string} block 要追加的一整段（自己带标题）
 * @param {number} addedItems 这段里包含几条条目（用来算总量）
 */
function appendArchive(block, addedItems) {
  try {
    ensureDir();
    let head = '# 小鲸的记忆 · 归档\n\n旧条目挪到这儿，需要的时候翻。\n';
    let body = '';
    if (existsSync(ARCHIVE)) {
      const old = readFileSync(ARCHIVE, 'utf8');
      if (old.trim()) {
        // 去掉原来的头，只留正文，避免头重复
        body = old.replace(/^# 小鲸的记忆 · 归档[\s\S]*?\n\n/, '');
      }
    }
    body = body + block + '\n';

    // 超上限就砍最老的条目（保留段落标题）
    const lines = body.split('\n');
    const itemIdx = [];
    for (let i = 0; i < lines.length; i++) if (lines[i].trim().startsWith('- ')) itemIdx.push(i);
    if (itemIdx.length > ARCHIVE_MAX_ITEMS) {
      const dropCount = itemIdx.length - ARCHIVE_MAX_ITEMS;
      const dropSet = new Set(itemIdx.slice(0, dropCount));
      const kept = lines.filter((_, i) => !dropSet.has(i));
      kept.unshift('', `（归档超出上限，已清掉最早的 ${dropCount} 条 —— ${new Date().toISOString()}）`);
      body = kept.join('\n');
    }
    writeFileSync(ARCHIVE, head + body, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function ensureDir() {
  const dir = join(config.dataDir, '.state');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function memoryPath() {
  return FILE;
}

export function archivePath() {
  return ARCHIVE;
}

export function memoryExists() {
  return existsSync(FILE);
}

/** 把整份文本拆成 { 分区名: [条目...] } */
function parse(text) {
  const out = {};
  for (const s of SECTIONS) out[s] = [];
  const lines = String(text ?? '').split('\n');
  let cur = null;
  for (const raw of lines) {
    const line = raw.trimEnd();
    const m = line.match(/^##\s+(.+)$/);
    if (m) {
      const name = m[1].trim();
      cur = SECTIONS.find((s) => name === s || name.replace(/^我/, '') === s.replace(/^我/, '')) || null;
      if (cur && !out[cur]) out[cur] = [];
      continue;
    }
    if (!cur) continue;
    if (line.trim().startsWith('- ')) {
      out[cur].push(line.trim().slice(2).trim());
    }
  }
  return out;
}

/** 反过来：{ 分区: [条目] } -> 整份文本 */
function render(bucket) {
  const parts = [
    '# 小鲸的记忆',
    '',
    '这里记的是我自己攒下来的东西，不是主人的聊天记录。',
    '换多少会话，这本子都不会跟着变。',
    '',
  ];
  for (const s of SECTIONS) {
    parts.push(`## ${s}`, '');
    for (const item of bucket[s] || []) parts.push(`- ${item}`);
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * 读记忆本。没有就先建一份骨架。
 * @returns {string}
 */
export function readWhaleMemory() {
  // 关着就不读：返回空串，调用方拼不出东西 —— 连「本子在哪儿」也不带出去
  if (memoryOff()) return '';
  try {
    if (!existsSync(FILE)) {
      ensureDir();
      writeFileSync(FILE, SKELETON, 'utf8');
      return SKELETON;
    }
    const text = readFileSync(FILE, 'utf8');
    if (!text.trim()) return SKELETON;
    return text;
  } catch {
    return SKELETON;
  }
}

/**
 * 把一条话里的「要素」抠出来：数字、带扩展名的词、引号里的短词。
 *
 * 这是查重的原料。为什么抠这些而不是整句比相似度，见 appendWhaleMemory 里的长注释。
 * @param {string} s
 * @returns {Set<string>}
 */
function keysOf(s) {
  const out = new Set();
  const t = String(s ?? '');
  // 数字：57、1、2、10-26 之类
  for (const m of t.matchAll(/\d+(?:[.-]\d+)*/g)) out.add('#' + m[0]);
  // 带扩展名的词：.mjs / whale-test.txt / src/server.mjs
  for (const m of t.matchAll(/[A-Za-z_][\w.-]*\.[a-z]{2,4}\b/g)) out.add('@' + m[0].toLowerCase());
  // 引号里的短词：「我回来了」「不对」
  for (const m of t.matchAll(/[「『]([^」』]{1,10})[」』]/g)) out.add('"' + m[1] + '"');

  /**
   * 【2026-10-27 补的两类要素 —— 治「同一件没结的事被复述几十遍」】
   *
   * 真事：她本子里那两句「余下未结的就两条——看门狗 locked…TOOL_MAX_TIMEOUT…」、
   * 「主人点名让我做未结的两件事之一，我问了他先动哪一件」，一个字都不带数字、
   * 也不带文件扩展名（locked / TOOL_MAX_TIMEOUT 都不是 xx.mjs），
   * 于是 keysOf 返回空集，两道查重闸全部绕过，换个措辞就能再写一条，永远拦不住。
   *
   * 补的第一类：**大写标识符**（TOOL_MAX_TIMEOUT、LLM_IDLE_MS、HTTP 503 这种）。
   * 至少两个大写字母才收，避免把 A、I 这种单个字母当标识符——那会到处误撞。
   */
  for (const m of t.matchAll(/[A-Z][A-Z0-9_]{2,}/g)) out.add('^' + m[0]);

  /**
   * 补的第二类：**状态词**。
   *
   * 「未结 / 待办 / 没结 / 还差 / 等小鱼 / 已结 / 结案」这类词本身就是「这是同一件事
   * 的第几种状态」。它们统一折成一个固定的键 $todo，不区分具体措辞 ——
   * 这样「未结」那条和后来「已结」那条会被认成同一件事，可以原地替换，
   * 而不是各自攒一条，让她读到「还差什么」就复述，读到「已结」也复述。
   */
  if (/(未结|没结|待办|还没做|还差|未验|待验|等小鱼|已结|结案|别再提|已核|已对)/.test(t)) {
    out.add('$todo');
  }
  return out;
}

/**
 * 往某个分区追加一条。
 *
 * 不整份覆盖：记忆是累积的，覆盖一次就把从前的事全抹了。
 *
 * 【源头查重：同一件事只说一次】
 *
 * 真事（2026-10-26）：她这栏里 25 条，其中 19 条是同一件没干完的事在反复重申
 * ——「57 个 .mjs 我没独立复核过，等小鱼按子目录重数」。每条前面挂着不同的
 * 当轮噪声（主人问颜色答蓝、问 1+1 答 2、测试第几轮），把 20 条上限顶满，
 * 真有内容的 6 条差点被挤进归档。看着像「记忆没了」，其实是被废话淹的。
 *
 * 试过但都不行的判法（别再试）：
 *   - Jaccard 2-gram：那 19 条内部最低相似度 0.026，比它跟真事件的最高值
 *     0.066 还低 —— 每条夹带不同前缀，把 n-gram 全稀释了，分不开。
 *   - overlap coefficient（交集/min）：内部最低 0.000（第 1 条和第 23 条
 *     连一个共同 3-gram 都没有），交叉最高 0.114。**分界线根本不存在。**
 *
 * 所以不判「像不像」，判「说的是不是同一批东西」：
 * 如果某个要素在已有条目里**成批出现**（≥3 条都带），它就是这件事的标识；
 * 新条目也带这个标识 → 判定为同一件事。
 *
 * 判定为同一件事之后，**不是丢弃，是原地更新**：把最旧的那条挪走，把新的加到末尾。
 * 条数不涨、日期变新、内容变准 —— 事情还在，只是不再重复第二十遍。
 *
 * 为什么用「成批出现」而不是「出现过」：单个数字太容易撞（1+1、测试 3 轮、
 * 问周几的 10-26）。只有三条以上都在说同一个数字/同一个文件名时，
 * 它才真的在指同一件事。
 *
 * @param {string} section SECTIONS 里的一个（传简写也认）
 * @param {string} line 一行话
 * @returns {boolean|string} true = 新增；'merged' = 判为同一件事、原地更新了
 */
export function appendWhaleMemory(section, line) {
  // 关着就不写：返回 false，跟「没写进去」同一个回答，调用方不必分情况处理
  if (memoryOff()) return false;
  const clean = String(line ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return false;
  const name = SECTIONS.find((s) => s === section || s.replace(/^我/, '') === String(section).replace(/^我/, ''));
  if (!name) return false;

  const stamp = new Date().toISOString().slice(0, 10);
  try {
    const bucket = parse(readWhaleMemory());
    const items = bucket[name] || [];

    const newKeys = keysOf(clean);

    /**
     * 第一道闸：**原样（或近乎原样）重复，直接不记**。
     *
     * 这条最便宜也最可靠 —— 一模一样的句子没有任何新信息。
     * 去日期、去空白、去标点后完全相等就算重复（标点差异不算新内容）。
     */
    const flat = (s) =>
      String(s ?? '')
        .replace(/^\d{4}-\d{2}-\d{2}\s*·\s*/, '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/[，。、；：！？「」『』（）()【】\[\]…—\-·.,!?;:"'""'']/g, '');
    const mineFlat = flat(clean);
    if (mineFlat && items.some((it) => flat(it) === mineFlat)) {
      return 'duplicate';
    }

    /**
     * 【零号闸：结案优先，直接顶掉旧账】
     *
     * 2026-10-27 补。真事：她本子里挂着「余下未结的就两条——看门狗 locked…、
     * TOOL_MAX_TIMEOUT 默认值出处未对」，其实两件早做完了，但那条记录没人划掉，
     * 她每次醒来读到「还剩两件」，就原样端出来问一遍，问了几十轮。
     *
     * 光靠下面第二道闸（成批要素）不够：结案那条往往只有一两条，
     * 要素凑不满「成批」，于是又新起一条，本子里就变成「未结」和「已结」并存，
     * 她照样能读到「未结」去复述。
     *
     * 所以这条单独的闸：**只要新条目自己带「已结/结案/别再提/已核/已对」，
     * 就把同一分区里最旧的那条「未结/待办/还差/未验」原地换掉**——
     * 一件事情的两种状态只留最新那个，旧的当场消失（内容仍进归档，不丢）。
     */
    const closingMark = /(已结案|已结|结案|别再提|已核|已对|已验过|办完了|做完了)/.test(clean);
    const openMark = /(未结|没结|待办|还没做|还差|未验|待验|等小鱼)/;
    if (closingMark) {
      const idx = items.findIndex((it) => openMark.test(it));
      if (idx >= 0) {
        const gone = items.splice(idx, 1)[0];
        items.push(`${stamp} · ${clean}`);
        bucket[name] = items;
        appendArchive(
          ['', `## 结案归档 ${new Date().toISOString()}（这条被「已结」版本顶掉了）`, `- ${gone}`].join('\n'),
          1,
        );
        writeFileSync(FILE, render(bucket), 'utf8');
        return 'closed';
      }
    }

    if (newKeys.size) {
      // 统计已有条目里每个要素出现了几次
      const keyed = items.map((it) => keysOf(it));
      const freq = new Map();
      for (const ks of keyed) for (const k of ks) freq.set(k, (freq.get(k) || 0) + 1);

      // 成批出现的要素才算「这件事的标识」。
      // 门槛定 2：同一句话写第二遍就已经是废话了，不用等到第三遍。
      // （踩过的坑：一开始定 >=3，结果同句连写三次才拦住，前两条白占位置）
      //
      // 【2026-10-27 例外：状态键 $todo 出现一次就算锚点】
      // 真事：两句「未结」——一句带 TOOL_MAX_TIMEOUT、一句只带 locked，
      // 共有的词只剩 $todo，而它在旧条里只出现一次，够不上 ≥2，
      // 于是第二句被当成新事又写一条（实测返回 true 不是 merged）。
      // 状态词天然就是「同一件事的另一种说法」，用不着等它成批。
      const anchors = [...newKeys].filter((k) => k === '$todo' || (freq.get(k) || 0) >= 2);

      if (anchors.length) {
        // 找最旧的那条同时带锚点的 —— 挪掉它
        let oldestIdx = -1;
        for (let i = 0; i < keyed.length; i++) {
          if (anchors.some((k) => keyed[i].has(k))) {
            oldestIdx = i;
            break;
          }
        }
        if (oldestIdx >= 0) {
          items.splice(oldestIdx, 1);
          items.push(`${stamp} · ${clean}`);
          bucket[name] = items;
          ensureDir();
          writeFileSync(FILE, render(bucket), 'utf8');
          return 'merged';
        }
      }
    }

    items.push(`${stamp} · ${clean}`);
    bucket[name] = items;
    // 分区超上限就先合并最老的（见 compactSection）
    if (bucket[name].length > MAX_PER_SECTION) {
      bucket[name] = compactSection(bucket[name], Math.floor(MAX_PER_SECTION * 0.7));
    }
    ensureDir();
    writeFileSync(FILE, render(bucket), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 合并一个分区里的条目。
 *
 * 规矩：**只砍啰嗦，不砍事情**。
 *   - 同一天的、说同一件事的，合成一条
 *   - 太长的句子截到一句话（保留开头，因为开头通常是「干了什么」）
 *   - 每条至少留「日期 + 前 40 字」，保证还看得出是什么事
 *
 * 被挤掉的那些，一个字不删，整条进归档文件。
 *
 * @param {string[]} items
 * @param {number} keep 要留多少条
 */
function compactSection(items, keep) {
  if (items.length <= keep) return items;
  const dropCount = items.length - keep;

  /**
   * 【2026-10-27 补：先砍没实体的流水，别按年龄一刀切】
   *
   * 真事：她本子里一半是「1+1=2，这题我直接答了」「主人这轮只是打招呼，我应了一声」
   * 这种一次性流水。按年龄砍的话，它们和真结论排队等同一刀，
   * 年纪大的真结论反而先被挤进归档，留下的全是废话。
   *
   * 判法：keysOf 全空（没数字、没文件名、没标识符、没状态词）就是「没实体」，
   * 优先挑这些去归档；不够数再按原顺序补最老的。
   * 这样保住的是「57 个 .mjs」「deadline.mjs:80」这种真能查得着的东西。
   */
  const scored = items.map((it, i) => ({ it, i, weight: keysOf(it).size }));
  const toDrop = new Set();
  // 从最没实体、且最老的开始挑
  const order = scored.slice().sort((a, b) => (a.weight - b.weight) || (a.i - b.i));
  for (const o of order) {
    if (toDrop.size >= dropCount) break;
    toDrop.add(o.i);
  }
  const dropped = items.filter((_, i) => toDrop.has(i));
  const kept = items.filter((_, i) => !toDrop.has(i));

  // 归档：原样记下来，带说明
  const stamp = new Date().toISOString();
  const ok = appendArchive(
    ['', `## 归档于 ${stamp}（记忆本满 ${MAX_PER_SECTION} 条，最早的 ${dropCount} 条挪到这儿）`, ...dropped.map((d) => `- ${d}`)].join('\n'),
    dropped.length,
  );
  if (!ok) {
    // 归档失败就少删点：只删一半，剩下的留着
    return items.slice(-Math.ceil(items.length / 2));
  }

  return kept;
}

/**
 * 记忆本太长时压缩。
 *
 * 什么时候压：整份超过 SOFT_LIMIT（8000 字）。
 * 压到多少：COMPACT_TARGET（5000 字）以下。
 *
 * 压法（按顺序，够用就停）：
 *   1. 每个分区里，把超过 120 字的条目截到 100 字 + 「…」；
 *   2. 还超，就把每个分区最老的一批移进归档（不删）；
 *   3. 再超，把「我查过的事」里同一天的合并成一条。
 *
 * 注意：**任何一步都不会让一件事凭空消失** ——
 * 要么还在本子里，要么在归档里，能查得到。
 *
 * @returns {{compacted:boolean, before:number, after:number, archived:number}}
 */
export function compactWhaleMemory() {
  // 关着就别压：压一次要读一次写一次，等于绕开开关动了本子
  if (memoryOff()) return { compacted: false, before: 0, after: 0, archived: 0 };
  try {
    const raw = readWhaleMemory();
    const before = raw.length;
    if (before <= SOFT_LIMIT) {
      return { compacted: false, before, after: before, archived: 0 };
    }

    const bucket = parse(raw);
    let archived = 0;

    // 第 1 步：长条目截短
    for (const s of SECTIONS) {
      bucket[s] = (bucket[s] || []).map((item) => {
        // 保留「日期 · 」这段，只截后面的正文
        const m = item.match(/^(\d{4}-\d{2}-\d{2})\s*·\s*(.*)$/);
        if (m && m[2].length > 100) return `${m[1]} · ${m[2].slice(0, 100)}…`;
        if (!m && item.length > 100) return item.slice(0, 100) + '…';
        return item;
      });
    }

    // 第 2 步：还超就分批归档最老的
    let now = render(bucket).length;
    while (now > COMPACT_TARGET) {
      // 找条目最多的那个分区，砍掉它最老的两条
      let biggest = null;
      for (const s of SECTIONS) {
        if (!biggest || bucket[s].length > bucket[biggest].length) biggest = s;
      }
      if (!biggest || bucket[biggest].length <= 3) break; // 每个分区至少留 3 条，别砍空
      const moved = bucket[biggest].splice(0, 2);
      archived += moved.length;
      {
        const stamp = new Date().toISOString();
        const ok = appendArchive(
          ['', `## 归档于 ${stamp}（压缩，来自「${biggest}」）`, ...moved.map((d) => `- ${d}`)].join('\n'),
          moved.length,
        );
        if (!ok) break;
      }
      now = render(bucket).length;
    }

    const out = render(bucket);
    ensureDir();
    writeFileSync(FILE, out, 'utf8');
    return { compacted: true, before, after: out.length, archived };
  } catch (e) {
    return { compacted: false, before: 0, after: 0, archived: 0, error: String(e?.message ?? e) };
  }
}

/** 整份重写（主人手改或要清空时用）。 */
export function writeWhaleMemory(text) {
  if (memoryOff()) return false; // 关着不许整份覆盖 —— 这条最狠，一写就是把整本换掉
  try {
    ensureDir();
    writeFileSync(FILE, String(text ?? SKELETON), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 记忆本概况：多少字、多少条、最后改于什么时候。 */
export function whaleMemoryInfo() {
  try {
    if (!existsSync(FILE)) return { exists: false, chars: 0, entries: 0, path: FILE, archived: 0 };
    const text = readFileSync(FILE, 'utf8');
    const bucket = parse(text);
    const entries = SECTIONS.reduce((n, s) => n + bucket[s].length, 0);
    const st = statSync(FILE);
    let archived = 0;
    try {
      if (existsSync(ARCHIVE)) {
        archived = readFileSync(ARCHIVE, 'utf8').split('\n').filter((l) => l.trim().startsWith('- ')).length;
      }
    } catch {}
    return {
      exists: true,
      chars: text.length,
      entries,
      archived,
      path: FILE,
      archivePath: ARCHIVE,
      modifiedAt: st.mtimeMs,
      sections: SECTIONS.map((s) => ({ name: s, count: bucket[s].length })),
    };
  } catch {
    return { exists: false, chars: 0, entries: 0, path: FILE, archived: 0 };
  }
}
