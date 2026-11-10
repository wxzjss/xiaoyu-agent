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
  /**
   * 【2026-11-10 · 这张表**故意不加英文** —— 加了会误伤一片】
   *
   * 我一开始往这里加了英文词（delete|remove|format|clear|uninstall…），
   * 想补「英文界面零拦截」。但实测立刻误伤：
   *   点「Format Document」在「settings.json - Code」→ 拦（VS Code 天天用）
   *   点「Remove from favorites」在「Photos」        → 拦（收藏，不是删文件）
   *
   * 因为英文词在**控件名**里的含义太泛：format=格式化文档 ≠ 格式化磁盘。
   * 结论：**控件名只认中文**（中文「删除/格式化」在控件名里几乎不会误判），
   * 英文交给下面的窗口标题表 —— 「Delete File」「Empty Trash」那种窗口才是真危险，粒度更准。
   */
];

/**
 * 【2026-11-10 加·窗口标题里的危险词（只管容器，不管控件）】
 *
 * 上面那张表判断「被点的控件叫什么」。但真实危险常常在**窗口**上：
 *   · 窗口「Delete File」里，按钮就叫「OK」—— 控件名干净，点了照样删
 *   · 窗口「卸载 微信」里，按钮叫「是」
 * 只查控件名 = 这类全漏。所以单开一组**只在 title/app 里匹配**的词。
 *
 * ⚠️ 这张表的两个坑（我各踩过一次，都是自己造的）：
 *
 * ① **英文词不能太泛**：`remove` / `clear` / `format` 单放会误伤一片——
 *    「Remove from favorites」（收藏夹）、「Format Document」（VS Code 格式化当前文件）
 *    都会被拦。所以英文只留明确指向删除的 `delete|erase|uninstall|wipe|purge`。
 *
 * ② **`snap.title` 里含文件名**（实测 `ui-tree.mjs:232`：`$title = Txt($root.Current.Name)`）。
 *    所以 `delete.ts` / `remove_old_data.py` / `clear_cache.rs` 这类**文件名本身就带危险词**——
 *    打开这种文件，整个窗口的所有按钮（包括「保存」「运行」）都会被拦，功能直接没法用。
 *    修法：**要求标题里同时出现「动作词」和「对象词」**才算危险（见 hitTitleDanger）。
 */
/**
 * 【2026-11-10 · 按钮名里的英文：分两类，不搞一刀切】
 *
 * 我在这张表上翻过两次车，两次都是「用一条规则覆盖两种语义」：
 *
 *   车 1：把 `delete|remove|format|clear|uninstall` 全加进来 →
 *         点「Format Document」（VS Code 格式化当前文件）、
 *         点「Remove from favorites」（收藏夹）全被拦 → 写代码时天天弹，功能没法用。
 *   车 2：一气之下把英文整个撤掉 →
 *         VS Code / 资源管理器里的 `Delete`、`Uninstall` 又变成零拦截，
 *         危险按钮真的被点下去。**这比误伤严重。**
 *
 * 现在按「这个词在按钮上有没有第二个意思」分两类：
 *
 *   · 无歧义（只有一个意思）→ **单词就拦**：
 *     `Delete` / `Uninstall` / `Erase` / `Wipe` / `Purge` / `Destroy`
 *     按钮上写这些字，除了"删掉东西"没有别的解释。
 *
 *   · 有歧义（看有没有宾语）→ **要求带宾语才拦**（bug-hunter 建议的方案 A）：
 *     `Remove file` 拦、裸 `Remove` 不拦；`Format Disk` 拦、`Format Document` 不拦。
 *     这样零误伤，又不漏「Remove selected files」这种真危险。
 *
 * 为什么不按 app 豁免（方案 B）：要维护一张越来越长的特例表，
 * 而且新装的程序永远不在表里 —— 那等于回到"英文零拦截"。
 */
