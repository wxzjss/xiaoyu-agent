/**
 * 【2026-11-18 加·run_command 的命令级危险识别】
 *
 * 为什么要有这个文件：`ui-guard.mjs` 那套审批只盖住了 UI 动作（点按钮、按键、打字），
 * 而 `run_command` 拿的是**宿主全权限** —— 破坏力比点一个按钮大得多，却一道审批都没有。
 * 外部诊断把这条列为「必须重做」，但我们查过之后发现：**审批管道早就接通了**
 * （server.mjs 有真正的 askApproval 注入，60 秒超时兜底 + 问不到就不动），
 * 缺的只是「run_command 这边没人去问」。
 *
 * 所以这里补的就是那一问。
 *
 * ── 判定哲学（照抄 ui-guard 那套，因为它是对的）────────────────
 * 1. **拿不准就问**，不是拿不准就放。失败关闭。
 * 2. **无歧义的词直接拦**，有歧义的词**必须带宾语**才拦。
 *    这么分是因为误伤会被主人骂，而漏放会真出事 —— 但误伤太多她会嫌烦，
 *    烦到最后主人会把整个功能关掉，那才是最大的不安全。
 * 3. **只判命令文本，不判后果**。我们不知道 `npm run build` 会不会删目录，
 *    所以只拦「文本上就写着要毁东西」的那些。
 *
 * ── 分级 ────────────────────────────────────────────────────
 *   high  → 一定要问（格式化磁盘、递归删根目录、关机、改系统权限、下载即执行）
 *   mid   → 问（删文件/目录、卸载、注册表写入、改环境变量、强推 git）
 *   low   → 放行（读、查、构建、跑测试、git 常规操作）
 *
 * ── 为什么不用 `rm -rf` 这种单条正则 ───────────────────────
 * 因为 PowerShell 里 `Remove-Item -Recurse -Force D:\` 才是等价写法，
 * cmd 里可能叫 `rd /s /q`，还有 `del /f /s /q`。必须按「动词 + 危险修饰 + 范围」三件套判。
 */

/**
 * 这些命令哪怕看着再人畜无害，只要出现就先问 —— 它们「能改写系统状态」。
 *
 * ⚠️ 【踩过的坑】第一版这里用了大量 `\b` 词边界，结果 `rm -rf /` 判成低危。
 * 原因：`\b` 只认「单词字符 ↔ 非单词字符」的边界，而 `-` 和 `:` 都不是单词字符，
 * 所以 `rm\b` 后面接 ` -rf` 时边界成立，但 `-rf\b` 后面接 ` /` 时、
 * 以及 `format\b` 后面接 ` C:` 时，那些位置根本没有「单词字符」参与，边界形同虚设。
 * 现在改成「用 \s / (?=\s|$|:) 这类显式分隔」+ 句首锚点，不再依赖 \b。
 */
