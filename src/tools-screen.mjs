/**
 * 【陪看屏幕】—— 她自己抬头看一眼主人现在的屏幕（2026-11-01）。
 *
 * 参考 dsh-whale-sense 那个插件：它让帮工进程反复截屏、把「屏幕变了」这件事
 * 跟图片一起塞回会话，于是模型能跟着主人一起看。这里不引 Python、不装依赖，
 * 底子是 src/screen-capture.mjs（Windows 自带 PowerShell + .NET）。
 *
 * 【她自己决定什么时候看，不是一直在看】
 * 插件那边是定时轮询；这里做成工具：她想看（主人让她看、她自己好奇、主人说
 * 「你看我这个」）才截一张。理由是实时轮询等于把主人的屏幕一直上传给模型，
 * 那件事得主人自己手动开（【陪看屏幕 · 一直在看】那个开关），不能默默就来。
 *
 * 【两档】
 *   look_screen          看一眼，返回图片给他自己看（进上下文，她真的能理解画面）
 *   screen_watch_status  看现在是不是在「一直在看」，以及最近截了几张、存了多少
 *
 * 【图片怎么给她】
 * 工具结果本身不能带图，所以走两个口子：
 *   ① 返回文本里写清「画面是什么样」的客观描述（分辨率、前台窗口、时间）
 *   ② 把缩图路径登记进 outbox，让这一轮的回复里挂一张她看见的图 ——
 *      主人能顺手点开，也能确认她到底看到了什么（避免「她说看到了」其实没看）
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { capture, recent, stashSize, prune, foregroundTitle } from './screen-capture.mjs';
import { normalizeSend, fmtSize, publicEntry, stash } from './outbox.mjs';
import { enabledToolNames } from './features.mjs';
import { ctxNow } from './tools.mjs';

const __dirnameScreen = dirname(fileURLToPath(import.meta.url));

/**
 * 【打包后脚本在哪】—— 源码态在 scripts/ 下；装成 exe 之后 scripts/ 会被打进
 * app.asar（只读归档，外部进程 PowerShell 读不了），所以必须同时满足两件事：
 *   ① package.json 的 build.files 带上 scripts/screen-off.ps1；
 *   ② build.asarUnpack 也带上它，electron-builder 会在 app.asar.unpacked 下放一份真文件。
 * 这里统一做解析：先找源码态，找不到再按 app.asar → app.asar.unpacked 换路径。
 * 日志/状态文件跟着脚本所在目录走（unpacked 目录是可写的，asar 里不是）。
 */
function unpackedPath(p) {
  return String(p).replace(/[\\/]app\.asar[\\/]/, (m) => m.replace('app.asar', 'app.asar.unpacked'));
}

function scriptsDir() {
  const plain = join(__dirnameScreen, '..', 'scripts');
  try {
    if (existsSync(join(plain, 'screen-off.ps1'))) return plain;
  } catch { /* 继续往打包态找 */ }
  const alt = unpackedPath(plain);
  try {
    if (existsSync(join(alt, 'screen-off.ps1'))) return alt;
  } catch { /* 都没有就返回源码态，让调用方如实报错 */ }
  return plain;
}

const SCREEN_OFF_SCRIPT = join(scriptsDir(), 'screen-off.ps1');

/** 这个功能开着没（关掉的时候工具根本不在她手上，这里是兜底）。 */
function senseOn() {
  try {
    /* 【2026-11-10 按会话】带上当前会话（陪看屏幕本身是机器级功能，走全局兜底，
     * 这里带 sessionId 只是让判据跟别的工具一致，将来真改口径也不用回来改这里）。 */
    return enabledToolNames(ctxNow().sessionId || '').includes('look_screen');
  } catch {
    return true;
  }
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return String(iso || '');
  }
}

