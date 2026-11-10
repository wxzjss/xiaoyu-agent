// Sessions on disk: .state/sessions/<id>.json + _last.json (最近会话).
// Every turn writes back to disk, so a reload/power-cut never loses the conversation.
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, openSync, writeSync, fsyncSync, closeSync, unlinkSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state', 'sessions');
const TRASH = join(DIR, '.trash');
const LAST = join(DIR, '_last.json');
const PLAN_DIR = join(config.dataDir, '.state', 'plan');
const MAX_TITLE = 40;

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

export function isSessionId(id) {
  return typeof id === 'string' && ID_RE.test(id);
}

function ensureDir(dir = DIR) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function fileFor(id) {
  return join(DIR, `${id}.json`);
}

/**
 * 睡一小会儿（同步版）。给下面的 rename 重试用 —— writeFileAtomic 是同步函数，
 * 里面不能 await，Atomics.wait 是同步阻塞里最省事、不烧 CPU 的睡法。
 */
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

/**
 * 原子写：先写同目录下的 .tmp，fsync 落盘，再 rename 覆盖目标。
 *
 * 【为什么不用 writeFileSync 直接盖】2026-10-29 修。
 * writeFileSync 是「打开目标 → 截断成 0 字节 → 往里写」，中间任何一刻进程被杀、
 * 断电、磁盘满，目标文件就停在「空的」或「半截 JSON」的状态 —— 整个会话当场没了，
 * 而且 JSON 坏掉之后 loadSession 只会当「这会话不存在」，连抢救的机会都没有。
 * rename 在同一分区上是原子的：要么还是旧的完整文件，要么就是新的完整文件。
 *
 * 【rename 撞 EPERM 不能就此罢手】2026-11-01 修 —— 那次真的丢了内容。
 *
 * 主人看到控制台红字：
 *   EPERM: operation not permitted, rename
 *   '...\sessions\smvv46rof8ijm.json.tmp-544' -> '...\sessions\smvv46rof8ijm.json'
 * 会话没写进盘 —— 磁盘上那份停在 00:59:59，进程 01:03 才重启，中间那几分钟的话全没了。
 *
 * Windows 上 rename 覆盖一个「正被别的句柄打开着」的文件会回 ERROR_ACCESS_DENIED，
 * Node 摊成 EPERM。打开它的通常不是我们自己（本项目读会话都是读完即关、不常驻 fd），
 * 而是杀毒软件扫刚写出来的文件、搜索索引器、备份/同步工具 —— 全是几百毫秒内的短暂占用。
 * 旧实现一次失败就 throw，撞上一次就丢一轮对话；而它偏偏在「文件刚被写大」时最容易撞上
 * （杀毒就是见新文件才扫），也就是内容最多的那几轮最危险。
 *
 * 现在的做法：
 *   ① tmp 文件名带 pid + 随机串 —— 同进程两处并发写不会再撞到同一个 tmp 路径；
 *   ② EPERM / EACCES / EBUSY 重试 6 次，退避 20→120ms（合计约半秒）；
 *   ③ 还换不上就退回「直接写目标文件」：原子性让一步，但这一轮的话必须留下。
 *      直接写是「截断再写」，那半毫秒里断电仍可能坏，属于极小概率；
 *      而 rename 被占是每次杀毒扫描都可能撞上的常事。两害相权，选留下内容。
 *
 * @returns {'rename'|'direct'} 怎么落下去的，只为了能记日志
 *
 * 【2026-11-10 D2 导出】原来只有本文件在用（会话存盘、_last.json）。
 * 但全仓还有几处状态文件在用裸 writeFileSync 直接盖：
 * thinking.json / models.json / session-overrides.json / diag.log 轮转 ——
 * 它们同样会「进程被杀时留半截 JSON」。导出复用，崩溃不再留半截状态文件。
 */
