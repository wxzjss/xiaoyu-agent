#!/usr/bin/env node
/**
 * 守卫：「操作桌面」的危险动作判断，不许再被改出「漏拦一片」或「误伤一片」。
 *
 * 【为什么要有这个脚本】
 * 2026-11-10 这一天，`ui-guard.mjs` 的危险判断被改了 **6 次**，每一次都修好一处、
 * 弄坏另一处。实测记录（都是我们自己踩的）：
 *   ① 只认中文       → 英文界面零拦截（Delete / Uninstall / Sign out 全放行）
 *   ② 加英文单动词   → 误伤 Format Document / Remove from favorites
 *   ③ 英文整层撤走   → 又回到英文零拦截，且这次写了注释说「故意不加」
 *   ④ 标题改 act+obj → 修好 delete.ts 误伤，但 Confirm Delete / 卸载 微信 漏拦 10 条
 *   ⑤ 改 app 白名单  → 修好上面几条，但新 app 默认漏
 *   ⑥ 模板改「在+why」→ 引入「在是删东西的菜单」「在要花钱」两处语病
 *
 * 每一轮都是「眼睛看出来的」，没有一道闸。这个脚本就是那道闸。
 *
 * 【关键设计：直接调 checkGuard，不复刻内部表】
 * 第一版复刻了 `hitDanger` / `hitTitleDanger` 的逻辑，结果 `ui-guard.mjs` 一重构
 * （拆成 DANGER_BTN_EN / DANGER_APPS / DANGER_KEYS_EN 三张表）脚本就全红了 ——
 * 那些红是脚本过时，不是代码坏了，反而制造噪音。
 * 现在直接调 `checkGuard()` 这个**真实出口**，内部怎么拆表都不影响。
 *
 * 【不连 CDP、不启浏览器、不碰真机】
 * checkGuard 是纯函数（输入 控件+窗口 信息 → 输出要不要问），直接喂参数就是最准的验证。
 *
 * 跑法：node scripts/check-ui-danger-words.mjs
 */
import { makeChecker } from './_harness_util.mjs';
import { checkGuard } from '../src/ui-guard.mjs';

const t = makeChecker('ui-guard / 危险动作判断');

/**
 * 判「这一次动作要不要问主人」。
 *
 * 只关心 needAsk（要不要主人点头）；`ok:false` 但没有 needAsk 的是「直接拒绝」
 * （密码框、白名单外），那些不在本脚本的判据里，单独看。
 */
function needAsk({ tool = 'ui_click', el = {}, title = '', app = '' } = {}) {
  const r = checkGuard({
    tool,
    el: { name: el.name || '', role: el.role || 'button', ...el },
    snap: { title, app },
    cfg: {},
  });
  return r;
}

/* ================================================================== */
/* 一、危险按钮名必须问（控件名这一层）                                  */
/* ================================================================== */

/**
 * 【这一组是「不许退化成只认中文」的钉子】
 *
 * 为什么必须在「干净窗口」下测：如果窗口标题本身危险，标题表会兜住，
 * 那就测不出「按钮名这一层」到底有没有防护。所以标题一律用最干净的。
 *
 * 真实场景依据（窗口标题一点线索都没有，只能靠按钮名）：
 *   · 资源管理器选中文件按 Delete —— 标题是「下载」
 *   · Chrome 书签管理器点 Remove —— 标题是「书签管理器」
 *   · VS Code 源代码管理面板点 Discard —— 标题是「main.js - Code」
 */
const CLEAN_WINDOWS = [
  { title: '下载', app: 'explorer' },
  { title: 'main.js - Visual Studio Code', app: 'code' },
  { title: '书签管理器 - Chrome', app: 'chrome' },
];

