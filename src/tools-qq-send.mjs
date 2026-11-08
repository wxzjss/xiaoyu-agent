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

/**
 * 【2026-11-03 加的三种「只有自己注册的号才有」的动作】
 *
 * 官方机器人（AppID/AppSecret 那套）没有戳一戳、没有 QQ 收藏表情包、没有群精华，
 * 这是腾讯的接口就不给。所以这三个 op 只在「自己注册的号」（OneBot）那条道上能用；
 * 走官方那条道时会明确告诉她「这条道做不到」，别让她以为是自己不会用。
 *
 * 为什么不拆成三个工具：她一次只做一个动作，参数还都不一样，拆开只会让模型多挑一次。
 * 一个 op 说清就行 —— 跟上面 image/video/voice/file 一个思路。
 */
const ONE_BOT_ONLY = {
  poke: '戳一戳',
  face: 'QQ 表情',
  mface: '收藏表情包',
  quote: '引用回复',
  history: '翻聊天记录',
  recall: '撤回',
};

export const qqSendTool = {
  name: 'qq_send',
  description:
    '往 QQ 里发东西：图片、视频、语音、文件，或者一句话配着发。' +
    '只有这一轮是从 QQ 递过来的时候能用（主人在电脑前跟你说话时没有 QQ 那头可发，用了会告诉你发不了）。' +
    'op 说清要发什么：image / video / voice / file 都必须是**本机绝对路径**；' +
    'text 是把一段话念成语音条发出去（不用自己先合成）。' +
    'poke 戳一戳对方；face / mface 发 QQ 表情或收藏表情包（要 face_id / emoji_id）；' +
    'quote 引用某条消息回（要 message_id）；history 翻上面聊了什么；recall 撤回自己发的一条。' +
    '后面这几样只有「自己注册的号」（OneBot）那条道能做，官方机器人的接口不提供。' +
    '别自己拼 QQ 号或群号 —— 该发回哪个会话，程序已经知道。',
  parameters: {
    type: 'object',
    properties: {
      op: {
        type: 'string',
        enum: ['image', 'video', 'voice', 'file', 'text', 'poke', 'face', 'mface', 'quote', 'history', 'recall'],
        description: '发什么：image 图 / video 视频 / voice 音频 / file 任意文件 / text 念成语音条 / poke 戳一戳 / face 表情 / mface 收藏表情包 / quote 引用回 / history 翻记录 / recall 撤回',
      },
      path: { type: 'string', description: '本机绝对路径（op 是 text / poke 等不用传）' },
      text: { type: 'string', description: 'op=text 时：要念的话。口语、短句，别塞颜文字和旁白；op=quote 时：引用后要说的话' },
      note: { type: 'string', description: '一句话说明这是啥（可选，会单独作为一条文字发出去）' },
      face_id: { type: 'string', description: 'op=face 时的表情编号（QQ 老表情，数字）' },
      emoji_id: { type: 'string', description: 'op=mface 时的收藏表情 id' },
      message_id: { type: 'string', description: 'op=quote / recall 时要针对的那条消息的 id' },
      count: { type: 'number', description: 'op=history 时取几条（默认 20）' },
    },
    required: ['op'],
  },
  async run({ op, path, text, note, face_id, emoji_id, message_id, count }, ctx = {}) {
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

    // 【只有「自己注册的号」才有的动作】官方机器人接口根本没这几样。
    // 先拦一道把话说清楚，别让她以为是参数写错了、一直重试。
    if (ONE_BOT_ONLY[kind]) {
      const oneBotOn = Boolean(bot?.__onebot);
      if (!oneBotOn) {
        return `「${ONE_BOT_ONLY[kind]}」官方机器人的接口不提供，只有「自己注册的号」那条道能做。`
          + '要么去 QQ 连接里把「自己注册的号（NapCat）」打开，要么这件事就算了。';
      }
      const ob = await import('./qq-onebot.mjs');
      const isGroup = String(target.scope || 'c2c') === 'group';
      const to = String(target.targetId || '');
      const srcObj = src || {};
      try {
        if (kind === 'poke') {
          const who = String(srcObj.whoId || srcObj.qq || to || '');
          if (!who) return '不知道戳谁（这一轮没带上对方的号）。';
          await ob.poke({ isGroup, groupId: to, target: to, userId: who });
          return '戳了一下。';
        }
        if (kind === 'face') {
          if (!face_id) return 'face 要给 face_id（QQ 老表情的编号）。';
          await ob.sendFace({ isGroup, target: to, faceId: face_id });
          return '表情发过去了。';
        }
        if (kind === 'mface') {
          if (!emoji_id) return 'mface 要给 emoji_id（收藏表情的 id）。';
          await ob.sendMface({ isGroup, target: to, emojiId: emoji_id });
          return '表情包发过去了。';
        }
        if (kind === 'quote') {
          const mid = String(message_id || target.msgId || '');
          if (!mid) return 'quote 要给 message_id（要引用哪一条）。';
          await ob.replyQuote({ isGroup, target: to, messageId: mid, text: String(text || said || '') });
          return '引用着回过去了。';
        }
        if (kind === 'history') {
          const r = await ob.history({ isGroup, target: to, count: Number(count) || 20 });
          const list = Array.isArray(r) ? r : [];
          if (!list.length) return '上面没有聊天记录。';
          const lines = list.slice(-30).map((x) => {
            const who = String(x?.sender?.card || x?.sender?.nickname || x?.user_id || '某人');
            const body = Array.isArray(x?.message)
              ? x.message.map((s) => (s?.type === 'text' ? s?.data?.text : `[${s?.type}]`)).join('')
              : String(x?.raw_message || '');
            return `${who}：${body}`.slice(0, 200);
          });
          return `上面这些（旧→新）：\n${lines.join('\n')}`;
        }
        if (kind === 'recall') {
          const mid = String(message_id || '');
          if (!mid) return 'recall 要给 message_id。';
          await ob.recall(mid);
          return '撤回了。';
        }
      } catch (e) {
        return `「${ONE_BOT_ONLY[kind]}」没成功：${String(e?.message ?? e)}`;
      }
    }

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
