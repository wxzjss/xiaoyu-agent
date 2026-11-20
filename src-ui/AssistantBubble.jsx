import { useEffect, useRef, useState } from 'react';
import MdDiv from './MdDiv.jsx';
import { mateColorOf } from './bridge.js';
import { beginEdit, getEdit } from './store.js';
import EditArea from './EditArea.jsx';

/* 已经「首映」过的段（切回会话 / 组件重挂载时不再从头吐一遍） */
const __seenSegs = new Set();

/**
 * 【吐字组件】把一段正文按「每秒 N 字」揭示出来。
 *
 * 为什么单独做成组件 + 由外面给 key：
 *   换段（同一个 item 里又长出新的一段）时 React 会重建它，`shown` 自然归零，
 *   不用在 hook 里手写「这一轮重置」的状态机 —— 那套状态机是前几次修不干净的地方。
 *
 * 三个必须守住的行为（2026-11-15 主人报「说一半顿住，然后连工具一起崩出来」后重做）：
 *  ① **直播段一律吐**，不再看「是不是最后一项」—— 工具卡一进来它就不是最后一项了，
 *     旧判据当场失效，于是一整段瞬间全砸出来，看着像被工具堵住。
 *  ② **收尾不截断**：`animate` 变 false 只是「不再等新字」，循环会把剩下的按速度吐完。
 *  ③ 只补画不重吐：见过这个段的 key、或一次来一大坨（>900 字，切回会话补画），直接全显。
 */
function TypedText({ text, animate, streaming, segKey, className }) {
  const full = String(text == null ? '' : text);
  const boot = (() => {
    if (!animate) return full.length;
    if (__seenSegs.has(segKey)) return full.length;
    if (full.length > 900) return full.length;
    return 0;
  })();
  const [shown, setShown] = useState(boot);
  const curRef = useRef(boot);
  const targetRef = useRef(full);
  targetRef.current = full;
  const animateRef = useRef(animate);
  animateRef.current = animate;
  const runningRef = useRef(false);

  useEffect(() => {
    /* 【关键】只随 segKey 重启。animate 从 true 变 false（直播条目翻成历史）时
     * **不许** cancel —— 那一下正在吐的字会被截断、直接跳全文，
     * 主人看到的就是「说一半被工具卡堵住、然后一下子崩出来」。 */
    if (!animate && curRef.current >= String(text || '').length) return undefined;
    __seenSegs.add(segKey);
    runningRef.current = true;
    let last = 0;
    let lastPublish = -Infinity;
    let id = 0;
    const step = (ts) => {
      const target = String(targetRef.current || '').length;
      let cur = curRef.current;
      if (cur > target) { cur = target; curRef.current = cur; setShown(cur); }
      if (cur < target) {
        const now = typeof ts === 'number' ? ts : performance.now();
        const dt = last ? Math.min(0.12, Math.max(0, (now - last) / 1000)) : 0.016;
        last = now;
        const gap = target - cur;
        /* 150 字/秒 = 正常阅读速度；一次来一大坨时临时提速，免得拖成「卡住」 */
        const cps = gap > 300 ? 420 : 150;
        cur = Math.min(target, cur + Math.max(1, Math.round(cps * dt)));
        curRef.current = cur;
        // Markdown rebuilds its DOM for each visible prefix. Keep the typing clock,
        // but batch intermediate prefixes and always publish the final one immediately.
        if (cur === target || now - lastPublish >= 50) {
          lastPublish = now;
          setShown(cur);
        }
      } else if (!animateRef.current) {
        runningRef.current = false;
        return;                       // 吐完 + 已不是直播 → 收工，不空转
      }
      id = requestAnimationFrame(step);
    };
    id = requestAnimationFrame(step);
    return () => { cancelAnimationFrame(id); runningRef.current = false; };
  }, [segKey]);   // eslint-disable-line react-hooks/exhaustive-deps

  /* 【光标什么时候亮】只两种：
   *   ① 还在吐（shown < 全文）—— 包括收尾后继续吐的那段；
   *   ② 这一段正是「她此刻在说的那段」（streaming）—— 字暂时吐平了、下一块还没来，
   *      光标也要留着，不然会一闪一闪地断。
   *
   * 【2026-11-16 主人报·每句话末尾都挂着蓝光标】
   * 上一版写的是 `animate || …`，而 animate = 「这一条是不是直播条目」——
   * live 条目在内存里要留 10 分钟才转历史，于是**说过的话末尾光标一直闪**。
   * 现在把「这段在直播」和「这段是她正在说的那句」分开：后者才配光标。 */
  const typing = shown < full.length || (animate && streaming);
  return (
    <MdDiv
      className={(className || 'bubble') + (typing ? ' streaming' : '')}
      text={shown < full.length ? full.slice(0, shown) : full}
    />
  );
}