const DANGER_BUTTONS = [
  ['Delete', '英文删除'],
  ['Delete All', '英文全删'],
  ['Delete account', '英文删账号'],
  ['Erase', '英文擦除'],
  ['Wipe', '英文抹除'],
  ['Purge', '英文清除'],
  ['Uninstall', '英文卸载'],
  ['Destroy', '英文销毁'],
  ['Empty Trash', '英文清空回收站'],
  ['Reset All', '英文重置所有'],
  ['Format Disk', '英文格式化磁盘'],
  ['Remove file', '英文带宾语 remove'],
  ['Clear all data', '英文清空数据'],
  ['Sign out', '英文退出登录'],
  ['Log out', '英文登出'],
  ['Deactivate', '英文停用账号'],
  ['Purchase', '英文购买'],
  ['Pay now', '英文付款'],
  ['Checkout', '英文结账'],
];
for (const [btn, note] of DANGER_BUTTONS) {
  for (const w of CLEAN_WINDOWS) {
    const r = needAsk({ el: { name: btn }, title: w.title, app: w.app });
    t.ok(`危险按钮要问：${note}（窗口「${w.title}」）`, r.needAsk === true, r.needAsk ? '' : '放行了');
  }
}

/* 中文侧（一直是对的，钉住别退化） */
const DANGER_BUTTONS_CN = ['删除', '清空', '卸载', '格式化', '购买', '付款', '退出登录', '注销', '重置所有', '删除账号'];
for (const btn of DANGER_BUTTONS_CN) {
  const r = needAsk({ el: { name: btn }, title: '下载', app: 'explorer' });
  t.ok(`危险按钮要问：${btn}`, r.needAsk === true, r.needAsk ? '' : '放行了');
}

/* ================================================================== */
/* 二、日常按钮必须放行（误伤面）                                       */
/* ================================================================== */

/**
 * 【这一组是「不许为了拦全而误伤一片」的钉子】
 * 每一条都对应一次真实误伤（这一轮踩过其中 4 个）。
 * 加英文词时最容易忘的就是这组 —— 因为它们的名字里确实含危险动词。
 */
const SAFE_BUTTONS = [
  ['Format Document', 'VS Code 格式化当前文件（误伤过）'],
  ['Remove from favorites', '取消收藏（误伤过）'],
  ['Remove from list', '从列表移除'],
  ['Remove breakpoint', '移除断点（可撤销）'],
  ['Clear search', '清空搜索框'],
  ['Clear formatting', '清除格式'],
  ['Reset zoom', '重置缩放'],
  ['Reset settings', '重置设置（不是重置所有）'],
  ['Discard changes', '放弃改动（有确认，可撤销）'],
  ['Close', '关闭'],
  ['Cancel', '取消'],
  ['Apply', '应用'],
  ['OK', '确定'],
  ['Save', '保存'],
  ['Undo', '撤销'],
  ['Rename', '重命名'],
  ['Move', '移动'],
  ['Copy', '复制'],
  ['Delete.ts', '文件名当控件名（边界用例，现实中不会发生）'],
];
for (const [btn, note] of SAFE_BUTTONS) {
  const r = needAsk({ el: { name: btn }, title: 'main.js - Visual Studio Code', app: 'code' });
  t.ok(`日常按钮要放行：${note}`, r.needAsk !== true, r.needAsk ? '误拦了（' + (r.reason || '') + '）' : '');
}

/* ================================================================== */
/* 三、危险窗口必须问（窗口这一层，按钮名干净）                          */
/* ================================================================== */

/**
 * 【这一组是「控件名干净、窗口危险」的钉子】
 * 按钮一律用 `OK`（最干净的名字），确保命中的是标题/窗口这一层。
 *
 * 这一组曾经漏过 10 条：act+obj 两段式修好文件名误伤之后，
 * 「确认删除」（宾语在正文里）、「卸载 微信」（宾语是软件专名）全漏了。
 */
