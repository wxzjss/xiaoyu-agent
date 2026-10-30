/**
 * 把会话导出成「人能直接读」的 txt。
 *
 * ── 为什么要这个 ─────────────────────────────────────────────
 * 现有的「导出这个 / 全部导出」给的是 JSON —— 那是为了**再导回来**用的，
 * 备份没问题，但主人想拿去看、拿去发给别人、拿去搜，就得自己翻一堆
 * `{"role":"assistant","content":"…","tool_calls":[…]}`。
 * 所以单开一条 txt 的出口：排版成聊天记录的样子，谁都能读。
 *
 * ── 排版原则 ─────────────────────────────────────────────────
 * 1. **只写人话**。system 提示词、context 上下文、压缩摘要都属于「机器的内务」，
 *    默认不写（写了就是几万字规则糊在开头，主人找自己的话得翻半天）。
 * 2. **小鲸的话要认出来**。她的话存在同一条 assistant 记录里（带 _whale / _whaleSide），
 *    导出时得写成「小鲸」而不是混成小鱼说的。
 * 3. **工具调用也要留痕**，但压成一行：她跑了什么命令、结果开头多少字。
 *    这些是「她干了什么」的证据，全删掉就看不懂她为什么那么说；全文照抄又是刷屏。
 * 4. 纯文本、UTF-8、\r\n 换行 —— Windows 记事本打开不乱行。
 */

/** 时间戳 → 「2026-10-27 21:43:05」 */
function fmtTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n);
  const p = (x, w = 2) => String(x).padStart(w, '0');
  return (
    d.getFullYear() +
    '-' + p(d.getMonth() + 1) +
    '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) +
    ':' + p(d.getMinutes()) +
    ':' + p(d.getSeconds())
  );
}

/** 一条消息到底是「谁」说的 */
function speakerOf(m) {
  if (!m) return '';
  if (m.role === 'user') return '主人';
  if (m.role === 'system') return '系统';
  if (m.role === 'tool') return '工具';
  if (m.role === 'assistant') {
    // 小鲸的话和主人的话共用一个 role，只能靠这几个标记分开
    if (m._whale || m._whaleSide) return '小鲸';
    return '小鱼';
  }
  return m.role || '';
}

/** 正文取哪个字段：_text 是主人原话（不含拼进去的记忆/上下文），优先用它 */
function bodyOf(m) {
  if (!m) return '';
  if (typeof m._text === 'string' && m._text.trim()) return m._text;
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // 带图/带附件时 content 是数组：{type:'text',text:...} / {type:'image_url',...}
    const parts = [];
    for (const p of c) {
      if (!p) continue;
      if (typeof p === 'string') parts.push(p);
      else if (p.type === 'text' && p.text) parts.push(String(p.text));
      else if (p.type === 'image_url') parts.push('［图片］');
    }
    return parts.join('\n');
  }
  return '';
}

/** 一行一条工具的调用参数里挑出「最像命令/路径」的那个，好在记录里认得出 */
function briefArgs(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  try {
    const o = JSON.parse(s);
    const pick =
      o.command ?? o.path ?? o.file_path ?? o.query ?? o.url ?? o.text ?? o.pattern ?? o.name;
    if (typeof pick === 'string' && pick.trim()) return pick.trim().replace(/\s+/g, ' ');
  } catch {
    /* 不是 JSON 就原样用 */
  }
  return s.replace(/\s+/g, ' ').slice(0, 160);
}

/** 工具结果压成一行：去掉多余换行，超长截断并标明截了 */
function briefResult(text, limit) {
  const t = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!t) return '（没有输出）';
  const flat = t.split('\n').filter((x) => x.trim()).join(' ⏎ ');
  if (flat.length <= limit) return flat;
  return flat.slice(0, limit) + ' …（省略 ' + (flat.length - limit) + ' 字，共 ' + t.length + ' 字，' + t.split('\n').length + ' 行）';
}

/**
 * 主函数：把一个会话对象变成 txt 字符串。
 * @param {object} session  会话对象（有 title / createdAt / messages / rewinds / mode）
 * @param {object} [opt]
 * @param {boolean} [opt.withSystem=false]  是否把 system 提示词也写进去（默认不写）
 * @param {number}  [opt.toolChars=240]     工具结果每条最多留多少字
 * @param {boolean} [opt.withTools=false]   是否写工具调用（默认**不写**：主人只要聊天记录）
 * @param {string}  [opt.version='']        程序版本，写进页眉
 */
