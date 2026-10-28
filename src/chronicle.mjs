/**
 * 岁月史书 —— 把所有会话的全部内容记下来，让她随时能翻，但不是一股脑全塞给她。
 *
 * ────────────────────────────────────────────────────────────────
 * 主人的原话（2026-10-28）：
 *   「增加一个新功能：岁月史书。自动记录所有会话的全部上下文内容，
 *     ai可随时翻阅，但翻阅方式不能一股脑全看，而是能够支持索引，
 *     ai能搜索关键字，甚至可以有目录，有分类这样的，具体你可以自己想」
 * ────────────────────────────────────────────────────────────────
 *
 * 【为什么不能直接读会话 json】
 *
 * 每个会话文件就是一个大 json，最长的 2MB、1477 条消息。让她 read_file 读那个，
 * 一次就是几万 token —— 而且 json 里的转义（\n、\\、\"）会把内容埋掉，
 * 她根本没法在上面搜东西。更别说「搜索所有会话」：得把 26 个文件全读一遍。
 *
 * 【所以：一次建库，之后全是查】
 *
 *   <dataDir>/.state/chronicle/
 *       manifest.json          全书目录（每个会话一条：标题/时间/条数/分类/词表大小）
 *       docs/<sid>.jsonl       该会话逐条记录，一行一条（便于按行定位、增量追加）
 *       index/<sid>.json       该会话的倒排索引：词 → 命中行号
 *
 * 建库是增量的：manifest 里记着每个会话的 updatedAt 和消息数，
 * 没变过的会话直接跳过，不为了一条新消息重编全书。
 *
 * 【三层翻阅，绝不一次全给】
 *
 *   1. 目录  chronicle_toc      → 有哪些会话、按什么分、每本多厚。几十行。
 *   2. 搜索  chronicle_search   → 关键字/正则 → 命中行的【摘要片段】，不是全文。
 *                                 带会话、第几条、角色、前后若干字。
 *   3. 精读  chronicle_read     → 给定会话 + 行号区间，读那一段原文。
 *                                 **必须带范围**，不给范围就报错让她先窄下来。
 *
 * 【为什么用行号而不是「第几条消息」】
 *
 * 一条 assistant 消息可能带 tool_calls、可能被拆成多段。
 * 用「行号」当定位锚点，跟磁盘上的 jsonl 一一对应，读的时候直接按行切，
 * 既不用重新解析整个 json，也不会因为消息结构变了而错位。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

/** 一次搜索最多回多少条命中 —— 多了就等于「一股脑全看」。 */
const MAX_HITS = 30;
/** 每条命中给多少字的上下文片段。 */
const SNIPPET_PAD = 60;
/** 精读一次最多多少字，超了让她分几次读。 */
const READ_MAX_CHARS = 12000;

function rootDir() {
  return join(config.dataDir, '.state', 'chronicle');
}
function docsDir() {
  return join(rootDir(), 'docs');
}
function indexDir() {
  return join(rootDir(), 'index');
}
function manifestFile() {
  return join(rootDir(), 'manifest.json');
}
function sessionsDir() {
  return join(config.dataDir, '.state', 'sessions');
}
function safeSid(sid) {
  return String(sid || 'unknown').replace(/[^\w-]/g, '_');
}

/**
 * 书有多厚。
 *
 * 「约 0K 字」这种写法对小会话毫无信息量（自测时看到过：60 字的会话显示
 * 0K，看着像空的）。小的直接用「字」，大了才进位到 K / M。
 */
function fmtSize(chars) {
  const n = Number(chars) || 0;
  if (n < 1000) return n + ' 字';
  if (n < 1000000) return Math.round(n / 1000) + 'K 字';
  return (n / 1000000).toFixed(1) + 'M 字';
}

// ────────────────────────────────────────────────────────────
// 分词
// ────────────────────────────────────────────────────────────

/**
 * 中英混排的分词。
 *
 * 中文没有空格，按空格切等于什么都没切。这里用「二元组 + 单词」的组合：
 *   - 英文/数字/路径：按 [A-Za-z0-9_./\\-]+ 切出整词，全小写
 *   - 中文：每两个字组成一个 bigram（「压缩上下文」→ 压缩/缩上/上下/下文）
 *
 * 为什么用 bigram 而不是真正的分词器：不引依赖、不联网、对「搜索关键字」这个用途足够。
 * 缺点是两个字的词会有一堆噪音命中，所以搜索时按命中数排序、只回前 30 条。
 *
 * 单字中文不进索引（噪音太大），但搜索时如果关键词是单字，会退化成直接子串扫。
 */
