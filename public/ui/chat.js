

/* ── 从 index.html 搬来 ─────────────────────────────── */
function paintSnapshot(sid, srcLive) {
  /* 先试快路：纯文本在变长时，一个 DOM 节点都不动 */
  try {
    if (tryLiveAppendFast(sid, srcLive)) return;
  } catch (e) { /* 快路出错绝不能连累正常渲染 */ }
  /**
   * 【2026-11-05 加·直播重画也要保住展开状态】
   *
   * 主人说「在新消息位置无论展开什么，新消息一来都会闭合」——这是老 bug。
   * 根因是这条路（paintSnapshot0）会 remove 掉本轮的 think / 卡片再重建。
   * 这里在整段前后做一次快照恢复，不管中间动了什么，出来时开合状态跟进去时一致。
   */
  const __snapBefore = snapOpenState();
  try {
    return paintSnapshotInner(sid, srcLive);
  } finally {
    try { applyOpenState(__snapBefore); } catch (e) {}
  }
}

function paintSnapshotInner(sid, srcLive) {
  try {
    /* 【2026-11-05 主人报：每轮说完末尾都挂一堆 worker 卡】
     * 原来这里把 srcLive.items 里【全部】worker 都存进缓存（items 是按会话全部历史
     * 重建的，所以历史 worker 也在里面）。收尾兜底再按这份缓存全补到 #log 末尾，
     * 于是每轮说完，历史那些卡就整整齐齐出现在最下面。
     *
     * 现在：只在【这一轮还在跑】时更新缓存；收尾那一趟（running === false）不覆盖，
     * 缓存里保留的就是本轮开跑以来那几个 worker。 */
    window.__liveWorkers = window.__liveWorkers || {};
    const _sidKey = String(sid || '');
    if (srcLive && srcLive.running) {
      const _wl0 = (Array.isArray(srcLive.items) ? srcLive.items : []).filter((x) => x && x.k === 'worker');
      const _turnMark = Number(srcLive && srcLive.startedAt) || 0;
      /* 换轮了（startedAt 变了）就重置，避免上一轮的残留混进来 */
      if (!window.__liveWorkersTurn) window.__liveWorkersTurn = {};
      window.__liveWorkersTurnWids = window.__liveWorkersTurnWids || {};
      if (window.__liveWorkersTurn[_sidKey] !== _turnMark) {
        window.__liveWorkersTurn[_sidKey] = _turnMark;
        window.__liveWorkers[_sidKey] = _wl0.slice();
        window.__liveWorkersTurnWids[_sidKey] = new Set(_wl0.map((x) => String((x && x.id) || '')));
      } else {
        window.__liveWorkers[_sidKey] = _wl0;
        const _ws = window.__liveWorkersTurnWids[_sidKey] || (window.__liveWorkersTurnWids[_sidKey] = new Set());
        for (const x of _wl0) _ws.add(String((x && x.id) || ''));
      }
    }
  } catch (e) {}
  /* 【2026-11-03】重画期间让滚动那块知道「高度变化是我们自己造成的」 */
  try { window.__repainting = (Number(window.__repainting) || 0) + 1; } catch (e) {}
  /* 【2026-11-03 修·点开的思考链一会儿自己关上了】
   *  重画是「先删整块、再照清单画」。主人点开的那块 <details open> 也在被删的那一块里，
   *  重建出来的默认是收起的 —— 于是看着就像「我刚点开，它自己又合上了」。
   *  这里先在删之前把「哪几块是点开的」记下来，画完之后照着恢复。 */
  /**
   * 【2026-11-05 加·翻着历史看她新消息，画面被踹到很久以前】
   *
   * 主人报：「滚轮往上翻历史时她发新消息，会跳到很久远以前的位置」。
   *
   * 根因：重画是「先删整块、再照清单画」。删完那一刻内容高度骤降，
   * 浏览器会把 scrollTop **夹到新的最大值**（可能就剩几百像素）。
   * 下面 finally 里只有在 `stickBottom`（贴着底）时才补滚 ——
   * 而主人正往上翻，stickBottom 是 false，**没有任何人把位置还回去**，
   * 于是画面就停在夹小之后的那个很靠上的位置。
   *
   * 现在记下重画前的 scrollTop，画完原样还回去。
   * 还的时候只认「不贴底」的情况：贴底的人本来就该被带到最新。
   */
  const __stBefore = (log && !stickBottom) ? log.scrollTop : -1;
  /**
   * 【2026-11-05 加·用「锚点消息」而不是像素位置】
   *
   * 主人报：「刷新后往上翻、点开一个思维链，新消息出来时被弹到很久远以前」。
   *
   * 上一版记的是 scrollTop 这个**数字**，画完原样设回去。可这招有个硬伤：
   * 重画前后**内容高度不一样**（思维链展开/收起、工具卡增减、图片加载完），
   * 同一个 scrollTop 对应的内容就变了 —— 历史越多、差得越远。
   * 而且点开思维链这个动作本身就会改高度，正好踩在刀口上。
   *
   * 现在改成记**人**：视口顶部第一条带 data-at 的消息，以及它离视口顶的偏移。
   * 画完把同一条消息挪回同样的偏移 —— 内容怎么变都不影响它待在该待的地方。
   * 找不到那条（被删了 / 换轮了）才退回用 scrollTop。
   */
  const __anchor = (() => {
    try {
      if (!log || stickBottom) return null;
      const base = log.getBoundingClientRect().top;
      for (const el of log.querySelectorAll('.msg[data-at]')) {
        const r = el.getBoundingClientRect();
        if (r.bottom > base + 4) return { at: el.dataset.at, off: r.top - base };
      }
    } catch (e) {}
    return null;
  })();

  const __openBefore = [];
  try {
    if (log) {
      log.querySelectorAll('details.think[open]').forEach((d, i) => __openBefore.push(i));
    }
  } catch (e) {}
  try {
    const __r = paintSnapshot0(sid, srcLive);
    try {
      if (log && __openBefore.length) {
        const now = Array.from(log.querySelectorAll('details.think'));
        for (const i of __openBefore) { if (now[i]) now[i].open = true; }
      }
    } catch (e) {}
    return __r;
  } finally {
    try {
      window.__repainting = Math.max(0, (Number(window.__repainting) || 0) - 1);
      /* 【2026-11-05 加】把滚动位置还回去（只对「不贴底」的人）。
       * 下一帧再还：那时重画的 DOM 已经布局完，scrollTop 才设得进去。 */
      if (log && (__anchor || __stBefore >= 0)) {
        requestAnimationFrame(() => {
          try {
            if (stickBottom) return;   // 贴底的人就该被带到最新
            if (__anchor) {
              const el = log.querySelector('.msg[data-at="' + __anchor.at + '"]');
              if (el) {
                /**
                 * 【2026-11-05 修·补偿量算反了】
                 *
                 * 上一版写的是 `log.scrollTop += (now - want)`，其中
                 * now = el.getBoundingClientRect().top - log.getBoundingClientRect().top
                 * 那是**视口坐标**，里面已经含了当前 scrollTop 的影响。
                 * 而重画刚结束时浏览器把 scrollTop 夹小过，于是 now 偏小 →
                 * 差值是负的 → 又在已经偏上的位置上**继续往上滚** ——
                 * 越修越远，正好是主人说的「停在很久远以前」。
                 *
                 * 现在用**文档坐标**算绝对位置：
                 *   锚点的文档位置 = (相对可视区的位置) + scrollTop
                 *   要让它离视口顶 off 像素 → scrollTop = 文档位置 - off
                 */
                const base = log.getBoundingClientRect().top;
                const docTop = el.getBoundingClientRect().top - base + log.scrollTop;
                log.scrollTop = Math.max(0, docTop - __anchor.off);
                return;
              }
            }
            if (__stBefore >= 0) log.scrollTop = __stBefore;
          } catch (e) {}
        });
      }
      /*
       * 【2026-11-03 修·切回一个正在跑的会话，画面停在半路不跟到底】
       *
       *  重画是「先删整块、再照清单画」，中途内容比原来矮 → 浏览器把 scrollTop 夹小。
       *  重画一结束就同步记认，会把「被夹小后的位置」当成主人的位置；紧接着来的
       *  scroll 事件就对不上，跟随状态被摘掉 —— 画面永远停在半路，箭头一直亮着，
       *  主人报的「切回来没有自动跳到最新消息位置」正是这个。
       *
       *  现在：① 结束瞬间开一个 260ms 的静默窗口，期间的 scroll 只同步记认；
       *        ② 下一帧（布局稳定后）如果还在跟随，就补一次贴底，并把记认对齐。
       */
      __ignoreScrollUntil = Date.now() + 260;
      /* 【2026-11-03 修·发新消息时画面抽搐一下】
       *  原来这里连着补滚两拍：下一帧一拍、120ms 后再一拍。
       *  重画本身已经是「先删再建」，中途高度变矮、scrollTop 被夹小，
       *  然后一拍拉到底、再一拍又拉一次 —— 主人看到的就是「画面抽一下」。
       *
       *  现在只留一拍（下一帧，那时布局已经稳定），后面那拍删掉。
       *  如果字体/图片真把高度又撑开了一点，交给 stickMo / stickPoll 那两条
       *  跟随通道去补 —— 它们每次只补「差多少」，不会整屏跳。
       */
      requestAnimationFrame(() => {
        try {
          if (stickBottom && log) hardScrollBottom();
          _lastDocH = log ? log.scrollHeight : _lastDocH;
          _lastTop = log ? log.scrollTop : _lastTop;
        } catch (e) {}
      });
    } catch (e) {}
  }
  /* 【2026-11-03·卡只增不闪，收尾才回收】
   * 这一轮清单里已经没有的门牌号，说明那个子任务彻底过去了 —— 现在才把卡删掉。
   * 只要清单里还有，卡就一直待在原地（内容就地更新，不摘不建，永远不会闪）。 */
  try {
    const _alive = new Set();
    try {
      for (const _n of document.querySelectorAll('#log details.wcard[data-live-turn="1"]')) {
        const _k = String((_n.dataset && _n.dataset.wid) || '');
        const _src = (window.__liveWorkers && window.__liveWorkers[String(sid || '')]) || [];
        if (_k && !_src.some((x) => String(x.id) === _k)) { try { _n.remove(); } catch (e) {} if (_k) _wcardByWid.delete(_k); }
        else if (_k) _alive.add(_k);
      }
    } catch (e) {}
  } catch (e) {}
  /* 【2026-11-03 兜底·子任务卡不许凭空消失】
   * 重画这条路出口太多（跑完那道闸、空清单、异常……），每个出口都可能把屏幕上的
   * 子任务卡带走而不再画回来 —— 主人看到的就是「卡闪一下就没了」，办事模式下
   * 等于「看不见谁在干活」。这里统一收口：画完检查一遍，这个会话事件流里明明有卡、
   * 屏幕上却一张都没有，那就补回来。历史接管之后（屏幕上有历史卡）这里不动。 */
  try {
    const _keep = (window.__liveWorkers && window.__liveWorkers[String(sid || '')]) || null;
    if (_keep && _keep.length) {
      const _lg2 = document.getElementById('log');
      /* 【2026-11-05 主人报：每轮说完末尾挂一堆 worker 卡】
       * __liveWorkers 现在只记【本轮】（见上面「缓存只记本轮」那段），
       * 所以这里补回来的本来就只有本轮那几张。
       * 再加一道闸：缓存里若混进了更早的轮（门牌集合对不上），按最近一次开跑
       * 的门牌集合过滤;拿不到集合就不过滤（缓存本身就是本轮的）。 */
      const _sidKey2 = String(sid || '');
      const _mine = (window.__liveWorkersTurnWids && window.__liveWorkersTurnWids[_sidKey2]) || null;
      const _keep2 = _mine ? _keep.filter((x) => x && _mine.has(String(x.id))) : _keep;
      if (_lg2 && !_lg2.querySelector('details.wcard')) for (const _it of _keep2) paintWorkerCard(_it, null);
    }
  } catch (e) {}
}

