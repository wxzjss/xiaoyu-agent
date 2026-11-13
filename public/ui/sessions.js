// @ts-check
/* 【2026-11-08】加了 @ts-check：编辑器里能对这里做类型推断。
 * 注意：项目没有 tsc 构建，这一行不影响运行；它只让 IDE 给出提示。
 * 全局函数之间互相调用会被标成「未声明」—— 那是拆分后共享全局作用域的代价，忽略即可。 */


/* ── 从 index.html 搬来 ─────────────────────────────── */
export async function refreshRunning() {
  try {
    const j = await fetch('/api/running').then((r) => r.json());
    const list = (j && Array.isArray(j.running)) ? j.running : [];
    /* 【2026-11-07 改·从「有没有」变成「还动不动」】
     * 主人报：「列表显示她在跑（绿点），点进去发现她早停了」。
     * 服务端那边是真挂着，可一个字都没回 —— 绿点只表示「挂着」，
     * 分不出「正在想」和「卡死了」。现在存整条，不只看 id。 */
    const next = new Map(
      list.filter((x) => x && x.sessionId).map((x) => [x.sessionId, x]),
    );
    /**
     * 【2026-11-08 修·「其他会话的【正在跑】提示会消失」】
     *
     * 主人：「多个会话在跑时，会话页每个名字下都有提示，
     * 但我在一个会话待久了，其他会话的提示会消失。」
     *
     * 因为这里是**整体替换**名单：服务端哪一次回答里漏了某个会话
     * （忙、刚重启、那一瞬间 runningTurns 被换过），这个名字的绿点立刻就没了，
     * 而且不会自己回来 —— 下一次回来时 key 没变、renderSessList 不重画。
     *
     * 加一层防抖：这次没出现、但上一次还在 → 先留一票，连续两次缺席才真摘掉。
     * 真跑完的会话第一次也会留 3 秒，那点延迟比「绿点乱闪」可接受得多。
     */
    for (const [id, info] of window.runningSess) {
      if (!next.has(id)) {
        const miss = (Number(info && info._miss) || 0) + 1;
        if (miss < 2) next.set(id, { ...(info || {}), sessionId: id, _miss: miss });
      }
    }
    window.runningSess = next;
  } catch { /* 拿不到就保留上一次的名单，别把绿点抹掉 */ }
}

/**
 * 【2026-11-10 B5·keyed 增量更新】
 *
 * 原来 renderSessList 每次都 `innerHTML = ''` 全量重建：
 *   · 正在 hover 的那一行瞬间消失又长回来 —— 闪；
 *   · 更要命的是 mousedown 落在旧行、mouseup 时行已经换了新节点，
 *     浏览器不认这笔 click —— 主人报的「点了没反应」就是这个。
 *
 * 现在按 s.id keyed diff：
 *   · 内容没变的行（签名一致）一个节点都不动 —— hover 不闪、点击不丢；
 *   · 内容变了（标题/绿点/ crew/副行文本……）的行只换行内的 main 块，
 *     行节点本身、改名/删除按钮、它们上面挂着的事件监听全保留；
 *   · 新增/删除的会话按 key 插拔。
 * 排序照旧（当前会话置顶、空会话沉底），只是搬节点而不是重建节点。
 */

/** 一行里「会变的部分」拼成签名：签名没变 = 这行可以原样保留 */
function sessRowSig(s) {
  const info = window.runningSess.get(s.id) || null;
  const stalled = info ? Number(info.idleMs || 0) > window.RUNNING_STALL_MS : false;
  const runningNow = typeof window.turnsInFlight !== 'undefined' && window.turnsInFlight.has(s.id);
  /* 卡住秒数按 20 秒分桶再进签名：绿点 hover 提示里的秒数不必逐秒更新，
     否则跑动中的行每 3 秒轮询都要重建一次，又回到闪烁老路 */
  const live = info ? (stalled ? 's' + Math.floor(Number(info.idleMs || 0) / 20000) : 'r') : '-';
  /* 【2026-11-11 置顶】pin 状态进签名：置顶/撤顶后这行的 📌 和按钮文字要跟着换 */
  return [
    s.id === window.sessionId ? '1' : '0',
    (window.bulkMode && window.picked.has(s.id)) ? '1' : '0',
    window.fixMojibake(s.title || '新会话'),
    String(s.agentName || '').trim(),
    s.agentId ? String(s.agentId) : '',
    (Array.isArray(s.crew) ? s.crew.filter(Boolean) : []).join(','),
    live,
    runningNow ? '1' : '0',
    window.relTime(s.updatedAt),
    s.count ? String(s.count) : '',
    s.preview || '',
    s.pinned ? '1' : '0',
  ].join('\u0001');
}

