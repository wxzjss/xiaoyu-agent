/**
 * 清理会话记忆本里「同一句话反复写」的垃圾条目。
 *
 * 【为什么要有这个】
 * 2026-10-26 主人说「记忆被清空了」，查下来发现：
 * 干活鱼那个会话的记忆本里，19 条摘要几乎一模一样，
 * 全是同一段「她跑偏了…」——当时编辑消息时把原文和改写版一起存进去了，
 * 加上那阵子在同一个地方打转，同一句话写了十九遍。
 * 20 条上限一满，真正有用的内容就被挤得看不见了。
 * 看起来像「记忆没了」，其实是被垃圾淹了。
 *
 * 【怎么清】
 * 不删条目，只做两件事：
 *   一、同一条里同一段话重复出现的，压成一次；
 *   二、相邻条目内容高度相似的，只留最早那条，后面的进归档。
 *
 * 归档段留在同一个文件的「## 归档」下面 —— 主人想看还看得到，一条不丢。
 *
 * 用法：
 *   node scripts/clean-digest.mjs <会话id> [--dry]
 *   node scripts/clean-digest.mjs --all [--dry]
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

function dataDir() {
  if (process.env.MINI_AGENT_DATA) return process.env.MINI_AGENT_DATA;
  const appData = process.env.APPDATA || join(process.env.USERPROFILE || '.', 'AppData', 'Roaming');
  return join(appData, '小鱼Agent', 'data');
}

const MEM_DIR = join(dataDir(), '.state', 'memory');
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const ALL = args.includes('--all');
const target = args.find((a) => !a.startsWith('--'));

/**
 * 把一条摘要里「重复出现的那段话」压成一次。
 *
 * 认法：如果同一条里某段文字（长度 > 30）出现了两次以上，只留第一次。
 * 这是给「原文 + 主人改成」那种自我重复用的。
 */
function dedupeInLine(line) {
  // 先按明显的分界切开
  const m = line.match(/^(.*?)(（主人把这句话改成了：.*)?$/s);
  if (!m) return line;
  let body = m[1];

  // 反复找「重复的子串」：从长度 60 起，找出现 2 次以上的最长前缀
  for (let len = Math.floor(body.length / 2); len >= 40; len--) {
    const head = body.slice(0, len);
    const firstAt = body.indexOf(head);
    const secondAt = body.indexOf(head, firstAt + 1);
    if (secondAt > 0) {
      body = body.slice(0, secondAt).trim();
      break;
    }
  }
  return body.trim();
}

/** 粗略判断两条摘要是不是在说同一件事（取前 60 字比对） */
function sameKind(a, b) {
  const key = (s) => s.replace(/^-\s+R\d{4}\s*\[[^\]]*\]\s*摘要：/, '').replace(/\s+/g, '').slice(0, 60);
  return key(a) === key(b);
}

function cleanOne(file) {
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n');
  const DIGEST_HEAD = '## 滚动摘要';
  const ARCHIVE_HEAD = '## 归档';

  // 找出滚动摘要段的范围
  const hi = lines.findIndex((l) => l.trim().startsWith(DIGEST_HEAD));
  if (hi < 0) return { file, skipped: '没有滚动摘要段' };

  let end = lines.length;
  for (let k = hi + 1; k < lines.length; k++) {
    if (/^##\s/.test(lines[k])) {
      end = k;
      break;
    }
  }

  const secBefore = lines.slice(0, hi + 1);
  const secBody = lines.slice(hi + 1, end);
  const secAfter = lines.slice(end);

  const entries = secBody.filter((l) => /^-\s+R\d{4}/.test(l));
  const others = secBody.filter((l) => !/^-\s+R\d{4}/.test(l));

  /**
   * 全局判重，不是只看相邻。
   *
   * 【为什么要改】第一版只跟「前一条」比，结果：
   *   废话A / 有用的B / 废话A / 有用的C / 废话A …
   * 每条废话前面都隔着一个有用的，谁都跟前面的不像，一条也折不掉。
   * 实测 20 条里 14 条是同一句废话，清完还剩 4 条 —— 就是这个原因。
   *
   * 现在把「已经见过的内容」全记下来，不管隔多远，像就折。
   */
  const kept = [];
  const folded = [];
  const seen = [];
  for (const l of entries) {
    const fixed = dedupeInLine(l);
    const dup = seen.some((prev) => sameKind(prev, fixed));
    if (dup) {
      folded.push(l);
      continue;
    }
    seen.push(fixed);
    kept.push(fixed);
  }

  if (!folded.length && kept.every((l, i) => l === entries[i])) {
    return { file, changed: false, total: entries.length, kept: entries.length, folded: 0 };
  }

  // 折起来的进归档段
  let outLines = [...secBefore, ...kept, ...others, ...secAfter];
  if (folded.length) {
    const ai = outLines.findIndex((l) => l.trim().startsWith(ARCHIVE_HEAD));
    if (ai >= 0) {
      outLines.splice(ai + 1, 0, ...folded);
    } else {
      outLines = outLines.concat(['', ARCHIVE_HEAD, ...folded, '']);
    }
  }

  if (!DRY) writeFileSync(file, outLines.join('\n'), 'utf8');
  return { file, changed: true, total: entries.length, kept: kept.length, folded: folded.length };
}

const files = ALL
  ? readdirSync(MEM_DIR).filter((f) => f.endsWith('.md')).map((f) => join(MEM_DIR, f))
  : target
    ? [join(MEM_DIR, target + '.md')]
    : [];

if (!files.length) {
  console.log('用法: node scripts/clean-digest.mjs <会话id> | --all  [--dry]');
  process.exit(0);
}

let touched = 0;
for (const f of files) {
  if (!existsSync(f)) {
    console.log('找不到: ' + f);
    continue;
  }
  const r = cleanOne(f);
  const name = f.split(/[\\/]/).pop();
  if (r.skipped) {
    console.log(`${name}  跳过（${r.skipped}）`);
  } else if (!r.changed) {
    console.log(`${name}  干净（${r.total} 条）`);
  } else {
    touched++;
    console.log(`${name}  清理：${r.total} 条 → 留 ${r.kept} 条，折进归档 ${r.folded} 条${DRY ? '（预览，没写）' : ''}`);
  }
}
console.log('');
console.log(`处理完：${touched} 个文件有改动` + (DRY ? '（--dry 预览模式，什么都没写）' : ''));
