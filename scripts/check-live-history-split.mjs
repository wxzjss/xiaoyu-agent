#!/usr/bin/env node
/**
 * 【2026-11-09 主人报·调用工具/思考/发消息过程中按 F5，又多段消息堆一块】
 *
 * 病根：开跑时历史只砍**最后一条** assistant。可一轮只要
 * 「说一段 → 调工具 → 再说一段」，历史里已经落了 3 条；
 * 只砍最后一条，前两条留在屏上，直播快照又整轮重画一遍 → 屏幕上两份。
 *
 * 这条检查把 trimTurnsForLive 抽出来真跑，钉住「砍到这一轮主人开口为止」。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CHAT = fs.readFileSync(path.join(ROOT, 'public/ui/chat.js'), 'utf8').replace(/\r\n/g, '\n');
/* 【2026-11-09 换框架】trimTurnsForLive 搬到了 src-ui/items.js ——
 * 那里是「turns + liveItems → 屏幕上那几段」的唯一算法（React 渲染层的输入）。
 * 判据跟着算法走：谁在算分段就查谁，不查已经不存在的 DOM 路径。 */
const ITEMS = fs.readFileSync(path.join(ROOT, 'src-ui/items.js'), 'utf8').replace(/\r\n/g, '\n');

let pass = 0;
let fail = 0;
const t = {
  ok(name, cond, extra) {
    if (cond) { pass++; console.log('  OK  ' + name); }
    else { fail++; console.log('  [!!] ' + name + (extra ? '  →  ' + extra : '')); }
  },
};

function grab(src, name) {
  const i = src.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('找不到 ' + name);
  const j = src.indexOf('{', i);
  let d = 0;
  for (let k = j; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) return src.slice(i, k + 1); }
  }
  throw new Error(name + ' 大括号没配平');
}

const { trimTurnsForLive } = new Function(grab(ITEMS, 'trimTurnsForLive') + '\nreturn { trimTurnsForLive };')();

const U = (text) => ({ role: 'user', text });
const A = (text, tools = null) => (tools ? { role: 'assistant', text: '', tools } : { role: 'assistant', text });

console.log('\n一、一轮跑到一半（说→工具→说）：历史只留到主人那句话');

{
  const turns = [U('帮我看看'), A('我看看'), A('', [{ name: 'read_file' }]), A('找到了')];
  const kept = trimTurnsForLive(turns);
  t.ok('只留主人那句，后半轮全交给直播', kept.length === 1 && kept[0].role === 'user', '剩 ' + kept.length + ' 条');
}

{
  /* 多轮历史 + 最后一轮在跑：前面几轮要留着，不能被一起砍掉 */
  const turns = [U('第一句'), A('第一轮的回答'), U('第二句'), A('我查查'), A('', [{ name: 'run' }]), A('查完了')];
  const kept = trimTurnsForLive(turns);
  t.ok('前面的完整轮次原样保留', kept.length === 3 && kept[2].role === 'user', JSON.stringify(kept.map((x) => x.role)));
  t.ok('砍的位置正好是「最后一条主人说的话」之后', kept[2].text === '第二句');
}

console.log('\n二、没有主人那句话时，退回老口径（只砍最后一条）');

{
  const turns = [A('续跑前说的'), A('续跑接着说的')];
  const kept = trimTurnsForLive(turns);
  t.ok('没有 user → 只砍最后一条 assistant', kept.length === 1 && kept[0].text === '续跑前说的');
}

{
  const turns = [];
  t.ok('空历史不出错', Array.isArray(trimTurnsForLive(turns)) && trimTurnsForLive(turns).length === 0);
  t.ok('非数组不出错', trimTurnsForLive(null) === null);
}

console.log('\n三、源码层面钉住「别再退回只砍一条」');

/**
 * 【2026-11-09 判据改口径 —— 为什么这三条过时了】
 *
 * 原来钉的是「chat.js 的 renderLog / renderTurns 里调了 trimTurnsForLive」。
 * 那是**实现位置**，不是行为：换 React 之后那两条手写 DOM 路径整个删了，
 * 「历史画到哪儿为止」只在 src-ui/items.js 的 buildMerged 里算一次。
 *
 * 所以改成钉「算分段的那一处真的用了它，而且别处不再各算一遍」——
 * 这正是原来那三条想守住的东西（别再退回「只砍最后一条」）。
 */
{
  t.ok('分段边界只有一处：src-ui/items.js 的 buildMerged 在跑着的时候调用 trimTurnsForLive',
    /const all = running \? trimTurnsForLive\(snap\.turns\) : snap\.turns;/.test(ITEMS));
  t.ok('chat.js 不再自己算这份边界（DOM 路径已删，不会两处各判一次）',
    !/trimTurnsForLive\(/.test(CHAT));
  t.ok('老写法「只 splice 最后一条 assistant」已经不在',
    !/turns\[i\]\.role === 'assistant'\) \{ turns\.splice\(i, 1\); break; \}/.test(CHAT + ITEMS));
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);
