/**
 * check-spectator-card.mjs — 旁观者模式的站岗（2026-11-12）。
 *
 * 主人定的四条规矩，这里钉死实现层不许跑偏：
 *  ① 功能页的旁观者选人必须是【读文件】【写文件】同款的 featRow 卡片
 *     （一行一个智能体，左边名字+徽标+说明，右边胶囊开关）——不再是一行复选框；
 *  ② 禁勾判据用服务端算好的 main（会话主智能体）+ occupied（屋里的人全名单），
 *     **不许**再拿 mainAgentName 判 —— 它按设计恒为「小鱼」，拿它判正好判反
 *     （这就是「小鱼禁勾、干活的小鲸反而能勾」那次事故）；
 *  ③ 主人问的冲突自愈：提前勾了旁观者、后来同名者进了屋里 → UI 载入时自动摘掉并回存；
 *  ④ 服务端插话闸也要滤一遍：取名单时把「在屋里」的名字全排除（静音也算在屋里）。
 */
import { readFileSync } from 'node:fs';

const HTML = 'public/index.html';
const SERVER = 'src/server.mjs';
let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log('  [ok] ' + m); } else { fail++; console.log('  [!!] ' + m + (d ? ' —— ' + d : '')); } };

const html = readFileSync(HTML, 'utf8');
const srv = readFileSync(SERVER, 'utf8');

/* ── ① 卡片形式 ── */
ok('选人容器里建的是 featRow 卡片',
  html.includes("row.className = 'featRow';") && html.includes("row.dataset.name = _name;"));
ok('卡片带徽标（旁观中/未旁观/干活中/在屋里）',
  html.includes("'旁观中' : '未旁观'") && html.includes("_isMain ? '干活中' : '在屋里'"));
ok('开关是 featRow 同款胶囊（开始/停止旁观）',
  html.includes("'停止旁观' : '开始旁观'"));
ok('不再是一行复选框（旧 label+checkbox 写法已清）',
  !html.includes("display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dim);cursor:pointer;white-space:nowrap;"));

/* ── ② 禁勾判据 ── */
ok('UI 不再用 mainAgentName 判主智能体（它按设计恒为小鱼，判反过一次）',
  !html.includes("typeof mainAgentName !== 'undefined' && mainAgentName"));
ok('主智能体由服务端 main 发回',
  srv.includes('agents: spectatorsOf(sid), main, occupied') || /main, occupied \}/.test(srv));
ok('服务端用 getAgent(sessionAgentId(sid)) 算 main',
  /getAgent\(sessionAgentId\(sid\) \|\| AGENT_XIAOYU\)/.test(srv));

/* ── ③ 冲突自愈 ── */
ok('UI 载入时把「进了屋里」的预勾摘掉并回存',
  html.includes('let _dirty = false;') && html.includes('specState.occupied.has(_n)') && html.includes("agents: Array.from(specState.chosen)"));

/* ── ③′ 功能卡形态（2026-11-12 主人钦点：跟【读文件】【写文件】一张门脸） ── */
ok('旁观者卡由 renderFeatList 画进功能列表（不再挂独立标题条）',
  /function renderFeatList[\s\S]{0,300}specPaintInto\(featList\)/.test(html));
ok('旧独立块（specBar/specHint/specPick）已清干净',
  !html.includes('id="specPick"') && !html.includes('id="specHint"') && !html.includes('id="specBar"'));
ok('卡上有「挑人/收起」展开钮 + 选人区 .specSub',
  html.includes("'收起 ▴' : '挑人 ▾'") && html.includes("className = 'specSub'"));
ok('候选名单每次打开现拉 /api/agents 全表（自建新卡自动进候选）',
  /async function specLoad[\s\S]{0,600}\/api\/agents/.test(html));
ok('卡上开关语义：关=清空名单，开=展开选人区',
  html.includes('specState.chosen.clear()') && /sw\.onclick = \(\) => \{ specState\.expanded = true; specRepaint\(\); \}/.test(html));

/* ── ④ 服务端闸双保险 ── */
ok('插话闸用 residentNamesOf 全名单滤（不再只除主智能体）',
  /const __resident = new Set\(residentNamesOf\(sessionId\)\);/.test(srv)
    && /!__resident\.has\(String\(n\)\.trim\(\)\)/.test(srv));
ok('residentNamesOf 连静音的也算在屋里（activeAgentIds(sid, () => true)）',
  /activeAgentIds\(sessionId, \(\) => true\)/.test(srv));
ok('residentNamesOf 返回数组（Set 直接 JSON 化会变成 {}）',
  /return Array\.from\(out\);/.test(srv));

console.log('\n' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
