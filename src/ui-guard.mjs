/**
 * 桌面动作 + 安全护栏 —— 点、双击、右键、打字、按键、滚轮（2026-11-03）。
 *
 * 【和 dsh-computer-use 的关系】
 * 做法全抄它（观察快照 TTL / 元素编号 / 危险词审批 / 密码框拒绝 / 失败关闭），
 * 实现是 Windows 原生的：SendInput + UI Automation，不装 cua-driver。
 *
 * 【为什么不抢焦点】
 * cua-driver 用的是「虚拟光标」，能点进没有焦点激活的窗口。Windows 这边
 * 没有等价物 —— 要么抢焦点（SetForegroundWindow），要么把点击「投」过去。
 * 这里选后者：按元素中心坐标发 WM_LBUTTONDOWN/UP，或者先把窗口拉到前面、
 * 再发真实 SendInput。**默认不打扰主人**：只投点击、不改前台窗口。
 * 需要真的输入文字/按键（那些必须前台），才显式 bringToFront。
 *
 * 【护栏从哪儿来的】
 *   - 没有观察快照就动手 → 拒（防「模型凭想象点」）
 *   - 快照过期 → 拒（界面早变了，旧编号点下去是碰运气）
 *   - 目标窗口不在 allowedApps → 拒（区域限制）
 *   - 目标是密码框 → 打字直接拒（密码必须主人自己输）
 *   - 按钮/菜单文字里有危险词（删除、支付、退出登录…）→ 要主人确认
 *   - 任何一步拿不准 → 拒。宁可不动，不许瞎动。
 */
import { windowText } from './ui-tree.mjs';

/** 动作工具的名单（列窗口/读界面不算动作，不受区域限制）。 */
export const ACT_TOOLS = new Set(['ui_click', 'ui_double_click', 'ui_right_click', 'ui_type', 'ui_key', 'ui_scroll']);

/**
 * 危险动作的词。命中就要主人点头再干。
 *
 * 【为什么是这几组】
 * 和 dsh-computer-use 的取舍一致：只挡「做了就收不回来」的。
 * 删除/清空/格式化/卸载 → 东西没了；支付/转账/下单 → 钱没了；
 * 退出登录/注销/解绑 → 要重新折腾一遍。
 * 故意**不含**「保存」「关闭」「新建」这些日常词 —— 挡这些只会让工具没法用。
 */
export const DANGER_WORDS = [
  { re: /删除|移除|清空|清倒|格式化|卸载|永久|销毁|抹掉|重置所有/, why: '会丢东西' },
  { re: /支付|付款|购买|下单|结账|转账|汇款|提交订单|确认交易|充值|打赏/, why: '会花钱' },
  { re: /退出登录|注销|登出|解绑|解封|删除账号/, why: '要重新折腾一遍' },
];

/**
 * 密码框的 UIA 特征。
 *
 * 【为什么还看 IsPassword】
 * ControlType 只是声明的角色；真正写着「这是密码」的是 IsPassword 属性。
 * 两个都看，宁可多拦一次，不许漏一次。
 */
/** UIA 的 role 或者控件名里带这些字，就当密码框。
 *
 * 【为什么名字也要看】
 * 有些程序（国产软件尤其多）密码框的 ControlType 就是普通 Edit，
 * 名字却老老实实写着「密码」「口令」。只认 role 会漏。
 * 反过来看错了也不会误伤：叫「密码提示」的框被拦一下，主人自己打就是了。
 */
const PASSWORD_ROLE_HINT = /password|passwd|pwd|secure|密码|口令|密钥/i;

// ---------------------------------------------------------------------------
// 观察快照（单例，跟 dsh-computer-use 的 lib/snapshot.js 一个模型）
// ---------------------------------------------------------------------------

let snapshot = null;

export function setSnapshot(s) {
  snapshot = {
    at: Date.now(),
    ttlMs: Number(s.ttlMs) || 30000,
    id: String(s.id || ''),
    hwnd: Number(s.hwnd) || 0,
    pid: Number(s.pid) || 0,
    title: String(s.title || ''),
    app: String(s.app || ''),
    win: s.win || { x: 0, y: 0, w: 0, h: 0 },
    png: String(s.png || ''),
    elements: Array.isArray(s.elements) ? s.elements : [],
  };
  return snapshot.id;
}

export function getSnapshot() {
  return snapshot;
}

export function clearSnapshot() {
  snapshot = null;
}

export function snapshotAge() {
  return snapshot ? Date.now() - snapshot.at : -1;
}

export function isFresh(ttlMs) {
  if (!snapshot) return false;
  return Date.now() - snapshot.at <= (Number(ttlMs) || snapshot.ttlMs);
}

/**
 * 按编号取元素。
 *
 * 三道检查跟 dsh-computer-use 一模一样，报错话也尽量说人话：
 * 没观察过 → 叫她先观察；过期了 → 叫她重新观察；编号不在 → 叫她看最新编号。
 */
