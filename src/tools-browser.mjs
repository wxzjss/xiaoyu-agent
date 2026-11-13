/**
 * 小鱼的内置浏览器工具（我自己的眼睛，不是给人点的按钮）。
 *
 * 【挂在哪儿】主进程 electron/main.cjs 在加载服务端之前，会把浏览器通道挂到
 * globalThis.__xiaoyuBrowser 上。服务端跟主进程是同一个进程（8788 端口归
 * 小鱼Agent.exe 自己），所以这里直接取 globalThis 就能用。
 *
 * 【拿不到就老实说】通道没有（纯 node 跑服务端、手机上、浏览器直开），
 * 这几个工具就返回「这台机器上没开浏览器」，绝不假装看过。
 */

/** 取通道；没有就返回 null */
function channel() {
  const c = globalThis.__xiaoyuBrowser;
  if (!c || typeof c.open !== 'function') return null;
  return c;
}

const NO_CHANNEL = '这台环境里没有可用的浏览器窗口（只有从桌面图标打开的小鱼Agent才有）。别假装看过页面。';

const browserToolsExtra = [
  {
    name: 'browser_eval',
    description:
      '在内置浏览器当前页面里执行一段 JS，返回结果。用来读 DOM、抓页面变量、钩 fetch。'
      + '支持 async。页面没开着会报错。',
    parameters: {
      type: 'object',
      properties: {
        js: {
          type: 'string',
          description: '要执行的 JS。最后一行的值会返回，如 document.title，或 await fetch("/api/x").then(r=>r.text())',
        },
      },
      required: ['js'],
    },
    async run({ js }) {
      const c = channel();
      if (!c) return NO_CHANNEL;
      if (!c.eval) return '这个版本的主进程没有 eval 通道，要更新小鱼Agent。';
      const r = await c.eval(js);
      if (!r || r.ok === false) return '执行失败：' + ((r && r.error) || '不知道为啥');
      const out = r.result === undefined ? '(undefined)' : typeof r.result === 'string' ? r.result : JSON.stringify(r.result);
      return String(out).slice(0, 12000);
    },
  },
  {
    name: 'browser_cookies',
    description: '读内置浏览器当前站点的 cookie。登录排错、确认凭据在不在用。',
    parameters: { type: 'object', properties: {} },
    async run() {
      const c = channel();
      if (!c) return NO_CHANNEL;
      if (!c.cookies) return '这个版本的主进程没有 cookies 通道，要更新小鱼Agent。';
      const r = await c.cookies();
      if (!r || r.ok === false) return '读不到：' + ((r && r.error) || '不知道为啥');
      if (!r.cookies || !r.cookies.length) return '当前站点没有 cookie。';
      return r.cookies.map((k) => k.name + ' = ' + String(k.value).slice(0, 80)).join('\n').slice(0, 8000);
    },
  },
  {
    name: 'browser_setcookie',
    description: '给内置浏览器的会话写一条 cookie（name、value、url 必填）。有些站要带凭据才能进时用。',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'cookie 名' },
        value: { type: 'string', description: 'cookie 值' },
        url: { type: 'string', description: '归属网址，如 https://chat.deepseek.com' },
        domain: { type: 'string' },
        path: { type: 'string' },
        secure: { type: 'boolean' },
        httpOnly: { type: 'boolean' },
      },
      required: ['name', 'value', 'url'],
    },
    async run(args) {
      const c = channel();
      if (!c) return NO_CHANNEL;
      if (!c.setCookie) return '这个版本的主进程没有 setCookie 通道，要更新小鱼Agent。';
      const r = await c.setCookie(args);
      if (!r || r.ok === false) return '没写进去：' + ((r && r.error) || '不知道为啥');
      return '写好了：' + args.name + ' → ' + args.url;
    },
  },
  {
    name: 'browser_network',
    description:
      '看内置浏览器页面发了什么网络请求、收了什么响应（方法、URL、状态码、错误）。'
      + '排接口报错、找页面真实调用的 API、看有没有被风控拦截时用。',
    parameters: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '按 URL 过滤（不区分大小写），如 "login"' },
        limit: { type: 'number', description: '最多几条，默认 30，最新在前' },
        body: { type: 'boolean', description: 'true 时附带最近一条响应的正文（截断）' },
      },
    },
    async run(args = {}) {
      const c = channel();
      if (!c) return NO_CHANNEL;
      if (!c.network) return '这个版本的主进程没有 network 通道，要更新小鱼Agent。';
      const r = await c.network(args);
      if (!r || r.ok === false) return '读不到：' + ((r && r.error) || '不知道为啥');
      const rows = (r.entries || []).map((e) => {
        const t = new Date(e.ts).toTimeString().slice(0, 8);
        const base = t + ' ' + (e.method || '') + ' ' + e.url + ' → ' + (e.phase === 'response' ? ('HTTP ' + e.status) : (e.error || e.phase));
        if (e.bodySnippet) return base + '\n  正文: ' + e.bodySnippet;
        return base;
      });
      return rows.length ? rows.join('\n').slice(0, 12000) : '这段时间页面没有网络请求记录。';
    },
  },
  {
    name: 'browser_click',
    description: '点内置浏览器页面里的一个元素。给 CSS 选择器（如 "#login-btn"）。会先滚动到中间再点。',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS 选择器' } },
      required: ['selector'],
    },
    async run({ selector }) {
      const c = channel();
      if (!c) return NO_CHANNEL;
      if (!c.click) return '这个版本的主进程没有 click 通道，要更新小鱼Agent。';
      const r = await c.click(selector);
      if (!r || r.ok === false) return '没点着：' + ((r && r.error) || '不知道为啥');
      return '点好了：' + selector;
    },
  },
  {
    name: 'browser_type',
    description: '往内置浏览器页面的输入框里填字。给 CSS 选择器和文本；会派发 input/change 事件，Vue/React 表单也听得到。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '输入框的 CSS 选择器' },
        text: { type: 'string', description: '要填的内容' },
      },
      required: ['selector', 'text'],
    },
    async run({ selector, text }) {
      const c = channel();
      if (!c) return NO_CHANNEL;
      if (!c.type) return '这个版本的主进程没有 type 通道，要更新小鱼Agent。';
      const r = await c.type(selector, text);
      if (!r || r.ok === false) return '没填进去：' + ((r && r.error) || '不知道为啥');
      return '填好了：' + selector;
    },
  },
  {
    name: 'browser_wait',
    description: '等内置浏览器页面到达某条件：元素出现（selector）或 URL 变化（urlIncludes）。最多等 60 秒。跳转/登录后确认结果用。',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '等这个 CSS 选择器出现' },
        urlIncludes: { type: 'string', description: '等 URL 包含这段字' },
        timeout: { type: 'number', description: '最多等几毫秒，默认 10000' },
      },
    },
    async run(args = {}) {
      const c = channel();
      if (!c) return NO_CHANNEL;
      if (!c.wait) return '这个版本的主进程没有 wait 通道，要更新小鱼Agent。';
      const r = await c.wait(args);
      if (!r || r.ok === false) return '没等到：' + ((r && r.error) || '超时');
      return '等到了：' + (r.url || '');
    },
  },
  {
    name: 'browser_read',
    description: '读内置浏览器页面里的文字：整页正文或某个元素里的文字（最多 8000 字）。截图里小字看不清、要精确读内容时用它。',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: '只读这个元素；不给读整页' } },
    },
    async run(args = {}) {
      const c = channel();
      if (!c) return NO_CHANNEL;
      if (!c.read) return '这个版本的主进程没有 read 通道，要更新小鱼Agent。';
      const r = await c.read(args);
      if (!r || r.ok === false) return '读不到：' + ((r && r.error) || '不知道为啥');
      return (r.text || '').slice(0, 8000);
    },
  },
];

