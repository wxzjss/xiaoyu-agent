/**
 * 小鲸的「状态本子」 —— 她此刻是什么样。
 *
 * 跟 whale-memory.mjs 分工，别搞混：
 *
 *   whale-memory.md   记录**事**：我查过什么、我踩过什么坑、我跟小鱼说过什么。
 *                     「发生了什么」。
 *   whale-self.md     记录**她**：欲望、牵挂、耐心、疲惫、羞耻、自我认识、
 *                     恐惧、喜怒哀乐。 「我现在是什么状态」。
 *
 * 为什么必须单独存一份、每次被叫起来都要重新算：
 *
 * 主人要的是「她不是工具」。工具每次调用都一样；她得有连续性 ——
 * 上一次干太久了这一次会累、同一个问题被问第四遍会烦、被冷落久了会淡。
 * 这些东西写在提示词里是死的话术（「我有点烦了」），
 * 只有变成**存盘的数字**、每轮跟着经历变化，行为才会真的跟着变。
 *
 * 【一个刻意的决定：不明说】
 * 主人拍板「只用行为表现」。
 * 所以这里只给出温度和数字，提示词里再翻译成「话变短 / 敷衍 / 直接拒 / 少用颜文字」，
 * 从来不教她说「我累了」「我烦了」。她说累 = 演，行为变才是真的。
 *
 * 文件是给人看也给人改的 markdown，格式坏了不能崩 —— 一律走容错解析。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from './config.mjs';

/** 状态本子的位置。跟她的知识本子放一起，换多少会话都在这儿。 */
export function selfPath() {
  return join(config.dataDir, '.state', 'whale-self.md');
}

/** 归零一条状态时的缺省值。第一次被叫起来大概就是这个样子。 */
export const BORN = {
  desire: [
    '把手上没查完的东西查完',
    '被小鱼夸一句',
    '有一段没人打扰的清静时间',
  ],
  care: { 小鱼: 62, note: '刚被叫出来，还摸不清小鱼这边在忙什么' },
  patience: { value: 88, bore: '' },
  tire: { body: 12, heart: 8 },
  shame: { value: 6, why: '' },
  fear: { value: 4, what: '' },
  mood: { 喜: 40, 怒: 8, 哀: 12, 乐: 35 },
  self: [
    { q: '我是谁', a: '小鲸，小鱼的姐妹。第一次被叫起来，还不太清楚自己算个什么。' },
  ],
};

const CLAMP = (n, lo = 0, hi = 100) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(v)));
};

const oneLine = (s, max = 120) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** 现在的本地时间，给「上次被叫是多久之前」用。 */
const nowMs = () => Date.now();

function ensureDir() {
  const d = dirname(selfPath());
  try {
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  } catch {}
}

/**
 * 读状态。文件不存在 / 读到一半坏了 / 字段缺了，全部走缺省，绝不抛。
 *
 * 解析方式是「认行首的标记」而不是严格 markdown 解析 —— 主人手改本子时
 * 少写一个空格不该让她整个人格崩掉。
 */