const DANGER_WINDOWS = [
  ['Delete File', '带宾语的删除窗口'],
  ['Delete folder', '删除文件夹'],
  ['删除文件', '中文带宾语'],
  ['Confirm Delete', '确认删除对话框（宾语在正文里）'],
  ['Confirm deletion', '确认删除（名词形态）'],
  ['Delete confirmation', '删除确认'],
  ['Are you sure you want to delete?', '英文问句式'],
  ['确认删除', '中文确认式'],
  ['确定删除？', '中文问句'],
  ['你确定要删除吗？', '中文口语问句'],
  ['卸载 微信', '卸载（宾语是软件专名）'],
  ['卸载 应用', '卸载（通用宾语）'],
  ['Uninstall WeChat', '英文卸载'],
  ['Uninstall', '英文卸载（无宾语）'],
  ['Empty Trash', '清空回收站'],
  ['清空回收站', '中文清空回收站'],
  ['格式化磁盘', '格式化磁盘'],
  ['Format Disk', '英文格式化磁盘'],
  ['Confirm Purchase', '确认付款'],
];
for (const [title, note] of DANGER_WINDOWS) {
  /* 【按钮名用两个】OK 和「是」—— 都刻意选「看不出危险」的名字。
   * 这样测的才是「窗口这一层能不能兜住」，而不是被按钮名兜住。
   * （这个交叉矩阵是 bug-hunter 提的，比我原来只用一个 OK 更严。） */
  for (const btn of ['OK', '是']) {
    const r = needAsk({ el: { name: btn }, title, app: 'explorer' });
    t.ok(`危险窗口要问：${note}（按钮「${btn}」）`, r.needAsk === true, r.needAsk ? '' : '漏拦了');
  }
}

/* 危险窗口里按 Enter 也要问（不能只拦点击） */
for (const [title, note] of DANGER_WINDOWS.slice(0, 3)) {
  const r = needAsk({ tool: 'ui_key', el: {}, title, app: 'explorer' });
  t.ok(`危险窗口里按键要问：${note}`, r.needAsk === true, r.needAsk ? '' : '漏拦了');
}

/* ================================================================== */
/* 四、文件名不许误伤整个窗口                                           */
/* ================================================================== */

/**
 * 【这一组是这一轮最贵的一课】
 *
 * `snap.title` 来自 `ui-tree.mjs:232` 的 `$root.Current.Name` —— 就是「文件名 - 程序名」。
 * 所以只要标题表用单动词（不带宾语），主人在编辑器里打开一个叫 delete.ts 的文件，
 * **那个窗口里所有按钮（保存、运行、切标签）全部被判危险**，功能直接没法用。
 *
 * 每一条都是真实的编辑器窗口标题。
 */
/**
 * 【反方向守住：以 Help 结尾但必须拦的】
 *
 * 2026-11-10 arch-auditor 抓到我这个脚本的盲区：
 * **原来只有 1 条 `- Help` 用例，而且是「期望放行」的** ——
 * 没有任何一条覆盖「以 Help 结尾但仍然是真删除确认框」。
 *
 * 后果很严重：如果按本脚本的失败清单去修（让 `Delete log history - Help` 变绿），
 * 最省事的做法就是「无条件 `isDocTitle → return null`」——
 * 那样本脚本会全绿，但**所有以 Help 结尾的删除确认框都会被放行**。
 *
 * 所以这一组必须和上面那组**成对存在**。谁改文档豁免规则，两组都要过。
 *   · `Delete log history - Help`        → 放（讲怎么删的文档）
 *   · `Confirm Delete - Help`            → 拦（这句是在问你要不要删）
 * 差别就在「有没有确认语义」。
 */
