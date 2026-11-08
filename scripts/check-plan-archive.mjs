/**
 * 【2026-11-08 加】已完成清单超十条要自动归档 —— 站岗
 *
 * 主人底线第 8 条原话：
 *   「已完成清单超过十条就归档并删掉最旧的那条，已完成的清单最多保留10条」
 *
 * 这条底线在提示词里躺了很久，代码里一个人都没数过它，清单一路涨到 64 条。
 * 所以它必须由机器自己执行，不能靠自觉。
 *
 * 这里真造一份清单来验，不读代码猜：
 *   ① 12 条已完成 → 从最老的搬走 2 条，清单上只剩 10 条
 *   ② 归档里原件留着，搬走的正是最老那 2 条
 *   ③ 最新的那两条还留在清单上
 *   ④ 没做完的一条都不许被搬走
 *   ⑤ 刚好 10 条（没超过）→ 一条不动
 */
import fs from 'node:fs';
import path from 'node:path';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('清单超十条归档');
const ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const KEY = '__gate_archive_' + Date.now();

const plan = await import('file:///' + ROOT.replace(/\\/g, '/') + '/src/plan.mjs?t=' + Date.now());
const cfg = await import('file:///' + ROOT.replace(/\\/g, '/') + '/src/config.mjs?t=' + Date.now());

const HIST = path.join(cfg.config.dataDir, '.state', 'plan', '_history');

// 【2026-11-08 加·自愈】以前只在正常跑完时清自己的探针，中途被打断（重启/掐掉）就留残骸，
// 日积月累攒了 140 份。现在开跑先把历史残骸扫干净，跑完再清一次。
{
  try {
    const dir = path.join(cfg.config.dataDir, '.state', 'plan');
    for (const f of fs.readdirSync(dir)) {
      if (/^__/.test(f)) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}
}

function histTexts() {
  const out = [];
  try {
    for (const f of fs.readdirSync(HIST)) {
      if (!f.startsWith(KEY) || !f.endsWith('.json')) continue;
      if (!f.includes('-done-over')) continue;
      const j = JSON.parse(fs.readFileSync(path.join(HIST, f), 'utf8'));
      for (const st of j.steps || []) out.push(st.text);
    }
  } catch {}
  return out;
}

// ── 1. 12 条已完成 → 只剩 10 条 ──
try { for (const f of fs.readdirSync(HIST)) if (f.startsWith(KEY)) fs.unlinkSync(path.join(HIST, f)); } catch {}

const steps12 = [];
for (let i = 1; i <= 12; i++) steps12.push('已完成第' + i + '步');
plan.planAction(KEY, { action: 'create', goal: '站岗探针', steps: steps12 });
for (let i = 1; i <= 12; i++) plan.planAction(KEY, { action: 'update', stepId: i, status: 'done' });

const s1 = plan.loadPlan(KEY);
const done1 = (s1.steps || []).filter((x) => x.status === 'done').length;
t.ok('12 条已完成 → 删最旧 2 条、只剩 10 条', done1 === 10 && (s1.steps || []).length === 10,
  '实际 done=' + done1 + ' 总数=' + (s1.steps || []).length);

const texts = histTexts();
t.ok('归档里留着被搬走那 2 条的原文', texts.length === 2, '归档抓到 ' + texts.length + ' 条');
t.ok('搬走的正是最老那 2 条', texts.includes('已完成第1步') && texts.includes('已完成第2步'),
  texts.join(','));
t.ok('最新那两条还留在清单上', texts.includes('已完成第11步') === false && texts.includes('已完成第12步') === false,
  '归档里不该有 11/12');

// ── 2. 没做完的不许被搬走 ──
const KEY2 = KEY + '_mix';
const mix = [];
for (let i = 1; i <= 15; i++) mix.push('混合第' + i + '步');
plan.planAction(KEY2, { action: 'create', goal: '混着来', steps: mix });
for (let i = 1; i <= 12; i++) plan.planAction(KEY2, { action: 'update', stepId: i, status: 'done' });
const s2 = plan.loadPlan(KEY2);
const pend2 = (s2.steps || []).filter((x) => x.status === 'pending');
const done2 = (s2.steps || []).filter((x) => x.status === 'done');
t.ok('没做完的还在（3 条）', pend2.length === 3, '剩下 pending=' + pend2.length);
t.ok('已完成的收到只剩 10 条', done2.length === 10, '实际 done=' + done2.length);
t.ok('剩下的确实是最后那 3 条', pend2.every((x) => /第1[345]步/.test(x.text)),
  pend2.map((x) => x.text).join(','));

// ── 3. 只有 10 条 → 一条不动 ──
const KEY3 = KEY + '_ten';
const ten = [];
for (let i = 1; i <= 10; i++) ten.push('刚好第' + i + '步');
plan.planAction(KEY3, { action: 'create', goal: '刚好十条', steps: ten });
for (let i = 1; i <= 10; i++) plan.planAction(KEY3, { action: 'update', stepId: i, status: 'done' });
const s3 = plan.loadPlan(KEY3);
t.ok('刚好 10 条 → 一条都不动', (s3.steps || []).length === 10, '实际=' + (s3.steps || []).length);

// 清理探针
for (const k of [KEY, KEY2, KEY3]) {
  try {
    const f = path.join(cfg.config.dataDir, '.state', 'plan', k + '.json');
    if (fs.existsSync(f)) fs.unlinkSync(f);
    const f2 = path.join(cfg.config.dataDir, '.state', 'plan', k + '.txt');
    if (fs.existsSync(f2)) fs.unlinkSync(f2);
  } catch {}
}
try {
  for (const f of fs.readdirSync(HIST)) if (f.startsWith(KEY)) fs.unlinkSync(path.join(HIST, f));
} catch {}

t.done();