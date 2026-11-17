/**
 * inline-image.mjs —— 流式内联图收集器
 *
 * 【2026-11-17 加·主人报「出图模型发来一张图，结果是乱码」】
 *
 * 现场：建模鱼里让出图模型画一张，屏幕上涌出一大串英文字母 —— 图没出来，
 * 显示的是 base64 原文。
 *
 * 查出来两个叠加的原因：
 *   ① 旧代码只认 markdown 写法 `![image_1](data:image/png;base64,…)`；
 *      而实际上游还会给**裸**的 `data:image/png;base64,…` 和
 *      `<img src="data:image/png;base64,…">`，这两种一个都认不出 → 原样当文字；
 *   ② 更致命的是**流式**：base64 被切成无数小块，旧代码在每一块上单独跑正则，
 *      而正则要求「200 个以上 base64 + 收尾 )」—— 单块永远凑不齐，一个都匹配不上，
 *      整段 base64 就顺着 draftText 写进气泡。
 *
 * 现在改成有状态的收集器，跨块攒。三个状态：
 *   idle   —— 正常放行文字，只把「可能是标记前半截」的尾巴扣住
 *   header —— 已经看到 data:image/，正在把 "data:image/png;base64," 这个头拼全
 *   b64    —— 头拼好了，正在收 base64，直到遇到不属于 base64 的字符
 *
 * 为什么必须分 header / b64 两个状态：头只出现在**开头那一块**，
 * 后面的块全是纯 base64。如果每次都拿「是否以 data:image/ 开头」来判断，
 * 第二块起就会被当成普通文字直接放出去 —— 这正是我第一版写错的地方
 * （实测：正文里漏出 14 万字符 base64）。
 *
 * 用法：
 *   const sink = makeInlineImageSink();
 *   for (const chunk of stream) { const r = sink.push(chunk); 发 r.text; 收 r.images; }
 *   const tail = sink.flush();   // 收尾别忘了 flush
 */
import { savePng } from './gen-image.mjs';

/** 一张图最多收多少 base64 字（约 30MB 的 PNG）。超了就砍掉，别把内存吃干净。 */
const INLINE_B64_MAX = 40 * 1024 * 1024;

/** 这个字是不是 base64 字母表里的（含换行/空白，base64 常带换行） */
function isB64Char(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
    || (c >= '0' && c <= '9') || c === '+' || c === '/' || c === '='
    || c === '\n' || c === '\r' || c === ' ' || c === '\t';
}

