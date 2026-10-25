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

export const browserTools = [
  {
    name: 'browser_open',
    description:
      '打开内置浏览器看一个网页（我自己的眼睛，主人看不见这个窗口）。给个网址就行，能截图看页面长什么样。只支持 http / https。',
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
