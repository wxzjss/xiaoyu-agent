// @ts-check
/* 【2026-11-08】加了 @ts-check：编辑器里能对这里做类型推断。
 * 注意：项目没有 tsc 构建，这一行不影响运行；它只让 IDE 给出提示。
 * 全局函数之间互相调用会被标成「未声明」—— 那是拆分后共享全局作用域的代价，忽略即可。 */
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
export function thinkPeekTail(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  /* 【2026-11-08 主人】28 字太短，灰字右边明明还有一大片空。
   * 现在放到 160 字，真正显示多长交给 CSS 的 ellipsis 按容器宽度决定 ——
   * 容器宽就多显示，窄就自动截，不用前端猜。 */
  return flat.length > 160 ? '…' + flat.slice(-160) : flat;
}

export function hubPeekOf(els) {
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
/**
 * 【2026-11-08·DOM class 名收成常量】
 *
 * 柜门这套 class 名原来散在十几个地方写死字符串。好处是改错一处不会有提示，
 * 坏处是改错一处不会有提示 —— 今天已经因为「同一件事写几遍」踩过四轮。
 * 收成常量后，改名字只改这里，IDE 也能跳转。
 */
const HUB_SEL = {
  sum: 'summary',
  name: '.hubname',
  status: '.status',
  peek: '.hubpeek',
  tool: 'details.tool',
  think: 'details.think',
  cardName: '.name',
  errInHub: 'details.tool .status.err',
};

export function syncHubHead(hub, opts) {
  if (!hub) return;
  const o = opts || {};
  const sum = hub.querySelector(HUB_SEL.sum) || hub;
  const name = sum.querySelector(HUB_SEL.name);
  const st = sum.querySelector(HUB_SEL.status);
  const pk = sum.querySelector(HUB_SEL.peek);
  const tools = [...hub.querySelectorAll(HUB_SEL.tool)];
  const thinks = [...hub.querySelectorAll(HUB_SEL.think)];
  const t = tools.length;
  const k = thinks.length;
  /* 哪张卡还在跑（status 文本带「运行」或挂 run 类）*/
  const runCard = tools.find((el) => {
    const s = el.querySelector(HUB_SEL.status);
    const tx = String((s && s.textContent) || '');
    return tx.indexOf('运行') >= 0 || Boolean(s && s.classList.contains('run'));
  }) || null;
  const bad = hub.querySelectorAll(HUB_SEL.errInHub).length;
  /* 警告要排除「正在跑」那种 —— 运行中挂的就是 warn 类，混进来会被当成警告 */
  const warn = tools.filter((el) => {
    const s = el.querySelector(HUB_SEL.status);
    if (!s || !s.classList.contains('warn')) return false;
    return String(s.textContent || '').indexOf('运行') < 0;
  }).length;
  const thinking = o.thinking || null;
  const runName = runCard
    ? String((runCard.querySelector(HUB_SEL.cardName) || {}).textContent || '干活').trim()
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

export function hubRefreshTitle() {
  if (!window._liveHub) return;
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
      const inside = window._liveHub.querySelector("details.think.thinking-now");
      if (inside) return inside;
      const lg = document.getElementById("log");
      if (!lg) return null;
      const kids = [...lg.children];
      const ix = kids.indexOf(window._liveHub);
      for (let i = kids.length - 1; i > ix; i -= 1) {
        const k = kids[i];
        if (k && k.classList && k.classList.contains("think") && k.classList.contains("thinking-now")) return k;
      }
    } catch (e) {}
    return null;
  })();
  syncHubHead(window._liveHub, { thinking: _thinking });
}