const browserTools = [...browserToolsExtra,
  {
    name: 'browser_open',
    description:
      '打开内置浏览器看一个网页。**这会真的在主人屏幕上弹出一个窗口**（1180×820，标题「内置浏览器」，'
      + '开着就一直留在那儿，再调一次会复用同一个窗口跳转）。所以动手前说一句「我开个浏览器看下」，'
      + '别一声不吭就甩一个窗口到他眼前。给个网址就行，能截图看页面长什么样。只支持 http / https。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网址，例如 https://example.com' },
      },
      required: ['url'],
    },
    async run({ url }) {
      const c = channel();
      if (!c) return NO_CHANNEL;
      const r = await c.open(url);
      if (!r || r.ok === false) return '没打开：' + ((r && r.error) || '不知道为啥');
      return '开好了：' + (r.url || url) + (r.reused ? '（复用了已经开着的那个窗口）' : '');
    },
  },
  {
    name: 'browser_goto',
    description: '让已经开着的浏览器跳到另一个网址。没开着就会顺手开一个。',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要跳去的网址' } },
      required: ['url'],
    },
    async run({ url }) {
      const c = channel();
      if (!c) return NO_CHANNEL;
      const r = await c.goto(url);
      if (!r || r.ok === false) return '跳不过去：' + ((r && r.error) || '不知道为啥');
      return '跳好了：' + (r.url || url);
    },
  },
  {
    name: 'browser_snap',
    description:
      '给现在开着的网页截一张图，返回图片路径。想「看看这个页面长什么样」的时候用它，比读 HTML 直观。',
    parameters: { type: 'object', properties: {} },
    async run() {
      const c = channel();
      if (!c) return NO_CHANNEL;
      const r = await c.snap();
      if (!r || r.ok === false) return '没截到：' + ((r && r.error) || '不知道为啥');
      return '截好了：' + r.file + '\n当前页：' + (r.url || '') + (r.title ? '（' + r.title + '）' : '');
    },
  },
  {
    name: 'browser_state',
    description: '看看浏览器现在开着没、在哪个网址、能不能后退。不确定的时候先问一句。',
    parameters: { type: 'object', properties: {} },
    async run() {
      const c = channel();
      if (!c) return NO_CHANNEL;
      const st = await c.state();
      if (!st || !st.open) return '浏览器没开着。用 browser_open 开一个。';
      return '开着：' + (st.title || '(无标题)') + '\n地址：' + (st.url || '') +
        '\n能后退：' + (st.canGoBack ? '是' : '否') + '，能前进：' + (st.canGoForward ? '是' : '否');
    },
  },
];

export { browserTools, browserToolsExtra };
