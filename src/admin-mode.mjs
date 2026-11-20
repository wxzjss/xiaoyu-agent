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
import { readFileSync, writeFileSync, renameSync, mkdirSync, appendFileSync } from 'node:fs';
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
 *  文件尚未创建时使用默认值。配置损坏或无法读取时关闭权限。
 */
function readState() {
  try {
    const f = file();
    /* 【2026-11-06 修·BOM 会让整张权限表静默失效】读之前剥掉 BOM；解析失败喊一声。 */
    let raw = readFileSync(f, 'utf8');
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    const j = JSON.parse(raw);
    const isTable = (value) => value && typeof value === 'object' && !Array.isArray(value);
    if (!isTable(j) || (!Object.hasOwn(j, 'off') && !Object.hasOwn(j, 'on'))
        || (j.version === 2 && !Object.hasOwn(j, 'off'))
        || ['off', 'on'].some((key) => Object.hasOwn(j, key)
          && (!isTable(j[key]) || Object.values(j[key]).some((value) => typeof value !== 'boolean')))) {
      throw new Error('权限表格式错误');
    }
    return { off: j.off || {}, on: j.on || {} };
  } catch (e) {
    if (e?.code === 'ENOENT') return { off: {}, on: {} };
    log('读表失败，关闭管理员权限：' + (e && e.message ? e.message : e));
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
  if (!st) return false;
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
  const st = readState();
  if (!st) return { ok: false, sessionId: sid, on: false };
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
  /* 【2026-11-16 主人要求：这一段提示词整段删掉】
   * 主人点名要删：管理员权限标题段、程序本体段、唯一还留着的三条段。
   * 权限本身（adminOn / safePath 放行 / 不询问行为）一点没动，只是不再往
   * 系统提示里写这段话 —— 工具描述和别处的规矩照旧生效。 */
  return '';
}