/**
 * 她（主智能体 / 某个身份）说的一段话。
 *
 * 一轮里「说 → 调工具 → 再说」会被服务端存成好几条 assistant turn；
 * items.js 已经把连续的几条并成一条 item 的 `bubbles` 数组（跟原来
 * 「续接进同气泡」的口径一致），所以这里只负责：一段一个 `.bubble`，
 * 署名只写在最上面一次。
 */
export default function AssistantBubble({ it, ask, streaming }) {
  const wrap = useRef(null);
  const bubbles = Array.isArray(it.bubbles) ? it.bubbles : [];
  const who = String(it.who || '小鱼');
  /* 吐字动画只作用于「直播条目」——判据是 it.isLive（服务端说这条还在直播），
   * 不再看「是不是清单里最后一项」，也不看全局 running：
   * 工具卡一进来，这段正文就不是最后一项了，旧判据当场失效 → 整段瞬间砸出。 */
  const lastIdx = bubbles.length - 1;
  const liveItem = it.isLive === true;

  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    try { if (!w.querySelector('.msgTime') && window.attachTime) window.attachTime(w, it.ts); } catch (e) {}
    if (it.cont) return;
    try { window.attachEdit && window.attachEdit(w, it.rewindId, () => beginEdit(it.key, it.rewindId)); } catch (e) {}
    try { window.attachBranchBtn && window.attachBranchBtn(w, it.rewindId); } catch (e) {}
    try { window.attachRetry && window.attachRetry(w, ask ? [{ at: ask.at, text: ask.text }] : []); } catch (e) {}
    try { window.attachDelBtn && window.attachDelBtn(w, it.rewindId, it.ts); } catch (e) {}
    try { window.attachCopyBtn && window.attachCopyBtn(w); } catch (e) {}
  }, [it.rewindId, it.ts, it.cont, it.key, ask && ask.at, ask && ask.text]);

  /* 超过 4 万字的长回复折起来（阈值和原来一致；短回复一个字都不折） */
  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    const els = w.querySelectorAll('.bubble');
    els.forEach((el, i) => {
      try { window.maybeFoldBubble && window.maybeFoldBubble(el, bubbles[i]); } catch (e) {}
    });
  }, [bubbles.join('\u0000')]);

  /* 这一轮的用量（token / 花费）：原来由 index.html 直接往气泡里 append，
   * 现在这里挂 —— 样式和「悬停才显示」的规则都由 appendTurnUsage 自己带。 */
  useEffect(() => {
    const w = wrap.current;
    if (!w || !it.usageRow) return;
    try {
      if (w.querySelector(':scope > .turnUsage')) return;
      if (typeof window.appendTurnUsage === 'function') {
        window.appendTurnUsage(it.usage || null, it.rewindId, it.model || '', w, true, it.replyChars, it.userChars);
      }
    } catch (e) { /* 用量画不出来不影响正文 */ }
  }, [it.usageRow, it.rewindId, it.usage, it.model, it.replyChars, it.userChars]);

  /* 她发的文件（A2 收编）：不再走 attachFiles 往气泡上挂 ——
   * 文件在 items.js 里直出成独立条目，由 LogView → FileCard 画。 */

  const editing = (() => { try { const e = getEdit(); return !!e && e.key === it.key; } catch (e) { return false; } })();
  const color = who !== '小鱼' ? mateColorOf(who) : '';
  const cls = 'msg assistant' + (it.cont ? ' cont' : '') + (it.edited ? ' edited' : '') + (editing ? ' editing' : '') + (it.aside ? ' aside' : '');

  return (
    <div
      className={cls}
      ref={wrap}
      data-who-name={who !== '小鱼' ? who : undefined}
      data-rewind-id={it.rewindId == null ? undefined : String(it.rewindId)}
      data-at={it.rewindId == null ? undefined : String(it.rewindId)}
    >
      <div className="role" style={color ? { color } : undefined}>
        {who}
      </div>
      {editing ? (
        <EditArea text={bubbles.join('\n\n')} at={it.rewindId} msgAt={it.ts} />
      ) : (
        bubbles.map((t, i) => {
          const cls = 'bubble' + (i > 0 ? ' cont' : '');
          /* 【吐字动画】直播条目的**最后一段**逐字揭示（换段时 key 变、组件重建、从头吐）；
           * 其余段整段直出。光标由 TypedText 自己在「还在吐」时挂 streaming。 */
          /* 【2026-11-15】最后一段**无论是不是直播**都走 TypedText：
           * 直播翻历史那一刻只是 animate 变了，组件不重建 —— 正在吐的字接着吐完。
           * 历史 / 补画的新挂载一律直出（boot 判据在 TypedText 里）。 */
          if (i === lastIdx) {
            return (
              <TypedText
                key={'b' + i + ':' + String(it.key || '')}
                segKey={String(it.key || '') + '#' + i}
                text={String(t == null ? '' : t)}
                animate={liveItem}
                streaming={!!streaming && i === lastIdx}
                className={cls}
              />
            );
          }
          return <MdDiv key={'b' + i} className={cls} text={String(t == null ? '' : t)} />;
        })
      )}
    </div>
  );
}
