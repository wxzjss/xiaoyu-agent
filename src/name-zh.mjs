/**
 * name-zh.mjs —— 子 Agent / worker 的中文名字规矩（2026-11-13 主人钦点）。
 *
 * 主人原话：「系统里改子Agent命名必须中文」。
 *
 * 单独成一个文件，是为了不跟 tools.mjs 和 task-mode.mjs 绕成循环依赖 ——
 * 那两个文件互相 import，名字规矩放在哪儿都别扭，拎出来最干净。
 */

/* 合规矩的名字 = 有汉字，且一个英文字母都没有。
 *   「小鲸」「查价员」「阿蓝二」都算；
 *   「worker-1」「abc小鲸」「工-7」都不算（旧系统名带前缀，看着就不像名字）。 */
const ZH_RE = /\p{Script=Han}/u;
const EN_RE = /[A-Za-z0-9]/;
let _seq = 0;

function isZhNameLike(s) {
  return ZH_RE.test(s) && !EN_RE.test(s);
}

/* 阿拉伯数字 → 中文数字（只到 9999，够用） */
function zhNum(n) {
  const d = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const u = ['', '十', '百', '千'];
  n = Math.max(1, Math.floor(Number(n) || 1)) % 10000;
  const s = String(n);
  let out = '';
  let zero = false;
  for (let i = 0; i < s.length; i++) {
    const v = Number(s[i]);
    const pos = s.length - 1 - i;
    if (v === 0) { zero = true; continue; }
    if (zero && out) out += '零';
    zero = false;
    out += d[v] + u[pos];
  }
  /* 「一十二」读着别扭，收成「十二」 */
  return out.replace(/^一十/, '十') || '一';
}

/**
 * 合规矩就照用；不合规矩自动起一个纯中文名（fallback + 中文序号，如「工一」「小鲸二」）。
 * changed=true 带回去，让返回文案告诉调用方「已经改成这个名了」。
 */
export function enforceZhWorkerName(raw, fallback = '跑腿') {
  const s = String(raw == null ? '' : raw).trim();
  if (isZhNameLike(s)) return { name: s, changed: false };
  return { name: fallback + zhNum(++_seq), changed: true };
}

/** 只看名字合不合规矩，不改（给校验/展示用）。 */
export function isZhName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return isZhNameLike(s);
}
