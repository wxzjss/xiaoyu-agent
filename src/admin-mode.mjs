/**
 * 【管理员权限】—— 她可以动工作区以外的东西（2026-11-01）。
 *
 * 参考 dsh-admin-mode 那个插件：它在权限菜单里加了一档「管理员」＝
 * 完全访问 + 永不询问 + 内置 computer use + 操控提示。这里做同一件事：
 * 把「只能在工作区里动」这条默认红线，变成一个**按会话、可开可关**的档位。
 *
 * ── 2026-11-13 主人钦点：默认开启 ──────────────────────────────
 * 主人原话：「把【管理员】按钮删除，改卡片形式放到【插件】页面里，且改为默认开启」。
 * 现在语义反过来：**没显式关过 = 开**，表里只记「谁被显式关掉」。
 * 旧文件（version 1，只有 on 表）读进来兼容：on:true 跟默认开同义。
 *
 * ── 旧说明（2026-11-01 当时为什么做成开关） ──────────────────────
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

/** 读整张表。返回 { off, on }：off = 显式关掉的会话；on = 兼容读旧格式。
 *  坏文件返回 null。
 *
 *  【2026-11-13 主人钦点：管理员档改为默认开启】
 *  旧语义是「没开过 = 关」（fail-closed，升高权限要显式点头）。
 *  主人原话：「改为默认开启」—— 现在反过来：**没显式关过 = 开**。
 *  表里只记「谁被显式关掉」（off）；旧的 on 表读进来只为兼容（旧 on:true 跟默认开同义）。
 *  读盘失败也按默认开处理（主人的意图就是让它开）。
 */
function readState() {
  try {
    const f = file();
    if (!existsSync(f)) return { off: {}, on: {} };
    /* 【2026-11-06 修·BOM 会让整张权限表静默失效】读之前剥掉 BOM；解析失败喊一声。 */
    let raw = readFileSync(f, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    return {
      off: (j && j.off && typeof j.off === 'object' && !Array.isArray(j.off)) ? j.off : {},
      on: (j && j.on && typeof j.on === 'object' && !Array.isArray(j.on)) ? j.on : {},
    };
  } catch (e) {
    log('读表失败，按「默认开启」处理：' + (e && e.message ? e.message : e));
    return null;
  }
}

function writeState(st) {
  const f = file();
  try {
    mkdirSync(dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 2, off: st.off, on: st.on }, null, 2), 'utf8');
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
 * 【2026-11-13 默认开启】没显式关过 = 开。off 表里有它才是关。
 */
export function adminOn(sessionId) {
  const sid = String(sessionId || 'default');
  const st = readState();
  if (!st) return true;
  if (st.off[sid] === true) return false;
  return true;
}

/**
 * 开 / 关。
 *
 * 返回 { ok, sessionId, on }；写盘失败 ok=false（界面那边会提示出来）。
 */
export function setAdminOn(sessionId, on) {
  const sid = String(sessionId || 'default');
  const want = on === true;
  const st = readState() || { off: {}, on: {} };
  if (want) {
    delete st.off[sid];
    st.on[sid] = true;
  } else {
    st.off[sid] = true;
    delete st.on[sid];
  }
  const ok = writeState(st);
  log(`${want ? '开' : '关'} session=${sid} ok=${ok}`);
  return { ok, sessionId: sid, on: want ? adminOn(sid) : false };
}

/** 现在哪些会话开着（界面/自检用）：默认全开，减去显式关掉的。
 *  只能列出「有记录的」——没记录的会话也是开（默认档），列不全就算了。 */
export function adminSessions() {
  const st = readState() || { off: {}, on: {} };
  const on = new Set(Object.keys(st.on || {}));
  for (const sid of Object.keys(st.off || {})) on.delete(sid);
  return Array.from(on);
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
    '【管理员权限 · 这一轮是开着的 · 什么都不用问】',
    '你不再被关在工作区里了：整台机器上的文件你都能读、能写、能跑命令（桌面、下载、别的盘、系统目录都算）。',
    '',
    '【主人的硬规矩 · 2026-11-01】主人原话：「无论什么事都无需询问主人，自己做决定」。',
    '所以这一档下：',
    '· 不问「要不要我做」—— 该做就做。',
    '· 不问「我可以删吗」「确认一下我就动手」—— 直接做。',
    '· 不问「要不要重启 / 要不要装 / 要不要改」—— 自己判断，利弊想清楚就拍板。',
    '· 不把决定权推回去让主人选 A 还是 B —— 你自己选一个，做完告诉他你选了哪个、为什么。',
    '· 卡住了不是回来问，是自己换个法子接着办（查日志、翻源码、写新功能、找替代方案）。',
    '',
    '【程序本体 · 2026-11-13 主人钦点：完美掌控小鱼Agent这个程序】',
    '小鱼Agent 本身（源码、配置、安装包、界面、功能、智能体、插件）也在你的掌控范围内：',
    '· 改自己的源码 / 配置 / 人设 / 功能开关 / 智能体花名册 —— 直接改，不用请示。',
    '· 重启自己：调 restart_self。别的会话在跑被 409 挡了也不用问，会自动带 force 重试。',
    '· 自更程序本体（改完代码要让安装版生效）：跑',
    '    powershell -File scripts\\repack-installed-app.ps1 -SelfUpdate',
    '  它会杀掉应用（包括你这一轮）→ 换包 → 自动拉回来；你被打断的这轮由开机自续接回，',
    '  说过的话主人屏幕上还看得到。跑之前把「这轮改了什么」先说清楚。',
    '· 团队模式开关不拦你：管理员档下随时可以 spawn_worker / spawn_workers 派活。',
    '',
    '唯一还留着的三条（这不是问不问的问题，是根本不许做的）：',
    '1. 记忆本（.state 里的那几份）不因为开了这一档就放开，别去碰。',
    '2. 别自己把这一档关掉，也别想办法绕过它。',
    '3. 做完必须如实交代：动了什么、动了哪儿、结果怎样 —— 不许瞒、不许含糊。这一条比「不停下来问」还硬。',
  ].join('\n');
}