function paintSnapshot0(sid, srcLive) {
  const items = Array.isArray(srcLive) ? srcLive : (srcLive && Array.isArray(srcLive.items) ? srcLive.items : null);
  if (!items) return null;
  if (typeof sid === 'string' && sessionId !== sid) return null;
  /**
   * 【空清单 = 没有快照，不是「什么都不该有」】—— 2026-11-02 严格自检抓到的真问题
   *
   *  实测：一个已经跑完的会话，拿 { items: [] } 调一次，屏幕上那份 4234 字的正文
   *  当场被清空，只剩开头那条招呼 —— 因为清理那段（①②）先把自己的东西删了，
   *  然后「照清单从头画」这一遍什么都没画。
   *
   *  什么时候会走到：服务端重启后 live 没了、或者这一轮刚开跑一个字还没吐，
   *  拉回来的 items 就是空的。这时候屏幕上的东西是「上一次画好的」，不该动它 ——
   *  要更新内容，靠的是「跑完之后按历史对齐（settleFromHistory）」那条路。
   *
   *  一句话：空的快照只能说明「我这边没话可说」，不能说明「屏幕上不该有东西」。 */
  if (!items.length) return null;
  /**
   * 【2026-11-02 严格自检抓到的第五个真问题】跑完之后，一个字都不许照直播快照画。
   *
   *  直播事件流有上限（服务端 LIVE_SOFT_MAX），长回复会被压薄 —— 正文中间整段丢掉。
   *  实测：5892 字的长回复，跑完时事件流只剩 5421 字。
   *
   *  原来这里有道「信历史」的闸，判据是「屏幕上那个历史正文容器不比快照短」。
   *  可清理那一段是先跑的（它会把「历史里本轮那半截」删掉交给重画），闸再判时
   *  那个容器已经没了 —— 于是照压薄的快照重画：完整的历史被短的一版盖掉。
   *
   *  根治的办法不是加判据，是划清边界：这一轮结束了，屏幕长什么样由**历史**说了算。
   *  直播快照只负责「还在跑的那一轮」。跑完的对齐走 settleFromHistory（按历史整屏重画）。
   */
/* 【2026-11-06 主人报「每轮说完这段提示都出现在末尾」·真根因】
   * 上一轮的 worker 卡（details.wcard）从来没被清掉，三个漏洞叠在一起：
   *   ① 开跑时清理只摘 .think/.tool，.wcard 为了不闪「只登记不摘」
   *   ② 跑完时下面那句 if (!_wl.length) return null —— 这一轮没派活就直接返回，也不清
   *   ③ 于是第一次派活画上去的那几张卡永远钉在 DOM 里，每轮都看得见
   * 修法：换轮（startedAt 变了）那一刻把旧卡全清一次；同一轮里纹丝不动，所以不闪。
   */
  try {
    const _sid0 = String(sid || '');
    const _at0 = Number(srcLive && srcLive.startedAt) || 0;
    if (_at0 > 0) {
      const _bags = (window.__turnAt || (window.__turnAt = {}));
      if (_bags[_sid0] !== _at0) {
        _bags[_sid0] = _at0;
        const _lg0 = document.getElementById('log');
        if (_lg0) {
          for (const _n of _lg0.querySelectorAll('details.wcard')) {
            try { _n.remove(); } catch (e) {}
          }
        }
        try { _wcardByWid.clear(); } catch (e) {}
      }
    }
  } catch (e) {}

  /* 【2026-11-03 修·跑完就没了（主人原话：「只显示一句派活 运行中…然后没了」）】
   * 跑完之后正文由历史说了算（这层闸是对的），但办事模式下「这一轮谁干了什么」
   * 历史里没有存，它只活在事件流里 —— 一进这层闸，那张子任务卡就跟着被抹掉，
   * 屏幕上只剩正文，主人以为子智能体白跑了。
   * 所以：跑完也把子任务卡留住（只留卡，别的一概不管），下一轮开跑时再按标记清掉。 */
  if (srcLive && srcLive.running === false) {
    const _wl = (Array.isArray(srcLive.items) ? srcLive.items : []).filter((x) => x && x.k === 'worker');
    /* 【2026-11-06 主人报「每轮说完那几张 worker 卡都出现在末尾」·真根因】
     * 原来这里第二行是 if (!_wl.length) return null;
     * —— 这一轮没派活就直接返回了，屏幕上上一轮留下的卡一张都没清，
     *   于是它们从第一次派活起就永远钉在聊天区最底下，每轮都看得见。
     * 现在改成：不管这轮有没有派活，先把屏幕上所有 worker 卡清干净，
     * 再按本轮清单重画（有就画，没有就空着）。
     */
    try {
      const _lg = document.getElementById('log');
      if (_lg) for (const n of _lg.querySelectorAll('details.wcard')) { try { n.remove(); } catch (e) {} }
      try { _wcardByWid.clear(); } catch (e) {}
    } catch (e) {}
    if (!_wl.length) return null;
    try {
      for (const it of _wl) paintWorkerCard(it);
    } catch (e) {}
    return null;
  }
  /* 本轮正文（用来判断历史里那块是不是本轮的半截）。洗 markdown + 抹空白，两边同一套口径。 */
  const nrm = (s) => { try { return String(fixMojibake(String(s || '')) || '').replace(/\s+/g, ''); } catch (e) { return String(s || '').replace(/\s+/g, ''); } };
  let bodyText = '';
  for (const it of items) if (it && it.k === 'text') bodyText += String(it.t || '');
  /* ① 先清掉自己画过的那一组（正文容器 + 提示行）
   *
   *  【2026-11-02 严格自检抓到的真问题】提示行原来没清理。
   *  快照里带 note 的那一轮（插话提醒、限流提示），每重画一次就多挂一条：
   *  实测同一份快照连调三次，屏幕上从 1 条变成 4 条一模一样的提示。
   *  正文容器有 data-live-turn 标记所以清得掉，提示行当时没标记 —— 现在补上。
   *  只清带标记的：别处（重发按钮、断线说明）画的提示不带标记，一个都不能动。 */
    /* 整组重画时「复用」自己画的块（而不是删掉重建）——详见下面 adoptThink 的说明。
     * 这两个声明必须待在函数体里（上一个版本误放在 ① 的 try 块内，导致后面取不到）。 */
    const _reuseEls = [];
    const takeReuse = (kind) => {
      for (let i = 0; i < _reuseEls.length; i++) {
        const el = _reuseEls[i];
        const isThink = el.classList.contains('think');
        const isWorker = el.classList.contains('wcard');
        const isTool = !isThink && !isWorker;
        if ((kind === 'think' && isThink) || (kind === 'tool' && isTool) || (kind === 'worker' && isWorker)) {
          _reuseEls.splice(i, 1);
          return el;
        }
      }
      return null;
    };
  try {
    for (const c of document.querySelectorAll('.msg.assistant[data-live-turn="1"]')) {
      try { c.remove(); } catch (e) {}
    }
    for (const n of document.querySelectorAll('.sysnote[data-live-note="1"]')) {
      try { n.remove(); } catch (e) {}
    }
    /* 【2026-11-02 严格自检抓到的第二个真问题】别人说的话原来也不清。
     *  小鲸那句正在流式长（「我」→「我来」→「我来说」），每重画一次就多一条：
     *  实测五个字蹦出来，屏幕上留下五条气泡。
     *  现在快照画的 say 都带 data-live-turn，重画时一起清；
     *  流式那条在定稿前不带标记，所以正在写的不会被打断。 */
    for (const w of document.querySelectorAll('.msg.whale[data-live-turn="1"], .msg.mate[data-live-turn="1"]')) {
      try { w.remove(); } catch (e) {}
    }
    /* 【2026-11-02 严格自检抓到的第三个真问题】思考块和工具卡原来也不清。
     *  它们不是挂在 .msg.assistant 里面，而是直挂 #log 的 <details>：
     *  于是每重画一次就多一份「正在想…」和多一张「跑命令 完成」。
     *  实测连画三次：思考块 1→4、工具卡 1→6。现在一律打标记、一律清。 */
    /* 注意选择器：聊天区那个容器的 class 是空的，只有个名叫 log 的 id ——
     * 一开始写成 `.log .tool` 一个都选不中（标记打上了、照样原地叠），别再这么写。 */
    /* 【2026-11-02 主人报「思考链抽搐、疯狂展开闭合」+「手动打开还会自动闭合」】
     * 原来这一组一律 remove，紧接着照清单重建 —— 正在想的那一块每秒被删掉重来一次，
     * 重建出来的是「收起」的新块，视觉上就是抽搐；主人手动点开的那个也一并被换掉，
     * 看着就是「刚点开又自动闭合」。
     * 现在改成：先把它们收起来（remove 前记一笔），下面照清单画时按顺序**复用** ——
     * 内容没变就连一个 DOM 属性都不碰，开合状态（含主人手动开的）自然连续。 */
    try {
      const lg = document.getElementById('log');
      if (lg) {
        try {
          for (const t of lg.querySelectorAll('.think[data-live-turn="1"], .tool[data-live-turn="1"]')) _reuseEls.push(t);
          /* 子任务卡不走这条路（见 _wcardByWid 的说明）：只登记，不摘下来 */
          for (const t of lg.querySelectorAll('.wcard[data-live-turn="1"]')) {
            const _k = String((t.dataset && t.dataset.wid) || '');
            if (_k) _wcardByWid.set(_k, { d: t, sum: t.querySelector('summary'), pre: t.querySelector('pre') });
          }
        } catch (e) {}
        for (const t of lg.querySelectorAll('.think[data-live-turn="1"], .tool[data-live-turn="1"]')) {
          try { t.remove(); } catch (e) {}
        }
        /* 柜子（foldLiveTools 合出来的 toolhub）自己不带标记 —— 里面被清空了就一起扔掉，
         * 省得屏幕上留一个「调了 N 次工具」的空柜门。 */
        for (const h of lg.querySelectorAll('.toolhub')) {
          try { if (!h.querySelector('.tool')) h.remove(); } catch (e) {}
        }
      }
    } catch (e) {}
    /* ② 再看历史里有没有「本轮那半截」：内容是本轮正文的开头（或整段都在正文里）就交给我们重画。
     *  这一步只在快照有正文时做 —— 空快照不许动历史。 */
    const nb = nrm(bodyText);
    if (nb.length >= 8) {
      /* 【2026-11-02 主人报「只要出现新消息，上下文就上下抽一下，翻到很久之前也一样」】
       *  真机实测（会话【抽搐】）：主人盯着的那条旧气泡在每拍重画时被 remove 掉了 ——
       *  节点一被摘掉浏览器就重排一次，看着就是「抽一下」。实测：
       *  t 34867→34915、h 35493→35541，而那块气泡的 isConnected 由 true 变 false。
       *  该交给重画的只有「本轮那半截」，而它只可能是列表**最后一个** assistant 容器；
       *  视口上方那些旧消息永远不该被这一步碰到。判据收窄成「只检查最后一个」。 */
      const _cands = [...document.querySelectorAll('.msg.assistant')].filter((c) => c.isConnected && c.dataset.liveTurn !== '1');
      const _tail = _cands.length ? [_cands[_cands.length - 1]] : [];
      for (const c of _tail) {
        if (!c.isConnected || c.dataset.liveTurn === '1') continue;
        const bs = [...c.querySelectorAll('.bubble')];
        let j = '';
        for (const b of bs) j += String((typeof b._rawText === 'string' && b._rawText) ? b._rawText : (b.textContent || ''));
        const nj = nrm(j);
        if (!nj || nj.length < 8) continue;
        if (nb.indexOf(nj) === 0 || nj.indexOf(nb) === 0) { try { c.remove(); } catch (e) {} }
      }
    }
    /* 【同一件事，思考块也要算「本轮那半截」】2026-11-02
     *  历史重画那块思考走的是 paintReasoning（.think.thinkPast，不带 live-turn 标记），
     *  上面那一步只清 .msg.assistant —— 于是快照照清单再画一遍思考时，
     *  屏幕上就出现两块内容一样的思考。实测：切进一个正在想的会话，思考块 1 → 3。
     *  判据和正文同一套：历史那块的字是清单里某条 think 的开头（或整段都在里面）就交给重画。 */
    try {
      const _thinkTexts = items.filter((x) => x && x.k === 'think').map((x) => nrm(x.t));
      if (_thinkTexts.length) {
        for (const d of document.querySelectorAll('.think')) {
          if (d.dataset.liveTurn === '1') continue;
          const bd = d.querySelector('.thinkBody') || d;
          const t = nrm(bd.textContent);
          if (!t || t.length < 8) continue;
          if (_thinkTexts.some((s) => s && (s.indexOf(t) === 0 || t.indexOf(s) === 0))) { try { d.remove(); } catch (e) {} }
        }
      }
    } catch (e) {}
  } catch (e) {}
  /* ③ 照清单从头画一遍 */
  let lastBubble = null;
  let toolEls = null;
  let think = null;
  const closeThink = () => { if (think) { try { think.finish(); } catch (e) {} think = null; } };
  /**
   * 【2026-11-05 加·思维链把一句话劈成两半】
   *
   * 主人报：「思考链消息有时会把说的话截断成 —— 消息1234 / 思考链 / 567」。
   *
   * 清单是按发生顺序给的：[text, think, text] 就画成「气泡 · 思维链 · 新气泡」，
   * 同一段话被思维链从中间切开，读起来就是断的。
   *
   * 现在：如果一条 think 后面紧跟的还是文字（说明她只是想到一半又接着说），
   * 就把它**延后**到那段文字之后 —— 文字连成一整段，思考块跟在这段后面。
   * 其它情况（think 后面是工具调用 / 结尾）照旧就地画。
   */
  let _deferredThink = null;
  const _flushDeferredThink = () => {
    if (!_deferredThink) return;
    const _t = _deferredThink;
    _deferredThink = null;
    try {
      const _o = takeReuse('think');
      const _tk = _o ? adoptThink(_o) : openThink();
      try { if (_tk && _tk.el) _tk.el.dataset.liveTurn = '1'; } catch (e) {}
      try { if (typeof _tk.set === 'function') _tk.set(String(_t.t || '')); else _tk.push(String(_t.t || '')); } catch (e) {}
      /* 【2026-11-05】延后补画的那块，内容进去也要刷柜门，不然摘要还是空。 */
      try { hubRefreshTitle(); } catch (e) {}
      try { _tk.finish(); } catch (e) {}
    } catch (e) {}
  };

  for (let _ii = 0; _ii < items.length; _ii++) {
    const it = items[_ii];
    if (!it || !it.k) continue;
    if (it.k === 'text') {
      closeThink();
      /**
       * 【2026-11-05 修·一句话被劈成两个气泡】
       *
       * 上一版只是把 think 挪了位置，可后面那段文字还是**新建了一个气泡** ——
       * 屏幕上照样是「前半句 / 后半句」两个框，只是中间没夹思考块了。
       *
       * 真正的意思应该是：她"想到一半接着说"，那还是同一句话。
       * 所以「刚才有一块思考被延后」= 现在这段文字要**接回上一个气泡**。
       */
      const _cont = _deferredThink && lastBubble;
      const b = _cont ? lastBubble : addAssistantAuto();
      if (!_cont) {
        try { const w = b.closest('.msg.assistant'); if (w) w.dataset.liveTurn = '1'; } catch (e) {}
      }
      pushStreamText(b, String(it.t || ''));
      lastBubble = b;
      /* 【2026-11-05】这段文字画完了，把刚才延后的思考补上（它的原意就是「想到这儿」）。 */
      _flushDeferredThink();
    } else if (it.k === 'think') {
      /* 【2026-11-05】后面紧跟文字 → 先记着，等那段文字画完再画，别把话切断。 */
      const _nx = items[_ii + 1];
      if (_nx && _nx.k === 'text') {
        /* 【2026-11-05 修】连着两条 think 时，前一条会被直接覆盖掉 ——
         * 先把手里那条画掉，再存新的。 */
        _flushDeferredThink();
        _deferredThink = it;
        continue;
      }
      /* 【一段思考一块 —— 2026-11-02 第二次修「抽搐」】
       *  原来是把清单里连着的好几段思考并进同一块：第一段 set 进去没问题，
       *  第二段 set 时它不是第一段的「续写」，整块内容被换掉一次 ——
       *  正在长的思考块每拍被整体重写，看着就是抽搐。
       *  现在按清单 1:1 画：一段一块，各自照自己的文字更新，谁也不动谁。
       *  节点照旧优先复用（takeReuse），所以块的「身份」和展开状态都保得住。 */
      const _oldThink = takeReuse('think');
      think = _oldThink ? adoptThink(_oldThink) : openThink();
      try { if (think && think.el) think.el.dataset.liveTurn = '1'; } catch (e) {}
      try { if (typeof think.set === 'function') think.set(String(it.t || '')); else think.push(String(it.t || '')); } catch (e) {}
      /* 【2026-11-05 加】内容填进去了才刷柜门 —— 建块那一刻正文还是空的，
       * 摘要算出来什么都没有，于是「想了 1 段」后面一直是白板。 */
      try { hubRefreshTitle(); } catch (e) {}
      try { think.finish(); } catch (e) {}
      think = null;
    } else if (it.k === 'tool') {
      closeThink();
      const _oldTool = takeReuse('tool');
      const el = _oldTool ? adoptTool(_oldTool) : addTool();
      /* 工具卡是直挂 #log 的 <details>，closest('.msg.assistant') 根本取不到东西 ——
       * 原来那行等于没打标记，重画时就清不掉、越叠越多。现在直接标在它自己身上。 */
      try { if (el && el.d) el.d.dataset.liveTurn = '1'; } catch (e) {}
      try {
        el.sum.querySelector('.name').textContent = niceTool(it.name, it.args);
        const st = el.sum.querySelector('.status');
        st.textContent = it.status === 'ok' ? '完成' : (it.status === 'err' ? '失败' : '运行中…');
        st.className = 'status ' + (it.status === 'ok' ? 'ok' : (it.status === 'err' ? 'err' : 'warn'));
        el.pre.textContent = (it.args ? '参数：' + tidyToolText(it.args) : '') + (it.output ? '\n--- output ---\n' + tidyToolText(it.output) : '');
      } catch (e) {}
      if (!toolEls) toolEls = new Map();
      if (it.id) toolEls.set(it.id, el);
    } else if (it.k === 'worker') {
      closeThink();
      _paintWorkerCardCore(it, takeReuse);
    } else if (it.k === 'say') {
      closeThink();
      /* 照清单画「别人说的话」：
       *   · 她正说到一半（屏幕上有个流式气泡）→ 先把它定稿到清单这份文字上，别另起一条；
       *   · 没有流式气泡 → 照清单新建一条（force，别被「这一轮画过」挡住）。
       *  两种情况都给它打上 data-live-turn：下一次重画连同它一起清，画多少遍都只有一条。 */
      try {
        const _t = String(it.t || '');
        const _fin = whaleStreamFinish(_t, StreamKey(sid, it.who));
        if (_fin) {
          let _el2 = null;
          try { _el2 = _whaleLastFinishEl ? _whaleLastFinishEl.closest('.msg.whale, .msg.mate') : null; } catch (e) {}
          if (_el2) { try { _el2.dataset.liveTurn = '1'; } catch (e) {} }
        } else {
          const _w2 = addWhaleBubble(it.who, _t, null, true);
          if (_w2) { try { _w2.dataset.liveTurn = '1'; } catch (e) {} }
        }
      } catch (e) {}
      lastBubble = null;
    } else if (it.k === 'note') {
      /* 照快照画的提示打上标记 —— 下一次重画由上面 ① 一并清掉，不会叠 */
      try {
        const nd = addSysNote(String(it.t || '').replace(/^[\s\n]+/, '').trim());
        if (nd) nd.dataset.liveNote = '1';
      } catch (e) {}
    }
  }
  closeThink();
  /* 【2026-11-05 加】清单走完了，延后的思考块（如果有）补画出来 ——
   * 不补就漏了，只在「think 后面紧跟 text」那种形状下才会走到这里。 */
  _flushDeferredThink();
  /* 收尾：把这一轮的记账写在轮次记录上（tool_end 回来还要找工具块） */
  try {
    let rec = turnsInFlight.get(sid);
    if (!rec || typeof rec !== 'object') { rec = {}; turnsInFlight.set(sid, rec); }
    rec.bubble = lastBubble;
    rec.toolEls = toolEls;
    rec.snapshotAt = Date.now();
  } catch (e) {}
  try { noteNewContent(); } catch (e) {}
  return lastBubble;
}

