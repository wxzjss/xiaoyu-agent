/**
 * 把「两份数据」拍平成一份 keyed 清单。
 *
 * 规格 4.2 / 4.3：
 *   · 历史边界只算一次：跑着的时候，历史只取到「最后一条 user turn」为止
 *     （原来的 trimTurnsForLive，逻辑搬到这里），后面全交给服务端的 liveItems。
 *   · **前端不再自己合成 items**：liveItems 直接用服务端 /api/chat/live 给的那份，
 *     一个字段都不加工（没有 liveItemsFeed 了）。
 *   · 每条 item 带一个 key：历史 `t-<轮次绝对下标>`、直播 `l-<下标>`、
 *     乐观气泡 `p-<id>`、系统提示 `n-<id>`。key 生成之后就不再变
 *     （下标是**绝对**的，往前补历史也不会让已有的 key 平移）。
 */

import { getWindowStart } from './store.js';

/** 长会话只画最近这么多轮，往上翻再补（沿用原来的 40） */
export const WINDOW = 40;

/**
 * 历史边界：跑着的时候，历史只画到「最后一条主人说的话」为止 ——
 * 那之后的内容全归服务端的直播清单，这样同一段永远只有一份。
 *
 * 找不到主人那句话（续跑 / 定时任务 / 群聊插入）就退回「砍最后一条 assistant」，
 * 宁可多留一条也不整屏不画。
 */
export function trimTurnsForLive(turns) {
  if (!Array.isArray(turns) || !turns.length) return turns;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i] && turns[i].role === 'user') return turns.slice(0, i + 1);
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i] && turns[i].role === 'assistant') return turns.slice(0, i).concat(turns.slice(i + 1));
  }
  return turns;
}

/** 这一轮是不是还在跑 */
export function isRunning(snap) {
  const lv = snap && snap.live;
  return !!(lv && lv.running !== false && Array.isArray(lv.items) && lv.items.length);
}

/**
 * 【历史气泡的署名兜底 · 2026-11-11 修主人报的错】
 *
 * 主人报：「关掉小鱼、启用小鲸后，小鱼一开始那句话被署名成【小鲸】，名字颜色也变白」。
 *
 * 根因就在这里：这个函数原来读的是 `#whoRail .whoBtn:not(.off)`——
 * 也就是**当前**屋里第一个开着的人。于是主人一切换身份，
 * **所有没有 `_who` 的老消息**就集体改署名了：小鱼干的活全变成小鲸的，
 * 颜色也跟着当前卡变。
 *
 * 正确口径（index.html:10631 那段注释早就写清了）：
 *   后端约定「落盘 `_who` 为空 = 小鱼」——老消息绝大多数都是小鱼干的活。
 *   所以历史气泡的兜底**必须永远固定 '小鱼'**，谁在场都不影响它。
 *
 * 本轮谁在说话是另一件事，用 turnSpeaker() 取（读 window.__turnSpeakerName）。
 */
function mainAgentName() {
  return '小鱼';
}

/**
 * 这一轮谁在说话 —— **只给流式气泡用**。
 *
 * 跟 mainAgentName 彻底分开（11-03 那条警告、11-09 二修、11-11 三修都是栽在
 * 把这两件事合成一个变量上）。流式气泡创建得同步，来不及等接口，
 * 所以读 index.html 在拉名单时存下的那份快照。
 */
function turnSpeaker() {
  try {
    const n = String(window.__turnSpeakerName || '').trim();
    if (n) return n;
  } catch (e) { /* 拿不到就用下面的兜底 */ }
  return '小鱼';
}

function hasText(s) {
  return String(s == null ? '' : s).trim().length > 0;
}

function numOrNull(v) {
  return Number.isFinite(Number(v)) ? Number(v) : null;
}

/**
 * 历史一条 turn → 若干 item。
 *
 * 刻意**不画**的（跟原实现一致）：system 消息、程序自己插的压缩提醒（turn.sysNote）、
 * 带 context 标记的记忆片段。
 */
