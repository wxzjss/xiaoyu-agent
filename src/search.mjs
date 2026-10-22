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
export async function webSearch(query, { limit = 8 } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('搜索词是空的');

  const errors = [];

  const tryBing = async () => {
    const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN&count=20`;
    const html = await fetchText(url);
    return parseBing(html);
  };
  const trySogou = async () => {
    const url = `https://www.sogou.com/web?query=${encodeURIComponent(q)}`;
    const html = await fetchText(url);
    return parseSogou(html);
  };

  for (const [engine, fn] of [
    ['bing', tryBing],
    ['sogou', trySogou],
  ]) {
    try {
      const raw = await fn();
      // 去重（同一个 URL 只留一条）
      const seen = new Set();
      const results = raw
        .filter((r) => {
          const k = r.url.split('#')[0];
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        })
        .slice(0, Math.max(1, Math.min(20, Number(limit) || 8)));
      if (results.length) return { query: q, engine, results };
      errors.push(`${engine}: 没有解析出结果`);
    } catch (e) {
      errors.push(`${engine}: ${e.message}`);
    }
  }
  throw new Error('搜索失败（' + errors.join('；') + '）');
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