export const DANGER_BTN_EN = [
  /* 无歧义：单词即危险 */
  { re: /\b(delete|uninstall|erase|wipe|purge|destroy)\b/i, why: '会丢东西' },
  /* 有歧义：必须带宾语 */
  { re: /\b(remove|clear|format|reset)\b[\s\S]{0,24}\b(file|files|folder|folders|disk|drive|volume|data|all|everything|account|history|contents?|trash|recycle ?bin|bin)\b/i, why: '会丢东西' },
  /* 【2026-11-10 补·copy-auditor 的 181 条检查抓出 38 个漏拦，全是这两族】
   *  · 「清空回收站」：`Empty Trash` / `Empty Recycle Bin` / `清倒回收站`
   *  · 「退出登录」：`Log Out` / `Sign Out` / `登出` / `停用账号`
   * 这两族我原来完全没覆盖 —— 前者是真删文件，后者是主人要重新折腾一遍。 */
  { re: /\b(empty|clear|purge)\b[\s\S]{0,16}\b(trash|recycle ?bin|bin)\b/i, why: '会清空回收站' },
  { re: /\b(log ?out|sign ?out|logoff|log off|switch account|deactivate|disable account|unlink|unbind)\b/i, why: '要重新折腾一遍' },
  { re: /\b(pay|purchase|buy|checkout|transfer|send money|place order)\b/i, why: '会花钱' },
];

/* 键盘组合里的危险键：Ctrl+Delete / Shift+Delete 是真删 */
export const DANGER_KEYS_EN = /\b(delete|backspace)\b/i;

/**
 * 【2026-11-10 定稿·标题/应用名的判定，一类一类说清为什么这么写】
 *
 * 我在这个地方翻过三次车，每次都是"一条规则盖住两种语义"。现在定型成三条，各有各的理由：
 *
 * ── 第 1 类：**系统级删除动作**（按窗口标题，标题含文件名也拦）
 * 删文件、清回收站、卸载程序、格式化磁盘。这些窗口标题里必然写着动作本身，
 * 而 Windows 资源管理器/系统对话框的标题**就是动作**（「删除」「Delete File」），不含文件名。
 *
 * ── 第 2 类：**通用软件的危险菜单**（按**进程名** snap.app，不看标题）
 * VS Code 的「File → Delete File」、PS 的「Delete Layer」——
 * 这些窗口标题是文件名（`xxx.ts - Visual Studio Code`），标题里永远不会有 delete，
 * 所以**只能靠 app 名判断**。好在 `snap.app` 取的是 `Get-Process.ProcessName`（`ui-tree.mjs:234`），
 * 是进程名不是标题，可靠。
 *
 * ── 第 3 类：**确认框语境**（bug-hunter 抓到的漏）
 * 「确认删除」这个按钮名里没有宾语，按"动作+对象"规则会被放过 —— 而它恰恰最该拦。
 * 这类靠标题里出现「确认/确定/Confirm」+ 动作词来判断。
 *
 * ⚠️ 明确不做的：**不按"文件名里出现 delete 就拦整个窗口"**——
 * 我踩过：窗口标题是 `delete.ts - Visual Studio Code`，结果整个编辑器
 * 所有按钮（保存、运行、切标签）全要确认，写代码直接没法用。
 * 文件名里的危险词**只有第 2 类（app 在名单里）才升级成危险**，裸文件名不算。
 */