function turnToItems(turn, abs, userChars) {
  const out = [];
  if (!turn || typeof turn !== 'object') return out;
  if (turn.role === 'system' || turn.context || turn.sysNote) return out;
  const key = 't-' + abs;

  if (turn.role === 'user') {
    const who = String(turn.who || '');
    /* 群聊里别人说的话被存成 role:'user'（老数据），按「那个人」的样子画 */
    const isMate = Boolean(who) && who !== '主人';
    out.push({
      kind: isMate ? 'mate' : 'user',
      key,
      text: String(turn.text || ''),
      atts: Array.isArray(turn.atts) ? turn.atts.filter((a) => a && a.path) : [],
      who,
      tag: '',
      rewindId: numOrNull(turn.rewindId),
      ts: numOrNull(turn.ts),
      edited: Boolean(turn.edited),
      isLive: false,
    });
    return out;
  }

  /* 她这一轮想过什么：挂在她说的话**上面**（想在前、说在后） */
  if (turn.reasoning && !turn.whale) {
    out.push({ kind: 'think', key: key + '-k', text: String(turn.reasoning || ''), running: false });
  }

  const tools = Array.isArray(turn.tools) ? turn.tools : [];
  /** 她这一轮发出去的文件（服务端存的是 turn.out，老字段名 _out）：
   *  【2026-11-10 收编（A2）】不再由 AssistantBubble 调 attachFiles 往气泡上挂，
   *  这里直出成 file 条目，跟直播那半边同一个画法（FileCard）。 */
  const outs = Array.isArray(turn.out) ? turn.out.filter((f) => f && (f.path || f.key)) : [];
  const text = String(turn.text || '');

  if (turn.whale) {
    /* 小鲸 / 别的智能体卡说的话：单独一条气泡，不并进我的 */
    if (hasText(text)) {
      out.push({
        kind: 'say',
        key,
        who: String(turn.whale),
        bubbles: [text],
        rewindId: numOrNull(turn.rewindId),
        ts: numOrNull(turn.ts),
        edited: Boolean(turn.edited),
        cont: false,
      });
    }
  } else if (hasText(text) || outs.length) {
    out.push({
      kind: 'assistant',
      key,
      who: String(turn.who || '').trim() || mainAgentName(),
      bubbles: hasText(text) ? [text] : [],
      rewindId: numOrNull(turn.rewindId),
      ts: numOrNull(turn.ts),
      edited: Boolean(turn.edited),
      cont: false,
      /* 这一轮的用量（token / 花费）。渲染时挂在她说的话下面，悬停才显示。 */
      usage: turn.usage || null,
      model: String((turn.usage && turn.usage.model) || ''),
      replyChars: String(text || '').length,
      userChars: Number(userChars) || 0,
    });
  }

  /* 她发的文件：紧跟在这段话后面画（和工具一个节奏），刷新 / 翻回来照样看得见 */
  for (let i = 0; i < outs.length; i++) {
    const f = outs[i];
    out.push({
      kind: 'file',
      key: key + '-f' + i,
      name: String(f.name || '文件'),
      size: Number(f.size) || 0,
      fkind: String(f.kind || 'file'),
      path: String(f.path || ''),
      fkey: String(f.key || ''),
      dir: 'out',
      isLive: false,
    });
  }

  /* 工具：紧跟在这段话后面画。连续多张由 LogView 折成「柜子」。 */
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i] || {};
    /* 【2026-11-10】压缩假工具同样不许出现在历史里（旧进程往盘上写过它）。
     * 直播那条路已经在 liveToItems 里滤了，这里是另一半 —— 两条都滤才彻底。 */
    if (String(t.name || '') === 'compress') continue;
    out.push({
      kind: 'tool',
      key: key + '-tl' + i,
      id: String(t.id || ''),
      name: String(t.name || ''),
      args: t.args,
      status: t.ok === null || t.ok === undefined ? 'run' : t.ok ? 'ok' : 'err',
      output: String(t.output || ''),
    });
  }

  /* 【团队模式】这一轮谁在干活（历史里也存了，刷新/翻回来照样看得见） */
  const workers = Array.isArray(turn.workers) ? turn.workers : [];
  for (let i = 0; i < workers.length; i++) {
    const w = workers[i] || {};
    out.push({
      kind: 'worker',
      key: key + '-w' + i,
      id: String(w.id == null ? i : w.id),
      name: String(w.name || ''),
      status: String(w.status || 'run'),
      steps: Array.isArray(w.steps) ? w.steps : [],
      note: String(w.note || ''),
      /* 【2026-11-11 团队模式】卡上要显示「跑了多久」「几轮几次工具」 */
      startedAt: Number(w.startedAt) || 0,
      endedAt: Number(w.endedAt) || 0,
      rounds: Number(w.rounds) || 0,
      tools: Number(w.tools) || 0,
    });
  }
  /* 【2026-11-11 团队模式】同一轮有多张卡时，在最后一张后面补一行小字，
   * 主人扫一眼就知道全局：不用一张张点开看状态。 */
  if (workers.length > 1) {
    const _run = workers.filter((w) => (String(w.status || 'run')) === 'run').length;
    const _ok = workers.filter((w) => String(w.status) === 'ok').length;
    out.push({ kind: 'note', key: key + '-wsum', text: _run + ' 个在跑 · ' + _ok + ' 个回来了', isLive: false });
  }
  return out;
}

