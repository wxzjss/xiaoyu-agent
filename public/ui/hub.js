/**
 * 【2026-11-08 第二项·从 index.html 里搬出来的第一块】
 *
 * index.html 已经 114 万字符，找一个函数要在里面翻半天。
 *
 * 原则：**不引入构建工具、不换框架**。还是普通 <script>，定义在全局，
 * 主脚本照旧直接调用 —— 只是物理上分开放，改一行刷新还是生效。
 *
 * 选这两个当第一块，因为最干净：纯函数，不碰状态、不发请求，
 * 只吃 DOM 元素、吐字符串。搬错了最多灰字不对，不会连累别处。
 */
function thinkPeekTail(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  /* 【2026-11-08 主人】28 字太短，灰字右边明明还有一大片空。
   * 现在放到 160 字，真正显示多长交给 CSS 的 ellipsis 按容器宽度决定 ——
   * 容器宽就多显示，窄就自动截，不用前端猜。 */
  return flat.length > 160 ? '…' + flat.slice(-160) : flat;
}

function hubPeekOf(els) {
  try {
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (!el || !el.classList || !el.classList.contains('tool')) continue;
      const st = el.querySelector('.status');
      const stText = String((st && st.textContent) || '');
      if (stText.indexOf('运行') >= 0 || (st && st.classList.contains('run'))) {
        const nm = el.querySelector('.name');
        if (nm && nm.textContent) return '正在' + String(nm.textContent).trim() + '…';
      }
    }
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i];
      if (!el || !el.classList) continue;
      if (el.classList.contains('think')) {
        const b = el.querySelector('.thinkBody');
        const t = String((b && b.textContent) || '').replace(/\s+/g, ' ').trim();
        if (t) return t.slice(0, 30) + (t.length > 30 ? '…' : '');
      } else if (el.classList.contains('tool')) {
        const nm = el.querySelector('.name');
        if (nm && nm.textContent) return String(nm.textContent).trim();
      }
    }
  } catch (e) {}
  return '';
}
