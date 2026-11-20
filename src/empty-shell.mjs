/**
 * 【2026-11-18 主人要求·空壳会话切走就扔】
 *
 * 原话：「新建会话后，除了开场白，该会话里智能体与用户都没发过消息，
 *        那么当用户切换到其他会话时自动删除那个新建的会话」。
 *
 * 现场是什么样：主人点一下「新会话」→ 屏幕上只有她那句开场白 → 他看一眼不合适，
 * 转头去了别的会话。这个会话从此再没人打开，却在左栏赖着不走。
 * 试几下就攒出一排「新会话」，列表全是垃圾。
 *
 * 【为什么判定要单独一个纯函数】
 * 删会话是不可逆的动作（虽然进的是回收站），判据必须能被单独测：
 * 一条边界判错就是「把主人真聊过的会话扔了」，比留着垃圾严重一万倍。
 * 所以这里只回答「该不该删」，不碰磁盘 —— 真删在 server.mjs 里做。
 */

/**
 * 这个会话是不是「谁都没用过」的空壳。
 *
 * @param {object} session 会话对象
 * @param {object} [ctx]
 * @param {boolean} [ctx.running] 这一轮 / 这个会话正在跑
 * @param {boolean} [ctx.pinned]  被主人置顶了
 * @param {boolean} [ctx.hasDraft] 还有活着的草稿（开过头，哪怕一个字没说）
 * @param {(m:object)=>boolean} [ctx.isOpening] 认不认得出「开场白那条」
 * @returns {{drop:boolean, why:string}} why 是**为什么留着**，方便日志与测试
 */
export function judgeEmptyShell(session, ctx = {}) {
  const id = String((session && session.id) || '');
  if (!id) return { drop: false, why: '没有会话' };
  if (ctx.running) return { drop: false, why: '正在跑' };
  if (ctx.pinned) return { drop: false, why: '主人置顶了' };
  if (ctx.hasDraft) return { drop: false, why: '有一轮开过头的草稿' };

  const ms = Array.isArray(session.messages) ? session.messages : [];
  /* 主人真说过话 —— 最硬的一条。带 context / _sysNote 的不算（那是程序自己投的）。 */
  const spoke = ms.some((m) => m && m.role === 'user' && !m.context && !m._sysNote);
  if (spoke) return { drop: false, why: '主人说过话' };

  const isOpening = typeof ctx.isOpening === 'function' ? ctx.isOpening : () => false;
  /* 她除了开场白还说过别的（工具活干过、答过话）—— 那也是「用过」 */
  const beyondOpening = ms.some((m) => m && m.role === 'assistant' && !m.context
    && String(m.content || '').trim() && !isOpening(m));
  if (beyondOpening) return { drop: false, why: '她说过开场白以外的话' };
  /* 工具消息 / 工具调用：她动过手就不算空壳（哪怕正文空着） */
  const worked = ms.some((m) => m && (m.role === 'tool'
    || (Array.isArray(m.tool_calls) && m.tool_calls.length)));
  if (worked) return { drop: false, why: '她干过活（有工具调用）' };

  /* 到这里：只有开场白（或者连开场白都没有）→ 空壳 */
  return { drop: true, why: '只有开场白，谁都没用过' };
}