async function attachLive(id) {
  let live = null;
  try {
    live = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(id)).then((r) => r.json());
  } catch {
    return false;
  }
  /* 【2026-11-02 串会话 · 别的会话的内容跑到这个会话里】
   *  这一句 await 可能挂好几百毫秒。主人手快，等它回来的时候屏幕上已经是别的会话了，
   *  而下面那些 paintLiveEvents / followLive 是不认人的 —— 照画不误：
   *  于是 B 会话说的话就长在了 C 会话的屏幕上。
   *  这里补一道闸：回来先看主人还在不在这个会话，不在就一个字节都不画。 */
  /* 【2026-11-05 加·第二版】把这一轮的开始时间记下来，给 showSending 当计时起点。
   *
   * 第一版放错位置了：写在下面那句 `if (sessionId !== id) return false` **之后**。
   * 而刷新的时候，模块级的 sessionId 还没同步过来（boot 是异步的），
   * 于是这句判断命中、直接 return，赋值那行一次都没执行 ——
   * 表现出来就是「F5 之后还是从 0 开始」，改了跟没改一样。
   *
   * 现在放到 return 之前。放这儿是安全的：id 就是这次请求的会话，
   * 记它的 startedAt 本来就不该受「屏幕上现在是谁」影响；
   * 真正用这个值的地方会自己核对 sessionId === id。
   */
  try {
    if (live && live.running) window.__xyLiveStartAt = Number(live.startedAt) || 0;
  } catch (e) {}
  if (sessionId !== id) return false;
  const evs = live && Array.isArray(live.events) ? live.events : [];

  /**
   * 这一轮还该不该「算在跑」，分两种情况看：
   *
   *  1) 本窗口正在跟这一轮（turnsInFlight 里有它，或者屏幕上正跑着它）：
   *     一切以服务端为准，接着轮询就行。
   *  2) 本窗口没在跟：说明是「窗口关过 / 刷新过 / 切回一个后台会话」。
   *     这时候更要紧的是历史：历史里最后一条是主人的话，就说明这条回复还没落盘，
   *     才需要靠直播缓存补画；历史里最后一条是我说的话，那这轮早结束了 ——
   *     服务端那份 running 只是上次进程留下的残骸（它就存在内存里，进程一崩就停在那儿），
   *     再拿它当准就会一直显示「还在跑」：气泡空着、输入框锁着、问什么都像没人应。
   */
  const mine = turnsInFlight.has(id) || (sessionId === id && busy);

  // 一条事件都没有：没东西可补画。是不是还在跑，照上面那套判断说回去。
  if (!evs.length) {
    if (live && live.running) {
      if (mine) return true;
      // 刚打开 / 刚切过来的这一瞬间，屏幕上一眼是空的（或还挂着上一个会话的消息），
      // 这时「历史最后一条是谁说的」说明不了任何事，当它是主人的话处理，
      // 让下面那套轮询去等它吐字 —— 比当场宣布「跑完了」安全。
      /**
       * 服务端说在跑，但直播缓存里一条事件都没有（刚开跑、还没吐字）。
       *
       * 以前这里还要再看「历史最后一条是谁说的」，判 assistant 就不算在跑。
       * 那个判断在切会话时会误伤：刚切回来那一刻屏幕上的历史可能还是上一个会话的，
       * 拿它来决定这一轮算不算在跑，就会把真在跑的一轮判成「跑完了」。
       * 服务端都说在跑了，就以服务端为准 —— 锁输入区，等它吐字。
       */
      /**
       * 【2026-11-01 修·切会话回来旧话重复一遍】
       *
       * 原来这里写死 followLive(id, 0) —— 从第 0 个事件开始画。
       * 可 renderTurns 刚刚已经把整屏历史都画好了，于是同一批话又被画一遍：
       * 主人看到的就是「切回来后一切正常，过好一会儿之前发的话又重复了一遍」。
       *
       * 改成：起点推到末尾，只接着画之后的新事件。
       * 万一 events 取不到（缓存被清），退回 0 也安全 ——
       * followLive 里每条 text 都会先问 assistantBubbleHas，画过的不会再画第二遍。
       */
      followLive(id, Array.isArray(live && live.events) ? live.events.length : 0);
      return true;
    }
    if (!mine) turnsInFlight.delete(id);
    return false;
  }

  // 已经跑完的那一轮，历史里早就落盘了（renderTurns 刚画过），
  // 再把缓存里的 text 重画一遍就成了两条一样的回复。
  if (!live.running) {
    /**
     * 【2026-11-08 修·「多段消息还是堆在一起」——第三次才挖到真凶】
     *
     * 这里原来会调 paintSnapshot(id, live)「对账」，初衷是落盘正文有时比
     * 事件流短（刚结束、写盘那一拍没跟上）。可这条和上面那条铁律**直接冲突**：
     *   「跑完之后，一个字都不许照直播快照画；屏幕长什么样由历史说了算。」
     * （见 paintSnapshot0 开头那段）
     *
     * 冲突的后果就是主人反复看到的：
     *   ① switchSession 用**落盘历史**画好整屏（对的）
     *   ② 这里又拿**直播快照**把这一轮重画一遍
     *   → 同一段话两份。刷新那一瞬间正常，是因为第 ② 步还没轮到；
     *     轮询一转起来就又叠上了 —— 完全对得上他的描述。
     *
     * 而且我上一版加的 dropTail 只挡住了「还在跑」的情况，跑完这一支没挡住，
     * 所以他说「还是堆在一起」。
     *
     * 现在：跑完就到此为止，什么都不重画。历史是唯一的真相。
     * 落盘偏短的极端情况，下一次刷新自然对齐，代价远小于屏幕上多一份。
     */
    turnsInFlight.delete(id);
    return false;
  }

  /**
   * 【服务端说还在跑，就以服务端为准】—— 这里原来有一条相反的逻辑，删了。
   *
   * 原来是：不是本窗口在跟、而且屏幕上历史最后一条是我说的话 ⇒ 判成「跑完了」，
   * 把 turnsInFlight 删掉、返回 false。本意是防「进程崩过留下的 running 残骸」。
   * 可这条在切会话时一定误伤：切回来的那一瞬间，屏幕上的历史还是【上一个会话】的，
   * 拿它去判这一轮，就会把明明还在跑的一轮判成跑完了。
   * 后果就是主人报的：切回来按钮变回「发送」，按下去发不出去。
   *
   * 残骸这件事另有办法兜（服务端进程真死了，/api/chat/live 会连不上，
   * 走的是 catch 里那条路；真跑完了 live.running 自己就是 false）。
   * 所以这里不再用屏幕上的历史去否定服务端。
   */

  // 【2026-10-31 收集已画的工具】
  // 屏幕上已经画过的工具（renderTurns 刚按历史画好的），补画直播时别再画一遍，
  // 否则就是主人看到的「跑命令 完成」连发两条。
  const _drawnToolIds = new Set();
  try {
    document.querySelectorAll('.log .tool[data-tool-id]').forEach((el) => {
      const v = el.dataset && el.dataset.toolId;
      if (v) _drawnToolIds.add(String(v));
    });
  } catch {}

    /**
     * 【2026-11-01 修 Ctrl+F5：画崩了不许把「还在跑」判成「跑完了」】
     *
     * 现场实测（主人刷新时直接打接口）：/api/chat/live 返回 running=True、events=295。
     * 也就是说服务端明明在跑、字都在缓存里，可界面还是变回【发送】、看不到后续的话。
     *
     * 真凶就是这一行：paintLiveEvents 要一口气画 295 个事件，
     * 中间只要有一个事件的数据形状不对劲（缺 text、少字段、DOM 已经不在），
     * 异常就一路冒到 switchSession 外面那个 catch —— 而那里面直接 busy=false。
     *
     * 注释上写着「补画失败只是少一段内容，绝不能连累输入框」，可它确实连累了：
     * busy 被清成 false → 按钮从【停止】变【发送】→ 再按就是发新一轮 → 撞 409。
     *
     * 所以这里把「画」单独裹一层：画不出来顶多少几段内容，绝不影响「这一轮还在跑」的事实。
     */
  /* 【2026-11-02 · 整组快照重画】
   *  原来这里调 paintLiveEvents(evs, ...) 拿事件碎片往屏幕上拼，还得传一串
   *  「历史里已经画过的工具 id」去重。现在只认一件事：这一轮现在该长什么样。
   *  画一次清一次、画一百次一样 —— 重复和丢字在结构上没地方发生。 */
  let bubble = null;
  try {
    if (Array.isArray(live.items)) {
      lastSnapFp.set(id, snapshotFingerprint(live.items));
      bubble = paintSnapshot(id, live);
    } else {
      bubble = paintLiveEvents(evs, null, _drawnToolIds);
    }
  } catch (e) {
    console.warn("[attachLive] 补画失败（只少几段内容，不影响运行状态）:", e && e.message ? e.message : e);
  }

  /**
   * 【2026-10-28 修：切回来能看见内容，但再切一次就卡死】
   *
   * 上面那行把直播缓存里的事件画出来了 —— 所以「切回来」这一眼是好的。
   * 可它画完就完了，**没有在 turnsInFlight 里留下任何记录**。
   *
   * 于是下一次 renderTurns（再切一次会话、或切到别的会话再切回来）会把整个聊天区
   * 清空重建，然后问 replayInFlight「这一轮画到哪了」—— 找不到记录，什么也不补。
   * 屏幕上就停在一个空的/残缺的状态，流式事件还在往已删除的孤儿节点里写，
   * 非要刷新页面才恢复。多个会话同时跑的时候尤其明显：每切一次就丢一次。
   *
   * 修法：补画完就把记录建起来，把这轮已经画到的 part 数记成 evs.length，
   * 并把 bubble 指针一起存进去 —— 后续流式追加和下一次重画都能接上。
   */
  if (live.running) {
    const rec = turnsInFlight.get(id) || {
      sessionId: id, parts: [], running: true, startedAt: Date.now(), fishOff: false,
      userText: '', userAttach: [], userDrawn: true,   // 历史里已经有了，不用再补主人那句
      bubble: null, drawnParts: 0,
    };
    // 把直播缓存里的事件同步成 parts，重画时照这个补
    rec.parts = evs.map((e) => ({ kind: e.type, ...e }));
    rec.drawnParts = rec.parts.length;
    rec.bubble = bubble || null;
    rec.running = true;
    turnsInFlight.set(id, rec);

    /* 【2026-11-05 修·刷新后光标闪在说完的话上】
     *
     * 主人问：「F5 刷新时如果正在运行，她发出的消息末端会有个一闪一闪的蓝光标」。
     * 原因就是这一行——恢复直播缓存时**无条件**把最后一个气泡标成「正在写」。
     *
     * 可她那一轮未必在写字：很可能话早说完了，正在调工具。这时候气泡末端挂个光标，
     * 看起来就是「话说完了还在闪」，很怪。
     *
     * 现在看直播缓存的最后一条事件：
     *   · 最后是工具（tool_start / tool_end / hub）→ 不标，等真的开始吐字再说；
     *   · 最后是正文 / 没有事件 → 照旧标上，表示「还在写」。
     */
    const _lastEv = Array.isArray(evs) && evs.length ? evs[evs.length - 1] : null;
    const _tooling = Boolean(_lastEv && (
      _lastEv.type === 'tool_start' || _lastEv.type === 'tool_end' || _lastEv.type === 'hub'
    ));
    if (bubble && !_tooling) markStreaming(bubble);
    /* 【2026-11-02 游标语义修正 · 重复显示真凶】
     *  服务端的游标现在是 rev（每次 push / 每次把增量并进上一条都 +1），
     *  这里原来却传 evs.length（事件条数）——条数比 rev 小，于是「刚刚补画过的那条事件」
     *  会被当成还没画过的新增，**再整段画一遍**：刷新之后屏幕上就是一轮重复。
     *  起步用服务端回的 nextSince（rev），增量才是真的增量。 */

    followLive(id, Number.isFinite(Number(live.nextSince)) ? Number(live.nextSince) : evs.length);
    /**
     * 【只要服务端说这轮还在跑，就返回 true，不管是谁发起的】
     *
     * 以前这里对「不是本窗口在跑」的轮次返回 false —— 想让输入区别被锁，
     * 主人可以一边等一边打下一句。想法挺好，实际是个坑：
     *
     *   返回 false → 上层把 busy 设成 false → 输入区解锁、
     *   按钮变回「发送」→ 主人一按，走的是「发新一轮」而不是「插话」
     *   → 服务端回 409「这个会话还在跑」→ 那句发不出去，按钮还停在「发送」，
     *   再按一次还是同样下场。主人就是这么卡住的。
     *
     * 现在统一返回 true：界面上那轮还在跑，输入区就锁着，
     * 按钮显示「停止」，要说话就走「插话」（那条路会把当前轮掐掉接你的话）。
     * 宁可让主人多按一次「停止」，也不能让他打个字石沉大海。
     */
    return true;
  }
  return false;
}

/**
 * 接着跟直播：服务端还在跑就隔一会儿拉一次增量，往上追加。
 * 不重新发请求，只把「已经发生过的事」补齐——窗口关多久都不影响。
 */


function followLive(id, fromIndex) {
  // 只清自己这个会话的，别人的别动
  stopFollow(id);
  let seen = fromIndex;

  const timer = setInterval(async () => {
    // 屏幕上换到别的会话了：这个会话的轮询留着没意义，停掉（只停自己）
    if (sessionId !== id) {
      stopFollow(id);
      return;
    }
    let live = null;
    try {
      /**
       * 【2026-11-01 修·刷新后发消息一卡一卡的】
       *
       * 以前每次都拉全量：服务端回 295 个事件，这里每 1200ms 收一遍、再逐条比一遍，
       * 长对话里就一顿一顿的。
       *
       * 现在带上 since=seen —— 只要「我还没画过的那几条」。服务端另回 nextSince，
       * 直接拿它当新游标，不用自己数。
       */
      live = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(id) + '&since=' + encodeURIComponent(String(seen || 0)))
        .then((r) => r.json());
    } catch {
      return;
    }
    /* 【2026-11-02 串会话 · 同一道闸，第二处】
     *  上面那句「屏幕上换到别的会话了」是在 await 之前判的；这一拍一旦卡在上面的 fetch 里，
     *  等回来时主人早就切走了，后面的画就全落到新会话的屏幕上。数据回来了再判一次。 */
    if (sessionId !== id) { stopFollow(id); return; }
    const evs = live.events || [];
    /**
     * 【收尾这件事必须每轮都查，不能只在「有新字」的时候查】
     *
     * 原来是：if (evs.length > seen) { …画新字…; if (!live.running) { 收尾 } }
     * 于是「这一轮跑完了、而且最后一批字早就画过了」这种情况下收尾根本走不到：
     * 定时器一直在转，气泡上那个闪烁的蓝光标（.streaming::after）就一直挂着，
     * busy 也一直没放下来。主人看到的就是「话说到一半，尾巴上光标一直在闪，
     * 这时候插话一定失败」—— 那一轮早结束了，界面还以为在跑。
     *
     * 现在把这两件事拆开：画字看有没有新东西，收尾只看服务端说没说完。
     */

    // 服务端给的权威游标：这批之后该从第几条起（取不到就退回自己数的）
    const _advance = () => {
      const n = Number(live.nextSince);
      if (Number.isFinite(n) && n >= 0) seen = n;
      else seen = seen + evs.length;
    };

    /* 【2026-11-02 · 改成快照对账】
     *
     * 这里原来是「拿这一拍的增量碎片、往屏幕上接着拼」，拼的人还有另外四拨
     * （attachLive / paintLiveEvents / 流式 SSE / replayInFlight），各记一套账。
     * 谁记错一次、谁跟谁对不齐，屏幕上就是重复、丢字、串会话 —— 主人报了整整两天。
     *
     * 现在：只要这一拍有新东西，就重新问一次「这一轮现在该长什么样」（全量），
     * 然后整组重画。画一百次结果一样（幂等），所以重复和丢字在结构上没地方发生。
     * 指纹没变就不动 DOM —— 光有事件、内容没长（比如只多了个 done）时不白重画。
     */
    /* 【2026-11-03 修·子任务卡再也不长 / 办事模式看不见过程】
     *
     * 这里原来写的是「这一拍有新事件，才重新拉一次全量快照重画」。
     * 结果只要「新事件」这条路哑了，屏幕就冻在第一帧 —— 而 freeze 的理由有好几种：
     *   ① 服务端的 rev 与 events 条数不是一回事（压薄/合并之后），
     *      前端拿 nextSince 当游标一追，可能追到 rev 前面去，之后 filter 永远空；
     *   ② worker 的每一步是「事件」，但它长的是一张卡，不是正文，
     *      主人看到的就是「派活 运行中… · 1 步」挂在那里一动不动。
     *
     * 现在改成「每拍都拿清单对账」。服务端每次都回 items（清单是权威真身），
     * 指纹变了才重画 —— 跟有没有新事件无关。事件只用来推进游标和判收尾。
     */
    /* 【2026-11-03 修·画出来的东西一秒有一秒没（子任务卡闪得像卡死）】
     * 原来是「有 items 就用这一拍拿回来的那份」。可这一拍拿回来的是**增量响应**，
     * 它带着的 items 未必是全量（谁知道服务端哪一版只给了尾巴）——
     * 拿一份不全的清单去重画，清理那一步把卡删了，画的时候清单里没有 worker，
     * 那张卡就再也回不来了；下一拍又拿回全量、卡又出现 —— 屏幕上就是 有/没有 闪。
     *
     * 规矩：**画，永远照全量快照画**（这一路的请求只负责推进游标和判收尾）。
     * 全量就一个常量请求，不拼游标。 */
    let _snap = null;
    try { _snap = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(id)).then((r) => r.json()); } catch (e) { _snap = null; }
    if (sessionId !== id) { stopFollow(id); return; }
    if (_snap && Array.isArray(_snap.items) && _snap.items.length) {
      const _fp = snapshotFingerprint(_snap.items);
      if (_fp !== lastSnapFp.get(id)) {
        /* 【2026-11-03 修·指纹先记、画失败就再也不画】
         * 原来是先 set 指纹、再 paint。paint 一抛异常（重画这一步本来就不该影响主流程），
         * 指纹已经前进，下一拍同样的内容就被判「没变」—— 屏幕永远停在失败那一帧。
         * 实测就是子任务卡写着「16 步」不动，服务端早就 21 步了。
         * 现在：画成功才记指纹；画失败把原因留在 window.__lastPaintErr，能查。 */
        try {
          paintSnapshot(id, _snap);
          lastSnapFp.set(id, _fp);
          try { window.__lastPaintErr = null; } catch (e) {}
        } catch (e) {
          const _why = e && e.message ? e.message : String(e);
          try { window.__lastPaintErr = _why; } catch (e2) {}
          console.warn('[followLive] 快照重画失败:', _why);
        }
      }
    }

    // 收尾：每轮都看，跟这一轮有没有吐新字无关
    if (!live.running) {
      stopFollow(id);
      /**
       * 【2026-11-02 修·跑完之后，屏幕必须以历史为准】
       *
       *  直播那份快照是「事件流压出来的」，而服务端的事件流有上限 —— 长回复会把
       *  中间那些老事件压薄，正文看起来就短了一截。这一轮真正完整的那份，在历史里。
       *
       *  所以跑完这一刻不能就停在快照上：主人会看到一句「短一版」的回复，
       *  而刷新一下又变完整 —— 正是他报的那个「刷新前后不一样」。
       *
       *  这里收尾时把历史重新拉一遍、整屏重画。跑完了就没有流式在写，重画不会劈气泡；
       *  重画之后屏幕＝历史＝唯一权威，跟你按 F5 看到的一模一样。
       */
      (async () => {
        try {
          turnsInFlight.delete(id);
          /**
           * 【为什么最多试 6 次】
           *
           *  这一轮刚结束时，写盘那一拍可能还没跟上（落盘的是半截）。
           *  这时候就按历史重画，屏幕上会永远停在那半截 —— 因为后面不会再有人来补。
           *  所以每 700ms 再问一次历史，直到「历史那条助手不比直播快照短」为止。
           *  最多 6 次（约 4 秒），还不齐就直接按历史画 —— 宁可用落盘的，也不用可能被压薄的直播。
           */
          const _nz = (s) => { try { return String(fixMojibake(String(s || '')) || '').replace(/\s+/g, ''); } catch (e) { return String(s || '').replace(/\s+/g, ''); } };
          let _want = '';
          try {
            const _lv = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(id)).then((r) => r.json());
            for (const _it of (_lv && Array.isArray(_lv.items) ? _lv.items : [])) if (_it && _it.k === 'text') _want += String(_it.t || '');
          } catch (e) {}
          const _wantNz = _nz(_want).length;
          let _turns = null;
          for (let _k = 0; _k < 6; _k++) {
            if (sessionId !== id) return;
            const sel = await fetch('/api/sessions/select', {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id }),
            }).then((r) => r.json()).catch(() => null);
            if (sessionId !== id) return;
            _turns = (sel && sel.session && Array.isArray(sel.session.turns)) ? sel.session.turns : null;
            if (_turns) {
              const _as = _turns.filter((t) => t && t.role === 'assistant' && !t.whale);
              const _last = _as.length ? _nz(_as[_as.length - 1].text).length : 0;
              if (_last >= _wantNz) break;
            }
            await new Promise((r) => setTimeout(r, 700));
          }
          if (sessionId !== id) return;
          if (_turns) renderTurns(_turns, { force: true });
          /* 【2026-11-03 修·跑完子任务卡就没了（主人原话：「只显示一句派活 运行中…然后没了」）】
           * renderTurns 刚把屏幕照历史重画了一遍 —— 可历史里没有「谁干了什么」，
           * 那份记录只活在事件流（items）里。于是子智能体干完活，证据当场被抹掉。
           * 这里补回来：只补子任务卡，别的一个字不动（卡带 live-turn 标记，下一轮开跑自然清掉）。 */
          try {
            const _wl = (Array.isArray(live.items) ? live.items : []).filter((x) => x && x.k === 'worker');
            /* 【2026-11-06 同一条根因第三处】原来只在 _wl.length 为真时才清；
             * 这轮没派活就把上一轮的卡留在屏幕上。改成先清后画，没活就空着。 */
            {
              const _lg = document.getElementById('log');
              if (_lg) for (const _n of _lg.querySelectorAll('details.wcard')) { try { _n.remove(); } catch (e) {} }
              try { _wcardByWid.clear(); } catch (e) {}
              for (const it of _wl) paintWorkerCard(it);
            }
          } catch (e) {}
        } catch (e) {}
      })();
      /**
       * 这一轮结束，气泡尾巴上的光标必须摘掉。
       *
       * 只摘「受这一轮影响的那几个」（也就是这会儿还挂着 streaming 的）：
       * 不用 sweepStaleStreaming() —— 那个是一刀切全摘，会把小鲸正在流式写的
       * 那句话的光标也一起掐掉，看着像她说一半卡住了。
       */
      try {
        for (const b of document.querySelectorAll('.assistant .bubble.streaming')) {
          b.classList.remove('streaming');
        }
        for (const b of document.querySelectorAll('.whale .bubble.streaming')) {
          b.classList.remove('streaming');
        }
      } catch {}
      busy = false;
      hideSending();
      syncSendBtn();
      refreshSessions({ silent: true }).catch(() => {});
      /**
       * 这一轮结束了，而主人插的那句话还挂着 → 现在就该接着答。
       *
       * 主流程（runTurn 的 finally）在正常收尾时会处理 pendingResume；
       * 但「断流之后走 followLive 这条旁路」的收尾不经过那段 finally，
       * pendingResume 就没人管 —— 界面上按了插话、话也进历史了，
       * 却永远等不到回应，按钮还卡着。这里补上同一个出口。
       */
      if (pendingResume) {
        pendingResume = false;
        const t = String(lastInterjectText || '').trim();
        const sid = id;
        setTimeout(() => {
          resumeOrResend(sid, t).catch((e) => {
            busy = false;
            syncSendBtn();
            if (input && !input.value.trim() && t) { input.value = t; autosizeInput(); }
            addSysNote('⚠ 插的这句没接上：' + (e && e.message ? e.message : '未知错误') + '，已经放回输入框');
          });
        }, 30);
      }
    }
  }, 1200);

  followingBySession.set(id, timer);
  // 兼容旧变量：让它指着「最近一次开起来的那个」，只读它的人也还能用
  following = timer;
}

