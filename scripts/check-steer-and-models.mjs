#!/usr/bin/env node
/**
 * 【2026-11-10 主人钦点的两项改造】：静态守卫
 *
 * 主人原话：
 *   ① 「插话…在插话预发送阶段【直接发送】后并将插话显示在这个位置，
 *       收到插话内容然后消息2，调用工具」
 *      → 插话必须显示在「消息1 之后、消息2 之前」，不能再堆到屏幕最底。
 *   ② 「添加模型的『选一个』不要写死的」
 *      → 下拉必须能问服务商要真实模型列表，不能再只有写死的预设表。
 *
 * 这个脚本只做**静态断言**（不连 CDP、不起浏览器 —— 历史教训：检查里连 CDP
 * 会把全量回归拖到十几分钟）。行为层由 check-live-items-parity 的「七、插话位置」
 * 那一节钉住（它在 node 里直接跑两份实现比对）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

const server = read('src/server.mjs');
const items = read('src-ui/items.js');
const html = read('public/index.html');
const parity = read('scripts/check-live-items-parity.mjs');

console.log('\n一、插话：服务端把 steer 合成进直播清单（两份实现同口径）');
{
  /* appendLiveItem 与 buildLiveItems 都必须有 steer 分支 */
  const branches = (server.match(/ev\.type === 'steer'|e\.type === 'steer'/g) || []).length;
  ok(branches >= 2, 'appendLiveItem + buildLiveItems 都有 steer 分支（' + branches + ' 处）',
    '少了一处 → 增量与从头重算会算出不同清单，屏幕会跳');

  ok(/k: 'user'[\s\S]{0,200}?steer: true/.test(server), 'steer → k:\'user\' 且带 steer 标记');

  /* /api/interject 的 steered 分支必须真的往 live 里推，不能只落 inbox */
  const ijIdx = server.indexOf("url.pathname === '/api/interject'");
  const ijSeg = ijIdx >= 0 ? server.slice(ijIdx, ijIdx + 9000) : '';
  ok(ijSeg.includes("type: 'steer'"), '/api/interject 在 steer 成功时推 live 事件',
    '没推的话前端只能等轮末，插话又会堆到屏幕最底');
}

console.log('\n二、插话：前端直出成主人气泡（不再走乐观 pend）');
{
  ok(/it\.k === 'user'/.test(items), 'src-ui/items.js 有 k:\'user\' 分支');
  ok(/kind: 'user'[\s\S]{0,240}?steer: true/.test(items), 'items.js 直出 kind:\'user\' + steer 标记');

  /* interject() 里不许再有 addUser 乐观气泡 —— 有就是双画 */
  const fnIdx = html.search(/async function interject[^{]*\{/);
  ok(fnIdx >= 0, 'public/index.html 里 interject() 还在');
  if (fnIdx >= 0) {
    const seg = html.slice(fnIdx, fnIdx + 6000);
    const bodyEnd = seg.indexOf('/api/interject');
    const head = bodyEnd >= 0 ? seg.slice(0, bodyEnd) : seg;
    /* 只看真实调用：注释里提到 addUser（说明「以前这么画」）不算。
     * 判据：行首去掉空白后不是 * 或 // 的，才算真代码。 */
    const codeLines = head.split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('*') && !l.startsWith('//') && !l.startsWith('/*'));
    const addUserCalls = codeLines.filter((l) => /\baddUser\s*\(/.test(l)).length;
    ok(addUserCalls === 0, 'interject() 发请求前不再画乐观气泡（真实 addUser 调用 ' + addUserCalls + ' 处）',
      '画了就是双画：live 里已经有一条真的\n       ' + codeLines.filter((l) => /\baddUser\s*\(/.test(l)).join('\n       '));
  }
}

console.log('\n三、插话：parity 检查钉住「消息1 → 插话 → 消息2」');
{
  ok(/type: 'steer'/.test(parity), 'parity 训练集里有 steer 事件');
  ok(/插话位置/.test(parity), 'parity 有插话位置专章');
  ok(/消息1[\s\S]{0,400}?消息2/.test(parity), 'parity 断言里含「消息1 → 插话 → 消息2」的形状');
}

console.log('\n四、模型列表：服务端有 discover 接口');
{
  ok(/url\.pathname === '\/api\/models\/discover'/.test(server), '/api/models/discover 路由存在');
  const dIdx = server.indexOf("url.pathname === '/api/models/discover'");
  const seg = dIdx >= 0 ? server.slice(dIdx, dIdx + 4000) : '';
  ok(/\/v1\/models/.test(seg), '会拼 /v1/models');
  ok(/AbortSignal\.timeout\(/.test(seg), '有超时（不能干等）');
  ok(/Authorization/.test(seg) && /Bearer/.test(seg), '带 Bearer 鉴权');
  /* key 绝不能进日志：日志里只许出现 keyLen（长度），不许出现 key 值本身。
   * 判据：某行 diagLog 里提到 _key0 或 key，但**不是** keyLen 那种写法，才算泄漏。
   * 注意别把「用已保存的 key（名字）」这种只写模型名的行算成泄漏 ——
   * 它写的是这条配置叫什么，不是 key 的值。 */
  const logLines = seg.split('\n').filter((l) => /diagLog\s*\(/.test(l));
  const leaked = logLines.filter((l) => {
    if (/keyLen/.test(l)) return false;                 // 只写长度，安全
    if (/用已保存的\s*key/.test(l)) return false;        // 只写配置名，安全
    return /\$\{?\s*(_key0|_key|key)\s*\}?/.test(l);     // 真的把 key 插进去了
  });
  ok(leaked.length === 0, '日志里不写 key 本身（只写 keyLen / 配置名）',
    leaked.map((l) => l.trim()).join('\n       '));
}

console.log('\n五、模型列表：前端有「拉一下」且预设表降级为兜底');
{
  ok(/id="mdlDiscoverBtn"/.test(html), '模型名那行有「拉一下」按钮');
  ok(/miniPick/.test(html), '按钮样式 .miniPick 已定义');
  ok(/api\/models\/discover/.test(html), '前端会调 discover 接口');
  ok(/mdlDiscovered/.test(html), '有「拉回来的列表」状态（地址一变作废）');
  /* 预设表必须还留着当兜底 —— 主人说的是不要「只有写死的」，不是把兜底删了 */
  ok(/const PROVIDERS = \[/.test(html), 'PROVIDERS 预设表保留（拉不到时兜底）');
  ok(/providerOf\(base\)/.test(html), '认厂商的兜底逻辑还在');
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);