export const screenTools = [
  {
    name: 'look_screen',
    /**
     * 【description 为什么写这么长】
     * 工具清单是从 schema 自动生成塞进系统提示的，模型只靠这段话判断该不该用。
     * 写短了它会滥用（每轮都看）或不敢用（主人说「你看这个」还在问）。
     */
    description:
      '抬头看一眼主人现在的屏幕，看这一刻他屏幕上是什么（哪个窗口、什么内容）。'
      + '\n\n什么时候用：主人说「你看我这个」「我屏幕上这个怎么回事」「这报错你看见没」「陪我一起看」；'
      + '或者你正需要知道他当前在哪个程序里、界面上是什么样，光靠他说不清的时候。'
      + '\n\n什么时候别用：主人没提屏幕、你也不需要知道他屏幕上是什么的时候。别每轮都看 —— '
      + '看一次他就得把他的屏幕交给模型一次，那是他的隐私，不是你随手能翻的东西。'
      + '\n\n看完你拿到的是这张图本身（缩到你也能看的分辨率），所以可以直接就画面里的东西说话；'
      + '别假装看见了没看见的细节，不确定的地方就问他。',
    parameters: {
      type: 'object',
      properties: {
        why: {
          type: 'string',
          description: '你为什么要看这一眼（一句话）。会记进这一帧的备注里，主人事后能看出你当时在想什么',
        },
      },
      required: [],
    },
    async run({ why }, ctx = {}) {
      if (!senseOn()) {
        return '【陪看屏幕】现在是关着的，我看不到你的屏幕。要用的话让主人在顶部【功能】里把「陪看屏幕」打开。';
      }
      const r = await capture({ tag: String(why || '').slice(0, 80) });
      if (!r.ok) return '看一眼没看成：' + r.error;

      /**
       * 把缩图登记进 outbox，这一轮的回复里就会挂上「她看见的那张」。
       * 挂上去的意义不只是好看：主人能点开对照，确认她真的看到了、没在编。
       */
      let attached = '';
      try {
        const norm = normalizeSend(r.small);
        if (norm.entry) {
          norm.entry.key = stash(norm.entry);
          if (Array.isArray(ctx.outbox)) ctx.outbox.push(publicEntry(norm.entry));
          attached = `\n这一眼看到的画面已经挂在回复里了（${norm.entry.name}，${fmtSize(norm.entry.size)}）。`;
        }
      } catch {
        /* 挂不上也不影响她看 */
      }

      const m = r.meta || {};
      const title = String(m.title || '').trim();
      const lines = [
        '【看了一眼你的屏幕】' + fmtTime(m.at),
        '屏幕：' + (m.screen?.width || '?') + '×' + (m.screen?.height || '?') + '（我只拿到缩到 ' + (m.small?.width || '?') + '×' + (m.small?.height || '?') + ' 的那张）',
        title ? '当时前台窗口：' + title : '当时没读到前台窗口的名字（可能全屏或者没窗口）',
        why ? '看这一眼的原因：' + String(why) : '',
        attached,
      ].filter(Boolean);
      /**
       * 【把图真的交到她手上】
       *
       * agent.mjs 已经支持工具返回 { text, images }：images 里的路径会当场编码成
       * image_url 拼进同一条 tool 消息。所以这里给的是**缩图路径**，不是文字描述 ——
       * 只给路径她看不见，会去 read_file 读 PNG 读成乱码，然后说「我看不清」。
       * 用缩图不用原图：原图 2~3MB，模型反正要缩到千把像素，传过去纯烧 token。
       */
      return { text: lines.join('\n'), images: [r.small] };
    },
  },
  {
    name: 'screen_watch_status',
    description:
      '看【陪看屏幕】现在是什么状态：开着没有、最近一共看了几张、占多少地方、最近那几张各自是什么时候、当时前台是哪个窗口。'
      + '主人问「你刚才看见的是什么」「你都存了我多少屏」的时候用它，别瞎猜。',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      const on = senseOn();
      const size = stashSize();
      const list = recent(8);
      const lines = ['【陪看屏幕】' + (on ? '开着（我可以用 look_screen 抬头看）' : '关着（我看不到你的屏幕）')];
      lines.push('盘上存着 ' + size.count + ' 张（' + fmtSize(size.bytes) + '，两小时后自动清，最多留 240 帧）');
      const title = await foregroundTitle();
      if (title) lines.push('你现在的窗口：' + title);
      if (list.length) {
        lines.push('');
        lines.push('最近看过的几张：');
        for (const f of list) {
          const t = fmtTime(f.at);
          const nm = String(f.title || '').trim() || '(没读到窗口名)';
          const tag = String(f.tag || '').trim();
          lines.push('· ' + t + ' — ' + nm + (tag ? '（为什么看：' + tag + '）' : ''));
        }
      } else {
        lines.push('还没看过任何一张。');
      }
      lines.push('');
      lines.push('顺手清一遍过期的：' + prune() + ' 个文件。');
      return lines.join('\n');
    },
  },
  {
    /**
     * 【关闭显示屏】—— 主人要的：跟小鱼说一声她就能把屏幕关掉。
     *
     * 实现走 scripts/screen-off.ps1（从 sleep-scheduler 那套验证过的方案搬过来的）：
     *   背光降到 0 + 全屏黑遮罩 + 隐藏光标，**全程不碰任何电源状态**。
     * 这一点很关键：本机是 S0 现代待机机型，用行业通用的
     * SC_MONITORPOWER 广播会让整机进 S0 待机并锁屏（实测 Kernel-Power 506），
     * 所以那个 API 一律不用。
     *
     * 解除：指纹 / 鼠标右键 / Esc / PrtSc / Delete / 锁屏，或超时自动恢复。
     * 进程是 detached 起的 —— 工具立刻返回，屏幕保持黑着，不会把这一轮卡住。
     */
    name: 'screen_off',
    description:
      '把显示器关掉（黑屏），但电脑照常运行：后台程序、网络、远程连接都不受影响，也不会睡眠/锁屏。'
      + '主人说「关屏」「把屏幕关了」「我要出门」这类话时用它。'
      + '关掉后主人动一下鼠标右键或按 Esc/指纹就能恢复；也可以说「打开屏幕」让我执行 screen_on。',
    parameters: {
      type: 'object',
      properties: {
        keepBrightness: {
          type: 'boolean',
          description: '只铺黑遮罩、不把背光降到 0。默认 false（真熄屏）。屏幕可能偏灰时用 true。',
        },
      },
      required: [],
    },
    async run({ keepBrightness }) {
      const r = await turnOffScreen({ keepBrightness: Boolean(keepBrightness) });
      if (r.ok && r.already) {
        return '显示器本来就关着（已经有一个关屏实例在跑），这次没有再叠一层。\n'
          + '电脑仍在正常运行。主人按【鼠标右键 / Esc / PrtSc / Delete】或刷指纹就能恢复显示。';
      }
      if (!r.ok) throw new Error(r.error || '关屏失败');
      return '显示器已关闭（背光 0 + 全屏黑遮罩），电脑仍在正常运行 —— 后台程序、网络、远程连接都没断，也没有睡眠或锁屏。\n'
        + '主人按【鼠标右键 / Esc / PrtSc / Delete】或刷指纹就能恢复显示；也可以说「打开屏幕」让我执行 screen_on。';
    },
  },
  {
    name: 'screen_on',
    description: '把刚才关掉的显示器恢复显示（还原亮度、撤掉黑遮罩）。主人说「开屏」「显示回来」时用它。',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      const r = await turnOnScreen();
      if (!r.ok) throw new Error(r.error || '恢复失败');
      return r.noop
        ? '显示器本来就是亮的（没找到关屏状态），亮度没有改动。'
        : '显示已恢复（亮度还原、黑遮罩撤掉）。';
    },
  },
];

