/**
 * 【陪看屏幕】—— 她自己抬头看一眼主人现在的屏幕（2026-11-01）。
 *
 * 参考 dsh-whale-sense 那个插件：它让帮工进程反复截屏、把「屏幕变了」这件事
 * 跟图片一起塞回会话，于是模型能跟着主人一起看。这里不引 Python、不装依赖，
 * 底子是 src/screen-capture.mjs（Windows 自带 PowerShell + .NET）。
 *
 * 【她自己决定什么时候看，不是一直在看】
 * 插件那边是定时轮询；这里做成工具：她想看（主人让她看、她自己好奇、主人说
 * 「你看我这个」）才截一张。理由是实时轮询等于把主人的屏幕一直上传给模型，
 * 那件事得主人自己手动开（【陪看屏幕 · 一直在看】那个开关），不能默默就来。
 *
 * 【两档】
 *   look_screen          看一眼，返回图片给他自己看（进上下文，她真的能理解画面）
 *   screen_watch_status  看现在是不是在「一直在看」，以及最近截了几张、存了多少
 *
 * 【图片怎么给她】
 * 工具结果本身不能带图，所以走两个口子：
 *   ① 返回文本里写清「画面是什么样」的客观描述（分辨率、前台窗口、时间）
 *   ② 把缩图路径登记进 outbox，让这一轮的回复里挂一张她看见的图 ——
 *      主人能顺手点开，也能确认她到底看到了什么（避免「她说看到了」其实没看）
 */
import { existsSync } from 'node:fs';
import { capture, recent, stashSize, prune, foregroundTitle } from './screen-capture.mjs';
import { normalizeSend, fmtSize, publicEntry, stash } from './outbox.mjs';
import { enabledToolNames } from './features.mjs';
import { ctxNow } from './tools.mjs';

/** 这个功能开着没（关掉的时候工具根本不在她手上，这里是兜底）。 */
function senseOn() {
  try {
    return enabledToolNames().includes('look_screen');
  } catch {
    return true;
  }
}

function fmtTime(iso) {
  try {
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  } catch {
    return String(iso || '');
  }
}