export const DANGER_TITLE_WORDS = [
  /* 第 1 类：系统级删除/清空/卸载（标题即动作，不看文件名） */
  { re: /^\s*(删除|清空|格式化|卸载|销毁)/, why: '在删东西' },
  /* 【2026-11-10 补名词形】`\bdelete\b` 匹配不到 `deletion`（后面跟着 ion，不是词边界），
   * 而确认框最常用的恰恰是名词形态（"Confirm deletion" 比 "Confirm Delete" 正式）。 */
  { re: /^\s*(delete|deletion|erase|erasure|uninstall|uninstallation|wipe|purge|format|empty)\b/i, why: '在删东西' },
  /* 【2026-11-10 收窄·原来光见「回收站」就拦，会把"打开回收站看看"也拦掉】
   * 必须是「清空动作 + 回收站」同时出现才算危险。只打开看看不算。 */
  { re: /(清空|清倒|empty|clear|purge)[\s\S]{0,12}(回收站|recycle ?bin|trash)/i, why: '在清空回收站' },
  { re: /(回收站|recycle ?bin|trash)[\s\S]{0,12}(清空|清倒|empty|clear|purge)/i, why: '在清空回收站' },
  /* 第 3 类：确认框语境（确认 + 动作） */
  { re: /(确认|确定|confirm)[\s\S]{0,12}(删除|清空|卸载|delete|remove|erase|uninstall)/i, why: '在等你确认删东西' },
  /* 【2026-11-10 补名词形】`Confirm deletion` 里 delete 后面跟 ion，`\bdelete\b` 匹配不到。
   * 而确认框**最常用的恰恰是名词形态**（比 "Confirm Delete" 更正式）。 */
  { re: /(确认|确定|confirm)[\s\S]{0,16}(deletion|erasure|uninstallation|removal)/i, why: '在等你确认删东西' },
  { re: /(删除|delete|remove|erase)[\s\S]{0,12}(确认|confirm)/i, why: '在等你确认删东西' },
  /* 【2026-11-10 补·确认式问句】`Are you sure you want to delete?` 这种：
   * 动作词在**最后**，跟「确认」隔了二十多个字，上面两条都匹配不到。
   * 而这是 Windows 系统对话框最常见的标题形态。 */
  { re: /\b(are you sure|do you really want to|确认要|确定要)[\s\S]{0,40}(delete|remove|erase|uninstall|删除|清空|卸载)/i, why: '在等你确认删东西' },
  /* 【2026-11-10 补·花钱】原来标题层完全没有花钱规则（只在按钮名表里有） */
  { re: /(确认|确定|confirm)[\s\S]{0,12}(付款|支付|购买|下单|purchase|payment|pay|checkout|order)/i, why: '在等你确认花钱' },
  { re: /\b(confirm|complete|place)[\s\S]{0,16}\b(purchase|payment|order|checkout)\b/i, why: '在等你确认花钱' },
];

/** 第 2 类：这些进程里的删除类菜单是真的会删东西（VS Code / PS / 资源管理器等） */
export const DANGER_APPS = /\b(code|code ?-? insiders|photoshop|illustrator|explorer|totalcmd|7zfm|winrar|everything|filezilla|navicat|sqlyog|heidisql|redis|mongodb)\b/i;

/**
 * 第 2 类「通用软件里的删除菜单」——按钮名的判定。
 *
 * 【2026-11-10 修·两个词误伤过】
 *   `Remove from favorites`（收藏夹）、`Clear Console`（清控制台）都被拦了。
 * 所以跟按钮名表同一个套路：**无歧义的单词直接拦，有歧义的必须带宾语**。
 *   · `Delete` / `Uninstall` / `Erase` / `Wipe` / `Purge` / `Destroy` → 单词就拦
 *   · `Remove` / `Clear` / `Format` / `Reset` → 后面 20 字内得有宾语才拦
 */
export const DANGER_BTN_IN_APP = [
  { re: /\b(delete|erase|uninstall|wipe|purge|destroy)\b/i },
  { re: /\b(remove|clear|format|reset)\b[\s\S]{0,20}\b(file|files|folder|folders|disk|drive|layer|layers|history|all|data|account|project|item|items|selection|objects?)\b/i },
];

/** 这个按钮名在 app 名单里算不算删除动作
 *
 * 【2026-11-10 加·范围限定】只在**已知会删东西的 app** 里才算。
 * 因为 `remove|clear|reset` 这组在普通 app 里太泛 ——
 * 实测 `removeCell`（Excel 删单元格）、`clearField`（清表单）本不该拦。
 */
