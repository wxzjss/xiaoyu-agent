/**
 * 【艾特（@）功能已删除 —— 别再长回来】
 *
 * 主人 2026-11-10 原话：「把【屋里的人】艾特功能删除」。
 *
 * 删之前那套是三层叠着：
 *   ① 个性打勾的人只在被 @ 时才说话
 *   ② @ 了一个关着牌的人 → 这一轮谁都不开麦
 *   ③ @ 的先后顺序决定这一轮谁先开口
 *
 * 现在规矩只剩一条：**左侧开关开着的人，每一轮都说一句，顺序照竖列从上到下。**
 * 主人想指定谁说话，就关掉不想听的那个 —— 不需要记 @ 语法。
 *
 * 这个检查钉三件事：
 *   一、后端不再解析 @：pickSpeakers 里不许出现 parseMentions / @ 正则
 *   二、界面上不许再有「@她／艾特／叫她的名字才应」这类说明（会让主人以为这功能还在）
 *   三、行为对：开着都说、关着都不说、句子里写 @ 不影响结果、旧 quiet 配置不再生效
 *
 * 纯静态 + 纯函数，不连 CDP、不起浏览器（历史教训：检查里连 CDP 会拖垮全量回归）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pass = 0;
let fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + String(detail).slice(0, 400) : '')); }
}

const groupSrc = fs.readFileSync(path.join(ROOT, 'src', 'group.mjs'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');

console.log('一、后端：pickSpeakers 不再解析 @');
{
  /* 取出 pickSpeakers 函数体（按花括号配平，别用正则截半截） */
  const start = groupSrc.indexOf('export function pickSpeakers(');
  let body = '';
  if (start >= 0) {
    let i = groupSrc.indexOf('{', start);
    let depth = 0;
    for (let k = i; k < groupSrc.length; k++) {
      if (groupSrc[k] === '{') depth++;
      else if (groupSrc[k] === '}') { depth--; if (depth === 0) { body = groupSrc.slice(start, k + 1); break; } }
    }
  }
  ok(Boolean(body), 'pickSpeakers 函数取到了', '没找到函数体');
  ok(!/parseMentions\s*\(/.test(body), 'pickSpeakers 里不再调 parseMentions',
    (body.match(/.*parseMentions.*/) || [''])[0].trim());
  ok(!/[@＠]/.test(body), 'pickSpeakers 里不再有 @ 匹配',
    (body.match(/.*[@＠].*/) || [''])[0].trim());
  ok(!/quietIds\s*\)?\s*\.map|new Set\(\s*quietIds/.test(body), 'pickSpeakers 里 quietIds 不再参与判断');
  ok(!/hitSet|askedOffOnly|aliveHits/.test(body), '「@ 了关着的牌就谁都不说」那套已拆干净');
}

console.log('\n二、行为：开着的都说、关着都不说、@ 不影响');
{
  /* Windows 上动态 import 必须给 file:// URL，直接给盘符路径会报
   * ERR_UNSUPPORTED_ESM_URL_SCHEME（'d:' 不是合法协议）。 */
  const g = await import(pathToFileURL(path.join(ROOT, 'src', 'group.mjs')).href);
  const roster = [{ id: 'a', name: '阿蓝' }, { id: 'b', name: '阿紫' }, { id: 'c', name: '阿绿' }];
  const names = (arr) => arr.map((x) => x.name).join(',');

  const all = g.pickSpeakers({ roster, userText: '随便说', enabledIds: ['a', 'b', 'c'] });
  ok(names(all) === '阿蓝,阿紫,阿绿', '三张牌都开着 → 三个都说，顺序照竖列', names(all));

  const withAt = g.pickSpeakers({ roster, userText: '@阿紫 你说说', enabledIds: ['a', 'b', 'c'] });
  ok(names(withAt) === '阿蓝,阿紫,阿绿', '句子里写 @阿紫 → 结果跟不写一模一样（@ 不再有魔力）', names(withAt));

  const two = g.pickSpeakers({ roster, userText: '@阿绿 你说', enabledIds: ['a', 'b'] });
  ok(names(two) === '阿蓝,阿紫', '关掉的那张牌，@ 它也不会开口', names(two));

  const none = g.pickSpeakers({ roster, enabledIds: [] });
  ok(none.length === 0, '一张牌都没开 → 没人说话', JSON.stringify(none));

  const legacyQuiet = g.pickSpeakers({ roster, userText: '没叫名字', quietIds: ['c'], enabledIds: ['a', 'b', 'c'] });
  ok(names(legacyQuiet) === '阿蓝,阿紫,阿绿',
    '老配置里「个性打勾」不再让人变哑巴（以前勾了不 @ 就不说话）', names(legacyQuiet));

  ok(Array.isArray(g.parseMentions('@阿紫', roster)) && g.parseMentions('@阿紫', roster).length === 0,
    'parseMentions 已停用（保留导出只为不炸老调用方，永远返回空）');
}