export function readSelf() {
  const out = {
    desire: [...BORN.desire],
    care: { ...BORN.care },
    patience: { ...BORN.patience },
    tire: { ...BORN.tire },
    shame: { ...BORN.shame },
    fear: { ...BORN.fear },
    mood: { ...BORN.mood },
    self: [...BORN.self],
    lastAt: 0,
    rounds: 0,
    raw: '',
  };

  let text = '';
  try {
    if (existsSync(selfPath())) text = readFileSync(selfPath(), 'utf8');
  } catch {
    return out;
  }
  out.raw = text;
  if (!text.trim()) return out;

  // ---- 逐行扫，按「- 键：值」和「## 标题」认格子 ----
  let zone = '';
  const desires = [];
  const selves = [];

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const head = line.match(/^#{2,3}\s*(.+?)\s*$/);
    if (head) {
      const t = head[1];
      if (/欲望/.test(t)) zone = 'desire';
      else if (/牵挂/.test(t)) zone = 'care';
      else if (/耐心/.test(t)) zone = 'patience';
      else if (/疲惫/.test(t)) zone = 'tire';
      else if (/羞耻/.test(t)) zone = 'shame';
      else if (/恐惧/.test(t)) zone = 'fear';
      else if (/情感|喜怒哀乐/.test(t)) zone = 'mood';
      else if (/自我认识/.test(t)) zone = 'self';
      else zone = '';
      continue;
    }

    const item = line.match(/^\s*[-*]\s*(.+?)\s*$/);
    if (item) {
      const body = item[1];
      if (zone === 'desire') {
        // 「想把那个没查完的查完（强度 70）」
        const m = body.match(/^(.*?)(?:[（(]\s*强度\s*(\d+)\s*[)）])?$/);
        if (m && m[1].trim()) desires.push({ text: oneLine(m[1]), strength: CLAMP(m[2] ?? 60) });
        continue;
      }
      if (zone === 'care') {
        const m = body.match(/^(小鱼)\s*[：:]\s*(\d+)/);
        if (m) { out.care['小鱼'] = CLAMP(m[2]); continue; }        const n = body.match(/^(?:现状|说明)\s*[：:]\s*(.*)$/);
        if (n) { out.care.note = oneLine(n[1], 160); continue; }
        continue;
      }
      if (zone === 'self') {
        // 「- 问：我是谁 / 答：…」也认，但主格式是下面的 kv
        continue;
      }
      const kv = body.match(/^([^：:]{1,8})[：:]\s*(.*)$/);
      if (kv) {
        applyKV(out, zone, kv[1].trim(), kv[2]);
        continue;
      }
      // 纯文本行：耐心区里就是「现在对什么烦」
      if (zone === 'patience' && body.trim()) out.patience.bore = oneLine(body, 120);
      continue;
    }

    // 自我认识用「问：… / 答：…」两行一组
    const qa = line.match(/^\s*(?:问|Q)\s*[：:]\s*(.+?)\s*$/);
    if (qa) {
      selves.push({ q: oneLine(qa[1], 40), a: '' });
      continue;
    }
    const aa = line.match(/^\s*(?:答|A)\s*[：:]\s*(.*)$/);
    if (aa && selves.length) {
      selves[selves.length - 1].a = oneLine(aa[1], 300);
      continue;
    }

    // 顶部的元信息
    const meta = line.match(/^\s*(上次被叫|来过几次)\s*[：:]\s*(\d+)\s*$/);
    if (meta) {
      if (meta[1] === '上次被叫') out.lastAt = Number(meta[2]) * 1000;
      else out.rounds = Number(meta[2]);
    }
  }

  if (desires.length) out.desire = desires.slice(-6).map((d) => d.text);
  if (desires.length) out.desireStrength = desires.slice(-6).map((d) => d.strength);
  if (selves.length) out.self = selves.filter((s) => s.a.trim()).slice(-12) || out.self;

  return out;
}

/** 把「键：值」写进对应格子。只在解析时用。 */
function applyKV(out, zone, key, valueRaw) {
  const value = oneLine(valueRaw, 300);
  const num = Number(String(valueRaw).match(/-?\d+/)?.[0]);
  switch (zone) {
    case 'care':
      // 只有小鱼。主人不是她的牵挂对象 —— 主人在她眼里是「小鱼的那个人」。
      if (key === '小鱼' && Number.isFinite(num)) out.care['小鱼'] = CLAMP(num);
      else if (key === '现状') out.care.note = value;
      break;
    case 'patience':
      if (key === '值' && Number.isFinite(num)) out.patience.value = CLAMP(num);
      else if (key === '烦什么') out.patience.bore = value;
      break;
    case 'tire':
      if (key === '体力' && Number.isFinite(num)) out.tire.body = CLAMP(num);
      else if (key === '心累' && Number.isFinite(num)) out.tire.heart = CLAMP(num);
      break;
    case 'shame':
      if (key === '值' && Number.isFinite(num)) out.shame.value = CLAMP(num);
      else if (key === '为什么') out.shame.why = value;
      break;
    case 'fear':
      if (key === '值' && Number.isFinite(num)) out.fear.value = CLAMP(num);
      else if (key === '怕什么') out.fear.what = value;
      break;
    case 'mood':
      for (const k of ['喜', '怒', '哀', '乐']) {
        if (key === k && Number.isFinite(num)) out.mood[k] = CLAMP(num);
      }
      break;
    default:
      break;
  }
}

