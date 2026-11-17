#!/usr/bin/env node
/**
 * check-inline-image.mjs — 【出图模型发来的内联图，不许变成一屏乱码】
 *
 * 【2026-11-17 加·主人报「建模鱼里出图模型给我发了个图，结果是乱码」】
 *
 * 查出来的根因（两条叠加，缺一不成立）：
 *   ① 旧代码只认 markdown 写法 `![image](data:image/png;base64,…)`；
 *      实际上游还会给**裸** data:URL 和 `<img src="data:…">`，这两种一个都认不出；
 *   ② 流式把 base64 切成了无数小块，而旧代码在**每一块**上单独跑正则，
 *      正则又要求「200+ base64 且带收尾符」—— 单块永远凑不齐 →
 *      一个都匹配不上 → 整段 base64 顺着 draftText 写进气泡 = 乱码。
 *
 * 修法：`src/inline-image.mjs` 的三态收集器（idle / header / b64），跨块攒。
 *
 * 这个哨兵**真跑**：把一张真 PNG 的 base64 按 7 / 64 / 4096 字一块喂进去，
 * 三种写法各验一遍。只 grep 源码是抓不住「状态机写错」这种 bug 的
 * —— 我第一版就是状态机错了，源码看着完全正确，实测漏出 14 万字符 base64。
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('出图 / 内联图');

/* 48×48 真 PNG（157 字节，见 scripts 里那段 zlib 生成代码的思路）。
 * 用真 PNG 而不是随便一段 base64：savePng 会读 IHDR 宽高，
 * 假数据测不出「存下来的图是不是好的」。 */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAZElEQVR4nO3PMQ0AIADAMJSgE7F4AREcDcmO/d2Ya5+fGxrQgAY0oAENaEADGtCABjSgAQ1oQAMa0IAGNKABDWhAAxrQgAY0oAENaEADGtCABjSgAQ1oQAMa0IAGNKABDWjAaxcoxfo8o2wg5QAAAABJRU5ErkJggg==';
const PNG_SIZE = Buffer.from(PNG_B64, 'base64').length;

const mod = await import('../src/inline-image.mjs');
const make = mod.makeInlineImageSink;
t.ok('拿到收集器工厂', typeof make === 'function');

const agent = fs.readFileSync('src/server.mjs', 'utf8');
t.ok('server 用的是收集器（不是逐块正则）', /makeInlineImageSink/.test(agent));
t.ok('收到 done/aborted 时会 flush（不然最后半句会丢）',
  /_imgSink\.flush\(\)/.test(agent));

/** 把一段文本按 size 切开喂进去，返回 { text, images } */
function feed(fullText, size) {
  const sink = make('__probe_inline');
  let text = '';
  const images = [];
  for (let i = 0; i < fullText.length; i += size) {
    const r = sink.push(fullText.slice(i, i + size));
    text += r.text;
    images.push(...r.images);
  }
  const f = sink.flush();
  text += f.text;
  images.push(...f.images);
  return { text, images };
}

const clean = (s) => fs.rmSync(s, { force: true });

for (const [label, wrap] of [
  ['裸 data:URL', (b) => '前面这句。data:image/png;base64,' + b + ' 后面这句。'],
  ['markdown 包裹', (b) => '前面这句。![image_1](data:image/png;base64,' + b + ')后面这句。'],
  ['<img> 标签', (b) => '前面这句。<img src="data:image/png;base64,' + b + '" />后面这句。'],
]) {
  for (const size of [7, 64, 4096]) {
    const full = wrap(PNG_B64);
    const r = feed(full, size);
    const tag = label + '/每块' + size + '字';
    t.ok('[' + tag + '] 正文里不漏 base64',
      !/data:image\//.test(r.text) && !/[A-Za-z0-9+/]{150,}/.test(r.text),
      r.text.slice(0, 60));
    t.ok('[' + tag + '] 抽出了 1 张图', r.images.length === 1, String(r.images.length));
    if (r.images.length === 1) {
      const p = r.images[0].path;
      const buf = fs.readFileSync(p);
      t.ok('[' + tag + '] 落盘的是合法 PNG（字节数与原图一致）',
        buf[0] === 0x89 && buf.length === PNG_SIZE, buf.length + '/' + PNG_SIZE);
      clean(p);
    }
    t.ok('[' + tag + '] 前后的正常文字都在，且没留 `/>` 这种碎渣',
      r.text.includes('前面这句') && r.text.includes('后面这句') && !/\/>\s*后面/.test(r.text),
      r.text);
  }
}

/* 提到 data:image 但并不是图 —— 不许吞掉人家的字 */
{
  const r = feed('这句话提到了 data:image/png 是什么，但没有真的图。', 3);
  t.ok('只是提到 data:image 时原样放行（不吞字）',
    r.text.includes('这句话提到了') && r.text.includes('但没有真的图'),
    r.text);
  t.ok('也不会凭空造出一张图', r.images.length === 0);
}

/* 普通文字里出现 data / 数据库 之类，不许误扣 */
{
  const r = feed('数据库里的 data 字段和 data:image 字样都是普通文字', 1);
  t.ok('普通行文不被误扣（逐字喂也不出错）',
    r.text.includes('数据库') && r.text.includes('普通文字'), r.text);
  t.ok('普通行文不产图', r.images.length === 0);
}

t.done();
