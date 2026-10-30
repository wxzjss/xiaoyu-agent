/**
 * 「小鱼说话」这一个工具。跟「发文件」一样拆出来单独放。
 *
 * 它干三件事：合成、把 mp3 登记进这一轮的 outbox、把结果告诉模型。
 * 界面那边最后会把它渲染成一张能播的卡片。
 */
import { speak, readTTS, VOICES } from './tts.mjs';
import { normalizeSend, fmtSize, publicEntry, stash } from './outbox.mjs';

export const sayTool = {
  name: 'say',
  description:
    '用主人给她挑好的嗓音把一段话念出来，发一条能直接播放的语音给主人。' +
    '主人说「说给我听」「念给我听」「用语音回我」，或者你想让他听见你的口气时用它。' +
    'text 只写要念的内容：不要写颜文字、不要写括号旁白，那些念不出来还难听。' +
    'voice 一般不用传，不传就用主人在功能页里选好的那档；' +
    '主人明确说想换一种声音时可以传：xiaoyu_144342（活泼甜）/ v4_nuo（软糯最软）/ v4_tian（软糯偏甜）/ v6_a（连读自然）。',
  parameters: {
    type: 'object',
    properties: {
      text: { type: 'string', description: '要念的话。口语、短句，别塞颜文字和旁白' },
      voice: {
        type: 'string',
        enum: VOICES.map((v) => v.id),
        description: '换一档声音；不传就用功能页里选好的那档',
      },
    },
    required: ['text'],
  },
  async run({ text, voice }, ctx = {}) {
    const said = String(text ?? '').trim();
    if (!said) return '没给要念的话，text 是空的。';

    // 颜文字和旁白念出来会很怪，动手前先削掉一层
    const clean = said
      .replace(/[（(][^）)]{0,40}[）)]/g, '。')
      .replace(/[≧≦˃ᴗ˂ω´｀Дд๑•̀ᴗ́︿̀◡ᵕ〃▽＼*｡ᵒゞ￣]/g, '')
      .replace(/[~～]{2,}/g, '')
      .replace(/。{2,}/g, '。')
      .trim() || said;

    const useVoice = voice || readTTS().voice;
    const out = await speak(clean, useVoice);

    const r = normalizeSend(out);
    const entry = r.entry;
    if (!entry) return '合成了但没找到文件：' + out;
    entry.key = stash(entry);
    if (Array.isArray(ctx.outbox)) ctx.outbox.push(publicEntry(entry));

    const vname = (VOICES.find((v) => v.id === useVoice) || {}).name || useVoice;
    return (
      `念好了，语音已经发到主人手上：「${vname}」这一档，${fmtSize(entry.size)}。\n` +
      `念的是：${clean.slice(0, 60)}${clean.length > 60 ? '…' : ''}`
    );
  },
};