const HIGH_RULES = [
  {
    id: 'format-disk',
    /* `format C:` / `format-volume` / `clear-disk` / `initialize-disk`
     * 不写 `\b`，用「前面是行首或空白/管道/分号」+「后面跟盘符或 disk/volume 词」 */
    re: /(^|[\s;&|])(format|format-volume|clear-disk|initialize-disk)[\s-]+(?:[a-z]:|disk|volume|drive)/i,
    why: '格式化磁盘/卷',
  },
  {
    id: 'format-bare',
    /* `format C:` 这种连空格都没有的写法（`format C:` 有空格，`formatC:` 没有但很少见），
     * 单独兜一条：format 后面紧跟盘符 */
    re: /(^|[\s;&|])format[\s]+[a-z]:/i,
    why: '格式化盘符',
  },
  {
    id: 'rm-root',
    /* 递归/强删 + 目标是盘根、系统根、家目录。
     *
     * 关键修法（踩了两次）：
     *   ① `-rf` 后面不能用 `\b`（`-` 不是单词字符，边界判不出来）；
     *   ② 目标 ` /` 后面是字符串结尾，`\s` 匹配不到 → 必须同时接受 `$`；
     *   ③ 四个分支都必须带 `(^|[\s;&|])` 前缀，否则 `inform` 里的 `form` 会被当 format。 */
    re: new RegExp([
      /* 删根：目标就是一个斜杠/反斜杠（后面是空白或结尾） */
      String.raw`(^|[\s;&|])(rm|remove-item|rmdir|rd|del|erase)(\s+-\S+)*\s+["']?([a-z]:[\\/]?|[\\/])["']?(\s|$|;)`,
      /* 删盘根：D: / D:\ */
      String.raw`(^|[\s;&|])(rm|remove-item|rmdir|rd)(\s+-\S+)*\s+["']?[a-z]:[\\/]?["']?(\s|$|;)`,
      /* 家目录：~ / $HOME / $env:USERPROFILE / %USERPROFILE% */
      String.raw`(^|[\s;&|])(rm|remove-item|rmdir|rd|del|erase)(\s+-\S+)*\s+["']?(~|\$home|\$env:userprofile|%userprofile%)["']?(\s|$|;)`,
    ].join('|'), 'i'),
    why: '递归删除盘根 / 家目录 / 系统根',
  },
  {
    id: 'rm-system-dir',
    /* 系统目录：Windows / System32 / Program Files / Users。
     * 注意 cmd 的 `rd /s /q C:\Windows` 选项在目标**前面**，所以这里允许「选项在中间」。 */
    re: new RegExp([
      String.raw`(^|[\s;&|])(rm|remove-item|rmdir|rd|del|erase)(\s+(?:-\S+|\/[a-z]+))*\s+["']?[a-z]:[\\/](windows|system32|program files|programdata|users)\b`,
      String.raw`(^|[\s;&|])(rm|remove-item|rmdir|rd|del|erase)(\s+(?:-\S+|\/[a-z]+))*\s+["']?[\\/](windows|system32|etc|usr|bin|sbin)\b`,
    ].join('|'), 'i'),
    why: '删除系统目录',
  },
  {
    id: 'shutdown',
    re: /\b(shutdown|restart-computer|stop-computer)\b/i,
    why: '关机 / 重启整台机器',
  },
  {
    id: 'boot-config',
    re: /\b(bcdedit|bootrec|diskpart)\b/i,
    why: '改启动配置 / 分区表',
  },
  {
    id: 'takeown-icacls',
    re: /\b(takeown|icacls)\b/i,
    why: '改文件所有权 / 权限（可能把自己锁在外面）',
  },
  {
    id: 'download-exec',
    /* 下载完直接执行 —— 这是最经典的「一句话把机器交出去」 */
    re: /\b(iwr|invoke-webrequest|curl|wget)\b[\s\S]{0,200}(\|\s*(iex|invoke-expression|sh|bash|powershell|pwsh)\b)|(iex\s*\(\s*(new-object|iwr|invoke-webrequest))/i,
    why: '下载内容直接执行（等于把机器交出去）',
  },
  {
    id: 'reg-delete',
    re: /\breg\b[\s\S]{0,10}\bdelete\b/i,
    why: '删注册表项',
  },
  {
    id: 'disable-defender',
    re: /\b(set-mppreference|add-mppreference)\b[\s\S]{0,40}\b(disable|exclusion)/i,
    why: '关防护 / 加白名单',
  },
];

/** 中危：会改东西，但通常不该一句话就干掉主人的东西 —— 问一声就好。 */
const MID_RULES = [
  {
    id: 'delete-files',
    /* 删除类动词 + 危险修饰（递归/强制/静默）+ 一个目标。
     *
     * 【第一版为什么漏了】原来写成 `\b(rm|...)\b\s+(-recurse|-r\b|\/s\b|...)`，
     * 而 `rm -rf ./build` 里 `rm` 后面第一个词是 `-rf`（不是 `-recurse`/`-r` 的精确写法），
     * `-r\b` 匹配 `-rf` 时后面是 `f`（单词字符），`\b` 不成立 → 整条漏掉。
     * 现在用 `-\S*` 兜「一堆短选项」，并且明确接受 `-rf` / `-fr` 这种合写。
     * 注意：正则必须写成**单行**（JS 字面量不允许换行），所以这里用四个分支拼起来。 */
    re: new RegExp([
      /* rm/remove-item/... 后面跟着「带 r 或 f 的短选项」再跟目标 */
      String.raw`(^|[\s;&|])(rm|remove-item|rmdir|rd|del|erase)\s+(?:-\S+\s+)*-(?:[a-z]*[rf])[a-z]*\s+\S`,
      /* --recursive 长写法 */
      String.raw`(^|[\s;&|])(rm|remove-item|rmdir|rd|del|erase)\s+--recursive\s+\S`,
      /* cmd 的 del /f /s /q */
      String.raw`(^|[\s;&|])(del|erase)\s+\/[fsq][\s\S]{0,20}\S`,
      /* 直接删盘符路径（不递归也算，因为可能是 D:\ 根） */
      String.raw`(^|[\s;&|])(rm|remove-item|rmdir|rd)\s+["']?[a-z]:[\\/]`,
    ].join('|'), 'i'),
    why: '删文件 / 删目录',
  },
  {
    id: 'uninstall',
    re: /\b(uninstall|winget\s+uninstall|choco\s+uninstall|npm\s+uninstall\s+-g|pip\s+uninstall)\b/i,
    why: '卸载软件',
  },
  {
    id: 'registry-write',
    re: /\breg\b[\s\S]{0,10}\b(add|import)\b|\b(set-itemproperty)\b[\s\S]{0,40}\bhklm:|new-itemproperty[\s\S]{0,40}\bhklm:/i,
    why: '写注册表（改系统级设置）',
  },
  {
    id: 'env-machine',
    re: /\[environment\]::setenvironmentvariable[\s\S]{0,80}\bmachine\b/i,
    why: '改系统级环境变量',
  },
  {
    id: 'git-force',
    re: /\bgit\b[\s\S]{0,30}\bpush\b[\s\S]{0,40}(--force\b|\s-f\b)|\bgit\b[\s\S]{0,30}\breset\b[\s\S]{0,20}--hard/i,
    why: 'git 强推 / 硬重置（会丢历史或覆盖远端）',
  },
  {
    id: 'chmod-chown',
    re: /\b(chmod|chown)\b[\s\S]{0,20}\b(777|000)\b/i,
    why: '把权限改成全开或全关',
  },
  {
    id: 'kill-other',
    re: /\b(taskkill|stop-process|pkill|killall)\b/i,
    why: '杀进程',
  },
  {
    id: 'service-change',
    re: /\b(sc\b\s+(config|delete)|net\s+stop|set-service|new-service|remove-service)\b/i,
    why: '改 / 删系统服务',
  },
  {
    id: 'pipe-to-shell',
    re: /\|\s*(bash|sh|zsh|powershell|pwsh|cmd)\b/i,
    why: '把输出直接喂给 shell 执行',
  },
  {
    id: 'move-overwrite',
    re: /\bmove-item\b[\s\S]{0,60}-force|\bmv\b[\s\S]{0,40}-f\b/i,
    why: '强制移动（可能覆盖已有文件）',
  },
];

/** 这些出现就说明是**正常的开发活**，直接放行，不再往下判。
 *  为什么要这个：`npm test` 里可能有 `rm -rf dist` 这种字眼，
 *  但它出现在 package.json 的脚本里、不是我们这条命令的主体时不该拦。
 *  —— 不过这条只对「整条命令看起来就是这个」的情况生效，宁可少放。 */
const SAFE_PREFIXES = [
  /^node\s+scripts\/check-/,
  /^node\s+--check\b/,
  /^git\s+(status|log|diff|show|branch|remote|ls-files|rev-parse)\b/,
  /^npm\s+(test|run\s+test)/,
  /^(ls|dir|cat|type|head|tail|wc|echo)\b/,
];

/** 一条命令文本 → { level, why, id } */
export function judgeCommand(raw) {
  const s = String(raw || '');
  if (!s.trim()) return { level: 'low', why: '', id: '' };

  /**
   * 【2026-11-18 加·先把「被套起来的命令」拆出来】
   *
   * 实测抓到的两个真绕过（`_t_bypass.mjs`）：
   *   ① `powershell -c "Remove-Item -Recurse -Force C:\Windows"`
   *      —— 危险词在**引号里面**，而我们所有规则都要求前面是 `(^|[\s;&|])`，
   *      引号不在那集合里 → 整条判成低危。cmd /c 能过是因为 `cmd /c rd...` 后面直接跟空白。
   *   ② `echo hi\nrm -rf /`
   *      —— `rm` 前面是换行符。`\s` 其实能匹配换行，问题出在**我们只判了整串里的开头锚点**……
   *      等等，这条实际是被「safeWhole 检查」放过的：
   *      `SAFE_PREFIXES` 里有 `^(ls|dir|cat|...|echo)\b`，而 `echo hi\nrm -rf /` 以 echo 开头，
   *      且 `!/&&|;|\|\|/` 也成立（只有换行，没有分号）→ 整条当安全放行。
   *
   * 修法：
   *   · **拆壳**：把 `powershell -c "…"` / `cmd /c …` / `bash -c '…'` 里的内容挖出来一起判；
   *   · **收紧 safeWhole**：只要命令里有换行、或者超过一个「行」，就不算「整条安全形态」。
   */

  /* ① 拆壳：把「解释器 -c/-Command 后面那段」也当成命令文本一起看 */
  let expanded = s;
  const SHELL_WRAP = [
    /(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-c(?:ommand)?\s+["']([\s\S]*)["']/i,
    /\bc(?:md)(?:\.exe)?\s+\/[ck]\s+["']?([\s\S]*)["']?/i,
    /\b(?:ba|z|k)?sh\s+-c\s+["']([\s\S]*)["']/i,
  ];
  for (const re of SHELL_WRAP) {
    const m = re.exec(s);
    if (m && m[1]) expanded = s + '\n' + m[1];
  }

  /* ② safeWhole：只对「单行、且没有被串联」的整条命令生效 */
  const trimmed = s.trim();
  const isSingleLine = !/\r|\n/.test(trimmed);
  const noChain = !/&&|;|\|\|/.test(trimmed);
  /* 安全前缀只能放行纯命令。Shell substitution 即使包在 echo/cat 里也会执行，
   * 不能因为外层以安全读命令开头就绕过审批。 */
  const noShellSubstitution = !/(?:\$\(|`)/.test(trimmed);
  const safeWhole = isSingleLine && noChain && noShellSubstitution && SAFE_PREFIXES.some((re) => re.test(trimmed));
  if (safeWhole) return { level: 'low', why: '', id: '' };

  for (const r of HIGH_RULES) {
    if (r.re.test(expanded)) return { level: 'high', why: r.why, id: r.id };
  }
  for (const r of MID_RULES) {
    if (r.re.test(expanded)) return { level: 'mid', why: r.why, id: r.id };
  }
  /* substitution 不能靠外层命令判断其实际效果；无安全分类时按中危审批。 */
  if (!noShellSubstitution) return { level: 'mid', why: 'Shell 命令替换/展开需要确认', id: 'shell-substitution' };
  return { level: 'low', why: '', id: '' };
}

/** 高/中危都要问；低危直接放。留着这个函数是为了以后要分级（比如 high 必问、mid 只在非管理员档问）。 */
export function needAsk(level) {
  return level === 'high' || level === 'mid';
}