console.log('\n三、界面：不许再出现「艾特 / @她才应」的说法');
{
  /* 注释行不算（代码注释里留着历史说明是有价值的） */
  const lines = html.split('\n');
  const visible = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) continue;
    if (t.startsWith('<!--')) continue;
    visible.push({ no: i + 1, text: raw });
  }
  const badPatterns = [
    [/勾上＝只有你叫她的名字/, '「个性」勾选框的说明'],
    [/（@她）才应一句/, '「@她」才应那句'],
    [/主动艾特某个或多个人/, '「主动艾特」那套说明'],
    [/根据艾特的顺序/, '「艾特顺序决定开口顺序」'],
    /* 【2026-11-10 补】删完之后还漏在 tooltip 里的两句 ——
     * 牌子悬停写着「个性打了勾：只有你叫她的名字（@她）才答」，
     * 顶栏牌子 title 写着「（N 个要叫才应）」。后端已经把 quiet/quietIds 压成
     * false/[]，这两句永远显示不出来，但留着就会在下次谁把字段接回去时诈尸。 */
    [/个性打了勾/, '「个性打了勾」的悬停提示'],
    [/个要叫才应/, '「N 个要叫才应」的牌子提示'],
  ];
  for (const [re, what] of badPatterns) {
    const hit = visible.filter((l) => re.test(l.text));
    ok(hit.length === 0, '界面上没有' + what, hit.map((h) => h.no + ': ' + h.text.trim()).join('\n       '));
  }
  ok(!/id="agQuiet"/.test(html), '「个性」那个 checkbox 本体已删',
    (html.match(/.*id="agQuiet".*/) || [''])[0].trim());
  ok(!/getElementById\('agQuiet'\)/.test(html), '读 agQuiet 的 JS 已删');
}