/* ── 从 index.html 搬来 ─────────────────────────────── */
export function groupLooseTools() {
  try {
    const lg = document.getElementById('log');
    if (!lg) return;
    let run = [];
    const flush = () => {
      if (!run.length) return;
      const first = run[0];
      const hub = document.createElement('details');
      hub.className = 'toolhub';
      hub.open = false;
      const sum = document.createElement('summary');
      const name = document.createElement('span');
      name.className = 'hubname';
      /* 【2026-11-08 重构】柜门头部交给唯一出口 syncHubHead。
       *
       * 这里原来自己数工具、自己数思考段、自己判断有没有在跑、自己拼文案、
       * 自己给状态定色 —— 而 hubRefreshTitle 和 foldLiveTools 里又各有一份。
       * 今天柜门那个 bug 我改了四轮才全中，就是因为改一处、另两处照旧。 */
      const st = document.createElement("span");
      st.className = "status ok";
      sum.append(name, st);
      hub.appendChild(sum);
      lg.insertBefore(hub, first);
      for (const el of run) hub.appendChild(el);
      try { syncHubHead(hub); } catch (e) {}
      try { window.markHubUserOpened(hub); } catch (e) {}
      run = [];
    };
    /* 【2026-11-05 改·先排掉已经是柜子的东西】
     * 主人报「展开里面还有一个调用 1 次的柜子」—— 柜子套柜子。
     * 归拢时只看直接子节点里的 tool / think，柜子本身绝不参与。 */
    const _pick = (el) => el && el.classList
      && !el.classList.contains('toolhub')
      && (el.classList.contains('tool') || el.classList.contains('think'))
      && !el.closest('details.toolhub');
    /* 【2026-11-05 改】think 也收进来。
     * 屏幕上它们是交错的（工具 / 思考 / 工具 / 思考），只收工具的话，
     * 每张卡都被 think 隔开、各自成一个「调了 1 次」的柜子，等于没收。 */
    for (const el of [...lg.children]) {
      if (_pick(el)) run.push(el);
      else flush();
    }
    flush();
    /* 【2026-11-05】归拢完拍平一次，防嵌套 */
    window.flattenNestedHubs();
  } catch (e) {}
}

