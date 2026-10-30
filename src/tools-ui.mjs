/**
 * 「操作桌面」的工具面 —— 让小鱼真的能看和点（2026-11-03）。
 *
 * 【设计取向：只开最小一组】
 * dsh-computer-use 有 12 个工具（含 zoom / wait / drag / app_launch）。
 * 这里先只开 6 个：看、点、双击、右键、打字、按键。
 * 少了的那几个不是做不出来，是**多了会让模型乱试** ——
 * 工具越花，她越容易「先试试这个试试那个」，而每一个试都要打断主人。
 * 等真的缺了再加。
 *
 * 【安全不是靠嘱咐，是靠这三条】
 *   1. 没观察过不许动（ui-guard 的 resolveElement）
 *   2. 观察过期不许动（默认 30 秒）
 *   3. 危险词/密码框要拦（ui-guard 的 checkGuard）
 * 这三条都在工具入口里，不写在提示词里 —— 提示词是劝，代码是拦。
 */
import { listWindows, readWindow, windowText } from './ui-tree.mjs';
import {
  setSnapshot, resolveElement, resolveWindow, checkGuard, askApproval,
  ACT_TOOLS, dangerOnScreen,
} from './ui-guard.mjs';
import { clickAt, typeText, sendKeys, scrollAt, bringToFront } from './ui-input.mjs';
import { getSettings } from './settings.mjs';

/**
 * 「操作桌面」的白名单（设置里那一格）。
 *
 * 【为什么不在 CTX 里】
 * CTX 是「这一次调用的上下文」，白名单是「主人的长期设置」，放一起会
 * 变成「忘了传就变成全放开/全锁死」。这里每次现读，读不到就当没设。
 */
function uiAllowList() {
  try {
    const st = getSettings() || {};
    const raw = st.uiAllowedApps ?? st.uiAllowed;
    if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter(Boolean);
    if (typeof raw === 'string') return raw.split(new RegExp('[,，\\n]')).map((x) => x.trim()).filter(Boolean);
  } catch { /* 读不到就当没设 */ }
  return [];
}


/** 观察有效期。30 秒是 dsh-computer-use 的默认值，够慢的模型反应，又不会拿十分钟前的编号点。 */
const TTL_MS = 30000;

function pickWindowText(o, w) {
  const head = o.app ? `【${w.app}】${w.title}` : w.title;
  const line = `窗口句柄 ${w.hwnd}　${w.w}×${w.hh}　${w.front ? '（现在在最前面）' : ''}`.trim();
  return `${head}\n${line}`;
}

function windowLine(w, idx) {
  const mark = w.front ? ' ← 在最前面' : '';
  return `${idx + 1}. ${w.title}　${w.app}　${w.w}×${w.hh}　hwnd=${w.hwnd}${mark}`;
}

/**
 * ui_observe：看一眼现在有什么窗口 / 某个窗口里有什么能点。
 *
 * 两种情况：
 *   不传 hwnd → 列窗口，让她挑一个
 *   传 hwnd   → 读那个窗口的控件树，编号 + 坐标 + 截图一起回来
 */
export const uiObserve = {
  schema: {
    type: 'function',
    function: {
      name: 'ui_observe',
      description:
        '看桌面：不传 hwnd 就列出所有能看见的窗口；传 hwnd 就把那个窗口里所有能点的东西编号列出来（带坐标和截图）。'
        + '**动手之前必须先用它看一次** —— 编号只在 30 秒内有效，界面一变就要重看。'
        + '它不会动鼠标、不会切窗口，纯看。',
      parameters: {
        type: 'object',
        properties: {
          hwnd: { type: 'integer', description: '要仔细看哪个窗口（不传就先列所有窗口，里面能查到 hwnd）' },
          why: { type: 'string', description: '为什么看（写一句，方便事后回看）' },
          maxElements: { type: 'integer', description: '最多列多少个元素，默认 200' },
        },
      },
    },
  },
  async run(args) {
    const hwnd = Number(args?.hwnd) || 0;
    if (!hwnd) {
      const list = await listWindows();
      if (!list.length) return { text: '一个窗口也没看见 —— 桌面是空的？' };
      const body = list.map(windowLine).join('\n');
      return {
        text:
          `现在桌面上一共 ${list.length} 个窗口：\n${body}\n\n`
          + '要看哪一个，就调 ui_observe 并把 hwnd 传进来。',
      };
    }

    const maxElements = Math.max(20, Math.min(500, Number(args?.maxElements) || 200));
    const r = await readWindow({ hwnd, maxElements, tag: String(args?.why || '').slice(0, 40) });
    if (!r.ok) return { text: '这个窗口读不出来：' + (r.error || '未知原因') };

    setSnapshot({
      id: r.id,
      ttlMs: TTL_MS,
      hwnd: r.meta.hwnd,
      pid: r.meta.pid,
      title: r.meta.title,
      app: r.meta.app,
      win: r.meta.win,
      png: r.meta.png,
      elements: r.elements,
    });

    const actable = r.elements.filter((e) => e.act !== false);
    const lines = r.elements.map((e) => {
      const tail = e.value ? `　值="${e.value}"` : '';
      return `${e.act === false ? ' ' : '['}${e.act === false ? '·' : e.i}${e.act === false ? '' : ']'} ${e.role} "${e.name}" @(${e.x},${e.y})${tail}`;
    });

    let danger = [];
    try { danger = await dangerOnScreen(hwnd); } catch { danger = []; }
    const dangerLine = danger.length
      ? `\n\n⚠ 这个窗口上有看着危险的字眼：${danger.map((d) => `「${d.text}」（${d.why}）`).join('、')} —— 点它们之前我会先问你。`
      : '';

    const text =
      `${pickWindowText(r.meta, r.meta)}\n`
      + `能点的 ${actable.length} 个（树里一共 ${r.meta.total} 个控件）　快照 ${r.id}\n\n`
      + (lines.length ? lines.join('\n') : '这个窗口里没读到可点的控件。')
      + `\n\n要动哪个就说编号，比如点 [3]。编号 ${Math.round(TTL_MS / 1000)} 秒内有效，过了要重看。`
      + dangerLine;

    const out = { text };
    if (r.hasPng) out.images = [r.meta.png];
    return out;
  },
};

