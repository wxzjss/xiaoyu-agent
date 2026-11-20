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

import { getWindowStart, isWindowTouched } from './store.js';

/**
 * 【2026-11-17 晚·根治「她的话在屏幕上凭空消失」——定案】
 *
 * 病灶：带 tool_calls 的那一圈，后端会把整段正文打上 _process，前端历史上「一个像素都不画」。
 * 结果同一轮里她只要顺手调了个工具（打个勾、建个清单），连她真正对主人说的那一大段话
 * 也一起被抹掉 —— 主人真机撞上：六段原文发出去，界面上一句都找不到。
 *
 * 治法（主人原话定案：「我要的是像你现在这样就好，正常显示」）：
 *   不再按字数分档、不再藏、不再降级成灰字条 —— 只要这句话有正文，
 *   就一律走正常气泡，跟她非过程轮的答复一模一样。从根上杜绝「她的话消失」。
 */

/** 长会话只画最近这么多轮，往上翻再补（沿用原来的 40） */
export const WINDOW = 40;

/**
 * 历史边界：跑着的时候，历史只画到「最后一条主人说的话」为止 ——
 * 那之后的内容全归服务端的直播清单，这样同一段永远只有一份。
 *
 * 找不到主人那句话（续跑 / 定时任务 / 群聊插入）就退回「砍最后一条 assistant」，
 * 宁可多留一条也不整屏不画。
 */
/**
 * 【本轮还没落盘的回复先留着 —— 2026-11-11 修主人报的「发消息一瞬间回复消失」】
 *
 * 病根就是下面这个裁剪：它的假设是「历史里最后一条 user = 当前这一轮」，
 * 于是把「最后一条 user 之后的内容」剪掉（因为那部分 live 会重新提供，不剪会重复）。
 *
 * 但这个假设在**刚发消息那一瞬间**是错的：
 *   主人发消息2 → 前端先乐观插一条 pendingUser，**服务端历史里还没有消息2**
 *   → 历史 = [消息1, 回复1]，最后一条 user 仍是**消息1**
 *   → 裁成 [消息1] → **回复1 被剪掉**
 *   → 屏幕上是「消息1 / 消息2」，正好是主人描述的「一瞬间折叠」。
 *   一秒后消息2 落进历史，最后一条 user 变成消息2，回复1 又回来了 —— 所以只闪一下。
 *
 * 修法：**有 pendingUser（刚发的那条还没进历史）时一律不裁。**
 * 这时候 live 提供的是**新消息**的回复，跟历史里的回复1 根本不在一个位置，不冲突；
 * 等消息2 真落进历史了，再按原规则裁（那才是与 live 重复的部分）。
 *
 * @param {Array} turns
 * @param {{hasPending?: boolean, pendingLanded?: boolean}} [opts]
 *   hasPending     pendingUser 里有东西（刚发、还没进历史）
 *   pendingLanded  那条 pending **服务端已经答完了**（history 里最后一条 assistant
 *                  比它新）—— 这时候不能留历史里的那份，否则和 live 重复
 */
export function trimTurnsForLive(turns, opts = {}) {
  if (!Array.isArray(turns) || !turns.length) return turns;
  /**
   * 【2026-11-18 加·有轮次 id 就按 id 裁 —— 这一条最准，所以放最前面】
   *
   * 上面那一大串注释（hasPending / startedAt / 下标推算）全是在**没有轮次标识**时
   * 的猜测：靠"最后一条 user 是不是本轮"、"这条 assistant 的时间戳早不早于直播开工"
   * 来推断哪一段该裁。判据越多，缝隙越多 —— 前后为此加了 12 个去重检查。
   *
   * 现在服务端每轮起手发一个 turnId，落盘时给这一轮的消息盖 `_turn`，
   * 直播清单也带着同一个 turnId。于是"这一轮在历史里从第几条开始"变成一个**确定的数**：
   *   · 找到第一条 `turn === live.turnId` 的下标 i → 历史只画 [0, i)，
   *     i 之后全交给直播（直播里一定有完整一份）；
   *   · 找不到（这一轮还没落盘）→ 返回 -1，走下面的老逻辑兜底。
   *
   * 老会话 / 老服务端没有这个字段 → `liveTurnIndex` 是 -1 → 行为跟以前一模一样，
   * 不会因为这次改动变差。
   */
  const _byTurn = Number.isInteger(opts && opts.liveTurnIndex) ? opts.liveTurnIndex : -1;
  if (_byTurn >= 0) {
    // 起轮的用户消息已落盘，直播只补正文和中途插话。
    let boundary = _byTurn;
    const turnId = turns[_byTurn]?.turn;
    while (turns[boundary]?.role === 'user' && turns[boundary].turn === turnId && !turns[boundary].steer) {
      boundary += 1;
    }
    return turns.slice(0, boundary);
  }
  /**
   * 【2026-11-11 再修·主人报「一个小鲸白名字、一个小鲸蓝名字，然后都不见了」】
   *
   * 上午那版写成「有 pending 就一律不裁」，放得太宽了：
   * 主人发完消息、**回复已经出来了**的那一两秒里，pendingUser 还在
   * （清理是异步的），于是历史里上一轮的回复留着（白名字的那条），
   * live 里同一句话又画一份（蓝名字的那条）→ **两个小鲸**；
   * 等 pending 清掉、历史重画，两条一起消失，再过一秒才回来新的 ——
   * 正是主人描述的「两条消失 → 两秒后重出一条」。
   *
   * 正确的判据：**只有"这条 pending 还没有对应的回答"时才不裁**。
   * 一旦历史里最后一条 assistant 比 pending 新（说明服务端已经答完），
   * 就得照原规则裁掉，让 live 那份接管，不能两边都留。
   */
  if (opts && opts.hasPending && !opts.pendingLanded) return turns;
  /* 【2026-11-13 修·主人报「续上后当前这轮她说的所有内容被吞」（端到端采样实锤）】
   * 原来跑动时把历史从最后一条 user 之后**整段裁掉**——那是给「当场发消息」的
   * 流式轮设计的：正文边流边落盘，历史里那份跟直播重复，裁掉防双份。
   * 可续跑轮（重启后续上）的直播**只有新内容**——被打断那轮已提交的正文和
   * 工具卡在直播里根本没有，一裁主人看着就是「当前这轮她说的所有内容被吞」
   * （_t_restart_dup_screen 采样：接上一瞬间屏幕从 3 条塌到 1 条，只剩消息A）。
   *
   * 现在按「属于本轮」裁：opts.startedAt = 直播开始时刻。倒着扫，碰到
   * **早于直播开工的 assistant**（ts < startedAt，重启前已提交的那半截）就停——
   * 它和它之前的历史照常画，直播只管接后面的新内容；ts >= startedAt 的
   * （本轮边流边提交的段落）照旧裁——直播里有同款，裁掉防双份。
   * ts 缺失（0）的照旧裁（老行为，万一 live 真带着它也不至于画两遍）。 */
  const _startedAt = Number(opts && opts.startedAt) || 0;
  for (let i = turns.length - 1; i >= 0; i--) {
    const _t = turns[i];
    if (_t && _t.role === 'user') return turns.slice(0, i + 1);
    if (_t && _t.role === 'assistant' && _startedAt > 0) {
      const _ts = Number(_t.ts) || 0;
      if (_ts > 0 && _ts < _startedAt) return turns.slice(0, i + 1);   // 本轮开工前的历史：一个字都不裁
    }
  }
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i] && turns[i].role === 'assistant') return turns.slice(0, i).concat(turns.slice(i + 1));
  }
  return turns;
}

