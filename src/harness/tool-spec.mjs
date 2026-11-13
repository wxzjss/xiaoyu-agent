/**
 * 【工具依赖元数据 · 单一真相】
 *
 * 2026-11-07 重做前，只读判定散在四处，彼此会漂移：
 *   agent.mjs:124-143  isReadOnlyCommand（命令正则）
 *   agent.mjs:1543     _RO 七个工具名的 Set
 *   task-mode.mjs:37   KEEP_TOOLS 办事模式白名单
 *   tools.mjs:2506     isToolEnabled 功能开关
 * 前三处都在回答「这几个能不能一起跑」，却各写各的。
 *
 * 这张表把「能不能并行」收成一处：表驱动 + 保守默认。
 * 没登记的工具一律按「有副作用、必须串行」处理 —— 判错只会少并一次，不会踩坏数据。
 */

/** 明确无副作用、且互不共享状态的工具。其余一律保守串行。 */
const READ_ONLY = [
  'read_file', 'list_dir', 'search_files', 'glob_files', 'grep_files',
  'web_search', 'fetch_url', 'fetch_txt', 'fetch_many',
  'browser_state', 'browser_snap', 'browser_eval', 'browser_cookies', 'browser_network', 'browser_wait', 'browser_read', 'look_screen', 'screen_watch_status', 'ui_observe',
  'chronicle_toc', 'chronicle_search', 'chronicle_read', 'folded_list', 'folded_read',
  'memory_search', 'list_peers', 'read_peer_mail', 'list_workers', 'watch_worker',
  'video_probe', 'video_read', 'video_doctor',
];

/** 明确要写 / 会改外部状态的工具。列出来是为了让检查脚本能验证「没被误判成只读」。 */
const SIDE_EFFECT = [
  'write_file', 'run_command', 'send_file', 'qq_send', 'say', 'restart_self',
  'plan', 'note', 'memory_add', 'memory_pin', 'use_skill', 'ask_peer',
  'browser_open', 'browser_goto', 'browser_setcookie', 'browser_click', 'browser_type', 'ui_click', 'ui_double_click', 'ui_right_click',
  'ui_type', 'ui_key', 'ui_scroll', 'make_image', 'video_sheet',
  't2s_convert', 'pack_book', 'ask_subagent', 'spawn_worker', 'spawn_workers',
  'tell_worker',
];

const SPEC = Object.create(null);
for (const n of READ_ONLY) SPEC[n] = { parallelSafe: true, idempotent: true, sideEffect: false };
for (const n of SIDE_EFFECT) SPEC[n] = { parallelSafe: false, idempotent: false, sideEffect: true };

/** 未登记时的兜底：宁可慢，不许踩 */
const UNKNOWN = { parallelSafe: false, idempotent: false, sideEffect: true, unknown: true };

export const TOOL_SPEC = SPEC;
export const UNKNOWN_SPEC = UNKNOWN;

/* 这条正则从 agent.mjs:126-131 原样搬来，一字不改 —— 行为必须与改前完全一致。
 * 判错只会「少并行一次」，不会多并行一次。 */
const READONLY_CMD_RE = new RegExp(
  '^\\s*(?:sudo\\s+)?(?:'
  + 'git\\s+(?:status|log|diff|show|branch|remote|rev-parse|ls-files|describe|blame|config\\s+--get)'
  + '|ls\\b|dir\\b|cat\\b|type\\b|head\\b|tail\\b|wc\\b|find\\b|grep\\b|rg\\b|findstr\\b'
  + '|pwd\\b|echo\\b|where\\b|which\\b|stat\\b|tree\\b|du\\b|df\\b|sort\\b|uniq\\b|cut\\b'
  + '|node\\s+(?:-v|--version)\\b|npm\\s+(?:-v|--version)\\b'
  + '|python\\s+--version\\b|pip\\s+(?:-v|--version)\\b'
  + ')',
  'i',
);

