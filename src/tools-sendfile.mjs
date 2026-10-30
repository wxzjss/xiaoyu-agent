/**
 * 「发文件」这一个工具。拆出来单独放，是因为 tools.mjs 已经很长了。
 *
 * 它只干两件事：把路径查清楚、把这一轮发出去的东西登记进 CTX.outbox。
 * 真正「交到界面」是 server 收尾时做的（挂到那条回复的 _files 上）。
 */
import { normalizeSend, fmtSize, publicEntry, stash } from "./outbox.mjs";
import { stashFileNow, ctxNow } from './tools.mjs';

export const sendFileTool = {
  name: "send_file",
  description:
    "把文件发给主人：生成好的报告、图片、视频、压缩包、代码什么的都行，任何后缀都能发。" +
    "path 给绝对路径（也可以用工作区里的相对路径）；多个文件就多调用几次，或者直接给一个文件夹的路径（发里面这一层）。" +
    "发出去之后聊天里会出现卡片：图片能看、视频能播、别的能直接下载。",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "要发的文件绝对路径（或工作区里的相对路径 / 文件夹路径）" },
      note: { type: "string", description: "一句话说这是啥（可选）" },
    },
    required: ["path"],
  },
  async run({ path, note }, ctx = {}) {
    const r = normalizeSend(typeof path === "string" ? path : (path && path.path));
    const said = String(note || "").trim();
    if (r.skip && !(r.kids && r.kids.length)) {
      return (r.skip ? r.skip : "这个发不了") + (said ? "\n（" + said + "）" : "");
    }
    const items = r.kids && r.kids.length ? r.kids : (r.entry ? [r.entry] : []);
    if (!items.length) return "这个文件夹里没有能发的文件。";
    const box = Array.isArray(ctx.outbox) ? ctx.outbox : null;
    const lines = [];
    // 【2026-10-30 主人要：图/文件当场出来，别等这一轮说完】
    // 以前只塞进 outbox，等 server 收尾才挂到回复上 —— 主人得等我把一整轮话都说完才看得见。
    // 现在塞进去的同时就推一条 sentfile 给界面，前端收到立刻画卡片。
    /* 【2026-10-30】工具拿到的 ctx 常常是空对象，真通道在 ctxNow() 里。两处都看一眼。 */
    const _c = (() => { try { return ctxNow() || {}; } catch { return {}; } })();
    const push = typeof _c.pushEvent === 'function' ? _c.pushEvent : (typeof ctx.pushEvent === 'function' ? ctx.pushEvent : null);
    for (const e of items) {
      e.key = stash(e);
      const pub = publicEntry(e);
      if (box) box.push(pub);
      // 主人 2026-10-30：文件一到手就先落盘，点停止 / 重启都不至于看不见。
      try { stashFileNow(pub); } catch {}
      if (push) {
        try { push({ type: 'sentfile', file: pub, note: said || '' }); } catch {}
      }
      lines.push("- " + e.name + "（" + fmtSize(e.size) + "，" + e.kind + "）→ " + e.path);
    }
    return "已经交到主人手上了，聊天里会看到卡片：\n" + lines.join("\n") + (said ? "\n（" + said + "）" : "");
  },
};