export const screenTools = [
  {
    name: 'look_screen',
    /**
     * 【description 为什么写这么长】
     * 工具清单是从 schema 自动生成塞进系统提示的，模型只靠这段话判断该不该用。
     * 写短了它会滥用（每轮都看）或不敢用（主人说「你看这个」还在问）。
     */
    description:
      '抬头看一眼主人现在的屏幕，看这一刻他屏幕上是什么（哪个窗口、什么内容）。'
      + '\n\n什么时候用：主人说「你看我这个」「我屏幕上这个怎么回事」「这报错你看见没」「陪我一起看」；'
      + '或者你正需要知道他当前在哪个程序里、界面上是什么样，光靠他说不清的时候。'
      + '\n\n什么时候别用：主人没提屏幕、你也不需要知道他屏幕上是什么的时候。别每轮都看 —— '
      + '看一次他就得把他的屏幕交给模型一次，那是他的隐私，不是你随手能翻的东西。'
      + '\n\n看完你拿到的是这张图本身（缩到你也能看的分辨率），所以可以直接就画面里的东西说话；'
      + '别假装看见了没看见的细节，不确定的地方就问他。',
    parameters: {
      type: 'object',
      properties: {
        why: {
          type: 'string',
          description: '你为什么要看这一眼（一句话）。会记进这一帧的备注里，主人事后能看出你当时在想什么',
        },
      },
      required: [],
    },
    async run({ why }, ctx = {}) {
      if (!senseOn()) {
        return '【陪看屏幕】现在是关着的，我看不到你的屏幕。要用的话让主人在顶部【功能】里把「陪看屏幕」打开。';
      }
      const r = await capture({ tag: String(why || '').slice(0, 80) });
      if (!r.ok) return '看一眼没看成：' + r.error;

      /**
       * 把缩图登记进 outbox，这一轮的回复里就会挂上「她看见的那张」。
       * 挂上去的意义不只是好看：主人能点开对照，确认她真的看到了、没在编。
       */
      let attached = '';
      try {
        const norm = normalizeSend(r.small);
        if (norm.entry) {
          norm.entry.key = stash(norm.entry);
          if (Array.isArray(ctx.outbox)) ctx.outbox.push(publicEntry(norm.entry));
          attached = `\n这一眼看到的画面已经挂在回复里了（${norm.entry.name}，${fmtSize(norm.entry.size)}）。`;
        }
      } catch {
        /* 挂不上也不影响她看 */
      }

      const m = r.meta || {};
      const title = String(m.title || '').trim();
      const lines = [
        '【看了一眼你的屏幕】' + fmtTime(m.at),
        '屏幕：' + (m.screen?.width || '?') + '×' + (m.screen?.height || '?') + '（我只拿到缩到 ' + (m.small?.width || '?') + '×' + (m.small?.height || '?') + ' 的那张）',
        title ? '当时前台窗口：' + title : '当时没读到前台窗口的名字（可能全屏或者没窗口）',
        why ? '看这一眼的原因：' + String(why) : '',
        attached,
      ].filter(Boolean);
      /**
       * 【把图真的交到她手上】
       *
       * agent.mjs 已经支持工具返回 { text, images }：images 里的路径会当场编码成
       * image_url 拼进同一条 tool 消息。所以这里给的是**缩图路径**，不是文字描述 ——
       * 只给路径她看不见，会去 read_file 读 PNG 读成乱码，然后说「我看不清」。
       * 用缩图不用原图：原图 2~3MB，模型反正要缩到千把像素，传过去纯烧 token。
       */
      return { text: lines.join('\n'), images: [r.small] };
    },
  },
  {
    name: 'screen_watch_status',
    description:
      '看【陪看屏幕】现在是什么状态：开着没有、最近一共看了几张、占多少地方、最近那几张各自是什么时候、当时前台是哪个窗口。'
      + '主人问「你刚才看见的是什么」「你都存了我多少屏」的时候用它，别瞎猜。',
    parameters: { type: 'object', properties: {}, required: [] },
    async run() {
      const on = senseOn();
      const size = stashSize();
      const list = recent(8);
      const lines = ['【陪看屏幕】' + (on ? '开着（我可以用 look_screen 抬头看）' : '关着（我看不到你的屏幕）')];
      lines.push('盘上存着 ' + size.count + ' 张（' + fmtSize(size.bytes) + '，两小时后自动清，最多留 240 帧）');
      const title = await foregroundTitle();
      if (title) lines.push('你现在的窗口：' + title);
      if (list.length) {
        lines.push('');
        lines.push('最近看过的几张：');
        for (const f of list) {
          const t = fmtTime(f.at);
          const nm = String(f.title || '').trim() || '(没读到窗口名)';
          const tag = String(f.tag || '').trim();
          lines.push('· ' + t + ' — ' + nm + (tag ? '（为什么看：' + tag + '）' : ''));
        }
      } else {
        lines.push('还没看过任何一张。');
      }
      lines.push('');
      lines.push('顺手清一遍过期的：' + prune() + ' 个文件。');
      return lines.join('\n');
    },
  },
];

/**
 * 给界面用：最近几帧（带能不能点开的路径）。
 *
 * 界面上的「陪看屏幕」面板列这个。只给最近的、且文件确实还在的 ——
 * 元信息还在但图片被清掉的那种，列出来点开会是空的，不如不列。
 */
export function recentFrames(limit = 12) {
  return recent(limit)
    .filter((f) => existsSync(String(f.small || '')) || existsSync(String(f.full || '')))
    .map((f) => ({
      id: f.id,
      at: f.at,
      title: f.title || '',
      tag: f.tag || '',
      screen: f.screen || {},
      small: f.small || '',
      full: f.full || '',
      smallBytes: f.smallBytes || 0,
      fullBytes: f.fullBytes || 0,
    }));
}