/**
 * 动作工具的公共壳：先护栏、再问主人、再动手。
 *
 * 顺序不能换 —— 先问再拦就等于「问了但已经拦住了」，先拦再问才是「不该问的别烦主人」。
 */
function actionTool({ name, desc, params, needsElement = true, impl }) {
  return {
    schema: {
      type: 'function',
      function: { name, description: desc, parameters: { type: 'object', properties: params } },
    },
    async run(args, ctx) {
      const snap = (() => {
        try { return needsElement ? resolveElement(args?.element, TTL_MS).snap : resolveWindow(TTL_MS); } catch (e) {
          return { error: e.message };
        }
      })();
      if (snap.error) return { text: '✗ ' + snap.error };

      const el = needsElement ? resolveElement(args.element, TTL_MS).el : null;
      const g = checkGuard({ tool: name, el, text: args?.keys ?? args?.text, cfg: { allowedApps: uiAllowList() }, snap });
      if (!g.ok) {
        if (!g.needAsk) return { text: '✗ ' + g.reason };
        const yes = await askApproval({ exec: ctx, toolName: name, reason: g.reason });
        if (!yes) return { text: '没动：' + g.reason + '。主人没有点头，就先不动。' };
      }

      try {
        return await impl({ args, el, snap });
      } catch (e) {
        return { text: '✗ 没做成：' + (e?.message || e) };
      }
    },
  };
}

/** 统一的「要哪个元素」参数说明。 */
const ELEMENT_PARAM = {
  type: 'object',
  properties: {
    element: { type: 'integer', description: 'ui_observe 结果里的编号（方括号里那个数）' },
    why: { type: 'string', description: '为什么点它（一句话）' },
  },
  required: ['element'],
};

export const uiClick = actionTool({
  name: 'ui_click',
  desc: '点一下界面上第 [N] 号控件。默认「投」一次点击进那个窗口 —— 不抢你的焦点、不动真鼠标，所以你在别处打字也不受影响。'
    + '要是某个程序不认「投」进来的点击（Chromium 系偶尔这样），再调一次并传 mode:"send"（这个会真动鼠标、会抢焦点）。',
  params: { ...ELEMENT_PARAM.properties, mode: { type: 'string', enum: ['post', 'send'], description: '怎么发，默认 post（不打扰你）' } },
  impl: async ({ args, el, snap }) => {
    const r = await clickAt({ hwnd: snap.hwnd, x: el.x, y: el.y, mode: args?.mode });
    const target = `[${el.i}] ${el.role} "${el.name}"`;
    return {
      text: r.ok
        ? `点过了：${target}。${r.note}。界面可能已经变了 —— 要接着动就先 ui_observe 重看一次。`
        : `✗ 点 ${target} 没成功（${r.note}）。有些程序不认投进去的点击，可以试 mode:"send"。`,
    };
  },
});

export const uiDoubleClick = actionTool({
  name: 'ui_double_click',
  desc: '双击第 [N] 号控件（打开文件、选中词之类）。同样默认投进去，不抢焦点。',
  params: { ...ELEMENT_PARAM.properties, mode: { type: 'string', enum: ['post', 'send'] } },
  impl: async ({ args, el, snap }) => {
    const r = await clickAt({ hwnd: snap.hwnd, x: el.x, y: el.y, count: 2, mode: args?.mode });
    const target = `[${el.i}] ${el.role} "${el.name}"`;
    return { text: r.ok ? `双击了 ${target}。${r.note}。` : `✗ 双击 ${target} 没成功（${r.note}）。` };
  },
});

