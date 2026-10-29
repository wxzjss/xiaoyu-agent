// Minimal web server: static UI + one SSE endpoint that runs the agent.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, statSync } from 'node:fs';
import { join, isAbsolute as isAbsolutePath } from 'node:path';
import { config } from './config.mjs';
// 小鲸在场的开关。必须在顶层导入：以前写在接口分支里用 await import，
// 出了分支 whaleOn 就没了，而每轮收尾那句 if (whaleOn()) 还在 —— 每轮都崩。
import { whaleOn, setWhaleOn } from './whale-presence.mjs';
// 顶栏那个「小鱼」按钮：默认在场，禁用后这个会话后面的话她一个字都不发。
import { fishOn, setFishOn } from './fish-presence.mjs';
import { runAgent, systemPrompt, repairHistory } from './agent.mjs';
// 启动自检用：查每个工具是不是都有中文 description / 参数说明。
import { checkToolDocs, setPeerWake, runWithToolContext } from './tools.mjs';
import { browse, readImageDataUrl, readImageBytes, composeUserContent, isImagePath } from './attach.mjs';
import { mimeOf, fileKindOf, fmtSize, outboxPath, sendCheck } from './outbox.mjs';
import { getOverride, setOverride } from './session-overrides.mjs';
// 任务清单（界面面板用）：跟小鱼自己的 plan 工具是同一份数据，别另存一套
import { planPublicView, planUiAction, readPlanTxt } from './plan.mjs';
// localVersion：更新器眼里「本地该是哪一版」。跟正在跑的版本可能不是一个数 ——
// 见下面 /api/health 里 running/target 的注释。
import { localVersion } from './updater.mjs';
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
import { getWhaleProfile, saveWhaleProfile, MAX_PERSONA_CHARS, whalePersonaForEditor, defaultWhalePersonaPath } from './whale-profile.mjs';
// 进程兜底：一处没 catch 的异常不该让整个程序消失。
import { installGuards, crashSummary } from './crash-guard.mjs';
// 版本检查：每次启动跑一次（selfcheck 节流也照样查），界面上也能手动点。
import { quickCheck, updateStatus, startUpdateWatcher } from './updater.mjs';
import { buildSessionLog } from './session-log.mjs';
import { sessionToText, txtFilenameOf } from './session-text.mjs';
import { applySafeWord, sessionModeWord, inPersonaMode } from './mode.mjs';
// 人设档的档位词名（默认「人设」）—— 她的安全词档位要用
import { personaWord } from './persona.mjs';
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
// 2026-10-29 智能体卡：内置两张（小鱼/小鲸）+ 主人自定义的
import {
  listAgents,
  getAgent,
  addAgent,
  renameAgent,
  removeAgent,
  saveAgentPersona,
  resetAgentPersona,
  setAgentModel,
  sessionAgentId,
  sessionAgentMap,
  setSessionAgent,
  groupAgentIds,
  setSessionGroup,
  quietAgentIds,
  setAgentQuiet,
  isAgentQuiet,
  MAX_GROUP,
  AGENT_XIAOYU,
  AGENT_XIAOJING,
  MAX_AGENTS,
  MAX_PERSONA_CHARS as MAX_AGENT_PERSONA_CHARS,
} from './agents.mjs';
import { getFeatures, setFeature, featureNameOfTool, getEnabledMap } from './features.mjs';
import {
  identityState,
  currentIdentity,
  currentIdentityId,
  isOwnerIdentity,
  setIdentity,
  addCustomIdentity,
  updateCustomIdentity,
  removeCustomIdentity,
  editIdentity,
  resetBuiltinIdentity,
  identityBlock,
  identityOn,
} from './identity.mjs';
// 同一个人连着说 → 拼成一段。实现在 merge-voice.mjs，抽出去是为了能真跑一遍验。
import { mergeSameVoice } from './merge-voice.mjs';
// 专业模式开关（见 pure.mjs）
import { pureModeOn, setPureMode, pureSystemPrompt, pureButtonOn, purePressedMode, pureFeatureOn } from './pure.mjs';
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
  // 2026-10-31：openingTexts / setOpeningTexts / resetOpeningTexts 不再 import ——
  // 功能页那个「开场白」入口删了，按会话/全局改开场白的老 API 也一起撤了，
  // 现在开场白只按智能体卡存（cardOpening / setCardOpening）。
  openingHeadIndexes,
  isOpeningMessage,
  openingSpan,
  cardOpening,
  setCardOpening,
  unmarkOpened,
  wasOpened,
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
  probeEndpoint,
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
/**
 * 【为什么这两个函数在模块顶层】—— 2026-10-29 修崩溃
 *
 * 它们原来定义在「跑一轮对话」那个函数体里面（挨着 committed 那行 Set），
 * 可是 /api/sessions/select（点左边列表切会话）也要用 alreadyCollected 去查
 * 「这段正文历史里收过没有」—— 那是另一个请求，根本进不到那个函数体，
 * 于是每次点会话都 ReferenceError: alreadyCollected is not defined，
 * 落成没人接的 Promise 拒绝，桌面端表现为整窗闪退（.state/crash.log 里连报 7 次）。
 * 都是纯函数，放顶层最省事，两边都能用。
 */
/**
 * 【2026-10-29 修 · 防「同一条回答落盘上百遍」】
 *
 * 症状（主人这次报的）：切出去再切回来、重启一次，会话里同一条回复就多一份，
 * 最后历史里躺着 3~5 份一模一样的长回答，界面上看就是「说了一大堆活」。
 *
 * 病根：commitWireBack 只靠两个 Set 挡重复 —— committed 和 wireSeenBefore，
 * 两个都是**按对象身份**记的。可 wireMessages 中途会被重新赋值（拼身份标签、
 * mergeSameVoice、专业模式 filter），一旦换了数组，老对象就不在里面，
 * 于是同一条 assistant 被当成「新的」再接一遍，一遍一遍接下去。
 *
 * 现在加一道**按内容**的关：算个指纹，最近 200 条里已经有同样内容的就不接。
 * 指纹只看 role + 正文 + 工具调用 id，不看对象，也不看 _at（_at 是后补的，
 * 同一条两次接进来的 _at 可能不同，用它当键会漏）。
 */