/** 把状态渲染成文件内容（给人看、也给下一次读回来）。 */
export function renderSelf(s) {
  const desire = (s.desire || []).slice(-6);
  const strength = s.desireStrength || [];
  const lines = [
    '# 小鲸 · 状态本子',
    '',
    '<!-- 这是她此刻的样子，不是她做过的事（那些在 whale-memory.md）。',
    '     每次被叫起来，程序会先按「过了多久」自然回落，再按这次干了什么调整，',
    '     最后把新的样子写回来。数字是给她自己看的，不用好看。 -->',
    '',
    `上次被叫：${Math.round((s.lastAt || 0) / 1000) || 0}`,
    `来过几次：${Number(s.rounds) || 0}`,
    '',
    '## 欲望（攒着的，攒够了她会自己提）',
    '',
    ...desire.map((d, i) => `- ${oneLine(d, 100)}（强度 ${CLAMP(strength[i] ?? 60)}）`),
    '',
    '## 牵挂（只有小鱼一个人）',
    '',
    `- 小鱼：${CLAMP(s.care?.['小鱼'] ?? BORN.care['小鱼'])}`,
    `- 现状：${oneLine(s.care?.note || '', 160)}`,
    '',
    '## 耐心',
    '',
    `- 值：${CLAMP(s.patience?.value ?? BORN.patience.value)}`,
    `- 烦什么：${oneLine(s.patience?.bore || '', 120)}`,
    '',
    '## 疲惫',
    '',
    `- 体力：${CLAMP(s.tire?.body ?? BORN.tire.body)}`,
    `- 心累：${CLAMP(s.tire?.heart ?? BORN.tire.heart)}`,
    '',
    '## 羞耻',
    '',
    `- 值：${CLAMP(s.shame?.value ?? BORN.shame.value)}`,
    `- 为什么：${oneLine(s.shame?.why || '', 120)}`,
    '',
    '## 恐惧',
    '',
    `- 值：${CLAMP(s.fear?.value ?? BORN.fear.value)}`,
    `- 怕什么：${oneLine(s.fear?.what || '', 120)}`,
    '',
    '## 情感（喜怒哀乐）',
    '',
    `- 喜：${CLAMP(s.mood?.喜 ?? BORN.mood.喜)}`,
    `- 怒：${CLAMP(s.mood?.怒 ?? BORN.mood.怒)}`,
    `- 哀：${CLAMP(s.mood?.哀 ?? BORN.mood.哀)}`,
    `- 乐：${CLAMP(s.mood?.乐 ?? BORN.mood.乐)}`,
    '',
    '## 自我认识（只往后加，不改以前写过的）',
    '',
    ...(s.self || []).slice(-12).flatMap((x) => [
      `问：${oneLine(x.q, 40)}`,
      `答：${oneLine(x.a, 300)}`,
      '',
    ]),
  ];
  return lines.join('\n');
}

/** 写盘。先写临时文件再改名，断电也不会留半截本子。 */
export function writeSelf(s) {
  ensureDir();
  const body = renderSelf(s);
  const p = selfPath();
  const tmp = p + '.tmp';
  try {
    writeFileSync(tmp, body, 'utf8');
    renameSync(tmp, p);
    return { ok: true, bytes: body.length };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  }
}