export function thinkTitleOf(flat) {
  const s = String(flat || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';
  /* 【2026-11-07 主人】标题要「长到碰到右侧框框边界」。
   * 原来是「第一句 + 最多 40 字」，可一行能放七十来字 ——
   * 于是标题后面永远空出一截，看着像被谁掐断了。
   * 现在只做「取第一句、上限放到 400 字」，视觉上的截断交给 CSS：
   *   .thinkTitle 是 nowrap + overflow:hidden + text-overflow:ellipsis，
   *   它会自己在容器的右边界停下，正好是一条铺满的省略。
   * 400 只是个兜底（防止某个没有句号的超长段把 DOM 撑得没边），
   * 一行装不下这么多，实际永远轮不到它起作用。 */
  const m = /^[^。！？!?；;]{1,400}/.exec(s);
  return String((m && m[0]) || s).trim();
}

export function adoptThink(d) {
  try { window.log.appendChild(d); } catch (e) {}
  const title = d.querySelector('.thinkTitle');
  const meta = d.querySelector('.thinkMeta');
  const body = d.querySelector('.thinkBody');
  const obj = {
    el: d,
    reused: true,
    push(delta) { this.set((body && body._full ? body._full : '') + String(delta || '')); },
    set(text) {
      const t = String(text || '');
      if (body && body._full === t) return;          // 和屏幕上一样就别碰 DOM
      const _cur = body ? (body._full || '') : '';
      if (body) body._full = t;
      if (body) {
        try {
          if (_cur && t.indexOf(_cur) === 0) body.appendChild(document.createTextNode(t.slice(_cur.length)));
          else body.textContent = t;
        } catch (e) { return; }
      }
      const flat = t.replace(/\s+/g, ' ').trim();
      if (title && flat) {
        /* 【2026-11-07 主人】跟实时那块一个口径：不截断，能多长显示多长 */
        title.textContent = thinkTitleOf(flat);
        title.removeAttribute('title');
      }
      if (meta) meta.textContent = t.length + ' 字';
      /* 整组重画送来的是全文快照，灰字也得跟着更新，不然会停在上一拍 */
      try { d.dataset.peek = thinkPeekTail(flat); } catch (e) {}
    },
    finish() {
      if (!body || !body.textContent.trim()) { try { d.remove(); } catch (e) {} }
      if (meta) meta.textContent = (body ? body.textContent.length : 0) + ' 字';
      /* 整组重画收尾：撤掉进行中标记，柜门别一直挂在「正在思考中…」 */
      try { d.classList.remove('thinking-now'); hubRefreshTitle(); } catch (e) {}
      /* 开合状态一个字都不动：主人点开的块，重画多少次都还开着 */
    },
  };
  try { if (body) obj.push(body.textContent); } catch (e) {}   // 让 _full 起点 = 现状
  return obj;
}

/** 工具卡同理：复用那一张，只改字，不再删掉重画（改了内容却整张闪一下也是白闪）。 */
export function adoptTool(d) {
  try { window.log.appendChild(d); } catch (e) {}
  const sum = d.querySelector('summary');
  const pre = d.querySelector('pre');
  try { d.dataset.liveTurn = '1'; } catch (e) {}
  try { window._liveToolEls.push(d); } catch (e) {}
  return { d, sum, pre };
}


/* ── 从 index.html 搬来 ─────────────────────────────── */
export function addTool() {
  // 【2026-10-31 主人要求：抽屉不手动点开就始终闭合】
  // 以前这里是 hub 收着 + 每个 tool 也收着（d.open = false）+ 参数 hidden ——
  // 三层折在一起，界面上就剩两条竖线，点都点不开。
  // 现在：hub 开着、每个 tool 也开着、参数直接显示；
  // 等主人发下一条消息，foldOldHubs() 再把整个 hub 收成一条灰。
  const d = document.createElement("details");
  d.className = "tool";
  /* 【2026-11-02 严格自检抓到的第四个真问题】工具卡要能被「整组重画」清掉。
   *  以前标记打在别处（而且有一处打在 closest('.msg.assistant') 上，工具卡根本没那个容器），
   *  结果快照重画时清不掉自己画的卡 —— 实测跑三条命令后重画两次，屏幕上从 3 张变 5 张。
   *  现在就在建卡这一处打，所有调用点一律带上。 */
  try { d.dataset.liveTurn = "1"; } catch (e) {}
  // 【主人 2026-10-31：不手动点开就始终闭合】
  // 以前这里写 true（干活时摊开），结果一屏全是参数和结果，得猛往下翻才看得见进度。
  // 现在抽屉一律关着：柜门那行「调了 N 次工具」照样实时刷新，想看细节自己拉。
  d.open = false;
  const sum = document.createElement("summary");
  sum.innerHTML = '<span class="name"></span><span class="status"></span>';
  const pre = document.createElement("pre");
  pre.hidden = false;            // 内容照旧塞在 <pre> 里，抽屉关着就看不见，拉开才有
  d.append(sum, pre);
  // 【主人 2026-11-01】干活中先当一张独立的卡挂上去 —— 一眼看得见这次调了什么，
  // 不用先去点开柜门。合不合并等下一个消息弹出来再说（foldLiveTools）。
  /**
   * 【2026-11-05 再改·直接把卡放进柜子，不再走「先 append 再 fold」】
   *
   * 主人报：「新的工具调用还是没在柜子里，刷新一下才在」。
   * 也就是说直播这条路没折上、历史那条（groupLooseTools）折上了。
   *
   * 与其继续查 foldLiveTools 为什么没生效（它依赖 _liveToolEls 这张登记表，
   * 而 hubReset 会在好几个地方把它清空），不如把这一步做死：
   * **建完卡直接决定它进哪个柜子**，一步到位，没有中间态。
   */
  const _attachToHub = () => {
    try {
      /**
       * 【2026-11-05 修·末尾是思考块时，往前找柜子】
       *
       * 主人报：「在新消息位置无论展开什么，新消息一来都会闭合」。
       *
       * 真实链路：她想了想（openThink 建了个 think 块挂在 log 末尾）
       * → 然后调工具 → 这里只看 lastElementChild，看到的是 think
       * → 判定「没有柜子」→ **新建一个柜子**
       * → 原来那个柜子里的卡被搬走 / 或者新柜子另起一段
       * 屏幕上就是「我刚打开的那个柜子没了/闭了」。
       *
       * 现在：从后往前找，跳过 think 和别的东西，找到第一个柜子为止。
       */
      /**
       * 【2026-11-06 修·说过话就该另起一个柜子】
       *
       * 主人报：「原来是说一段话后调一次工具，然后再说一段话；
       * 现在是连说几段话挤在一起，不同段话后的工具调用全在一个柜子里」。
       *
       * 元凶就是下面这个循环：昨天为了修「展开的柜子被新消息挤掉」，
       * 让它从后往前跳过 think **和 msg** 去找柜子 ——
       * 于是她说完一段话（末尾是个 .msg），接着调工具，工具就被塞进了
       * 那句**之前**的老柜子里。说十段话、调三十次工具，全落进同一个柜子，
       * 屏幕上自然不会再有「话—柜子—话—柜子」的节奏。
       *
       * 正确的边界只有一条：**说过话就另起**。
       *   · 末尾是 think → 往前找（思考和紧随的工具是同一段活）
       *   · 末尾是 msg   → 停，另起一个新柜子（我说话了，接下来的活是新的一段）
       *   · 别的一律停
       */
      let _last = window.log.lastElementChild;
      for (let _guard = 0; _guard < 6 && _last; _guard++) {
        if (_last.classList && _last.classList.contains('toolhub')) break;
        if (_last.classList && _last.classList.contains('think')) {
          _last = _last.previousElementSibling;
          continue;
        }
        _last = null;
        break;
      }
      const _okHub = _last && _last.classList && _last.classList.contains('toolhub')
        && !(_last.parentElement && _last.parentElement !== window.log);
      if (_okHub) {
        _last.appendChild(d);
        /* 【2026-11-05】塞进已有柜子时也把指针接上，标题才会跟着涨 */
        try { window._liveHub = _last; } catch (e) {}
        return _last;
      }
      const h = document.createElement('details');
      h.className = 'toolhub';
      h.open = false;
      try { h.dataset.liveTurn = '1'; } catch (e) {}
      const sum = document.createElement('summary');
      sum.innerHTML = '<span class="hubname"></span><span class="status ok"></span><span class="hubpeek"></span>';
      h.appendChild(sum);
      try { window.markHubUserOpened(h); } catch (e) {}
      window.log.appendChild(h);
      h.appendChild(d);
      /**
       * 【2026-11-05 修·新柜子顶上光秃秃没字】
       *
       * 上面那个 summary 是空壳，等着 hubRefreshTitle 来填。
       * 可 hubRefreshTitle 只认 `_liveHub` —— 新建柜子时没把指针交过去，
       * 它就什么都不做，于是柜门那一行永远是空的。
       * 这里把指针接上，后面 push 完会自然刷出「正在读取…」。
       */
      try { window._liveHub = h; window._liveHubCount = 1; } catch (e) {}
      return h;
    } catch (e) { return null; }
  };
  /* 先把还没收的思考块收掉，免得它夹在 log 末尾、导致新柜子开到它后面 */
  try { foldLiveTools(); } catch (e) {}
  const _myHub = _attachToHub();
  window._liveToolEls.push(d);
  window.noteNewContent();
  /**
   * 【2026-11-05 改·建完立刻收进柜子】
   *
   * 以前是「干活时先摊着，等下一条消息才收」——本意是让人一眼看见进度。
   * 但主人要的是**始终折叠**：一句话说完、屏幕上一排卡摊着，看着乱。
   *
   * 现在建完就收：柜门那行「调了 N 次工具」实时更新，想看细节点开，
   * 不想看就是一行。摊开的中间态没有了。
   */
  try { foldLiveTools(); } catch (e) {}
  /* 【2026-11-05 加】建完立刻把柜门刷一遍 —— 名字这时还是空的（调用方紧接着才填），
   * 但至少能先把「调了 1 次工具」这个计数写上去，不至于顶着空白柜门。
   * 调用方填完 name 之后还会再刷一次（见 tool_start 那段）。 */
  try { hubRefreshTitle(); } catch (e) {}
  /* 【2026-11-05】每次建卡后拍平一次，防嵌套 */
  try { window.flattenNestedHubs(); } catch (e) {}
  return { d, sum, pre };
}

/**
 * 【2026-11-07 主人】柜门右侧那截灰字，思考时要跟着流不断变。
 * 取**尾部**而不是开头：思考是从头往后长的，取开头那几个字永远不变，
 * 取最后一小截才看得出「她正在想什么」。28 字刚好塞得进 62% 的一行，
 * 不会被 CSS 的 ellipsis 再切一刀。
 */




export function foldLiveTools() {
  /* 【2026-11-07】第一次合柜时顺手把「散卡自愈守卫」装上（只装一次）。
   * 挂在这里而不是启动流程里：启动那段在闭包深处，改起来容易碰坏别的东西；
   * 而合柜这件事本身就是「工具卡要进柜」这条链的入口，挂这儿最贴题。 */
  try { window.installToolLeakGuard(); } catch (e) {}
  const _tools = (window._liveToolEls || []).filter((el) => el && el.isConnected);
  window._liveToolEls = [];
  /**
   * 【2026-11-07 加·合柜子时别把主人正在看的地方拽走】
   *
   * 主人报：「返回最新消息位置，此时柜子还是展开的，然后又被弹到很久以前会话位置」。
   *
   * 根因：这个函数把散在外面的工具卡/思考块**移进柜子**（appendChild 到别处）。
   * 柜子收起时高度骤减（几十行变一行），浏览器会把 scrollTop 夹小；
   * 下一秒新内容又补回来，可 scrollTop 已经停在那个偏小的值上 ——
   * 视觉上就是「嗖地跳到很早以前」。
   *
   * 修法：**柜子展开着的时候**先记住视口顶端那个元素的绝对位置，
   * 移完在下一帧把它拉回原处。没展开时不记（那时不会有理解上的损失，
   * 而且每来一张卡都算一遍位置太浪费）。
   */
  const _log0 = document.getElementById('log');
  const _hubOpen = !!(window._liveHub && window._liveHub.open);
  let _keep = null;
  if (_hubOpen && _log0) {
    try {
      const base = _log0.getBoundingClientRect().top;
      for (const el of _log0.children) {
        const r = el.getBoundingClientRect();
        if (r.bottom > base + 2) { _keep = { el, off: r.top - base }; break; }
      }
    } catch (e) { _keep = null; }
  }
  const _restore = () => {
    if (!_keep || !_log0) return;
    /* 【2026-11-08 修·工具完成时画面「弹一下再弹回来」】
     * 这里的补偿是「把视口拉回移动前的位置」，而工具收尾那边还会 noteNewContent()
     * → followNow() → 滚到底。两套一起动：先被拉回原位、下一帧又被蹬到底，
     * 看着就是「弹一下再弹回来」。
     * 用户本来就贴着底看（stickBottom）时，跟着到底才是他要的，
     * 这时候就别做位置补偿了。 */
    try { if (typeof window.stickBottom !== 'undefined' && window.stickBottom) return; } catch (e) {}
    requestAnimationFrame(() => {
      try {
        if (!_keep.el || !_keep.el.isConnected) return;
        const base = _log0.getBoundingClientRect().top;
        const docTop = _keep.el.getBoundingClientRect().top - base + _log0.scrollTop;
        _log0.scrollTop = Math.max(0, docTop - _keep.off);
      } catch (e) {}
    });
  };
  /**
   * 【2026-11-05 加·思考链也收进柜子】
   *
   * 主人要求：「把所有工具调用以及思考显示放进【调用了x次工具】里面」。
   *
   * 原来柜子只装工具卡，思考链在外面单独躺着 —— 一轮里她想了想、调几下、
   * 再想、再调，屏幕上就是「思考 / 工具 / 思考 / 工具」一路铺下去，很长。
   *
   * 现在两者都收进来，按屏幕上的先后顺序排（compareDocumentPosition），
   * 主人点开柜子还是一条时间线，但收起时只剩一行。
   */
  /**
   * 【2026-11-05 修·只取还没进柜子的】
   *
   * 这里原来用的是 log.querySelectorAll —— 那是**递归**查，会把已经在
   * toolhub 里面的 think 也捞出来，再塞进一个新建的柜子 → 柜子里套柜子，
   * 每加一张卡就多套一层。必须只看 log 的**直接子节点**。
   */
  const _logEl = document.getElementById('log');
  const _thinks = _logEl
    ? [..._logEl.children].filter((el) => el && el.classList && el.classList.contains('think'))
    : [];
  /**
   * 【2026-11-05 加·进柜前再筛一遍】
   *
   * 上面 _tools / _thinks 分别来自登记表和 DOM 查询，理论上都不该含柜子。
   * 但主人确实看到了「调了 1 次的柜子里还有一个调了 1 次的柜子」——
   * 与其继续追是哪条路径漏的，这里做最后一道：**柜子永远不许被塞进柜子**。
   */
  const arr = [..._tools, ..._thinks]
    .filter((el) => el && el.classList && !el.classList.contains('toolhub'))
    .sort((a, b) => {
    try {
      if (a === b) return 0;
      return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1;
    } catch (e) { return 0; }
  });
  /**
   * 【2026-11-05 改·哪怕只有一件也折叠】
   *
   * 主人要的是「全部折叠成一行标题」，不是「多了才折」。
   * 原来这里 `< 2` 就 return，于是只调一次工具的那一轮，
   * 卡片照样大喇喇摊在屏幕上，跟折叠过的那些长得完全不一样。
   */
  /**
   * 【2026-11-05 改·没调工具就不建柜】
   *
   * 主人要：「只是想了一段没调工具，就不要显示『调用了 0 次工具』」。
   *
   * 之前把 think 也算进 arr，于是「只想了想没动手」也会建一个柜子，
   * 标题写着「调了 0 次工具 · 想了 1 段」—— 那句「调了 0 次」是废话。
   *
   * 现在只有真调了工具才建柜；纯思考的轮次，思考块自己本来就是可折叠的，
   * 单独待着就好。
   */
  /* 【2026-11-05 再改】只有思考也要折叠 —— 主人要的是「想了 1 段」这一行，
   * 不是把思考块散着放。标题那边按有无工具分三种写法。 */
  if (arr.length < 1) return;
  const first = arr[0];
  const parent = first.parentNode;
  if (!parent) return;

  /**
   * 【2026-11-05 加·塞进隔壁已经有的柜子，别每次新建】
   *
   * 现在 addTool 建完卡就调一次这里，于是连着三次工具 = 三个「调了 1 次工具」。
   * 主人要的是**一个柜子**，里面装着这一轮干的全部活。
   *
   * 判据：紧挨着的那个兄弟是不是本轮的 toolhub —— 是就往里塞、把标题重算。
   */
  /**
   * 【2026-11-05 修·别要求前一个柜子带 liveTurn 标记】
   *
   * 原来判据是「紧邻的兄弟是 toolhub **且带 data-live-turn="1"**」。
   * 可历史归拢（groupLooseTools）建的柜子没有这个标记 ——
   * 于是一个会话里前面那些柜子是归拢出来的，新工具卡一来就判定「没有相邻柜子」，
   * 自己另开一个散在外面（或者单开一个柜）。
   *
   * 改成：只要是柜子就往里塞。反正它是紧挨着的，就是同一段活儿。
   */
  const _prev = first.previousElementSibling;
  if (_prev && _prev.classList && _prev.classList.contains('toolhub')) {
    for (const el of arr) {
      if (!el || (el.classList && el.classList.contains('toolhub'))) continue;
      try { _prev.appendChild(el); } catch (e) {}
    }
    /**
     * 【2026-11-08 修·「柜子标题始终不随调用变化」】
     *
     * 这条分支把新卡塞进**已经存在的柜子**（历史归拢出来的那个也算），
     * 可接手之后没把 `_liveHub` 指过去 —— 于是后面每一次 hubRefreshTitle()
     * 都打在旧指针（或者是 null）上，标题/状态/灰字全都不动。
     * 主人看到的「始终是调了 x 次工具、从来不涨」就是这个。
     *
     * 塞完就把指针接上来，跟 _attachToHub 那条路一个规矩。
     */
    try { window._liveHub = _prev; } catch (e) {}
    /* 【2026-11-08 重构】同样是交给唯一出口。
     * 这里原来是第三份手写逻辑（数工具、判运行中、拼三种文案、定色），
     * 也是主人几轮截图里最常走到的那个柜子 —— 卡一张张往里塞，标题却不动。 */
    try { syncHubHead(_prev); } catch (e) {}
    _restore();
    return;
  }
  const hub = document.createElement('details');
  hub.className = 'toolhub';
  /* 柜子是 foldLiveTools 合出来的，里面装的是直播画的卡 —— 也算「我自己画的」，一并清 */
  try { hub.dataset.liveTurn = '1'; } catch (e) {}
  hub.open = false;                        // 收起来，主人点开才是一排抽屉
  try { window.markHubUserOpened(hub); } catch (e) {}
  /**
   * 【2026-11-05 改·打开柜子时，里面的工具直接摊开】
   *
   * 主人 2026-10-31 定过「柜子里的抽屉要关着」——那时候柜子里只有工具卡，
   * 关着还能看到一排工具名。现在思考块也收进来了，全关着就只剩
   * 「想了 1 段」「读取文件」这些标题，看不出这一轮到底干了什么。
   *
   * 折中：**工具展开**（参数、结果一眼看到），**思考仍收着**（本来就长，
   * 想看再点）。这样打开柜子就是一条完整的工作流水，不用点两层。
   */
  /**
   * 【2026-11-05 撤·别自动展开工具卡】
   *
   * 上一版打开柜子时把里面的工具全摊开 —— 截了一张图才发现：
   * 一屏全是参数和输出，柜门那行反而被顶出视口，跟 dsh 完全不是一回事。
   *
   * dsh 的做法是「一行一条命令，点开才看详情」。所以这里什么都不做，
   * 保持每张卡默认收起（addTool 里 d.open = false 那条规矩回到本意）。
   */
  const hsum = document.createElement('summary');
  const n1 = document.createElement('span');
  n1.className = 'hubname';
  /* 【2026-11-05 改】标题按真实构成写：调了几次工具、想了多久 */
  /**
   * 【2026-11-05 改·标题跟着眼前的事变】
   *
   * 主人提醒：「你折叠的柜子上面的文本会根据内容不断变更」。
   * 对 —— 柜门那一行本来就该是**眼下正在干什么**，而不是一个统计数。
   *
   * 现在分两层：
   *   · 有工具在跑 → 标题就是「正在读取 index.html…」，一个字都不提数字；
   *   · 全跑完了   → 才退回统计：「读文件、跑命令 · 3 次」这样的收尾说法。
   * 后面的 hubpeek 只在「跑完了」时补一句想了什么。
   */
  const _running = _tools.find((el) => {
    const st = el.querySelector('.status');
    const tx = String((st && st.textContent) || '');
    return tx.indexOf('运行') >= 0 || (st && st.classList.contains('run'));
  });
  const _statLine = (_tools.length && _thinks.length)
    ? ('调了 ' + _tools.length + ' 次工具 · 想了 ' + _thinks.length + ' 段')
    : (_thinks.length
      ? ('想了 ' + _thinks.length + ' 段')
      : ('调了 ' + _tools.length + ' 次工具'));
  n1.textContent = _running
    ? ('正在' + String((_running.querySelector('.name') || {}).textContent || '干活').trim() + '…')
    : _statLine;
  const bad = _tools.filter((el) => el.querySelector('.status.err')).length;
  const warn = _tools.filter((el) => el.querySelector('.status.warn')).length;
  const n2 = document.createElement('span');
  n2.className = 'status ' + (bad ? 'err' : (warn ? 'warn' : 'ok'));
  n2.textContent = bad ? (bad + ' 个失败') : '';
  /**
   * 【2026-11-05 加·柜门上直接看到「在做什么 / 想了什么」】
   *
   * 主人要：「在『调了 x 次工具』与『想了 x 段』后面实时显示一小段内容」。
   *
   * 收起状态下只看见一行，以前全是数字、看不出她在干嘛。现在后面挂一小段：
   * 正在跑工具就显示工具名，否则显示最新那段思考的开头。
   */
  const peek = document.createElement('span');
  peek.className = 'hubpeek';
  /* 在跑的时候标题已经是「正在…」，后面不用再跟一句重复的 */
  peek.textContent = _running ? '' : hubPeekOf(arr);
  hsum.append(n1, n2, peek);
  hub.appendChild(hsum);
  parent.insertBefore(hub, first);         // 柜子落在第一张卡原来的位置
  for (const el of arr) hub.appendChild(el);
  _restore();
}


/* 经典脚本（index.html 里那段）还要按名字直接调这些函数 ——
   模块有独立作用域，不挂回 window 它们就找不到了。 */
Object.assign(window, {
  thinkPeekTail, hubPeekOf, syncHubHead, hubRefreshTitle, groupLooseTools, thinkTitleOf, adoptThink, adoptTool, addTool, foldLiveTools,
});