/* ==========================================================
 * 【关屏 / 恢复的进程启动】—— 这里踩过一个大坑，别改回去
 *
 * 直觉写法 `spawn('powershell.exe', [...], { detached: true })` 在 Windows 上是
 * **必然失效**的：detached:true 会给子进程打上 DETACHED_PROCESS 标志，
 * 进程没有控制台，powershell.exe 起来后 100~200ms 内就以 exit=0 静默退出 ——
 * 脚本一行都没执行，父进程却收到 exit=0「成功」。
 * 实测三种变体（detached / detached+stdio pipe / detached+-WindowStyle Hidden）
 * 全部 0 行日志；这跟 -WindowStyle 无关，是 DETACHED_PROCESS 本身的问题。
 *
 * 唯一可靠的组合是 `cmd.exe /c start "" /b powershell.exe ...`：
 *   · /b      —— 不新开窗口（等于 SW_HIDE 的 console）
 *   · start   —— 让 powershell 脱离调用方的进程树，Node 退出 / Electron 重载
 *                都不会把它杀掉（实测父进程退出后仍存活 15s+，日志持续写入）
 *   · detached:true + windowsHide:true —— 让 cmd 那一层也别闪一下窗口
 * 这条组合实测能跑完 20 秒的长脚本、能写日志、能跨父进程存活。
 * ========================================================== */
const PS_EXE = 'powershell.exe';