export function writeFileAtomic(file, text) {
  /**
   * tmp 名字：以 `.` 开头、且不伪装成 `.json` —— 2026-11-01 加。
   *
   * 原来叫 `<id>.json.tmp-<pid>`。任何「遍历会话目录」的代码（我们自己、测试、外部工具）
   * 都会把它当成一个会话文件抓走；等 rename 把它搬走，那边 stat 就 ENOENT。
   * 实测就是这么挂的：_t_select 复制目录时炸在
   *   stat ...\smvvr7pdnhyp4.json.tmp-30348-bsp77o
   * 现在的名字 `.<id>.json.tmp-<pid>-<随机>`：以点开头 —— listSessions 本来就跳过点开头的，
   * 别人的遍历也天然忽略；后缀不是 .json，认错过一次的东西不会再认错第二次。
   */
  const tmp = join(dirname(file), '.tmp-' + basename(file) + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
  let fd = null;
  try {
    fd = openSync(tmp, 'w');
    writeSync(fd, text);
    try { fsyncSync(fd); } catch {}
    closeSync(fd);
    fd = null;

    let lastErr = null;
    for (let i = 0; i < 6; i++) {
      try {
        renameSync(tmp, file);
        return 'rename';
      } catch (e) {
        lastErr = e;
        const code = e && e.code;
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw e;
        sleepSync(20 * (i + 1));
      }
    }

    // 重试到底也换不上：别再抛了，直接把内容写进目标文件。
    try {
      console.warn('[sessions] rename 连试 6 次都被占（' + String((lastErr && lastErr.code) || lastErr) + '），改为直接写目标文件：' + file);
    } catch {}
    writeFileSync(file, text);
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    return 'direct';
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    throw e;
  }
}

/**
 * 会话文件在磁盘上的完整路径。
 * 给外面（server.mjs）用：它靠 statSync 这个文件判断内存缓存是不是过期了。
 * 不导出的话外面只能自己拼一遍路径 —— 拼错了就悄悄失效，这类 bug 最难查。
 */
export function sessionPath(id) {
  return fileFor(id);
}

function cleanTitle(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
}

/** First user line doubles as the session title. */
export function titleFromMessage(text) {
  const raw = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!raw) return '新会话';
  const line = raw.split(/[。！？!?\n]/)[0].trim() || raw;
  return line.slice(0, MAX_TITLE);
}

export function newSessionId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 读历史时剔掉「伪装成主人说话的报错」。
 *
 * 【为什么要有】
 * 老版本在连接断掉 / 网关 502 时，会把 `⚠ terminated`、`⚠ LLM HTTP 502: {...}`
 * 当成一条 role:'user' 的消息写进历史。它们看着像主人发的，实际是系统告警。
 *
 * 危害有三个，都不小：
 * 1. 界面上这几个字显示成主人的气泡，主人会以为是自己说的；
 * 2. 每次继续对话都原样发给模型，模型以为主人真的说了这句，白费 token 还带偏判断；
 * 3. 502 重试那段逻辑会被自己造成的假 user 消息污染。
 *
 * 现在的写入路径已经不再这么干了（报错走前端提示条，不进历史），
 * 但磁盘上老会话里的那几条还在 —— 这里读的时候统一滤掉，不动物理文件，想回滚随时能回去。
 */
const ALERT_USER_RE = /^\s*⚠/;

function sanitizeLoadedMessages(list) {
  if (!Array.isArray(list) || !list.length) return list || [];
  const out = [];
  /* 【2026-11-05 修·const 被重新赋值，整个会话读不出来】
   *
   * 症状：重启后某个会话从列表里凭空消失（主人报「检查鱼不见了」）。
   *
   * 根因：下面为了剥掉正文里的 <thinking> 标签，写了一句 `m = { ...m, content: ... }`，
   * 可循环变量声明成了 `const m` —— 给常量赋值直接抛 TypeError，
   * 被 loadSession 的 catch 吞掉 → 返回 null → 界面上就少一条。
   * 而且**只有历史里带过 <thinking> 的会话才会中招**，所以是「有时候少一个」。
   *
   * 改成 let。另外那个 catch 也一并改成会打日志，别再让这种事查半天。
   */
  for (let m of list) {
    if (m && m.role === 'user') {
      // content 可能是字符串，也可能是 [{type:'text',text:...}, ...] 这种多段结构
      let head = '';
      if (typeof m.content === 'string') head = m.content;
      else if (Array.isArray(m.content)) {
        const t = m.content.find((x) => x && typeof x.text === 'string');
        head = t ? t.text : '';
      }
      if (ALERT_USER_RE.test(head)) continue; // 系统告警，不是主人说的话
      if (m._sysNote === true) continue; // 程序自己插的量线提醒，不是主人说的话
      // 【2026-10-31 补】老会话里已经写进去的「〔量线／〔压缩」提醒也一并遮掉 —— 那是程序插的，不是主人说的。
      if (/^\s*〔(量线|压缩|程序自动插入)/.test(String(m.content || ''))) continue;
    }
    // 【2026-11-05】剥掉正文里的思考标签：有的网关把思考塞进 content，
    // 老会话里已经躺了一批这样的脏消息，读的时候一并清掉。
    /* 【2026-11-06 修·孤立结束标签清不掉】
     * 入口原来只认「有起始标签」。可逐块剥留下的残渣往往是孤零零一个 </thinking>
     * （起始标签在前一块已经被整段吃掉了）—— 这种脏消息进不了这道门，一直留着。
     * 实测盘上就有这样的：6 条有起始标签能清，1 条只剩结束标签清不掉。
     * 改成「有任一种标签就进」，让 stripThinkTags 自己去判断怎么清。 */
    if (m && typeof m.content === 'string' && /<\/?(thinking|think|reasoning)[\s>]/i.test(m.content)) {
      m = { ...m, content: stripThinkTags(m.content) };
    }
    /**
     * 【2026-11-07 加·角色标签不是正文】
     *
     * 实测杂活鱼第 368 条：content 就是 `<assistant>`（11 个字符），
     * 后面跟着 tool_calls —— 模型调工具前先吐了个角色标签当开头。
     * 这是训练数据里的对话格式漏出来了，存盘时清掉。
     * 有 tool_calls 的只清 content，调用本身保留（否则 tool 消息会变成孤儿）。
     */
    if (m && typeof m.content === 'string' && /<\/?(assistant|user|system)\s*>/i.test(m.content)) {
      m = { ...m, content: m.content.replace(/<\/?(?:assistant|user|system)\s*>/gi, '').trim() };
    }
    /* 【2026-11-05】压缩记忆也不该出现在正文里（她有时候会照写出来）。 */
    if (m && typeof m.content === 'string' && m.content.indexOf('【压缩记忆') >= 0) {
      m = { ...m, content: stripCompressMemory(m.content) };
    }
    out.push(m);
  }
  return out;
}

