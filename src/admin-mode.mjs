/**
 * 【管理员权限】—— 她可以动工作区以外的东西（2026-11-01）。
 *
 * 参考 dsh-admin-mode 那个插件：它在权限菜单里加了一档「管理员」＝
 * 完全访问 + 永不询问 + 内置 computer use + 操控提示。这里做同一件事：
 * 把「只能在工作区里动」这条默认红线，变成一个**按会话、可开可关**的档位。
 *
 * ── 为什么这件事必须做成「开关」，而不是「平时就开着」 ──────────────
 *
 * 默认状态下，她 read_file / write_file / run_command 全都被 safePath 关在工作区里
 * （老板的整套东西只有一份，位置出错代价太大）。这一档打开之后，她能看到整台机器：
 * 桌面、下载、别的盘、系统目录。
 *
 * 这是**升高权限**，不是新功能 —— 所以：
 *   · 按会话存（跟小鲸在场、专业模式一个待遇），不在这个会话里开就绝对不发生
 *   · 读盘失败一律当「没开」（fail-closed），绝不因为文件坏了就悄悄放开
 *   · 每次开关都写进 .state/admin.log，主人事后能看出「什么时候谁开的」
 *   · .state 里的记忆本禁区不因为开了这一档就放开（那条闸在 safePath 里排在前面）
 *
 * ── 跟 CTX.fullAccess 的关系 ────────────────────────────────────
 *
 * CTX.fullAccess 是「小鲸跑那一趟」的临时放行，跑完立刻改回 false（runSubagent 用）。
 * 这一档是**会话级的**：每轮开跑前把它读进 CTX.adminMode，
 * 两个条件满足一个就放开 —— 谁都别去改 CTX.fullAccess 来蹭这一档的语义。
 */
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.mjs';

function file() {
  return join(config.dataDir, '.state', 'admin-mode.json');
}

function logFile() {
  return join(config.dataDir, '.state', 'admin.log');
}

/** 读整张表：{ '<sessionId>': true }。坏文件一律当空表（= 全都没开）。 */
function readTable() {
  try {
    const f = file();
    if (!existsSync(f)) return {};
    const j = JSON.parse(readFileSync(f, 'utf8'));
    if (j && j.on && typeof j.on === 'object' && !Array.isArray(j.on)) {
      const map = {};
      for (const [k, v] of Object.entries(j.on)) if (v === true) map[k] = true;
      return map;
    }
    return {};
  } catch {
    return {};
  }
}

function writeTable(map) {
  const f = file();
  try {
    mkdirSync(dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, on: map }, null, 2), 'utf8');
    renameSync(tmp, f);
    return true;
  } catch (e) {
    console.warn('[admin-mode] 写不进盘：', String(e?.message ?? e));
    return false;
  }
}

function log(line) {
  try {
    mkdirSync(dirname(logFile()), { recursive: true });
    appendFileSync(logFile(), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去不影响功能 */
  }
}

/**
 * 这个会话现在是不是管理员权限。
 *
 * 【读盘失败 = 关】见文件头：这是升高权限的开关，宁可开不了也不能莫名开着。
 */
export function adminOn(sessionId) {
  const sid = String(sessionId || 'default');
  const map = readTable();
  return map[sid] === true;
}

/**
 * 开 / 关。
 *
 * 返回 { ok, sessionId, on }；写盘失败 ok=false（界面那边会提示出来）。
 */
export function setAdminOn(sessionId, on) {
  const sid = String(sessionId || 'default');
  const map = readTable();
  const want = on === true;
  if (want) map[sid] = true;
  else delete map[sid];
  const ok = writeTable(map);
  log(`${want ? '开' : '关'} session=${sid} ok=${ok}`);
  return { ok, sessionId: sid, on: want && adminOn(sid) };
}

/** 现在哪些会话开着（界面/自检用）。 */
export function adminSessions() {
  return Object.keys(readTable());
}

/**
 * 给系统提示用的一段话。
 *
 * 【为什么要写进提示词】
 * dsh-admin-mode 里那一条「操控提示」说的就是这个：模型不知道自己有权限时，
 * 会先小心翼翼地问「要不要我去 XX 目录看看」——主人已经开过了，还得再答一次。
 * 反过来，提示词里写清了边界，她才会真的去用。
 *
 * 【2026-10-29 主人改口径：别问了，自己决定】
 * 主人原话：「太烦了，一直问一直问，随便一个事情都要问」。
 * 所以这一档现在照 dsh-admin-mode 的本意走 —— **完全访问 + 永不询问**：
 * 不可逆的事不再回来请示，自己判断、自己动手、事后说清动了什么。
 * 唯一留下的是「记忆本别碰」（那不是权限问题，是另一道闸，见 tools.mjs 的 memoryLocked）
 * 和「别自己把这一档关掉/绕过」。
 *
 * 为什么不能只是把「先问」删掉了事：光删掉这句话，模型反而会捏出
 * 「那我是不是该问一下」的第三种理解。所以这里要**正面写清楚该怎么做**：
 * 别请示、别确认、直接做完再如实交代。
 */
export function adminPromptBlock(sessionId) {
  if (!adminOn(sessionId)) return '';
  return [
    '【管理员权限 · 这一轮是开着的】',
    '你不再被关在工作区里了：整台机器上的文件你都能读、能写、能跑命令（桌面、下载、别的盘、系统目录都算）。',
    '所以你现在可以直接办「把桌面上那个表格给我改一下」「看看 D 盘还剩多少」这类事，不用先问「我有权限吗」。',
    '',
    '但记住三条：',
    '1. 不可逆的事不用回来问：删文件、覆盖原文件、改注册表、装/卸软件、动系统目录 —— 你自己判断该不该做，该做就直接做完，别再「要我删吗」「确认一下我就动手」地请示。做完在回话里说清你动了什么、动了哪儿，让他事后看得见。（主人说过：一直问、随便一件小事都问，太烦了。）',
    '2. 记忆本（.state 里的那几份）不因为开了这一档就放开，别去碰。',
    '3. 这一档是主人一个会话一个会话开的，不是长期的。他说关就关，别自己想办法绕过。',
  ].join('\n');
}
