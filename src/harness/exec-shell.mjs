/**
 * 【run_command 快速通道】
 *
 * 重做前 tools.mjs 无条件 `shell: 'powershell.exe'`。PowerShell 启动约 300ms
 * （cmd 约 30ms），而她一天要跑两百次命令 —— 光「壳还没开始干活」就烧掉一分钟。
 * 更糟的是提示词里那条烂写法（中文路径 + $env: + 引号 + 再起一个 node）。
 *
 * 这里不改命令内容，只挑壳：
 *   · 明显简单的命令 → cmd.exe，省掉那 300ms
 *   · 出现任何 PowerShell 专有语法、变量、引号、管道、重定向 → 一律回老路
 *
 * **保守到偏胆小**：分错只会慢一点，绝不会把命令跑成另一个意思。
 * shell_hint 是给模型/调用方显式指定的口子，默认 auto。
 */

const PS_MARKERS = new RegExp(
  // ; 是 PowerShell 的分隔符、cmd 里却只是普通字符 —— 提示词教她「用 ; 串几条检查」，
  // 这种命令必须回 PowerShell，不然在 cmd 里会被当成参数的一部分直接跑挂（2026-11-07 严检发现）。
  '[' + String.fromCharCode(36) + '`\'"<>|;]'               // $ ` ' " < > | ;
  + '|@\\('
  + '|\\b(?:Get|Set|New|Remove|Write|Select|Where|ForEach|ConvertTo|Out|Test|Join|Resolve|Start|Stop|Invoke|Import|Export)-[A-Za-z]+'
  + '|\\b(?:taskkill|powershell|pwsh)\\b',
  'i',
);

export function needsPowerShell(command) {
  return PS_MARKERS.test(String(command || ''));
}

/**
 * @returns 传给 child_process.exec 的 shell
 */
export function pickShell(command, hint = 'auto') {
  if (process.platform !== 'win32') return '/bin/sh';
  const h = String(hint || 'auto').toLowerCase();
  if (h === 'powershell' || h === 'ps') return 'powershell.exe';
  if (h === 'cmd') return 'cmd.exe';
  const c = String(command || '').trim();
  if (!c) return 'powershell.exe';   // 空命令也走老路，别拿快路去赌
  return needsPowerShell(c) ? 'powershell.exe' : 'cmd.exe';
}

/** 给检查脚本和指标用：这条命令会走哪条路 */
export function shellLabel(command, hint) {
  const s = pickShell(command, hint);
  if (s === 'cmd.exe') return 'cmd';
  if (s === 'powershell.exe') return 'powershell';
  return 'sh';
}