export function loadSession(id) {
  if (!isSessionId(id)) return null;
  try {
    const raw = JSON.parse(readFileSync(fileFor(id), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    return {
      id,
      title: cleanTitle(raw.title) || '新会话',
      createdAt: Number(raw.createdAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
      messages: sanitizeLoadedMessages(Array.isArray(raw.messages) ? raw.messages : []),
      // 回退点跟着会话一起落盘：只追加、从不改写老消息。
      rewinds: Array.isArray(raw.rewinds) ? raw.rewinds : [],
      // 老会话没有这个字段 -> 当人设档处理，不去补写盘
      mode: raw.mode && typeof raw.mode === 'object' && raw.mode.word ? { word: String(raw.mode.word), since: Number(raw.mode.since) || 0 } : null,
    };
  } catch (e) {
    /* 【2026-11-05 加·别把错误吞掉】
     * 原来这里 `catch { return null }` —— 一个会话读不出来，界面上就凭空少一条，
     * 而且一点线索都没有（主人报「重启后某个会话不见了」，我查了半天都没方向）。
     * 现在至少把 id 和原因打到日志里。 */
    try { console.warn('[sessions] 读不出来，已跳过：' + id + ' —— ' + String(e && e.message ? e.message : e)); } catch (e2) {}
    return null;
  }
}

/**
 * 【2026-10-29 修 · 存盘前把「同一次生成的同一句话」只留一份】
 *
 * 症状：切会话 / 重启几次之后，会话里同一条长回复躺着 3~5 份，界面上看着像
 * 「一口气说了一大堆活」。
 *
 * 病根：历史数组会被重新拼（wireMessages 换引用、合并、压缩回写），
 * 拼的时候同一条 assistant 可能被接两遍。commitWireBack 那边已经加了一道关，
 * 这里是**最后一道**：不管上面怎么绕，落盘之前过一遍。
 *
 * 判据用 role + _at + 正文 + 工具调用 id：
 *   · _at 是那次生成的时间戳，同一次只有一值 —— 同 _at 同正文 = 重复，删掉后面的；
 *   · 我过一会儿又认真说一遍（不同 _at）→ 不同键，留着。
 * 只动 assistant（带 tool_calls 的也不动），user / tool / 摘要一概不碰。
 */
function dropRepeatedTurns(ms, maxScan = 400) {
  if (!Array.isArray(ms) || ms.length < 2) return 0;
  const start = Math.max(0, ms.length - maxScan);
  const seen = new Set();
  const kill = [];
  for (let i = start; i < ms.length; i++) {
    const m = ms[i];
    if (!m || m.role !== 'assistant') continue;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) continue;
    const body = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => (p && (p.text || p.type)) || '').join('\n') : '';
    if (!body || body.trim().length < 80) continue;   // 短句（「好」「收到」）可能是真说了两遍
    const k = String(m._at || '') + '|' + body;
    if (seen.has(k)) { kill.push(i); continue; }
    seen.add(k);
  }
  for (let n = kill.length - 1; n >= 0; n--) ms.splice(kill[n], 1);
  if (kill.length) {
    try { console.log('[dedupe] 落盘前清掉 ' + kill.length + ' 条重复的回复'); } catch {}
  }
  return kill.length;
}

/**
 * 一条消息的指纹：role + tool_call_id + tool_calls 的 id + 正文。
 *
 * 合流去重、以及「删掉的别再接回来」都靠它认人。原来是 saveSession 里的局部函数，
 * 2026-10-29 提到模块级：删消息的那一端（server.mjs 的 /api/reset）也得用它算指纹，
 * 两边各算一套迟早算出不一样的。
 */
export function messageKey(m) {
  if (!m || typeof m !== 'object') return null;
  const role = String(m.role || '');
  if (!role) return null;
  const txt = typeof m.content === 'string' ? m.content
    : (m.content == null ? '' : JSON.stringify(m.content));
  let tcId = '';
  if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
    tcId = m.tool_calls.map((x) => String(x && x.id ? x.id : '')).join(',');
  }
  const callId = m.tool_call_id ? String(m.tool_call_id) : '';
  return role + '|' + callId + '|' + tcId + '|' + txt;
}