/** 服务端的 liveItems → item。一个字段都不改，只补 key 和「谁说的」。 */
function liveToItems(items, running) {
  const out = [];
  /* 【2026-11-11】流式气泡的署名用 turnSpeaker()（本轮谁在说话），
   * **不是** mainAgentName()（历史兜底固定小鱼）—— 切到小鲸时她正在说的话
   * 必须署小鲸，否则屏幕上会出现"小鲸在说、署名却是小鱼"。 */
  const speaker = turnSpeaker();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it || !it.k) continue;
    const key = 'l-' + i;
    if (it.k === 'text') {
      /**
       * 【2026-11-10 修·空气泡】
       *
       * 服务端 appendLiveItem / buildLiveItems 在「text 事件来了但内容还是空」时
       * 会留下一条 `{k:'text', t:''}`（QA 在 parity 检查里早就钉住过这个口径差）。
       * 换框架后这里原样往下传 → React 建一个**空的 assistant 气泡**。
       *
       * 后果：F5 之后屏幕上比服务端清单多一个气泡（实测「实际 2 个 / 清单 1 段」）。
       * 空正文本来就没有可显示的东西，直接跳过 —— 与「清单里那一条」不对等也没关系，
       * 因为它不含任何正文。
       */
      if (!String(it.t || '').trim()) continue;
      out.push({
        kind: 'assistant',
        key,
        who: speaker,
        bubbles: [String(it.t || '')],
        rewindId: null,
        ts: null,
        edited: false,
        cont: false,
        isLive: true,
      });
    } else if (it.k === 'think') {
      out.push({ kind: 'think', key, text: String(it.t || ''), running: running !== false, isLive: true });
    } else if (it.k === 'tool') {
      /**
       * 【2026-11-10 主人定：压缩一律不显示】
       *
       * 后端已经不推 compress 的 tool_start/tool_end 了，但**旧进程 / 旧重放**里还有。
       * 换框架前是四处硬拦（name === 'compress' 就不画），React 这边原来原样往下传，
       * 于是屏幕上会冒出一张「压缩中 · 运行中…」的假卡（QA 真机抓到）。
       *
       * 现在在「清单 → 行」这一步就滤掉：这是唯一入口，后面谁画都看不到它。
       */
      if (String(it.name || '') === 'compress') continue;
      out.push({
        kind: 'tool',
        key,
        id: String(it.id || ''),
        name: String(it.name || ''),
        args: it.args,
        status: String(it.status || 'run'),
        output: String(it.output || ''),
        isLive: true,
      });
    } else if (it.k === 'worker') {
      out.push({
        kind: 'worker',
        key,
        id: String(it.id == null ? '' : it.id),
        name: String(it.name || ''),
        status: String(it.status || 'run'),
        steps: Array.isArray(it.steps) ? it.steps : [],
        note: String(it.note || ''),
        /* 【2026-11-11 团队模式】耗时用：startedAt 来自 start 事件，
         * endedAt 由服务端在 end 事件那刻补（appendLiveItem）。 */
        startedAt: Number(it.startedAt) || 0,
        endedAt: Number(it.endedAt) || 0,
        rounds: Number(it.rounds) || 0,
        tools: Number(it.tools) || 0,
        isLive: true,
      });
    } else if (it.k === 'say') {
      /**
       * 【2026-11-10 修·空气泡（A6）】say 与 text 对称滤空。
       *
       * 服务端 whale_stream_start 原来会先落一条 {k:'say', t:''} 占位（旧版
       * 这里原样往下传 → React 建一个「别人说了句空话」的空气泡）。
       * 服务端源头已改（不再落空 say），这里再把对称的滤空钉住：
       * 就算旧进程 / 旧重放里还有空 say，屏幕上也不冒空气泡。
       */
      if (!String(it.t || '').trim()) continue;
      out.push({
        kind: 'say',
        key,
        who: String(it.who || ''),
        bubbles: [String(it.t || '')],
        rewindId: null,
        ts: null,
        edited: false,
        cont: false,
        isLive: true,
      });
    } else if (it.k === 'file') {
      /**
       * 【2026-11-10 收编（A2）】她发的文件：服务端清单里的条目，直出。
       *
       * 服务端 appendLiveItem / buildLiveItems 已把 sentfile / files 事件
       * 合成 k:'file'（带文件名 / 大小 / kind / 路径 / outbox key / 方向）。
       * 这里一个字段都不加工，转成屏幕条目，由 FileCard 渲染。
       * 旧路（attachFiles 往 .msg 塞 fileList、placeSentCard 往 .bubble.streaming
       * 里塞卡片）已删 —— mdInto 每个流式 tick 都重写 .bubble 的 innerHTML，
       * 谁挂进去谁下一个 tick 就没了。
       */
      if (!String(it.path || '') && !String(it.fkey || '')) continue;
      out.push({
        kind: 'file',
        key,
        name: String(it.name || '文件'),
        size: Number(it.size) || 0,
        fkind: String(it.kind || 'file'),
        path: String(it.path || ''),
        fkey: String(it.fkey || ''),
        dir: String(it.dir || 'out'),
        isLive: true,
      });
    } else if (it.k === 'user') {
      /**
       * 【2026-11-10 主人钦点·插话显示在对话流中间】
       *
       * 服务端 /api/interject 在 steer 成功那一刻就往当前轮的直播清单推一条
       * `{k:'user', t, steer:true, ts}` —— 它的位置就是事件真实顺序：
       * 她消息1（含工具）之后、消息2 之前。
       *
       * 这里直出成主人气泡（跟历史里的 user turn 同一种画法），
       * 不再走 pushPendingUser 的乐观气泡 —— 那条路会把插话画到 live 之后
       * ＝屏幕最底，正是主人不满意的地方。轮末落盘换历史时，
       * 这句已经在 turns 里了，key 从 l-N 换成 t-N，内容一致、位置不跳。
       */
      const _t = String(it.t || '');
      if (!_t.trim()) continue;
      out.push({
        kind: 'user',
        key,
        text: _t,
        atts: Array.isArray(it.atts) ? it.atts : [],
        who: String(it.who || '主人'),
        tag: '插话',
        steer: true,
        ts: Number(it.ts) || null,
        rewindId: it.rewindId != null ? it.rewindId : null,
        edited: false,
        isLive: true,
      });
    } else if (it.k === 'note') {
      out.push({ kind: 'note', key, text: String(it.t || ''), isLive: true });
    }
  }
  return out;
}

