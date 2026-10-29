/**
 * 「往 QQ 里发东西」这一个工具 —— 2026-11-02
 *
 * 主人说：「最好还能让小鱼Agent在QQ里发文件语音图片」。
 * 这一份只做工具面那一层：把参数变成「发什么」「发到哪儿」，真正动手在 qq-media.mjs。
 *
 * 为什么工具叫 qq_send 而不是 send_image / send_voice 三个：
 * 她一次通常只想发一个东西，参数长得一样，分成三个工具只会让她多挑一次。
 * 一个 op 字段说清是什么，剩下交给后缀。
 *
 * 为什么不需要她自己填 QQ 号：这一轮是从谁那儿来的、该发回哪儿，
 * turn-source 里已经记着了（qq-server 在开跑前写进去）。她自己拼地址只会拼错，
 * 更糟的是可能拼到别人那儿去 —— 所以地址只从服务端那一侧取，工具里不接受 target。
 */
import { existsSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import { currentQqBot } from './qq-bridge.mjs';
import { sendFileToQq, kindOfFile } from './qq-media.mjs';
import { turnReplyTarget, turnSourceOf } from './turn-source.mjs';
import { speak } from './tts.mjs';

/** 念出来的话里颜文字/旁白要削掉，不然合成出来很怪（跟 say 工具一个口径） */
function cleanForSpeech(said) {
  return String(said || '')
    .replace(/[（(][^）)]{0,40}[）)]/g, '。')
    .replace(/[≧≦˃ᴗ˂ω´｀Дд๑•̀ᴗ́︿̀◡ᵕ〃▽＼*｡ᵒゞ￣]/g, '')
    .replace(/[~～]{2,}/g, '')
    .replace(/。{2,}/g, '。')
    .trim();
}

export const qqSendTool = {
  name: 'qq_send',
  description:
    '往 QQ 里发东西：图片、视频、语音、文件，或者一句话配着发。' +
    '只有这一轮是从 QQ 递过来的时候能用（主人在电脑前跟你说话时没有 QQ 那头可发，用了会告诉你发不了）。' +
    'op 说清要发什么：image / video / voice / file 都必须是**本机绝对路径**；' +
    'text 是把一段话念成语音条发出去（不用自己先合成）。' +
    '别自己拼 QQ 号或群号 —— 该发回哪个会话，程序已经知道。',
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['image', 'video', 'voice', 'file', 'text'],
        description: '发什么：image 图 / video 视频 / voice 音频 / file 任意文件 / text 念成语音条',
      },
      path: { type: 'string', description: '本机绝对路径（op 是 text 时不用传）' },
      text: { type: 'string', description: 'op=text 时：要念的话。口语、短句，别塞颜文字和旁白' },
      note: { type: 'string', description: '一句话说明这是啥（可选，会单独作为一条文字发出去）' },
    },
    required: ['op'],
  },
  async run({ op, path, text, note }, ctx = {}) {
    const sessionId = String(ctx?.sessionId || '');
    const target = turnReplyTarget(sessionId);
    const src = turnSourceOf(sessionId);
    if (!target) {
      return '这一轮不是从 QQ 递过来的，没有 QQ 那头可以发（主人现在是在电脑前跟你说话）。'
        + (src?.source ? `（这一轮来自 ${src.source}）` : '');
    }
    const bot = currentQqBot();
    if (!bot) return 'QQ 现在没连着（机器人没启动或断了），发不出去。';

    const said = String(note || '').trim();
    const kind = String(op || '').trim();

    // 先把文字说明发掉：她说「给你看这张」的时候，人家才知道自己在看什么
    const sendNote = async () => {
      if (!said) return;
      try {
        await bot.sendText(target, said);
      } catch {}
    };

    if (kind === 'text') {
      const words = cleanForSpeech(text);
      if (!words) return '没给要念的话，text 是空的。';
      let mp3 = '';
      try {
        mp3 = await speak(words);
      } catch (e) {
        return `语音没合成出来：${String(e?.message ?? e)}`;
      }
      if (!mp3 || !existsSync(mp3)) return '语音合成没落盘，发不了。';
      await sendNote();
      try {
        const r = await sendFileToQq(bot, target, mp3, { as: 'voice' });
        return r.sent === 'voice' ? '语音条发出去了。' : `发成文件了（${r.note || ''}）`;
      } catch (e) {
        return `发不出去：${String(e?.message ?? e)}`;
      }
    }

    const raw = String(path || '').trim();
    if (!raw) return 'op 是 ' + kind + ' 的时候得给 path（本机绝对路径）。';
    const abs = isAbsolute(raw) ? resolve(raw) : '';
    if (!abs) return '要给绝对路径，不然我不知道从哪儿取文件。';
    if (!existsSync(abs)) return '找不到这个文件：' + abs;
    try {
      if (!statSync(abs).isFile()) return '这是个文件夹，发不了（先打包或者发里面单个文件）。';
    } catch {}

    const byExt = kindOfFile(abs);
    const wantAs = kind === 'file' ? 'file' : (kind === byExt ? kind : byExt);
    void extname(abs);
    void basename(abs);

    await sendNote();
    try {
      const r = await sendFileToQq(bot, target, abs, { as: wantAs });
      const zh = { image: '图片', video: '视频', voice: '语音', file: '文件', text: '文字' }[r.sent] || r.sent;
      return `发出去了（按${zh}发的${r.note ? '，' + r.note : ''}）。`;
    } catch (e) {
      return `发不出去：${String(e?.message ?? e)}`;
    }
  },
};
