/**
 * self-compress.mjs —— 压缩记忆这件事，改成「我自己挑」（2026-10-30）
 *
 * 【为什么要这个文件】主人原话：
 *   「压缩是你自己压缩的吗？如果是，你应该会自己挑那些重要的内容，不重要的直接删，
 *    已完成的任务保留清单就够了，具体做了什么可以简洁成一句话甚至直接删。
 *    为什么会频频出现问题」
 *
 * 他说得对。以前压缩是这么干的：真对话被折成一段，交给一个便宜的摘要模型，
 * 按「主人要什么 / 已经做完 / 还没做完 / 关键约束」四个死标签写五条 ——
 * 挑重点这件事，实际上外包给了一台根本不在场的机器。
 * 它不知道哪条是真要紧、哪条是流水账，只能机械地摘，
 * 于是一份档案写满「run_command(cd "D:\小鱼Agent"; node ...)」这种流水，
 * 真正的目标、卡在哪一步、主人骂过什么，全被埋在里头或者直接漏掉。
 *
 * 现在改成：**压缩那一下，我自己写这一轮的记忆。**
 * 我本来就知道自己在干嘛 —— 目标、清单打到第几步、卡在哪儿、主人原话是什么。
 * 摘要模型退到兜底（我这一轮没回来才用它）。
 */

import { memoryText } from './my-memory.mjs';
import { readMemory as readSessionMemory, appendDigest as appendSessionDigest, memoryMtime } from './session-memory.mjs';

/** 压缩记忆开头的记号，收的时候靠它认出「这是压缩写的」并取出存档编号。 */
export const SELF_NOTE_TAG = '【压缩记忆';

/** 一段压缩记忆最多这么长。
 *
 * 【2026-11-16 主人钦点·从 1200 提到 3000】
 *
 * 原话：「查压缩记忆是否存在问题」「你决定」。
 *
 * 查下来的问题就在这个数上：提示词写 1200、程序硬上限也是 1200，
 * 而实际会话压缩比能到 553 条 → 1200 字（搭建鱼那段）。等于一小时的工作
 * 只剩一张便签，细节全灭。提示词那边同时改成「六块固定结构」，
 * 让这 3000 字落在该落的地方：目标 / 清单 / 已定 / 路径命令 / 坑 / 断点。
 *
 * 代价：每段摘要多约 1.5k~2k token。跟「重启后忘光、重做一遍」比，
 * 这点钱可以忽略。 */
export const SELF_NOTE_MAX = 3000;

/**
 * 【2026-11-15 加·压缩记忆别再画成"她说的空消息"（源头这一刀）】
 *
 * 主人报：「她思考链说要写压缩记忆，然后下一个回复就是空消息，只有署名。」
 *
 * 【病根】压缩记忆（`【压缩记忆·seg-xxx】…`）是**写给程序看的内部工作单**，
 * 走的是她自己的正文通道。程序这边确实收了（saveSelfNote），但同一段文字
 * 也照常被当成"她对主人说的话"：一边推给界面画气泡，一边落进历史。
 * 前端后来加了个渲染过滤（items.js），可那只是**关掉了灯**——盘上、推流里、
 * 上下文里都还在。真正要收的是源头：**这段文字根本不该进对话正文**。
 *
 * 【怎么收】在 agent 收流的时候就分叉：
 *   · 看见记号 `【压缩记忆` → 之后的内容一律归"记忆"，不进 text、不推流、不落历史；
 *   · 剩下的（前面的正文）照常走。
 * 这样界面从头到尾都看不到它，历史里也不会留下一条只有署名、没有字的空消息。
 *
 * 为什么要在**流式**阶段分叉：气泡是逐字吐出来的，等最后再剪，
 * 屏幕上已经先闪出一段"她的话"了。所以这里按块缓冲，攒到能判断开头为止。
 */
export function splitSelfNote(raw) {
  const s = String(raw ?? '');
  const i = s.indexOf(SELF_NOTE_TAG);
  if (i < 0) return { chat: s, note: '' };
  return { chat: s.slice(0, i).replace(/\s+$/, ''), note: s.slice(i) };
}

