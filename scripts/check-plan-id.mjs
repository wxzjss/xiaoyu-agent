/**
 * 清单 id 稳定性检查（2026-11-15）
 *
 * 为什么要有这个脚本：
 *   以前 plan.mjs 在 create / clear 时会把整张清单的 id 重新编号成 1..N，
 *   而打勾是按 id 定位的 —— id 一变，之前打的勾就落到别人头上，
 *   表现就是「清单显示 10/66，实际全做完了」。
 *
 * 这个脚本证明两件事：
 *   ① 行为级：create / add / clear / 归档 怎么折腾，已有步骤的 id 都不变，勾不串行；
 *   ② 静态级：源码里不许再出现「id: <数组下标>+1」这种重排写法（防以后改回去）。
 *
 * 跑法：node scripts/check-plan-id.mjs
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* 全程在临时目录里跑，绝不碰真实的 .state/plan */
const dir = mkdtempSync(join(tmpdir(), 'plan-id-'));
process.env.XIAOYU_DATA_DIR = dir;

const m = await import('../src/plan.mjs');
const { planAction } = m;

let pass = 0, fail = 0;
const bad = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; bad.push(name + (extra ? ' → ' + extra : '')); console.log('  ✗ ' + name + (extra ? ' → ' + extra : '')); }
}
const KEY = 'test-' + process.pid;

function view(key) {
  const st = m.loadPlan(key);
  return st.steps.map((s) => ({ id: s.id, text: s.text, status: s.status, pinned: !!s.pinned }));
}
function idOf(key, text) {
  const s = view(key).find((x) => x.text === text);
  return s ? s.id : null;
}
const asIds = (arr) => JSON.stringify(arr.map((x) => x.id));

console.log('\n【1】create：老步骤 id 原样保留，新步骤接在后面');
planAction(KEY, { action: 'create', goal: 'g1', steps: ['A', 'B', 'C'] });
let v = view(KEY);
ok('三条 id = 1,2,3', asIds(v) === '[1,2,3]', asIds(v));

planAction(KEY, { action: 'update', stepId: idOf(KEY, 'B'), status: 'done' });
ok('B 打勾后仍是 done', view(KEY).find((x) => x.text === 'B').status === 'done');

/* 再 create 一次（追加）—— 老写法这里会把 id 全部重排，勾就串行了 */
planAction(KEY, { action: 'create', goal: 'g1', steps: ['D', 'E'] });
v = view(KEY);
ok('追加后 A/B/C 的 id 没变（1,2,3）', asIds(v.slice(0, 3)) === '[1,2,3]', asIds(v));
ok('追加后 B 还是 done，勾没串行', v.find((x) => x.text === 'B').status === 'done');
ok('新步骤 D/E 接在后面（4,5）', asIds(v.slice(3)) === '[4,5]', asIds(v.slice(3)));

console.log('\n【2】create 重复文本：不重复记，且不重排 id');
planAction(KEY, { action: 'create', goal: 'g1', steps: ['A', 'B', 'C', 'D', 'E'] });
v = view(KEY);
ok('没有加出新行（还是 5 条）', v.length === 5, String(v.length));
ok('id 仍是 1..5', asIds(v) === '[1,2,3,4,5]', asIds(v));

console.log('\n【3】add：id 取 max+1，归档留下的空号不回收');
planAction(KEY, { action: 'add', text: 'F' });
ok('F 的 id = 6', idOf(KEY, 'F') === 6, String(idOf(KEY, 'F')));

console.log('\n【4】归档（done 超十步自动归档）后，剩下的步骤 id 一个都不变');
const key2 = KEY + '-arch';
planAction(key2, { action: 'create', goal: 'g2', steps: Array.from({ length: 12 }, (_, i) => 'S' + (i + 1)) });
const beforeIds = view(key2).filter((x) => x.text === 'S11' || x.text === 'S12').map((x) => x.id);
for (let i = 1; i <= 11; i++) planAction(key2, { action: 'update', stepId: i, status: 'done' });
const after = view(key2);
const afterIds = after.filter((x) => x.text === 'S11' || x.text === 'S12').map((x) => x.id);
ok('归档后 S11/S12 的 id 没前移', JSON.stringify(beforeIds) === JSON.stringify(afterIds), JSON.stringify(beforeIds) + ' vs ' + JSON.stringify(afterIds));
ok('归档摘掉最旧的那批（12 → 11）', after.length === 11, String(after.length));
planAction(key2, { action: 'add', text: 'S13' });
ok('归档后 add 的新步骤 id = 13（不撞 11/12）', idOf(key2, 'S13') === 13, String(idOf(key2, 'S13')));
planAction(key2, { action: 'update', stepId: afterIds[0], status: 'done' });
ok('打 S11 的勾只落在 S11 上', view(key2).find((x) => x.text === 'S11').status === 'done' && view(key2).find((x) => x.text === 'S12').status === 'pending');