/** 行内 main 块（标题行 + 副行）。签名变了就整块换新，行本身不动。 */
function buildSessMain(s) {
  const main = document.createElement('div');
  main.className = 'sessMain';
  const t = document.createElement('div');
  t.className = 'sessTitle';
  // 标题文字和「挂的哪张卡」分开装：标题能被省略号截，卡名标签永远露在外面
  const ttxt = document.createElement('span');
  ttxt.className = 'sessTitleText';
  ttxt.textContent = window.fixMojibake(s.title || '新会话');
  t.appendChild(ttxt);
  /* 【2026-11-11 置顶】置顶的会话标题前一颗 📌，一眼认出。
   * 插在 ttxt 前面：绿点/黄点也是插这儿，顺序就是 📌 · 绿点 · 标题。 */
  if (s.pinned) {
    const pf = document.createElement('i');
    pf.className = 'sessPinFlag';
    pf.textContent = '📌';
    pf.title = '这个会话已置顶';
    t.insertBefore(pf, ttxt);
  }
  if (window.runningSess.has(s.id)) {
    const lv = document.createElement('i');
    const info = window.runningSess.get(s.id) || {};
    /* 静默太久 = 挂着但没回音。绿点是「在她那儿有动静」，黄点是「可能卡死了」 */
    const stalled = Number(info.idleMs || 0) > window.RUNNING_STALL_MS;
    lv.className = 'sessLive' + (stalled ? ' stalled' : '');
    lv.title = stalled
      ? ('已经 ' + Math.round(Number(info.idleMs || 0) / 1000) + ' 秒没有任何回音，可能卡住了')
      : '这个会话正在跑';
    t.insertBefore(lv, ttxt);
    /**
     * 【2026-11-08 加·列表里直接停】
     *
     * 主人：「压根没有 ⏹」—— 翻了才发现：停止键只长在**当前会话**的输入框旁边。
     * 后台在跑的是别的会话（那次是杂活鱼 + 卡了 126 秒的办事鱼），
     * 不一个个切过去，根本停不掉。
     * 跑着的这一行给一个 ⏹，点一下停那个会话，不用切过去。
     * sessStop 是行内元素，随「这行还在不在跑」生灭 —— 保持现状。
     */
    try {
      const sp = document.createElement('button');
      sp.type = 'button';
      sp.className = 'sessStop';
      sp.textContent = '⏹';
      sp.title = '停掉这个会话正在跑的那一轮';
      sp.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        try {
          await fetch('/api/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId: s.id }),
          });
        } catch (e) {}
        try { await refreshRunning(); renderSessList(); } catch (e) {}
      });
      t.appendChild(sp);
    } catch (e) {}
  }
  /* 【2026-11-07 改】这里显示的现在是「谁在说话」，不是「绑了哪张卡」——
     屋里的人排最上面、且开着的那个，随时会变（主人要的就是动态）。 */
  const agName = String(s.agentName || '').trim();
  if (agName && s.agentId) {
    const chip = document.createElement('span');
    chip.className = 'sessAgent';
    chip.textContent = agName;
    chip.title = `现在这个会话由「${agName}」说话（屋里的人里排最前、且开着的那位，会随开关和顺序变）`;
    t.appendChild(chip);
  }
  /**
   * 【这个屋里还坐着谁】2026-11-01
   *
   * 主人要「一眼看出去哪个会话里有几个人」。服务端已经把名字算好一起送回来了
   * （crew 数组），这里只负责画：一人一个小圆点，标名字第一个字，颜色按名字算，
   * 同一个人在所有会话里颜色都一样。
   *
   * 只挂 3 个，多的收成「+N」——会话列表一行就那么点地方。
   */
  const crew = Array.isArray(s.crew) ? s.crew.filter(Boolean) : [];
  if (crew.length) {
    const box = document.createElement('span');
    box.className = 'sessCrew';
    box.title = `这个会话里坐着：小鱼、${crew.join('、')}`;
    const head = (nm) => String(nm).trim().slice(0, 1) || '·';
    // 颜色用名字哈希到 4 档，稳定不闪：同一个名字永远同一个颜色
    const toneOf = (nm) => {
      let h = 0;
      for (const ch of String(nm)) h = (h * 31 + ch.codePointAt(0)) % 997;
      return 'c' + (1 + (h % 4));
    };
    for (const nm of crew.slice(0, 3)) {
      const dot = document.createElement('i');
      dot.className = toneOf(nm);
      dot.textContent = head(nm);
      dot.title = nm;
      box.appendChild(dot);
    }
    if (crew.length > 3) {
      const more = document.createElement('span');
      more.className = 'sessCrewMore';
      more.textContent = '+' + (crew.length - 3);
      box.appendChild(more);
    }
    t.appendChild(box);
  }
  const sub = document.createElement('div');
  sub.className = 'sessSub';
  const runningNow = typeof window.turnsInFlight !== 'undefined' && window.turnsInFlight.has(s.id);
  sub.textContent = [
    runningNow ? '⏳ 还在跑' : '',
    window.relTime(s.updatedAt),
    s.count ? `${s.count} 句` : '',
    s.preview || '',
  ].filter(Boolean).join(' · ');
  if (runningNow) sub.classList.add('sessRunning');
  main.append(t, sub);
  return main;
}

