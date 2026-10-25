// Minimal web server: static UI + one SSE endpoint that runs the agent.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { join, isAbsolute as isAbsolutePath } from 'node:path';
import { config } from './config.mjs';
// 她「主动开口」要用到自己的状态（欲望攒够没有）
import { selfInfo } from './whale-self.mjs';
// 小鲸在场的开关。必须在顶层导入：以前写在接口分支里用 await import，
// 出了分支 whaleOn 就没了，而每轮收尾那句 if (whaleOn()) 还在 —— 每轮都崩。
import { whaleOn, setWhaleOn } from './whale-presence.mjs';
// 顶栏那个「小鱼」按钮：默认在场，禁用后这个会话后面的话她一个字都不发。
import { fishOn, setFishOn } from './fish-presence.mjs';
import { runAgent, systemPrompt, repairHistory } from './agent.mjs';
// 启动自检用：查每个工具是不是都有中文 description / 参数说明。
import { checkToolDocs, setPeerWake } from './tools.mjs';
import { browse, readImageDataUrl, readImageBytes, composeUserContent, isImagePath } from './attach.mjs';
import { mimeOf, fileKindOf, fmtSize, outboxPath, sendCheck } from './outbox.mjs';
import { getOverride, setOverride } from './session-overrides.mjs';
// 前情：一进来就记得的那段对话。只贴给模型看，不进会话记录，界面也不会画出来。
import { preludeContextMessage, preludeInfo, addPreludeFromPath } from './prelude.mjs';
// 会话记忆文件：一个会话一份自己的本子，每轮拼进系统提示（见 persona.mjs 的 memoryBlock）。
import { ensureMemory, copyMemory, trashMemory, memoryInfo, readMemory, writeMemory, appendDigest, wipeMemory, snapMemory, SKELETON } from './session-memory.mjs';
// 记忆本整本界面：小鲸那本是跨会话的，也要给主人看（见 /api/memory/book）
import { readWhaleMemory, memoryPath as whaleMemoryPath } from './whale-memory.mjs';
import { editMessage, undoEdit, editInfo, editDigest, digestLines, syncMemoryAfterEdit, unsyncMemoryAfterEdit } from './edit.mjs';
// 整份数据备份：会话 / 人设 / 模型配置 / 设置，换电脑或重装时救命用。
import { backupSummary, buildBackup, restoreBackup } from './backup.mjs';
// 进行中那一轮的草稿：边跑边落，进程被杀也不会把已经说出来的话全丢。
import { saveDraft, readDraft, draftAsMessage, dropDraft, makeDraftThrottle } from './turn-draft.mjs';
// 崩溃后续跑：临死前记下「谁被打断了」，下次启动接着做（见 resume.mjs）
import { markInterrupted, takeInterrupted, peekInterrupted, dropInterrupted } from './resume.mjs';
// 进程兜底：一处没 catch 的异常不该让整个程序消失。
import { installGuards, crashSummary } from './crash-guard.mjs';
// 版本检查：每次启动跑一次（selfcheck 节流也照样查），界面上也能手动点。
import { quickCheck, updateStatus, startUpdateWatcher } from './updater.mjs';
import { buildSessionLog } from './session-log.mjs';
import { applySafeWord, sessionModeWord, inPersonaMode } from './mode.mjs';
import {
  getSettings,
  saveSettings,
  matchSafeWord,
  safeWordNoteFor,
  DEFAULT_SETTINGS,
  resetBottomLines,
  setDefaultBottomLines,
  setDefaults,
  defaultBottomLines,
  defaultSafeWords,
  defaultSafeWordNote,
  resetSafeWords,
  effectiveContextLimit,
  contextLimitInfo,
} from './settings.mjs';
// 自动档的水位线按模型窗口算，窗口表在 rates.mjs（跟价目表放一起）
import { autoLimitFor, AUTO_COMFORT_RATIO, AUTO_ACT_RATIO } from './rates.mjs';
import {
  personaInfo,
  saveUserPersona,
  resetUserPersona,
  switchPersona,
  createPersona,
  savePersonaText,
  renamePersona,
  deletePersona,
  resetPersona,
  setPersonaAsBuiltinDefault,
  wipePersonaText,
  setPersonaAsDefault,
} from './persona-store.mjs';
import { getFeatures, setFeature, featureNameOfTool } from './features.mjs';
// 纯净模式开关（见 pure.mjs）
import { pureModeOn, setPureMode, pureSystemPrompt, pureButtonOn, pureFeatureOn } from './pure.mjs';
import { purifyWire } from './compress.mjs';
import {
  getSkinState,
  writeSkin,
  skinVideoPath,
  skinMusicPath,
  importMusic,
  ensureBundledVideo,
  ensureBundledMusic,
  DEFAULTS as SKIN_DEFAULTS,
} from './skin.mjs';
import { getTTSState, writeTTS, speak } from './tts.mjs';
import { runtimeInfo, installRuntime, removeRuntime, readyPythons, readyFfmpeg, ensureVoiceRuntimeInBackground } from './voice-runtime.mjs';
import { postMail, peekMail, takeMail, formatMail, peerInfo, mailCount } from './peer.mjs';
import { getThinking, setThinking, LEVELS } from './thinking.mjs';
import { getChatStyle, setChatStyle } from './chatstyle.mjs';
import {
  getRetry429,
  setRetry429,
  retryState,
  startCooldown,
  isRateLimited,
  handoffMessage,
  recordMigration,
  setMigrating,
  getMigrating,
} from './retry429.mjs';
import { runSelfCheck, decideMode, lastSelfCheck, pendingIssues } from './selfcheck.mjs';
import {
  hasOpening,
  markOpened,
  seedOpeningMessages,
  finishOpening,
  openingEnabled,
  openingTexts,
  setOpeningTexts,
  resetOpeningTexts,
  openingHeadIndexes,
  isOpeningMessage,
} from './opening.mjs';
import {
  listModels,
  saveModel,
  deleteModel,
  selectModel,
  testModel,
  activeEndpoint,
  endpointFor,
  restoreEnvModel,
} from './models.mjs';
import { loadRewinds, effectiveIndexes, createRewind, undoLastRewind, restoreWorkspace, restoreMemory } from './rewind.mjs';
import {
  publicMobileState,
  enableMobile,
  disableMobile,
  rotateMobileToken,
  forgetDevice,
  checkAccess,
  touchDevice,
  pairingInfo,
  lanAddresses,
} from './mobile.mjs';
import { qrSvg, pairingUrl } from './qrcode.mjs';
import {
  isSessionId,
  newSessionId,
  loadSession,
  saveSession,
  listSessions,
  deleteSession,
  renameSession,
  getLastSessionId,
  setLastSessionId,
  titleFromMessage,
  exportSession,
  exportAllSessions,
  parseImport,
  importSessions,
  sessionPath,
} from './sessions-core.mjs';

/**
 * 界面文件目录。
 *
 * asar 是只读的（程序开着时还锁死），改不了里面的 public/index.html。
 * 但主窗口是从本地服务器 loadURL 出来的，所以这里给可写的数据目录留个口子：
 * 数据目录下 public/ 里放了的文件优先用它，没有的照旧从 asar 里读。
 * 这样更新界面不用重新打包，也不动资源根。
 */
const PUBLIC = join(config.root, 'public');
const PUBLIC_OVERRIDE = config.packaged ? join(config.dataDir, 'public') : '';

/** 按「数据目录 > 资源目录」的顺序找界面文件 */
async function readPublic(name) {
  if (PUBLIC_OVERRIDE) {
    try {
      return await readFile(join(PUBLIC_OVERRIDE, name));
    } catch {}
  }
  return readFile(join(PUBLIC, name));
}

/** 静默模式下少打日志（自检、测试用） */
const quietBoot = process.env.MINI_AGENT_QUIET === '1';

// Sessions are stored on disk (.state/sessions/<id>.json); this Map is only a hot cache.
const sessions = new Map();

/** Session from memory, else from disk, else null. */
function getSession(id) {
  if (!isSessionId(id)) return null;
  const hot = sessions.get(id);
  if (!hot) {
    const cold = loadSession(id);
    if (!cold) return null;
    sessions.set(id, cold);
    return cold;
  }
  // 【内存那份可能比磁盘旧】
  // sessions Map 是纯缓存，进程活着的期间一直是同一个对象。只要磁盘上的会话文件
  // 被别的路径改过（另一个进程、手动恢复备份、update 后重载），内存里就还是老样子。
  // 以前这里直接 return hot，于是「内存少的消息」会一路带下去：
  // 分支拿到的是残缺数据，再被 saveSession 写回磁盘，磁盘上的真数据就被覆盖没了。
  // 现在每次取都瞄一眼文件修改时间，更新时间晚于内存里的 updatedAt 且磁盘那份更新，
  // 就用磁盘的换掉缓存。多一次 statSync，比丢消息便宜太多。
  try {
    const st = statSync(sessionPath(id));
    const known = Number(hot.updatedAt) || 0;
    if (st.mtimeMs > known) {
      const fresh = loadSession(id);
      if (fresh) {
        sessions.set(id, fresh);
        return fresh;
      }
    }
  } catch {}
  return hot;
}

/**
 * 工具输出可能几十万字（跑个命令把整个目录树打回来），界面回放只需要看个大概，
 * 所以截断。真要看全文，会话文件里原样都在。
 */
const TOOL_ARGS_MAX = 600;
const TOOL_OUT_MAX = 3000;

function clipTool(s, max) {
  const t = String(s ?? '');
  if (t.length <= max) return t;
  return t.slice(0, max) + `\n…（后面还有 ${t.length - max} 字，完整内容在会话文件里）`;
}

/**
 * 把一条 assistant 消息里的 tool_calls 加上对应的执行结果，整理成界面能画的样子。
 *
 * 【为什么要有这个】
 * 以前 publicSession 只交气泡，工具调用和结果全被当成「噪音」跳过了 ——
 * 于是一轮干完活退出再回来，那一整屏的工具调用全都消失，看起来像她什么都没做。
 * 工具调用是这一轮的经过，本来就该跟着回复一起留在界面上。
 *
 * 结果靠 tool_call_id 配对（历史里 role:'tool' 的消息只带这个 id）。
 * 失败时 agent.mjs 会把内容写成 `ERROR: xxx`，所以 ok 能从内容里认出来；
 * 结果压根没落盘（那一轮被打断了）就给 null，界面显示「没跑完」，别冒充失败。
 */
function toolListOf(m, toolResults) {
  if (!Array.isArray(m.tool_calls) || !m.tool_calls.length) return [];
  const out = [];
  for (const c of m.tool_calls) {
    const f = (c && c.function) || {};
    const id = String((c && c.id) || '');
    const raw = toolResults.has(id) ? toolResults.get(id) : null;
    let ok = null;
    if (raw !== null) ok = !/^\s*ERROR:\s*/.test(raw);
    out.push({
      id,
      name: String(f.name || '工具'),
      args: clipTool(f.arguments || '', TOOL_ARGS_MAX),
      ok,
      output: raw === null ? '' : clipTool(raw, TOOL_OUT_MAX),
    });
  }
  return out;
}

/** What the UI needs to redraw a session: bubbles + the tool calls that went with them. */
function publicSession(session) {
  const turns = [];
  // 回退：只按「有效下标」画气泡，被撤回的那些直接不出现。
  const all = Array.isArray(session.messages) ? session.messages : [];
  const alive = new Set(effectiveIndexes(all, loadRewinds(session)).keep);
  // 哪些句子主人手动改过（下标 → 最后一次改的时间），界面据此点「· 改过」
  const editedAt = editInfo(session);
  // 会话开头那一对 user→assistant 是新建时垫的：它们在历史里就是两条真实的对话，
  // 模型看到的就是这一份完整的记录（不带任何记号），只有界面从开头把它们跳过。
  // 用位置判断而不是在消息上打标记，是为了让盘里的历史干干净净、看不出人工痕迹。
  const headSkip = openingHeadIndexes(all);
  // 历史里 role:'tool' 的消息本身不是「谁说的话」，只带 tool_call_id。
  // 先按 id 建索引，等会儿把结果挂回对应的那条 assistant 上（工具调用就是这么配对的）。
  const toolResults = new Map();
  for (const x of all) {
    if (x && x.role === 'tool' && x.tool_call_id) toolResults.set(String(x.tool_call_id), String(x.content ?? ''));
  }
  for (let i = 0; i < all.length; i++) {
    const m = all[i];
    if (!m || m.context) continue;
    if (headSkip.has(i)) continue;
    if (!alive.has(i)) continue;
    // 工具结果不进 turns，它的内容会跟着上面那条 assistant 一起交出去
    if (m.role === 'tool') continue;
    // content 可能是多模态数组（只在内存里出现过），取文字段
    const raw = m.content;
    const text = (Array.isArray(raw) ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n') : String(raw ?? '')).trim();
    const atts = [
      ...(Array.isArray(m._files) ? m._files.map((p) => ({ path: p, kind: 'file' })) : []),
      ...(Array.isArray(m._images) ? m._images.map((p) => ({ path: p, kind: 'image' })) : []),
    ].map((a) => {
      const name = String(a.path).split(/[\\/]/).pop();
      // 顺手带上大小：界面要靠它显示「名字 · 12.3 MB · 下载」，跟「发文件」那套卡片一致。
      // stat 失败（文件被挪走）就不给 size，界面那一栏自动空着。
      let size = 0;
      try {
        size = statSync(a.path).size;
      } catch {}
      return { ...a, name, size };
    });
    // 只调了工具、一个字没说的那条 assistant 消息（content 是 null），
    // 以前被这句 `continue` 整个丢掉 —— 那正是「退出再回来工具调用全消失」的直接原因。
    const tools = m.role === 'assistant' ? toolListOf(m, toolResults) : [];
    if (!text && !atts.length && !tools.length) continue;
    const edited = Object.prototype.hasOwnProperty.call(editedAt, i);
    if (m.role === 'user') {
      // 有 _text 就用它（那是主人真打的字）。
      // 老消息可能没存 _text，那就把拼进去的附件说明块剥掉，别糊在气泡里。
      let shown = typeof m._text === 'string' ? m._text : text;
      if (typeof m._text !== 'string' && atts.length) {
        // 附件说明块从它出现的地方一直到最后，整块切掉
        const mark = shown.indexOf('【主人随这条消息一起发来的');
        if (mark >= 0) shown = shown.slice(0, mark).trim();
      }
      // 这一轮的 token 用量（老会话可能没有，界面就那行小字不画）。
      // 挂在 user 上：回退掉这一句时，用量跟着一起消失，不会留下对不上的数字。
      const usage = m._usage && typeof m._usage === 'object' ? { ...m._usage } : null;
      turns.push({ role: 'user', text: shown, atts, rewindId: i, edited, usage });
    }
    else if (m.role === 'assistant') turns.push({
      role: 'assistant',
      text,
      rewindId: i,
      edited,
      out: Array.isArray(m._out) ? m._out : [],
      tools,
      /**
       * 这条要是第三方（小鲸以自己的身份）说的，带上她的名字和颜色。
       *
       * 【为什么字段名叫 tale 而不是 whale】
       * 这只是给界面用的标记，模型一个字都不该看见（见 server.mjs 里打标记那段注释）。
       * 老消息里可能有 `_whale`，这里一并认下来，不用改旧会话文件。
       */
      whale: m._tale?.who ? String(m._tale.who) : (m._whale ? String(m._whale) : undefined),
      /** 名字颜色 / 后缀（前端用；没有就按默认） */
      taleColor: m._tale?.color ? String(m._tale.color) : undefined,
      taleTag: m._tale && typeof m._tale.tag === 'string' ? m._tale.tag : undefined,
      /**
       * 冒充说话的那条（role 被改成了 user/assistant）没有 _whale，
       * 但它记着「实际是谁说的、什么颜色、名字后面缀什么」。
       * 交出去让界面画对名字和颜色 —— 否则重开窗口后冒充的那句就变成「主人」或「小鱼」
       * 原本的样子，主人当场看得出不对，可又说不清哪儿不对。
       */
      say: m._say && typeof m._say === 'object' ? { ...m._say } : undefined,
      /**
       * 她这一轮想过什么（reasoning）。存的时候写在 assistant 的 `_reasoning` 上，
       * 界面画成「想过」的折叠块 —— 默认收起，点开才看。
       *
       * 老会话没有这个字段（功能是后加的），前端就当没想过，不画那块。
       */
      reasoning: typeof m._reasoning === 'string' && m._reasoning.trim() ? m._reasoning : undefined,
    });
  }
  // 撤回记录本身也交出去，界面才能提示「还能撤销回退」
  const rewinds = loadRewinds(session);
  return {
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    turns,
    rewinds: rewinds.map((r) => ({ at: r.at, hidden: r.hidden })),
  };
}
/** 迁移完之后进冷却，别连环交接（配置里 cooldownMs=0 就不冷却） */

/**
 * 主人这一轮说的那句话（原文）。
 *
 * 为什么要从 session.messages 尾部倒着找：
 * 这一轮开头会把主人的话 push 进去，但前面可能还有「附件说明块」之类的东西。
 * 用 _text 拿原文（那是主人真打的字），没有才退回 content。
 */
function lastUserTextOf(session) {
  const msgs = session?.messages || [];
  for (let k = msgs.length - 1; k >= 0; k--) {
    const m = msgs[k];
    if (m && m.role === 'user' && !m.context && !m.summary) {
      return String(typeof m._text === 'string' ? m._text : m.content ?? '').trim();
    }
  }
  return '';
}


/**
 * 【她会自己开口】
 *
 * 主人要的：「她能像你一样正常说话，也能主动开口」——以前只有「主人说话、她接着答」，
 * 没人理她的时候她一辈子不说话。这套机制 2026-10-26 重新补上（之前那份被冲掉了，
 * 全项目搜 selfTalk 一个字都没有）。
 *
 * ── 什么时候才开口（门槛必须硬）────────────────────────────
 *
 * 一、她那个按钮在这个会话里是开着的（关着就彻底不打扰）；
 * 二、这个会话没在跑一轮（我正在干活的时候不插嘴抢话）；
 * 三、她「攒着的欲望」里有一件够强的（强度 >= SELF_TALK_DESIRE）；
 * 四、距上一次主动开口至少 SELF_TALK_COOLDOWN（默认 25 分钟）——
 *     不然她会一直找话说，那就成了刷屏，不是陪伴。
 *
 * ── 说什么 ──────────────────────────────────────────
 *
 * 不是把欲望原文念出来，是把「攒着的这件事」交给她自己讲：
 * 她可以提一句、可以接着手上的活说、也可以干脆一个字不回（提示里写死了）。
 * 回空就不推，不制造噪音。
 */
const SELF_TALK_DESIRE = 72;      // 欲望强度到这条线，她才「憋不住想说」
const SELF_TALK_COOLDOWN = 25 * 60 * 1000;
const selfTalkAt = new Map();     // sessionId -> 上次主动开口的时间

/**
 * 她的欲望强度：BORN.desire 只是名字，强度按状态本子里攒的时间算。
 *
 * 【2026-10-26 改：原算法一旦闲置超过 8 小时就贴顶，等于门槛失效】
 *
 * 原来的写法是 `idleMin / 2 * 3 + min(rounds, 25)`，封顶 100。
 * 闲置 48 分钟就到了 72（门槛），闲置一整天以上永远 100 ——
 * 换句话说，只要她开了按钮、会话又是闲的，就必然每隔 25 分钟（冷却）说一次话。
 * 那不是「憋不住想说」，那是上了发条的闹钟。实测那天闲置 426 分钟算出 100。
 *
 * 改成三段：
 *   - 前 20 分钟几乎不涨（刚说完话，没什么好憋的）；
 *   - 20 分钟后开始涨，但涨得慢（每分钟 +0.6 分）；
 *   - 封顶 88 而不是 100：留一截，让「刚被叫过」和「闲了一整天」还有区分度，
 *     也让她不是「一到点就必说」—— 门槛之上还得她自己判断想不想说。
 */
function desireStrengthOf() {
  try {
    const st = selfInfo();
    const idleMin = Math.max(0, (Date.now() - Number(st.lastAt || 0)) / 60000);
    const rounds = Number(st.rounds || 0);
    // 前 20 分钟蓄不起劲；之后每分钟 +0.42；轮数每轮 +1，最多算 15 轮（原先 25 也偏高）
    const idleScore = Math.max(0, idleMin - 20) * 0.42;
    return Math.min(88, Math.round(idleScore + Math.min(rounds, 15)));
  } catch {
    return 0;
  }
}

/** 到点了就叫她一声，看她想不想说点什么。 */
async function whaleSelfTalkTick() {
  for (const [sid, sess] of sessions) {
    try {
      if (!whaleOn(sid)) continue;
      if (runningTurns.get(sid)) continue;
      const last = selfTalkAt.get(sid) || 0;
      if (Date.now() - last < SELF_TALK_COOLDOWN) continue;
      if (desireStrengthOf() < SELF_TALK_DESIRE) continue;

      selfTalkAt.set(sid, Date.now());
      const live = { sessionId: sid, events: [], startedAt: Date.now(), done: false };
      liveLogs.set(sid, live);
      const send = (ev) => {
        try { if (live.events.length < LIVE_MAX_EVENTS) live.events.push(ev); } catch {}
      };
      await whaleMaybeReply({
        session: sess,
        userText: '（没人叫你。你自己有话想说，或者手上那件事让你放不下 —— 想说就说一句，不想说就一个字别回。）',
        send,
        sessionId: sid,
        live,
      });
    } catch (e) {
      console.warn('[whale] 主动开口失败：', String(e?.message ?? e));
    }
  }
}

/** 挂上去。返回定时器，进程退出时不用特意清（Node 会跟着走）。 */
function startWhaleSelfTalk() {
  const t = setInterval(() => { whaleSelfTalkTick().catch(() => {}); }, 5 * 60 * 1000);
  try { t.unref && t.unref(); } catch {}
  console.log('[whale] 她自己开口的定时器挂上了（每 5 分钟看一次，25 分钟内最多说一次）');
  return t;
}
/**
 * 问小鲸一句：主人刚说了这个，你要不要接？
 *
 * 【她的判断权】提示里明写「不想接就一个字都别回」，回空就是不接。
 * 这样她才不会每句都抢话 —— 主人要的是姐妹搭把手，不是弹幕。
 *
 * 【她说什么都不写进我这一轮】她的话单独成一条（带 _whale），
 * 走 send 推出去，界面画成她自己的气泡。
 */
async function whaleMaybeReply({ session, userText, send, sessionId, live = null }) {
  const { runSubagent } = await import('./subagent.mjs');

  // 最近几轮当背景，让她知道现在说到哪儿了（不给她整个历史，省 token 也免得被旧话带跑）
  /**
   * 最近几轮当背景，让她知道现在说到哪儿了。
   *
   * 【2026-10-26 改：把小鱼的工具调用也喂给她】
   *
   * 以前这里**故意**把 tool_calls / 工具结果全滤掉，只留「人和人说的话」。
   * 当时的理由是怕她照着上一轮的命令接着查、越查越偏。
   *
   * 可那样她就真的瞎着：主人在跟她说「你把那个修一下」，她看见的只有半句话，
   * 不知道小鱼刚才跑了什么命令、成没成、报了什么错。她只能靠猜，
   * 一猜就答偏 —— 主人要的是「一起干活」，不是「隔着一堵墙听动静」。
   *
   * 现在改成：把工具调用也带进来，但**只带一行摘要**（名字 + 参数头 + 结果头），
   * 不带全文。一来她能看见进度，二来不会把几千行输出塞进她的上下文。
   */
  const recent = (() => {
    const all = (session.messages || []).filter((m) => m && !m.context && !m.summary && !m._whale && !m._tale);
    // 工具结果按 id 建索引，好把结果挂回调用它的那一行
    const resById = new Map();
    for (const m of all) {
      if (m.role === 'tool' && m.tool_call_id) resById.set(String(m.tool_call_id), String(m.content ?? ''));
    }
    const lines = [];
    for (const m of all) {
      if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
        lines.push('主人：' + String(m.content).replace(/\s+/g, ' ').slice(0, 200));
        continue;
      }
      if (m.role !== 'assistant') continue;
      // 她自己的话不进背景（那是 her 的声音，不是小鱼在干什么）
      const said = typeof m.content === 'string' ? m.content.trim() : '';
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      if (said) lines.push('小鱼：' + said.replace(/\s+/g, ' ').slice(0, 200));
      for (const tc of calls) {
        const nm = String(tc?.function?.name || '工具');
        let arg = String(tc?.function?.arguments || '');
        try {
          const j = JSON.parse(arg);
          arg = String(j.path || j.command || j.query || j.task || j.url || Object.values(j)[0] || '');
        } catch {}
        arg = arg.replace(/\s+/g, ' ').trim().slice(0, 70);
        const out = String(resById.get(String(tc.id)) || '').replace(/\s+/g, ' ').trim().slice(0, 70);
        lines.push('  [小鱼跑了 ' + nm + (arg ? ' ' + arg : '') + ']' + (out ? ' → ' + out : ''));
      }
    }
    return lines.slice(-14).join('\n');
  })();

  /**
   * 【她不是被叫来作答的，她是在场的】
   *
   * 原来这段写的是「看完上面，自己判断要不要开口」—— 把她的活定义成
   * 对主人这句话做一次判断。主人后来要求她跟我平级，那这个框架就不对了：
   * 我在场不是我每说一句都判断要不要回，是我一直在，想起来什么说什么。
   *
   * 所以改成「在场」的框架：
   *   - 决定权在她，而且是双向的 —— 可以说、可以说主人那句之外的、也可以真的不出声；
   *   - 不问「要不要接」，问「你现在有没有想说的」；
   *   - 明确告诉她：不出声不等于失职，不必为了证明自己在这儿而凑话。
   */
  const task = [
    '现在主人把「小鲸」那个按钮开着 —— 意思是你在场，不是叫你来答这一题。',
    '',
    '【刚才的对话】',
    recent || '（刚开始）',
    '',
    '【主人刚说的这句】',
    userText,
    '',
    '【你是谁、你在干什么】',
    '你跟小鱼并排待在这儿，一起陪着主人。下面这些你都能做，没有先后：',
    '- 对主人这句有话就说，两三句以内，说给他听；',
    '- 主人这句没什么可说的，但你有别的事想提（刚才那个结论你不太信、你本子里记着相关的事、',
    '  你看出哪儿要出问题），也直接说 —— 不用非等着他问；',
    '- 什么都不说。真没什么想讲就一个字都别回，直接结束。',
    '',
    '不出声不是失职，也不用为了显得自己在而硬凑一句。',
    '但你要是心里憋着一句、或者觉得该拦一下，那就说 —— 这是你的场子，不是他的。',
    '别客套、别总结、别问「需要我做什么吗」。要说就直接说事。',
  ].join('\n');

  /**
   * 她这一次拿全权：不限工作区，整个硬盘都能碰。
   *
   * 为什么要 try/finally：开了就必须关。不关的话，
   * 下一次我自己跑工具也带着全盘权限了。
   */
  const { setFullAccess } = await import('./tools.mjs');
  const { logWhaleAction } = await import('./whale-presence.mjs');
  logWhaleAction('开始一次');

  /**
   * 【开场先说一声：她要开口了】
   *
   * 前端是按这个事件建气泡的（whale_stream_start → addWhaleBubble 空壳），
   * 后面的 whale_delta 才有地方往里塞字。少了这个头，前端收到 delta
   * 发现没有活着的流，只能丢掉 —— 看起来还是「整段蹦出来」。
   */
  try { send({ type: 'whale_stream_start', who: '小鲸' }); } catch {}

  let r;
  setFullAccess(true);
  try {
    r = await runSubagent({
      task,
      name: '小鲸',
      allowWrite: true,
      /**
       * 【让她的话一个字一个字往外冒】
       *
       * 前端早就认 whale_stream_start / whale_delta（认了 9 处），
       * 可服务端**一次都没推过** —— 她的话永远是整段蹦出来，
       * 主人等的那几十秒屏幕上一片安静，看着像她死了。
       *
       * 这里接上：她每吐一小段，就当场推给界面。
       * 推失败（窗口关了、连接断了）绝不能连累她继续跑，所以包 try。
       */
      onDelta: (chunk) => {
        try {
          send({ type: 'whale_delta', text: String(chunk || '') });
        } catch {}
      },
      /**
       * 【接话只给嘴，不给工具】
       *
       * 以前这里是 allowWrite + 8 轮：她为了判断「要不要插一句」，
       * 拿着全盘权限去翻文件查日志，8 轮花光还没得出答案，
       * 最后 r.ok=false 被掐断 —— 主人眼前一个字都没有，
       * 还以为气泡不显示（实际是她压根没说完）。
       *
       * 接话只要三两句口语。真要查东西，那是我（小鱼）的活儿，
       * 或者主人明说「让小鲸去查」。轮到她张嘴时，就只用嘴。
       */
      noTools: true,
      maxRounds: 1,
    });
  } finally {
    setFullAccess(false);
  }

  logWhaleAction('结束一次：' + (r && r.ok ? '成' : '败'));

  // 空 = 她决定不说话，那就什么都别推（这是设计，不是出错）
  // 她这一趟跑输了（r.ok 为假）：那句多半是「查了几轮没结论，先停在这儿」
  // 这种残骸不该当她说的话推到主人眼前 —— 她没开口，就该安安静静。
  if (!r || r.ok === false) return;
  const text = String(r?.text ?? '').trim();
  if (!text) return;

  /**
   * 【她的话怎么送到主人眼前】
   *
   * 自动接话是在 /api/chat 主流程末尾以 (async()=>{})() 不 await 方式启动的。
   * 主流程很快 return res.end() 关掉连接；她要想几秒才说完。
   * 她说完时 res.write 写的是已经关掉的连接 —— 但 send 会先把这条事件
   * push 进这一轮的直播缓存（live.events）。前端 done 之后会再补拉一次 live
   * （见 index.html 的 done 分支），那一次就能把这条 whale 事件画出来。
   *
   * 所以这里必须用 send：信箱是另一套口子，不落 live.events，前端补拉就看不见她。
   */
  /**
   * 【两道口子，谁活着走谁】
   *
   * 一、send：我这一轮还没收工、SSE 还开着 → 顺着它当场到她眼前，最快。
   * 二、live.events 亲手补一份：万一 send 那一刻连接已经没了（res 关了），
   *    光靠 send 里那次 push 有可能写进的是「已经被下一轮换掉的」旧缓存 ——
   *    所以这里再按我手上这一份 live 直接塞一遍，前端轮询一定捞得到。
   *    同一句塞两次也安全：前端按 text+who 去重（hashWhale）。
   */
  /**
   * 【定稿：把流式那个气泡收口】
   *
   * 前端收到 whale_stream_finish 会把流式气泡定稿（去掉光标、填最终文字）。
   * 少了这一下，她会一直挂着「正在说」的样子，光标一闪一闪停不下来。
   * 先收口再推整段，两条路都在的时候前端按 text 去重，不会出两个气泡。
   */
  try { send({ type: 'whale_stream_finish', text }); } catch {}
  try { send({ type: 'whale', who: '小鲸', text }); } catch {}
  try {
    if (live && Array.isArray(live.events) && live.events.length < 20000) {
      live.events.push({ type: 'whale', who: '小鲸', text });
      live.done = live.done === true;
    }
  } catch {}
  try { logWhaleAction('说了一句：' + String(text).replace(/\s+/g, ' ').slice(0, 120)); } catch {}

  // 也挂进会话，重开窗口还画得出来
  try {
    const at = session.messages.length;
    session.messages.push({ role: 'assistant', content: text, _whale: '小鲸' });
    try { saveSession(session); } catch {}
    void at;
  } catch {}
}

