/**
 * check-plan-dup.mjs —— 清单重复的自动检测（红线：完全重复必须为 0）
 *
 * 主人原话：「清单内容有时候会重复，是为什么？修，同时增加自动检测完全重复的清单内容」
 *
 * 这个检查看两件事：
 *   ① **完全重复**（去掉空白/标点/序号后一字不差）→ 一条都不许有，有就是红；
 *   ② **近似重复**（同一实体、同一数字，措辞不同，Dice ≥ 0.72）→ 只警告不判红，
 *      因为这类要人眼确认（"跑第一次/跑第二次" 已经被指纹挡掉了，不会误报）。
 * 还会顺手确认 create/add 那两处查重逻辑没被人删掉 —— 那是根因修复，删了就白修。
 *
 * 用法：
 *   node scripts/check-plan-dup.mjs            只检查（默认查真实 .state/plan）
 *   node scripts/check-plan-dup.mjs --fix      把完全重复的合并掉（每个文件先备份）
 *   node scripts/check-plan-dup.mjs --dir=xxx  查指定目录（回归用假数据）
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const FIX = args.includes('--fix');
const dirArg = args.find((a) => a.startsWith('--dir='));
const PLAN_DIR = dirArg
  ? dirArg.slice(6)
  : join(process.env.APPDATA || '', '小鱼Agent', 'data', '.state', 'plan');

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  OK  ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  ← ' + detail : '')); }
};

const mod = await import('../src/plan.mjs');
const { normStepText, findSameStep, dedupeSteps } = mod;

/* ── ① 根因修复还在不在（防被回退） ───────────────────────────── */
function checkSource() {
  console.log('\n[源码] create / add 的查重逻辑');
  const src = readFileSync(join(ROOT, 'src', 'plan.mjs'), 'utf8');
  ok(/findSameStep\(/.test(src), 'create/add 调用了 findSameStep（近似重复也挡）');
  ok(/dedupeSteps\(state\)/.test(src), 'savePlan 落盘前会合并完全重复的');
  ok(/export function normStepText/.test(src), '归一化函数还在');
  const tools = readFileSync(join(ROOT, 'src', 'tools.mjs'), 'utf8');
  ok(/不是推倒重来/.test(tools), 'plan 工具说明讲清了「create 是接在后面」');
}

/* ── ② 判重行为本身对不对（假数据，不碰真实清单） ───────────────── */
function checkBehavior() {
  console.log('\n[行为] 该判重的判重、不该判重的不判');
  const S = (id, text) => ({ id, text, status: 'pending', note: '' });
  const cases = [
    ['读 run-all-checks.mjs，定位 spawn 方式与 stdio 配置（根因到行）', '读 run-all-checks.mjs 弄清 spawn 方式与 stdio 配置（已完成）', true, '同义改写'],
    ['出四行汇报', '交四行汇报', true, '近义短句'],
    ['修 src/a.mjs 的宽度', '修 src/b.mjs 的宽度', false, '换了对象，不是重复'],
    ['跑第一次全量回归', '跑第二次全量回归', false, '第一次/第二次 是两步'],
    ['读文件', '改文件', false, '两个字不同，语义完全不同'],
    ['跑回归', '跑回归。', true, '只差标点（完全重复）'],
  ];
  for (const [a, b, want, why] of cases) {
    const hit = findSameStep([S(1, a)], b);
    ok(!!hit === want, (want ? '应判重' : '不应判重') + '：' + why, hit ? '误判为 ' + hit.how : '没判出来');
  }
  const st = {
    steps: [
      S(5, '跑回归'),
      { id: 9, text: '跑回归。', status: 'done', note: '过了', toolCalls: 7, pinned: true },
    ],
  };
  const merged = dedupeSteps(st);
  ok(merged === 1 && st.steps.length === 1, '完全重复的两条合并成一条', 'merged=' + merged + ' len=' + st.steps.length);
  ok(st.steps[0].status === 'done', '合并后状态取「做过的」（不能把 done 变回 pending）', st.steps[0].status);
  ok(st.steps[0].id === 5, '合并后保留最小 id（勾还认得）', String(st.steps[0].id));
  ok(st.steps[0].pinned === true && st.steps[0].toolCalls === 7, '钉死与工具次数不丢');
}

/* ── ③ 真实清单扫一遍 ───────────────────────────────────────── */
function loadJson(f) {
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return null; }
}

function normAll(steps) {
  const map = new Map();
  for (const s of steps) {
    const k = normStepText(s && s.text);
    if (!k) continue;
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  return map;
}

function checkData() {
  console.log('\n[盘面] ' + PLAN_DIR);
  if (!existsSync(PLAN_DIR)) { console.log('  （目录不存在，跳过）'); return; }
  const files = readdirSync(PLAN_DIR).filter((f) => f.endsWith('.json') && !f.includes('.bak'));
  let exactTotal = 0;
  let nearTotal = 0;
  for (const f of files) {
    const abs = join(PLAN_DIR, f);
    const d = loadJson(abs);
    if (!d || !Array.isArray(d.steps) || !d.steps.length) continue;
    const groups = normAll(d.steps);
    const dups = [...groups.entries()].filter(([, arr]) => arr.length > 1);
    const near = [];
    const list = d.steps.filter((s) => s && typeof s.text === 'string');
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (normStepText(list[i].text) === normStepText(list[j].text)) continue; // 完全重复已单列
        if (findSameStep([list[j]], list[i].text)) near.push([list[i], list[j]]);
      }
    }
    if (!dups.length && !near.length) continue;
    console.log('  · ' + f + '（' + d.steps.length + ' 步）');
    for (const [k, arr] of dups) {
      if (!FIX) exactTotal++;   // --fix 就是把它们合并掉，合并过了就不再算红
      console.log('      完全重复 x' + arr.length + ' ids=' + arr.map((x) => x.id).join(',') + '  ' + k.slice(0, 40));
    }
    for (const [a, b] of near) {
      nearTotal++;
      console.log('      近似重复（警告）#' + a.id + ' ' + String(a.text).slice(0, 28) + '  ≈  #' + b.id + ' ' + String(b.text).slice(0, 28));
    }
    if (FIX && dups.length) {
      const bak = abs + '.bak-dup-' + new Date().toISOString().replace(/[:.]/g, '').slice(0, 15);
      copyFileSync(abs, bak);
      const before = d.steps.length;
      dedupeSteps(d);
      writeFileSync(abs, JSON.stringify(d, null, 2), 'utf8');
      console.log('      → 已合并：' + before + ' 步 → ' + d.steps.length + ' 步（备份 ' + bak.split(/[\\/]/).pop() + '）');
    }
  }
  ok(exactTotal === 0, '盘面上没有「完全重复」的清单步骤' + (exactTotal ? '（' + exactTotal + ' 组）' : ''), exactTotal ? '跑 --fix 可合并' : '');
  if (nearTotal) console.log('  （近似重复 ' + nearTotal + ' 对，只警告：换措辞的同一件事，要人眼确认）');
}

checkSource();
checkBehavior();
checkData();

console.log('\n结果：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