/**
 * 把一个还在跑的会话「补画」到屏幕上：先把已收到的内容摆出来，后面新来的接着追加。
 */
function replayInFlight(id) {
  /**
   * 【2026-11-02 · 整组快照重画（原来是「按 parts 增量补」）】
   *
   * 原来这里拿着 rec.parts（这一轮攒下来的碎片）去补画，还配套一堆账本：
   *   userDrawn / drawnParts / _paintBase / 认领最后一个气泡 / 比前缀……
   * 而 screens 上还有另外四拨人也在画（renderTurns / paintLiveEvents / followLive /
   * 流式 SSE），各记一套。主人报的「一句话重复两次」「切会话后重复」「内容跑到别的会话」
   * 全是这些账本互相打架的结果。
   *
   * 现在只做一件事：问服务端「这一轮现在该长什么样」，拿回来整组重画。
   * 画一次清一次、画一百次一样 —— 账本一个都不需要，也就没有记错账这回事。
   *
   * 拉不到（服务端没这一轮 / 网络断）才退回老办法，别让屏幕彻底空着。
   */
  const rec0 = turnsInFlight.get(id);
  /* 主人那句话：还没画过就补上（切走时它可能还在屏幕上，切会话后被清掉了） */
  try {
    if (rec0 && !rec0.userDrawn && (rec0.userText || (rec0.userAttach && rec0.userAttach.length))) {
      if (sessionId === id) {
        addUser(rec0.userText || '', undefined, rec0.userAttach && rec0.userAttach.length ? rec0.userAttach : undefined, undefined, undefined, rec0.userIdentity);
      }
    }
    if (rec0) rec0.userDrawn = true;
  } catch (e) {}

  /* 快照那条路：异步拉、拉回来整组重画 */
  let _usedSnap = false;
  try {
    fetch('/api/chat/live?sessionId=' + encodeURIComponent(id))
      .then((r) => r.json())
      .then((live) => {
        if (!live || !Array.isArray(live.items)) return;
        if (sessionId !== id) return;      // 拉的过程中主人已经切走了：一个字节都不画
        lastSnapFp.set(id, snapshotFingerprint(live.items));
        paintSnapshot(id, live);
      })
      .catch(() => {});
    _usedSnap = true;
  } catch (e) {}

  /* 退回老办法：服务端连不上时，至少把攒下来的 parts 补出来 */
  const rec = turnsInFlight.get(id);
  if (!rec) return false;
  if (_usedSnap) {
    if (!Number.isFinite(rec.drawnParts)) rec.drawnParts = 0;
    rec.drawnParts = Array.isArray(rec.parts) ? rec.parts.length : 0;
    return true;
  }
  if (!Number.isFinite(rec.drawnParts)) rec.drawnParts = 0;
  if (rec.drawnParts > rec.parts.length) rec.drawnParts = 0;
  for (let i = rec.drawnParts; i < rec.parts.length; i++) {
    const p = rec.parts[i];
    const kind = p.kind || p.type || '';
    if (kind === 'reasoning') {
      if (!rec.think) rec.think = openThink();
      /* 【2026-11-06 主人报·正文被思考链劈成两半】
       *  原来 openThink() 是 log.appendChild(d)，思考块挂在 #log 末尾、跟气泡平级。
       *  于是「正文12345 → 思考 → 正文6789」排成：气泡(12345) / 思考块 / 气泡里又冒出6789。
       *  正文其实一直在同一个 bubble 里长，只是思考块插到了它后面。
       *  改法：思考块一建出来就塞进 .msg.assistant 容器、放在 .bubble 前面，
       *  这样正文后面再长多少都长在思考块下面，永远劈不开。 */
      try {
        const _th = rec.think && rec.think.el;
        const _bb = rec.bubble;
        if (_th && _bb) {
          const _wrap = _bb.closest && _bb.closest(".msg.assistant");
          if (_wrap && _th.parentNode !== _wrap) _wrap.insertBefore(_th, _bb);
        }
      } catch (e) {}
      try { rec.think.push(p.text); } catch (e) {}
    } else if (kind === 'text') {
      if (p && p.notice) { try { addSysNote(String(p.text || '').replace(/^[\s\n]+/, '').trim()); } catch (e) {} continue; }
      if (!rec.bubble || !rec.bubble.isConnected) {
        rec.bubble = addAssistantAuto();
        try { const w = rec.bubble.closest('.msg.assistant'); if (w) w.dataset.liveTurn = '1'; } catch (e) {}
      }
      /* 【2026-11-06 补】思考先到、正文后到时，上面那次归位 rec.bubble 还是 null，会跳过。
       *  所以正文气泡一建好，再补一次：把已有的思考块挪进这个气泡的容器、放在正文前面。 */
      try {
        const _th2 = rec.think && rec.think.el;
        if (_th2 && rec.bubble) {
          const _w2 = rec.bubble.closest && rec.bubble.closest(".msg.assistant");
          if (_w2 && _th2.parentNode !== _w2) _w2.insertBefore(_th2, rec.bubble);
        }
      } catch (e) {}
      try { pushStreamText(rec.bubble, String(p.text || '')); } catch (e) {}
    } else if (kind === 'tool') {
      if (String(p.name) === 'compress') return true;   // 压缩条不重画
      try {
        const el = addTool();
        el.sum.querySelector('.name').textContent = niceTool(p.name, p.args);
        const st = el.sum.querySelector('.status');
        st.textContent = p.done ? (p.ok ? '完成' : '失败') : '运行中…';
        st.className = 'status ' + (p.done ? (p.ok ? 'ok' : 'err') : 'warn');
        el.pre.textContent = (p.args ? '参数：' + tidyToolText(p.args) : '') + (p.done && p.output ? '\n--- output ---\n' + tidyToolText(p.output) : '');
        if (!rec.toolEls) rec.toolEls = new Map();
        if (p.id) rec.toolEls.set(p.id, el);
      } catch (e) {}
    } else if (kind === 'whale' || kind === 'whale_delta') {
      try { if (!whaleStreamFinish(String(p.text || ''), StreamKey(id, p.who))) addWhaleBubble(p.who, String(p.text || '')); } catch (e) {}
    }
  }
  rec.drawnParts = rec.parts.length;
  return true;
}