/** 起一个独立的 powershell（不受 Node 退出影响），只负责拉起，不等它跑完。 */
function spawnDetachedPs(psArgs) {
  const child = spawn('cmd.exe', ['/c', 'start', '""', '/b', PS_EXE, ...psArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => { /* 由轮询兜底报告失败 */ });
  child.unref();
  return child;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 关屏脚本每天一个日志文件，这里按日期算路径（跟 ps1 里 Get-Date -Format yyyy-MM-dd 对齐）。
 */
function screenLogPath() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return join(scriptsDir(), 'logs',
    `monitor_off_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`);
}

/**
 * 【只读这次新增的日志】—— 用字节偏移取增量，不看历史行。
 *
 * 为什么要这样：日志是**按天追加**的，白天关过十次屏，直接 grep 全文件永远能
 * 命中"已生效"，那就又变成假成功了。记下 spawn 之前的长度，只认之后写进来的。
 * BOM 要去掉：PowerShell 的 Add-Content -Encoding UTF8 每次追加都可能带一个 BOM，
 * 留着它不影响 includes 匹配，但拿去做精确比对/展示时很碍事，统一剥掉。
 */
function logSnapshot() {
  const f = screenLogPath();
  let size = 0;
  try { size = readFileSync(f).length; } catch { size = 0; }
  return { file: f, size };
}

function logSince(snap) {
  try {
    const buf = readFileSync(snap.file);
    if (buf.length <= snap.size) return '';
    return buf.subarray(snap.size).toString('utf8').replace(/\uFEFF/g, '');
  } catch {
    return '';
  }
}

/**
 * 【还在关屏吗】—— 脚本运行时写的状态文件在，才说明真有一个实例在维持黑屏。
 * 只用来给"单实例挡下"这种情况补一道事实核对：光凭日志说"已有实例在运行"不够，
 * 那个实例可能刚被右键解除、状态文件已经删掉了。
 */
function screenOffStateFile() {
  return join(scriptsDir(), '.monitor_off_state');
}

/**
 * 轮询日志，等到出现 expected 里任一 marker（或 fail 里任一 marker）为止。
 * 超时返回 { ok:false, text }，让调用方如实报告 —— 绝不无条件返回成功。
 */
async function waitForLog(snap, { markers, failMarkers = [], timeoutMs = 6000, everyMs = 250, earlyOut = null }) {
  const deadline = Date.now() + timeoutMs;
  let text = '';
  while (Date.now() < deadline) {
    await sleep(everyMs);
    text = logSince(snap);
    for (const f of failMarkers) {
      if (text.includes(f)) return { ok: false, text, hit: f };
    }
    for (const m of markers) {
      if (text.includes(m)) return { ok: true, text, hit: m };
    }
    /* 提前收场：单实例挡下来时不必空等满 6 秒 */
    if (earlyOut) {
      const e = earlyOut(text);
      if (e) return { ok: false, text, early: e };
    }
  }
  return { ok: false, text, timeout: true };
}

/** 摘出日志里最后几行有效内容，塞进错误信息里，主人一眼能看到卡在哪。 */
function tailLines(text, n = 4) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(-n)
    .join(' / ');
}

/**
 * 真正去关屏（界面按钮和工具都走这一个口子，避免两套实现走偏）。
 *
 * 【不再"起来就算成功"】—— 以前是 300ms 后无条件 resolve ok，于是 detached 的
 * powershell 静默退出也报成功，屏幕根本没黑。现在**必须等到日志里出现
 * 「全屏黑遮罩已铺上」+「已生效」才算关掉**，最多等 6 秒；等不到就如实失败。
 */