console.log('\n四、安静标记（.quiet）也一起退了');
{
  /* 两条都要成立：牌子不再挂 .quiet 类；界面上再没有调用 setAgentQuiet 的地方。
   * （setAgentQuiet 函数本体留在 src/agents.mjs 里不删 —— 老会话文件里还存着这个字段，
   *   真要恢复时也是现成的；但**入口**必须一个都不剩。） */
  /* 只看「会真的跑起来的代码」：注释里留着历史说明是有价值的，不算入口。 */
  const codeOnly = html
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (!t) return false;
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')) return false;
      if (t.startsWith('<!--') || t.startsWith('#') || t.startsWith('--')) return false;
      /* 注释块正文行：上一行是 /* 或 * 开头，这一行也是纯叙述（没有 { } = ; 这些代码符号） */
      return true;
    })
    .join('\n');
  /* .agMem.quiet 是否还有**真正的 CSS 规则**（形如「选择器 {」而不是注释里提到它） */
  const hasQuietRule = /^\s*[#.][^{}\n]*\.agMem\.quiet[^{}\n]*\{/m.test(html);
  const hasQuietCall = /\bsetAgentQuiet\s*\(/.test(codeOnly);
  ok(!hasQuietRule, '「屋里的人」牌子不再挂 quiet 类（没有虚线框那一档）',
    (html.match(/.*\.agMem\.quiet[^{}\n]*\{.*/) || [''])[0].trim());
  ok(!hasQuietCall, '界面上再没有调用 setAgentQuiet 的入口（勾选框已撤）',
    (codeOnly.match(/.*setAgentQuiet\s*\(.*/) || [''])[0].trim());
}

console.log('\n五、连带的读取点也退了（老配置 / 老前端不会再画出「叫才应」）');
{
  /* 只挑「会真的跑起来的行」：整行注释、块注释正文都不算。 */
  const codeLines = html.split('\n').filter((l) => {
    const t = l.trim();
    if (!t) return false;
    if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('<!--')) return false;
    return true;
  }).join('\n');
  /* ① 顶栏那颗牌原来用 members[].quiet 剔掉「叫才应」的小鲸；
   *    quiet 恒 false 时它等于 alive，可一旦后端又报 true，小鲸会从牌子上消失。
   *    这里钉住：界面不许再读这个字段。 */
  ok(!/\bm\.quiet\b/.test(codeLines), '界面不再读 members[].quiet（老配置勾过的人也照常算在场）',
    (codeLines.match(/.*\bm\.quiet\b.*/) || [''])[0].trim());
  ok(!/\bgrp\.quietIds\b/.test(codeLines), '界面不再读 quietIds（后端已恒返回空数组）',
    (codeLines.match(/.*\bgrp\.quietIds\b.*/) || [''])[0].trim());
  /* ② 双击/右键牌子原来往输入框塞「@名字」——那是最直接的「@ 还有用」暗示。 */
  ok(!/['"]@['"]\s*\+/.test(codeLines), '双击牌子不再往输入框塞「@名字」',
    (codeLines.match(/.*['"]@['"]\s*\+.*/) || [''])[0].trim());

  /* ③ 后端那两处「老客户端要的字段」必须恒空/恒假，不然新老前端都会画出不存在的状态。 */
  const svr = fs.readFileSync(path.join(ROOT, 'src', 'server.mjs'), 'utf8');
  ok(/quiet:\s*false/.test(svr), '后端 /api/agents/group 恒报 quiet:false（老前端画不出「叫才应」小点）');
  ok(/quietIds:\s*\[\]/.test(svr), '后端 /api/agents/group 恒报 quietIds:[]（牌子 title 不会再冒出 N 个要叫才应）');

  /* ④ 最后一层保险：老 agents.json 里就算还留着 quiet:true，也不许任何人读到它。
   *    （2026-11-10 主人问过一次：出厂卡带 quiet:true 会不会让人永远不说话？
   *      结论是「不会」—— 前提正是下面这两条恒假/恒空。谁把它们改回去，这条就红。） */
  const agentsSrc = fs.readFileSync(path.join(ROOT, 'src', 'agents.mjs'), 'utf8');
  const fnBody = (name) => {
    const s = agentsSrc.indexOf('export function ' + name + '(');
    if (s < 0) return '';
    let i = agentsSrc.indexOf('{', s);
    let depth = 0;
    for (let k = i; k < agentsSrc.length; k++) {
      if (agentsSrc[k] === '{') depth++;
      else if (agentsSrc[k] === '}') { depth--; if (depth === 0) return agentsSrc.slice(s, k + 1); }
    }
    return '';
  };
  const iq = fnBody('isAgentQuiet');
  ok(Boolean(iq) && /return\s+false/.test(iq) && !/\.quiet/.test(iq),
    'isAgentQuiet 恒返回 false、不再读老配置（勾过的人不会再被当成「要叫才应」）',
    iq.slice(0, 200));
  const qids = fnBody('quietAgentIds');
  ok(Boolean(qids) && /return\s*\[\s*\]/.test(qids) && !/\.quiet/.test(qids),
    'quietAgentIds 恒返回空数组、不再读老配置', qids.slice(0, 200));
  /* 导卡那一步也不许把「dead 字段」重新种回配置里。
     判之前先挖掉注释 —— 上面那条历史说明里就写着 setAgentQuiet(...) 这个字面量。 */
  const imp = fnBody('importCard');
  const impCode = imp.replace(/\/\*[\s\S]*?\*\//g, '').split('\n')
    .map((l) => { const k = l.indexOf('//'); return k >= 0 ? l.slice(0, k) : l; })
    .join('\n');
  ok(Boolean(imp) && !/setAgentQuiet\s*\(/.test(impCode), '导入角色卡不再把卡里的 quiet 写回配置');
  /* 出厂卡（随包发布的那几张）身上不许带 quiet —— 带了就等于给新机器预制一个哑巴。 */
  const presetsSrc = fs.readFileSync(path.join(ROOT, 'src', 'agent-presets.mjs'), 'utf8');
  ok(!/\bquiet\s*:/.test(presetsSrc), '出厂智能体卡不带 quiet 字段');
}

console.log('\n────────────────────────────────');
console.log('结果: ' + pass + ' 过 / ' + fail + ' 挂');
if (fail) process.exit(1);