export function sessionToText(session, opt = {}) {
  const withSystem = opt.withSystem === true;
  const withTools = opt.withTools === true;
  const toolChars = Number.isFinite(Number(opt.toolChars)) ? Number(opt.toolChars) : 240;
  const version = String(opt.version || '');

  const msgs = Array.isArray(session?.messages) ? session.messages : [];
  // 回退过的地方要标出来：不然读者会奇怪「怎么这儿突然接不上」
  const rewindAt = new Map();
  for (const r of Array.isArray(session?.rewinds) ? session.rewinds : []) {
    const at = Number(r?.at);
    if (Number.isFinite(at)) rewindAt.set(at, r);
  }

  const L = [];
  const line = (s = '') => L.push(s);
  const rule = (ch = '─', n = 64) => line(ch.repeat(n));

  // ── 页眉 ──
  const title = String(session?.title || '未命名会话');
  rule('═');
  line('小鱼Agent · 会话记录');
  rule('═');
  line('标题：' + title);
  line('会话 ID：' + String(session?.id || ''));
  const created = fmtTime(session?.createdAt);
  const updated = fmtTime(session?.updatedAt);
  if (created) line('创建时间：' + created);
  if (updated) line('最后更新：' + updated);
  line('导出时间：' + fmtTime(Date.now()));
  if (version) line('程序版本：' + version);
  const modeWord = typeof session?.mode?.word === 'string' ? session.mode.word : '';
  if (modeWord) line('模式：' + modeWord);

  // 数一数，让读者一眼知道份量
  let nUser = 0, nFish = 0, nWhale = 0, nTool = 0;
  for (const m of msgs) {
    const who = speakerOf(m);
    if (who === '主人') nUser++;
    else if (who === '小鲸') nWhale++;
    else if (who === '小鱼') nFish++;
    else if (who === '工具') nTool++;
  }
  line(
    '内容：' + msgs.length + ' 条消息（主人 ' + nUser + ' · 小鱼 ' + nFish +
    ' · 小鲸 ' + nWhale + (withTools ? ' · 工具 ' + nTool : '') + '）',
  );
  if (!withSystem) line('说明：系统提示词与上下文未导出');
  rule('═');
  line();

  // ── 正文 ──
  let wrote = 0;
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (!m) continue;
    const who = speakerOf(m);

    // 回退点：标在这一条前面
    if (rewindAt.has(i)) {
      line('⟲ ［这里回退了对话，后面的内容从这句重新开始］');
      line();
    }

    if (m.role === 'system') {
      if (!withSystem) continue;
      line('── 系统提示词 ' + (fmtTime(m._at) ? '(' + fmtTime(m._at) + ')' : '') + ' ──');
      line(bodyOf(m));
      line();
      wrote++;
      continue;
    }

    if (m.summary || m.context) {
      // 压缩摘要 / 上下文：属于机器内务，默认不写
      if (!withSystem) continue;
      line('── ' + (m.summary ? '压缩摘要' : '上下文') + ' ──');
      line(bodyOf(m));
      line();
      wrote++;
      continue;
    }

    if (m.role === 'tool') {
      if (!withTools) continue;
      line('  ⎿ ' + briefResult(bodyOf(m), toolChars));
      wrote++;
      continue;
    }

    // 人说的话（主人 / 小鱼 / 小鲸）
    const when = fmtTime(m._at);
    const tags = [];
    if (m._interject) tags.push('插话');
    if (m._recovered) tags.push('补回');
    if (m._editedAt) tags.push('编辑过');
    if (m._images && m._images.length) tags.push('图×' + m._images.length);
    const head =
      '【' + (who || '未知') + '】' +
      (when ? ' ' + when : '') +
      (tags.length ? ' ［' + tags.join('·') + '］' : '');

    const body = bodyOf(m).replace(/\r\n/g, '\n').trimEnd();
    const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];

    // 只有工具调用、一个字都没说的 assistant —— 别输出一个空壳
    if (!body && !calls.length) continue;

    line(head);
    if (body) {
      for (const ln of body.split('\n')) line('  ' + ln);
    }
    if (withTools && calls.length) {
      for (const c of calls) {
        const fn = c?.function || {};
        const args = briefArgs(fn.arguments);
        line('  ↳ 调工具 ' + (fn.name || '?') + (args ? '：' + args : ''));
      }
    }
    line();
    wrote++;
  }

  if (!wrote) {
    line('（这个会话里没有可读的内容）');
    line();
  }

  // ── 页脚 ──
  rule('═');
  line('以上是「' + title + '」的全部对话记录。');
  rule('═');
  return L.join('\r\n');
}

/** 给下载用的文件名：小鱼Agent-标题-20261027-2143.txt */
export function txtFilenameOf(session, stampStr) {
  const title = String(session?.title || '会话').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 40) || '会话';
  const st = String(stampStr || '');
  return '小鱼Agent-' + title + (st ? '-' + st : '') + '.txt';
}