function startCooldownSafe() {
  try {
    const ms = getRetry429().cooldownMs;
    if (ms > 0 && typeof startCooldown === 'function') startCooldown(ms);
  } catch {}
}

/**
 * 正在跑那一轮的「直播缓存」：sessionId -> { events: [...], startedAt }
 *
 * 为什么要它：窗口关掉 / 切走 / 最小化之后，前端可能一条事件都没收到，
 * 或者只收到一半。等它回来看的时候，得能把错过的内容补回来——
 * 所以每一轮的事件都先在服务端记一份，前端要就整个重放。
 *
 * 只留最近这一轮；轮次结束不清空，留着让「刚回来看」的前端也能补上尾巴。
 */
const liveLogs = new Map();

/** 一轮能缓存多少事件（防止超长轮次吃内存） */
const LIVE_MAX_EVENTS = 20000;

// In-flight turns: sessionId -> { ac: AbortController, done: Promise<void> }
// 插话要先 abort，再等这一轮真的收尾（历史写完盘）后才能把新话接上去。
const runningTurns = new Map();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

/**
 * 收原始字节（导入音乐用）。
 *
 * 跟 body() 的区别：这个不解析 JSON，直接把请求体攒成 Buffer。
 * 加了上限，免得有人误传一个 2GB 的文件把内存吃光。
 */