/**
 * 【写完前先验内存还在不在】
 *
 * saveSession 会拿磁盘那份来合流（见下面「合流」那段）：磁盘上有、内存里没有的
 * 消息会被当成「插话刚 push 进来、还没落盘的那一句」接回末尾。
 *
 * 这条规矩本身是给插话用的，可它跟「删消息」撞在一起就翻车 ——
 * 删掉的消息在磁盘旧文件里还在，于是每一轮存盘都把它接回来一次，
 * 主人删了三次、它回来三次。2026-10-29 实测：/api/interject 插的那条测试消息，
 * 手工从磁盘删掉后，下一轮 saveSession 又写回来了（sandbox/_repro_wipe2.mjs）。
 *
 * 真正的病根是「凭记忆判断磁盘新不新」：这份 session 可能是这一轮开头就抓下来的
 * 旧副本，中途别人（插话、重置、压缩、另一轮）已经改过内存里那份真的了。
 * 拿旧副本去索引磁盘，必然把它判成「磁盘上多出来的新消息」。
 *
 * 所以在**读磁盘之前**记下内存那份的版本号，合流之后再验一次：
 * 变了 = 说明这次合流的前提已经作废，直接放弃、重来一次。
 */
function memStamp(session) {
  if (!session || typeof session !== 'object') return null;
  const m = session.messages;
  return (Array.isArray(m) ? m.length : -1) + '|' + String(session.updatedAt || 0);
}