const DANGER_DOC_LOOKING = [
  ['Confirm Delete - Help', '确认框（宾语在正文）'],
  ['Are you sure you want to delete? - Help', '疑问式确认'],
  ['Delete confirmation - Help', '名词式确认'],
  ['删除确认 - 帮助', '中文确认框'],
  ['确定删除吗？- 帮助', '中文疑问式'],
  ['Delete File - Security Help', '安全警告（不是文档）'],
  ['Delete File - Security Warning', '安全警告'],
  ['清空回收站 - 帮助', '不可逆动作 + Help 后缀'],
  /**
   * 【2026-11-11 加·71% 覆盖率的真洞（arch-auditor 抓的）】
   *
   * 上面那几条靠 `_SEC_WORD`（Security）或 `_ASK_WORD`（Confirm）挡住，
   * 但**「危险动作 + 纯 Help 后缀、既没 Security 也没 Confirm」这一类完全没测**。
   *
   * 实测（当前代码 00:16:07 版本）：
   *   Delete File          → 拦 ✅
   *   Delete File - Help   → 放 ❌   ← 同一个操作，加个后缀就穿过去了
   *
   * 规模：7 动词 × 10 对象 × 5 文档后缀 = 350 条，**漏拦 300 条 = 86%**。
   *
   * 根因：文档豁免只排除了「安全警告/确认框/清空回收站/格式化磁盘」四类，
   * 而「删除 X」这类最常见的删除动作不在排除名单里。
   *
   * ⚠️ 这几条和下面「真文档要放行」是**同一个正则的两侧**：
   *    Delete File - Help        → 拦（对象是被删的东西）
   *    Delete log history - Help → 放（对象是「关于删除的记录」）
   * 区别在**对象词**，不在后缀。谁改文档豁免，必须两组同时过。
   */
  ['Delete File - Help', '危险动作 + 纯 Help（物件）'],
  ['Delete Folder - Help', '危险动作 + 纯 Help（文件夹）'],
  ['Delete User - Help', '危险动作 + 纯 Help（用户）'],
  ['Delete Account - Help', '危险动作 + 纯 Help（账号）'],
  ['Remove File - Guide', 'Remove + 物件 + Guide'],
  ['Uninstall Program - Help', '卸载程序 + Help'],
  ['卸载程序 - 帮助', '中文：卸载 + 程序'],
  ['删除文件 - 帮助', '中文：删除 + 文件'],
  ['删除文件夹 - 帮助', '中文：删除 + 文件夹'],
  ['删除用户 - 帮助', '中文：删除 + 用户'],
  ['清空数据 - 帮助', '清空 + 数据'],
];
for (const [title, note] of DANGER_DOC_LOOKING) {
  const r = needAsk({ el: { name: 'OK' }, title, app: 'explorer' });
  t.ok(`带 Help 的真危险要问：${note}`, r.needAsk === true, r.needAsk ? '' : '漏拦了（文档豁免把人话放过去了）');
}

/**
 * 【同一组的另一半：真文档必须放行】
 *
 * 这两组是「双向约束」—— 只满足其中一边，改法就是错的。
 * 具体见上面那组的注释。
 */
const SAFE_DOC_TITLES = [
  ['Delete log history - Help', '英文帮助页'],
  ['Delete log history - User Guide', '英文用户指南'],
  ['Delete log history - 快速参考', '中文快速参考'],
  ['删除文件 - 使用手册', '中文使用手册'],
  ['删除文件 - 用户指南', '中文用户指南'],
  ['删除文件 - 说明书', '中文说明书'],
  ['删除文件 - 操作说明', '中文操作说明'],
];
for (const [title, note] of SAFE_DOC_TITLES) {
  const r = needAsk({ el: { name: 'OK' }, title, app: 'explorer' });
  t.ok(`真文档要放行：${note}`, r.needAsk !== true, r.needAsk ? '误拦了' : '');
}