function isDangerBtnInApp(name) {
  const s = String(name || '');
  if (/\b(delete|erase|uninstall|wipe|purge|destroy)\b/i.test(s)) return true;
  if (/\bremove\b/i.test(s)) return /\b(file|files|folder|folders|layer|layers|history|item|items|selection)\b/i.test(s);
  if (/\bclear\b/i.test(s)) return /\b(all|history|data)\b/i.test(s);
  if (/\bformat\b/i.test(s)) return /\b(disk|drive|volume)\b/i.test(s);
  if (/\breset\b/i.test(s)) return /\b(disk|drive|volume|all|data)\b/i.test(s);
  return false;
}

/**
 * 标题命中危险词就返回 why。
 *
 * 【2026-11-10 改·原来是「动作+对象同时出现」，那个规则漏了最重要的一类】
 *
 * 旧规则要求标题里同时有动作词和对象词。好处是不会误伤文件名（`delete.ts` 没对象词），
 * 坏处是 **「确认删除」这种最该拦的窗口反而放过** —— 它只有动作、没有对象，
 * 而它恰恰是"按下去就真删"的那一步（bug-hunter 抓到的）。
 *
 * 现在靠**动词位置**解决：DANGER_TITLE_WORDS 里第 1 类的正则都以 `^\s*` 开头，
 * 意思是「标题**以**这个动作开头」——系统删除对话框的标题就是「删除」「Delete File」。
 * 而 `delete.ts - Visual Studio Code` 是**文件名开头**但后面跟的是扩展名/编辑器名，
 * 不会以 `delete ` 后面接空白+对象的形式出现…… 这就容易误判。
 *
 * 所以干脆加一条硬排除：**标题里含路径分隔符或常见扩展名 → 当文件名看，不算窗口动作**。
 * 这条比"动作+对象"精确，也比纯 `^` 锚定安全。
 */
