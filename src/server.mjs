// Minimal web server: static UI + one SSE endpoint that runs the agent.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReadStream, statSync, readdirSync, readFileSync as __rotRead, writeFileSync as __rotWrite, mkdirSync as __mkPaste } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, isAbsolute as isAbsolutePath } from 'node:path';
import { config } from './config.mjs';
/* 【2026-11-08 加·整轮空闲看门狗】以前只有「等模型」那层有超时，卡在别处没人管 */
import { createTurnWatchdog } from './harness/turn-watchdog.mjs';
import { TURN_IDLE_MAX_MS, TOOL_MAX_MS, LLM_IDLE_MS } from './deadline.mjs';
// 小鲸在场的开关。必须在顶层导入：以前写在接口分支里用 await import，
// 出了分支 whaleOn 就没了，而每轮收尾那句 if (whaleOn()) 还在 —— 每轮都崩。
import { whaleOn, setWhaleOn, markWhaleSpoke, whaleSpokeThisTurn } from './whale-presence.mjs';
// 顶栏那个「小鱼」按钮：默认在场，禁用后这个会话后面的话她一个字都不发。
import { fishOn, setFishOn } from './fish-presence.mjs';
import { runAgent, systemPrompt, repairHistory } from './agent.mjs';
import { startSelfwake, stopSelfwake, noteReplied, noteSpoke, shouldFire, getState as selfwakeState } from './selfwake.mjs';
import { startCron, listTasks, addTask, removeTask, setEnabled as cronSetEnabled, markRan as cronMarkRan, dueTasks } from './cron.mjs';
// 启动自检用：查每个工具是不是都有中文 description / 参数说明。
import { checkToolDocs, setPeerWake, setRunningProbe, runWithToolContext, tools as allTools } from './tools.mjs';
import { checkSkills } from './skills.mjs';
import { browse, readImageDataUrl, readImageBytes, composeUserContent, isImagePath } from './attach.mjs';
import { mimeOf, fileKindOf, fmtSize, outboxPath, sendCheck } from './outbox.mjs';
import { getOverride, setOverride } from './session-overrides.mjs';
// 任务清单（界面面板用）：跟小鱼自己的 plan 工具是同一份数据，别另存一套
import { planPublicView, planUiAction, readPlanTxt, loadPlan } from './plan.mjs';
// localVersion：更新器眼里「本地该是哪一版」。跟正在跑的版本可能不是一个数 ——
// 见下面 /api/health 里 running/target 的注释。
import { localVersion } from './updater.mjs';
// 前情：一进来就记得的那段对话。只贴给模型看，不进会话记录，界面也不会画出来。
import { preludeContextMessage, preludeInfo, addPreludeFromPath } from './prelude.mjs';
// 会话记忆文件：一个会话一份自己的本子，每轮拼进系统提示（见 persona.mjs 的 memoryBlock）。
import { ensureMemory, copyMemory, trashMemory, memoryInfo, readMemory, writeMemory, appendDigest, appendFixed, wipeMemory, snapMemory, SKELETON } from './session-memory.mjs';
// 记忆本整本界面：小鲸那本是跨会话的，也要给主人看（见 /api/memory/book）
import { readWhaleMemory, memoryPath as whaleMemoryPath } from './whale-memory.mjs';
import { editMessage, undoEdit, editInfo, editDigest, digestLines, syncMemoryAfterEdit, unsyncMemoryAfterEdit } from './edit.mjs';
// 整份数据备份：会话 / 人设 / 模型配置 / 设置，换电脑或重装时救命用。
import { backupSummary, buildBackup, restoreBackup } from './backup.mjs';
// 进行中那一轮的草稿：边跑边落，进程被杀也不会把已经说出来的话全丢。
import { saveDraft, readDraft, draftAsMessage, dropDraft, makeDraftThrottle } from './turn-draft.mjs';
// 中途投递信箱：主人一边看她干活一边插的话排在这里（照 dsh 的 steering，见 inbox.mjs）
import { steer, clearInbox, inboxCount, peekInbox } from './inbox.mjs';
// 崩溃后续跑：临死前记下「谁被打断了」，下次启动接着做（见 resume.mjs）
import { markInterrupted, takeInterrupted, peekInterrupted, dropInterrupted, listInterrupted } from './resume.mjs';
/**
 * 【QQ小鱼】2026-11-01 加。
 *
 * 三段分工：qq.mjs 管存、qq-bridge.mjs 管连、qq-server.mjs 管「跑成一轮」。
 * mountQq 放在下面（函数都声明完了之后），路由里用 await import 现取 ——
 * 这样 QQ 没配的时候一个字节都不加载，也就不会因为缺 SDK 把启动弄挂。
 */
import { mountQq, ensureQqSession, renameGroupSession, runQqTurn, markQqOwner } from './qq-server.mjs';
/** 「这是我」口令的有效期（跟 qq.mjs 里的 CLAIM_TTL_MS 保持一致，只给界面显示用） */
const CLAIM_TTL_PUB = 10 * 60 * 1000;

/**
 * 【诊断日志】2026-10-31 加
 *
 * 以前断流、续跑失败这些错误只 console.warn 到 stderr ——
 * 可打包版的 stderr 是进 Electron 的，主人和下一个我都看不见，
 * 排查时只能靠猜（「续跑为什么没续上」就是猜了半天才找到）。
 *
 * 现在一律往 .state/diag.log 追加一行带时间的记录，最多留 800 行。
 */
import { unlinkSync as __fsUnlinkSync, appendFileSync as __diagAppend, mkdirSync as __diagMkdir, readFileSync as __diagRead, writeFileSync as __diagWrite, existsSync as __diagExists, readdirSync as __diagReaddir } from 'node:fs';
import { join as __diagJoin } from 'node:path';
function diagLog(tag, detail) {
  try {
    const fs = { appendFileSync: __diagAppend, mkdirSync: __diagMkdir, readFileSync: __diagRead, writeFileSync: __diagWrite };
    const path = { join: __diagJoin };
    const dir = path.join(config.dataDir, '.state');
    fs.mkdirSync(dir, { recursive: true });
    const line = `${new Date().toISOString()} [${tag}] ${String(detail).replace(/\n/g, ' ').slice(0, 600)}\n`;
    fs.appendFileSync(path.join(dir, 'diag.log'), line, 'utf8');
    // 太长就砍掉前面：只留最后 800 行
    const p = path.join(dir, 'diag.log');
    const all = fs.readFileSync(p, 'utf8').split('\n');
    /* 【2026-11-10 D2·原子写】diag.log 是排障的命根子，轮转那一刀要是停在半截，
     * 前面的历史就全没了。走 writeFileAtomic（rename 原子换），不再直接盖。 */
    if (all.length > 800) writeFileAtomic(p, all.slice(-800).join('\n'));
  } catch { /* 日志写不了也不能影响主流程 */ }
}

import { getWhaleProfile, saveWhaleProfile, MAX_PERSONA_CHARS, whalePersonaForEditor, defaultWhalePersonaPath, setWhalePersonaAsDefault } from './whale-profile.mjs';
// 进程兜底：一处没 catch 的异常不该让整个程序消失。
import { installGuards, crashSummary } from './crash-guard.mjs';
// 版本检查：每次启动跑一次（selfcheck 节流也照样查），界面上也能手动点。
import { quickCheck, updateStatus, startUpdateWatcher, lastUpdateInfo } from './updater.mjs';
// 装机：新版安装包下好之后，人点「装一下」才真装（装完会重启，不能自作主张）
import { spawnSilentInstall, dropInstaller } from './updater-installer.mjs';
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
  currentBottomLines,
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
  withPersonaScope,
} from './persona-store.mjs';
// 【2026-11-01】人设按会话：会话删了，把「它用哪套人设」这条记录一起清掉
import { clearSessionPersona } from './persona-session.mjs';
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
  mainAgentId,
  activeAgentIds,   /* 2026-11-09 重做：主智能体 + 接话名单的唯一真源 */
  /* 屋里的人·2026-11-01：顺序（拖）与开关（启用才说话） */
  setSessionGroupOrder,
  isGroupMemberEnabled,
  setGroupMemberEnabled,
  groupEnabledMap,
  /* 颜色接口·2026-10-29 */
  agentColor,
  agentColorMap,
  setAgentColor,
  allowedSpeakersOf,
  setAllowedSpeakers,
  setAgentQuiet,
  MAX_GROUP,
  AGENT_XIAOYU,
  AGENT_XIAOJING,
  MAX_AGENTS,
  MAX_PERSONA_CHARS as MAX_AGENT_PERSONA_CHARS,
  /* 角色卡·2026-11-01 导入/导出（见 agents.mjs 的 exportCard / importCard） */
  exportCard,
  importCard,
  cardFileName,
} from './agents.mjs';
// 管理员权限：按会话的开关键（见 admin-mode.mjs 文件头）。
import { adminOn, setAdminOn, adminSessions } from './admin-mode.mjs';
import {
  wipeWorkers as wipeTaskWorkers,
  taskOn,
  setTaskOn,
  taskFeatureOn,
  taskInfo,
  listWorkers,
  forgetSession as forgetTaskSession,
} from './task-mode.mjs';
/* 【2026-11-11 团队模式】后台派发/停/回传的通道注入与启动清理（src/team.mjs） */
import { setTeamChannels, markInterruptedWorkers, stopWorker } from './team.mjs';
// 【陪看屏幕】最近看过的几帧 + 帧目录（界面点开看大图用，见 /api/screen/frames）
import { recentFrames, turnOffScreen, turnOnScreen } from './tools-screen.mjs';
/* 【增强提示词】输入框那颗星星的一次性改写调用（src/enhance-prompt.mjs，2026-11-11） */
import { enhancePrompt } from './enhance-prompt.mjs';
import { frameDir as screenFrameDir, prune as pruneFrames } from './screen-capture.mjs';
import { getFeatures, featureNameOfTool, getEnabledMap, featureOnFor, setFeatureScoped, GLOBAL_ONLY_FEATURES, TOOL_FEATURE, TOOL_OWNERS, exportFeatures, exportFeaturesTo, importFeatures, removeCustomFeature } from './features.mjs';
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
  setIdentityAsDefault,
  restoreIdentityDefault,
  identityBlock,
  identityOn,
} from './identity.mjs';
// 同一个人连着说 → 拼成一段。实现在 merge-voice.mjs，抽出去是为了能真跑一遍验。
import { mergeSameVoice } from './merge-voice.mjs';
import { extractInlineImages } from './gen-image.mjs';
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
import { getThinking, setThinking, LEVELS, levelFor } from './thinking.mjs';
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
  cardOpeningEnabled,
  setCardOpeningEnabled,
  unmarkOpened,
  wasOpened,
} from './opening.mjs';
import {
  listModels,
  keyForBaseURL,
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
import { startHealthWatch, pruneOrphans, pruneWorkerFiles } from './state-sweep.mjs';
import { ensureAgentPresets } from './agent-presets.mjs';
import { workersSnapshot } from './task-mode.mjs';
import { rotateArchive, compactTrash } from './mem-rotate.mjs';
import {
  isSessionId,
  newSessionId,
  loadSession,
  saveSession,
  messageKey,
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
  /* 【2026-11-10 D2·原子写】diag.log 轮转、after-restart.json 这类状态文件
   * 之前用裸 writeFileSync 直接盖，进程被杀那一刻会留半截 JSON。
   * 统一走 sessions-core 的 writeFileAtomic（tmp+fsync+rename+EPERM 重试）。 */
  writeFileAtomic,
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


/**
 * 【2026-10-31 主人要求：折叠的工具调用不占上下文，但我能手动点开看】
 *
 * 主人原话：「要求折叠的工具调用具体消息内容不占上下文，但你可手动打开查看」。
 *
 * 【为什么不能直接删】
 * 上游有硬规则：role:'tool' 那条前面必须有一条 assistant.tool_calls 点名同一个 id，
 * 少一条就 400「Messages with role tool must be a response to a preceding message with tool_calls」。
 * 所以删不得。
 *
 * 【做法】把**老得已经收起来**的那批 tool 结果的正文换成一两行摘要，
 *   tool_call_id / role 一个字不动，配对照旧成立；
 *   完整原文还在会话 json 里，界面点开那条灰照旧能看见全文。
 *
 * 【只动 wire，不动 history】
 * wire 是 history 的浅拷贝，元素是同一批对象。原地改对象会污染存档和界面，
 * 所以这里**换新对象**替换 wire 里的位置，history 那边原封不动。
 *
 * @param {Array} list  wire 数组（会被就地替换元素）
 * @param {number} keep 最近多少条 tool 结果保持完整（正在干的这一轮）
 */
function collapseOldToolBodies(list, keep = 6) {
  try {
    if (!Array.isArray(list) || !list.length) return list;
    // 从后往前数 tool 消息，数够 keep 条就标成「保留」
    const keepSet = new Set();
    let n = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m && m.role === "tool") {
        if (n < keep) { keepSet.add(m); n++; }
      }
    }
    for (let i = 0; i < list.length; i++) {
      const m = list[i];
      if (!m || m.role !== "tool" || keepSet.has(m)) continue;
      const body = typeof m.content === "string" ? m.content : (Array.isArray(m.content) ? m.content.filter((p) => p && p.type === "text").map((p) => p.text).join(" ") : String(m.content ?? ""));
      // 本来就短的不用换，换了也没省下什么
      if (body.length <= 200) continue;
      const oneline = body.replace(/\s+/g, " ").trim();
      const head = oneline.slice(0, 120);
      const err = /^\s*ERROR:/.test(body) ? "（失败）" : "";
      const brief = "〔旧工具结果已收起" + err + "，全文 " + oneline.length + " 字，需要就看会话记录〕" + head;
      // 换新对象，别动 history 里那个
      list[i] = Object.assign({}, m, { content: brief, _collapsed: true });
    }
    return list;
  } catch (e) {
    // 收不起来也不能让这一轮发不出去
    console.warn("[ctx] 旧工具结果收起失败：", String(e && e.message || e));
    return list;
  }
}

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
    /**
     * 【2026-11-05 加·system 消息不该出现在对话流里】
     *
     * 主人报「还是有 <thinking>」。查数据发现它出在**第 0 条 role:'system'**
     * （人设正文里有 <thinking> 的示例写法），而这里原来只跳过了 context / tool，
     * 没跳过 system —— 于是人设整段被当成一条对话交给前端画了出来。
     */
    if (m.role === 'system') continue;
    /**
     * 【2026-11-08 加·草稿回灌不画给主人看】
     *
     * 主人问：「重启后【杂活鱼】会发出一大段话，是说给我看的吗？」
     * 不是。那是 `_recovered` —— 重启时把上一轮没说完的半截话从草稿补回来，
     * 目的是「别丢了她说的话、让她接着往下说」。实测那条 1079 字，
     * 里面全是括号里的内心独白（「丢脸」「我手上没工具调它」），还带着 `<assistant>` 标签。
     *
     * 这功能要留（删了她会从断点前重说一遍），但它**不该当正文画出来** ——
     * 跟压缩摘要一个待遇：留在 messages 里（她自己读得到），界面上不显示。
     */
    if (m._recovered) continue;
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
      /* 【2026-11-01 主人：插话要画在「我说到哪儿」的位置】steer=这条是主人生气时半路插进来的话；steerAt=他插话那一刻我已经说出多少字。前端靠这两个数把我那段话劈成两半，把他的话嵌在中间。老会话没有这两个字段，界面照老样子排末尾。 */
      turns.push({ role: 'user', ts: typeof m.at === 'number' ? m.at : 0, text: shown, atts, rewindId: i, edited, usage, who, sysNote: m._sysNote === true ? true : undefined,      steer: m._steer === true ? true : undefined,      steerAt: typeof m._atChars === 'number' ? m._atChars : undefined, });
    }
    else if (m.role === 'assistant') turns.push({
      role: 'assistant',
      ts: typeof m.at === 'number' ? m.at : 0,
      text,
      rewindId: i,
      edited,
      out: Array.isArray(m._out) ? m._out : [],
      tools,
      /* 【2026-11-03 加】这一轮里「谁干了什么」（办事模式的子任务流水）。
       * 它在内存事件流里只有一份，一轮跑完事件流就换了 —— 不存进历史，
       * 主人看到的就是「派活 运行中…然后没了」。 */
      workers: Array.isArray(m._workers) ? m._workers : [],
      /**
       * 这条要是第三方（小鲸以自己的身份）说的，带上她的名字和颜色。
       *
       * 【为什么字段名叫 tale 而不是 whale】
       * 这只是给界面用的标记，模型一个字都不该看见（见 server.mjs 里打标记那段注释）。
       * 老消息里可能有 `_whale`，这里一并认下来，不用改旧会话文件。
       */
      whale: m._tale?.who ? String(m._tale.who) : (m._whale ? String(m._whale) : (m._card ? String(m._who || m._card) : undefined)),
      /**
       * 【2026-11-02 修·切到别人身份后旧消息署名全被刷掉】
       * 主人 2026-10-28 定过：身份名跟着消息一起存，画的时候直接用这份，
       * 不许看「现在是哪个身份」—— 否则一切换满屏旧消息的署名全被刷掉。
       * 但这条规矩只给 user 消息做了：assistant 消息没带 _card 就交不出 who，
       * 前端只能退回全局的 mainAgentName，于是切到小白曦后满屏都是小白曦。
       * 这里补上：只要这条消息自己记着 _who，就照原样交出去。
       */
      who: (typeof m._who === 'string' && m._who.trim()) ? m._who.trim() : undefined,
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
      const uMsg = { role: 'user', content: message, at: Date.now() };
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

/**
 * 【屋里的「别人」也是独立个体】—— 2026-11-01 主人报
 *
 * 主人原话：「关掉小鱼只开小鲸与另一个智能体后，只有小鲸在说话，
 * 这说明智能体其实是你在说话。我要求智能体是像你和小鲸一样是独立的个体，
 * 不能因为你关了或小鲸关了就不说话了。」
 *
 * 真因：小鱼不在的那个分支（/api/chat 里 if (!resume && !fishOn(sessionId))）
 * 只调了 whaleMaybeReply 就 res.end()，群聊那一段（GROUP_CHAT）在主流程末尾，
 * 根本走不到 —— 自建卡一个字的出声机会都没有，主人只能听见小鲸。
 *
 * 这里把那一段抽成 runMateRound：谁在场、谁能说，都在这儿判。
 * 主流程末尾和小鱼不在的分支共用它，别搞成两套判据。
 */
function mateSwitchOn(id, sessionId) {
  const key = String(id || '');
  if (key === AGENT_XIAOJING) {
    try { return whaleOn(sessionId); } catch { return false; }
  }
  if (key === AGENT_XIAOYU) {
    try { return fishOn(sessionId); } catch { return true; }
  }
  return isGroupMemberEnabled(key, sessionId);
}

/** 除小鱼小鲸之外，这个会话里还有没有开着的自建卡 */
function anyMateOn(sessionId) {
  try {
    const all = groupAgentIds(sessionId)
      .map((id) => String(id))
      .filter((id) => id !== AGENT_XIAOYU && id !== AGENT_XIAOJING);
    return all.some((id) => {
      try { return isGroupMemberEnabled(id, sessionId); } catch { return false; }
    });
  } catch {
    return false;
  }
}

/**
 * 让屋里的「别人」按规矩开口。
 * @returns {Promise<number>} 这一趟说了几个人
 */
async function runMateRound({ sessionId, heard, send, excludeIds = [], signal = null, session = null }) {
  if (process.env.GROUP_CHAT === '0') return 0;
  try {
    const sess = session || getSession(sessionId);
    if (!sess) return 0;
    const skip = new Set((Array.isArray(excludeIds) ? excludeIds : []).map((x) => String(x)));
    /* 【2026-11-09 重做】跟主流程末尾同一套口径：主智能体以下的人按竖列顺序接话。 */
    const _alive = activeAgentIds(sessionId, (id) => mateSwitchOn(id, sessionId));
    const _mainId = String(_alive[0] || '');
    let _mainName = '';
    try { _mainName = String((getAgent(_mainId) || {}).name || '').trim(); } catch {}
    const roster = _alive.slice(1)
      .map((id) => getAgent(id))
      .filter(Boolean)
      .filter((a) => !skip.has(String(a.id)));
    if (!roster.length) return 0;
    const enabledIds = roster.map((a) => String(a.id));
    const { speakAsCard, pickSpeakers } = await import('./group.mjs');
    const prevAllowed = allowedSpeakersOf(sessionId);
    /* 2026-11-10 艾特删除：quietIds 已不参与判断，不再取也不再传 */
    const speakers = pickSpeakers({
      roster,
      userText: String(heard || ''),
      allowedIds: prevAllowed,
      enabledIds,
      keepOrder: true,   /* 固定口径：严格按竖列 A→B→C（@ 顺序已废） */
    });
    try { console.log("[DBG-mate] roster=" + roster.map(a=>a.name).join(",") + " enabled=" + enabledIds.join(",") + " speakers=" + (speakers||[]).map(a=>a.name).join(",") + " msgs=" + (sess.messages||[]).length); } catch {}
    if (!speakers || !speakers.length) return 0;
    let spoke = 0;
    let burned = 0;
    for (const mate of speakers) {
      if (signal && signal.aborted) break;
      const nm = String(mate.name || '').trim();
      let out = null;
      try {
        out = await speakAsCard({ agent: mate, messages: sess.messages, sessionId, signal, mainName: _mainName });
      } catch {
        out = null;
      }
      try {
        const u = out && out.usage;
        const pin = Number(u?.prompt_tokens ?? 0) || 0;
        const pout = Number(u?.completion_tokens ?? 0) || 0;
        if (pin + pout > 0) {
          sess._whaleUsage = sess._whaleUsage
            || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, at: 0 };
          sess._whaleUsage.prompt_tokens += pin;
          sess._whaleUsage.completion_tokens += pout;
          sess._whaleUsage.total_tokens += pin + pout;
          sess._whaleUsage.at = Date.now();
          burned += pin + pout;
        }
      } catch { /* 记账失败不影响她说话 */ }
      const said = String(out?.text || '').trim();
      if (!said) continue;
      sess.messages.push({
        role: 'assistant',
        content: said,
        _text: said,
        _whale: nm,
        _who: nm,
        _card: String(mate.id),
        _cardVoice: true,
        createdAt: new Date().toISOString(),
      });
      try { saveSession(sess); } catch {}
      spoke += 1;
      try { send({ type: 'agent', agentId: String(mate.id), who: nm, text: said }); } catch {}
    }
    if (burned > 0) {
      try { saveSession(sess); } catch {}
      try { send({ type: 'whale_usage' }); } catch {}
    }
    return spoke;
  } catch (e) {
    try { console.warn('[mates] 群里这一趟出错：', String(e?.message ?? e)); } catch {}
    return 0;
  }
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
    /**
     * 【让开的那条路上，我自己一个字都没说】—— 2026-11-03
     *
     * 主人报「同时开小鱼和小鲸，小鲸回两句、小鱼一句不回」。
     * 往前点名她的那一句，小鱼曾经整轮让开（那条路 2026-10-30 已按主人意思删掉：
     * 让开时自己去把她叫起来答话 —— 可她那时候一查这个时间窗，
     * 会话末条 assistant 是我上一轮说的话（不到 3 秒前），
     * 「闸 A」就把她挡掉了（whale-actions.log 里连一条「开始一次」都没有）。
     * 结果：我不说、她也不说。
     *
     * 让开的时候，这一轮本来就不该有我这句话 —— 这个窗口对它不适用。
     */
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
  if (!speaksToHer && Date.now() - __myLastSayAt < 3000) {
    try { logWhaleAction('闸A 让行：我 3 秒前刚说完，她这一下先让'); } catch {}
    dropWhaleSay(send);
    return;
  }

  const { setFullAccess } = await import('./tools.mjs');
  const { logWhaleAction } = await import('./whale-presence.mjs');
  // 【上锁】她这一趟还没跑完，就不许再起第二趟（见 __whaleRunning 的注释）
  if (__whaleRunning.has(sessionId)) {
    try { logWhaleAction('重复拦下：她这一趟还在跑，第二趟不起了'); } catch {}
    try { dropWhaleSay(send); } catch {}
    return;
  }
  __whaleRunning.set(sessionId, { at: Date.now() });
  let __whaleUnlocked = false;
  const __whaleUnlock = () => {
    if (__whaleUnlocked) return;
    __whaleUnlocked = true;
    __whaleRunning.delete(sessionId);
  };
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
      /* 【2026-11-10 按会话】她干活也要听这个会话的功能开关 */
      sessionId,
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
    __whaleUnlock();  // 【放锁】她这一趟跑完/抛了都放开，下一轮才能再进
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
  /**
   * 【在会话上记一笔「她这一轮开过口」】—— 2026-11-03
   *
   * 为什么在这儿：这是她所有说话路（whaleMaybeReply / 插话闸 / ask_peer）
   * 的**公共出口**。记在会话对象上，收尾的群聊段才看得见，
   * 不会对着同一句再把她叫起来答第二遍（主人报的「小鲸说两轮」）。
   */
  markWhaleSpoke(session, text);

  // 推流在这儿（上面），落盘交给两边共用的那一处（本来就在这个函数里，抽出去只为让别的路也能落）
  landWhaleSay({ session, sessionId, text, send, live });
}

/**
 * 【她说的话，怎么进主人的会话】—— 2026-10-27 抽出来
 *
 * 原来这一大段只在这个函数里，于是所有「不经过 whaleMaybeReply」的说话路
 * 都只推了气泡、没落进历史 —— 切会话/重启就没了：
 *   · 她自己在另一条请求里开口答的（旧的「我让开」那条路 2026-10-30 已删）；
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
        /**
         * 【她的话不能算「主流程已经答过了」】—— 2026-10-30 修
         *
         * 主人报：小鱼小鲸都启用时，屏幕上只剩小鲸，我的话一条都不显示。
         *
         * 原因就在这一行：判「这一轮有没有人答」时漏了 !m._whale。
         * 于是她先插一句 → 被判成「主流程答完了」→ 我真正的回答
         * 反而当成多余、被押到她后面、还挂着她的名字，界面上就只剩她。
         * 上面 2026-10-27 那段注释本来就写了「以前只认我自己」，
         * 这一步是漏做了，现在补回来。
         */
        if (m && m.role === 'assistant' && !m._tale && !m._whale
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

function startCooldownSafe(sessionId) {
  try {
    const ms = getRetry429().cooldownMs;
    /* 【2026-11-08 修】冷却按会话记 —— 一个会话撞限流迁移了，别的会话不该跟着冻住。
     * 迁移完挂在**新会话**上（它才是接着跑的那个）。 */
    if (ms > 0 && typeof startCooldown === 'function') startCooldown(ms, sessionId);
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

/**
 * 【2026-11-10 D3·liveLogs 生命周期】
 *
 * 原状：轮次 done 之后整份缓存**永久驻留** —— 单轮 events 上限 20000 条事件对象，
 * 加上 items 真身，一个长轮次能占几 MB～几十 MB。会话开得多、跑得久，内存慢性泄漏。
 *
 * 改法：done 之后**保留 10 分钟**（前端切回来 / 刷新还要靠它对账补画），之后清掉
 * events / items 数组，只留一份轻量摘要（有没有错、事件计数、起止时间）。
 * 清扫用**惰性触发**：新轮次进入、前端轮询直播缓存时顺手扫一遍过期项 ——
 * 不起定时器，就不会有定时器堆积 / 泄漏的问题。
 *
 * 摘要态的兼容（前端 src-ui/store.js 的消费口径）：
 *   · /api/chat/live 里 running 以 runningTurns 为准（本来就不看 live.done）→ 摘要态必然 false；
 *   · items 为空数组 → store.setLive 照收，但 buildMerged 的 isRunning 判 items.length
 *     为 0 → live 不参与绘制，跟「没在跑」完全一致；
 *   · 响应里带 summary 字段，前端想显示「那一轮的账」有据可查。
 */
const LIVE_RETAIN_MS = 10 * 60 * 1000;

/** 把一份 done 的直播缓存清成轻量摘要（幂等：清过就不再动） */
function summarizeLiveLog(live) {
  if (!live || live._summarized) return;
  live._summarized = true;
  const events = Array.isArray(live.events) ? live.events : [];
  const items = Array.isArray(live.items) ? live.items : [];
  live.summary = {
    turnId: Number(live.startedAt) || 0,
    startedAt: Number(live.startedAt) || 0,
    endedAt: Number(live.endedAt) || 0,
    eventCount: events.length,
    itemCount: items.length,
    textLen: items.reduce((n, it) => n + ((it && it.k === 'text') ? String(it.t || '').length : 0), 0),
    hasError: events.some((e) => e && (e.type === 'error' || e.type === 'aborted')),
  };
  live.events = [];
  live.items = [];
  /* rev 照常 +1：/api/chat/live 的游标语义（nextSince）不因清扫而错位 */
  live.rev = (typeof live.rev === 'number' ? live.rev : 0) + 1;
}

/** 惰性清扫：把 done 超过 10 分钟的缓存清成摘要。便宜（Map 通常只有几条），随处可调。 */
function sweepLiveLogs() {
  const now = Date.now();
  for (const live of liveLogs.values()) {
    if (live && live.done && !live._summarized
      && Number(live.endedAt) > 0 && now - Number(live.endedAt) > LIVE_RETAIN_MS) {
      summarizeLiveLog(live);
    }
  }
}

/**
 * 【2026-11-10 D1·会话列表增量协议】
 *
 * 病根：/api/sessions 每次都 listSessions() —— 把每个会话文件**整个读出来**解析一遍
 * （四十多个会话 × 每个几百 KB），前端列表轮询一次就是一轮全量 IO。
 *
 * 改法：先算一个**便宜**的指纹（只 readdir + stat 会话文件，不读内容）：
 *   会话集拓扑（哪些文件在）+ 每会话文件 mtime/size（内容一变 mtime 必变，消息数/标题跟着变）
 *   + 在跑集合（哪些会话正有轮次在跑）+ 智能体卡/设置文件 mtime（列表里的 agentId/crew 依赖它们）
 *   + 最近会话 id（_last.json 切换会话就变）。
 *
 * 指纹没变 → 绝不重算 sessions 数组：
 *   · 客户端带了 ?rev= 且等于当前指纹 → 轻量响应 { rev, unchanged:true, lastSessionId }，
 *     不带 sessions 数组（304 语义）；
 *   · 客户端没带 rev（老前端 / 首拉）→ 直接回缓存的上一份完整 payload，listSessions 一次都不跑。
 * 指纹变了 → 照常全量计算，并把结果连同指纹一起缓存。
 *
 * 向后兼容：rev / unchanged 是新增字段，老前端不认识也不会读 —— 没带 rev 的请求
 * 拿到的 sessions / lastSessionId 跟以前一模一样。
 */
const SESSIONS_DIR_FINGERPRINT = join(config.dataDir, '.state', 'sessions');
/** 上一份完整响应的缓存：{ fp, payload }。指纹变了才重建。 */
let __sessionsCache = { fp: '', payload: null };

function sessionsFingerprint() {
  const parts = [];
  try {
    const names = readdirSync(SESSIONS_DIR_FINGERPRINT);
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      if (name.startsWith('_') || name.startsWith('.')) continue;
      try {
        const st = statSync(join(SESSIONS_DIR_FINGERPRINT, name));
        parts.push(name + ':' + st.mtimeMs + ':' + st.size);
      } catch { /* stat 的那一刻刚好被删了：文件集变化本身就该反映在指纹里 */ }
    }
    parts.sort();
  } catch { /* 目录还不存在：空列表也算一个稳定状态 */ }
  /* 在跑集合：轮次开跑 / 收尾都会改变它 */
  try {
    const running = [];
    for (const [id, t] of runningTurns.entries()) {
      if (t && t.ac && t.ac.signal && t.ac.signal.aborted) continue;
      running.push(id);
    }
    parts.push('running=' + running.sort().join(','));
  } catch {}
  /* 列表里的 agentId / crew / agentName 依赖智能体卡和设置（开没开、谁排前面） */
  for (const f of ['agents.json', 'settings.json']) {
    try {
      const st = statSync(join(config.dataDir, '.state', f));
      parts.push(f + ':' + st.mtimeMs + ':' + st.size);
    } catch { parts.push(f + ':absent'); }
  }
  /* 最近会话：切会话不改会话文件，但它属于列表响应 */
  try { parts.push('last=' + String(getLastSessionId() || '')); } catch {}
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 20);
}

/**
 * 【2026-11-02 · 快照合成】把这一轮的事件流压成「屏幕上该有什么」的一张清单。
 *
 * 为什么要这个东西：
 *  原来前端是「拿一堆增量碎片、边收边拼」，拼的人有七八拨（renderTurns / paintLiveEvents /
 *  followLive / 流式 / replayInFlight），各记各的账。谁记错一次，屏幕就是重复、丢字、串会话。
 *  现在服务端直接给出「这一轮现在长什么样」的一份完整清单，前端照着画就行 ——
 *  画一百次结果一样（幂等），账本也就不需要存在了。
 *
 * 输出：
 *  { k:'text',  t }            正文（相邻 text 已合并成一条）
 *  { k:'think', t }            思考块
 *  { k:'tool',  id,name,args,status:'run'|'ok'|'err', output }
 *  { k:'say',   who, t }       别人说的话（小鲸 / 别的助手）
 *  { k:'note',  t }            系统提示（不进正文）
 *
 * 顺序就是事件原本的顺序（tool 与文字交错也照实排）。
 */
/**
 * 【为什么还要一个「增量版」】
 *
 *  上面那个是从事件数组一次性算出来的（打开一个已经跑完的旧轮次时用）。
 *  可事件数组有上限（LIVE_SOFT_MAX），长回复会被压薄 —— 老的那些正文事件被丢掉，
 *  于是「照事件算出来的清单」就短了一截（屏幕上是短一版，刷新前后不一样）。
 *
 *  所以正在跑的轮次里，清单不从这里算，而是一条事件一条事件地接着长（appendLiveItem）。
 *  它只增不减、不受压薄影响 —— 服务端手里那份才是「这一轮现在到底长什么样」的真身，
 *  前端照着它画。压薄只影响「增量游标」（events），不影响画面。
 */
/* 【2026-11-09 主人报·多段消息堆一块】
 *
 * 病根：排队轮（插话 / 定时任务 / 续跑）**复用同一份 live**（openLiveForQueuedTurn
 * 直接把上一轮的缓存接过来续写，见上面那段注释），可 `done` 不是分段线 ——
 * appendLiveItem 只看「最后一条是不是 text」，于是下一轮的第一段正文会接着
 * 上一轮最后那段往下拼，屏幕上就是「好几轮的话堆在一个气泡里」。
 * 这跟「正在发送消息」消失是同一个根：都发生在流断了、服务端自己接着跑下一轮时。
 *
 * 修法：`done` / `aborted` / `error` 三个轮末事件算**硬分段**。
 * 用 Symbol 打标记（JSON 序列化看不见、不会漏给前端，也不污染 items 的形状），
 * 下一段 text 就一定会新起一个 item。
 * `rate_limited` 不算 —— 那是同一轮里的重试，断开反而会把一句话劈成两个气泡。
 */
function appendLiveItem(items, ev) {
  if (!items || !ev || !ev.type) return;
  /* 轮末：把最后那段正文「封口」，下一轮的话不许再拼上去。
   *
   * 标记用**不可枚举属性**，不是 Symbol 常量 —— 因为 _t_live_cursor.mjs 和
   * check-segment-split.mjs 会把这两个函数抽出来单独跑（new Function），
   * 引用模块级常量会直接 ReferenceError。不可枚举 → JSON.stringify 看不见，
   * 发给前端的 items 仍是干净的原样。 */
  if (ev.type === 'done' || ev.type === 'aborted' || ev.type === 'error') {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!it) continue;
      if (it.k !== 'text') break;          // 最后一条不是正文，本来就已经断开
      try { Object.defineProperty(it, '__segEnd', { value: true, enumerable: false, configurable: true }); } catch { it.__segEnd = true; }
      break;
    }
    return;
  }
  const last = () => (items.length ? items[items.length - 1] : null);
  const lastOf = (k) => { for (let i = items.length - 1; i >= 0; i--) if (items[i].k === k) return items[i]; return null; };
  if (ev.type === 'text') {
    const t = String(ev.text || '');
    if (ev.notice) { if (t) items.push({ k: 'note', t }); return; }
    const p = last();
    if (p && p.k === 'text' && !p.__segEnd) { p.t += t; return; }
    /* 【2026-11-10 修·空气泡（A6）】源头不落空 text：内容还是空就先不建条目，
     * 等真有字了再建 —— 不然 F5 之后屏幕会比清单多一个空气泡。 */
    if (!t) return;
    items.push({ k: 'text', t });
  } else if (ev.type === 'reasoning') {
    const t = String(ev.text || '');
    const p = last();
    if (p && p.k === 'think') p.t += t;
    else items.push({ k: 'think', t });
  } else if (ev.type === 'tool_start') {
    items.push({ k: 'tool', id: String(ev.id || ''), name: String(ev.name || ''), args: String(ev.args || ''), status: 'run', output: '' });
  } else if (ev.type === 'tool_end') {
    const id = String(ev.id || '');
    const it = lastOf('tool');
    if (it && it.id === id) { it.status = ev.ok ? 'ok' : 'err'; it.output = String(ev.output || ''); }
    else items.push({ k: 'tool', id, name: String(ev.name || ''), args: '', status: ev.ok ? 'ok' : 'err', output: String(ev.output || '') });
  } else if (ev.type === 'whale' || ev.type === 'agent') {
    /* 【2026-11-10 修·空气泡（A6）】空 say 不落清单（源头不产生）。
     * 注意 whale_stream_start 的空占位**不在此列**（见下）：它是分段语义的一部分。 */
    const _t = String(ev.text || '');
    const _who = String(ev.who || '');
    if (_t) {
      /**
       * 【2026-11-10 主人报·小鲸的话说两遍（同一句挨着出现两条）】
       *
       * 她一句话在直播清单里实际走**两条事件**：
       *   whale_stream_start → 建一条空 say 占位
       *   whale_delta×N      → 把字拼在那条占位上
       *   whale_stream_finish → 占位补字（通常这时已经拼满了）
       *   whale              → **整句又来一遍**
       *
       * 最后这条原来无条件 push 一条新 say —— 于是清单里就有两条一模一样的。
       * 屏幕上是「小鲸把同一句话说两遍」，刷新前后都在（不是前端重画的锅）。
       *
       * 收口规矩：整句到达时，若最后一条就是同一个人的 say，
       *   · 内容完全相同 → 认成同一次发言，什么都不做（最多把占位补全）
       *   · 占位还空着   → 直接把整句填进去（占位本来就在等这句）
       *   · 占位已有别的内容（她被打断过、后面又接了一句）→ 那确实是新的一句，照常 push
       * 这样「流式 + 定稿整句」永远只落一条气泡，而真接着说的第二句不会被误吞。
       */
      const _lastSay = (() => {
        for (let i = items.length - 1; i >= 0; i--) if (items[i] && items[i].k === 'say') return items[i];
        return null;
      })();
      const _norm = (s) => String(s || '').replace(/\s+/g, '');
      if (_lastSay && _lastSay.who === _who) {
        if (!String(_lastSay.t || '').trim()) {
          _lastSay.t = _t;                       // 占位等着这句：填进去
        } else if (_norm(_lastSay.t) === _norm(_t)) {
          /* 同一句：已经拼满了，收口时把标点/空白对齐到定稿版本 */
          _lastSay.t = _t;
        } else if (_norm(_t).startsWith(_norm(_lastSay.t))) {
          /* 定稿比流式那份长（尾部补全）：以定稿为准，别留半句 */
          _lastSay.t = _t;
        } else {
          items.push({ k: 'say', who: _who, t: _t });
        }
      } else {
        items.push({ k: 'say', who: _who, t: _t });
      }
    }
  } else if (ev.type === 'whale_stream_start') {
    /* 【2026-11-10 A6 复核后保留】这条空 say 占位**必须留**：
     * 它是「小鲸开口了」的分段记号 —— 后面她插进来的 delta 字都拼在它身上，
     * 主智能体被打断前后两截话才能并回同一个气泡（parity 检查的 ①/⑤ 两案
     * 钉的就是这个：占位一删，一句话就被插话劈成两个气泡）。
     * 屏幕那半边的口径：items.js 对 say 与 text 对称滤空 —— 占位还没等到字
     * 就被 F5 / 对账撞上时，前端不画空气泡；两份实现（增量 / 从头重算）
     * 都带着同一个占位，清单仍然逐字相等。 */
    items.push({ k: 'say', who: String(ev.who || ''), t: '' });
  } else if (ev.type === 'whale_delta') {
    const who = String(ev.who || '');
    const it = lastOf('say');
    if (it && it.who === who) it.t += String(ev.text || '');
    else items.push({ k: 'say', who, t: String(ev.text || '') });
  } else if (ev.type === 'whale_stream_finish') {
    const it = lastOf('say');
    const t = String(ev.text || '');
    if (it && !it.t && t) it.t = t;
  } else if (ev.type === 'steer') {
    /* 【2026-11-10 主人钦点·插话显示进对话流中间】
     *
     * 主人要的形态：她「消息1 → 工具」的时候插话发出去，
     * 插话就显示在**消息1 之后、消息2 之前**的对话流位置。
     *
     * 数据层早就对了（steer 进 inbox、agent loop 下一步取走当 user 消息），
     * 错的是屏幕：前端把插话画成乐观气泡，合并公式是「turns + pend + live」——
     * pend 排在 live **之后** = 屏幕最底，她后面说的话又跟在后面长，
     * 于是插话永远卡在最底下，轮末落盘重画才回到正确位置。
     *
     * 现在插话自己就是 live 清单里的**一条独立条目**（k:'user'），
     * 位置 = 事件真实发生的顺序 —— 分段线，绝不并进她正在说的那段正文。
     * 前端 liveToItems 认它、直出成主人气泡，乐观气泡那条路随之退役。 */
    const _t = String(ev.text || '');
    if (_t || (Array.isArray(ev.atts) && ev.atts.length)) {
      items.push({
        k: 'user',
        t: _t,
        steer: true,
        ts: Number(ev.ts) || 0,
        who: String(ev.who || ''),
        ...(Array.isArray(ev.atts) && ev.atts.length ? { atts: ev.atts } : {}),
        ...(ev.rewindId != null ? { rewindId: ev.rewindId } : {}),
      });
    }
  } else if (ev.type === 'sentfile' || ev.type === 'files') {
    /* 【2026-11-10 收编（A2）】她发的文件进清单 —— 前端不再自己画文件卡。
     *
     * 旧路是前端两条：attachFiles 往 .msg 塞 fileList、placeSentCard 往
     * .bubble.streaming 里塞卡片 —— 而那是 React 的 MdDiv，mdInto 每个
     * 流式 tick 都重写 innerHTML，谁挂进去谁下一个 tick 就没了
     * （审查实测「文件卡一闪就没」）。现在文件和工具卡一样是清单条目，
     * 屏幕由 FileCard 照它画。
     *
     * 折叠规则照工具卡的口径：同一份文件（key/path 相同）只留一条，
     * 重复的事件更新原条目、不新增；新文件 = 新条目 = 分段线
     * （appendLiveItem 这边 push 进 items 之后，正文拼接自然断开）。
     * flush / 分段规则本身一个字没动。 */
    const _list = ev.type === 'sentfile' ? [ev.file] : (Array.isArray(ev.items) ? ev.items : []);
    for (const _f of _list) {
      if (!_f || (!String(_f.path || '') && !String(_f.key || ''))) continue;
      const _fk = String(_f.key || _f.path || '');
      let _dup = null;
      for (let _i = items.length - 1; _i >= 0; _i--) {
        if (items[_i].k === 'file' && items[_i].fkey === _fk) { _dup = items[_i]; break; }
      }
      if (_dup) continue;
      items.push({
        k: 'file',
        fkey: _fk,
        name: String(_f.name || '文件'),
        size: Number(_f.size) || 0,
        kind: String(_f.kind || 'file'),
        path: String(_f.path || ''),
        dir: 'out',
      });
    }
  } else if (ev.type === 'worker') {
    /* 【2026-11-03 · 子任务卡（办事模式看不见干活的过程）】
     *  ★ 同一套规则有三份，改一份必须改全三份：
     *    ① 这里 appendLiveItem（增量攒清单，界面一直在读的是它）
     *    ② 下面的 buildLiveItems（从头重算，since=0 那趟、以及 items 空时兜底）
     *    ③ public/index.html 的 itemsFromEvents（前端镜像）
     *  漏了 ① 的真实现象：事件流里明明有 worker 的每一步，快照里却一张卡都没有
     *  —— 屏幕上永远只有那张「派活 · 运行中…」。 */
    const wid = String(ev.wid || '0');
    let it = null;
    for (let i = items.length - 1; i >= 0; i--) if (items[i].k === 'worker' && items[i].id === wid) { it = items[i]; break; }
    if (!it) { it = { k: 'worker', id: wid, name: String(ev.name || ''), status: 'run', steps: [], note: '', startedAt: 0, endedAt: 0 }; items.push(it); }
    if (ev.name) it.name = String(ev.name);
    if (ev.status) it.status = String(ev.status);
    if (ev.note) it.note = String(ev.note);
    /* 【2026-11-11 团队模式】耗时用的两个字段：start 事件带 startedAt（从那一刻算
     * 「· 2分13秒」），end 事件补 endedAt（收尾定格，跑着的由前端每秒现算）。 */
    if (ev.startedAt && !it.startedAt) it.startedAt = Number(ev.startedAt) || 0;
    /* 【2026-11-11 parity 修·时间戳必须来自事件本身】
     * 原来这里写 Date.now()，收尾那一刻「就地取钟」——
     * 而 buildLiveItems（刷新 / items 空时兜底）拿的是事件数组，没有这一刻可问，
     * 于是同一张 worker 卡：直播里有 endedAt，刷新后没有 → 两条路径的清单不逐字相等，
     * 刷新还会把「跑了多久」抹掉。改为读事件上的 endedAt（生产者收尾时打戳），
     * 两条路径读到同一个数；事件没带就留 0（前端 fmtDur 对 <=0 不显示，不崩）。 */
    if (ev.kind === 'end') it.endedAt = Number(ev.endedAt) || 0;
    const _st = String(ev.text || '').trim();
    if (_st && (ev.kind === 'step' || ev.kind === 'start' || ev.kind === 'mail')) {
      it.steps.push({ kind: String(ev.kind || 'step'), t: _st });
      if (it.steps.length > 40) it.steps.splice(0, it.steps.length - 40);
    }
  }
  /* 【2026-11-10 D7·file/sentfile 合成】由上面「收编（A2）」那个分支承担
   * （sentfile / files → k:'file'，字段 fkey/name/size/kind/path/dir，
   * 与 src-ui/FileCard.jsx、src-ui/items.js 同一口径）。这里不再重复落第二个
   * file 分支 —— 两份形状并存必然算出两份清单，parity 必红。 */
}

function buildLiveItems(events) {
  const items = [];
  let cur = null;
  const flush = () => { if (cur && cur.t) items.push(cur); cur = null; };
  const lastOf = (k) => { for (let i = items.length - 1; i >= 0; i--) if (items[i].k === k) return items[i]; return null; };
  /**
   * 【2026-11-09 QA 复核抓到的真缺陷·两份实现对「分段线」判据不同】
   *
   *  `appendLiveItem`（增量，/api/chat/live 有 items 时走它）只看「最后一条 item 是不是 text」；
   *  这里原来**见到任何非 text 事件都 flush()**，包括那些**只更新已有条目、不新增条目**的
   *  （`tool_end` 改已有工具卡、`worker` 更新已有卡、`whale_delta` 补已有 say）。
   *  于是同一条事件流：
   *    appendLiveItem → [text 'B', worker, text 'CD']
   *    buildLiveItems → [text 'B', worker, text 'C', text 'D']
   *  `/api/chat/live` 在不同时刻（items 有 / items 空）给出**段数不同**的清单 ——
   *  屏幕上就是「跑着的时候 3 个气泡，对个账 / 刷新一下变 2 个」。
   *
   *  口径（一边定死，四份实现都照这个来）：
   *    **只有「新增一条条目」的事件才是分段线**；只更新已有条目的不算。
   *  理由：那两种事件在屏幕上没有多出任何东西（只改状态 / 只给已有的卡补一句），
   *  把一段话在这里劈开，主人看到的就是「一句话莫名断成两个气泡」。
   *
   *  所以下面 `flush()` 一律挪进「真要 push 一条新条目」的那一支：
   *   `tool_end` / `whale_delta` / `worker` 命中已有条目时**不 flush**，正文接着长。
   *  （`whale_stream_finish` 本来就只补字、不 push，所以它一直是对的。）
   */
  for (const e of (Array.isArray(events) ? events : [])) {
    if (!e || !e.type) continue;
    /* 轮末就是分段线：排队的下一轮是「另一段话」，不能跟上一轮拼一个气泡。 */
    if (e.type === 'done' || e.type === 'aborted' || e.type === 'error') { flush(); continue; }
    if (e.type === 'text') {
      if (e.notice) { flush(); const _nt = String(e.text || ''); if (_nt) items.push({ k: 'note', t: _nt }); continue; }
      if (!cur) cur = { k: 'text', t: '' };
      cur.t += String(e.text || '');
    } else if (e.type === 'reasoning') {
      flush();
      const last = items[items.length - 1];
      if (last && last.k === 'think') last.t += String(e.text || '');
      else items.push({ k: 'think', t: String(e.text || '') });
    } else if (e.type === 'tool_start') {
      /* 新卡 = 新条目 → 分段线 */
      flush();
      items.push({ k: 'tool', id: String(e.id || ''), name: String(e.name || ''), args: String(e.args || ''), status: 'run', output: '' });
    } else if (e.type === 'tool_end') {
      const id = String(e.id || '');
      const it = lastOf('tool');
      /* 改已有那张卡：屏幕上没多出东西，**不算分段线**（不 flush） */
      if (it && it.id === id) { it.status = e.ok ? 'ok' : 'err'; it.output = String(e.output || ''); }
      else { flush(); items.push({ k: 'tool', id, name: String(e.name || ''), args: '', status: e.ok ? 'ok' : 'err', output: String(e.output || '') }); }
    } else if (e.type === 'whale' || e.type === 'agent') {
      const t = String(e.text || '');
      const who = String(e.who || '');
      /* 【2026-11-10 修·空气泡（A6）】空 say 不落清单（与 appendLiveItem 同口径） */
      if (t) {
        /* 【2026-11-10 修·小鲸的话说两遍】与 appendLiveItem 同一个口径：
         * 整句事件到达时，若最后一条就是同一人的 say，同句/占位/前缀补全 → 收口不新增。
         * 两份实现必须算出逐字相等的清单（check-live-items-parity 钉的就是这个）。 */
        const lastSay = lastOf('say');
        const norm = (s) => String(s || '').replace(/\s+/g, '');
        if (lastSay && lastSay.who === who) {
          if (!String(lastSay.t || '').trim()) lastSay.t = t;
          else if (norm(lastSay.t) === norm(t)) lastSay.t = t;
          else if (norm(t).startsWith(norm(lastSay.t))) lastSay.t = t;
          else { flush(); items.push({ k: 'say', who, t }); }
        } else {
          flush();
          items.push({ k: 'say', who, t });
        }
      }
    } else if (e.type === 'whale_stream_start') {
      /* 【2026-11-10 A6 复核后保留】空 say 占位是分段记号（见 appendLiveItem 同支）；
       * 两份实现都带着它，清单逐字相等；屏幕半边由 items.js 对称滤空。 */
      flush();
      items.push({ k: 'say', who: String(e.who || ''), t: '' });
    } else if (e.type === 'whale_delta') {
      const it = lastOf('say');
      /* 她那一句已经在屏幕上长着：只是接着长，**不算分段线** */
      if (it && it.who === String(e.who || '')) it.t += String(e.text || '');
      else { flush(); items.push({ k: 'say', who: String(e.who || ''), t: String(e.text || '') }); }
    } else if (e.type === 'steer') {
      /* 【2026-11-10 主人钦点·插话进对话流中间】与 appendLiveItem 同一口径：
       * 插话是独立条目 = 分段线（flush 前置，不并进她正在说的正文）。
       * 这是「从头重算」那条路，两份实现必须算出逐字相等的清单。 */
      const _t = String(e.text || '');
      if (_t || (Array.isArray(e.atts) && e.atts.length)) {
        flush();
        items.push({
          k: 'user',
          t: _t,
          steer: true,
          ts: Number(e.ts) || 0,
          who: String(e.who || ''),
          ...(Array.isArray(e.atts) && e.atts.length ? { atts: e.atts } : {}),
          ...(e.rewindId != null ? { rewindId: e.rewindId } : {}),
        });
      }
    } else if (e.type === 'sentfile' || e.type === 'files') {
      /* 【2026-11-10 收编（A2）】她发的文件进清单（与 appendLiveItem 同一口径：
       * 同一份文件只留一条；新文件 = 新条目 = 分段线）。 */
      const list = e.type === 'sentfile' ? [e.file] : (Array.isArray(e.items) ? e.items : []);
      for (const f of list) {
        if (!f || (!String(f.path || '') && !String(f.key || ''))) continue;
        const fk = String(f.key || f.path || '');
        let dup = null;
        for (let i = items.length - 1; i >= 0; i--) {
          if (items[i].k === 'file' && items[i].fkey === fk) { dup = items[i]; break; }
        }
        if (dup) continue;
        flush();
        items.push({
          k: 'file',
          fkey: fk,
          name: String(f.name || '文件'),
          size: Number(f.size) || 0,
          kind: String(f.kind || 'file'),
          path: String(f.path || ''),
          dir: 'out',
        });
      }
    } else if (e.type === 'worker') {
      /* 【2026-11-03 主人：办事模式下看不见干活的过程】
       * 原来 worker 干什么只有主智能体（watch_worker）和文件里的进度知道，
       * 主人屏幕上只有一张「派活 · 运行中…」的卡，它跑多久都只有那一行。
       * 现在 worker 的每一步都当成一个事件推给界面，画成一棵可以展开的子任务卡。 */
      const wid = String(e.wid || '0');
      let it = null;
      for (let i = items.length - 1; i >= 0; i--) {
        if (items[i].k === 'worker' && items[i].id === wid) { it = items[i]; break; }
      }
      if (!it) {
        /* 第一张卡 = 新条目 → 分段线；后面只是往这张卡上补一步，屏幕没多东西，不算 */
        flush();
        /* 【2026-11-11 parity 修·字段形状必须与 appendLiveItem 一致】
         * 增量那边建卡时带 startedAt/endedAt 两个字段（团队模式的耗时），
         * 这里漏了 → 同一张卡两条路径 JSON 不同（少两个键），parity 三条全红。
         * 形状是清单契约的一部分：键不许一边有一边没有。 */
        it = { k: 'worker', id: wid, name: String(e.name || ''), status: 'run', steps: [], note: '', startedAt: 0, endedAt: 0 };
        items.push(it);
      }
      if (e.name) it.name = String(e.name);
      if (e.status) it.status = String(e.status);
      if (e.note) it.note = String(e.note);
      /* 与 appendLiveItem 同一口径：耗时两个字段都从事件上读（不许就地取钟，
       * 否则重算路径拿不到同一刻，清单对不上、刷新还会丢时长）。 */
      if (e.startedAt && !it.startedAt) it.startedAt = Number(e.startedAt) || 0;
      if (e.kind === 'end') it.endedAt = Number(e.endedAt) || 0;
      const stepText = String(e.text || '').trim();
      if (stepText && (e.kind === 'step' || e.kind === 'start' || e.kind === 'mail')) {
        it.steps.push({ kind: String(e.kind || 'step'), t: stepText });
        /* 只留最近 40 步 —— 一个 worker 跑几十轮，全留着会把整轮事件撑爆 */
        if (it.steps.length > 40) it.steps.splice(0, it.steps.length - 40);
      }
    } else if (e.type === 'whale_stream_finish') {
      // 定稿：把最后那条还没字的 say 补上正文（有字就不动）
      const it = lastOf('say');
      const t = String(e.text || '');
      if (it && !it.t && t) it.t = t;
    }
    /* 【2026-11-10 D7·file/sentfile 合成】由上面「收编（A2）」的分支承担
     * （sentfile / files → k:'file'，fkey/name/size/kind/path/dir，与
     * src-ui/FileCard.jsx、src-ui/items.js 同一口径），此处不再重复落第二个分支。 */
  }
  flush();
  return items;
}

/** 一轮能缓存多少事件（防止超长轮次吃内存） */
const LIVE_MAX_EVENTS = 20000;
/** 【2026-11-02】超过这个数就自动压薄 —— 前端扛不住几千次 DOM 重排 */
const LIVE_SOFT_MAX = 600;
/**
 * 【2026-11-10 D5·封顶可感知】events 撞到 LIVE_MAX_EVENTS 之后，再进来的事件原本
 * 被**静默丢弃** —— 界面上后半段凭空消失，主人还以为是程序坏了。现在第一次封顶时
 * 向流内推一条 notice（前端有现成的 note 渲染路径，appendLiveItem 也认 notice text
 * → { k:'note' }），明说「细节省略了」，之后的事件才静默放行丢弃。
 */
const LIVE_CAP_NOTICE_TEXT = '本轮内容太多（超过 ' + LIVE_MAX_EVENTS + ' 条），后面的细节先省略了；事情还在照常做，结果不受影响。';

// In-flight turns: sessionId -> { ac: AbortController, done: Promise<void> }
// 插话要先 abort，再等这一轮真的收尾（历史写完盘）后才能把新话接上去。
const runningTurns = new Map();

/** 小鲸中途插话的节流时间戳（每会话一个用不上，全局一个够了 —— 她一开口就是整个界面看得见）。 */
let lastWhaleTickAt = 0;
/*
 * 【同一会话，她同一时刻只许跑一趟】—— 2026-10-30 修重复
 *
 * 主人报：小鱼小鲸都启用时，同一句话她会答两遍。
 * 实测 whale-actions.log 20:45:30：两行「开始一次」时间完全相同 →
 * 两次都「结束一次：成」→ 各说了一句，会话里就成了两条一样的话。
 * 根因：whaleMaybeReply 有两处调用方（主流程收尾 / 让路分支），
 * 各自都判「这该她说了」，于是同一轮把她叫起来两遍。
 *
 * 这里按会话加一把短锁：她正在跑的时候，第二个进来的直接退出，
 * 不推流、不落盘、不花 token。锁在下面 finally 里放，抛了也会放。
 */
const __whaleRunning = new Map(); // sessionId -> { at }

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
/**
 * 【押着的条目补进历史 · 统一去重】2026-11-11 修主人报的「她回 3 句、后两句一模一样」
 *
 * 病根：小鲸的「并排插话」为防丢，同一个 rec 会**同时押在两个地方**
 * （`runningTurns` 的 reg 上、旁路 `whaleParkBox` 里 —— 见 1764/1776 那两行注释）。
 * 补写时必须把两边合起来看，否则丢话。但合起来之后**同一条会出现两份**：
 *
 *   parked = [...reg.whaleParked, ...box.whaleParked]   ← 同一对象两份引用
 *   for (const rec of parked) msgs.push(rec);           ← 没有去重 → 落两遍
 *
 * 实测证据：会话 smwa2p0lqyxjo.json 里最后两条 assistant 的 `_at` **完全相同**
 * （1794362877148），正文一字不差 —— 就是同一个对象被 push 了两次。
 *
 * `flushWhalePark()` 那条路径早就有这个去重（2026-10-27 修过一次），
 * 但收尾补写（:11423）和开跑补漏（:9149）两处是**直接 push 的**，漏了。
 * 现在三处统一走这里。
 *
 * 判据：`_at + 正文` 当键。同一次发言时间戳是同一个 `Date.now()`，
 * 换成两次真发言时间戳必然不同，所以这个键足够严，不会把真话吞掉。
 *
 * @param {Array} msgs   要补进去的 messages
 * @param {Array} parked 押着的条目（可能含重复引用）
 * @returns {number} 真正补进去的条数
 */
function pushParkedUnique(msgs, parked) {
  if (!Array.isArray(msgs) || !Array.isArray(parked) || !parked.length) return 0;
  const seen = new Set();
  for (const m of msgs) {
    if (m && m._whale) seen.add(String(m._at ?? '') + '|' + String(m.content ?? ''));
  }
  let n = 0;
  for (const rec of parked) {
    if (!rec) continue;
    const k = String(rec._at ?? '') + '|' + String(rec.content ?? '');
    if (seen.has(k)) continue;     // 已经在历史里、或本轮已补过
    seen.add(k);
    msgs.push(rec);
    n += 1;
  }
  return n;
}

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

/**
 * 【2026-11-11 加·askApproval 的挂起表】
 *
 * 危险动作弹窗问主人的那半条链路：工具里 ui-guard.askApproval 读 ctx.askApproval
 * （下面主聊天路由注入的），这里存「等主人点允许/不许」的 resolve 函数。
 * 前端点完 POST /api/ask-approval 带 requestId 来取。
 *
 * 【失败关闭】60 秒没等到答复算「不许」（超时 timer 在 askApproval 里）；
 * 路由这边取不到 resolve（已超时/已答复/重复点）就回 404，绝不补一次「当成功」。
 * 内存表，重启即清 —— 挂着的弹窗随进程消失，不会隔夜复活。
 */
const PENDING_ASKS = new Map();

/**
 * 前情能插在哪儿（只认「安全缝」）。
 *
 * 上游网关按 OpenAI 协议验形状，一条死规矩：
 *   assistant 带 tool_calls 之后，下一个非 tool 消息出现之前，**那批 tool 结果必须到齐**。
 * 往中间塞任何别的东西（包括我们自己的前情那条 user 消息），直接 400：
 *   Messages with role 'tool' must be a response to a preceding message with 'tool_calls'
 *
 * 干活鱼2 就是因为会话压过一次、开头变成
 *   system → 摘要 → assistant(tc) → tool → …
 * 前情又硬插在 2 号位，从此每轮必 400（10/27 一直躺到 10/30）。
 *
 * 这里从前往后找第一个「安全缝」：缝隙前面的消息里，所有 tool_calls 都已经有结果。
 * 找不到返回 -1，由调用方把前情挪去设定副本那一格。
 *
 * @param {Array} msgs 已经 wire 过、准备发给模型的副本
 * @returns {number} 可插入的下标；-1 = 没有安全缝
 */
function safePreludeSlot(msgs) {
  if (!Array.isArray(msgs) || msgs.length === 0) return 0;
  /** 还没拿到结果的 tool_call id */
  const pending = new Set();
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    // 先记账：这条要是「assistant 带 tool_calls」，插在它前面就已经晚了
    const opensToolCalls = !!(m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length);
    // 缝：前面没欠账、当前这条也不是工具调用的开头 → 可以插（0 号位是 system，至少从 1 号开始）
    if (!pending.size && !opensToolCalls && i >= 1) return i;
    if (opensToolCalls) {
      for (const tc of m.tool_calls) if (tc && tc.id) pending.add(tc.id);
      continue;
    }
    if (m && m.role === 'tool') {
      pending.delete(m.tool_call_id);
      continue;
    }
    // 不是 tool 也不是 assistant(tc)，但前面还欠着结果 —— 历史本身已经坏了
    // （repairHistory 会去修，这里只管别把前情也塞进去），继续往后找。
  }
  // 一轮都没还清（比如最后一条 assistant 带 tool_calls、后面还没结果）：没有安全缝
  return pending.size ? -1 : msgs.length;
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
  const __card = cardIdOf(sessionId);
  const { userMsg, assistantText } = seedOpeningMessages(__card);
  if (!String(assistantText || '').trim()) return;
  const at = session.messages.findIndex((m) => m && m.role !== 'system' && !m.context);
  /**
   * 【开场白得认得出是谁说的】—— 2026-11-01 主人报
   *
   * 主人原话：「屏幕上出现了小白曦的开场白，但名字以及颜色消息样式都是小鱼的，
   *           实际上是小鱼在说话」。
   *
   * 原来这一条只写 role/content，不带任何记号。前端重绘历史时认不出说话人，
   * 一律当小鱼 —— 于是小白曦的开场白顶着鱼的名字和鱼的颜色出来了。
   *
   * 小鱼自己不用标（她就是默认身份）；别人的卡才标 _card/_who，
   * 跟群聊段里她们说的话一个口径。
   */
  const __say = { role: 'assistant', content: assistantText };
  if (__card && __card !== AGENT_XIAOYU) {
    try {
      const __a = getAgent(__card);
      if (__a && __a.name) {
        __say._who = String(__a.name);
        if (__card === AGENT_XIAOJING) __say._whale = String(__a.name);
        else __say._card = String(__card);
      }
    } catch {}
  }
  const pair = [userMsg, __say];
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
    // 【2026-10-31 主人要求】老的、已经收起来的工具结果不进上下文，只留一句摘要；
    // 正在干的最近几条保持完整。只改 wire 里的副本，history 原样不动。
    collapseOldToolBodies(wire, 6);
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
    /** 【2026-10-31 修】这一行是从别处复制来的，snap 没定义过（报 snap is not defined）。
     *  叫她起来这一轮没有「主人手上的那句消息」可以挂回滚点，跟 QQ 那边一样给空快照。 */
    const snap = {};
    /* 【2026-11-11 修·stashFile 不许挂到上一轮】本轮起点：此刻最后一条正主 user 消息的下标。
     * 闭包创建时取一次就够 —— runAgent 的 refreshSystem 重建的是 wire（history.slice() 副本），
     * session.messages 不动，这个下标全程安全（scripts/check-stashfile-turn.mjs 第三组钉的就是这条）。
     * 往回找 assistant 时以它封底：本轮还没有自己的回复就老老实实新建一条，
     * 绝不把 worker 发的文件挂到上一轮那句去。 */
    const turnStart = (() => {
      try {
        const ms = session.messages;
        for (let q = ms.length - 1; q >= 0; q--) {
          const m = ms[q];
          if (m && m.role === 'user' && !m.context) return q;
        }
      } catch {}
      return -1;
    })();
    const out = await runWithToolContext({ sessionId, snap, signal: ac.signal, outbox: null, pushEvent: (ev) => { try { send(ev); } catch {} }, stashFile: (f) => {
        try {
          const ss = (typeof session !== 'undefined' && session) ? session : null;
          if (ss && Array.isArray(ss.messages) && f) {
            /* 【2026-11-11 修·不许挂到上一轮】倒着找 + 以本轮起点封底：
             * turnStart 是闭包创建时记下的「本轮起点」下标。本轮还没有 assistant
             * 就回 -1，走下面「新建一条」的分支。（scripts/check-stashfile-turn.mjs
             * 实测四种判据里只有这个写法 4/4 全对。）
             * 不能用「最后一条 user 之后」——主人中途插话（steer 会 push 一条 user）
             * 会把本轮最终回复排除掉；也不能从 turnStart 往后找第一条——
             * 会命中工具调用那条哑巴 assistant。 */
            let ix = -1;
            for (let q = ss.messages.length - 1; q >= Math.max(0, turnStart); q--) {
              const m2 = ss.messages[q];
              if (m2 && m2.role === 'assistant' && !m2.context) { ix = q; break; }
            }
            if (ix < 0) { ss.messages.push({ role: 'assistant', content: '', at: Date.now() }); ix = ss.messages.length - 1; }
            const pv = Array.isArray(ss.messages[ix]._out) ? ss.messages[ix]._out : [];
            if (!pv.some((x) => x && x.key && f.key && x.key === f.key)) {
              pv.push(f);
              ss.messages[ix]._out = pv;
              try { saveSession(ss); } catch {}
            }
          }
        } catch {}
      } }, () => runAgent({
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
      if (m && (m.role === 'system' || m.context || m._sysNote === true)) continue;
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
  /* 【2026-11-10 D3】新轮次进入时顺手扫一遍过期缓存（惰性清扫，不起定时器） */
  try { sweepLiveLogs(); } catch {}
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
/**
 * 【定时任务】到点跑一条：往目标会话投一句引子，再起一轮。
 *
 * 为什么不直接 runAgent：startQueuedTurn 会管排队、锁、前端实时补画、收尾落盘。
 * 定时任务跑出来的东西主人得能在界面上看见 —— 所以走这条路，跟「重启了」一模一样。
 *
 * 引子带 context: true：服务端当作框架消息，前端不画成「主人说的话」。
 */
async function runCronTask(task) {
  if (!task || !task.id) return { ok: false, error: 'no-task' };
  const text = String(task.text || '').trim();
  if (!text) return { ok: false, error: 'empty-text' };

  // 挑会话：任务指定的那个；没指定就用最近动过的那个
  let sid = String(task.sessionId || '').trim();
  if (!sid) {
    try {
      const all = listSessions();
      const pick = all.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      sid = pick && pick.id ? String(pick.id) : '';
    } catch { sid = ''; }
  }
  if (!sid || !isSessionId(sid)) {
    try { cronMarkRan(task.id, false, '没有能跑的会话'); } catch {}
    return { ok: false, error: 'no-session' };
  }

  const sess = getSession(sid);
  if (!sess) {
    try { cronMarkRan(task.id, false, '会话读不出来：' + sid); } catch {}
    return { ok: false, error: 'no-session-data' };
  }

  /*
   * 投引子。措辞要写清楚「这是你自己定的闹钟」，
   * 否则她可能以为主人在跟她说话、或者以为时间乱了。
   */
  const when = new Date(Number(task.at) || Date.now());
  const hh = String(when.getHours()).padStart(2, '0');
  const mm = String(when.getMinutes()).padStart(2, '0');
  const lead = [
    '（定时任务到了：' + hh + ':' + mm + '）',
    '',
    '这是主人之前给我定下的活：',
    text,
    '',
    '现在就到点了，我直接去做，做完告诉主人结果。',
    /* 【2026-11-10 修·定时任务从来没成功跑过】
     * 这里原来是 `.join(eol)`，而 **eol 这个变量在整个项目里从来没定义过**。
     * 于是每次到点都在这一行抛 ReferenceError → 被 cron.mjs 那个 catch 吞掉，
     * 只在任务列表留一句「这一趟没跑起来」+ 一行 console.warn。
     * 表现就是：定时任务配了、时间也对，但到点什么都不发生，翻遍界面看不出原因。
     *
     * 引子本来就是几行文本，按 '\n' 拼就是本意（Windows 显示换行照样正常）。 */
  ].join('\n');

  sess.messages = Array.isArray(sess.messages) ? sess.messages : [];
  sess.messages.push({
    role: 'user',
    content: lead,
    /**
     * 【2026-11-10 修·引子被「设定副本」吃掉，定时任务等于没跑】
     *
     * 原来这里写的是 `context: true`。可 agent.mjs 每轮开头有一段重建逻辑：
     * 只要 `messages[1]` 是 `role:'user' + context:true` 且不是摘要，
     * 就直接 `messages[1].content = ctx`（把这一轮的设定副本写进去）。
     *
     * 新建会话的消息序列正好是：[system] + 这条引子 → 引子落在 index 1 →
     * 下一轮开头被整段替换成设定副本，**主人的任务正文一个字都不剩**。
     * 实测取证：会话里那条 `_cron` 消息的 content 是 4735 字的设定，
     * 含「定时任务到了」= false，而任务状态还是「跑过了」。
     *
     * 现在只用 `_sysNote`（前端据此画成一条系统提示，不画成主人说的话），
     * 不再打 context —— context 是「每轮重算的设定副本」专用的记号，借它当地位会打架。
     */
    _sysNote: true,
    _at: Date.now(),
    _cron: String(task.id),
  });
  try { saveSession(sess); } catch {}

  try {
    const r = await startQueuedTurn(sid);
    if (r && (r.skipped || r.error)) {
      try { cronMarkRan(task.id, false, String(r.skipped || r.error)); } catch {}
    }
    return r || { ok: true };
  } catch (e) {
    try { cronMarkRan(task.id, false, String(e && e.message || e)); } catch {}
    throw e;
  }
}

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
  /* 【2026-11-02 修·跟续跑那个 ac is not defined 同一类】**
   *  下面 runWithToolContext 传了 snap、还读 ac.signal，
   *  可 snap 在这个函数里从来没声明 —— 一叫醒就抛 ReferenceError，
   *  被外层 catch 吞掉，表现成「重启后没人叫醒我」。 */
  const snap = {};
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
    // 【2026-10-31 主人要求】老的、已经收起来的工具结果不进上下文，只留一句摘要；
    // 正在干的最近几条保持完整。只改 wire 里的副本，history 原样不动。
    collapseOldToolBodies(wire, 6);
    const seen = new Set(history);

    /* 【2026-11-11 修·stashFile 不许挂到上一轮】本轮起点：此刻最后一条正主 user 消息的下标。
     * 闭包创建时取一次就够 —— runAgent 的 refreshSystem 重建的是 wire（history.slice() 副本），
     * session.messages 不动，这个下标全程安全（scripts/check-stashfile-turn.mjs 第三组钉的就是这条）。
     * 往回找 assistant 时以它封底：本轮还没有自己的回复就老老实实新建一条，
     * 绝不把 worker 发的文件挂到上一轮那句去。 */
    const turnStart = (() => {
      try {
        const ms = session.messages;
        for (let q = ms.length - 1; q >= 0; q--) {
          const m = ms[q];
          if (m && m.role === 'user' && !m.context) return q;
        }
      } catch {}
      return -1;
    })();
    const out = await runWithToolContext({ sessionId, snap, signal: ac.signal, outbox: null, pushEvent: (ev) => { try { send(ev); } catch {} }, stashFile: (f) => {
        try {
          const ss = (typeof session !== 'undefined' && session) ? session : null;
          if (ss && Array.isArray(ss.messages) && f) {
            /* 【2026-11-11 修·不许挂到上一轮】倒着找 + 以本轮起点封底：
             * turnStart 是闭包创建时记下的「本轮起点」下标。本轮还没有 assistant
             * 就回 -1，走下面「新建一条」的分支。（scripts/check-stashfile-turn.mjs
             * 实测四种判据里只有这个写法 4/4 全对。）
             * 不能用「最后一条 user 之后」——主人中途插话（steer 会 push 一条 user）
             * 会把本轮最终回复排除掉；也不能从 turnStart 往后找第一条——
             * 会命中工具调用那条哑巴 assistant。 */
            let ix = -1;
            for (let q = ss.messages.length - 1; q >= Math.max(0, turnStart); q--) {
              const m2 = ss.messages[q];
              if (m2 && m2.role === 'assistant' && !m2.context) { ix = q; break; }
            }
            if (ix < 0) { ss.messages.push({ role: 'assistant', content: '', at: Date.now() }); ix = ss.messages.length - 1; }
            const pv = Array.isArray(ss.messages[ix]._out) ? ss.messages[ix]._out : [];
            if (!pv.some((x) => x && x.key && f.key && x.key === f.key)) {
              pv.push(f);
              ss.messages[ix]._out = pv;
              try { saveSession(ss); } catch {}
            }
          }
        } catch {}
      } }, () => runAgent({
      messages: wire,
      signal: ac.signal,
      sessionId,
      safeMode: !inPersonaMode(session),
      safeWord: session.mode?.word || '',
      onEvent: (ev) => {
        if (!ev) return;
        if (ev.type === 'error') console.warn('[queued] ' + sessionId + ' 出错：' + String(ev.message ?? ''));
        // 照主轮的样子写进直播缓存，前端 followLive 才画得出来
        /* 【2026-11-02 揪出来的真 bug：接续轮的工具条全丢】
         *  这里原来只认 'tool' / 'tool_result' 两个名字，可 runWithToolContext
         *  实际吐出来的是 'tool_start' / 'tool_end' —— 一个都对不上，
         *  于是被叫醒的那一轮前端只有字、没有【跑命令】【写文件】那些条。
         *  现在两边名字都认，以后再加事件名也记得往这儿补。 */
        if (ev.type === 'text' || ev.type === 'reasoning' || ev.type === 'tool' || ev.type === 'tool_result' || ev.type === 'tool_start' || ev.type === 'tool_end' || ev.type === 'whale' || ev.type === 'whale_stream_start' || ev.type === 'whale_delta' || ev.type === 'notice') {
          send(ev);
        }
      },
    }));

    repairHistory(history);
    for (const m of wire) {
      if (seen.has(m)) continue;
      if (m && (m.role === 'system' || m.context || m._sysNote === true)) continue;
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
    /* 【2026-11-09 补】排队轮（setImmediate 起来的那种）出错也要落盘。
     * 以前这里只 send({type:"error"})，事件一走就没了：切会话、刷新、重启全都看不见。
     * 跟主轮那处一个套路，先落历史再发事件，并且去重。 */
    try {
      const _s = getSession(sessionId);
      const _last = (_s && Array.isArray(_s.messages) && _s.messages.length) ? _s.messages[_s.messages.length - 1] : null;
      const errText = String(e?.message ?? e);
      if (_s && !(_last && _last.__turnErr)) {
        _s.messages.push({
          role: 'assistant',
          content: '⚠️ 这一轮断在这儿了：' + errText
            + '\n\n（这一轮没说完，工具结果还在。换个模型试试，或者跟我说一声「接着办」，我照清单往下走。）',
          at: Date.now(),
          __turnErr: true,
        });
        saveSession(_s);
      }
    } catch {}
    if (ac.signal.aborted) send({ type: 'aborted', reason: String(ac.signal.reason ?? '') });
    /* 【2026-11-10 修·错误提示画两遍】落盘过就打 persisted，
     * 前端便不再补画一颗（屏幕只认历史那一条）。见前端 error 分支注释。 */
    else send({ type: 'error', message: String(e?.message ?? e), persisted: true });
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
async function resumeInterruptedTurn(onlySessionId) {
  /* 【2026-11-07 改·可以指定续哪一个】
   *
   * 原来只能续「最近那一条」。现在 resume.json 里一个会话一条，
   * 开机要挨个把每个都起回来 —— 所以这里加个参数：
   *   给 sessionId → 只续那一个（开机遍历时用）
   *   不给        → 续最近那一个（POST /api/resume 这类老调用点用）
   * 不这么改的话，第二次调用永远拿到同一条（因为第一条还没删），
   * 结果要么重复续同一个、要么把别人漏掉。
   */
  /* 【2026-11-05 改·先取走改成先看一眼】
   *
   * takeInterrupted() 是「取出即删」。可续跑路上有好几道闸，任何一道没过
   * （没配模型 / 屋里的鱼关着 / 那一轮其实已经收尾）都会 return ——
   * 文件已经被删了，**下一次重启就再也没得续**。
   * 这解释了「有时候能续、有时候静悄悄」：第一次没续成，机会就用光了。
   *
   * 现在改成 peek：只有真的跑完、或者确定不可能再续（会话没了），才 drop。
   */
  const info = peekInterrupted(onlySessionId);
  diagLog('resume-enter', info ? `session=${info.sessionId}` : 'info=null（没有中断标记）');
  if (!info) return;
  const sessionId = info.sessionId;
  const session = getSession(sessionId);
  if (!session) {
    console.log('[resume] 上次崩的会话已经没了：', sessionId);
    /* 【2026-11-07】只删这一条：别的会话的断点还得留着给下一轮续 */
    try { dropInterrupted(sessionId); } catch (e) {}
  diagLog('resume-skip:no-session', sessionId);
    return;
  }
  /**
   * 【续跑也要看开关】—— 2026-10-27 补
   *
   * 崩之前小鱼是开着的，重启后主人可能已经关了她。
   * 不看这一眼，就会在主人明确关掉之后自己爬起来接着答。
   */
  /*
   * 【2026-11-01 主人：重启后要自己接着做，不用我催】
   *
   * 原来这里有道闸：小鱼在这个会话没开就 return。可主人关小鱼不代表
   * 那一轮没干完 —— 屋里还有别的智能体，活照样得接着干。
   * 现在改成：只要这屋里有任何一个能说话的人开着，就允许续跑。
   */
  let _anyVoice = false;
  try { _anyVoice = Boolean(fishOn(sessionId)); } catch {}
  if (!_anyVoice) {
    try {
      const _ids = groupAgentIds(sessionId) || [];
      _anyVoice = _ids.some((id) => {
        try { return mateSwitchOn(id, sessionId); } catch { return false; }
      });
    } catch {}
  }
  if (!_anyVoice) {
    console.log('[resume] 这屋里一个人都没开，不续跑：', sessionId);
    diagLog('resume-skip:nobody-on', sessionId);
    return;
  }
  const ep = activeEndpoint();
  if (!ep || !ep.apiKey) {
    console.log('[resume] 没配模型，续跑跳过');
  diagLog('resume-skip:no-endpoint', sessionId);
    return;
  }
  if (runningTurns.get(sessionId)) {
    console.log('[resume] 那个会话已经在跑了，不插队');
  diagLog('resume-skip:already-running', sessionId);
    return;
  }
  const last = session.messages[session.messages.length - 1];
  /**
   * 【判「这一轮到底收完没有」】—— 2026-10-31 改宽
   *
   * 原来只认「最后一条是 user」，说这一轮已经收尾了就不续。
   * 可实测的断法根本不长这样：
   *   · 跑到一半被重启掐断 → 最后一条是 tool（工具刚返回，模型还没说话）
   *   · 模型刚说完「我去改」准备调工具 → 最后一条是 assistant，但话没说完活也没干
   * 这两种都被判成「收尾了」，于是重启后没人接手，主人看到的就是「小鱼干到一半自己停了」。
   *
   * 现在反过来判：**只有「最后一条是 assistant、且没有待执行的工具调用」才算真收尾**。
   * 空壳 assistant（没文字也没工具）也当作没收尾 —— 那是断在半路的疤。
   */
  const lastHasTools = !!(last && Array.isArray(last.tool_calls) && last.tool_calls.length);
  const lastHasText = !!(last && String(last.content ?? '').trim().length);
  // tool 一律算断在半路：工具刚跑完、话还没来得及说就被掐断了，这是最常见的一种
  // 【别被草稿回灌骗了】草稿会被补成一条 assistant 消息（带 _recovered），
  // 补完以后「最后一条是 assistant 有文字」就成立了 —— 可那一轮其实没干完，
  // 只是被打断后把半截话接回来了。所以先看尾巴有没有 _recovered 的痕迹。
  // 【只认「紧挨着的那一条」】草稿回灌会把半截话补成一条带 _recovered 的 assistant。
  // 补回来的那句本身绝对不能算收尾 —— 那一轮其实没干完。
  // 但如果接回来之后又追加了新的 assistant 收尾，那就是真说完了，不能再续。
  const lastIsRecovered = !!(last && last._recovered);
  const reallyFinished = !!(last && last.role === 'assistant' && lastHasText && !lastHasTools && !lastIsRecovered);
  /*
   * 【2026-11-01 主人：重启后自己接着做，别等我催】
   *
   * 「上一轮说完了」不等于「活干完了」—— 我可能是在说了句「请重启」
   * 或者「我先把这批改完」之后就收尾的，清单上还有没打勾的步骤。
   * 所以这里多问一句：清单还有剩的吗？有剩就照样续。
   */
  let _planLeft = 0;
  /*
   * 【2026-11-01 严检揪出的真 bug】
   *
   * 原来写的是 String(loadPlan(sessionId) || '') 再按行找「1. · 」开头的行。
   * 可 loadPlan 返回的是【对象】{goal, steps:[...]}，String(对象) 得到的是
   * 字面量 "[object Object]" —— 切成一行，一个也匹配不上，_planLeft 恒为 0。
   *
   * 后果：清单上明明还有 8 步没做，续跑却每次都判「清单也清空了」直接跳过
   * （diag.log 里那条 resume-skip:finished 就是它）。主人看到的就是
   * 「重启完一片安静，得自己再催一句」。
   */
  try {
    const _p = loadPlan(sessionId);
    const _steps = (_p && Array.isArray(_p.steps)) ? _p.steps : [];
    _planLeft = _steps.filter((x) => x && x.status !== 'done' && x.status !== 'skipped').length;
  } catch {}
  /* 【2026-11-05 加·有明确意图就不再猜】
   *
   * resume.json 是「有活没干完」那一刻写的（写的时候最清楚），
   * 里面带 intent:'continue'。既然写了，就不该再拿「最后一条消息长得像不像收尾」去推翻它。
   *
   * 不加这一条的话，主人让她重启、她刚好说完一句完整的话、清单又是空的 ——
   * 就会被判成「已完成」直接跳过，表现就是「有时候只是重启，没有续上」。
   */
  const _explicitIntent = String(info && info.intent || '') === 'continue';
  if (reallyFinished && !_planLeft && !_explicitIntent) {
    console.log('[resume] 上一轮说完了、清单也清空了，不用续');
    diagLog('resume-skip:finished', sessionId);
    return;
  }
  if (reallyFinished && !_planLeft && _explicitIntent) {
    console.log('[resume] 上一轮表面说完了，但重启前明确记了「要接着做」—— 照续');
    diagLog('resume-go:intent', sessionId);
  }
  if (reallyFinished && _planLeft) {
    console.log('[resume] 上一轮说完了，但清单还剩 ' + _planLeft + ' 步没做 —— 接着干');
    diagLog('resume-go:plan-left(' + _planLeft + ')', sessionId);
  }
  /* 【2026-11-02 修】这里原来直接写 { ac, ... } 又用 ac.signal、snap，
   *  两个变量在这个函数里根本没定义 —— 一进续跑就抛「ac is not defined」，
   *  被外层 catch 吞掉，表现成「重启后不接着干，日志只到 resume-enter」。
   *  跟上面叫她起来那一轮是同一个错（那边修过又抄漏了）。 */
  const ac = new AbortController();
  const snap = {};
  const turn = { ac, done: null, resumeTurn: true, startedAt: Date.now() };
  runningTurns.set(sessionId, turn);
  /**
   * 【2026-11-08 真修·续跑轮要有自己的事件出口】
   *
   * 昨天我把 `onEvent: () => {}` 改成 `send(ev)` 就以为修好了 —— 其实没有：
   * `send` 不是模块级函数，它只在 /api/chat（8181）和 startQueuedTurn（2789）
   * 里各自局部定义。这里一调就抛 ReferenceError，被 try/catch 吞掉，
   * 事件照样一个都进不了 live。主人问「自动重启续上是不是会导致
   * 在运行但我看不到在运行」——答案是**会，而且昨天那次没修动**。
   *
   * 现在照 startQueuedTurn 的样子补齐：开一个 live，定义局部 send。
   * 这样 pushEvent（工具事件）和 onEvent（正文/报错）两条路都能写进
   * live.events，前端 followLive 画得出来，/api/running 的 events 也会涨，
   * 看门狗不再把它误判成「真空转空挂 12 分钟」。
   */
  const live = openLiveForQueuedTurn(sessionId);
  const send = (ev) => {
    if (!live) return;
    try { live.events.push({ ...ev, at: Date.now() }); } catch {}
  };
  try {
    const history = session.messages;
    repairHistory(history);
    // 这句是给模型的临时提示，不是主人说的 —— 打 context 标记，
    // 这样它不进 turns、不参与压缩、跑完摘掉。
    history.push({
      role: 'user',
      content:
        '（上一轮跑到一半被打断了（程序重启 / 崩溃 / 被关掉都算）。你现在是在**接着**那一轮做，' +
        '不是重新开始；已经说过的话主人已经看到了，别从头复述。）' +
        (info.text ? `\n你当时正说到：「${info.text.slice(-600)}」` : '') +
        (info.taskLine ? `\n主人当时的原话：「${info.taskLine}」` : '') +
        /* 【2026-10-30】清单上没打勾的步骤一并告诉它 —— 否则它只知道「断在半句话」，
         * 不知道自己还有哪几步没做完，还是得等主人发「继续」。 */
        (Array.isArray(info.openSteps) && info.openSteps.length
          ? `\n清单上还没做完的这几步：` + info.openSteps.map((x) => `\n  ${x.n}. ${x.text}`).join('') +
            `\n就照这个往下做，按顺序来，别跳。`
          : '') +
        '\n直接从断的地方往下做，该调工具就调，别问我「要不要继续」。',
      context: true,
    });
    const wire = history.slice();
    // 【2026-10-31 主人要求】老的、已经收起来的工具结果不进上下文，只留一句摘要；
    // 正在干的最近几条保持完整。只改 wire 里的副本，history 原样不动。
    collapseOldToolBodies(wire, 6);
    const seen = new Set(history);
    /* 【2026-11-11 修·stashFile 不许挂到上一轮】本轮起点：此刻最后一条正主 user 消息的下标。
     * 闭包创建时取一次就够 —— runAgent 的 refreshSystem 重建的是 wire（history.slice() 副本），
     * session.messages 不动，这个下标全程安全（scripts/check-stashfile-turn.mjs 第三组钉的就是这条）。
     * 往回找 assistant 时以它封底：本轮还没有自己的回复就老老实实新建一条，
     * 绝不把 worker 发的文件挂到上一轮那句去。 */
    const turnStart = (() => {
      try {
        const ms = session.messages;
        for (let q = ms.length - 1; q >= 0; q--) {
          const m = ms[q];
          if (m && m.role === 'user' && !m.context) return q;
        }
      } catch {}
      return -1;
    })();
    const out = await runWithToolContext({ sessionId, snap, signal: ac.signal, outbox: null, pushEvent: (ev) => { try { send(ev); } catch {} }, stashFile: (f) => {
        try {
          const ss = (typeof session !== 'undefined' && session) ? session : null;
          if (ss && Array.isArray(ss.messages) && f) {
            /* 【2026-11-11 修·不许挂到上一轮】倒着找 + 以本轮起点封底：
             * turnStart 是闭包创建时记下的「本轮起点」下标。本轮还没有 assistant
             * 就回 -1，走下面「新建一条」的分支。（scripts/check-stashfile-turn.mjs
             * 实测四种判据里只有这个写法 4/4 全对。）
             * 不能用「最后一条 user 之后」——主人中途插话（steer 会 push 一条 user）
             * 会把本轮最终回复排除掉；也不能从 turnStart 往后找第一条——
             * 会命中工具调用那条哑巴 assistant。 */
            let ix = -1;
            for (let q = ss.messages.length - 1; q >= Math.max(0, turnStart); q--) {
              const m2 = ss.messages[q];
              if (m2 && m2.role === 'assistant' && !m2.context) { ix = q; break; }
            }
            if (ix < 0) { ss.messages.push({ role: 'assistant', content: '', at: Date.now() }); ix = ss.messages.length - 1; }
            const pv = Array.isArray(ss.messages[ix]._out) ? ss.messages[ix]._out : [];
            if (!pv.some((x) => x && x.key && f.key && x.key === f.key)) {
              pv.push(f);
              ss.messages[ix]._out = pv;
              try { saveSession(ss); } catch {}
            }
          }
        } catch {}
      } }, () => runAgent({
      messages: wire,
      signal: ac.signal,
      sessionId,
      safeMode: !inPersonaMode(session),
      safeWord: session.mode?.word || '',
      /* 【2026-11-01 谁排第一谁干活】续跑也走主声，不能固定成默认人设 */
      agentId: (() => { try { return String(mainAgentId(sessionId, (id) => mateSwitchOn(id, sessionId)) || ''); } catch { return ''; } })(),
      /* 【2026-11-08 修·自动续跑那一轮是「哑」的】
       *
       * 原来是 `onEvent: () => {}` —— 续跑轮吐的字、调的工具、报的错，
       * 一个都不往 live 推。于是界面上「什么都没发生」，/api/running
       * 一直显示 events:0，主人发消息只看见自己那句，没人回、也没开工。
       * 更要命的是看门狗：没有事件就判「真空转」，得等 12 分钟才掐。
       *
       * 现在跟主轮一样接上 send()。看得见，看门狗也能按「等模型」那档早点管。 */
      onEvent: (ev) => { try { send(ev); } catch {} },
    }));
    repairHistory(history);
    for (const m of wire) {
      if (seen.has(m)) continue;
      if (m && (m.role === 'system' || m.context || m._sysNote === true)) continue;
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
    /* 【2026-11-05 修·续跑那一轮没有用量】
     *
     * 主人报「自动重启后没显示这一轮时长」。查下来是：续跑这条路跑完只打了日志、
     * 返回了文字，**从来没把 out.usage 存进会话** —— 而界面上的 tokens 和时长
     * 都是从会话文件里的 _usage 读的。所以那一轮整行都是空的。
     *
     * 字段跟 /api/chat 那条主路保持一致（白名单那几个），_ms 也带上。
     * 挂到最后一条「主人的话」上，跳过 context 那种临时引子。
     */
    if (out && out.usage) {
      try {
        const msgs = session.messages;
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m && m.role === 'user' && !m.context) {
            m._usage = {
              prompt_tokens: Number(out.usage.prompt_tokens ?? 0),
              completion_tokens: Number(out.usage.completion_tokens ?? 0),
              total_tokens: Number(out.usage.total_tokens ?? 0),
              context_tokens: Number(out.usage.prompt_tokens ?? 0),
              calls: Number(out.usage.last_calls ?? 0),
              _ms: Number(out.usage._ms ?? 0),
            };
            break;
          }
        }
        saveSession(session);
      } catch (e) { /* 存不上不影响续跑本身 */ }
    }

    /* 【2026-11-05 加】真跑完了才算用掉这份意图 —— 失败/中途 return 的都留着，下次还能试。
     * 【2026-11-07 改】只删这一个会话的那条：别的会话还排队等着续，
     * 原来无参调用会把整个文件端掉，于是第二个会话永远续不上。 */
    try { dropInterrupted(sessionId); } catch (e) {}

    console.log('[resume] 续跑跑完了：', sessionId, out && out.text ? `（${String(out.text).length} 字）` : '');
    diagLog('resume-done', `session=${sessionId} textLen=${out && out.text ? String(out.text).length : 0}`);
    return { ok: true, sessionId, text: out && out.text };
  } catch (e) {
    console.warn('[resume] 续跑这一轮没跑成：', String(e?.message ?? e), 'sessionId =', sessionId);
    diagLog('resume-fail', `session=${sessionId} ${String(e?.message ?? e)}`);
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

  /**
   * 【2026-11-10 主人钦点：「添加模型」的「选一个」不要写死的】
   *
   * 以前那颗下拉是前端写死的一张 PROVIDERS 预设表（按 base host 认出哪家，
   * 列出那家的常用模型名）。缺点很直接：换了个分组 / 新模型上线 / 小众家，
   * 下拉里一个字都没有，还得自己照着文档手打。
   *
   * 现在这里直接问服务商：GET {base}/models（OpenAI 兼容），把真实可用的 id 拿回来。
   * 前端点「拉一下」调它，成功就填下拉、失败才回落到预设表。
   *
   * 几条硬规矩：
   *   · **key 绝不进日志**（这不是可选要求，写日志时只能提长度/是否为空）
   *   · 超时 10 秒就认输 —— 主人正在填表，不能让他干等
   *   · base 规整：末尾斜杠去掉；已经带 /v1 就直接拼 /models，
   *     否则按常见形态先试 /v1/models，再退一步试 /models（有些家两种都挂）
   */
  if (req.method === 'POST' && url.pathname === '/api/models/discover') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { ok: false, error: 'invalid JSON body' });
    }
    const _base0 = String((payload && payload.base) || '').trim();
    let _key0 = String((payload && payload.key) || '').trim();
    if (!_base0) return json(res, 400, { ok: false, error: '先填接口地址' });
    if (!/^https?:\/\//i.test(_base0)) return json(res, 400, { ok: false, error: '接口地址要以 http:// 或 https:// 开头' });

    /**
     * 【2026-11-10 修·「拉一下」永远 401（主人报「拉一下会没拉到」）】
     *
     * 前端编辑已有模型时，Key 输入框是**空的**（后端只回 hasKey:true / keyHint，
     * 从不把 key 发回前端，这是对的）。而「拉一下」原来只读那个空输入框 →
     * 不带 Authorization 去问 /v1/models → 服务商回 401 → 主人看到「没拉到」。
     * 实测就是这样：同一个地址同一个 key，命令行带上就 200 拉到 4 个模型，
     * 界面上点就 401。
     *
     * 现在：前端没填 key 时，服务端**用这个地址已保存的那个 key** 兜底
     * （按 baseURL 归一化后匹配，忽略末尾斜杠和 /v1 差异）。
     * 主人没填就代表「用已保存的那个」，这正是他的意思。
     */
    if (!_key0) {
      try {
        /* 注意：不能用 listModels() 的返回去找 key（它只回 hasKey，从来不带 apiKey）。
         * 必须走 keyForBaseURL —— 它是专门为这件事开的口子。 */
        const _found = keyForBaseURL(_base0);
        if (_found) {
          _key0 = _found;
          try { diagLog('models-discover-keyfallback', '按地址找到已保存的 key（长度 ' + _key0.length + '）'); } catch {}
        } else {
          try { diagLog('models-discover-nokey', 'base=' + _base0 + ' 没有已保存的 key，按无 key 请求'); } catch {}
        }
      } catch (e) { /* 拿不到就用空 key 去试（有些自建站不校验） */ }
    }

    const _trimSlash = (s) => String(s ?? '').trim().replace(/\/+$/, '');
    const _b = _trimSlash(_base0);
    /* 候选 URL：带 /v1 的原样 > 补 /v1 > 就是 /models（少数家这么挂） */
    const _cands = /\/v1$/i.test(_b)
      ? [`${_b}/models`]
      : [`${_b}/v1/models`, `${_b}/models`];

    const _headers = { Accept: 'application/json' };
    if (_key0) _headers.Authorization = `Bearer ${_key0}`;

    let _lastErr = '';
    for (const _u of _cands) {
      try {
        const _res = await fetch(_u, { method: 'GET', headers: _headers, signal: AbortSignal.timeout(10_000) });
        if (!_res.ok) {
          /* 别把响应体整段塞回前端（可能有内部地址/调试信息），只留一行 */
          const _txt = await _res.text().catch(() => '');
          _lastErr = `HTTP ${_res.status}` + (_txt ? '：' + String(_txt).slice(0, 160).replace(/\s+/g, ' ') : '');
          continue;
        }
        const _j = await _res.json().catch(() => null);
        /* OpenAI 兼容形状：{data:[{id:'...'}]}；少数家直接给数组或 {models:[...]} */
        let _arr = null;
        if (_j && Array.isArray(_j.data)) _arr = _j.data;
        else if (Array.isArray(_j)) _arr = _j;
        else if (_j && Array.isArray(_j.models)) _arr = _j.models;
        if (!_arr) { _lastErr = '返回里没有模型列表（不是 OpenAI 兼容格式）'; continue; }
        const _ids = [];
        for (const _m of _arr) {
          const _id = String((_m && (_m.id || _m.name || _m.model)) || '').trim();
          if (_id && !_ids.includes(_id)) _ids.push(_id);
        }
        if (!_ids.length) { _lastErr = '拉到了列表，但里面没有可用的模型名'; continue; }
        _ids.sort((a, b) => a.localeCompare(b));
        try { diagLog('models-discover', `ok base=${_b} keyLen=${_key0.length} count=${_ids.length}`); } catch {}
        return json(res, 200, { ok: true, ids: _ids, url: _u });
      } catch (e) {
        /* 网络层的错误对主人没意义（"fetch failed" / ECONNREFUSED），翻成人话 */
        const _n = String(e?.name || '');
        const _m = String(e?.message || '');
        let _h = _m;
        if (_n === 'TimeoutError' || /timeout/i.test(_m)) {
          _h = '等太久了（10 秒没回话），地址或网络可能不对';
        } else if (/ECONNREFUSED/i.test(_m)) {
          _h = '连不上这个地址（服务没开 / 端口不对）';
        } else if (/ENOTFOUND|getaddrinfo/i.test(_m)) {
          _h = '找不到这个域名，地址可能写错了';
        } else if (/certificate|SSL|TLS/i.test(_m)) {
          _h = '证书有问题，试试 http:// 而不是 https://';
        } else if (!_m || _m === 'fetch failed') {
          _h = '连不上：地址不对，或者这个服务不接 /v1/models';
        }
        _lastErr = _h.slice(0, 180);
      }
    }
    /* 日志里只记地址和失败原因 —— key 一个字都不写 */
    try { diagLog('models-discover-fail', `base=${_b} keyLen=${_key0.length} err=${_lastErr}`); } catch {}
    return json(res, 200, { ok: false, error: _lastErr || '拉不到模型列表' });
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

  // ---- 团队模式：worker 花名册与手动停（2026-11-11，docs/design-team-mode.md §1.5）----
  if (req.method === 'GET' && url.pathname === '/api/team/workers') {
    const sid = url.searchParams.get('sessionId') || '';
    if (!isSessionId(sid)) return json(res, 400, { error: 'bad sessionId' });
    const ws = listWorkers(sid);
    return json(res, 200, {
      sessionId: sid,
      workers: ws,
      running: ws.filter((w) => w.status === 'running').length,
      total: ws.length,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/team/stop') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const sid = String((payload && payload.sessionId) || '');
    if (!isSessionId(sid)) return json(res, 400, { error: 'bad sessionId' });
    const wid = String((payload && payload.wid) || '').trim();
    if (!wid) return json(res, 400, { error: 'missing wid' });
    const r = stopWorker(sid, wid);
    return json(res, r && r.ok ? 200 : 404, { ...r, sessionId: sid });
  }

  // ---- 正在跑那一轮的直播缓存（重启窗口后补画用） ----
  if (req.method === 'GET' && url.pathname === '/api/chat/live') {
    const sid = url.searchParams.get('sessionId') || '';
    if (!isSessionId(sid)) return json(res, 400, { error: 'bad sessionId' });
    /* 【2026-11-10 D3】前端轮询顺手清一遍过期缓存（惰性清扫） */
    try { sweepLiveLogs(); } catch {}
    const live = liveLogs.get(sid);
    if (!live) return json(res, 200, { sessionId: sid, running: false, events: [], summary: null });
    // 「还在跑」以真正登记在跑的轮次为准，不能只看这份缓存标记。
    // 缓存只活在内存里：进程一崩/一重启，那份 done=false 就留在了旧对象上；
    // 界面照着它当「还在跑」，就会一直等一条永远不会来的回复。
    // 【2026-10-31 挂死轮清理】：登记的那一轮其实早就被停掉了（ac 已 abort），
    // 却因为收尾时判断「不是我登记的」而没删 —— 前端就一直以为她还在干，
    // 输入框锁着、消息发不出去，非得刷新页面才缓过来。这里顺手清掉。
    let alive = runningTurns.has(sid);
    if (alive) {
      const reg = runningTurns.get(sid);
      if (reg && reg.ac && reg.ac.signal && reg.ac.signal.aborted) {
        try { runningTurns.delete(sid); } catch {}
        alive = false;
        try { diagLog('stale-turn-cleared', sid); } catch {}
      }
    }
    /**
     * 【2026-11-01 修·刷新后发消息一卡一卡的】
     *
     * 原来这里每次都回 `events: live.events` —— 全量。
     * 前端 followLive 每 1200ms 轮询一次，于是长对话里每 1.2 秒就要
     * 序列化 + 传输 + 解析 295 个事件，刷新后特别明显：字一顿一顿地冒。
     *
     * 现在支持 `?since=<n>`：只回第 n 条之后的新增，外加 `nextSince` 让前端记账。
     * 不传 since（或者传 0）还是回全量，新开一轮 / 切会话回来照样能拿全。
     */
    const sinceRaw = url.searchParams.get('since');
    const since = Number.isFinite(Number(sinceRaw)) && Number(sinceRaw) > 0 ? Math.floor(Number(sinceRaw)) : 0;
    const all = Array.isArray(live.events) ? live.events : [];
    /* 【2026-11-02 游标修复 · 丢字真凶就在这一行】
     *  原来 since 是「事件条数」：`since > 0 && since <= all.length ? all.slice(since) : ...`。
     *  可 send() 会把累积型的 text/reasoning 并进上一条 —— 条数不变、正文却一直在变长。
     *  前端按条数推进游标，那条被追加的事件就再也拉不到：屏幕停在那一刻不动，
     *  非得再刷新一次（since=0 走全量）才补回来。
     *  现在游标换成 rev（每次 push/合并都 +1），被加长的老事件同样能被拉到。 */
    const _revOf = (e) => (e && typeof e.rev === 'number' ? e.rev : 0);
    const tail = since > 0 ? all.filter((e) => _revOf(e) > since) : all;
    /* 【2026-11-02 快照对账】这一轮的正文现在一共多少字（notice 不算正文）。
     *  前端拿它跟「屏幕上已经画了多少字」对账：短了就说明增量那条路没跟上（游标错位、
     *  事件被合并、连接断过…），立刻拉一次全量走补画 —— 这是兜底的幂等保证，
     *  让「刷新之后永远追不上尾巴」在结构上不可能发生。 */
    /* 【textLen 也要照「真身」算】events 会被压薄，拿它算出来的长度会偏短，
     *  前端据此对账就会以为「自己画多了」。清单不受压薄影响，长度才是真的。 */
    const _items0 = (live && Array.isArray(live.items) && live.items.length) ? live.items : buildLiveItems(all);
    const _textLen = _items0.reduce((a, it) => a + ((it && it.k === 'text') ? String(it.t || '').length : 0), 0);
    return json(res, 200, {
      sessionId: sid,
      /* 【2026-11-02 主人报「消息被吞、画面固定」】
       *  原来只写 alive && !live.done。alive 是「runningTurns 里还有这条」，
       *  可续跑/一轮被停掉之后 ac 已经 abort，那个条目要是没被清掉，
       *  这里就永远报 running:true → 前端 busy 锁死、按钮变【停止】、
       *  切回来发消息撞 /api/chat 的 409，主人看到的就是「话被吞」。
       *  口径跟 /api/running（3468 行）对齐：ac 已 abort 的残骸不算在跑。 */
      /* 【2026-11-09 改】同 /api/running：live.done 不等于「这一轮结束了」，
       * 它只是「直播流关了」。只认运行登记 + 没被 abort。 */
      running: alive && !(() => {
        const t0 = runningTurns.get(sid);
        return !!(t0 && t0.ac && t0.ac.signal && t0.ac.signal.aborted);
      })(),
      startedAt: live.startedAt,
      endedAt: live.endedAt ?? null,
      since,
      total: all.length,
      nextSince: typeof live.rev === 'number' ? live.rev : all.length,
      textLen: _textLen,
      /* 【2026-11-02 快照】「这一轮现在该显示成什么样」的一份完整清单。
       *  前端只要照它画一遍就行 —— 不传 since 或传 0 时给（全量那趟），
       *  增量那趟没必要重复给（items 已经含了全部正文）。 */
      items: _items0,
      events: tail,
      /* 【2026-11-10 D3】缓存被清成摘要后（done 超 10 分钟），这里给出摘要标记。
       *  此时 running=false、items=[]、events=[]，前端照旧画不出任何直播内容；
       *  想知道那一轮的结局（有没有错、事件计数）看这个字段。 */
      summary: live.summary || null,
    });
  }

  // ---- 前端打个点（切会话耗时、怪现象现场） ----
  /**
   * 【2026-11-03】界面里 __mark() 一直在往这儿 POST（切会话的四个计时点），
   * 可服务端从来没有这个路由 —— 每次切会话浏览器控制台就红三条 405。
   * 主人看见的那句「会报 HTTP 400」有一半就是这么来的噪声。
   * 现在真把它落下来：写进 .state/console.log，查「切会话为什么慢」时直接翻这个。
   */
  if (req.method === 'POST' && url.pathname === '/api/debug-log') {
    try {
      const b = await body(req).catch(() => null);
      const line = new Date().toISOString() + ' [web] ' + JSON.stringify(b || {}).slice(0, 800) + '\n';
      __diagAppend(join(config.dataDir, '.state', 'console.log'), line, 'utf8');
    } catch { /* 记不上就算了 */ }
    return json(res, 200, { ok: true });
  }

  // ---- askApproval 答复：前端确认框（「她要动：xx」）点完回传 ----
  // 挂起表里取 resolve 调掉。取不到（已超时 / 已答过 / 编号不对）就 404，
  // 绝不把「没问着」当成功 —— 那半边由 askApproval 的 60 秒 timer 按「不许」兜底。
  if (req.method === 'POST' && url.pathname === '/api/ask-approval') {
    const b = await body(req).catch(() => null);
    const rid = String((b && b.requestId) || '');
    const fn = PENDING_ASKS.get(rid);
    if (typeof fn !== 'function') {
      try { console.log('[ask] 答复落空：' + rid + ' yes=' + String(b && b.yes) + '（挂起表里没有，可能已超时/已答过）现存 ' + PENDING_ASKS.size + ' 条'); } catch {}
      return json(res, 404, { ok: false, error: '没有这个待确认的请求（可能已经超时或答复过了）。按「不许」处理。' });
    }
    fn((b && b.yes) === true);
    return json(res, 200, { ok: true });
  }

  // ---- 哪些会话正在跑（界面切回来时用得上） ----
  if (req.method === 'GET' && url.pathname === '/api/running') {
    const list = [];
    for (const [id, t] of runningTurns.entries()) {
      // 【2026-10-31 修 52】跟 /api/chat/live 同一条兜底：登记还在、但那一轮其实早被停掉了
      // （ac 已 abort），这份残骸会让界面一直以为还在跑：按钮显示「停止」、输入框锁着，
      // 主人切回会话发不出话，还以为是程序卡死。这里先清残骸再报，别把它当活的。
      if (t && t.ac && t.ac.signal && t.ac.signal.aborted) {
        try { runningTurns.delete(id); } catch {}
        continue;
      }
      const live = liveLogs.get(id);
      /**
       * 【2026-11-09 修·主人报「工具跑着跑着，【正在发送消息】和柜门【运行中】一起消失，而且不再回来」】
       *
       * 原来这里有一句 `if (live && live.done) continue;`。
       * 问题在于 **live.done 只表示「这条直播流关了」，不表示「这一轮结束了」**：
       * 页面切走、连接断一下、客户端为了重连把流掐掉，都会让它变 true，
       * 而服务端那一轮**照样还在跑**（工具还在跑、模型还在想）。
       * 于是 /api/running 把它报成「没在跑」→ 前端隐藏提示 → 这一轮后面的
       * 事件全堆在 live 里没人画，等下次刷新一次性铺出来（就是「多段消息堆一块」）。
       *
       * 现在只看**运行登记本身**：runningTurns 里还挂着、而且没被 abort，就是在跑。
       * 登记由这一轮自己删（收尾的 finally），那才是唯一权威的生命周期；
       * 直播流的死活是传输层的事，不该拿它判业务。
       */
      const _t0 = runningTurns.get(id);
      if (_t0 && _t0.ac && _t0.ac.signal && _t0.ac.signal.aborted) continue;
      if (live && live.done && !_t0) continue;   // 只剩个关掉的直播壳、连登记都没有：别报
      /**
       * 【2026-11-07 加·「在跑」和「卡住了」得能分开】
       *
       * 主人报：「会话列表显示她在跑（小绿点），点进去发现她早停了」。
       * 查下来两边都是真的：runningTurns 里确实挂着这条，可 events=0、
       * 会话文件好几分钟没动 —— 请求发出去了，模型一个字都没回。
       *
       * 界面只拿得到 startedAt 和 events，分不出「正在想」和「卡死了」。
       * 这里补三个量：最后一次事件的时间、已经等了多久、有没有在动。
       * 前端就能把绿点变成「回过字没」的绿 / 「超过 90 秒没动静」的黄。
       */
      const now = Date.now();
      const evCount = live ? live.events.length : 0;
      let lastEventAt = Number(t.startedAt) || 0;
      if (live && evCount) {
        /**
         * 【2026-11-07 修·事件不一定都有 at】
         *
         * 主路径 push({ ...ev, at: Date.now() }) 带 at，但小鲸那条
         * （live.events.push({ type:'whale', who, text })）不带。
         * 最早写成「取最后一个的 at，没有就退回开跑时间」——
         * 一旦最后一个恰好是没 at 的那种，idleMs 就变成「从开跑算起」，
         * 实测把一个刚在动的会话报成「卡住 17 分钟」。往前找最近一个带 at 的。
         */
        for (let i = evCount - 1; i >= 0 && i >= evCount - 8; i -= 1) {
          const a = Number(live.events[i] && live.events[i].at);
          if (Number.isFinite(a) && a > 0) { lastEventAt = a; break; }
        }
      }
      list.push({
        sessionId: id,
        startedAt: t.startedAt ?? 0,
        events: evCount,
        lastEventAt,
        /* 从「最后一次有动静」算起静了多久；一个事件都没有时从开跑算起 */
        idleMs: Math.max(0, now - lastEventAt),
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
      startCooldownSafe(newId);
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

  // 【2026-11-04 主人要求】「设为默认」存下的就是「恢复默认」回来的那份
  if (req.method === 'POST' && url.pathname === '/api/identity/as-default') {
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    const ok = setIdentityAsDefault(String(payload?.id || ''));
    if (!ok) return json(res, 400, { error: '只有内建身份能设默认' });
    return json(res, 200, Object.assign({ ok: true }, identityState()));
  }

  if (req.method === 'POST' && url.pathname === '/api/identity/restore-default') {
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    const ok = restoreIdentityDefault(String(payload?.id || ''));
    if (!ok) return json(res, 400, { error: '只有内建身份能恢复默认' });
    return json(res, 200, Object.assign({ ok: true }, identityState()));
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
  /* 【2026-11-05 修·这一行原来是块注释开头，把下面 62 行全注释掉了】
   *
   * 症状：点【功能】显示「读取功能列表失败」—— /api/features 的路由
   * 正好落在这段注释里，压根没执行，请求一路掉到静态文件兜底，回 404。
   * 一起被吞的还有整个 cron（定时任务）的所有路由。
   *
   * 成因：这里开了块注释却没在这一段收尾，结束符落到了下面「陪看屏幕」
   * 那个注释块的末尾 —— 中间所有代码都成了注释正文。JS 语法完全合法，
   * node --check 一个字都不会报。
   *
   * 现在收在正确位置：下面的 cron / features 路由全部恢复生效。
   */
  // ===== 定时任务（cron）—— 按主人要求加的 =====
  if (req.method === 'GET' && url.pathname === '/api/cron') {
    return json(res, 200, { tasks: listTasks(), limits: { tickMs: 30000 } });
  }

  if (req.method === 'POST' && url.pathname === '/api/cron') {
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { error: 'bad body' }); }
    try {
      const task = addTask(payload || {});
      return json(res, 200, { ok: true, task, tasks: listTasks() });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/cron/remove') {
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const r = removeTask(payload && payload.id);
    return json(res, 200, { ok: true, ...r, tasks: listTasks() });
  }

  /* 【2026-11-06 修】前端那颗「删」发的是 DELETE /api/cron?id=xxx，这里原来只有 POST /remove，
   * 于是界面点删除返回 405，前端拿 try/catch 一裹静默吞掉 —— 看着像「点了没反应」。
   * 补上 DELETE 这条路（id 从 query 里拿），跟前端已经写好的调用对齐。 */
  if (req.method === 'DELETE' && url.pathname === '/api/cron') {
    const id = url.searchParams.get('id');
    const r = removeTask(id);
    return json(res, 200, { ok: true, ...r, tasks: listTasks() });
  }

  if (req.method === 'POST' && url.pathname === '/api/cron/toggle') {
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const r = cronSetEnabled(payload && payload.id, Boolean(payload && payload.on));
    return json(res, 200, { ok: true, ...r, tasks: listTasks() });
  }

  if (req.method === 'POST' && url.pathname === '/api/cron/run') {
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { error: 'bad body' }); }
    const want = String((payload && payload.id) || '');
    const hit = listTasks().find((t) => String(t.id) === want);
    if (!hit) return json(res, 404, { error: '没这个任务' });
    try {
      await runCronTask(hit);
      return json(res, 200, { ok: true, tasks: listTasks() });
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  }

  /**
   * 【2026-11-10 按会话】功能开关从「全局」改成「按会话」。
   *
   * 读：带 sessionId 就按这个会话算（三级回退：会话表 → 全局表 → defaultOn）；
   *     不带就退回全局 —— **只为兼容老前端/老脚本**，新代码一律带 sessionId。
   * 写：见下面的 /api/features/set，一律 setFeatureScoped()，缺 sessionId 直接 400。
   */
  if (req.method === 'GET' && url.pathname === '/api/features') {
    const sid = String(url.searchParams.get('sessionId') || '') || '';
    return json(res, 200, getFeatures(sid));
  }

  /**
   * 【陪看屏幕 · 她最近看过的那几张】2026-11-01
   *
   * 主人问过一次「她到底看了什么」，当时只能翻盘上的目录。
   * 这条接口把最近几帧（时间 / 前台窗口 / 为什么看 / 缩图路径）列出来给界面用。
   *
   * 只回**缩图**路径，不回整张原图 —— 缩图 78KB 左右，界面画一排不心疼；
   * 点开看大图再走 /api/frames/<id> 那条（见下面的静态段）。
   * 顺便 prune() 一次：这个接口本来就不常调，顺手把两小时前的清掉。
   */
  /**
   * 【关闭显示屏】界面按钮（2026-11-11 主人要的）
   *
   * 和工具 screen_off 走同一个实现（turnOffScreen），不另写一套 ——
   * 两套实现迟早会走偏：按钮能用、工具不能用，或者反过来。
   *
   * 功能关掉时按钮也要拦住：这里先查 screenOff 这个功能开关，
   * 关了就直接 403 并如实说"功能被关了"，不假装关屏成功。
   */
  if (req.method === 'POST' && (url.pathname === '/api/screen/off' || url.pathname === '/api/screen/on')) {
    let payload = {};
    try { payload = await body(req); } catch { payload = {}; }
    const sid = String(payload?.sessionId || url.searchParams.get('sessionId') || '') || '';
    /* 只有「关」受功能开关管；「开」一律放行 ——
       否则主人一关功能、屏幕又正好黑着，就再也开不回来了（虽然物理按键还能救，
       但那是把功能开关变成了惩罚）。 */
    if (url.pathname === '/api/screen/off') {
      try {
        if (featureOnFor(sid, 'screenOff') === false) {
          return json(res, 403, { error: '「关闭显示屏」这个功能被关掉了，去【功能】里打开再试。' });
        }
      } catch { /* 查不到开关就当开着，别把人挡在门外 */ }
    }
    try {
      if (url.pathname === '/api/screen/off') {
        const r = await turnOffScreen({
          keepBrightness: Boolean(payload?.keepBrightness),
          /* 默认跟独立小工具一致：先变暗 3 秒做预告，再彻底熄屏。
             传 0 可以跳过预告直接黑。 */
          armSeconds: Number.isFinite(Number(payload?.armSeconds)) ? Number(payload.armSeconds) : 3,
        });
        if (!r.ok) return json(res, 500, { error: r.error || '关屏失败' });
        return json(res, 200, { ok: true, note: '显示器已关闭，电脑仍在运行' });
      }
      const r = await turnOnScreen();
      if (!r.ok) return json(res, 500, { error: r.error || '恢复失败' });
      return json(res, 200, { ok: true, note: '显示已恢复' });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 【增强提示词】输入框右下角那颗星星（2026-11-11 主人要的）
   *
   * 主人写下「帮我看看这个报错」，点一下星星 → 这句话被改写成更具体的表述，
   * **直接替换回输入框**，他自己决定发不发。不发就点「恢复原文」。
   *
   * 【为什么要单独一条接口，而不是塞进 /api/chat】
   * 这是一次性改写，**不能进会话历史**：进了历史，主人真正发出去的那句话
   * 前面就多了一段他没说过的内容。所以走独立接口 + 独立提示词 + 非流式调用。
   *
   * 【为什么失败也返回 200】
   * 界面那颗星星要区分三种收场：成功（换文案）、取消（静默恢复原文，
   * 是主人再点一下造成的，不该弹错误）、失败（tooltip 显示原因）。
   * 全用 200 + success/code 表达，前端只认这套字段，不用去猜 HTTP 状态码。
   * 404/500 只在「接口本身出问题」时才出现。
   */
  if (req.method === 'POST' && url.pathname === '/api/enhance-prompt') {
    let payload = {};
    try { payload = await body(req); } catch { payload = {}; }
    const text = String(payload?.text ?? '');
    const sid = String(payload?.sessionId ?? '') || '';
    if (!text.trim()) {
      return json(res, 200, { success: false, text: '', code: 'empty_input', error: '输入框是空的，没东西可增强。' });
    }
    try {
      const r = await enhancePrompt({ text, sessionId: sid, model: payload?.model || undefined });
      if (r && r.ok) return json(res, 200, { success: true, text: r.text });
      return json(res, 200, { success: false, text: '', code: (r && r.code) || 'unknown', error: (r && r.error) || '增强失败' });
    } catch (e) {
      /* 取消：主人再点一下星星。界面要静默恢复原文，所以这里给 success:false + aborted，
       * 前端见 aborted 不弹任何提示。 */
      if (e?.name === 'AbortError') return json(res, 200, { success: false, text: '', code: 'aborted' });
      return json(res, 500, { success: false, text: '', code: 'unknown', error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/screen/frames') {
    try {
      // 顺手清一次两小时前的（这个接口本来就不常调，不用另起定时器）
      try { pruneFrames(); } catch { /* 清不掉不影响列表 */ }
      const frames = recentFrames(12);
      // getEnabledMap()[id] === false 才是「主人关掉了」；没这个键或 true 都算开着
      const en = (() => { try { return getEnabledMap().screenSense !== false; } catch { return true; } })();
      return json(res, 200, { ok: true, frames, enabled: en });
    } catch (e) {
      return json(res, 200, { ok: true, frames: [], note: String(e?.message ?? e) });
    }
  }
  /**
   * 【那一帧的缩图】给界面点开看大一点用。
   *
   * 只许取 .state/frames 目录里的东西：id 是 capture() 生成的，
   * 但地址栏里传什么进来都得防一手 —— 这里只认 [a-z0-9-] 拼出来的 id，
   * 拼不出就 400，绝不让 ../ 溜出这个目录。
   */
  if (req.method === 'GET' && url.pathname.startsWith('/api/frames/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/frames/'.length));
    if (!/^[a-z0-9][a-z0-9-]{2,40}$/i.test(id)) return json(res, 400, { error: 'bad frame id' });
    const want = String(url.searchParams.get('size') || 'small');
    const name = id + (want === 'full' ? '.png' : '-small.jpg');
    try {
      const buf = await readFile(join(screenFrameDir(), name));
      res.writeHead(200, {
        'Content-Type': want === 'full' ? 'image/png' : 'image/jpeg',
        'Cache-Control': 'no-store',
        'Content-Length': String(buf.length),
      });
      return res.end(buf);
    } catch {
      return json(res, 404, { error: '这一帧不在了（两小时后会自动清掉）' });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/features/set') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      /**
       * 【2026-11-10 主人要求：功能仅当前会话，不是全局】
       *
       * 原来这里只有 selfwake 一条走会话，其余 30 个都写全局表 ——
       * 结果主人在 A 会话把「跑命令」关了，B 会话也跟着没了。
       *
       * 现在一律 setFeatureScoped()：
       *   - 普通功能 → 写会话表（feature-by-session.json），**缺 sessionId 就 400**，
       *     绝不偷偷写全局；
       *   - GLOBAL_ONLY_FEATURES（videoBg / screenSense）→ 仍写全局，
       *     那两条是「这台机器在不在做」，本来就没有会话这回事。
       *
       * 返回体保留老的 features/total/enabledCount/enabledTools（老前端在读），
       * 但数值是按**这个会话**算的；另外补 ok / id / on / scope 方便新前端直接用。
       */
      const fid = String(payload?.id || '');
      const sid = String(payload?.sessionId || url.searchParams.get('sessionId') || '') || '';
      /* selfwake 的老行为：没带 sessionId 就落到「最后一次用过的会话」。
       * 它本来就靠会话活着，退到那个会话比直接 400 有用得多（且不会写全局）。 */
      const target = (fid === 'selfwake' && !sid) ? String(getLastSessionId() || '') : sid;
      /* 机器级那 5 条（GLOBAL_ONLY_FEATURES）本来就没有会话可言，不要求 sessionId；
       * 别在这里重新手写一份 id 名单 —— 名单只有 features.mjs 一处，抄第二份迟早对不上。 */
      if (!target && !GLOBAL_ONLY_FEATURES.has(fid)) {
        return json(res, 400, { error: '缺少 sessionId：功能开关现在按会话生效，必须告诉我是哪个会话' });
      }
      const r = setFeatureScoped(fid, payload?.enabled, target);
      /* 机器级那条不报 sessionId（它就是没有会话）—— 报个 SESS_A 出去，
       * 前端很容易当成「这是 A 的私有状态」。 */
      const echoSid = r.scope === 'global' ? null : (r.sessionId || target || null);
      /* features 清单永远按这个会话给（机器级那 5 条本来就走全局，不受影响）；
       * 只把 sessionId 回显置空，免得前端把那 5 条当成「A 的私有状态」。 */
      return json(res, 200, { ...getFeatures(target), ok: true, id: fid, on: r.on, scope: r.scope, sessionId: echoSid });
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  /* ===== 功能：导出 / 导入 / 删除（2026-11-10 主人要的） =====
   *
   * 定义存哪、为什么更新不丢：见 src/features.mjs 顶部「自定义功能」那段。
   * 这里只做 HTTP 这层：收 id 列表、落盘、把结果原样回给前端。
   *
   * 内置工具名清单从 allTools 现取（它已经含 ui_*）——
   * 用它判断「导入的功能引用了不存在的工具」，只提醒、不拦。
   */
  const knownToolNameSet = () => {
    const out = new Set();
    for (const t of (Array.isArray(allTools) ? allTools : [])) {
      const n = String(t?.name || '');
      if (n) out.add(n);
    }
    return out;
  };

  // GET /api/features/export?ids=a,b,c —— 不落盘，直接把清单回给前端（可以当场预览）
  if (req.method === 'GET' && url.pathname === '/api/features/export') {
    const raw = String(url.searchParams.get('ids') || '');
    const ids = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return json(res, 200, exportFeatures(ids));
  }

  // POST /api/features/export-to { ids?, dir? } —— 真的写到磁盘上
  if (req.method === 'POST' && url.pathname === '/api/features/export-to') {
    let payload = {};
    try { payload = await body(req); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    try {
      const ids = Array.isArray(payload?.ids)
        ? payload.ids.map((x) => String(x))
        : (typeof payload?.ids === 'string' ? payload.ids.split(',').map((s) => s.trim()).filter(Boolean) : []);
      return json(res, 200, exportFeaturesTo({ ids, dir: payload?.dir }));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // POST /api/features/import { files?, bundle?, features? }
  if (req.method === 'POST' && url.pathname === '/api/features/import') {
    let payload = {};
    try { payload = await body(req); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    try {
      return json(res, 200, importFeatures(payload, { knownTools: knownToolNameSet() }));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // POST /api/features/remove { id } —— 只许删自定义
  if (req.method === 'POST' && url.pathname === '/api/features/remove') {
    let payload = {};
    try { payload = await body(req); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    try {
      return json(res, 200, removeCustomFeature(payload?.id ?? url.searchParams.get('id')));
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
  /**
   * 开场白开关（2026-10-31 主人要的）
   *
   * 原来想暂时不开场，只能把那段话删了 —— 回头还得重新打一遍。
   * 现在单独记一个开关：稿子留着，关掉就是这次不开口。
   * GET  ?id=xxx  → { enabled: true|false }
   * POST { id, enabled } → 存下来
   */
  if (url.pathname === '/api/agents/opening-switch') {
    if (req.method === 'GET') {
      const id = url.searchParams.get('id') || '';
      return json(res, 200, { ok: true, id, enabled: cardOpeningEnabled(id) });
    }
    if (req.method === 'POST') {
      let payload;
      try {
        payload = await body(req);
      } catch {
        return json(res, 400, { error: 'invalid JSON body' });
      }
      try {
        const r = setCardOpeningEnabled(payload?.id, payload?.enabled !== false);
        return json(res, 200, { ok: true, ...r });
      } catch (err) {
        return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
      }
    }
  }

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
        factoryPersona: ed.defaultText,
        personalDefaultPersona: p.defaultPersona,
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
      return json(res, 200, { ok: true, persona: p.persona, personaCustom: p.personaCustom, modelId: p.modelId, personalDefaultPersona: p.defaultPersona });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/whale/profile/reset') {
    try {
      const p = saveWhaleProfile({ persona: '', modelId: '' });
      const ed = whalePersonaForEditor();
      return json(res, 200, { ok: true, persona: p.persona, personaCustom: p.personaCustom, modelId: p.modelId, personalDefaultPersona: p.defaultPersona, factoryPersona: ed.defaultText });
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
   * 【管理员权限 · 2026-11-01】
   *
   * 主人按的那个开关。按会话存（跟小鲸在场、专业模式一个规矩），
   * 状态在 .state/admin-mode.json，每次开关都记一行 .state/admin.log。
   *
   * 为什么单独两条接口而不是塞进 /api/settings：
   * 这是**升高权限**，不是普通偏好 —— 要能被单独审计、单独关掉，
   * 而且读它的时候还要顺手告诉界面「现在到底是不是开着」，
   * 界面不能自作聪明用本地变量记着（主人可能从另一台设备关掉）。
   */
  if (req.method === 'GET' && url.pathname === '/api/admin-mode') {
    const sid = String(url.searchParams.get('sessionId') || '');
    try {
      return json(res, 200, { ok: true, sessionId: sid, on: adminOn(sid) });
    } catch (e) {
      // 读盘失败 = 关（fail-closed，见 admin-mode.mjs 文件头）
      return json(res, 200, { ok: true, sessionId: sid, on: false, note: String(e?.message ?? e) });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/admin-mode') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const sid = String(payload?.sessionId || '').trim();
    if (!sid) return json(res, 400, { error: '得先有会话' });
    try {
      const r = setAdminOn(sid, payload?.on === true);
      if (!r.ok) return json(res, 500, { error: '存不上，磁盘那边出问题了' });
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 【办事模式】—— 顶栏那颗珊瑚橙按钮的读写口。
   *
   * 2026-11-01 主人：「删除专业模式，回滚办事模式，然后让【专业模式】按钮变成
   * 【办事模式】按钮」。所以这条接口变回**真正的开关**（中间有一段时间它被并进
   * /api/pure，只剩读花名册的用途），而 /api/pure 整条删掉了。
   *
   * GET  ?sessionId=xxx      读这个会话的状态（available/on/workers 一次回全，界面只问一次）
   * POST { sessionId, on }   翻这一格；关掉顺手把这个会话的 worker 名册清空
   *                          （主人要的是「用完就没」）
   *
   * 【功能页里关掉时】available:false，界面据此把整颗按钮拿掉 —— 不是灰着让你点。
   */

  if (req.method === 'GET' && url.pathname === '/api/task-mode') {
    const sid = String(url.searchParams.get('sessionId') || '');
    try {
      return json(res, 200, { ok: true, ...taskInfo(sid) });
    } catch (e) {
      // 读盘失败 = 关（fail-closed，跟 task-mode.mjs 文件头一个口径）
      return json(res, 200, {
        ok: true,
        sessionId: sid,
        available: false,
        on: false,
        workers: [],
        note: String(e?.message ?? e),
      });
    }
  }
  if (req.method === 'POST' && url.pathname === '/api/task-mode') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const sid = String(payload?.sessionId || '').trim();
    if (!sid) return json(res, 400, { error: '得先有会话' });
    if (!taskFeatureOn()) {
      return json(res, 403, { ok: false, error: '这个功能在【功能】里是关的，先在【功能】里打开' });
    }
    try {
      const r = setTaskOn(sid, payload?.on === true);
      /* 【2026-11-01 主人：办事模式启用的那一瞬间，把主智能体挪到排序第一】
         主智能体 = 屋里排序第一个「已启用」的卡。主人可能把她排在第二、第一个位置空着；
         这时候就把她挪到第一位，让「谁排第一谁说了算」和「办事模式谁是主」永远同一张卡。 */
      if (r.ok && payload?.on === true) {
        try {
          const __on = (id) => { try { return isGroupMemberEnabled(id, sid); } catch { return true; } };
          const __list = groupAgentIds(sid).map((x) => String(x));
          const __main = __list.find((id) => __on(id));
          if (__main && __list[0] !== __main) {
            const __next = [__main, ...__list.filter((x) => x !== __main)];
            try { setSessionGroupOrder(sid, __next); } catch {}
          }
        } catch { /* 挪不动不影响开关本身 */ }
      }
      if (!r.ok) return json(res, 500, { error: '存不上，磁盘那边出问题了' });
      return json(res, 200, { ok: true, ...r, ...taskInfo(sid) });
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
      /**
       * 【用她开的会话，她得在屋里坐着】—— 2026-11-01 主人报
       *
       * 主人原话：「自动新建会话后，为什么左侧【屋里的人】没有小白曦？」
       *
       * 真因：新会话的「屋里的人」名单从没设置过，cleanGroup 只保底补上
       * 小鱼和小鲸两个人，绑定的那张卡不会自己进去。
       * 结果就是：她替这个会话说着话（开场白也是她的），
       * 可左栏名单里根本没她，主人想给她开关、调顺序都无从下手。
       *
       * 所以绑卡的同时把她排进名单。放最后一位：小鱼、小鲸依旧是默认的前两位，
       * 她是这一摊的「另一个人」，不抢默认位置。
       */
      try {
        /* 【2026-11-02 主人：新建会话选自建卡，屋里不该硬塞小鱼】
           以前是先读 groupAgentIds() 再 push 她进去。可新会话从没存过名单时，
           那个函数按老规矩吐 [xiaoyu,xiaojing] —— 于是小鱼被悄悄带进了名单。
           新会话本来就是个空壳，直接拿她当名单起点就行，不读默认值。 */
        /* 新会话的名单一定是空的，直接拿她当起点。
           小鲸那条老规矩（名单里总有她）由 setSessionGroup 自己按默认补。 */
        setSessionGroup(session.id, [String(agentId)]);
      } catch (e) {
        console.warn('[agents] 把她排进屋里没成：', String(e?.message ?? e));
      }
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
   * ─────────────── 【QQ小鱼】（2026-11-01 主人要的）───────────────
   *
   * 主人原话：「选择哪个会话或创建新的会话连接 QQ」「通常是通过 QQ 号识别主人」。
   *
   * 这一段的接口只管「配置 + 认人 + 开关」，真收消息在 src/qq-bridge.mjs，
   * 真跑一轮在 src/qq-server.mjs。三条分工写在 qq-server.mjs 的文件头。
   *
   * 安全上的三条硬规矩（别为了省事放宽）：
   *   1. AppSecret 只进不出 —— 任何接口都不把它吐回界面，只说「有没有、尾巴四位」。
   *   2. 谁是主人靠**主人自己在 QQ 里发一次口令**认领，不靠「谁先发谁算」。
   *   3. 没配置 / 文件读坏 → 一律当没接（fail-closed），绝不默认放人进来。
   */
  if (req.method === 'GET' && url.pathname === '/api/qq/status') {
    try {
      const { qqStatus, sdkAvailable } = await import('./qq-bridge.mjs');
      const { claimState } = await import('./qq.mjs');
      const claim = claimState();
      const st = qqStatus();
      return json(res, 200, {
        ok: true,
        ...st,
        // `running` 是 qqStatus() 里没有的一格（它给的是 phase）——
        // 界面要问「能不能点断开」时只看这一个布尔，所以在这儿补上。
        running: Boolean(st.phase === 'online' || st.phase === 'starting'),
        sdk: await sdkAvailable(),
        claim: claim ? { alive: !claim.expired, ttlMs: CLAIM_TTL_PUB } : null,
        // 「自己注册的号」那条道的状态：面板要能同时看到两条道
        onebot: await (async () => {
          try {
            const ob = await import('./qq-onebot.mjs');
            return ob.oneBotStatus();
          } catch (e) {
            return { phase: 'error', error: String(e?.message ?? e), conf: null };
          }
        })(),
      });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qq/bot') {
    const payload = await body(req).catch(() => ({}));
    try {
      const { setQqBot, qqBotPublic } = await import('./qq.mjs');
      const bot = setQqBot({
        appId: payload.appId,
        appSecret: payload.appSecret,
        enabled: payload.enabled,
        autoStart: payload.autoStart,
        sandbox: payload.sandbox,
        useGateway: payload.useGateway,
      });
      return json(res, 200, { ok: true, bot: qqBotPublic() });
    } catch (e) {
      return json(res, 400, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qq/bind') {
    const payload = await body(req).catch(() => ({}));
    try {
      const { setQqBind, qqBind } = await import('./qq.mjs');
      const bind = setQqBind({ sessionId: payload.sessionId, mode: payload.mode });
      return json(res, 200, { ok: true, bind: qqBind() });
    } catch (e) {
      return json(res, e?.status || 400, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qq/start') {
    try {
      const { startQq } = await import('./qq-bridge.mjs');
      const st = await startQq({
        ensureSession: ensureQqSession,
        renameGroupSession,
        runChat: runQqTurn,
        setSpeakerOwner: markQqOwner,
        onLog: () => {},
      });
      return json(res, 200, { ok: st.phase !== 'error', ...st });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qq/stop') {
    try {
      const { stopQq } = await import('./qq-bridge.mjs');
      return json(res, 200, { ok: true, ...(await stopQq()) });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 「自己注册的号」（OneBot v11）。
   *
   * GET  看配置 + 连接状态
   * POST 存配置（enabled / mode / url / token / ownerQq）
   * POST /start 拨号或起反向监听
   * POST /stop  停
   *
   * 为什么不并进 /api/qq/bot：那组是官方机器人（AppID+AppSecret），这套是
   * 挂协议端（NapCat）的号，两条道同时在也是合理的（一个办事一个玩）。
   */
  if (req.method === 'GET' && url.pathname === '/api/qq/onebot') {
    try {
      const ob = await import('./qq-onebot.mjs');
      return json(res, 200, { ok: true, conf: ob.publicConf(), status: ob.oneBotStatus() });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qq/onebot') {
    const payload = await body(req).catch(() => ({}));
    try {
      const ob = await import('./qq-onebot.mjs');
      const conf = ob.setOneBotConf({
        enabled: payload.enabled,
        mode: payload.mode,
        url: payload.url,
        token: payload.token,
        ownerQq: payload.ownerQq,
        autoStart: payload.autoStart,
      });
      return json(res, 200, { ok: true, conf });
    } catch (e) {
      return json(res, e?.status || 400, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qq/onebot/start') {
    try {
      const { startQqOneBot } = await import('./qq-bridge.mjs');
      const st = await startQqOneBot({
        ensureSession: ensureQqSession,
        renameGroupSession,
        runChat: runQqTurn,
        setSpeakerOwner: markQqOwner,
        onLog: () => {},
      });
      return json(res, 200, { ok: st.phase !== 'error', ...st });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qq/onebot/stop') {
    try {
      const { stopQq } = await import('./qq-bridge.mjs');
      return json(res, 200, { ok: true, ...(await stopQq()) });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 协议端（NapCat）的一键化。
   * 提不提权？**不提**。协议端和主人的 QQ 同级跑就行，
   * 弹 UAC 让主人点「是」是 NapCat 自带启动器的毛病，不是必须的。
   */
  if (url.pathname === '/api/qq/onebot/protocol' && req.method === 'GET') {
    try {
      const p = await import('../scripts/qq-protocol.mjs');
      const st = await p.status();
      return json(res, 200, { ok: true, ...st });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (url.pathname === '/api/qq/onebot/protocol/deploy' && req.method === 'POST') {
    try {
      const p = await import('../scripts/qq-protocol.mjs');
      const r = await p.deploy();
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (url.pathname === '/api/qq/onebot/protocol/start' && req.method === 'POST') {
    try {
      const p = await import('../scripts/qq-protocol.mjs');
      const r = p.start();
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (url.pathname === '/api/qq/onebot/protocol/kill' && req.method === 'POST') {
    try {
      const p = await import('../scripts/qq-protocol.mjs');
      return json(res, 200, { ok: true, ...p.kill() });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 登录二维码：面板上直接看、直接扫。
   *
   * 图从协议端自己的 cache/qrcode.png 读（WebUI 那套接口要 HMAC 凭证，外部签不出来），
   * 状态靠 3001 通不通 + 图新不新来判。?inline=0 就只回时间戳不塞 base64，
   * 免得面板每两秒轮询一次、每次都拖一张几十 KB 的图。
   */
  if (url.pathname === '/api/qq/onebot/qrcode' && req.method === 'GET') {
    try {
      const q = await import('./qq-qrcode.mjs');
      const ob = await import('./qq-onebot.mjs');
      const inline = new URL(req.url || '/', 'http://x').searchParams.get('inline') !== '0';
      let protocol = { installed: false, running: false };
      try {
        protocol = await ob.protocolState();
      } catch {}
      const st = ob.oneBotStatus();
      const online = st?.phase === 'online';
      const qr = await q.loginQrcode();
      const out = {
        ok: true,
        online,
        phase: st?.phase || '',
        protocol,
        hint: q.qrcodeHint({ protocol, qr, online }),
        staleMs: q.QR_STALE_MS,
        qr: {
          ok: qr.ok,
          reason: qr.reason || '',
          mtime: qr.mtime || 0,
          ageMs: qr.ageMs ?? null,
          width: qr.width || 0,
          height: qr.height || 0,
          size: qr.size || 0,
        },
      };
      if (inline && qr.ok) out.qr.base64 = qr.base64;
      return json(res, 200, out);
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (url.pathname === '/api/qq/onebot/protocol/qr-refresh' && req.method === 'POST') {
    try {
      const p = await import('../scripts/qq-protocol.mjs');
      p.kill();
      await new Promise((r) => setTimeout(r, 800));
      const started = p.start();
      return json(res, 200, { ok: true, ...started });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/qq/peers') {
    try {
      const { qqPeerList } = await import('./qq-bridge.mjs');
      return json(res, 200, { ok: true, peers: qqPeerList() });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  /** 白名单：主人 QQ 号 / 谁能私聊 / 哪个群能说话（2026-11-03 主人要的）。 */
  if (req.method === 'GET' && url.pathname === '/api/qq/gate') {
    try {
      const { qqGate } = await import('./qq.mjs');
      return json(res, 200, { ok: true, gate: qqGate() });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/qq/gate') {
    const payload = await body(req).catch(() => ({}));
    try {
      const { setQqGate } = await import('./qq.mjs');
      const gate = setQqGate({
        ownerQq: payload.ownerQq,
        allowQq: payload.allowQq,
        allowGroup: payload.allowGroup,
        strict: payload.strict,
      });
      return json(res, 200, { ok: true, gate });
    } catch (e) {
      return json(res, e?.status || 400, { error: String(e?.message ?? e) });
    }
  }

  /** 认人表的两件事：删一个人 / 指定谁是主人。 */
  if (req.method === 'POST' && url.pathname === '/api/qq/peer') {
    const payload = await body(req).catch(() => ({}));
    try {
      const { forgetQqPeer, noteQqPeer, qqPeer } = await import('./qq.mjs');
      const openid = String(payload.openid || '').trim();
      if (!openid) return json(res, 400, { error: '得说清是哪个人（openid）' });
      if (payload.remove === true) {
        forgetQqPeer(openid);
        return json(res, 200, { ok: true, removed: true });
      }
      if (payload.role !== undefined) {
        // 2026-11-03：认主改由「面板上主人手填的 QQ 号」决定，这里不再能指定主人。
        // 留着 role 只为了兼容老调用（把人标成客人）。
        if (payload.role === 'owner') {
          return json(res, 400, { error: '现在认主只看「你自己的 QQ 号」那一格：把号填对就行，不用在这里指定' });
        }
        noteQqPeer(openid, { role: 'guest', counted: false });
      }
      if (payload.name !== undefined) noteQqPeer(openid, { name: payload.name, counted: false });
      return json(res, 200, { ok: true, peer: qqPeer(openid) });
    } catch (e) {
      return json(res, 400, { error: String(e?.message ?? e) });
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
      // members 是给左边那竖列「屋里的人」按钮用的（带 id / kind / 安静 / 开没开 / 颜色）
      const onMap = groupEnabledMap(qsid);
      /**
       * 【2026-11-02 主人：「把界面顶部的【小鱼】与【小鲸】按钮删了，现在统一由左侧的按钮决定启用」】
       *
       * 以前小鱼、小鲸的在场是顶栏两颗按钮说了算（fish-presence / whale-presence），
       * 左边「屋里的人」那两颗牌对她们是常亮的、点不灭。现在顶栏那两颗删了，
       * 开关只剩一处 —— 就是左边这颗牌。
       *
       * 这里做的是**把两套状态并成一套**：牌子读的是 groupEnabledBySession，
       * 而小鱼/小鲸真正被拦在门外看的是 fish-presence / whale-presence。
       * 不并的话，牌子上显示「开着」她却不说话（或者反过来），主人又要以为程序坏了。
       */
      const switchOf = (id) => {
        if (id === AGENT_XIAOYU) { try { return fishOn(qsid); } catch { return true; } }
        if (id === AGENT_XIAOJING) { try { return whaleOn(qsid); } catch { return true; } }
        return null;
      };
      const members = ids.map((id) => {
        const a = getAgent(id);
        if (!a) return null;
        const sw = switchOf(id);
        return {
          id,
          name: String(a.name || ''),
          kind: String(a.kind || ''),
          /* 2026-11-10 艾特删除：quiet 不再有任何行为含义（pickSpeakers 不读它了），
             这里恒报 false —— 免得新前端照旧画一个「叫她才应」的小点，
             让主人以为那个人要喊才说话。字段留着不删，老客户端读它也不会崩。 */
          quiet: false,
          // 「屋里的人」那颗牌子开没开：关掉的人这一轮一句话都不说（点名也不应）
          // 小鱼/小鲸只认她们自己那套状态（上面 switchOf），别的卡认牌子表
          enabled: (sw === null) ? (onMap[id] !== false) : sw,
          color: (() => { try { return agentColor(id); } catch { return ''; } })(),
        };
      }).filter(Boolean);
      return json(res, 200, {
        ok: true,
        sessionId: qsid,
        agentIds: ids,
        max: MAX_GROUP,
        members,
        names: members.map((m) => m.name),
        /* 2026-11-10 艾特删除：恒空。老前端读这个数组画「叫才应」的小点，
             报非空就会画出不存在的状态。 */
        quietIds: [],
        // 谁被关掉了
        offIds: members.filter((m) => m.enabled === false).map((m) => m.id),
      });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 【屋里的人：换个顺序 / 开或关一张牌】
   *
   * 主人原话（2026-11-01）：「名字可长按上下拖动，比如我把【小鲸】拖动到小鱼上面，
   * 那么此时小鲸的方块变成原来第一个的小鱼的方框的那种实线，小鱼的方框变成小鲸的
   * 那种虚线，说话顺序按从上到下顺序来，且仅对于小鱼与小鲸来说，屏幕上方的【小鱼】
   * 与【小鲸】按钮只有启用时她们才说话，禁用时不说话。」
   */
  if (req.method === 'POST' && url.pathname === '/api/agents/group/order') {
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { error: '请求体不是 JSON' }); }
    try {
      const sid = String(payload?.sessionId || '').trim();
            /* 【2026-11-01 主人：办事模式开着的时候，别把「未启用」的卡拖到第一位】
         主智能体 = 排序第一个已启用的。要是允许把一张关着的卡拖到第一，
         「排序第一」和「在干活的那张」就会分家，牌子、开场白、干活身份全乱。
         所以这里挡住：想放第一的那张要是没启用，就弹回原位（返回 refused）。 */
      let __orderIds = Array.isArray(payload?.agentIds) ? payload.agentIds.map((x) => String(x)) : [];
      try {
        if (taskOn(sid) && __orderIds.length) {
          const __head = __orderIds[0];
          let __headOn = true;
          try { __headOn = isGroupMemberEnabled(__head, sid); } catch { __headOn = true; }
          if (!__headOn) {
            const __now = groupAgentIds(sid).map((x) => String(x));
            return json(res, 200, { ok: true, refused: true, agentIds: __now, why: '没启用的卡不能排在第一位' });
          }
        }
      } catch { /* 查不动就放行，别把排序整个卡死 */ }
      const r = setSessionGroupOrder(sid, payload?.agentIds);
      if (!r) return json(res, 500, { error: '没存下来' });
      return json(res, 200, { ok: true, ...r });
    } catch (e) {
      return json(res, Number(e?.status) || 500, { error: String(e?.message ?? e) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/group/toggle') {
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { error: '请求体不是 JSON' }); }
    try {
      const sid = String(payload?.sessionId || '').trim();
      const id = String(payload?.id || '').trim();
      const on = payload?.enabled !== false;
      /**
       * 【2026-11-02：小鱼、小鲸也走这颗牌】
       *
       * 顶栏那两颗按钮删了之后，左边这颗牌就是唯一开关。
       * 她们俩以前被特意做成「牌子点不灭」，现在反过来 —— 点牌就真的关掉/打开，
       * 而且必须同时改她们自己的那套状态（fish-presence / whale-presence），
       * 因为拦住她们的代码读的是那一套，不是牌子表。
       */
      let sw = null;
      if (id === AGENT_XIAOYU) sw = setFishOn(sid, on);
      else if (id === AGENT_XIAOJING) sw = setWhaleOn(sid, on);
      // 牌子表也照写一份：这样「屋子里有谁」这类读牌子的地方不会跟她俩的状态打架
      const r = setGroupMemberEnabled(id, sid, on);
      if (!r) return json(res, 500, { error: '没存下来' });
      return json(res, 200, { ok: true, ...r, enabled: (sw === null ? r.enabled : sw) });
    } catch (e) {
      return json(res, Number(e?.status) || 500, { error: String(e?.message ?? e) });
    }
  }

  /**
   * 【已停用 · 2026-11-10】安静开关：某张卡改成「只在叫名字时才说话」。
   *
   * 主人当天删掉艾特功能，界面上那个勾选框已撤、`pickSpeakers` 也不读 quiet
   * —— 这个接口现在**设了没有任何效果**。
   *
   * 接口本身留着（不删路由）：老客户端 / 老脚本还在打它，直接 404 会让它们
   * 弹一堆「没存上」的错。改成「照收，但明说已经不起作用」，比假装成功诚实。
   */
  if (req.method === 'POST' && url.pathname === '/api/agents/quiet') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    /* 仍把值写下去（老会话文件里本来就有这个字段，写空也无害），
       但响应里带上说明 —— 前端若还在用，会看见 retired 而不是假装成功。 */
    try {
      setAgentQuiet(String(payload?.id || ''), payload?.quiet !== false);
    } catch (e) {
      /* 找不到那张卡之类：本来就没用了，不因为写不进去而报错 */
      void e;
    }
    return json(res, 200, {
      ok: true,
      id: String(payload?.id || ''),
      quiet: payload?.quiet !== false,
      retired: true,
      note: '艾特功能已删除，「叫她才应」不再生效；现在只说左侧开关决定说不说。',
    });
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

  /* 颜色接口·2026-10-29 每张卡的颜色（屋里的人那一竖列要用） */
  if (req.method === 'GET' && url.pathname === '/api/agents/colors') {
    try {
      return json(res, 200, { ok: true, colors: agentColorMap() });
    } catch (e) {
      return json(res, 500, { error: String(e?.message ?? e) });
    }
  }

  /* 颜色接口·2026-10-29 改一张卡的颜色 */
  if (req.method === 'POST' && url.pathname === '/api/agents/color') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const r = setAgentColor(String(payload?.id || ''), payload?.color);
      if (!r.ok) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, color: r.color, colors: agentColorMap() });
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
      /* 【2026-11-03 主人要的】新建时能一起填开场白。
       * addAgent 只管名字/描述/人设，开场白是 opening.mjs 那边按 agentId 存的，
       * 所以要单独写一次。写失败不该让整个「新建」失败 —— 名字和人设已经建好了，
       * 开场白留给主人以后在卡片里补。 */
      try {
        const __op = String(payload?.opening ?? '').trim();
        if (__op) setCardOpening(agent.id, __op);
      } catch { /* 开场白没写进去不影响智能体本身 */ }
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

  /**
   * 角色卡：导入 / 导出（2026-11-01 主人要的「以角色卡形式」）。
   *
   * 两个都只经过 agents.mjs，一个字都不碰会话。导出走 POST 是因为界面要顺手拿到
   * 文件名（卡名里有中文和空格，不能塞进 URL），拿到再自己触发下载。
   */
  if (req.method === 'POST' && url.pathname === '/api/agents/card/export') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const id = String(payload?.id || '');
    const card = id ? exportCard(id) : null;
    if (!card) return json(res, 404, { error: '没有这个智能体' });
    return json(res, 200, { ok: true, fileName: cardFileName(card.name), card });
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/card/import') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: '这个文件读不成 JSON（可能不是角色卡）' });
    }
    // 接口收 {card: <对象或文本>}，也认直接给整个 body 就是一张卡
    const rawCard = (payload && payload.card !== undefined) ? payload.card : payload;
    try {
      const r = importCard(rawCard);
      if (!r.ok) return json(res, 400, { error: r.error });
      return json(res, 200, { ok: true, agent: r.agent, renamed: r.renamed, agents: listAgents() });
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
      // 记账换币要用的汇率：价目表本身存的是「元 / 百万 token」，用美元看就按它折。
      // 不联网抓（汇率天天动，抓一次还得为它加一整套失败分支），给个主人自己改的数最实在。
      fx: { usdPerCny: Number(process.env.XY_USD_PER_CNY || 0.14) },
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

  /**
   * 把「现在输入框里这几条」定成新的默认底线。
   *
   * 两个来源都认：body 里带了 bottomLines 就用它；没带（老界面的写法）
   * 就拿「现在正在生效的」那一份 —— 这条路由本来就叫「把当前这版设为默认」，
   * 让调用方必须把内容再抄一遍纯属自找不同步。
   */
  if (req.method === 'POST' && url.pathname === '/api/settings/default-bottomlines') {
    let payload;
    try {
      payload = await body(req);
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    try {
      const lines = Array.isArray(payload?.bottomLines) ? payload.bottomLines : currentBottomLines();
      const out = setDefaultBottomLines(lines);
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
  /* 【2026-11-05 加·粘贴图片】
   *
   * 以前只能从「+」菜单选、或者把文件拖进窗口，截图之后 Ctrl+V 什么都不会发生。
   * 剪贴板里的图没有磁盘路径，而发消息那条链路（/api/chat）只认 { path, name, kind }，
   * 所以必须先在服务端落一份盘，前端才拿得到能发的东西。
   *
   * 落盘位置：工作区下的 attachments/（不是 .state，那是程序自己的地盘，
   * 而且 sendCheck 会拦机密路径）。
   */
  if (req.method === 'POST' && url.pathname === '/api/attach/upload') {
    try {
      const payload = await body(req);
      const dataUrl = String(payload?.dataUrl || '');
      const m = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl);
      if (!m) return json(res, 400, { error: '要 dataUrl（data:image/png;base64,... 这种）' });
      const mime = String(m[1] || 'application/octet-stream').toLowerCase();
      // 只收图片：粘贴这条路的用途就是「截图直接问」，别的类型走选文件更清楚
      if (!mime.startsWith('image/')) return json(res, 400, { error: '只支持粘贴图片' });
      const buf = Buffer.from(String(m[3] || ''), 'base64');
      if (!buf.length) return json(res, 400, { error: '内容是空的' });
      if (buf.length > 32 * 1024 * 1024) return json(res, 413, { error: '太大了（上限 32MB）' });
      const ext = mime.includes('png') ? 'png'
        : mime.includes('jpeg') ? 'jpg'
          : mime.includes('gif') ? 'gif'
            : mime.includes('webp') ? 'webp'
              : mime.includes('bmp') ? 'bmp'
                : 'png';
      const dir = join(config.workspace || config.dataDir, 'attachments');
      __mkPaste(dir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const name = 'paste-' + ts + '-' + Math.random().toString(36).slice(2, 7) + '.' + ext;
      const abs = join(dir, name);
      __rotWrite(abs, buf);
      return json(res, 200, { path: abs, name, size: buf.length, kind: 'image' });
    } catch (err) {
      return json(res, 500, { error: String(err?.message ?? err) });
    }
  }

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
      /* 【2026-11-09 改】perModel 的键现在优先是「地址/模型名」的稳定键，
       * 直接拿 epNow.id 去查会漏。统一走 levelFor（它内部两个键都认）。 */
      defaultLevelName: LEVELS.find((l) => l.id === levelFor(epNow))?.name || '默认',
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


  // who参数·2026-10-30 —— 这条请求是哪位智能体的人设库？不传就是小鱼。
  const scopeOf = (u) => {
    const w = String(u.searchParams.get('who') || '').trim();
    if (!w || w === 'xiaoyu' || w === 'fish') return '';
    return /^[A-Za-z0-9_-]{1,64}$/.test(w) ? w : '';
  };
  /** 【2026-11-01】sid = 想看「哪个会话」的人设；不传就是全局那套（老行为）。 */
  const sidOf = (u) => {
    const s = String(u.searchParams.get('sid') || '').trim();
    return /^[A-Za-z0-9_-]{1,64}$/.test(s) ? s : '';
  };
  if (req.method === 'GET' && url.pathname === '/api/personas') {
    try {
      return json(res, 200, withPersonaScope(scopeOf(url), () => personaInfo(sidOf(url))));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/new') {
    try {
      const payload = await body(req);
      return json(res, 200, withPersonaScope(scopeOf(url), () => createPersona({
        name: payload?.name,
        text: payload?.text,
        copyCurrent: payload?.copyCurrent !== false,
      })));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/switch') {
    try {
      const payload = await body(req);
      // 带 sessionId → 只切这个会话（主人 2026-11-01 的要求）；不带才是改全局那套
      const _psid = String(payload?.sessionId || sidOf(url) || '').trim();
      return json(res, 200, withPersonaScope(scopeOf(url), () => switchPersona(payload?.id, _psid)));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/save') {
    try {
      const payload = await body(req);
      return json(res, 200, withPersonaScope(scopeOf(url), () => savePersonaText(payload?.id, payload?.text ?? '')));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/rename') {
    try {
      const payload = await body(req);
      return json(res, 200, await withPersonaScope(scopeOf(url), () => renamePersona(payload?.id, payload?.name)));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/delete') {
    try {
      const payload = await body(req);
      return json(res, 200, withPersonaScope(scopeOf(url), () => deletePersona(payload?.id)));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 把当前这套人设存成默认（以后「恢复成默认内容」就回到这套）
  if (req.method === 'POST' && url.pathname === '/api/personas/set-default') {
    try {
      const payload = await body(req);
      return json(res, 200, withPersonaScope(scopeOf(url), () => setPersonaAsDefault(payload?.id)));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/personas/reset') {
    try {
      const payload = await body(req);
      return json(res, 200, withPersonaScope(scopeOf(url), () => resetPersona(payload?.id)));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 把「现在这套人设」定成默认（以后「恢复成默认内容」回到它）
  if (req.method === 'POST' && url.pathname === '/api/personas/as-default') {
    try {
      const payload = await body(req);
      return json(res, 200, withPersonaScope(scopeOf(url), () => setPersonaAsBuiltinDefault(payload?.id)));
    } catch (err) {
      return json(res, err?.status ?? 500, { error: String(err?.message ?? err) });
    }
  }

  // 人设设默认·2026-10-29 把智能体界面里「当前的人设」设成默认。id=xiaojing 走小鲸，别的走小鱼。
  if (req.method === 'POST' && url.pathname === '/api/agents/persona/as-default') {
    let payload;
    try { payload = await body(req); } catch { return json(res, 400, { error: 'invalid JSON body' }); }
    try {
      const id = String(payload?.id || '');
      if (id === 'xiaojing' || id === 'whale') {
        const r = setWhalePersonaAsDefault(payload.persona);
        return json(res, 200, { ok: true, id: 'xiaojing', chars: r.chars, personalDefaultPersona: r.defaultPersona, agents: listAgents() });
      }
      const r = setPersonaAsBuiltinDefault(id || 'xiaoyu');
      return json(res, 200, { ok: true, id: id || 'xiaoyu', ...(r || {}), agents: listAgents() });
    } catch (e) {
      return json(res, e?.status ?? 500, { error: String(e?.message ?? e) });
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
    /* 【2026-11-10 D1·增量协议】先算便宜指纹（readdir+stat，不读会话内容）。
     *  指纹没变：绝不重算 sessions 数组 —— 带了 rev 且相等就回轻量 304 语义响应；
     *  没带 rev（老前端 / 首拉）回缓存的上一份完整 payload。
     *  指纹变了：照常全量计算并刷新缓存。 */
    const fp = sessionsFingerprint();
    const clientRev = String(url.searchParams.get('rev') || '');
    if (__sessionsCache.fp === fp && __sessionsCache.payload) {
      if (clientRev && clientRev === fp) {
        return json(res, 200, {
          rev: fp,
          unchanged: true,
          lastSessionId: __sessionsCache.payload.lastSessionId,
        });
      }
      return json(res, 200, { ...__sessionsCache.payload, unchanged: false });
    }
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
      /**
       * 【2026-11-07 改·主人要的是「现在谁在说话」，不是「绑了哪张卡」】
       *
       * 原来这里是 `boundMap[s.id]` —— 那是**手动绑的卡**，绑一次就不动了。
       * 主人原话：「我一开始要求的是，会话里【屋里的人】里排最上面的启用智能体
       * 是哪个就用哪个标志，是动态变化的」。
       *
       * 所以改成按顺序算出来的主智能体（mainAgentId：屋里排最上面、且开着的那个）。
       * 判据用 mateSwitchOn —— 它已经处理了小鱼/小鲸的 presence（不在牌子表里）。
       * 绑卡信息不丢，另给一个 boundAgentId 字段备用。
       */
      let agentId = '';
      try {
        agentId = String(mainAgentId(s.id, (id) => mateSwitchOn(id, s.id)) || '');
      } catch { agentId = ''; }
      return {
        ...s,
        agentId,
        agentName: agentId ? (nameOf.get(String(agentId)) || '') : '',
        boundAgentId: String(boundMap[s.id] || ''),
        crew: groupOf(s.id),
      };
    });
    const last = getLastSessionId();
    const fallback = list.length ? list[0].id : null;
    const payload = {
      rev: fp,
      unchanged: false,
      sessions: list,
      lastSessionId: last && list.some((s) => s.id === last) ? last : fallback,
    };
    __sessionsCache = { fp, payload };
    return json(res, 200, payload);
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
    const session = makeSession(payload, { opening: false });
    /**
     * 2026-10-31 主人：「新建会话时选择智能体」。
     *
     * 选出来的人就是这间屋子的在场名单 —— 小鱼和小鲸默认就在（不能取消），
     * 其余的由主人勾。名单存好之后，左上角那竖列按钮和群聊都照它来。
     * 名单有问题也不许把会话弄没了：会话已经建好，名单顶多退回默认。
     */
    /**
     * 【2026-11-01 主人】「新建会话的时候，默认都不选，而不是默认选了小鱼又选了小鲸」
     *
     * 所以这里的 agentIds 是「主人真勾了谁」的完整清单，**包括小鱼和小鲸**：
     *   · 勾了小鱼 → 她在这个会话里说话；没勾 → 这屋子她不出声（fishOn=false）
     *   · 勾了小鲸 → 她在名单里；没勾 → 名单里就是不写她（keepWhale:false）
     * 一张都没勾 = 屋里没人说话，主人自己再往屋里叫人就是。
     */
    let group = [];
    try {
      const picked = Array.isArray(payload?.agentIds) ? payload.agentIds.map((x) => String(x || '')) : null;
      if (picked) {
        const wantFish = picked.includes('xiaoyu');
        const wantWhale = picked.includes('xiaojing');
        try { setFishOn(session.id, wantFish); } catch {}
        try { setWhaleOn(session.id, wantWhale); } catch {}
        /* 【2026-11-02 修·新会话屋里的人看不见小鱼】
         * 这里原来把 xiaoyu 从名单里过滤掉，想靠 cleanGroup 的「没写她就补回来」兜底。
         * 可那条兜底只在「从来没存过名单」时才生效（!Array.isArray(ids)）；
         * 这里传进去的是过滤后的真数组 → 兜底被跳过 → 名单里永远没有小鱼，
         * 左侧「屋里的人」就一条鱼都画不出来。
         * 现在小鱼照样进名单；她在不在场由 setFishOn 管，小鲸仍按 keepWhale:false 处理。 */
        /* 【2026-11-02 修·勾了小鲸左栏却看不见她】
         * 上面的注释写着「勾了小鲸 → 她在名单里」，可代码把小鲸也过滤掉了。
         * 于是只勾小鲸建会话时，名单被存成空数组 → 左栏一条牌子都没有。
         * 现在什么都不过滤：勾了谁就写谁。小鲸在不在场另有 setWhaleOn 管，
         * 小鱼在不在场另有 setFishOn 管，名单只负责「谁在这屋里」。 */
        const roster = picked.slice();
        group = (setSessionGroup(session.id, roster, { keepWhale: false })?.agentIds || []);
        /* 【2026-11-01 主人：小鱼、小鲸、自建智能体地位完全平行】
           以前这里只设了名单和开关，从来没设「谁是这屋的主声」——
           于是 cardIdOf 永远退回小鱼，主人明明勾了小白曦，开场白却还是小鱼说。
           现在：主人勾的人里只要有一张自建卡，就让她当这屋的主声（开场白、提示词都跟着她走）。
           一张自建卡都没勾（只勾了小鱼/小鲸）→ 不动绑定，仍按原来的规矩走。 */
        try {
          const __cards = picked.filter((x) => x && x !== 'xiaoyu' && x !== 'xiaojing');
          if (__cards.length) setSessionAgent(session.id, __cards[0]);
        } catch {}
      } else {
        group = groupAgentIds(session.id);
      }
    } catch (err) {
      console.warn('[session/new] 名单没设上：', String(err?.message ?? err));
      try { group = groupAgentIds(session.id); } catch { group = []; }
    }
    /* 【2026-11-01 主人：三者地位完全平行】
       开场必须在「谁是主声」定下来之后再跑 —— 否则 cardIdOf 拿到的还是空绑定，
       一律退回小鱼，主人明明勾了小白曦，开场白却成了小鱼说的。
       所以 makeSession 那边改成 opening:false（不自动开场），走完名单+主声再在这里补。 */
    try {
      if (payload?.opening !== false) await startOpening(session.id);
    } catch (err) {
      console.warn('[session/new] 开场没跑成：', String(err?.message ?? err));
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
    /* 【2026-11-03 严检补的】/edit 有「正在生成就不许改」的保护，撤销却没有 ——
     * 跑着的时候点撤销，会把正文改回来再 saveSession 写盘，跟正在吐的那一轮打架，
     * 最后落盘的可能是半截。撤销本质上也是改正文，保护要一样。 */
    if (runningTurns.get(id)) {
      return json(res, 409, { error: '这一轮正在生成，等它说完再撤销（不然会写乱）' });
    }
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
      // 空草稿（一个字没说、也没调过工具）读出来是 null —— 顺手把文件删掉。
      // 不删的话这种文件会一直躺在 .state/drafts 里，看目录的人会以为「有草稿没回灌」。
      if (!draft) { try { dropDraft(id); } catch { /* 删不掉不影响这一轮 */ } }
      // 干工具活的时候往往一个字正经话都没说，只有工具记录 —— 以前读到「没文字」就当没草稿，
      // 于是那一整轮（她说了「我这就去改」然后调了七八个工具）在历史里彻底蒸发。
      // 现在只要草稿里有文字**或者**有工具记录，都接回来。
      if (draft) {
        const last = session.messages[session.messages.length - 1];
        // 只有「最后一句话是主人说的」才补：说明确实缺了这条回复。
        // 否则草稿多半是以前遗留的脏数据，补进去反而多一条。
        /**
         * 【什么时候才该把草稿回灌】—— 2026-10-31 改宽
         *
         * 原来只认「最后一条是主人说的」。可主人反馈的真实场景是这样：
         * 她说「我去查查」然后连着调工具，重启那一下最后一条是 tool；
         * 或者刚说「我这就改」还没调工具，最后一条是空壳 assistant。
         * 这两种都不满足「最后一条是 user」，于是草稿被 dropDraft 直接删掉 ——
         * 主人那边看到的就是「重启前最后一轮她的话消失了」。
         *
         * 现在只在「这一轮明明已经正常收尾」时才不补：
         * 最后一条是 assistant、有文字、且没待办工具 → 真的说完了，草稿是残留，删掉。
         * 其它情况（最后是 tool / user / 空壳 assistant）都算断在半路，把话接回来。
         */
        const tailIs = last ? last.role : '';
        const tailHasTools = !!(last && Array.isArray(last.tool_calls) && last.tool_calls.length);
        const tailHasText = !!(last && String(last.content ?? '').trim().length);
        // 同上：tool 算断在半路，别误判成「说完了」把草稿当残留删掉
        const tailFinished = tailIs === 'assistant' && tailHasText && !tailHasTools;
        if (!tailFinished) {
          const body = draftAsMessage(draft, (n) => featureNameOfTool(n) || n);
          if (body) {
            diagLog('draft-restored', `session=${id} len=${body.length}`);
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
    return json(res, 200, { session: publicSession(session), memory: memoryInfo(id), recovered, interrupted: peekInterruptedInfo(id), running: runningTurns.has(id) });
  }

  // ---- 对话回退 ----
  // 只遮蔽不删除：往会话里追加一个回退点，老消息原样留在日志里。
  if (req.method === 'POST' && url.pathname === '/api/sessions/rewind') {
    const { id, at } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    /**
     * 【2026-11-01 修·回退不了】
     *
     * 原来这里直接回 409「这个会话正在跑，先点停止再回退」。
     * 可 preview 端点不查运行状态，界面上显示得好好的、点确认才被拒 ——
     * 主人只会看到「回退不了」，不知道要先去点停止。
     *
     * 主人点回退，意思就是「回到这条之前」，替他停掉更顺，不该让他再多点一次。
     * 所以这里就地掐掉这一轮（abort + 销登记），然后照常往下回退。
     */
    const _rwTurn = runningTurns.get(id);
    if (_rwTurn && !_rwTurn.ac.signal.aborted) {
      try { _rwTurn.ac.abort('rewind'); } catch {}
      runningTurns.delete(id);
      try {
        const _ll = liveLogs.get(id);
        if (_ll) { _ll.done = true; _ll.endedAt = Date.now(); }
      } catch {}
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
    /* 【2026-11-03 严检补的】/rewind 有 busy 保护（它还会主动掐断正在跑的那一轮），
     * 而「撤销回退」这条没有：它同样 saveSession 写盘 + snapMemory 回写记忆，
     * 跑着的时候点会跟正在吐字的那一轮抢同一条会话，落盘成半截。
     * 两条路必须是同一把锁，否则前门锁了后门还开着。 */
    if (runningTurns.get(id)) {
      return json(res, 409, { error: '这一轮正在生成，等它说完再撤销回退（不然会写乱）' });
    }
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

  /**
   * 【删掉某一条消息】—— 2026-10-30 主人：「给消息加个删除按钮」。
   *
   * 跟回退不一样：回退是「把对话退到这条之前」，会连记忆、文件一起退。
   * 删除只办一件事：这一条从今往后不发给模型了，别的什么都不动。
   *
   * 做法照抄 rewind 的路子：往 session 上记一条 hiddenRewinds，用 effectiveIndexes
   * 精确把这一条剔出去，**不改 messages 数组本身** —— 下标一变，所有 rewind 点、
   * 所有 _ws 快照就全错位了。
   *
   * 两条铁律（都是 rewind.mjs 里踩出来的）：
   *   ① 删 assistant 时，它名下 tool_calls 对应的 tool 结果必须一起删，
   *      否则上游当场 400「Messages with role tool must be a response to a preceding tool_calls」；
   *   ② 反过来不处理：tool 结果被删、assistant 留着，那个形状上游接受。
   */
  if (req.method === 'POST' && url.pathname === '/api/sessions/message-delete') {
    const { id, at } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const rt = runningTurns.get(id);
    if (rt && !rt.ac.signal.aborted) {
      return json(res, 409, { error: '这个会话正在跑，先点停止再删' });
    }
    repairHistory(session.messages);
    const all = Array.isArray(session.messages) ? session.messages : [];
    const idx = Number(at);
    if (!Number.isFinite(idx) || idx < 0 || idx >= all.length) {
      return json(res, 400, { error: '这条消息不在这个会话里' });
    }
    const target = all[idx];
    if (!target || target.role === 'system') return json(res, 400, { error: 'system 那段不能删' });

    const rewinds = loadRewinds(session);
    if (!effectiveIndexes(all, rewinds).keep.includes(idx)) {
      return json(res, 400, { error: '这条已经删过/退过了' });
    }

    // 要剔的下标：这条自己 + 它到「下一条真正的消息」之间挂着的工具
    //
    // 【2026-10-30 主人要】删一条就把它到下一个消息之间的工具一起删 ——
    // 原来只删「这条 + 它自己 tool_calls 名下那几条 tool」，于是删掉 user 那句之后，
    // 后面那条 assistant 顺手调的一串工具（读文件、跑命令…）还孤零零挂在原地，
    // 看着像没删干净。现在改成：从这条往后，一路吃到「下一个不是 tool 的消息」为止。
    //
    // 【怎么划这刀】一轮的骨架是：user → assistant(调工具) → tool → tool → assistant(总结)
    // 所以「这条到下一个消息之间」= 吃到**下一条 user** 为止，中间 assistant / tool 全带走。
    // （早先按「撞上非 tool 就停」，删 user 时第一条 assistant 就把它顶住了，工具一条没删。）
    const drop = new Set([idx]);
    for (let k = idx + 1; k < all.length; k++) {
      const m = all[k];
      if (!m) continue;
      if (m.role === 'user') break;   // 下一个开口的人 → 到这里为止
      if (m.role === 'system') break; // 系统提示不动
      // assistant 分两种：纯调工具的那种（content 是空的）算「经过」，跟着走；
      // 有字的回答是「她说过的话」，那是下一条消息，不能顺手删掉。
      if (m.role === 'assistant') {
        const txt = typeof m.content === 'string' ? m.content.trim() : '';
        if (txt) break;
        drop.add(k);
        continue;
      }
      drop.add(k);                    // tool 结果 → 一起走
    }
    // 吃到下一个 user 为止
    // 再兜一层：这条自己如果是 assistant，它 tool_calls 点名的 tool 结果无论隔多远都要删
    const calls = Array.isArray(target.tool_calls) ? target.tool_calls : [];
    for (const c of calls) {
      const cid = String((c && c.id) || '');
      if (!cid) continue;
      for (let k = idx + 1; k < all.length; k++) {
        const m = all[k];
        if (m && m.role === 'tool' && String(m.tool_call_id || '') === cid) drop.add(k);
      }
    }

    /**
     * 【怎么让它真的不发给模型】
     *
     * 不另造字段 —— effectiveIndexes 只认 rewinds[].hidden，而且 loadRewinds 会
     * 把「没有 at 的记录」整个滤掉。所以这里必须带 at: -1 —— rewind.mjs 第 44 行
     * 写明「at:-1 是登记表，不是回退点，永远不算数」，正好拿来当纯隐藏用。
     * 只给 hidden 不给 at 的话，会被 loadRewinds 丢掉，删了等于没删。
     */
    const rec = { at: -1, hidden: [...drop].sort((a, b) => a - b), ws: {}, deleted: true };
    const list = Array.isArray(session.rewinds) ? session.rewinds : [];
    list.push(rec);
    session.rewinds = list;
    session.updatedAt = Date.now();
    saveSession(session);
    return json(res, 200, { ok: true, deleted: [...drop], session: publicSession(session) });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/rewind-preview') {
    const { id, at } = await body(req).catch(() => ({}));
    if (!isSessionId(id)) return json(res, 400, { error: 'bad session id' });
    const session = getSession(id);
    if (!session) return json(res, 404, { error: 'session not found' });
    const all = Array.isArray(session.messages) ? session.messages : [];
    const view = effectiveIndexes(all, loadRewinds(session));
    const idx = Number(at);
    /**
     * 【2026-11-01 修·预览骗人】
     *
     * 原来这里什么都不查：at 越界（99999）、指向已隐藏的消息、指向 assistant，
     * 一律回 ok:true。界面于是显示「能退」，主人一点确认，真执行时才被打回来。
     * 预览的意义就是「先告诉我行不行」，所以这里必须跟真执行用同一套判据。
     */
    const _t = all[idx];
    if (!_t || !Number.isInteger(idx) || idx < 0) {
      return json(res, 200, { ok: false, at: idx, error: '这条消息已经不在了', removed: 0, files: [], text: '' });
    }
    if (_t.role !== 'user' || _t.context) {
      return json(res, 200, { ok: false, at: idx, error: '只能回退到你自己说过的话', removed: 0, files: [], text: '' });
    }
    if (!view.keep.includes(idx)) {
      return json(res, 200, { ok: false, at: idx, error: '这条已经被回退过了', removed: 0, files: [], text: '' });
    }
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
    // 办事模式开出来的 worker 只属于这个会话，会话没了就该跟着走
    try {
      forgetTaskSession(id);
    } catch {}
    // 人设按会话：这条会话没了，它「用过哪套人设」的记录也没意义了
    try {
      clearSessionPersona(id);
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
        try {
          forgetTaskSession(id);
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
    /*
     * 【2026-11-01 主人报：关了再开，还是得我先发一句它才动】
     *
     * 真凶：上面这段只把「正在跑的那一轮」掐掉，从来没写过 resume.json。
     * 而主人平时重启就是「关窗口 → 再双击打开」，走的就是这条 /api/app/quitting。
     * 所以续跑意图一次都没落过盘 —— 重启完自然一片安静。
     *
     * 现在退出前也记一笔，规矩跟 /api/app/restart 完全一致：
     *   · 在跑的那一轮       → 记（半截话 + 清单）
     *   · 没在跑但清单没清完 → 记（只记清单）
     *   · 都没有             → 不记，安静退出
     */
    try {
      /* 【2026-11-07 改·每个有活的会话都要记】
       *
       * 主人报：「一个会话自动重启续跑了，另一个正在运行的会话就停了没跟着续跑」。
       *
       * 原来这段是「找到第一个有活的 _qsid 就 break，只记一条」——
       * 配上 resume.json 老结构只有一个坑位，两个会话同时跑时，
       * 重启后必然只续一个，另一个无声无息停了。
       * （/api/app/restart 那条路早就是多候选了，漏的是这条「关窗口退出」。）
       *
       * 现在：把「正在跑的」和「清单没清完的」收成一个集合，一个都不漏地各记一条。
       */
      const _cand = [];
      const _pushCand = (sid) => {
        const s = String(sid || '');
        if (s && !_cand.includes(s)) _cand.push(s);
      };
      /* ① 正在跑的：一个都别落下 */
      for (const id of ids) { try { if (runningTurns.get(id)) _pushCand(id); } catch {} }
      try { for (const sid of runningTurns.keys()) _pushCand(sid); } catch {}
      /* ② 【2026-11-07 删·不再扫「清单还有没打勾的」】
       *
       * 原来这里会把最近 30 个会话里清单没清完的都收进来 —— 实测一次退出记出
       * **8 条**老账（都是早就不在跑、主人可能早放弃的活）。
       * 这些记下来只有一个后果：文件越长越大，还容易在开机时被误续。
       *
       * 现在只认「正在跑、被掐断」的那几个。清单老账想接着干，主人手动点
       * （POST /api/resume 带 sessionId），别替他决定。 */
      /* ③ 逐个写：一个会话一条，互不覆盖 */
      for (const _qsid of _cand) {
        let _qopen = [];
        try {
          const _qp = loadPlan(_qsid);
          const _qst = (_qp && Array.isArray(_qp.steps)) ? _qp.steps : [];
          _qopen = _qst
            .filter((x) => x && x.status !== 'done' && x.status !== 'skipped')
            .map((x, n) => ({ n: (x.id != null ? x.id : n + 1), text: String(x.text || '').slice(0, 200) }));
        } catch {}
        let _qlive = null;
        try { _qlive = runningTurns.get(_qsid); } catch {}
        if (_qlive || _qopen.length) {
          markInterrupted({
            sessionId: _qsid,
            text: _qlive && _qlive.draft ? _qlive.draft.text : '',
            reason: _qlive ? '关窗口退出（这一轮还没跑完）' : '关窗口退出（清单上还有没做完的）',
            taskLine: lastUserLine(_qsid),
            openSteps: _qopen,
            /* 【2026-11-07】只有「正在跑被打断」才在开机时自动接着干；
             * 清单老账（人早就不在跑了）只记着，等主人手动点 —— 否则一次能拉起八个会话。 */
            autoResume: Boolean(_qlive),
          });
          diagLog('quit-resume:' + _qsid + ':' + _qopen.length, _qsid);
        }
      }
    } catch (e) { console.warn('[quit] 记续跑意图失败：', String(e?.message ?? e)); }
    /* 【2026-11-02 主人要求·修】这里原来干的是「有活没干完就置 __xyRelaunchOnQuit，
     *  让主进程退了之后自己爬起来」。主人手动退出却自己重开，就是这一行造成的：
     *  只要 resume.json 里还压着旧账（清单没做完），哪怕是他自己点了退出，
     *  程序也会偷偷 relaunch。而「重启后自动接着干」那套功能后来已经按主人要求删了，
     *  这个重开就只剩副作用 —— 所以整段拿掉。
     *  现在规矩很干脆：主人亲手退出 = 真退出，绝不自己爬起来。
     *  只有我调 /api/app/restart（带 byTool）时，才由那条路径自己处理重开。 */
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
    /* 【2026-11-03 主人要求】功能页那一档管的是「续不续上」，不是「能不能重启」。
     *
     * 主人原话：「如果这个功能被关，那么就改为能自动重启但不能续上」。
     *
     * 所以这里**不拦重启**，只降级：
     *   功能开着 → 正常重启，退出前记 resume 意图，重启完自动接着干（原来那套）
     *   功能关着 → 照样能重启（否则新代码永远生效不了，只能靠主人手动双击），
     *              但不写 resume 意图，重启完就是个干净的冷启动。
     *
     * 真正堵死的是另一件事：用命令把进程杀掉（run_command 里的 Stop-Process /
     * taskkill 那些）—— 那不是重启，是退出，主进程没了谁也不会把它拉回来。
     * 那条路已经在 tools.mjs 里拦死了。
     */
    let _resumeAllowed = true;
    {
      let _gateBody = {};
      try { _gateBody = await body(req).catch(() => ({})); } catch { _gateBody = {}; }
      req.__xyBody = _gateBody;
      let _feats = null;
      try { _feats = getFeatures(); } catch { _feats = null; }
      const _gate = _feats?.features?.find((f) => f.id === 'selfRestart');
      _resumeAllowed = Boolean(_gate && _gate.enabled === true);
      if (!_resumeAllowed) console.log('[restart] 「自动重启续上」关着 → 照样重启，但不续上');
    }
    /**
     * 【2026-11-07 加·主人定的底线：有别 的会话在跑，重启得先问】
     *
     * 主人原话：「我加了底线是在有其他会话运行时重启得问主人」。
     *
     * 为什么要这道闸：重启会把**所有**正在跑的轮次一起掐断。虽然现在断点一个会话
     * 一条、起来能全部续上（见 resume.mjs），但被打断一次终归要重来一段，
     * 主人可能根本不希望这个时候重启。
     *
     * 所以这里**不自己重启**，回 409 让模型去问；主人点头后带 force:true 再来一次。
     * 判断「别的会话」时把当前这个会话排除掉 —— 她自己正跑着、自己要求重启，
     * 那不叫「别人在跑」。
     */
    try {
      const _force = Boolean(req.__xyBody && req.__xyBody.force);
      const _cur = String((req.__xyBody && req.__xyBody.sessionId) || '');
      if (!_force) {
        /* 【2026-11-08 修·僵尸登记卡死重启】把僵尸登记清掉再数。
         * 主人报过、我这次也撞上了：一条会话被关窗掐断后，runningTurns 里那条
         * 登记永远没人删 —— 从此任何会话想重启都被它挡着，可清掉它又只能靠重启，
         * 死锁。这里用跟 /api/running 完全相同的两条判据：
         *   ① t.ac.signal.aborted —— 那一轮早被停掉了，只是没人删登记
         *   ② liveLogs 里有记录且 done —— 已经跑完收尾了
         * 都不成立才当活着。绝不按「多久没动静」猜，免得把真在跑的误杀。 */
        try {
          for (const _sid of [...runningTurns.keys()]) {
            if (_sid === _cur) continue;
            let _dead = false;
            try {
              const _o = runningTurns.get(_sid);
              if (_o && _o.ac && _o.ac.signal && _o.ac.signal.aborted) _dead = true;
              const _lg = liveLogs.get(_sid);
              if (_lg && _lg.done) _dead = true;
            } catch {}
            if (_dead) {
              runningTurns.delete(_sid);
              console.log('[restart] 清掉僵尸登记：' + _sid);
            }
          }
        } catch {}
        const _others = [];
        for (const sid of runningTurns.keys()) {
          if (String(sid) === _cur) continue;
          _others.push(String(sid));
        }
        if (_others.length) {
          const _names = _others.map((sid) => {
            try { const s = getSession(sid); return String((s && s.title) || sid); } catch { return sid; }
          });
          console.log('[restart] 还有 ' + _others.length + ' 个会话在跑，先问主人：', _names.join('、'));
          return json(res, 409, {
            ok: false,
            needConfirm: true,
            busy: _names,
            error: '还有 ' + _others.length + ' 个会话正在跑（' + _names.join('、') + '），'
              + '现在重启会把它们全部掐断。**先问主人一句「现在要不要重启」**；'
              + '他说要，再带 force:true 调一次。别自己替他决定。',
          });
        }
      }
    } catch (e) { console.warn('[restart] 检查别的会话时出错（不影响重启）：', String(e?.message ?? e)); }

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
    let _reqSid = '';
    let _b = {};
    try {
      _b = (req && req.__xyBody) ? req.__xyBody : await body(req).catch(() => ({}));
      _reqSid = String(_b?.sessionId || '');
      const _want = _reqSid;
      /**
       * 【认谁在跑，不认谁最后聊过】
       *
       * 前端点「重启」时不一定带 sessionId，所以这里兜底：
       * 只从 runningTurns 里找「此刻真有一轮在跑」的会话。
       * 绝不去翻 lastSessionId —— 那个是「最后聊过的」，
       * 用它就正好会犯主人担心的事：重启完跑到别的会话里去接着干。
       * runningTurns 里没有，就一条都不记，重启完安安静静。
       */
      /*
       * 【2026-11-01 主人报：重启后还得我自己发一句它才动】
       *
       * 原来这一整段只在「此刻真有一轮在跑」时才记续跑意图（下面 if (!_live) continue）。
       * 可主人让我重启，最常见的时机恰恰是**我刚把这一轮说完、正等他点重启** ——
       * 那一轮已经收尾、不在 runningTurns 里了，于是什么都没记，重启完就干等。
       *
       * 现在的规矩：
       *   · 在跑的那一轮       → 照旧记（半截话 + 清单），起来接着说完
       *   · 没在跑但清单没清完 → 也记（只记清单），起来接着做剩下的
       *   · 没在跑、清单也空   → 什么都不记，安静重启（别自作聪明乱起）
       */
        /*
         * 【2026-11-01 主人要：重启完自己接着做，别等我再发一句】
         *
         * 光看 runningTurns 不够 —— 最常见的重启时机恰恰是「这一轮已经说完，
         * 主人在等它重启」。那时候 runningTurns 是空的，一个候选都没有。
         * 所以再补一路：扫一遍会话清单，谁的 plan 上还有没打勾的，就把谁当候选。
         * 不翻 lastSessionId：它是「最后聊过的」，不代表还有活没干。
         */
        /**
         * 【2026-11-08 修·A 续上了、B 却被丢下】
         *
         * 主人问：「A 会话自动重启续上时，另一个正在运行中的 B 会话在自动重启后也会续上吗？」
         * 查下来答案是**不会**。原来这一行是：
         *     let _cands = _want ? [_want] : [...runningTurns.keys()];
         * 而前端那个「重启让它生效」按钮**一定会带 sessionId**（public/index.html:16910），
         * 于是 _want 永远有值 → 候选永远只有那一个 → 同时在跑的 B 连一条续跑意图都没记，
         * 重启完就静悄悄地停在那儿。
         *
         * 这跟 11-01「一次只续一个」是同一个形状的坑，只是那次修的是「不带 id 时」，
         * 没管「带了 id 时」。
         *
         * 现在：点重启的那个排最前面（优先续），**其余正在跑的一个不落跟在后面**。
         */
        let _cands = _want
          ? [_want, ...[...runningTurns.keys()].filter((x) => x !== _want)]
          : [...runningTurns.keys()];
        if (!_want) {
          try {
              const _dir = join(config.dataDir, '.state', 'sessions');
              if (__diagExists(_dir)) {
              const _files = __diagReaddir(_dir).filter((f) => f.endsWith('.json'));
              // 按修改时间倒序，最近聊过的那几个先看
              const _sorted = _files
                .map((f) => { try { return { f, t: statSync(join(_dir, f)).mtimeMs }; } catch { return { f, t: 0 }; } })
                .sort((a, b) => b.t - a.t)
                .slice(0, 30);
              for (const { f } of _sorted) {
                const _sid2 = f.replace(/\.json$/, '');
                if (_cands.indexOf(_sid2) >= 0) continue;
                try {
                  /* 【2026-11-01 严检揪出来的真 bug：这里把 loadPlan 的返回值当成文本切了】
                     loadPlan(…) 返回的是对象 { goal, steps:[{id,text,status}] }（实测 typeof=object、steps=25 条），
                     不是 .txt 那种渲染文本。当字符串切出来的 _op 恒为空 → 一个候选都选不出来 →
                     重启完 resume.json 根本没写 → 主人看到的就是「还是得我自己发一句它才动」。
                     现在照对象读。 */
                  const _pp = loadPlan(_sid2);
                  const _psteps = (_pp && Array.isArray(_pp.steps)) ? _pp.steps : [];
                  const _op = _psteps.filter((x) => x && x.status !== 'done' && x.status !== 'skipped');
                  /* 只认最近活跃的那一个。
                     原因：老会话也带着没打勾的清单（整整 19 个），
                     全开会同时启动一批任务。只要最近那个。 */
                  if (_op.length) { _cands.push(_sid2); break; }
                } catch {}
              }
            }
          } catch {}
        }
      for (const _sid of new Set(_cands)) {
        const _live = runningTurns.get(_sid);
        let _open = [];
        /** 【2026-11-06 修】_steps 原来在 try 里声明，出了 try 就取不到 —— 提到这里 */
        let _steps = [];
        /** 【2026-11-06 修·同一个坑】_p 也是 try 里声明的，出了 try 取不到 */
        let _p = null;
        /*
         * 【2026-11-01 这里我自己差点搞错，留个记号】
         *
         * loadPlan() 读的是 .state/plan/<id>.json，返回的是对象 { goal, steps:[{id,text,status}] }。
         * 旁边那个同名的 .txt 只是给人看的渲染版 —— 别拿它当判据，用 TXT 去切只会切出空数组。
         */
        try {
          _p = loadPlan(_sid);
          _steps = (_p && Array.isArray(_p.steps)) ? _p.steps : [];
          _open = _steps
            .filter((x) => x && x.status !== 'done' && x.status !== 'skipped')
            .map((x, n) => ({ n: (x.id != null ? x.id : n + 1), text: String(x.text || '').slice(0, 200) }));
        } catch {}
        // 没在跑、清单也清完了，但会话里说过话 → 照样记一笔断点。
        // 【2026-11-07 修】原来这里无条件 continue。干完活、清单清空、立刻重启，
        // 那一刻 runningTurns 空、_open 也空，于是断点一个字不写，起来就接不上。
        // 而这恰恰是最常见的重启时机 —— 下面那段「清单空了就用会话标题 +
        // 主人最后那句」的兜底，永远走不到。改成：有话说就记，彻底没话才跳过。
        if (!_live && !_open.length) {
          let _hadTalk = false;
          try { _hadTalk = Boolean(String(lastUserLine(_sid) || '').trim()); } catch { _hadTalk = false; }
          if (!_hadTalk) continue;
        }
        /* 【2026-11-03 主人要求】功能关着 → 照样重启，但不写续跑意图（干净冷启动） */
        if (!_resumeAllowed) continue;
        /* 【2026-11-06 加】把「总目标」和「已经定过的做法」算出来，一起写进断点。
         *  目标优先取清单上的 goal；清单常常是空的，那就拿「会话标题｜主人最后那句」顶上 ——
         *  标题本来就是主人那句话的浓缩，两句拼起来足够让醒来的我知道在干什么。 */
        let _goal = String((_p && _p.goal) || '').trim();
        if (!_goal) {
          try {
            const _sess = getSession(_sid);
            const _t = String((_sess && _sess.title) || '').trim();
            const _u = String(lastUserLine(_sid) || '').trim();
            _goal = (_t && _u && _t !== _u) ? (_t + '｜' + _u) : (_t || _u || '');
          } catch { /* 取不到就留空，宁可少一段也不带崩重启 */ }
        }
        _goal = _goal.slice(0, 300);
        /* 决定从哪来：清单里已经打勾的步骤 = 已经做完的决定。
         * 不去猜、不去总结 —— 只抄事实，抄错了比不抄更糟。 */
        const _decisions = _steps
          .filter((x) => x && (x.status === 'done' || x.status === 'skipped'))
          .map((x) => String(x.text || '').slice(0, 160))
          .filter(Boolean)
          .slice(-6);
        markInterrupted({
          sessionId: _sid,
          text: _live && _live.draft ? _live.draft.text : '',
          reason: _live
            ? '主人让它重启（重启前这一轮还没跑完）'
            : '主人让它重启（这一轮已说完，清单上还有没做完的）',
          taskLine: lastUserLine(_sid),
          openSteps: _open,
          /* 【2026-11-06 加·5 段式交接】
           *  原来只记「断在哪、还剩哪几步」—— 醒来知道接着干，但不知道**为什么干**、
           *  也**已经定过什么主意**，于是要么把做过的重做一遍，要么拐到别的方向去。
           *  workbuddy 的 session-continuity 把交接写成 5 段：目标/决定/规则/状态/下一步。
           *  规则（主人原话）本来就在系统提示里，这里只补「目标」和「决定」。 */
          goal: _goal,
          decisions: _decisions,
        });
        _resumeSid = _sid;
        break;
      }
    } catch (e) {
      console.warn('[restart] 记续跑意图失败（不影响重启）：', String(e?.message ?? e));
    }
    /* 【2026-11-02 主人要求】
     *  原话：「重启后让我自动发一句：重启了」，并且
     *  「必须是你手动调用工具自动重启才会这样，而不是我手动关掉你你还会自动重启」。
     *
     *  所以这件事只写在这里 —— /api/app/restart 只有我自己调工具喊得到。
     *  主人关窗口/托盘退出走的是 electron 那条路，不经过这里，天然不会触发。
     */
    let _tellWho = '';
    try {
      /* 【2026-11-02 主人报「重启了没被叫醒」的真凶】
       *  原来只认 _resumeSid 或「此刻恰好只有一个在跑」。
       *  可最常见的重启时机是：我这一轮刚说完、清单也全打勾了 ——
       *  那两个来源全是空的，_tellWho 就成了空串，标记根本没写。
       *  兜底补一路：请求体里带了 sessionId 就用它（tools.mjs 的重启工具会带）。 */
      _tellWho = String(_resumeSid || _reqSid || (runningTurns.size === 1 ? [...runningTurns.keys()][0] : '') || '');
    } catch {}
    /* 【只有我调工具喊的重启才自动说一句】
     *  主人点界面上的「重启」按钮、或者自己关窗口，都不该触发 ——
     *  请求体里带 byTool:true 才算数（tools.mjs 的重启工具会带）。
     */
    let _byTool = false;
    try {
      _byTool = String(_b?.byTool) === 'true' || _b?.byTool === true;
    } catch {}
    if (_tellWho && _byTool) {
      try {
        __diagMkdir(join(config.dataDir, '.state'), { recursive: true });
        writeFileAtomic(join(config.dataDir, '.state', 'after-restart.json'), JSON.stringify({ sessionId: _tellWho, at: Date.now() }));
      } catch (e) {
        console.warn('[restart] 记「重启后说一句」失败（不影响重启）：', String(e?.message ?? e));
      }
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

  /**
   * 装新版：POST /api/update/install
   *
   * 只在「安装包已经下好、校验过」时才动。做的事：
   *   1. 生成一个脱钩的 .cmd：等本进程退出 → 跑安装包 /S → 装完把程序拉起来
   *   2. 回 200
   *   3. 250ms 后 app.relaunch()? 不要 —— 这里必须**真退出**，不然文件被占用装不上。
   *      所以用 globalThis.__xiaoyuQuitForInstall()（主进程里注册，app.exit(0) 不重启），
   *      没有就自己 process.exit(0)。
   *
   * 为什么不直接在这里 spawn 安装包：NSIS 覆盖安装要求目标程序已退出，我们还活着会撞
   * 「文件被占用」。所以必须让 .cmd 等着我们死。
   */
  if (req.method === 'POST' && url.pathname === '/api/update/install') {
    const bodyJson = await body(req).catch(() => null);
    const info = lastUpdateInfo();
    if (!info || info.status !== 'ready' || !info.file) {
      return json(res, 400, { ok: false, error: '现在没有下好的新版安装包' });
    }
    const running = runningTurns.size;
    if (running > 0) {
      // 装完会重启，正在跑的那一轮会被掐断。宁可让人多等一会儿，也不替他决定。
      return json(res, 409, { ok: false, error: `还有 ${running} 个会话在跑，等它们跑完再装` });
    }
    /* 【2026-11-03 回归打脸】_t_update_flow 走到这条会真装新版，把跑着的程序自己弄退。
       * 验收要能「走到这一步但不真装」，所以给个 dryRun：只回话，不落脚本、不退出。 */
      if (bodyJson && bodyJson.dryRun === true) {
        return json(res, 200, { ok: true, dry: true, file: info.file, size: Number(info.size) || 0 });
      }
      const appExe = String(process.env.XIAOYU_APP_EXE || process.execPath || '');
    const r = spawnSilentInstall({ file: info.file, kind: info.kind || 'setup', appExe, pid: process.pid });
    if (!r.ok) return json(res, 500, { ok: false, error: r.error || '起不来安装脚本' });
    console.log('[update] 安装脚本已起，程序马上退出交给它装：', r.script);
    json(res, 200, { ok: true, script: r.script, size: info.size || 0 });
    setTimeout(() => {
      const quit = globalThis.__xiaoyuQuitForInstall;
      if (typeof quit === 'function') {
        try { quit(); return; } catch (e) { console.warn('[update] 喊主进程退出失败：', String(e?.message ?? e)); }
      }
      try { emitExit(0); } catch {}
      process.exit(0);
    }, 300);
    return;
  }

  /** 不装了：POST /api/update/dismiss → 把下好的包删掉、状态清掉（下次不再提示这一版） */
  if (req.method === 'POST' && url.pathname === '/api/update/dismiss') {
    const info = lastUpdateInfo();
    if (info && info.status === 'ready') {
      dropInstaller(info.file);
      try {
        writeFileAtomic(
          join(config.dataDir, '.state', 'update.json'),
          JSON.stringify({ at: Date.now(), status: 'dismissed', from: info.from, to: info.to }, null, 2),
        );
      } catch {}
    }
    return json(res, 200, { ok: true });
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
    /* 【2026-11-02 主人报「消息被吞」】
     * 原来只要 runningTurns 里有这条就一律 409。可那一轮可能早就 abort 了
     * （续跑失败 / 崩溃后重启留下的残骸），ac 已 aborted 只是没人删。
     * 那样主人每发一句都吃 409，界面上就是「消息被吞」。
     * 现在先看 ac 是不是已经废了：废了当场清掉，让这句话正常发出去。 */
    if (runningTurns.has(sessionId)) {
      const _st = runningTurns.get(sessionId);
      const _dead = !!(_st && _st.ac && _st.ac.signal && _st.ac.signal.aborted);
      if (_dead) {
        diagLog('409-cleanup', 'session=' + sessionId + '（残留的 aborted 轮次，清掉放行）');
        try { runningTurns.delete(sessionId); } catch {}
      } else {
        return json(res, 409, { error: '这个会话还在跑，等它跑完（或者点停止）再发' });
      }
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
     * 【主动找我 · 主人真回来了】把「她不说话我连叫了几次」清零。
     *
     * 不清零的后果：叫满 7 次没人理就停手（这是对的），可主人明明回来了、
     * 只是那 7 次恰好他不在，之后她就永远不再主动开口 —— 一次误伤管一辈子。
     * 所以只要主人真发了一句，这里就归零。
     */
    try { noteReplied(sessionId); } catch {}

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
    /** 小鱼不在时，群聊那一趟也要把事件写进 live，界面才看得见自建卡说的话 */
    let live0ForMates = null;
    /* 【2026-11-09 修·关掉小鱼、开小白曦，说话没回应】
     * 主人报的：关小鱼 / 开小白曦，发一句只有 done + fish_off，零回复。
     * 实测四种配置，凡小鱼关掉都 text=0。
     *
     * 病根就是下面这个 early return：它把「小鱼不在」当成「这一轮没人干活」，
     * 直接收口，只留小鲸补一句 + runMateRound 群聊接话。
     * 可新口径里小鱼只是【屋里的人】之一，主智能体 = 从上往下第一个开着的；
     * 关掉她，小白曦就成了主智能体，**应该走完整主流程 runAgent**
     * （有工具、能派活、完整回复），而不是被塞进「别人补一句」那条旁支。
     * 更糟的是我上一版把 runMateRound 的名单改成 activeAgentIds().slice(1)，
     * 此时名单只有 [小白曦]，slice(1) 为空 —— 连补一句的人都没有，彻底静默。
     *
     * 现在：只有**一个启用者都不剩**才走这条「屋里没人应」的收口支线。 */
    const _aliveForTurn = activeAgentIds(sessionId, (id) => mateSwitchOn(id, sessionId));
    if (!resume && !fishOn(sessionId) && _aliveForTurn.length === 0) {
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
        /**
         * 【2026-11-02 两把钥匙都关着，得让主人知道「不是坏了」】
         *
         * 主人报：「小鱼按钮关闭后我发消息她没有回复」。两个开关都关着的时候，
         * 这一轮确实谁都不该开口 —— 但界面只剩自己那条消息，看着像程序死了。
         * fish_off 已经告诉前端「不是我答的」，这里再补一句「屋里这会儿没人应」，
         * 让前端能给一句人话的提示，而不是静悄悄地什么都不发生。
         */
        let nobodyHere = false;
        try {
          /* 小鲸不在 ≠ 屋里没人：自建卡开着也算有人（2026-11-01 主人报） */
          nobodyHere = !whaleOn(sessionId) && !anyMateOn(sessionId);
        } catch { nobodyHere = true; }
        res.write(`data: ${JSON.stringify({ type: 'fish_off', nobodyHome: nobodyHere })}\n\n`);
      } catch {}
      /**
       * 【小鱼不在屋，不代表小鲸也听不见】
       *
       * 以前这里直接 res.end() 就 return 了，小鲸那句调用写在主流程末尾，
       * 根本走不到 —— 主人把小鱼一关、只开小鲸，说半天她一句话没有。
       *
       * 现在在这儿就把主人这句给她，让她照常判断要不要接。
       * 她那句话走她自己的通道推出去，不指望这条已经关掉的 SSE。
       *
       * 【2026-11-03 主人第三报：她答了两遍，而且两遍口径还不一致】
       *
       * 她在这一支里被叫起来时，读的是 `getSession(sessionId)` 现取的那份会话。
       * 上面注释里写的那个「孤儿」就是它：小鱼那条路开跑就把它换成了新对象，
       * 这一份还停在「主人这句话刚落地」——于是她说第一遍时觉得「屋里只有她」。
       * 而小鱼那条路走到收尾的群聊段，第二次读到的已经是带着小鱼回复的历史，
       * 于是又喊她一遍，这一次她说「小鱼也在」。
       * 主人看到的就是「她答了两轮，前后还不一致」。
       *
       * 两道锁，跟群聊段那个 whaleSpokeThisTurn 配套：
       *   · 这一支叫过她 → 收尾的群聊段不会再喊她（第一道锁在群聊段里）；
       *   · 这一支自己只该叫一次，别被别的通道再叫第二遍。
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
        // 【2026-11-01】live0 以前建在「小鲸开着」那个 if 里面 ——
        // 小鲸一关，自建卡说出来的话就没地方推，界面上一个字都看不见。
        // 现在无条件建，谁在屋里谁都能用这一份事件流。
        const live0 = { sessionId, events: [], startedAt: Date.now(), done: false };
        liveLogs.set(sessionId, live0);
        live0ForMates = live0;
        const send0 = (ev) => {
          /**
           * 【2026-11-08 修·「正常运行一直计数」的真凶】
           *
           * 主人：「为什么正常运行了一直在计数，而且计数是从当前轮总用时多久来的」。
           *
           * 因为这里 push 事件时**没带 at** —— 而 /api/running 算 idleMs 靠
           * 「往前找最近一个带 at 的事件」。一条都找不到就退回 startedAt，
           * 于是 idleMs 恒等于「这一轮跑了多久」，90 秒一到就误报「没有回音」。
           * （同一个坑 11-07 在小鲸那条上踩过，当时只补了注释，主路径漏了。）
           *
           * 现在补上 at：idleMs 才是真正的「距上一次有动静」。
           */
          try {
            if (live0.events.length < LIVE_MAX_EVENTS) {
              live0.events.push({ ...ev, at: (ev && ev.at) || Date.now() });
            } else if (!live0.__capNoticed) {
              /* 【2026-11-10 D5·封顶可感知】第一次封顶推一条 notice，之后才静默丢弃 */
              live0.__capNoticed = true;
              live0.events.push({ type: 'text', notice: true, text: LIVE_CAP_NOTICE_TEXT, at: Date.now() });
              ev = { type: 'text', notice: true, text: LIVE_CAP_NOTICE_TEXT };
            } else {
              return; // 已经提醒过了：后续事件连 SSE 都不再发，别把连接刷爆
            }
          } catch {}
          /**
           * 【2026-11-01 主人报「关掉小鱼后小鲸不说话」】
           *
           * 她其实说了 —— 会话文件里有她那条，live 里也有她一个字一个字吐出来的流。
           * 但这里只往 live 里塞，一个 res.write 都没有：这条 SSE 只发出了 done/fish_off，
           * 前端当场当然什么都画不出来，主人以为她没吭声。
           * 现在两句都做：live 留着（切回来补拉用），SSE 也写出去（当场就看得见）。
           */
          try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
        };
        try {
        const sessForWhale = getSession(sessionId);
        const said = String(message || '').trim();
        if (sessForWhale && said && whaleOn(sessionId)) {
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
          await whaleMaybeReply({ session: sessForWhale, userText: said, speaksToHer: true, send: send0, sessionId, live: live0,
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
            .then((r) => {
              /**
               * 【等她说完了再关流】—— 2026-11-03 修
               *
               * 原来这里是 `.catch(...)` 不 await，紧接着就 res.end()。
               * 她那句要几秒才说得完，而这条 SSE 已经关了 —— 主人只看到转圈停了，
               * 却等不到她的话（她的话走 live 补拉，界面得自己再拉一次才看得见）。
               * 现在等她说定，让这条流把她的气泡也带出去。
               */
              if (r === undefined) return;
            })
            .catch((e) => console.warn('[whale] 小鱼不在时她没接上：', String(e?.message ?? e)));
        }
      } catch (e) {
        console.warn('[whale] 小鱼不在时叫她失败：', String(e?.message ?? e));
      }
      /**
       * 【小鱼不在，不代表屋里没人】—— 2026-11-01 主人报
       *
       * 这一支以前叫完小鲸就 res.end() 了，自建卡永远轮不到 ——
       * 主人看到的就是「关掉小鱼，只有小鲸说话，那个智能体像是我在替它说」。
       *
       * 现在这儿也走一趟群聊：谁开着谁说话，跟主流程末尾同一套判据。
       * 小鲸刚才已经由 whaleMaybeReply 说过，这里剔掉她，别让她答两遍。
       */
      try {
        await runMateRound({
          sessionId,
          heard: String(message || ''),
          /**
           * 【2026-11-01 严检揪出的真 bug：只说给 live 听，没发给前端】
           *
           * 原来这里只把事件塞进 live0ForMates，一个 res.write 都没有 ——
           * 端到端实测收到的事件只有 fish_off 和 done，自建卡说的话全丢在服务端。
           * 主人看到的就是「关掉小鱼，那个智能体像是不存在」。
           * 现在：SSE 直接写出去（前端当场就能画），同时照样进 live（补拉历史也在）。
           */
          send: (ev) => {
            try {
              if (live0ForMates && live0ForMates.events.length < LIVE_MAX_EVENTS) {
                live0ForMates.events.push(ev);
              } else if (live0ForMates && !live0ForMates.__capNoticed) {
                /* 【2026-11-10 D5·封顶可感知】同主路：第一次封顶推 notice */
                live0ForMates.__capNoticed = true;
                const _capEv = { type: 'text', notice: true, text: LIVE_CAP_NOTICE_TEXT, at: Date.now() };
                live0ForMates.events.push(_capEv);
                ev = _capEv;
              } else {
                return; // 封顶后静默丢弃，SSE 也不再发
              }
            } catch {}
            try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {}
          },
          excludeIds: [AGENT_XIAOJING],
        });
      } catch (e) {
        try { console.warn('[mates] 小鱼不在时群里没接上：', String(e?.message ?? e)); } catch {}
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
    /* 【2026-11-05 主人报「重启续上后 tokens 显示是估的、数字还特别小」】
     *  真因：这里原来只在 resume 模式下回填挂靠点。可重启续上、定时任务、【主动找我】
     *  这些「系统自己起的一轮」走的不是 resume，是 startQueuedTurn ——
     *  userMsgRef 稳在 null，用量就被丢进 session._orphanUsage（没人读它），
     *  前端只能按字数估算，于是显示「（估）接口没回用量」，数字还是照这一轮字数瞎估的小数。
     *  实测对照：同一轮接口明明回了 prompt_tokens=17353，界面上却是 1,762（估）。
     *
     *  改法：除了 resume，**「历史尾巴上那条是系统插的话」也回填**。
     *  为什么不能干脆去掉 resume 判断：正常发言时这段跑在 history.push(userMsg) 之前，
     *  无脑回填会挂到上一条主人消息上，用量就记到别人的气泡底下去了。 */
    if (Array.isArray(history)) {
      const _tail = history[history.length - 1];
      /* 尾巴是系统插的话（重启了 / 定时任务 / 主动找我）→ 用量就记在它自己身上。
       * 这类轮次是本程序自己起的，不存在「主人那句话」可挂；挂它自己不会串到别人气泡底下。
       * 原来一律不回填，用量全丢进没人读的 _orphanUsage，前端只能瞎估。 */
      const _sysTail = !!(_tail && _tail.role === 'user' && _tail._sysNote);
      if (_sysTail) userMsgRef = _tail;
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
      if (!(me && me.id === 'owner')) return false;
      /**
       * 【2026-11-05 修·关掉开场白还是垫】
       *
       * 主人报：「切回来发现我的消息前面冒出了小鱼的开场白，可我已经禁用了」。
       *
       * 原因是**两条路各判各的**：
       *   · startOpening（切会话那条）用的是 openingAllowed()，里面查了开关 ✅
       *   · /api/chat 这条用的是这里，原来**只查了身份**，压根没看开关 ❌
       *
       * 于是「卡里写着开场白 + 开关关掉」这种状态，从聊天这条路照样会垫进去。
       * 而它是在**发消息那一刻**垫的，前端当下不一定画出来 —— 等切走再切回来重绘，
       * 那句开场白才冒出来。跟主人描述的现象完全对上。
       */
      try {
        return openingEnabled(cardIdOf(sessionId));
      } catch (e) {
        return false;
      }
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
      && openingAllowedHere();
    if (wantOpening) {
      // 插在 system（+可能的 context）之后、现有对话之前，顺序才对
      const at = history.findIndex((m) => m && m.role !== 'system' && !m.context);
      /* 【2026-11-02 修·切到别人身份后，旧消息署名全被刷掉】
       * 主人 2026-10-28 定的规矩是「身份名跟着这句消息一起存下来，
       * 界面画的时候直接用这份」——但这条 assistant 消息当年漏了 _who。
       * 于是切到小白曦身份后重画历史，满屏都是小白曦。
       * 现在把这张卡的身份一起存进去。 */
      const __opCard = cardIdOf(sessionId);
      const __opName = (() => {
        try { const __a = getAgent(__opCard); return String((__a && __a.name) || '').trim(); } catch { return ''; }
      })();
      const __opMsg = { role: 'assistant', content: openingTextHere };
      if (__opName) {
        __opMsg._who = String(__opName);
        if (__opCard && __opCard !== 'xiaoyu') __opMsg._card = String(__opCard);
      }
      const pair = [openingPack.userMsg, __opMsg];
      if (at < 0) history.push(...pair);
      else history.splice(at, 0, ...pair);
      delete session._openingPending;
    }
    if (!resume) {
      /* 【2026-11-05 主人报·发了一句「继续」，会话名被改成了「继续」】
       *
       *  原来只看「历史里有没有 user 消息」就当成第一句、直接改标题。
       *  可分支出来的 / 压缩过的 / 续跑重建的会话，开头是摘要不是 user，
       *  于是永远被判成「第一句」，主人随便发个「继续」就把标题覆盖了。
       *
       *  现在的判据加一条：当前标题得是空的 / 还是默认名「新会话」/ 或者短得不像名字，
       *  才允许自动起名。已经有像样标题的，一句话都不许动。
       *
       *  （firstUserTurn 原来还兼职判断「这是不是第一句」，所以改名和判第一句要分开：
       *    判第一句照旧看历史，改标题才加上面的标题守卫。）
       */
      const _curTitle = String(session.title || '').trim();
      const _titleAutoOk = !_curTitle || _curTitle === '新会话' || _curTitle.length < 3;
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
      /* 两个条件都要：这是第一句，而且现在的标题还空着/是默认名/短得不像名字。 */
      if (firstUserTurn && _titleAutoOk) session.title = titleFromMessage(message);
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
          /* 【2026-11-11】原来这里是裸 push：同一个 rec 可能两边都押着，会落两遍。
           * 统一走 pushParkedUnique 去重（见函数注释里的实测证据）。 */
          const added = pushParkedUnique(msgs, parkedLeft);
          try { saveSession(session); } catch {}
          try { logWhaleAction('开跑补上次漏的：' + n0 + ' → ' + msgs.length + '（+' + added + '，押了' + parkedLeft.length + '条）'); } catch {}
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
    /* 【2026-11-10 D3】开新一轮前顺手扫一遍过期缓存（惰性清扫） */
    try { sweepLiveLogs(); } catch {}
    const live = { sessionId, events: [], items: [], startedAt: Date.now(), done: false };
    liveLogs.set(sessionId, live);
    /**
     * 【2026-11-01 08:45 删掉了一段「send 还没定义就调用它」的残留】
     *
     * 这里原来是：
     *     if (changedMode) send({ type: 'safeWord', ... });
     *
     * 可 const send 是下面十几行之后才声明 —— TDZ，一进来就
     * 「Cannot access 'send' before initialization」。
     * 崩点在 writeHead 之后、runningTurns 登记之前，所以只要这一轮命中安全词
     * （喊了会切档的词），主人看到的就是：一条空流、running 永远 false、她一个字都不回。
     * 这条在 .state/crash.log 里留了铁证（08:45:44）。
     *
     * 安全词提示现在统一在 send 定义之后的那两行发（type 是 safe_word，还带说明文案），
     * 这一份是当时没删干净的旧块，删掉即可 —— 不是「先不发」，是「换到能发的地方发」。
     */

    const send = (ev) => {
      /* 【2026-11-02 前端卡死修复】
       *  主人报「消息被吞、画面固定、刷新也看不到新消息」。
       *  实测这一轮的 live.events 有 2938 条，其中 2249 条是 reasoning，
       *  平均每条只有 1.8 个字 —— 模型一两个字一吐，每一片都成了独立事件。
       *  前端一刷新就要拉全量重画，主线程直接卡死。
       *  这里两道保险：①同一轮里相邻的 reasoning/text 直接并进上一条，
       *  ②超过 SOFT_MAX 就整体「压薄」一次（只留最近的大块）。 */
      try {
        /* 【2026-11-02 · text 又改回「并进上一条」了，原因如下】
         *
         *  以前不能并：前端拿「事件条数」当游标要增量，被并长的那条再也拉不到（丢字）。
         *  现在前端不吃增量了 —— 它只要一有新事件就重新拉「这一轮现在长什么样」的全量快照，
         *  按 rev 过滤（被加长的老事件照样会被带回来），照着整组重画。所以并进上一条没副作用。
         *
         *  反而必须并：一条一条送的话，长回复会有几千条事件，撞上 LIVE_SOFT_MAX 压薄，
         *  老的那些 text 被直接丢掉 —— 屏幕上就成了「短一版」，刷新前跟刷新后不一样。
         *  并起来事件数就压到几十条，压薄不会再动正文。 */
        const _sameKind = (ev && (ev.type === 'reasoning' || ev.type === 'text'))
          && !live.__capNoticed   /* 【2026-11-10 D5】封顶后不许再合并：否则正文会被并进封顶 notice 里 */
          && live.events.length
          && live.events[live.events.length - 1]
          && live.events[live.events.length - 1].type === ev.type;
        if (_sameKind) {
          /* 合并进上一条的事件，清单这边也要跟着长（正文就是这么攒起来的） */
          try { appendLiveItem(live.items, ev); } catch (e) {}
          const _last0 = live.events[live.events.length - 1];
          live.rev = (typeof live.rev === 'number' ? live.rev : 0) + 1;
          live.events[live.events.length - 1] = {
            ..._last0,
            text: String(_last0.text || '') + String(ev.text || ''),
            rev: live.rev,
          };
        } else if (live.events.length < LIVE_MAX_EVENTS) {
          /* 【2026-11-02 游标修复】每条事件打上稳定序号 seq（数组下标）与 rev（变更次数）。
           *  前端原来拿「事件条数」当游标，而 text/reasoning 会被并进上一条（条数不变、内容变长），
           *  于是被追加的那条永远拉不到 —— 界面停在那一刻，非得再刷新一次才补回来。
           *  rev 每次 push/合并都 +1，/api/chat/live 用 rev 过滤，加长的老事件也能被拉到。 */
          live.rev = (typeof live.rev === 'number' ? live.rev : 0) + 1;
          ev.seq = live.events.length;
          ev.rev = live.rev;
          live.events.push(ev);
          /* 【画面真身】清单只增不减 —— 压薄动的是上面那个 events 数组，动不了它 */
          try { appendLiveItem(live.items, ev); } catch (e) {}
        } else if (!live.__capNoticed) {
          /* 【2026-11-10 D5·封顶可感知】第一次封顶向流内推一条 notice（带 seq/rev 照常进清单），
           *  让界面明说「细节省略了」，而不是无声消失；之后的事件才静默丢弃（连 SSE 都不发）。 */
          live.__capNoticed = true;
          live.rev = (typeof live.rev === 'number' ? live.rev : 0) + 1;
          ev = {
            type: 'text',
            notice: true,
            text: LIVE_CAP_NOTICE_TEXT,
            at: Date.now(),
            seq: live.events.length,
            rev: live.rev,
          };
          live.events.push(ev);
          try { appendLiveItem(live.items, ev); } catch (e) {}
        } else {
          return; // 已经提醒过了：后续事件静默丢弃，SSE 也不再发
        }
        /* ② 太长了就压薄：把相邻同类合并，实在还超就砍最老的 */
        if (live.events.length > LIVE_SOFT_MAX) {
          const _kept = [];
          for (const e of live.events) {
            const p = _kept[_kept.length - 1];
            // 同上：text 也合并（前端不按增量画了，内容变长没副作用；合并反而省条数、防压薄丢正文）
            if (p && e && p.type === e.type && (e.type === 'reasoning' || e.type === 'text')) {
              // seq/rev 一并带过去：压薄重组后 seq 会被重排，rev 保持单调（游标据此过滤）
              _kept[_kept.length - 1] = {
                ...p,
                text: String(p.text || '') + String(e.text || ''),
                seq: typeof p.seq === 'number' ? p.seq : 0,
                rev: Math.max(typeof p.rev === 'number' ? p.rev : 0, typeof e.rev === 'number' ? e.rev : 0),
              };
            } else _kept.push(e);
          }
          /* 砍的时候别一视同仁：tool_start/tool_end/done 这些是「骨架」，
           *  丢了界面就画不出【跑命令】这些块；reasoning/text 是血肉，可压。
           *  做法：先按类型把 reasoning/text 合并到底，还超就只在它们里面砍。 */
          /* 【2026-11-02 主人报「文字和工具条交错、显示不全」】
           *  原来这里：先 push(..._flesh, ..._bones)，再按 (a.at||0) 排。
           *  两个 bug：
           *   ① tool_start / tool_end / done 这些事件压根不带 at，全是 0，
           *      一排序工具条整体飞到最前面 —— 画出来就是「一堆工具块、话在下面」。
           *   ② 先 flesh 后 bones 再排，等于是靠 at 兜，缺 at 就全乱。
           *  改法：留着每个事件的原始下标，压薄后按原始下标的先后重新排 ——
           *  事件本来就是按发生顺序进数组的，这才是真顺序。 */
          const _bones = _kept.map((e, i) => ({ e, i })).filter((x) => x.e && x.e.type !== 'reasoning' && x.e.type !== 'text');
          const _flesh = _kept.map((e, i) => ({ e, i })).filter((x) => x.e && (x.e.type === 'reasoning' || x.e.type === 'text'));
          /* 【2026-11-03 主人报「思考链只剩二三十字」】原来是 _flesh.slice(-_room)：
           *  按**条数**砍，前面的事件整条丢掉。可 reasoning/text 早就被并成一条了，
           *  条数不多、字数巨大 —— 结果就是思考动不动被削到只剩尾巴几十个字。
           *  改成按**字数额度**留：谁都别整条消失，只把超长的那条按尾巴截短。
           *  优先保 reasoning（主人最想看的推理），再保 text。 */
          /* 额度按实际长度给：正常轮次一个字都不砍，只在真的超长时才截尾巴。 */
          const _lenOf = (arr) => arr.reduce((n, x) => n + String((x.e && x.e.text) || '').length, 0);
          const _thinkLen = _lenOf(_flesh.filter((x) => x.e && x.e.type === 'reasoning'));
          const _sayLen = _lenOf(_flesh.filter((x) => x.e && x.e.type === 'text'));
          const _keepThink = Math.max(80000, Math.min(_thinkLen, 400000));
          const _keepSay = Math.max(40000, Math.min(_sayLen, 200000));
          const _cutByChars = (arr, cap) => {
            let left = cap;
            const out = [];
            for (let k = arr.length - 1; k >= 0; k--) {
              const it = arr[k];
              const t = String((it.e && it.e.text) || '');
              if (left <= 0) break;
              if (t.length <= left) { out.push(it); left -= t.length; }
              else { out.push({ ...it, e: { ...it.e, text: t.slice(-left) } }); left = 0; }
            }
            return out;
          };
          const _keptFlesh = [
            ..._cutByChars(_flesh.filter((x) => x.e && x.e.type === 'reasoning'), _keepThink),
            ..._cutByChars(_flesh.filter((x) => x.e && x.e.type === 'text'), _keepSay),
          ];
          const _merged = [..._keptFlesh, ..._bones].sort((a, b) => a.i - b.i).map((x) => x.e);
          live.events.length = 0;
          for (const e of _merged) { e.seq = live.events.length; live.events.push(e); }
        }
      } catch {}

      /**
       * 【连接已经收了尾，这一下别把整个进程带崩】—— 2026-11-03
       *
       * 主人报「同时开小鱼小鲸，小鲸说两轮」—— 查出来第二「轮」来自这里：
       * 旧的「让开」那条路（2026-10-30 已删）当年是先 `send({type:'done'})` 再 `res.end()`，
       * 然后才 await 她说话。她每吐一句都往这条已经 end 的连接上写，
       * `res.write` 抛 `ERR_STREAM_WRITE_AFTER_END` —— 这是**异步**抛的，
       * 包在同步 try/catch 里根本接不住，直接升级成进程级未捕获异常
       * （.state/crash.log 里连着两条就是它）。
       *
       * 现在先看 `res.writableEnded`：已经把话说完了就往缓存里放，不再碰连接。
       */
      if (res.writableEnded || res.destroyed) return;
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
    /* 【2026-10-30 主人：把「念到小鲸名字就不说话」这类设定删了】
     * 这条判据原来只看「这句话里有没有小鲸两个字」，一命中就让小鱼整轮闭嘴。
     * 主人要的不是这个：名字可以被顺口提到（「我刚刚把小鲸移到你下面」），
     * 那不是在叫她，更不该因此把小鱼关掉。
     * 所以这里恒为 false —— 不看名字了。真正控制「她开不开口」的只有她自己的
     * 开关（whaleOn）和小鱼在不在屋（__fishAway），不再由一句话里的字眼决定。 */
    const __calledByName = false;
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
    /**
     * 【2026-11-02 主人连着报两次：小鱼不说话了】
     *
     * 现象一：「启用小鲸后再发消息，小鱼不说话了」——真因就在下面这一行：
     *   `__calledByName && !__fishAway && whaleOn(sessionId)`
     * 主人一开小鲸，`whaleOn` 就是 true；而 `__calledByName` 认的是整句话里
     * 出现过「小鲸」两个字。于是只要主人顺口提一句小鲸（哪怕只是打招呼、
     * 或者说「小鲸在家吗」），小鱼整轮被静音。
     *
     * 现象二：「小鲸关着，小鱼照样不回答」——那是我上一版改坏的：
     * 原来还寄望「我让开，让插话闸接」，可插话闸的总开关也是 whaleOn，
     * 同一个 false 把它一起关上了，两边都以为对方在说，结果谁都没说。
     *
     * 所以：让路之后必须**自己把小鲸叫起来说**，不能寄望插话闸。
     *
     * 【2026-11-03 主人报「同时开小鱼和小鲸，小鲸说两轮、小鱼一句话不说」】
     * 上面那条「让路」就是真凶的另一半：
     *   · 这一轮主人点了小鲸 → 我整轮让开，一个字不说；
     *   · 让开之后我调 whaleMaybeReply 把小鲸叫起来 → 她答了一轮；
     *   · 可这轮走到收尾，群聊那段（GROUP_CHAT）又把「小鲸」列进 speakers
     *     （个性没打勾 = 每轮都说）→ 她对着同一句再答一轮。
     * 主人看到的：两条都是她的，小鱼一条没有。
     *
     * 现在只把**这一句**让给她，**这一轮**里就不再让群聊重复喊她 ——
     * 让路只在「她这一轮没被群聊叫过」时才成立，见 groupSpokeThisTurn。
     *
     * 【2026-11-03 第三报：她到底为什么答两遍】实测她两遍都出在同一处：
     * 让路分支 await 完 whaleMaybeReply 之后，发给下一趟的 messages 里已经带着
     * 她刚说的那句（`_who: 小鲸`），可群聊段照样把她列进 speakers ——
     * 因为记账只加进 `groupSpokeThisTurn` 这个**本轮局部**集合，
     * whaleMaybeReply 内部那条通道根本不认它。所以改成在会话上下留时间戳，
     * 见 markWhaleSpoke / whaleSpokeThisTurn。
     */
    const groupSpokeThisTurn = new Set();
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
      /** 【2026-11-02 主人第二次发火：把「她在屋」和「她有没有话要说」分开】
       *
       * 主人原话：「我说了小鱼与小鲸是否启用只与屏幕上方的两个按钮是否启用有关，
       * 为什么我把小鲸关了她特么还在说话？」
       *
       * 查下来是这一行在作怪：原来只要「她在群聊名单里 + 个性没打勾」就返回 true，
       * 于是主流程把插话闸**让开**，可群聊那条路（见下面 GROUP_CHAT 那段）这两条
       * 又都**不叫她**：
       *   · HOSTS 里的卡不看「屋里的人」那颗牌，只看 whaleOn —— 牌关了照样算开着；
       *   · 名单里根本没有小鱼（她永远是主声），所以「个性没打勾」这条对小鱼从没生效过。
       * 结果就是：她不在场时没人说话，在场时却有两处同时判「该由别人来说」，
       * 谁也没说 —— 小鲸这颗按钮关了，最后能开口的还是插话闸。
       *
       * 现在这一行只回答一件事：她的话是不是已经有另一条路负责说了（别重复）。
       * 而「她到底该不该开口」，交回主流程那个 if 里的 whaleOn(sessionId) 管 ——
       * 顶栏那颗按钮，就是唯一的开关。
       */
      try {
        // 她替这个会话说话 → 她的话由主声那条路说，插话闸让开
        if (sessionAgentId(sessionId) === AGENT_XIAOJING) return true;
        // 下面那条「她在屋里且不是叫才应」的让路已经删掉：它把「在场」当成了「该说话」。
        return false;
      } catch { return false; }
    })();
    /**
     * 【2026-10-29 主人发话：把「每轮自动补一句」从源头掐掉】
     *
     * 原来这里只有 whaleOn(sessionId) —— 一个「会话级开关」。
     * 开关一开，**每一轮**收尾都去问小鲸要不要接话，不管主人这一句叫没叫她。
     * 主人看到的现象就是：小鱼每答完一轮，后面总跟着一句披着小鲸样式的补充。
     *
     * 现在改成「叫她才应」：这一句是冲她说的（点了名 / 小鱼被禁用 / 她在群里且没被静音），
     * 才轮到她开口。其余时候我一轮说完就是我一个人的话，不追加、不补气。
     *
     * 立场（__speaksToHer）照旧传下去 —— 她真开口时，仍然知道自己是在跟谁说话。
     */
    const __whaleCalledToSpeak = __speaksToHer || __whaleIsSomeone;
    /**
     * 【2026-11-11 修·主人报「只开小鲸时，我发一条她连回两条」】
     *
     * 截图实证：一条「（愣了一下，尾巴尖慢慢翘起来）主人……突然这么说」，
     * 紧跟着又一条「（听到这三个字，顿了一下）嗯……我记下了」——
     * 两次**不同的生成**，不是重复落盘。
     *
     * 根因：主人是在顶栏【屋里的人】里关掉小鱼、把小鲸往上挪的，
     * **会话绑定的卡没变**，所以上面 `sessionAgentId(sessionId) === AGENT_XIAOJING`
     * 那行不命中；插话闸于是照开 → 她以主智能体身份答完一次，
     * 收尾又被叫去「说一句」→ 屏幕上两条。
     *
     * 判据改成**这一轮真正的主智能体**（屋里第一个开着的），
     * 口径跟 runAgent 的 `__mainIdForTurn` 一致：
     * 她自己就是主声时，她的回答由主声那条路负责，插话闸必须关。
     */
    const __mainIsWhale = (() => {
      try {
        return String(mainAgentId(sessionId, (id) => mateSwitchOn(id, sessionId)) || '') === AGENT_XIAOJING;
      } catch { return false; }
    })();
    if (whaleOn(sessionId) && __whaleCalledToSpeak && !__quiet && !__busyTurn && !__mainIsWhale) {
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
      /**
       * 【前情不许插进一对 tool 调用中间 —— 2026-10-30 修 · 干活鱼2 的 LLM HTTP 400】
       *
       * 真踩过，而且死得很冤：会话历史一旦被压缩，开头就成了
       *   system → 摘要(带 context) → assistant(tool_calls) → tool → …
       * 这时把前情硬插在 2 号位，前情（role:'user'）正好卡在
       * 「assistant(tool_calls)」和「它的 tool 结果」中间：
       *   system → 摘要 → 前情(user) → assistant(tc) → tool
       * 上游按 OpenAI 协议一验就拒：
       *   Messages with role 'tool' must be a response to a preceding message
       *   with 'tool_calls'
       * 于是这个会话**每一轮都 400**，主人说多少句「继续」都是石沉大海，
       * 界面上只剩一行 ⚠（干活鱼2 从 10/27 拖到 10/30 就是这个）。
       *
       * 规矩：**前情只能落在「安全缝」里** —— 前面是 system/摘要，或者前面那条
       * assistant 的 tool_calls 已经全部有了结果。落不进去就把前情送进「设定副本」
       * 那一格（1 号位，紧挨着 system）：那是它本来就合法的两个位置之一，
       * 绝不会把一组 tool 调用劈成两半。
       */
      if (pm) {
        const at = safePreludeSlot(wireMessages);
        if (at < 0) {
          console.log('[prelude] 找不到安全缝（前面是没配齐的 tool_calls），前情改贴到设定副本那一格');
          wireMessages.splice(1, 0, pm);
        } else {
          wireMessages.splice(at, 0, pm);
        }
      }
    }
    /** 前情那条消息的引用，日志里好认（没插就是 undefined） */
    const preludeRef = wireMessages.find((m) => m && m.context && !m._identity) ?? undefined;

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
     * 【发出去之前最后一道体检 —— 2026-10-30】
     *
     * 上游认的是 OpenAI 协议的形状，有两条死规矩，哪条破了都是 HTTP 400：
     *   ① role:'tool' 前面必须是一条带同 id `tool_calls` 的 assistant；
     *   ② assistant 带 tool_calls 之后，那批结果必须紧接着到齐，中间不许插别的东西。
     *
     * 拼接的地方太多（前情、规则副本、身份说明、同人合并、专业模式清场、
     * 压缩摘要……），谁往里插一格都可能把一对 tool 调用劈成两半 ——
     * 干活鱼2 就是这么一句「LLM HTTP 400」躺了三天的。
     * 与其事后猜，不如出门前照一遍镜子：破了就在日志里指名道姓，
     * 这样下次再有人动拼接逻辑，一眼就能看出是哪一步弄坏的。
     */
    if (process.env.WHALE_DEBUG_WIRE) {
      const bad = [];
      const pending = new Set();
      wireMessages.forEach((m, i) => {
        if (!m) return;
        if (m.role === 'tool') {
          if (!pending.delete(m.tool_call_id)) {
            bad.push('#' + i + ' tool(' + String(m.tool_call_id ?? '').slice(0, 12) + ') 找不到对应的 tool_calls');
          }
          return;
        }
        if (pending.size) {
          bad.push('#' + i + ' ' + m.role + ' 插进了还没配齐的 tool_calls（欠 ' + [...pending].join(',') + '）');
        }
        if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
          for (const tc of m.tool_calls) if (tc && tc.id) pending.add(tc.id);
        }
      });
      if (pending.size) bad.push('尾巴上还欠结果：' + [...pending].join(','));
      console.log('[wire-check] ' + (bad.length ? '⚠ ' + bad.join(' / ') : '形状 OK'));
    }
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
        /* 【2026-11-03 修·主讲人不是小鱼时，她说的话没署名】
         * 主人 2026-10-28 定过：身份名跟着消息一起存，画的时候直接用这份，
         * 不许看「现在是哪个身份」—— 否则一切换，满屏旧消息的署名全被刷掉。
         * 这条规矩以前只给开场白（2340）、__opMsg（7541）、userMsg（7569）做了，
         * 主人真正说的那些回复一条都没标 —— 落盘时就光秃秃一个 assistant。
         * 前端拿不到 who，只能退回「这一轮谁在说话」的兜底；眼下兜底算得对，
         * 可一旦换人当主讲、或者老消息跨会话重画，旧话就会被顶上新名字。
         * 这里补上：这一轮是谁当主讲，就把名字一起存进消息。
         * 小鱼不标（她就是默认身份，空署名＝小鱼，见 576/607 行那两处约定）。
         */
        if (m.role === 'assistant' && !m._who && !Array.isArray(m.tool_calls)) {
          try {
            const __mid = String(mainAgentId(sessionId, (id) => mateSwitchOn(id, sessionId)) || '');
            if (__mid && __mid !== AGENT_XIAOYU) {
              const __ag = getAgent(__mid);
              if (__ag && __ag.name) {
                m._who = String(__ag.name);
                if (__mid === AGENT_XIAOJING) m._whale = String(__ag.name);
                else m._card = String(__mid);
              }
            }
          } catch { /* 标不上就当小鱼，不影响说话 */ }
        }
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
       * 【这一轮没有人替主人答，就照常自己答】—— 2026-10-30 改
       *
       * 以前这里有一条「点名小鲸 → 小鱼整轮让开」，主人 2026-10-30 明确要删：
       * 「把念到小鲸名字你就不说话这种类型设定删了」。
       * 现在没有了：名字只当普通字眼看，我照常答；她开不开麦只由她自己的开关决定。
       */

      /**
       * 【2026-11-01 主人要：按竖列顺序说话 · 排在小鱼上面的人先说】
       *
       * 主人原话：「我希望是排序在上面的先说话」。
       *
       * 难点：小鱼是这一轮的主声，她的回答在主流程里跑完才轮到群聊段。
       * 竖列里排在她上面的人，必须在她之前开口，否则「排序决定先后」对小鱼不成立。
       *
       * 做法：在她开跑之前，先让「排在她上面 + 开着 + 这轮没说过」的人各说一句。
       * 落盘/推流沿用群聊那套（role:'user' + _who），所以翻历史时看得出是谁说的。
       */
      try {
        /**
         * 【resume 时不开口】—— 2026-11-01 严检第二轮
         *
         * resume = 接着已经落盘的历史继续跑（插话之后用），主人并没有说新话。
         * 这时候再把上面的人各喊一遍，等于他们无缘无故又重复一次。
         * 6728/6769/6802 行都明确写着「resume 不做这些」，这里跟着守同一条规矩。
         */
        /* 【2026-11-09 主人重做·这段整个停用】
         * 旧口径是「排在小鱼上面的人先开口」，因为小鱼写死当主声。
         * 新口径：名单第一个开着的**就是**主智能体 A，她必须最先说
         * （A 看主人 → B 看主人+A → C 看主人+A+B）。A 上面没人，
         * 所以这段没有存在意义，留着只会让 B 抢在 A 前面、破坏链式可见。
         * 真要回退用 XY_LEGACY_ABOVE=1，默认永不触发。 */
        if (process.env.XY_LEGACY_ABOVE === '1' && process.env.GROUP_CHAT !== '0' && !resume) {
          const _order = groupAgentIds(sessionId).map((x) => String(x));
          const _fishAt = _order.indexOf(String(AGENT_XIAOYU));
          const _above = _order.filter((id, idx) => {
            if (_fishAt < 0) return true;          // 名单里没有小鱼：全算上面
            return idx < _fishAt;
          });
/** 只要真能说话的（开着、不是小鲸那种叫才应、也不重复点名挑） */
          const _cands = _above
            .filter((id) => id !== String(AGENT_XIAOYU))
            .filter((id) => {
              try { return mateSwitchOn(id, sessionId); } catch { return false; }
            })
            /**
             * 【2026-11-10 拆·艾特删除后这条成了坑】
             *
             * 原来这里：quiet 名单里的人，只有这句话里**出现她的名字**才让她开口。
             * 主人当天删掉艾特功能，界面上那个勾选框也撤了 —— 于是这条规则只剩半个身子：
             * 主人再也设不了它，但老配置里勾过的人会**永远不说话**，
             * 而且他在界面上找不到任何开关可以打开（勾选框没了）→ 典型的「查不出来的哑巴」。
             *
             * 现在直接放行：开着的牌都说话。字段留着不删（老会话文件里还有），但不再挡人。
             * 要恢复艾特时，从 git 历史（v0.9.46）把这段拿回来即可。
             */
            .filter(() => true)
            /**
             * 【小鲸刚才要是已经答过，就别再喊她一遍】—— 2026-11-01 严检补
             *
             * whaleMaybeReply 在主流程前面就调过了；她要是开了口，
             * 群聊段靠 whaleSpokeThisTurn 拦住她。我这一段在更后面，
             * 不做同样的判断，她就会**说两遍**。
             */
            .filter((id) => {
              if (String(id) !== String(AGENT_XIAOJING)) return true;
              try { return !whaleSpokeThisTurn(sessionId); } catch { return true; }
            });
          try {
            console.log('__DBG_CANDS ' + JSON.stringify({ order: _order, fishAt: _fishAt, above: _above, cands: _cands }));
          } catch {}
          if (_cands.length) {
            const { speakAsCard } = await import('./group.mjs');
            for (const _id of _cands) {
              if (ac.signal && ac.signal.aborted) break;
              const _agent = getAgent(_id);
              if (!_agent) continue;
              try {
                const _out = await speakAsCard({
                  agent: _agent,
                  messages: session.messages,
                  sessionId,
                  signal: ac.signal,
                });
                const _said = String((_out && _out.text) || '').trim();
                if (!_said) continue;
                groupSpokeThisTurn.add(String(_id));
                /**
                 * 【落盘标记要跟群聊段一致】—— 2026-11-01 严检补
                 *
                 * 群聊段写的是 _card（自建卡的身份证）+ _who（署名）；
                 * 只有小鲸才写 _whale。上一版不分青红皂白全塞 _whale，
                 * 会让前端和后续判断把她当成小鲸。
                 */
                const _isWhale = String(_id) === String(AGENT_XIAOJING);
                const _msg = {
                  role: 'user',
                  content: '[' + _agent.name + '] ' + _said,
                  at: Date.now(),
                  _who: _agent.name,
                };
                if (_isWhale) _msg._whale = _agent.name;
                else _msg._card = String(_id);
                session.messages.push(_msg);
                try { saveSession(session); } catch {}
                try { send({ type: 'agent', agentId: _id, who: _agent.name, text: _said }); } catch {}
              } catch (_e) {
                try { console.warn('[order] 上面的人没说出来：', String(_e && _e.message ? _e.message : _e)); } catch {}
              }
            }
          }
        }
      } catch (_e) {
        try { console.warn('[order] 提前开口这步出错（不影响小鱼照常答）：', String(_e && _e.message ? _e.message : _e)); } catch {}
      }
      /* 【2026-11-01 主人：谁排第一谁就是这屋的主智能体】
         干活的这张卡由名单决定，不再写死小鱼。mainAgentId 返回名单里第一个「开着」的人；
         空串表示是小鱼（沿用老约定）。拿不到就退回小鱼，绝不让这一轮因为身份问题挂掉。 */
      let __mainIdForTurn = '';
      try { __mainIdForTurn = String(mainAgentId(sessionId, (id) => mateSwitchOn(id, sessionId)) || ''); } catch { __mainIdForTurn = ''; }
          /* 2026-11-02 前端卡死修复：碎片合并累加器（本轮专用） */
          const _opAcc = Object.create(null);
          const _opLast = Object.create(null);
      /* 【2026-11-11 修·stashFile 不许挂到上一轮】本轮起点：此刻最后一条正主 user 消息的下标。
       * 闭包创建时取一次就够 —— runAgent 的 refreshSystem 重建的是 wire（history.slice() 副本），
       * session.messages 不动，这个下标全程安全（scripts/check-stashfile-turn.mjs 第三组钉的就是这条）。
       * 往回找 assistant 时以它封底：本轮还没有自己的回复就老老实实新建一条，
       * 绝不把 worker 发的文件挂到上一轮那句去。 */
      const turnStart = (() => {
        try {
          const ms = session.messages;
          for (let q = ms.length - 1; q >= 0; q--) {
            const m = ms[q];
            if (m && m.role === 'user' && !m.context) return q;
          }
        } catch {}
        return -1;
      })();
      const { usage, lastUsage, files: sentFiles } = await runWithToolContext({ sessionId, snap, signal: ac.signal, outbox: null,
        /* 【2026-11-11 加·askApproval 真注入】
         * 2026-11-10 三方审计抓的静默失效：ui-guard.askApproval 读 exec.askApproval，
         * 可全仓没有任何一方提供这个函数 —— 危险操作全都走「主人没有点头」分支还报绿。
         * 现在在这里把通道接上：SSE 推 ask_approval 给前端 → 前端弹确认框（「她要动：xx」）
         * → 点允许/不许 POST /api/ask-approval → 这里 resolve。
         * 【失败关闭】60 秒没答复 = 不许；这一轮被掐（abort）也算不许 ——
         * 问不到主人就不动，绝不「问不到就自己决定」。 */
        askApproval: ({ toolName, reason }) => new Promise((resolve) => {
          const requestId = 'ask_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          let settled = false;
          const finish = (yes, why) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            PENDING_ASKS.delete(requestId);
            try { console.log('[ask] ' + requestId + ' ui=' + toolName + ' -> ' + (yes ? '允许' : '不许') + '（' + why + '）'); } catch {}
            resolve(yes === true);
          };
          const timer = setTimeout(() => finish(false, '60s 超时'), 60000);
          PENDING_ASKS.set(requestId, finish);
          try { if (ac.signal) ac.signal.addEventListener('abort', () => finish(false, '本轮被掐'), { once: true }); } catch {}
          try { send({ type: 'ask_approval', toolName: String(toolName || ''), reason: String(reason || ''), requestId }); }
          catch (e) { finish(false, 'send 失败：' + String(e?.message || e)); }
        }),
        pushEvent: (ev) => { try { send(ev); } catch {} }, stashFile: (f) => {
        try {
          const ss = (typeof session !== 'undefined' && session) ? session : null;
          if (ss && Array.isArray(ss.messages) && f) {
            /* 【2026-11-11 修·不许挂到上一轮】倒着找 + 以本轮起点封底：
             * turnStart 是闭包创建时记下的「本轮起点」下标。本轮还没有 assistant
             * 就回 -1，走下面「新建一条」的分支。（scripts/check-stashfile-turn.mjs
             * 实测四种判据里只有这个写法 4/4 全对。）
             * 不能用「最后一条 user 之后」——主人中途插话（steer 会 push 一条 user）
             * 会把本轮最终回复排除掉；也不能从 turnStart 往后找第一条——
             * 会命中工具调用那条哑巴 assistant。 */
            let ix = -1;
            for (let q = ss.messages.length - 1; q >= Math.max(0, turnStart); q--) {
              const m2 = ss.messages[q];
              if (m2 && m2.role === 'assistant' && !m2.context) { ix = q; break; }
            }
            if (ix < 0) { ss.messages.push({ role: 'assistant', content: '', at: Date.now() }); ix = ss.messages.length - 1; }
            const pv = Array.isArray(ss.messages[ix]._out) ? ss.messages[ix]._out : [];
            if (!pv.some((x) => x && x.key && f.key && x.key === f.key)) {
              pv.push(f);
              ss.messages[ix]._out = pv;
              try { saveSession(ss); } catch {}
            }
          }
        } catch {}
      } }, () => runAgent({
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
        // 【她中途也能插一句话 —— 2026-11-01 主人报】
        // 主人原话：「事实上，在你说话工作过程中，其他智能体说不了话，发不出来消息」
        // 以前她只在收尾时被叫一次，我开长活就几十分钟没人问她 —— 不是她不说，是没人问。
        // 这里每轮调模型前敲一下，节流由 lastWhaleTickAt 兜住（见下），不许连累这一轮。
        onRoundTick: async ({ round }) => {
          try {
            if (!whaleOn(sessionId)) return;
            /**
             * 【2026-11-11 修·主人报「只开小鲸时她连回两条」】
             *
             * 这一轮的主智能体本来就是她的时候，她正在正常回答，
             * 再叫她「看进度说一句」= 让她自己跟自己说第二轮，屏幕上就是两条
             * （截图：一条「愣了一下，尾巴尖慢慢翘起来」，一条「听到这三个字，顿了一下」）。
             *
             * 口径跟收尾那个插话闸、跟 runAgent 的 agentId 用同一个 __mainIdForTurn。
             */
            if (String(__mainIdForTurn || '') === AGENT_XIAOJING) return;
            const now = Date.now();
            // 节流：至少隔 120 秒，且最多每 3 轮敲一次 —— 别每轮都叫她（烧钱又吵）。
            if (now - lastWhaleTickAt < 120000) return;
            if (round % 3 !== 0) return;
            lastWhaleTickAt = now;
            await whaleMaybeReply({
              session,
              userText: '',
              send,
              sessionId,
              live,
              speaksToHer: false,
              extraRule: '（这是我干活干到一半，不是你刚说完话。看着进度，想说一句就说，没什么想讲就一个字都别回。）',
            });
          } catch (e) {
            try { console.warn('[whale] 中途插话失败：', String(e?.message ?? e)); } catch {}
          }
        },
        // 没喊别的安全词就是「待在当前档」——新会话天然是「人设」档；
        // 喊了别的词就临时切过去，这句话说完仍继续保持那一档，直到再切回来。
        /* 【2026-11-01 主人：谁排第一谁就是这屋的主智能体】这一轮用哪张卡的身份干活 */
        agentId: __mainIdForTurn,
        safeMode: modeInfo.switched,
        safeWord: modeInfo.word || '',
        signal: ac.signal,
        onEvent: (ev) => {
          // 边收边存草稿：进程被杀 / 断电时，已经说出来的字不至于全丢。
          // 正式历史仍然只在整轮跑完后接（commitWireBack），草稿只是保险。
          if (ev.type === 'text') {
            /* 【2026-11-02】notice（连接断了 / 工具还在跑 / 量了量 token）是提醒，不是她说的正文。
             * 记进草稿的话，刷新后草稿被灌回气泡，屏幕上就是「一句话说到半截换行」。
             * 正文照旧记，提醒丢掉。 */
            if (ev.notice) { /* 只发不记 */ }
            else {
            // 【2026-10-31 拦截内联大图】
            // 有的生图模型不在 /images/generations 出图，而是把整张 PNG 的 base64
            // 塞进聊天正文：![image_1](data:image/png;base64,...) —— 一次能到 266 万字符。
            // 直接放进 draftText 会：①界面涌出一堆英文字母 ②上下文被撑爆 ③每段都重写盘，卡死。
            // 这里当场把这种内联图抠出来存文件，正文里只留一句人话。
            if (ev.text && ev.text.indexOf('data:image/') >= 0) {
              try {
                const _ex = extractInlineImages(String(ev.text), 'inline');
                if (_ex.images.length) {
                  for (const im of _ex.images) {
                    try { sentFiles.push({ path: im.path, kind: 'image' }); } catch {}
                  }
                  ev = { ...ev, text: _ex.text };
                }
              } catch {}
            }
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
          else if (ev.type === 'reasoning' || ev.type === 'text') {
            /* 【2026-11-02】提醒单独发、不攒进 _opAcc —— 攒进去就跟正文粘成一段，
             * 前端再也分不出哪句是提醒，只能整段当正文画（就是那个「中途换行」）。 */
            if (ev.notice) { send({ type: 'text', text: ev.text, notice: true }); }
            else {
            // 2026-11-02 前端卡死修复：碎片合并
            const _k = ev.type;
            _opAcc[_k] = (_opAcc[_k] || '') + String(ev.text || '');
            const _n = Date.now();
            /* 【2026-11-02】阈值别太保守。原来 60 字 / 250ms —— 短回复（「好的」
             *  两个字）攒不满，得等整轮收尾才一起冲出去，界面那段是空的，
             *  看着就是「话说一半没下文」。降到 24 字 / 120ms：字出来得跟手，
             *  事件数还是比逐字推少一个数量级。 */
            if (_opAcc[_k].length >= 24 || _n - (_opLast[_k] || 0) >= 120) {
              send({ type: _k, text: _opAcc[_k] });
              _opAcc[_k] = '';
              _opLast[_k] = _n;
            }
            }
          }
          else if (ev.type === 'sentfile' && ev.file) {
            /* 【2026-11-06 主人报「文件根本没出现在聊天界面」】
             *  病根：send_file 工具是往 pushEvent 里推 { type:'sentfile' } 的，
             *  但上面这张 onEvent 只认 text/reasoning/tool_start/tool_end ——
             *  sentfile 落到 else 外面，一个分支都不命中，直接被丢掉。
             *  前端 index.html 里那段 ev.type === 'sentfile' 永远收不到，卡片自然画不出来。
             *  补上：照样先 flush 攒着的碎片，再原样转给前端。 */
            for (const _k of ['reasoning', 'text']) {
              if (_opAcc[_k] && _opAcc[_k].length) { send({ type: _k, text: _opAcc[_k] }); _opAcc[_k] = ''; }
            }
            send({ type: 'sentfile', file: ev.file, note: ev.note || '' });
          }
          else if (ev.type === 'tool_start' || ev.type === 'tool_end') {
            /* 【2026-11-02 主人报「消息显示不全、文字和工具条串在一起」】
             *  碎片合并会把 text/reasoning 攒在 _opAcc 里。工具事件一到，
             *  如果先发工具条再发文字，画面上就变成「工具条插在句子中间」。
             *  所以发工具事件之前，先把攒着的碎片按原顺序冲出去。 */
            for (const _k of ['reasoning', 'text']) {
              if (_opAcc[_k] && _opAcc[_k].length) { send({ type: _k, text: _opAcc[_k] }); _opAcc[_k] = ''; }
            }
            if (ev.type === 'tool_start') send({ type: 'tool_start', id: ev.id, name: ev.name, args: ev.args });
            else send({ type: 'tool_end', id: ev.id, name: ev.name, ok: ev.ok, output: ev.output, images: ev.images || 0 });
          }
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
      /* 2026-11-02：收尾 flush —— 最后那点没攒够 60 字的碎片必须补发，
       *  否则屏幕上会少掉尾巴上的几个字（看着像被截断）。 */
      try {
        for (const _k of ['reasoning', 'text']) {
          if (_opAcc[_k] && _opAcc[_k].length) { send({ type: _k, text: _opAcc[_k] }); _opAcc[_k] = ''; }
        }
      } catch {}
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
        /* 【功能开关：长期记忆】关着就不写。关掉之后既不该读也不该记 —— 只写不读就是黑洞，本子还会被悄悄改动。
         * 【2026-11-10 按会话】改成问**这个会话**。原来读全局：主人在会话里把记忆关了，
         * 工具层已经拦住 memory_add，可这道 digest 闸还认为「开着」，
         * 每轮照样往本子里写 —— 主人以为关干净了，本子还在被悄悄改。 */
        if (featureOnFor(sessionId, 'memory') === false) throw { __skip: 1 };
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
          if (!/^[【〔\[]/.test(String(said || '').trim())) { appendDigest(sessionId, line); }
          /**
           * 【同时把这一轮收进「当前状态」】—— 2026-11
           *
           * 实测 154 个本子 153 个固定记忆区空着。空着不只是难看：
           * persona 每轮都把这一块发给她，四个标题横在那里一个字没有，
           * 她读到的就是「我有个本子但里面什么都没记」。
           *
           * 为什么只写「当前状态」不写别的：四个小节里只有它是「滚动的」
           * —— 任务目标、约束偏好、待办都得靠判断才能写对，程序瞎填只会填错。
           * 它们留给她自己用 write_file 写（提示词里现在给的是真路径）。
           *
           * 只保留最新的几条：「当前状态」越堆越长就不叫当前了。而且同一句不重复写。
           */
          // （重复的那段过滤已删，上面那处 if 就是唯一入口）
          
        }
      } catch (e) {
          if (!e?.__skip) console.warn('[memory] 这一轮没记进本子：', String(e?.message ?? e));
          /* 【2026-11-02 修·显示不全】上面那个大 try 里攒着的碎片（_opAcc），
           *  一旦中途抛错就直接跳到这里，收尾 flush 根本轮不上 —— 主人看到的
           *  就是「话说到一半没了，只剩几个碎片」。出错也要把攒着的发出去。 */
          try {
            for (const _k2 of ['reasoning', 'text']) {
              if (_opAcc[_k2] && _opAcc[_k2].length) { send({ type: _k2, text: _opAcc[_k2] }); _opAcc[_k2] = ''; }
            }
          } catch {}
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
          let target = null;
          for (let i = history.length - 1; i >= 0; i--) {
            const m = history[i];
            if (!m || m.role !== 'assistant' || m.context) continue;
            // 只挂这一轮新接进来的那条，别糊到上一轮的回复上
            if (seenBefore.has(m)) break;
            target = m;
            break;
          }
          /**
           * 【2026-11-08 修·「柜子里没有思考链」的真因】
           *
           * 主人反复问：「柜子里没有思考链，柜子上却写『想了 1 段』」。
           *
           * 查下来：写入条件太苛刻 —— 只认「这一轮**新加**的 assistant 消息」。
           * 可一轮里很常见只有工具调用、没有新的说话（或者最后那条早就在
           * seenBefore 里），循环第一脚就 break，`target` 一直是 null，
           * 思考整段丢掉。实测那个 99 条 assistant 的会话，**一条 reasoning 都没有**。
           *
           * 退一步：找不到「这一轮新的」，就挂到当前会话最后一条非 context 的
           * assistant 上。位置可能不完美，但比丢掉强 —— 界面上那个折叠块
           * 就是根据这个字段画的，没有字段就整块消失。
           */
          if (!target) {
            for (let i = history.length - 1; i >= 0; i--) {
              const m = history[i];
              if (!m || m.role !== 'assistant' || m.context) continue;
              target = m;
              break;
            }
          }
          if (target) {
            target._reasoning = draftReasoning.trim();
            try { console.log('[reasoning] 已存 ' + target._reasoning.length + ' 字'); } catch {}
          } else {
            try { console.warn('[reasoning] 没找到可挂的 assistant，' + draftReasoning.length + ' 字丢掉'); } catch {}
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
            /**
             * 【2026-11-01 修·ask_subagent 说的话永远落不了盘】
             *
             * 主人报了两次「等好一会才同步、不确定中间的话丢没丢」，根子就在这。
             *
             * 原来这里不看情况，一律整批丢掉。理由是「whaleMaybeReply 已经播过、落过盘了，
             * 这里再播一次就重复」—— 这个理由对【她主动开口】那条路是成立的，
             * 可 ask_subagent（我叫她跑腿）走的根本不是那条路：
             *
             *   subagent.mjs 里 pushWhaleSays() 把她的结论塞进信箱
             *   → whaleMaybeReply 从头到尾没参与
             *   → 唯一能接住她的就是这里
             *   → 结果被当成「重复」整批扔掉。
             *
             * 表现：她的话推到了界面（看得见），但会话文件里一条都没有（刷新就没了）。
             *
             * 现在按「这轮她到底走没走过 whaleMaybeReply」分流：
             *   走过  → 说明它已经落盘了，这里的确实是重复，丢掉（原逻辑）
             *   没走过 → 这些话没人接，交给 landWhaleSay 落盘
             */
            const spokeByMaybe = (() => {
              try { return !!whaleSpokeThisTurn(session); } catch { return false; }
            })();
            if (spokeByMaybe) {
              console.log('[whale] 信箱里还有 ' + leftover.length + ' 句 —— whaleMaybeReply 已落盘，丢弃避免重复');
            } else {
              let landed = 0;
              for (const one of leftover) {
                const t = String((one && one.text) || '').trim();
                if (!t) continue;
                try {
                  landWhaleSay({ session, sessionId, text: t, send: (typeof send === 'function' ? send : null), live: null });
                  landed++;
                } catch (e) {}
              }
              console.log('[whale] 信箱里 ' + leftover.length + ' 句 → whaleMaybeReply 没跑，已补落盘 ' + landed + ' 句');
            }
          }
        } catch (e) {
          console.warn('[whale] 清信箱失败：', String(e?.message ?? e));
        }
      }
      // 「发文件」发出去的东西挂到最后那条助手消息身上：
      // 跟着会话一起落盘，重开窗口还画得出来；点一下就能预览 / 下载。
      /* 【2026-10-30 主人原话】「中途退出重启相当于打断，也不会显示你发的任何文件」
       * 原来这段只在「这一轮正常跑完」时才执行 —— 点停止、中途重启、断线全跳过，
       * 画好的图 / 发出去的文件就凭空消失了（文件其实在盘上，只是没记进会话）。
       * 现在：找不到落脚点就自己补一条助手消息，绝不因为「没地方挂」而丢掉。 */
      {
        const sent = Array.isArray(sentFiles) ? sentFiles.filter(Boolean) : [];
        if (sent.length) {
          const msgs = session.messages;
          let idx = -1;
          for (let k = msgs.length - 1; k >= 0; k--) {
            const m = msgs[k];
            if (m && m.role === 'assistant' && !m.context) { idx = k; break; }
          }
          if (idx < 0) {
            msgs.push({ role: 'assistant', content: '', at: Date.now() });
            idx = msgs.length - 1;
          }
          // 合并而不是覆盖：同一轮可能分几次发，前一批不能被后一批冲掉。
          const prev = Array.isArray(msgs[idx]._out) ? msgs[idx]._out : [];
          const merged = prev.slice();
          for (const it of sent) {
            const dup = merged.some((x) => x && x.key && it && x.key === it.key);
            if (!dup) merged.push(it);
          }
          msgs[idx]._out = merged;
          // 顺手在会话记忆本子里记一笔：消息万一丢了，记忆里还留着
          try {
            /* 【2026-11-10 按会话】同上：发文件补记也按这个会话的记忆开关 */
            if (featureOnFor(sessionId, 'memory') === false) throw { __skip: 1 };
            const names = sent.map((x) => String(x?.name || '文件')).join('、');
            appendDigest(sessionId, `发了文件：${names}`);
          } catch (e) {
            if (!e?.__skip) console.warn('[sendfile] 记忆本子没记上：', String(e?.message ?? e), 'sessionId =', sessionId);
          }
          send({ type: 'files', items: sent, at: idx });
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
      const modelBeforeTurn = (() => {
        try { return modelUsedThisTurn(sessionId); } catch { return ''; }
      })();
      /**
       * 【2026-11-02 补的洞】这一轮**真正在用的**模型名。
       *
       * 上面那个 modelUsedThisTurn 走的是「会话里选的那个模型 → 全局默认」，
       * 跟 llm.mjs 里真正发请求的那套优先级一致 —— 它拿到的是**这一轮起点**的真名。
       * 循环里要是中途被切了模型，末尾再用它算钱，价目就会对不上账。
       * 所以两处都记：起点拿得到就用起点，拿不到再退回「最后一圈」那个老办法。
       */
      let turnModel = '';
      /* 【2026-11-01】这一轮真正跑的那条配置 id —— 算钱要按它查，不能按模型名猜（同名三条价差十倍）。 */
      let __cfgIdForUsage = '';
      try { const _lm = await import('./llm.mjs'); __cfgIdForUsage = String(_lm.configIdForSession(sessionId) || ''); } catch {}
      try { turnModel = String(modelBeforeTurn || '') || String(modelUsedThisTurn(sessionId) || ''); } catch {}
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
          // 这一条 user 已经存过用量了（前端重发同一个请求、断线自愈重放等）：
          // 别拿新一轮的数覆盖 → 一个气泡底下会出现两行、两行数字还不一样。
          // 2026-11-02 修：主人看到「同一块下面挤两行」，一笔是历史补画的。
          if (userMsgRef._usage && !body?.forceUsage) throw { __usageAlreadyStored: true };
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
            /* 【2026-11-05 加】这一轮跑了多久（毫秒）。
             * 必须显式列进来：下面这个对象是**逐字段白名单**，不在名单上的字段一律丢掉。
             * 第一次加的时候漏了这一步，结果只有「刚跑完那一瞬间」有时长，
             * 一刷新 / 一切会话再回来就没了 —— 因为重绘是从会话文件里的 _usage 读的。 */
            _ms: Number(usage._ms ?? 0),
            // 缓存命中：以前这里固定取 `usage.prompt_cache_hit_tokens`，最外层那个对象 ——
            // 可 agent.mjs 的 sumUsage 只累加了三个数（prompt/completion/total），
            // 缓存字段压根没往上并，所以这里**永远是 0**。
            // 0 传下去，前端就只能当成「接口没报缓存」，退回按 98% 估。
            // DeepSeek 其实一直在报（prompt_cache_hit_tokens / prompt_cache_miss_tokens），
            // 全被丢在半路上了 —— 2026-11-02 把井挖通。
            prompt_cache_hit_tokens: Number(
              usage.prompt_cache_hit_tokens ?? lastUsage?.prompt_cache_hit_tokens ?? 0,
            ),
            prompt_cache_miss_tokens: Number(
              usage.prompt_cache_miss_tokens ?? lastUsage?.prompt_cache_miss_tokens ?? 0,
            ),
            model: turnModel,
            /* 【2026-11-01】这一轮真正跑的那条配置的 id。
               光有模型名不够 —— 同名三条价差十倍，前端拿名字猜会算错钱。
               有了 id，前端能精确找到主人填的那几个数。 */
            configId: String(__cfgIdForUsage || ''),
            at: Date.now(),
          };
          saveSession(session);
        } catch (e) {
          if (!e || !e.__usageAlreadyStored) {
            console.warn('[usage] 用量没存下来：', String(e?.message ?? e), 'sessionId =', sessionId);
          }
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
          /**
           * 【2026-10-30 修：小鲸/自建智能体插过一句，我的正文就补不回来了】
           *
           * 主人报：干活时刷新屏幕，界面停在半截（工具显示"完成"、话断成两截），
           * 之后越刷越坏，要反复刷新才恢复。
           *
           * 查到根就在这里：老代码写的是「碰到 role:user 就 break」—— 那是在认「主人又开口了，
           * 这一轮到我这儿为止」。可群里别人（小鲸、自建智能体）的话，是刻意按
           * role:'user' + _who 存的（见下面那段说明）。
           * 于是只要她们这一轮插过一句，收集就提前断了，我后面的正文全被漏掉，
           * done 里的 turnTexts 缺段 → 前端补画时没东西可补 → 屏幕停在半截，非刷新不可。
           *
           * 现在改成：带 _who / _card / _cardVoice 的 user 消息不算「主人开口」，继续往下收；
           * 只有真正的用户消息才 break。
           */
          if (m.role === 'user') {
            const card = m._who || m._card || m._cardVoice;
            if (!card) break;      // 真·主人开口了，这一轮到此为止
            continue;              // 别人插的话不算正文，也不截断
          }
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
          /* 2026-11-02 主人第三次说同一句话，这回不再自作聪明：
             「我不懂什么主声副声，我只知道按钮关了就是她不说话了，按钮开了就是她会说话」。

             所以这里只有一条规矩：**顶栏那颗按钮说关，她这一轮就不许说话**。
             · 小鲸 → whaleOn(sessionId)
             · 小鱼 → fishOn(sessionId)（她本来就不在 roster 里，剔掉只是防着她哪天进来）
             旧的「小鲸不再看 whaleOn、只看她屋里那颗牌」作废 —— 那颗钥匙原来被当成
             「能不能叫出去干活」，主人从来没这么用，她指的是「她在不在场」。

             【2026-11-09 主人重做·接话名单动态化】
             以前写死「排除小鱼」—— 可主智能体是「从上往下第一个开着的」，
             她未必是小鱼。主智能体换成别人时，小鱼被白白剔掉、
             而真正的主智能体又被当成「补一句的人」再说一遍。
             现在统一：接话名单 = activeAgentIds() 里主智能体**以下**的那些，
             按竖列顺序（A→B→C）依次接话。主智能体这一轮已在上面完整答完。 */
          const _alive = activeAgentIds(sessionId, (id) => mateSwitchOn(id, sessionId));
          const _mainId = String(_alive[0] || '');
          let _mainName = '';
          try { _mainName = String((getAgent(_mainId) || {}).name || '').trim(); } catch {}
          const roster = _alive.slice(1)
            .map((id) => getAgent(id))
            .filter(Boolean);
          const switchOn = (id) => {
            if (id === AGENT_XIAOJING) {
              try { return whaleOn(sessionId); } catch { return false; }
            }
            if (id === AGENT_XIAOYU) {
              try { return fishOn(sessionId); } catch { return true; }
            }
            return isGroupMemberEnabled(id, sessionId);
          };
          const enabledIds = roster.map((a) => String(a.id)).filter((id) => switchOn(id));
          // 「别一直全员齐发」：点名只让被点的接；没点名就看「个性」那个勾。
          // 认的是 `@名字`（见 group.mjs 的 pickSpeakers），不认「句子里出现过名字」——
          // 那样「阿绿昨天说的办法」会把她拽出来重答一遍。
          const { speakAsCard, pickSpeakers, nextAllowedIds } = await import('./group.mjs');
          const heard = String(lastUserTextOf(session) || '');
          /* 记住@的人·2026-10-29 / 2026-11-01 改口径：@ 了没打勾的人 → 之后一直只留他们；
             @ 的只是打勾的人 → 说完这句就撤，不立规矩。 */
          const prevAllowed = allowedSpeakersOf(sessionId);
          /* 2026-11-10 艾特删除：quietIds 已不参与判断，不再取也不再传 */
          const speakers0 = roster.length
            ? pickSpeakers({ roster, userText: heard, allowedIds: prevAllowed, enabledIds, keepOrder: true })
            : [];
          /**
           * 【这一轮已经开过口的人，群聊不再喊一遍】—— 2026-11-03
           *
           * 主人报「同时开小鱼和小鲸，小鲸说两轮、小鱼一句话不说」：
           * 当年是「点了小鲸 → 小鱼让开」（那条路 2026-10-30 已删）→ 让开时已经把小鲸叫起来答了一轮；
           * 可走到这里，她又因为「个性没打勾 = 每轮都说」被列进 speakers，于是同一句再答一遍。
           *
           * `groupSpokeThisTurn` 是这一轮里「已经以自己身份说过话」的集合，
           * 让路那一刻往里面记一笔。这里把人剔掉 —— 一次发言只留一个声音。
           * 剔空了也不慌：上面那句已经由让路那条路说了，主人不会看到一片安静。
           *
           * 【2026-11-03 第二道锁：她还可能从别的通道说过】本地集合只管得住
           * 这一条主流程。所以再看一眼会话上的时间戳（whaleSpokeThisTurn）——
           * 那是她所有说话路的公共出口打的，谁说的都能看见。
           */
          let speakers = speakers0.filter(
            (a) => !groupSpokeThisTurn.has(String(a.id))
              && !(String(a.id) === AGENT_XIAOJING && whaleSpokeThisTurn(session)),
          );
          /**
           * 【2026-11-05 加·办事模式下最多两个声音】
           *
           * 主人报「办事模式特别慢，不如不开」。
           *
           * 慢的一半是上下文（已收窄），另一半是**串行**：每个 speaker 一次完整 chat()，
           * 而且每次都带一整套人设 —— 三个 speaker 就是三次排队。
           *
           * 这里不碰顺序（后面的还得看到前面说的），只**限制说话的人数**：
           * 办事模式本来就是一个主 + 几个干活的，干活的人不需要人人都开口。
           * 前两个说，剩下的这一轮只听 —— 话少一半，时间也少一半。
           */
          try {
            const _ti = taskInfo(sessionId);
            if (_ti && _ti.on) {
              /**
               * 【2026-11-06 改·办事模式下别人不再挨个补一句】
               *
               * 主人要的是「办事模式做事比正常快」。上一版只是把 3 个声音压到 2 个，
               * 可真正贵的地方在于：**每一个 speaker 都是一次完整 chat()**，
               * 带着整套人设 + 十几条历史，串行排队。
               *
               * 而这一轮本来就有人说过话了 —— 小鱼的回答在群聊这段之前已经完整说完，
               * worker 的汇报也已经以 worker 事件推给主人看过了。
               * 再让旁人来补一句，纯属「开完会轮流发言」，一个字的信息都不多，时间却翻倍。
               *
               * 【2026-11-10 艾特删除后的修正 · 这条不改就是永久静音】
               * 原来判据是「只有被 @ 到的人才接话」，而 @ 已经不认了 ——
               * `_named` 会恒空、speakers 归零，**办事模式下屋里其他人永远不说话**，
               * 不报错、没日志，主人只会觉得「她们怎么突然不理我了」。
               * 现在按新口径：只留一个声音（竖列顺序第一个），其余不喊。
               */
              speakers = speakers.slice(0, 1);
            }
          } catch (e) { /* 读不到状态就按原样放行 */ }
          if (speakers.length) {
            try {
              /* 2026-11-10 艾特删除：nextAllowedIds 已不再需要 quietIds
               * （原来这里还传了一个 quietIds，而那个变量在同一次改动里被删掉了，
               *   于是这一行每轮静默抛 ReferenceError —— 被 catch 吞掉，
               *   setAllowedSpeakers 一次都没执行过，agents.json 里的旧名单永远清不掉。）
               * 形参有默认值，少传就是 []，行为不变。 */
              setAllowedSpeakers(sessionId, nextAllowedIds(prevAllowed, heard, roster));
            } catch { /* 存不上不影响这一轮 */ }
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
                  mainName: _mainName,
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
              /**
               * 【她说的不是「主人说的」—— 2026-11-01 主人报】
               *
               * 主人原话：「为什么小鲸的第一句话，名字样式与消息样式和我说话消息一样，
               * 是名字白色、消息灰框？」
               *
               * 真因就在下面这几行：原来写的是 role:'user'。前端画 user 消息一律用
               * 『主人的气泡』那套（名字白、灰底框），所以 _who 虽然把名字换成了小鲸，
               * 样式还是主人那一套 —— 同一个人前后两种长相。
               *
               * 改成 assistant + _whale：走的就是她正常说话那条渲染路径（冷蓝名字、
               * 不着框），跟主流程 1487 行那条 _whale:'小鲸' 完全一致。
               *
               * 模型那边看到的效果不变：wire 层仍然按「这段是别人说的话」塞进上下文，
               * 跟原来 role:'user' 时一样，不会因为她改了个 role 就听不懂谁在说。
               */
              session.messages.push({
                role: 'assistant',
                content: said,
                _text: said,
                _whale: nm,
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
      // 报给前端的模型名＝这一轮真正在用的那个（上面那一处算过的 turnModel）。
      // 以前这里是 modelUsedThisTurn()，拿到的是「最后一圈」的模型，跟开头未必是同一个，
      // 前端拿它去对价目表就可能对不上 → 只报 token 不报钱。
      /* 【2026-11-03 加·把这一轮的子任务流水钉进历史】
       * 办事模式的「谁干了什么」只活在内存事件流里，这一轮一完事件流就换 ——
       * 主人看到的就是「派活 运行中…然后没了」。这里在收尾那一刻把它写到
       * 最后一条助手消息上（_workers），历史就成了唯一权威：
       * 翻回来、刷新、换会话再看，卡都还在。 */
      try {
        const _ws = workersSnapshot(sessionId);
        if (_ws.length) {
          for (let _q = session.messages.length - 1; _q >= 0; _q--) {
            const _m = session.messages[_q];
            if (_m && _m.role === 'assistant' && !_m.context) { _m._workers = _ws; break; }
          }
          try { saveSession(session); } catch (e) {}
        }
      } catch (e) {}
      send({ type: 'done', usage, at: doneAt, model: turnModel || modelUsedThisTurn(sessionId), turnTexts });
    } catch (err) {
      // 用户点了「停止」：不是错误，照实报一句就收尾。
      if (ac.signal.aborted) {
        /**
         * 【2026-11-11 修·点停止把她已经说出来的话整段抹掉】主人原话：
         * 「出现【停止】的系统提示后，整个上下文会突然一变，我说的话会出现在最下方，
         *   我说的话后面没有她说的话，就好像只有我说了话而她之前说过的话都被吞了一样」
         *
         * 病根：正常收尾那三步（flush 碎片 → commitWireBack → saveSession）在
         * `await runAgent(...)` **之后**；而停止是 agent 抛异常跳到这里 ——
         * 三步全被跳过，历史里只剩主人的问题，磁盘上一个字都没有。
         * 屏幕上那 350 字本来是 SSE 推出来的，前端随后用历史整屏重画，
         * 历史里没有 → 全消失。主人看到的就是「她说过的话都被吞了」。
         *
         * 修法：停止也走同样的收尾 ——
         *   ① 剩下的碎片补发给前端（屏幕不缺尾巴）
         *   ② wire 里已经齐的照常接回历史
         *   ③ wire 没接到的（模型正吐字就被掐）从草稿接 —— 草稿（draftText）
         *      每个流出的字都进了，是这一轮最完整的记录
         *   ④ 落盘 + 清草稿
         */
        try { commitWireBack(); } catch {}
        try {
          /* 半截话从草稿接回历史 —— 跟「关机后恢复」是同一条路（:7418 那段）。
           * 只在「这一轮还没有任何 assistant 落过历史」时才接，避免跟
           * commitToolsNow 已落的前几段拼成重复。 */
          const _d = readDraft(sessionId);
          const _body = String((_d && _d.text) || '').trim();
          if (_body) {
            const _s = getSession(sessionId);
            if (_s && Array.isArray(_s.messages)) {
              // 本轮起点 = 最后一条非 context 的 user
              let _lastUser = -1;
              for (let _q = _s.messages.length - 1; _q >= 0; _q--) {
                const _um = _s.messages[_q];
                if (_um && _um.role === 'user' && !_um.context) { _lastUser = _q; break; }
              }
              let _landed = false;
              for (let _q = _s.messages.length - 1; _q > _lastUser; _q--) {
                const _am = _s.messages[_q];
                if (_am && _am.role === 'assistant' && !_am.context) { _landed = true; break; }
              }
              if (!_landed) {
                _s.messages.push({ role: 'assistant', content: _body, _text: _body, _stopped: true, at: Date.now() });
                saveSession(_s);
              }
            }
          }
          dropDraft(sessionId);
        } catch {}
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
          startCooldownSafe(newId);

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

          /* 【2026-11-08 根治「消息半路断了」】
           * 出错这句话原来只 send 出去，不进 session.messages。
           * 后果：前端不在这个会话上（切走了 / 断线 / 重启过）就永远看不到 ——
           * 主人看到的画面就停在「我上一条说的话」，后面全丢。
           * 2026-11-08 实测：12:14 跑完全量回归后这一轮被掐，
           * 04:19:55 turn-idle-abort → 04:19:59 stuck-retry（前端不在，没人收）
           * → 04:31:52 重试又撞 HTTP 502 抛到这里。整段十二分钟，界面一个字都没有。
           * 所以：这句话必须落盘。落进历史的东西切会话、刷新、重启都在。
           */
          const errText = String(err?.message ?? err);
          try {
            const _s = getSession(sessionId);
            const _last = (_s && Array.isArray(_s.messages) && _s.messages.length) ? _s.messages[_s.messages.length - 1] : null;
            const _already = !!(_last && _last.__turnErr);
            if (_s && !_already) {
              _s.messages.push({
                role: 'assistant',
                content: '⚠️ 这一轮断在这儿了：' + errText
                  + '\n\n（这一轮没说完，工具结果还在。换个模型试试，或者跟我说一声「接着办」，我照清单往下走。）',
                at: Date.now(),
                __turnErr: true,
              });
              saveSession(_s);
            }
          } catch {}
          /* 【2026-11-10 修·错误提示画两遍】persisted=true 告诉前端
           * 「这条已经落进历史了，你别再自己补一颗」—— 屏幕只认落盘的那一条，
           * 轮末换历史时不闪、不双画。 */
          send({ type: 'error', message: errText, persisted: true });
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
              /* 【2026-11-11】同上去重：reg 和旁路箱里可能是**同一个对象的两份引用**
               * （为防丢两边都存），裸 push 会让她同一句话落两遍 —— 主人报的
               * 「回了 3 句、后两句一模一样」就是这个。 */
              const added = pushParkedUnique(msgs, parked);
              let saved = 'ok';
              try { saveSession(session); } catch (e) { saved = '失败:' + String(e && e.message ? e.message : e).slice(0, 80); }
              try {
                logWhaleAction('补写完成：' + n0 + ' → ' + msgs.length + '（+' + added + '，押了' + parked.length + '条），存盘' + saved);
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
          /**
           * 【压缩过的那一头，一条都不许往回接】2026-10-29 修
           *
           * 「按位置对齐」这条规矩本来是给插话用的，可它跟压缩撞在一起就出事：
           *
           *   压缩把 [start, cut) 折成一条摘要、插在头部后面 —— 公共前缀当场断在第 1 条，
           *   于是「前缀之后这一轮多出来的」就变成了内存里那 500 多条老消息，
           *   一条不落地整段接回压缩后的最新那份 → 2057 条 → 压了个寂寞。
           *   而且摘要会被挤到中间、下一轮再也压不到它，越堆越多。
           *
           * 所以并之前先认出「这一轮是不是刚压过」：
           *   · 内存这份里带 summary 的消息（压缩产物）数量比磁盘那份**多** —— 是这一轮压的；
           *   · 或者磁盘那份里有 summary、内存这份没有 —— 是别的路压的，这边更得让。
           * 只要认出来，就只允许接「压缩点之后新长出来的那几条」：
           *   以内存这份里最后一条 summary 为界，它前面的老消息一律不接。
           *
           * 没压缩的普通收尾（插话把话补回来那条路）完全不受影响：一份 summary 都没有，
           * `cutAt` 就是 0，行为跟以前一模一样。
           */
          const countSummary = (arr) => arr.reduce(
            (n, m) => n + (m && m.summary && m.context ? 1 : 0), 0,
          );
          const sumMem = countSummary(session.messages);
          const sumDisk = countSummary(latest.messages);
          let from = common;
          if (sumMem > 0 || sumDisk > 0) {
            /**
             * 认出来了：这一轮（或别的路）动过压缩，那就**只接压缩之后新长出来的那一段**。
             *
             * 判据是「连续」：从公共前缀往后走，找到的位置必须一路到尾都是磁盘里没有的，
             * 才算新尾巴。中间只要又撞上一条磁盘里有的，说明这段里头掺着老消息
             * （压缩把长度改了，老消息在两边对不上号），这种情况一律整段不接。
             *
             * 三条场景说明为什么要这么严：
             *   · 压缩后啥也没说 → 后面全是老消息，找不到干净的新尾巴，接 0 条 ✔
             *   · 压缩后说了 3 句 → 那 3 句连着，接 3 条 ✔
             *   · 压缩后说了 3 句又聊了几句（新老交替）→ 宁可这一段不接，
             *     也不能把老消息接回去把压缩推翻 —— 那一轮的话下轮还会再说。
             */
            const inDisk = new Set(latest.messages);
            from = session.messages.length;
            for (let i = common; i < session.messages.length; i++) {
              let clean = true;
              for (let k = i; k < session.messages.length; k++) {
                if (inDisk.has(session.messages[k])) { clean = false; break; }
              }
              if (clean) { from = i; break; }
            }
          }
          for (let i = from; i < session.messages.length; i++) {
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
    // 停手就连压着的插话一起清：主人点停止的意思是「这一轮到此为止」，
    // 停完还让排着的插话自动跑起来，会变成「明明点了停还在动」。
    /**
     * 【2026-11-09 主人报·「调用工具中途停止后，插话的消息不在插话时的位置」】
     *
     * 原来的做法是**直接丢掉**压着的那几句。于是：
     *   · 主人插话时界面上画出来的那个气泡，其实只在屏幕上，历史里没有；
     *   · 刷新一次它就没了，或者下一次发消息时被当成新的一句，跑到最末尾去。
     * 换句话说，「点了停止」顺带把主人刚打的那句话也删了 —— 这不是他要的。
     *
     * 现在改成：**不跑，但落盘**。把压着的插话按顺序写进历史（就是停下来的那个位置），
     * 不自动起轮（守住「点了停就别自己动」），主人再发一句就接着用。
     */
    try {
      const _left = peekInbox(sessionId);
      const _queued = [...(_left.steps || []), ...(_left.turns || [])];
      clearInbox(sessionId);
      if (_queued.length) {
        const _s = getSession(sessionId);
        if (_s) {
          _s.messages = Array.isArray(_s.messages) ? _s.messages : [];
          let _added = 0;
          for (const it of _queued) {
            const _t = String((it && it.text) || '').trim();
            if (!_t) continue;
            /* 已经在这一轮里被取走、落过盘的，别再来一条 */
            let _dup = false;
            for (let k = _s.messages.length - 1; k >= 0 && k >= _s.messages.length - 6; k -= 1) {
              const _m = _s.messages[k];
              if (_m && _m.role === 'user' && String(_m.content || '').trim() === _t) { _dup = true; break; }
            }
            if (_dup) continue;
            _s.messages.push({ role: 'user', content: _t, at: Date.now(), _keptOnStop: true });
            _added += 1;
          }
          if (_added) {
            try { saveSession(_s); } catch (e) {}
            try { console.log('[stop] 把压着的 ' + _added + ' 句插话落进历史（不自动跑）'); } catch (e) {}
          }
        }
      }
    } catch { /* 清不掉不影响停止 */ }
    /**
     * 【修·说停就停 · 2026-10-31】
     *
     * 以前这里只掐信号、不把这一轮从 runningTurns 里划掉。那一轮赖在表里不退，
     * 界面就一直以为还在跑：按钮停在【停止】、输入框锁着。主人点了停止再想发下一句，
     * 得干等五分钟那个兜底清理才松口 ——「说停停不下来、接着发消息要等五分钟」就这来的。
     *
     * 现在当场划掉；真在跑的那一轮被打断后自己收尾，收尾时再删一次是幂等的，撞不上。
     * 界面收到 running:false 立刻解冻按钮和输入框。
     */
    const had = runningTurns.delete(sessionId);
    try { const lv = liveLogs && liveLogs.get && liveLogs.get(sessionId); if (lv && !lv.done) { lv.done = true; lv.endedAt = Date.now(); } } catch {}
    /**
     * 【2026-11-08 加·停止要在上下文里留个收口】
     *
     * 主人：「重启后给她发消息，她回我的还是【嗯，我在。】」
     *
     * 查下来：这里只掐信号、清插话、划掉 runningTurns，**啥都不落盘**。
     * 于是历史尾部停在 `assistant(tool_calls) → tool([主人点了停止，命令被掐掉])`——
     * 一组不齐的工具调用。下一次主人发话时，repairHistory 会把这一组整个砍掉，
     * 她看到的是一段**被掐断的**上下文，再看到「继续」两个字，
     * 只能顺着「你还在吗」去理解，于是回一句「嗯，我在。」
     *
     * 修法：停的时候补一条 sysNote 的 assistant 痕迹（界面上不画），
     * 让上下文干净收口 —— 下一句「继续」就是正常的续接，不用她猜。
     */
    try {
      const _s = getSession(sessionId);
      const _m = _s && Array.isArray(_s.messages) ? _s.messages : null;
      if (_m && _m.length) {
        const _last = _m[_m.length - 1];
        const _tailIsTool = _last && (_last.role === 'tool' || (_last.role === 'assistant' && _last.tool_calls?.length));
        if (_tailIsTool) {
          _m.push({
            role: 'assistant',
            content: '（主人把这一轮停掉了，活停在这儿，没做完。）',
            at: Date.now(),
            _sysNote: true,
          });
          try { saveSession(_s); } catch (e) {}
        }
      }
    } catch (e) {}
    return json(res, 200, { ok: true, stopped: Boolean(turn?.ac) || had, running: false });
  }

  // 生成中插话：先把这句落盘，再停住当前这一轮，让前端带着新话接着跑。
  if (req.method === 'POST' && url.pathname === '/api/interject') {
    /* 【2026-11-05 修·插话丢附件】
     *
     * 主人报的现象：把图片拖进输入框、补一句话、发送 —— 只发出去了文字，图没了。
     * 根因就在这条接口：生成中点发送走的是「插话」，而插话只传 message，
     * 服务端也只认 message。附件从头到尾没进过任何一环。
     *
     * 更糟的是「只拖图不打字就发」：前端 `if (!busy || !text) return` 直接返回，
     * 图静悄悄消失，连个提示都没有。所以这里也要允许「只有附件没有字」。 */
    const { sessionId = 'default', message = '', atChars = null, attachments = [] } =
      await body(req).catch(() => ({}));
    const _att = Array.isArray(attachments) ? attachments.filter((a) => a && a.path) : [];
    if (!isSessionId(sessionId)) return json(res, 400, { error: 'bad sessionId' });
    if (!String(message).trim() && !_att.length) return json(res, 400, { error: 'empty message' });

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
    /**
     * 【2026-11-01 主人：「插话会直接打断 ai 正在说的话」】
     *
     * 老做法（0.9.26）：先把手上这一轮 abort 掉，等它收尾，话落盘，
     * 再由前端拿新话重起一轮。代价是她正在说的那句话被拦腰砍断 ——
     * 主人看到的像是「我一开口就把她噎住了」。
     *
     * 现在照 dsh 的 steering 来：话只往 inbox 塞一条，**不 abort**。
     * agent loop 在下一步开头把 inbox 取空、当成一条真的 user 消息接进历史，
     * 所以这句话一定是在「她这一步已经说完」之后才被看见的：
     * 不打断正在流的字，也不会丢（每次入队都落盘 .state/inbox/，重启还认得）。
     *
     * 副作用要多说一句：她这一轮可能还要跑好几圈工具才轮到「下一步」，
     * 这段时间主人看着像没反应 —— 所以前端要显示「已收下，排在她这一步之后」。
     */
    if (wasRunning) {
      /*
       * 【2026-11-01 主人：插话要能画在「我说到哪儿」的位置】
       * steer() 把话塞进信箱，agent loop 下一步取走时 push 成一条 user 消息。
       * 那条消息原来不带位置 —— 前端重绘只能排到末尾，主人看到的就是「我的话全堆在后面」。
       * 这里把「插话那一刻我已经说出多少字」一起带进信箱，loop 取走时写进消息的 _atChars。
       */
      try {
        const __n = Number(atChars);
        steer(sessionId, message, Object.assign(
          (Number.isFinite(__n) && __n >= 0) ? { atChars: __n } : {},
          _att.length ? { attachments: _att.map((x) => ({ path: String(x.path), name: String(x.name || ''), kind: String(x.kind || '') })) } : {},
        ));
      } catch (e) {
        return json(res, 500, { ok: false, running: true, error: '话没排进信箱：' + String(e?.message ?? e) });
      }
      diagLog('interject-steered', 'session=' + sessionId + ' pending=' + inboxCount(sessionId));
      /**
       * 【2026-11-10 主人钦点·插话立刻出现在对话流中间】
       *
       * 主人原话：「消息1，调用工具，在插话预发送阶段【直接发送】后并将插话
       * 显示在这个位置，收到插话内容然后消息2，调用工具」。
       *
       * 数据层本来就是对的（steer 进 inbox，agent loop 下一步取走当 user 消息），
       * 错的只有屏幕：前端把插话画成乐观 pend，合并公式 turns+pend+live 把 pend
       * 排在 live 后面 = 永远卡在屏幕最底，轮末重画才归位。
       *
       * 现在把它作为一条真事件推进**当前这一轮的直播清单**：
       * 位置 = 事件真实顺序（她消息1 的正文/工具之后、消息2 之前），
       * 前端 liveToItems 认出 k:'user' 直出成主人气泡 —— 不再有乐观气泡。
       *
       * events 与 items 两边都落，保证「增量攒」和「从头重算」算出来一模一样
       * （check-live-items-parity 钉的就是这两份逐字相等）。
       */
      try {
        const lv = liveLogs.get(sessionId);
        if (lv && !lv.done) {
          const _steerEv = {
            type: 'steer',
            text: String(message || ''),
            ts: Date.now(),
            at: Date.now(),
            ...(_att.length ? { atts: _att.map((x) => ({ path: String(x.path), name: String(x.name || ''), kind: String(x.kind || '') })) } : {}),
          };
          lv.rev = (typeof lv.rev === 'number' ? lv.rev : 0) + 1;
          _steerEv.rev = lv.rev;
          if (!Array.isArray(lv.items)) lv.items = [];
          if (Array.isArray(lv.events) && lv.events.length < LIVE_MAX_EVENTS) {
            _steerEv.seq = lv.events.length;
            lv.events.push(_steerEv);
          }
          appendLiveItem(lv.items, _steerEv);
        }
      } catch (e) {
        /* 推不进直播清单不算插话失败：话已经进信箱、落盘了，轮末照样能看到 */
        try { diagLog('interject-steer-item-fail', String(e?.message ?? e)); } catch {}
      }
      return json(res, 200, {
        ok: true,
        running: true,
        steered: true,
        count: inboxCount(sessionId),
      });
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
    /* 【2026-11-01 主人：插话要插在「我说到哪儿」的位置，别全堆在末尾】
       以前这里只 push 一条 {role:'user',content}，前端重绘时认不出「这句是插进来的」，
       只好按历史顺序排在整段回答后面。现在带上两个记号：
         _steer: true    —— 这是插话（前端画个「插话」小标）
         _atChars: N     —— 插进来那一刻我已经说了多少字
       前端重绘时按 _atChars 把我那段话劈成两半，把主人的话嵌在中间。
       客户端没传就退回老做法（排末尾）。 */
    const _atC = Number(atChars);
    history.push({
      role: 'user',
      content: message,
      _steer: true,
      ...(Number.isFinite(_atC) && _atC >= 0 ? { _atChars: _atC } : {}),
    });
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


  /**
   * 【2026-10-31 「清空当前」已下线】
   *
   * 主人原话：「把【清空当前】按钮以及对应效果删除，我严重怀疑就是因为这个的原因清空的」。
   * 前端按钮和调用已经整块拆掉；这儿留一个明确的拒绝，
   * 万一以后有旧页面 / 别的代码还在调它，也不会悄悄把记录清掉。
   *
   * 真要清空，去会话面板里删那一整个会话 —— 那一步有确认、看得见。
   */
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    return json(res, 410, {
      error: '「清空当前」这个功能已经下线了，会话记录不会再被它清掉。要清空请到会话面板里删掉那一整个会话。',
      gone: true,
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

/* ────────────────────────────────────────────────────────────────
 * 【掐轮之后，自己接回来】
 *
 * 主人 2026-11-08 凌晨问：「为什么小鱼Agent里面的会话总是做任务做着做着自己停了」。
 *
 * diag.log 里 00:53~01:07 这十四分钟，六个会话轮着被看门狗掐：
 *   静了 700 秒 / 325 秒 / 443 秒 / 306 秒 / 310 秒 / 305 秒
 * 掐掉之后**没有任何人接** —— 界面就那样停在半路，主人只能自己再打一句。
 * 「自己停了」这四个字，指的就是这一段。
 *
 * 掐本身不算错（真卡死的时候总得有人动手），错在**掐完就撒手**。
 * 现在掐完做三件事：
 *   ① 等旧轮真的退干净（不然两轮同时改同一个 messages 数组）；
 *   ② 往会话里补一句框架消息，说清楚「刚才怎么了、现在重来」——
 *      前端不画成主人说的话，但主人回来看得见原因；
 *   ③ 用接续轮把活接上（跟定时任务走同一条路：startQueuedTurn）。
 *
 * 还要防死循环：上游真挂了的时候，「掐 → 接 → 再掐」能转到天亮。
 * 所以同一会话半小时内最多自动接 2 次，第 3 次就老实停下，把话说清楚。
 * ──────────────────────────────────────────────────────────────── */
const stuckRetryBook = new Map(); // sid → { n, lastAt }
const STUCK_RETRY_MAX = 2;        // 半小时内最多自动接几次
const STUCK_RETRY_WINDOW = 30 * 60 * 1000;

function scheduleStuckRetry(sid, info = {}) {
  const sessionId = String(sid || '');
  if (!sessionId) return;
  const now = Date.now();
  const rec = stuckRetryBook.get(sessionId) || { n: 0, lastAt: 0 };
  if (now - rec.lastAt > STUCK_RETRY_WINDOW) rec.n = 0;

  if (rec.n >= STUCK_RETRY_MAX) {
    diagLog('stuck-retry-give-up', sessionId + ' 半小时内已经自动接过 ' + rec.n + ' 次还是停，不再硬接了');
    return;
  }
  rec.n += 1;
  rec.lastAt = now;
  stuckRetryBook.set(sessionId, rec);

  const idleSec = Math.max(0, Math.round(Number(info.idleMs || 0) / 1000));
  let waited = 0;
  const timer = setInterval(() => {
    waited += 4000;
    const t = runningTurns.get(sessionId);
    const stillAlive = Boolean(t && t.ac && !t.ac.signal.aborted);
    /* 旧轮还在退 —— 再等等；最多等 90 秒，等不到也不管了，硬接 */
    if (stillAlive && waited < 90000) return;
    clearInterval(timer);
    (async () => {
      try {
        const sess = getSession(sessionId);
        if (!sess) return;
        sess.messages = Array.isArray(sess.messages) ? sess.messages : [];
        sess.messages.push({
          role: 'user',
          context: true,      // 框架消息：前端不画成「主人说的话」
          _sysNote: true,
          _at: Date.now(),
          content: '（刚才那一轮静了 ' + (idleSec || 60) + ' 秒没有动静，我把它掐断，重来一次——接着做。）',
        });
        try { saveSession(sess); } catch {}
        diagLog('stuck-retry', sessionId + ' 第 ' + rec.n + ' 次自动接回（静了 ' + idleSec + ' 秒）');
        await startQueuedTurn(sessionId, null);
      } catch (e) {
        diagLog('stuck-retry-fail', sessionId + ' ' + String((e && e.message) || e));
      }
    })();
  }, 4000);
  if (typeof timer.unref === 'function') timer.unref();
}

export function startServer({ port = config.port, quiet = false, selfCheck = true } = {}) {
  /**
   * 【2026-11-08 加·整轮空闲看门狗（主人说「根治」）】
   *
   * 现场：三个会话同时卡住 —— events 不动、会话文件十几分钟不写，
   * 界面上却一直显示「正在跑」。查下来只有「等模型」那层有 2 分钟超时，
   * 卡在别处（工具、写盘、某个没人 resolve 的 await）完全没人管；
   * `TURN_IDLE_MAX_MS` 更是只躺在常量表里，一行执行的代码都没有。
   *
   * 这个看门狗按「整轮静默」判：
   *   · 正在等工具 → 按工具上限 +1 分钟（工具本来就允许跑二十分钟）
   *   · 其余情况   → 5 分钟
   * 超了先软掐（abort），60 秒还没退就强制清理（删条目 + 把 live 标 done），
   * 让界面解冻 —— 主人至少能在会话里接着说话，而不是对着一个永远转圈的界面。
   */
  try {
    if (!globalThis.__xyTurnWatchdog) {
      globalThis.__xyTurnWatchdog = createTurnWatchdog({
        turns: () => runningTurns.entries(),
        liveOf: (sid) => liveLogs.get(sid),
        abort: (sid) => {
          try {
            const t = runningTurns.get(sid);
            if (t && t.ac && typeof t.ac.abort === 'function') t.ac.abort('turn-idle');
          } catch (e) {}
        },
        forceClean: (sid) => {
          try { runningTurns.delete(sid); } catch (e) {}
          try {
            const lv = liveLogs.get(sid);
            if (lv) {
              if (!Array.isArray(lv.events)) lv.events = [];
              /* 【2026-11-08 改】以前写完这句就完了，主人还得自己打一句「接着做」。
               * 现在 onStuck 已经在排队接回了，所以这句话要跟实际行为对上。 */
              lv.events.push({ type: 'error', text: '这一轮卡得太久，我先把它强行收掉，马上重新接一次——你不用管。', at: Date.now() });
              /* 【2026-11-08 加·主人说「根治」】光写 live.events 只在内存里，
               * 切会话/刷新/重启就没了——主人就是这么丢了一整段话的。
               * 所以同一句也落进会话历史，一定能看见。 */
              try {
                const _s = getSession(sid);
                const _last = (_s && Array.isArray(_s.messages) && _s.messages.length) ? _s.messages[_s.messages.length - 1] : null;
                if (_s && !(_last && _last.__turnErr)) {
                  _s.messages.push({
                    role: 'assistant',
                    content: '⚠️ 这一轮卡太久，我先强行收掉、马上重接——你不用管。\n\n（要是没接回来，跟我说一声「接着办」，我照清单往下走。）',
                    at: Date.now(),
                    __turnErr: true,
                  });
                  saveSession(_s);
                }
              } catch {}
              lv.done = true;
              lv.endedAt = Date.now();
            }
          } catch (e) {}
        },
        idleMs: TURN_IDLE_MAX_MS,
        toolIdleMs: TOOL_MAX_MS + 60000,
        /* 等模型那一档：比 LLM 自己的空闲超时再宽 1 分钟 —— 让它先自己报错、走重试，
         * 别跟看门狗抢着动手。 */
        llmIdleMs: LLM_IDLE_MS + 60000,
        /* 【2026-11-08 加】真要掐的时候先记一笔，掐完自动接回来 */
        onStuck: (sid, info) => { try { scheduleStuckRetry(sid, info); } catch {} },
        onLog: (tag, detail) => diagLog(tag, detail),
      });
      globalThis.__xyTurnWatchdog.start();
      diagLog('watchdog-start', 'idle=' + Math.round(TURN_IDLE_MAX_MS / 1000) + 's tool='
        + Math.round((TOOL_MAX_MS + 60000) / 1000) + 's llm=' + Math.round((LLM_IDLE_MS + 60000) / 1000) + 's');
      if (!quiet) {
        console.log('  watchdog : 真空转 ' + Math.round(TURN_IDLE_MAX_MS / 1000) + 's / 等工具 '
          + Math.round((TOOL_MAX_MS + 60000) / 1000) + 's / 等模型 '
          + Math.round((LLM_IDLE_MS + 60000) / 1000) + 's，超了掐掉并自动接回来');
      }
    }
  } catch (e) {
    console.warn('[watchdog] 起不来（不影响主流程）：', String(e?.message ?? e));
  }

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

  /* 【2026-11-02 主人要求：删掉「重启后自动续上」】
   *
   *  主人原话：「删除重启后自动续上的功能」。
   *
   *  原来这里 setTimeout 3 秒后自己爬起来接着跑上一轮 —— 现在整段拿掉。
   *  重启就是重启：界面停在「上次断在这儿」，主人想看 / 想接着说，自己发一句就行。
   *
   *  保留的（不是这条功能，别一起删）：
   *   · 程序自己退出后能自动重新进来（electron/main.cjs 的 relaunch）；
   *   · POST /api/resume 手动续跑接口（主人主动点才跑）；
   *   · resume.mjs 的落盘记录（给上面那个手动接口用）。
   */

  /* 【2026-11-02 主人要求】重启后自动发一句「重启了」
   *
   *  原话：「重启后让我自动发一句：重启了」，而且
   *  「必须是你手动调用工具自动重启才会这样，而不是我手动关掉你你还会自动重启」。
   *
   *  凭据只有一个：/api/app/restart 退出前写下的 after-restart.json。
   *  主人自己关窗口 / 托盘退出，压根不经过那个接口，也就没有这个文件 —— 什么都不会发生。
   *  用完就删，免得下一次普通启动又冒一句。
   */
  setTimeout(() => {
    let _tell = null;
    const _mark = join(config.dataDir, '.state', 'after-restart.json');
    try {
      if (!__diagExists(_mark)) return;
      try { _tell = JSON.parse(__diagRead(_mark, 'utf8')); } catch { _tell = null; }
      try { __fsUnlinkSync(_mark); } catch {}
    } catch {}
    if (!_tell || !_tell.sessionId) return;
    const _sid = String(_tell.sessionId);
    try {
      const _s = getSession(_sid);
      if (!_s) return;
      // 只说一句「重启了」，不带任何「接着干」的提示（那是主人另外砍掉的东西）
      /* 主人要的是「自动发一句：重启了」—— 就发这三个字。
       *  别自作多情加旁白：这句话的作用是把界面顶出一条新消息、
       *  让主人一眼看到「重启成功、可以接着说了」。 */
      diagLog('after-restart-told', _sid);
      /* 主人 2026-11-02：「或者让系统给你发一句重启了，叫醒你」。
       *  所以这里不去冒充「我自己说话」，而是由系统投一条 user 消息进来 ——
       *  它既能把界面顶出一条新消息（主人看得见「重启了」），
       *  又天然触发一轮：我收到这句话，就接着干。 */
      /* 【2026-11-02 主人要求】这句「重启了」只给我自己看，不许在界面上冒充主人说话。
       *  做法跟压缩提醒一样：打 _sysNote 标记 ——
       *    · 前端 renderTurns 里 `if (turn.sysNote) continue;` 直接不画；
       *    · 但它仍在 wire 里，所以我自己读得到，照样能被这句话叫醒。
       *  别改成 context:true —— 那样我会连自己该干什么都看不到。 */
      /* 【2026-11-05 主人报「重启后没续上」】
       *  原来这里只塞三个字。我醒来看到「重启了」三个字，只知道「重启过了」，
       *  不知道断在哪儿、还剩哪些活 —— 结果就是主人还得再说一句「继续」我才动。
       *  resume.json 里明明记着断点原文、中断原因、没做完的步骤，可这儿压根没读它
       *  （实测那次重启后 resume.json 原封不动躺在 .state 里，没人消费）。
       *
       *  改法：把断点、原因、没做完的步骤一起塞进这条消息 —— 界面照样不画
       *  （_sysNote 照旧），只是我自己读得到。不自动起新一轮、不冒充主人说话，
       *  主人 2026-11-02 定的那两条规矩一条没动，只是让这句话自己把话说完。 */
      let _resumeMsg = '重启了';
      /* 有没有真断点（要接着干的事）。没有的话，这句话只会换来一句「嗯，我在」。 */
      let _hasBreakpoint = false;
      try {
        const _ri = peekInterrupted ? peekInterrupted() : null;
        if (_ri && String(_ri.sessionId || '') === String(_sid || '')) {
          const _open = Array.isArray(_ri.openSteps) ? _ri.openSteps : [];
          const _lines = [];
          if (_ri.taskLine) _lines.push('断在主人这句话上：' + String(_ri.taskLine).slice(0, 200));
          if (_ri.reason) _lines.push('中断原因：' + String(_ri.reason).slice(0, 120));
          if (_ri.text) _lines.push('断的那一刻我正说到：' + String(_ri.text).slice(-600));
          if (_open.length) {
            _lines.push('清单上还没打勾的 ' + _open.length + ' 步（从断点接着干，别从头重来）：');
            for (const st of _open.slice(0, 12)) {
              _lines.push('  ' + (st && st.n ? st.n : '?') + '. ' + String((st && st.text) || '').slice(0, 220));
            }
          }
          if (_lines.length) {
            _hasBreakpoint = true;
            _resumeMsg = '重启了。断点在这儿：\n' + _lines.join('\n') +
              '\n\n（直接从没打勾那步接着干，不用等我再问。别回「我在」这种话。）';
          }
          /* 读完就把它销掉：断点已经抄进这条消息里了（会话里存得住），
           * 留着只会让下一次重启又读到同一个旧断点，把老账重念一遍。 */
          try { dropInterrupted(); } catch {}
        }
      } catch (e) { try { console.warn('[restart] 读断点失败（不影响叫醒）：', String(e && e.message)); } catch {} }
      /**
       * 【2026-11-08 加·「她在，但答非所问」】
       *
       * 主人 19:46 截图：检查鱼连问三次「自动重启能给她们续上吗」，
       * 她三次都只回「嗯，我在。」—— 因为她醒来看到的是我们投的
       * 「重启了」，那句话盖在主人问题**后面**，成了最后一条输入。
       * 于是她以为主人只是在确认她在不在。
       *
       * 规矩：**主人有话还没人答**（最后一条普通 user 消息排在最后一条
       * assistant 之后）时，别再投叫醒语、也别再塞一条新 user 消息 ——
       * 直接跑那一轮，让她正面回答主人的问题。
       * 只有主人的话已经答过了（重启只是补一句"我回来了"）才投「重启了」。
       */
      let _ownerWaiting = false;
      try {
        const _ms = Array.isArray(_s.messages) ? _s.messages : [];
        let _lastU = -1;
        let _lastA = -1;
        for (let i = _ms.length - 1; i >= 0; i--) {
          const mm = _ms[i];
          if (!mm || mm.context) continue;
          if (_lastU < 0 && mm.role === 'user' && !mm._sysNote) _lastU = i;
          if (_lastA < 0 && mm.role === 'assistant') _lastA = i;
          if (_lastU >= 0 && _lastA >= 0) break;
        }
        _ownerWaiting = _lastU > _lastA;
      } catch (e) {}
      if (_ownerWaiting) {
        try { console.log('[restart] 主人有话没答，直接跑那一轮，不投「重启了」：' + _sid); } catch (e) {}
        try { startQueuedTurn(_sid, null).catch((e) => console.warn('[restart] 接着答失败：', String(e?.message ?? e))); } catch (e) {}
      } else if (!_hasBreakpoint) {
        /**
         * 【2026-11-09 加·「她们没被叫也说了句『嗯，我在』」】
         *
         * 主人 00:02 报：检查鱼、杂活鱼也各说了一句「嗯，我在。」，
         * 「可是我分明什么都没干啊，她们原本应该在做任务来着」。
         *
         * 查清了：不是她们自己开口，是**重启叫醒**。今晚重启了好几次，
         * 每次对「没有断点」的会话只投三个字「重启了」，再起一轮 ——
         * 她看到一句「重启了」，没有活可干，只能应一声「嗯，我在。」。
         *
         * 没有断点 = 没有要接着做的事。这句话除了换来一句废话，没有任何信息量，
         * 还会在会话里留下一条垃圾。所以**干脆不叫醒**，安静等着。
         * 有断点才叫（那种才真的需要"接着干"），主人有话没答才叫（那种要正面回答）。
         */
        try { console.log('[restart] 没有断点，不叫醒（免得换来一句「我在」）：' + _sid); } catch (e) {}
      } else {
        _s.messages.push({ role: 'user', content: _resumeMsg, _sysNote: true });
        saveSession(_s);
        try { startQueuedTurn(_sid, null).catch((e) => console.warn('[restart] 叫醒失败：', String(e?.message ?? e))); } catch {}
      }
    } catch (e) {
      console.warn('[restart] 自动说一句失败（不影响使用）：', String(e?.message ?? e));
    }
  }, 1500).unref?.();

  // 把「叫醒某个会话」交给工具那边用。
  // 为什么用注入：wakePeer 要动 runningTurns、要起 runAgent，这些都在本文件里；
  // 而 tools.mjs 反过来 import server.mjs 就成环了。所以在这里塞进去。
  setPeerWake(wakePeer);
  // 让 list_peers / 重启前自检能看见「此刻谁在跑」（2026-11-04）
  setRunningProbe(() => [...runningTurns.keys()]);

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
    /* 【2026-11-05 加·补一类它查不到的】
     *
     * 工具**写好了、注册进 tools 数组了，却没登记到 features 的功能白名单** ——
     * `isToolEnabled()` 对查不到归属的工具直接 `return false`（不是 true），
     * 于是它会静默变成"关着"的状态：模型拿到的是「现在是关着的，用不了」，
     * 而代码里明明有这个工具。
     *
     * 今天就栽过一次：memory_search 加完、测了、同步了，唯独漏了登记这一道，
     * 等于给她的眼睛又戴回眼罩，而且**任何检查都不报错**。
     */
    const registered = new Set([...TOOL_FEATURE.keys(), ...TOOL_OWNERS.keys()]);
    for (const t of allTools) {
      if (!registered.has(t.name)) {
        problems.push(t.name + ': 没登记到 features 的功能表（会被静默关闭，永远用不了）');
      }
    }
    if (problems.length) {
      console.warn('[tools] 下面这些工具有问题，模型要么看不懂、要么根本用不上：');
      for (const p of problems) console.warn('  · ' + p);
    }
    /* 【2026-11-05 加】技能本的格式自检：缺 description 的话，
     * 模型只看得到一个名字、不知道什么时候该翻它 —— 等于白放。 */
    try {
      const skProblems = checkSkills();
      if (skProblems.length) {
        console.warn('[skills] 这些技能格式不对，她会翻不到或不知道该不该翻：');
        for (const p of skProblems) console.warn('  · ' + p);
      }
    } catch {}
  } catch (e) {
    console.warn('[tools] 文档自检没跑成（不影响使用）：', String(e?.message ?? e));
  }

  /**
   * 【主动找我 · selfwake】—— 2026-11-06，对着 DeepSeek Harness 补齐的
   *
   * .dsh 有 selfwake：主人很久不来，角色会自己开口说一句。小鱼一点没有 ——
   * 人设里写着「被冷落会寂寞」，可她本人一个字都没法先开口，只能等主人说话。
   *
   * 这里只负责「把 server 那两样东西交给它」：怎么列会话、怎么读会话、到点了怎么起一轮。
   * 判断节奏（间隔、静默、次数上限）全在 selfwake.mjs 里，那边能单独测。
   *
   * 默认关着 —— 要主人在【功能】面板里把「主动找我」点亮才生效。
   * 出错一律吞：主动唤醒来捣乱，比它不工作糟得多。
   */
  try {
    startSelfwake({
      listSessions: () => listSessions(),
      getSession: (id) => getSession(id),
      // 功能页里那条「主动找我」关着就直接整轮不跑 —— 不是等到要说话时才挡
      isEnabled: (sid) => featureOnFor(sid, 'selfwake'),
      onDue: async (sid, session, verdict) => {
        try {
          // 关着就别叫（跟 startQueuedTurn 里那道闸同一个口径，这里先挡一道不让它白起）
          // 功能页里那条「主动找我」关着，就彻底别动（跟顶栏按钮一个口径）
          if (!featureOnFor(sid, 'selfwake')) return;
          if (!fishOn(sid)) return;

          /**
           * 投一条「引子」。
           *
           * 为什么是 role:'user' + context：走的是跟「重启了」完全一样的路
           * （server.mjs 那条注释写着：不去冒充我自己说话，而是由系统投一条 user 进来），
           * 这样 agent 那边当成「背景」而不是「主人刚发来的话」。
           *
           * _sysNote: true → 前端在 renderTurns 里 continue 掉，界面上不画这条。
           * 主人只看到她回出来的那句话，不会看到自己没说过的话。
           */
          const sess = session || getSession(sid);
          if (!sess) return;
          const msgs = Array.isArray(sess.messages) ? sess.messages : [];
          if (!msgs.length) return; // 空会话不自己开口（没上下文，说了也怪）

          msgs.push({
            role: 'user',
            context: true,
            _sysNote: true,
            _at: Date.now(),
            content: '（她一个人待了会儿。没人跟她说话，她想主动开口讲一句 —— 就一句，别长篇，别问「在吗」，说点她自己在想的事或者关心主人的话。'
              + (() => {
                /* 【2026-11-05 加·借鉴 dsh 的 lastLine】
                 * 原来每次醒来都是同一句干巴巴的引子，她不知道上一回自己说到哪儿了，
                 * 于是要么重复同一个话题，要么前后不接。带上这句之后至少能接着自己往下说。 */
                try {
                  const _prev = String((selfwakeState(sid) || {}).lastLine || '').trim();
                  return _prev ? ('上一回你主动说的是：「' + _prev + '」—— 别重复它，接着往下说点别的。）') : '）';
                } catch { return '）'; }
              })(),
          });
          sess.updatedAt = Date.now();
          try { saveSession(sess); } catch {}

          const r = await startQueuedTurn(sid, null);
          if (!r || !r.ok) {
            console.log('[selfwake] 这一轮没起成：', sid, r && (r.skipped || r.error));
          } else {
            /* 【2026-11-05 加】把这一轮她说出口的话记成 lastLine，供下次醒来当背景。
             * 只记真正说出口的 assistant 文本，工具调用之类不算。 */
            try {
              const _now = getSession(sid);
              const _ms = Array.isArray(_now && _now.messages) ? _now.messages : [];
              for (let _i = _ms.length - 1; _i >= 0; _i--) {
                const _m = _ms[_i];
                if (!_m || _m.role !== 'assistant') continue;
                const _t = String(_m.content == null ? '' : _m.content).trim();
                if (!_t) continue;
                noteSpoke(sid, _t);
                break;
              }
            } catch {}
          }
        } catch (e) {
          try { console.warn('[selfwake] 起一轮失败（不影响别的）：', e && e.message); } catch {}
        }
      },
    });
  } catch (e) {
    try { console.warn('[selfwake] 挂不上（不影响主流程）：', e && e.message); } catch {}
  }

  /**
   * 【定时任务 · cron】—— 2026-11-06 主人要求：
   * 「给他说一个任务，然后再说这个任务什么时候开始，然后他就会在那个时候自动去做」
   *
   * 判断「到点没」全在 cron.mjs 里（能单独测），这里只把「怎么起一轮」交过去。
   * 出错一律吞：定时任务坏了不许连累主流程。
   *
   * 【2026-11-10 修·整块被粘进 selfwake 回调里，导致定时任务一条都不响】
   *
   * 病根：这段原本该在 `startSelfwake({...})` 的**外面**，跟它并列。
   * 但 2eeceff 那次提交（注释还写着「修·定时任务从来没成功跑过」，就是在修 eol 那次）
   * 把它整块粘进了 `onDue: async (sid, session, verdict) => { try {` 的函数体里，
   * 位置正好在「关着就别叫」那两行注释之后、真正的 `if (!featureOnFor(...))` 之前。
   *
   * 后果：`startCron` 是模块级启动代码，**躲在回调里 → 模块加载时从不执行**
   *   → cron.mjs 的 started 永远 false → tick 永不起 → 一条定时任务都不会响。
   * 实测取证：`POST /api/cron {when:'+1m'}` 过期 386 秒后
   *   `lastRunAt=0, runCount=0, lastNote=""`，而手动 `POST /api/cron/run` 是好的
   *   （说明 runCronTask 没坏，坏的是调度器根本没启动）。
   * 界面还会显示那行任务孤零零挂着「11/10 20:45 · 一次」，没有任何"已执行/失败"标记 ——
   * 主人只会以为「她没听见我的闹钟」。
   *
   * 以后改这段请盯住：`startCron(` 必须在 `startSelfwake(` 的 try 外面。
   * scripts/check-cron-fires.mjs 有静态哨兵按括号深度算，粘错了会红。
   */
  try {
    startCron({ onDue: (task) => runCronTask(task) });
  } catch (e) {
    try { console.warn('[cron] 挂不上（不影响主流程）：', e && e.message); } catch {}
  }

  /* 【2026-11-11 团队模式】把三条通道交给 team.mjs —— 起轮、liveLogs 全在
   * startServer 的闭包里，team.mjs 反着 import 会成环，照 setPeerWake 的老办法注入。
   *   · pushWorkerEvent：worker 事件落该会话的 liveLogs（设计文档 §1.5「后台化必须
   *     补的一条」—— 主轮收尾后 worker 还在跑，事件不能再只走那一轮的 send）。
   *     缓存不存在/已收尾就开一份新的，前端轮询 /api/chat/live 照常补画；
   *   · isTurnRunning：回报该不该排 followup（在跑 → 主轮收尾的 drainTurns 接走）；
   *   · startTurnWithIntro：主轮不在、followup 没人取 → 照 selfwake 的路投一条
   *     context+sysNote 引子再起排队轮，绝不冒充主人说话。 */
  try {
    setTeamChannels({
      pushWorkerEvent: (sid, ev) => {
        try {
          let live = liveLogs.get(sid);
          if (!live || live.done) {
            live = { sessionId: sid, events: [], startedAt: Date.now(), done: false, endedAt: 0, queuedTurn: true };
            liveLogs.set(sid, live);
          }
          appendLiveItem(live.events, ev);
        } catch { /* 事件丢一条不致命，别连累 worker 本体 */ }
      },
      isTurnRunning: (sid) => runningTurns.has(sid),
      startTurnWithIntro: async (sid, text) => {
        try {
          const sess = getSession(sid);
          if (!sess) return { ok: false, error: 'no-session' };
          const msgs = Array.isArray(sess.messages) ? sess.messages : [];
          if (!msgs.length) return { ok: false, error: 'empty-session' };
          msgs.push({
            role: 'user',
            context: true,
            _sysNote: true,
            _at: Date.now(),
            content: String(text || ''),
          });
          sess.updatedAt = Date.now();
          try { saveSession(sess); } catch {}
          const r = await startQueuedTurn(sid, null);
          return r || { ok: false };
        } catch (e) {
          return { ok: false, error: String(e && e.message ? e.message : e) };
        }
      },
    });
  } catch (e) {
    try { console.warn('[team] 通道挂不上（不影响主流程）：', e && e.message); } catch {}
  }

  /* 【2026-11-11 团队模式】启动时把「还挂着 running 但进程已经重启过」的 worker
   * 统一标成 interrupted —— 不标的话页面刷新后前端看到的 running 是文件里的
   * 旧状态，实际进程早没了（设计文档 §2.4 场景 C）。 */
  try {
    const _swept = markInterruptedWorkers();
    if (_swept && _swept.swept) console.log('[team] 启动清理：' + _swept.swept + ' 个中断的 worker 已标记');
  } catch (e) {
    try { console.warn('[team] 中断标记失败（不影响启动）：', e && e.message); } catch {}
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
      /* 【2026-11-03 记忆系统严检】起一个目录体检：超了就在日志里喊一声（不删东西）。
       * 严检时量到 .state 已经 1GB+，那些目录全是证据/交付物，不能自动删，
       * 但至少得让主人知道它在长。 */
      try { startHealthWatch((m) => console.log('  ' + m)); } catch (e) { /* 体检挂了不能拖累服务 */ }

      /* 【2026-11-07 修·BOM 根治：扫全 .state 递归，不只根目录的 .json】
       *
       *  PowerShell 的 Set-Content -Encoding utf8 会加 BOM（EF BB BF）——
       *  手动改一次配置、别的脚本顺手写一下，就留下它了。
       *
       *  原来只扫 .state 根目录、只认 .json，于是 memory/*.md 这些子目录里的
       *  本子带 BOM 根本扫不到。2026-11-07 记忆本就被咬过一次：写进去带 BOM，
       *  读出来开头是 U+FEFF，markdown 的 "# 会话记忆" 不再是标题，整份本子就哑了。
       *
       *  现在递归扫 .json / .md / .jsonl：
       *    .json 削完先 JSON.parse 验一遍，坏了不动（宁可留着也别削坏）；
       *    .md / .jsonl 是纯文本，直接削。 */
      /* 【2026-11-08 修·「服务听上了」有时 2 秒、有时 54 秒】
       *
       * 主人报「手动重启与自动重启速度有时快有时慢，多是慢的」。
       * boot.log 给出实证：
       *   05:19:43 起 → 服务听上了 +1711ms   （快）
       *   05:20:42 起 → 服务听上了 +5494ms   （中）
       *   05:42:42 起 → 服务听上了 +53893ms  （慢，54 秒）
       * 窗口露面跟着一起慢（+2.8s / +10.8s / +60s），慢的**不是窗口、是开服**。
       *
       * 元凶就是这段 BOM 清扫：它在 listen 回调里**同步递归**扫 `.state` 下
       * 所有 .json/.md/.jsonl，每个都 statSync + readFileSync。.state 里堆着
       * 几千个文件（会话、记忆本、归档、回收站…），同步读一遍就是几十秒；
       * 文件越堆越多，所以「有时快、多是慢」。
       *
       * 它只是「顺手削一下 BOM」，完全不阻塞对外服务。
       * 跟下面的归档轮转、孤儿清理一样，挪到启动之后 15 秒再跑。
       */
      /* 【2026-11-08 停用·这段清扫不能再跑了】
       *
       * 半小时前我把它从 listen 回调挪到「启动后 15 秒」，以为解决了启动慢。
       * 结果是更坏的回归：它**仍然是同步递归**读 .state 下所有 .json/.md/.jsonl，
       * 14:27:21 启动 → 15 秒后开始扫 → 主进程被堵住几分钟，
       * 窗口标题变成「未响应」、整屏盖白、8788 端口在听却一个请求都答不了。
       * 主人 14:27:59 的截图就是这个。
       *
       * 它本来只是「顺手削掉历史遗留的 BOM」，不是开服必需。
       * 正解是在**写入侧**保证不写 BOM（Node 的 writeFileSync utf8 本来就不会加），
       * 而不是每次启动把整盘翻一遍。真要清理，单独跑个脚本、手动执行一次就够。
       *
       * 下面整段保留作存档，用 if (false) 封住 —— 不编译执行，也不许有人手滑放回来。 */
      if (false) {
      try {
        const _st = join(config.dataDir, '.state');
        let _bn = 0;
        const _walkBom = (dir, depth) => {
          if (depth > 4) return;
          let _names = [];
          try { _names = __diagReaddir(dir); } catch { return; }
          for (const _f of _names) {
            const _p = join(dir, _f);
            let _isdir = false;
            try { _isdir = statSync(_p).isDirectory(); } catch { continue; }
            if (_isdir) { _walkBom(_p, depth + 1); continue; }
            if (!/\.(json|md|jsonl)$/i.test(_f)) continue;
            try {
              const _b = __rotRead(_p);
              if (_b.length < 3 || _b[0] !== 0xef || _b[1] !== 0xbb || _b[2] !== 0xbf) continue;
              const _t = _b.slice(3).toString('utf8');
              if (/\.json$/i.test(_f)) JSON.parse(_t);
              __rotWrite(_p, _t, 'utf8');
              _bn++;
            } catch (e) { /* 单个文件坏了别拦着服务起来 */ }
          }
        };
        _walkBom(_st, 0);
        if (_bn) console.log('  [bom] 开服清掉 ' + _bn + ' 个文件上的 BOM');
      } catch (e) { /* 清扫自己挂了也不能拖累服务 */ }
      }
      /* 【2026-11-03 记忆系统严检】归档轮转 + 回收站压缩：一天最多跑一次。
       * 不是删，是打包成 .jsonl.gz —— 要翻还能翻，占的地方小一个量级。
       * 回收站超过 7 天、归档超过 30 天才压，阈值给得够宽。 */
      try {
        const mark = join(config.dataDir, '.state', '.last-rotate');
        let last = 0;
        try { last = Number(__rotRead(mark, 'utf8')) || 0; } catch {}
        if (Date.now() - last > 86400000) {
          /* 【2026-11-05 加·延后 15 秒再跑】
           * 主人报「双击图标启动那么慢」。这段原来是 listen 回调里**同步**跑的，
           * 阈值改 2 天之后要压 2335 个文件，直接把事件循环堵死 —— 端口通了但界面点不动。
           * 现在延后 15 秒：先把界面服务出来，打包在后面慢慢做。 */
          /* 【2026-11-08 停用】这三段延后任务仍然全是同步 IO，
           * 启动后 6 秒 / 15 秒接连连跑，跟 BOM 清扫一起把主进程堵成「未响应」。
           * 「延后」只是把卡顿挪到窗口露面之后，并没有解决堵死。
           * 维护类批处理不该跑在 Electron 主进程里 —— 要跑就单独起脚本/子进程。 */
          if (false) {
          /* 【2026-11-05 改·7 天 → 2 天】
           *
           * 回收站已经堆到 73MB / 2974 个文件：今天 565 个、1-7 天 2382 个、
           * 7 天以上只有 24 个。也就是说 7 天这条线几乎不起作用 ——
           * 该压的早就压完了，剩下的全是「一周内删的」，一直压不动、一直涨。
           *
           * 回收站的本意是「手滑删了还能捞回来」，给两天够用了；
           * 而且压缩是打包成 .tar.gz，不是删除，真要翻还是能翻。
           */
          const t = compactTrash({ days: 2 });
          const a = rotateArchive({ days: 30 });
          const n = t.reduce((s, x) => s + x.packed, 0) + a.packed;
          if (n) console.log('[rotate] 打包回收 ' + n + ' 个老文件（回收站 7 天 / 归档 30 天）');
          __rotWrite(mark, String(Date.now()), 'utf8');
          }
        }
      } catch (e) { /* 轮转挂了不能拖累服务 */ }
      /* 【2026-11-05 改·清理也挪到启动之后】
       *
       * 主人报启动十几秒，主因是轮转（已延后）。这三个虽然量小，
       * 但也是同步 IO，一起挪出去 —— 启动路径上不该有「扫目录」这种活。 */
      /* 同上：孤儿清理也停用，别在启动后再来一波同步扫目录。 */
      if (false) {
        try { pruneOrphans(); } catch { /* 孤儿清理挂了不能拖累服务 */ }
        try { pruneWorkerFiles(); } catch { /* 同上 */ }
      }
      /* 【2026-11-03 出厂自建卡】每台机器第一次启动时把小白曦、旁白铺成卡。
       * 账本在 .state/agent-presets-made.json —— 铺过一次就不再铺，主人删了就是删了。
       * 人设正文来自包里的 persona/agents/<key>.md（build.files 带着整个 persona 目录）。 */
      /* 【2026-11-05 改】铺卡也延后 —— 第一次启动要写几十个文件，不该占启动时间 */
      setTimeout(() => {
        try {
          const n = ensureAgentPresets();
          if (n && !quiet) console.log(`[presets] 铺了 ${n} 张出厂智能体卡`);
        } catch (e) { /* 铺卡失败不能拖累服务 */ }
      }, 3000);
      /* 【2026-11-07 修·这段原来在 if (!quiet) 里面，从来没执行过】
       *
       * 主进程调 startServer 时传的是 `quiet: true`（见 electron/main.cjs），
       * 于是整个 `if (!quiet) { ... }` 块被跳过 —— 开机续跑的调度从来就没注册过。
       * 这是「有时只重启不续跑」的第三层原因（前两层：intent 读不到、3 秒 < 启动 62 秒）。
       * 续跑跟「要不要打印启动日志」毫无关系，搬出来。
       */
        setTimeout(() => {
          try {
            /* 【2026-11-07 加·这条链路以前一声不响】
             * 实测：开机续跑一次都没触发，可哪儿都没日志 ——
             * 因为这个 try 里的几个 return 和 catch 只往 console 打，
             * 而安装版没有控制台，等于什么都没留下。
             * 现在每一道闸都写 diag.log，下次一看就知道卡在哪一步。 */
            diagLog('boot-resume-enter', 'start');
            const f = getFeatures();
            const on = Boolean(f && f.features && f.features.find((x) => x.id === 'selfRestart')?.enabled);
            if (!on) { console.log('  resume   : 「自动重启续上」关着，不续'); diagLog('boot-resume-skip:switch', 'off'); return; }
            /**
             * 【2026-11-07 改·有几个续几个】
             *
             * 原来这里只取一条（peekInterrupted）就起一轮 ——
             * 可主人常常同时开着两三个会话，一个是【检查鱼】一个是【杂活鱼】，
             * 重启后只有一个活了，另一个就那么停在那儿。
             * 现在 resume.json 一个会话一条（见 resume.mjs），这里挨个起回来。
             *
             * 错开 1.5 秒不是一个一个排队跑，只是别让他们在同一毫秒一起抢模型端点；
             * 真要排队的话，第二个会一直等到第一个（可能十几分钟）跑完，那更糟。
             */
            const pendingAll = listInterrupted();
            /* 【2026-11-07】只自动续「真的被打断」的；清单老账留在文件里等主人手动点。
             * 实测退出一次能记出 8 条「清单还有没做完的」，全续会把端点直接打爆。 */
            const pendingList = pendingAll.filter((x) => x && x.autoResume === true);
            if (!pendingList.length) {
              console.log('  resume   : 没有需要自动续的（待续 ' + pendingAll.length + ' 条，都是清单老账）');
              diagLog('boot-resume-skip:none', 'all=' + pendingAll.length);
              return;
            }
            if (pendingAll.length > pendingList.length) {
              console.log('  resume   : 另跳过 ' + (pendingAll.length - pendingList.length) + ' 条清单老账（不自动续）');
            }
            console.log('  resume   : 有 ' + pendingList.length + ' 个会话没做完，逐个接着做');
            diagLog('boot-resume-go', pendingList.map((x) => x.sessionId).join(','));
            pendingList.forEach((it, i) => {
              setTimeout(() => {
                console.log('  resume   : [' + (i + 1) + '/' + pendingList.length + '] '
                  + it.sessionId + '（' + it.reason + '）');
                resumeInterruptedTurn(it.sessionId)
                  .catch((e) => {
                    console.warn('[resume] 自动续跑失败：', String(e?.message ?? e));
                    diagLog('boot-resume-fail', it.sessionId + ' ' + String(e?.message ?? e));
                  });
              }, i * 1500);
            });
          } catch (e) {
            console.warn('[resume] 开机自续没跑成（不影响使用）：', String(e?.message ?? e));
            diagLog('boot-resume-error', String(e?.message ?? e));
          }
        }, 8000);
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

        /**
         * 【2026-11-05 加·重启后自己续上】
         *
         * 主人报：「有【自动重启续上】功能，却只做到了自动重启，没做到续上」。
         *
         * 查下来是这样：重启前确实写了 .state/resume.json（谁被打断、断在哪、清单还剩几步），
         * 但是**启动流程里没有任何一行去读它** —— 全项目只有 `POST /api/resume`
         * 那条手动路径会调 resumeInterruptedTurn()。所以文件躺在盘上，一直到过期都没人碰。
         *
         * 现在补上：起来等三秒（让前端把 WebSocket 连上，不然事件发出去没人收），
         * 如果还压着旧账、而且「自动重启续上」这个开关是开的，就自己接着做。
         *
         * 为什么尊重开关：主人关掉它就是要「干净重启」，这时候自作主张爬起来接着干
         * 比不续还烦人。
         */

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
      // 「自己注册的号」那条道如果开了「开机就连」，这里替主人接上。
      // 不 await：连不上也不该拖住启动（自愈和重拨都在 qq-onebot 里）。
      bootAutoStartOneBot(quiet);
      bootPruneQqMedia(quiet);
    });

  });
}

// Auto-start when launched directly (node src/server.js).
const isDirectRun = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/server.mjs');

/**
 * 【2026-11-09 加·QQ 收到的图/语音/文件从来不删，硬盘只涨不落】
 *
 * qq-media.mjs 里早就写好了 pruneMediaDir(keepDays) —— 但**没有任何地方调用它**，
 * 于是 data/qq-media 只会越堆越大（图片视频都往那儿落）。主人用久了就是几个 G。
 *
 * 现在开机先等 20 秒（别跟启动抢 IO），清一次「7 天前的」；之后每 24 小时一次。
 * 定时器 unref，不拦着进程退出。删不掉的（正被占用）跳过，不抛。
 */
async function bootPruneQqMedia(quiet) {
  const run = async (why) => {
    try {
      const m = await import('./qq-media.mjs');
      const n = m.pruneMediaDir(7);
      if (n && !quiet) console.log(`  qq-media : 清掉 ${n} 个超过 7 天的附件`);
      if (n) diagLog('qq-media-prune', why + ' ' + n);
    } catch (e) {
      if (!quiet) console.log(`  qq-media : 清理跳过（${String(e?.message ?? e)}）`);
    }
  };
  setTimeout(() => { run('boot'); }, 20_000).unref?.();
  const timer = setInterval(() => { run('daily'); }, 24 * 3600_000);
  timer.unref?.();
}

/**
 * 【开机自动连上「自己注册的号」】2026-11-03
 *
 * 主人报过「QQ 一直显示正在连」：协议端挂了、或者程序重开之后那条道就不接了。
 * 现在 onebot.autoStart 一开，小鱼Agent 自己起来就把这条道接上，
 * 接不上也会由 qq-onebot 的重拨 + 看门狗自己爬起来。
 */
async function bootAutoStartOneBot(quiet) {
  try {
    const ob = await import('./qq-onebot.mjs');
    const conf = ob.oneBotConf();
    if (!conf.enabled || !conf.autoStart) return;
    if (!quiet) console.log('qq: 开机自动连接「自己注册的号」');
    const { startQqOneBot } = await import('./qq-bridge.mjs');
    const st = await startQqOneBot({
      ensureSession: ensureQqSession,
      renameGroupSession,
      runChat: runQqTurn,
      setSpeakerOwner: markQqOwner,
      onLog: () => {},
    });
    if (!quiet) console.log(`  qq       : ${st.phase}（自己注册的号，自动重连已开）`);
  } catch (e) {
    console.log(`qq: 开机自动连接失败 —— ${String(e?.message ?? e)}`);
  }
}

/**
 * 【把 QQ 这一侧装到服务器身上】2026-11-01
 *
 * 为什么放在文件末尾、而不是写在某个函数里面：mountQq 要的是「一堆已经存在的函数」，
 * 放在最后能保证它们全都声明过了（函数声明会提上来，但这些是 const / 闭包里的东西，
 * 位置摆错就是 undefined）。
 *
 * 这里给 qq-server.mjs 的是「跑一轮需要的那几只手」：拿会话、存会话、开新会话、
 * 以及 runAgent + 工具上下文。给了它们，QQ 那边就不必自己再造一套会话引擎。
 */
mountQq({
  getSession,
  saveSession,
  publicSession,
  isSessionId,
  newSessionId,
  runAgent,
  runWithToolContext,
  snapFor: (sid) => {
    // 跟 /api/chat 一样：这一轮的「点单」快照（哪一轮改了哪些文件）。
    // 这里给一个空对象就行 —— QQ 那边没有「主人手上那句消息」可以挂回滚点，
    // 记在别处反而会让回退错位。所以是「空快照」而不是「不许快照」。
    return {};
  },
  inPersonaMode,
  sessionModeWord,
  fishOn,
  setFishOn,
  setIdentity,
  runningTurns,
  liveLogs,
  /**
   * 给 QQ 的人开新会话。
   *
   * 用的是新建会话那条正路（makeSession 的逻辑），但有两点不一样：
   *   · 不跑开场白 —— QQ 上的人一进来就看见「主人你可算来了」很怪，
   *     而且开场白会调一次模型、白花钱。
   *   · 名字直接用传进来的 title。
   */
  newSessionFor: async ({ title = '', agentId = 'xiaoyu' } = {}) => {
    const id = newSessionId();
    const now = Date.now();
    const session = {
      id,
      title: String(title || 'QQ 会话').slice(0, 40),
      createdAt: now,
      updatedAt: now,
      messages: sysSeed(id),
      _openingPending: false,
    };
    saveSession(session);
    sessions.set(id, session);
    try { ensureMemory(id); } catch {}
    setLastSessionId(id);
    try { if (agentId) setSessionAgent(id, agentId); } catch {}
    return { id };
  },
});

if (isDirectRun) startServer().catch((err) => {
  console.error('failed to start:', err?.message ?? err);
  process.exit(1);
});