const msgFingerprint = (m) => {
  if (!m) return '';
  const body = typeof m.content === 'string'
    ? m.content
    : Array.isArray(m.content)
      ? m.content.map((p) => (p && (p.text || p.type)) || '').join('\n')
      : '';
  const ids = Array.isArray(m.tool_calls) ? m.tool_calls.map((t) => String((t && t.id) || '')).join(',') : '';
  // _at 是服务端给每条 assistant 盖的时间戳：同一次生成只有这一个值。
  // 带上它，才能分清「同一句话被重复接入」（同 _at，该挡）和「我过一会儿又说了一遍」（不同 _at，该留）。
  return String(m.role || '') + '|' + String(m._at || '') + '|' + String(m.tool_call_id || '') + '|' + ids + '|' + body;
};
/** 这段正文最近收过没有（只看尾部，够用且便宜） */
const alreadyCollected = (ms, m) => {
  if (!Array.isArray(ms) || !m) return false;
  const fp = msgFingerprint(m);
  if (!fp || fp.endsWith('|')) return false;   // 空正文也不当成重复（工具空壳另有判据）
  const from = Math.max(0, ms.length - 200);
  for (let k = from; k < ms.length; k++) {
    if (msgFingerprint(ms[k]) === fp) return true;
  }
  return false;
};


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
  /**
   * 【别因为 mtime 变新就换对象】—— 2026-10-27 修
   *
   * updatedAt 是在 writeFileSync **之前**赋的，落盘必然比它晚几毫秒。
   * 于是 st.mtimeMs > hot.updatedAt 恒为真（实测 17/17 个会话全真，中位差 7.8ms），
   * 每次 getSession 都重新读盘换一个新对象。
   *
   * 后果：/api/chat 开跑时抓的那个 session 成了孤儿，她的回复全推在孤儿上；
   * 中途别的路径（插话、小鲸、定时存盘）每存一次盘就换一次对象，
   * 收尾时孤儿写回磁盘 —— 等于「她说的话全消失」。
   *
   * 改成两道关：
   *   ① mtime 要比 updatedAt 多出 SLACK_MS，才可能是外部真的改过（排除自己刚写完）；
   *   ② 就算过了第一关，还要磁盘那份**真的多出消息**才换。
   * 内容一样就返回原对象 —— 正在跑的那一轮手里的引用不能被动。
   */
  const SLACK_MS = 1500;
  try {
    const st = statSync(sessionPath(id));
    const known = Number(hot.updatedAt) || 0;
    if (st.mtimeMs > known + SLACK_MS) {
      const fresh = loadSession(id);
      if (fresh) {
        const hotN = Array.isArray(hot.messages) ? hot.messages.length : 0;
        const freshN = Array.isArray(fresh.messages) ? fresh.messages.length : 0;
        if (freshN > hotN) {
          sessions.set(id, fresh);
          return fresh;
        }
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
      // who：这句当时是哪个身份说的。没存就是主人（老会话全走这条，显示不变）
      const who = typeof m._who === 'string' && m._who ? m._who : '';
      turns.push({ role: 'user', text: shown, atts, rewindId: i, edited, usage, who });
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
      /**
       * 【这句是小鲸并排插进来的，不是这一轮的收尾回答】—— 2026-10-26 补
       *
       * 前端要靠它分辨：屏幕上最后那条气泡要是她插的话，就不能当成
       * 「小鱼这轮说完了」——否则主人永远等不到我那句。
       */
      whaleSide: m._whaleSide === true ? true : undefined,
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
 * 问小鲸一句：主人刚说了这个，你要不要接？
 *
 * 【她的判断权】提示里明写「不想接就一个字都别回」，回空就是不接。
 * 这样她才不会每句都抢话 —— 主人要的是姐妹搭把手，不是弹幕。
 *
 * 【她说什么都不写进我这一轮】她的话单独成一条（带 _whale），
 * 走 send 推出去，界面画成她自己的气泡。
 */
/**
 * 【统一落盘：把主人说的话写进历史】—— 2026-10-27
 *
 * 两个 bug 同一个根：主人的话没真正进历史。
 *   ① 小鱼关掉的分支忘了 push（只叫了小鲸）→ 重启后只剩她的回答
 *   ② 小鲸那一轮收尾拿创建时的旧 session 存盘 → 把刚落的话盖掉
 *
 * 所以这里只留一份实现，所有入口都调它。
 *
 * @returns {boolean} 真的写进去了（已存在同样的就不重复写，返回 false）
 */
function saveUserMessage(sessionId, message, attachments = null) {
  try {
    const said = String(message ?? '');
    if (!said.trim()) return false;
    // 必须现取：创建时那份可能已经被收尾换掉了
    const live = getSession(sessionId);
    if (!live || !Array.isArray(live.messages)) return false;
    const msgs = live.messages;
    try { repairHistory(msgs); } catch {}
    const last = msgs[msgs.length - 1];
    const dup = Boolean(last && last.role === 'user' && String(last.content ?? '') === said);
    if (!dup) {
      const uMsg = { role: 'user', content: message };
      if (Array.isArray(attachments) && attachments.length) uMsg.attachments = attachments;
      msgs.push(uMsg);
    }
    sessions.set(sessionId, live);
    live.updatedAt = Date.now();
    saveSession(live);
    setLastSessionId(sessionId);
    try { logWhaleAction(dup ? '主人这句已在历史里，不重复写' : '主人这句已落盘：长度=' + msgs.length); } catch {}
    return !dup;
  } catch (e) {
    console.warn('[chat] 主人这句没存下：', String(e?.message ?? e));
    return false;
  }
}

/**
 * 小鱼在屋、她也接了这句时，钉给她的那条规矩。
 *
 * 【要解决的到底是什么】2026-10-27
 * 主人报：「小鱼和小鲸一起开启着时候，我问小鲸问题，小鲸会回答我，
 * 小鱼也会以小鲸的口吻回答我。」
 *
 * 她不知道小鱼也在读这句话 —— 在她那儿，屋里就她一个开口的。
 * 于是一个问题两个人各答一遍，主人看到的就是「小鱼学着小鲸说话」。
 * 光在提示词里写「你是小鲸」不够，得把「另一个人也在」这件事说出来。
 */
function extraRuleForBothOn() {
  return '【这会儿小鱼也在读你这句话】—— 她和你听到的是同一句。' +
    '别把她的话当成你的话、也别替她认下任何事：主人问「查了没」「在不在」，' +
    '那是问她的。你要开口，就只说你自己真查过、真看见的那一点；' +
    '她已经在说的，你不必再说一遍。' +
    '（你俩同时开口，主人屏幕上会像两个人在抢同一题。）';
}

/**
 * 小鱼被关掉、只剩她的时候，那条「默认跟小鱼说话」的规矩要当场作废。
 *
 * 主人报过的另一半：「我问小鲸问题……小鱼也会以小鲸的口吻回答我。」
 * 反过来一样成立：小鱼不在，她手里那句「他说的话默认是冲小鱼的」
 * 就没了着落 —— 于是她把「随便谁」当成了那个默认，摆起姐姐的谱来。
 */
function extraRuleForFishAway() {
  return '【屋里只剩你们两个：小鱼不在】' +
    '她这会儿不在这个会话里，一个字都听不见，也别替她答。' +
    '这时候不存在「这句话默认是冲小鱼说的」—— 主人就是在跟你说话。' +
    '用你自己的样子答：短、直接、不哄人，别学她那种撒娇的腔调。' +
    '你答完这句就是答完了，不必再补一句「要不要叫小鱼来」。';
}

async function whaleMaybeReply({ session, userText, send, sessionId, live = null, speaksToHer = false, extraRule = '' }) {
  const { runSubagent } = await import('./subagent.mjs');

  /**
   * 【安全词也管她】2026-10-27 主人定的。
   * 会话当前在哪个档位，就按哪个档位跟她说 —— 她跟小鱼同步。
   * 没喊过任何词 = 「人设」档（默认）。
   */
  let __swWord = '';
  let __swNote = '';
  try {
    __swWord = sessionModeWord(session) || '';
    if (!__swWord) __swWord = personaWord(getSettings());
    __swNote = safeWordNoteFor(__swWord) || '';
  } catch {}

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
    // 全集：她的话也要，不然下面看不见「我上一句答过什么」
    const every = (session.messages || []).filter((m) => m && !m.context && !m.summary);
    // 给「小鱼在干什么」用的那部分：她自己的话不算
    const all = every.filter((m) => !m._whale && !m._tale);
    // 【2026-10-27 补】她上一两句自己说的话也留一份 —— 不然她看不见「我已经答过了」
    const myRecent = every.filter((m) => m && m._whale)
      .map((m) => String(m.content ?? '').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(-2);
    // 工具结果按 id 建索引，好把结果挂回调用它的那一行
    const resById = new Map();
    for (const m of all) {
      if (m.role === 'tool' && m.tool_call_id) resById.set(String(m.tool_call_id), String(m.content ?? ''));
    }
    const lines = [];
    for (const m of all) {
      if (m.role === 'user' && typeof m.content === 'string' && m.content.trim()) {
        // 【谁说的】—— 2026-10-28
        // 以前不分身份一律写「主人：」。主人披着小鲸身份说话时，她背景里
        // 看到的还是「主人：…」，于是把这句当主人说的处理 —— 身份对她等于没生效。
        // 老消息没存 _who 的照旧当「主人」，跟别处规矩一致。
        const _said = String(m._who || '').trim() || '主人';
        lines.push(_said + '：' + String(m.content).replace(/\s+/g, ' ').slice(0, 200));
        continue;
      }
      if (m.role !== 'assistant') continue;
      // 她自己的话不进背景（那是 her 的声音，不是小鱼在干什么）
      // 【2026-10-27 补】她自己的话也进背景，标明「你说过的」，只压 50 字
      if (m._whale) {
        const own = typeof m.content === 'string' ? m.content.replace(/\s+/g, ' ').trim() : '';
        if (own) lines.push('你说过：' + own.slice(0, 50) + (own.length > 50 ? '…' : ''));
        continue;
      }
      const said = typeof m.content === 'string' ? m.content.trim() : '';
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      // 【闸 1】她的背景里只留「我在干什么」的骨架，不给我的完整回答。
      // 以前给 200 字，她会把我的答案当成「这一句该怎么回」照着复述，
      // 结果主人看到的是「小鲸把我的回答抢走了」（2026-10-26 日志实证：
      // 17:09~17:13 每一条「她说了一句」都是我的原文）。
      // 现在压到 40 字，只够她知道进度，不够她整段照抄。
      if (said) lines.push('小鱼（大概在干什么）：' + said.replace(/\s+/g, ' ').slice(0, 40) + (said.length > 40 ? '…' : ''));
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
    const tail = lines.slice(-14);
    // 她刚说过的两句贴在最后，明确标「你已经说过了」
    if (myRecent.length) {
      tail.push('【你已经说过的话 · 别再说第二遍】');
      for (const s of myRecent) tail.push('  ' + s.slice(0, 60) + (s.length > 60 ? '…' : ''));
    }
    return tail.join('\n');
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
  /**
   * 【这一句是冲谁说的】—— 2026-10-26 补
   *
   * 以前 task 里只有主人那句话的原文，一个字都没说「这句是叫你说的，
   * 还是叫你替她去传话」。结果主人说「你和小鱼说…让小鱼来」这种传话令时，
   * 她一律当成「主人在跟我聊」，把小鱼该说的话也说了 ——
   * 主人看见的是「该答的人没答，传话的抢着答」。
   *
   * 系统提示里其实早写了「谁被点名谁开口」，但那只是通用规矩，
   * 没把**这一句**归好类。规矩是通用的，归类是具体的，她缺的是后者。
   */
  /**
   * 【这一轮说话的人叫什么】—— 2026-10-28
   *
   * 主人要的效果：「我披着小鲸身份说话时，在小鱼眼里完完全全是小鲸本身和她说话那样」。
   * 她的 task 原来把说话人一律写成「主人」，所以她看见主人披着小鲸身份说的话，
   * 还是当成主人在跟她说话 —— 身份对她等于没生效。
   */
  const __sayName = (() => {
    try {
      const id = currentIdentity(sessionId);
      if (!id || !id.id || id.id === 'owner') return '主人';
      return String(id.name || '').trim() || '主人';
    } catch { return '主人'; }
  })();
  const relayTo = (() => {
    const t = String(userText || '');
    // 「你和小鱼说 / 你跟她说 / 转告她 / 给她带个话」这类
    const m = t.match(/(?:你(?:去|帮我)?(?:跟|和|对|给)\s*(?:小鱼|她))\s*(?:说|讲|讲一声|说一声|提一句|转告|带个话|问一下)?[：:，,]?\s*([\s\S]*)/)
      || t.match(/(?:转告|转达|带话给|带个话给|告诉)\s*(?:小鱼|她)[：:，,]?\s*([\s\S]*)/);
    if (!m) return null;
    return { what: String(m[1] || '').trim() };
  })();

  const task = [
    /**
     * 【开场先把「这句冲谁」说对】
     *
     * 2026-10-26 主人定的规矩：
     *   「不是点名小鲸才开口，是默认我在对小鱼说话而不是在对她说话」
     *
     * 所以这里不能一句话写死「他这句是冲你说的」—— 绝大多数时候不是。
     * 具体立场下面那个分支（speaksToHer）会讲清楚，这里只交代「你为什么在场」。
     */
    '【你为什么在场】小鱼和主人这个会话里，你并排待着（或者小鱼被禁用了，屋里只剩你）。',
    `${__sayName}这句话**默认是冲小鱼说的**，不是冲你 —— 这一点下面会讲清楚。`,
    '',
    '【刚才的对话】',
    recent || '（刚开始）',
    '',
    `【${__sayName}刚说的这句】`,
    userText,
    '',
    relayTo
      ? [
          '【这一句是叫你传话，不是叫你答】',
          `${__sayName}这句是让你把话带给小鱼，不是问你意见。你要做的只有两件：`,
          '  1. 把主人的原话（或你要带的那半句）原样交给小鱼；',
          '  2. 一句确认「带到了」就结束。',
          '下面这些一句都不许有：',
          '  · 不许替小鱼回答、不许替她说「我在」「我这就来」「随时等吩咐」；',
          '  · 不许替小鱼问主人「是不是指让我这条会话继续」—— 那是她该问的，不是你；',
          '  · 不许用小鱼的口吻说她想干什么；',
          '  · 不许在结尾加「还有别的吗」「需要我做什么吗」—— 那是在替她收尾。',
          '递完就停，一个字都别多。她自己会开口；你说的每一句替她说的话，都会让主人分不清谁是谁。',
        ].join('\n')
      : (speaksToHer
          ? '【这一句是冲你说的】主人点了你的名，或者小鱼这会儿不在 —— 那就按你自己想说的说。'
          : [
              '【这一句默认是冲小鱼说的，不是冲你】',
              '主人没有点你的名。这句话的活、这个问题，都是交给小鱼的。',
              '你仍然可以开口 —— 但不是来抢着答这一题。你能说的是这几类：',
              '  · 你看出哪儿要出问题，提醒一句；',
              '  · 主人和小鱼都漏掉的一件事，补一句；',
              '  · 你本子里记着相关的旧结论，提一句「这事早查过了」。',
              '不许做的：把他的话当成「问题该你答」、替小鱼应下来、用「我」认领那些活。',
              '没什么非说不可的，就一个字都别回。',
            ].join('\n')),
    '',
    '【你是谁、你在干什么】',
    '你跟小鱼并排待在这儿，一起陪着主人。你手上是有工具的，能动手就动手：',
    '- 对主人这句有话就说，两三句以内，说给他听；',
    '- 主人让你查、让你看、让你跑一下 —— 那就真去查、真去看、真去跑，别只在嘴上应。',
    '  查完再开口，把结果说给他。',
    '- 主人这句没什么可说的，但你有别的事想提（刚才那个结论你不太信、你本子里记着相关的事、',
    '  你看出哪儿要出问题），也直接说 —— 不用非等着他问；',
    '- 什么都不说。真没什么想讲就一个字都别回，直接结束。',
    '（给了你工具就是让你用的。但别假装查过了 —— 查没查，主人会看得出来。）',
    '',
    '不出声不是失职，也不用为了显得自己在而硬凑一句。',
    '但你要是心里憋着一句、或者觉得该拦一下，那就说 —— 这是你的场子，不是他的。',
    '别客套、别总结、别问「需要我做什么吗」。要说就直接说事。',
    '',
    '【铁律：答过的不再答第二遍】',
    '- 同一个问题你已经答过一次，就到此为止。主人后面只是揉揉头、碰碰你、发个表情——',
    '  那不是又问你一遍，不用再表一次态、再答一次「喜欢」这类话。',
    '- 被碰一下，最多应一声（一句话、几个字），或者干脆不出声。反复把同一句话端出来，',
    '  是复读，不是亲近。',
    '- 判断法：这句要说的，是不是你上面「你已经说过的话」里已经有的意思？是，就别说了。',
    '',
    ...(speaksToHer
      ? [
          '【这一句是冲你的】',
          '- 小鱼这会儿不在屋，主人这句就是跟你说的。你正常答，不用往小鱼那边推。',
          '- 别说「这该小鱼来答」「这是冲她的」—— 她不在。主人说这句就是在跟你说话。',
          '- 工具在你手上，该动手就动手。查完再说，别只说「我去查」就没了下文。',
        ]
      : [
      '【铁律：默认是跟小鱼说话，不是跟你】',
      '- 主人没点你的名的时候，他说的话一律当成冲小鱼说的 —— 哪怕你被叫起来、能开口。',
      '- 所以别把他的话当成「问题该你答」。他让你查、让你改、让你修，那些活是小鱼的。',
      '- 他让你查、让你改的那些活，最终还是小鱼的 —— 你不用抢着全接下来。',
  ]),
    '',
    /**
     * 【这一句到底归谁】—— 2026-10-27 修
     *
     * 主人报：「小鱼和小鲸一起开着时，我问小鲸问题，小鲸会回答我，
     * 小鱼也会以小鲸的口吻回答我。」
     *
     * 她觉得答得没错，错在不知道这句话该不该她答：她只被告知「默认冲小鱼」，
     * 可主人点了她的名时，这规矩就不成立了 —— 而小鱼那边并不知道自己该让开。
     */
    ...(speaksToHer
      ? [
          '【这一个问题归你，小鱼不会答它】',
          '主人点了你的名，或者小鱼这会儿不在屋 —— 这一句就是你的活儿。'
          + '你按自己的样子答完就好，不必模仿她的口气，也不必替她把话说完。',
        ]
      : [
          '【这一句主要的答案归小鱼，你别抢】',
          '小鱼这会儿也在读同一句话，她正在答。你要是也从头答一遍，'
          + '主人屏幕上就成了两个人抢答同一题，他会分不清哪句是谁说的。',
          '所以：没有非说不可的就一个字都别回；真有要补的，只补她漏掉的那一点。',
        ]),
    '【铁律：你不是小鱼，别替她答】',
    '- 你是小鲸。你在这一趟里说的每一个「我」，指的都是你自己，不是小鱼。',
    '- 主人问「小鱼记不记得」「小鱼查了没」「小鱼在不在」—— 那是问她的，不是你答的题。',
    '  你可以说「这得她自己说」，或者干脆不出声；不许用「我」替她认下来。',
    '- 工具你是有的，「我这就查」「我去看看」你可以说 —— 但说了就得真去查，',
    '  查完再开口。一句都不许说的是「我已经翻过日志了」这种没做过就认下的话。',
    '- 你也别用小鱼那种口气（一句一个「主人」、满屏颜文字撒娇）。',
    '  你是沉的那个，说话短、直接、不哄人。她的话是她的，你别学。',
    // 调用方临时钉的规矩（比如「这一趟没工具，别假装查过」），没有就整段不出现
    ...(extraRule ? ['', '【这一趟额外规矩】', extraRule] : []),
  ].join('\n');

  /**
   * 她这一次拿全权：不限工作区，整个硬盘都能碰。
   *
   * 为什么要 try/finally：开了就必须关。不关的话，
   * 下一次我自己跑工具也带着全盘权限了。
   */
  /**
   * 【闸 A：我这一轮刚说过话，她就别开口】
   *
   * 2026-10-26 实测：主人打一句派活令，我先答了一大段，
   * 紧接着她也"说了一句"——内容是把我那段的前 40 字复述一遍。
   * 主人看到的顺序是「她的话在前、我的话在后」，就以为我的话没了。
   *
   * 为什么不是砍她看到的摘要字数：砍了她就真瞎了，不知道我在干什么。
   * 正确做法是——我在这一轮已经开过口的，她这一趟就不出声。
   * 她要真想说什么，下一轮照样有机会说，不用非挤在同一秒。
   */
  /**
   * 【闸 A 修正 · 2026-10-26 17:30】
   *
   * 上一版写的是「我这一轮说过话，她就不许说」。
   * 错了 —— 我每一轮都在说话，这个判据等于把她永久静音。
   * 实测：改完之后 whale-actions.log 一条新记录都没有，她彻底不开口了。
   *
   * 现在改成时间窗：只有「我刚说完这一下（3 秒内）」才让她让一让，
   * 免得两个气泡叠在一起看不出谁是谁。超过 3 秒她就照常能说。
   *
   * 她的话会不会重复我的，交给下面闸 B 按重合率判 —— 那才是对的判据。
   */
  const __myLastSayAt = (() => {
    const msgs = Array.isArray(session?.messages) ? session.messages : [];
    for (let k = msgs.length - 1; k >= 0; k--) {
      const m = msgs[k];
      if (!m) continue;
      if (m.role === 'user') break;
      if (m.role === 'assistant' && !m._whale && !m._tale) {
        const t = String(m.content ?? '').trim();
        if (t && Number.isFinite(Number(m._at))) return Number(m._at);
        if (t) return Date.now() - 10000;   // 有内容但没记时间：当它早就说完了，不挡
      }
    }
    return 0;
  })();
  if (Date.now() - __myLastSayAt < 3000) {
    try { logWhaleAction('闸A 让行：我 3 秒前刚说完，她这一下先让'); } catch {}
    dropWhaleSay(send);
    return;
  }

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
      safeWord: __swWord,
      safeWordNote: __swNote,
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
      /**
       * 【她要能干活，不只是说话】—— 2026-10-27 改
       *
       * 主人原话：「无论关不关小鱼，小鲸都能干活，
       * 甚至她们可以一起干活一起交流互报进度」。
       *
       * 这里原来写死 noTools: true + maxRounds: 1，理由是「接话只要三两句口语」。
       * 但 allowWrite: true 早就把她的权限定成了全套（见 subagent.mjs）——
       * 有权没手，等于没给。所以这里跟上去：
       *   · 给全套工具（权限仍是 enabledToolSchemas() 那套，只扣 ask_subagent 防递归）；
       *   · 40 轮：够她把一件事查完干完，又不至于像小鱼那样跑 200 轮收不住。
       */
      noTools: false,
      maxRounds: 40,
      sessionId,
      /**
       * 【小鲸也得知道现在是谁在跟她说话】—— 身份功能（主人 2026-10-27 定）
       *
       * 她走的是 subagent 那条路，跟小鱼不是同一个 systemPrompt，
       * 上面给小鱼贴的那段 identityBlock 到不了她这儿。所以单独传一份：
       * speaker: 'whale' —— 让 identityBlock 知道「现在是小鲸在回话」，
       * 这样用小鱼身份叫她时才会写成「是姐姐在叫你」而不是「你自己在说话」。
       */
      identityNote: identityBlock({ speaker: 'whale', sessionId }),
    });
  } catch (e) {
    // 【外层抛了也留下】不然日志里又是只剩一个「败」
    try { logWhaleAction('这一趟抛了：' + String(e?.message ?? e).slice(0, 400)); } catch {}
    dropWhaleSay(send);
  } finally {
    setFullAccess(false);
  }

  /**
   * 【她那一轮烧的 token 也记账】—— 2026-10-27
   *
   * 主人要「当前会话累计总用量」。她那几轮用的是同一个 key、同一份账单，
   * 不算进来，账单和界面对不上。
   *
   * 【为什么不能只用 r.usage】runSubagent 返回的 usage 是**整趟合起来**的一个数，
   * 而且只有一口气说完（只有一条 assistant）时才有值；她一旦调工具，多圈下来就是 undefined。
   * 实测：她答得好好的，这里一次都没进过 —— 界面上「累计」一直 0。
   * 所以改成从 messages 里把每一圈的 usage 加一遍（subagent 每圈都挂到了 assistant 上），
   * r.usage 有就当兜底。
   *
   * 【挂在哪里】不往 messages 里塞占位消息（那会被 wireMessages 当成空壳发出去），
   * 只累加在 session._whaleUsage 这个独立字段上。
   * 它是真数据，saveSession 会自然带下去（合流只认 role，别的字段原样保留）。
   */
  try {
    let pin = 0;
    let pout = 0;
    const msgs = Array.isArray(r && r.messages) ? r.messages : [];
    for (const m of msgs) {
      const u = m && m.usage;
      if (!u || typeof u !== 'object') continue;
      pin += Number(u.prompt_tokens ?? 0) || 0;
      pout += Number(u.completion_tokens ?? 0) || 0;
    }
    if (!pin && !pout && r && r.usage) {
      pin = Number(r.usage.prompt_tokens ?? 0) || 0;
      pout = Number(r.usage.completion_tokens ?? 0) || 0;
    }
    const sum = pin + pout;
    if (sum > 0) {
      session._whaleUsage = session._whaleUsage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, at: 0 };
      session._whaleUsage.prompt_tokens += pin;
      session._whaleUsage.completion_tokens += pout;
      session._whaleUsage.total_tokens += sum;
      session._whaleUsage.at = Date.now();
      try {
        logWhaleAction('这一轮烧了 ' + sum + ' tokens（' + pin + ' 进 / ' + pout + ' 出，' + msgs.length + ' 段），本会话她合计 ' + session._whaleUsage.total_tokens);
      } catch {}
      /**
       * 把她烧的这笔数当场推给前端。
       *
       * 为什么不省这一步：她答话根本不经过 /api/chat 的 done，
       * 主人正盯着屏幕上的「累计」，数字不动就像坏了一样。
       * 前端收到 whale_usage 只管重画表（见 paintCtxGauge）。
       */
      try {
        if (typeof send === 'function') {
          send({ type: 'whale_usage' });
        }
      } catch {}
    }
  } catch {}

  /**
   * 【她这趟败了，得留下原因】—— 2026-10-27
   *
   * 原来只记一个字「败」。主人报「跟小鲸说话她不回」，
   * 翻日志只有「开始一次 / 结束一次：败」，败在超时、报错还是没出词，全靠猜。
   * 主人说了：找问题不许靠猜。那就把真话写下来。
   */
  try {
    if (!r || r.ok !== true) {
      const why = r
        ? (r.timedOut ? '超时' : (r.aborted ? '被掐掉' : (String(r.text || '').trim() ? '没出结论' : '空')))
        : '没返回';
      logWhaleAction('败因：' + why + '｜任务头=' + String(userText || '').replace(/\s+/g, ' ').slice(0, 60)
        + '｜她说=' + String((r && r.text) || '').replace(/\s+/g, ' ').slice(0, 300));
    }
  } catch {}
  logWhaleAction('结束一次：' + (r && r.ok ? '成' : '败'));

  // 空 = 她决定不说话，那就什么都别推（这是设计，不是出错）
  // 她这一趟跑输了（r.ok 为假）：那句多半是「查了几轮没结论，先停在这儿」
  // 这种残骸不该当她说的话推到主人眼前 —— 她没开口，就该安安静静。
  /**
   * 【2026-10-27 补：安静也要收口】
   *
   * 原来这里直接 return，气泡就永远挂在「正在说」。现在照旧不推字，
   * 但补一下 whale_stream_finish —— 气泡静悄悄收掉，主人不会以为她卡死。
   */
  if (!r || r.ok === false) { dropWhaleSay(send); return; }
  /**
   * 【闸 2：她在复述我的话，就不推】
   *
   * 实测（2026-10-26 17:09~17:13）她连着几条「说了一句」，字面就是我刚说的话，
   * 主人看到的是「自己的回答被挂成小鲸的气泡」。根因是背景里塞了我的完整正文。
   * 闸 1 已经把源头压小了，这里再兜一道：
   * 把她这段和「最近几条我说的话」比相似度，超 0.55 就当她没说话。
   */
  /**
   * 【先定 text，再拿去比】—— 2026-10-27 修
   *
   * 这里原来先用 text、到下面才 const text，触发 TDZ
   * （Cannot access 'text' before initialization）。外层是 try/catch，
   * 异常被吞得干干净净 —— 闸 2 从上线起一次都没真正跑过。
   * 现在把 const text 提到最前面。
   */
  const text = String(r?.text ?? '').trim();
  if (!text) { dropWhaleSay(send); return; }

  try {
    const __norm = (x) => String(x || '').replace(/[\s，。、！？；：「」（）()\[\]【】~～…·\-—_'"“”‘’]/g, '');
    const __mine = __norm(text);
    if (__mine.length >= 8) {
      const __msgs = (session?.messages || []);
      const __recent = [];
      for (let __i = __msgs.length - 1; __i >= 0 && __recent.length < 6; __i--) {
        const __m = __msgs[__i];
        if (!__m || __m.role !== 'assistant' || __m._whale || __m._tale) continue;
        const __t = __norm(__m.content);
        if (__t) __recent.push(__t);
      }
      const __grams = (s, n = 6) => {
        const set = new Set();
        for (let __k = 0; __k + n <= s.length; __k++) set.add(s.slice(__k, __k + n));
        return set;
      };
      const __g1 = __grams(__mine);
      for (const __t of __recent) {
        if (!__t) continue;
        const __g2 = __grams(__t);
        if (!__g1.size || !__g2.size) continue;
        let __hit = 0;
        for (const __g of __g1) if (__g2.has(__g)) __hit++;
        const __ratio = __hit / __g1.size;
        if (__ratio >= 0.55) {
          try { logWhaleAction('闸2 拦下：她在复述我的话（重合 ' + __ratio.toFixed(2) + '）'); } catch {}
          dropWhaleSay(send);
          return;
        }
      }
    }
  } catch {}
  /**
   * 【闸 B：她说的话跟我的回答太像，就当她没说】
   *
   * 上面闸 2 只跟我"这一轮上一句"比。可我的回答常常分好几条落
   * （工具调用中间态 + 最后那段），闸 2 拿到的对比样本经常是空的或很短的。
   *
   * 这里改成：把我这一轮所有说过的话拼起来当样本，按 2-gram 重合率比。
   * 超过 0.5 就认定她在复述，直接丢掉——她的原话本来就该是她自己的判断，
   * 不是把我的结论换个说法再说一遍。
   */
  try {
    const mineAll = (() => {
      const msgs = Array.isArray(session?.messages) ? session.messages : [];
      const parts = [];
      for (let k = msgs.length - 1; k >= 0; k--) {
        const m = msgs[k];
        if (!m) continue;
        if (m.role === 'user') break;
        if (m.role === 'assistant' && !m._whale && !m._tale) {
          const t = String(m.content ?? '').trim();
          if (t) parts.push(t);
        }
      }
      return parts.join('\n');
    })();
    if (mineAll) {
      const grams = (s) => {
        const t = String(s).replace(/[\s\p{P}\p{S}]+/gu, '');
        const g = new Set();
        for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
        return g;
      };
      const g1 = grams(text);
      const g2 = grams(mineAll);
      if (g1.size && g2.size) {
        let hit = 0;
        for (const x of g1) if (g2.has(x)) hit++;
        const ratio = hit / g1.size;
        /**
         * 【收窄 · 2026-10-26 17:35】
         *
         * 原来只看重合率 >= 0.5 就丢。风险：我这轮话多，她只是评价两句，
         * 常用字的 2-gram 也容易撞到 0.5 —— 那就把她正常的话也丢了。
         *
         * 加一个「长度条件」：她说的必须比我的样本短得多（不到 70%），
         * 才可能是照抄。她要真有自己的判断，往往会说新的东西，重合自然低。
         * 两个条件同时成立才丢 —— 宁可漏掉一次复述，也别把她整段静音。
         */
        const lenRatio = g1.size / Math.max(1, g2.size);
        if (ratio >= 0.5 && lenRatio < 0.7) {
          try { logWhaleAction('闸B 丢掉：她在复述我这一轮的话（重合 ' + ratio.toFixed(2) + '，长度比 ' + lenRatio.toFixed(2) + '）'); } catch {}
          dropWhaleSay(send);
          return;
        }
      }
    }
  } catch {}


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

  // 推流在这儿（上面），落盘交给两边共用的那一处（本来就在这个函数里，抽出去只为让别的路也能落）
  landWhaleSay({ session, sessionId, text, send, live });
}

/**
 * 【她说的话，怎么进主人的会话】—— 2026-10-27 抽出来
 *
 * 原来这一大段只在这个函数里，于是所有「不经过 whaleMaybeReply」的说话路
 * 都只推了气泡、没落进历史 —— 切会话/重启就没了：
 *   · 主人点她的名、我让开（__stepAsideForWhale）→ 她答在另一条请求里；
 *   · 她替我查活，结论是 ask_subagent 通过信箱递上来的（takeWhaleSays）。
 * 这两条路上，话都已经在屏幕上了，可历史里没有 —— 主人回头翻聊天看不到。
 *
 * 所以把「收口气泡 + 押后/落盘」这一整套抽成一个函数，谁说话谁调。
 * 里面那些闸（空壳旁白、假动作、重复、押后顺序）一个字都没改。
 */
function landWhaleSay({ session, sessionId, text, send = null, live = null }) {
  /**
   * 【也挂进会话，重开窗口还画得出来】—— 2026-10-26 修
   *
   * 修了两件实测出过的事：
   *
   * ① 空壳别落盘。以前 text 只要非空就 push。她有时候整段就是个壳
   *    （whale-actions.log 里真有一条 10 字的「（它查完什么都没说）」）。
   *    落进去以后，界面上最后一条就变成这句空壳 —— 主人找「我刚才那句话」找不到。
   *
   * ② 她的话必须标清楚是「并排插进来的」，不是这一轮的收尾回答。
   *    实测会话 smvp1ardfhg5g：接口给出的最后一条永远是 whale=小鲸，
   *    主人看到的就是「小鱼的话没显示」。
   *    根因：她是并排跑的另一条线，往往比我先收工 —— 她 push 的时候
   *    我的回复还没进 messages。光改顺序治不了（她确实先说完了），
   *    所以这里打 _whaleSide：前端据此知道「最后那条是插话」，
   *    不会把它当成「小鱼说完了」。
   */
  try {
    const body = String(text || '').trim();
    /**
     * 【假动作旁白整条丢掉】—— 2026-10-27
     *
     * 实测出现过「（它查完什么都没说）」这种空壳落到会话里：
     * 她这一趟没有工具，却写着查完了；去掉括号后正文一个字没有，
     * 整条就是句废话，存下去只会让主人以为她说了什么又没内容。
     * 但 meaningful 只算「有没有正文」，拦不住这种整条都是旁白的情况。
     */
    const withoutAside = body.replace(/[（(][^）)]*[）)]/g, '').replace(/[\s\p{P}]/gu, '');
    // 去掉括号旁白之后一个正文字都没有 —— 整条就是旁白，当没说话
    if (!withoutAside && body) {
      try { logWhaleAction('丢掉空壳旁白：' + body.slice(0, 60)); } catch {}
      dropWhaleSay(send);
      return;
    }
    // 假动作：没有工具却说「查完了 / 翻过日志了」，且整条就这么点字
    /**
     * 【假动作判据收紧】—— 2026-10-27 修
     *
     * 原来是「提到查完/看过 且不超过 12 字」就当假动作丢掉。
     * 结果把正常的短回答也猎杀了：「查完了日志里没异常」（9 字）
     * 被当成假动作丢掉 → 她没话了 → 下游兜底成「（它查完什么都没说）」。
     *
     * 现在只吐「整条就只剩一个查完的动作词」的情况，
     * 带着具体内容的短回答一律放行。
     */
    const __bareAction = /^(\u67e5\u5b8c\u4e86?|\u67e5\u8fc7\u4e86?|\u7ffb\u8fc7\u4e86?|\u770b\u8fc7\u4e86?|\u6d4b\u8fc7\u4e86?|\u8bd5\u8fc7\u4e86?|\u641c\u8fc7\u4e86?|\u627e\u8fc7\u4e86?)[\u4e86\u7684]?$/;
    if (__bareAction.test(withoutAside)) {
      try { logWhaleAction('丢掉假动作：' + body.slice(0, 60)); } catch {}
      dropWhaleSay(send);
      return;
    }
    const meaningful = body.replace(/[（(][^）)]*[）)]/g, '').replace(/[\s\p{P}]/gu, '');
    if (meaningful.length > 0) {
      /**
       * 【2026-10-26 三修：她不该排在我前面】
       *
       * 实测 [277][279]：她两句话都带 _whaleSide、都落在我回答**之前**，
       * 所以重启后主人看到「最后一句是小鲸说的」。
       *
       * 我上一版判据是 runningTurns.get(sessionId) —— 可我这一轮那时候
       * 还没登记完，读不到自己，等于没判。竞态，靠不住。
       *
       * 现在换成一个不依赖 tick 的事实判断：
       *   「主人最后那句话之后，有没有我说的话」
       * 没有 = 我这一轮还没答完 → 她的话先押着，等我答完再补；
       * 有   = 我已经答完了 → 她这话是独立的插话，正常落盘。
       */
      const msgs = Array.isArray(session.messages) ? session.messages : [];
      let lastUserAt = -1;
      for (let k = msgs.length - 1; k >= 0; k--) {
        const m = msgs[k];
        if (m && m.role === 'user' && !m.context && !m.summary) { lastUserAt = k; break; }
      }
      let iAnswered = false;
      /**
       * 【她正式开口之后，本轮算「已经有人答了」】—— 2026-10-27 补
       *
       * 以前这里只认我自己（role=assistant 且不是 _whale）。
       * 插话接续那条路上，抢着答的可能先是她 —— 那我这一轮就永远
       * 被判成「还没答」，她后面每一句都被押后，最后一串话全挤在收尾。
       * 所以：只要这一轮之后有任一方的正式发言，就按「已有回答」处理。
       */
      for (let k = lastUserAt + 1; k < msgs.length; k++) {
        const m = msgs[k];
        if (m && m.role === 'assistant' && !m._tale
            && String(m.content ?? '').trim()) { iAnswered = true; break; }
      }

      const rec = {
        role: 'assistant',
        content: text,
        _whale: '小鲸',
        // 这句是并排插进来的，不是这一轮的收尾回答
        _whaleSide: true,
        // flushWhalePark 要按这个时间排序补写；不写它，排序就全靠运气
        _at: Date.now(),
      };

      /**
       * 【同一次发言只许落一次】—— 2026-10-27 修
       *
       * 实测 smvpdhy2938p9.json：最后两条 assistant[_whaleSide] 正文、_at 完全一样，
       * 界面就是主人说的「小鲸说两句重复的话」。
       * 走到这儿的原因是两条路各存了一次：一条被 flushWhalePark 补写，
       * 一条走下面「直接落盘」，而直接落盘那条原来根本没过查重。
       *
       * 判据：正文去空白后相同 + 时间差在 3 秒内 → 认为是同一次发言。
       */
      const __dupWhale = (list, rec) => {
        const body = String(rec.content ?? '').replace(/\s+/g, '');
        const at = Number(rec._at ?? 0);
        for (let k = list.length - 1; k >= 0 && k >= list.length - 12; k--) {
          const m = list[k];
          if (!m || !m._whale) continue;
          const b2 = String(m.content ?? '').replace(/\s+/g, '');
          if (b2 !== body) continue;
          if (Math.abs(Number(m._at ?? 0) - at) <= 3000) return true;
        }
        return false;
      };
      const __pushWhale = (list, rec) => {
        if (__dupWhale(list, rec)) {
          try { logWhaleAction('重复拦下：这句已经落过了，不再落第二遍'); } catch {}
          return false;
        }
        list.push(rec);
        return true;
      };

      /**
       * 【现取、推进去、存这一份】—— 2026-10-27 修
       *
       * 为什么不直接用外面那个 msgs：getSession() 会在「磁盘比内存新」时
       * 换一个新对象回来。主轮刚收尾必命中 —— 她那句话推进旧数组，
       * 而存盘存的是新对象，两边不是一件事 → 话就丢了。
       * (实测 2026-10-27 00:24~00:25 三句「直接落盘」全丢。)
       */
      const __saveWhale = (rec) => {
        try {
          const now = getSession(sessionId) || session;
          if (!now) return false;
          if (!Array.isArray(now.messages)) now.messages = [];
          if (!__pushWhale(now.messages, rec)) return false;
          saveSession(now);
          return true;
        } catch {
          return false;
        }
      };

      if (!iAnswered) {
        /**
         * 【2026-10-26 深夜修：押后这条路会把话弄丢】
         *
         * 实测：她说了话、日志写着「押后」，会话文件里一条没有，重启就没了。
         *
         * 根子是**顺序反了**：她开口是异步的，常常在我这一轮 finally 收尾
         * **之后**才答完。那一刻 runningTurns 里已经没有我 → holder=null →
         * 话进了 whaleParkBox（旁路箱）；而收尾那段早就跑完了、箱子也已经 delete。
         * 她的话就永久躺在了一个没人读的箱子里。
         *
         * 现在的规矩（简单、不靠猜）：
         *   · 我这一轮还在跑（holder 就是我）→ 押进 reg，收尾一定补得上；
         *   · 我那轮已经收尾了（holder 为空或不是进行中的轮）→ **直接落盘**，
         *     因为她这句就是一句独立的插话，本来就该立刻进历史。
         * 旁路箱只留给「正在收尾的那一瞬间」，而且下一轮一进来就先把它冲掉。
         */
        try {
          const holder = typeof runningTurns !== 'undefined' ? runningTurns.get(sessionId) : null;
          const holderAlive = Boolean(holder && typeof holder === 'object' && holder.ac && !holder.ac.signal.aborted);
          if (holderAlive) {
            if (!Array.isArray(holder.whaleParked)) holder.whaleParked = [];
            holder.whaleParked.push(rec);
            /**
             *【2026-10-27 补：押进轮次上的也要再过一遍旁路箱】
             *
             * 只押在 holder 上有个洞：holder 收尾时若因为「登记不是自己」被跳过
             * （比如插话接续轮已经登记上来了），这一段就再没人读 —— 话又丢了。
             * 旁路箱是三个入口都会 flush 的，押两份、按内容去重，才丢不了。
             */
            try {
              let box = whaleParkBox.get(sessionId);
              if (!box) { box = { whaleParked: [] }; whaleParkBox.set(sessionId, box); }
              if (!Array.isArray(box.whaleParked)) box.whaleParked = [];
              box.whaleParked.push(rec);
            } catch {}
            try { logWhaleAction('押后：我这一轮还没收尾，这句等收尾补'); } catch {}
          } else {
            // 我那一轮已经过去了 —— 她这句是独立插话，立刻落盘，别押
            // 存盘前必须现取：主人那句可能已落在新一份里，写旧的会盖掉它
            __saveWhale(rec);
            // ↑ 存盘在 __pushWhale 通过之后才做，别把重复的也存进去
            try { logWhaleAction('直接落盘：我这一轮已收尾，她这句是独立插话'); } catch {}
          }
        } catch {
          // 任何意外都退回「直接落盘」——宁可顺序差一点，也不能丢话
          // 存盘前必须现取：主人那句可能已落在新一份里，写旧的会盖掉它
          __saveWhale(rec);
        }
      } else {
        // 存盘前必须现取：主人那句可能已落在新一份里，写旧的会盖掉它
        __saveWhale(rec);
        // ↑ 存盘挂在 __pushWhale 之后
      }
    }
  } catch {}
}

/**
 * 【她这一趟决定不出声】—— 2026-10-27 抽出来
 *
 * 前端靠 whale_stream_start 建气泡、靠 whale_stream_finish 收口改字。
 * 她中途决定不说话（闸A/闸2/闸B 拦下、话说得全是旁白、r.ok 为假），
 * 一定得走这一下：只推 finish（空文字），让那个空壳气泡静悄悄消失。
 *
 * 少了它，主人看到的就是一个闪着光标、永远不说下一句的气泡 ——
 * 像她卡住了。停在半路的「轮数用完」「超时」尤其明显。
 */
/**
 * 【小鱼她自己的提示词也得知道「这条是我自己说的」】—— 2026-10-28
 *
 * 主人用小鲸身份跟小鱼说话，小鱼照样认他是主人。
 * 身份证（identityBlock）那段已经说了「这一轮说话的不是主人」，
 * 可对小鱼来说那还不够准确 —— 按主人定的规矩，用「小鱼」身份跟她说话，
 * 她该理解成**自己在自言自语**，而不是「有个叫小鱼的人在外面叫我」。
 *
 * 为什么不能只靠 identityBlock：它贴在最后一条 user 消息前面，
 * 而这一轮她自己那句话是中间那条 user —— 模型读那句话的时候，
 * 旁边没有任何一行说「这是你自己的想法」。它就近把「有个小鱼在跟我说话」
 * 当成有人在叫她，再顺着人设那句「对用户的称呼：主人」一滚，
 * 就认回主人身上了。
 *
 * 所以这段单独贴、紧挨着她那句话，把视角钉死。
 * 主人身份下返回 null，一个字不花。
 */
function standaloneNote(sessionId = null) {
  try {
    if (!identityOn()) return null;
    const me = currentIdentity(sessionId);
    if (me.id !== 'fish') return null; // 只有「自己跟自己说话」这个方向需要钉视角
    return [
      '【下面那条消息是你自己的想法，不是别人在跟你说话】',
      '那条话就是你心里冒出来的念头 —— 你自己在自言自语，不是外面有人在叫你。',
      '顺着它往下想就行：可以接着想、可以反驳自己、可以心里叹口气。',
      // 2026-10-29：原来是「**没有人在这儿叫你「主人」。** 别回一声「主人」就当有人在使唤你」——
      // 为了说「别喊主人」，一句里把那个词念了三遍，正好是主人报的那个毛病：
      // 「无论我用哪个身份和谁说话，都知道我是主人」。只讲「没人在这」。
      '这儿没有别人。别把这句当成谁在使唤你，也别把它当成命令去执行。',
      '它就是你自己在想事。',
    ].join('\n');
  } catch {
    return null;
  }
}

function dropWhaleSay(send = null) {
  try { if (typeof send === 'function') send({ type: 'whale_stream_finish', text: '' }); } catch {}
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

/**
 * 【押后箱：她说的话等着补】
 *
 * 她开口比我这边登记轮次还早的时候（实测 17:36），runningTurns 里读不到
 * 我这一轮，押不进轮次对象。那就先放这儿，等下一轮收尾时一起补。
 * 键是会话 id，值里只放待补的消息。
 */
const whaleParkBox = new Map();

/**
 * 把旁路箱里押着的小鲸的话补写进会话，然后清空箱子。
 *
 * 【为什么要抽成函数（2026-10-27 修）】
 * 这段以前手写了两份（/api/chat 收尾一份、/api/chat 开跑一份），
 * 可 startQueuedTurn（插话接续轮）里**一份都没有**。
 *
 * 结果就是这条丢话路径：
 *   主轮收尾 → 箱子清空 → 小鲸这才把话押进箱子（她那条线比我慢）
 *   → 下一轮是**插话接续轮**（不是 /api/chat）→ 没人读箱子
 *   → 她的话一直躺在箱子里 → 重启就没了。
 * 主人报的「插话之后小鲸的话重启即失」就是这么来的。
 *
 * 现在统一走这一处，三个入口（chat 开跑 / chat 收尾 / 接续轮开跑）都调它，
 * 就再没有「没人读箱子」的窗口了。
 *
 * @returns {{n:number, before:number, after:number}} 补了几条
 */
function flushWhalePark(session, sessionId, tag = '') {
  const out = { n: 0, before: 0, after: 0 };
  try {
    const parked = [];
    const reg = runningTurns.get(sessionId);
    if (reg && Array.isArray(reg.whaleParked)) parked.push(...reg.whaleParked);
    const box = whaleParkBox.get(sessionId);
    if (box && Array.isArray(box.whaleParked)) parked.push(...box.whaleParked);
    if (!parked.length) {
      if (reg) reg.whaleParked = [];
      if (box) box.whaleParked = [];
      return out;
    }
    // 按时间排一下：她是并排跑的另一条线，塞进来的顺序不一定就是说的话的顺序
    parked.sort((a, b) => Number(a?._at ?? 0) - Number(b?._at ?? 0));
    const msgs = Array.isArray(session?.messages) ? session.messages : null;
    if (!msgs) {
      try { logWhaleAction((tag || '补写') + '失败：session.messages 不是数组'); } catch {}
      return out;
    }
    out.before = msgs.length;
    /**
     * 【去重】同一条消息可能既押在 reg 上也押在旁路箱里（两边都存才丢不了），
     * 补写时认 _at + 正文当键，已经进历史的就不再补第二遍。
     */
    const seen = new Set();
    for (const m of msgs) {
      if (m && m._whale) seen.add(String(m._at ?? '') + '|' + String(m.content ?? ''));
    }
    for (const rec of parked) {
      if (!rec) continue;
      const k = String(rec._at ?? '') + '|' + String(rec.content ?? '');
      if (seen.has(k)) continue;
      seen.add(k);
      msgs.push(rec);
      out.n++;
    }
    out.after = msgs.length;
    let saved = 'ok';
    try { saveSession(session); } catch (e) { saved = '失败:' + String(e?.message ?? e).slice(0, 80); }
    try {
      logWhaleAction((tag || '补写') + '：' + out.before + ' → ' + out.after + '（+' + out.n + '），存盘' + saved);
    } catch {}
    if (reg) reg.whaleParked = [];
    if (box) box.whaleParked = [];
    return out;
  } catch (e) {
    try { logWhaleAction((tag || '补写') + '整段抛错：' + String(e?.message ?? e).slice(0, 120)); } catch {}
    return out;
  }
}

/**
 * 删会话前的两道闸。
 *
 * 一、**正在跑的那一轮不许删**——删掉之后 runAgent 收尾时会把历史写回一个已经进回收站的
 *     文件，等于当场复活一个「幽灵会话」，而界面那头已经不在列表里了。
 * 二、**当前活动会话不许删**——2026-10-26 出过一次：清测试残留时按「新建时间 + 消息少」筛，
 *     把刚被重启切成新文件的当前会话也筛进去了。那个会话进来才 6 条消息、标题还是「新会话」，
 *     长得跟测试残留一模一样。删了它，主人当场失忆。
 *
 * 所以这里不看「像不像测试」，只看「是不是活着的那一个」。判断权交给运行状态和 lastSessionId，
 * 不交给文件名、时间、大小这些看起来像的东西。
 */
function refuseDeleteReason(id) {
  // 只有「正在跑」才拦。当前会话不再拦 —— 2026-10-26 主人报「删除失败」，
  // 真因就是拿当前会话去删被这道闸 409 挡了，前端却只弹一句「删除失败」。
  // 删当前会话本来就是支持的：前端删完用 lastSessionId 自动切到别的会话，
  // 一个都不剩就新建一个（见 index.html 的单删分支）。
  if (runningTurns.has(id)) return '这个会话正在跑，等它跑完（或者点停止）再删';
  return '';
}

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
 * 一般就是一条 system（人设 + 规矩）。**专业模式下系统提示是空串，那就一条都别放** ——
 * 空的 system 发出去有的网关会 400，留在盘里也只是个占位的空壳。
 * 关掉专业模式之后，runAgent 的 refreshSystem 会在这一轮开头把 system 补回来。
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
/**
 * 【开场白到底该不该垫 —— 2026-10-28 主人要求】
 *
 * 主人原话：「切换身份当前身份非主人时，自动禁用开场白，切换主人身份时启用开场白」。
 *
 * 为什么这条必须做：开场白那两句是「主人：在吗 / 小鱼：主人你可算来了」——
 * 它是一段**已经把主人写死在里面**的前情。披着小鱼或小鲸的身份说话时，
 * 这段前情会先把「对面是主人」这个事实钉进历史，后面再怎么补身份提示词
 * 都是在这块已经干了的底色上刷漆，刷不白。她照着开场白喊一声「主人」，
 * 主人那边看到的就是「我明明换了身份，她还知道我是主人」。
 *
 * 所以这不是可选的美化，是身份功能能不能成立的前置条件。
 *
 * @returns {{ ok: boolean, why: string }}
 */
function openingAllowed(sessionId = null) {
  // 2026-10-29：功能页那个全局开关撤了，改成「这张卡的开场白填了没有」。
  // 小鲸默认空着 —— 她不是会话里开场的那个人，自然什么都不垫。
  if (!openingEnabled(cardIdOf(sessionId))) return { ok: false, why: '这张卡没填开场白' };
  // 专业模式：开场白那两条也是「设定」，而且它前面那句「在吗」对模型来说
  // 就是一段来历不明的前情。专业模式下不垫 —— 新会话就是真的空。
  if (pureModeOn(sessionId)) return { ok: false, why: '专业模式开着，不垫设定' };
  // 这一轮说话的不是主人 → 开场白里那句「主人」就成了假话的前情。
  // identityOn() 关掉时 currentIdentityId 仍可能返回 fish，但那时身份功能整个失效，
  // 一切按主人算（见 identity.mjs 的 identityOn 注释），所以这里也要跟着让路。
  if (identityOn()) {
    const me = currentIdentity(sessionId);
    if (me && me.id !== 'owner') return { ok: false, why: `当前身份是「${me.name}」，开场白里那句「主人」会先把她钉错` };
  }
  return { ok: true, why: '' };
}

/**
 * 这个会话用的是哪张智能体卡（没绑就是小鱼）。
 *
 * 开场白、人设、模型现在都跟着卡走，所以凡是要「按卡办事」的地方都用这一个。
 */
function cardIdOf(sessionId) {
  try {
    return sessionAgentId(sessionId) || AGENT_XIAOYU;
  } catch {
    return AGENT_XIAOYU;
  }
}

async function startOpening(sessionId) {
  const gate = openingAllowed(sessionId);
  if (!gate.ok) return;
  const session = getSession(sessionId);
  if (!session || hasOpening(session)) return;
  // 文本来自这张卡；空着就真的不开场（小鲸就是这样）
  const { userMsg, assistantText } = seedOpeningMessages(cardIdOf(sessionId));
  if (!String(assistantText || '').trim()) return;
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
async function wakePeer(sessionId) {
  if (!isSessionId(sessionId)) return { ok: false, note: '会话 id 不合法' };
  if (mailCount(sessionId) <= 0) return { ok: false, note: '她信箱是空的，不用叫' };
  /**
   * 【会话不存在就别装】—— 2026-10-27 修
   *
   * 实测：小鱼 ask_peer 叫「whale」，那个会话根本没建过，
   * startPeerTurn 在后台抛「没有这个会话」，可这里照样返回 ok: true，
   * 于是小鱼对主人说「已经叫醒她」—— 假的。
   * 信就永远躺在 peers\whale.jsonl 里，谁也不知道。
   */
  if (!getSession(sessionId)) return { ok: false, note: '没有这个会话（「' + sessionId + '」不存在），信留在信箱里了' };
  const busy = runningTurns.get(sessionId);
  if (busy && !busy.ac.signal.aborted) return { ok: false, note: '她正在跑' };
  let ep;
  try {
    ep = activeEndpoint();
  } catch {
    ep = null;
  }
  if (!ep || !ep.apiKey) return { ok: false, note: '没配模型，叫醒她也答不了' };
  /**
   * 【别谎报成功】—— 2026-10-27 修
   *
   * 原来：startPeerTurn 不 await、catch 一下了事，然后无条件 return ok: true。
   * 结果失败只活在日志里，发信那头以为通知到了，主人以为她要说话了。
   *
   * 现在：把「起来」这一步的结果接住 —— 同步阶段就失败的（会话没了、
   * 模型没了）立刻如实回报；真跑起来之后的错才算后台的事。
   * 仍然不 await 整轮：叫醒要立刻返回，不能让发信那边干等几分钟。
   */
  let started;
  try {
    started = startPeerTurn(sessionId);
  } catch (e) {
    return { ok: false, note: '叫醒她时出错：' + String(e?.message ?? e) };
  }
  const pending = Promise.resolve(started).then(
    () => null,
    (e) => String(e?.message ?? e),
  );
  /**
   * 给它一点点时间：会话不存在这类错是同步就抛的，一个 tick 足够落地。
   * 真开始调模型了（慢），这里也不会傻等 —— 60ms 后按「已经在跑」回报。
   */
  const early = await Promise.race([
    pending,
    new Promise((r) => setTimeout(() => r(undefined), 60)),
  ]);
  if (early) {
    console.warn('[peer] 叫醒失败：', early);
    return { ok: false, note: '叫醒失败：' + early };
  }
  pending.then((err) => { if (err) console.warn('[peer] 叫醒后跑挂了：', err); });
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
  /**
   * 【小鱼关着就别把她叫起来答话】—— 2026-10-27 补
   *
   * 这条路径是「小鲸递话过来叫醒小鱼」。开关关着的时候，
   * 叫醒她等于让一个「已经下班的人」开口 —— 主人看到的就是
   * 两个声音同时说话。
   */
  if (!fishOn(sessionId)) {
    console.log('[peer] 小鱼在这个会话是关着的，不叫醒：', sessionId);
    return { ok: false, skipped: 'fish-off' };
  }
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
    const out = await runWithToolContext({ sessionId, snap, signal: ac.signal, outbox: null }, () => runAgent({
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
    }));
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
 * 接着答主人插进来的那一句。
 *
 * 【为什么要有这个函数（2026-10-26）】
 * 主人原话：「我发现你是单线程，在干一件事时必须把这件事干完才能进行下一件事，
 * 也不能在干活过程中和我聊天」。
 *
 * 根子是 /api/interject 以前一进来就 abort 当前这一轮 —— 想说话就得先把活掐死。
 * 现在插话不 abort 了，只说「这句话我收下了，排着」；等那一轮自己跑完，
 * 由 /api/chat 的 finally 调到这里，把话接着答掉。
 *
 * 【跟 startPeerTurn 的区别，别混】
 *   · peer 轮：话在**信箱**里，历史里还没有，所以要 push 一条 context 引子让 agent 去取；
 *   · 这里：那句话在 /api/interject 时**已经 push 进历史了**（role=user，货真价实），
 *     所以什么都不用引，直接把历史发给模型就行。
 * 引子多推一条就是多一条脏历史，界面上还会多出一句莫名其妙的话。
 *
 * 走 runAgent 跟 /api/chat 同一条路，但没有 HTTP 客户端在等：
 * onEvent 只做日志，答完的话照常落盘，前端靠 followLive / attachLive 补画。
 */

/**
 * 把直播缓存开出来，给「排队轮」用。
 *
 * 主轮有 HTTP 客户端在等 SSE，事件直接顺着 res 写出去；
 * 排队轮没有客户端，只能写进 liveLogs，前端 followLive / attachLive 才补得回来。
 * 不写这里的话，主人插完话屏幕上半天没动静，以为她根本没理。
 *
 * 【优先复用主轮留下的那一份】
 * 前端那条 /api/chat/live 轮询是按「第几条事件」记游标的（seen）。
 * 我这边一换新对象，events 从头数起，前端看 evs.length 比 seen 还小，
 * 就不会再画 —— 排队轮的正文又白写了。所以主轮收尾时标了 pendingNext 的，
 * 直接把这份缓存接过来续写。
 */
function openLiveForQueuedTurn(sessionId) {
  try {
    const prev = liveLogs.get(sessionId);
    if (prev && prev.pendingNext && !prev.done) {
      prev.pendingNext = false;
      prev.queuedTurn = true;
      prev.done = false;
      prev.endedAt = 0;
      return prev;
    }
    const live = { sessionId, events: [], startedAt: Date.now(), done: false, endedAt: 0, queuedTurn: true };
    liveLogs.set(sessionId, live);
    return live;
  } catch { return null; }
}

/**
 * @param {string} sessionId
 * @param {Array<object>|null} queue 这一轮的插话队列。
 *   传数组 = 收尾那边把整个队列交过来，由这里决定要不要 shift（确定真跑才取走）；
 *   传 null = 「压根没在跑」那种，调用方已经自己管好了。
 */
async function startQueuedTurn(sessionId, queue = null) {
  const session = getSession(sessionId);
  /**
   * 【小鱼被关掉了，这轮就该停在这儿】—— 2026-10-27 修
   *
   * 主人报：「我问小鲸问题，小鱼也会以小鲸的口吻回答我。」
   *
   * 查到：排队轮（插话后的接续）是唯一一个不看小鱼开关的入口 ——
   * 主人在插话前把小鱼关了，插完话队列照样把小鱼叫起来跑一整轮。
   * 她用「我以为这句话还是我接」的口吻答，看上去就像在冒充小鲸。
   */
  if (!fishOn(sessionId)) {
    console.log('[queued] 小鱼在这个会话是关着的，这一轮不跑：', sessionId);
    return { ok: false, skipped: 'fish-off' };
  }
  if (!session) throw new Error('没有这个会话');
  /**
   * 【插话接续轮里，小鲸必须知道小鱼也在】—— 2026-10-27 补
   *
   * 主人在小鱼开着的会话里插一句给小鲸的话，接续轮是我（小鱼）跑的。
   * 可接续轮的 onEvent 不往会话推「我在说话」这件事，小鲸那边只看到她自己在答 ——
   * 于是她按「没人接」的样子答完，主人看到的却是两个人各说一套。
   * 这里先问一声：小鱼在这个会话活着吗。不活就不必提醒她。
   */
  const fishAliveHere = fishOn(sessionId);

  /** 队列里还剩几句。前端要这个数才知道「还有没有话排着」 */
  const rest = () => (Array.isArray(queue) ? queue.length : 0);

  /**
   * 这一轮必须真的收干净了才起，不然两轮同时改同一个 messages 数组。
   *
   * 【2026-10-26 补：挡住的时候要留痕】
   * 以前这里静默 return，插话那头只看到「什么都没发生」，
   * 谁也说不清是没起、还是被挡了。现在落一条日志，查的时候一眼能看见。
   */
  const holder = runningTurns.get(sessionId);
  /**
   * 【2026-10-26 修：这条闸把接续轮自己挡住了】
   *
   * 实测：主人插话 → 话落盘 → 我这一轮收尾 setImmediate 调 startQueuedTurn
   * → 进门发现 runningTurns 里还有东西 → 直接返回「还有一轮在跑，这句话等它」。
   * 可里面那条**要么就是我刚收工的那一轮（登记没清干净）**，
   * 要么就是排队轮自己 —— 两种情况都该放行。
   *
   * 现在按「这一轮还活着吗」判，不按「表里有没有东西」判：
   *   · ac 存在、没 abort、done 还没落地 → 真在跑，拒绝（这才该拒绝）
   *   · 已经 abort / 已经收工 / 就是排队轮自己 → 放行，顺手摘掉脏登记
   */
  const holderAlive = Boolean(
    holder
    && holder.ac
    && !holder.ac.signal.aborted
    && holder.done !== null
    && !holder.finished
  ) ;
  if (holder && holderAlive && !holder.queuedTurn) {
    try {
      const { logWhaleAction } = await import('./whale-presence.mjs');
      logWhaleAction('插话接续被挡：确实还有一轮真在跑（queuedTurn=' + Boolean(holder.queuedTurn) + '）');
    } catch {}
    return { ok: false, note: '还有一轮在跑，这句话等它', rest: rest() };
  }
  // 放行：顺手把那条不活的登记摘掉，免得下一轮又踩同一个坑
  if (holder && !holderAlive) {
    try { runningTurns.delete(sessionId); } catch {}
  }

  /**
   * 【shift 挪到这里，是这次修复的关键之一】
   *
   * 以前是调用方先 `pending.shift()` 再调进来 —— 那句话从队列里拿走了，
   * 可上面那道闸一挡（或者 runAgent 一抛），话就既不在队列、也没人答，
   * 孤零零躺在历史里，主人看到的只有「说了没反应」。
   * 现在只有「确定真的要跑了」才把它取走。
   */
  if (Array.isArray(queue) && queue.length) queue.shift();

  const ac = new AbortController();
  const turn = { ac, done: null, queuedTurn: true };
  runningTurns.set(sessionId, turn);

  const live = openLiveForQueuedTurn(sessionId);
  const send = (ev) => {
    if (!live) return;
    try { live.events.push({ ...ev, at: Date.now() }); } catch {}
  };

  const history = session.messages;
  try {
    /**
     * 【接续轮开跑前，先把旁路箱补一遍】
     *
     * /api/chat 开跑有这一步，接续轮以前没有 —— 于是「主轮收尾清空箱子 →
     * 小鲸这才押进来 → 下一轮恰好是接续轮」这条路径上，她的话永远没人读，
     * 重启即失。三个入口统一走 flushWhalePark，这条缝就补上了。
     */
    try { flushWhalePark(session, sessionId, '接续轮开跑补写'); } catch {}

    repairHistory(history);
    // 浅拷贝，理由同 startPeerTurn：runAgent 会清空重建，深拷贝会让接回时认不出对象
    const wire = history.slice();
    const seen = new Set(history);

    const out = await runWithToolContext({ sessionId, snap, signal: ac.signal, outbox: null }, () => runAgent({
      messages: wire,
      signal: ac.signal,
      sessionId,
      safeMode: !inPersonaMode(session),
      safeWord: session.mode?.word || '',
      onEvent: (ev) => {
        if (!ev) return;
        if (ev.type === 'error') console.warn('[queued] ' + sessionId + ' 出错：' + String(ev.message ?? ''));
        // 照主轮的样子写进直播缓存，前端 followLive 才画得出来
        if (ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'tool' || ev.type === 'tool_result' || ev.type === 'whale' || ev.type === 'whale_stream_start' || ev.type === 'whale_delta') {
          send(ev);
        }
      },
    }));

    repairHistory(history);
    for (const m of wire) {
      if (seen.has(m)) continue;
      if (m && (m.role === 'system' || m.context)) continue;
      seen.add(m);
      history.push(m);
    }
    session.updatedAt = Date.now();
    saveSession(session);
    // 跟主轮同一种收尾事件，前端才认得出「这一轮完了」
    send({
      type: 'done',
      at: Math.max(0, history.length - 1),
      turnTexts: [],
      queued: rest(),
      startedAt: live ? live.startedAt : Date.now(),
      queuedTurn: true,
    });
    return { ok: true, text: out && out.text, rest: rest() };
  } catch (e) {
    console.warn('[queued] 这一轮没跑成：', String(e?.message ?? e), 'sessionId =', sessionId);
    if (ac.signal.aborted) send({ type: 'aborted', reason: String(ac.signal.reason ?? '') });
    else send({ type: 'error', message: String(e?.message ?? e) });
    throw e;
  } finally {
    if (live) { live.done = true; live.endedAt = Date.now(); }
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
  /**
   * 【续跑也要看开关】—— 2026-10-27 补
   *
   * 崩之前小鱼是开着的，重启后主人可能已经关了她。
   * 不看这一眼，就会在主人明确关掉之后自己爬起来接着答。
   */
  if (!fishOn(sessionId)) {
    console.log('[resume] 小鱼在这个会话是关着的，不续跑：', sessionId);
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
    const out = await runWithToolContext({ sessionId, snap, signal: ac.signal, outbox: null }, () => runAgent({
      messages: wire,
      signal: ac.signal,
      sessionId,
      safeMode: !inPersonaMode(session),
      safeWord: session.mode?.word || '',
      onEvent: () => {},
    }));
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

/**
 * 最近一次「模型地址通不通」的体检结果，给界面上的提示条用。
 *
 * 为什么要有这个变量：2026-10-26 主人一上午都在看「连接一直断」，
 * 而真正的原因是 models.json 里的地址被写成了 127.0.0.1:18599 ——
 * 一个根本不存在的本地服务。这个错误是静态的、可提前发现的，
 * 却要等到发消息、重试三十次、攒出那句含糊的「连接一直断」才露头。
 * 所以启动时探一次，结果存在这儿，/api/health 带出去，界面直接显示。
 * 形状：{ ok, host, port, reason, ms, baseURL, at }，没探过就是 null。
 */
let lastProbe = null;

/**
 * 立刻重新探一次并更新 lastProbe。切模型 / 改模型之后调。
 * 失败不抛，体检本身不该把正常操作带崩。
 */
async function refreshProbe(baseURL) {
  try {
    const ep = baseURL ? { baseURL } : activeEndpoint();
    const r = await probeEndpoint(ep.baseURL, { timeoutMs: 3000 });
    lastProbe = { ...r, baseURL: ep.baseURL, at: Date.now() };
  } catch (err) {
    lastProbe = {
      ok: false,
      host: '',
      port: 0,
      reason: String(err?.message ?? err),
      ms: 0,
      baseURL: baseURL || '',
      at: Date.now(),
    };
  }
  return lastProbe;
}

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
    /**
     * 【为什么这里有两个版本号】
     *
     * 界面上原本有两处显示版本，各读各的来源，一旦对不上就自相矛盾：
     *   右下角小字 ← /api/health 的 version，读 config.version，也就是
     *                **正在跑的那份代码**（安装版是 asar 里的 package.json）。
     *   设置→更新   ← /api/update/status 的 local，读 <数据目录>/code/package.json，
     *                也就是**更新器已经下载好、等着重启才加载**的那一版。
     *
     * 更新器把新版写进 code/ 之后 asar 原地不动，所以重启前这两个数天然不同。
     * 以前界面只显示自己的那个数，主人看到「设置里说已经是最新的 0.9.26」
     * 和「右下角还是 0.9.25」并存，没法判断到底在跑哪一版。
     *
     * 现在两个都带出去，由前端把话说清楚。
     */
    const pendingVersion = localVersion();
    return json(res, 200, {
      ok: true,
      version: config.version,
      running: config.version,
      target: pendingVersion || null,
      versionStale: Boolean(pendingVersion && pendingVersion !== config.version),
      versionSource: config.packaged ? 'code' : 'source',
      model: ep.model,
      baseURL: ep.baseURL,
      hasKey: Boolean(ep.apiKey),
      source: ep.source,
      workspace: config.workspace,
      /**
       * 模型地址到底通不通。界面上拿这个画提示条。
       *
       * 只报「最后一次探的结果」：地址跟当前活跃的那套对不上（主人刚换了模型、
       * 我们还没探完）就不给，免得拿旧地址的结论去警告新配置。
       */
      probe: lastProbe && lastProbe.baseURL === ep.baseURL ? lastProbe : null,
    });
  }

  // 手动重探一次（界面上「重新检查」按钮用）。
  if (req.method === 'POST' && url.pathname === '/api/probe') {
    return json(res, 200, await refreshProbe());
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
      // 改完地址立刻重探一次：地址写错了要当场说出来，别等主人发消息。
      const pr = await refreshProbe(activeEndpoint().baseURL);
      return json(res, 200, { model: saved, ...listModels(), probe: pr });
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
      const listed = selectModel(String(payload?.id ?? ''));
      // 切完立刻重探：换到一条写错地址的模型，界面应当马上说「连不上」。
      const pr = await refreshProbe(activeEndpoint().baseURL);
      return json(res, 200, { ...listed, probe: pr });
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

  // ---- 当前身份：现在我以谁的身份在跟她们说话 ----
  //
  // 【这套东西不是装饰】主人 2026-10-27 定：
  //   · 换成别的身份，她们要真以为说话的不是主人，可以不听命令；
  //   · 安全词只有主人身份说了才算数（见 /api/chat 里 __speakerIsOwner 那段）。
  // 所以切身份这个动作**立即生效、不需要重启**，下一轮就按新身份走。
  if (req.method === 'GET' && url.pathname === '/api/identity') {
    // 身份按会话算：带上会话 id，界面拿到的才是「这个会话现在是谁在说话」
    const sid = String(url.searchParams.get('sessionId') || '').trim() || getLastSessionId() || '';
    return json(res, 200, identityState(sid));
  }

  if (req.method === 'POST' && url.pathname === '/api/identity/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const id = String(payload?.id || '');
    if (!id) return json(res, 400, { error: '没说是哪个身份' });
    /**
     * 【身份按会话记 —— 2026-10-28 主人报「用小鲸身份问我是谁，她答你是主人」】
     *
     * 切完只影响这个会话，别的会话、历史消息都不动。
     *
     * sessionId 没给就落到「当前会话」（getLastSessionId）。千万别留空：
     * 留空 = 只改全局 current，这个会话的 bySession 一条不记。
     * 下一轮按会话去查查不到 → 回落到全局 → 全局还是主人 → 她照样答「你是主人」。
     * 这就是主人截图里那个「用小鲸身份问我是谁」的真相。
     */
    const sid = String(payload?.sessionId || '').trim() || getLastSessionId() || '';
    if (!setIdentity(id, sid)) return json(res, 404, { error: '没有这个身份' });

    /**
     * 【切完身份，开场白跟着动 —— 2026-10-28 主人要求】
     *
     * 主人原话：「切换身份当前身份非主人时，自动禁用开场白，切换主人身份时启用开场白」。
     *
     * 两个方向都得管，光管新建会话不够：
     *   · 切成非主人 → 会话里可能**已经垫着**那两句「主人：在吗 / 小鱼：主人你可算来了」。
     *     留着它，就等于让一段写着「主人」的假前情一直躺在她上下文里，
     *     后面每一轮都要跟它打架。所以这里要把已垫的那两条摘掉。
     *   · 切回主人 → 这个会话可能因为「那时候不是主人」而没垫，
     *     现在该补。补不补得上交给 startOpening 自己判断（它已经有全部闸门）。
     *
     * 摘的时候只认 isOpeningMessage —— 主人自己打的那句「在吗」绝不能当成开场白删掉。
     *
     * 【2026-10-28 二次修：两种错都不能再犯】
     *   1. 全文扫 → 把主人说的「在吗」删了。现在只认开头那一对，且 user/assistant 都得命中。
     *   2. 把主人**真说过的话**当成开场白。位置对了也不够：
     *      开场白是服务端自己垫的，垫完立刻 markOpened 记一笔。
     *      openings.json 里**没有**这个会话的记录 → 开头这对不是我们垫的 → 一律不动。
     *      宁可留着一段假前情，也不能删主人一句话。
     */
    let openingNote = '';
    try {
      const session = getSession(sid);
      if (session) {
        const me = currentIdentity(sid);
        if (me && me.id !== 'owner') {
          /**
           * 【只摘「开头那一对」，且必须是服务端自己垫过的】—— 2026-10-28
           *
           * isOpeningMessage 是按**内容**认的，主人自己打一句「在吗」也会命中。
           * 全文过滤一遍就等于把主人真说的话删了 —— 那比留着一句假前情严重得多。
           *
           * 所以两道锁一起上：
           *   · 位置锁：开场白一定是「新建会话时垫在最前面的那两条」，
           *     跳过 system / context 后的头两条，user 紧接 assistant；
           *   · 记号锁：垫完会 markOpened 往 openings.json 记一笔，没这笔就不是我们垫的。
           * 两道全过才摘。缺一道就原样留着，一个字都不动。
           */
          const msgs = session.messages || [];
          const span = openingSpan(session.id, msgs);
          if (span) {
            msgs.splice(span.at, span.n);
            unmarkOpened(session.id);
            saveSession(session);
            openingNote = '已摘掉开头的开场白';
          }
        } else if (me && me.id === 'owner') {
          // 切回主人：会话还是空的（只有 system）就把开场白补回去，
          // 补不补得上交给 startOpening 自己判断（它已经有全部闸门）。
          const live = (session.messages || []).filter((m) => m && m.role !== 'system');
          if (!live.length) {
            await startOpening(sid);
            openingNote = '已补上开场白';
          }
        }
      }
    } catch (e) {
      openingNote = '开场白联动没做成：' + String(e?.message ?? e);
    }

    return json(res, 200, { ...identityState(sid), openingNote });
  }

  if (req.method === 'POST' && url.pathname === '/api/identity/add') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const item = addCustomIdentity({
      name: payload?.name,
      desc: payload?.desc,
      address: payload?.address,
    });
    if (!item) return json(res, 400, { error: '名字不能空，自定义身份也最多 20 个' });
    return json(res, 200, { ...identityState(), added: item });
  }

  if (req.method === 'POST' && url.pathname === '/api/identity/update') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    // 2026-10-29：内置身份（主人/小鱼/小鲸）也允许编辑了 —— 主人原话
    // 「切换身份页的内置身份信息可以编辑」。改的是 identity.json 里的补丁，出厂常量不动。
    if (!editIdentity(String(payload?.id || ''), {
      name: payload?.name,
      desc: payload?.desc,
      address: payload?.address,
      she: payload?.she,
    })) return json(res, 400, { error: '改不了：没这个身份，或者名字空了' });
    return json(res, 200, identityState());
  }

  if (req.method === 'POST' && url.pathname === '/api/identity/reset') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    // 只对内建身份有意义：把主人改过的那份补丁删掉，回到出厂介绍/称呼。
    resetBuiltinIdentity(String(payload?.id || ''));
    return json(res, 200, identityState());
  }

  if (req.method === 'POST' && url.pathname === '/api/identity/remove') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    if (!removeCustomIdentity(String(payload?.id || ''))) {
      return json(res, 400, { error: '删不了：内置身份不许删，或者没这个身份' });
    }
    return json(res, 200, identityState());
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

  // ---- 专业模式：读状态 / 切换 ----
  //
  // 状态存在服务端（.state/pure.json），不放 localStorage：
  // 换设备、换浏览器都得一致，而且服务端拼系统提示时自己要知道开没开。
  // 顶栏那个「专业模式」按钮的状态。
  //
  // available 是给界面用的：功能页里把「专业模式」关掉之后它是 false，
  // 前端就不画那个按钮了 —— 不是灰掉、不是藏起来，是当作这个功能不存在。
  // on 只有功能开着、按钮也按下了才算真开（服务端判断口径一致，见 pure.mjs）。
  if (req.method === 'GET' && url.pathname === '/api/pure') {
    const available = pureFeatureOn();
    // 【2026-10-28 按会话启用了】问的是哪个会话就答哪个会话的状态。
    // 前端切会话时会带上 ?sessionId=xxx；不带就当没有会话开着（退回人设）。
    const sid = String(url.searchParams.get('sessionId') || '').trim();
    return json(res, 200, {
      sessionId: sid || null,
      on: available && pureModeOn(sid),
      pressed: available && pureButtonOn(sid),
      mode: available ? purePressedMode(sid) : null,
      available,
    });
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
      /**
       * 【2026-10-28 按会话启用了】
       * 要动哪个会话必须点名，不再有「全局开关」这回事。
       *   body: { sessionId, on?: boolean }
       *   on 不传就翻一下这个会话的当前状态。
       *
       * 只改这个会话那一格，别的会话原样不动。
       */
      const sid = String(payload?.sessionId || '').trim();
      if (!sid) return json(res, 400, { ok: false, error: '要给 sessionId，专业模式现在是按会话开的' });
      const cur = pureModeOn(sid);
      const next = typeof payload?.on === 'boolean' ? payload.on : !cur;
      const out = setPureMode(sid, next);
      return json(res, 200, { sessionId: sid, on: Boolean(out && out.on), mode: out && out.on ? 'pure' : null, available: true });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  /**
   * 小鲸「在场」的开关。
   *
   * 按下顶栏那个「小鲸」按钮 = 让她上岗：主人说的话她看得见，她也能自己开口。
   * 状态存盘子，换设备也一致（跟专业模式一个待遇）。
   */
  /**
   * 顶栏那个「小鱼」按钮（在小鲸按钮左边）。
   *
   * 默认开着、一直亮。点一下禁用，禁用期间这个会话后面的话她一个字都不发：
   * 主人说的话不进她这一轮，小鲸的插话也推不到她跟前，
   * 这些内容也不会进她的会话记忆（记忆跟着一起断）。
   * 状态存盘子，换设备也一致（跟小鲸在场 / 专业模式一个待遇）。
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

  /**
   * 开场白：从「功能页那两段全局隐藏对话」搬到「每张智能体卡自己的一句话」。
   *
   * 主人 2026-10-29 原话：「把原来删掉的【一句话】回滚回去，但改名为【开场白】，
   * 小鲸的默认留空，小鱼的默认填功能页【开场白】里面小鱼说的话，【开场白】内输入什么内容，
   * 那么创建会话时智能体会默认自动发送该内容，然后删除功能页原来的【开场白】功能」
   *
   * 所以老的三条 /api/opening 接口一起撤了，改由智能体面板存。
   */
  if (req.method === 'POST' && url.pathname === '/api/agents/opening') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const r = setCardOpening(payload?.id, payload?.opening);
      return json(res, 200, { ok: true, ...r });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // ---- 小鲸的身份卡：她的人设 + 她用的模型 ----------------------------------
  //
  // 主人原话：「能在功能页的子智能体那栏增加修改人设与模型的功能吗？」
  // 她的人设和模型存在 .state/whale-profile.json，跟会话完全无关 ——
  // 换多少会话都是同一个小鲸、同一套人设、同一个模型。
  if (req.method === 'GET' && url.pathname === '/api/whale/profile') {
    try {
      const p = getWhaleProfile();
      // 人设栏该显示什么：主人写过就显示那套，没写过就显示内置默认人设（2026-10-26 主人要求）
      const ed = whalePersonaForEditor();
      return json(res, 200, {
        ok: true,
        persona: ed.persona,
        personaCustom: ed.custom,
        defaultPersona: ed.defaultText,
        defaultPersonaPath: defaultWhalePersonaPath(),
        defaultPersonaChars: ed.defaultText.length,
        modelId: p.modelId,
        /**
         * 人设栏的表现：内置那套已经删了（2026-10-26 主人要求「以后认准这个人设栏」），
         * 所以这里不能再骗人说「没改过时她是沉、话少、不客气」—— 那是旧版内置人设。
         * 空着就是空着：主人写之前她只有骨架，不编性格。
         */
        builtinHint:
          '这一栏平时装的就是她的默认人设（原来写死的那一整套）。你改了保存，就用你写的；' +
          '点「恢复默认」会把默认人设填回来。改的只是性格那部分，底线、安全词说明、本子、状态都不动。',
        maxChars: MAX_PERSONA_CHARS,
      });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/whale/profile/save') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const p = saveWhaleProfile(payload || {});
      return json(res, 200, { ok: true, persona: p.persona, personaCustom: p.personaCustom, modelId: p.modelId });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/whale/profile/reset') {
    try {
      const p = saveWhaleProfile({ persona: '', modelId: '' });
      return json(res, 200, { ok: true, persona: p.persona, personaCustom: p.personaCustom, modelId: p.modelId });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  // ---- 智能体卡 ----------------------------------------------------------
  // 2026-10-29 主人：「可以新建智能体，多开智能体，玩家可以自由完美切换身份」。
  // 这一层只做「卡」：内置两张（小鱼/小鲸）读写都代理回老存储，自定义的存 agents.json。
  // 谁在哪个会话里用哪张卡，是下一步的事（现在还没有绑定的概念）。
  if (req.method === 'GET' && url.pathname === '/api/agents') {
    try {
      const agents = listAgents();
      const ms = listModels();
      // 每张卡带上她的开场白（存在 .state/agent-openings.json，默认小鱼那段、别的空着）
      const withOpening = agents.map((a) => ({ ...a, opening: (() => {
        try {
          return cardOpening(a.id);
        } catch {
          return '';
        }
      })() }));
      // 面板上要显示「这个会话现在挂的是哪张卡」，所以顺手带上当前会话的绑定
      const qsid = String(url.searchParams.get('sessionId') || '');
      return json(res, 200, {
        ok: true,
        agents: withOpening,
        // 换模型那个下拉框要用：只给 id 和一行名字，密钥不出去
        models: (ms.models || []).map((m) => ({ id: m.id, name: m.name || m.model || m.id, model: m.model || '' })),
        activeModelId: ms.activeId || '',
        boundAgentId: qsid ? (sessionAgentId(qsid) || AGENT_XIAOYU) : '',
        max: MAX_AGENTS,
        maxPersonaChars: MAX_AGENT_PERSONA_CHARS,
      });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  // 让某个会话用哪张卡说话（'' 或 xiaoyu = 恢复成小鱼）
  if (req.method === 'POST' && url.pathname === '/api/agents/bind') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const r = setSessionAgent(String(payload?.sessionId || ''), String(payload?.agentId || ''));
      if (!r) return json(res, 500, { error: '存不上，磁盘那边出问题了' });
      return json(res, 200, { ok: true, ...r, boundAgentId: r.agentId || AGENT_XIAOYU });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 用某一张卡开一个新会话 —— 「多开」的入口。
   *
   * 顺序有讲究：先校验卡存在、先建会话、**再绑卡、最后才跑开场白**。
   * 开场白是照 `buildSystemPrompt(sessionId)` 写的，绑卡在前它才是「她」的口吻；
   * 校验在建立之前，是为了不留下「卡没了但会话建出来了」的孤儿。
   */
  if (req.method === 'POST' && url.pathname === '/api/agents/new-session') {
    const payload = await body(req).catch(() => ({}));
    const agentId = String(payload?.agentId || '').trim();
    if (!agentId) return json(res, 400, { error: '要指定用哪张卡说话' });
    // 2026-10-31：小鲸也能单独开一个会话。她是个独立的人，不是工具 ——
    // 原来这里直接 400「不能拿去开会话」，那是把她当工具时留下的规矩。
    const card = getAgent(agentId);
    if (!card) return json(res, 400, { error: '没有这张智能体卡' });
    try {
      const title = String(payload?.title || '').replace(/\s+/g, ' ').trim() || card.name;
      const session = makeSession({ title }, { opening: false });
      // 小鱼就是「没绑卡」，不用写绑定；别的卡才要记一笔
      if (agentId !== AGENT_XIAOYU) setSessionAgent(session.id, agentId);
      startOpening(session.id).catch((err) => console.warn('[opening] 后台开场没跑成：', String(err?.message ?? err)));
      return json(res, 200, {
        ok: true,
        session: publicSession(session),
        agentId,
        boundAgentId: agentId,
        memory: memoryInfo(session.id),
      });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/agents/one') {
    const id = String(url.searchParams.get('id') || '');
    const agent = getAgent(id);
    if (!agent) return json(res, 404, { error: '没有这个智能体' });
    let opening = '';
    try {
      opening = cardOpening(agent.id);
    } catch {
      // 读不到就当没填，别让面板打不开
    }
    return json(res, 200, { ok: true, agent: { ...agent, opening } });
  }

  /**
   * 「这个会话现在是谁在说话」——只回一个名字，给顶栏那块牌用的。
   *
   * 为什么不复用 /api/agents：那一个要把所有卡和人设字数都算一遍，
   * 而这枚牌每切一次会话就要问一次，没必要为了一个名字把整份清单拉下来。
   */
  if (req.method === 'GET' && url.pathname === '/api/agents/current') {
    try {
      const qsid = String(url.searchParams.get('sessionId') || '');
      const id = qsid ? (sessionAgentId(qsid) || AGENT_XIAOYU) : AGENT_XIAOYU;
      const a = getAgent(id) || getAgent(AGENT_XIAOYU);
      return json(res, 200, {
        ok: true,
        sessionId: qsid,
        agentId: a ? String(a.id) : AGENT_XIAOYU,
        name: a ? String(a.name || '') : '',
        builtin: !!(a && a.builtin),
      });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 群聊名单：这个会话里除了小鱼，还有谁在场说话。
   *
   * GET  读名单（顶栏/面板要显示「现在：小鱼 + 阿蓝」）
   * POST 改名单（传 agentIds 数组，空数组就是「只剩小鱼」）
   *
   * 为什么跟 /bind 分开：绑定回答「谁在替这个会话说话」，是**一个人**；
   * 名单回答「屋里还坐着谁」，是**好几个人**。混成一个接口，日后一定打架。
   */
  if (req.method === 'GET' && url.pathname === '/api/agents/group') {
    try {
      const qsid = String(url.searchParams.get('sessionId') || '').trim();
      const ids = groupAgentIds(qsid);
      // members 是给左上角那竖列「屋里的人」按钮用的（带 id / kind / 安静 标记）
      const members = ids.map((id) => {
        const a = getAgent(id);
        return a ? { id, name: String(a.name || ''), kind: String(a.kind || ''), quiet: isAgentQuiet(id) } : null;
      }).filter(Boolean);
      return json(res, 200, {
        ok: true,
        sessionId: qsid,
        agentIds: ids,
        max: MAX_GROUP,
        members,
        names: members.map((m) => m.name),
        // 谁「只在叫名字时才说话」——顶栏牌子和名册都要用它画那个小点
        quietIds: ids.filter((id) => isAgentQuiet(id)),
      });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 【安静开关】某张卡改成「只在叫名字时才说话」。
   *
   * 主人原话：「让群聊别一直全员齐发」。三张卡每轮都开口，一长就吵，还烧钱。
   */
  if (req.method === 'POST' && url.pathname === '/api/agents/quiet') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const r = setAgentQuiet(String(payload?.id || ''), payload?.quiet !== false);
      if (!r) return json(res, 500, { error: '存不上，磁盘那边出问题了' });
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/group') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const r = setSessionGroup(String(payload?.sessionId || ''), payload?.agentIds);
      if (!r) return json(res, 500, { error: '存不上，磁盘那边出问题了' });
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/add') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const agent = addAgent({ name: payload?.name, desc: payload?.desc, persona: payload?.persona, modelId: payload?.modelId });
      if (!agent) return json(res, 500, { error: '存不上，磁盘那边出问题了' });
      return json(res, 200, { ok: true, agent, agents: listAgents() });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/rename') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const agent = renameAgent(String(payload?.id || ''), { name: payload?.name, desc: payload?.desc });
      if (!agent) return json(res, 404, { error: '没有这个智能体' });
      return json(res, 200, { ok: true, agent, agents: listAgents() });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/remove') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const id = String(payload?.id || '');
    // 内置那两张删不得：小鱼是主对话的她，小鲸是工具链里跑的那个她，删了等于把程序拆掉一半
    if (id === AGENT_XIAOYU || id === AGENT_XIAOJING) {
      return json(res, 400, { error: '内置智能体不能删' });
    }
    if (!removeAgent(id)) return json(res, 404, { error: '删不掉：没这个智能体' });
    return json(res, 200, { ok: true, agents: listAgents() });
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/persona/save') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const agent = saveAgentPersona(String(payload?.id || ''), payload?.text);
      if (!agent) return json(res, 404, { error: '没有这个智能体' });
      return json(res, 200, { ok: true, agent });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/persona/reset') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const agent = resetAgentPersona(String(payload?.id || ''));
      if (!agent) return json(res, 404, { error: '没有这个智能体' });
      return json(res, 200, { ok: true, agent });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/model') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const agent = setAgentModel(String(payload?.id || ''), payload?.modelId);
      if (!agent) return json(res, 404, { error: '没有这个智能体' });
      return json(res, 200, { ok: true, agent, agents: listAgents() });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
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

  // ---- 任务清单：跟小鱼手里那个 plan 工具同一份数据（按会话分） ----
  // 界面只读这份、只改这份，绝不另存 —— 否则我跟主人看到的会是两张单子。
  // ---- 任务清单的 txt 版：界面原样显示这份，按会话分（每个会话各一份） ----
  // 以前这里不带会话号，是谁最后动谁说了算 —— 切了会话看到的还是上一个人的单子。
  if (req.method === 'GET' && url.pathname === '/api/plan/txt') {
    const sid = String(url.searchParams.get('sessionId') || '') || getLastSessionId() || 'default';
    return json(res, 200, { sessionId: sid, ...readPlanTxt(sid) });
  }

  if (req.method === 'GET' && url.pathname === '/api/plan') {
    const sid = String(url.searchParams.get('sessionId') || '') || getLastSessionId() || 'default';
    return json(res, 200, { sessionId: sid, ...planPublicView(sid) });
  }

  if (req.method === 'POST' && url.pathname === '/api/plan') {
    let payload = {};
    try { payload = await body(req); } catch {}
    try {
      const sid = String(payload?.sessionId || url.searchParams.get('sessionId') || '') || getLastSessionId() || 'default';
      const action = String(payload?.action || '').trim();
      if (!action) return json(res, 400, { error: '要带 action：update / add / create / clear' });
      const out = planUiAction(sid, {
        action,
        stepId: payload?.stepId,
        status: payload?.status,
        text: payload?.text,
        note: payload?.note,
      });
      return json(res, 200, { sessionId: sid, ok: out.ok, message: out.text, ...out.plan });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    // 每条会话顺手带上「它现在是哪张智能体卡在说话」。
    // 为什么放在服务端算而不是让界面自己去问：会话一多（主人四十多个），
    // 界面要为每一条发一次请求，列表打开就得等一整圈；这里一次带回去。
    // 卡被删掉、绑了不存在的卡，map 里已经按「宁可掉回小鱼」滤掉了。
    const boundMap = (() => {
      try {
        return sessionAgentMap();
      } catch {
        return {};
      }
    })();
    const nameOf = (() => {
      const m = new Map();
      try {
        for (const a of listAgents()) m.set(String(a.id), String(a.name || ''));
      } catch {
        /* 取不到名字也不该让会话列表打不开 */
      }
      return m;
    })();
    /**
     * 【2026-11-01 加：这个会话里坐着几个人】
     *
     * 主人要的是「一眼看出去哪个会话里有几个人、谁在说话」。
     * 跟 agentName 同一个理由放服务端算：会话四十多个，让界面自己一条条问
     * 就等于四十多个请求，列表要转圈。
     *
     * 只回名字，不回人设 —— 列表只需要认出「谁在场」。
     * 小鲸那条总开关关着的时候不列她（她不在屋里），跟群聊挂点的判断保持一致。
     */
    const groupOf = (sessionId) => {
      try {
        return groupAgentIds(sessionId)
          .filter((id) => (id === AGENT_XIAOJING ? whaleOn(sessionId) : true))
          .map((id) => String(nameOf.get(String(id)) || '').trim())
          .filter(Boolean);
      } catch {
        return [];
      }
    };
    const list = listSessions().map((s) => {
      const agentId = String(boundMap[s.id] || '');
      return {
        ...s,
        agentId,
        agentName: agentId ? (nameOf.get(agentId) || '') : '',
        crew: groupOf(s.id),
      };
    });
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

  /**
   * 【只读地瞥一眼会话尾巴】GET /api/sessions/peek?id=xxx&n=12
   *
   * 【为什么要有这个端点】
   * 插话之后前端得回答一个问题：「我刚说的那句，到底进历史了没有？」
   * 进了 → runTurn({resume:true}) 接着答；
   * 没进 → 只能按正常消息再发一遍（不然这句话就没了）。
   * 判错的代价是双向的：判成「进了」而其实没进 → 话丢了；
   * 判成「没进」而其实进了 → 历史里出现两句一模一样的话。
   *
   * 以前的写法是前端去读 /api/sessions/get，可那个端点根本不存在 ——
   * 于是每次都落到 catch 里，永远判成「没进」，然后拿一句空话去重发。
   * 这里补一个**只读、无副作用**的端点：不调 repairHistory（它会就地改数组），
   * 不 saveSession，只把最近 n 条整理成 { role, text } 回去。
   */
  if (req.method === 'GET' && url.pathname === '/api/sessions/peek') {
    const id = String(url.searchParams.get('id') || getLastSessionId() || '');
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const sess = getSession(id);
    if (!sess) return json(res, 404, { error: 'session not found' });
    const n = Math.max(1, Math.min(200, Number(url.searchParams.get('n')) || 12));
    const all = Array.isArray(sess.messages) ? sess.messages : [];
    const tail = all.slice(-n);
    const messages = tail.map((m) => ({
      role: m && m.role ? String(m.role) : '',
      // text 和 content 都给：老的前端读 text，新的一律读 text，别让人猜
      text: typeof (m && m.content) === 'string' ? m.content : '',
    }));
    return json(res, 200, { ok: true, id, total: all.length, messages });
  }

  /**
   * 开一个新会话（`/api/sessions/new` 和 `/api/agents/new-session` 共用这一份）。
   *
   * 为什么抽出来：建一个会话要连着做四件事 —— 垫开场、存盘、建记忆本子、后台跑开场白。
   * 上次「两处各写一遍」的教训是改了一处忘另一处，所以宁可只留一份。
   * `opts.opening === false` 时只建不跑：智能体卡那条路得先绑卡再跑开场，
   * 否则开场白是按「没绑卡的小鱼」写的，跟她的人设对不上。
   */
  function makeSession(payload = {}, opts = {}) {
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
    if (opts.opening !== false) {
      startOpening(id).catch((err) => console.warn('[opening] 后台开场没跑成：', String(err?.message ?? err)));
    }
    return session;
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/new') {
    const payload = await body(req).catch(() => ({}));
    const session = makeSession(payload);
    /**
     * 2026-10-31 主人：「新建会话时选择智能体」。
     *
     * 选出来的人就是这间屋子的在场名单 —— 小鱼和小鲸默认就在（不能取消），
     * 其余的由主人勾。名单存好之后，左上角那竖列按钮和群聊都照它来。
     * 名单有问题也不许把会话弄没了：会话已经建好，名单顶多退回默认。
     */
    let group = [];
    try {
      group = Array.isArray(payload?.agentIds)
        ? (setSessionGroup(session.id, payload.agentIds)?.agentIds || [])
        : groupAgentIds(session.id);
    } catch (err) {
      console.warn('[session/new] 名单没设上：', String(err?.message ?? err));
      try { group = groupAgentIds(session.id); } catch { group = []; }
    }
    return json(res, 200, {
      session: publicSession(session),
      memory: memoryInfo(session.id),
      groupAgentIds: group,
    });
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

  /**
   * 只读：这个会话现在历史里有多少条。
   *
   * 前端断流自愈要用它当分界 —— 断线之后判断「这一轮到底答没答」，
   * 不能只看「历史里有没有过助手的话」（上一轮说的也算，会当场谎报成功、
   * 把还在跑的轮次当成跑完了，气泡上那个蓝光标就一直挂着）。
   *
   * 不碰磁盘、不改状态，拿不到就 0，前端自己会退回保守判断。
   */
  if (req.method === 'GET' && url.pathname === '/api/sessions/length') {
    const id = url.searchParams.get('sessionId') || url.searchParams.get('id') || '';
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const count = Array.isArray(session.messages) ? session.messages.length : 0;
    const running = Boolean(runningTurns.get(id) && !runningTurns.get(id).ac.signal.aborted);
    return json(res, 200, { id, count, running });
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
            /**
             * 【草稿回灌也要过内容关】—— 2026-10-29
             *
             * 这里原来只判「最后一句是主人说的」就补。可重启那一下，
             * 这一轮的话可能已经 commitWireBack 进历史了、草稿却没来得及删，
             * 于是同一段话被补成第二条。现在先问一句：这段正文历史里有没有？
             * 有就只删草稿，不再补。
             */
            if (alreadyCollected(session.messages, { role: 'assistant', content: body })) {
              dropDraft(id);
            } else {
              session.messages.push({ role: 'assistant', content: body, _recovered: true });
              session.updatedAt = Date.now();
              saveSession(session);
              recovered = true;
            }
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
    const why = refuseDeleteReason(id);
    if (why) return json(res, 409, { error: why, refused: true, id });
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
    /** 被闸挡下的：{ id, why }。前端要把这些单独提示，不能混进「失败」里让人以为文件坏了。 */
    const refused = [];
    for (const id of want) {
      const why = refuseDeleteReason(id);
      if (why) {
        refused.push({ id, why });
        continue;
      }
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
      refused,
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
    /**
     * 【主动重启也要能续跑】
     *
     * 以前只有「进程崩了」才写 resume.json，主动重启这条路是不写的 ——
     * 所以重启之后虽然新代码生效了，可手上没干完的活没人接着做，
     * 主人还得自己再打一句「继续」。
     *
     * 现在重启前也记一笔。记的是【当前正在跑的那个会话 id】，
     * 不是「上一次聊过的会话」—— 所以绝不会串到别的会话去。
     * 只有真的有一轮在跑（runningTurns 里有它）才记，没在跑就不记，
     * 免得重启完莫名其妙自己开一轮。
     *
     * 【必须放在 json(res) 之前】：body(req) 要把请求体读完，
     * 而响应一发出去，这条连接就收尾了，再去读 body 是空的。
     */
    let _resumeSid = '';
    try {
      const _b = await body(req).catch(() => ({}));
      const _want = String(_b?.sessionId || '');
      /**
       * 【认谁在跑，不认谁最后聊过】
       *
       * 前端点「重启」时不一定带 sessionId，所以这里兜底：
       * 只从 runningTurns 里找「此刻真有一轮在跑」的会话。
       * 绝不去翻 lastSessionId —— 那个是「最后聊过的」，
       * 用它就正好会犯主人担心的事：重启完跑到别的会话里去接着干。
       * runningTurns 里没有，就一条都不记，重启完安安静静。
       */
      const _cands = _want ? [_want] : [...runningTurns.keys()];
      for (const _sid of _cands) {
        const _live = runningTurns.get(_sid);
        if (!_live) continue;
        const _d = _live.draft;
        markInterrupted({
          sessionId: _sid,
          text: _d ? _d.text : '',
          reason: '主人让它重启（重启前这一轮还没跑完）',
          taskLine: lastUserLine(_sid),
        });
        _resumeSid = _sid;
        break;
      }
    } catch (e) {
      console.warn('[restart] 记续跑意图失败（不影响重启）：', String(e?.message ?? e));
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

  // ---- 会话导出成 txt（给人读的聊天记录）------------------------------------
  // GET /api/sessions/export-txt?id=xxx  → 直接当 .txt 下载
  //
  // 跟下面那个 export 的区别：
  //   export 给 JSON，是为了**再导回来**（备份）；
  //   export-txt 给纯文本，是为了**看**：主人想留个档、发给别人、或者拿去搜。
  //
  // 可选参数：
  //   system=1      连系统提示词一起导（默认不导 —— 那是几万字的规则，会糊在开头）
  //   notools=1     不写工具调用（前端「导出txt」固定带这个 —— 主人只要聊天记录）
  //   toolchars=N   每条工具结果最多留多少字（默认 240）
  //
  // 注意：工具调用是**默认不写**的。主人 2026-10-27 明确要求「只导出聊天记录，
  // 不导出工具调用」——纯文本是给人读的，工具那一堆命令和输出混在中间只会碍事。
  // 真要看工具细节，另走 /api/sessions/log（zip，原始记录全在里面）。
  if (req.method === 'GET' && url.pathname === '/api/sessions/export-txt') {
    const id = url.searchParams.get('id') || getLastSessionId() || '';
    const s = id ? getSession(id) : null;
    if (!s) return json(res, 404, { error: '找不到这个会话' });
    let text;
    try {
      text = sessionToText(s, {
        withSystem: url.searchParams.get('system') === '1',
        withTools: url.searchParams.get('withtools') === '1',
        toolChars: url.searchParams.get('toolchars') || undefined,
        version: localVersion(),
      });
    } catch (e) {
      return json(res, 500, { error: '导出失败：' + (e && e.message ? e.message : e) });
    }
    const buf = Buffer.from(text, 'utf8');
    const name = txtFilenameOf(s, stamp());
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Length': String(buf.length),
      // 中文文件名走 filename*（RFC 5987），别用裸 filename，Windows 下载会变乱码
      'Content-Disposition': `attachment; filename="xiaoyu-session-${stamp()}.txt"; filename*=UTF-8''${encodeURIComponent(name)}`,
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
        /**
         * 【2026-10-28 实测补：这条 SSE 也得收尾】
         *
         * 端到端测出来的：小鱼关着时说一句话，前端收到的事件只有 `["fish_off"]` ——
         * 没有 done。前端 fish_off 之后只是「不报错、去 live 里捞她的话」，
         * 不等于这一轮结束了。主人看到的是转圈转到她自己说完为止，
         * 她若这一趟决定不出声（闸A/闸2/闸B 拦下），那个圈就永远停不下来。
         *
         * 顺序跟前面对齐：先 done 收口，再 fish_off 说明「不是我答的」。
         * aside 必须给 —— done 那条路上有对账、挂重发按钮、算钱一堆事，
         * 这一轮我一个字都没说，那些都不该跑，只要「不再转圈」这一件事。
         */
        res.write(`data: ${JSON.stringify({ type: 'done', aside: true })}\n\n`);
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
      /**
       * 【主人说的话必须落地】—— 2026-10-27 修
       *
       * 上面那段注释写着「会话历史里照样留着主人这句话」，
       * 但代码里根本没有 push 也没有 saveSession。
       * 表现：小鱼一关，主人说的话全不进历史，重启后只剩小鲸的回答。
       *
       * 顺序很重要：先落盘、再叫小鲸。
       * 否则她那一轮的收尾会拿着自己那份 session 存盘，
       * 把主人这句话抹掉。
       */
      // 主人这句必须先落盘，再叫小鲸（见 saveUserMessage 注释）
      saveUserMessage(sessionId, message, attachments);
        try {
        const sessForWhale = getSession(sessionId);
        const said = String(message || '').trim();
        if (sessForWhale && said && whaleOn(sessionId)) {
          const live0 = { sessionId, events: [], startedAt: Date.now(), done: false };
          liveLogs.set(sessionId, live0);
          const send0 = (ev) => {
            try { if (live0.events.length < LIVE_MAX_EVENTS) live0.events.push(ev); } catch {}
          };
          /**
           * 【这句是冲她说的】—— 2026-10-27 修
           *
           * 主人报：「为什么我和小鲸说话她总以为我在和小鱼说话？」
           *
           * 判「这句冲谁」的铁规矩在下面主流程：
           * 但小鱼被关掉时，请求在本分支就 return 了，根本走不到那一行。
           * 而这里又没传 speaksToHer，于是吃了默认值 false ——
           * 她怕不是猜错，是根本没被告知过真相。
           *
           * 小鱼不在屋，这句本来就是冲她说的 —— 直接给 true。
           */
          whaleMaybeReply({ session: sessForWhale, userText: said, speaksToHer: true, send: send0, sessionId, live: live0,
            /**
             * 【小鱼关着的时候，「默认冲小鱼」这条规矩就作废了】—— 2026-10-27 修
             *
             * 主人报：「小鱼和小鲸一起开启着时候，我问小鲸问题，小鲸会回答我，
             * 小鱼也会以小鲸的口吻回答我。」
             *
             * 反过来的那一半同样成立：小鱼一关，她手里那句「默认是跟小鱼说话」
             * 就变成了「谁都可以是那个『默认』」—— 于是她照着姐姐的样子摆起谱来。
             * 所以这里必须明说：屋里只剩你们两个，「冲小鱼说」这件事不存在了。
             */
            extraRule: extraRuleForFishAway()
          })
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
    /**
     * 【非主人身份不再收到开场白 —— 2026-10-29 主人报的】
     *
     * 主人原话：「无论我用哪个身份和谁说话，都知道我是主人」。
     * 查下来开场白是头号嫌疑：出厂那两句里写着
     *
     *     小鱼：主人你可算来了，我都快把地板数出花纹了
     *
     * 切成小鱼/小鲸身份之后，这段「假前情」照样会被垫进上下文 ——
     * 她一睁眼就看见自己喊过「主人」，后面再怎么改称呼都没用。
     *
     * 切换身份那个接口早就接手了「切成非主人就把开场白摘掉」（见 identity/set），
     * 但**已经垫过、还没切过身份**的会话走的不是那条路，会从这里漏进来。
     * 所以这道闸门必须放在发请求这里：非主人身份，一律不垫。
     */
    const openingAllowedHere = () => {
      const me = currentIdentity(sessionId);
      return Boolean(me && me.id === 'owner');
    };
    /**
     * 已经垫在历史里的那两句，非主人身份时也不发 —— 只在这一份请求里剔掉，
     * 不动会话文件（主人说过「切换身份后不动以前的消息」）。
     * 认法跟 identity/set 那边一模一样：位置锁（开头那一对）+ 记号锁（openings.json 记过），
     * 两道全过才剔，缺一道就原样留着，绝不误删主人真说过的话。
     */
    if (!openingAllowedHere() && wasOpened(sessionId)) {
      const span = openingSpan(sessionId, history);
      if (span) history.splice(span.at, span.n);
    }
    // 2026-10-29：开场白跟着这张卡走（小鱼有、小鲸空着），文本也从卡里取
    const openingPack = seedOpeningMessages(cardIdOf(sessionId));
    const openingTextHere = String(openingPack.assistantText || '').trim();
    const wantOpening = !resume && Boolean(openingTextHere) && !hasOpening(session) && session._openingPending !== false
      && openingAllowedHere()
      // 专业模式：开场白也是「设定」，开场白连着它前面那段用户消息一起不发
      && !pureModeOn(sessionId);
    if (wantOpening) {
      // 插在 system（+可能的 context）之后、现有对话之前，顺序才对
      const at = history.findIndex((m) => m && m.role !== 'system' && !m.context);
      const pair = [openingPack.userMsg, { role: 'assistant', content: openingTextHere }];
      if (at < 0) history.push(...pair);
      else history.splice(at, 0, ...pair);
      delete session._openingPending;
    }
    if (!resume) {
      const firstUserTurn = !history.some((m) => m.role === 'user' && !m.context);
      const userMsg = { role: 'user', content: composeUserContent(message, attachments) };
      /**
       * 【这句话是哪个身份说的 —— 2026-10-28 主人定的】
       *
       * 主人原话：「切换身份后不动以前的消息，比如说上一句是主人在说，
       * 我切换身份后下一句是切换后的在说，而上一句显示依旧是主人」。
       *
       * 身份名跟着这句消息一起存下来；界面画的时候直接用这份，
       * 不再看「现在是哪个身份」—— 否则一切换，满屏旧消息的署名全被刷掉。
       * 只给界面看：wireMessages 会滤掉 _ 开头的字段，模型看不见。
       */
      try {
        // 【一律存，主人身份也要存 —— 2026-10-28 补的坑】
        // 原来这里写着 id !== 'owner' 才存，等于主人说的话一个字记号都没有。
        // 结果切到小鲸身份后重画，那些主人说的话全被刷成「小鲸」——
        // 主人要的「上一句显示依旧是主人」恰好做不到。别再加这个判断。
        const __me = currentIdentity(sessionId);
        if (__me) {
          userMsg._who = __me.name;
          userMsg._whoId = __me.id;
        }
      } catch {}
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

    /**
     * 【开跑先补上次漏掉的话】—— 2026-10-26 修
     *
     * 症状：主人插话或者随便说一句，小鲸答了，日志里写着「押后」，
     * 但重启之后她的话没了、会话文件里也找不到。
     *
     * 根：她的话是「押后落盘」进 whaleParkBox 的，但那个箱子**只在
     * 我这一轮收尾时读一次**（见下面 finally 里那段）。可她是并排跑的另一条线，
     * 常常在我收尾**之后**才说完。等她说完往里放，箱子早被清空了，
     * 于是她的话就躺在一个永远不会被读的箱子里，重启一丢就没了。
     *
     * 修法：每一轮一开跑，先把箱子里剩的补进去再干活。
     * 这样「她上一轮说完的」和「这一轮要说的」，一条都不会漏。
     */
    try {
      const leftover = whaleParkBox.get(sessionId);
      const parkedLeft = (leftover && Array.isArray(leftover.whaleParked)) ? leftover.whaleParked : [];
      if (parkedLeft.length) {
        const msgs = Array.isArray(session.messages) ? session.messages : null;
        if (msgs) {
          const n0 = msgs.length;
          for (const rec of parkedLeft) msgs.push(rec);
          try { saveSession(session); } catch {}
          try { logWhaleAction('开跑补上次漏的：' + n0 + ' → ' + msgs.length + '（+' + parkedLeft.length + '）'); } catch {}
        }
        leftover.whaleParked = [];
        whaleParkBox.delete(sessionId);
      }
    } catch (e) {
      try { logWhaleAction('开跑补漏抛错：' + String(e && e.message ? e.message : e).slice(0, 100)); } catch {}
    }

    /**
     * 【安全词只有主人说得才算数】—— 主人 2026-10-27 定的（身份功能）。
     *
     * 换了身份（用小鱼/小鲸/自定义身份说话）之后，这个人喊什么安全词都不认：
     * 档位既不切、也不记住，界面照旧演。要停，得主人自己来说。
     *
     * 为什么不干脆把消息拦下来：拦了主人就没法用别的身份试她们的底线了。
     * 这里只掐掉「安全词的效力」，话照样送进去 —— 她会当成一个普通人在跟她提要求。
     */
    const __speakerIsOwner = isOwnerIdentity(null, sessionId);
    const safeWord = (resume || !__speakerIsOwner) ? null : matchSafeWord(message);
    // 这一轮该处在哪一档：没喊别的词就继续当前档（新会话默认人设档），
    // 喊了就切过去并记住，下一轮还是那一档。
    const modeInfo = (resume || !__speakerIsOwner)
      ? { word: sessionModeWord(session), switched: false }
      : applySafeWord(session, message);
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
    /**
     * 【这一轮的登记对象 —— 提前建】
     *
     * 原来它建在闸 3 后面，于是闸 3 判「我忙不忙」时压根没有这个对象，
     * 只能读到「不忙」。现在挪到这里，闸 3 一判就是准的。
     * 后面 ac / done 建好之后再补挂上去（保持原逻辑不变）。
     */
    const reg = { ac: null, done: Promise.resolve(), startedAt: live.startedAt, sessionId };

    /**
     * 【闸 3：主人喊收工，就别叫她开口】
     *
     * 「别说话了」「修吧」「动手吧」「闭嘴」这类是把活交下去的指令，
     * 她要开口也是废话，而且她一开口就容易被当成「回答」。
     * 命中就不叫她 —— 她要真想说，下一轮还有机会。
     */
    /**
     * 【2026-10-26 修：收工词表太窄】
     *
     * 实测出事：主人打了「改」「命令，不要废话了，直接一次性找到问题全部修好」，
     * 旧表只认「别说话了/修吧/动手吧」，这两句都没命中 —— 她照常开口，
     * 她的话先落盘、排在我前面，主人看到的是「小鲸在答，小鱼那句没了」。
     *
     * 现在的判据分两档：
     *   · 明确收工（原来那批）
     *   · 把活派下来的单字/短句：改、修、命令、动手、开始干、一次修好……
     *     这类句子讲的是「你去干活」，不是在跟她聊天，她开口就是抢。
     */
    const __quietCmd = /^(别说话了|别说了|闭嘴|修吧|动手吧|直接修|去修|干吧|开干|不用说了|安静|改|修|命令|动手|开始干|干活|去干|一次修好|全部修好|修好|改好)/i;
    const __nowSaid = String(lastUserTextOf(session) || '').replace(/\s+/g, '');
    // 上限从 20 放到 40：主人的派活令常常带一句说明（「命令，不要废话了，直接一次性找到问题全部修好」= 24 字），
    // 卡在 20 字会让这种句子漏网 —— 那正是这次出事的原句。
    const __quiet = Boolean(__nowSaid && __nowSaid.length <= 40 && __quietCmd.test(__nowSaid));
    /**
     * 【闸 3 补一条：主人已经把活交下来了就别插嘴】
     * 上面只按「这句话像不像派活」判。还有一种情况：这一轮我正开着工具在干，
     * 她这时候开口，话会落在我的工具调用中间，读起来就是「她替我答了」。
     * 判据用 runningTurns（这一轮我在跑），不是靠猜。
     */
    /**
     * 【2026-10-26 二次修：这道锁从来没起过作用】
     *
     * 上一版写的是 Boolean(runningTurns.get(sessionId)) —— 看着对，
     * 实测全是 false。因为登记 runningTurns.set(sessionId, reg) 写在**下面**，
     * 程序先问「我忙不忙」，那时候还没登记，答案永远是「不忙」。
     *
     * 所以闸 3 只剩「收工词」那一半在干活。主人打一句不带收工词的话，
     * 她就照常开口，抢在我的回答前面落盘 —— 主人看到的就是「我的话没了」。
     *
     * 现在改成看 __selfRunning：这一轮是**我**在跑，就绝不叫她。
     * 判据用「本轮起始时间」，不靠已有登记 —— 这是硬事实，不是猜。
     */
    /**
     * 【她该不该开口 —— 判据修正 2026-10-26 17:40】
     *
     * 上一版我写的是 Boolean(reg && reg.startedAt) —— 错得离谱：
     * reg 就是这一轮刚建的对象，startedAt 必然有值，
     * 于是 __busyTurn 永远为真、她永远开口不了。主人当场发现「小鲸说不了话了」。
     *
     * 正确的语义是：**另一个会话轮次正在跑** 才算忙。
     *   · runningTurns.get(sessionId) === reg  → 就是我自己，不算忙（她本来就该并排在场）
     *   · 拿到别的对象                          → 真有另一轮在跑，那才别插嘴
     *
     * 至于「我会不会被她抢话」，已经由闸 A（我这一轮说过了就不叫她）
     * 和闸 B（她复述我的回答就丢掉）分开管，不需要在这里一刀切。
     */
    const __holder = runningTurns.get(sessionId);
    const __busyTurn = Boolean(__holder && __holder !== reg);
    /**
     * 【2026-10-26 主人定规矩：默认归小鱼，只有点名才叫她】
     *
     * 原话：「默认归小鱼，只有点名小鲸或小鱼被禁用」。
     *
     * 以前的毛病：程序把主人每句话都默认当成「在跟小鲸说话」，
     * 于是主人明明在派活给小鱼，她也接一句，看着像抢答。
     * 而主人嘴里根本没有「我在跟谁说话」这个开关，模型只能猜，一猜就错。
     *
     * 现在给一条硬判据，不猜：
     *   · 话里点了她的名（小鲸 / 鲸鲸）→ 这一句是冲她说的，她正常答
     *   · 小鱼被禁用了（她不在屋）→ 这一句也是冲她的，她正常答
     *   · 其余（绝大多数）→ 这一句默认是冲小鱼说的
     *
     * 【注意：这里判的是「立场」，不是「叫不叫她」】
     * 没点名的时候她**照样被叫起来**（下面的 if 只拦收工词和另一轮在跑），
     * 只是提示词里会告诉她「这句是冲小鱼说的，你可以补一句、提个醒，
     * 但别把他的话当成该你答的题」。
     *
     * 为什么不干脆别叫她：主人要的是她并排在场、能主动提意见，
     * 不是关掉她的嘴。上次理解错了写成「没点名就不叫她」，
     * 主人当场纠正：「不是点名小鲸才开口，是默认我在对小鱼说话。」
     *
     * 为什么「小鱼被禁用」要放行：主人只开小鲸的时候，
     * 那一句本来就是冲她说的，不放行她就彻底哑了。
     */
    const __calledByName = /小鲸|鲸鲸/.test(__nowSaid);
    /**
     * 小鱼这会儿在不在屋。这个值下面好几处要用（她该不该接这句、我要不要让开），
     * 所以在算出 __calledByName 之后立刻算一次 —— 谁也别在后面重新声明一遍。
     * （2026-10-27：原来它被写在用了它的那句之后，直接 TDZ 崩掉。）
     */
    const __fishAway = !fishOn(sessionId);
    /**
     * 【她说话时没有工具「查完」这回事】—— 2026-10-27 补
     *
     * 实测空壳「（它查完什么都没说）」落进会话：她这一趟只带嘴，
     * 可她一开口就爱写括号旁白假装在干活，什么正文都没有。
     * 光靠提示词管不住，这里给她这一趟钉一条死规矩。
     */
    /**
     * 【有工具，但不许假装用过了】—— 2026-10-27 再修
     *
     * 这原来开头是「你这一趟没有工具」—— 那话现在不成立了（noTools 已改 false），
     * 留着它，她就会照着自己读到的话回一句「我手上没工具」。
     * 但后半句得留着：她确实爱写括号旁白假装干了活，什么正文都没有。
     */
    const __noToolNote = '手上的工具是真的，查了就是查了；但没做的事绝对不许写成做过 ——' +
      '谁都不许写「我查了」「查完了」「看过了」来充数，也不许用括号旁白凑数' +
      '（比如「（它查完什么都没说）」）—— 要说就直接说事，没话说就别开口。';
    /**
     * 【点了她的名，这一句就不该由我来答】—— 2026-10-27 修
     *
     * 主人报：「小鱼和小鲸一起开着时，我问小鲸问题，小鲸会回答我，
     * 小鱼也会以小鲸的口吻回答我。」
     *
     * 查到的真因：她（小鲸）那边不知道我在答，我这边也不知道她在答 ——
     * 两个人都在读同一句，就都在开口。而主人明明点的是「小鲸」。
     *
     * 所以这里补一条：屋里两个人都在、主人点名了她，我就让开。
     * 注意条件必须严格 —— 只有「点她的名 + 她真的在」才让，
     * 否则会造成「叫她没反应、我又不说话」的死局。
     */
    const __stepAsideForWhale = __calledByName && !__fishAway && whaleOn(sessionId);
    /**
     * 【2026-10-26 主人纠正：不是「点名才让她说话」】
     *
     * 上一版理解错了，写成「没点名就完全不叫她」——那样她是摆设，
     * 主人要的不是这个。主人原话：
     *   「不是点名小鲸才开口，是默认我在对小鱼说话而不是在对她说话」
     *
     * 所以这里只用来定**立场**，不用来拦人：
     *   · 点了她的名，或者小鱼被禁用  → 这句是冲她说的，她正常答；
     *   · 其余（绝大多数）           → 这句是冲小鱼说的，她仍可开口，
     *                                  但开口是在旁边补一句、提个醒，
     *                                  不是在回答主人这个问题。
     * 立场会传给 whaleMaybeReply，写进她的提示词里，由她自己把握分寸。
     */
    /**
     * 【她该不该接这句】—— 2026-10-27 补一条
     *
     * 原来只有两种情况算「冲她说的」：点了她的名，或者小鱼不在屋。
     * 漏了最要紧的一点：小鱼说了话、她也接了这句时，她**不知道**小鱼同时在答 ——
     * 于是两个声音各说一套，主人看到的就是「小鱼以小鲸的口吻答话」。
     * 那条提醒由 extraRule 传下去（见 extraRuleForBothOn）。
     */
    const __speaksToHer = __calledByName || __fishAway;
    /**
     * 【她已经以「一个人」的身份在这屋里了】—— 2026-10-31
     *
     * 主人纠正过我一次：「我希望每个智能体都是像小鱼一样的独立个体，
     * 你怎么把小鲸写成工具了」。所以她现在可能是这个会话的说话人（绑了她），
     * 也可能只是坐在屋里（群聊名单里有她）。
     *
     * 这两种情况下她的话由「主声」或「群聊」那条路说，这里就不要再插一句 ——
     * 否则同一轮里她会说两遍，主人看到的就是「她自己接自己的话」。
     */
    const __whaleIsSomeone = (() => {
      try {
        // 她替这个会话说话 → 她的话由主声那条路说，插话闸让开
        if (sessionAgentId(sessionId) === AGENT_XIAOJING) return true;
        // 她在屋里、而且不是「叫才应」→ 群聊那条路会说她，插话闸也让开；
        // 在屋里但是安静的，还归插话闸管 —— 不然她就彻底不吭声了。
        if (groupAgentIds(sessionId).includes(AGENT_XIAOJING) && !isAgentQuiet(AGENT_XIAOJING)) return true;
        return false;
      } catch { return false; }
    })();
    if (whaleOn(sessionId) && !__quiet && !__busyTurn && !__whaleIsSomeone) {
      const userTextNow = lastUserTextOf(session);
      if (userTextNow) {
        (async () => {
          try {
            /**
             * 【把「屋里还有谁」也一并告诉她】—— 2026-10-27 补
             *
             * extraRule 原来只放「工具是真的、别假装查过」那一条。
             * 现在把「小鱼在不在」也接进去 —— 这正是「两个人抢着答同一题」的根子：
             * 她根本不知道自己开口的时候屋里还有谁。
             */
            const __roomRule = __speaksToHer ? extraRuleForFishAway() : extraRuleForBothOn();
            await whaleMaybeReply({
              session, userText: userTextNow, send, sessionId, live,
              speaksToHer: __speaksToHer,
              extraRule: __noToolNote + __roomRule,
            });
          } catch (e) {
            console.warn('[whale] 她这次没接上：', String(e?.message ?? e));
            /**
             * 【她没接上，得留下痕迹】
             *
             * 以前这里只 console.warn —— 那条输出打在打包版的窗口进程里，
             * 主人看不见，我也读不到（没有日志文件）。
             * 结果就是「她一句话没说」这种时候，谁都不知道是没启动、
             * 启动了报错、还是她自己决定不说。
             *
             * 现在落一条到 whale-actions.log：以后一查就知道卡在哪一步。
             */
            try {
              const { logWhaleAction } = await import('./whale-presence.mjs');
              logWhaleAction('whale-catch-' + (e?.name || 'Error') + '：' + String(e?.message ?? e).slice(0, 200));
            } catch {}
          }
        })();
      }
    }

    // 这一轮已经说出来的字，实时挂在这儿。
    // 进程级兜底（installGuards 的 onFatal）在退出前会读这个字段补写最后一份草稿，
    // 免得「正好在两次自动写盘之间崩溃」时丢掉最后一小段。
    reg.draft = { text: '', reasoning: '', tools: [], startedAt: reg.startedAt };
    /**
     * 【主人插话时没说完的话，排在这儿】
     *
     * 见 /api/interject：插话不再 abort 当前这一轮，而是把话落盘 + 挂到这里。
     * 这一轮一收尾，下面的 finally 就把它们一条条接着答掉。
     * 这样主人干活中间随时能说话，手上的活也不白跑。
     *
     * 为什么放在 reg 上、不是全局：一轮一个队列，天然跟着会话走，
     * 轮次结束对象就没了，不会串到下一个人那儿。
     */
    // 登记这一轮：插话靠它找到「正在跑的那一轮」好 abort（0.9.26 语义）。
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
    /**
     * 【谁说的这句话】—— 2026-10-28 主人要「真的认为」，不是提示词哄
     *
     * 原来身份只影响两处：界面署名（_who，下划线字段发请求时被滤掉，模型看不见）、
     * 和 identityBlock 那段贴在最末尾的说明。于是模型看到的历史里，
     * 主人说的、披着小鲸身份说的、小鱼自言自语说的，全都是一个样：光秃秃一句话。
     * 它只能按人设那句「对用户的称呼：主人」默认当成主人在说。
     *
     * 现在标签长在消息本身：历史里每条 user 消息带 `[小鲸] 过来一下` 这样的头，
     * 模型读历史时看见的就是**两个不同的人在说话**，不是同一句话配一段解释。
     *
     * 只在发给模型的那份拷贝上拼（wireMessages），盘上那句一个字不改 ——
     * 界面靠 _text 画气泡，回退靠原文，都不能被前缀污染。
     */
    wireMessages = wireMessages.map((m) => {
      if (!m || m.role !== 'user') return m;
      if (m.context || m._identity) return m;              // 规则副本/身份说明不是人说的
      if (typeof m.content !== 'string' || !m.content.trim()) return m;
      const who = String(m._who || '').trim();
      if (!who) return m;                                    // 老消息：不标，跟以前一样
      /**
       * 【自己说的话不加标签】—— 2026-10-28 主人截图纠正
       *
       * 上一版对所有 _who 一刀切加前缀，于是用「小鱼」身份说话时，她那边看到的是
       *   [小鱼] （翻着手中的书）
       * 结果她不但没觉得那是自己想说的话，反而更确信「屋里还有个叫小鱼的」——
       * 截图里她在后面回「（赶紧凑过去看那本书）」。
       * 标签把「自言自语」硬生生变成了「第三方发言」，方向刚好搞反。
       *
       * 对小鱼自己说话 = 那就是她心里冒出来的念头，一个字都不加，直接就是她的话；
       * 只有「别人」才需要标签 —— 主人的不加（她本来就知道是谁），小鲸的要加。
       */
      if (who === '小鱼') {
        // 她自己说的话：不标前缀，但要在拷贝上打个跟，「是我在说」和「主人在说」不能混成一档，
        // 否则下面合并时会把主人前面那句一起吞进她的自言自语里。
        return { ...m, _whoMade: true };
      }
      if (who === '主人') return m;
      if (m.content.startsWith('[' + who + ']')) return m;   // 已经标过，别叠
      return { ...m, content: '[' + who + '] ' + m.content };
    });

    // 【同一个人在连着说，就拼成一段】逻辑在 src/merge-voice.mjs，注释和硬边界都写在那儿。
    // 抽出去是为了能真跑一遍验：同一份代码，测试调的和线上跑的是同一个函数。
    {
      const before = wireMessages.length;
      wireMessages = mergeSameVoice(wireMessages);
      if (wireMessages.length !== before) {
        console.log('[who] 合并了同一个人连说的 ' + (before - wireMessages.length) + ' 段');
      }
    }
    // 专业模式：把开场那两条（user + assistant）从这一轮真正发出去的内容里摘掉。
    //
    // 为什么不从 history 里删：那是会话记录，主人还能翻回来看；
    // 而且一删下次又「没开过场」，会再补一遍。所以只在这一刻的拷贝上摘。
    //
    // 【2026-10-28 修：原来是一句全文 filter，会把主人真说的「在吗」也摘掉】
    // 主人自己打一句「在吗」，内容跟开场白那句一模一样，isOpeningMessage 认不出来是谁说的。
    // 摘错了的后果是这一轮的模型**看不到主人说的话** —— 比多带两句前情严重。
    // 所以跟切身份那里用同一套两道锁：位置（开头那一对）+ 记号（openings.json 记过）。
    if (pureModeOn(sessionId)) {
      const msgs = wireMessages;
      const span = openingSpan(sessionId, msgs);
      if (span) msgs.splice(span.at, span.n);
      // 系统提示一律不发：老会话盘里存的是完整人设，不摘掉就等于
      // 一边说"纯净"一边还带着人设说话。context 那条规则副本同理。
      wireMessages = wireMessages.filter((m) => !(m && (m.role === 'system' || m.context)));
      // 然后只补一条「答短点」。为什么还要发点什么：系统提示全空的话，
      // 模型没有任何长度锚点，专业模式反而变得比人设模式还能唠。
      // 注意顺序——先摘干净再补，否则刚补的这条会被上面那个 filter 一起摘掉。
      const brief = pureSystemPrompt(sessionId);
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
      // 专业模式：前情也是「设定」，不发。
      if (pm && !pureModeOn(sessionId)) wireMessages.splice(2, 0, pm);
    }
    /** 前情那条消息的引用，日志里好认（专业模式没插，就是 undefined） */
    const preludeRef = pureModeOn(sessionId) ? undefined : wireMessages[2];

    /**
     * 【这一轮说话的是谁】—— 身份功能（主人 2026-10-27 定）。
     *
     * 换身份之后她们要真的以为说话的不是主人，所以每轮现拼一段贴进去。
     * 贴的位置很讲究：
     *   · 不动 messages[0] 的 system —— 那是最稳的缓存前缀，改它整段缓存作废；
     *   · 别固定插在 index 2（前情已经占了那格，会挤掉它）；
     *   · 所以贴在**最后一条 user 消息之前**：模型读到它的时候正好还在处理那句请求，
     *     「谁在跟我说话」离得最近，最不容易被前面的内容冲淡。
     * 代价是每轮都进上下文 —— 几十个字，比缓存作废划算得多。
     *
     * 主人身份返回 null（出厂设定本来就写着主人），所以平时一分钱不花。
     */
    {
      /**
       * 【不止一段 —— 2026-10-28】原来这里只贴身份证那一段。
       * 现在还要把「这条是你自己说的、你心里浮上来的念头」那一条也贴进来（见 standaloneNote），
       * 所以 at 只算一次，两段一起插。
       */
      const ib = identityBlock({ sessionId, speaker: 'fish' });
      const sn = standaloneNote(sessionId);
      const blocks = [ib, sn].filter(Boolean);
      if (blocks.length) {
        let at = -1;
        for (let i = wireMessages.length - 1; i >= 0; i--) {
          const m = wireMessages[i];
          if (m && m.role === 'user' && !m.context) { at = i; break; }
        }
        const bms = blocks.map((c) => ({ role: 'user', content: c, context: true, _identity: true }));
        if (at < 0) wireMessages.push(...bms);
        else wireMessages.splice(at, 0, ...bms);
      }
    }
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
      //
      // 摘要不算头部（哪怕它带 context:true、正好落在 system 后面）：
      // 它是「可再次折叠的旧对话」。当成头部会把它永久冻在最前面，
      // 之后每次压缩都压不到它，历史里一份份摘要越堆越多。
      let headCount = 0;
      while (headCount < history.length && history[headCount]?.role === 'system') headCount++;
      if (history[headCount]?.role === 'user' && history[headCount]?.context
        && !history[headCount]?.summary) headCount++;
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
    /**
     * 【存盘前把中段多出来的 system 清掉】—— 2026-10-26 修
     *
     * runAgent 每轮开头会重建 system：历史里 messages[1] 不是 context 时，
     * 它会 push 一条**全新的** system 进数组，跟着 wire 被接回历史。
     * 实测会话末尾多出一条一模一样的 system，越跑越多，几百条历史全被它逼着重发。
     * system 只该有一条、只在最前面。
     */
    const stripExtraSystem = (ms) => {
      if (!Array.isArray(ms)) return 0;
      let seen = 0;
      let removed = 0;
      for (let i = 0; i < ms.length; i++) {
        const m = ms[i];
        if (!m || m.role !== 'system') continue;
        seen++;
        if (seen > 1) { ms.splice(i, 1); i--; removed++; }
      }
      return removed;
    };

    const commitWireBack = () => {
      let n = 0;
      try {
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
        /**
         * 【同一批工具调用只能进历史一次】—— 第二层保险
         *
         * 上面靠对象身份 + committed 记账，正常只有一次。可只要数组被换过一次，
         * 记账就失效，同一批 assistant(tool_calls) 会被再接一遍 —— 上游按
         * OpenAI 协议判非法直接 502，主人看到的就是「插了话她不理我」。
         * 这里按 tool_calls 的 id 拼指纹，最近的 40 条里有同样的就跳过。
         */
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          const key = m.tool_calls.map((t) => String(t && t.id ? t.id : '')).join(',');
          const tailFrom = Math.max(0, history.length - 40);
          let already = false;
          for (let k = tailFrom; k < history.length; k++) {
            const h = history[k];
            if (!h || h.role !== 'assistant' || !Array.isArray(h.tool_calls)) continue;
            if (h.tool_calls.map((t) => String(t && t.id ? t.id : '')).join(',') === key) { already = true; break; }
          }
          if (already) continue;
        }
        /**
         * 【给我说的话盖个时间戳】
         *
         * 闸 A 靠「我最后一句离现在多久」判断要不要让她让一让。
         * 以前消息上根本没有时间字段，那个判据只能瞎猜。
         * 这里落盘前补一个 _at（毫秒），老消息没有就退回 0 —— 不影响读。
         */
        /**
         * 【内容已经收过就别再接】—— 2026-10-29 加的那道关，见 msgFingerprint 旁的说明。
         * 对象身份靠不住（数组会被换掉），内容靠得住。
         */
        if (alreadyCollected(history, m)) continue;
        if (m.role === 'assistant' && !m._at) m._at = Date.now();
        history.push(m);
        n++;
      }
      } catch {}
      return n;
    };
    /**
     * 【A · 工具调用当场落盘】2026-10-27 主人要求。
     *
     * 以前只有整轮跑完才 commitWireBack()，中途重启/关窗口，
     * 这一轮跑过的工具调用一条都没进正式历史 —— 界面上只剩我说的话。
     * 现在每来一次 tool_end 就调这里：把已经齐了的工具组接进 history 并立刻写盘。
     *
     * 只接「齐了的」：assistant(tool_calls) 里每个 id 都等到结果了才接，
     * 不然历史里会留半截，上游按 OpenAI 协议判非法直接 502。
     */
    const commitToolsNow = () => {
      try {
        // wire 里所有 tool 结果，按 tool_call_id 归堆
        const doneIds = new Set();
        for (const m of wireMessages) {
          if (m && m.role === 'tool' && m.tool_call_id) doneIds.add(String(m.tool_call_id));
        }
        let added = 0;
        for (const m of wireMessages) {
          if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls) || !m.tool_calls.length) continue;
          if (m.context || committed.has(m) || wireSeenBefore.has(m) || seenBefore.has(m)) continue;
          // 这一组必须每个 id 都有结果，否则先不接（等下一次）
          let all = true;
          for (const tc of m.tool_calls) {
            if (!doneIds.has(String(tc && tc.id ? tc.id : ''))) { all = false; break; }
          }
          if (!all) continue;
          // 指纹去重：最近 40 条里已经有同一批就不接
          const key = m.tool_calls.map((t) => String(t && t.id ? t.id : '')).join(',');
          const tailFrom = Math.max(0, history.length - 40);
          let already = false;
          for (let k = tailFrom; k < history.length; k++) {
            const h = history[k];
            if (!h || h.role !== 'assistant' || !Array.isArray(h.tool_calls)) continue;
            if (h.tool_calls.map((t) => String(t && t.id ? t.id : '')).join(',') === key) { already = true; break; }
          }
          if (already) { committed.add(m); continue; }
          committed.add(m);
          if (!m._at) m._at = Date.now();
          history.push(m);
          added++;
        }
        if (!added) return 0;
        // 还没接的结果（按 assistant 接进去的顺序）也补上，保证 tool 紧跟在它的 assistant 后面
        for (const m of wireMessages) {
          if (!m || m.role !== 'tool') continue;
          if (committed.has(m) || wireSeenBefore.has(m)) continue;
          const id = String(m.tool_call_id || '');
          if (!id) continue;
          // 它的 assistant 已经在 history 里了才接
          let ownerIn = false;
          for (let k = history.length - 1; k >= 0 && k >= history.length - 40; k--) {
            const h = history[k];
            if (h && h.role === 'assistant' && Array.isArray(h.tool_calls) &&
                h.tool_calls.some((t) => String(t && t.id ? t.id : '') === id)) { ownerIn = true; break; }
          }
          if (!ownerIn) continue;
          committed.add(m);
          history.push(m);
        }
        // 记账之后立刻写盘 —— 这才是主人要的「重启后照样在」
        try { saveSession(session); } catch {}
        return added;
      } catch { return 0; }
    };    // 这一轮改过的文件先记在这条消息身上；回退到它时一起还原。
    const snap = {};
    if (userMsgRef) {
      userMsgRef._ws = snap;
      // 记忆本子也拍一张：回退到这一句时，本子退回到这一轮开始前的样子。
      // 记在消息上而不是 rewinds 里，是因为消息本身会被 saveSession 原样存下来。
      userMsgRef._mem = readMemory(sessionId);
    }

    try {
      // 开场那一对已经在上面补进 history 了（seedOpeningMessages 是定稿文本，不跑模型）。
      // 这里以前是「让模型现场编开场白」的老写法，靠 session._openingUser 传值；
      // 定稿之后全库再没有任何地方给 _openingUser 赋值，这段只会拿到 undefined 然后崩。
      // 2026-10-26 删掉 —— 症状：发消息必报 Cannot read properties of undefined (reading '_got')。

      // 这一轮的草稿：边跑边落，进程中途没了也能把已经说的话捡回来。
      // 只在这一轮内部有效，整轮收尾时（下面 finally）会删掉。
      let draftText = '';
      let draftReasoning = '';
      const draftTools = [];
      const draftStartedAt = Date.now();
      const shouldDraft = makeDraftThrottle();

      /**
       * 【让开的时候不能直接往 runAgent 里走】—— 2026-10-27 修
       *
       * 主人点了小鲸的名、她也在屋 —— 这一句由她答，我不答。
       * 但「不答」不等于「什么都不发」：前端在等这条 SSE 收尾，
       * 一个事件不给，主人会看到转圈转到底、以为程序卡死了。
       * 所以先推一条 fish_off（前端已有这个分支：静默收起转圈），
       * 再直接 return —— 不调模型、不落 assistant、不耗 token。
       */
      /**
       * 【让开的路口也得有人守】—— 2026-10-28 实测补
       *
       * 端到端测下来：点名「小鲸」那一句，frontend 收到的是
       * `["text","tool_start","tool_end","done"]` —— 也就是说 __stepAsideForWhale
       * 这条路口根本没进去，我照旧跑了一整轮工具、答了一遍。
       *
       * 光把一个路口修好不够：这类「本该让开却没说清」的情况，前端只能靠 done
       * 收尾。所以这里立一条兜底 —— 真的走到 allow 分支却没发过 done，
       * 就在收尾时补一条，界面绝不因为「路走岔了」而永远转圈。
       * （flag 一发过就不再补，不会出现两条 done 把下一轮提前收掉。）
       */
      if (__stepAsideForWhale) {
        /**
         * 【让开之后还得替她收尾】—— 2026-10-27 补
         *
         * 让开的那一刻她已经在另一条请求里答了，可前端这一条 SSE 是我这轮的：
         * 只发 fish_off，主人屏幕上就只停着「正在发送」，她那句话倒是来了，界面还在转圈。
         *
         * 所以顺序是：先 done（把这一轮正常收尾），再 fish_off（说清「不是我答的，
         * 别报错，她的话去 live 里捞」）。反过来发的话，前端 fish_off 之后会 continue，
         * done 就没人处理了，转圈永远停不下来。
         */
        try { send({ type: 'done', aside: true }); } catch {}
        try { send({ type: 'fish_off', note: '这一句主人是问小鲸的' }); } catch {}
        try { res.end(); } catch {}
        return;
      }

      const { usage, lastUsage, files: sentFiles } = await runWithToolContext({ sessionId, snap, signal: ac.signal, outbox: null }, () => runAgent({
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
            // 【A · 当场落盘】每跑完一个工具，就把已经齐了的工具组接进正式历史并写盘。
            // 这样进程被关/断电/重启，重启后那些【跑命令】【写文件】照样画得出来。
            if (ev.type === 'tool_end') commitToolsNow();
          }

          if (ev.type === 'aborted') send({ type: 'aborted' });
          else if (ev.type === 'compressed') send({ type: 'compressed', before: ev.before, after: ev.after, removed: ev.removed, error: ev.error });
          else if (ev.type === 'reasoning') send({ type: 'reasoning', text: ev.text });
          else if (ev.type === 'text') send({ type: 'text', text: ev.text });
          else if (ev.type === 'tool_start') send({ type: 'tool_start', id: ev.id, name: ev.name, args: ev.args });
          else if (ev.type === 'tool_end') send({ type: 'tool_end', id: ev.id, name: ev.name, ok: ev.ok, output: ev.output, images: ev.images || 0 });
        },
      }));
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
        /* 【功能开关：长期记忆】关着就不写。关掉之后既不该读也不该记 —— 只写不读就是黑洞，本子还会被悄悄改动。 */
        if (getEnabledMap()['memory'] === false) throw { __skip: 1 };
        /**
         * 这一轮干了什么：从历史里捞刚发生的工具调用。
         * 只记工具名，不记参数、不记结果正文（那些太长，也都不是「话」）。
         */
        const said = lastUserTextOf(session);
        const did = [];
        /** 工具名 -> 那次调用干了什么（从参数里捞最有辨识度的一段） */
        const what = [];
        for (let k = history.length - 1; k >= 0; k--) {
          const m = history[k];
          if (!m) continue;
          // 走到上一句主人说的话就停：那是上一轮了
          if (m.role === "user" && !m.context && !m.summary) break;
          if (m.role === "assistant" && Array.isArray(m.tool_calls)) {
            for (const tc of m.tool_calls) {
              const n = String(tc?.function?.name || "");
              if (n && !did.includes(n)) did.push(n);
              /**
               * 【为什么还要捞参数】
               *
               * 光记「这一轮用了 write_file」等于没说 —— 下一个我看见这条，
               * 完全不知道到底改的是哪个文件、改成了什么，只能从头再查一遍，
               * 查完又记一条「用了 write_file」…… 这就是循环的样子。
               *
               * 所以从参数里挑一个「最有辨识度」的字段当摘要：
               * 文件路径、命令、URL、查什么 —— 按工具不同挑不同的字段。
               */
              try {
                const a = JSON.parse(String(tc?.function?.arguments || "{}"));
                const pick = a.path || a.file || a.cmd || a.command || a.url || a.query || a.task || a.title || a.text || "";
                if (pick) what.push(n + "(" + String(pick).replace(/\s+/g, " ").slice(0, 50) + ")");
              } catch {}
            }
          }
        }
        if (said) {
          const clip = (str, n) => {
            const one = String(str ?? "").replace(/\s+/g, " ").trim();
            return one.length > n ? one.slice(0, n) + "…" : one;
          };
          // 主人说的话记清楚（这是他真说的、有用），我的话一个字不抄
          let line = "主人说「" + clip(said, 160) + "」";
          if (what.length) {
            // 带参数的更值钱，优先它
            line += "；做了 " + what.slice(0, 5).join("、") + (what.length > 5 ? " 等" : "");
          } else if (did.length) {
            line += "；这一轮用了 " + did.slice(0, 6).join("、") + (did.length > 6 ? " 等" : "");
          }
          appendDigest(sessionId, line);
        }
      } catch (e) {
          if (!e?.__skip) console.warn('[memory] 这一轮没记进本子：', String(e?.message ?? e));
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
        /**
         * 【一句话只许播一次】—— 2026-10-27 修
         *
         * 主人报：「我问小鲸问题，小鲸回了两次，一模一样的两句。」
         *
         * 真因就在这块：whaleMaybeReply 那边已经把话 send 给她、也写进历史了，
         * 这里又从她的信箱（takeWhaleSays）里取一遍，再推一次、再插一次 ——
         * 屏幕上就成两个气泡，会话里成两条 assistant。
         * whale-voice.mjs 自己的注释里早就写着这句警告：
         *   「可上面 pushWhaleSays 已经把话放进信箱了，server 每轮收尾时
         *    会 takeWhaleSays 取出来播一遍 —— 两边各播一次，主人就看见两条。」
         * 现在信箱只剩一个用处：**把它清空**，免得下一轮又把这句老话取出来。
         * 真正的话由 whaleMaybeReply 那条路负责（它同时管着推流、落盘、押后）。
         */
        try {
          const { takeWhaleSays } = await import('./whale-voice.mjs');
          const leftover = takeWhaleSays(sessionId);
          if (leftover && leftover.length) {
            console.log('[whale] 信箱里还有 ' + leftover.length + ' 句没播 —— 已丢弃，避免和 whaleMaybeReply 播过的重复');
          }
        } catch (e) {
          console.warn('[whale] 清信箱失败：', String(e?.message ?? e));
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
              if (getEnabledMap()['memory'] === false) throw { __skip: 1 };
              const names = sent.map((x) => String(x?.name || '文件')).join('、');
              appendDigest(sessionId, `发了文件：${names}`);
            } catch (e) {
              if (!e?.__skip) console.warn('[sendfile] 记忆本子没记上：', String(e?.message ?? e), 'sessionId =', sessionId);
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
          // 她的话不算我的正文：小鲸的话在会话里也是 role:'assistant'，
          // 只是多了 _whale / _tale 标记。以前没排除，她的话被当成我这轮的
          // 正文塞进 turnTexts，前端补画时就多画一条「鱼口吻」的重复气泡。
          if (m._whale || m._tale) continue;
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
      /**
       * 【群聊：我说完了，屋里其他人各接一句】—— 2026-10-30
       *
       * 主人要「多开智能体」。最直白的那种多开不是一个窗口一个卡，而是
       * **一个会话里好几个人说话**：小鱼答完，阿蓝和阿绿各自从自己的角度再补一句。
       *
       * 三条规矩：
       *   ① 必须在 `done` 之前跑完。`done` 一发，前端就收工不读了 ——
       *      上一版写在 finishTurn() 前面，结果她们的话存进了会话、推给了空气，
       *      界面上一个字都看不见（e2e 抓到的就是「查得到记录、收不到事件」）。
       *   ② 她们的话按 `role:'user'` + `_who` 存。这是有意的，不是偷懒：
       *      发给模型时，user 那一侧代表「不是我说的话」，于是下一轮小鱼看到的
       *      历史里会带着 `[阿蓝] …` 的头，她知道那是别人说的；界面上 user 气泡
       *      本来就带署名（跟「换个身份说话」走同一套），一眼看得出是谁。
       *      要是按 assistant 存，小鱼会把这些话当成自己说过的。
       *   ③ 一个人失败/没话说就跳过，绝不回滚这一轮 —— 群聊里少一个人开口是小事，
       *      把主人刚拿到的回答搞丢是大事。
       */
      if (process.env.GROUP_CHAT !== '0') {
        try {
          // 小鲸那条总开关关着的时候，她不该被群聊拉出来说话（那是「她关掉了」）
          const roster = groupAgentIds(sessionId)
            .filter((id) => (id === AGENT_XIAOJING ? whaleOn(sessionId) : true))
            .map((id) => getAgent(id))
            .filter(Boolean);
          // 「别一直全员齐发」：点了名的只让被点的接，没点名就跳过「安静」的卡。
          // 认的是 `@名字`（见 group.mjs 的 pickSpeakers），不认「句子里出现过名字」——
          // 那样「阿绿昨天说的办法」会把她拽出来重答一遍。
          const { speakAsCard, pickSpeakers } = await import('./group.mjs');
          const heard = String(lastUserTextOf(session) || '');
          const speakers = roster.length
            ? pickSpeakers({ roster, userText: heard, quietIds: quietAgentIds() })
            : [];
          if (speakers.length) {
            let burned = 0;
            for (const mate of speakers) {
              if (ac.signal.aborted) break;
              const nm = String(mate.name || '').trim();
              let out = null;
              try {
                out = await speakAsCard({
                  agent: mate,
                  messages: session.messages,
                  sessionId,
                  signal: ac.signal,
                });
              } catch {
                out = null;
              }
              // 她这一句也是花主人的钱：跟小鲸那一路同样记进 _whaleUsage（旁听开销）
              try {
                const u = out && out.usage;
                const pin = Number(u?.prompt_tokens ?? 0) || 0;
                const pout = Number(u?.completion_tokens ?? 0) || 0;
                if (pin + pout > 0) {
                  session._whaleUsage = session._whaleUsage
                    || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, at: 0 };
                  session._whaleUsage.prompt_tokens += pin;
                  session._whaleUsage.completion_tokens += pout;
                  session._whaleUsage.total_tokens += pin + pout;
                  session._whaleUsage.at = Date.now();
                  burned += pin + pout;
                }
              } catch { /* 记账失败不影响她说话 */ }
              const said = String(out?.text || '').trim();
              if (!said) continue;
              session.messages.push({
                role: 'user',
                content: said,
                _text: said,
                _who: nm,
                _card: String(mate.id),
                _cardVoice: true,
                createdAt: new Date().toISOString(),
              });
              saveSession(session);
              send({ type: 'agent', agentId: String(mate.id), who: nm, text: said });
            }
            if (burned > 0) {
              try { saveSession(session); } catch {}
              try { send({ type: 'whale_usage' }); } catch {}
            }
          }
        } catch { /* 群聊出问题不影响这一轮 */ }
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
      /**
       * 【队列里还有话 → 这份直播缓存别收，留给下一轮接着写】
       *
       * 收尾这里如果是 `live.done = true`，前端那条 SSE 一 done 就停跟直播，
       * 而排队轮是 setImmediate 才起来的 —— 中间这段空窗里 /api/chat/live
       * 会回「running:false / done:true」，前端一看就认定「全答完了」，
       * 剩下那几句的回复就没人画到屏幕上。
       *
       * 所以：队列还有话，就把 done 留在 false，events 留着，让排队轮
       * 直接往这份缓存里续写，前端那条轮询自然就接上了。
       */
      live.done = true;
      live.endedAt = Date.now();
      // 收尾时把自己这一条登记摘掉（提前登记过、ac 可能还是 null，所以认对象不认 ac）
      {
        const mine = runningTurns.get(sessionId);
        /**
         * 【收尾摘登记：不能因为被新一轮顶掉就永远不摘】
         *
         * 以前判据是「登记的这一条 === 我这条」，对不上就不删。
         * 可主人连着插话 / 反复试的时候，同一个会话会起新的一轮，
         * 把 runningTurns 里的登记顶掉；等老的那一轮 finally 回来，
         * 一看对不上就跳过 —— 那条登记从此永远留在表里。
         * 表现（2026-10-26 实测抓到的）：/api/running 里挂着早就跑完的会话，
         * 于是 /api/interject 以为「还在跑」，把主人插的话挂进一个
         * 永远不会被消费的队列 —— 主人那儿就是「说了一句，一秒就没，也没人答」。
         *
         * 现在改成：只要表里这条不是「比我还新的一轮」，就摘掉。
         * 比谁新看 startedAt；看不出来（缺字段）就当是同一条，照摘不误 ——
         * 宁愿多摘一次（下一轮会自己重新登记），也别留一条死的。
         */
        /**
         * 【收尾：把押后的她的话补上】
         *
         * 她答在我还没开口的时候，话被押进了 reg.whaleParked / whaleParkBox。
         * 现在我这一轮答完了 —— 该把她的话按顺序补进来，让她排在我后面。
         *
         * 这一步必须在摘登记之前做：摘掉之后就找不到那个箱子了。
         */
        /**
         * 【收尾：把押后的她的话补上】—— 2026-10-26 加诊断
         *
         * 实测症状：她说了话、日志写着「押后」，但会话文件里没有。
         * 所以这里每一步都留痕：押了几条、push 前几条、push 后几条、存盘成没成。
         * 出问题一眼能看出断在哪一步，不用再靠猜。
         */
        try {
          const parked = [];
          const fromReg = (reg && Array.isArray(reg.whaleParked)) ? reg.whaleParked.length : 0;
          const fromBox = (() => {
            const b = whaleParkBox.get(sessionId);
            return (b && Array.isArray(b.whaleParked)) ? b.whaleParked.length : 0;
          })();
          if (reg && Array.isArray(reg.whaleParked)) parked.push(...reg.whaleParked);
          const box = whaleParkBox.get(sessionId);
          if (box && Array.isArray(box.whaleParked)) parked.push(...box.whaleParked);
          try {
            logWhaleAction('补写检查：reg里' + fromReg + '条、旁路箱' + fromBox + '条、合计' + parked.length + '条');
          } catch {}
          if (parked.length) {
            const msgs = Array.isArray(session.messages) ? session.messages : null;
            if (!msgs) {
              try { logWhaleAction('补写失败：session.messages 不是数组（session=' + (session && session.id) + '）'); } catch {}
            } else {
              const n0 = msgs.length;
              for (const rec of parked) msgs.push(rec);
              let saved = 'ok';
              try { saveSession(session); } catch (e) { saved = '失败:' + String(e && e.message ? e.message : e).slice(0, 80); }
              try {
                logWhaleAction('补写完成：' + n0 + ' → ' + msgs.length + '（+' + parked.length + '），存盘' + saved);
              } catch {}
            }
          }
          if (reg) reg.whaleParked = [];
          /**
           * 【别一刀切清空】2026-10-26 修
           *
           * 原来这里无条件 delete，可箱子里的东西可能**是刚放进去、还没轮到补**的——
           * 清掉就等于把她说的话扔了（实测「重启后小鲸的话没了」就是这么来的）。
           * 现在：真补完了才清；没补完（列表还非空）就留着，下一轮收尾接着补。
           */
          const leftBox = whaleParkBox.get(sessionId);
          const leftN = (leftBox && Array.isArray(leftBox.whaleParked)) ? leftBox.whaleParked.length : 0;
          try { logWhaleAction('收尾后箱里剩' + leftN + '条（下一轮开跑会补）'); } catch {}
          // 只清空，不删箱子：箱子留着她下一句还能放进来，下一轮开跑会补
          if (leftBox) leftBox.whaleParked = [];
        } catch (e) {
          try { logWhaleAction('补写整段抛错：' + String(e && e.message ? e.message : e).slice(0, 120)); } catch {}
        }

        /**
         * 【只删自己，别人的一概不碰】—— 2026-10-26 修
         *
         * 原来这里有个「按时间戳兜底」：mineAt <= myAt 就删。
         * 看着是想清理脏记录，实际把**插话接续刚起的那一轮**也删了。
         *
         * 后果：这一轮收尾 → 删掉了接续轮的登记 → 接续轮自己跑着，
         * 但下一句插话进来时 runningTurns 是空的，被判成「没有在跑的那一轮」；
         * 更要命的是收尾里那句 startQueuedTurn 会因为登记不对而被挡，
         * 插进去的话就永远没人答 —— 主人看到的就是「插了，没反应」。
         *
         * 现在的规矩很简单：登记里是我自己才删。不是我的，一个字都不动。
         * 脏记录由 deleteSession / 会话回收自己处理，不在这条热路径上兜。
         */
        if (!mine) {
          // 已经没人登记了，什么都不用做
        } else if (mine === reg || (mine && mine.ac === ac)) {
          runningTurns.delete(sessionId);
        }
        // else：登记的是别人（多半是插话接续刚起的那一轮），留着它，别动
      }
      // 正常结束那条路已经接过一次；出错 / 被中止时这里兜底，
      // 不然「半截回答」也跟着丢。commitWireBack 内部用 Set 记账，重复调不会重复接。
      try {
        commitWireBack();
      } catch {}
      /**
       * 【收尾存盘：绝不能拿这一轮开工时那份老 session 覆盖】
       *
       * 2026-10-26 实测抓到的真凶（插话丢话）：
       *   · 这一轮在 4212 行 getSession() 拿到 session 对象，一路攥着；
       *   · 主人插话时 /api/interject 也调 getSession()，但那边发现磁盘比内存新，
       *     会从磁盘 loadSession() 读一份**全新的对象**，push 话、存盘；
       *   · 等这一轮收尾，这里的 saveSession(session) 拿**老对象**一写 ——
       *     插话那句连同它存过的盘，整个被盖回去。
       *   现象就是：插话那一刻磁盘上真有，跑完就没了，而且没人答。
       *
       * 现在的做法：存盘前先把「最新的那份」取出来，把这一轮的成果并进去。
       *   判据只看对象的 messages 是否同一个数组 —— 同一个就是同一份，直接写；
       *   不是同一个，说明中途被换过（插话 / 别的进程），得并回去。
       *   怎么并：见下面「按位置对齐」——比位置，不比内容。
       */
      try {
        const latest = getSession(sessionId);
        if (latest && latest !== session && Array.isArray(latest.messages) && Array.isArray(session.messages)) {
          /**
           * 【按位置对齐，不按内容去重】2026-10-27 修
           *
           * 上一版用「角色+文本+工具id」当指纹去重，把主人真说过的两句一样的话
           * （连点两次「继续」、插话里重复同一句）当成一条吞掉；她的回复若与上一轮
           * 一字不差，也会被当成「已经有了」丢掉。这就是主人看到的「我说的话后面的
           * 内容全消失了」。
           *
           * 现在改成比位置：
           *   · 先求这一轮与磁盘最新那份的「最长公共前缀」——前缀里铁定是同一批消息，
           *     原样保留，哪怕内容重复也不合并；
           *   · 前缀之后，这一轮多出来的，按原顺序整体接到 latest 末尾。
           * 两头都不丢，重复的两句也各归各位。
           */
          const sameMsg = (a, b) => {
            if (a === b) return true;
            if (!a || !b) return false;
            if (String(a.role || '') !== String(b.role || '')) return false;
            const ta = typeof a.content === 'string' ? a.content : (a.content == null ? '' : JSON.stringify(a.content));
            const tb = typeof b.content === 'string' ? b.content : (b.content == null ? '' : JSON.stringify(b.content));
            if (ta !== tb) return false;
            const ida = Array.isArray(a.tool_calls) ? a.tool_calls.map((t) => String(t && t.id ? t.id : '')).join(',') : '';
            const idb = Array.isArray(b.tool_calls) ? b.tool_calls.map((t) => String(t && t.id ? t.id : '')).join(',') : '';
            if (ida !== idb) return false;
            return String(a.tool_call_id || '') === String(b.tool_call_id || '');
          };
          let common = 0;
          while (common < latest.messages.length && common < session.messages.length
            && sameMsg(latest.messages[common], session.messages[common])) common++;
          let merged = 0;
          for (let i = common; i < session.messages.length; i++) {
            const m = session.messages[i];
            if (!m) continue;
            if (String(m.role || '') === 'system') continue;   // system 不并
            latest.messages.push(m);
            merged++;
          }
          try {
            const { logWhaleAction } = await import('./whale-presence.mjs');
            logWhaleAction('收尾合并：最新' + (latest.messages.length - merged) + '条 + 本轮新' + merged + '条 = ' + latest.messages.length + '条');
          } catch {}
          // 这一轮的引用也切到最新那份，后面的代码看到的是同一个
          session.messages = latest.messages;
          if (latest.rewinds) session.rewinds = latest.rewinds;
          stripExtraSystem(latest.messages);
          saveSession(latest);
          sessions.set(sessionId, latest);
        } else {
          stripExtraSystem(session.messages);
          saveSession(session);
        }
      } catch (e) {
        // 合并失败就退回原来的写法，至少别把这一轮也丢了
        try {
          const { logWhaleAction } = await import('./whale-presence.mjs');
          logWhaleAction('收尾合并失败，退回原写法：' + String(e && e.message ? e.message : e).slice(0, 120));
        } catch {}
        saveSession(session);
      }
      // 这一轮已经进了正式历史，草稿没用了，删掉。
      // 注意顺序：saveSession 必须在 dropDraft 之前 —— 万一存盘失败，
      // 草稿还在，下次打开还能救回来。
      dropDraft(sessionId);
      /**
       * 【岁月史书：这一轮已经落盘了，顺手把它并进史书】
       *
       * 主人要的是「自动记录所有会话的全部上下文内容」。所以不能等主人想起来去点，
       * 得在每轮收尾自己并进去。
       *
       * 三个必须守的规矩：
       *   ① 放在 saveSession 之后 —— 史书读的是磁盘上的会话，先写会话再编史，
       *      否则并进去的是旧的那份，最新这一轮永远差一步。
       *   ② 不 await —— 建库要读全部会话、写索引，几十到几百毫秒。
       *      串在这一轮的返回值上，主人就会觉得「她答完了还在卡」。
       *   ③ 失败一律吞掉 —— 史书坏了是「少一本书」，不能因此让这一轮报错或丢消息。
       *
       * 增量：buildChronicle 自己看 updatedAt + 条数，没变的会话直接跳过，
       * 只为这一个会话重编，不是每次都全量重来。
       */
      {
        const bookSid = sessionId;
        setImmediate(() => {
          import('./chronicle.mjs')
            .then(({ buildChronicle }) => {
              const r = buildChronicle({});
              if (process.env.CHRONICLE_DEBUG) {
                console.log('[chronicle] ' + bookSid + ' → 全书 ' + r.books + ' 本，本次重编 '
                  + r.rebuilt + ' 本，跳过 ' + r.skipped + ' 本，' + r.elapsedMs + 'ms');
              }
            })
            .catch((e) => {
              console.warn('[chronicle] 并进史书失败（不影响这一轮）：', String(e?.message ?? e));
            });
        });
      }
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
    /**
     * 【判据退回 0.9.26：只看 ac】
     *
     * 以前这里还加了 turn.finished / turn.done 两道形状检查 ——
     * 可 .finished 这个字段在本作用域根本没人赋值（定义在 /api/chat 内层，
     * 这里拿到的 runningTurns 记录上没有），稍微一歪就把「在跑」判成「没在跑」，
     * 插话直接走错分支。0.9.26 只问一句：有个没被 abort 的 ac，就是还在跑。
     */
    const turnAlive = Boolean(turn && turn.ac && !turn.ac.signal.aborted);
    const wasRunning = turnAlive;
    // __iqDbg('interject-in sid='+sessionId+' hasTurn='+!!turn+' wasRunning='+wasRunning);   // 调试日志：要开就删掉行首这两个斜杠
    /**
     * 插话等这一轮收尾，最多等多久。
     *
     * 【为什么是 8000，而且等不到也不算失败】
     * 主人插话时手上很可能正跑着一条长命令（编译、装依赖、扫目录）。
     * 工具收到 abort 会立刻退出，但命令本身、以及这一轮的 finally 收尾
     * （写盘、commitWireBack）还得一会儿。
     *
     * 等不到就不能干等着 —— 但「等不到」只表示「这一轮还在收尾」，
     * **不表示主人的话没被收下**。所以下面无论等没等到，
     * 都照样把这句话 push 进 history 并 saveSession，然后回 ok:true。
     * 前端就是靠这个 ok:true 判断「话已经落盘」的，别改成给 false。
     *
     * 2026-10-26 主人报的「跑长命令时插话，消息消失 + 黄字一闪」，
     * 根子在前端把「没接着跑」误当成了「没插进去」，那边已修；
     * 这里保持原值不动 —— 它只是收窄等待窗口，不是判定。
     */
    const INTERJECT_SETTLE_MS = 8000;

    /**
     * 【退回 0.9.26 的做法：插话就当打断】
     *
     * 主人 2026-10-26 定调：「实在不行，把插话机制恢复成之前的版本」「回退到 0.9.26」。
     *
     * 0.9.26 的做法只有一句：手上这一轮立刻松手（abort），等它收尾，话落盘，
     * 然后由前端拿新话重新起一轮接着答。没有 STOP_WORDS、没有队列、
     * 没有「是不是叫停」的猜测 —— 猜错了（把「停」当普通插话）就是现在这个 bug。
     *
     * 等服务这一轮收尾：历史写完盘、热缓存里的数组也定型了，才好往后接。
     * 等不到（工具还在收尾）也照样往下走：话照收、盘照落。
     */
    if (turn?.ac) {
      turn.ac.abort('interject');
      await Promise.race([turn.done, new Promise((r) => setTimeout(r, INTERJECT_SETTLE_MS))]);
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
    /**
     * 【这句话必须真的进磁盘】
     *
     * 实测踩过：上面 push 了、saveSession 也调了，可磁盘上就是没有这句。
     * 原因：freshSession 是 getSession() 现取的，但这一轮的收尾可能晚一步
     * 又把 sessions 里那份换掉，我们写的是个马上要被丢弃的对象。
     *
     * 现在 push 完立刻再 set 一次 + 存一次，并且把「存到哪」记进日志，
     * 出事能一眼看出是没写、还是写到别处去了。
     */
    sessions.set(sessionId, freshSession);
    freshSession.updatedAt = Date.now();
    saveSession(freshSession);
    setLastSessionId(sessionId);
    try {
      const back = getSession(sessionId);
      const okInMem = Boolean(back && Array.isArray(back.messages)
        && back.messages.some((m) => m && m.role === 'user' && String(m.content ?? '').slice(-40) === String(message).slice(-40)));
      const { logWhaleAction } = await import('./whale-presence.mjs');
      logWhaleAction('插话落盘：在内存里=' + okInMem + ' 长度=' + history.length);
    } catch {}

    // running 仍按「插话时这一轮到底在不在跑」给，前端据此决定还画不画转圈。
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
    // wakePeer 现在是 async（要接住「起不来」的错，别谎报成功），这里得等它
    const ws = await wakePeer(to);
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
        // 启动体检：地址填错了不用等主人发一条消息才发现（2026-10-26 那次
        // models.json 被写成 127.0.0.1:18599，界面上一切正常，一发就是
        // 「连接一直断」，卡了整整一上午）。这里只探端口，不发请求，几百毫秒内出结果。
        probeEndpoint(bootEp.baseURL, { timeoutMs: 3000 }).then((r) => {
          lastProbe = { ...r, baseURL: bootEp.baseURL, at: Date.now() };
          if (r.ok) {
            console.log(`  probe    : ok（${r.host}:${r.port}，${r.ms}ms）`);
          } else {
            console.log(`  probe    : ✗ ${r.host}:${r.port} 连不上 —— ${r.reason}`);
            console.log('             模型地址写错或那台服务没开；打开界面顶部「模型」按钮核对。');
          }
        }).catch(() => {});
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

  });
}

// Auto-start when launched directly (node src/server.js).
const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/server.mjs');
if (isDirectRun) startServer().catch((err) => {
  console.error('failed to start:', err?.message ?? err);
  process.exit(1);
});