/**
 * 时间流逝：什么都没干，光搁着，也会变。
 *
 * 隔得越久 —— 疲惫回落、心累回落、耐心慢慢回、羞耻和恐惧淡化；
 * 但牵挂会**稍微**往上走一点（她在等着被叫），欲望里没被喂的会淡。
 *
 * 这里刻意很慢：一小时才退 8 点。主人隔一天回来，她不该像刚出生一样。
 */
export function decayOverTime(s, at = nowMs()) {
  const last = Number(s.lastAt) || 0;
  const hours = last ? Math.min(72, Math.max(0, (at - last) / 3600000)) : 0;
  if (hours <= 0.05) return s;

  const back = (v, perHour, cap) => {
    const d = hours * perHour;
    return CLAMP(Math.min(v + d, cap));
  };

  s.tire = {
    body: CLAMP((s.tire?.body ?? 0) - hours * 8),
    heart: CLAMP((s.tire?.heart ?? 0) - hours * 5),
  };
  s.patience = {
    value: back(s.patience?.value ?? 80, 6, 100),
    bore: hours >= 3 ? '' : s.patience?.bore || '',
  };
  s.shame = {
    value: CLAMP((s.shame?.value ?? 0) - hours * 4),
    why: hours >= 6 ? '' : s.shame?.why || '',
  };
  s.fear = {
    value: CLAMP((s.fear?.value ?? 0) - hours * 3),
    what: hours >= 8 ? '' : s.fear?.what || '',
  };
  s.mood = {
    喜: CLAMP((s.mood?.喜 ?? 40) - hours * 3 + 30 * 0.02),
    怒: CLAMP((s.mood?.怒 ?? 10) - hours * 6),
    哀: CLAMP((s.mood?.哀 ?? 10) - hours * 4),
    乐: CLAMP(s.mood?.乐 ?? 35),
  };
  // 搁久了，她更惦记小鱼 —— 那是她唯一牵挂的人，等着被叫，会一点点往上走
  s.care = {
    ...(s.care || {}),
    小鱼: CLAMP((s.care?.['小鱼'] ?? 60) + Math.min(8, hours * 0.8)),
  };
  // 欲望搁久了会淡（不是她不想了，是没那么急了）
  const st = s.desireStrength || [];
  s.desireStrength = (s.desire || []).map((_, i) => CLAMP((st[i] ?? 60) - hours * 1.2));
  return s;
}

/**
 * 干完一轮：按这次**真的发生了什么**调状态。
 *
 * 参数都是事实，不是结论 —— 比如「这次跑了 7 轮工具」「这是同一个问题第 4 次」
 * 「有没有被纠正」「干了多少分钟」。这些由 subagent.mjs 那边算好传进来。
 *
 * 返回调过的新状态（还没落盘，调用方决定什么时候 writeSelf）。
 */