/* 【2026-11-11 置顶】筛选状态：全部 / 置顶 / 今天 / 最近 7 天。纯前端过滤，
 * 不加后端参数。放 sessionStorage 跟 sessListRev 同一个理由：面板关了再开别失忆。 */
let sessFilterMode = 'all';
try { sessFilterMode = sessionStorage.getItem('sessFilterMode') || 'all'; } catch (e) {}

function sessFilterPass(s) {
  if (sessFilterMode === 'pinned') return Boolean(s.pinned);
  if (sessFilterMode === 'today') {
    const d = new Date();
    return Number(s.updatedAt || 0) >= new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  }
  if (sessFilterMode === 'week') return Number(s.updatedAt || 0) >= Date.now() - 7 * 86400e3;
  return true;
}

export function renderSessList() {
  window.sessList.classList.toggle('bulk', window.bulkMode);
  document.getElementById('sessBulkBar').hidden = !window.bulkMode;
  const bulkBtn = document.getElementById('sessBulk');
  if (bulkBtn) bulkBtn.classList.toggle('on', window.bulkMode);
  if (!window.sessionsCache.length) {
    window.sessList.innerHTML = '';
    const e = document.createElement('div');
    e.className = 'sessEmpty';
    e.textContent = '还没有会话，点上面的「＋ 新会话」开一个吧';
    window.sessList.appendChild(e);
    window.sessHint.textContent = '';
    window.leaveBulkIfEmpty();
    return;
  }
  window.sessHint.textContent = `${window.sessionsCache.length} 个`;
  /* 从「零会话」恢复到有会话时，把空态占位摘掉 —— 它没有 dataset.id，
     不在 keyed diff 的管辖内，不摘会一直赖在列表顶上 */
  const staleEmpty = window.sessList.querySelector('.sessEmpty');
  if (staleEmpty) staleEmpty.remove();
  // 展示排序：当前会话永远置顶；一句没说的空会话沉到底。
  // 为什么：空会话 updatedAt 也新，纯按时间排会把正在聊的会话顶到下面，
  // 切走再回来就得往下滚——看着就像"原来的会话没了"。
  /* 【2026-11-07 修·压缩过的会话被画成空会话】
   * 原来只看 count（主人说过几句）和 preview。
   * 可上下文压过一次之后，主人原话被折成一条摘要，count 就是 0 ——
   * 于是一堆内容的会话在列表里变成灰色的「新会话」，主人以为它废了。
   * 现在多认一个 hasContent（服务端给的「有没有消息」）。
   * 三个都空才算真空。 */
  const isEmpty = (x) => !x.hasContent && !x.count && !x.preview;
  /* 【2026-11-11 置顶 + 筛选】
   * 筛选：先按面板顶部选的模式把不该露面的滤掉（纯前端，不惊动后端）。
   * 【2026-11-13 主人钦点：置顶改「按时间顺序动态排序」】置顶不再是
   * 「按 pinnedAt 静态钉死」的那组——它只当一个排序权重（置顶的永远压过
   * 未置顶的），组内和其余全部按 updatedAt 时间倒序动态排：哪条会话最新，
   * 它就在自己那一层里排最前，列表跟着消息动。当前会话仍排它那层第一，
   * 空会话照旧沉底。 */
  const view = window.sessionsCache.filter(sessFilterPass).sort((a, b) => {
    const pa = a.pinned ? 1 : 0;
    const pb = b.pinned ? 1 : 0;
    if (pa !== pb) return pb - pa;                       // 置顶权重在前
    if (a.id === window.sessionId) return -1;
    if (b.id === window.sessionId) return 1;
    const ea = isEmpty(a) ? 1 : 0;
    const eb = isEmpty(b) ? 1 : 0;
    if (ea !== eb) return ea - eb;      // 有内容的在前，空的在后
    return (b.updatedAt || 0) - (a.updatedAt || 0);      // 纯时间倒序（动态）
  });
  /* 【2026-11-11 筛选】开着筛选时提示「筛出几个 / 共几个」，让人知道还有会话被藏起来了 */
  window.sessHint.textContent = sessFilterMode === 'all'
    ? `${window.sessionsCache.length} 个`
    : `${view.length}/${window.sessionsCache.length} 个`;

  // 现存行按 key 收好（没有 dataset.id 的杂节点——比如 sessEmpty——不参与 diff）
  const oldRows = new Map();
  for (const node of [...window.sessList.children]) {
    if (node.dataset && node.dataset.id) oldRows.set(node.dataset.id, node);
  }
  const seen = new Set();
  let anchor = window.sessList.firstChild;
  for (const s of view) {
    seen.add(s.id);
    const old = oldRows.get(s.id);
    let row;
    if (old && old.__sessSig === sessRowSig(s)) {
      // 一字未变：节点原样保留（这就是「不闪、点了不吞」的全部秘密）
      row = old;
      oldRows.delete(s.id);
    } else if (old) {
      // 内容变了：行节点、改名/删除按钮、监听器全保留，只换里面的 main 块
      row = old;
      oldRows.delete(s.id);
      row.className = 'sessRow'
        + (s.id === window.sessionId ? ' current' : '')
        + (isEmpty(s) ? ' sessEmptyRow' : '');
      row.classList.toggle('picked', Boolean(window.bulkMode && window.picked.has(s.id)));
      const cb = row.querySelector('input.sessPick');
      if (cb) cb.checked = window.picked.has(s.id);
      const freshMain = buildSessMain(s);
      const oldMain = row.querySelector('.sessMain');
      if (oldMain) row.replaceChild(freshMain, oldMain);
      else row.insertBefore(freshMain, row.firstChild);
      /* 【2026-11-11 置顶】按钮不在 main 块里，得单独跟着 pin 状态换字 */
      const pinBtn = row.querySelector('button[data-act="pin"]');
      if (pinBtn) {
        pinBtn.textContent = s.pinned ? '撤顶' : '置顶';
        pinBtn.title = s.pinned ? '取消置顶' : '把这个会话钉在列表最上面';
      }
    } else {
      // 新会话：整行新建
      row = document.createElement('div');
      row.dataset.id = s.id;
      row.className = 'sessRow'
        + (s.id === window.sessionId ? ' current' : '')
        + (isEmpty(s) ? ' sessEmptyRow' : '');
      if (window.bulkMode) {
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'sessPick';
        cb.checked = window.picked.has(s.id);
        cb.dataset.pick = s.id;
        cb.setAttribute('aria-label', '选中这个会话');
        row.appendChild(cb);
      }
      row.append(buildSessMain(s));
      const ren = document.createElement('button');
      ren.type = 'button';
      ren.className = 'mini';
      ren.dataset.act = 'rename';
      ren.textContent = '改名';
      /* 【2026-11-11 置顶】跟改名/删除同一个交互：hover 才露面的 mini 小按钮 */
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'mini';
      pin.dataset.act = 'pin';
      pin.textContent = s.pinned ? '撤顶' : '置顶';
      pin.title = s.pinned ? '取消置顶' : '把这个会话钉在列表最上面';
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mini del';
      del.dataset.act = 'del';
      del.textContent = '删除';
      row.append(ren, pin, del);
    }
    row.__sessSig = sessRowSig(s);
    // 按目标顺序归位：就在锚点位置的行不动，其余搬过去（搬 ≠ 重建）
    if (row === anchor) {
      anchor = anchor.nextSibling;
    } else {
      window.sessList.insertBefore(row, anchor);
    }
  }
  // 这一轮没露面的行 = 被删掉的会话，摘掉
  for (const gone of oldRows.values()) gone.remove();
  /* 【2026-11-11 筛选】筛选把所有会话都滤没了时给一句说明，别让人以为列表坏了 */
  if (!view.length) {
    const e = document.createElement('div');
    e.className = 'sessEmpty';
    e.textContent = sessFilterMode === 'pinned' ? '还没有置顶的会话：把鼠标放到会话行上点「置顶」' : '这个范围里没有会话';
    window.sessList.appendChild(e);
  }
  window.paintBulkCount();
}

/* 【2026-11-11 筛选】给经典脚本（index.html）调的入口：模块作用域里的
 * sessFilterMode 摸不到，挂到 window 上走这一个口子。 */
function sessSetFilter(mode) {
  sessFilterMode = String(mode || 'all');
  try { sessionStorage.setItem('sessFilterMode', sessFilterMode); } catch (e) {}
  renderSessList();
}

/** 筛选片亮灯用：现在选的是哪一档。 */
function sessGetFilter() {
  return sessFilterMode;
}


/* 经典脚本（index.html 里那段）还要按名字直接调这些函数 ——
   模块有独立作用域，不挂回 window 它们就找不到了。 */
Object.assign(window, {
  refreshRunning, renderSessList, sessSetFilter, sessGetFilter,
});