console.log('\n【5】clear：钉死的 + 完成的留下来，id 沿用原号不重排');
const key3 = KEY + '-clear';
planAction(key3, { action: 'create', goal: 'g3', steps: ['P1', 'P2', 'P3', 'P4'] });
planAction(key3, { action: 'update', stepId: 1, status: 'done' });
planAction(key3, { action: 'update', stepId: 3, status: 'done' });
planAction(key3, { action: 'update', stepId: 2, pin: true });
const keptBefore = view(key3).filter((x) => x.status === 'done' || x.pinned).map((x) => x.id);
planAction(key3, { action: 'clear' });
const keptAfter = view(key3).map((x) => x.id);
ok('留下的 id 跟清空前一致', JSON.stringify(keptBefore) === JSON.stringify(keptAfter), JSON.stringify(keptBefore) + ' vs ' + JSON.stringify(keptAfter));
ok('留下的号沿用原号（不是被压成 1,2）', JSON.stringify(keptAfter) === JSON.stringify(keptBefore), JSON.stringify(keptAfter));

console.log('\n【6】update 打不存在的号：报错要把真号列出来，不能只说 1~N');
const r = planAction(key3, { action: 'update', stepId: 99, status: 'done' });
ok('报错里列出了现有的真号', /现有这些号/.test(r.text) && keptAfter.every((n) => r.text.includes(String(n))), r.text.split('\n')[0]);

console.log('\n【7】progress 跟实际状态对得上');
{
  const key5 = KEY + '-prog';
  planAction(key5, { action: 'create', goal: 'g5', steps: ['Q1', 'Q2', 'Q3', 'Q4'] });
  planAction(key5, { action: 'update', stepId: 2, status: 'done' });
  planAction(key5, { action: 'update', stepId: 4, status: 'done' });
  const txt = m.formatPlan(m.loadPlan(key5));
  ok('进度显示 2/4', /进度：2\/4/.test(txt), txt.split('\n')[1]);
  ok('打勾的那两行才带 ✔', (txt.match(/✔/g) || []).length === 2, (txt.match(/✔/g) || []).length + ' 个勾');
  ok('清单里的序号就是真 id', /^1\. .*Q1/m.test(txt) && /^4\. .*Q4/m.test(txt), txt.split('\n').slice(2).join(' / '));
}

/* ────────────────────────────────────────────────────────────
 * 【8】静态守门：源码里不许再出现「按数组下标重排 id」的写法。
 * 行为级只证明当下这一次对；这一层防以后有人手一抖又改回去。
 * ──────────────────────────────────────────────────────────── */
console.log('\n【8】静态守门：src/plan.mjs 里不许按序号重排 id');
{
  const src = readFileSync('src/plan.mjs', 'utf8');
  const lines = src.split(/\r?\n/);
  const guilty = [];
  /* 只盯「步骤」的重排：id: i+1 出现时，往上看 6 行内必须有 steps 的 map。
     notes 那行的 id: i+1 是笔记自己编号，跟步骤勾选无关，不算。 */
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    if (!/\bid\s*:\s*(?:i|idx|index|k|n)\s*\+\s*1\b/.test(line)) return;
    const win = lines.slice(Math.max(0, i - 6), i + 1).join('\n');
    if (/steps/.test(win) || /\.map\(\((?:s|st|step)\b/.test(win)) {
      guilty.push((i + 1) + ': ' + line.trim());
    }
  });
  ok('没有 id: <下标>+1 这种重排写法', guilty.length === 0, guilty.join(' | '));
  ok('nextStepId 存在（新号从最大号往下发）', /function nextStepId\s*\(/.test(src));
  ok('formatPlan 按 s.id 显示，不按数组下标', src.includes('safe.steps.map((s) => `${s.id}'));
  ok('loadPlan 遇到缺 id 的走 _fillId 补号', /_fillId\s*\(/.test(src));
}

console.log('\n────────────────────────');
console.log(`通过 ${pass} / 失败 ${fail}`);
/* 【2026-11-15 加·自己造的清单自己收】
 * 这个检查会以 test-<pid>(-arch/-clear/-prog) 的名义真写清单，以前写完就不管了 ——
 * 每跑一次往 .state/plan 留 12 个文件，攒到后来 check-plan-session 报「12 份孤儿清单」，
 * 看着像真 bug，其实是自己留的垃圾。收尾统一删掉（只删本进程这棵前缀）。 */
try {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const os = await import('node:os');
  const cfg = await import('../src/config.mjs');
  /* 两个可能的清单目录都扫一遍：仓库里跑用 config.dataDir，
   * 装好之后跑用 %APPDATA%\小鱼Agent\data —— 只清「本进程这棵前缀」的，别的一律不碰。 */
  const dirs = new Set([
    path.join(cfg.config.dataDir, '.state', 'plan'),
    path.join(os.homedir(), 'AppData', 'Roaming', '小鱼Agent', 'data', '.state', 'plan'),
  ]);
  let n = 0;
  for (const dir of dirs) {
    let list = [];
    try { list = fs.readdirSync(dir); } catch { continue; }
    for (const f of list) {
      if (f.startsWith(KEY)) { try { fs.unlinkSync(path.join(dir, f)); n++; } catch {} }
    }
  }
  if (n) console.log(`（已清理本次测试留下的 ${n} 个清单文件）`);
} catch { /* 清理失败不影响结论 */ }
if (fail) {
  console.log('失败项：');
  bad.forEach((b) => console.log('  - ' + b));
  process.exit(1);
}
console.log('全过 ✔');