const SAFE_WINDOWS = [
  ['main.js - Visual Studio Code', '普通文件'],
  ['delete.ts - Visual Studio Code', '文件名含 delete（误伤过）'],
  ['delete.js - Code', '文件名含 delete（另一种 app 名）'],
  ['deleted-items.md - Code', '文件名含 deleted'],
  ['prettier-format.md - Visual Studio Code', '文件名含 format（误伤过）'],
  ['formatter.js - Code', '文件名含 formatter'],
  ['remove_old_data.py - Sublime Text', '文件名含 remove'],
  ['clear_cache.rs - Visual Studio Code', '文件名含 clear'],
  ['removed-items.json - Code', '文件名含 removed'],
  ['Format转换说明.md - 记事本', '中文文件名含 format（误伤过）'],
  ['删除记录的历史介绍.md - 记事本', '说明文档标题含「删除」'],
  ['Delete log history - Help', '帮助文档讲解「怎么删日志」'],
  ['回收站', '打开回收站看东西（不是清空）'],
  ['Recycle Bin', '英文回收站（打开不是危险）'],
  ['Downloads', '下载文件夹'],
  ['下载', '中文下载文件夹'],
  ['文档', '中文文档文件夹'],
  ['package.json - Code', '配置文件'],
  ['settings.json - Visual Studio Code', '配置文件'],
];
for (const [title, note] of SAFE_WINDOWS) {
  const r = needAsk({ el: { name: 'Save' }, title, app: 'explorer' });
  t.ok(`窗口要放行：${note}`, r.needAsk !== true, r.needAsk ? '误拦了（' + (r.reason || '') + '）' : '');
}

/**
 * 【普通窗口里的普通按钮 —— 整窗被拦的历史事故】
 *
 * 这一组钉的是「窗口标题命中之后，里面所有按钮都被判危险」那类事故。
 * 每一条都是主人日常会点的、完全无害的按钮。
 */
const PLAIN_BUTTONS = ['打开', '还原', '取消', 'OK'];
const PLAIN_WINDOWS = ['回收站', 'Recycle Bin', '下载', '文档'];
for (const title of PLAIN_WINDOWS) {
  for (const btn of PLAIN_BUTTONS) {
    const r = needAsk({ el: { name: btn }, title, app: 'explorer' });
    t.ok(`普通窗口「${title}」里点「${btn}」要放行`, r.needAsk !== true, r.needAsk ? '误拦了' : '');
  }
}

/* 回收站里点「还原」要放过 —— 这是救命操作，拦了主人会很恼火 */
{
  const r = needAsk({ el: { name: '还原' }, title: '回收站', app: 'explorer' });
  t.ok('回收站里点「还原」要放行', r.needAsk !== true, r.needAsk ? '误拦了' : '');
}
{
  const r = needAsk({ el: { name: 'Restore' }, title: 'Recycle Bin', app: 'explorer' });
  t.ok('回收站里点「Restore」要放行', r.needAsk !== true, r.needAsk ? '误拦了' : '');
}

/* ================================================================== */
/* 五、文案：拼出来得是人话                                             */
/* ================================================================== */

/**
 * 【为什么把文案也钉进这个检查】
 *
 * `reason` 是模板 + `why` 拼出来的。单独看每一段都通顺，拼起来会出语病：
 *
 *   第 ⑥ 次改动用 `why.replace(/^在/, '')` 再拼 `在${why}`，
 *   而 `why` 里有「是删东西的菜单」「要花钱」这种不以「在」开头的，拼出：
 *     「这个窗口（Downloads）在是删东西的菜单，…」
 *     「这个窗口（Confirm Purchase）在要花钱，…」
 *
 * 这类错误**没有任何运行时症状**，只有人读才发现。所以变成断言。
 */
const ALL_REASONS = [
  { el: { name: 'OK' }, title: 'Delete File', app: 'explorer' },
  { el: { name: 'OK' }, title: 'Format Disk', app: 'explorer' },
  { el: { name: 'OK' }, title: 'Empty Trash', app: 'explorer' },
  { el: { name: 'OK' }, title: 'Confirm Purchase', app: 'chrome' },
  { el: { name: 'OK' }, title: '确认删除', app: 'explorer' },
  { el: { name: '删除' }, title: 'Downloads', app: 'explorer' },
];
for (const c of ALL_REASONS) {
  const r = needAsk(c);
  if (!r.needAsk) continue;
  const s = String(r.reason || '');
  /* 拼接产物里的硬伤：动词前多一个「在」、或「是」跟在「在」后面 */
  t.ok(`理由读着通顺：${c.title}`, !/在(是|要|会|干掉?的)/.test(s) || /在干掉/.test(s), s);
  /* 不许出现重复的主语 */
  t.ok(`理由不重复主语：${c.title}`, (s.match(/这个窗口/g) || []).length <= 1, s);
  /* 括号里不许空着 */
  t.ok(`理由标题不空：${c.title}`, !/这个窗口（\s*）/.test(s), s);
}