/** 正文尾巴上如果是「图片前缀」的半截，剥掉它（否则正文里会留下 "![image_1](" ） */
const MD_PREFIX_RE = /!\[[^\]]*\]\(\s*$/;
const IMG_TAG_RE = /<img[^>]*src\s*=\s*["']?\s*$/i;

/** "data:image/" 的所有前缀（流式可能切在任意位置，得认得出半截） */
const MARKER = 'data:image/';

/** idle 态恒定扣住末尾多少字不发（够容纳 markdown 的 `![xx](` 和 html 的 `<img src=`） */
const IDLE_HOLD = 24;
const DATA_TAILS = (() => {
  const out = [];
  for (let i = 1; i <= MARKER.length; i++) out.push(MARKER.slice(0, i));
  return out;
})();

export function makeInlineImageSink(prefix = 'inline') {
  let pending = '';               // 还没放行的尾巴
  let state = 'idle';             // idle | header | b64
  let b64 = '';
  let tooBig = false;
  /**
   * 【2026-11-17 补·刚收完一张图时，它的 HTML 收尾符可能还在下一块里】
   *
   * 实测（每块 7 字）：base64 结束时只能看到 `"`，` />` 还在下一块，
   * 于是正文里剩下 `（图已取出来…）/>后面这句。`。
   * 打上这个标记，下一块开头如果是收尾符就先削掉。
   */
  let justClosed = false;

  const reset = () => { state = 'idle'; b64 = ''; tooBig = false; };

  return {
    /**
     * 喂一段流式正文。
     * @param {string} chunk
     * @returns {{text: string, images: Array<{path: string, caption: string}>}}
     */
    push(chunk) {
      const images = [];
      let out = '';
      if (chunk) pending += String(chunk);

      if (justClosed) {
        const m = /^(?:\s*["'])?\s*\/?>/.exec(pending);
        if (m) {
          pending = pending.slice(m[0].length);
          justClosed = false;
        } else if (/[^\s"'\/>]/.test(pending.slice(0, 8))) {
          /* 开头已经不是收尾符了 → 说明没有收尾符，正常往下走 */
          justClosed = false;
        }
      }

      for (;;) {
        if (state === 'idle') {
          const at = pending.indexOf(MARKER);
          if (at < 0) {
            /* 没有完整标记：扣住「可能是标记前半截」的尾巴，其余放行 */
            let hold = 0;
            for (const t of DATA_TAILS) {
              if (pending.endsWith(t) && t.length > hold) hold = t.length;
            }
            /**
             * 【2026-11-17 补·前缀必须**恒定扣住**，不能等它凑齐才扣】
             *
             * 实测（每块 7 字）：`<img src="` 会被切成 `<i` `mg s` `rc="` 好几块，
             * 等我看到完整的 `<img` 时，`<i` 早就发出去了，剥不掉 ——
             * 正文里就留下 `<img src="（图已取出来…）/>` 这种碎渣。
             *
             * 所以 idle 态**恒定留一小段尾巴不发**（IDLE_HOLD 字）：
             * 短到不影响手感（几十毫秒的延迟），长到足够容纳 `![xx](` / `<img src="`。
             * 发送前再从这段尾巴里把前缀剥掉。
             */
            hold = Math.max(hold, Math.min(IDLE_HOLD, pending.length));
            const cut = pending.length - hold;
            if (cut > 0) {
              /* 放出去的那部分里如果带着未收尾的前缀，也顺手清掉 */
              out += pending.slice(0, cut).replace(MD_PREFIX_RE, '').replace(IMG_TAG_RE, '');
              pending = pending.slice(cut);
            }
            break;
          }
          /* 看到了 data:image/ —— 前面的话放出去，顺手剥掉 ![..]( / <img src= */
          let head = pending.slice(0, at);
          head = head.replace(MD_PREFIX_RE, '').replace(IMG_TAG_RE, '');
          out += head;
          pending = pending.slice(at);
          state = 'header';
          continue;
        }

        if (state === 'header') {
          const m = /^data:image\/[a-zA-Z0-9.+-]+;base64,/.exec(pending);
          if (!m) {
            /* 头还没拼全（比如只到 "data:image/png;base6"），等下一块。
             * 但给个上限：40 字还拼不出头，说明那句话里只是**提到了**
             * data:image 这几个字，不是真图 —— 原样当文字放出去。 */
            if (pending.length < 40) break;
            out += pending;
            pending = '';
            reset();
            break;
          }
          pending = pending.slice(m[0].length);
          state = 'b64';
          b64 = '';
          tooBig = false;
          continue;
        }

        /* state === 'b64'：只认 base64 字符 */
        let i = 0;
        while (i < pending.length && isB64Char(pending[i])) i++;
        b64 += pending.slice(0, i);
        if (b64.length > INLINE_B64_MAX) tooBig = true;

        if (i >= pending.length) {
          /* 整块都是 base64，接着等下一块 */
          pending = '';
          break;
        }

        /* 遇到不属于 base64 的字符 = 这张图收完了（通常是 ) 或 " 或空格） */
        const rest = pending.slice(i);
        try {
          if (!tooBig) {
            const saved = savePng(b64, prefix);
            /**
             * 把紧随其后的收尾符号顺手吃掉，别在正文里留下 ` />` `")` 这种碎渣：
             *   · markdown：`)`
             *   · html：`">`、`" />`、`'/>`
             * 允许中间夹空格（上游排版不统一，实测就有 `" />` 这种）。
             */
            let t = 0;
            const skipWs = () => { while (t < rest.length && /\s/.test(rest[t])) t++; };
            skipWs();
            if (rest[t] === ')') t++;
            else {
              if (rest[t] === '"' || rest[t] === "'") t++;
              skipWs();
              if (rest[t] === '/' && rest[t + 1] === '>') t += 2;
              else if (rest[t] === '>') t++;
            }
            images.push({ path: saved.path, caption: '' });
            out += '（图已取出来，就是上面那张）';
            pending = rest.slice(t);
            /* 收尾符可能还没到（`"` 到了、` />` 还在下一块）—— 标记一下，下一块开头削掉 */
            justClosed = !rest.slice(0, t).includes('>');
          } else {
            out += '（这张图太大，超过程序的接收上限，已丢弃 —— 让它重新画一张小点的）';
            pending = rest;
          }
        } catch {
          out += '（图没取出来）';
          pending = rest;
        }
        reset();
        continue;
      }

      return { text: out, images };
    },

    /** 收尾：把压着的话放出去；正在收但没等到收尾符的图，尽力存一下 */
    flush() {
      const images = [];
      let out = '';
      if (state === 'b64') {
        if (b64 && !tooBig) {
          try {
            const saved = savePng(b64, prefix);
            images.push({ path: saved.path, caption: '' });
            out += '（图已取出来，就是上面那张）';
          } catch {
            out += '（图没取出来）';
          }
        } else if (tooBig) {
          out += '（这张图太大，超过程序的接收上限，已丢弃）';
        }
      } else if (pending) {
        /* idle / header 状态压着的都是正常文字（或者只是提到了 data:image） */
        out += pending;
      }
      pending = '';
      reset();
      return { text: out, images };
    },
  };
}
