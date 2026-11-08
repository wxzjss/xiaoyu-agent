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


/* ── 以下从 index.html 搬来 ───────────────────────────── */
/**
 * 【2026-11-08 重构·柜门头部只留一个出口】
 *
 * 为什么做这个：今天一整天，柜门(标题/状态/灰字)这一小块我改了**四轮**才对。
 *
 *   ① 标题不涨   → 只改了直播柜，漏了归拢柜
 *   ② 仍不涨     → 归拢柜补了，漏了「新卡塞进已有柜」
 *   ③ 有了但灰   → 文字对了，class 被 warn 抢走，不是 run live
 *   ④ 两个「运行中」→ status 一个、hubpeek 又一个
 *
 * 四轮、四个不同症状，根子是同一件事：**柜门头部在三个函数里各写一遍**
 *   · hubRefreshTitle   直播柜
 *   · groupLooseTools   历史归拢柜
 *   · foldLiveTools     新卡塞进已有柜
 * 每处都自己数工具、自己判断在不在跑、自己拼文案 —— 改一处，另两处照旧。
 *
 * 现在统一成这一个函数，三处只管调它。以后要改柜门长什么样，只改这里。
 *
 * @param {HTMLElement} hub   柜子（details.toolhub）
 * @param {object} opts
 * @param {HTMLElement|null} opts.thinking  柜子外面那块正在想的（没有就传 null）
 */
function syncHubHead(hub, opts) {
  if (!hub) return;
  const o = opts || {};
  const sum = hub.querySelector('summary') || hub;
  const name = sum.querySelector('.hubname');
  const st = sum.querySelector('.status');
  const pk = sum.querySelector('.hubpeek');
  const tools = [...hub.querySelectorAll('details.tool')];
  const thinks = [...hub.querySelectorAll('details.think')];
  const t = tools.length;
  const k = thinks.length;
  /* 哪张卡还在跑（status 文本带「运行」或挂 run 类）*/
  const runCard = tools.find((el) => {
    const s = el.querySelector('.status');
    const tx = String((s && s.textContent) || '');
    return tx.indexOf('运行') >= 0 || Boolean(s && s.classList.contains('run'));
  }) || null;
  const bad = hub.querySelectorAll('details.tool .status.err').length;
  /* 警告要排除「正在跑」那种 —— 运行中挂的就是 warn 类，混进来会被当成警告 */
  const warn = tools.filter((el) => {
    const s = el.querySelector('.status');
    if (!s || !s.classList.contains('warn')) return false;
    return String(s.textContent || '').indexOf('运行') < 0;
  }).length;
  const thinking = o.thinking || null;
  const runName = runCard
    ? String((runCard.querySelector('.name') || {}).textContent || '干活').trim()
    : '';

  if (name) {
    if (thinking) {
      name.textContent = (t ? ('调了 ' + t + ' 次 · ') : '') + '正在思考中…';
    } else if (runCard) {
      name.textContent = (t ? ('调了 ' + t + ' 次 · ') : '') + '正在' + runName + '…';
    } else if (t && k) {
      name.textContent = '调了 ' + t + ' 次工具 · 想了 ' + k + ' 段';
    } else if (k) {
      name.textContent = '想了 ' + k + ' 段';
    } else {
      name.textContent = '调了 ' + t + ' 次工具';
    }
  }
  if (st) {
    const live = Boolean(runCard) || Boolean(thinking);
    st.className = 'status ' + (bad ? 'err' : (live ? 'run live' : (warn ? 'warn' : 'ok')));
    st.textContent = bad ? (bad + ' 个失败') : (live ? '运行中' : '');
  }
  if (pk) {
    if (thinking) {
      pk.textContent = thinking.dataset.peek || '';
      pk.classList.remove('live');
    } else if (runCard) {
      /* 标题已经写了「正在X…」、status 已经是金色「运行中」，
       * 这截灰字再写一遍就成了两个「运行中」—— 清空，:empty 会自己隐藏 */
      pk.textContent = '';
      pk.classList.remove('live');
    } else {
      pk.textContent = hubPeekOf([...tools, ...thinks]);
      pk.classList.remove('live');
    }
  }
}

function hubRefreshTitle() {
  if (!_liveHub) return;
  /**
   * 【2026-11-08 重构·这里原来一百二十多行】
   *
   * 它自己数工具、自己判断有没有在跑、自己拼三种文案、自己给状态定色 ——
   * 而同样的逻辑在 groupLooseTools 和 foldLiveTools 里又各有一份。
   * 今天柜门那个 bug 我改了四轮才对，就是因为改一处、另两处照旧。
   *
   * 现在这里只做一件柜内查不到的事：找到「正在想的那块」——
   * 它挂在柜子**外面**（openThink 追到 #log 末尾），柜内 querySelector 找不到。
   * 剩下的交给 syncHubHead，柜门长什么样只在那一个地方定义。
   */
  const _thinking = (() => {
    try {
      const inside = _liveHub.querySelector("details.think.thinking-now");
      if (inside) return inside;
      const lg = document.getElementById("log");
      if (!lg) return null;
      const kids = [...lg.children];
      const ix = kids.indexOf(_liveHub);
      for (let i = kids.length - 1; i > ix; i -= 1) {
        const k = kids[i];
        if (k && k.classList && k.classList.contains("think") && k.classList.contains("thinking-now")) return k;
      }
    } catch (e) {}
    return null;
  })();
  syncHubHead(_liveHub, { thinking: _thinking });
}