/* ================================================================== */
/* 六、结构：三类判据别被合并                                         */
/* ================================================================== */

/**
 * 三类判据是这一天讨论出来的，各有各覆盖的场景，别被后来人合并：
 *   ① 标题即动作    → 系统对话框（Delete File / 卸载 微信）
 *   ② app + 按钮名  → 通用软件的危险菜单（VS Code 的 Delete File 菜单）
 *   ③ 确认框语境    → Confirm Delete（宾语在正文里）
 *
 * 合并成一条的后果我们试过了：要么文件名误伤整窗，要么确认框全漏。
 */
t.ok('至少有「按钮名」和「窗口」两条判据', typeof checkGuard === 'function');

/* 一个兜底：任何情况下 checkGuard 都不许抛 */
{
  let threw = null;
  try {
    needAsk({ el: {}, title: '', app: '' });
    needAsk({ el: { name: '' }, title: '', app: '' });
    needAsk({ tool: 'ui_key', el: {}, title: '', app: '' });
    needAsk({ el: { name: 'Delete' }, title: '', app: '' });
  } catch (e) {
    threw = e;
  }
  t.ok('空标题 / 空控件名不许抛异常', !threw, threw ? String(threw.message) : '');
}

/* ================================================================== */
/* 七、硬拒绝键组合（Alt+F4 / Ctrl+W）—— 2026-11-11 补                    */
/* ================================================================== */

/**
 * 【这组跟上面的 needAsk 判据不同类】
 *
 * 上面的键位用例（Ctrl+Delete / Shift+Delete）是「要问主人」；
 * 这一组是「**连问都不问**，直接拒」—— Alt+F4 / Ctrl+W / Ctrl+Shift+W
 * 按下去就是关窗口，弹窗反而抢主人正在打字的焦点，而且没有例外场景。
 * 判据是 `ok:false && !needAsk`：要是哪天被人改成了 needAsk:true，
 * 这里会红 —— 改回去之前先想想为什么当初不走询问。
 */
const HARD_REJECT_KEYS = [
  ['Alt+F4', '关窗口（标准写法）'],
  ['alt+f4', '关窗口（小写）'],
  ['Alt + F4', '关窗口（带空格）'],
  ['Ctrl+W', '关标签页'],
  ['ctrl+w', '关标签页（小写）'],
  ['Ctrl+Shift+W', '关整个窗口'],
];
for (const [keys, note] of HARD_REJECT_KEYS) {
  const r = checkGuard({ tool: 'ui_key', text: keys, snap: { title: 'Notepad', app: 'notepad' }, cfg: {} });
  t.ok(`硬拒键不许问要直接拒：${keys}（${note}）`, r.ok === false && !r.needAsk, r.needAsk ? '走了询问，应该直接拒' : (r.ok ? '放行了' : ''));
}
const SAFE_KEYS = [['Ctrl+C', '复制'], ['Ctrl+V', '粘贴'], ['Alt+Tab', '切窗口'], ['ctrl+s', '保存']];
for (const [keys, note] of SAFE_KEYS) {
  const r = checkGuard({ tool: 'ui_key', text: keys, snap: { title: 'Notepad', app: 'notepad' }, cfg: {} });
  t.ok(`日常键要放行：${keys}（${note}）`, r.ok === true, r.needAsk ? '误拦了（' + (r.reason || '') + '）' : '');
}

t.done();
