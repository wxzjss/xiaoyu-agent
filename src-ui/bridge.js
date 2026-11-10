/**
 * 桥：把「已经在 index.html 里的那些工具函数」借过来用。
 *
 * 规格步骤 2 明确要求**复用**而不是重写：markdown（mdInto）、工具名美化（niceTool）、
 * 工具文本清洗（tidyToolText）、思考摘要（thinkPeekTail）、署名配色（mateColorOf）
 * 都是打磨过很多轮的东西，重写一遍只会把已经修好的 bug 再引进新实现里。
 *
 * 这里每个函数都带一个「拿不到就退化」的兜底：万一某个全局还没加载完，
 * 屏幕上退成纯文本也比整片白屏好。
 */

/** 把 markdown 画进一个已经存在的元素 */
export function mdInto(el, text) {
  if (!el) return;
  const raw = String(text == null ? '' : text);
  try {
    if (typeof window.mdInto === 'function') {
      window.mdInto(el, raw);
      return;
    }
  } catch (e) {
    try { console.warn('[log-view] mdInto 失败，退成纯文本:', e && e.message ? e.message : e); } catch (e2) {}
  }
  el.textContent = raw;
}

/** 工具卡标题：「跑命令 · ls -la」这种 */
export function niceTool(name, args) {
  try {
    if (typeof window.niceTool === 'function') return String(window.niceTool(name, args) || '');
  } catch (e) { /* 退化成原始名字 */ }
  return String(name || '工具');
}

/** 工具参数 / 输出的清洗（抹掉噪声、压掉超长 base64 之类） */
export function tidyToolText(v) {
  try {
    if (typeof window.tidyToolText === 'function') return String(window.tidyToolText(v) || '');
  } catch (e) { /* 退化 */ }
  return String(v == null ? '' : v);
}

/** 思考灰字那一截（柜门右侧 / 思考块右侧） */
export function thinkPeek(text) {
  try {
    if (typeof window.thinkPeekTail === 'function') return String(window.thinkPeekTail(text) || '');
  } catch (e) { /* 退化 */ }
  return '';
}

/** 这个身份的名字该用什么颜色（小鲸 / 别的助手卡） */
export function mateColorOf(name) {
  try {
    if (typeof window.mateColorOf === 'function') return String(window.mateColorOf(name) || '');
  } catch (e) { /* 退化 */ }
  return '';
}

/** 修乱码（服务端 / 老会话里偶尔有） */
export function fixText(s) {
  try {
    if (typeof window.fixMojibake === 'function') return String(window.fixMojibake(String(s == null ? '' : s)) || '');
  } catch (e) { /* 退化 */ }
  return String(s == null ? '' : s);
}

/** 文件大小 */
export function fmtSize(n) {
  try {
    if (typeof window.fmtSize === 'function') return String(window.fmtSize(n) || '');
  } catch (e) { /* 退化 */ }
  return n ? String(n) : '';
}

/** 时间：只画「时:分」，完整时间放 title */
export function fmtTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  if (!Number.isFinite(d.getTime())) return '';
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 工具参数：对象拆成 k: v 行（别让屏幕上出现 [object Object]） */
export function formatArgs(args) {
  if (args == null || args === '') return '';
  if (typeof args === 'object') {
    try {
      return Object.keys(args)
        .map((k) => {
          const v = args[k];
          let s = v && typeof v === 'object' ? JSON.stringify(v) : String(v);
          if (s.length > 300) s = s.slice(0, 300) + '…';
          return k + ': ' + s;
        })
        .join('\n');
    } catch (e) {
      return String(args);
    }
  }
  return String(args);
}
