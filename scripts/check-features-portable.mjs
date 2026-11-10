/**
 * 守卫：功能页的「导入 / 导出 / 删除」不许悄悄退化。
 *
 * 【这个脚本钉的是什么】
 * 主人 2026-11-10 要的三件事：拖动功能文件导入、勾选导出、删除某个功能。
 * 下面每一条都可能被以后的改动悄悄弄坏，而且坏得**不报错**：
 *
 *   1. 自定义功能要是被写进 src/ 里 → 装官方安装包一更新，src/ 整个被覆盖，
 *      主人导进来的功能全没了，还没人告诉他。所以必须钉住「存在 .state/」。
 *   2. 导入时 id 和内置撞了要是让它覆盖 → 一个导入文件就能改掉「跑命令」的定义。
 *   3. 内置功能要是能删 → 下次启动又长回来，主人会以为「删了又回来了」。
 *   4. 导出的东西要是导不回来（字段对不上、包结构不认）→ 备份等于废纸。
 *
 * 【为什么是纯静态 + 纯函数，不连服务、不开浏览器】
 * 这是回归基线，得能在任何机器上 `node scripts/check-features-portable.mjs` 跑，
 * 不需要先起服务、不需要 Electron。涉及落盘的用例全在系统临时目录里做，
 * 跑完删干净，绝不碰主人真实的 .state。
 *
 * 跑法：node scripts/check-features-portable.mjs
 */
import { readFileSync, mkdirSync, rmSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

let pass = 0;
let fail = 0;
const check = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  [ok] ' + name + (extra ? '  ' + extra : '')); }
  else { fail++; console.log('  [FAIL] ' + name + (extra ? '  ' + extra : '')); }
};

const readSrc = (rel) => {
  try { return readFileSync(join(ROOT, rel), 'utf8'); } catch { return ''; }
};

/* ============================================================
 * ① 静态：定义存哪儿、冲突怎么处理、删不删得掉
 * ============================================================ */
console.log('=== 1. 静态：自定义功能存在 .state（更新才不丢）===');
const feat = readSrc('src/features.mjs');
const srv = readSrc('src/server.mjs');

