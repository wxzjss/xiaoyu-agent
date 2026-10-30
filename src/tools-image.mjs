/**
 * 「画图」这一个工具。拆出来单独放，跟 tools-sendfile.mjs 一个道理：
 * tools.mjs 已经很长了，一次能读的量有限。
 *
 * 两件事：真去出图、把图登记进 CTX.outbox（主人那边就长出图片卡片）。
 * 出图慢（30~40 秒），所以这里不设很短的超时 —— 半路掐死比慢更让人难受。
 */
import { generateImage, imageEndpoint } from './gen-image.mjs';
import { normalizeSend, fmtSize, publicEntry, stash } from './outbox.mjs';
import { ctxNow, stashFileNow } from './tools.mjs';

export const makeImageTool = {
  name: 'make_image',
  description:
    '画一张图给主人看。prompt 写清楚要画什么（主体、风格、颜色、构图），越具体越像。' +
    '出图要等 30~40 秒，别催；画好之后聊天里会直接出现这张图。' +
    '一次只画一张。要改细节就再画一张，把上次不满意的地方写进 prompt。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '画什么。中文英文都行，写具体一点。' },
      size: { type: 'string', description: '尺寸建议，默认 1024x1024。上游可能自己给 1254x1254，那也算正常。' },
      note: { type: 'string', description: '一句话说明这张是干嘛的（可选）' },
    },
    required: ['prompt'],
  },
  async run({ prompt, size, note }, ctx = {}) {
    const ep = imageEndpoint();
    if (!ep) {
      return '还没有能出图的模型。让主人在右上角模型面板里加一条，把「这条拿来干嘛」选成「出图」—— 加了之后我才能画。';
    }
    const r = await generateImage({ prompt, size, prefix: 'draw' });
    if (!r.ok) return '没画成：' + r.error;

    // 交到主人手上：走 send_file 那条路（登记 outbox，聊天里长卡片）
    const box = Array.isArray(ctx.outbox) ? ctx.outbox : null;
    const sent = normalizeSend(r.path);
    let card = '';
    if (sent.entry) {
      sent.entry.key = stash(sent.entry);
      if (box) box.push(publicEntry(sent.entry));
      try { stashFileNow(publicEntry(sent.entry)); } catch {}
      /* 【2026-10-30】画好的图当场推给界面 —— 以前只塞 outbox，要等我这一轮全说完才画出来。
       * 主人原话：「没有当场出来图片，估计得等你说完一轮才行」。 */
      try {
        const push = ctxNow().pushEvent;
        if (typeof push === 'function') push({ type: 'sentfile', file: publicEntry(sent.entry), note: String(note || '').trim() });
      } catch {}
      card = `\n（${sent.entry.name}，${fmtSize(sent.entry.size)}，在这里点开就能看）`;
    }
    const said = String(note || '').trim();
    const secs = Math.round((r.ms || 0) / 1000);
    const dim = r.width && r.height ? `，${r.width}×${r.height}` : '';
    const revised = r.revised && String(r.revised).trim() && String(r.revised).trim() !== String(prompt).trim()
      ? `\n上游把你的意思改写成：${String(r.revised).slice(0, 200)}`
      : '';
    return `画好了，用了 ${secs} 秒${dim}。${card}${revised}${said ? '\n（' + said + '）' : ''}`;
  },
};