function tokenize(text) {
  const out = new Set();
  const s = String(text || '');
  // 英文/数字/路径词
  for (const m of s.matchAll(/[A-Za-z0-9_][A-Za-z0-9_./\\-]{1,}/g)) {
    out.add(m[0].toLowerCase());
  }
  // 中文 bigram
  for (const run of s.matchAll(/[\u4e00-\u9fff]+/g)) {
    const t = run[0];
    if (t.length === 1) continue;
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  }
  return out;
}

// ────────────────────────────────────────────────────────────
// 一条消息 → 一行记录
// ────────────────────────────────────────────────────────────

/**
 * 把消息内容摊平成纯文本。工具调用不能丢 —— 回头最常想查的就是「我到底跑过什么命令」。
 */
function flatten(m) {
  const parts = [];
  if (typeof m?.content === 'string') parts.push(m.content);
  else if (Array.isArray(m?.content)) {
    for (const p of m.content) {
      if (p && typeof p.text === 'string') parts.push(p.text);
      else if (p && p.type) parts.push('（附件：' + p.type + '）');
    }
  }
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) {
    parts.push('[工具调用] ' + m.tool_calls.map((c) => {
      const n = c?.function?.name || c?.name || '?';
      const a = c?.function?.arguments ?? c?.arguments ?? '';
      return n + '(' + (typeof a === 'string' ? a : JSON.stringify(a)) + ')';
    }).join(' | '));
  }
  return parts.join('\n').trim();
}

/**
 * 给消息猜一个类别。分类不追求精确，只为「目录里能分堆」。
 *
 * 判据全部来自结构，不调用模型 —— 建库要能离线跑、跑得快。
 */
function classify(m, text) {
  if (m?.summary) return '摘要';
  if (m?.role === 'system') return '设定';
  if (m?.role === 'tool') return '工具结果';
  if (Array.isArray(m?.tool_calls) && m.tool_calls.length) return '工具调用';
  if (m?.context) return '背景';
  if (m?.role === 'assistant') return '她说的';
  if (m?.role === 'user') {
    if (m?._text && String(m._text).trim()) return '主人说的';
    return '主人说的';
  }
  return '其它';
}

// ────────────────────────────────────────────────────────────
// 建库（增量）
// ────────────────────────────────────────────────────────────

function readManifest() {
  try {
    const j = JSON.parse(readFileSync(manifestFile(), 'utf8'));
    if (j && typeof j === 'object' && Array.isArray(j.books)) return j;
  } catch {}
  return { version: 1, books: [], builtAt: 0 };
}

function writeManifest(m) {
  mkdirSync(rootDir(), { recursive: true });
  writeFileSync(manifestFile(), JSON.stringify(m, null, 2), 'utf8');
}

/**
 * 建/更新全书。
 *
 * @param {object} opt
 * @param {boolean} opt.force   true = 全部重编（换过分词规则、或主人要「重建」时用）
 * @returns {{books:number, rebuilt:number, skipped:number, messages:number, elapsedMs:number}}
 */