export function saveSession(session, _attempt = 0) {
  // 落盘前最后一道：清掉同一次生成被接入多份的重复回复（见 dropRepeatedTurns 上的说明）
  try { if (session && Array.isArray(session.messages)) dropRepeatedTurns(session.messages); } catch {}
  /**
   * 【2026-11-02 历史迁移】旧版本投的「重启了」没带 _sysNote 标记，会在界面上冒充主人说话。
   *  主人要求这条只给我自己看（跟压缩提示同一个待遇）。
   *  判据：内容正好是「重启了」+ 前面紧跟一条 tool 结果 —— 系统投的那条永远接在
   *  「重启前最后一步工具」后面；主人自己手打的那两次，前面都是我的 assistant 回复，误伤不到。
   *  放在落盘前做，写下去的这份就是干净的，不用等重启。
   */
  try {
    const _ms = session && Array.isArray(session.messages) ? session.messages : [];
    for (let _i = 1; _i < _ms.length; _i++) {
      const _m = _ms[_i];
      if (!_m || _m.role !== 'user' || String(_m.content || '') !== '重启了') continue;
      if (_m._sysNote === true) continue;
      const _prev = _ms[_i - 1];
      if (_prev && _prev.role === 'tool') _m._sysNote = true;
    }
  } catch {}
  if (!session || !isSessionId(session.id)) return null;
  ensureDir();
  // 【合流之前先记下内存这份的样子】见 memStamp 上的说明（2026-10-29）
  // 注意这里先拍一拍「updatedAt 之前」的样子：updatedAt 每次存盘都要刷新，
  // 拿刷新后的值去比，等于永远相等，验了个寂寞。
  const stampBefore = memStamp(session);
  session.updatedAt = Date.now();
  if (!session.createdAt) session.createdAt = session.updatedAt;
  const payload = {
    id: session.id,
    title: cleanTitle(session.title) || '新会话',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messages: session.messages ?? [],
    rewinds: Array.isArray(session.rewinds) ? session.rewinds : [],
  };
  /**
   * 【删过的指纹跟着落盘】2026-10-29
   *
   * 只留在内存里不够：会话刷新 / 重启之后 getSession 从磁盘读回来，_deletedKeys 就没了，
   * 这时候再来一份老副本合流，被删的照样会被接回。所以写进文件。
   * 没有就整个字段不写 —— 别给正常会话平白多一个空数组。
   */
  { const deletedKeys = Array.isArray(session._deletedKeys)
      ? session._deletedKeys.filter((k) => typeof k === 'string' && k)
      : [];
    if (deletedKeys.length) payload._deletedKeys = deletedKeys; }
  // 会话当前处在哪个安全词档位。没这个字段的老会话 = 人设档（见 mode.mjs），
  // 所以只在真的记过档位时才写，免得给所有会话塞一堆冗余字段。
  if (session.mode?.word) payload.mode = { word: session.mode.word, since: session.mode.since ?? Date.now() };
  // 【合流】写盘前先看一眼磁盘上那份：中途可能有别人（主人插话 / 另一轮）
  // 往里写了话，那这份内存里的 session 就是旧的。整份覆盖会把人家的话抹掉。
  // 做法：磁盘那份打底，把内存这份有、磁盘没有的接在后面，再去重写回。
  try {
    const raw = JSON.parse(readFileSync(fileFor(session.id), 'utf8'));
    const diskMsgs = Array.isArray(raw?.messages) ? raw.messages : [];
    const memMsgs = Array.isArray(payload.messages) ? payload.messages : [];
    if (diskMsgs.length) {
      /**
       * 【合流用指纹】—— 2026-10-26 重写
       *
       * 旧版只按「角色 + content 字符串」算，content 不是字符串就返回 null，
       * 然后被当成「磁盘/内存各自独有」—— 于是每存一次盘，content 为 null 的
       * assistant(tool_calls) 就被再追加一遍：一次插话能让同一个 tool_call id
       * 从 1 条变 3 条，上游按 OpenAI 协议判非法直接 502，
       * 主人看到的就是「插了话她不理我」。
       *
       * 新版指纹带上 tool_calls 的 id 和 tool_call_id，内容空也有身份；
       * 算不出指纹（不是对象 / 没角色）的才返回 null，那种一律不参与合并。
       */
      const key = (m) => messageKey(m);
      const memKeys = new Set(memMsgs.map(key).filter(Boolean));
      // 算不出指纹的不参与合并（见上）
      /**
       * 【system / context 不参与合流】—— 2026-10-26 修
       *
       * runAgent 每轮开头会把历史里 system 的 content 就地刷成最新的人设。
       * 于是磁盘上那份还是**旧人设**、内存这份已经变成新人设 —— 指纹不同，
       * 下面就会把旧 system 当成「磁盘独有的新消息」补到历史末尾。
       * 实测结果：每轮多一条一模一样的 system，越跑越多，几百条历史全被它
       * 逼着重发一遍，还挤掉了真正该带上去的对话。
       *
       * system 和 context 是每轮重算的框架，不属于对话内容，一律不补。
       */
      const isFraming = (m) => m && (m.role === 'system' || m.context);
      const diskOnly = diskMsgs.filter((m) => { if (isFraming(m)) return false; const k = key(m); return k && !memKeys.has(k); });
      /**
       * 【两边都接：内存的打底，磁盘独有的补在后面】
       *
       * 内存这份是这一轮真正跑过的历史（已压缩、已回退、已去重），是主线；
       * 磁盘那份可能有内存里还没有的（插话刚 push 的那句、另一个进程写的），
       * 所以按指纹把磁盘独有的接在末尾，一条不丢。
       *
       * 关键在于指纹稳定：同一批 assistant(tool_calls) 在两边算出的 key 一样，
       * 就只会留一份 —— 这才是旧版真正缺的东西（旧版对 content=null 的消息
       * 算不出 key，于是两边都「独有」，每存一次盘就多几条）。
       */
      const merged = memMsgs.slice();
      const seenKey = new Set(merged.map(key).filter(Boolean));
      /**
       * 【压缩过的那份，磁盘上的老消息一条都不许接回来】—— 2026-10-31 修
       *
       * 上面那套「磁盘独有的接在末尾」是给插话用的：磁盘上可能有内存里还没有的
       * 那一句。可它跟压缩撞在一起就出大问题 ——
       *
       *   压缩把老消息折进摘要、从数组里移走了，磁盘上那份还是压缩前的。
       *   于是**每一条被压掉的老消息都算「磁盘独有」**，一条条接回末尾，
       *   内存里刚压好的 838 条，落盘又成了 2058 条。
       *
       * 这是压缩白做的第三处（前两处在 server.mjs：收尾合并、commitCompression
       * 之前的 history 副本）。实测：compressHistory 报 2057→838、commitCompression
       * 日志也写着「已同步进会话：2058 → 838」，可磁盘上还是 2059 条 ——
       * 就是这里接回去的。
       *
       * 判据跟 server.mjs 收尾合并那边保持一致：只要有一边带摘要（= 动过压缩），
       * 就只接「内存这份里、磁盘那份完全没有的」那几条真正的新话。
       * 压缩挪走的那些老消息（磁盘有、内存没有）一律视为「已经进摘要了」，不接。
       */
      /**
       * 【清空闸】—— 2026-10-31 加
       *
       * 「清空当前」要把这个会话的聊天记录原地擦干净、只留开场白。
       * 上面那套「磁盘独有的接在末尾」本来是给插话用的，可它跟清空撞在一起就完蛋：
       * 清空后内存里只剩 system + 开场白，磁盘上那份还满是旧对话，
       * 每一条旧对话都算「磁盘独有」，被一条条接回来 ——
       *
       * 实测：接口返回 kept=2 messages=3，磁盘上读回来还是 5 条，假消息全回来了。
       *
       * 判据：调用方把 session._wipe 置成 true，表示这次是整份替换，磁盘那份一个字都不接。
       */
      if (session && session._wipe === true) diskOnly.length = 0;

      /**
       * 【删掉的，不许再接回来】—— 2026-10-29 修
       *
       * 上面这套「磁盘独有的接在末尾」是给插话用的，但它分不清两种「磁盘有、内存没有」：
       *   ① 插话刚 push、还没落盘的那一句  → 该接
       *   ② 主人刚从历史里删掉的那一句      → 绝对不该接
       *
       * 实测（sandbox/_repro_wipe2.mjs）：插话写下的一条测试消息，从内存里删掉之后
       * 下一次 saveSession 就把它原样接回末尾 —— 删了三次回来三次。
       *
       * 判据：删消息的那一方在 session._deletedKeys 里登记指纹（字符串数组），
       * 合流时命中这些指纹的磁盘消息一律不接。用指纹而不是下标，因为删一条之后
       * 后面的下标全变了，按位置对必然对错。
       */
      const deletedKeys = Array.isArray(session && session._deletedKeys) ? session._deletedKeys : null;
      if (deletedKeys && deletedKeys.length) {
        const deadSet = new Set(deletedKeys);
        for (let i = diskOnly.length - 1; i >= 0; i--) {
          if (deadSet.has(key(diskOnly[i]))) diskOnly.splice(i, 1);
        }
      }

      const countSummary = (arr) => arr.reduce((n, m) => n + (m && m.summary && m.context ? 1 : 0), 0);
      const compressedAnywhere = countSummary(memMsgs) > 0 || countSummary(diskMsgs) > 0;
      if (compressedAnywhere) {
        // 只接磁盘上确实没有的；压缩移走的那些不算「磁盘独有」，而是「已被压掉」
        for (const m of diskOnly) {
          // 老消息的特征：磁盘上有、而且算得出指纹（说明是正常的对话条目）。
          // 压缩之后内存里没有它，只可能是被折进摘要了 —— 跳过。
          // 真正该接的是「内存里新长出来、磁盘还没见过」的内容，那从内存那边来，
          // 根本不会出现在 diskOnly 里，所以这里直接不接。
          void m;
        }
      } else {
        for (const m of diskOnly) {
          const k = key(m);
          if (!k || seenKey.has(k)) continue;
          seenKey.add(k);
          merged.push(m);
        }
      }
      payload.messages = merged;
    }
  } catch {}
  // 【合流之后回头验一遍：内存那份还是刚才那份吗】见 memStamp 上的说明（2026-10-29）
  // 变了 = 有人（插话 / 重置 / 压缩 / 另一轮）在我们读磁盘这几毫秒里改过真的那份，
  // 这次合流的前提已经作废 —— 写下去就会把人家刚删的接回来、或者把刚加的漏掉。
  // 放弃这次、重来（最多 3 次；之后照写，宁可慢一拍也不死循环）。
  if (stampBefore !== null && memStamp(session) !== stampBefore && _attempt < 3) {
    return saveSession(session, _attempt + 1);
  }
  writeFileAtomic(fileFor(session.id), JSON.stringify(payload));
  if (session._wipe) delete session._wipe;
  return session;
}

