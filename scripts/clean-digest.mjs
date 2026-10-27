/**
 * 清掉会话记忆本里被反复灌进去的同一句话。
 *
 * 【为什么会有这个脚本】
 * 2026-10-27 主人报「时间循环」：我每轮醒来都在说同一句「她跑偏了」。
 * 查下来不是压缩坏了、不是数据丢了 —— 是记忆本里同一条被记了 10 次：
 *   醒来 → 读记忆本（第一条就是「她跑偏了」）→ 照着复读 → 自动记一笔 → 又多一条
 * 越滚越多，我永远卡在最老的那句话上。
 *
 * 所以治法是：把记忆本里重复的条目清掉，只留最新的那条，
 * 再把「循环备忘」写进固定记忆，让下一轮醒来看见的头一句就是「别复读」。
 *
 * 用法：
 *   node scripts/clean-digest.mjs <会话id>          # 清重复
 *   node scripts/clean-digest.mjs <会话id> --dry    # 只看会清哪些
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const DATA = process.env.MINI_AGENT_DATA
  || join(process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming'), '小鱼Agent', 'data');

const sid = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!sid) {
  console.log('用法: node scripts/clean-digest.mjs <会话id> [--dry]');
  process.exit(1);
}

const file = join(DATA, '.state', 'memory', sid + '.md');
if (!existsSync(file)) {
  console.log('没有这个会话的记忆本: ' + file);
  process.exit(1);
}

const text = readFileSync(file, 'utf8');
const lines = text.split('\n');

/**
 * 判重指纹：取正文里一段「有辨识度」的片段。
 * 只取前 40 字不够 —— 同一条话开头都一样，后面才是内容。
 * 取法：去掉标点空白，取中间那段的字符。
 */
function fingerprint(line) {
  const body = line.replace(/^- R\d+ \[[^\]]*\] 摘要：/, '').trim();
  const norm = body.replace(/[（）()「」【】\s*·—…]/g, '');
  // 用整句的哈希代替：简单起见取长度 + 首20 + 中20 + 尾20
  return norm.length + '|' + norm.slice(0, 20) + '|' + norm.slice(Math.floor(norm.length / 2), Math.floor(norm.length / 2) + 20) + '|' + norm.slice(-20);
}

const seen = new Map(); // fingerprint -> 最新那条的行号
const keep = [];
const dropped = [];

for (const line of lines) {
  if (!/^- R\d+ \[/.test(line)) {
    keep.push(line);
    continue;
  }
  const fp = fingerprint(line);
  if (seen.has(fp)) {
    // 重复：把之前保留的那条标成丢弃，留这一条（新的）
    const prevIdx = seen.get(fp);
    const prev = keep[prevIdx];
    if (prev !== null) {
      dropped.push(prev.slice(0, 80) + '…');
      keep[prevIdx] = null;
    }
    seen.set(fp, keep.length);
    keep.push(line);
  } else {
    seen.set(fp, keep.length);
    keep.push(line);
  }
}

const cleaned = keep.filter((x) => x !== null).join('\n');

console.log('原记忆本: ' + text.length + ' 字, ' + lines.filter((l) => /^- R\d+ \[/.test(l)).length + ' 条摘要');
console.log('清完:     ' + cleaned.length + ' 字, ' + cleaned.split('\n').filter((l) => /^- R\d+ \[/.test(l)).length + ' 条摘要');
console.log('去掉重复: ' + dropped.length + ' 条');
if (dropped.length) {
  console.log('');
  console.log('去掉的是（前 3 条示例）:');
  dropped.slice(0, 3).forEach((d) => console.log('  · ' + d));
}

if (!DRY) {
  writeFileSync(file, cleaned, 'utf8');
  console.log('');
  console.log('已写回: ' + file);
} else {
  console.log('');
  console.log('（--dry，没有写入）');
}