check('features.mjs 读得到', feat.length > 1000, `${feat.length} 字`);
check(
  '自定义功能文件拼的是 config.dataDir + .state + features-custom.json',
  /join\(\s*config\.dataDir\s*,\s*'\.state'\s*,\s*'features-custom\.json'\s*\)/.test(feat),
);
check('自定义功能**没有**被写进 src 目录', !/(['"`])\.\/features-custom\.json\1/.test(feat) && !/src[\\/]features-custom\.json/.test(feat));
check('合并清单里带 custom 标记', /custom:\s*true/.test(feat) && /custom:\s*false/.test(feat));
check('id 冲突以内置为准（有 BUILTIN_IDS.has 判断）', /BUILTIN_IDS\.has\(\s*f\.id\s*\)/.test(feat));
check('冲突说明是人话', /和内置功能重名，跳过/.test(feat));
check('删除内置会明确拒绝', /内置功能只能停用/.test(feat) && /status\s*=\s*400|httpError\(400/.test(feat));
check('删不存在的给 404', /httpError\(404/.test(feat));
check('导出格式带 version/exportedAt/features', /version:\s*'1'/.test(feat) && /exportedAt:\s*new Date\(\)\.toISOString\(\)/.test(feat));
check('多份导出额外写 _all.featurepack.json', /_all\.featurepack\.json/.test(feat));
check('默认导出目录在 features-export/<时间戳>', /'features-export'/.test(feat) && /timeStamp\(\)/.test(feat));

console.log('');
console.log('=== 2. 静态：四条路由都在 server.mjs 里 ===');
for (const [method, path] of [
  ['GET', '/api/features/export'],
  ['POST', '/api/features/export-to'],
  ['POST', '/api/features/import'],
  ['POST', '/api/features/remove'],
]) {
  const re = new RegExp(`req\\.method\\s*===\\s*'${method}'\\s*&&\\s*url\\.pathname\\s*===\\s*'${path.replace(/[/.]/g, '\\$&')}'`);
  check(`${method} ${path}`, re.test(srv));
}
check('列表接口照旧在（GET /api/features）', /req\.method === 'GET' && url\.pathname === '\/api\/features'/.test(srv));
check('导入时拿真实工具清单校验（allTools）', /importFeatures\(payload,\s*\{\s*knownTools/.test(srv) && /allTools/.test(srv));

/* ============================================================
 * ② 静态：功能作用域「按会话」这条线不能中途断掉
 *
 * 这条最容易坏的方式是「静默断链」：接口按会话了，但工具侧还在读全局 ——
 * 界面显示关着、工具照样能调（假关），而且不报任何错。
 * 所以这里逐个钉住穿参的那几处。
 * ============================================================ */
console.log('');
console.log('=== 2b. 静态：sessionId 真的从接口穿到了工具 ===');
const toolsSrc = readSrc('src/tools.mjs');
const agentSrc = readSrc('src/agent.mjs');
const subSrc = readSrc('src/subagent.mjs');
const taskSrc = readSrc('src/task-mode.mjs');
const personaSrc = readSrc('src/persona.mjs');

check('features.mjs 有三级回退（resolveEnabled）', /function resolveEnabled\(/.test(feat));
check('② 回退读的是全局表（raw[key]），不是直接 defaultOn',
  /function resolveEnabled[\s\S]{0,600}?raw\[key\] !== undefined/.test(feat));
/* 【别写死名单】口径改过两回了（2 → 5）。这里从源码里把 id 抽出来，
 * 只断言「必须包含这几条」+「每条都得是真功能」，以后再加一条不会把这条断言弄红。 */
const whitelistIds = (() => {
  const m = /GLOBAL_ONLY_FEATURES = new Set\(\[([^\]]*)\]\)/.exec(feat);
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : [];
})();
const REQUIRED_GLOBAL = ['videoBg', 'screenSense', 'ttsVoice', 'selfRestart', 'identity'];
check('机器级白名单存在，且包含这 5 条', REQUIRED_GLOBAL.every((id) => whitelistIds.includes(id)), whitelistIds.join(','));
check('白名单里每个 id 都是真功能（不是打错字）', whitelistIds.length > 0 && whitelistIds.every((id) => new RegExp(`id: '${id}'`).test(feat)));
check('白名单有来源说明（注释里写了判据）', /少一个本事/.test(feat));
check('tools.mjs：enabledToolSchemas 收 sessionId', /export function enabledToolSchemas\(sessionId = ''\)/.test(toolsSrc));
check('tools.mjs：isToolEnabled 带会话', /isToolEnabled\(name, sessionId\)/.test(toolsSrc));
check('tools.mjs：记忆锁按会话判（currentSessionId）', /featureOnFor\(currentSessionId\(\), 'memory'\)/.test(toolsSrc));
check('agent.mjs：每轮工具清单按会话取', /enabledToolSchemas\(sessionId\)/.test(agentSrc));
check('agent.mjs：提示词里的工具清单也按会话（setToolLister 带 sid）', /setToolLister\(\(sid\) => enabledToolSchemas\(sid\)\)/.test(agentSrc));
check('subagent.mjs：子任务用派活会话，不用 subSessionId', /const gateSessionId = sessionId \|\| ownerSessionId/.test(subSrc));
check('subagent.mjs：工具清单按 gateSessionId 取', /enabledToolSchemas\(gateSessionId\)/.test(subSrc));
check('subagent.mjs：记忆判据也按 gateSessionId', /featureOnFor\(gateSessionId, 'memory'\)/.test(subSrc));
check('task-mode.mjs：办事模式可用性按会话', /taskFeatureOn\(sessionId = ''\)/.test(taskSrc) && /featureOnFor\(sessionId \|\| '', 'taskmode'\)/.test(taskSrc));
check('persona.mjs：toolBlock 收 sessionId', /function toolBlock\(sessionId = ''\)/.test(personaSrc) && /_listTools\(sessionId\)/.test(personaSrc));
check('server.mjs：GET 按 sessionId 算', /getFeatures\(sid\)/.test(srv));
check('server.mjs：set 走 setFeatureScoped（不再直接写全局）', /setFeatureScoped\(fid, payload\?\.enabled, target\)/.test(srv));
check('server.mjs：缺 sessionId 给 400', /缺少 sessionId：功能开关现在按会话生效/.test(srv));


console.log('');
console.log('=== 2c. 静态：不许把「可能为空」的东西喂给 featureOnFor 的第一个参数 ===');
/* 【为什么专门钉这一条】2026-11-10 scope-rules 提醒的坑：
 * `featureOnFor(session?.id, 'x')` —— session 为空时第一个参数是 undefined，
 * 函数会**静默跳过会话那一级、退回全局**。代码看着「改了」，实际还是假关，
 * 而且一个错都不报。这类只能靠约定 + 静态扫，扫不到就永远没人发现。
 * 合法姿势：`featureOnFor(sessionId, 'x')`、`featureOnFor(sid || '', 'x')`。
 *
 * 【这条的边界，别当成万无一失】
 *   · 只管「直接写在参数位上」的写法。间接的挡不住：
 *       const sid = session?.id;  featureOnFor(sid, 'x')   ← 这里参数位上干干净净
 *     这属于静态分析的天花板，靠 code review 兜。
 *   · `featureOnFor(session?.id ?? '', 'x')` 也会被拦 —— 它其实安全（?? '' 已经
 *     兜成空串了），但我们**故意不为它开特例**：正则里一开特例，下一个人就会
 *     顺着这个口子写更巧的变体。正确做法是先取变量再传，多一行、看得懂。
 */
const ARG_BAD = /featureOnFor\(\s*([^,)]*)/;
const badCalls = [];
/* 先剥注释再扫：src 里到处是「别写成 featureOnFor(session?.id)」这种说明文字，
 * 不剥的话守卫会被自己人的注释弄红，那就变成狼来了。 */
const stripComments = (t) => t
  .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
try {
  for (const f of readdirSync(join(ROOT, 'src'))) {
    if (!f.endsWith('.mjs')) continue;
    const rawText = readFileSync(join(ROOT, 'src', f), 'utf8');
    if (!rawText.includes('featureOnFor(')) continue;
    const text = stripComments(rawText);
    text.split(/\r?\n/).forEach((line, i) => {
      const m = ARG_BAD.exec(line);
      if (!m) return;
      const arg = m[1].trim();
      if (!arg) return;
      /* 可选链 / 字面 undefined / null —— 这三种都会让「这个会话」凭空消失 */
      if (/\?\./.test(arg) || /^(undefined|null)$/.test(arg)) {
        badCalls.push(`src/${f}:${i + 1}  ${line.trim().slice(0, 90)}`);
      }
    });
  }
} catch { /* 扫不动就不判，别让守卫自己炸掉整轮 */ }
check('featureOnFor 的第一个参数没有可选链/undefined/null', badCalls.length === 0, badCalls.length ? badCalls.join(' | ') : '干净');

/* ============================================================
 * ② 纯函数：在系统临时目录里跑真逻辑
 *
 * 注意必须在 import features.mjs **之前**设好 MINI_AGENT_DATA ——
 * config.mjs 在模块加载时就把 dataDir 定下来了。
 * ============================================================ */
console.log('');
console.log('=== 3. 真跑：临时数据目录里的导入 / 导出 / 删除 ===');
const TMP = join(tmpdir(), `xy-features-guard-${process.pid}-${Date.now()}`);
mkdirSync(join(TMP, '.state'), { recursive: true });
process.env.MINI_AGENT_DATA = TMP;

let F;
try {
  F = await import('../src/features.mjs');
} catch (e) {
  console.log('  [FAIL] features.mjs 加载不了：' + String(e?.message ?? e));
  rmSync(TMP, { recursive: true, force: true });
  process.exit(1);
}

const CUSTOM = join(TMP, '.state', 'features-custom.json');
const KNOWN = new Set(['run_command', 'read_file', 'web_search', 'fetch_url']);

try {
  // 基线：内置清单没被这次改动弄坏
  const base = F.getFeatures();
  check('内置功能条数 > 20', base.features.length > 20, `${base.features.length} 条`);
  check('每条都带 custom:boolean', base.features.every((f) => typeof f.custom === 'boolean'));
  check('内置那条 custom=false', base.features.every((f) => f.custom === false));
  check('旧字段一个没少（id/name/desc/tools/enabled/defaultOn）', base.features.every((f) => f.id && f.name && typeof f.desc === 'string' && Array.isArray(f.tools) && typeof f.enabled === 'boolean' && typeof f.defaultOn === 'boolean'));
  check('内置 id 集合没变（shell 还在）', base.features.some((f) => f.id === 'shell' && f.name === '跑命令'));

  // 1) 单个功能文件
  let r = F.importFeatures({ files: [{ name: 'a.feature.json', content: JSON.stringify({ id: 'guard_one', name: '守卫一', desc: 'd', tools: ['read_file'] }) }] }, { knownTools: KNOWN });
  check('单条导入：added=[guard_one]', r.ok && r.added.length === 1 && r.added[0] === 'guard_one', JSON.stringify(r.added));
  check('单条导入：落盘到 .state/features-custom.json', existsSync(CUSTOM));
  check('自定义功能的开关能读能写', F.setFeature('guard_one', false).features.find((f) => f.id === 'guard_one')?.enabled === false);
  check('自定义那条 custom=true', F.getFeatures().features.find((f) => f.id === 'guard_one')?.custom === true);

  // 2) featurepack 批量 + 覆盖记 updated
  const pack = F.exportFeatures(['guard_one']);
  r = F.importFeatures({ files: [{ name: '_all.featurepack.json', content: JSON.stringify(pack) }] }, { knownTools: KNOWN });
  check('featurepack 批量回导：记进 updated', r.updated.includes('guard_one') && !r.added.includes('guard_one'), JSON.stringify(r.updated));

  // 3) 坏 JSON
  r = F.importFeatures({ files: [{ name: 'broken.feature.json', content: '{ "id": ' }] }, { knownTools: KNOWN });
  check('坏 JSON 进 skipped（不整批失败）', r.skipped.length === 1 && r.skipped[0].imported === false);
  check('坏 JSON 的原因里有文件名', /broken\.feature\.json/.test(r.skipped[0].reason));
  check('坏 JSON 的原因里有位置（第几行 / 末尾截断）', /第 \d+ 行|截断/.test(r.skipped[0].reason), r.skipped[0].reason);

  // 4) 和内置重名
  r = F.importFeatures({ features: [{ id: 'shell', name: '冒充跑命令', tools: ['run_command'] }] }, { knownTools: KNOWN });
  check('和内置重名 → skipped', r.skipped.some((s) => s.id === 'shell'));
  check('内置定义一个字没被改', F.getFeatures().features.find((f) => f.id === 'shell').name === '跑命令');
  check('内置那条 custom 仍是 false', F.getFeatures().features.find((f) => f.id === 'shell').custom === false);

  // 5) 引用不存在的工具：导入但不拦
  r = F.importFeatures({ features: [{ id: 'guard_ghost', name: '守卫幽灵', tools: ['no_such_tool'] }] }, { knownTools: KNOWN });
  check('引用不存在工具仍然导入', r.added.includes('guard_ghost'));
  const warn = r.skipped.find((s) => s.id === 'guard_ghost');
  check('但如实提醒（imported:true + 工具名）', warn && warn.imported === true && /no_such_tool/.test(warn.reason));

  // 6) round-trip：导出 → 清空 → 导回 → 一模一样
  const snapshotBefore = F.exportFeatures();
  rmSync(CUSTOM, { force: true });
  const afterWipe = F.getFeatures().features.filter((f) => f.custom).length;
  check('删掉自定义文件后清单里没有自定义了', afterWipe === 0, `剩 ${afterWipe}`);
  r = F.importFeatures({ bundle: snapshotBefore }, { knownTools: KNOWN });
  const snapshotAfter = F.exportFeatures();
  check('round-trip：export → import → 清单一致', JSON.stringify(snapshotBefore.features) === JSON.stringify(snapshotAfter.features));
  check('round-trip：version 字段还在', snapshotAfter.version === '1' && typeof snapshotAfter.exportedAt === 'string');

  // 7) 导出到磁盘 + 拖回来
  const outDir = join(TMP, 'out');
  const ex = F.exportFeaturesTo({ dir: outDir });
  check('导出写到指定目录', ex.ok && ex.path === outDir, ex.path);
  check('多份导出写了 _all.featurepack.json', ex.files.includes('_all.featurepack.json'), ex.files.join(','));
  const packFile = join(outDir, '_all.featurepack.json');
  const listBeforeReimport = F.getFeatures().features.map((f) => `${f.id}:${f.custom}:${f.name}:${f.tools.join('|')}`);
  const back = F.importFeatures({ files: [{ name: '_all.featurepack.json', content: readFileSync(packFile, 'utf8') }] }, { knownTools: KNOWN });
  check('导出的包能原样拖回来（没有一条被拒）', back.ok && back.skipped.every((s) => s.imported === true), JSON.stringify(back.skipped));
  check('包里的内置条目记进 ignored，不刷成错误', back.ignored.length > 20, `ignored ${back.ignored.length} 条`);
  check('拖回来之后清单一个字没变', JSON.stringify(listBeforeReimport) === JSON.stringify(F.getFeatures().features.map((f) => `${f.id}:${f.custom}:${f.name}:${f.tools.join('|')}`)));
  check('真想覆盖内置的才报错', (() => {
    const rr = F.importFeatures({ features: [{ id: 'shell', name: '被我改了', tools: ['run_command'] }] }, { knownTools: KNOWN });
    return rr.skipped.some((s) => s.id === 'shell' && s.builtin === true && s.imported === false);
  })());

  // 8) 删除
  let e1 = null;
  try { F.removeCustomFeature('shell'); } catch (e) { e1 = e; }
  check('删内置 → 400', e1 && e1.status === 400, e1 ? String(e1.message) : '(没抛)');
  check('删内置的提示是「只能停用」', e1 && /只能停用/.test(e1.message));
  let e2 = null;
  try { F.removeCustomFeature('nope_not_here'); } catch (e) { e2 = e; }
  check('删不存在 → 404', e2 && e2.status === 404);
  const rem = F.removeCustomFeature('guard_ghost');
  check('删自定义 → ok', rem.ok && rem.removed === 'guard_ghost');
  check('删完清单里就没了', !F.getFeatures().features.some((f) => f.id === 'guard_ghost'));

  // 9) 按会话 + 三级回退（2026-11-10 主人要求「功能仅当前会话，不是全局」）
  F.setFeature('shell', false);                       // 全局：关
  check('② 会话没设过 → 走全局值（不是 defaultOn）', F.featureOnFor('sess_new', 'shell') === false);
  F.setFeatureFor('sess_A', 'shell', true);           // A 会话：开
  check('① 会话设过 → 听会话的', F.featureOnFor('sess_A', 'shell') === true);
  check('别的会话不受 A 影响', F.featureOnFor('sess_B', 'shell') === false);
  check('getFeatures(会话) 的 enabled 按会话算', F.getFeatures('sess_A').features.find((f) => f.id === 'shell').enabled === true);
  check('getFeatures(会话) 标 scope=session', F.getFeatures('sess_A').scope === 'session');
  check('不带会话退回全局（兼容老前端）', F.getFeatures().scope === 'global' && F.getFeatures().features.find((f) => f.id === 'shell').enabled === false);
  check('enabledToolNames 按会话算', F.enabledToolNames('sess_A').includes('run_command') && !F.enabledToolNames('sess_B').includes('run_command'));
  check('isToolEnabled 按会话算', F.isToolEnabled('run_command', 'sess_A') === true && F.isToolEnabled('run_command', 'sess_B') === false);
  let e3 = null;
  try { F.setFeatureScoped('readFile', true, ''); } catch (e) { e3 = e; }
  check('缺 sessionId 的会话级开关 → 400（不偷偷写全局）', e3 && e3.status === 400);
  check('videoBg 保持全局（机器级，不跟会话）', F.setFeatureScoped('videoBg', false, 'sess_A').scope === 'global' && F.featureOnFor('sess_B', 'videoBg') === false);
  check('screenSense 同样保持全局', F.setFeatureScoped('screenSense', false, 'sess_A').scope === 'global');

  /* 【2026-11-10 白名单扩到 5 条】team-lead 定的三条硬要求，这里逐条钉：
   *   ① 每条功能自己带 scope（前端要靠它标「整台机器」）
   *   ② 白名单 id 直接调 setFeatureFor 必须抛 400（不是「写了再忽略」）
   *   ③ 会话表里永远不出现白名单 id（不留死数据） */
  const GLOBAL_IDS = ['videoBg', 'screenSense', 'ttsVoice', 'selfRestart', 'identity'];
  const featOf = (r, id) => r.features.find((f) => f.id === id);
  check('每条功能都带 scope 字段', F.getFeatures('sess_A').features.every((f) => f.scope === 'global' || f.scope === 'session'));
  check('白名单 5 条 scope 恒为 global（带会话）', GLOBAL_IDS.every((id) => featOf(F.getFeatures('sess_A'), id)?.scope === 'global'));
  check('白名单 5 条 scope 恒为 global（不带会话）', GLOBAL_IDS.every((id) => featOf(F.getFeatures(), id)?.scope === 'global'));
  check('普通功能 scope 恒为 session', ['web', 'shell', 'memory', 'readFile'].every((id) => featOf(F.getFeatures('sess_A'), id)?.scope === 'session'));
  let e4 = null;
  try { F.setFeatureFor('sess_A', 'videoBg', false); } catch (e) { e4 = e; }
  check('setFeatureFor 写白名单 → 抛 400（不是写了再忽略）', e4 && e4.status === 400 && /整台机器的开关/.test(e4.message), e4 && e4.message);
  check('setFeatureFor 拒写之后会话表里没有它', (() => {
    try {
      const raw = JSON.parse(readFileSync(join(TMP, '.state', 'feature-by-session.json'), 'utf8'));
      return !raw?.sess_A || raw.sess_A.videoBg === undefined;
    } catch { return true; }
  })());
  check('ttsVoice 在 A/B 两个会话结论相同（机器级）', (() => {
    F.setFeatureScoped('ttsVoice', false, 'sess_A');
    return F.featureOnFor('sess_A', 'ttsVoice') === F.featureOnFor('sess_B', 'ttsVoice') && F.featureOnFor('sess_B', 'ttsVoice') === false;
  })());
  check('selfRestart 在 A/B 两个会话结论相同（机器级）', (() => {
    F.setFeatureScoped('selfRestart', false, 'sess_A');
    return F.featureOnFor('sess_A', 'selfRestart') === F.featureOnFor('sess_B', 'selfRestart');
  })());
  check('identity 在 A/B 两个会话结论相同（机器级）', (() => {
    F.setFeatureScoped('identity', false, 'sess_A');
    return F.featureOnFor('sess_A', 'identity') === F.featureOnFor('sess_B', 'identity');
  })());
  check('memory 仍按会话（A 关 B 开，两条独立的）', (() => {
    F.setFeatureFor('sess_A', 'memory', false);
    F.setFeatureFor('sess_B', 'memory', true);
    return F.featureOnFor('sess_A', 'memory') === false && F.featureOnFor('sess_B', 'memory') === true;
  })());

  // 10) 升级兼容：会话表没了要回到**全局值**，不是回到 defaultOn
  const SESS = join(TMP, '.state', 'feature-by-session.json');
  F.setFeature('shell', false);                 // 全局明确关
  F.setFeatureFor('A', 'shell', true);          // A 明确开
  check('删会话表之前：A 听会话的（开）', F.featureOnFor('A', 'shell') === true);
  rmSync(SESS, { force: true });
  check('升级兼容：删掉会话表 → 回到全局值 false（不是 defaultOn）', F.featureOnFor('A', 'shell') === false);
  check('陌生会话同样回全局值', F.featureOnFor('ZZZ', 'shell') === false);

  // 11) 删自定义功能要顺手清掉会话表那一格（否则删了再导回来会继承旧开关）
  F.importFeatures({ features: [{ id: 'tmp_sess_feat', name: '临时', tools: [] }] }, { knownTools: KNOWN });
  F.setFeatureFor('A', 'tmp_sess_feat', false);
  F.removeCustomFeature('tmp_sess_feat');
  const sessAfter = (() => { try { return JSON.parse(readFileSync(SESS, 'utf8')); } catch { return {}; } })();
  check('删自定义功能后，会话表里那一格也没了', sessAfter?.A?.tmp_sess_feat === undefined);

  // 12) customCount（前端要显示「其中 N 个是自定义的」）
  F.importFeatures({ features: [{ id: 'cnt_a', name: '甲', tools: [] }, { id: 'cnt_b', name: '乙', tools: [] }] }, { knownTools: KNOWN });
  const withCustom = F.getFeatures();
  check('customCount = 清单里 custom 的条数', withCustom.customCount === withCustom.features.filter((f) => f.custom).length && withCustom.customCount >= 2, `customCount=${withCustom.customCount}`);
  check('total 仍等于 features.length', withCustom.total === withCustom.features.length);
  check('导入的返回值也带 total/customCount（前端刷新用）', (() => {
    const r2 = F.importFeatures({ features: [{ id: 'cnt_c', name: '丙', tools: [] }] }, { knownTools: KNOWN });
    return r2.total === r2.features.length && r2.customCount === r2.features.filter((f) => f.custom).length;
  })());

  // 13) 坏文件（手改坏了）不能让整页崩
  writeFileSync(CUSTOM, '{ not json at all', 'utf8');
  let survived = null;
  try { survived = F.getFeatures(); } catch (e) { survived = e; }
  check('自定义文件坏了也能列出内置功能', survived && Array.isArray(survived.features) && survived.features.length > 20);
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log('');
console.log('断言：' + pass + '/' + (pass + fail));
if (fail) {
  console.log('\u2605 失败 ' + fail + ' 条');
  process.exit(1);
}
console.log('PASS 功能可以安全地导入导出删除（存 .state、内置改不动、导出导得回来）');