export function buildChronicle({ force = false } = {}) {
  const t0 = Date.now();
  const man = readManifest();
  const byId = new Map(man.books.map((b) => [b.id, b]));
  mkdirSync(docsDir(), { recursive: true });
  mkdirSync(indexDir(), { recursive: true });

  /**
   * 只收真正的会话文件。
   *
   * sessions 目录里还混着 .bak / .bak-verify-xxx / .bak-before-xxx / .bak-before-cleanup-xxx
   * 这类备份 —— 它们是同一段对话的旧影子。收进去的后果：
   *   ① 目录里同一个标题出现好几遍，她分不清哪个是活的
   *   ② 搜索同一条命中回好几次，白占额度
   *   ③ 统计虚高（实测 22 本里有一本 2MB 的 .bak-verify 抢了名额）
   * 判据：文件名必须是 `<id>.json`，`<id>` 里不许有「.」。
   *
   * 【为什么还要专门踢掉 _last.json —— 2026-10-28 踩过的坑】
   *
   * `_last.json` 是「最后打开的是哪个会话」的指针，内容就 `{id, at}` 两个键，
   * 但它的文件名完全符合上面那条判据，于是被当成一个会话收了进来。
   * 而且它的 `id` **正好等于**某个真实会话的 id，两个文件撞在一起：
   *
   *   true 副本先处理 → 读到 9 条 → manifest 记下 msgCount=9
   *   _last.json 后处理 → 同一个 id、没有 messages → 把 9 覆盖成 0
   *
   * 结果是那本书永远是空的：目录里显示 0 条、搜索搜不出东西、精读说「一共 0 行」。
   * 更难受的是它**每次建库都会被清空一次**，所以怎么重建都没用。
   *
   * 教训：按文件名猜内容是不可靠的，得按「里面到底有没有 messages」再判一次。
   */
  const META_FILES = new Set(['_last.json']);
  const files = existsSync(sessionsDir())
    ? readdirSync(sessionsDir()).filter((f) => /^[^.]+\.json$/.test(f) && !META_FILES.has(f))
    : [];
  let rebuilt = 0;
  let skipped = 0;
  let totalMsgs = 0;
  const seen = new Set();

  for (const f of files) {
    let s;
    try {
      s = JSON.parse(readFileSync(join(sessionsDir(), f), 'utf8'));
    } catch {
      continue; // 坏文件跳过，不因为一个文件毁掉整本书
    }
    const sid = safeSid(s?.id || f.replace(/\.json$/, ''));
    seen.add(sid);
    const msgs = Array.isArray(s?.messages) ? s.messages : [];

    /**
     * 【兜底：同一本会话被两个文件认领时，只认「真的有对话」的那一个】
     *
     * 上面已经按名字踢掉了 `_last.json`。但这个名字是死的，以后程序再加
     * 别的指针文件、或者误存了副本，还会撞上同一个坑 —— 而且症状极隐蔽：
     * 书里空空如也，看着像「没记得住」，其实是刚写进去就被抹了。
     *
     * 所以这里再判一次性质：**没有 messages 数组的文件，不是会话。**
     * 一条都没有的（新建了还没说话）允许收，但如果同一个 id 已经有一本
     * 更厚的了，就不许拿薄的去盖它。
     */
    if (!Array.isArray(s?.messages)) continue;
    const prevForSid = byId.get(sid);
    if (prevForSid && msgs.length < (prevForSid.msgCount || 0) && !force) continue;

    const prev = prevForSid;
    // 增量判据：条数和更新时间都没变就跳过
    if (!force && prev && prev.msgCount === msgs.length && prev.updatedAt === s?.updatedAt) {
      skipped++;
      totalMsgs += msgs.length;
      continue;
    }

    // ── 逐条写成 jsonl + 顺手建倒排索引 ──
    const lines = [];
    const postings = new Map(); // 词 → Set(行号)
    const catCount = new Map(); // 类别 → 条数
    msgs.forEach((m, i) => {
      const text = flatten(m);
      const cat = classify(m, text);
      catCount.set(cat, (catCount.get(cat) || 0) + 1);
      const rec = {
        l: i,
        r: String(m?.role || '?'),
        c: cat,
        t: text.length > 60000 ? text.slice(0, 60000) + '\n…（这一条太长，索引里只留前 60000 字）' : text,
      };
      // 摘要消息多带一个小标，翻目录时能一眼看出「这里是折叠点」
      if (m?.summary) rec.s = 1;
      lines.push(JSON.stringify(rec));
      if (!text) return;
      for (const tok of tokenize(text)) {
        let set = postings.get(tok);
        if (!set) { set = []; postings.set(tok, set); }
        set.push(i);
      }
    });

    writeFileSync(join(docsDir(), sid + '.jsonl'), lines.join('\n'), 'utf8');
    // 倒排索引用「词 → 行号数组」的普通对象；数组去重后存，省一半体积
    const idxObj = {};
    for (const [tok, arr] of postings) idxObj[tok] = Array.from(new Set(arr));
    writeFileSync(join(indexDir(), sid + '.json'), JSON.stringify(idxObj), 'utf8');

    const book = {
      id: sid,
      title: String(s?.title || '（没有标题）'),
      createdAt: Number(s?.createdAt) || 0,
      updatedAt: Number(s?.updatedAt) || 0,
      msgCount: msgs.length,
      chars: lines.reduce((n, l) => n + l.length, 0),
      terms: postings.size,
      categories: Object.fromEntries(catCount),
      builtAt: Date.now(),
    };
    byId.set(sid, book);
    rebuilt++;
    totalMsgs += msgs.length;
  }

  // 会话被删了 → 它的书也撤掉（原文已经不在了，留着清单会误导她去读空气）
  for (const id of Array.from(byId.keys())) {
    if (!seen.has(id)) byId.delete(id);
  }

  const books = Array.from(byId.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  writeManifest({ version: 1, books, builtAt: Date.now() });
  return { books: books.length, rebuilt, skipped, messages: totalMsgs, elapsedMs: Date.now() - t0 };
}

/** 建库如果从没跑过，或者过期了，就顺手建一下（工具调用前的保险）。 */
function ensureBuilt() {
  const man = readManifest();
  if (!man.books.length || !existsSync(docsDir())) {
    return buildChronicle({});
  }
  return null;
}

// ────────────────────────────────────────────────────────────
// 第一层：目录
// ────────────────────────────────────────────────────────────

/**
 * 全书目录。
 *
 * @param {object} opt
 * @param {boolean} opt.byCategory  按分类汇总（哪一类的话最多），默认按时间列书
 * @param {number}  opt.limit       列多少本，默认 40
 */
export function chronicleToc({ byCategory = false, limit = 40 } = {}) {
  ensureBuilt();
  const man = readManifest();
  const books = man.books;
  if (!books.length) return { ok: true, text: '岁月史书还是空的：还没建过库，或者一个会话都没有。' };

  if (byCategory) {
    // 把每本书的分类计数相加，得到「全书分类」
    const sum = new Map();
    for (const b of books) {
      for (const [k, v] of Object.entries(b.categories || {})) {
        sum.set(k, (sum.get(k) || 0) + v);
      }
    }
    const rows = Array.from(sum.entries()).sort((a, b) => b[1] - a[1]);
    const lines = ['【岁月史书 · 分类总览】共 ' + books.length + ' 个会话', ''];
    for (const [k, v] of rows) lines.push('- ' + k + '：' + v + ' 条');
    lines.push('', '要看某一类的具体会话，用 chronicle_search 搜关键字；要看某本书的目录，用 chronicle_toc。');
    return { ok: true, text: lines.join('\n') };
  }

  const shown = books.slice(0, Math.max(1, Math.min(200, Number(limit) || 40)));
  const lines = ['【岁月史书 · 目录】共 ' + books.length + ' 个会话，按最后更新排序' + (books.length > shown.length ? '（只列前 ' + shown.length + ' 个）' : '')];
  /**
   * 【分卷：按时间把书分成几卷】
   *
   * 22 本书顺着时间翻还能忍，两百本就不行了。所以在目录里加一条粗的时间轴：
   * 今天 / 这周 / 这个月 / 更早。她先看「这事大概是什么时候的」，再决定翻哪一卷，
   * 不用从最新一路翻到最早。
   */
  if (books.length > 3) {
    const now = Date.now();
    const DAY = 86400000;
    const buckets = [
      { label: '今天', test: (t) => now - t < DAY },
      { label: '这周', test: (t) => now - t >= DAY && now - t < 7 * DAY },
      { label: '这半个月', test: (t) => now - t >= 7 * DAY && now - t < 15 * DAY },
      { label: '这个月', test: (t) => now - t >= 15 * DAY && now - t < 31 * DAY },
      { label: '更早', test: (t) => now - t >= 31 * DAY },
    ];
    const got = buckets.map((b) => ({ label: b.label, n: books.filter((x) => x.updatedAt && b.test(x.updatedAt)).length }));
    const live = got.filter((g) => g.n > 0);
    if (live.length > 1) {
      lines.push('');
      lines.push('时间上分这么几卷：' + live.map((g) => g.label + ' ' + g.n + ' 个').join(' ｜ '));
    }
  }
  lines.push('');
  for (const b of shown) {
    const d = b.updatedAt ? new Date(b.updatedAt).toLocaleString('zh-CN') : '时间不明';
    lines.push('');
    lines.push('▸ ' + b.title);
    lines.push('  id: ' + b.id);
    lines.push('  最后更新: ' + d + ' ｜ ' + b.msgCount + ' 条 ｜ ' + fmtSize(b.chars));
    const cats = Object.entries(b.categories || {}).sort((a, b2) => b2[1] - a[1]).slice(0, 5);
    if (cats.length) lines.push('  构成: ' + cats.map(([k, v]) => k + ' ' + v).join('、'));
  }
  lines.push('');
  lines.push('下一步：chronicle_search 搜关键字（会回片段和行号），或 chronicle_read 按 id + 行号区间精读。');
  return { ok: true, text: lines.join('\n') };
}

// ────────────────────────────────────────────────────────────
// 第二层：搜索（回片段，不回全文）
// ────────────────────────────────────────────────────────────

function loadIndex(sid) {
  try {
    return JSON.parse(readFileSync(join(indexDir(), sid + '.json'), 'utf8'));
  } catch {
    return null;
  }
}

function loadLines(sid) {
  try {
    const raw = readFileSync(join(docsDir(), sid + '.jsonl'), 'utf8');
    return raw.split('\n').map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    });
  } catch {
    return null;
  }
}