/**
 * 流式闸门：把"压缩记忆"从正文里剪掉，只让正常说话流到界面。
 *
 * 用法：
 *   const gate = makeSelfNoteGate();
 *   每收到一段 → for (const seg of gate.push(chunk)) 发出去;
 *   每轮开头 → gate.reset()（正文归零，已收到的记忆**不清**）;
 *   收尾     → gate.finish() 把还压着的一小段吐出来;
 *   记忆正文 → gate.note
 */
export function makeSelfNoteGate() {
  const TAG = SELF_NOTE_TAG;
  let pending = '';        // 还没放行的尾巴（可能是记号的前半截，得等下一块才能定）
  let mute = false;        // 已经进了记忆，后面全吞
  let note = '';           // 攒下来的压缩记忆
  return {
    push(chunk) {
      const out = [];
      const s = String(chunk ?? '');
      if (!s) return out;
      if (mute) { note += s; return out; }
      pending += s;
      const i = pending.indexOf(TAG);
      if (i >= 0) {
        if (i > 0) out.push(pending.slice(0, i));
        note += pending.slice(i);
        pending = '';
        mute = true;
        return out;
      }
      /* 没有完整记号 —— 但结尾这几个字可能是记号的前半截（流式是一块一块来的，
       * "【压" / "缩记" 这种半截必须先扣着，不然先把半截放出去就再也收不回了）。 */
      let hold = 0;
      const maxK = Math.min(TAG.length - 1, pending.length);
      for (let k = maxK; k > 0; k--) {
        if (TAG.startsWith(pending.slice(-k))) { hold = k; break; }
      }
      const cut = pending.length - hold;
      if (cut > 0) out.push(pending.slice(0, cut));
      pending = pending.slice(cut);
      return out;
    },
    /** 每轮开头清"本条回复"的状态；记忆正文不清（那是要落到本子里的） */
    reset() { pending = ''; mute = false; },
    /** 收尾：还扣着的尾巴（不够组成记号）该放出去了 */
    finish() { const s = pending; pending = ''; return s ? [s] : []; },
    get note() { return note; },
    get muted() { return mute; },
  };
}

/**
 * 收她写回来的压缩记忆。
 *
 * 规矩：宁可这一次不收（退回让摘要模型兜底），也不许收一句空话 ——
 * 收错了就是把自己压失忆，比不压还糟。
 *
 * @param {string} raw 她这一轮的正文
 * @returns {{ok:boolean, text?:string, reason?:string}}
 */