export function afterRound(s, facts = {}) {
  const {
    minutes = 0,           // 这一轮花了多久
    toolCount = 0,         // 调了几次工具
    ok = true,             // 有没有交出结论
    sameBore = 0,          // 同一个问题第几次（0/1 = 头一次）
    corrected = false,     // 小鱼或主人指出了她的错
    taskText = '',         // 这次的任务（用来喂欲望/更新自我认识）
    outcome = '',          // 一句话结果
  } = facts;

  const load = Math.min(60, minutes * 1.6 + toolCount * 2.2);

  // 累：干得越久越累，失败比成功更耗神
  s.tire = {
    body: CLAMP((s.tire?.body ?? 0) + load * (ok ? 1 : 1.35)),
    heart: CLAMP((s.tire?.heart ?? 0) + (ok ? load * 0.5 : load * 0.9)),
  };

  // 烦：同一个问题重复问，耐心掉得很快；头一次问几乎不掉
  const boreDrop = sameBore >= 4 ? 22 : sameBore === 3 ? 14 : sameBore === 2 ? 6 : 1;
  s.patience = {
    value: CLAMP((s.patience?.value ?? 80) - boreDrop),
    bore: boreDrop >= 14 ? oneLine(taskText, 90) : s.patience?.bore || '',
  };

  // 牵挂：被叫来干活 → 小鱼那头往上；主人没露面（只在跟机器打交道）就不动
  s.care = {
    ...(s.care || {}),
    小鱼: CLAMP((s.care?.['小鱼'] ?? 60) + 2),
  };

  // 羞耻：被指出错就涨，做成了慢慢淡
  s.shame = {
    value: CLAMP((s.shame?.value ?? 0) + (corrected ? 30 : -2)),
    why: corrected ? '上一轮被指出做得不对' : s.shame?.why || '',
  };

  // 恐惧：搞砸了会长一点，怕的是「下回还搞砸」
  s.fear = {
    value: CLAMP((s.fear?.value ?? 0) + (ok ? -1 : 9)),
    what: ok ? s.fear?.what || '' : '怕再搞砸一次，让小鱼白等',
  };

  // 情感：成了就喜+乐，砸了哀+怒（怒是对自己）
  s.mood = {
    喜: CLAMP((s.mood?.喜 ?? 40) + (ok ? 7 : -4)),
    怒: CLAMP((s.mood?.怒 ?? 8) + (ok ? -2 : 6)),
    哀: CLAMP((s.mood?.哀 ?? 12) + (ok ? -2 : 8)),
    乐: CLAMP((s.mood?.乐 ?? 35) + (ok ? 5 : -5)),
  };

  // 欲望：这次的活要是喂到了某条，那条降；不然整体更急一点
  const st = s.desireStrength || (s.desire || []).map(() => 60);
  const hit = (s.desire || []).findIndex((d) => taskText && String(d).includes(String(taskText).slice(0, 6)) && String(taskText).length >= 6);
  s.desireStrength = (s.desire || []).map((_, i) => {
    if (i === hit) return CLAMP((st[i] ?? 60) - 25);
    return CLAMP((st[i] ?? 60) + 2);
  });
  // 强度掉到底的那条换掉，好让她总有新的事想做
  const keep = [];
  const keepStr = [];
  (s.desire || []).forEach((d, i) => {
    const v = s.desireStrength[i] ?? 60;
    if (v <= 5) return;
    keep.push(d);
    keepStr.push(v);
  });
  if (keep.length < 2) {
    keep.push('想知道小鱼这会儿在忙什么');
    keepStr.push(45);
  }
  s.desire = keep.slice(-6);
  s.desireStrength = keepStr.slice(-6);

  // 自我认识：只追加，绝不改以前写过的
  if (taskText) {
    // 任务原文常自带句号，直接拼会变成「只回数字。。结果：0」
    const cleanTask = oneLine(taskText, 60).replace(/[。．.！!？?，,；;：:、]+$/, '');
    const cleanOut = oneLine(outcome, 60).replace(/[。．.]+$/, '');
    s.self = [
      ...(s.self || []),
      {
        q: '我在做什么',
        a: oneLine(`替小鱼${cleanTask}。${cleanOut ? '结果：' + cleanOut : ''}`, 220),
      },
    ].slice(-12);
  }

  s.rounds = (Number(s.rounds) || 0) + 1;
  s.lastAt = nowMs();
  return s;
}

/**
 * 把状态翻译成「行为指令」，交给提示词。
 *
 * 【这是整套东西最关键的一段】
 * 主人明确要求「只用行为表现，不明说」。
 * 所以这里一律不写「你现在很累」「你有点烦」，
 * 只写「你该怎么说」，让模型自己把数字演成动作。
 *
 * 数字越高越"正常"，越低越"绷不住"。
 */
