/**
 * 「画图」这一个工具。拆出来单独放，跟 tools-sendfile.mjs 一个道理：
 * tools.mjs 已经很长了，一次能读的量有限。
 *
 * 两件事：真去出图、把图登记进 CTX.outbox（主人那边就长出图片卡片）。
 *
 * 【2026-11-15 改成代码画图】
 * 以前这条路只有一条出口：一条标成「出图」的模型。没配模型的机器上这档就是空的，
 * 主人点了也没反应。现在默认走 code-draw.mjs：本地排版 SVG + 本机浏览器无头截一张 PNG，
 * 零依赖、不联网、不花钱，秒级出图。
 * 原来的出图模型没删，留成第二条路：代码画图失手了、或者主人点名要模型，才走它。
 *
 * 【注意】这里不许在模块顶层调 code-draw 的函数 —— tools.mjs 和本文件互相 import，
 * 顶层就去碰对方的导出会撞上「before initialization」。所以清单是惰性的，用到才算。
 */
import { generateImage, imageEndpoint } from './gen-image.mjs';
import { drawByCode, codeDrawSummary } from './code-draw.mjs';
import { normalizeSend, fmtSize, publicEntry, stash } from './outbox.mjs';
import { ctxNow, stashFileNow } from './tools.mjs';

let _sum = null;
function sum() {
  if (!_sum) {
    try {
      _sum = codeDrawSummary();
    } catch {
      _sum = { templates: [], palettes: [], browser: 'unknown' };
    }
  }
  return _sum;
}
const idList = (arr) => arr.map((x) => `${x.id}（${x.label}）`).join('、');

export const makeImageTool = {
  name: 'make_image',
  description:
    '画一张图给主人看。prompt 写清楚要画什么（主体、风格、颜色、构图），越具体越像。' +
    '默认用代码画（本地排版 + 截一张 PNG），几秒就出来，不要模型、不花钱、不联网。' +
    '画好之后聊天里会直接出现这张图。一次只画一张。' +
    '要改细节就再画一张，把上次不满意的地方写进 prompt。' +
    '可选模板 template：星空/深海/山野/城市/星球/波纹/图案/海报；可选配色 palette：极光/午夜/日落/糖果/森野/赛博/深海/素白。' +
    '不指定就按 prompt 里的词自己挑。要带标题就传 title。' +
    /* 【2026-11-16 晚·画人物必须说清楚】
     * 主人让她画鲸鱼娘，她只拿到两张渐变背景 —— 因为工具说明里压根没提「人物」，
     * 参数里也没有 subject。模板只会画风景和标题。现在把这条写进说明。 */
    '要画**人物/角色**（鲸鱼娘、人鱼、女孩、男孩、猫、狗、狐狸、兔子、鸟、人剪影）必须传 subject：' +
    'whalegirl/mermaid/girl/boy/cat/dog/fox/rabbit/bird/person；' +
    '不传 subject 时只有 prompt 里明确出现「鲸鱼娘 / 人鱼 / 女孩 / 角色 / 立绘 / Q版」这类词才会自动当人物画，' +
    '否则画出来只有场景和标题（没有人物）。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '画什么。中文英文都行，写具体一点。' },
      size: { type: 'string', description: '尺寸，默认 1024x1024。也可以写 1280x720、方形、竖版。' },
      template: { type: 'string', description: '模板 id：starfield/ocean/mountains/city/planet/waves/pattern/poster。不传自动挑。' },
      palette: { type: 'string', description: '配色 id：aurora/midnight/sunset/candy/forest/cyber/ocean/mono。不传自动挑。' },
      subject: { type: 'string', description: '要画的人物/主体：whalegirl（鲸鱼娘）/mermaid（人鱼）/girl/boy/cat/dog/fox/rabbit/bird/person（人剪影）。画角色必传，不传只出场景。' },
      title: { type: 'string', description: '画面上的大标题（可选）' },
      subtitle: { type: 'string', description: '标题下面那行小字（可选）' },
      engine: { type: 'string', description: 'code（默认）/ model（走「出图」模型）。一般不用传。' },
      note: { type: 'string', description: '一句话说明这张是干嘛的（可选）' },
    },
    required: ['prompt'],
  },
  async run({ prompt, size, template, palette, title, subtitle, engine, note, subject }, ctx = {}) {
    const wantModel = String(engine || '').trim() === 'model';
    let drew = null;

    // ── 第一条路：代码画图（默认）
    if (!wantModel) {
      try {
        drew = await drawByCode({ prompt, size, template, palette, title, subtitle, subject });
      } catch (e) {
        drew = { ok: false, error: String((e && e.message) || e) };
      }
    }

    // ── 第二条路：出图模型（点名要模型，或者代码画图失手了兜底）
    if (!drew || !drew.ok) {
      const ep = imageEndpoint();
      if (!ep) {
        if (drew && drew.error) return 'ERROR：没画成：' + drew.error;
        return 'ERROR：没画成，这台机器上也没有「出图」模型可以兜底。';
      }
      const r = await generateImage({ prompt, size, prefix: 'draw' });
      if (!r.ok) return 'ERROR：没画成：' + r.error;
      drew = {
        ok: true,
        path: r.path,
        width: r.width,
        height: r.height,
        ms: r.ms,
        engine: 'model',
        revised: r.revised,
        warn: drew && drew.error ? drew.error : '',
      };
    }

    // 交到主人手上：走 send_file 那条路（登记 outbox，聊天里长卡片）
    const box = Array.isArray(ctx.outbox) ? ctx.outbox : null;
    const sent = normalizeSend(drew.path);
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
    const secs = Math.max(1, Math.round((drew.ms || 0) / 1000));
    const dim = drew.width && drew.height ? `，${drew.width}×${drew.height}` : '';
    const how = drew.engine === 'model' ? '模型' : '代码';
    const tplInfo = (drew.engine !== 'model' && drew.template) ? `\n（模板 ${drew.template} · 配色 ${drew.palette}）` : '';
    const warn = drew.warn ? `\n（${drew.warn}）` : '';
    const revised = drew.revised && String(drew.revised).trim() && String(drew.revised).trim() !== String(prompt).trim()
      ? `\n上游把你的意思改写成：${String(drew.revised).slice(0, 200)}`
      : '';
    return `画好了（${how}画的），用了 ${secs} 秒${dim}。${tplInfo}${warn}${card}${revised}${said ? '\n（' + said + '）' : ''}`;
  },
};

/** 插件面板要展示的模板/配色清单（前端也能拿到）。惰性，别在 import 期就求值。 */
export function makeImageCatalog() {
  const s = sum();
  return {
    templates: s.templates,
    palettes: s.palettes,
    browser: s.browser,
    templateText: idList(s.templates || []),
    paletteText: idList(s.palettes || []),
  };
}
