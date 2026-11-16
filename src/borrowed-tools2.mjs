/**
 * 借鉴工具·第二批（2026-11-15）
 *
 * 精准改文件 / 设目标 / 发一组文件 / 反复做到过 / 翻轮次
 * 都是照着 dsh / WorkBuddy 那几家挑出来重写的，名字按小鱼的规矩起中文。
 */
import { readFileSync, writeFileSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';

const EOL = '\r\n';

function absPath(p) {
  if (!p) throw new Error('路径不能是空的');
  return isAbsolute(p) ? resolve(p) : resolve(process.cwd(), p);
}

/* ---------------- 精准改文件（对应 dsh 的 str_replace_editor） ---------------- */

function editFile(filePath, oldStr, newStr, opts = {}) {
  const p = absPath(filePath);
  if (!existsSync(p)) throw new Error('文件不存在：' + p);
  const st = statSync(p);
  if (st.isDirectory()) throw new Error('这是目录，不是文件：' + p);
  if (st.size > 8 * 1024 * 1024) throw new Error('文件太大（' + (st.size / 1048576).toFixed(1) + 'MB），别用这个改');

  let text = readFileSync(p, 'utf8');
  const before = text.length;

  if (typeof oldStr !== 'string' || oldStr === '') throw new Error('old_str 不能是空的 —— 空的没法定位');

  // 数一下出现几次
  const hits = [];
  let from = 0;
  while (true) {
    const i = text.indexOf(oldStr, from);
    if (i < 0) break;
    hits.push(i);
    from = i + 1;
    if (hits.length > 100) break;
  }

  if (hits.length === 0) {
    // 试试把换行统一一下（Windows 上经常是 CRLF 和 LF 打架）
    const alt = oldStr.replace(/\r\n/g, '\n');
    const alt2 = oldStr.replace(/\n/g, EOL);
    if (text.indexOf(alt) >= 0 || text.indexOf(alt2) >= 0) {
      const use = text.indexOf(alt) >= 0 ? alt : alt2;
      return editFile(filePath, use, newStr, opts);
    }
    throw new Error('原文里没找到这段：\n' + oldStr.slice(0, 200));
  }

  if (hits.length > 1 && !opts.allowMultiple) {
    throw new Error('这段在文件里出现了 ' + hits.length + ' 次，定位不准。要么把 old_str 写长一点只留一处，要么传 allow_multiple=true 全改。');
  }

  if (opts.allowMultiple) {
    text = text.split(oldStr).join(newStr);
  } else {
    const i = hits[0];
    text = text.slice(0, i) + newStr + text.slice(i + oldStr.length);
  }

  // 留一份备份，改坏了能退
  if (opts.backup !== false) {
    try { copyFileSync(p, p + '.bak-edit-' + Date.now()); } catch { /* 备份失败不拦 */ }
  }

  writeFileSync(p, text, 'utf8');

  // 找出改动在第几行
  const line = text.slice(0, text.indexOf(newStr.slice(0, 20) || '')).split(/\r?\n/).length;
  return {
    path: p,
    changes: hits.length,
    before,
    after: text.length,
    delta: text.length - before,
    line,
  };
}

/* ---------------- 设目标（对应 dsh 的 goal） ---------------- */

function goalSet(text, opts = {}) {
  const { stateDir } = opts;
  if (!stateDir) throw new Error('没给 stateDir');
  const p = resolve(stateDir, 'goal.md');
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (!text || !String(text).trim()) {
    // 空 = 读当前的
    if (!existsSync(p)) return { text: '', set: false };
    return { text: readFileSync(p, 'utf8'), set: true, path: p };
  }
  const body = '# 当前目标\n\n' + String(text).trim() + '\n\n（设于 ' + now + '）\n';
  writeFileSync(p, body, 'utf8');
  return { text: String(text).trim(), set: true, path: p, at: now };
}

/* ---------------- 发一组文件（对应 WorkBuddy 的 present_files） ---------------- */

function batchFileList(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('要给一组路径');
  const ok = [];
  const bad = [];
  for (const raw of paths) {
    const p = absPath(raw);
    if (!existsSync(p)) { bad.push({ path: p, why: '不存在' }); continue; }
    const st = statSync(p);
    ok.push({ path: p, size: st.size, dir: st.isDirectory() });
  }
  return { ok, bad };
}

/* ---------------- 反复做到过（对应 dsh 的 ralph） ---------------- */

/**
 * 不是自己在那儿循环 —— 是给她一个「验收口诀」：说清什么算过、用什么命令验、最多试几轮。
 * 真跑还是她自己跑 run_command，这儿只负责把状态记下来、别一轮一轮重来。
 */
function ralphPlan(goal, checkCmd, opts = {}) {
  const { stateDir } = opts;
  const maxRounds = Number(opts.maxRounds) || 5;
  if (!goal || !checkCmd) throw new Error('得说清「要做到什么」和「拿什么验」');
  if (!stateDir) throw new Error('没给 stateDir');
  const p = resolve(stateDir, 'ralph.md');
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  let round = 1;
  let log = '';
  if (existsSync(p)) {
    const old = readFileSync(p, 'utf8');
    const m = old.match(/第 (\d+) 轮/);
    if (m) round = Number(m[1]) + 1;
    log = old;
  }
  const rec = '# 反复做到过\n\n' +
    '目标：' + goal.trim() + '\n' +
    '验收命令：`' + checkCmd.trim() + '`\n' +
    '第 ' + round + ' 轮 / 最多 ' + maxRounds + ' 轮\n' +
    '更新于 ' + now + '\n';
  writeFileSync(p, rec + (log && round > 1 ? '\n---\n' + log : ''), 'utf8');
  return { round, maxRounds, over: round > maxRounds, path: p, goal: goal.trim(), checkCmd: checkCmd.trim() };
}

/* ---------------- 翻轮次（对应 dsh 的 session_trace） ---------------- */

/**
 * 把这一轮里每个工具调用按顺序列出来：第几次、什么工具、成没成、错在哪。
 * 数据来源是会话文件里的 tool 消息 —— 不用翻整个 json，只挑要的那段。
 */
function traceTurns(messages, opts = {}) {
  const limit = Number(opts.limit) || 40;
  if (!Array.isArray(messages)) return { rounds: [], note: '没有消息可看' };

  const rounds = [];
  let cur = null;
  let idx = 0;

  for (const m of messages) {
    const role = m && m.role;
    if (role === 'user') {
      idx += 1;
      cur = { round: idx, calls: [] };
      rounds.push(cur);
      continue;
    }
    if (!cur) { cur = { round: ++idx, calls: [] }; rounds.push(cur); }
    if (role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        cur.calls.push({
          tool: (tc.function && tc.function.name) || tc.name || '?',
          args: String((tc.function && tc.function.arguments) || '').slice(0, 120),
          ok: null,
          err: '',
        });
      }
    } else if (role === 'tool') {
      const last = cur.calls[cur.calls.length - 1];
      if (last) {
        const body = String(m.content || '');
        const bad = /^\s*(ERROR|错误)|exit code [1-9]|失败/i.test(body);
        last.ok = !bad;
        if (bad) last.err = body.slice(0, 200);
      }
    }
  }

  const out = rounds.slice(-limit).map((r) => ({
    round: r.round,
    total: r.calls.length,
    failed: r.calls.filter((c) => c.ok === false).map((c) => ({ tool: c.tool, err: c.err })),
    tools: r.calls.map((c) => c.tool),
  }));

  return { rounds: out, roundsSeen: rounds.length };
}

export { editFile, goalSet, batchFileList, ralphPlan, traceTurns, absPath };