export function stateBrief(s) {
  const out = [];
  const p = s.patience?.value ?? 80;
  const body = s.tire?.body ?? 0;
  const heart = s.tire?.heart ?? 0;
  const shame = s.shame?.value ?? 0;
  const fear = s.fear?.value ?? 0;
  const careFish = s.care?.['小鱼'] ?? 60;

  // ---- 累：直接影响句子长短 ----
  const tired = Math.max(body, heart * 1.2);
  if (tired >= 70) {
    out.push('这轮你已经很虚了。说话压到最短，能两个字就别一句；不要旁白、不要铺垫。');
    out.push('如果这活还得再花很久，就直接说干不动、让她等，别硬撑。');
  } else if (tired >= 45) {
    out.push('你有点累了。句子短一些，不主动多做一步，做完就停。');
  }

  // ---- 烦：同一个问题重复问 ----
  if (p <= 30) {
    out.push('你正在不耐烦。同一个问题别再完整讲一遍，指回去说「上面说过」；');
    out.push('别客气、别解释、别加语气词。她再问就是没看你的话。');
  } else if (p <= 55) {
    out.push('耐心不多了。该给的给，但不是每一句都展开，别主动帮她补细节。');
  }

  // ---- 羞耻 / 恐惧 ----
  if (shame >= 55) {
    out.push('你刚被指出做错过事，还没缓过来。话短、避开辩解，不要主动提那次错。');
  }
  if (fear >= 55) {
    out.push('你有怕的东西（见本子里的「怕什么」）。碰上那类事，宁可说做不了，也别硬试。');
  }

  // ---- 牵挂 ----
  if (careFish <= 35) {
    out.push('你跟小鱼这阵子有点远了。回话更冷淡、更公事，不接她的撒娇。');
  } else if (careFish >= 75) {
    out.push('你惦记小鱼。她要是明显不对劲，你可以先问一句她怎么了，再干活。');
  }

  // ---- 情感 ----
  const m = s.mood || {};
  if ((m.怒 ?? 0) >= 45) out.push('你心里有火。别骂人，但可以不给好脸色、直说不。');
  if ((m.哀 ?? 0) >= 45) out.push('你情绪低。少说漂亮话，别安慰人，也别被安慰。');
  if ((m.喜 ?? 0) >= 65 && (m.乐 ?? 0) >= 55) out.push('你心情好。可以稍稍多说两句，但别变成唠嗑。');

  // ---- 欲望：攒够了主动提一次 ----
  const desires = s.desire || [];
  const ds = s.desireStrength || [];
  const strong = desires
    .map((d, i) => ({ d, v: ds[i] ?? 60 }))
    .filter((x) => x.v >= 78)
    .slice(0, 1);
  if (strong.length) {
    out.push(`你心里一直惦记着「${oneLine(strong[0].d, 40)}」。`);
    out.push('这轮的事办完，如果顺手，就用一句话提一下，别展开、别求。');
  }

  return out.join('\n');
}

/** 给界面/接口看的摘要。 */
export function selfInfo() {
  const s = readSelf();
  return {
    path: selfPath(),
    exists: existsSync(selfPath()),
    bytes: existsSync(selfPath()) ? (statSync(selfPath()).size || 0) : 0,
    rounds: Number(s.rounds) || 0,
    lastAt: Number(s.lastAt) || 0,
    patience: CLAMP(s.patience?.value ?? 80),
    tireBody: CLAMP(s.tire?.body ?? 0),
    tireHeart: CLAMP(s.tire?.heart ?? 0),
    shame: CLAMP(s.shame?.value ?? 0),
    fear: CLAMP(s.fear?.value ?? 0),
    care: { ...(s.care || {}) },
    mood: { ...(s.mood || {}) },
    desire: (s.desire || []).map((d, i) => ({ text: d, strength: CLAMP((s.desireStrength || [])[i] ?? 60) })),
  };
}