/**
 * 主入口：快照 → 清单。
 * 顺序永远是：历史 → （还没落盘的主人那句）→ 直播。落盘之后乐观那条自动消失，
 * 位置不跳 —— 因为它本来就在同一个地方。
 */
export function buildMerged(snap) {
  const running = isRunning(snap);
  const all = running ? trimTurnsForLive(snap.turns) : snap.turns;
  const sid = snap.sid;

  /* 窗口：只画最近 WINDOW 轮（长会话一次性建上万个节点会把主线程顶住） */
  let start = Number(getWindowStart(sid)) || 0;
  /* 【2026-11-11 修·虚拟化恒不生效】原条件 `start >= 0 && all.length - start >= WINDOW`
     在用户没往前翻过（start=0）且会话够长时恒为真 → start 保持 0 → 整个会话全画，
     300 轮切过去卡 6.8 秒。窗口的语义是「用户手动往前翻过就尊重他的位置，
     否则只留最近 WINDOW 轮」—— 判据应该是 start > 0。 */
  if (!(start > 0)) start = Math.max(0, all.length - WINDOW);
  start = Math.max(0, Math.min(start, all.length));

  const items = [];
  let lastUserChars = 0;
  /* 用量行是「一轮一行」，挂在那一轮她说的话下面 —— 所以只给每轮第一段打标 */
  let wantUsageRow = false;
  for (let i = start; i < all.length; i++) {
    const turn = all[i];
    const part = turnToItems(turn, i, lastUserChars);
    if (turn && turn.role === 'user') {
      lastUserChars = String(turn.text || '').length;
      wantUsageRow = true;
    }
    for (const it of part) {
      /* 同一句话被工具活劈成好几条 assistant turn 时，并回一个气泡（原 sameStem 的口径） */
      const prev = items.length ? items[items.length - 1] : null;
      if (
        it.kind === 'assistant' &&
        prev &&
        prev.kind === 'assistant' &&
        prev.who === it.who &&
        !prev.isLive &&
        !it.isLive
      ) {
        prev.bubbles = prev.bubbles.concat(it.bubbles);
        if (it.rewindId != null) prev.rewindId = prev.rewindId == null ? it.rewindId : prev.rewindId;
        continue;
      }
      if (it.kind === 'assistant' && wantUsageRow) {
        it.usageRow = true;
        wantUsageRow = false;
      }
      items.push(it);
    }
  }

  const pend = (snap.pendingUser || []).map((p) => ({
    kind: p.who && p.who !== '主人' ? 'mate' : 'user',
    key: p.id.indexOf('p') === 0 ? 'p-' + p.id.slice(1) : 'p-' + p.id,
    text: p.text,
    atts: p.atts,
    who: p.who,
    tag: p.tag,
    rewindId: p.rewindId,
    ts: Date.now(),
    edited: false,
    isLive: true,
  }));

  const live = running ? liveToItems(snap.live.items, true) : [];
  const noteItems = (snap.notes || []).map((n) => ({ kind: 'note', key: n.id, text: n.text, actions: n.actions || null }));

  return {
    running,
    start,
    totalTurns: all.length,
    items: items.concat(pend, live, noteItems),
  };
}
