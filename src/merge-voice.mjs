/**
 * 【同一个人在连着说，就拼成一段】—— 2026-10-28
 *
 * 主人报：用小鱼身份说话，她回「（赶紧凑过去看那本书）」—— 把主人的话想成了别人手里的书。
 * 查下来不是标签的问题，是**结构**的问题：
 *
 *   user: 在吗            ← 主人说的
 *   user: （翻着手中的书）  ← 我（另一副身份）说的
 *
 * 两条独立的 user 消息，中间没有她的回答 —— 从模型视角看，这是一轮里换人了。
 * 真人在聊天框里连着说两句，是同一段话里的两行，不是两条消息。这里照那个来。
 *
 * 【硬边界：绝不跨过她的回答】
 * 中间隔着 assistant 的两句话不能合并 —— 那等于把她的回答从自己的历史里抹掉，
 * 是改历史，不是改视角。所以只合并「紧挨着、中间什么都没有」的那种。
 *
 * 【为什么能保住回退】
 * 合并只发生在发出去的拷贝上；盘上那句话还是单独一条，带自己的下标。
 * 回退、编辑、分支全靠盘上那份的 rewindId 干活，一个字都没动。
 *
 * @param {Array} wireMessages 发出去的那份拷贝（已经拼过说话人前缀）
 * @returns {Array} 合并后的新数组
 */
export function mergeSameVoice(wireMessages) {
  /** 相邻两条能不能算「同一个人在连着说」 */
  const sameVoice = (a, b) => {
    if (!a || !b) return false;
    if (a.role !== 'user' || b.role !== 'user') return false;
    if (a.context || b.context || a._identity || b._identity) return false;  // 规则条不算人话
    if (typeof a.content !== 'string' || typeof b.content !== 'string') return false;
    /**
     * 【这条判据问的不是「谁」，是「有没有换人」】
     *
     * 一开始按「名字一样才合」写，结果主人那句 + 她自己那句永远合不上 ——
     * 因为在模型眼里**主人和她自己本来就是同一个人**（她说的话，就是主人借她的嘴说出来的）。
     *
     * 所以只分两档：
     *   · 人            → 一律 [me]（主人、她自己、任何一副身份，都是同一个人）
     *   · 规则条        → 上面那行已经挡掉了
     * 剩下能挡住的只有 context / assistant 这些硬边界。
     *
     * 那还留名字干什么？—— 只给「真有个别人在场」留口子：
     * 打了 _thirdParty 的才算另一个人。
     *
     * 【2026-11-04 改】QQ 那头递进来的话现在也打 _thirdParty（在 qq-server 里打的）——
     * 打上之后名字有用了：主人、她自己、QQ 上的张三，三副嗓子各自分开，
     * 不会再把「另一个人说的话」当成主人接着自己的上一句续下去。
     * 没打 _thirdParty 的老消息照旧合在一起，等于「都算同一个人」。
     */
    const voice = (x) => (x._thirdParty ? String(x._who || '?') : '[me]');
    return voice(a) === voice(b);
  };
  const out = [];
  let prevIdx = -1;
  for (let wi = 0; wi < wireMessages.length; wi++) {
    const m = wireMessages[wi];
    const prev = out[out.length - 1];
    // 严格相邻：中间夹着别的（比如她的回答、规则副本）就绝不算连着说
    if (sameVoice(prev, m) && prevIdx === wi - 1) {
      prevIdx = wi;
      /**
       * 【拼起来之后，得让模型看得出这是两行不同的话 —— 2026-10-29 补】
       *
       * 上一版只是拿换行接起来：
       *     在吗
       *     （翻着手中的书）
       * 结果她还是回「（赶紧凑过去看那本书）」—— 把后面那行当成了**别人**的动作。
       *
       * 为什么拼了还认错：换行对模型来说只是同一句话里断了一下，
       * 没有任何标记说「这第二行不是刚才那个人说的」。
       * 而她要的正是这个信息：**第二行是她自己心里的念头**。
       *
       * 所以拼的时候带上来源标记（_whoMade 由 server 那边打，见它 who 分支的注释）：
       * 她自己那几行前面加「（心里）」——不是称呼、不是标签，是把行属性讲清。
       * 主人那几行不加任何前缀（她知道那是谁说的）。
       * 标记只在合并时加、只加在**发出去的拷贝**上，盘上那句话原本就是干净的一条。
       */
      const mine = (x) => Boolean(x && x._whoMade);
      const lineOf = (x) => String(x.content ?? '');
      /**
       * 一段里第一次出现「她自己说的」那行才打标记，后面的不用每行都打 ——
       * 打太多变成噪音，模型反而会去猜「为什么每行都标」。
       */
      const body = String(prev.content ?? '');
      const tagged = body.includes('（心里）') || mine(prev);
      out[out.length - 1] = {
        ...prev,
        content: body + '\n' + (mine(m) && !tagged ? '（心里）' : '') + lineOf(m),
      };
      continue;
    }
    out.push(m);
    prevIdx = wi;
  }
  return out;
}