export function renameSession(id, title) {
  const s = loadSession(id);
  if (!s) return null;
  const next = cleanTitle(title);
  if (!next) return null;
  s.title = next;
  saveSession(s);
  return s;
}

function previewOf(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user' && !m.context) {
      const raw = m.content;
      const body = Array.isArray(raw) ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') : raw;
      let text = String(body ?? '').replace(/\s+/g, ' ').trim();
      // 只有图没文字：拿附件名顶一下
      if (!text && Array.isArray(m._images) && m._images.length) text = '[图片] ' + m._images.map((p) => String(p).split(/[\\/]/).pop()).join(' ');
      /* 【2026-11-07 修·压缩过的会话预览是空的】
       * 程序自动插的提醒不是主人说的话，这里要跳过，继续往前找，
       * 不然整条会话的预览会变成「〔量线 30%〕…」这种废话。 */
      if (!text || /^〔|^【该你自己压了】|^（下面是程序自动生成/.test(text)) continue;
      return text.slice(0, 60);
    }
  }
  /**
   * 【2026-11-07 加·兜底：主人原话被压缩折走之后】
   *
   * 上下文压过一次之后，messages 里原来的 user 消息被折叠成一条摘要，
   * 剩下的 user 全是程序插的量线提醒 —— 上面那圈一个都挑不出来。
   * 于是 preview 空、count 也是 0，**界面就把它当成「新建的空会话」画成灰的**，
   * 主人看到的是「我这个会话怎么废了」。
   *
   * 兜底：挑最后一条有文字的助手消息（或者那条压缩摘要）当前 60 字。
   * 会话里明明有一大堆内容，列表上就不该显示成空的。
   */
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || (m.role !== 'assistant' && m.role !== 'system')) continue;
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) continue;
    const raw = m.content;
    const body = Array.isArray(raw) ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') : raw;
    const text = String(body ?? '').replace(/\s+/g, ' ').trim();
    /* 程序自己注入的那几条（身份锚等）不能当预览 —— 列表面上一行小字，
     * 写「【本轮身份锚】你就是下一条消息里写的那个人…」主人完全看不懂。 */
    if (!text || /^【本轮身份锚】|^【压缩记忆|^（下面是程序自动生成/.test(text)) continue;
    return text.slice(0, 60);
  }
  return '';
}