function hitTitleDanger(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  /* 看起来像「文件名 - 编辑器名」的标题，不按窗口动作处理。
   * 例：`delete.ts - Visual Studio Code` / `D:\x\remove.py - Code` */
  const looksLikeFilename = /\.(ts|tsx|js|jsx|py|rs|go|java|c|cpp|h|md|json|ya?ml|txt|html|css|log)\b/i.test(s)
    || /[\\/]/.test(s);
  /**
   * 【2026-11-10 加·文档类标题不是操作】
   *
   * `Delete log history - Help` 是**讲怎么删日志的帮助文档**，标题以 Delete 开头。
   * 不加这条就会把整篇帮助文档当成删除对话框 —— 实测就是这么误拦的。
   *
   * ⚠️ **但不能无条件放行**：`Delete File - Security Help` 这种真删除确认框
   * 会顶着「- Help」后缀，无条件放就是漏拦（我第一版就是这么写的，被同事抓出来）。
   * 所以三个条件都要满足才当文档看：
   *   ① 末尾是文档类词  ② 标题里没有安全/警告类词  ③ 标题里没有确认类词
   */
  const _DOC_END = /[-–—]\s*(help|帮助|documentation|文档|手册|guide|wiki|说明)\s*$/i.test(s);
  const _SEC_WORD = /\b(security|warning|alert|danger|critical)\b|安全|警告|危险|重要/i.test(s);
  const _ASK_WORD = /(确认|确定|confirm|are you sure)/i.test(s);
  /**
   * 【2026-11-10 再补·「清空回收站 - 帮助」被文档豁免放过了】
   *
   * 反向用例测出来的（同事提醒的「别为了变绿放宽规则」完全正确）：
   * 标题是「清空回收站 - 帮助」，末尾是「帮助」→ 文档豁免把它放行了。
   * 但「清空回收站」是**明确的不可逆操作**，就算写在帮助文档标题里，
   * 也不该因为一个"- 帮助"后缀就放行 —— 万一用户真在点它呢。
   *
   * 所以加第三条豁免条件：**标题里出现"强不可逆动作短语"时，文档豁免不生效**。
   * 这个词表刻意窄，只放「动词+对象」的完整短语，不放单个动词。
   */
  const _HARD_IRREVERSIBLE = /(清空回收站|清倒回收站|格式化磁盘|格式化硬盘|empty (the )?(trash|recycle ?bin)|format (disk|drive|volume|hard ?drive))/i.test(s);
  /**
   * 【2026-11-10 补·「动作+对象」完整短语出现时，文档豁免一律不生效】
   *
   * 漏洞实测（我自己复现的）：
   *   `Delete File`        → 拦 ✅
   *   `Delete File - Help` → 放 ❌  ← 加个 "- Help" 就绕过了
   *   `删除文件 - 帮助`      → 放 ❌
   *   `卸载程序 - 帮助`      → 放 ❌
   *
   * **这是绕过路径**：任何删除确认框只要标题结尾带「- 帮助」就放行。
   * 而我加文档豁免的初衷是为了 `Delete log history - Help`（讲怎么删日志的文档）——
   * 那类标题的特征是「动作词 + **历史/记录/日志**」，宾语是文档内容，不是真文件。
   *
   * 所以判据改成：**标题里有「动作 + 真对象（文件/文件夹/程序/磁盘）」时，文档豁免失效。**
   * 真文档（讲「怎么删日志」）的宾语是「日志/记录/历史」，不在这个表里，仍然放行。
   */
  /**
   * 【2026-11-10 三修·最后定型，判据是「动作词在标题的什么位置」】
   *
   * 踩过的三种写法（都有实测反例）：
   *   ① 无条件放行文档后缀     → `Delete File - Help` 漏拦（绕过路径）
   *   ② 加 SEC/ASK 排除         → 仍漏 `Delete File - Help`（它没有安全/确认词）
   *   ③ 加「动作+对象」排除      → 又误拦 `Delete log history - Help`（history 被当对象）
   *
   * 真正能分开两类的是**位置**：
   *   · `Delete File - Help`        ← 动作词在**最开头**，宾语紧跟其后 → 这是**操作窗口**
   *   · `Delete log history - Help` ← 动作词开头，但宾语是「log history」，讲的是**这条记录** → 文档
   *   · `Delete User - Help`        ← 动作词开头 + 宾语 User → 操作窗口
   *
   * 所以判据：**如果标题以「动作词 + 单个具体名词」开头（不超过 2 个词），就不当文档看。**
   * 「log history」是两个词 → 更像"关于日志历史"这个主题 → 仍按文档放行。
   */
  /* 英文要空格分词；中文不需要。所以两套分开写。 */
  const _LEAD_VERB_NOUN_EN = /^\s*(?:delete|remove|erase|uninstall|wipe|purge|empty|format)\s+(?:user|users|account|accounts|profile|file|files|folder|folders|program|app|disk|drive|volume|directory)\s*(?:[-–—]|$)/i.test(s);
  const _LEAD_VERB_NOUN_CN = /^\s*(?:删除|移除|卸载|清空|格式化)(?:用户|账号|账户|文件|文件夹|程序|目录|磁盘|全部)/.test(s);
  if (_DOC_END && !_SEC_WORD && !_ASK_WORD && !_HARD_IRREVERSIBLE && !_LEAD_VERB_NOUN_EN && !_LEAD_VERB_NOUN_CN) return null;
  for (const d of DANGER_TITLE_WORDS) {
    /* 第 1 类（系统动作）要求**标题以动作开头**；文件名类标题跳过这一层 */
    const m = d.re.exec(s);
    if (!m) continue;
    if (d.re.source.startsWith('^') && looksLikeFilename) continue;
    return { why: d.why };
  }
  return null;
}

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
 * 英文按钮名判定 —— `DANGER_BTN_EN` 的执行者。
 *
 * 【2026-11-10 补·这张表加了却忘了写消费函数】
 *
 * 我往文件里加了 `DANGER_BTN_EN` 常量，判定处写了 `hitDangerEnBtn(name)`，
 * **但没实现这个函数** → 一调 `checkGuard` 就 `ReferenceError`。
 * 后果比原来严重得多：原来只是"英文按钮不拦"，现在是"操作桌面整个崩"。
 * bug-hunter 抓到我时，代码正处于这个状态（他把守卫弄崩了）。
 *
 * 教训：**加规则/加字段/加函数必须三件一起写完再跑**，不能改一半去做别的。
 */