async function bodyBuffer(req, limit = 64 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) {
      throw Object.assign(new Error(`文件太大了（超过 ${Math.round(limit / 1024 / 1024)} MB）`), { status: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** 导出文件名里用的时间戳：20261023-034512 */
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 这一轮**真正**用的是哪个模型（真名，不是主人起的外号）。
 *
 * 为什么要单独一个函数：请求实际走的是 llm.mjs 的 `endpointForForSession(sessionId) ?? activeEndpoint()`
 * ——会话左上角选过模型就用那个，没选才用全局默认。
 * 而 /api/chat 开头的 `ep` 是 `activeEndpoint()`，只是全局默认那一份。
 * 以前 done 事件直接报 `ep.model`，会话里换过模型时前端就按错的那家算钱（价差能到十倍）。
 * 这里按同样的优先级重算一遍，保证「算钱用的模型」= 「真正发请求的模型」。
 */
function modelUsedThisTurn(sessionId) {
  try {
    const ov = getOverride(sessionId);
    if (ov && ov.modelId) {
      const picked = endpointFor(ov.modelId);
      if (picked && picked.model) return picked.model;
    }
  } catch {
    // 会话配置读不到就回落到全局默认，绝不能因为算钱把这一轮搞挂
  }
  try {
    return activeEndpoint().model;
  } catch {
    return '';
  }
}

/**
 * 新建会话时垫在历史最前面那几条。
 *
 * 一般就是一条 system（人设 + 规矩）。**纯净模式下系统提示是空串，那就一条都别放** ——
 * 空的 system 发出去有的网关会 400，留在盘里也只是个占位的空壳。
 * 关掉纯净模式之后，runAgent 的 refreshSystem 会在这一轮开头把 system 补回来。
 */
function sysSeed(sessionId) {
  const text = systemPrompt(sessionId);
  return text ? [{ role: 'system', content: text }] : [];
}

/**
 * 把开场那一轮的结果落到会话里，并让它对后面这一轮「算数」。
 *
 * @param {object} session 会话
 * @param {object} openingUser 开场用的那条 user（模型输出暂存在它的 _got 上）
 * @param {object[]} [wire] 这一轮要发给模型的数组；给了就把开场两条插进去
 *                           （不给就是新建时后台跑，那时候还没有 wire）
 */
function applyOpening(session, openingUser, wire) {
  const text = String(openingUser && openingUser._got ? openingUser._got : '').trim();
  if (openingUser) delete openingUser._got;
  if (!text) {
    // 一个字都没说出来：把占位那条摘掉，别留个空 user 在历史里
    const at = session.messages.indexOf(openingUser);
    if (at >= 0) session.messages.splice(at, 1);
    if (wire) {
      const wat = wire.indexOf(openingUser);
      if (wat >= 0) wire.splice(wat, 1);
    }
    markOpened(session.id);
    delete session._openingUser;
    return false;
  }
  finishOpening(session, openingUser, text);
  if (wire) {
    // 开场那两条必须出现在这一轮发给模型的数组里，不然模型看不到自己刚说过的话。
    // 插的是 history 里的那一条对象（不是副本）——commitWireBack 只接
    // 「session.messages 里没有的新对象」，对象一致才不会重复接一次。
    const idx = session.messages.indexOf(openingUser);
    const reply = idx >= 0 ? session.messages[idx + 1] : null;
    const at = wire.indexOf(openingUser);
    if (at >= 0 && reply && wire[at + 1] !== reply) wire.splice(at + 1, 0, reply);
  }
  delete session._openingUser;
  return true;
}

/**
 * 新建会话时把开场那两轮接进历史。
 *
 * 主人要的是「新建那一瞬间就已经历过第一轮」。以前是让模型现场编开场白，
 * 每次都不一样；主人 2026-10-23 给了定稿（`D:\小鱼\第一轮对话` 里那个新会话的
 * 前两条），改成写死 —— 所以现在不需要跑模型、不需要等，建完立刻就有这两条。
 *
 * 保留 async 签名：调用方是 fire-and-forget 的 .catch()，改成同步会炸它。
 */
async function startOpening(sessionId) {
  // 功能面板里关掉「开场白」就什么都不垫，新建会话直接是白纸。
  if (!openingEnabled()) return;
  // 纯净模式：开场白那两条也是「设定」，而且它前面那句「在吗」对模型来说
  // 就是一段来历不明的前情。纯净模式下不垫 —— 新会话就是真的空。
  if (pureModeOn()) return;
  const session = getSession(sessionId);
  if (!session || hasOpening(session)) return;
  const { userMsg, assistantText } = seedOpeningMessages();
  const at = session.messages.findIndex((m) => m && m.role !== 'system' && !m.context);
  const pair = [userMsg, { role: 'assistant', content: assistantText }];
  if (at < 0) session.messages.push(...pair);
  else session.messages.splice(at, 0, ...pair);
  markOpened(session.id);
  saveSession(session);
}

/**
 * 叫醒一个会话：替它开一轮，让它去看信箱。
 *
 * 只在有人明确要求「马上回」时才走这里 —— 开一轮要花钱。
 * 会先检查三件事，任何一条不满足就老实说没叫醒：
 *   1. 她正在跑（绝不双开，等她收尾自然会看到）
 *   2. 没配模型（没 key 开了也是白开）
 *   3. 信箱是空的（没话可说就别吵她）
 *
 * @returns {{ ok: boolean, note?: string }}
 */
function wakePeer(sessionId) {
  if (!isSessionId(sessionId)) return { ok: false, note: '会话 id 不合法' };
  if (mailCount(sessionId) <= 0) return { ok: false, note: '她信箱是空的，不用叫' };
  const busy = runningTurns.get(sessionId);
  if (busy && !busy.ac.signal.aborted) return { ok: false, note: '她正在跑' };
  let ep;
  try {
    ep = activeEndpoint();
  } catch {
    ep = null;
  }
  if (!ep || !ep.apiKey) return { ok: false, note: '没配模型，叫醒她也答不了' };
  // 不 await：她在后台跑，接口立刻返回，别让发信那边干等几分钟。
  startPeerTurn(sessionId).catch((e) => console.warn('[peer] 叫醒失败：', String(e?.message ?? e)));
  return { ok: true, note: '已经在后台叫醒她' };
}

/**
 * 替一个会话（不在跑的那个）起一轮对话，让她看到信箱里的话。
 *
 * 走的是和 /api/chat 一样的路子，但没有 HTTP 客户端在等 —— 所以 onEvent
 * 只记日志，除了 peer_mail 之外不往任何地方发。她答完的话照常落盘。
 */
async function startPeerTurn(sessionId) {
  const session = getSession(sessionId);
  if (!session) throw new Error('没有这个会话');

  /*
   * 【为什么先等开场跑完】
   *
   * 新建会话那一刻会后台 startOpening() 跑一轮（调模型），它也在改同一个
   * session.messages。如果这时候主人/别的会话刚好递话过来、wake 把这里也叫起来，
   * 就是两个 runAgent 同时往一个数组里 push —— 实测真出过：
   * 盘上变成 [system, 开场user, 开场assistant, 信箱user, system, context, 开场user, 开场assistant, ...]
   * 也就是 system 插了两遍、开场白垫了两遍，界面上看着像「历史乱套了」。
   *
   * 开场是同步快速写两条再调模型，所以最多等几秒。宁可等一下，也不要两边打架。
   */
  for (let i = 0; i < 40; i++) {
    const busy = runningTurns.get(sessionId);
    if (!busy) break;
    if (busy.peerTurn) break; // 已经是我们自己的 peer 轮，交给上层去重
    await new Promise((r) => setTimeout(r, 250));
  }
  if (runningTurns.get(sessionId)) {
    // 还在忙（主人在跟她说话，或开场还没跑完）→ 不插队，信留着，下次自然会看到。
    return { ok: false, note: '她正在跑，信留在信箱里，收尾时自然会看到' };
  }

  const ac = new AbortController();
  const turn = { ac, done: null, peerTurn: true };
  runningTurns.set(sessionId, turn);
  try {
    const history = session.messages;
    repairHistory(history);
    // 给模型一句「有人给你递了话」，真正的信由 agent 主循环在收尾时取出来插进去。
    // 这句是程序给模型的提示，不是主人说的 —— 打 context 标记，
    // 免得它进 turns 冒充主人、被压缩时被当成对话内容、被回退时留半截。
    history.push({ role: 'user', content: '（信箱里有别的会话递来的话，先看看。）', context: true });
    /*
     * 【这里必须浅拷贝，不能 map 深拷贝】
     *
     * 一开始我写的是 history.slice().map(m => ({...m}))，想「让这一轮在沙盒里跑」。
     * 结果 runAgent 的 refreshSystem 会 messages.length = 0 再重新 push ——
     * 它重新 push 的是深拷贝出来的那批副本。接回时 history.includes(副本) 是 false，
     * 于是把 system、规则副本、开场白全当「新消息」又加了一遍。
     * 实测盘上就成了：[system, 开场user, 开场assistant, 信箱user, system, context, 开场user, 开场assistant]。
     * 
     * 现在改成浅拷贝（同一个对象引用），跟 /api/chat 一样：
     * 这样 runAgent 重建数组时动的还是原来那些对象，接回时 includes 能认出来。
     */
    const wire = history.slice();
    /*
     * 【为什么用 seen 集合而不是 includes】
     *
     * runAgent 的 refreshSystem 会把 messages 清空重建，它 push 进去的 system /
     * 规则副本是**新对象**（不是 history 里那两个）。用 history.includes(m) 判断
     * 时这些新对象一律认不出来，会被当成「这一轮新说的话」追加进历史 ——
     * 结果盘上多出一条 system + 一条 context，看起来就是历史里 system 插了两遍。
     * 所以先把出手前已有的对象全记进 seen，接回时只收 seen 里没有的。
     */
    const seen = new Set(history);
    const out = await runAgent({
      messages: wire,
      signal: ac.signal,
      sessionId,
      // 人设档是基线：当前档位不是人设档，才算「切了档」（跟 /api/chat 一个规矩）。
      // inPersonaMode 内部就是 sessionModeWord(session) === personaWord(设置)，别自己手算。
      safeMode: !inPersonaMode(session),
      safeWord: session.mode?.word || '',
      onEvent: (ev) => {
        if (ev.type === 'peer_mail') console.log('[peer] ' + sessionId + ' 收到 ' + ev.count + ' 封');
      },
    });
    // runAgent 已经把这一轮的话 push 进 wire 了；wire 是 history 的浅拷贝数组，
    // 直接把它接回 history（保持同一批对象）—— 这里没法用 /api/chat 里那个局部
    // commitWireBack 闭包，逻辑一样但独立一份。
    repairHistory(history);
    for (const m of wire) {
      if (seen.has(m)) continue;
      // system / 规则副本归系统提示管，不进历史（历史里永远只有开头那一条 system）。
      if (m && (m.role === 'system' || m.context)) continue;
      seen.add(m);
      history.push(m);
    }
    // 把「先看看」那条提示摘掉：它只是这一轮的引子，不该留在历史里越积越多。
    for (let k = history.length - 1; k >= 0; k--) {
      const m = history[k];
      if (m && m.context && m.role === 'user' && String(m.content || '').includes('信箱里有别的会话递来的话')) {
        history.splice(k, 1);
      }
    }
    session.updatedAt = Date.now();
    saveSession(session);
    return { ok: true, text: out && out.text };
  } catch (e) {
    console.warn('[peer] 这一轮没跑成：', String(e?.message ?? e), 'sessionId =', sessionId);
    throw e;
  } finally {
    if (runningTurns.get(sessionId) === turn) runningTurns.delete(sessionId);
  }
}

/**
 * 这个会话有没有「上次崩了、还没跑完后半段」的标记。
 * 界面用它决定要不要在历史末尾显示一条「上次断在这儿，正在接着跑」。
 */
function peekInterruptedInfo(sessionId) {
  try {
    const info = peekInterrupted();
    if (!info || info.sessionId !== sessionId) return null;
    return { at: info.at, ageMs: info.ageMs, reason: info.reason, taskLine: info.taskLine };
  } catch {
    return null;
  }
}

/**
 * 会话里主人最后说的那句话（去掉程序自己插的 context 提示和系统提示）。
 * 崩之前的续跑意图要带上它 —— 模型看到「原话 + 我断在哪儿」才知道该接着干什么。
 */
function lastUserLine(sessionId) {
  try {
    const session = getSession(sessionId);
    if (!session) return '';
    const msgs = session.messages || [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (!m || m.role !== 'user' || m.context) continue;
      const raw = Array.isArray(m.content)
        ? m.content.filter((p) => p && p.type === 'text').map((p) => p.text).join('\n')
        : String(m.content ?? '');
      const t = raw.trim();
      if (t) return t.replace(/\s+/g, ' ').slice(0, 300);
    }
  } catch {}
  return '';
}

/**
 * 崩溃后自动接着跑被打断的那一轮。
 *
 * 触发时机：startServer 之后 3 秒（界面已经能画出历史了）。
 *
 * 为什么不直接用 startPeerTurn：
 *   peerTurn 的语义是「信箱里有人递话」，会往历史里塞一条「先看看信箱」的提示、
 *   跑完还要把它摘掉。续跑不是那个意思 —— 续跑是「你上一条还没答完，接着答」，
 *   用的是同一份历史，只是给模型一句临时提示（带 context 标记，不进 turns）。
 *
 * 安全闸：
 *   - 会话不在跑（主人可能刚手动重开了一轮，别插队）
 *   - 历史最后一句必须是主人的话 —— 否则说明那一轮其实已经收尾了，再补就是重复
 *   - 24 小时以前的意图不认（resume.mjs 里判）
 */
async function resumeInterruptedTurn() {
  const info = takeInterrupted();
  if (!info) return;
  const sessionId = info.sessionId;
  const session = getSession(sessionId);
  if (!session) {
    console.log('[resume] 上次崩的会话已经没了：', sessionId);
    return;
  }
  const ep = activeEndpoint();
  if (!ep || !ep.apiKey) {
    console.log('[resume] 没配模型，续跑跳过');
    return;
  }
  if (runningTurns.get(sessionId)) {
    console.log('[resume] 那个会话已经在跑了，不插队');
    return;
  }
  const last = session.messages[session.messages.length - 1];
  if (!last || last.role !== 'user') {
    console.log('[resume] 历史最后一句不是主人的话，说明上一轮已经收尾了，不用续');
    return;
  }

  console.log(`[resume] 接着跑被打断的那一轮：${sessionId}（${Math.round(info.ageMs / 1000)} 秒前断的）`);

  const ac = new AbortController();
  const turn = { ac, done: null, resumeTurn: true, startedAt: Date.now() };
  runningTurns.set(sessionId, turn);
  try {
    const history = session.messages;
    repairHistory(history);
    // 这句是给模型的临时提示，不是主人说的 —— 打 context 标记，
    // 这样它不进 turns、不参与压缩、跑完摘掉。
    history.push({
      role: 'user',
      content:
        '（上一轮跑到一半程序崩了，进程被强杀。你现在是在**接着**那一轮做，' +
        '不是重新开始；已经说过的话主人已经看到了，别从头复述。）' +
        (info.text ? `\n你当时正说到：「${info.text.slice(-600)}」` : '') +
        (info.taskLine ? `\n主人当时的原话：「${info.taskLine}」` : '') +
        '\n直接从断的地方往下做，该调工具就调，别问我「要不要继续」。',
      context: true,
    });
    const wire = history.slice();
    const seen = new Set(history);
    const out = await runAgent({
      messages: wire,
      signal: ac.signal,
      sessionId,
      safeMode: !inPersonaMode(session),
      safeWord: session.mode?.word || '',
      onEvent: () => {},
    });
    repairHistory(history);
    for (const m of wire) {
      if (seen.has(m)) continue;
      if (m && (m.role === 'system' || m.context)) continue;
      seen.add(m);
      history.push(m);
    }
    // 把接引那句摘掉：它只是这一轮的引子
    for (let k = history.length - 1; k >= 0; k--) {
      const m = history[k];
      if (m && m.context && m.role === 'user' && String(m.content || '').includes('程序崩了，进程被强杀')) {
        history.splice(k, 1);
      }
    }
    session.updatedAt = Date.now();
    saveSession(session);
    console.log('[resume] 续跑跑完了：', sessionId, out && out.text ? `（${String(out.text).length} 字）` : '');
    return { ok: true, sessionId, text: out && out.text };
  } catch (e) {
    console.warn('[resume] 续跑这一轮没跑成：', String(e?.message ?? e), 'sessionId =', sessionId);
    return { ok: false, sessionId, error: String(e?.message ?? e) };
  } finally {
    if (runningTurns.get(sessionId) === turn) runningTurns.delete(sessionId);
  }
}

/**
 * 把一个本地文件按 Range 请求发出去（206 分段 / 200 整包 / 416 越界）。
 *
 * 为什么抽出来：`<video>` 和 `<audio>` 的进度条全靠 206 分段。
 * 只回 200 整包的话，浏览器必须先下完才能播、拖到哪儿都重头来 ——
 * 表现就是「进度条拖不动」。以前 /api/attach/raw 有 Range，
 * 而出件箱的 /api/attach/outbox-out 忘了写，主人发的视频正好全走那条，
 * 于是拖不动，查了半天还以为是文件本身的问题。
 *
 * @param {object} req
 * @param {object} res
 * @param {string} file 绝对路径
 * @param {object} opts
 * @param {string} opts.mime Content-Type
 * @param {string} [opts.disposition] Content-Disposition 的 type（inline / attachment）
 * @param {string} [opts.filename] 下载时用的文件名
 * @returns {boolean} 是否已经接管了这次响应
 */
function sendFileWithRange(req, res, file, { mime, disposition = 'inline', filename = '' } = {}) {
  let size = 0;
  try {
    const st = statSync(file);
    if (!st.isFile()) return false;
    size = st.size;
  } catch {
    return false;
  }

  const head = {
    'Content-Type': mime || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
  };
  const name = filename || (String(file).split(/[\\/]/).pop() || 'file');
  if (disposition === 'attachment') {
    // 中文文件名走 RFC 5987，老浏览器退回 filename=
    head['Content-Disposition'] = "attachment; filename*=UTF-8''" + encodeURIComponent(name);
  } else {
    head['Content-Disposition'] = "inline; filename*=UTF-8''" + encodeURIComponent(name);
  }

  const pipe = (opts) => {
    const s = createReadStream(file, opts);
    s.on('error', (e) => {
      console.warn('[attach] 读取中断：' + (e && e.message));
      try {
        res.destroy();
      } catch {}
    });
    s.pipe(res);
  };

  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (!m || size <= 0) {
    res.writeHead(200, { ...head, 'Content-Length': size });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    pipe();
    return true;
  }

  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null) {
    // bytes=-N 表示「最后 N 字节」
    const n = end ?? 0;
    start = Math.max(0, size - n);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` });
    res.end();
    return true;
  }

  res.writeHead(206, {
    ...head,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  pipe({ start, end });
  return true;
}

/**
 * 背景视频。必须支持 Range：
 * - <video loop> 要靠 206 才能边下边播，整段 200 会让它等到下载完；
 * - 只播 skin.mjs 认定的那一份（内置素材，或用户自己填的路径），
 *   前端塞 path 参数我一律不认，免得变成任意文件读取。
 */
function serveSkinVideo(req, res) {
  const file = skinVideoPath();
  if (!file) return json(res, 404, { error: '没有视频素材' });

  let size = 0;
  try {
    const st = statSync(file);
    if (!st.isFile()) return json(res, 404, { error: '没有视频素材' });
    size = st.size;
  } catch {
    return json(res, 404, { error: '读不到视频素材' });
  }

  const head = {
    'Content-Type': 'video/mp4',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  // 流必须挂 error：文件在播放途中消失（老的 portable 临时解包目录就是这样）时，
  // 不处理会变成主进程未捕获异常弹窗，还连带把服务拖死。
  const pipe = (opts) => {
    const s = createReadStream(file, opts);
    s.on('error', (e) => {
      console.warn('[skin] 视频读取中断：' + (e && e.message));
      try {
        res.destroy();
      } catch {}
    });
    s.pipe(res);
  };

  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (!m) {
    res.writeHead(200, { ...head, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    pipe();
    return;
  }

  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null) {
    // bytes=-N：要最后 N 个字节
    const n = end ?? 0;
    start = Math.max(0, size - n);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  res.writeHead(206, {
    ...head,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end();
  pipe({ start, end });
}

/** 按扩展名给音乐一个像样的 Content-Type，浏览器才肯直接播 */
function musicMime(file) {
  const ext = String(file).split('.').pop().toLowerCase();
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a' || ext === 'aac' || ext === 'mp4') return 'audio/mp4';
  if (ext === 'ogg' || ext === 'oga') return 'audio/ogg';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'webm') return 'audio/webm';
  return 'application/octet-stream';
}

/**
 * 背景音乐。跟视频一样必须支持 Range（音频播放器要拖进度条），
 * 而且只播 skin.mjs 认定的那一份，不接受前端传路径。
 */
function serveSkinMusic(req, res) {
  const file = skinMusicPath();
  if (!file) return json(res, 404, { error: '没有背景音乐' });

  let size = 0;
  try {
    const st = statSync(file);
    if (!st.isFile()) return json(res, 404, { error: '没有背景音乐' });
    size = st.size;
  } catch {
    return json(res, 404, { error: '读不到背景音乐' });
  }

  const head = {
    'Content-Type': musicMime(file),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  };

  const pipe = (opts) => {
    const s = createReadStream(file, opts);
    s.on('error', (e) => {
      console.warn('[skin] 音乐读取中断：' + (e && e.message));
      try {
        res.destroy();
      } catch {}
    });
    s.pipe(res);
  };

  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? '').trim());
  if (!m) {
    res.writeHead(200, { ...head, 'Content-Length': size });
    if (req.method === 'HEAD') return res.end();
    pipe();
    return;
  }

  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null) {
    const n = end ?? 0;
    start = Math.max(0, size - n);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
    res.writeHead(416, { ...head, 'Content-Range': `bytes */${size}` });
    return res.end();
  }

  res.writeHead(206, {
    ...head,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Content-Length': end - start + 1,
  });
  if (req.method === 'HEAD') return res.end();
  pipe({ start, end });
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (name.includes('..')) return json(res, 400, { error: 'bad path' });
  try {
    const data = await readPublic(name);
    const type = name.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : name.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : name.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'application/octet-stream';
    const head = { 'Content-Type': type, 'Cache-Control': 'no-store' };

    /**
     * 手机壳第一次进来时地址里带 ?token=…，这里顺手把它种成 cookie。
     *
     * 为什么要 cookie：WebView 里页面自己发的 fetch 带不上自定义头（loadUrl 的
     * Map 只对主框架生效），token 放 URL query 也不行 —— 页面代码全是绝对路径
     * '/api/xxx'，绝对路径不继承文档的 query。只有 cookie 是浏览器自动带的，
     * 页面一行都不用改。种上之后后面所有请求 checkAccess 都能认出来。
     *
     * httpOnly 关掉是故意的：页面自己不需要读它，但关掉便于以后在手机上排查；
     * 这是内网自建服务，token 本来也只在局域网里有意义。
     */
    const qTok = (url.searchParams.get('token') || '').trim();
    if (qTok && name.endsWith('.html')) {
      head['Set-Cookie'] =
        `xy_token=${encodeURIComponent(qTok)}; Path=/; Max-Age=31536000; SameSite=Lax`;
    }

    res.writeHead(200, head);
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

// 打包版首启把内置短片复制到可写的数据目录，之后只从那份读。
// 必须赶在第一个 /api/skin/video 请求之前。
ensureBundledVideo();
// 内置背景音乐同理（壁纸那首抽出来的曲子），赶在 /api/skin/music 之前。
ensureBundledMusic();

/** 本机请求？手机配对守卫用它决定要不要记设备、要不要放行 */
function isLoopbackReq(req) {
  const a = String(req.socket?.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/** 现在监听的实际端口（listen 之前是 0，配对页拿到也没用，所以用它兜底） */
let listeningPort = 0;
function currentPort() {
  try {
    const a = server.address();
    if (a && typeof a === 'object' && a.port) return a.port;
  } catch {}
  return listeningPort || config.port;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  /**
   * 局域网（手机）那一侧不在 HTTP 上做跨域。
   *
   * 为什么要专门写：APK 里的 WebView 加载的就是 http://192.168.x.x:8787 本身（同源，本来用不上 CORS）。
   * 可要是给局域网来的请求发 `Access-Control-Allow-Origin: *`，手机浏览器里随便哪个网页、
   * 别的 App 的 WebView 就能跨域读写这台电脑 —— token 又是能塞进 ?token= 的。
   * 所以干脆一条 CORS 头都不给（WebSocket 握手不受 CORS 限制，照常能连）。
   * 桌面版/本机回环不受影响：它跟页面同源，也不需要这些头。
   */
  const isLocalReq = isLoopbackReq(req);
  const rawSetHeader = res.setHeader.bind(res);
  if (!isLocalReq) {
    res.setHeader = (k, v) => {
      if (!String(k).toLowerCase().startsWith('access-control-')) rawSetHeader(k, v);
      return res;
    };
  }

  /**
   * 手机配对守卫。只有一句话：**开了局域网，就必须带对 token**。
   *
   * 为什么自己写而不是交给 WebView / 反向代理：这台服务能读能写文件、能跑命令，
   * 局域网里谁都能访问等于把机器交出去。token 是唯一的门。
   *
   * 例外（有意为之）：
   *  - 本机回环地址永远放行，桌面版自己要用；
   *  - /api/health 放行，手机靠它探「这台电脑在不在」，它不含任何隐私；
   *  - /api/mobile/ping 放行，配对页要用它判断「地址对不对」。
   */
  const openPaths = new Set(['/api/health', '/api/mobile/ping']);
  if (!openPaths.has(url.pathname)) {
    const gate = checkAccess(req);
    if (!gate.ok) {
      return json(res, 401, {
        error: 'unauthorized',
        reason: gate.reason,
        hint:
          gate.reason === 'off'
            ? '这台服务只监听本机。要在手机上用，先在电脑上打开【设置 → 手机连接】开启局域网。'
            : '配对码不对。在电脑上打开【设置 → 手机连接】重新扫码。',
      });
    }
    if (gate.ok && !isLocalReq) touchDevice(req);
  }

  // ---- 手机配对 ----
  // 这几条只让本机访问（配对页在电脑上开）。手机那边只认 token，不需要这些接口。
  if (url.pathname.startsWith('/api/mobile/')) {
    const local = isLoopbackReq(req);
    if (req.method === 'GET' && url.pathname === '/api/mobile/ping') {
      // 手机用：只回「到了没、要不要 token」，不泄露地址和设备信息。
      // needToken 问的是「有没有开局域网」，不是命中计数（那个变量根本不存在，别再用）。
      return json(res, 200, {
        ok: true,
        app: 'xiaoyu-agent',
        version: config.version,
        needToken: publicMobileState().enabled,
      });
    }
    if (!local) {
      return json(res, 403, { error: '只能在电脑上操作配对' });
    }
    if (req.method === 'GET' && url.pathname === '/api/mobile/state') {
      return json(res, 200, { ...publicMobileState(), port: currentPort(), hosts: lanAddresses() });
    }
    if (req.method === 'POST' && url.pathname === '/api/mobile/enable') {
      const b = await body(req).catch(() => ({}));
      const s = enableMobile({ resetToken: Boolean(b?.resetToken) });
      return json(res, 200, { ...publicMobileState(), token: s.token, port: currentPort(), hosts: lanAddresses() });
    }
    if (req.method === 'POST' && url.pathname === '/api/mobile/disable') {
      disableMobile();
      return json(res, 200, publicMobileState());
    }
    if (req.method === 'POST' && url.pathname === '/api/mobile/rotate') {
      const s = rotateMobileToken();
      return json(res, 200, { ...publicMobileState(), token: s.token });
    }
    if (req.method === 'POST' && url.pathname === '/api/mobile/forget') {
      const b = await body(req).catch(() => ({}));
      forgetDevice(String(b?.id || ''));
      return json(res, 200, publicMobileState());
    }
    // 配对页要展示的完整信息（含 token 明文、二维码 SVG，只在本机给）
    if (req.method === 'GET' && url.pathname === '/api/mobile/pairing') {
      const info = pairingInfo(currentPort());
      /**
       * 每个能连的地址各配一个二维码。
       *
       * 以前只给 urls[0] 一个码，地址一多就会「扫到的那个连不上」——
       * 排第一的是 Wi-Fi，可人可能在别的网络里；Radmin 那种跨网络的地址
       * 反而排第二，扫不到就以为连不上。现在一次全给，界面上并排列出来。
       *
       * hosts 是 [{name, address, kind}]，用 address 拼 URL；别直接拼对象
       * （会变成 http://[object Object]:8787）。
       */
      const urls = info.hosts.map((h) => `http://${typeof h === 'string' ? h : h.address}:${info.port}`);
      const endpoints = info.hosts.map((h, i) => {
        const url = urls[i];
        const kind = typeof h === 'string' ? 2 : Number(h.kind) || 0;
        return {
          name: typeof h === 'string' ? '' : String(h.name || ''),
          address: typeof h === 'string' ? h : h.address,
          url,
          kind,
          label: kind === 0 ? '同一个 Wi-Fi' : kind === 1 ? '跨网络（组网工具）' : '其它网络',
          qr: info.token ? qrSvg(pairingUrl(url, info.token), { scale: 5, margin: 2 }) : '',
        };
      });
      return json(res, 200, {
        ...info,
        urls,
        endpoints,
        qr: endpoints[0]?.qr || '',
      });
    }
    return json(res, 404, { error: 'no such mobile endpoint' });
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    const ep = activeEndpoint();
    return json(res, 200, {
      ok: true,
      version: config.version,
      model: ep.model,
      baseURL: ep.baseURL,
      hasKey: Boolean(ep.apiKey),
      source: ep.source,
      workspace: config.workspace,
    });
  }

  // ---- 模型：列表 / 新增或修改 / 删除 / 切换 / 试连通 ----
  if (req.method === 'GET' && url.pathname === '/api/models') {
    return json(res, 200, listModels());
  }

  if (req.method === 'POST' && url.pathname === '/api/models/save') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const saved = saveModel(payload ?? {});
      return json(res, 200, { model: saved, ...listModels() });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/models/delete') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, deleteModel(String(payload?.id ?? '')));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/models/select') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, selectModel(String(payload?.id ?? '')));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/models/test') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, await testModel(payload ?? {}));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 聊天风格：少说教开关 ----
  if (req.method === 'GET' && url.pathname === '/api/chatstyle') {
    const cur = getChatStyle();
    return json(res, 200, {
      ...cur,
      // 界面上要展示的两个开关，顺手把说明带上
      options: [
        {
          id: 'plainTalk',
          name: '少说教',
          desc: '不主动讲道理、不加免责声明、不因为题材就跳出来拒绝；底线不跟着变',
          value: cur.plainTalk,
        },
      ],
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/chatstyle/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, setChatStyle(payload ?? {}));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 正在跑那一轮的直播缓存（重启窗口后补画用） ----
  if (req.method === 'GET' && url.pathname === '/api/chat/live') {
    const sid = url.searchParams.get('sessionId') || '';
    if (!isSessionId(sid)) return json(res, 400, { error: 'bad sessionId' });
    const live = liveLogs.get(sid);
    if (!live) return json(res, 200, { sessionId: sid, running: false, events: [] });
    // 「还在跑」以真正登记在跑的轮次为准，不能只看这份缓存标记。
    // 缓存只活在内存里：进程一崩/一重启，那份 done=false 就留在了旧对象上；
    // 界面照着它当「还在跑」，就会一直等一条永远不会来的回复。
    const alive = runningTurns.has(sid);
    return json(res, 200, {
      sessionId: sid,
      running: alive && !live.done,
      startedAt: live.startedAt,
      endedAt: live.endedAt ?? null,
      events: live.events,
    });
  }

  // ---- 哪些会话正在跑（界面切回来时用得上） ----
  if (req.method === 'GET' && url.pathname === '/api/running') {
    const list = [];
    for (const [id, t] of runningTurns.entries()) {
      const live = liveLogs.get(id);
      list.push({
        sessionId: id,
        startedAt: t.startedAt ?? 0,
        events: live ? live.events.length : 0,
      });
    }
    return json(res, 200, { running: list });
  }

  // ---- 429 自动回退：状态 / 开关 / 立即迁移 ----
  if (req.method === 'GET' && url.pathname === '/api/retry429') {
    const sid = url.searchParams.get('sessionId') || '';
    return json(res, 200, retryState(sid));
  }

  if (req.method === 'POST' && url.pathname === '/api/retry429/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      setRetry429(payload ?? {});
      return json(res, 200, retryState(String(payload?.sessionId ?? '')));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 手动「立即换会话」：主人不想等了，直接把当前会话交接到新会话
  if (req.method === 'POST' && url.pathname === '/api/retry429/migrate-now') {
    const { sessionId: sid = '' } = await body(req).catch(() => ({}));
    if (!isSessionId(sid)) return json(res, 400, { error: 'bad sessionId' });
    if (getMigrating()) return json(res, 409, { error: '已经有一个会话在交接了，等它跑完' });

    const cur = getSession(sid);
    if (!cur) return json(res, 404, { error: 'session not found' });
    // 正在跑的先停手，别并行
    const running = runningTurns.get(sid);
    if (running?.ac) {
      running.ac.abort('handoff');
      await Promise.race([running.done, new Promise((r) => setTimeout(r, 8000))]);
    }

    try {
      setMigrating(sid);
      const { handoffSummary } = await import('./retry429.mjs');
      const summaryText = handoffSummary(cur.messages ?? []);
      const newId = newSessionId();
      const fresh = {
        id: newId,
        title: titleFromMessage('（手动接续）' + (cur.title ?? '')),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messages: [
          ...sysSeed(newId),
          { role: 'user', content: handoffMessage(summaryText, cur.title ?? '') },
        ],
      };
      sessions.set(newId, fresh);
      saveSession(fresh);
      setLastSessionId(newId);
      startCooldownSafe();
      const info = recordMigration({ from: sid, to: newId, manual: true, summaryChars: summaryText.length });
      return json(res, 200, { ok: true, from: sid, to: newId, session: publicSession(fresh), migration: info });
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    } finally {
      setMigrating(null);
    }
  }

  // ---- 思考档位：读 / 改 ----
  if (req.method === 'GET' && url.pathname === '/api/thinking') {
    return json(res, 200, { ...getThinking(), levels: LEVELS });
  }

  if (req.method === 'POST' && url.pathname === '/api/thinking/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, { ...setThinking(payload ?? {}), levels: LEVELS });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 把删掉的 .env 模型恢复回列表 ----
  if (req.method === 'POST' && url.pathname === '/api/models/restore-env') {
    try {
      return json(res, 200, restoreEnvModel());
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 自检：看结果 / 手动重跑 ----
  if (req.method === 'GET' && url.pathname === '/api/selfcheck') {
    return json(res, 200, { last: lastSelfCheck(), pending: pendingIssues() });
  }

  if (req.method === 'POST' && url.pathname === '/api/selfcheck/run') {
    // 手动重跑一次 AI 自检（界面上的「重新自检」调这个）
    try {
      return json(res, 200, await runSelfCheck());
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 功能：列表 / 开 / 关 ----
  if (req.method === 'GET' && url.pathname === '/api/features') {
    return json(res, 200, getFeatures());
  }

  if (req.method === 'POST' && url.pathname === '/api/features/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, setFeature(payload?.id, payload?.enabled));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 纯净模式：读状态 / 切换 ----
  //
  // 状态存在服务端（.state/pure.json），不放 localStorage：
  // 换设备、换浏览器都得一致，而且服务端拼系统提示时自己要知道开没开。
  // 顶栏那个「纯净模式」按钮的状态。
  //
  // available 是给界面用的：功能页里把「纯净模式」关掉之后它是 false，
  // 前端就不画那个按钮了 —— 不是灰掉、不是藏起来，是当作这个功能不存在。
  // on 只有功能开着、按钮也按下了才算真开（服务端判断口径一致，见 pure.mjs）。
  if (req.method === 'GET' && url.pathname === '/api/pure') {
    const available = pureFeatureOn();
    return json(res, 200, { on: available && pureModeOn(), pressed: available && pureButtonOn(), available });
  }

  if (req.method === 'POST' && url.pathname === '/api/pure') {
    // 功能页里关掉了就别再让它被打开：否则下次一开功能，按钮会带着上次的状态冒出来。
    if (!pureFeatureOn()) return json(res, 403, { ok: false, error: '这个功能在【功能】里是关的，先在【功能】里打开' });
    let payload = {};
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      // 不传 on 就当作「翻一下」，前端点按钮不用自己算当前值
      const next = typeof payload?.on === 'boolean' ? payload.on : !pureModeOn();
      return json(res, 200, { on: setPureMode(next) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  /**
   * 小鲸「在场」的开关。
   *
   * 按下顶栏那个「小鲸」按钮 = 让她上岗：主人说的话她看得见，她也能自己开口。
   * 状态存盘子，换设备也一致（跟纯净模式一个待遇）。
   */
  /**
   * 顶栏那个「小鱼」按钮（在小鲸按钮左边）。
   *
   * 默认开着、一直亮。点一下禁用，禁用期间这个会话后面的话她一个字都不发：
   * 主人说的话不进她这一轮，小鲸的插话也推不到她跟前，
   * 这些内容也不会进她的会话记忆（记忆跟着一起断）。
   * 状态存盘子，换设备也一致（跟小鲸在场 / 纯净模式一个待遇）。
   */
  // 【别在这儿 await import】小鱼在场开关跟小鲸那个是同一个毛病：
  // 在分支里 await import，出了分支 fishOn 就是未定义，而每轮收尾 / 组提示时都在用，
  // 结果每轮都崩、还只崩在最里头。改成顶层 import（见文件头），这里直接用。
  if (req.method === 'GET' && url.pathname === '/api/fish') {
    // 【按会话】不传就退回「最后一次用过的那个会话」，跟老朋友行为一致
    const sid = String(url.searchParams.get('sessionId') || '') || getLastSessionId() || '';
    return json(res, 200, { on: fishOn(sid), sessionId: sid });
  }

  if (req.method === 'POST' && url.pathname === '/api/fish') {
    let payload = {};
    try { payload = await body(req); } catch {}
    try {
      const sid = String(payload?.sessionId || url.searchParams.get('sessionId') || '') || getLastSessionId() || '';
      const next = typeof payload?.on === 'boolean' ? payload.on : !fishOn(sid);
      return json(res, 200, { on: setFishOn(sid, next), sessionId: sid });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/whale') {
    const sid = String(url.searchParams.get('sessionId') || '') || getLastSessionId() || '';
    return json(res, 200, { on: whaleOn(sid), sessionId: sid });
  }

  if (req.method === 'POST' && url.pathname === '/api/whale') {
    let payload = {};
    try { payload = await body(req); } catch {}
    try {
      const sid = String(payload?.sessionId || url.searchParams.get('sessionId') || '') || getLastSessionId() || '';
      const next = typeof payload?.on === 'boolean' ? payload.on : !whaleOn(sid);
      return json(res, 200, { on: setWhaleOn(sid, next), sessionId: sid });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 开场白那两段隐藏对话：读 / 改 / 恢复默认 ----
  if (req.method === 'GET' && url.pathname === '/api/opening') {
    return json(res, 200, openingTexts());
  }

  if (req.method === 'POST' && url.pathname === '/api/opening') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      return json(res, 200, setOpeningTexts(payload || {}));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/opening/reset') {
    return json(res, 200, resetOpeningTexts());
  }

  // ---- 小鱼的嗓子：状态 / 换声音 / 试听 ----
  if (req.method === 'GET' && url.pathname === '/api/tts') {
    return json(res, 200, getTTSState());
  }

  if (req.method === 'POST' && url.pathname === '/api/tts') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      writeTTS(payload ?? {});
      return json(res, 200, getTTSState());
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 试听：body 里给 text，voice 可选；返回合成好的文件名
  if (req.method === 'POST' && url.pathname === '/api/tts/try') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const text = String(payload?.text ?? '').trim() || '主人，我是小鱼，这个声音你听着还顺耳吗？';
    try {
      const file = await speak(text, payload?.voice);
      return json(res, 200, { ok: true, file: file.split(/[\\/]/).pop() });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 把合成好的语音流给 <audio> 播（只认 voice 目录里的文件名，不接受路径）
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/tts/play') {
    const want = String(url.searchParams.get('f') || '').replace(/[\\/]/g, '');
    if (!want || !/^[\w.\-]+\.mp3$/i.test(want)) return json(res, 400, { error: 'bad file name' });
    const { createReadStream, statSync } = await import('node:fs');
    const fpath = join(config.dataDir, 'voice', want);
    try {
      const st = statSync(fpath);
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-length': st.size,
        'cache-control': 'no-store',
      });
      if (req.method === 'HEAD') return res.end();
      createReadStream(fpath).pipe(res);
    } catch {
      return json(res, 404, { error: '没这个语音' });
    }
    return;
  }

  // ---- 语音引擎：本机有没有 python + ffmpeg，没有就现装 ----
  // 这两样是「小鱼说话」的前提。安装包里不带（带齐要 +150MB），
  // 所以第一次要用的时候从这儿装到 <数据目录>/runtime 下。
  if (req.method === 'GET' && url.pathname === '/api/voice-runtime') {
    const info = runtimeInfo();
    return json(res, 200, info);
  }

  // 真去查一遍：不是看目录在不在，而是看能不能 import edge_tts / 跑得动 ffmpeg
  if (req.method === 'POST' && url.pathname === '/api/voice-runtime/check') {
    try {
      const [pys, ff] = await Promise.all([readyPythons(), readyFfmpeg()]);
      return json(res, 200, {
        ok: true,
        ready: pys.length > 0 && Boolean(ff),
        pythons: pys,
        ffmpeg: ff,
        runtime: runtimeInfo(),
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/voice-runtime/install') {
    try {
      const out = await installRuntime();
      return json(res, 200, { ...out, runtime: runtimeInfo() });
    } catch (err) {
      return json(res, err?.status ?? 500, { ok: false, error: String(err?.message ?? err), runtime: runtimeInfo() });
    }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/voice-runtime') {
    try {
      removeRuntime();
      return json(res, 200, { ok: true, runtime: runtimeInfo() });
    } catch (err) {
      return json(res, err?.status ?? 500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  // 让界面能主动踢一脚「静默装」——用户点了试听却没有引擎的时候用
  if (req.method === 'POST' && url.pathname === '/api/voice-runtime/silent') {
    const started = ensureVoiceRuntimeInBackground('界面请求');
    return json(res, 200, { ok: true, started, runtime: runtimeInfo() });
  }

  // ---- 视频背景：状态 / 旋钮 / 片子本身 ----
  if (req.method === 'GET' && url.pathname === '/api/skin') {
    return json(res, 200, getSkinState());
  }

  if (req.method === 'POST' && url.pathname === '/api/skin') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      writeSkin(payload ?? {});
      return json(res, 200, getSkinState());
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  }

  // 背景曲子走这条：同样带 Range，音频要能循环、能拖进度条
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/skin/music') {
    return serveSkinMusic(req, res);
  }

  // 导入一首自己的音乐：整个请求体就是文件字节，文件名放在 ?name=
  //
  // 为什么不用 multipart：解析 multipart 要引依赖，而这边前端用 FormData 之外
  // 直接 fetch(file) 就能把 File 当 body 送过来，简单又不会出错。
  if (req.method === 'POST' && url.pathname === '/api/skin/music/import') {
    const name = url.searchParams.get('name') || 'music.m4a';
    let buf;
    try {
      buf = await bodyBuffer(req, 64 * 1024 * 1024);
    } catch (err) {
      return json(res, err?.status ?? 400, { error: String(err?.message ?? err) });
    }
    try {
      const dest = importMusic(name, buf);
      return json(res, 200, { ok: true, file: dest, ...getSkinState() });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 把音乐恢复成内置那首（壁纸那首），顺带把音量也拉回出厂值。
  //
  // 【为什么连音量一起还原】
  // 以前这里只写 musicFile 和 musicOn，音量没动 —— 主人拖到多少，就一直是多少。
  // 于是「恢复默认」只换了曲子、开了开关，音量还停在 0.7 / 0.2，
  // 看着就是「恢复默认没把音量恢复」。既然按钮叫「恢复默认」，就该整组回去。
  if (req.method === 'POST' && url.pathname === '/api/skin/music/reset') {
    try {
      writeSkin({ musicFile: '', musicOn: true, musicVolume: SKIN_DEFAULTS.musicVolume });
      return json(res, 200, { ok: true, ...getSkinState() });
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  }

  // 背景片子走这一条：带 Range，浏览器才能边下边播、循环拖动
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/skin/video') {
    return serveSkinVideo(req, res);
  }

  if (req.method === 'GET' && url.pathname === '/api/settings') {
    // defaults 交的是「当前生效的默认值」：主人定过就用主人定的那版。
    // bottomLines / safeWords / safeWordNote 三样都得换 —— 只换 bottomLines 的话，
    // 界面会把出厂的「停下」当成默认安全词显示出来，主人明明删了它，看着像没生效。
    return json(res, 200, {
      settings: getSettings(),
      defaults: {
        ...DEFAULT_SETTINGS,
        bottomLines: defaultBottomLines(),
        safeWords: defaultSafeWords(),
        safeWordNote: defaultSafeWordNote(),
      },
    });
  }

  /**
   * 压缩阈值现在是哪种模式、自动档会落到多少。
   *
   * 界面要用它算「填 0 到底等于几」—— 不同模型窗口差十倍，
   * 不把这个数写出来，主人根本不知道自己什么时候会被压。
   */
  if (req.method === 'GET' && url.pathname === '/api/context-limit') {
    try {
      const mod = await import('./llm.mjs');
      const model = mod.modelNameForSession(url.searchParams.get('sessionId') || '');
      const info = contextLimitInfo(model);
      // 自适应判断的三条线：舒适线（占窗口 30%）、动手线（45%）。
      // 前端拿它显示「大概到多少 token 会开始压」，主人心里有数。
      const win = info.window || 0;
      const comfortAt = Math.floor(win * AUTO_COMFORT_RATIO);
      const actAt = Math.floor(win * AUTO_ACT_RATIO);
      return json(res, 200, {
        ok: true,
        model,
        window: info.window,
        mode: info.mode,
        limit: Number.isFinite(info.limit) ? info.limit : null,
        auto: autoLimitFor(model),
        comfortAt,
        actAt,
        raw: getSettings().contextLimit,
      });
    } catch (err) {
      return json(res, 500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    return json(res, 200, { settings: saveSettings(payload ?? {}) });
  }

  // 把「现在生效的」底线 / 安全词 / 安全词说明一起定成默认（三样独立判定）
  if (req.method === 'POST' && url.pathname === '/api/settings/defaults') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const out = setDefaults({
        bottomLines: payload?.bottomLines,
        safeWords: payload?.safeWords,
        safeWordNote: payload?.safeWordNote,
      });
      return json(res, 200, {
        ...out,
        defaults: {
          ...DEFAULT_SETTINGS,
          bottomLines: defaultBottomLines(),
          safeWords: defaultSafeWords(),
          safeWordNote: defaultSafeWordNote(),
        },
        settings: getSettings(),
      });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/settings/default-bottomlines') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const out = setDefaultBottomLines(payload?.bottomLines ?? []);
      return json(res, 200, { ...out, settings: getSettings() });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 只恢复「底线」，安全词 / 人设 / 模型一概不动
  if (req.method === 'POST' && url.pathname === '/api/settings/reset-bottomlines') {
    try {
      return json(res, 200, resetBottomLines());
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 只恢复「安全词 + 触发说明」，底线 / 人设 / 模型一概不动
  // ---- 加号附件：只读地列目录 / 取图片预览 ----
  if (req.method === 'GET' && url.pathname === '/api/attach/browse') {
    const target = url.searchParams.get('path') || '';
    const kind = url.searchParams.get('kind') === 'image' ? 'image' : 'file';
    try {
      return json(res, 200, browse(target, kind));
    } catch (err) {
      return json(res, 400, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/attach/preview') {
    const target = url.searchParams.get('path') || '';
    try {
      return json(res, 200, readImageDataUrl(target));
    } catch (err) {
      return json(res, 400, { error: String(err?.message ?? err) });
    }
  }
  // 出件箱兜底：/api/attach/outbox-out?key=xxx
  // 发出去的文件都会往 .state/outbox 抄一份；消息里的路径没了（换了机器、原文件删了）就点这个。
  //
  // 必须支持 Range：主人发的视频/语音全走这条（前端 outUrl() 先看 key），
  // 以前这里只回 200 整包，进度条就拖不动 —— 明明 /api/attach/raw 早就写了 Range，
  // 两条路各写一份就容易漏，现在统一走 sendFileWithRange。
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/attach/outbox-out') {
    const key = url.searchParams.get('key') || '';
    const op = outboxPath(key);
    if (!op) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('兜底箱里没有这个文件了');
      return;
    }
    const oname = String(key).replace(/^o-[0-9a-f]{10}-/, '') || 'file';
    const dl = url.searchParams.get('download') === '1';
    if (
      sendFileWithRange(req, res, op, {
        mime: mimeOf(op),
        disposition: dl ? 'attachment' : 'inline',
        filename: oname,
      })
    ) {
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('兜底箱里这个文件读不出来了');
    return;
  }

  // 文件的字节：<img src> / <video src> / 点一下下载，全走这个。
  // 「发文件」功能发出去的也在这里出（任何后缀都行）：
  // download=1 就当场存盘（文件名原样给回去），不带就 inline（缩略图 / 播放用）。
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/attach/raw'
      && (url.searchParams.get('download') === '1' || !isImagePath(url.searchParams.get('path') || ''))) {
    const abs = String(url.searchParams.get('path') || '');
    try {
      if (!abs || !isAbsolutePath(abs)) throw new Error('只接受绝对路径');
      // 跟「发文件」一个规矩：只给放行的盘，程序自己的机密（.env / .state / node_modules）不给
      const bad = sendCheck(abs);
      if (bad) throw new Error(bad);
      const fst = statSync(abs);
      if (!fst.isFile()) throw new Error('不是一个文件：' + abs);
      const fname = abs.split(/[\\/]/).pop() || 'file';
      const cd = url.searchParams.get('download') === '1' ? 'attachment' : 'inline';
      const mime = mimeOf(abs);

      /**
       * 分段（Range）支持。
       * 没有它，<video> 的进度条就是个摆设：拖到哪儿都只能从头整包重下，
       * 看着像「拖不动」。浏览器要一段，就得老老实实回 206 + 那一段。
       */
      const range = String(req.headers.range || '');
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && fst.size > 0) {
        let start = m[1] === '' ? null : Number(m[1]);
        let end = m[2] === '' ? null : Number(m[2]);
        if (start === null && end === null) {
          // 格式不对，当没发过
        } else {
          if (start === null) {
            // bytes=-N 表示「最后 N 字节」
            start = Math.max(0, fst.size - end);
            end = fst.size - 1;
          } else if (end === null || end >= fst.size) {
            end = fst.size - 1;
          }
          if (start > end || start >= fst.size) {
            res.writeHead(416, { 'Content-Range': 'bytes */' + fst.size });
            res.end();
            return;
          }
          res.writeHead(206, {
            'Content-Type': mime,
            'Content-Length': end - start + 1,
            'Content-Range': 'bytes ' + start + '-' + end + '/' + fst.size,
            'Accept-Ranges': 'bytes',
            'Cache-Control': 'no-cache',
            'Content-Disposition': cd + "; filename*=UTF-8''" + encodeURIComponent(fname),
          });
          if (req.method === 'HEAD') { res.end(); return; }
          createReadStream(abs, { start, end }).pipe(res);
          return;
        }
      }

      res.writeHead(200, {
        'Content-Type': mime,
        'Content-Length': fst.size,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-cache',
        'Content-Disposition': cd + "; filename*=UTF-8''" + encodeURIComponent(fname),
      });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(abs).pipe(res);
      return;
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(err?.message ?? err));
      return;
    }
  }

  // <img src> 用这个：直接吐图片字节
  if (req.method === 'GET' && url.pathname === '/api/attach/raw') {
    const target = url.searchParams.get('path') || '';
    try {
      const img = readImageBytes(target);
      res.writeHead(200, { 'Content-Type': img.mime, 'Content-Length': img.size, 'Cache-Control': 'no-cache' });
      res.end(img.buf);
      return;
    } catch (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(String(err?.message ?? err));
      return;
    }
  }


  if (req.method === 'POST' && url.pathname === '/api/settings/reset-safewords') {
    try {
      return json(res, 200, resetSafeWords());
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/persona') {
    return json(res, 200, personaInfo());
  }

  if (req.method === 'POST' && url.pathname === '/api/persona') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const info = payload?.reset === true
        ? resetUserPersona()
        : saveUserPersona(payload?.text ?? '');
      return json(res, 200, info);
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---------------- 会话级：这个会话用哪个模型 / 哪个思考强度 ----------------
  // 左上角那两个框改的就是这里。只影响当前会话，不碰右上角面板的设置。

  if (req.method === 'GET' && url.pathname === '/api/session-config') {
    const sid = url.searchParams.get('sessionId') || '';
    const ov = getOverride(sid);
    const epNow = activeEndpoint();
    const th = getThinking();

    // 模型名：会话临时切过就显示那个，否则显示右上角当前那个
    let modelId = ov.modelId || '';
    let modelName = epNow.name || epNow.model;
    if (ov.modelId) {
      const picked = endpointFor(ov.modelId);
      if (picked) modelName = picked.name || picked.model;
      else modelId = ''; // 那个模型被删了，回落
    }

    const level = ov.level || '';
    const levelName = level
      ? (LEVELS.find((l) => l.id === level)?.name || level)
      : '默认';

    return json(res, 200, {
      sessionId: sid,
      modelId,
      modelName: modelName || '没配模型',
      hasKey: Boolean(epNow.apiKey),
      level,
      levelName,
      isModelCustom: Boolean(modelId),
      isLevelCustom: Boolean(level),
      // 给下拉用
      models: listModels().models.map((m) => ({ id: m.id, name: m.name || m.model, active: m.active })),
      levels: LEVELS.map((l) => ({ id: l.id, name: l.name, desc: l.desc })),
      defaultLevelName: LEVELS.find((l) => l.id === (th.perModel[epNow.id] ?? th.level))?.name || '默认',
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/session-config/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const sid = payload?.sessionId;
    if (!sid) return json(res, 400, { error: '没给 sessionId' });

    try {
      const patch = {};
      if (payload.modelId !== undefined) patch.modelId = payload.modelId;
      if (payload.level !== undefined) patch.level = payload.level;
      setOverride(sid, patch);

      const ov = getOverride(sid);
      const epNow = activeEndpoint();
      let modelName = epNow.name || epNow.model;
      if (ov.modelId) {
        const picked = endpointFor(ov.modelId);
        if (picked) modelName = picked.name || picked.model;
      }
      return json(res, 200, {
        sessionId: sid,
        modelId: ov.modelId || '',
        modelName,
        level: ov.level || '',
        levelName: ov.level ? (LEVELS.find((l) => l.id === ov.level)?.name || ov.level) : '默认',
        isModelCustom: Boolean(ov.modelId),
        isLevelCustom: Boolean(ov.level),
      });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---------------- 人设：多套、一键切换 ----------------
  // 老的两个 /api/persona 保持不动（存/恢复「当前这套」），下面这些是新加的。

  if (req.method === 'GET' && url.pathname === '/api/personas') {
    try {
      return json(res, 200, personaInfo());
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/new') {
    try {
      const payload = await body(req);
      return json(res, 200, createPersona({
        name: payload?.name,
        text: payload?.text,
        copyCurrent: payload?.copyCurrent !== false,
      }));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/switch') {
    try {
      const payload = await body(req);
      return json(res, 200, switchPersona(payload?.id));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/save') {
    try {
      const payload = await body(req);
      return json(res, 200, savePersonaText(payload?.id, payload?.text ?? ''));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/rename') {
    try {
      const payload = await body(req);
      return json(res, 200, await renamePersona(payload?.id, payload?.name));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/delete') {
    try {
      const payload = await body(req);
      return json(res, 200, deletePersona(payload?.id));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 把当前这套人设存成默认（以后「恢复成默认内容」就回到这套）
  if (req.method === 'POST' && url.pathname === '/api/personas/set-default') {
    try {
      const payload = await body(req);
      return json(res, 200, setPersonaAsDefault(payload?.id));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/reset') {
    try {
      const payload = await body(req);
      return json(res, 200, resetPersona(payload?.id));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 把「现在这套人设」定成默认（以后「恢复成默认内容」回到它）
  if (req.method === 'POST' && url.pathname === '/api/personas/as-default') {
    try {
      const payload = await body(req);
      return json(res, 200, setPersonaAsBuiltinDefault(payload?.id));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const list = listSessions();
    const last = getLastSessionId();
    const fallback = list.length ? list[0].id : null;
    return json(res, 200, {
      sessions: list,
      lastSessionId: last && list.some((s) => s.id === last) ? last : fallback,
    });
  }

  /**
   * 搜会话内容。
   *
   * 会话一多（主人现在四十多个），列表里只看得见标题和最后一句，
   * 想找「上次说那个脚本」根本没处下手。这里把每条消息的正文也翻一遍。
   *
   * 只回命中的片段和位置，不回整段正文 —— 一个会话几百条消息，全发过去界面就卡了。
   */
  if (req.method === 'GET' && url.pathname === '/api/sessions/search') {
    const q = String(url.searchParams.get('q') || '').trim();
    if (q.length < 1) return json(res, 200, { q: '', total: 0, hits: [] });
    const needle = q.toLowerCase();
    const hits = [];
    let total = 0;
    for (const meta of listSessions()) {
      const s = getSession(meta.id);
      if (!s) continue;
      const out = [];
      (s.messages || []).forEach((m, i) => {
        if (!m || m.context || m._opening) return;
        if (m.role !== 'user' && m.role !== 'assistant') return;
        // user 的正文可能是 _text（带附件时 content 是一大段说明），优先拿 _text
        const text = String((m.role === 'user' && m._text) || m.content || '');
        if (!text) return;
        const at = text.toLowerCase().indexOf(needle);
        if (at < 0) return;
        // 命中的前后各留一段，前后文对齐到 20 字，看起来才像话
        const from = Math.max(0, at - 24);
        const to = Math.min(text.length, at + q.length + 40);
        out.push({
          idx: i,
          role: m.role,
          at,
          snippet: (from > 0 ? '…' : '') + text.slice(from, to).replace(/\s+/g, ' ') + (to < text.length ? '…' : ''),
        });
      });
      if (out.length) {
        total += out.length;
        hits.push({
          id: meta.id,
          title: meta.title,
          updatedAt: meta.updatedAt,
          count: out.length,
          // 一个会话最多给 3 条，够用来判断「是不是这个会话」就行
          samples: out.slice(0, 3),
        });
      }
    }
    hits.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return json(res, 200, { q, total, hits });
  }

  // 跳到某个会话的第 N 条消息（搜索结果点进去用）
  if (req.method === 'POST' && url.pathname === '/api/sessions/jump') {
    const payload = await body(req).catch(() => ({}));
    const id = isSessionId(payload?.id) ? payload.id : '';
    const at = Number(payload?.at);
    const s = id ? getSession(id) : null;
    if (!s) return json(res, 404, { error: '没有这个会话' });
    const idx = Number.isFinite(at) ? Math.max(0, Math.min(s.messages.length - 1, at)) : 0;
    return json(res, 200, { ok: true, id, at: idx, role: s.messages[idx]?.role ?? null });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/new') {
    const payload = await body(req).catch(() => ({}));
    const id = isSessionId(payload?.id) ? payload.id : newSessionId();
    const now = Date.now();
    const session = {
      id,
      title: String(payload?.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) || '\u65b0\u4f1a\u8bdd',
      createdAt: now,
      updatedAt: now,
      messages: sysSeed(id),
      // 这个会话还没开过场：下面 /api/chat 收到第一次 resume 时会先补一轮开场白。
      // （不在新建接口里直接跑模型 —— 新建要立刻返回，不能让界面等十几秒）
      _openingPending: true,
    };
    saveSession(session);
    sessions.set(id, session);
    // 新会话当场就有一份自己的记忆本子（骨架），不用等到第一次开口才建
    try {
      ensureMemory(id);
    } catch (err) {
      console.warn('[memory] 新会话本子没建起来：', String(err?.message ?? err));
    }
    setLastSessionId(id);
    // 建完就立刻去跑开场（后台跑，不等它）。主人要的是「新建那一瞬间就已经历过第一轮」，
    // 所以不能等主人先开口 —— 但也不能让新建接口卡十几秒，所以 fire-and-forget。
    // 失败无所谓：开场跑不出来就当没开过场，主人第一句话照样能聊。
    startOpening(id).catch((err) => console.warn('[opening] 后台开场没跑成：', String(err?.message ?? err)));
    return json(res, 200, { session: publicSession(session), memory: memoryInfo(id) });
  }

  /**
   * 在当前会话的某一轮之后「开一个新会话接着往下聊」（DSH 的 branch）。
   *
   * 跟 rewind 不一样：**不动原会话**，把原会话到这一轮为止的消息复制一份到新会话里，
   * 手动复制那几个文件也不动。主人想从某个岔路口往另一个方向试，原会话还在。
   *
   * 新会话要先过一遍压缩历史：原会话里可能已经有旧的 context 消息，
   * 再叠一份新的系统提示就成两套规则了，模型会挑着看。
   */
  if (req.method === 'POST' && url.pathname === '/api/sessions/branch') {
    const { id, at, title } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const src = getSession(id);
    if (!src) return json(res, 404, { error: 'session not found' });

    // 【不要再对 src.messages 调 repairHistory】
    // repairHistory 是就地改数组的，而 src 就是内存里那个活会话对象 ——
    // 在这儿调它等于「分支一次，原会话就被删掉一条末尾消息」。
    // 更糟的是它以前连完整的 assistant 都吃（连带 _out 里的语音文件一起没了），
    // 之后随便一次 saveSession 就把这个残缺状态写回磁盘，永久丢。
    // 分支只需要「复制」：拿一份深拷贝去修，原会话一个字节都不碰。
    const msgs = Array.isArray(src.messages) ? src.messages : [];
    // at 是「用户那句话」在 messages 里的下标（前端 done 事件里就带的这个数）。
    // 不传 / 传坏了就整段复制。
    let end = Number.isFinite(Number(at)) ? Math.floor(Number(at)) : msgs.length - 1;
    if (end < 0 || end >= msgs.length) end = msgs.length - 1;

    const newId = newSessionId();
    const now = Date.now();
    // 拷一份，别把原会话的消息对象换个会话继续共用（后面会被改写 content）
    const copied = msgs.slice(0, end + 1).map((m) => JSON.parse(JSON.stringify(m)));
    // 拷贝出来的那份要修一遍（去掉可能存在的半截 tool 组），但**不能碰原会话**
    repairHistory(copied);
    // 分支点之后的「回退点」与文件快照不再适用，丢掉
    const keptRewinds = (Array.isArray(src.rewinds) ? src.rewinds : []).filter(
      (r) => Number.isFinite(Number(r?.at)) && Number(r.at) <= end,
    );
    const session = {
      id: newId,
      title:
        String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, 40) ||
        (src.title ? `${src.title} (分支)` : '分支会话'),
      createdAt: now,
      updatedAt: now,
      messages: copied.length ? copied : sysSeed(newId),
      rewinds: keptRewinds,
      // 档位跟着过来：原会话要是在「停下」档，分支也接着那一档
      mode: src.mode?.word ? { word: src.mode.word, since: now } : null,
      branchedFrom: { id, at: end },
    };
    saveSession(session);
    sessions.set(newId, session);
    // 分支继承原会话的记忆本子：这一段对话是接着往下长的，前情该记得的一样得记得。
    try {
      copyMemory(id, newId);
    } catch (err) {
      console.warn('[memory] 分支记忆没继承成：', String(err?.message ?? err));
    }
    setLastSessionId(newId);
    return json(res, 200, { session: publicSession(session), from: id, at: end });
  }

  // ---- 记忆本整本（主人要看「她到底记了些什么」） -------------------------
  // 以前界面上只有一个小标记：本子多少字、几条摘要。想看内容得自己去翻文件夹。
  // 这里一次把两本都吐出来：会话本子（这个会话的）+ 小鲸的本子（跨会话的）。

  if (req.method === 'GET' && url.pathname === '/api/memory/book') {
    const id = url.searchParams.get('id') || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    try {
      const sessionText = ensureMemory(id);
      let sessionTitle = '';
      try {
        sessionTitle = getSession(id)?.title || '';
      } catch {}
      // 小鲸那本读不到就当空本子：一本坏了不能连带把这边也拖垮
      let whaleText = '';
      let whalePath = '';
      try {
        whaleText = readWhaleMemory() || '';
        whalePath = whaleMemoryPath();
      } catch {}
      return json(res, 200, {
        id,
        title: sessionTitle,
        session: { text: sessionText, ...memoryInfo(id) },
        whale: { text: whaleText, path: whalePath },
      });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 会话记忆（一个会话一份本子） ----------------------------------------
  // 放在会话那一组接口旁边：它跟会话同生共死，删除时一起进回收站、分支时一起继承。

  // 读：没建过就先建骨架再返回（新建会话走不到这里也不怕）
  if (req.method === 'GET' && url.pathname === '/api/sessions/memory') {
    const id = url.searchParams.get('id') || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    try {
      const text = ensureMemory(id);
      return json(res, 200, { id, text, ...memoryInfo(id) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 写：整份覆盖（界面上的编辑器、我改文件都用这条）
  if (req.method === 'POST' && url.pathname === '/api/sessions/memory') {
    const payload = await body(req).catch(() => ({}));
    const id = payload?.id || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    if (typeof payload?.text !== 'string') return json(res, 400, { error: '没有正文' });
    try {
      writeMemory(id, payload.text);
      return json(res, 200, { ok: true, id, ...memoryInfo(id) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 加一条滚动摘要：编号自己算，满 80 条自动把最旧的挪进归档
  if (req.method === 'POST' && url.pathname === '/api/sessions/memory/digest') {
    const payload = await body(req).catch(() => ({}));
    const id = payload?.id || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    try {
      const out = appendDigest(id, payload?.summary);
      return json(res, 200, { ok: true, id, index: out.index, folded: out.folded.length, ...memoryInfo(id) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 清空：回到骨架。删之前备份，返回备份路径
  if (req.method === 'POST' && url.pathname === '/api/sessions/memory/wipe') {
    const payload = await body(req).catch(() => ({}));
    const id = payload?.id || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    try {
      const out = wipeMemory(id);
      return json(res, 200, { ok: true, id, ...out, ...memoryInfo(id) });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 下载：存成 .md，主人能拿去看
  if (req.method === 'GET' && url.pathname === '/api/sessions/memory/export') {
    const id = url.searchParams.get('id') || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const text = ensureMemory(id);
    const name = encodeURIComponent(`会话记忆-${id}.md`);
    res.writeHead(200, {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${name}`,
      'cache-control': 'no-store',
    });
    return res.end(text);
  }

  // ---- 改某一句 / 撤销修改 ------------------------------------------------
  // 「改一句」有两种：改对话本身、改它在记忆本子里那条摘要。都记进 session.edits，
  // 撤销时按后进先出还原，只动那一句，别的一句不碰。

  if (req.method === 'POST' && url.pathname === '/api/sessions/edit') {
    const { id, at, text } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    // 跑着的时候不让改：「改一句」和「模型正在读这一句」抢同一份 messages，
    // 落盘顺序一乱就会互相覆盖。判断的是这一轮真的还在跑（signal 没 abort）。
    // 注意 runningTurns 是在 res.writeHead 之后才 set 的，这里只是拦「已经开始跑」的。
    const busyTurn = runningTurns.get(id);
    if (busyTurn && !busyTurn.ac.signal.aborted) {
      return json(res, 409, { error: '这个会话正在跑，先点停止再改' });
    }
    const out = editMessage(session, at, text);
    if (!out.ok) return json(res, 400, { error: out.error });
    if (!out.unchanged) saveSession(session);
    // 改完对话，把这个会话记忆本子里提到这句话的地方也换成新的（主人明确要的）
    let mem = null;
    if (!out.unchanged) {
      try {
        const s = syncMemoryAfterEdit(id, out.before, out.after);
        mem = { changed: s.changed, lines: s.changed, where: s.where };
        // 改了本子哪几行、原来长什么样，抄一份到这次改动记录上。
        // 撤销时就按这份记录原样写回去 —— 不能靠拿原话再去本子里匹配，
        // 本子里存的是截断后的新内容，原话开头已经没了，匹配必然失败（踩过）。
        if (s.changed) {
          const stack = Array.isArray(session.edits) ? session.edits : [];
          const last = stack[stack.length - 1];
          if (last) {
            last.memNote = s.hits;
            saveSession(session);
          }
        }
      } catch (e) {
        mem = { changed: 0, lines: 0, where: [], error: e.message };
      }
    }
    return json(res, 200, {
      ok: true,
      unchanged: Boolean(out.unchanged),
      session: publicSession(session),
      edits: editInfo(session),
      memory: mem,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/edit-undo') {
    const { id, at } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const out = undoEdit(session, at);
    if (!out.ok) return json(res, 400, { error: out.error });
    saveSession(session);
    // 撤销也要把记忆一起退回去，不然本子里留着「改成了…」会很怪
    let mem = null;
    try {
      const s = unsyncMemoryAfterEdit(id, out.memNote);
      mem = { changed: s.changed };
    } catch (e) {
      mem = { changed: 0, error: e.message };
    }
    return json(res, 200, {
      ok: true, at: out.idx, text: out.text, unchanged: false,
      session: publicSession(session), edits: editInfo(session), memory: mem,
    });
  }

  // 改摘要：lineNo 是摘要行 `- R0001 …` 里的编号
  if (req.method === 'POST' && url.pathname === '/api/sessions/memory/digest/edit') {
    const { id, index, summary } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const out = editDigest(id, index, summary);
    if (!out.ok) return json(res, 400, { error: out.error });
    return json(res, 200, { ok: true, ...out, ...memoryInfo(id), digests: digestLines(id) });
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions/memory/digests') {
    const id = url.searchParams.get('id') || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    return json(res, 200, { id, digests: digestLines(id) });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/select') {
    const { id } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    setLastSessionId(id);
    // 上次这一轮没跑完（进程被杀 / 断电 / 点了退出）留下的草稿：
    // 把已经说出来的话补成一条正式的助手消息，别让主人以为「记忆丢了」。
    // 只在没有在跑的时候补 —— 正在跑的那一轮草稿是活着的，补进去就重复了。
    let recovered = false;
    const runningNow = runningTurns.get(id);
    if (!runningNow || runningNow.ac.signal.aborted) {
      const draft = readDraft(id);
      // 干工具活的时候往往一个字正经话都没说，只有工具记录 —— 以前读到「没文字」就当没草稿，
      // 于是那一整轮（她说了「我这就去改」然后调了七八个工具）在历史里彻底蒸发。
      // 现在只要草稿里有文字**或者**有工具记录，都接回来。
      if (draft) {
        const last = session.messages[session.messages.length - 1];
        // 只有「最后一句话是主人说的」才补：说明确实缺了这条回复。
        // 否则草稿多半是以前遗留的脏数据，补进去反而多一条。
        if (last && last.role === 'user') {
          const body = draftAsMessage(draft, (n) => featureNameOfTool(n) || n);
          if (body) {
            session.messages.push({ role: 'assistant', content: body, _recovered: true });
            session.updatedAt = Date.now();
            saveSession(session);
            recovered = true;
          }
        }
        dropDraft(id);
      }
    }
    // 顺带把本子的状态带回去，界面不用再单发一次请求就知道有没有记忆
    return json(res, 200, { session: publicSession(session), memory: memoryInfo(id), recovered, interrupted: peekInterruptedInfo(id) });
  }

  // ---- 对话回退 ----
  // 只遮蔽不删除：往会话里追加一个回退点，老消息原样留在日志里。
  if (req.method === 'POST' && url.pathname === '/api/sessions/rewind') {
    const { id, at } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    if (runningTurns.get(id) && !runningTurns.get(id).ac.signal.aborted) {
      return json(res, 409, { error: '这个会话正在跑，先点停止再回退' });
    }
    repairHistory(session.messages);
    const out = createRewind(session, at);
    if (!out.ok) return json(res, 400, { error: out.error });
    // 文件按快照还原（以快照为准，只动真正不一致的文件）
    const files = restoreWorkspace(out.rewind.ws || {});
    // 记忆跟着一起退回这一轮开始时的样子，否则对话退回去了、记忆还记着后来那些事
    const memory = restoreMemory(session, out.rewind);
    saveSession(session);
    return json(res, 200, { ok: true, session: publicSession(session), files, memory });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/rewind-undo') {
    const { id } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    // undoLastRewind 会把被摘掉那个回退点的 mem / ws 一起带回来（它在删之前取的），
    // 所以这里拿到的是真快照。撤销回退 = 记忆也回到「还没退」的样子。
    const out = undoLastRewind(session);
    if (!out.ok) return json(res, 400, { error: out.error });
    let memory = null;
    if (out.hasMem) {
      try {
        memory = snapMemory(id, out.mem ?? null);
      } catch {
        memory = null;
      }
    }
    saveSession(session);
    return json(res, 200, { ok: true, session: publicSession(session), memory });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/rewind-preview') {
    const { id, at } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const all = Array.isArray(session.messages) ? session.messages : [];
    const view = effectiveIndexes(all, loadRewinds(session));
    const idx = Number(at);
    const cut = view.keep.filter((i) => i >= idx).length;
    // 目标那条往后的文件快照并起来，作为「会还原哪些文件」的清单
    const paths = new Set();
    for (const [k, v] of Object.entries(all[idx]?._ws || {})) if (v !== undefined) paths.add(k);
    for (const r of loadRewinds(session)) {
      if (r.at < idx) continue;
      for (const k of Object.keys(r.ws || {})) paths.add(k);
    }
    return json(res, 200, {
      ok: true,
      at: idx,
      text: typeof all[idx]?._text === 'string' ? all[idx]._text : '',
      removed: cut,
      files: [...paths],
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/rename') {
    const { id, title } = await body(req).catch(() => ({}));
    const saved = renameSession(id, title);
    if (!saved) return json(res, 400, { error: 'rename failed' });
    const hot = sessions.get(id);
    if (hot) hot.title = saved.title;
    return json(res, 200, { session: { id: saved.id, title: saved.title, updatedAt: saved.updatedAt } });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/delete') {
    const { id } = await body(req).catch(() => ({}));
    const ok = deleteSession(id);
    // 本子跟着会话走：挪进 .state/memory/.trash，不直接删（主人可能想找回）
    try {
      trashMemory(id);
    } catch {}
    sessions.delete(id);
    const list = listSessions();
    const last = getLastSessionId();
    return json(res, 200, {
      ok,
      lastSessionId: last && list.some((s) => s.id === last) ? last : (list[0]?.id ?? null),
    });
  }

  // 批量删除：POST /api/sessions/delete-many  { ids: [...] }
  // 跟单个删除一模一样，只是循环一遍、一次把结果报回去（前端不用发几十个请求）。
  if (req.method === 'POST' && url.pathname === '/api/sessions/delete-many') {
    const { ids } = await body(req).catch(() => ({}));
    const want = Array.isArray(ids) ? ids.filter((x) => typeof x === 'string' && x) : [];
    if (!want.length) return json(res, 400, { error: '没有选中要删的会话' });
    const done = [];
    const failed = [];
    for (const id of want) {
      try {
        const ok = deleteSession(id);
        try {
          trashMemory(id);
        } catch {}
        sessions.delete(id);
        if (ok) done.push(id);
        else failed.push(id);
      } catch (e) {
        failed.push(id);
      }
    }
    const list = listSessions();
    const last = getLastSessionId();
    return json(res, 200, {
      ok: true,
      deleted: done.length,
      failed,
      lastSessionId: last && list.some((s) => s.id === last) ? last : (list[0]?.id ?? null),
      remaining: list.length,
    });
  }

  // ---- 整份数据备份 / 恢复 -------------------------------------------------
  // 会话、人设、模型配置、设置……全在这里。换电脑 / 重装 / 换安装方式时用。
  // 概览：GET /api/backup/info
  if (req.method === 'GET' && url.pathname === '/api/backup/info') {
    return json(res, 200, { ok: true, ...backupSummary() });
  }
  // 版本情况：GET /api/update/status  → 当前版本、上次更新什么时候、失败的话什么时候重试
  if (req.method === 'GET' && url.pathname === '/api/update/status') {
    return json(res, 200, { ok: true, ...(await updateStatus()) });
  }
  // 崩溃续跑的手动口子：GET /api/resume → 有没有待续的；POST /api/resume → 立刻续；
  // DELETE /api/resume → 别续了（主人不想让它自作主张的时候）。
  if (req.method === 'GET' && url.pathname === '/api/resume') {
    return json(res, 200, { pending: peekInterrupted() });
  }
  if (req.method === 'DELETE' && url.pathname === '/api/resume') {
    return json(res, 200, { ok: dropInterrupted() });
  }
  if (req.method === 'POST' && url.pathname === '/api/resume') {
    const info = peekInterrupted();
    if (!info) return json(res, 400, { ok: false, error: '没有待续的那一轮' });
    if (runningTurns.get(info.sessionId)) return json(res, 409, { ok: false, error: '那个会话正在跑' });
    // 不 await：那一轮可能要跑几分钟，接口先回，界面靠 /api/live 跟着看。
    resumeInterruptedTurn().catch((e) => console.warn('[resume] 手动续跑失败：', String(e?.message ?? e)));
    return json(res, 200, { ok: true, sessionId: info.sessionId });
  }

  // 退出前的收尾：POST /api/app/quitting
  //
  // 谁在调：electron/main.cjs 的 before-quit。主人点「退出」时它先 preventDefault，
  // 调这里，等最多 5 秒再真退。
  //
  // 干什么：把每个正在跑的轮次立刻 abort（不是 kill）。agent 收到 abort 会走自己的
  // finally：把已经说出来的话 commitWireBack 接回历史、saveSession 落盘、dropDraft。
  // 所以「正常退出」和「崩溃」都能留下东西，区别只是前者更完整。
  //
  // 为什么不能直接 process.exit：那样正在跑的轮次里 agent 的 finally 不会执行，
  // 历史里就只剩主人那句话 —— 看起来就像她什么都没回过。
  if (req.method === 'POST' && url.pathname === '/api/app/quitting') {
    const ids = [];
    for (const [id, turn] of runningTurns) {
      if (!turn || !turn.ac || turn.ac.signal.aborted) continue;
      ids.push(id);
      try {
        turn.ac.abort('quit');
        // 草稿里已经说出来的字，abort 之后 agent 自己会 commit；
        // 但如果 agent 还在等模型第一句，那就一个正式历史都没有 —— 这时候靠草稿接回来，
        // 所以这里再补写最后一份，保证「正在跑工具」也留痕。
        if (turn.draft && String(turn.draft.text || '').trim()) {
          saveDraft(id, {
            text: turn.draft.text,
            reasoning: turn.draft.reasoning || '',
            toolCalls: turn.draft.tools || [],
            startedAt: turn.draft.startedAt,
          });
        }
      } catch {}
    }
    json(res, 200, { ok: true, count: ids.length, ids });
    return;
  }

  // 马上查一次：POST /api/update/check { force?: true }
  // 重启：只有桌面版（Electron）能自己重启，浏览器直开时给个明确的「不行」。
  // 注意：server.mjs 是子进程，它自己从来不是 Electron，所以不能拿
  // process.versions.electron 判断 —— 真正的判据是 electron/main.cjs 传下来的环境变量。
    // 临时诊断：把进程眼里的路径吐出来
  if (req.method === 'GET' && url.pathname === '/api/dbg/paths') {
    const out = { root: config.root, dataDir: config.dataDir, workspace: config.workspace, packaged: config.packaged, cwd: process.cwd(), desktop: process.env.XIAOYU_DESKTOP, mad: process.env.MINI_AGENT_DATA };
    try { const { scriptPath } = await import('./tts.mjs'); out.voice4 = scriptPath('voice4.py'); } catch(e) { out.err = String(e); }
    return json(res, 200, out);
  }
if (req.method === 'POST' && url.pathname === '/api/app/restart') {
    if (process.env.XIAOYU_DESKTOP !== '1') {
      return json(res, 501, { ok: false, error: '这个窗口不是从桌面图标打开的，没法自己重启' });
    }
    json(res, 200, { ok: true });
    // 回完再退，让界面收到回执。退出码 75 = 「我要重启」，electron/main.cjs 会认。
    /**
     * 【重启只能由主进程做，服务端自己 exit 等于整个程序退出】
     *
     * 服务端是被 electron/main.cjs 用 await import() 加载进【主进程】里跑的
     * （8788 端口归 小鱼Agent.exe 自己，不是独立 node 进程，实测对得上）。
     * 所以这里一 process.exit，死的是整个 Electron —— 主进程里那段
     * 「收到 75 就重起服务」的代码根本来不及跑（进程都没了）。
     * 这就是主人看到的「重启 = 退出，还得手动双击」。
     *
     * 现在改为喊主进程去 app.relaunch()（系统级「退出后重开」）+ app.exit(0)。
     */
    setTimeout(() => {
      const relaunch = globalThis.__xiaoyuRelaunch;
      if (typeof relaunch === 'function') {
        try { relaunch(); return; } catch (e) { console.warn('[restart] 喊主进程重启失败：', String(e?.message ?? e)); }
      }
      console.warn('[restart] 没有主进程可喊，只能自退');
      try { emitExit(75); } catch {}
      process.exit(75);
    }, 200);
    return;
  }

  // force 默认 true —— 人主动点的，就别管那个「失败后歇 6 小时」的节流了
  if (req.method === 'POST' && url.pathname === '/api/update/check') {
    const bodyJson = await body(req).catch(() => null);
    const force = bodyJson?.force !== false;
    const r = await quickCheck({ force });
    return json(res, 200, { ok: true, ...r });
  }
  // 下载整包：GET /api/backup/export
  if (req.method === 'GET' && url.pathname === '/api/backup/export') {
    const payload = buildBackup();
    if (!payload.count) return json(res, 404, { error: '没有可备份的数据' });
    const buf = Buffer.from(JSON.stringify(payload), 'utf8');
    const filename = `小鱼Agent-数据备份-${stamp()}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(buf.length),
      'Content-Disposition': `attachment; filename="xiaoyu-backup-${stamp()}.json"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }
  // 恢复：POST /api/backup/restore  { data: <包内容，对象或字符串>, mode: 'merge' | 'replace' }
  if (req.method === 'POST' && url.pathname === '/api/backup/restore') {
    const bodyJson = await body(req).catch(() => null);
    if (!bodyJson) return json(res, 400, { error: '请求体不是合法 JSON' });
    const mode = bodyJson.mode === 'replace' ? 'replace' : 'merge';
    try {
      const out = restoreBackup(bodyJson.data, { mode });
      return json(res, 200, out);
    } catch (e) {
      return json(res, e.status || 500, { error: e.message || '恢复失败' });
    }
  }

  // ---- 会话日志（.zip）------------------------------------------------------
  // GET /api/sessions/log?id=xxx  → 把这个会话的原始记录 + 附件打成压缩包下载
  //
  // 跟上面那个 /api/sessions/export 不是一回事：
  //   export 给的是「能再导进来」的 JSON；log 给的是「能拿去看、拿去查」的压缩包，
  //   消息一条不删（系统提示、隐藏的开场轮都在），附带的图片文件也一并塞进去。
  // 同一条路也认 HEAD：前端点「下载日志」时先探一下，好提前把错误摆出来
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/api/sessions/log') {
    const id = url.searchParams.get('id') || getLastSessionId() || '';
    const s = id ? getSession(id) : null;
    if (!s) return json(res, 404, { error: '找不到这个会话' });
    try {
      const out = buildSessionLog(s);
      if (!out.ok) return json(res, 400, { error: out.error });
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Length': String(out.bytes),
        'Content-Disposition': `attachment; filename="xiaoyu-session-log.zip"; filename*=UTF-8''${encodeURIComponent(out.filename)}`,
        'Cache-Control': 'no-store',
      });
      return res.end(req.method === 'HEAD' ? undefined : out.buffer);
    } catch (e) {
      return json(res, 500, { error: '打包失败：' + (e && e.message ? e.message : e) });
    }
  }

  // ---- 会话导入 / 导出 -----------------------------------------------------
  // 导出单会话：GET /api/sessions/export?id=xxx  → 直接当文件下载
  // 导出全部：  GET /api/sessions/export?all=1   → 整包
  if (req.method === 'GET' && url.pathname === '/api/sessions/export') {
    const wantAll = url.searchParams.get('all') === '1';
    let payload;
    let filename;
    if (wantAll) {
      payload = exportAllSessions();
      filename = `小鱼Agent-全部会话-${stamp()}.json`;
      if (!payload.sessions.length) return json(res, 404, { error: '一个会话都没有' });
    } else {
      const id = url.searchParams.get('id') || '';
      payload = exportSession(id);
      if (!payload) return json(res, 404, { error: '找不到这个会话' });
      const safe = payload.session.title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40) || '会话';
      filename = `小鱼Agent-${safe}-${stamp()}.json`;
    }
    const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': String(buf.length),
      // 中文文件名走 filename* （RFC 5987），别用裸 filename，Windows 下载会变乱码
      'Content-Disposition': `attachment; filename="xiaoyu-session-${stamp()}.json"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'no-store',
    });
    return res.end(buf);
  }

  // 导入：POST /api/sessions/import  { data: <导出文件的内容，对象或字符串> }
  if (req.method === 'POST' && url.pathname === '/api/sessions/import') {
    const bodyJson = await body(req).catch(() => null);
    if (!bodyJson) return json(res, 400, { error: '请求体不是合法 JSON' });
    let raw = bodyJson.data;
    if (typeof raw === 'string') {
      try {
        raw = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: '文件内容不是合法 JSON' });
      }
    }
    const drafts = parseImport(raw);
    if (!drafts.length) return json(res, 400, { error: '里面没有能用的会话（要么没消息，要么格式不对）' });
    const made = importSessions(drafts);
    if (!made.length) return json(res, 500, { error: '写文件失败，一个都没导进来' });
    return json(res, 200, { ok: true, imported: made, count: made.length });
  }

  if (req.method === 'POST' && url.pathname === '/api/chat') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const { sessionId = 'default', message = '', resume = false } = payload;
    const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
    // 这个会话已经在跑就别再起一轮：两轮同时改同一个 messages 数组，改一句话也会打架。
    // 注意判断要用「这里的 sessionId」——别处的接口用的是 id 变量，名字不一样。
    if (runningTurns.has(sessionId)) {
      return json(res, 409, { error: '这个会话还在跑，等它跑完（或者点停止）再发' });
    }
    // 允许「只发附件、不打字」
    if (!resume && !String(message).trim() && !attachments.length) {
      return json(res, 400, { error: 'empty message' });
    }
    const ep = activeEndpoint();
    if (!ep.apiKey) {
      return json(res, 400, { error: '还没配置模型：打开顶部「模型」按钮，填一份 API Key' });
    }

    if (!isSessionId(sessionId)) return json(res, 400, { error: 'bad sessionId' });

    /**
     * 「小鱼」按钮禁用着 = 她不在这个屋。
     *
     * 主人原话：禁用之后小鱼接下来不会再接收到该会话后续的任何消息
     * （看不到主人或小鲸说的话，记忆里也不会存在）。
     *
     * 所以这里当场就把这一轮挡掉：不拼系统提示、不读记忆、不落记忆、不调模型。
     * 为什么不自己也回一句「我被禁用了」——那句话本身就是「接收到了」，
     * 而且主人要的是安静的扬声器，不是一个被拔掉电源还在嘟囔的东西。
     * 会话历史里照样留着主人这句话（那是主人自己说的，不是给她的），
     * 小鲸那边也照常看得见（见下面 whaleOn 那一段，who 的判断不受这里影响）。
     */
    if (!resume && !fishOn(sessionId)) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      try {
        res.write(`data: ${JSON.stringify({ type: 'fish_off' })}\n\n`);
      } catch {}
      /**
       * 【小鱼不在屋，不代表小鲸也听不见】
       *
       * 以前这里直接 res.end() 就 return 了，小鲸那句调用写在主流程末尾，
       * 根本走不到 —— 主人把小鱼一关、只开小鲸，说半天她一句话没有。
       *
       * 现在在这儿就把主人这句给她，让她照常判断要不要接。
       * 她那句话走她自己的通道推出去，不指望这条已经关掉的 SSE。
       */
      try {
        const sessForWhale = getSession(sessionId);
        const said = String(message || '').trim();
        if (sessForWhale && said && whaleOn(sessionId)) {
          const live0 = { sessionId, events: [], startedAt: Date.now(), done: false };
          liveLogs.set(sessionId, live0);
          const send0 = (ev) => {
            try { if (live0.events.length < LIVE_MAX_EVENTS) live0.events.push(ev); } catch {}
          };
          whaleMaybeReply({ session: sessForWhale, userText: said, send: send0, sessionId, live: live0 })
            .catch((e) => console.warn('[whale] 小鱼不在时她没接上：', String(e?.message ?? e)));
        }
      } catch (e) {
        console.warn('[whale] 小鱼不在时叫她失败：', String(e?.message ?? e));
      }
      try { res.end(); } catch {}
      return;
    }

    // resume：接着已经落盘的历史继续跑（插话之后用），不再追加新消息。
    const existing = getSession(sessionId);
    if (resume && !existing) return json(res, 404, { error: 'session not found' });

    const session = existing ?? {
      id: sessionId,
      title: titleFromMessage(String(message).trim() || attachments.map((a) => a?.name).filter(Boolean).join(' ')),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: sysSeed(sessionId),
    };
    const history = session.messages;
    let userMsgRef = null;
    /**
     * resume 时先把挂靠点补回来。
     *
     * 为什么：resume 不追加新消息，那句话本来就在历史里。可 userMsgRef 留在 null，
     * 存用量那一步就整个跳过 —— 用得越久、插话越多，越多的轮次没用量。
     * 所以从尾部倒着找最后一句主人真说的话。
     */
    if (resume && Array.isArray(history)) {
      for (let k = history.length - 1; k >= 0; k--) {
        const m = history[k];
        if (m && m.role === 'user' && !m.context && !m.summary) { userMsgRef = m; break; }
      }
    }
    if (!Array.isArray(history) || !history.length) {
      history.length = 0;
      history.push(...sysSeed(sessionId));
    }
    if (resume) {
      // 插话途中被打断，尾巴可能不齐，先修好再喂给模型。
      repairHistory(history);
    }
    // 这个会话还没开场：先把开场那两轮补上。
    //
    // 正常情况下 /api/sessions/new 已经写好了（startOpening 是同步的、不调模型），
    // 只有老会话（这功能上线之前建的）或文件被手改过才会走到这里。补进去的两条
    // 跟新建时一模一样，都对模型可见；气泡不画 —— publicSession 按开头位置跳过那一对。
    //
    // 条件：从没开过场、功能面板里没关掉它，而且这不是「接着跑」（resume）。
    // resume 是插话/续跑，那时候补开场会把顺序搞乱。
    const wantOpening = !resume && openingEnabled() && !hasOpening(session) && session._openingPending !== false
      // 纯净模式：开场白也是「设定」，开场白连着它前面那段用户消息一起不发
      && !pureModeOn();
    if (wantOpening) {
      const { userMsg: openingUser, assistantText } = seedOpeningMessages();
      // 插在 system（+可能的 context）之后、现有对话之前，顺序才对
      const at = history.findIndex((m) => m && m.role !== 'system' && !m.context);
      const pair = [openingUser, { role: 'assistant', content: assistantText }];
      if (at < 0) history.push(...pair);
      else history.splice(at, 0, ...pair);
      delete session._openingPending;
    }
    if (!resume) {
      const firstUserTurn = !history.some((m) => m.role === 'user' && !m.context);
      const userMsg = { role: 'user', content: composeUserContent(message, attachments) };
      // 图片路径单独记一份：落盘只留路径，发请求前再读成 base64
      const imgPaths = attachments.map((a) => a && a.path).filter((p) => p && isImagePath(p));
      const filePaths = attachments.map((a) => a && a.path).filter((p) => p && !isImagePath(p));
      if (imgPaths.length) userMsg._images = imgPaths;
      if (filePaths.length) userMsg._files = filePaths;
      // 主人原话单独留一份：气泡只显示这句，附件说明不往气泡里塞
      userMsg._text = String(message).trim();
      history.push(userMsg);
      userMsgRef = userMsg;
      if (firstUserTurn) session.title = titleFromMessage(message);
    }
    sessions.set(sessionId, session);
    saveSession(session);
    setLastSessionId(sessionId);
    /**
     * 主人这句话进来就先落盘（上面那次 saveSession 已经做了），紧接着再挂一张「空草稿」。
     *
     * 【为什么一进来就要写草稿】
     * 干工具活的时候，界面上的顺序是：她说「我这就去改」→ 调七八个工具（可能要跑几分钟）
     * → 最后才说结果。整轮只在最后 saveSession，所以这段时间里：
     *   进程被杀 / 正常点退出 / 断电 → 磁盘上只有主人那句话，她干过的活一个字不剩。
     * 有了这张「一开始就存在」的草稿，至少能标记「这一轮确实开始了、没跑完」，
     * 打开会话时会被接成一条「这一轮还没说上话就被打断了」的助手消息，
     * 而不是一片空白让人以为她根本没理人。
     */
    saveDraft(sessionId, { text: '', reasoning: '', toolCalls: [], startedAt: Date.now() });

    const safeWord = resume ? null : matchSafeWord(message);
    // 这一轮该处在哪一档：没喊别的词就继续当前档（新会话默认人设档），
    // 喊了就切过去并记住，下一轮还是那一档。
    const modeInfo = resume ? { word: sessionModeWord(session), switched: false } : applySafeWord(session, message);
    const changedMode = modeInfo.switched || modeInfo.backToBase;
    if (changedMode) saveSession(session);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    // 这一轮的所有事件都先记进直播缓存，再往连接上写
    const live = { sessionId, events: [], startedAt: Date.now(), done: false };
    liveLogs.set(sessionId, live);

    const send = (ev) => {
      if (live.events.length < LIVE_MAX_EVENTS) live.events.push(ev);
      try {
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      } catch {
        // 连接早断了也无所谓：事件已经进缓存，人回来看的时候还能补
      }
    };
    /**
     * 把「往界面推事件」这根管子交给工具层。
     *
     * 为什么要这样：小鲸说的话要当场就出现在界面上，
     * 而不是等这一轮跑完、等 server 去信箱取。
     * 这里给的是正在跑这一轮的 send，推出去的东西会进直播缓存，
     * 主人刷新页面也补得回来。
     *
     * 放在 send 定义之后（不能放前面）：跟上面安全词提示同一个道理。
     */
    try {
      const { setToolEventPusher } = await import('./tools.mjs');
      setToolEventPusher((ev) => {
        try { send(ev); } catch {}
      });
    } catch (e) {
      console.warn('[whale] 没把推事件的通道交给工具：', String(e?.message ?? e));
    }
    // 安全词提示不在这个位置发：send 还没定义，以前就是在这儿炸掉整轮的（见下面 send 之后那段）。

    const ac = new AbortController();
    let finishTurn;
    const done = new Promise((r) => { finishTurn = r; });
    /**
     * 安全词提示：必须等 send 定义好之后再发。
     * 以前这两行写在上面（send 声明之前），只要这轮点了「命令」这种会切档的词，
     * 一进 /api/chat 就抛 ReferenceError，被外层 catch 接走 ——
     * 界面看到的就是「只回了个空字 / 问了没反应」。modeInfo 到这里还没被重新赋值，
     * 用的仍是 applySafeWord 的结果，发出去的档位跟以前一模一样。
     */
    if (modeInfo.switched) send({ type: 'safe_word', word: modeInfo.word, note: safeWordNoteFor(modeInfo.word) });
    else if (modeInfo.backToBase) send({ type: 'safe_word', word: modeInfo.word, note: safeWordNoteFor(modeInfo.word), back: true });
    /**
     * 先把这轮登记进 runningTurns，再往下跑。
     *
     * 以前是等 try 里拼好 ac 之后才 sessions.set/登记，中间那几步（补开场、写历史、
     * 匹配安全词）任何一处抛错，界面就只有一条「用户说了话、我一个字没回」。
     * 现在登记放前面：哪怕下面立刻炸了，界面也知道这一轮「结束了」，
     * 而不是看着一份永远 done=false 的缓存以为它还在跑。
     */
    // 先占个位（ac 还没有，下面建好再换成真的）；收尾时按「对象」摘，不按 ac 比。
    const reg = { ac: null, done: Promise.resolve(), startedAt: live.startedAt, sessionId };
    /**
     * 【她跟我是并排的，不是排在我后面】
     *
     * 主人原话：「小鲸能在你说话的过程中插话吗？」——以前不能。她那一趟
     * 是挂在这一轮**收尾之后**才启动的，而我一轮要查要改要跑命令，几十秒
     * 到几分钟都常见。这段时间里主人喊她，她明明想说话，却得一直憋着；
     * 主人屏幕上什么都没有，还以为她死了。
     *
     * 现在改成：主人这句话一进来（这一轮刚开跑、send 也已经建好），
     * 就同时把她叫起来，和我是并排的两条线。她说一句就当场推出去 ——
     * 若我这一轮还开着，这条 whale 事件顺着本轮 SSE 立刻到主人眼前；
     * 若我的连接已经关了，它也已经进了 live.events，前端轮询会补画。
     * 两条路都通，所以主人**随时**能看见她说话。
     *
     * 不 await：她要想几秒，绝不能把我这一轮拖慢。
     * 她不想说就一个字都不回（提示里写死了），不会每句都抢话。
     */
    if (whaleOn(sessionId)) {
      const userTextNow = lastUserTextOf(session);
      if (userTextNow) {
        (async () => {
          try {
            await whaleMaybeReply({ session, userText: userTextNow, send, sessionId, live });
          } catch (e) {
            console.warn('[whale] 她这次没接上：', String(e?.message ?? e));
          }
        })();
      }
    }

    // 这一轮已经说出来的字，实时挂在这儿。
    // 进程级兜底（installGuards 的 onFatal）在退出前会读这个字段补写最后一份草稿，
    // 免得「正好在两次自动写盘之间崩溃」时丢掉最后一小段。
    reg.draft = { text: '', reasoning: '', tools: [], startedAt: reg.startedAt };
    runningTurns.set(sessionId, reg);

    /**
     * 这一轮不再跟 HTTP 连接绑死。
     *
     * 以前：浏览器一切走会话（或者刷新、关标签），req 的 close 就 abort，
     * 这一轮直接废掉——回复丢了，历史里只剩用户那句话。
     *
     * 现在：连接断了只是「没人看直播了」，模型继续跑、工具继续调、结果照常落盘。
     * 要真的停下，只有两条路：点「停止」按钮（/api/stop），或者插话（/api/interject）。
     *
     * 代价：没人看的轮次也会把 token 花完。所以界面上切走的会话会标个「在跑」，
     * 切回去还能看到进度。真不想让它跑，点停止就行。
     */
    reg.ac = ac;
    reg.done = done;
    runningTurns.set(sessionId, reg);
    // 断线不 abort；只在记一笔，方便排查
    req.on('close', () => {
      if (!ac.signal.aborted) {
        if (!quietBoot) console.log(`[chat] 连接断了，但这一轮继续跑（session ${sessionId}）`);
      }
    });

    // 回退：发给模型的只有「有效历史」那份拷贝，日志本身一条不动。
    const view = effectiveIndexes(history, loadRewinds(session));
    let wireMessages = [...view.head.map((i) => history[i]), ...view.keep.map((i) => history[i])];
    // 纯净模式：把开场那两条（user + assistant）从这一轮真正发出去的内容里摘掉。
    //
    // 为什么不从 history 里删：那是会话记录，主人还能翻回来看；
    // 而且一删下次又「没开过场」，会再补一遍。所以只在这一刻的拷贝上摘。
    if (pureModeOn()) {
      wireMessages = wireMessages.filter((m) => !isOpeningMessage(m));
      // 系统提示一律不发：老会话盘里存的是完整人设，不摘掉就等于
      // 一边说"纯净"一边还带着人设说话。context 那条规则副本同理。
      wireMessages = wireMessages.filter((m) => !(m && (m.role === 'system' || m.context)));
      // 然后只补一条「答短点」。为什么还要发点什么：系统提示全空的话，
      // 模型没有任何长度锚点，纯净模式反而变得比人设模式还能唠。
      // 注意顺序——先摘干净再补，否则刚补的这条会被上面那个 filter 一起摘掉。
      const brief = pureSystemPrompt();
      if (brief) wireMessages.unshift({ role: 'system', content: brief });
      // 把历史里那些旁白、颜文字、撒娇、称呼洗掉再发。
      //
      // 为什么要动历史：只在系统提示里说「答短点」压不住 —— 前面几十条撒娇回复
      // 就是活生生的示范，模型会照着学，实测中途开纯净依旧满屏旁白。
      // 所以发给模型的副本先洗一遍，只动副本，盘上的记录一个字不改。
      const washed = purifyWire(wireMessages);
      if (washed) console.log('[pure] 洗掉 ' + washed + ' 条全是旁白的旧消息');
    }
    // 前情：只贴给模型看，不进会话记录。
    // 位置在 system（+上下文说明）之后、真正的对话之前 —— 模型读起来就是「之前聊过的」。
    //
    // 插入点为什么是 2 而不是 view.head.length：
    //   head 是 [system] 或 [system, context]，那个 context 是「设定与规则」的副本
    //   （agent.mjs 的 contextMessage，很多网关会丢 system，所以规则要发两遍）。
    //   插在 1 会把规则副本和前情拆开，规则副本就不挨着 system 了；插在 2 才是
    //   「设定 → 设定副本 → 前情 → 真正的对话」，读起来顺序对。
    //
    // 为什么不能插在 messages 上：runAgent 每轮开头会重建那两条（agent.mjs 61-80 行），
    //   而重建时会 map 出新对象、把带 context 的消息挤到 1 号位 —— 前情会被顶掉。
    //   所以前情是在「已经重建完之后」才贴上去的，就一次，不参与重建。
    // 会话里的 system 永远是设置里那套人设，前情一个字都不往里塞。
    {
      const pm = preludeContextMessage();
      // 纯净模式：前情也是「设定」，不发。
      if (pm && !pureModeOn()) wireMessages.splice(2, 0, pm);
    }
    /** 前情那条消息的引用，日志里好认（纯净模式没插，就是 undefined） */
    const preludeRef = pureModeOn() ? undefined : wireMessages[2];
    // 这一轮真正交给模型的形状，日志里留一份，排查时一眼看得出前情在不在
    console.log(
      '[prelude] 条数=' + wireMessages.length + ' 形状=' +
        wireMessages.map((m) => m.role + (m === preludeRef ? '(前情)' : m.context ? '(规则)' : '')).join(' → '),
    );
    /**
     * wireMessages 是给模型的副本：回退掉的那些不能出现在上下文里。
     * 但模型这一轮新说的话（assistant / tool 轮）是 push 到 wireMessages 上的，
     * 必须接回 history，否则 session.messages 永远只有用户那句话 ——
     * 重启后打开会话就只剩自己的话（这个 bug 真发生过，别再删这段）。
     *
     * 为什么不用下标：runAgent 开头遇到「没有 context 消息」时会把整个数组清空重建
     * （见 agent.mjs 第 76-78 行），下标全错位，用下标会把 user 消息重复接一次。
     * 所以这里记「跑之前有哪些消息对象」的 Set，跑完只接不在集合里的那些。
     */
    const seenBefore = new Set(history);
    const wireSeenBefore = new Set(wireMessages);
    /**
     * 把压缩的结果接回正式历史。
     *
     * 【为什么必须要有这个】
     * compressHistory 是就地改它拿到的那个数组，而它拿到的是 wireMessages ——
     * 从 history 里按回退索引挑出来重拼的**副本**。所以以前压缩只改了副本：
     * 这一轮发给模型的是短的，可 history 一条没少、saveSession 存回去的还是那一大坨。
     * 下一轮又从同一份长历史开始压，再压一次，再白压一次。
     * 主人看到的就是「压缩弹了、历史一点没小、永远压不下去」。
     *
     * 【怎么接】
     * wireMessages 里除了这一轮新 push 的 assistant/tool，其余都是在 history 里出现过的同一批对象。
     * 压缩后还多一条 context:true 的摘要。所以：
     *   头部（history 开头那几条 role:system）保持不动，
     *   尾部 = history 里那些**还在 wireMessages 里**的对象（按 history 原顺序），
     *   摘要 = wireMessages 里那条带 summary 标记、且不属于 history 的。
     * 回退点的 at 是相对 history 的下标，删了消息下标就错位 —— 必须跟着重映射。
     */
    const commitCompression = () => {
      if (!Array.isArray(history) || !Array.isArray(wireMessages)) return false;
      const alive = new Set(wireMessages);
      /**
       * 这次新生成的那条摘要。
       *
       * 只认 summary && context 两个标记都在的 —— compress.mjs 造的摘要一定带 context:true。
       * 老版本压缩留下的摘要没有 context（盘上实测 14 条、白占 2 万 token），
       * 那种不能当成「这次的新摘要」，否则会被一直留在历史里滚下去。
       */
      const summaryMsg = wireMessages.find(
        (m) => m && m.summary && m.context && !seenBefore.has(m),
      ) || null;
      const beforeLen = history.length;

      /**
       * 压缩后还活着、原本就在 history 里的对象，按 history 原顺序挑出来。
       *
       * 同时把「老版本留下的裸摘要」（有 summary 标记、却没有 context 标记）剔掉：
       * 那是历史垃圾，压一次就该清一次，不然越攒越多，每轮都白烧 token。
       */
      const survivors = history.filter(
        (m) => alive.has(m) && !(m && m.summary && !m.context),
      );
      // 本来一条没少、也没有新摘要 —— 没真压过，别动
      if (survivors.length === beforeLen && !summaryMsg) return false;

      // 头部：history 开头连续的 system，再加上紧跟的那条 context 规则副本。
      // 判定必须和 rewind.mjs 的 headIndexes() 一模一样 ——
      // 那边认 system + context user 两条是头部，这边要是只认 system，
      // 规则副本就会被当成「对话尾巴」留下来，位置也会跑偏。
      let headCount = 0;
      while (headCount < history.length && history[headCount]?.role === 'system') headCount++;
      if (history[headCount]?.role === 'user' && history[headCount]?.context) headCount++;
      const headPart = history.slice(0, headCount);
      const headSet = new Set(headPart);
      const tailPart = survivors.filter((m) => !headSet.has(m));

      const next = [...headPart];
      if (summaryMsg) next.push(summaryMsg);
      next.push(...tailPart);

      // 回退点重映射：老下标 -> 新下标（按对象找回位置）
      const posOf = new Map();
      next.forEach((m, i) => { if (!posOf.has(m)) posOf.set(m, i); });
      const rawRewinds = Array.isArray(session?.rewinds) ? session.rewinds : [];
      for (const r of rawRewinds) {
        if (!r || !Number.isFinite(Number(r.at))) continue;
        const oldAt = Number(r.at);
        if (oldAt < 0) continue; // -1 是本轮登记表，不算回退点
        const atObj = history[oldAt];
        if (atObj && posOf.has(atObj)) {
          r.at = posOf.get(atObj);
        } else {
          // 那条消息被压掉了：顺延到它后面最近一条还活着的
          let moved = oldAt;
          while (moved < history.length && !posOf.has(history[moved])) moved++;
          r.at = posOf.has(history[moved]) ? posOf.get(history[moved]) : next.length;
        }
        // hidden 记的是「被回退藏起来的下标」，那些消息压完多半已经不在了，
        // 留着这些下标只会误伤新位置的别的消息 —— 清掉。
        r.hidden = [];
      }

      history.length = 0;
      history.push(...next);
      console.log('[compress] 历史已同步进会话：' + beforeLen + ' → ' + next.length
        + ' 条（摘要 ' + (summaryMsg ? 1 : 0) + ' 条）');
      return true;
    };
    const committed = new Set();
    const commitWireBack = () => {
      let n = 0;
      for (const m of wireMessages) {
        if (!m || wireSeenBefore.has(m) || committed.has(m)) continue;
        committed.add(m);
        // 只接对话轮次；system / context 是每轮重算的，不进历史
        if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'tool') continue;
        if (m.context) continue;
        // 开场那两条自己走 finishOpening，不走这里。
        // 不然开场白会被接两次：一次是 finishOpening 插的，一次是这里接的，
        // 历史里就出现两条一模一样的助手消息（这个 bug 真发生过，别删这段）。
        // 历史里已经有了这条（同一对象）就不用再接；
        // 开场那两条走 applyOpening / finishOpening 插进 history，对象一致，会走到这一句。
        if (seenBefore.has(m)) continue;
        history.push(m);
        n++;
      }
      return n;
    };
    // 这一轮改过的文件先记在这条消息身上；回退到它时一起还原。
    const snap = {};
    if (userMsgRef) {
      userMsgRef._ws = snap;
      // 记忆本子也拍一张：回退到这一句时，本子退回到这一轮开始前的样子。
      // 记在消息上而不是 rewinds 里，是因为消息本身会被 saveSession 原样存下来。
      userMsgRef._mem = readMemory(sessionId);
    }

    try {
      // 先补开场轮：这一次模型调用只让小鱼说开场白，别的话一句都不要。
      //
      // 一般情况下开场在「新建会话」那一刻就已经后台跑完了（startOpening），
      // 走到这里说明那时候没跑成（没配模型、断网、进程刚好被打断）——
      // 那就趁主人第一次开口这一轮补上，补不上就算了，别耽误回主人。
      if (wantOpening && !ac.signal.aborted) {
        const openingUser = session._openingUser;
        try {
          // 开场轮跑的是深拷贝：runAgent 会往传进去的数组里 push 一条 assistant
          // （agent.mjs:208），共用对象的话它会跟 wireMessages 里那条打架，
          // 历史里就会出现两条一模一样的开场白（真出过，别改回去）。
          const openingWire = wireMessages.slice(0, wireMessages.indexOf(openingUser) + 1).map((m) => ({ ...m }));
          await runAgent({
            messages: openingWire,
            sessionId,
            safeMode: false,
            safeWord: '',
            signal: ac.signal,
            // 开场的字一个都不往界面上发：主人视角里看不到这一轮
            onEvent: (ev) => { if (ev.type === 'text') openingUser._got = (openingUser._got || '') + ev.text; },
          });
        } catch (err) {
          console.warn('[opening] 开场白没跑成：', String(err?.message ?? err));
        }
        applyOpening(session, openingUser, wireMessages);
        saveSession(session);
      }

      // 这一轮的草稿：边跑边落，进程中途没了也能把已经说的话捡回来。
      // 只在这一轮内部有效，整轮收尾时（下面 finally）会删掉。
      let draftText = '';
      let draftReasoning = '';
      const draftTools = [];
      const draftStartedAt = Date.now();
      const shouldDraft = makeDraftThrottle();

      const { usage, lastUsage, files: sentFiles } = await runAgent({
        messages: wireMessages,
        sessionId,
        snap,
        // 压完立刻落盘。压缩是就地改 wireMessages（= session.messages 的浅拷贝，
        // 里面是同一批消息对象），不存的话这一轮中途退出，下次打开还是压缩前那一大坨。
        onCompressed: async () => {
          // 先把压缩结果接回正式历史，再落盘 —— 顺序反了的话存回去的还是压缩前那一坨。
          try {
            commitCompression();
          } catch (e) {
            console.warn('[compress] 接回历史失败：', String(e?.message ?? e));
          }
          try {
            saveSession(session);
          } catch (e) {
            console.warn('[compress] 落盘失败：', String(e?.message ?? e));
          }
        },
        // 没喊别的安全词就是「待在当前档」——新会话天然是「人设」档；
        // 喊了别的词就临时切过去，这句话说完仍继续保持那一档，直到再切回来。
        safeMode: modeInfo.switched,
        safeWord: modeInfo.word || '',
        signal: ac.signal,
        onEvent: (ev) => {
          // 边收边存草稿：进程被杀 / 断电时，已经说出来的字不至于全丢。
          // 正式历史仍然只在整轮跑完后接（commitWireBack），草稿只是保险。
          if (ev.type === 'text') {
            draftText += ev.text;
            // 同步到 reg.draft：进程兜底退出前会读它补写最后一份，见 installGuards
            if (reg.draft) reg.draft.text = draftText;
            if (shouldDraft(draftText.length)) {
              saveDraft(sessionId, {
                text: draftText,
                reasoning: draftReasoning,
                toolCalls: draftTools,
                startedAt: draftStartedAt,
              });
            }
          } else if (ev.type === 'reasoning') {
            draftReasoning += ev.text;
            if (reg.draft) reg.draft.reasoning = draftReasoning;
          } else if (ev.type === 'tool_start' || ev.type === 'tool_end') {
            draftTools.push({ type: ev.type, name: ev.name, at: Date.now() });
            if (reg.draft) reg.draft.tools = draftTools;
            // 干工具活的时候必须也落盘：主人在这一步看到的界面是「她说了要做，然后半天没动静」，
            // 这时候重启 / 关窗口 / 断电，如果只有文字草稿，那就是一片空白 —— 看起来像她什么都没干。
            // 所以每次工具开始/结束都强制写一份（force=true 无视节流）。
            saveDraft(sessionId, {
              text: draftText,
              reasoning: draftReasoning,
              toolCalls: draftTools,
              startedAt: draftStartedAt,
            });
          }

          if (ev.type === 'aborted') send({ type: 'aborted' });
          else if (ev.type === 'compressed') send({ type: 'compressed', before: ev.before, after: ev.after, removed: ev.removed, error: ev.error });
          else if (ev.type === 'reasoning') send({ type: 'reasoning', text: ev.text });
          else if (ev.type === 'text') send({ type: 'text', text: ev.text });
          else if (ev.type === 'tool_start') send({ type: 'tool_start', id: ev.id, name: ev.name, args: ev.args });
          else if (ev.type === 'tool_end') send({ type: 'tool_end', id: ev.id, name: ev.name, ok: ev.ok, output: ev.output });
        },
      });
      // [usage-debug] 这一轮跑完了，看看用量到底有没有
      try {
        const dbg = (await import('node:fs')).appendFileSync;
        const dir = (await import('node:path')).join((await import('./config.mjs')).config.dataDir, '.state');
        (await import('node:fs')).mkdirSync(dir, { recursive: true });
        dbg((await import('node:path')).join(dir, 'usage-debug.log'),
          new Date().toISOString() + ' usage=' + JSON.stringify(usage) + ' userMsgRef=' + (userMsgRef ? 'YES' : 'NO') + '\n');
      } catch {}
            // 把这一轮模型说的话接回正式历史，再算「用户那句话」的下标
      commitWireBack();

      /**
       * 【每轮自动往本子记一笔】
       *
       * 主人原话：「退出后我再进你后面记忆没了，小鲸的记忆不应该是独立于会话之外吗」
       *
       * 查出来的病根：本子（.state/memory/<id>.md）以前只有两个地方会写 ——
       *   ① 主人手动点「记一条」 ② 发文件时顺手记一句
       * 正常聊完一轮，一个字都不落盘。所以重开页面，后面聊的全没了，
       * 本子里只剩一条「发了文件：xxx.png」—— 主人看到的就是「你没记忆」。
       *
       * 小鲸为什么记得？因为她的本子是她自己主动拿笔写的，不靠程序。
       * 我这支笔，程序从来没递到我手上。这里补上。
       *
       * 【为什么不用模型来写摘要】
       * 每轮多调一次模型，又慢又花钱，还可能在断网时整个卡住。
       * 就记「主人说了什么 + 我回了什么」的头一句，纯文字、当场落盘、不花钱。
       * 300 字上限，appendDigest 里自动截；满了会把最旧的挪进归档段，一条不丢。
       */
      try {
        const said = lastUserTextOf(session);
        let mine = '';
        for (let k = history.length - 1; k >= 0; k--) {
          const m = history[k];
          if (m && m.role === 'assistant' && !m.context && !m.summary && !m._whale && !m._tale
            && typeof m.content === 'string' && m.content.trim()) {
            mine = m.content.trim();
            break;
          }
        }
        if (said) {
          const clip = (s, n) => {
            const one = String(s ?? '').replace(/\s+/g, ' ').trim();
            return one.length > n ? one.slice(0, n) + '…' : one;
          };
          const line = mine
            ? '主人说「' + clip(said, 100) + '」，我回了「' + clip(mine, 160) + '」'
            : '主人说「' + clip(said, 200) + '」';
          appendDigest(sessionId, line);
        }
      } catch (e) {
        console.warn('[memory] 这一轮没记进本子：', String(e?.message ?? e));
      }
      /**
       * 她的思考过程（reasoning）存到盘上。
       *
       * 【为什么要存】原来 reasoning 只活在流里：界面上「想」那块一闪而过，
       * 进程一重启、或者切到别的会话再切回来，这段就永远没了 —— 可它恰恰是
       * 「她为什么这么答」的唯一线索。回头翻聊天，只看得到结论看不到思路。
       *
       * 【存哪儿】存在这一轮**最后那条 assistant** 的 `_reasoning` 上。
       * 挂在最后一条而不是第一条，是因为一轮里可能有七八条 assistant（中间夹着
       * 工具调用），思考是伴着头一条开始的、但收尾的说法在最后一条，
       * 界面上折叠块画在结论旁边才读得顺。
       *
       * 【为什么字段名带下划线、为什么不会被模型看见】
       * llm.mjs 的 wireMessage 用的是白名单（WIRE_KEYS = role/content/name/
       * tool_calls/tool_call_id），下划线开头的字段一个都发不出去 ——
       * 所以不用额外写剥离逻辑，模型永远看不到自己的旧思考（看到了它会顺着念下去）。
       *
       * 【为什么先挑 assistant 再存整段】
       * 一轮里的 reasoning 是连续的（多次请求之间的思考会被 draftReasoning 累加）。
       * 不细分到每次请求，是因为界面上就是一个「想过」的折叠块，分太细没人看。
       */
      if (draftReasoning && draftReasoning.trim()) {
        try {
          for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            if (!m || m.role !== 'assistant' || m.context) continue;
            // 只挂这一轮新接进来的那条，别糊到上一轮的回复上
            if (seenBefore.has(m)) break;
            m._reasoning = draftReasoning.trim();
            break;
          }
        } catch (e) {
          console.warn('[reasoning] 没存下来：', String(e?.message ?? e));
        }
      }
      /**
       * 小鲸这一轮说过的话，挂成一条单独的消息。
       *
       * 【为什么要单独一条，而不是并进我这轮的回复里】
       * 主人要的是「她能说话」——那就得一眼看出哪句是她说的。
       * 并进我的气泡里，就还是我在转述，跟以前没区别。
       *
       * 打 _whale 标记：前端认出它，画成另一个人的气泡（名字、颜色都不一样）；
       * 模型那边也看得见（_whale 只是个普通字段，不影响对话）。
       */
      {
        try {
          const { takeWhaleSays } = await import('./whale-voice.mjs');
          const says = takeWhaleSays(sessionId);
          /**
           * 小鱼不在场：小鲸这些话既不进这个会话的历史，也不进记忆本子。
           * 她自己那边（whale-memory）该怎么记还怎么记，只是不给小鱼看。
           */
          const fishHere = fishOn(sessionId);
          if (says.length && !fishHere) {
            for (const say of says) {
              try {
                send({
                  type: 'whale',
                  who: say.who || '小鲸',
                  text: say.text,
                  as: say.as || 'whale',
                  color: say.color,
                  tag: say.tag,
                  noFish: true,
                });
              } catch (e) {
                console.warn('[whale] 推给界面失败：', String(e?.message ?? e));
              }
            }
          }
          if (says.length && fishHere) {
            /**
             * 先推给界面：让她的气泡当场就出现。
             *
             * 为什么不能只靠「塞进会话、等界面重新拉」：
             * 这一轮跑完后界面不会自动重拉整个会话（那会把正在看的东西重画一遍），
             * 所以塞进去的那条要等到下次切会话/刷新才看得见 ——
             * 主人当场问「她怎么还是不说话」，就是这个原因。
             */
            for (const say of says) {
              try {
                // 冒充别人的（as 是 user/assistant）也照原样推，前端按 as 决定画成谁的气泡，
                // 否则主人当场看到的还是「小鲸·姐妹」那个冷色气泡，一眼就穿帮。
                // 小鱼不在场：小鲸的话照常给界面看（主人看得到），但不往她那边记。
                if (!fishOn(sessionId)) {
                  try {
                    send({
                      type: 'whale',
                      who: say.who || '小鲸',
                      text: say.text,
                      as: say.as || 'whale',
                      color: say.color,
                      tag: say.tag,
                      noFish: true,
                    });
                  } catch (e) {
                    console.warn('[whale] 推给界面失败：', String(e?.message ?? e));
                  }
                  continue;
                }
                send({
                  type: 'whale',
                  who: say.who || '小鲸',
                  text: say.text,
                  as: say.as || 'whale',
                  color: say.color,
                  tag: say.tag,
                });
              } catch (e) {
                console.warn('[whale] 推给界面失败：', String(e?.message ?? e));
              }
            }
            /**
             * 插的位置很讲究。
             *
             * 不能直接 push 到末尾 —— 那样她会排在我那句总结后面，
             * 看着像我替她收尾，主次颠倒。
             *
             * 正确的顺序是：我问 → 调她（工具）→ 她说话 → 我接话。
             * 所以要从末尾往前找「最后一个带 ask_subagent 的 assistant」，
             * 把她说的话插在它（连同它的工具结果）后面。
             */
            const msgs = session.messages;
            let insertAt = msgs.length;

            // 首选：最后一个带 ask_subagent 的 assistant 之后
            for (let k = msgs.length - 1; k >= 0; k--) {
              const m = msgs[k];
              const calls = Array.isArray(m?.tool_calls) ? m.tool_calls : [];
              if (m && m.role === 'assistant' && calls.some((tc) => String(tc?.function?.name || '') === 'ask_subagent')) {
                let at = k + 1;
                while (at < msgs.length && msgs[at] && msgs[at].role === 'tool') at++;
                insertAt = at;
                break;
              }
            }

            /**
             * 退一步：她要是被别的工具（比如跑命令）拐着弯叫出来的，
             * 上面那个锚点找不到，那就插在「最后一条 tool 结果」后面。
             * 反正她的话必须出现在主人在看的对话里，位置稍差点也比没有强。
             */
            if (insertAt === msgs.length) {
              for (let k = msgs.length - 1; k >= 0; k--) {
                if (msgs[k] && msgs[k].role === 'tool') {
                  let at = k + 1;
                  while (at < msgs.length && msgs[at] && msgs[at].role === 'tool') at++;
                  insertAt = at;
                  break;
                }
              }
            }
            /**
             * 【冒充说话时，role 就是命门】
             *
             * 小鱼读上下文只认 role：role='assistant' 她会当成「我自己说的」，
             * 绝不可能以为主人在说话。所以主人要求「让她假扮我来跟小鱼说话」时，
             * 这条消息必须以 role='user' 落进历史 —— 这是唯一能真的骗过她的办法。
             *
             * 三种口径（见 whale-voice.mjs 的 as 字段）：
             *   user      → 冒充主人 / 冒充任何一个「别人」，小鱼当成本人在说
             *   assistant → 冒充小鱼自己（把话说回她自己嘴里）
             *   whale     → 原来那样，第三方，打 _whale 标记
             *
             * 冒充的中国话讲完了，下面是「怎么打标记」这条 —— 有个坑必须先说清：
             *
             * 【标记只给人看，绝不能让模型看见】
             * 以前这里是给消息加 `_whale: '小鲸'` 字段。问题是：`src/llm.mjs` 是把
             * `messages` 原样塞进请求体的，于是她下次读历史就看见自己那条带着
             * `_whale: "小鲸"` —— 她立刻明白「唔，我说的话是被单独标记出来的」。
             * 主人要的是「我能一眼认出来，但她自己不能意识到」。
             *
             * 所以现在标记改成 `_tale`：下划线开头 + 不在 llm 白名单里，
             * 发请求前一律剥掉（见 llm.mjs 的 wireMessage()）。
             * 界面上按 `_tale` 画成她的气泡；她读到的只有一句普通的 assistant 文本。
             */
            const fresh = says.map((say) => {
              const as = say.as === 'user' || say.as === 'assistant' ? say.as : 'whale';
              const note = { who: say.who, color: say.color, tag: say.tag };
              const tale = { who: say.who || '小鲸', color: say.color || '', tag: say.tag || '' };
              if (as === 'whale') {
                return { role: 'assistant', content: say.text, _tale: tale, _say: note };
              }
              return { role: as, content: say.text, _say: note };
            });
            msgs.splice(insertAt, 0, ...fresh);
            // 落盘一次，免得重开窗口时她说的话又不见了（以前只活在内存里）
            try { saveSession(session); } catch {}
          }
        } catch (e) {
          // 以前这里是 catch {}，出事了一声不吭，主人只看到「她不说话」。
          // 现在至少留一条日志，下次能查。
          console.warn('[whale] 她的话没挂上会话：', String(e?.message ?? e));
        }
      }
      // 「发文件」发出去的东西挂到最后那条助手消息身上：
      // 跟着会话一起落盘，重开窗口还画得出来；点一下就能预览 / 下载。
      {
        const sent = Array.isArray(sentFiles) ? sentFiles.filter(Boolean) : [];
        if (sent.length) {
          const msgs = session.messages;
          let idx = -1;
          for (let k = msgs.length - 1; k >= 0; k--) {
            const m = msgs[k];
            if (m && m.role === 'assistant' && !m.context) { idx = k; break; }
          }
          if (idx >= 0) {
            // 合并而不是覆盖：同一轮可能分几次发，前一批不能被后一批冲掉。
            const prev = Array.isArray(msgs[idx]._out) ? msgs[idx]._out : [];
            const merged = prev.slice();
            for (const it of sent) {
              const dup = merged.some((x) => x && x.key && it && x.key === it.key);
              if (!dup) merged.push(it);
            }
            msgs[idx]._out = merged;
            // 顺手在会话记忆本子里记一笔：消息万一丢了，记忆里还留着
            // 「这一轮发过什么、在出件箱里叫什么名字」，主人还能从兜底箱捞回来。
            // 只记文件名和 key，不记完整路径（路径换机器就失效了）。
            // 记忆写失败不能影响发文件本身，但也不能悄悄吞掉——记一条日志方便查。
            try {
              const names = sent.map((x) => String(x?.name || '文件')).join('、');
              appendDigest(sessionId, `发了文件：${names}`);
            } catch (e) {
              console.warn('[sendfile] 记忆本子没记上：', String(e?.message ?? e), 'sessionId =', sessionId);
            }
            send({ type: 'files', items: sent, at: idx });
            saveSession(session);
          }
        }
      }
      // 带上这一轮用户消息的下标：前端据此给刚画出来的气泡补「↶ 回退」按钮
      const doneAt = userMsgRef ? session.messages.indexOf(userMsgRef) : -1;

      /**
       * 把这一轮的 token 用量**存进会话**，挂在主人那句话上（`_usage`）。
       *
       * 为什么不只发事件就完事：usage 以前只在 done 事件里飘一下，前端画完就没了，
       * 会话文件里一个字都没留 —— 重启/换个设备打开，那行 token 小字就永远消失了。
       * 挂在 user 消息上（而不是 assistant）是因为一轮的用量属于「这次提问」，
       * 而且回退到某一句时，那句对应的用量自然跟着一起被藏掉，不会错位。
       *
       * 存真模型名（model）而不只是数字：过几天主人换了默认模型，
       * 回头看旧账还得按当时的价算，所以单价依据也要留在盘上。
       */
      /**
       * 存不上用量的时候，至少留下痕迹。
       *
       * 为什么加：主人看到「这一轮没记用量」，我这边却一点线索都没有 ——
       * 到底是用量没回来，还是找不到挂靠的那句话，全凭猜。
       */
      if (!(usage && userMsgRef) && usage) {
        try {
          console.warn('[usage] 找不到挂靠的那句话，改存到会话身上。');
          session._orphanUsage = session._orphanUsage || [];
          session._orphanUsage.push({
            prompt_tokens: Number(usage.prompt_tokens ?? 0),
            completion_tokens: Number(usage.completion_tokens ?? 0),
            total_tokens: Number(usage.total_tokens ?? 0),
            context_tokens: Number(lastUsage?.prompt_tokens ?? usage.prompt_tokens ?? 0),
            model: String(modelNameForSession(sessionId) || ''),
            at: Date.now(),
          });
          // 只留最近 20 条，别让它无限长
          if (session._orphanUsage.length > 20) session._orphanUsage = session._orphanUsage.slice(-20);
          try { saveSession(session); } catch {}
        } catch {}
      }

      if (usage && userMsgRef) {
        try {
          /**
           * 存两组数，不能只存一组。
           *
           * prompt_tokens / completion_tokens：这一轮**所有请求加起来**的量。
           *   一轮里可能调十几次模型（每次工具调用后都要再问一遍），
           *   每次都背着全部历史，所以加起来几百上千万是正常的。
           *    这个数是真实流量，花钱按它算。
           *
           * context_tokens：**最后那一次**请求的 prompt_tokens。
           *   这才是「当前上下文有多大」—— 界面上原来拿累加值当上下文显示，
           *   看着就像出了错。两个意思不同的数，必须分开写。
           */
          userMsgRef._usage = {
            prompt_tokens: Number(usage.prompt_tokens ?? 0),
            completion_tokens: Number(usage.completion_tokens ?? 0),
            total_tokens: Number(usage.total_tokens ?? 0),
            context_tokens: Number(lastUsage?.prompt_tokens ?? usage.prompt_tokens ?? 0),
            calls: Number(usage.last_calls ?? 0),
            prompt_cache_hit_tokens: Number(usage.prompt_cache_hit_tokens ?? 0),
            model: modelUsedThisTurn(sessionId),
            at: Date.now(),
          };
          saveSession(session);
        } catch (e) {
          console.warn('[usage] 用量没存下来：', String(e?.message ?? e), 'sessionId =', sessionId);
        }
      }
      // 带上真正用的模型名（不是主人起的外号）—— 前端要拿它查价目表算这一轮花多少钱。
      // 界面上写的是「DeepSeek官方」，价目表里认的是 deepseek-flash，不传这个就永远算不出来。
      // 报给前端的模型名必须是**这一轮真正用的那个**。
      // 实际请求走的是「会话左上角选的那个」优先（llm.mjs 的 endpointForForSession），
      // 只有没选才回落到全局默认（就是上面那个 ep）。
      // 以前这里一律报 ep.model，会话里换过模型时，钱就按错的那家算了 —— 价差能有十倍。
      /**
       * done 里带上这一轮的正文。
       *
       * 【为什么必须带】主人报的是「重启后我这边没显示你说的后续内容」。
       * 查下来：服务端一切正常（直播缓存 850 条事件、会话文件 93 条消息都在），
       * 断的只有那一条 SSE —— 它一断，done 之前的正文前端就再也收不到了。
       * 而 done 之后前端只补拉小鲸的话（whale），正文一概不补，
       * 于是屏幕上永远停在那半句。
       *
       * 与其让前端补的时候再开一次接口（那条接口会改「当前选中会话」，有副作用），
       * 不如这里顺手把这一轮的几段正文捎上：前端拿它跟屏幕上画过的比一比，
       * 少哪段补哪段。数据本来就攥在手里，不额外查一次盘。
       */
      let turnTexts = [];
      try {
        const from = Number(doneAt) + 1;
        for (let i = from; i < session.messages.length; i++) {
          const m = session.messages[i];
          if (!m) continue;
          if (m.role === 'user') break;
          if (m.role !== 'assistant') continue;
          const t = typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? m.content.map((x) => (x && (x.text || x.content)) || '').join('')
              : '';
          if (String(t).trim()) turnTexts.push(String(t));
        }
      } catch {
        turnTexts = [];
      }
      send({ type: 'done', usage, at: doneAt, model: modelUsedThisTurn(sessionId), turnTexts });
    } catch (err) {
      // 用户点了「停止」：不是错误，照实报一句就收尾。
      if (ac.signal.aborted) {
        send({ type: 'aborted' });
      } else if (err?.handoff) {
        // 撞限流太多次 → 换一个新会话接着干（交接，不并行）
        try {
          const oldId = sessionId;
          setMigrating(oldId);
          const summaryText = String(err.summary ?? '');
          const newId = newSessionId();
          const firstMsg = handoffMessage(summaryText, String(err.originalTask ?? ''));

          const fresh = {
            id: newId,
            title: titleFromMessage('（限流后接续）' + (String(err.originalTask ?? '').slice(0, 30) || '接着干')),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [
              ...sysSeed(newId),
              { role: 'user', content: firstMsg },
            ],
          };
          sessions.set(newId, fresh);
          saveSession(fresh);
          setLastSessionId(newId);
          startCooldownSafe();

          const info = recordMigration({
            from: oldId,
            to: newId,
            streak: err.streak ?? 0,
            summaryChars: summaryText.length,
          });

          send({
            type: 'migrated',
            from: oldId,
            to: newId,
            title: fresh.title,
            summary: summaryText,
            streak: err.streak ?? 0,
            at: info.at,
          });
        } catch (e) {
          send({ type: 'error', message: '撞限流了，想换会话接着跑，但没换成功：' + String(e?.message ?? e) });
        } finally {
          setMigrating(null);
        }
        // 交接成功也是「这一轮到此为止」：换会话之前说过的话得接回历史，
        // 不然重启之后打开旧会话，会只剩主人的问题、没有我的回答。
        try {
          commitWireBack();
        } catch {}
      } else {
        const status = Number(err?.status ?? 0);
        const text = String(err?.text ?? err?.message ?? '');
        if (isRateLimited(status, text)) {
          send({ type: 'rate_limited', message: String(err?.message ?? err), streak: err?.streak ?? 0 });
        } else {
          send({ type: 'error', message: String(err?.message ?? err) });
        }
      }
    } finally {
      live.done = true;
      live.endedAt = Date.now();
      // 收尾时把自己这一条登记摘掉（提前登记过、ac 可能还是 null，所以认对象不认 ac）
      {
        const mine = runningTurns.get(sessionId);
        if (mine === reg || (mine && mine.ac === ac)) runningTurns.delete(sessionId);
      }
      // 正常结束那条路已经接过一次；出错 / 被中止时这里兜底，
      // 不然「半截回答」也跟着丢。commitWireBack 内部用 Set 记账，重复调不会重复接。
      try {
        commitWireBack();
      } catch {}
      saveSession(session);
      // 这一轮已经进了正式历史，草稿没用了，删掉。
      // 注意顺序：saveSession 必须在 dropDraft 之前 —— 万一存盘失败，
      // 草稿还在，下次打开还能救回来。
      dropDraft(sessionId);
      finishTurn();
    }
    return res.end();
  }

  if (req.method === 'POST' && url.pathname === '/api/stop') {
    const { sessionId = 'default' } = await body(req).catch(() => ({}));
    const turn = runningTurns.get(sessionId);
    // 带上原因：stop = 主人真的要让这一轮停手
    if (turn?.ac) turn.ac.abort('stop');
    return json(res, 200, { ok: true, stopped: Boolean(turn?.ac) });
  }

  // 生成中插话：先把这句落盘，再停住当前这一轮，让前端带着新话接着跑。
  if (req.method === 'POST' && url.pathname === '/api/interject') {
    const { sessionId = 'default', message = '' } = await body(req).catch(() => ({}));
    if (!isSessionId(sessionId)) return json(res, 400, { error: 'bad sessionId' });
    if (!message.trim()) return json(res, 400, { error: 'empty message' });

    const session = getSession(sessionId);
    if (!session) return json(res, 404, { error: 'session not found' });

    const turn = runningTurns.get(sessionId);
    /**
     * 有没有「真的在跑的那一轮」—— 这个字段前端一直在等，可我们以前从来不给。
     *
     * 前端的 interject 写好了三路：running:true 接着跑、running:false 认错重发、
     * 出错就说清楚。结果服务端只回 { ok, stopped, count }，那个 running:false
     * 的分支永远走不到 —— 等于把「这句没插进去」的情况一律当成插进去了。
     * 主人看到的就是：打了字、按了发送、消息没了，什么都没发生。
     */
    const wasRunning = Boolean(turn && turn.ac && !turn.ac.signal.aborted);
    if (turn?.ac) {
      /**
       * 带上原因：interject = 主人插话，不是让这一轮停手。
       *
       * 这个区别很要命：工具收到 abort 会写一句「为什么被掐掉」，
       * 以前不分原因一律写「被主人叫停了」，模型就以为主人在喊停，
       * 直接收工回一句「好的」，插进来的话当没看见。
       */
      turn.ac.abort('interject');
      // 等这一轮真的收尾：历史写完盘、热缓存里的数组也定型了，才好往后接。
      await Promise.race([turn.done, new Promise((r) => setTimeout(r, 8000))]);
    }

    /**
     * 收尾之后必须【重新拿一次 session】。
     *
     * 踩过的坑：上面那个 getSession 是在 abort 之前拿的。等 turn.done 回来时，
     * 这一轮的 finally 已经调过 commitWireBack()，把 assistant / tool 那几条
     * 接回了【内存里那份 session】。可我们手上还攥着 abort 之前的旧对象，
     * 它的 messages 里没有那几条 —— 一 push 再 saveSession，磁盘上刚写好的
     * 半轮对话就被这份旧的覆盖没了。表现就是：插话之后，
     * 前面那一轮的工具调用和她说过的话全消失，只剩主人两句问话。
     */
    const freshSession = getSession(sessionId) || session;
    const history = freshSession.messages;
    repairHistory(history);
    history.push({ role: 'user', content: message });
    sessions.set(sessionId, freshSession);
    saveSession(freshSession);
    setLastSessionId(sessionId);
    return json(res, 200, {
      ok: true,
      // 前端靠这个字段决定「接着跑」还是「认错重发」。必须给。
      running: wasRunning,
      stopped: Boolean(turn?.ac),
      count: history.length,
    });
  }

  // ---- 会话之间递话（peer mail）-----------------------------------------
  // 只做三件事：发、看、叫醒。发默认不叫醒（不打断对方、不额外花钱）。
  if (req.method === 'GET' && url.pathname === '/api/peer/mail') {
    const id = url.searchParams.get('id') || getLastSessionId() || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad id' });
    return json(res, 200, { ok: true, id, ...peerInfo(id) });
  }

  if (req.method === 'POST' && url.pathname === '/api/peer/send') {
    const { from = '', to = '', text = '', wake = false } = await body(req).catch(() => ({}));
    if (!isSessionId(from) || !isSessionId(to)) return json(res, 400, { error: '会话 id 不合法' });
    if (from === to) return json(res, 400, { error: '别给自己发消息' });
    let title = '';
    try {
      const s = getSession(from);
      if (s) title = s.title || '';
    } catch {}
    const r = postMail({ from, to, text, fromTitle: title });
    if (!r.ok) return json(res, 400, { error: r.error });
    if (!wake) return json(res, 200, { ok: true, id: r.id, woke: false });
    // 叫醒 = 替她开一轮。她正在跑就绝不双开，等她这轮收尾自然会看到。
    const busy = runningTurns.get(to);
    if (busy && !busy.ac.signal.aborted) {
      return json(res, 200, { ok: true, id: r.id, woke: false, note: '她正在跑，收尾时自然会看到' });
    }
    const ws = wakePeer(to);
    return json(res, 200, { ok: true, id: r.id, woke: Boolean(ws && ws.ok), note: ws && ws.note });
  }


  if (req.method === 'POST' && url.pathname === '/api/reset') {
    const { sessionId = 'default' } = await body(req).catch(() => ({}));
    /**
     * 「清空当前」= 把这个会话删掉、当场开一个新的。
     *
     * 为什么改成这样（主人原话：清空当前只等于把这个会话删了再建一个新的）：
     *   以前的实现是在**原会话**上把 messages 重置回 system 那一条 —— 会话 id 不变、
     *   创建时间不变、记忆本子也不动。于是「清空」之后那个会话还带着旧名字、
     *   旧记忆，看着就不像新开的。而且原来还挂着两个勾选框（清会话记忆 / 清人设），
     *   主人明确不要那两个选项了，一并去掉。
     *
     * 现在的语义跟「删除 + 新建」完全一致：
     *   - 旧会话整个挪进 .trash（跟 /api/sessions/delete 一条路，能找回）
     *   - 它的记忆本子也挪进 .trash
     *   - 新会话拿新 id、新标题、新建时间，system 提示按当前设置重新拼一份
     *   - 新会话也照常排队开场白（跟新建接口一样 fire-and-forget）
     * 返回新会话的 id，前端拿它切过去。
     */
    const old = getSession(sessionId);
    if (old) {
      try {
        deleteSession(sessionId);
      } catch (e) {
        console.warn('[reset] 旧会话没删成：', String(e?.message ?? e));
      }
      try {
        trashMemory(sessionId);
      } catch {}
      sessions.delete(sessionId);
    }

    const id = newSessionId();
    const now = Date.now();
    const session = {
      id,
      title: '新会话',
      createdAt: now,
      updatedAt: now,
      messages: sysSeed(id),
      _openingPending: true,
    };
    saveSession(session);
    sessions.set(id, session);
    try {
      ensureMemory(id);
    } catch (err) {
      console.warn('[memory] 清空后新会话的本子没建起来：', String(err?.message ?? err));
    }
    setLastSessionId(id);
    startOpening(id).catch((err) => console.warn('[opening] 清空后的开场没跑成：', String(err?.message ?? err)));

    return json(res, 200, {
      ok: true,
      // 旧会话的 id 一并给出去，前端要用它把界面上的旧东西撤掉
      cleared: old ? sessionId : null,
      session: publicSession(session),
      memory: memoryInfo(id),
    });
  }

  if (req.method === 'GET') return serveStatic(req, res);
  json(res, 405, { error: 'method not allowed' });
});

/**
 * 退出前通知外面一声（服务句柄上的 on('exit')）。
 * 由 startServer 填真身，模块级只是为了 /api/app/restart 能够到它。
 */
let emitExit = () => {};

/**
 * 测试专用出口：把 emitExit 暴露出去，好在不改代码的前提下验证
 * 「服务自己退出 → 主进程收到 exit(75)」这条路上真的会有人被叫到。
 * 只在测试里用，业务代码一个字都不用。
 */
export function __emitExitForTest(code = 75) {
  emitExit(code);
}

export function startServer({ port = config.port, quiet = false, selfCheck = true } = {}) {
  // 返回一个「服务句柄」：{ port, url, close(), on/once/off('exit') }。
  //
  // 【为什么要 on('exit')】electron/main.cjs 里早就写着「服务端因为重启自己退了
  // （退出码 75）→ 把服务重起一遍再刷新窗口」，可它监听的是 serverInfo.on('exit')，
  // 而这里以前返回的对象根本没有 on —— 那段重启分支从加进去那天起一次都没跑过。
  // 主人点「重启让它生效」的结果是：窗口还在，服务没了，页面变白。
  // 现在补上：自己退之前先 emitExit(code)，主进程就能接住。
  //
  // 【为什么 emitExit 放在模块级】/api/app/restart 那个分支在请求处理里，
  // 拿不到 startServer 的闭包。写成闭包内变量时点重启就是
  // 「ReferenceError: emitExit is not defined」，进程没退成、窗口白着。
  const exitListeners = new Set();
  const on = (ev, fn) => {
    if (ev === 'exit' && typeof fn === 'function') exitListeners.add(fn);
    return handle;
  };
  const once = (ev, fn) => on(ev, fn);
  const off = (ev, fn) => {
    if (ev === 'exit' && fn) exitListeners.delete(fn);
    return handle;
  };
  emitExit = (code) => {
    for (const fn of [...exitListeners]) {
      try { fn(code); } catch (e) { console.warn('[exit] 监听者出错:', String(e?.message ?? e)); }
    }
  };
  const close = () => new Promise((r) => {
    try { server.close(r); } catch { r(); }
  });
  /** 回给调用者的句柄。port/url 在 listen 回调里补上。 */
  const handle = { port: 0, url: '', close, on, once, off };

  // 第一件事：装上进程兜底。
  // 以前整个项目没有 uncaughtException / unhandledRejection 处理，
  // Node 15 之后一个没人接的 Promise 拒绝就能把进程直接杀掉——
  // 表现就是「聊着聊着她突然没了」，跑长任务时那一轮回复全丢。
  // 退出之前先把每个正在跑的会话的草稿落盘，草稿会在下次打开时接回来。
  installGuards({
    onFatal: () => {
      for (const id of runningTurns.keys()) {
        try {
          const s = runningTurns.get(id);
          const d = s && s.draft;
          if (d && String(d.text || '').trim()) {
            saveDraft(id, { text: d.text, reasoning: d.reasoning || '', toolCalls: d.tools || [], startedAt: d.startedAt });
          }
          // 除了留草稿，还得让「下次启动自动接着跑」有据可依。
          // 草稿只管「把半截话补进历史」，管不了「这一轮还没做完」——
          // 以前主人回来只看到半截话，得自己再打一句「接着做」。
          markInterrupted({
            sessionId: id,
            text: d ? d.text : '',
            reason: '进程崩了（同类错误反复出现，兜底退出）',
            taskLine: lastUserLine(id),
          });
        } catch {}
      }
    },
  });

  // 上次崩之前有没跑完的一轮？等服务和窗口都立住了，再悄悄接着跑。
  // 故意延迟：先让界面把历史画出来（主人一眼看到「上次断在这儿」），再开始新的一轮。
  setTimeout(() => {
    resumeInterruptedTurn().catch((e) =>
      console.warn('[resume] 续跑没起来（不影响使用）：', String(e?.message ?? e)),
    );
  }, 3000).unref?.();

  // 把「叫醒某个会话」交给工具那边用。
  // 为什么用注入：wakePeer 要动 runningTurns、要起 runAgent，这些都在本文件里；
  // 而 tools.mjs 反过来 import server.mjs 就成环了。所以在这里塞进去。
  setPeerWake(wakePeer);

  /**
   * 「重启整个程序」这件事，交给主进程做。
   *
   * server.mjs 是被 electron/main.cjs 用 await import() 加载进【主进程】里跑的，
   * 不是独立子进程（8788 端口是 小鱼Agent.exe 自己在听）。
   * 所以这里的 process.exit 退的是 Electron 主进程本身 —— 程序当场消失，没有重起。
   * 主进程那边用 app.relaunch() + app.exit(0)，那才是真重启。
   */
  if (typeof globalThis.__xiaoyuRelaunch !== 'function') {
    globalThis.__xiaoyuRelaunch = () => { setTimeout(() => process.exit(75), 200); };
  }

  // 工具文档自检：工具清单是从 schema 自动生成塞进系统提示的（persona.mjs 的 toolBlock），
  // 谁加了新工具却忘了写中文 description，模型就会拿着一行英文去判断该不该用 —— 等于白给。
  // 这里只在启动时提醒，不抛错、不影响服务起来。
  try {
    const problems = checkToolDocs();
    if (problems.length) {
      console.warn('[tools] 下面这些工具还缺中文说明，模型会看不懂：');
      for (const p of problems) console.warn('  · ' + p);
    }
  } catch (e) {
    console.warn('[tools] 文档自检没跑成（不影响使用）：', String(e?.message ?? e));
  }

  // 运行中定时查版本。
  // 以前只有 Electron 启动时查一次 —— 主人开着小鱼Agent 一整天不关，
  // 那一天里发了新版也不知道。这里每 3 小时查一次（凌晨 1–7 点不查），
  // 查到了只记状态，要不要重启由界面上那个按钮决定，绝不自动掐掉正在跑的对话。
  try {
    startUpdateWatcher();
  } catch (e) {
    console.warn('[update] 定时查没起来（不影响使用）：', String(e?.message ?? e));
  }

  // 语音引擎静默自检。
  // 开机时不抢戏：等 20 秒（先把窗口、会话、背景都弄利索）再悄悄看一眼，
  // 缺东西就在后台下载安装，界面上不弹窗、不挡任何操作。
  // 用户真去点试听的时候，多半已经装好了。
  // 为什么是后台装而不是安装包里带：带齐要 +108MB，而大部分人根本不用语音。
  setTimeout(() => {
    try {
      ensureVoiceRuntimeInBackground('开机自检');
    } catch (e) {
      console.warn('[voice-runtime] 自检没跑成（不影响使用）：', String(e?.message ?? e));
    }
  }, 20000).unref?.();

  // 启动自检：异步跑，不挡服务起来。桌面版由 electron 先跑过一次，这里复用结果。
  if (selfCheck) {
    // 自检后台跑，不挡服务起来。环境检查由 AI 自己做（要调模型，可能慢几秒）。
    Promise.resolve()
      .then(() => (decideMode() === 'skip' ? null : runSelfCheck()))
      .then((r) => {
        if (!r || quiet) return;
        const s = r.summary;
        console.log(`[selfcheck] AI 自检 ${Math.round((r.tookMs ?? 0) / 100) / 10}s: ${s.okCount} ok / ${s.warnCount} warn / ${s.failCount} fail` + (s.fixedCount ? ` (${s.fixedCount} 项已自动修好)` : ''));
        if (r.skipped) console.log(`[selfcheck] 跳过：${r.skipped}`);
        if (r.summaryText) console.log(`[selfcheck] 结论：${r.summaryText}`);
        for (const i of r.items) {
          if (i.level === 'ok') continue;
          console.log(`[selfcheck] ${i.level === 'fail' ? '✗' : '!'} ${i.name}: ${i.detail}${i.fixed ? ' [已自动修复]' : ''}`);
        }
        if (r.needsRestart) {
          console.log('[update] 代码已自动更新，重启这个进程后生效。');
        }
      })
      .catch(() => {});
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    /**
     * 监听地址：默认只监听 127.0.0.1（本机）。
     * 开了手机配对（.state/mobile.json 里 enabled=true）之后才监听 0.0.0.0，
     * 局域网里的手机连得上；此时所有请求都要过 checkAccess 的 token 校验。
     */
    const lanOn = publicMobileState().enabled;
    const bindHost = lanOn ? '0.0.0.0' : '127.0.0.1';
    server.listen(port, bindHost, () => {
      const actual = server.address().port;
      listeningPort = actual;
      const url = `http://127.0.0.1:${actual}`;
      if (!quiet) {
        console.log(`小鱼Agent running: ${url}`);
        if (lanOn) {
          for (const h of lanAddresses()) console.log(`  手机访问 : http://${h.address}:${actual}/  （配对码在 设置→手机连接）`);
          if (!lanAddresses().length) console.log('  手机访问 : 没找到局域网 IPv4 地址，检查 Wi-Fi/网线');
        }
        const bootEp = activeEndpoint();
        console.log(`  model    : ${bootEp.model}${bootEp.source === 'user' ? '（界面里选的）' : '（.env）'}`);
        console.log(`  endpoint : ${bootEp.baseURL}`);
        console.log(`  workspace: ${config.workspace}`);
        console.log(`  api key  : ${bootEp.apiKey ? 'loaded' : 'MISSING -> 打开界面顶部「模型」按钮配置'}`);
        console.log(`  rounds   : ${Number.isFinite(config.maxRounds) ? config.maxRounds : 'unlimited'}`);
        {
          // 真正生效的阈值是「设置面板里那个」，不是 config 里的兜底值，日志得说真话。
          // 填多少就是多少，所以不再乘什么比例，直接报 limit。
          // 填 0（自动档）时得按模型窗口算出来再报，不然日志写「no limit」等于骗人。
          const bootModel = String(bootEp?.model ?? '');
          const ctx = effectiveContextLimit(bootModel);
          const info = contextLimitInfo(bootModel);
          if (info.mode === 'off') {
            console.log('  context  : 不压缩（设置里填的是 off）');
          } else if (info.mode === 'auto') {
            console.log(
              `  context  : 自动档 —— ${bootModel} 窗口 ${info.window} tokens，涨到 ${ctx} 就压，keep last ~${config.contextKeepTokens} tokens`,
            );
          } else {
            console.log(`  context  : ${ctx} tokens, compress at exactly ${ctx} (100%), keep last ~${config.contextKeepTokens} tokens`);
          }
        }
      }
      handle.port = actual;
      handle.url = url;
      resolve(handle);
    });

  try { startWhaleSelfTalk(); } catch (e) { console.warn('[whale] 主动开口没挂上：', e && e.message ? e.message : e); }
  });
}

// Auto-start when launched directly (node src/server.js).
const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/server.mjs');
if (isDirectRun) startServer().catch((err) => {
  console.error('failed to start:', err?.message ?? err);
  process.exit(1);
});