export const uiRightClick = actionTool({
  name: 'ui_right_click',
  desc: '在第 [N] 号控件上点右键（叫出右键菜单）。点完菜单会弹出来，记得重新 ui_observe 看新出来的项。',
  params: { ...ELEMENT_PARAM.properties, mode: { type: 'string', enum: ['post', 'send'] } },
  impl: async ({ args, el, snap }) => {
    const r = await clickAt({ hwnd: snap.hwnd, x: el.x, y: el.y, button: 'right', mode: args?.mode });
    const target = `[${el.i}] ${el.role} "${el.name}"`;
    return { text: r.ok ? `右键点了 ${target}。${r.note}。菜单应该出来了，重看一次再选。` : `✗ 右键 ${target} 没成功（${r.note}）。` };
  },
});

export const uiType = actionTool({
  name: 'ui_type',
  desc: '往第 [N] 号控件里打字（中文也行）。会先把那个窗口拉到前面再打 —— 键盘没办法「投」进后台窗口。'
    + '密码框我不代打，会直接拒。',
  params: {
    element: { type: 'integer', description: '要打字的输入框编号（先点它一下更稳，直接打也行）' },
    text: { type: 'string', description: '要打的字' },
    why: { type: 'string', description: '为什么打（一句话）' },
  },
  impl: async ({ args, el, snap }) => {
    const text = String(args?.text ?? '');
    if (!text) return { text: '✗ 没有要打的字。' };
    await bringToFront(snap.hwnd);
    // 先点一下目标，确保光标在那儿
    await clickAt({ hwnd: snap.hwnd, x: el.x, y: el.y, mode: 'send' });
    const r = await typeText({ text });
    return { text: r.ok ? `打进去了：${r.note}（打在 [${el.i}] ${el.role} "${el.name}" 上）。` : `✗ 打字没成功：${r.note}` };
  },
});

export const uiKey = actionTool({
  name: 'ui_key',
  desc: '按一组键：enter、tab、esc、方向键、f1-f12，组合键写成 ctrl+s / ctrl+shift+s / alt+F4。'
    + '必须那个窗口在前台 —— 会先把它拉到前面。',
  params: {
    element: { type: 'integer', description: '（可选）按之前先点这个编号，让焦点落在对的地方' },
    keys: { type: 'string', description: '要按的键，比如 enter、ctrl+c、alt+tab' },
    why: { type: 'string', description: '为什么按（一句话）' },
  },
  needsElement: false,
  impl: async ({ args, snap }) => {
    const keys = String(args?.keys || '').trim();
    if (!keys) return { text: '✗ 要先说要按什么键。' };
    await bringToFront(snap.hwnd);
    const r = await sendKeys({ keys });
    return { text: r.ok ? `按了 ${keys}。${r.note}` : `✗ 按键没成功：${r.note}` };
  },
});

export const uiScroll = actionTool({
  name: 'ui_scroll',
  desc: '滚一下第 [N] 号控件所在的窗口。notches 负数是往上滚（看前面的内容），正数往下。'
    + '默认投进窗口不动真鼠标；不认的话传 mode:"send"。',
  params: {
    ...ELEMENT_PARAM.properties,
    notches: { type: 'integer', description: '滚几格，默认 -3（往上三格）' },
    mode: { type: 'string', enum: ['post', 'send'] },
  },
  impl: async ({ args, el, snap }) => {
    const r = await scrollAt({ hwnd: snap.hwnd, x: el.x, y: el.y, notches: args?.notches, mode: args?.mode });
    return { text: r.ok ? `${r.note}。要接着看就重新 ui_observe。` : `✗ 滚轮没生效：${r.note}` };
  },
});

export const uiTools = [uiObserve, uiClick, uiDoubleClick, uiRightClick, uiType, uiKey, uiScroll];

/**
 * 摊进 tools.mjs 数组的那一份。
 *
 * tools.mjs 里别的工具都是 `{ name, description, parameters, run }` 这个扁平形状，
 * `toolSchemas` 那一步再包成 `{type, function}` 交给模型；而 `runTool` 是按名字
 * 去数组里找 `t.run`。所以这里必须**带上 run**。
 *
 * 【踩过的坑（2026-11-03）】
 * 原来这里写的是 `uiTools.map((t) => t.schema.function)` —— 只取了 schema 那层，
 * run 被丢了。结果是：7 个 ui_* 工具在模型眼里列得好好的，真调用时
 * `runTool` 报 `tool.run is not a function`，一个字都点不出去。
 * 注释里还写了句「真正的执行走 registerToolRunners」—— 那个函数压根不存在，是我编的。
 * 教训：**注释里说的机制，代码里得真能搜到**，不然就是自欺。
 */
export const uiToolDefs = uiTools.map((t) => ({
  name: t.schema.function.name,
  description: t.schema.function.description,
  parameters: t.schema.function.parameters,
  run: t.run,
}));

/** 给界面用的：这套工具的名字（功能面板里要列）。 */
export const UI_TOOL_NAMES = uiTools.map((t) => t.schema.function.name);