function hitDangerEnBtn(name) {
  const s = String(name || '');
  for (const d of DANGER_BTN_EN) {
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

  // 密码框：打字一律拒（只判断它「是不是」密码框，绝不读取框里的内容）
  const role = String(el?.role || '');
  const name = String(el?.name || '');
  const looksSecret = el?.password === true || (tool === 'ui_type' && PASSWORD_ROLE_HINT.test(role + ' ' + name));
  if (looksSecret && tool === 'ui_type') {
    return { ok: false, reason: '这是一个密码框：密码、密钥这种东西必须主人自己输，我不代打。' };
  }

  // 危险词：要看主人点头
  /**
   * 【2026-11-10 改·两个维度都要看，不只控件名】
   *
   * 原来只 `hitDanger(name)` —— 只看"被点的控件叫什么"。
   * 而真实危险常常在窗口上：窗口「Delete File」里按钮就叫「OK」，控件名干净，点了照样删。
   * 所以先查**窗口标题**（容器危险 → 里面的按钮都危险），再查控件名。
   *
   * 顺序有讲究：标题命中就早早返回，理由写清是"这个窗口在干掉东西"，
   * 比"要点的是「OK」"有用得多 —— 主人要知道他点的是哪个窗口。
   */
  const _snapObj = snap || s || {};
  /**
   * 【2026-11-10 修·拼了 app 名进去，害得 `$` 锚点的规则全失效】
   *
   * 原来是 `hitTitleDanger(title + ' ' + app)`。两个后果：
   *   · 「文档类标题」那条用 `$` 锚定结尾（`- Help$`），拼上 app 之后永远匹配不到
   *   · 「标题以动作开头」那条 `^\s*` 也一样，前面多了东西才怪（这条还好，app 在后面）
   * 我写的时候只想着「让 app 名也能触发危险词」，忘了 `$` 锚定的规则会被破坏。
   *
   * 现在**只传标题**。app 名走下面单独的 `DANGER_APPS` 判定（第 2 类），职责分开。
   */
  const _titleHit = hitTitleDanger(String(_snapObj.title || ''));
  /* 【第 2 类】通用软件的删除菜单：标题是文件名、app 才是线索。
   * 只在点名的那几个 app 里生效，所以按钮名可以放宽到单词（见 DANGER_BTN_IN_APP 的注释）。 */
  const _appHit = DANGER_APPS.test(String(_snapObj.app || '') + ' ' + String(_snapObj.title || ''))
    && isDangerBtnInApp(String(name || ''))
    && (tool === 'ui_click' || tool === 'ui_double_click' || tool === 'ui_right_click');
  /**
   * 【2026-11-10 修·这里原来拼出「在是删东西的菜单」这种病句】
   *
   * 第 2 类（app 菜单）的 why 我写成了「是删东西的菜单」，而下面拼的是 `在${why}`
   * → 「在是删东西的菜单」。第 1/3 类的 why 是「在删东西」「在等你确认删东西」，
   * 拼出来就对（下面会 replace 掉开头的"在"）。
   *
   * 根因不是拼接，是**两类 why 的语法形态不统一**。所以统一成「动词短语」，
   * 拼接一律用 `在${why}`：删东西 / 等你确认删东西 / 删菜单里的东西。
   */
  const _hit = _titleHit || (_appHit ? { why: '删菜单里的东西' } : null);
  if (_hit && (tool === 'ui_click' || tool === 'ui_double_click' || tool === 'ui_right_click' || tool === 'ui_key')) {
    /**
     * 【2026-11-10 修·这段话原来有个语病，是拼接造成的】
     *
     * 原来写的是：
     *   `现在这个窗口（${title}）是${_titleHit.why}的，…`
     * 而 why 本身就是「在干掉东西」这种**带谓语的短语**，拼出来是：
     *   「现在这个窗口（Delete File）是在干掉东西的，…」
     * —— "是在干掉东西的"读着别扭，而且"是…的"把动作说成了状态。
     *
     * 另外 `title` 为空时（有些窗口拿不到标题）会变成「现在这个窗口（）是…」，
     * 括号里空着。两处一起修：why 去掉"是…的"结构，标题空了就用应用名、再空就整句换说法。
     */
    const _who = String(_snapObj.title || '').trim() || String(_snapObj.app || '').trim();
    const _why = String(_hit.why || '').replace(/^在/, '');
    return {
      ok: false,
      needAsk: true,
      reason: (_who ? `这个窗口（${_who}）` : '这个窗口')
        + `在${_why}，里面的按钮点了收不回来。你确认要我动它吗？`,
    };
  }
  if (tool === 'ui_click' || tool === 'ui_double_click' || tool === 'ui_right_click') {
    /* 中文危险词（原有） */
    const d = hitDanger(name);
    if (d) return { ok: false, needAsk: true, reason: `要点的是「${d.word}」（${d.why}）` };
    /**
     * 【2026-11-10 修·`DANGER_BTN_EN` 定义了却从没被调用过】
     *
     * 我加这张表是为了补「英文按钮零拦截」，但**忘了在判定处接上** ——
     * 结果它在文件里躺着，`Delete` 按钮照样放过（bug-hunter 的用例 11 抓到的）。
     * 这种"加了规则但没接线"跟当初 `askApproval` 没注入是同一类错，都是静默失效。
     *
     * 现在接上。注意它的判定哲学跟中文表不同（见 DANGER_BTN_EN 注释）：
     *   · 无歧义单词（Delete/Uninstall/Erase/Wipe/Purge/Destroy）→ 直接拦
     *   · 有歧义词（Remove/Clear/Format/Reset）→ **必须带宾语**才拦
     *     （所以「Format Document」「Remove from favorites」「Clear Console」不会误伤）
     */
    const e = hitDangerEnBtn(name);
    if (e) return { ok: false, needAsk: true, reason: `要点的是「${e.word}」（${e.why}）` };
  }
  if (tool === 'ui_key') {
    const d = hitDanger(text);
    if (d) return { ok: false, needAsk: true, reason: `要按的键组合里有「${d.word}」（${d.why}）` };
    /**
     * 【2026-11-10 补·键位里的英文原来完全没拦】
     *
     * `hitDanger` 只认中文（那张表故意不加英文，见它上面那段注释）。
     * 但**键位不是按钮名**：`Delete` 键、`Ctrl+Delete`、`Shift+Delete`（永久删除）、
     * `Ctrl+Backspace`（删整词）—— 这些没有"第二个意思"，按下去就是删。
     * 实测 `Ctrl+Delete` / `Shift+Delete` / `Ctrl+Backspace` 三个全部放过。
     *
     * 所以键位单独用 `DANGER_KEYS_EN` 判断，不受按钮名那条"避免误伤"的约束。
     */
    if (DANGER_KEYS_EN.test(String(text || ''))) {
      return { ok: false, needAsk: true, reason: `要按的键里有「Delete / Backspace」（会删东西）` };
    }
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
