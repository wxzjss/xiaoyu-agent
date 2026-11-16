/**
 * check-hub-scroll.mjs — 守「柜子里只有一层滚动」。
 *
 * 主人 2026-11-15 报：「鼠标在 B 框（柜子里的工具卡/思考链）里滚轮滚动，
 * 连带着 A 框（柜子内容区 .hubBody）一起滚时一卡一卡」。
 *
 * 根子不是渲染慢（实测帧耗时 16.7ms / 60fps、零掉帧），是**两层滚动交棒**：
 *   B 滚到底 → 浏览器把剩余滚动量交给 A → A 只剩一两百像素余量 → 两格又到底 → 停住。
 *
 * 修法：柜子内取消 B 的 320px 限高，内容整段铺开，滚动只发生在 A 一层。
 * 这条断言守这个形状：柜子内 B 不许有 max-height，独立卡仍然要有。
 *
 * 单独跑：node scripts/check-hub-scroll.mjs
 */
import { readFileSync } from 'node:fs';

const raw = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
/* 注释会混进「块前面的选择器文本」，先剥掉（CSS 注释 + JS 注释一起剥，不影响判据） */
const html = raw.replace(/\/\*[\s\S]*?\*\//g, ' ');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/**
 * 抓某个选择器的**全部**声明。
 * 同名规则可能散在好几处（CSS 合并生效），所以要全收；
 * 逗号分组里出现也算（`a, b { … }` 里的 b）。
 */
function ruleBody(sel) {
  const out = [];
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(html))) {
    const sels = m[1].split(',').map((x) => x.trim());
    if (sels.includes(sel)) out.push(m[2]);
  }
  return out.join('\n');
}

const hubPre = ruleBody('details.toolhub details.tool pre');
ok('找到「柜子内工具卡 pre」规则', !!hubPre);
ok('柜子内 pre 不限高（max-height: none）', /max-height\s*:\s*none/.test(hubPre),
  '柜子内又限高 = 又变成两层滚动，滚到底会交棒给 A，一卡一卡回来');
ok('柜子内 pre 不再自己滚（overflow: visible）', /overflow\s*:\s*visible/.test(hubPre));

const hubThink = ruleBody('.hubBody .thinkBody');
ok('柜子内思考链也不限高', /max-height\s*:\s*none/.test(hubThink) && /overflow\s*:\s*visible/.test(hubThink));

const soloPre = ruleBody('details.tool pre');
ok('不在柜子里的独立卡仍然 320px 限高（外面没有 A 可接棒，不封顶会顶飞整屏）',
  /max-height\s*:\s*320px/.test(soloPre), '独立卡限高被误删了');

const hubBody = ruleBody('details.toolhub > .hubBody');
ok('A 框（.hubBody）自己有上限且在框内滚',
  /max-height\s*:\s*\d+px/.test(hubBody) && /overflow-y\s*:\s*auto/.test(hubBody));
ok('A 框滚到底不把整个对话撸走（overscroll-behavior: contain）',
  /overscroll-behavior\s*:\s*contain/.test(hubBody));
/* 【2026-11-16 晚·主人报「必须把鼠标放在 B 框里才能滚」】
 * 老判据只找 B 框，鼠标挪到柜门/空隙/收起态卡片上就撒手；
 * A 的 contain 会让原生链止步，于是只有压在 B 上才滚得动。 */
{
  const at = html.indexOf('function installInnerToHubScrollChain');
  const fn = at >= 0 ? html.slice(at, at + 6000) : '';
  ok('滚轮接管覆盖整个柜子（不再只认 B 框）',
    /const hub = t\.closest\('\.toolhub'\)/.test(fn));
  ok('非 B 区域也直接喂 A 框',
    /hub\.getElementsByClassName\('hubBody'\)\[0\]/.test(fn));
  ok('A 到头时清掉没追完的目标，不把之后的原生滚动拽回来',
    /targetA = null; targetVal = 0/.test(fn));
  ok('每帧位移封顶，一格滚轮不再第一帧猛跳一节',
    /const MAX_STEP = 12/.test(fn) && /Math\.min\(Math\.abs\(d\) \* EAT, MAX_STEP\)/.test(fn));
}

console.log('\n柜子滚动：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