/** 把一段文字按关键词位置切出「…前文【关键词】后文…」。 */
function snippet(text, kw) {
  const t = String(text || '');
  const lower = t.toLowerCase();
  const pos = lower.indexOf(String(kw).toLowerCase());
  if (pos < 0) return t.slice(0, SNIPPET_PAD * 2).replace(/\s+/g, ' ');
  const from = Math.max(0, pos - SNIPPET_PAD);
  const to = Math.min(t.length, pos + kw.length + SNIPPET_PAD);
  return (from > 0 ? '…' : '') + t.slice(from, to).replace(/\s+/g, ' ') + (to < t.length ? '…' : '');
}

/**
 * 搜索。
 *
 * @param {object} opt
 * @param {string}  opt.query    关键词（空格分隔多个，全部命中优先）
 * @param {string}  opt.session  限定某个会话 id（可选）
 * @param {string}  opt.category 限定分类（可选，如「主人说的」「工具调用」）
 * @param {number}  opt.limit    最多几条命中，默认 20，上限 MAX_HITS
 */
export function chronicleSearch({ query, session, category, limit, includeSystem = false } = {}) {
  ensureBuilt();
  const q = String(query || '').trim();
  if (!q) return { ok: false, text: '要给个关键词。想看有哪些会话，先用 chronicle_toc。' };
  const man = readManifest();
  let books = man.books;
  if (session) {
    const sid = safeSid(session);
    books = books.filter((b) => b.id === sid || b.title === session || b.id.startsWith(sid));
  }
  if (!books.length) return { ok: false, text: '没有这个会话。先用 chronicle_toc 看 id。' };

  const terms = q.split(/\s+/).filter(Boolean);
  const lim = Math.max(1, Math.min(MAX_HITS, Number(limit) || 20));
  // 计分：一个词命中 +1，全部词都命中额外 +5
  const scored = [];
  for (const b of books) {
    const idx = loadIndex(b.id);
    const lines = loadLines(b.id);
    if (!idx || !lines) continue;
    const hits = new Map(); // 行号 → 命中词数
    for (const term of terms) {
      // 英文词用整词索引；中文词用 bigram 拆开求交
      const keys = [];
      if (/^[A-Za-z0-9_]/.test(term)) keys.push(term.toLowerCase());
      else {
        for (const tok of tokenize(term)) keys.push(tok);
        if (!keys.length) keys.push(term); // 单字中文：走下面的全量扫
      }
      let lineSet = null;
      for (const k of keys) {
        const arr = idx[k];
        if (!arr) { lineSet = new Set(); break; }
        const s = new Set(arr);
        lineSet = lineSet ? new Set([...lineSet].filter((x) => s.has(x))) : s;
      }
      // 单字/无索引命中 → 退化成子串扫（慢，只在必要时）
      if (!lineSet || !lineSet.size) {
        lineSet = new Set();
        for (const rec of lines) {
          if (rec && String(rec.t || '').toLowerCase().includes(term.toLowerCase())) lineSet.add(rec.l);
        }
      }
      for (const ln of lineSet) hits.set(ln, (hits.get(ln) || 0) + 1);
    }
    for (const [ln, n] of hits) {
      const rec = lines[ln];
      if (!rec) continue;
      if (category && rec.c !== category) continue;
      /**
       * 默认不搜「设定」。
       *
       * 实测：「压缩」这个词命中 403 处，前三条全是每个会话第 0 行的 system 提示词 ——
       * 那段话里写着「人设/记忆/压缩包」之类的词，于是任何跟这些沾边的关键词都会
       * 把 22 个会话的开场白全捞出来。这不是她要的历史，是每本书的封面。
       *
       * 要搜设定（比如查「当时的人设里到底怎么写的」）就传 includeSystem。
       */
      if (!includeSystem && rec.c === '设定') continue;
      const score = n + (n === terms.length && terms.length > 1 ? 5 : 0);
      scored.push({ book: b, rec, score });
    }
  }

  /**
   * 【把「每本书封面上都印着同一句话」的命中压到后面去】
   *
   * 实测：搜「主人」命中 1747 处，前三条全是同一段开场白 —— 22 个会话里
   * 有 16 个第 1-2 行是同一句「主人你可算来了」，一字不差。
   * 这不是她要找的历史，是每本书都抄了一遍的封面。
   *
   * 【为什么不能只靠减分】
   *
   * 第一版是减分（重复一次 -3）。实测没用：模板本身命中词多、分高，
   * 减完 45 分还是比别的命中高，照样占着前三条。**分数是量，模板是性质**，
   * 拿减法去处理性质，永远调不准。所以改成硬性两段排序：
   *   - 先按「是不是模板」分成两堆，非模板一律排前面；
   *   - 各自堆里再按分数排。
   *
   * 也不能直接删：万一是真的在问那件事。所以只是沉底 + 标出来。
   */
  const textCount = new Map();
  for (const it of scored) {
    const k = normText(it.rec.t);
    if (k) textCount.set(k, (textCount.get(k) || 0) + 1);
  }
  for (const it of scored) {
    const k = normText(it.rec.t);
    const dup = k ? (textCount.get(k) || 1) : 1;
    if (dup > 1) it.template = dup; // 跨会话一字不差 → 模板
  }
  scored.sort((a, b) => {
    const ta = a.template ? 1 : 0;
    const tb = b.template ? 1 : 0;
    if (ta !== tb) return ta - tb;          // 非模板永远在前
    if (b.score !== a.score) return b.score - a.score;
    return b.book.updatedAt - a.book.updatedAt;
  });

  const page = scored.slice(0, lim);
  /**
   * 【过滤之后可能一条都不剩 —— 别拿 page[0] 硬取】
   *
   * 上面 `scored.length` 判过空，但那是「过滤之前」。加了 category 之后
   * （比如搜「主人」又要只看「她说的」），很可能一个都不剩。
   * 第一版直接写 `page[0].book.id`，这种时候就崩了 —— 而且崩在她手上，
   * 主人看到的是「搜不动」，不是「这一类里没有」。
   */
  if (!page.length) {
    return {
      ok: true,
      hits: 0,
      shown: 0,
      text: '【岁月史书 · 搜索「' + q + '」】'
        + (category ? '在「' + category + '」这一类里' : '')
        + '一条也没搜到。换个词，或者去掉 category 限制再搜。',
    };
  }

  const lines = ['【岁月史书 · 搜索「' + q + '」】命中 ' + scored.length + ' 处' + (scored.length > page.length ? '，只列前 ' + page.length + ' 处（把关键词写细一点，或加 category 过滤）' : '')];
  for (const it of page) {
    const d = it.book.updatedAt ? new Date(it.book.updatedAt).toLocaleString('zh-CN') : '';
    lines.push('');
    lines.push('▸ 《' + it.book.title + '》 第 ' + it.rec.l + ' 行 · ' + it.rec.c + ' · ' + d
      + (it.template ? '（这段在 ' + it.template + ' 个会话里一模一样，大概是模板，已沉底）' : ''));
    lines.push('  ' + snippet(it.rec.t, terms[0]));
  }
  lines.push('');
  lines.push('下一步：用 chronicle_read 传 session=' + page[0].book.id + ' 和 from/to 行号，读那一段原文。');
  return { ok: true, text: lines.join('\n'), hits: scored.length, shown: page.length };
}