/** 命令本身是不是只读（不写盘、不串接、不拉起别的程序） */
export function isReadOnlyCommand(raw) {
  const cmd = String(raw || '').trim();
  if (!cmd) return false;
  if (/[>|;&`]|\$\(/.test(cmd)) return false;
  if (/\s(?:-delete|-exec|--exec|-fprint|-fwrite)\b/.test(cmd)) return false;
  return READONLY_CMD_RE.test(cmd);
}

export function specOf(name) {
  return SPEC[String(name || '')] || UNKNOWN;
}

/** 把一条 tool_call 归一成「能不能并行」的判定结果 */
export function classifyCall(call) {
  const fn = (call && call.function) || call || {};
  const name = String(fn.name || '');
  let args = {};
  try { args = JSON.parse(String(fn.arguments || '{}')); } catch { args = {}; }
  const spec = specOf(name);
  let parallelSafe = spec.parallelSafe;
  let reason = spec.unknown ? '未登记的工具，保守串行' : (parallelSafe ? '只读' : '有副作用');
  if (name === 'run_command') {
    parallelSafe = isReadOnlyCommand(args.command);
    reason = parallelSafe ? '只读命令' : '命令可能有副作用，串行';
  }
  return {
    name,
    args,
    parallelSafe,
    sideEffect: !parallelSafe,
    idempotent: Boolean(spec.idempotent && parallelSafe),
    known: !spec.unknown,
    reason,
  };
}

/** 两个调用能不能放在同一层。保守：两个都得是只读。 */
export function canParallel(a, b) {
  const x = classifyCall(a);
  const y = classifyCall(b);
  return x.parallelSafe && y.parallelSafe;
}

/**
 * 把一串调用切成「执行层」。
 *
 * 规则极简但安全：
 *   · 只读调用 → 攒进当前层（同层并行跑）
 *   · 遇到一个有副作用的调用 → 先把攒的那层推走，这个调用**独占一层**，
 *     后面重新攒（这样它之后的只读天然排在它后面）
 *
 * 例子：
 *   [读,读,读]            → [[读,读,读]]
 *   [读,写,读,读,写]      → [[读],[写],[读,读],[写]]
 *   [写,写]               → [[写],[写]]
 *
 * 为什么写操作独占一层而不是「跟只读同层」：后一步常要读前一步的结果，
 * 硬凑一批会跑出假结果，比慢糟得多。
 */
export function groupLayers(calls) {
  const layers = [];
  let layer = [];
  for (const c of Array.isArray(calls) ? calls : []) {
    if (!c) continue;
    if (classifyCall(c).parallelSafe) {
      layer.push(c);
      continue;
    }
    if (layer.length) { layers.push(layer); layer = []; }
    layers.push([c]);
  }
  if (layer.length) layers.push(layer);
  return layers;
}

/**
 * 依赖边（给检查脚本和指标用）：返回 [i, j] 表示 j 必须等 i。
 * 有副作用的调用 = 屏障：它前面所有调用都是它的前驱，它是后面所有调用的前驱。
 */
export function dependencyEdges(calls) {
  const list = Array.isArray(calls) ? calls : [];
  const edges = [];
  for (let j = 0; j < list.length; j++) {
    for (let i = 0; i < j; i++) {
      if (!classifyCall(list[i]).parallelSafe || !classifyCall(list[j]).parallelSafe) edges.push([i, j]);
    }
  }
  return edges;
}

/** 生成给提示词用的「名字 + 什么时候用」紧凑表。触发器从工具 description 第一句自动截，不手写。 */
export function buildToolIndex(schemas) {
  const out = [];
  for (const s of Array.isArray(schemas) ? schemas : []) {
    const fn = s && s.function ? s.function : s;
    const name = String(fn && fn.name || '');
    if (!name) continue;
    const desc = String((fn && fn.description) || '');
    const first = desc.split(/[\n。；;]/)[0].replace(/\*\*/g, '').trim();
    out.push({
      name,
      trigger: first.slice(0, 42) || '（按名字判断）',
      parallelSafe: specOf(name).parallelSafe,
    });
  }
  return out;
}