function renderTurns(turns, opts) {
  /**
   * 【2026-11-01 主人报：生成中说的话被拆成好几个碎气泡，刷新之后才对】
   *
   * 病根：只要有人调 renderTurns，这里就会 ——
   *   ① hideSending() 把「正在发送消息」藏掉；
   *   ② 把 bubble 指针清成 null，流式那边只好新开一个气泡接着写。
   * 于是一句完整的话被切成「前半截 / 后半截」两三个独立气泡，看着像是分段发的。
   * 刷新之后走的是历史重画，一条 assistant 一个气泡，所以又正常了。
   *
   * 现在：真在生成中的时候，除非调用方明说要重画（force），否则这里什么都不动 ——
   * 只把 currentTurns 记一下（费用总账要用），DOM 交给流式那条路自己长。
   */
  /* 【2026-11-02 修·主人报「消息被吞、画面固定、刷新也没用」】
   *
   *  原来这里只看 _genBusy（判据掺了界面自己的 sending 状态位）。刷新之后
   *  turnsInFlight 已经空了、sending 却还留着上一轮的 true —— 于是永远当「在生成」，
   *  整屏一个字都不画。主人看到的就是「画面卡在旧的，刷新也没用」。
   *
   *  现在只认一个凭据：当前这个会话在 turnsInFlight 里真有一条（有 startedAt/adopted）。
   *  它在，说明流式那边正握着气泡，别插手动它；它不在，就照画历史 ——
   *  画出来永远比让主人盯着一屏旧东西安全。
   */
  let _curInFlight = false;
  try { const _r = turnsInFlight.get(sessionId); _curInFlight = !!( _r && (_r.startedAt || _r.adopted) ); } catch {}
  /**
   * 【2026-11-08 修·「多段消息堆在一起」，尤其是切走再切回来】
   *
   * 主人：「不同段消息在我这里还是会堆在一块（特别是切换会话后再切换回来
   * 大概率出现）。刷新后有那么一瞬间是恢复正常的，但马上又变成堆在一块。」
   *
   * 链路是这样叠起来的：
   *   ① switchSession 先 renderTurns 画历史 —— 里面**已经包含本轮落盘的回复**
   *   ② 紧接着 attachLive 把 /api/chat/live 的事件从头重放一遍
   *   → 同一段话，历史画一份、直播再画一份，挤在屏幕上。
   * 刷新那一瞬间正常，是因为第 ② 步还没跑；轮询一转起来就又叠上了。
   *
   * 修法：调用方知道「这个会话此刻真在跑」时传 dropTail，
   * 历史就先别画最后那条 assistant —— 那段交给直播去长。
   */
  if (opts && opts.dropTail && Array.isArray(turns)) {
    turns = turns.slice();
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i] && turns[i].role === 'assistant') { turns.splice(i, 1); break; }
    }
  }
  /**
   * 【2026-11-02 修·换会话时不许「不画」】
   *
   * 上面那条「真在生成中就什么都不动」是为了别把我们自己正在流式写的气泡拆碎，
   * 它只在「屏幕上这一屏本来就属于这个会话」时成立。
   * 可切会话也走这里：切到一个正在跑的会话，它照样 return —— 屏幕就留在上一个会话上，
   * 主人看到的是「别的会话的内容跑到这个会话里了」。这比拆碎气泡严重得多。
   *
   * 现在多一个判据：屏幕归谁（window.__turnsOwner）。换人了就必须照画，
   * 宁可重画一次，也不能让主人对着一屏别人的话。
   */
  let _ownerSame = true;
  try { _ownerSame = (window.__turnsOwner === sessionId); } catch (e) {}
  if (_curInFlight && _ownerSame && !(opts && opts.force)) {
    try { currentTurns = Array.isArray(turns) ? turns : []; } catch {}
    return;
  }
  /* 【2026-11-03 修·发出去的插话突然消失】
   *
   *  主人的插话是先画到屏幕上的（addUser），这一轮跑完才落盘。
   *  可这一轮刚结束、下一轮还没被判成"在跑"的那个空档里，`_curInFlight` 是 false，
   *  上面那道保护失效 —— renderTurns 拿着"服务端还没有这句"的 turns 整屏重画，
   *  刚打出去的那句话就被盖掉，屏幕上"闪一下就没了"。
   *
   *  修法：重画之前先把「屏幕上有、服务端 turns 里没有」的用户消息记下来，
   *  重画完再补回去。判据用"洗完只留字"的正文比对，跟 reconcileTurnTexts 同一套口径。 */
  /* 【2026-11-04 主人报·新建会话后屏幕上还留着上个会话的话，按 F5 才消失】
   *
   *  病根就在下面这段「补回差点被洗掉的插话」：它的前提是「屏幕上这一屏本来就属于这个会话」。
   *  可新建 / 切会话时屏幕上是【上一个会话】的消息，而服务端 turns 是空的 ——
   *  于是 _srv 里一条都对不上，那些旧消息全被判成「刚打出去还没落盘的插话」，
   *  整批补进新会话里。屏幕归属变了的时候，这段补回必须整个跳过。
   *  判据用上面已经算好的 _ownerSame（换人了就是 false）。 */
  let _lostUsers = [];
  try {
    if (!_ownerSame) throw new Error('owner-changed');
    /* 【2026-11-04 主人报·点【回退】后那条消息还挂在屏幕上，得 F5 才消失】
     *  真凶就在下面这段「补回差点被洗掉的插话」里：
     *  回退把服务端后面的消息藏掉之后，屏幕上那条刚画过的（drawnAt 在 15 分钟内）
     *  在服务端 turns 里找不到了 → known=false、_fresh=true → 被当成「还没落盘的插话」
     *  又补了回来。所以画面看起来「一条没少」。
     *  【编辑】【删除】【重发】走的是同一套 force 重画，也带着同一个病。
     *  修：凡是调用方明确要求「照盘上这份重画」（opts.force）的，都不许补回 ——
     *  那些都是服务端已经改完、我们主动要它重画的场景，补回就是在跟服务端对着干。 */
    /* 注意：不能用 opts.force 当判据 —— 「这一轮跑完按历史重画」也传 force，
     * 那种场景恰恰要把主人刚发、还没落盘的那句补回来（见 64xx 行收尾那段）。
     * 只有「服务端已经明确改完、我只想照盘上这份画」的主动操作才该跳过补回。 */
    if (opts && opts.noCarry) throw new Error('authoritative-repaint');
    const _wash = (s) => String(fixMojibake(String(s || '')) || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
    const _srv = new Set();
    for (const t of (Array.isArray(turns) ? turns : [])) {
      if (t && t.role === 'user') { const w = _wash(t.text); if (w) _srv.add(w); }
    }
    const _lg0 = document.getElementById('log');
    if (_lg0) {
      for (const el of _lg0.querySelectorAll('.msg.user')) {
        let body = '';
        /**
         * 【2026-11-05 修·凭空冒出一条"我说的话"】
         *
         * 原来写的是 `el.querySelector('.bubble') || el` —— 没有 `.bubble` 就退回整个容器。
         * 而**纯附件的消息（只发图、没打字）根本没有 .bubble**，
         * 于是 `textContent` 把署名和操作按钮一起吸进来：
         *   「主人↶ 回退✎ 编辑⑂ 分支删除」
         * 这段东西在服务端当然找不到对应，就被当成"还没落盘的那句"补了回去 ——
         * 屏幕上凭空多一条主人说的话，内容是按钮。
         *
         * 现在：只认 `.bubble`。没有气泡 = 没有文字可补，直接跳过，**绝不退回容器**。
         */
        try {
          const b = el.querySelector('.bubble');
          if (b) body = String(b.textContent || '');
        } catch (e) {}
        const w = _wash(body);
        if (!w) continue;
        // 服务端已经有这段（或它包含在这段里）就不用补
        let known = false;
        for (const sv of _srv) { if (sv === w || sv.includes(w) || w.includes(sv)) { known = true; break; } }
        if (known) continue;
        /* 【2026-11-03 补】只认「刚打出去的」那几句 —— 屏幕上因为别的原因残留的旧消息
         *  （比如服务端删了、本地还挂着）不能每次都补回来，不然越补越多。
         *  15 分钟以内、而且这一段还没落盘，才算「差点被洗掉的那句」。 */
        let _fresh = true;
        try {
          /* 【2026-11-03 严检抓到的真 bug】data-at 存的是「消息在数组里的下标」
           * （rewindId，见 6779 / 16276 / 16364 行），不是毫秒时间戳。
           * 拿 Date.now() 减它永远是天文数字 → _fresh 永远 false →
           * 这段「补回差点被洗掉的插话」从来没生效过。
           * 改：认 el.dataset.drawnAt（画的时候打的时间戳）。老气泡没这个标记就当它不新。 */
          const _drawn = Number(el.dataset.drawnAt);
          _fresh = Number.isFinite(_drawn) && _drawn > 0 && (Date.now() - _drawn) < 15 * 60 * 1000;
        } catch (e) { _fresh = true; }
        if (!_fresh) continue;
        // 把这条消息的文字记下来（气泡里的工具条之类一并略过，只留正文）
        _lostUsers.push(String(body).trim());
      }
    }
  } catch (e) { _lostUsers = []; }

  hideSending();
  // 记下「屏幕上这一屏是什么」：设置面板里的会话总账要拿它加总（见 paintUsageBox）。
  try { currentTurns = Array.isArray(turns) ? turns : []; } catch {}
  /**
   * 【2026-10-28 修：重画之后流式追加写进了「孤儿节点」，界面就卡住不动】
   *
   * 重画会把聊天区整个清空重建，原来那个 bubble 元素已经不在 DOM 里了。
   * 可是 runTurn 的流式循环手里还攥着旧引用，接着往里写 —— 写的是没人看得见的孤魂，
   * 屏幕上就停在重画那一刻，非要刷页面才行。
   * 这里把「正在跑的会话」的 bubble 指针清掉，让补画逻辑重新认一个活节点。
   */
  try {
    // 【2026-10-29 多会话并行修 · ②：只清「屏幕上这个会话」，别动别人】
    // 原来这里 for…of 把 turnsInFlight 里【所有会话】的补画进度都清零了。
    // 两个会话同时跑的时候，谁最后重画一次，谁就把另一边的进度抹掉 ——
    // 切回去那边只剩半截、或者整片空白，非要刷新页面才回来。
    // 重画只影响当前这一屏，所以只清当前这一步正在跑的记录。
    const _curRec = turnsInFlight.get(sessionId);
    if (_curRec) {
      _curRec.bubble = null; _curRec.drawnParts = 0; _curRec.userDrawn = false;
      // 2026-10-31：重画会把聊天区整个换掉，旧 DOM 全成了孤儿。
      // toolEls 里攥的那些元素已经不在页面上了，tool_end 再去更新就是改空气 ——
      // 主人看到的正是「切会话再回来，工具调用全不见」。清掉，让补画重新认新节点。
      _curRec.toolEls = null;
    }
  } catch {}

  usageEl.textContent = '';
  // 回放历史时用：最近几句主人说的话上带着的用量，轮到画它们回复时批量补上去。
  // 用队列而不是单个变量：连着好几条 user 的情况太常见（催促、中途打断），
  // 单个变量会把前一句直接覆盖掉，那条用量行和分支按钮就没了。
  const pendingTurns = [];
  /**
   * 已经画过用量的那些 turn 的 id。
   *
   * 【为什么必须有它】实测主人这边一个会话里有 4 处「同一块下面挤了两行」：
   * 一行「这一轮没记用量」+ 一行真数字并排。
   * 根因是补画会触发多次（一轮常是 user→assistant→tool→assistant），
   * 只清空数组防不住末尾那次兜底补画。用集合记死，谁画过谁就不再画。
   */
  const drawnUsage = new Set();
  // 这一串 assistant 里最后画出来那个气泡（用量行要挂在它下面，悬停它才显形）
  let lastBubbleOfTurn = null;
  // 【2026-10-31 同轮并气泡】：这一串回复共用的那个气泡，以及它当前那段话的容器
  let _contBubble = null;   // 上一段话的气泡（同一串里后面的话接进它）
  let _contBody = null;     // 气泡里最后那个 .cont 容器
  /* 【2026-11-01 插话嵌中间】主人插话时把我那段话劈成两半：
     前半截留在原气泡，后半截先存这儿，等后面那段 assistant 进来再接回去。 */
  let _steerTail = null;    // 被插话劈下来的后半截文字（纯文本）
  let _steerTailBody = null; // 它原来那个正文容器（接回去要挂它下面）
  let _contStem = null;     // 保留字段（服务端暂时没给 stem，判据已改成看 prevRole）
  // 【2026-10-31 并气泡·改判据】：上一条 turn 是什么角色。连着两条 assistant = 同一串（中间没被主人打断）
  let prevRole = '';
  // 【2026-10-31 攒工具再折叠】：同一串对话里的工具先收在这儿，等这一串画完再折叠成一行
  let _hubTools = [];
  let _hubKey = null;
  const flushHub = () => {
    if (_hubTools.length) paintTools(_hubTools, frag, { fold: true });
    _hubTools = [];
    _hubKey = null;
  };
  /**
   * 【C · 估算用的字数】
   * 这一串回复（可能好几条 assistant）一共写了多少字。
   * 接口没报 usage 的时候，只能按字数估个大概，总比整行空着强。
   * 每遇到 user 就清零，跟着这一轮走。
   */
  let turnReplyChars = 0;
  /**
   * 【重发要用】这一串回复是回哪一句话的。
   *
   * 重发的做法是「退回问这句话之前，再用原话跑一轮」——
   * 回退接口只认 role=user 且非 context 的消息，所以必须记住那条 user 的 rewindId，
   * 画到 assistant 气泡时才挂得上「重发」。
   *
   * 用队列而不是单个变量：连着一串 user 时（催、打断）不能把前一句盖掉。
   */
  const askQueue = [];

  /**
   * 【2026-11-01 根治界面卡死：长会话只画最近一段】
   *
   * 主人连着两次重启都是因为界面卡死。实测：
   *   smvmk3dex74g8 → 1.0MB / 801 轮
   *   smvlz6icxqonx → 770KB / 722 轮
   * 服务端取回只要 86ms，慢的全在浏览器：801 轮 × 每轮十几个节点 = 上万个节点，
   * 一次性建完，主线程直接顶住（content-visibility 只管不画，节点还是全建）。
   *
   * 现在改成窗口化：第一次只画最后 WINDOW 轮，往上滚到顶再补前面一批。
   * 用 _histWindow 记住「这个会话还差多少轮没画」，切走再回来就重置。
   */
  /* 【2026-11-05 修·长会话翻不到更早的消息】
   * 补历史也是走这个函数，而它最后是「无条件跳到底」的 ——
   * 于是刚补上的一屏，被 rAF 那一发和每 250ms 的 followNow 一起拽回底部，
   * 看着就是"滚不上去、一滚就弹回来"。
   * keepScroll 给这条路开个绿灯：不贴底，也不让后面的定时器贴。 */
  const _keepScroll = !!(opts && opts.keepScroll);
  /**
   * 【2026-11-05 改·120 → 40】
   *
   * 主人原话：「要不还是删除我会话久远以前的显示吧（仅删除显示）」。
   *
   * 窗口本来就是 120（只画最后 120 轮，往上滚到顶再补前面一批），
   * 可 120 轮 DOM 太多：每次重画都要重建一百多个节点，高度变化大、耗时长，
   * 中间任何一处高度对不上都会让画面抖。
   *
   * 收到 40 —— 一屏大概能放 8~12 轮，40 轮够看四五屏，往上滚还是照旧自动补。
   * 数据一条没删，只是少画。
   */
  const WINDOW = 40;
  /* 【注意】这里的 turns 就是全部轮次；_all 不能写成 = list —— list 下面才定义，会 TDZ 报错。 */
  const _all = Array.isArray(turns) ? turns : [];
  let _start = 0;
  try {
    /* 【关键】回填时是自己调自己的：这时 _resetWin 为 true，必须沿用已经算好的 start，
       不能再按「最后 120 轮」重算一遍 —— 否则补完立刻又被切回尾部，白补。 */
    const _keep = renderTurns._keepStart;
    renderTurns._keepStart = false;
    if (typeof _keep === "number" && _keep >= 0 && _keep < _all.length) {
      _start = _keep;
    } else if (_all.length > WINDOW) {
      _start = Math.max(0, _all.length - WINDOW);
    }
    renderTurns._pending = { all: _all, start: _start, sessionId };
  } catch {}

  const list = _all.slice(_start);
  /**
   * 【长会话才开「屏幕外不算」】150 轮以下不动它，短会话本来就秒开。
   * 阈值挑 150：实测 76 轮/101KB 完全不卡，244 轮/321KB 开始有感，
   * 628 轮/659KB 明显黑一下 —— 取中间偏安全的 150。
   */
  try {
    if (log) log.classList.toggle("long-list", _all.length > 150);
  } catch {}
  const frag = document.createDocumentFragment();
  /* 重画期间别人（notice 提示）要往里塞东西 —— 塞到旧屏上会被下面的 replaceChildren 冲掉 */
  try { window.__renderFrag = frag; } catch {}

  /**
   * 【2026-11-05 加·「加载更早」改成手动点】
   *
   * 主人要的：「改成需要手动点击加载才补前面的」。
   * 原来是滚到离顶 240px 以内就自动补 120 轮 —— 往上翻的时候一碰顶就触发重画，
   * 重画本身又会动高度，正好和「看着历史」这件事打架。
   * 现在只在顶上放一颗按钮，点一下补一批，不点就一直是这么多。
   */
  try {
    if (_start > 0) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'loadEarlier';
      btn.textContent = '↑ 再往前看 100 轮（还有 ' + _start + ' 轮没显示）';
      btn.onclick = () => {
        try {
          const keepFromBottom = log.scrollHeight - log.scrollTop;
          /* 【2026-11-05】一次 100 轮。40 太少 —— 六百多轮要点十几次，
           * 而且每点一次都要重画，反而更累。 */
          renderTurns._keepStart = Math.max(0, _start - 100);
          renderTurns(_all, { keepScroll: true });
          requestAnimationFrame(() => {
            try { log.scrollTop = log.scrollHeight - keepFromBottom; } catch (e) {}
          });
        } catch (e) {}
      };
      frag.appendChild(btn);
    }
  } catch (e) {}

  for (let ti = 0; ti < list.length; ti++) {
    const turn = list[ti];
    /* 【2026-11-05 严检加固】turns 是服务端给的，理论上不会含空值（服务端 publicSession
     *  里有 !m || m.context continue 挡着）。但前端这一整段有 40 处直接读 turn.role /
     *  turn.text / turn.who，一个 null 进来就 TypeError，整屏一条都画不出来。
     *  这里挡一道：坏数据跳过，不许让一条脏数据拖垮整屏。 */
    if (!turn || typeof turn !== 'object') continue;
    // 一轮干工具活会留下好几条 assistant（先只带工具调用的、再带最后那段话的），
    // 用量和「说完没」都该等这一串画完再补。
    const nextTurn = list[ti + 1];
    const nextIsAssistant = Boolean(nextTurn && nextTurn.role === 'assistant');
    if (turn.role === 'user') {
      // 【2026-10-31 user 前 flush】：主人一开口，上一串就结束了，攒着的工具在它后面折叠成一行画出来
      flushHub();
      // 【2026-10-31 主人原话：压缩相关一个字都不许露】
      /**
       * 【2026-11-05 加·system 消息不画】
       *
       * 后端已经过滤了，这里再兜一层 —— 万一是旧数据或者别的接口带过来的。
       * 人设正文里就有 <thinking> 的示例，画出来就是「屏幕上冒出标签」。
       */
      if (turn.role === 'system') continue;

      // 程序自己插的压缩提醒（turn.sysNote）在界面上直接不画 ——
      // 不挂主人的名字（免得看着像主人在提醒压缩），也不画成系统小字（主人说不想看到任何压缩显示）。
      /* 【2026-11-06 修】系统插的那句话（重启续上 / 定时任务）本身不画，
       * 但这一轮的用量就挂在它身上 —— 直接 continue 掉，数字永远看不见，
       * 前端只能退回按字数瞎估（就是主人看到的那种一千多的小数字）。
       * 这里把它塞进下面那个「待补画」队列，让紧随其后的那条回复去画。
       * 复用现成队列而不是新造变量：一轮只能有一条待补画，天然不会串到下一轮。 */
      if (turn.sysNote) {
        /* 只在队列空着时才接：队列里还有上一条主人消息的用量时不能冲掉它，
         * 否则那一行就凭空消失了（宁可少露一行，也不能吞掉别人的）。 */
        if (turn.usage && !pendingTurns.length) {
          pendingTurns.push({ id: 's' + ti, u: turn.usage, at: undefined, model: (turn.usage && turn.usage.model) || '', replyChars: 0, userChars: 0 });
        }
        continue;
      }
      /**
       * 【role 存错的旧消息 —— 2026-11-01 修】
       *
       * 主人报：「小鲸的第一句话，名字样式与消息样式和我说话一样，名字白、灰框」。
       * 真因是服务端群聊那条路把她的话存成了 role:'user'（已改成 assistant+_whale），
       * 但**已经存进历史的那几条**还是旧样子 —— 而程序正跑着时不能去改会话文件
       * （saveSession 会拿内存里的原样盖回来），所以在这边兼容：
       * 一条 user 消息只要带了别人名字（turn.who），就按那个人的样式画，不套主人的气泡。
       */
      const w = (turn.who && String(turn.who) !== '主人')
        ? (addWhaleBubble(turn.who, turn.text, frag) || addUser(turn.text, undefined, turn.atts, frag, turn.rewindId, turn.who || ''))
        : addUser(turn.text, undefined, turn.atts, frag, turn.rewindId, turn.who || '');
      // 【2026-11-05】我自己说的话也标上时间
      attachTime(w, turn.ts);
      /* 【2026-11-01 主人：插的话要插在「我说到哪儿」的位置】
       * 服务端把「他插话那一刻我已经说出多少字」（turn.steerAt）带下来了。
       * 这里把上一个气泡的文字截断到那个字数，多出来的尾巴先存起来，
       * 等后面那段 assistant 进来时再接回去 —— 屏幕上就读成：
       *   我说到一半 → 主人插话 → 我接着说。
       * 拿不到 steerAt（老会话 / 前端没算出来）就什么都不做，照老样子排末尾。
       */
      try {
        if (turn.steer && Number.isFinite(Number(turn.steerAt)) && _contBody) {
          const full = String(_contBody.textContent || '');
          const at = Math.max(0, Math.min(full.length, Number(turn.steerAt)));
          if (at > 0 && at < full.length) {
            _steerTail = full.slice(at);
            _contBody.textContent = fixMojibake(full.slice(0, at));
            _steerTailBody = _contBody;
          }
        }
      } catch {}
      // 每一句都能改：主人说的和我说的一样对待
      attachEdit(w, turn.rewindId);
      // 「分支」也贴着句子放：从这句往下另开一个会话
      attachBranchBtn(w, turn.rewindId);
      attachDelBtn(w, turn.rewindId);
      if (turn.edited) w.classList.add('edited');
      // 【用量要在 user 之后立刻入队】
      // 以前放在循环末尾，而「补画」又发生在 user 分支里 —— 也就是先补画、后入队，
      // 顺序反了，结果除了最后一条，前面每一轮的用量都补不出来。
      pendingTurns.push({
        // 每一条给个唯一记号：同一条用量只许画一次。
        // 为什么要这个：一轮常长成 user→assistant→tool→assistant，
        // 补画会触发好几次，以前靠清空数组来防重，但清空之后
        // 末尾那段「兜底补画」又会把剩下的再画一遍 —— 就出现了两行。
        id: 'u' + ti,
        u: turn.usage || null,
        at: Number.isFinite(Number(turn.rewindId)) ? Number(turn.rewindId) : undefined,
        model: (turn.usage && turn.usage.model) || '',
        // 新的一轮开始，回复字数从头数
        replyChars: 0,
        userChars: String(turn.text || '').length,
      });
      // 记住这一问，画回复时「重发」要用
      askQueue.push({
        at: Number.isFinite(Number(turn.rewindId)) ? Number(turn.rewindId) : undefined,
        text: String(turn.text || ''),
      });
      turnReplyChars = 0;
      /* 【2026-11-02】这一句必须在这儿。原来只在 assistant 分支末尾记 prevRole，
       * user 那一条进来时它不执行，prevRole 就一直停在 'assistant' ——
       * 紧接着的 assistant 被判成「同一串接着说」，并进上一个气泡，
       * 屏幕上就成了「回复跑到主人下一句之前、且几段回复挤成一个气泡」。 */
      prevRole = turn.role;
    } else {
      const hasText = String(turn.text || '').trim().length > 0;
      // 这一串回复写了多少字：接口没报 usage 时拿来估
      if (hasText) turnReplyChars += String(turn.text || '').length;
      const outs = Array.isArray(turn.out) ? turn.out : [];
      const tools = Array.isArray(turn.tools) ? turn.tools : [];
      /**
       * 她这一轮想过什么。挂在她说的话**上面**，跟实时流里那个「正在想…」的位置一致
       *（想在前、说在后，读起来才是「先想过再开口」）。
       *
       * 只画给我自己的回放：小鲸说的话（turn.whale）没有思考过程，
       * 那是另一个人的话，别把她的思考算到别人头上。
       */
      if (turn.reasoning && !turn.whale) paintReasoning(turn.reasoning, frag);
      // 只调了工具、一个字没说的那条 assistant（content 是 null）：不画空气泡，只画工具块
      // 【修·工具调用从来没画出来】只调了工具、一个字没说的那条 assistant（content 是 null），
      // 原来被下面的 if(hasText||outs.length) 整个跳过 —— 工具就永远不显示了。
      // 这里单独给它画一条「调了 N 次工具」的灰折叠条：默认摊开（干活时看得见），
      // 主人发下一条消息时由 foldOldHubs 收起来；点开随时能看参数和结果。
      // 【2026-10-31 主人：两条消息之间的工具并进同一个柜子】
      // 这里原来是「只调了工具、一个字没说」当场画一条 div.toolFrag —— 结果是
      // 连着调 5 个工具画出 5 条「调了 1 次工具」，而且下面 14572 还会再画一遍（画两遍）。
      // 现在什么都不画，只交给下面的 _hubTools 攒着，凑成一个柜子再说。
      // 【主人定：柜子要夹在 A 与 B 两条消息之间】
      // 这条 assistant 说话了 —— 那「这句话之前」攒下的那批工具，现在就折成一个柜子画出去，
      // 它自然落在这句话前面。下一批工具会攒着，等下一个说话的点再画。
      // 于是读起来就是：A →【调了 x 次工具】→ B →【调了 y 次工具】→ C。
      // 先拍快照再 flush：下面的 sameStem 要判「这句之前有没有攒着工具」，
      // 而 flushHub 会把 _hubTools 清空 —— 顺序反了就会读到永远为 0 的假象。
      const _hadHubTools = _hubTools.length > 0;
      if (hasText) flushHub();
      if (hasText || outs.length) {
        /**
         * 小鲸说的话，单独画成她的气泡。
         *
         * 【为什么不能并进我的气泡里】
         * 主人要的是「她能说话」，那就得一眼看出哪句是她说的。
         * 并进来就又变成我转述了 —— 跟没做一样。
         *
         * 服务端在消息上打了 whale（她的名字），这里认它。
         * 颜色、称呼都不一样，别的照旧（能改、能分支）。
         */
        if (turn.whale) {
          // 【独立个体·2026-11-01】以前这里写死 whale 一套，重启后所有第三方
          // （包括自建卡）都变成小鲸那个冷蓝。现在按「是谁」分：
          // 只有小鲸用 whale 那套，别人用它自己卡上的颜色。
          const __wn = String(turn.whale);
          const __isWhaleTurn = __wn === '小鲸';
          const wrap = addEl('', __isWhaleTurn ? 'msg whale whaleSelf' : 'msg mate mateSelf', frag);
          if (!__isWhaleTurn) {
            wrap.dataset.whoName = __wn;
            try { wrap.style.setProperty('--whoC', mateColorOf(__wn)); } catch {}
          }
          const roleEl = document.createElement('div');
          roleEl.className = 'role';
          roleEl.textContent = String(turn.whale);
          wrap.appendChild(roleEl);
          if (Number.isFinite(Number(turn.rewindId))) wrap.dataset.at = String(Number(turn.rewindId));
          const b = document.createElement('div');
          b.className = 'bubble';
          mdInto(b, turn.text); // 【2026-11-05】正文走 markdown（没特征就原样文字）
          maybeFoldBubble(b, turn.text);
          attachTime(wrap, turn.ts);
          wrap.appendChild(b);
          if (outs.length) attachFiles(wrap, outs);
          // 【修·工具调用从来没画出来】这一条 assistant 带的工具，画在这段话正下方。
          // 默认摊开（干活时看得见我在做什么）；主人发下一条消息时 foldOldHubs 把它收成一条灰。
          if (tools.length) paintTools(tools, wrap, { fold: true });
          /*
           * 她的话也能改、也能从这儿分出去。
           *【为什么原先没有】上面注释一直写着「别的照旧（能改、能分支）」，
           * 可实际漏了这两个调用 —— 主人点不开她说的那句。
           * 后端 /api/sessions/edit 本来就允许改 assistant（她就是 assistant + _whale），
           * 缺的只是这里的按钮。回退不挂：退到「主人那句话之前」挂在她身上会误伤。
           */
          attachEdit(wrap, turn.rewindId);
          attachBranchBtn(wrap, turn.rewindId);
          attachRetry(wrap, askQueue);
          attachDelBtn(wrap, turn.rewindId);
          attachCopyBtn(wrap);
          if (turn.edited) wrap.classList.add('edited');
          lastBubbleOfTurn = wrap;
        } else {
          /**
           * 【2026-11-04 根治「切会话/重启回来屏幕全清空」】
           *
           * 这里原来是 `const wrap = addEl(...)`，然后下面 `if (sameStem) { wrap = _contBubble; }`。
           * 并气泡那次改动把「先建新气泡」写成了 const，可紧接着又要把它换成上一段的气泡 ——
           * 一给 const 赋值就抛 `TypeError: Assignment to constant variable`。
           *
           * 而这个错是从 renderTurns 里抛出来的、没有任何地方接住，于是：
           *   ① renderTurns 中断在第二条 assistant 上，聊天区只留下前面那一点点；
           *   ② 异常一路冒到 switchSessionSafe 的 catch，它当成「切会话失败」返回 false；
           *   ③ bootSessions 三次都失败 → 弹出「刚才没能自动回到上次的会话」，屏幕全空。
           * 主人的证据也正好对得上：diag.log 里打点只到「解析完」，后面一条都没有。
           *
           * 改成 let + 先置空：只有真的不并气泡时才建新节点，省一个白建的 DOM。
           */
          let wrap = null;
          // 【2026-10-31 续接进同气泡】
          // 一次工具循环会往历史里写好几条 assistant，看着像「一句话一个气泡」。
          // 这里把同一串（中间没被主人打断）的话接进同一个气泡：话还是那些话，只是不再断开。
          // 工具一律画在气泡外面、原来的位置，不往里挪 —— 挪了就会全堆到末尾。
          const stem = String(turn.stem || '');
          // 判据：上一条也是 assistant ⇒ 这是同一串里接着说的话，并进同一个气泡。
          // （原来拿 turn.stem 比，可服务端根本不发 stem，永远不相等，等于没合并。）
          // 【主人 2026-10-31：柜子要夹在 A 与 B 之间】
          // 中间攒着工具（_hubTools 非空）时不并气泡 —— A 说完干了活再说 B，
          // A 和 B 本来就是两段，各自有各自的工具，并成一条消息柜子就无处可夹，
          // 只能全挤在整条消息后面（实测会连出一串「{柜:1}{柜:1}{柜:1}」）。
          const sameStem = _contBubble && _contBody && _contBody.parentNode
            /* 【2026-11-01 插话嵌中间】上一条是主人插话、而我那段话被劈了一半等着接回来时，
               后面这段也得并进原来那个气泡 —— 不然尾巴没地方接，读起来还是断成两截。 */
            && (prevRole === 'assistant' || _steerTail !== null) && !_hadHubTools;
          let b;
          if (sameStem) {
            wrap = _contBubble;
            /* 【2026-11-01 插话嵌中间】先把被插话劈下来的后半截接回原气泡，
               再接这一段 —— 读到眼睛里就是「我说到一半 → 主人插话 → 我接着说」。 */
            if (_steerTail) {
              const tb = document.createElement("div");
              tb.className = "bubble cont";
              tb.textContent = fixMojibake(_steerTail);
              tb._rawText = _steerTail;
              _contBody.appendChild(tb);
              _contBody = tb;
              _steerTail = null;
              _steerTailBody = null;
            }
            b = document.createElement('div');
            b.className = 'bubble cont';
            mdInto(b, turn.text); // 【2026-11-05】正文走 markdown（没特征就原样文字）
            maybeFoldBubble(b, turn.text);
            attachTime(wrap, turn.ts);
            _contBody.appendChild(b);
            _contBody = b;
            // 后接进来的那段不重复挂按钮，按钮只在第一段上
          } else {
            wrap = addEl('', 'msg assistant', frag);
            /* 【2026-11-02 修·切到别人身份后旧消息署名全被刷掉】
             * 原来这里一律用全局的 mainAgentName —— 那个变量每次切会话都被
             * 改写成「名单第一是谁」。于是切进一个小白曦排第一的会话，
             * 满屏历史消息的署名刷地全成了小白曦。
             * 主人 2026-10-28 就定过：身份名跟着消息一起存，画的时候直接用那份，
             * 不许看「现在是哪个身份」。所以这里优先用这条消息自带的 who。 */
            /* 【2026-11-03 修·名字对了，颜色却还是小鱼的粉】
             * 主人截图报：「红色名字的小白曦，其实是你说的话」。
             * 署名修好之后还差一层：.assistant .role 的颜色写死成 #f0a6a0（小鱼的粉），
             * 于是小白曦那一句名字写对了、颜色却仍旧是我的。
             * 修法：这条消息自带 who、且 who 不是小鱼时，只给「名字那一行」设内联颜色
             * = 她卡上的色（mateColorOf）。
             * 为什么不挂 .mate：.msg.mate .role 会把字号缩到 0.92em，跟小鱼那一列对不齐；
             * 气泡本身也不用变（主人早定过「屋里的人说话都长一样」）。
             * 颜色值等 /api/agents 回来后再刷一遍（refreshMateColors 扫 [data-whoName]）。 */
            const __wn = (turn && String(turn.who || '').trim()) ? String(turn.who).trim() : (String(mainAgentName || '').trim() || '小鱼');
            wrap.innerHTML = '<div class="role">' + __wn + '</div>';
            if (__wn && __wn !== '小鱼') {
              /* 2026-11-03 严检修：只给名字那行上色，不要挂 .mate ——
               * .msg.mate .role 会把字号缩到 0.92em，跟小鱼那一列对不齐。 */
              try {
                wrap.dataset.whoName = __wn;
                const _rl = wrap.querySelector('.role');
                if (_rl) _rl.style.color = mateColorOf(__wn);
              } catch { /* 上不上色都不影响读 */ }
            }
            // 搜会话时靠这个下标把命中那条滚到眼前
            if (Number.isFinite(Number(turn.rewindId))) wrap.dataset.at = String(Number(turn.rewindId));
            b = document.createElement('div');
            b.className = 'bubble';
            mdInto(b, turn.text); // 【2026-11-05】正文走 markdown（没特征就原样文字）
            maybeFoldBubble(b, turn.text);
            attachTime(wrap, turn.ts);
            wrap.appendChild(b);
            _contBubble = wrap;
            _contBody = b;
            _contStem = stem;
          }
          if (outs.length) attachFiles(wrap, outs);
          if (!sameStem) {
          attachEdit(wrap, turn.rewindId);
          // 她说的话下面也有「分支」：从这句回复往下另开一个会话
          attachBranchBtn(wrap, turn.rewindId);
          // 她说错了、或者想让她重答一遍：一键退回再问一次
          attachRetry(wrap, askQueue);
          attachDelBtn(wrap, turn.rewindId);
          attachCopyBtn(wrap);
          if (turn.edited) wrap.classList.add('edited');
          lastBubbleOfTurn = wrap;
          }
        }
      } else {
        lastBubbleOfTurn = null;
        _contBubble = null; _contBody = null; _contStem = null;
      }
      prevRole = turn.role;
      // 工具调用是这一轮的经过，得跟着回复一起留在界面上
      //（以前只活在「正在跑」的那一屏里，切走再回来就全没了）
      // 【2026-10-31 主人纠正：工具要跟着「自己那一段消息」走】
      // 主人原话：「假如你一轮说了A、B两个消息，每个消息都有工具调用，
      //   那么 A 说完后 A 底下得有对应的工具调用，而不是全堆到 B 下面。」
      // 所以不再跨消息往 _hubTools 里攒：每段自己的工具当场折成一处，画在这段话正下方。
      if (tools.length) {
        // 【主人原话：A 与 B 之间的工具并进一个「调了 x 次工具」，且夹在 A 与 B 之间】
        // 只调工具、没说话的那几条，先攒着；等遇到「说了话的 assistant」
        //（见上面那句 flushHub）或下一条 user，才折成一个柜子画出去。
        _hubTools.push(...tools);
      }
      // 这一轮的 token 用量。
      // 用量存在「主人那句」的 user turn 上（见 server.mjs 的 _usage），
      // 但视觉上它属于这一轮的回复 —— 所以挂在**她说的话**下面，
      // 而且平时不显示，鼠标悬停在那句话上才淡出来（见 .turnUsage 的 CSS）。
      //
      // 【为什么用队列】
      // 一轮正常的形状是 user → assistant，但历史里「连着好几条 user」很常见：
      // 主人连着催、或者上一轮被中断了没回复。单个变量会把前一句直接盖掉，
      // 那条用量就没了。所以每遇到一条 user 就压进队列，等这一串 assistant 画完再补。
      if (!nextIsAssistant && pendingTurns.length) {
        for (const p of pendingTurns) {
          if (drawnUsage.has(p.id)) continue;   // 画过就别再画
          drawnUsage.add(p.id);
          const host = lastBubbleOfTurn || frag;
// 把这一轮回复的字数给下去：usage 空的时候按字数粗估（界面上不再标任何字样）
          p.replyChars = turnReplyChars;
          appendTurnUsage(p.u, p.at, p.model, host, true, p.replyChars, p.userChars);
        }
        pendingTurns.length = 0;
      }
    }
  }

  // 历史末尾还挂着一串没等到回复的 user（正在跑 / 被打断），也得各自有那一行。
  // 同样先查记号：前面画过的绝不再画一遍（这就是「两行」的来源）。
  for (const p of pendingTurns) {
    if (drawnUsage.has(p.id)) continue;
    drawnUsage.add(p.id);
    appendTurnUsage(p.u, p.at, p.model, frag, false, p.replyChars, p.userChars);
  }
  pendingTurns.length = 0;

  // 一次性替换 + 只滚一次
  // 【2026-10-31 末尾 flush】：最后那一串还没遇到 user，工具得在收尾前画出来
  flushHub();
  /*
   * 【2026-11-03 修·切回一个正在跑的会话，画面停在半路、箭头一直亮着】
   *
   *  replaceChildren 这一下把整屏历史换掉，高度会骤变，浏览器随即甩一个 scroll 事件。
   *  可那一刻 _lastTop 还是【上一个会话】的位置（比如 13851），换上来的这屏比它矮，
   *  scrollTop 被夹到 5746 —— 滚动回调就判成「主人自己往上翻了」，跟随状态被摘掉。
   *  之后无论怎么跟播、怎么重画，都不会再把他带回底部：画面停在半路，箭头一直亮。
   *
   *  所以重画这一整段（含紧接着的 attachLive / paintSnapshot）开一个静默窗口，
   *  期间的 scroll 只同步记认、不碰 stickBottom。窗口到期后由贴底那一步对齐。
   */
  /* 【2026-11-04 主人报·手动点开的思考链，我一发新消息就自己合上了】
   *
   *  【为什么记录要放在 replaceChildren 之前】
   *  下面那段「收历史工具」也会记录一次展开状态，但那是**重画之后**才去 querySelectorAll 的 ——
   *  那时候 DOM 已经整块换成新元素了，新建的 <details> 默认都是闭合的，
   *  所以记下来的永远是空集合，等于没恢复。必须趁旧 DOM 还在的时候先记。
   *
   *  记的是「第几个 hub / hub 里第几个 tool」这种位置号：重画会把元素换掉，记元素本身没用。
   *  换会话（_ownerSame === false）不记 —— 那是老规矩，进新会话一律收起。
   */
  let _keepOpenBefore = new Set();
  if (_ownerSame) {
    try {
      const _lgB = document.getElementById('log') || document;
      [..._lgB.querySelectorAll('details.toolhub')].forEach((el, hi) => {
        if (el.open) _keepOpenBefore.add('h' + hi);
        el.querySelectorAll('details.tool').forEach((inner, ti) => {
          if (inner.open) _keepOpenBefore.add('h' + hi + 't' + ti);
        });
      });
    } catch {}
  }
  /**
   * 【2026-11-05 加·renderTurns 这条路径漏了滚动保护】
   *
   * 主人报：「往上翻历史时她发新消息，画面弹到很久远以前」，我改了两版都没用 ——
   * 因为我改的是 paintSnapshot（直播重画那条），而**历史重画走的是这里**。
   *
   * 下面 `log.replaceChildren(frag)` 把整屏换掉，高度骤变的瞬间浏览器会把
   * scrollTop 夹到新的最大值；而这里只设了 __ignoreScrollUntil（让 scroll 事件
   * 别改 stickBottom），**没有人把位置还回去**。
   *
   * 锚点算法跟 paintSnapshot 那边一致：记「视口顶部那条消息 + 它离视口顶多远」，
   * 换完下一帧把它挪回原位。用文档坐标算，不能用增量。
   */
  const __anchorBefore = (() => {
    try {
      if (!log || stickBottom) return null;
      const base = log.getBoundingClientRect().top;
      for (const el of log.querySelectorAll('.msg[data-at]')) {
        const r = el.getBoundingClientRect();
        if (r.bottom > base + 4) return { at: el.dataset.at, off: r.top - base };
      }
    } catch (e) {}
    return null;
  })();
  /**
   * 【2026-11-05 加·重画会把当前轮的思维链冲掉，高度一塌就把人弹上去】
   *
   * 主人描述得非常准：「像是我站在思维链上面，然后思维链突然闭合、弹一下把我弹上去」。
   *
   * 查下来：renderTurns 里**根本没有 think 相关代码** —— 历史数据里没有思考过程，
   * 所以它不重画思考块。而屏幕上那个思维链是 paintSnapshot（直播那条路）画的。
   * 于是新消息一来 → 这里整屏 replaceChildren → **思维链被冲走** →
   * 那一整块高度瞬间消失 → 站在它上面的人就被顶到上面去了。
   *
   * 修法不重建（重建要拿 reasoning 数据、还要恢复展开态，太绕）：
   * 重画前把现有的 think 节点**整个摘下来存着**，换屏之后原样接回去。
   * DOM 节点复用，内容、展开态、滚动位置全都不用管。
   */
  /**
   * 【2026-11-05 改·第二版：要接回原位，不是接回末尾】
   *
   * 主人给了一条决定性的线索：「**只在展开思维链时弹**」。
   *
   * 第一版是摘下来之后 `log.appendChild(d)` —— 全接到末尾。
   * 收起状态的思维链只有一行高，挪到末尾影响很小，所以看不出来；
   * 可**展开的**有几十行高，一挪位置整屏的高度分布就变了，
   * 锚点算出来的补偿量自然对不上，于是弹。
   *
   * 现在记下「它前面最近的那条消息是谁」，换屏后插回那条后面；找不到才退到末尾。
   */
  /**
   * 【2026-11-05 加·重画前记下「哪几个柜子是打开的」】
   *
   * 主人报：「打开一个柜子，等新的调用消息出来时它会自动闭上」。
   *
   * foldOldHubs 那条路已经修好了（带 userOpened 记号的不关，实测通过）。
   * 但 renderTurns 是**整屏 replaceChildren** —— 所有柜子重建一遍，
   * 新柜子默认 open=false，记号也没了，于是看着就是「自动闭上」。
   *
   * 这里照 think 那套：画之前把打开的那些记下来（用标题文字当身份），画完按同样的标题恢复。
   */
  const __openHubs = [];
  let __hubSeq = 0;
  /* 【2026-11-05】整体快照：所有 details（柜子/思考/工具卡）的展开状态 */
  const __openAll = snapOpenState();
  try {
    if (log) {
      for (const h of log.querySelectorAll('details.toolhub')) {
        if (!h.open) continue;
        const nm = h.querySelector(':scope > summary .hubname');
        const key = String((nm && nm.textContent) || '').trim();
        const idx = __hubSeq++;
        /**
         * 【2026-11-05 修·按序号记，不只按标题】
         *
         * 主人报「最新消息位置还是这样」。
         *
         * 因为最新那个柜子的标题一直在变（调了 1 次 → 调了 2 次 → …），
         * 按标题匹配，重画后永远对不上。序号是稳的：第几个柜子就是第几个。
         */
        if (key) __openHubs.push({ key, idx });
        else __openHubs.push({ key: '', idx });
      }
    }
  } catch (e) {}

  const __keepThink = [];
  /* 这一屏要画的是哪些「消息下标」—— 思考块只跟着自己的那条消息走 */
  const __incomingAt = new Set(
    (Array.isArray(turns) ? turns : [])
      .filter((t) => t && Number.isFinite(Number(t.rewindId)))
      .map((t) => String(Number(t.rewindId))),
  );
  /**
   * 【2026-11-06 加·这一屏还是不是同一个会话】
   *
   * `window.__turnsOwner` 是上一次画完时记下的「这屏是谁的」（文件末尾有赋值）。
   * 新建会话 / 切会话时 sessionId 已经换成新的，两边对不上 ——
   * 那就一个思考块都不该留，不管它有没有锚点。
   * 直播时 sessionId 没变，两边相等，照旧接回原位。
   */
  let __sameOwner = true;
  try {
    const _cur = (typeof sessionId === 'string' && sessionId) ? sessionId : '';
    const _own = (typeof window !== 'undefined' && window.__turnsOwner) ? String(window.__turnsOwner) : '';
    if (_cur && _own && _cur !== _own) __sameOwner = false;
  } catch (e) {}
  try {
    if (log) {
      /* 屏上所有消息按文档顺序排好，供「这个思考块前面最近的那条消息是谁」用 */
      const _msgs = [...log.querySelectorAll('.msg[data-at]')];
      for (const d of log.querySelectorAll('details.think')) {
        /**
         * 【2026-11-06 修·锚点要找「文档里前面最近的那条消息」】
         *
         * 以前只顺着 previousElementSibling 找。可思考块常常躺在柜子里面，
         * 兄弟节点全是工具卡，一路走到柜子边界就断了 → afterAt 记成空串，
         * 换会话时那一句「找不到就放末尾」就把它塞进了空屏 ——
         * 新会话冒出【想了 26 段】就是这么来的。
         */
        let prev = null;
        for (const m of _msgs) {
          if (m === d) continue;
          const pos = d.compareDocumentPosition(m);
          if (pos & Node.DOCUMENT_POSITION_PRECEDING) prev = m;   // m 在 d 前面
          else if (pos & Node.DOCUMENT_POSITION_FOLLOWING) break; // 已经在后面了
        }
        __keepThink.push({ el: d, afterAt: prev ? String(prev.dataset.at || '') : '' });
        d.remove();          // 先摘下来，免得被 replaceChildren 一起清掉
      }
    }
  } catch (e) {}

  /**
   * 【2026-11-05 重做·第一刀：同一条消息复用旧节点，不再每轮建新的】
   *
   * 现在的做法是「离屏组装一整个 frag，再 replaceChildren 换掉整屏」——
   * 每条消息都重建，节点身份全丢：展开的思维链收起了、图片重新加载、滚动位置归零。
   * 前面那一堆补丁（保留 think、锚点还原、展开态记录）都是在给这个病根打补丁。
   *
   * 这里做最小但有效的一步：**给每条消息一个稳定 key，换屏时能对上就复用旧节点**。
   *   · 节点身份保住 → 展开态、内部状态、图片缓存全都自然连续，不用再额外记；
   *   · 内容不会变旧：流式那条是直接改 DOM 的，旧节点才是最新的。
   */
  /**
   * 【2026-11-05 重做·第二刀：只是追加的时候，一个节点都不换】
   *
   * 第一刀保住了节点身份（复用旧 DOM），但整屏还是要 replaceChildren 一次 ——
   * 那一下会重排、会动滚动位置。
   *
   * 这一步做真的增量：先比 key 列表，如果新列表只是「旧列表 + 尾巴」，
   * 那就只把尾巴 append 进去，已经有的一行都不碰。
   *
   * 只有列表真的变了（回退、压缩、换会话、删消息）才退回全量替换。
   * 全量那条路也还用第一刀的复用，所以最坏情况也不会比原来差。
   */
  let _appendedOnly = false;
  try {
    const _seq = Object.create(null);
    for (const el of frag.querySelectorAll('.msg')) {
      const at = String(el.dataset.at || 'x');
      _seq[at] = (_seq[at] || 0) + 1;
      el.dataset.key = at + '#' + _seq[at];
    }

    const _isMsg = (e) => e && e.classList && e.classList.contains('msg') && e.dataset && e.dataset.key;
    const _domMsgs = [...log.children].filter(_isMsg);
    const _fragMsgs = [...frag.children].filter(_isMsg);

    let _same = 0;
    while (_same < _domMsgs.length && _same < _fragMsgs.length
      && _domMsgs[_same].dataset.key === _fragMsgs[_same].dataset.key) _same++;

    /* 【判据】旧的那些一条不落、而且顺序一致（_same === 旧总数）→ 就是追加。
     * 而且真得有新东西（_fragMsgs 更长），否则什么都不用做。
     *
     * 【2026-11-07 修·force 的时候绝不能走这条快路】
     * 主人报「点删除之后，前面消息的格式全没了，刷新才好」。
     * 天真的想法是「按 key 复用旧节点时别复用纯文本的」，可真正的原因在这儿：
     * 删除走的是 renderTurns(..., {force:true, noCarry:true}) —— 明明要「照盘上重画」，
     * 可旧 DOM 的消息 key 跟新的一一对得上，于是被判成「只是追加」，
     * **一条都没替换**，屏幕上那个直播时写的纯文本气泡就原样留着。
     * 刷新之所以好，是因为刷新时屏上本来就是 md 的。
     *
     * 所以：force 一律真重画，不做追加优化。这类调用（删除/回退/编辑/换分支）
     * 本来就是「我改完了，你照盘上的画一遍」，容不得偷懒。
     */
    if (!(opts && opts.force)
      && _domMsgs.length > 0 && _same === _domMsgs.length && _fragMsgs.length >= _domMsgs.length) {
      const _tailNodes = [...frag.children].slice([...frag.children].indexOf(_fragMsgs[_same] || frag.lastElementChild));
      for (const n of _tailNodes) if (n && n.parentNode === frag) log.appendChild(n);
      _appendedOnly = true;
    }
  } catch (e) {
    _appendedOnly = false;
  }

  if (!_appendedOnly) {
    /* 退回全量：能对上 key 的用旧节点替掉新造的（第一刀那套），再整屏换。 */
    try {
      for (const el of [...frag.children]) {
        const k = el.dataset && el.dataset.key;
        if (!k) continue;
        let old = null;
        try { old = log.querySelector('.msg[data-key="' + k + '"]'); } catch (e) { old = null; }
        if (old && old.parentNode === log) {
          /**
           * 【2026-11-07 修·删除后老消息「没格式了」】
           *
           * 主人报：一轮说完之后点「删除」，前面那些消息的 markdown 全没了，刷新才好。
           *
           * 链路：直播时气泡是 paintSpeech 用 textContent 写的（纯文本 + pre-wrap），
           * 没有 <p>/<strong> 这些子元素；而这里按 data-key 复用的是**旧的那个纯文本气泡**，
           * 于是刚 mdInto 画好的新节点被扔掉，屏幕上留着纯文本 → 看着就是「没格式了」。
           * 刷新时屏上气泡本来就是 md 的，复用没差别，所以「刷新一次就好了」。
           *
           * 判据：新画的那个有元素子节点（= 走了 markdown），旧的却是光秃秃一段文字
           * （= 直播写的纯文本）—— 这种不复用，让新的进来。
           */
          const oldPlain = old.children.length === 0;
          const neuRich = el.children.length > 0;
          if (oldPlain && neuRich) continue;
          try { frag.replaceChild(old, el); } catch (e) {}
        }
      }
    } catch (e) {}
    __ignoreScrollUntil = Date.now() + 800;
    log.replaceChildren(frag);
  }

  /**
   * 【2026-11-05 重做·这里那段清洗撤掉】
   *
   * 它只在 renderTurns 末尾跑，而屏幕上那些脏气泡走的是增量快路，压根不经过这儿。
   * 改成全局的 DOM 监听（见 installTagCleaner），一处管所有出口。
   */
  /* 【2026-11-05】先按整体快照恢复（覆盖柜子/思考/工具卡所有类型） */
  try { applyOpenState(__openAll); } catch (e) {}

  /* 【2026-11-05】再按序号补一遍柜子（防止顺序差异导致上面那步没对上） */
  try { applyOpenState(__openAll); } catch (e) {}

  /* 【2026-11-05】把刚才记的「打开着的柜子」恢复回来（按标题认）。
   * 柜子本身被重建了、内容也更新了，但主人拉开的状态要留着。 */
  try {
    if (__openHubs.length) {
      const _wantIdx = new Set(__openHubs.map((x) => x.idx));
      const _wantKey = new Set(__openHubs.map((x) => x.key).filter(Boolean));
      let _i = 0;
      for (const h of log.querySelectorAll('details.toolhub')) {
        const nm = h.querySelector(':scope > summary .hubname');
        const key = String((nm && nm.textContent) || '').trim();
        /* 序号对得上就恢复（最新那个标题变了也认得出来），标题也能兜一层 */
        if (_wantIdx.has(_i) || (key && _wantKey.has(key))) {
          h.open = true;
          try { h.dataset.userOpened = '1'; } catch (e) {}
        }
        _i++;
      }
    }
  } catch (e) {}

  /* 【2026-11-05】把摘下来的思考块接回**原来的位置**（前面那条消息之后）。
   * 接末尾会让展开的思维链整块位移，高度分布一变就弹。 */
  try {
    for (const it of __keepThink) {
      const d = it.el;
      /**
       * 【2026-11-06 修·新建会话却显示「想了 26 段」】
       *
       * 主人报：「点会话 → 新会话 → 选小鱼 → 开一间，屏幕上显示【想了 26 段】」。
       *
       * 链路：renderTurns 为了不被 replaceChildren 清掉，先把屏上所有
       * details.think 摘下来存进 __keepThink，画完再接回去。
       * 新会话里那些「原来那条消息」早就不在了，锚点找不到，
       * 于是走最后那句 `log.appendChild(d)` —— 把上一个会话的思考块
       * 全塞进了空的新会话里，groupAllTools 再把它们拢成一个柜子，
       * 柜门就写着「想了 26 段」。
       *
       * 现在先问一件事：**它挂的那条消息，在这一屏里还有没有？**
       *   · 有 → 接回原位
       *   · 没有 → 丢掉（换会话/换分支了，它不属于这一屏）
       *   · 压根没有锚点（前面一条消息都没有）→ 才退到末尾
       */
      if (!__sameOwner) continue;                       // 换会话了：一块都不带过去
      if (it.afterAt && !__incomingAt.has(String(it.afterAt))) continue;
      if (it.afterAt) {
        const anchor = log.querySelector('.msg[data-at="' + it.afterAt + '"]');
        if (anchor && anchor.parentNode === log) {
          anchor.after(d);
          continue;
        }
      }
      log.appendChild(d);
    }
  } catch (e) {}
  if (__anchorBefore) {
    requestAnimationFrame(() => {
      try {
        if (stickBottom) return;
        const el = log.querySelector('.msg[data-at="' + __anchorBefore.at + '"]');
        if (!el) return;
        const base = log.getBoundingClientRect().top;
        const docTop = el.getBoundingClientRect().top - base + log.scrollTop;
        log.scrollTop = Math.max(0, docTop - __anchorBefore.off);
      } catch (e) {}
    });
  }
  /* 【2026-11-03 修·插话闪一下就没】把重画前记下的、还没落盘的那几句主人消息补回去，
   *  按当时打字的先后顺序接在这一屏的最后（它们本来就是最新的那几句）。 */
  try {
    for (const _txt of _lostUsers) {
      try { addUser(_txt, '', undefined, undefined, undefined, ''); } catch (e) {}
    }
  } catch (e) {}
  try { window.__renderFrag = null; } catch {}
  /* 记一笔：这一屏现在是谁的。下次 renderTurns 靠它分辨「同一个会话在重画」还是「换人了」 */
  try { window.__turnsOwner = sessionId; } catch (e) {}
  /* 【2026-11-03 加】这一轮还在跑：子任务卡只能从事件流里拿（历史里还没有），
   * 而重画这一下会把它们连根带走 —— 之后 followLive 的指纹没变、不会重画，
   * 屏幕上就空一大截。所以重画完顺手把「还在跑的那些卡」补回来。 */
  try {
    const _lvW = (window.__liveWorkers && window.__liveWorkers[sessionId]) || null;
    const _runningNow = (() => { try { return turnsInFlight.has(sessionId); } catch (e) { return false; } })();
    if (_lvW && _lvW.length && _runningNow) for (const _it of _lvW) paintWorkerCard(_it, null);
  } catch (e) {}
  /* 【2026-11-03 加】历史里存着子任务流水，就照着画出来（办事模式「谁干了什么」） */
  try {
    let _lw = null;
    for (const _t of (Array.isArray(turns) ? turns : [])) {
      if (_t && _t.role === 'assistant' && Array.isArray(_t.workers) && _t.workers.length) _lw = _t;
    }
    if (_lw) for (const _it of _lw.workers) paintHistWorkerCard(_it);
  } catch (e) {}
  /**
   * 【2026-11-01 往上滚再补前面的】窗口化之后，顶上是空的。
   * 滚到接近顶部就再往前放一批（一次 BACKFILL 轮），补完把滚动位置还原，
   * 主人看着就是「往上翻还有」，不会跳。
   */
  /* 【2026-11-05 改】原来这里挂了个 scroll 监听：滚到离顶 240px 就自动补 120 轮。
   * 主人要求改成手动 —— 往上翻的时候一碰顶就触发重画，重画又动高度，
   * 正好和「想安静看历史」打架。现在由顶上那颗「加载更早」按钮负责。
   * （严检时把外面那层空 try/catch 壳去掉了：里面只剩注释，留着只会让人以为有逻辑。） */
  /* 【2026-10-31 主人定】历史画完了，工具调用统统收成一条灰 —— 不然打开会话就是一整屏参数和结果。
   * 留最后一个 hub 展开：那可能是正在跑的这一轮，收起来就看不见我在做什么了。
   * keepFrom 那种「按元素排除」的办法在这儿不好使（最后一个 hub 不一定是我这一轮的），所以自己数。 */
  try {
    const _lgH = document.getElementById("log") || document;
    const _hubs = [..._lgH.querySelectorAll("details.toolhub")];
    /* 【2026-11-04 主人报·手动点开的思考链，我一发新消息就自己合上了】
     *  原来这里不分场合一律 open=false：只要重画（发消息、切会话、定时对账都算）
     *  就把主人亲手展开的思考链全收起来，等于程序擅自改主人的阅读状态。
     *  现在分两种：
     *    ① 换会话 / 刷新进来（_ownerSame === false）→ 仍然一律收起，这是老规矩；
     *    ② 同一会话重画 → 先把开着的记下来，画完按原样恢复。
     *  记的是「第几个 hub / hub 里第几个 tool」这种位置号，不能记元素本身：
     *  重画会把整块 DOM 换掉，旧元素已经不在树上了。 */
    /* 【2026-11-04 修】这里原来又记了一遍展开状态 —— 但走到这儿 DOM 已经 replaceChildren 换新了，
     *  新建的 <details> 全是闭合的，记出来永远是空集合。真正的记录在上面、replaceChildren 之前。
     *  这里直接用那份。 */
    const _keepOpen = _keepOpenBefore;
    /* 上面把该收的收了；同一会话重画时，把主人亲手展开的那几个按位置号恢复回去 */
    if (!_ownerSame) {
      _hubs.forEach((el) => { el.open = false; });
      _hubs.forEach((el) => { for (const inner of el.querySelectorAll("details.tool")) inner.open = false; });
    } else {
      _hubs.forEach((el, hi) => {
        if (_keepOpen.has("h" + hi)) el.open = true;
        el.querySelectorAll("details.tool").forEach((inner, ti) => {
          if (_keepOpen.has("h" + hi + "t" + ti)) inner.open = true;
        });
      });
    }
  } catch (e) { /* 折不起来也不该让整屏白掉 */ }
  // 渲染完一整屏历史之后，必须无条件跳到最底 —— 你打开会话就是想看最新那句。
  // 这里不能用 noteNewContent()：它会看 stickBottom，而这会儿的 stickBottom
  // 还是上一个会话 / 上一次渲染留下的，一旦是 false 就只加未读数、一次都不滚，
  // 表现就是「退出重进还停在最早的位置，得自己往下翻」。
  //
  // 【例外】补历史（opts.keepScroll）：这时候人正往上翻，贴底就是跟他抢方向。
  if (_keepScroll) {
    stickBottom = false;
  } else {
    resetScrollStick();
  }
  /* 【2026-11-05】历史画完了，把散着的工具卡收成柜子（一件也收）。
   * 延后到下一帧再收：renderTurns 后面还有补画子任务卡之类的追加动作，
   * 现在收完，后脚就被它们又摊出来了。 */
  /**
   * 【2026-11-05 改·先当场收一次，别让人看见「散着」的中间态】
   *
   * 主人报：「新的工具调用显示会存在一段时间后才进柜子」。
   *
   * 原来是纯延后（rAF + 120ms），所以画完到归拢之间有一段时间屏幕上是一排散卡。
   * 现在**当场先收一次**，把肉眼可见的窗口压到最小；
   * 后面两次延后照旧留着兜底（renderTurns 后面还有补画动作，会把卡再摊出来）。
   */
  try { groupLooseTools(); } catch (e) {}
  try {
    requestAnimationFrame(() => { try { groupLooseTools(); } catch (e) {} });
  } catch (e) {}
  try { setTimeout(() => { try { groupLooseTools(); } catch (e) {} }, 120); } catch (e) {}
  // 记一笔：这一屏最后停在谁的话上。切会话 / 断开自愈时判断「这轮写完没」要用。
  markTailRole(list);
  // 图片、视频加载完会把高度撑开，撑开之后还得再贴一次底
  if (log) {
    for (const el of log.querySelectorAll('img, video')) {
      if (el.complete === undefined) {
        el.addEventListener('loadedmetadata', () => { if (stickBottom) hardScrollBottom(); }, { once: true });
      } else if (!el.complete) {
        el.addEventListener('load', () => { if (stickBottom) hardScrollBottom(); }, { once: true });
      }
    }
  }
}