/** Newest first, for the 会话 picker. */
export function listSessions() {
  ensureDir();
  const out = [];
  let names = [];
  try {
    names = readdirSync(DIR);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const id = name.slice(0, -5);
    if (!isSessionId(id)) continue;
    const s = loadSession(id);
    if (!s) continue;
    out.push({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      count: s.messages.filter((m) => m && m.role === 'user' && !m.context).length,
      preview: previewOf(s.messages),
      /* 【2026-11-07 加】判「空会话」不能只看 count / preview：
       * 压缩过的会话，主人原话全被折成一条摘要，count 变 0、preview 也得靠兜底 ——
       * 界面那边要是只认这两个字段，就会把一堆内容的会话画成灰色的「新会话」。 */
      hasContent: Array.isArray(s.messages) && s.messages.length > 0,
      // 会话列表里带一句当前档位，界面想显示「这会话被叫停过」就有数据可用
      mode: s.mode?.word || null,
    });
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

/** Soft delete: the file moves to .state/sessions/.trash instead of vanishing. */
export function deleteSession(id) {
  if (!isSessionId(id)) return false;
  const file = fileFor(id);
  if (!existsSync(file)) return false;
  ensureDir(TRASH);
  renameSync(file, join(TRASH, `${id}-${Date.now()}.json`));
  /* 【2026-11-08】会话没了，它的分步清单也得跟着走 ——
   * 否则 .state/plan 里会攒一堆指不到任何会话的孤儿清单，
   * check-plan-session 一跑就红，看着像代码坏了，其实是垃圾没清。 */
  try {
    const pf = join(PLAN_DIR, `${id}.json`);
    if (existsSync(pf)) renameSync(pf, join(TRASH, `${id}-plan-${Date.now()}.json`));
  } catch {}
  const last = getLastSessionId();
  if (last === id) {
    const rest = listSessions();
    setLastSessionId(rest.length ? rest[0].id : null);
  }
  return true;
}

export function getLastSessionId() {
  try {
    const j = JSON.parse(readFileSync(LAST, 'utf8'));
    return isSessionId(j?.id) ? j.id : null;
  } catch {
    return null;
  }
}

export function setLastSessionId(id) {
  ensureDir();
  writeFileAtomic(LAST, JSON.stringify({ id: isSessionId(id) ? id : null, at: Date.now() }));
}

// ---- 导入 / 导出 -----------------------------------------------------------
/**
 * 导出格式（一个会话一个文件，纯 JSON，人类可读）：
 * {
 *   "kind": "xiaoyu-agent.session",
 *   "version": 1,
 *   "exportedAt": 1690000000000,
 *   "session": { id, title, createdAt, updatedAt, messages: [...], rewinds: [...] }
 * }
 * 消息里的附件只存路径（_images / _files），不内联二进制 —— 换台机器上那些路径可能不存在，
 * 这一点在 README 里写清楚了。要连附件一起搬，就把整个 .state 目录拷过去。
 */
export const EXPORT_KIND = 'xiaoyu-agent.session';
export const EXPORT_VERSION = 1;

/** 把一个会话包成可导出的对象；会话不存在返回 null。 */export function exportSession(id) {
  const s = loadSession(id);
  if (!s) return null;
  return {
    kind: EXPORT_KIND,
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    session: {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      messages: s.messages,
      rewinds: s.rewinds,
    },
  };
}

/** 全部会话一起导出（备份用），不含 .trash。 */
export function exportAllSessions() {
  const ids = listSessions().map((s) => s.id);
  return {
    kind: EXPORT_KIND + '.bundle',
    version: EXPORT_VERSION,
    exportedAt: Date.now(),
    sessions: ids.map((id) => exportSession(id)).filter(Boolean).map((x) => x.session),
  };
}

/**
 * 把一条消息洗成我们认的样子。认不出来的直接丢掉，不让脏数据进库。
 * 只保留用得到的字段：role / content / _images / _files / toolCallId / isError / context 等。
 */
function cleanMessage(m) {
  if (!m || typeof m !== 'object') return null;
  const role = String(m.role ?? '').trim();
  if (!['system', 'user', 'assistant', 'tool'].includes(role)) return null;
  const out = { role };
  if (typeof m.content === 'string') out.content = m.content;
  else if (Array.isArray(m.content)) out.content = m.content;
  else out.content = '';
  for (const k of ['_images', '_files']) {
    if (Array.isArray(m[k])) out[k] = m[k].filter((x) => typeof x === 'string');
  }
  if (typeof m.toolCallId === 'string') out.toolCallId = m.toolCallId;
  if (typeof m.toolName === 'string') out.toolName = m.toolName;
  if (m.isError) out.isError = true;
  if (m.context) out.context = true;
  /* 【2026-11-02】导入会话时别把「这是我插的、别显示」的标记弄丢 —— 丢了就
   *  会在界面上冒充主人说话（「重启了」「量线提醒」都会露出来）。 */
  if (m._sysNote === true) out._sysNote = true;
  return out;
}

/**
 * 从导入的数据里抠出会话列表。同时认三种形状：
 *   1. 单会话导出：{ kind, session: {...} }
 *   2. 整包导出：  { kind, sessions: [...] }
 *   3. 裸会话对象：{ messages: [...] } —— 手写的、或从别处拷来的也能进
 *   4. 裸数组：    [ {...}, {...} ]
 * @returns {Array<object>} 干净的会话草稿（还没分配 id）
 */
export function parseImport(raw) {
  const list = [];
  const push = (s) => {
    if (!s || typeof s !== 'object') return;
    const messages = Array.isArray(s.messages) ? s.messages.map(cleanMessage).filter(Boolean) : [];
    if (!messages.length) return;
    list.push({
      title: cleanTitle(s.title) || titleFromMessage(textOf(messages)),
      createdAt: Number(s.createdAt) || Date.now(),
      updatedAt: Number(s.updatedAt) || Date.now(),
      messages,
      rewinds: Array.isArray(s.rewinds) ? s.rewinds : [],
    });
  };

  if (Array.isArray(raw)) {
    for (const x of raw) push(x && x.session ? x.session : x);
  } else if (raw && typeof raw === 'object') {
    if (Array.isArray(raw.sessions)) for (const x of raw.sessions) push(x);
    else if (raw.session) push(raw.session);
    else push(raw);
  }
  return list;
}

function textOf(messages) {
  for (const m of messages) {
    if (m.role !== 'user' || m.context) continue;
    const raw = m.content;
    const body = Array.isArray(raw) ? raw.filter((p) => p && p.type === 'text').map((p) => p.text).join(' ') : raw;
    const t = String(body ?? '').trim();
    if (t) return t;
  }
  return '';
}

/**
 * 把导入的草稿真正写进 .state/sessions，每条都拿一个新 id（不会覆盖现有会话）。
 * @returns {Array<{id:string,title:string,count:number}>}
 */
export function importSessions(drafts) {
  ensureDir();
  const made = [];
  for (const d of drafts) {
    const session = {
      id: newSessionId(),
      title: d.title,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      messages: d.messages,
      rewinds: d.rewinds,
    };
    // 极端情况下生成的 id 撞了，就再摇一次
    let guard = 0;
    while (existsSync(fileFor(session.id)) && guard++ < 8) session.id = newSessionId();
    const saved = saveSession(session);
    if (!saved) continue;
    made.push({
      id: saved.id,
      title: saved.title,
      count: saved.messages.filter((m) => m && m.role === 'user' && !m.context).length,
    });
  }
  return made;
}

/** 剥掉正文里的思考标签（网关有时把思考塞进 content 而不是 reasoning_content）。 */
/**
 * 【2026-11-05 加·把「压缩记忆」从正文里切掉】
 *
 * 主人报：「还是会把【压缩记忆·seg-2-aeeae9ce15】写出来」。
 *
 * 提示词第 8 条已经明说「不许复述」，但模型有时候还是照写。
 * 这种事不能只靠劝 —— 这里做硬剥离：正文里只要出现【压缩记忆…】，从那儿切到结尾。
 *
 * 为什么切到结尾而不是精确配对：压缩记忆是她一轮收尾时写的东西，写在最后；
 * 真出现「压缩记忆 + 后面还有正常内容」的情况极少，宁可少显示，也不让主人看见这堆东西。
 */
function stripCompressMemory(s) {
  if (!s || typeof s !== 'string') return s;
  const i = s.indexOf('【压缩记忆');
  if (i < 0) return s;
  return s.slice(0, i).replace(/\s+$/, '');
}

function stripThinkTags(s) {
  if (!s || typeof s !== 'string') return s;
  /* 【2026-11-06 修·孤立结束标签】
   * 入口原来只认起始标签。可逐块剥留下的残渣往往只剩一个孤零零的 </thinking>，
   * 这种传进来会被这里直接 return 掉，一个字都不剥 —— 上面那道门放宽了也没用。
   * 改成结束标签也算数。 */
  if (!/<\/?(thinking|think|reasoning)[\s>]/i.test(s)) return s;
  return s
    .replace(/<(thinking|think|reasoning)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<(thinking|think|reasoning)[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/(thinking|think|reasoning)>/gi, '');
}
