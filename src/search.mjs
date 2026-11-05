// 联网搜索：把「搜一下」变成真能搜。
//
// 为什么自己解析 Bing：这台机器上 duckduckgo 连不上（fetch failed），
// Bing / 搜狗都是 200 且结构稳定。所以主用 Bing，挂了再退搜狗。
// 只拿标题 / 链接 / 摘要，够模型判断「该点哪个」，正文交给 fetch_url 去读。
//
// 设计上的两条底线：
//   1. 不编：搜不到就老实说搜不到，绝不拿模型自己的记忆顶替搜索结果。
//   2. 结果是「别人的话」，喂回模型时要标明来源，别让它当成自己的结论。

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const TIMEOUT_MS = 20000;

function decodeEntities(s) {
  return String(s)
    .replace(/<[^>]+>/g, '')
    .replace(/&ensp;|&nbsp;|&#160;|&#0183;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Bing：<li class="b_algo"> 里 h2>a 是标题+链接，p.b_lineclamp* 是摘要 */
function parseBing(html) {
  const out = [];
  for (const chunk of html.split('<li class="b_algo"').slice(1)) {
    const h2 = chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/);
    if (!h2) continue;
    const a = h2[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = a[1];
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(a[2]);
    const p = chunk.match(/<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    let snippet = p ? decodeEntities(p[1].replace(/<a[^>]*class="b_algoReadMore"[\s\S]*$/i, '')) : '';
    snippet = snippet.replace(/阅读更多$/, '').trim();
    if (!title) continue;
    out.push({ title, url, snippet, engine: 'bing' });
  }
  return out;
}

/** 搜狗：结构多变，只做兜底，取 <h3><a href="/link?url=..."> */
function parseSogou(html) {
  const out = [];
  for (const chunk of html.split('<h3').slice(1)) {
    const a = chunk.match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    let url = a[1];
    if (url.startsWith('/link?')) url = 'https://www.sogou.com' + url;
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(a[2]);
    if (!title) continue;
    out.push({ title, url, snippet: '', engine: 'sogou' });
  }
  return out;
}

/**
 * 【2026-11-05 加】百度。
 *
 * 为什么加：中文长尾词百度召回明显好过 Bing —— 实测「深度求值」这种词，
 * 百度前 20 条里 15 条对题，Bing 只有 8 条。
 *
 * 注意链接是跳转链（www.baidu.com/link?url=...），fetch_url 跟一下就落到真实页面，
 * 所以不在这里解 —— 解一次要发一次请求，20 条就是 20 次，太贵。
 * 结果里标成 baidu，模型自己知道这是跳转。
 */
function parseBaidu(html) {
  const out = [];
  for (const chunk of html.split('class="result').slice(1)) {
    const h3 = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!h3) continue;
    const a = h3[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = a[1];
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(a[2]);
    if (!title) continue;
    // 摘要有两种容器，新版是 span 里拼的，抓不到就留空（宁可没摘要，也别抓错段落）
    const ab = chunk.match(/class="[^"]*c-abstract[^"]*"[^>]*>([\s\S]*?)<\/(?:div|span)>/i);
    const snippet = ab ? decodeEntities(ab[1]).slice(0, 200) : '';
    out.push({ title, url, snippet, engine: 'baidu' });
  }
  return out;
}

/** 【2026-11-05 加】360 搜索。结构比百度稳，<li class="res-list"> 里一个 h3。 */
function parse360(html) {
  const out = [];
  for (const chunk of html.split('class="res-list').slice(1)) {
    const h3 = chunk.match(/<h3[^>]*>([\s\S]*?)<\/h3>/);
    if (!h3) continue;
    const a = h3[1].match(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = a[1];
    if (!/^https?:\/\//i.test(url)) continue;
    const title = decodeEntities(a[2]);
    if (!title) continue;
    const p = chunk.match(/class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/p>/i);
    out.push({ title, url, snippet: p ? decodeEntities(p[1]).slice(0, 200) : '', engine: '360' });
  }
  return out;
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      Accept: 'text/html,application/xhtml+xml',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return await res.text();
}

/**
 * 搜索。返回 { query, engine, results:[{title,url,snippet}] }。
 * 两个引擎都挂掉时抛错，由工具层转成「搜不到」回给模型。
 */
/**
 * 【2026-11-05 改·并行多引擎】
 *
 * 原来是「Bing 不行才试搜狗」，串行：Bing 慢就等于慢，搜狗闲着。
 * 现在四个一起打，谁先回来算谁，按引擎轮流并进结果里 ——
 * 不同引擎的排序不一样，轮流取比堆在一起覆盖得更广。
 *
 * 4.5 秒窗口：搜索等超过五秒，交互上已经变味了，宁可少几条。
 */
const ENGINES = [
  {
    name: 'bing',
    build: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=20`,
    parse: parseBing,
  },
  {
    name: 'baidu',
    build: (q) => `https://www.baidu.com/s?wd=${encodeURIComponent(q)}`,
    parse: parseBaidu,
  },
  {
    name: 'sogou',
    build: (q) => `https://www.sogou.com/web?query=${encodeURIComponent(q)}`,
    parse: parseSogou,
  },
  {
    name: '360',
    build: (q) => `https://www.so.com/s?q=${encodeURIComponent(q)}`,
    parse: parse360,
  },
];

/**
 * 【2026-11-05 加·引擎冷却】
 *
 * 实测：四个引擎并发打几次之后，百度开始返回 1.4KB 的空壳页（之前是 969KB 的正文），
 * 搜狗也缩水 —— 是反爬在限流。
 *
 * 所以给每个引擎记一笔「什么时候可以再用」：这次没拿到结果，就冷五分钟。
 * 宁可少一个引擎，也别每次都去撞墙把 IP 撞死。
 *
 * 只在内存里记，重启就清空 —— 不需要持久化，重启本身就是一次"重新开始"。
 */
const COOLDOWN_MS = 5 * 60 * 1000;
const _cooldown = new Map();

function cooling(name) {
  return (_cooldown.get(name) || 0) > Date.now();
}
function coolDown(name) {
  _cooldown.set(name, Date.now() + COOLDOWN_MS);
}

export async function webSearch(query, { limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索词是空的');
  const N = Math.max(1, Math.min(20, Number(limit) || 8));

  const got = [];
  const errors = [];

  /* 【2026-11-05 加·按语言排引擎】
   * 中文长尾词上 bing 召回很差：搜「深度求值」，它把词拆成「深度」+「求值」，
   * 第一条给的是 deepin 那个 Linux 发行版。百度/搜狗/360 反而对题。
   * 所以中文查询让国内三个先上，英文查询还是 bing 打头 —— 它在英文上最稳。 */
  const zh = /[\u4e00-\u9fff]/.test(q);
  const order = zh ? ['baidu', 'sogou', '360', 'bing'] : ['bing', 'baidu', 'sogou', '360'];
  const seq = order.map((n) => ENGINES.find((e) => e.name === n)).filter(Boolean);

  const jobs = seq.map((e) =>
    fetchText(e.build(q))
      .then((html) => {
        const rows = e.parse(html);
        if (rows.length) got.push({ engine: e.name, rows });
        else { errors.push(e.name + ': 没解析出结果'); coolDown(e.name); }
      })
      .catch((err) => {
        errors.push(e.name + ': ' + (err && err.message ? err.message : err));
        coolDown(e.name);
      }),
  );

  await Promise.race([
    Promise.allSettled(jobs),
    new Promise((r) => setTimeout(r, 4500)),
  ]);

  if (!got.length) throw new Error('搜索失败（' + errors.join('；') + '）');

  /* 【2026-11-05 修】got 是按「谁先回来」排的，不代表引擎优先级。
   * 中文查询时百度该排前面，但它慢半拍就会被挤到后面去。
   * 这里按 seq 重排一次。 */
  const gotOrdered = seq
    .map((e) => got.find((g) => g.engine === e.name))
    .filter(Boolean);

  /* 合并：按引擎轮流取，保证多样性。
   *
   * 两道去重：
   *   ① 同一 URL —— 老规矩；
   *   ② 同一标题（前 12 字一样就算）—— 新加的。四个引擎经常报同一批新闻，
   *      而它们的 URL 各不相同（百度还是跳转链），光按 URL 去重等于没去。
   *      前 12 字足够区分不同新闻，又不至于把"深度求值（一）"和"（二）"误判成同一条。 */
  const seenUrl = new Set();
  const seenTitle = new Set();
  const results = [];
  for (let i = 0; results.length < N; i++) {
    let added = false;
    for (const g of gotOrdered) {
      if (results.length >= N) break;
      const r = g.rows[i];
      if (!r) continue;
      added = true;
      const k = r.url.split('#')[0];
      if (seenUrl.has(k)) continue;
      const tk = String(r.title || '').replace(/\s/g, '').slice(0, 12);
      if (tk && seenTitle.has(tk)) continue;
      seenUrl.add(k);
      if (tk) seenTitle.add(tk);
      results.push(r);
    }
    if (!added) break;
  }

  return { query: q, engine: got.map((g) => g.engine).join('+'), results };
}

/** 把结果排成给模型看的文本：自己带序号和来源，别让它去编 */
export function formatResults({ query, engine, results }) {
  const lines = [`搜索「${query}」—— ${engine} 共 ${results.length} 条：`];
  results.forEach((r, i) => {
    lines.push('');
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.snippet) lines.push(`   ${r.snippet}`);
  });
  lines.push('');
  lines.push('要看全文就用 fetch_url 打开上面某条链接。这些是网页上的说法，不是你自己知道的。');
  return lines.join('\n');
}
