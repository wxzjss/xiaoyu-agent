#!/usr/bin/env node
/**
 * check-agent-signature.mjs — 【署名不许跟着「现在谁主事」漂移】
 *
 * 【2026-11-17 主人报的三个症状，查下来是同一个病根】
 *   ① 「禁用前三个只启用鲸鱼娘，我说话时却还是小鲸在回复」
 *   ② 「把鲸鱼娘拖动到最上面时，她署名的回复会连着回两句话，
 *       且还不一定真的是鲸鱼娘在说话」
 *   ③ 「平时全开着，轮到鲸鱼娘说话时，她以小鱼的名义说话、替小鱼说话」
 *
 * 病根四处：
 *   A. 主智能体是**小鱼**时，落盘**不写 _who**（旧约定「空署名 = 小鱼」）。
 *      主人一把别人拖上去当主讲，那些空署名老消息重绘时被兜底成**现在**的主智能体
 *      → 当年小鱼说的话，现在挂着鲸鱼娘的名字。「不一定真的是她在说」就是这个。
 *   B. `publicSession` 的兜底直接 `return mainNameOfSession`
 *      —— 拿「现在谁当家」去猜「当年是谁说的」，历史被改写。
 *   C. `speakerOf` 最后 `|| '小鱼'` 硬编码。主智能体不是小鱼时，
 *      没署名的历史行全被标成「小鱼：…」，鲸鱼娘读着就跟着以小鱼口吻接。
 *   D. `buildCardMessages` 无条件写「记录里『X』是主智能体，**不是你**」——
 *      轮到主智能体本人说话时这句自相矛盾（告诉鲸鱼娘「鲸鱼娘不是你」），
 *      她只好另找个身份演，于是「像两个人连着说两遍」。
 *
 * 这个哨兵钉住这四条，防止哪天又改回去。
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('群聊 / 署名与身份');
const srv = fs.readFileSync('src/server.mjs', 'utf8');
const grp = fs.readFileSync('src/group.mjs', 'utf8');

const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .replace(/^\s*\/\/.*$/gm, ' ');
const srvCode = stripComments(srv);
const grpCode = stripComments(grp);

/* ── A. 落盘一律写署名，不再「小鱼=空」 ── */
t.ok('落盘时主智能体一律写 _who（不再排除小鱼）',
  /m\._who = String\(__ag\.name\)/.test(srvCode)
  /* 精确判「包住写 _who 的那个 if」有没有排除小鱼 ——
   * `else if (__mid !== AGENT_XIAOYU) m._card = …` 是另一回事（小鱼不是自建卡，
   * 不该记 _card），那是对的，别误伤。 */
  && !/if \(__mid && __mid !== AGENT_XIAOYU\)/.test(srvCode));
t.ok('同时写 _whoId（换名后还能反查）', /m\._whoId = String\(__mid\)/.test(srvCode));

/* ── B. publicSession 不许拿「现在的主智能体」兜底历史 ── */
{
  const at = srvCode.indexOf('who: (() => {');
  const end = srvCode.indexOf('})(),', at);
  const body = at >= 0 ? srvCode.slice(at, end) : '';
  t.ok('找得到 publicSession 的 who 判据', body.length > 200);
  t.ok('不再 return mainNameOfSession 兜底', !/return mainNameOfSession \|\| undefined/.test(body));
  t.ok('认 _whoId 反查名字', /m\._whoId/.test(body));
  t.ok('查不到就如实交 undefined（不编人）', /return undefined;/.test(body));
}

/* ── C. speakerOf 不许硬编码「小鱼」 ── */
t.ok('speakerOf 不再硬编码小鱼兜底',
  !/who \|\| String\(mainName \|\| ''\)\.trim\(\) \|\| '小鱼'/.test(grpCode));
t.ok('speakerOf 有「有人」这个中性别名', /'有人'/.test(grpCode));

/* ── D. 主智能体本人说话时不许说「不是你」 ── */
t.ok('buildCardMessages 有 iAmMain 分支', /const iAmMain = /.test(grpCode));
t.ok('iAmMain 时明说「就是你自己」', /你就是这一轮的主智能体/.test(grpCode));
t.ok('iAmMain 时禁止换身份说话', /别换成别的名字说话/.test(grpCode));

/* ── E. 「小鲸抢答」：牌子关着就不许走旁白路 ── */
t.ok('小鱼不在分支看牌子（不只是 whaleOn）', /__whaleEnabledByCard/.test(srvCode));

t.done();