export function acceptSelfNote(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { ok: false, reason: '空' };
  const at = s.indexOf(SELF_NOTE_TAG);
  if (at < 0) return { ok: false, reason: '没有编号（对不回是哪一段）' };
  const body = s.slice(at).trim();
  if (body.length < 40) return { ok: false, reason: '太短' };
  if (ADVISOR_LINE.test(body)) return { ok: false, reason: '顾问腔' };
  // 全是工具流水/横杠，也算没写
  const solid = body.replace(/[\s\-*#>|`~·【】]/g, '');
  if (solid.length < 30) return { ok: false, reason: '没有实字' };
  return { ok: true, text: body.slice(0, SELF_NOTE_MAX) };
}

/**
 * 从记忆本里取出最近一条压缩记忆（合并时用）。
 *
 * 【2026-11-04 修死循环 · 最重要的那条】
 *
 * 这里原来读的是 `memoryText()` —— 那是**我自己**的长期记忆本（my-memory.md），
 * 可压缩记忆是写进**这个会话自己的本子**（.state/memory/<sid>.md）的。
 * 两边永远对不上，于是 lastSelfNote 一直返回空串：
 *   · agent.mjs 每小时都以为「这一轮我还没写过压缩记忆」，把【该你自己压了】
 *     一遍遍地塞进同一轮对话；
 *   · 主人看到的正是「压完又超线又压」的死循环，
 *     而记录里「尾巴最近 5 条」「最旧的 89 条」反复变 —— 因为每一轮都在重新探线。
 *
 * 现在改读会话本子。读不到就老实返回空串（也就照老路提醒）。
 *
 * @param {string} sessionId 会话 id —— 没有它就没法定位本子，直接返回空
 */
export function lastSelfNote(sessionId, wantSegId) {
  const sid = String(sessionId || '').trim();
  if (!sid) return '';
  try {
    const t = readSessionMemory(sid) || '';
    /**
     * 【2026-11-05 加】按段号取。
     *
     * 不传 wantSegId 就照旧取最近一条（兼容老调用）；
     * 传了就只认「给这一段写的那份」—— 段号对不上就当没写过，
     * 让调用方重新递工作单，而不是拿上一段的摘要去换这一段原文。
     */
    const want = String(wantSegId || '').trim();
    if (want) {
      const at = t.lastIndexOf(want);
      if (at >= 0) {
        const tagAt = t.lastIndexOf(SELF_NOTE_TAG, at);
        if (tagAt >= 0) return t.slice(tagAt, Math.min(t.length, tagAt + SELF_NOTE_MAX));
      }
      /**
       * 【2026-11-16 修·段号对不上就别把话卡死】
       *
       * 现场：修理鱼 12:31~12:43 把同一个本子 write_file 写了 6 遍，
       * 段号一直写的是上一段的 seg-2-57a7ea6f58，而工作单要的是 seg-2-b9d0bbda25。
       * 对不上 → 这里返回空 → 上层认为「她还没写」→ 再递工作单 → 她再写一遍。
       * 从外面看就是「一直在写压缩记忆、一直在重复思考」。
       *
       * 判据退一步：本子是**刚被写过**的（一小时内），且最后一条确实是带编号的
       * 压缩记忆，就认它是这一段的。段号对不上只记一笔，不再当成「没写」。
       * 为什么敢这么松：一小时内写进本子的东西，不可能是「上一段的旧摘要」——
       * 那正是不认它的唯一理由。
       */
      const age = Date.now() - memoryMtime(sid);
      if (!(age >= 0 && age <= 60 * 60 * 1000)) return '';
      const i = t.lastIndexOf(SELF_NOTE_TAG);
      if (i < 0) return '';
      try {
        console.warn('[self-note] 段号对不上（要 ' + want + '，本子是另一次写的，' + Math.round(age / 60000) + ' 分钟前）→ 按「刚写过」认下来');
      } catch { /* 日志失败不影响 */ }
      return t.slice(i, Math.min(t.length, i + SELF_NOTE_MAX));
    }
    const i = t.lastIndexOf(SELF_NOTE_TAG);
    if (i < 0) return '';
    return t.slice(i, Math.min(t.length, i + SELF_NOTE_MAX));
  } catch {
    return '';
  }
}

/**
 * 把我这一轮写的压缩记忆落到这个会话的记忆本里（滚动摘要区）。
 *
 * 【为什么需要它】原来只导出 acceptSelfNote（只做校验、不写盘），
 * 而全项目**一处都没有调用它** —— 也就是说：我写了压缩记忆，程序压根没接，
 * 下一轮 lastSelfNote 还是空，提醒照旧发。写和读这两头都断了。
 *
 * 落盘走 appendSessionDigest：它自带编号（R0001…）、自带查重、满 80 条自动归档，
 * 而且「## 滚动摘要」本来就是给人回看的那一段，位置正好。
 *
 * @returns {{ok:boolean, text?:string, reason?:string, added?:boolean, skipped?:string}}
 */
export function saveSelfNote(sessionId, raw) {
  const got = acceptSelfNote(raw);
  if (!got.ok) return got;
  const sid = String(sessionId || '').trim();
  if (!sid) return { ok: false, reason: '没有会话 id，不知道该写进哪个本子' };
  try {
    // 摘要是给人看的一段话，压成一行：标题 + 提纲，别把整块 markdown 塞进一条摘要。
    const oneLine = String(got.text)
      .replace(/\r\n?/g, '\n')
      .replace(/\n+/g, ' ⏎ ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 400);
    const r = appendSessionDigest(sid, oneLine);
    return { ok: true, text: got.text, added: r && r.added !== false, skipped: r && r.skipped };
  } catch (e) {
    return { ok: false, reason: '写不进本子：' + (e && e.message ? e.message : e) };
  }
}

/**
 * 真要给她看的那一段「该你压了」。
 *
 * 为什么不复用 buildSelfCompressInstruction：那条是塞进模型对话里的指令，
 * 这条是要**给她自己看**、提醒她这一轮必须先动手把记忆写出来的。
 */
export function renderSelfCompressBlock(on = true) {
  if (!on) return '';
  return [
    '【上下文太长的时候，是**你自己挑**重点，不是别人代挑】',
    '真压起来的时候，程序会给你一份旧对话的原文存档编号，让你亲手写一段压缩记忆。规矩：',
    '1. 这段活还在干什么（目标），一定要留 —— 这是后面接得上的唯一理由。',
    '2. 清单打到第几步、哪几步做完打勾了，留清单就行；具体每一步做了什么，缩成一句话，能删就删。',
    '3. 卡在哪儿、什么没成、什么被证明不通 —— 比做过什么重要得多，必须留。',
    '4. 主人原话里的硬要求（不许干的事、他定的规矩、他说过的数）照原样抄，别改写。',
    '5. 其余一律删。工具调用流水、「我先看看」「已经改完」这类过程废话，一个字都不要。',
    '6. 每段开头写「【压缩记忆·存档编号】」。正文最多 3000 字，按下面六块写，缺一块就算没写完：',
    '   · ## 目标 —— 这段活在干什么、怎么算做完（后面能接上全靠它）',
    '   · ## 清单 —— 打到第几步、哪几步打勾了；没做的**照抄原文**，别转述',
    '   · ## 已定的决定 —— 走过的路、为什么这么走；改过/否掉的方案也写一句为什么否',
    '   · ## 关键路径·命令·参数 —— 文件在哪、命令原文、端口、会话 id、账号名；**照抄，不许改写**',
    '   · ## 坑 —— 什么试过不通、哪条报错说明什么、什么东西一碰就再坏一次（这条比做过什么值钱）',
    '   · ## 现在断在哪 —— 最后一句话是什么、下一步第一件事做什么',
    '   别人问你要不要继续、你也不许反问我。',
    '7. 【写完之后立刻接着干原来那件事，中间不许停】压完不是收工。',
    '   绝对不许说「压缩好了」「记忆写好了」「先停在这」「这一轮到此为止」这类话，',
    '   也不许拿压缩当交差理由、把剩下的活留到下一轮。',
    '   界面自己会显示一条【压缩中】的工具条，主人看得见；你要做的就是压完马上回到刚才那件事上继续做。',
    '8. 【压缩记忆是写给**你自己**看的，不是对话内容】',
    '   · 不许在给主人的回复里复述它、贴它、摘要它、引用它 —— 主人一个字都不需要看见。',
    '   · 不许说「我记下了这些」「保留的重点是……」这种把内容摊开的话。',
    '   · 主人问「你刚才压了什么」，也只答「记住了」或者一句概括，不要把记忆正文倒出来。',
    '   · 压缩这件事本身对主人是**透明的**：他只会看到界面上一条【压缩中】，别的什么都不该出现。',
  ].join('\n');
}

export function selfCompressHint(o = {}) {
  const segId = String(o.segId ?? '未编号');
  const tokens = Number(o.tokens) || 0;
  const window = Number(o.window) || 0;
  const kept = Number(o.kept ?? 0);
  const removed = Number(o.removed ?? 0);
  const pct = window > 0 ? ((tokens / window) * 100).toFixed(1) + '%' : '?';
  const parts = [
    '【该你自己压了】',
    `这一轮历史 ${tokens} token（占窗口 ${pct}），程序已经把最旧的 ${removed} 条原文折好存盘，编号 ${segId}（要翻原话随时能翻），还没真删。`,
    `现在先动手把这一段亲手写成压缩记忆再接着干：写完程序会把那 ${removed} 条折起来、只留你写的这段（最多 ${SELF_NOTE_MAX} 字）。`,
  ];
  if (o.planText && String(o.planText).trim()) {
    parts.push('', '【清单（已做完的打勾就好，别复述过程）】', String(o.planText).trim().slice(0, 1500));
  }
  if (kept) parts.push('', `（尾巴最近 ${kept} 条原文不动，别把它们也写进来）`);
  parts.push(
    '',
    '规矩：目标一句；清单做完的打勾、没做完的写卡在哪；主人原话硬要求照抄；工具流水一个字不要。',
    `开头写「${SELF_NOTE_TAG}·${segId}】」。不许反问我，不许说「要我继续吗」。`,
    '',
    '【写完马上回去干活】压完不算交差：写完这段记忆就**立刻接着做压缩之前那件事**，',
    '一个字都别提「压缩好了」、别提「记忆写好了」、别说「先停在这」「这一轮到此为止」。',
    '界面会自己显示一条【压缩中】的工具条，主人看得见进度，你只管接着干。',
  );
  return parts.join('\n');
}