/**
 * 这一轮是不是还在跑。
 *
 * 【2026-11-11 修·主人报「发到一半突然消失一下，然后再全发出来」】
 *
 * 原来最后一个条件是 `lv.items.length` —— 要求清单里**已经有东西**才算在跑。
 * 于是新一轮刚开始、第一个字还没吐出来的那一两百毫秒里：
 *   items = [] → isRunning 判 false → 下面 buildMerged 里 `live` 整段被丢掉
 *   → 屏幕上瞬间只剩「历史 + 你刚发的那条」→ 看起来像"发到一半消失了"
 * 第一个字一到，items 非空 → 判 true → live 整段**一次性全冒出来**。
 * 主人看到的「消失一下再全发出来」就是这一帧。
 *
 * 判据只该看**服务端说没在跑**（`running === false`）：
 * 那时才是真结束了。清单空只是"还没开始说话"，不等于"没在跑"。
 * 空清单本身也不会画出任何东西，保留 running=true 是安全的。
 */
export function isRunning(snap) {
  const lv = snap && snap.live;
  return !!(lv && lv.running !== false);
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
 *
 * 【2026-11-19 补·这条兜底现在几乎用不上了，但一个字都不能改】
 * 主人报「小白曦会话的历史里，她的名字变成小鱼」——就是这里兜的。
 * 后端改了：`publicSession` 会把**本会话绑的那张卡**的名字放进 who 里，
 * 只有「绑的就是小鱼」才继续交 undefined，落到这里。
 * 所以：
 *   · 这里**仍然固定 '小鱼'**，绝不能改成读当前在场名单（11-11 栽过一次）；
 *   · 绑卡的会话已经由后端署名，不靠这句。
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
  /* 【2026-11-12 加·「上一轮断在半路」的历史提示行】
   * 服务端 publicSession 会在历史末尾补一条 `note: true` 的 turn（见 restoreDraftHalfTurn
   * 那段注释）：她半路被杀、半截话被接回历史这件事，以前屏幕上一个字都不提，
   * 主人以为是「回答丢了」。这里把它画成一行系统提示 —— 不是谁说的话，不挂气泡。 */
  if (turn.note) {
    /* 【2026-11-18 修·主人报「刚发的图这一轮结束后就消失了」】
     * 上游网关抖动时，那一轮被服务端存成一条 note（「网关波动了，正在重试」），
     * 而她那轮**真发出去的图**是挂在这条 note 上的（turn.out / 老字段名 _out）。
     * 老代码在这里直接 return 一行提示，文件条目整段跳过 —— 于是图只在直播时看得见，
     * 一轮落地换历史视图就"消失"了，主人以为是丢图。
     * 现在：提示照画，挂在它身上的文件也照画（跟正常 turn 的 file 条目同一规格）。 */
    const _items = [{ kind: 'note', key: 't-' + abs + '-note', text: String(turn.text || ''), isLive: false }];
    const _nouts = Array.isArray(turn.out) ? turn.out.filter((f) => f && (f.path || f.key)) : [];
    for (let i = 0; i < _nouts.length; i++) {
      const f = _nouts[i];
      _items.push({
        kind: 'file',
        key: 't-' + abs + '-nf' + i,
        name: String(f.name || '文件'),
        size: Number(f.size) || 0,
        fkind: String(f.kind || 'file'),
        path: String(f.path || ''),
        fkey: String(f.key || ''),
        dir: 'out',
        isLive: false,
      });
    }
    return _items;
  }
  if (turn.role === 'system' || turn.context || turn.sysNote) return out;
  const key = 't-' + abs;

  if (turn.role === 'user') {
    const who = String(turn.who || '');
    /* 群聊里别人说的话被存成 role:'user'（老数据），按「那个人」的样子画 */
    const isMate = Boolean(who) && who !== '主人';
    /**
     * 【2026-11-11 修·插话在历史里「堆到轮末」（steer-fixer）】
     *
     * 服务端 publicSession 会给插话消息带两个记号（server.mjs:637 / 12662）：
     *   steer: true    这句是主人半路插进来的
     *   steerAt: N     他插话那一刻**她那段话**已经说出多少字（_atChars）
     *
     * 老 DOM 渲染器靠这两个数把她那段话劈成两半、把主人的话嵌在中间；
     * React 重写后 turnToItems 把它们整个忽略了 —— 于是历史里的插话只能按
     * 数组顺序排（在她那段话**之后**），看起来就是「我的话跑到她那段话后面 /
     * 堆到这一轮最末」。这里把两个字段带到 item 上，劈段由 buildMerged 末尾
     * 的 applySteerSplits() 负责（它要看到「前一条 assistant」，单条 turn 里看不到）。
     *
     * tag 也跟着给上「插话」：轮末落盘换历史时，那颗气泡的小标不许消失
     * （直播那条路 liveToItems 一直有）。
     */
    const _steer = turn.steer === true;
    /* 【别用 numOrNull】`Number(null)` 是 0 —— null 会被当成「steerAt = 0」，
     * 老插话（没有这个字段）就会跑到那一段前面去。只认真的数字。 */
    const _steerAt = typeof turn.steerAt === 'number' && Number.isFinite(turn.steerAt) ? turn.steerAt : null;
    out.push({
      kind: isMate ? 'mate' : 'user',
      key,
      text: String(turn.text || ''),
      /* 【2026-11-13 修·主人报「切换身份说话时前端消息渲染会有问题」】
       * mate 条目原来只带 text 不带 bubbles —— 而 LogView 把 kind:'mate'
       * 一律交给 MateBubble，它只认 it.bubbles（数组）→ 身份说话的每一条
       * 从历史重画时**正文全丢**（气泡里只剩名字、时间、按钮）。
       * 现在带上 bubbles，跟 say/assistant 条目同一规格。
       * 【注意】这里只能用 turn.text —— 下面那个 const text 在这之后才声明，提前用会 TDZ 炸。 */
      bubbles: hasText(turn.text) ? [String(turn.text || '')] : [],
      atts: Array.isArray(turn.atts) ? turn.atts.filter((a) => a && a.path) : [],
      who,
      tag: _steer ? '插话' : '',
      steer: _steer || undefined,
      steerAt: _steer ? _steerAt : null,
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
        spectator: Boolean(turn.spectator),
        bubbles: [text],
        rewindId: numOrNull(turn.rewindId),
        ts: numOrNull(turn.ts),
        edited: Boolean(turn.edited),
        cont: false,
      });
    }
  } else if (hasText(text) || outs.length) {
    /* 【2026-11-16 晚·过程话彻底不上屏（主人第三次提这件事，这次说透了）】
     *
     * 主人原话：「我不想看到【（先给自己起个名，这事儿不能忘）】的提示出现在我的屏幕上，
     * 改为只有她自己能看见」+「为什么她回我的内容会在金色的提示里？然后又回我一遍？」
     *
     * 前两版都还是把过程话降级成一行灰字/金字**提示**画在屏幕上 —— 只要画出来，
     * 主人就会觉得「她的话怎么跑进系统提示里了」，而且金块里一句话、下面气泡又一句，
     * 看着就是同一个人回了两遍。
     *
     * 现在：带 _process 的 assistant 消息**一个像素都不画**。
     * 它照旧留在历史里、照旧发给模型（她自己看得见自己刚才说过什么），
     * 只是屏幕上是干净的：只有柜子和她最终那句话。
     */
    if (turn._process === true || turn.process === true) {
      /* 【2026-11-17 晚·主人口径定案】主人原话：「我要的是像你现在这样就好，正常显示」。
       * 不再按字数分档、不再藏、不再降级成灰字条 —— 有正文就一律走正常气泡，
       * 跟她非过程轮的答复一模一样。从根上杜绝「她的话消失」。 */
      if (hasText(text)) {
        out.push({
          kind: 'assistant',
          key,
          who: String(turn.who || '').trim() || mainAgentName(),
          bubbles: [text],
          rewindId: numOrNull(turn.rewindId),
          ts: numOrNull(turn.ts),
          edited: Boolean(turn.edited),
          cont: false,
          usage: turn.usage || null,
          model: String((turn.usage && turn.usage.model) || ''),
          replyChars: String(text || '').length,
          userChars: Number(userChars) || 0,
        });
      }
    } else {
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
      /* 【2026-11-14 主人报「界面显示跑回归运行中」】历史里 ok=null 意思是「这条命令
       * 当时没跑完就被掐了」（重启/中断）。原来直接标成 'run' → 卡片永远显示「运行中…」，
       * 可那一轮早结束了。现在标 'stopped'（中断），由 ToolCard 显示成「中断」。 */
      status: t.ok === null || t.ok === undefined ? 'stopped' : t.ok ? 'ok' : 'err',
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
/**
 * 【2026-11-18 改·live 条目也带时间】
 *
 * 原来流式那几条的 ts 一律是 null —— 界面上就是「历史有完整时间、正在说的那条没有」。
 * 主人要求「每条消息都显示发送时间」，所以把**本轮开工时刻**（live.startedAt）
 * 传进来当它们的时间。
 *
 * 为什么用本轮开工时刻而不是逐条记时：服务端的事件里没有逐条时间戳，
 * 而一轮通常几十秒内写完 —— 精确到分钟的话，整轮是同一分钟，没区别。
 */
function liveToItems(items, running, startedAt) {
  /* 时间只在「有值且合理」时给，否则保持 null（界面上就不画，不占位） */
  const T = (Number(startedAt) > 0) ? Number(startedAt) : null;
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
      /**
       * 【2026-11-15 修·「只有署名的空消息」（主人报·游戏鱼截图）】
       *
       * 主人截图：一段思考链写着「我需要先写压缩记忆」，紧接着就冒出一个
       * **只有「小鱼」署名、正文什么都没有**的气泡。
       *
       * 查明：那是她按程序要求写的**压缩记忆**（正文以 `【压缩记忆·seg-xxx】` 开头，
       * 里面是「## 目标 / ## 决定」这类内部工作单）。这东西是给她自己下一轮读的档案，
       * 不是对主人说的话 —— 可它走的是普通 text 事件，于是被画成一个正常气泡。
       * 而 buildMerged 那侧还会把这类纯内部标记段折掉，结果屏幕上只剩一个空壳 + 署名。
       *
       * 现在：这种正文不进气泡。它该去的地方是会话本子（agent.mjs 的 saveSelfNote 负责），
       * 界面上一个字都不用显示。
       */
      if (/^\s*【压缩记忆[·・]/.test(String(it.t || ''))) continue;
      /**
       * 【2026-11-16 晚·直播这半边也一起不画】
       *
       * 主人原话：「为什么她回我的内容会在金色的提示里？然后又回我一遍？」
       * 过程话（工具循环中间的旁白）以前在直播里被降级成一行金字提示 ——
       * 屏幕上一块金、下面又冒一个气泡，看着像她答了两遍。
       * 现在跟历史那半边一个口径：**不上屏**。它仍在事件流和上下文里，她自己看得见。
       */
      if (it.process === true || it._process === true) {
        /* 【2026-11-17 晚·主人口径定案】与历史半边一致：有正文就正常气泡，不分档、不藏、不灰字。 */
        if (String(it.t || '').trim()) {
          out.push({
            kind: 'assistant',
            key,
            who: speaker,
            bubbles: [String(it.t || '')],
            rewindId: null,
            ts: T,
            edited: false,
            cont: false,
            isLive: true,
          });
        }
        continue;
      }
      out.push({
        kind: 'assistant',
        key,
        who: speaker,
        bubbles: [String(it.t || '')],
        rewindId: null,
        ts: T,
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
        /* 【2026-11-11 加】开跑时刻（tool_start 事件带的 ts）：
         * 跑着的卡上用它算「已耗时秒数」。没有就是 0，卡片不画耗时。 */
        startedAt: Number(it.startedAt) || 0,
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
        spectator: Boolean(it.spectator),
        bubbles: [String(it.t || '')],
        rewindId: null,
        ts: T,
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
      const text = String(it.t || '');
      const atts = Array.isArray(it.atts) ? it.atts.filter((a) => a && a.path) : [];
      const who = String(it.who || '主人');
      if (!hasText(text) && !atts.length) continue;
      out.push({
        kind: who === '主人' ? 'user' : 'mate',
        key,
        text,
        bubbles: hasText(text) ? [text] : [],
        atts,
        who,
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
 * 【2026-11-11 新增·插话按 steerAt 劈段】把「她那段话」劈成两半，把主人的话嵌在中间。
 *
 * ══ 为什么要这一步 ══
 *
 * 主人 2026-11-11 原话：「正常发消息，一轮结束消息全堆在轮末」「插话后她已说出的
 * 回复也消失」。前者是 store.js 那头乐观气泡没收掉（已修），后者的一半就是这个：
 * 直播时插话靠服务端往清单里推 k:'user'（位置＝事件真实顺序）画对了，
 * 可**轮末落盘换历史之后**，历史里那条 user turn 只能按数组顺序排在她那段话后面 ——
 * 屏幕上的话当场从「中间」跳到「末尾」，主人看到的就是「她已说出的回复没了 /
 * 我的话堆到最下面」。
 *
 * ══ steerAt 的口径（跟服务端/老渲染器必须一致）══
 *
 * `steerAt` = 插话那一刻**她当前那一段正文**已经吐出多少字（server.mjs:12662
 * 的 _atChars，前端 index.html:9930 那段算的）。它**不是**整轮累计字数：
 * 一轮里只要调过工具，正文就会被劈成好几段 assistant turn，累计值远大于
 * 「当前这一段」的长度，按累计值去劈会把主人的话插到很早以前那一段里面
 * （index.html:9949「2026-11-05 修·插话跑到很早之前」记的就是这个坑）。
 *
 * 所以这里**只认紧挨着的那一段**（合并后的最后一个气泡），不跨气泡累加：
 *   · 多个气泡（同一句话被工具劈开、在 buildMerged 里合并回来的）→ 只劈最后一个；
 *     前面那几段一个字符都不动，绝不把某个气泡劈成空气泡。
 *   · steerAt 可能大于该段长度（她插话后又说了几个字才停）→ Math.min 夹到段末，
 *     等于「不劈」，一个字不丢、不重复。
 *   · steerAt = 0（她这一段还没吐字）→ 插话排在这一段**前面**。
 *
 * @param {Array} items 已经合并好（同轮同署名的 assistant 并回一个气泡）的历史条目
 * @returns {Array} 新数组（不改入参）
 */
export function applySteerSplits(items) {
  const arr = Array.isArray(items) ? items : [];
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const it = arr[i];
    const nx = arr[i + 1];
    /**
     * 判据三件齐了才劈：
     *   ① 前一条是**历史**里的 assistant（直播那条路服务端已经排好，别插手；
     *      mate / say 是别人说的，steerAt 量的不是他的话）；
     *   ② 后一条是带 steer 的 user；
     *   ③ steerAt 是个**数**（老会话没有这个字段 → 照老样子排末尾，绝不去猜）。
     *
     * ③ 必须写成 typeof === 'number'：`Number(null)` 是 0，用 Number.isFinite(Number(x))
     * 判的话「带 steer 但没有 steerAt」的老插话会被当成 steerAt=0 → 插话跑到那一段
     * **前面**去（本来该排末尾）。null 不是数，别让它混进来。
     */
    if (
      it &&
      it.kind === 'assistant' &&
      !it.isLive &&
      nx &&
      (nx.kind === 'user' || nx.kind === 'mate') &&
      nx.steer &&
      typeof nx.steerAt === 'number' &&
      Number.isFinite(nx.steerAt)
    ) {
      const cut = splitSteerAt(it, nx, nx.steerAt);
      if (cut) {
        for (const x of cut) out.push(x);
        i += 1;              /* 插话那条已经嵌进去了，别再画第二遍 */
        continue;
      }
    }
    out.push(it);
  }
  return out;
}

/**
 * 把 prev 那段正文在 at 处劈开 → [前半 assistant, 插话 user, 后半 assistant]。
 *
 * 返回 null = 不用劈（at 落在段末 / 这段没有正文），调用方照原顺序画。
 */
function splitSteerAt(prev, steerItem, at) {
  const bs = Array.isArray(prev.bubbles) ? prev.bubbles.map((b) => String(b == null ? '' : b)) : [];
  const lastIdx = bs.length - 1;
  if (lastIdx < 0) return null;
  const last = bs[lastIdx];
  if (!last) return null;                       /* 这一段本来就是空的：没得劈 */
  const cut = Math.max(0, Math.min(last.length, Math.floor(Number(at) || 0)));
  /* ① 落在段末：本来就是这个位置，什么都不用做（这是最常见的一拍：
   *    她这一整段已经说完，插话本来就该排在这一段之后） */
  if (cut >= last.length) return null;
  /* ② 0 字：她这一段还没开始说 → 插话排在这一段**前面** */
  if (cut === 0 && lastIdx === 0) return [steerItem, prev];
  /* ③ 中间：前半 / 插话 / 后半 */
  const frontItem = Object.assign({}, prev, {
    /* 前半保住原 key / rewindId / 用量行 —— 「这一轮」的按钮和用量都挂在它上面，
     * 挪到后半就等于把编辑、回退、分支全挂到了一段"残句"上。 */
    bubbles: cut === 0 ? bs.slice(0, lastIdx) : bs.slice(0, lastIdx).concat([last.slice(0, cut)]),
  });
  const backItem = {
    kind: 'assistant',
    /* key 必须稳定且不撞：前半是 t-<绝对下标>，后半挂 -sb 后缀。
     * 用绝对下标而不是序号，往前补历史/新来内容都不会让它平移。 */
    key: String(prev.key || '') + '-sb',
    who: prev.who,
    bubbles: [last.slice(cut)],
      /* 编辑/回退/分支/删除四颗按钮只给前半（同一个 turn 不许长出两套按钮） */
      rewindId: null,
      /* 【2026-11-18 改】原来这里是 null —— 插话劈出来的后半截不显示时间，
       * 屏幕上就成了「同一条回复，前半有时间、后半没有」。它本来就是同一条，
       * 时间跟着前半走。 */
      ts: (prev && prev.ts) || null,
    edited: false,
    cont: false,
    usage: null,
    model: '',
    replyChars: last.slice(cut).length,
    userChars: 0,
    isLive: false,
  };
  return [frontItem, steerItem, backItem];
}

/**
 * 主入口：快照 → 清单。
 * 顺序永远是：历史 → （还没落盘的主人那句）→ 直播。落盘之后乐观那条自动消失，
 * 位置不跳 —— 因为它本来就在同一个地方。
 */

/* 【2026-11-15 主人定】同一文件重复发送 → 界面上只留最新一张卡：
 * 从后往前扫，先见到的（=最新的）留下，前面同 fkey 的旧卡直接剔除。
 * 落盘侧（server.mjs 轮末合并）已同步清旧，这里是渲染侧兜底 ——
 * 历史卡是哪个轮落盘的都无所谓，屏幕上永远只剩最后一张。 */
function dedupeFileCards(items) {
  const seen = new Set();
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it || it.kind !== 'file') continue;
    const fk = String(it.fkey || it.path || '');
    if (!fk) continue;
    if (seen.has(fk)) { items.splice(i, 1); continue; }
    seen.add(fk);
  }
  return items;
}
export function buildMerged(snap) {
  const running = isRunning(snap);
  /* 刚发的那条还在 pending（服务端历史里还没它）—— 见 trimTurnsForLive 的注释。 */
  const _hasPending = Array.isArray(snap.pendingUser) && snap.pendingUser.length > 0;
  /**
   * pending **已经落进历史并被答完**了吗？
   *
   * 判据：历史里最后一条 assistant 的下标 > 最后一条 user 的下标。
   * 说明服务端已经针对最后那条 user 答过了 —— 那份回答历史里有、live 里也有，
   * 这时候必须照原规则裁（让 live 接管），否则同一句话会被画两遍：
   * 历史那份走 MateBubble（署名白）、live 那份走 assistant（署名蓝）=「两个小鲸」，
   * 然后 pending 一清、历史重画，两条一起消失又重出一条。主人报的就是这个。
   */
  const _pendingLanded = (() => {
    try {
      const t = Array.isArray(snap.turns) ? snap.turns : [];
      /**
       * 【2026-11-11 修·判据错了：把「上一轮已答完」当成了「这条 pending 已答完」】
       *
       * 旧判据只看「历史最后一条 assistant 的下标 > 最后一条 user 的下标」。
       * 可 pending 是**乐观插入**的 —— 服务端历史里根本没有它，那条「最后一条 user」
       * 是**上一轮**的主人的话。于是这个判据在任何「已经结束过一轮」的会话里恒为真，
       * `trimTurnsForLive` 每次都把上一轮的回复当成「与 live 重复」剪掉：
       *   历史 [U1, A1] + pending(U2) → 裁成 [U1] → 屏幕上只剩「消息1 / 消息2」。
       *
       * 真机实测（隔离实例 + headless Edge + CDP 60ms 连拍，发第二句后 +3506ms）：
       *   turns=3 running=true 屏幕 = [开场白, U1, U2]  ← A1「我是第一轮」被剪。
       * 而 A1 此刻只能从 live 来，`items.concat(pend, live)` 又把 live 排在 pend 之后，
       * 于是屏幕上就是「消息1 / 消息2 / 回复1」—— 主人报的错序就是这一帧。
       *
       * 正确判据是「**这条 pending 自己**落盘了、并且被答了」，三条缺一不可：
       *   ① 末尾有一条 assistant 排在最后一条 user 之后（被答了）；
       *   ② 那条 user 的正文与某条 pending 对得上（落盘了，是本轮这句）；
       *   ③ 对不上就说明那条 user 是上一轮的话，跟本轮 pending 无关 → 不许裁。
       */
      const _pendingNorm = (x) => {
        try { return String(x == null ? '' : x).replace(/\s+/g, ''); } catch (e) { return ''; }
      };
      /* 【写法说明】两个变量分开声明 —— scripts/check-ui.mjs 的「未定义变量」扫描
       * 认不出 `let a = -1, b = -1` 这种一行多声明，会把 b 误判成未定义。
       * 为了不给自己添一道假红线，这里写成两行。 */
      let lastU = -1;
      let lastA = -1;
      for (let i = t.length - 1; i >= 0; i--) {
        const r = t[i] && t[i].role;
        if (lastU < 0 && r === 'user') lastU = i;
        if (lastA < 0 && r === 'assistant') lastA = i;
        if (lastU >= 0 && lastA >= 0) break;
      }
      /* ① 我得被答过，才谈得上「已答完」 */
      if (lastU < 0 || lastA <= lastU) return false;
      /* ② 末尾那条 user 得是本轮这句（跟某条 pending 对得上） */
      const _uTxt = _pendingNorm(t[lastU] && t[lastU].text);
      if (!_uTxt) return false;
      const _pendList = Array.isArray(snap.pendingUser) ? snap.pendingUser : [];
      return _pendList.some((p) => {
        const _pn = _pendingNorm(p && p.text);
        return Boolean(_pn) && (_pn === _uTxt || _uTxt.endsWith(_pn) || _pn.endsWith(_uTxt));
      });
    } catch { return false; }
  })();
  /**
   * 【2026-11-18 加·这一轮在历史里从第几条开始】
   *
   * 直播清单带着服务端发的 `turnId`，历史每个 turn 带着 `turn: <同一个 id>`。
   * 扫一遍找出「本轮第一条已落盘消息」的下标，交给 trimTurnsForLive 精确裁剪。
   *
   * 找不到就是 -1（这一轮还没落盘 / 老数据没有这个字段）→ 走原来的兜底判据。
   * 这就是为什么这次改动**不会让老会话变差**：没信息时行为完全不变。
   */
  const _liveTurnId = (snap.live && typeof snap.live.turnId === 'string') ? snap.live.turnId : '';
  const _liveTurnIndex = (() => {
    if (!_liveTurnId) return -1;
    const t = Array.isArray(snap.turns) ? snap.turns : [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] && t[i].turn === _liveTurnId) return i;
    }
    return -1;
  })();
  const liveItems = Array.isArray(snap.live?.items) ? snap.live.items : [];
  const awaitingHistory = snap.live?.running === false && snap.live.awaitingHistory === true;
  const showLive = running || awaitingHistory;
  // 等直播确实有内容可画，再让它接管历史中属于这一轮的消息。
  const all = showLive && liveItems.length
    ? trimTurnsForLive(snap.turns, { hasPending: _hasPending, pendingLanded: _pendingLanded, startedAt: Number(snap.live?.startedAt) || 0, liveTurnIndex: _liveTurnIndex })
    : snap.turns;
  const sid = snap.sid;

  /* 窗口：只画最近 WINDOW 轮（长会话一次性建上万个节点会把主线程顶住） */
  let start = Number(getWindowStart(sid)) || 0;
  /* 【2026-11-11 修·虚拟化恒不生效】原条件 `start >= 0 && all.length - start >= WINDOW`
     在用户没往前翻过（start=0）且会话够长时恒为真 → start 保持 0 → 整个会话全画，
     300 轮切过去卡 6.8 秒。窗口的语义是「用户手动往前翻过就尊重他的位置，
     否则只留最近 WINDOW 轮」—— 判据应该是 start > 0。 */
  /* 【2026-11-12 改·把「翻到最顶」和「从没翻过」分开】
   * 判据从「start 大于 0」换成「这个会话他手动翻过没有」：
   *   从没翻过 → 只画最近 WINDOW 轮（虚拟化照旧，300 轮不会卡）；
   *   翻过（哪怕翻到 0）→ 老老实实尊重他的位置，一路看到最顶也不跳回最新。 */
  if (!isWindowTouched(sid)) start = Math.max(0, all.length - WINDOW);
  start = Math.max(0, Math.min(start, all.length));
  /* 【2026-11-13 修·检查鱼历史消失第二因】WINDOW 数的是 turn，可长任务一轮
   * 能跑上百次工具调用（检查鱼 475 条消息 / 228 turns，一轮就占掉大半）。
   * 最近 40 个 turn 全被当前这一轮吃掉 → 屏上只剩八个气泡，主人看着就是
   * 「以前的历史全没了」。现在往前扩到「至少盖住最近 3 条主人消息」，
   * 硬上限 120 turn 防卡（虚拟化注释里 300 轮会卡好几秒）。
   * 主人手动翻过的位置（isWindowTouched）一律尊重，这里不碰。 */
  if (!isWindowTouched(sid)) {
    /* ══════════════════════════════════════════════════════════════
       【2026-11-14 主人钦点·窗口按「柜子数」算，不按 turn 数】
       工具现在都收在柜子里：一轮长活十几个工具调用，在 turns 里是十几个
       assistant，可界面上只是**一个柜子**。按 turn 数算窗口会把一个柜子
       当成十几轮，长任务一下子就把历史挤光。
       从末尾往前扫，把「一段连续 assistant」算一个柜子，保留最近 3 个柜子
       （外加它们之间的主人消息）；80 turn 兜底防卡。
       【2026-11-14 夜·主人报「重启后密密麻麻历史消息堆屏」】原来是 8 柜/160 turn，
       长任务一个柜子几十张工具卡，重启后整屏全是旧卡。收窄到 3 柜/80 turn：
       既保住「不让一轮长活把历史挤光」（11-13 那次的坑），又不会一屏糊满。
       主人手动翻过的位置（isWindowTouched）照旧一律尊重。
       ══════════════════════════════════════════════════════════════ */
    let _hubs = 0;
    let _i = all.length - 1;
    for (; _i >= 0; _i--) {
      const _cur = all[_i];
      const _next = all[_i + 1];
      // 倒着扫：当前是 assistant、而更靠后的那条不是 → 这是一段连续 assistant 的开头（一个柜子）
      if (_cur && _cur.role === 'assistant' && (!_next || _next.role !== 'assistant')) _hubs += 1;
      /* 【2026-11-15 修·off-by-one】倒扫到第 4 个柜子才 break，此时 _i 正指着
       * 第 4 柜的开头，直接拿它当 start 会多画一整柜（注释说 3 柜、实际 4 柜）。
       * 往回挪一条，让 start 落在第 3 柜前面那条（通常是它的提问）。 */
      if (_hubs > 3) { _i += 1; break; }
      if (all.length - _i >= 80) break;
    }
    /* 【2026-11-15 修·3柜口径被 WINDOW 粗算压掉】原来这里是
       start = Math.max(0, Math.min(start, _i)) —— 可上面第 684 行已经把 start
       压成 all.length - WINDOW（40 turn），min 取更早的一条 → 柜子算出的
       起点永远被压回去，3 柜口径等于没生效（12 柜的会话照样画 10 条主人
       消息，主人报的「重启后密密麻麻」就是这个）。现在柜子算出的起点直接
       说了算，再叠两道：① 至少盖住最近 3 条主人消息（长活占满 3 柜、
      柜子里没有主人消息时靠它托底）；② 硬上限 120 turn 防卡。 */
    const _hubStart = _i < 0 ? 0 : _i;
    let _uSeen = 0;
    let _uStart = all.length;
    for (let _j = all.length - 1; _j >= 0; _j--) {
      const _t = all[_j];
      if (_t && _t.role === 'user') {
        _uSeen += 1;
        if (_uSeen >= 3) { _uStart = _j; break; }
      }
    }
    start = Math.max(0, Math.min(_hubStart, _uStart));
    if (all.length - start > 120) start = all.length - 120;
  }

  const items = [];
  let lastUserChars = 0;
  /* 用量行是「一轮一行」，挂在那一轮她说的话下面 —— 所以只给每轮第一段打标 */
  let wantUsageRow = false;
  /**
   * 【2026-11-18 主人报「她说话断断续续，像被工具调用截断」】
   *
   * 现场：同一轮（同一个 turnId）里，服务端把正文按「说一句 → 跑工具 → 再说一句」
   * 落成了好几条 assistant 消息（搭建鱼会话一条轮次里有 3 段正文、中间夹 4 张工具卡）。
   * 老合并判据只看「紧挨着的上一条是不是 assistant」—— 中间夹了 tool item 就合不了，
   * 于是她一句话被画成三个各自带署名的气泡，读起来一顿一顿。
   *
   * 新判据：拿**轮次号**认亲。同一个 turnId + 同一个人 + 都非直播 → 后面的正文
   * 一律并进这一段的第一条气泡（工具卡留在原位，它们本来就该显示）。
   * lastAsst 记「本轮最近那条 assistant item」，跳过中间的工具/文件卡也能找到。
   * 没有 turnId 的老消息退回原判据（紧挨着的两条仍合并），行为不变。
   */
  let lastAsst = null;
  let lastAsstTurn = '';
  for (let i = start; i < all.length; i++) {
    const turn = all[i];
    const part = turnToItems(turn, i, lastUserChars);
    if (turn && turn.role === 'user') {
      lastUserChars = String(turn.text || '').length;
      wantUsageRow = true;
      lastAsst = null;
      lastAsstTurn = '';
    }
    const turnId = (turn && typeof turn.turn === 'string' && turn.turn) || '';
    for (const it of part) {
      /* 同一个人说的话（可能隔着工具卡）并回一个气泡 */
      const prev = items.length ? items[items.length - 1] : null;
      let target = null;
      if (it.kind === 'assistant' && !it.isLive) {
        if (turnId && lastAsstTurn === turnId && lastAsst && lastAsst.who === it.who) {
          target = lastAsst;                       // 同一轮、隔着工具也能认回来
        } else if ((!turnId || !lastAsstTurn) && prev && prev.kind === 'assistant' && prev.who === it.who && !prev.isLive) {
          target = prev;                           // 老数据没轮次号：仍只合并紧挨着的
        }
      }
      if (target) {
        target.bubbles = (target.bubbles || []).concat(it.bubbles || []);
        if (it.rewindId != null) target.rewindId = target.rewindId == null ? it.rewindId : target.rewindId;
        if (it.usageRow) target.usageRow = true;
        if (it.usage && !target.usage) target.usage = it.usage;
        continue;                                  // 这一条不单独建气泡了
      }
      if (it.kind === 'assistant' && wantUsageRow) {
        /* 【2026-11-12 修·主人问「为什么露了署名但没说话」】
         * 一轮只跑了工具、一个字没说就断了（上游 503 掐的）——历史里那条
         * assistant 没有正文，只有用量行挂着：屏幕上一行「进入 · 计时 · tokens」
         * 孤零零悬着，看着像她签了到却不吭声。规矩：**没说话就没有署名行**。
         * 用量数字跟着下一句有话的话再挂（wantUsageRow 不清，顺延过去）。 */
        const _hasTalk = Array.isArray(it.bubbles) && it.bubbles.some((b) => String(b || '').trim());
        if (_hasTalk) {
          it.usageRow = true;
          wantUsageRow = false;
        }
      }
      items.push(it);
      if (it.kind === 'assistant' && !it.isLive) {
        lastAsst = it;
        lastAsstTurn = turnId;
      }
    }
  }

  /* 【2026-11-13 严检·主人问「一轮结束后会不会把我曾说过的消息重渲染一遍」—— 会，漏点在这】
   * pend（乐观气泡）原来**无条件拼接**（live 有 running 闸，pend 没有）：
   * 收尾那一拍 running:false 快照进来 → 历史全量接管（主人消息已在历史里）→
   * 而 pendingUser 的清理是异步的（dropLandedPending 只在 !st.live 时跑，
   * 收尾时 live 对象还挂着 running:false）→ 主人那条消息「历史一份 + 乐观气泡一份」
   * 画两遍，等清理触发才恢复。修：两种形态都不再拼 pend——
   *   ① running=false：历史全量已含所有落盘消息，pend 里没有「还没落盘」的；
   *   ② _pendingLanded=true（pending 已落盘且被答完）：历史里主人消息保留着
   *      （trimTurnsForLive 只裁它后面的 assistant），再拼 pend 又是双份。 */
  /* 【2026-11-13 二改·主人报「发消息时屏幕上不立即显示，要等回话才出现」】
   * 上一版拿 !running 当「历史已全量接管」的判据，可 isRunning() 要求 live
   * 对象存在且 running!==false —— 而按下发送那一刻 live 还没建立（null），
   * 于是 !running=true，乐观气泡被整批挡掉：主人那句话要等服务端回话、
   * 历史里有了才冒出来。主人感知的就是「必须等回话才显示」。
   *
   * 正确的「不画」只有两种：
   *   ① 明确收尾那一拍（live.running === false，历史已全量含这条）；
   *   ② 这条 pending 已落盘且被答完（_pendingLanded）。
   * 其余（live=null 刚发出 / live.running=true 正在跑）一律照常画乐观气泡。
   * live 真被置 null 之后，store 的 dropLandedPending 已把账收干净，
   * pendingUser 自然为空，不会把「收尾后」误判成「刚发出」。 */
  const _liveEnded = snap.live?.running === false && !awaitingHistory;
  const pend = (_liveEnded || _pendingLanded) ? [] : (snap.pendingUser || []).map((p) => ({
    kind: p.who && p.who !== '主人' ? 'mate' : 'user',
    key: p.id.indexOf('p') === 0 ? 'p-' + p.id.slice(1) : 'p-' + p.id,
    text: p.text,
    /* 【2026-11-13 同修】乐观气泡那条 mate 也缺 bubbles——切身份当场发的那句
     * 同样只剩名字没正文。 */
    bubbles: hasText(p.text) ? [String(p.text || '')] : [],
    atts: p.atts,
    who: p.who,
    tag: p.tag,
    rewindId: p.rewindId,
    ts: Date.now(),
    edited: false,
    isLive: true,
  }));

  const live = showLive ? liveToItems(liveItems, running, Number(snap.live?.startedAt) || 0) : [];
  if (awaitingHistory) {
    for (const item of live) {
      if (item.kind === 'assistant') item.isLive = false;
    }
  }
  const noteItems = (snap.notes || []).map((n) => ({ kind: 'note', key: n.id, text: n.text, actions: n.actions || null }));

  return {
    running,
    start,
    totalTurns: all.length,
    /* 【2026-11-11】历史这一份先过一道「插话劈段」：带 steerAt 的插话要把她那段话
     * 劈成两半、自己嵌在中间（见 applySteerSplits）。只对历史做 —— pend 是新发的
     * 那句（没有 steerAt），live 那边服务端已经按事件顺序排好了。 */
    items: dedupeFileCards(applySteerSplits(items).concat(pend, live, noteItems)),
  };
}