/**
 * 比较两段话是不是「同一段」时用的归一化：去掉所有空白和标点，
 * 只比实打实的字。因为开场白在压缩/落盘后可能差个空格或换行，
 * 直接比字符串会漏判成两段不同的。
 */
function normText(s) {
  return String(s || '').replace(/[\s\u3000]+/g, '').replace(/[，。！？、；：""''（）()【】…—\-~～·]/g, '');
}

// ────────────────────────────────────────────────────────────
// 第三层：精读（必须带范围）
// ────────────────────────────────────────────────────────────

/**
 * 读一段原文。
 *
 * **必须给范围**（from/to）。不给就直接报错，逼她先窄下来 ——
 * 这是「不能一股脑全看」这条要求在代码里的落点。
 *
 * @param {object} opt
 * @param {string} opt.session 会话 id
 * @param {number} opt.from    起始行（含）
 * @param {number} opt.to      结束行（含）；最多 READ_MAX_CHARS 字，超了会截断并提示
 */
export function chronicleRead({ session, from, to } = {}) {
  ensureBuilt();
  const man = readManifest();
  const wanted = String(session || '').trim();
  if (!wanted) return { ok: false, text: '要指定是哪个会话。先用 chronicle_toc 或 chronicle_search 拿到 id。' };
  const book = man.books.find((b) => b.id === safeSid(wanted) || b.title === wanted || b.id === wanted);
  if (!book) return { ok: false, text: '没有这个会话：' + wanted + '。先用 chronicle_toc 看有哪些。' };

  const fr = Number(from);
  const toN = Number(to);
  if (!Number.isFinite(fr) && !Number.isFinite(toN)) {
    return {
      ok: false,
      text: '岁月史书不能一次全读 —— 请先给行号范围（from / to）。'
        + '这个会话一共 ' + book.msgCount + ' 行，先用 chronicle_search 搜关键字定位到某几行再读。',
    };
  }
  const lines = loadLines(book.id);
  if (!lines) return { ok: false, text: '这个会话还没建进史书，先让它建一次库。' };

  const a = Math.max(0, Number.isFinite(fr) ? fr : toN - 20);
  const b = Math.min(lines.length - 1, Number.isFinite(toN) ? toN : a + 20);
  if (b < a) return { ok: false, text: '范围写反了：from=' + a + ' to=' + b };

  const out = ['【岁月史书 · 《' + book.title + '》第 ' + a + '–' + b + ' 行】'];
  let chars = 0;
  let stoppedAt = -1; // 没读进去的第一行；下面报「读到第 X 行」时要用 X-1，别再差一行
  for (let i = a; i <= b; i++) {
    const rec = lines[i];
    if (!rec) continue;
    const body = '--- #' + rec.l + ' [' + rec.r + '/' + rec.c + '] ---\n' + rec.t;
    // 一条就超上限（超大工具结果）：截一下照样读进来，否则这一行永远读不到、
    // 提示还让你 from=同一行，来回死循环。
    if (chars === 0 && body.length > READ_MAX_CHARS) {
      out.push('');
      out.push(body.slice(0, READ_MAX_CHARS));
      chars += READ_MAX_CHARS;
      out.push('');
      out.push('（这一条本身就有 ' + body.length + ' 字，先给你前 ' + READ_MAX_CHARS + ' 字。要看后面，用 chronicle_search 加关键词再搜。）');
      stoppedAt = i + 1;
      break;
    }
    if (chars + body.length > READ_MAX_CHARS) { stoppedAt = i; break; }
    out.push('');
    out.push(body);
    chars += body.length;
  }
  if (stoppedAt >= 0) {
    out.push('');
    out.push('（读到第 ' + (stoppedAt - 1) + ' 行就到 ' + READ_MAX_CHARS + ' 字上限了。接着读就再调一次，from=' + stoppedAt + '。）');
  }
  return { ok: true, text: out.join('\n'), from: a, to: stoppedAt >= 0 ? stoppedAt - 1 : b, chars };
}

// ────────────────────────────────────────────────────────────
// 状态 / 维护
// ────────────────────────────────────────────────────────────

/** 建库状态：界面和「史书」工具用。 */
export function chronicleStats() {
  const man = readManifest();
  let bytes = 0;
  for (const d of [docsDir(), indexDir()]) {
    try {
      for (const f of readdirSync(d)) {
        try { bytes += statSync(join(d, f)).size; } catch {}
      }
    } catch {}
  }
  return {
    books: man.books.length,
    messages: man.books.reduce((n, b) => n + (b.msgCount || 0), 0),
    chars: man.books.reduce((n, b) => n + (b.chars || 0), 0),
    bytes,
    builtAt: man.builtAt,
    builtAtText: man.builtAt ? new Date(man.builtAt).toLocaleString('zh-CN') : '从没建过',
  };
}

/** 重建全书（换分词规则、或主人手动点「重建」时用）。 */
export function rebuildChronicle() {
  return buildChronicle({ force: true });
}