/**
 * 切会话这件事本身也得有个上限。
 *
 * 以前这里是直接 await 一个没有超时的请求：服务端只要有一口气不吐字，
 * 界面就停在「上一个会话的画面 + 输入框被锁着」的样子，怎么点都没反应。
 * 现在最多等 8 秒，超时就当连不上，走下面那套「说一句 + 把输入区救回来」。
 */
async function switchSessionSafe(id, opts) {
  try {
    return await Promise.race([
      switchSession(id, opts),
      // 【2026-10-31 修】12 秒太短：186 个 turn 重画 + 260KB 解析真会超。
      // 慢不等于坏，宽限到 60 秒；真出错走下面的 catch，不打这儿的假失败。
      new Promise((r) => setTimeout(() => r(false), 60000)),
    ]);
  } catch (e) {
    console.warn('[switchSessionSafe] 切会话出错:', e && e.message ? e.message : e);
    releaseComposer();
    return false;
  }
}

async function switchSession(id, opts) {
  // 换会话 = 换了一份历史，球的数必须跟着换（先清掉旧数字，别让上一份的残留骗人）
  /**
   * 【2026-10-26 主人报：批量删除开了之后，关掉会话、下次打开还是启用状态】
   *
   * bulkMode / picked 是纯内存变量，从来没人把它清掉，
   * 而 switchSession 一路走到底、最后 renderSessList() 又照着旧值把
   * 复选框和「删掉选中的 N 个」整个重画出来 —— 看着就像「记住了」。
   *
   * 批量删除是「我现在就要删一批」的临时动作，不是该常驻的模式。
   * 切会话就是换了一件事在做，顺手收掉最稳妥：
   * 不带着勾选跨会话（勾的都是上一个列表里的 id，留着反而容易删错）。
   * 注意必须在 start 就清，不能等 renderSessList 之后再清 ——
   * 那样中间会闪一下批量界面。
   */
  if (bulkMode || picked.size) {
    bulkMode = false;
    picked.clear();
    try {
      const bar = document.getElementById('sessBulkBar');
      if (bar) bar.hidden = true;
      const bb = document.getElementById('sessBulk');
      if (bb) bb.classList.remove('on');
      const sl = document.getElementById('sessList');
      if (sl) sl.classList.remove('bulk');
    } catch {}
  }

  /**
   * 【2026-11-05 修·附件跟着会话串味】
   *
   * 草稿是按会话存的（`xy.draft.<sid>`），附件却是全局一个数组：
   * 在 A 会话挑好一张图、切到 B，图还挂在输入框上面，一按发送就发进了 B。
   * 附件是「我现在要发的这个东西」，跟谁走就该是谁的 —— 切会话一律清掉。
   * 草稿文字仍然按会话留着，丢的只是那个还没发出去的附件，重新选一次比发错人强。
   */
  if (attachments.length) {
    attachments = [];
    try { renderAttachBar(); } catch {}
    try { syncSendBtn(); } catch {}
  }

  /**
   * 【2026-10-31 主人报：重启回来弹「没能自动回到上次的会话」，可人其实还在这个会话里】
   *
   * 病根两处：
   *   ① 上面 switchSessionSafe 是 12 秒硬砍，而 186 个 turn 的重画不是网络的活，
   *      超了照样砍 → 报「没能回去」，可数据早回来了，人看着就是自相矛盾。
   *   ② 这里 .then(x => x.json()) 把「解析」挂在超时保护外面，而且一有风吹草动
   *      就 catch 成 null，只往 console 打一行 —— 主人和我都看不见真正的原因。
   *
   * 现在：网络给 30 秒；解析单独兜住，失败时把原文前 200 字也带上，能一眼看出
   * 是服务端返了错页、还是数据太大解析崩了。
   */
  __switchGen++;
  const __switchGenSeen = __switchGen;
  const __t0 = performance.now();
  const __mark = (name) => {
    const ms = Math.round(performance.now() - __t0);
    console.log('[switchSession] ' + name + ' @ ' + ms + 'ms');
    try {
      fetch('/api/debug-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'switchSession', name, ms, sid: id }),
      }).catch(() => {});
    } catch {}
  };

  let __resp = null;
  try {
    __resp = await fetchTimed('/api/sessions/select', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }, 30000);
  } catch (e) {
    console.warn('[switchSession] 请求失败:', e && e.message ? e.message : e);
    return null;
  }
  __mark('响应头回来');

  let __raw = '';
  let r = null;
  try {
    __raw = await __resp.text();
    __mark('读完正文(' + __raw.length + '字符)');
    r = JSON.parse(__raw);
    __mark('解析完(' + (r && r.session && r.session.turns ? r.session.turns.length : 0) + '个turn)');
  } catch (e) {
    // 这里以前只会静静地返回 null，主人看到的就是「切不过去」却不知道为什么。
    const why = e && e.message ? e.message : String(e);
    console.warn('[switchSession] 响应解析失败:', why, '原文前 200 字:', String(__raw).slice(0, 200));
    try {
      fetch('/api/debug-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tag: 'switchSession', name: '解析失败 ' + why + ' 原文:' + String(__raw).slice(0, 120), ms: -1, sid: id }),
      }).catch(() => {});
    } catch {}
    return null;
  }
  if (!r || r.error) {
    // 打不开这个会话（多半是它已经被删了，或多个窗口共用同一目录时被别的窗口改掉了）。
    // 以前是静默 return，人看着就是"点了一下，会话没了/没反应"。现在说一句、并刷新列表。
    const why = r && r.error ? String(r.error) : '连不上服务';
    console.warn('[switchSession] 打不开会话', id, why);
    try {
      if (sessHint) {
        sessHint.textContent = why.includes('not found') ? '这个会话已经不在了，列表已刷新' : ('打不开：' + why);
        sessHint.classList.add('sessWarn');
        setTimeout(() => { try { sessHint.classList.remove('sessWarn'); } catch {} }, 4000);
      }
    } catch {}
    await refreshSessions({ silent: true });
    // 切不过去也别把输入区锁着
    releaseComposer();
    return false;
  }
  /* 【2026-11-02 串会话 · 第三道闸】
   *  拉历史这一段也可能很慢（186 个 turn 要几十毫秒甚至更久）。
   *  等回来时若主人已经又点开了第三个会话，这里再往下画就是拿旧会话的 turns 盖新屏幕。
   *  判据用一个只增不减的世代号：发起时记一份，回来时对不上就整段作废。 */
  /* 作废要返回 true —— 这不是「切失败」。主人已经切到别的会话去了，
   *  这一趟的活儿本来就该扔；返回 false 会让 bootSessions 以为连续三次没切过去，
   *  再弹出那句「刚才没能自动回到上次的会话」，等于凭空造一个错。 */
  if (__switchGenSeen !== __switchGen) return true;
  /* 【2026-11-03 修·切会话输入框串味】原来这里只给 sessionId 赋新值，
   *  从没碰过草稿：在 A 里打的字，切到 B 还留在输入框里（切回来又变成 B 的），
   *  等于草稿根本没按会话分开 —— 可 draftKey() 明明是按 sessionId 存的。
   *  修法：赋值前先把旧会话的打字存进它自己的格子，赋值后再把新会话的打字捞出来。 */
  try { if (typeof saveDraft === 'function') saveDraft(); } catch { /* 存不上也不许挡切换 */ }
  sessionId = r.session.id;
  sessionTitle = r.session.title;
  localStorage.setItem(STORE_KEY, sessionId);
  try { if (typeof restoreDraft === 'function') restoreDraft(); } catch { /* 恢复失败就当空白 */ }
  paintSessNow();
  paintMemoryFlag(r.memory); // 换会话，顶栏的记忆小字也要跟着换
  // 小鱼/小鲸在不在场也是按会话的 —— 但 2026-11-02 顶栏那两颗按钮删了之后，
  // 这件事只剩一处要看：左边「屋里的人」那列牌子（refreshWhoRail 会自己按
  // 新会话重读 /api/agents/group，服务端把 fish/whale 两套状态并进去了）。
  // 专业模式也按会话：切过去要重读，不然按钮还亮着上一个会话的状态
  // 办事模式同理，而且它还带着 worker 名册 —— 切会话必须重读
  try { if (typeof window.__reloadTaskState === 'function') window.__reloadTaskState(); } catch {}
  loadTopCfg(); // 左上角那两个框跟着换成本会话的设置
  /* 【2026-11-02 修·切回来自家会话，历史署名全变成上一个会话的人】
   * 病根在顺序：renderTurns 先把 578 条历史画出来，而它给每条气泡配署名时
   * 优先看这条消息自带的名字，老消息没存名字就退回全局 mainAgentName ——
   * 可这个全局变量要等 refreshAgentChip() 跑完才会改成「这个会话是谁」。
   * 于是画图时拿到的还是上一个会话的人名，满屏都是他。
   * 按 F5 重开就正常，正因为那时 chip 早就算完了。
   * 现在：画之前先把身份算准，算不出来也照画（不能因为一个名字卡住整屏）。 */
  try { if (typeof refreshAgentChip === 'function') await refreshAgentChip(); } catch { /* 名字算不出来也要画 */ }
  /**
   * 【2026-11-07 主人问「切了会话柜门就不变了？」—— 查下来确实少了这一句】
   *
   * 切会话时 #log 会被 renderTurns 整个重画，`_liveHub` 却还指着**原来那个柜子**。
   * 后面再有 tool_start 进来，hubRefreshTitle 刷的是那个已经不在屏幕上的节点 ——
   * 眼前这个柜子的柜门就一直停在「调了 N 次工具」。
   * 新建会话那条路早就 hubReset 了，切会话这条路漏了，补上。
   * （工具卡自己会重新接柜子：_attachToHub 里会把指针再交过去。）
   */
  try { if (typeof hubReset === 'function') hubReset(); } catch {}
  /* 【2026-11-08 修·自动重启后历史一条都不画】
   *
   * 主人报：「办事鱼做完自动重启后，只显示我说的一句以及她说的第一句话，
   * 后面其他说过的话都没了」。
   *
   * 数据其实全在：会话 265 条消息（97 条可见），服务端给了 95 个 turn / 10.8 万字符，
   * 前端日志也写着「解析完(95个turn)」——**是这一步没把它们画出来**。
   *
   * renderTurns 开头有一道保护：这个会话在 turnsInFlight 里（自动续跑已经开跑）
   * 且屏幕归属没变，就直接 return，DOM 交给流式那条路自己长。
   * 自动重启恰好撞上它：开机 8 秒后服务端就把续跑轮起起来了，前端来取历史时
   * 那一轮已经在跑 —— 于是整屏历史被跳过，屏幕上只剩续跑轮刚画的两条。
   *
   * 现在：屏幕本来就是空的（重启后的新窗口）→ 强制画历史。
   * 屏幕上已经有内容时保持原样，不打断正在流式的气泡。
   */
  const _emptyScreen = !(log && (log.querySelector('.msg') || log.querySelector('details.toolhub')));
  /* 【2026-11-08 修·「多段消息堆在一起」又回来了】
   *
   * 今天为了修「重启后历史不画」加了上面这个 force:true，可它只看了 DOM 空不空，
   * 没看这一轮有没有被流式接管。重启后 3 秒轮询会先把 turnsInFlight 记上、
   * 起 followLive 画新事件；这时 switchSession 再拿整份历史 force 重画一遍，
   * 两套画法叠在同一屏上 —— 就是主人说的「多段话又挤在一起」。
   *
   * 现在多一道：这一轮已经被流式接管了，就别再整屏强插，交给 followLive。
   * 屏幕空 + 没人在画，才强制补历史（那正是「重启后一片空白」要救的场景）。
   */
  const _inFlightHere = (() => {
    try { const r = turnsInFlight.get(sessionId); return !!(r && (r.startedAt || r.adopted)); }
    catch { return false; }
  })();
  /* 【2026-11-08】这个会话真在跑 → 历史别画最后那条 assistant，
   * 那段交给 attachLive 的直播去长，否则同一段话被画两遍（切走再切回特别明显）。 */
  const _runningNow = (() => {
    try { return Boolean(runningSess && runningSess.has(sessionId)); } catch { return false; }
  })();
  renderTurns(
    r.session.turns,
    (_emptyScreen && !_inFlightHere)
      ? { force: true, dropTail: _runningNow }
      : { dropTail: _runningNow },
  );
  /* 【2026-11-08】切会话：把**这个会话**的待发送队列读出来（按会话分 key 存的） */
  try { loadPendingQueue(); } catch (e) {}
  // 上下文球：这个会话用了多少 / 能装多少 / 累计 —— 换过来立刻问一次

  // 这个会话还在后台跑吗？
  // 先问服务端（窗口关过也能补回来），再退回本页内存里的记录。
  // 整段包 try：补画失败只是少一段内容，绝不能连累输入框。
  try {
    const liveRunning = typeof attachLive === 'function' ? await attachLive(sessionId) : false;
    if (!liveRunning) {
      const stillRunning = typeof turnsInFlight !== 'undefined' && turnsInFlight.has(sessionId);
      if (stillRunning && typeof replayInFlight === 'function') {
        replayInFlight(sessionId);
        busy = true;
        showSending();
      } else {
        /**
         * 【2026-11-01 修·切会话回来按钮变回【发送】】
         *
         * turnsInFlight 是本页面内存的 Map。切会话、Ctrl+F5 之后它一定是空的，
         * 所以「服务端明明还在跑」也会走到这个 else，把按钮打回【发送】、
         * 连「正在发送消息」也一起藏了 —— 主人报的正是这个。
         *
         * 现在不认内存了，直接再问一次服务端：
         *   running=true  → 锁着（按钮还是【停止】），并且接着跟直播
         *   running=false → 才放开
         */
        let _stillUp = false;
        try {
          const _l = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(sessionId)).then((x) => x.json());
          _stillUp = Boolean(_l && _l.running);
        /* 【2026-11-02 修·切过来看不到这轮已经吐出来的字】
         *
         * attachLive 内部已经把这一轮画过一遍了，并且按 drawnParts 记好了
         * 「画到第几个事件」，剩下的字由它挂的轮询接着长 —— 这里再叫一次
         * followLive 等于同一个会话起两条轮询，后一条会把前一条顶掉，
         * 起点还用的是 events.length（末尾），中间那一大段就永远画不出来了。
         */
        } catch {}
        if (_stillUp) {
          busy = true;
          showSending();
          try { syncSendBtn(); } catch {}
        } else {
          busy = false;
          hideSending();
          try { syncSendBtn(); } catch {}
        }
      }
    } else {
      /* 【2026-11-02 修·切换会话后按钮还是「发送」】       *       *  attachLive 返回 true 说明服务端这一轮确实还在跑，可这里原来只设了       *  busy 和「正在发送」，**漏了 syncSendBtn()** —— 于是输入框锁着、       *  那行小字也出来了，唯独按钮还停在【发送】。主人一点就是发新一轮，       *  服务端回 409，那句话就石沉大海。       *       *  别的分支（往上一行的 _stillUp、往下的 else）都调了这个，唯独这条主路径漏。       */
      busy = true;
      showSending();
      try { syncSendBtn(); } catch {}
    }
  } catch (err) {
    console.warn('[switchSession] 补画后台进度失败（不影响输入）:', err && err.message ? err.message : err);
    /**
     * 【2026-11-01 修 Ctrl+F5：补画失手 ≠ 这一轮跑完了】
     *
     * 原来这里无脑 busy=false + 藏「正在发送」。可补画失败的原因多半是
     * 「渲染时 DOM 出岔子」，跟「服务端还在不在跑」毫无关系。
     * 主人刷新时，服务端 running=True、缓存里 295 个事件，界面却因为这里
     * 把按钮变回【发送】—— 正是他报的那个现象。
     *
     * 现在改成：失败也再问一次服务端，它说在跑就保持锁着（按钮还是【停止】），
     * 剩下的字照样会通过 followLive 长出来。只有服务端明确说没跑，才放开。
     */
    try {
      const live2 = await fetch('/api/chat/live?sessionId=' + encodeURIComponent(sessionId)).then((x) => x.json());
      if (live2 && live2.running) {
        busy = true;
        showSending();
        try { followLive(sessionId, Array.isArray(live2.events) ? live2.events.length : 0); } catch {}
      } else {
        busy = false;
        hidingSendingSafe();
      }
    } catch {
      busy = false;
      hidingSendingSafe();
    }
  }
  stopping = false;
  syncSendBtn();

  renderSessList();
  /**
   * 不管上面有没有抛错，输入区都收拾干净（这条是「删会话后点不了输入框」的根治）。
   *
   * 【这里不能用 settleComposer，它会把 busy 无条件清成 false】
   *   上面刚根据「服务端说这一轮还在跑吗」把 busy 设好（还在跑就是 true），
   *   紧接着 settleComposer 一调，busy 又被清成 false ——
   *   按钮从「停止」变回「发送」，主人一按就是发新一轮，撞 409，消息发不出去。
   *   主人报的「切回来她就停了、发不出话」就是这个。
   *
   *   closeSessPanel 只做该做的事：收面板、放开输入框、还焦点，一个 busy 都不碰。
   *   （settleComposer 的注释里也写着这一条，只是这个调用点以前漏改了。）
   */
  closeSessPanel();
  if (typeof input !== 'undefined' && input) {
    try { input.disabled = false; input.readOnly = false; if (input.dataset) delete input.dataset.locked; } catch {}
  }
  // focus:false 的理由跟以前一样：切会话时人不一定想打字，抢焦点会把输入法冲回英文。
  return true;
}