export async function turnOffScreen({ keepBrightness = false, armSeconds = 3, timeoutSec = 43200, waitMs = 10000 } = {}) {
  if (!existsSync(SCREEN_OFF_SCRIPT)) {
    return { ok: false, error: '找不到 scripts/screen-off.ps1' };
  }
  const snap = logSnapshot();
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', SCREEN_OFF_SCRIPT,
    '-ArmSeconds', String(armSeconds),
    '-TimeoutSec', String(timeoutSec),
  ];
  if (keepBrightness) args.push('-KeepBrightness');

  try {
    spawnDetachedPs(args);
  } catch (e) {
    return { ok: false, error: '启动关屏进程失败：' + (e?.message || e) };
  }

  const r = await waitForLog(snap, {
    // 真正关掉的证据：遮罩铺上 + 进入"等待解除"，两个都写才算数
    markers: ['全屏黑遮罩已铺上'],
    failMarkers: ['遮罩未生效', '[关屏] 异常', '黑遮罩代码加载失败', '黑遮罩未铺上'],
    timeoutMs: waitMs,
    earlyOut: (t) => (/已有实例在运行|已有实例正在启动/.test(t) ? 'already' : null),
  });

  const log = r.text || '';

  /* 单实例挡下来的情况：这次没铺新遮罩。不能直接报成功 —— 那个"已有实例"
   * 可能刚被右键解除（状态文件已删），这时候屏幕上其实是亮的。
   * 所以补一道事实核对：状态文件在 = 屏幕确实还黑着。 */
  if (!r.ok && r.early === 'already' && existsSync(screenOffStateFile())) {
    return { ok: true, already: true, log: tailLines(log) };
  }
  if (!r.ok && r.early === 'already') {
    return {
      ok: false,
      error: '已经有一个关屏实例，但它已经不在了（状态文件已清），屏幕现在很可能是亮的。再调一次 screen_off 会重新关。',
    };
  }

  if (!r.ok) {
    if (r.timeout) {
      const seen = tailLines(log);
      return {
        ok: false,
        error: '关屏脚本启动后 ' + Math.round(waitMs / 1000) + ' 秒内没有铺上黑遮罩，屏幕没有关掉。'
          + (seen ? '（脚本日志：' + seen + '）' : '（脚本连日志都没写出来，很可能 powershell 一起来就退出了）'),
      };
    }
    return { ok: false, error: '关屏失败：' + (r.hit || '未知原因') + (log ? '（' + tailLines(log) + '）' : '') };
  }

  /* 遮罩铺上了，再等一行"已生效"确认脚本没在中间翻车（比如紧接着异常退出）。
   * 这一拍很短，遮罩已经在了，纯粹是补一道确认。 */
  const r2 = await waitForLog(snap, { markers: ['[关屏] 已生效'], timeoutMs: 1500 });
  if (!r2.ok) {
    return { ok: false, error: '黑遮罩铺上了但脚本没有进入等待状态（可能马上退出了），屏幕可能已经或即将恢复。' };
  }
  return { ok: true, log: tailLines(r2.text) };
}

/**
 * 恢复显示：走同一脚本的 -Restore（会杀掉关屏实例、还原亮度、清状态文件）。
 *
 * 同样不再"起来就报成功"：必须等日志出现「显示已恢复」/「亮度已还原」才算数。
 */
export async function turnOnScreen({ waitMs = 6000 } = {}) {
  if (!existsSync(SCREEN_OFF_SCRIPT)) {
    return { ok: false, error: '找不到 scripts/screen-off.ps1' };
  }
  const snap = logSnapshot();
  try {
    spawnDetachedPs([
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', SCREEN_OFF_SCRIPT,
      '-Restore',
    ]);
  } catch (e) {
    return { ok: false, error: '启动恢复进程失败：' + (e?.message || e) };
  }

  const r = await waitForLog(snap, {
    markers: ['显示已恢复', '亮度已还原'],
    failMarkers: ['[关屏] 异常'],
    timeoutMs: waitMs,
    /* "未发现关屏状态" = 本来就没关，不用改亮度，这是正常收场不是失败。
     * 认出来就立刻返回，不必空等满 6 秒。 */
    earlyOut: (t) => (/未发现关屏状态/.test(t) ? 'noop' : null),
  });

  if (r.ok) return { ok: true, log: tailLines(r.text) };
  if (r.early === 'noop') {
    return { ok: true, noop: true, log: tailLines(r.text) };
  }
  return {
    ok: false,
    error: '恢复脚本启动后 ' + Math.round(waitMs / 1000) + ' 秒内没有确认显示恢复，屏幕可能仍然是黑的或亮度没还原。'
      + (r.text ? '（脚本日志：' + tailLines(r.text) + '）' : '（脚本连日志都没写出来）'),
  };
}

/**
 * 给界面用：最近几帧（带能不能点开的路径）。
 *
 * 界面上的「陪看屏幕」面板列这个。只给最近的、且文件确实还在的 ——
 * 元信息还在但图片被清掉的那种，列出来点开会是空的，不如不列。
 */
export function recentFrames(limit = 12) {
  return recent(limit)
    .filter((f) => existsSync(String(f.small || '')) || existsSync(String(f.full || '')))
    .map((f) => ({
      id: f.id,
      at: f.at,
      title: f.title || '',
      tag: f.tag || '',
      screen: f.screen || {},
      small: f.small || '',
      full: f.full || '',
      smallBytes: f.smallBytes || 0,
      fullBytes: f.fullBytes || 0,
    }));
}