export function resolveElement(index, ttlMs) {
  if (!snapshot) {
    throw new Error('还没观察过界面：先用 ui_observe 看一眼，再按编号动手。');
  }
  const ttl = Number(ttlMs) || snapshot.ttlMs;
  if (!isFresh(ttl)) {
    const sec = Math.round((Date.now() - snapshot.at) / 1000);
    clearSnapshot();
    throw new Error(`上一次观察已经过了 ${sec} 秒（超过 ${Math.round(ttl / 1000)} 秒算过期）：界面可能变了，重新 ui_observe 再点。`);
  }
  const want = Number(index);
  if (!Number.isFinite(want)) throw new Error('要给元素编号（ui_observe 结果里方括号里那个数）。');
  const hit = snapshot.elements.find((e) => Number(e.i) === want && e.act !== false);
  if (!hit) {
    const nums = snapshot.elements.filter((e) => e.act !== false).map((e) => e.i);
    const hint = nums.length ? `现在能点的是 ${nums.slice(0, 24).join('、')}${nums.length > 24 ? ' …' : ''}` : '这个窗口现在没有可点元素';
    throw new Error(`编号 [${want}] 不在这次观察里。${hint}。`);
  }
  return { el: hit, snap: snapshot };
}

/** 只取窗口（不指定元素时用：键盘、滚轮这类作用于整窗的动作）。 */
export function resolveWindow(ttlMs) {
  if (!snapshot) throw new Error('还没观察过界面：先用 ui_observe 看一眼。');
  const ttl = Number(ttlMs) || snapshot.ttlMs;
  if (!isFresh(ttl)) {
    clearSnapshot();
    throw new Error('上一次观察已经过期了：重新 ui_observe 再动手。');
  }
  return snapshot;
}

// ---------------------------------------------------------------------------
// 护栏
// ---------------------------------------------------------------------------

function hitDanger(text) {
  const s = String(text || '');
  for (const d of DANGER_WORDS) {
    const m = d.re.exec(s);
    if (m) return { word: m[0], why: d.why };
  }
  return null;
}

/**
 * 判断「这一次动作要不要先问主人」。
 *
 * 返回 { ok:true } 放行，{ ok:false, reason } 拒绝，
 * { ok:false, needAsk:true, reason } 要主人点头。
 *
 * @param {{tool:string, el?:object, text?:string, cfg?:object, snap?:object}} p
 */
export function checkGuard({ tool, el, text, cfg = {}, snap }) {
  const allowed = Array.isArray(cfg.allowedApps) ? cfg.allowedApps.filter(Boolean) : [];
  const s = snap || snapshot;
  if (allowed.length) {
    const appName = String(s?.app || '');
    const title = String(s?.title || '');
    const okApp = allowed.some((a) => {
      const want = String(a).toLowerCase();
      return appName.toLowerCase().includes(want) || title.toLowerCase().includes(want);
    });
    if (!okApp) {
      return { ok: false, reason: `这个窗口（${appName || title || '未知'}）不在允许操作的范围里（现在只许动：${allowed.join('、')}）。要去动它的话，让主人把【操作桌面】的白名单里加上它。` };
    }
  }

  // 密码框：打字一律拒
  const role = String(el?.role || '');
  const name = String(el?.name || '');
  const looksPwd = el?.password === true || (tool === 'ui_type' && PASSWORD_ROLE_HINT.test(role + ' ' + name));
  if (looksPwd && tool === 'ui_type') {
    return { ok: false, reason: '这是一个密码框：密码、密钥这种东西必须主人自己输，我不代打。' };
  }

  // 危险词：要看主人点头
  if (tool === 'ui_click' || tool === 'ui_double_click' || tool === 'ui_right_click') {
    const d = hitDanger(name);
    if (d) return { ok: false, needAsk: true, reason: `要点的是「${d.word}」（${d.why}）` };
  }
  if (tool === 'ui_key') {
    const d = hitDanger(text);
    if (d) return { ok: false, needAsk: true, reason: `要按的键组合里有「${d.word}」（${d.why}）` };
  }
  return { ok: true };
}

/**
 * 问主人这件事能不能干。
 *
 * 【失败关闭】
 * 外面（tools.mjs）没有传审批回调 —— 那就当没批准。
 * 绝不允许「问不到主人就自己决定」。
 */
export async function askApproval({ exec, toolName, reason }) {
  const ask = exec?.askApproval;
  if (typeof ask !== 'function') return false;
  try {
    const r = await ask({ toolName, reason });
    return r === true;
  } catch {
    return false;
  }
}

/** 只读检查用：这个窗口上有没有危险按钮（给 ui_observe 顺手提示一句）。 */
export async function dangerOnScreen(hwnd) {
  const words = await windowText(hwnd);
  if (!Array.isArray(words)) return [];
  const hits = [];
  for (const w of words) {
    const d = hitDanger(w);
    if (d && !hits.some((h) => h.word === d.word)) hits.push({ word: d.word, why: d.why, text: String(w).slice(0, 40) });
  }
  return hits;
}
