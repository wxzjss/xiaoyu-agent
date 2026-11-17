#!/usr/bin/env node
/**
 * 守一条（2026-11-15 主人钦点，2026-11-17 改档）：
 *   新建会话时，左上角「思考强度」默认是【自动】。
 *   （最初默认是「低」，11-17 主人要求加「自动」档并把它设成新会话默认，判据跟着改。）
 *
 * 要求写清：**只影响新会话**——
 *   · 不能顺手把右上角给模型设的全局档改掉（那是另一件事，主人没让动）；
 *   · 不能把老会话也改掉（它们各自的设置原样保留）；
 *   · 新会话那个「自动」是**会话级覆盖**，主人在左上角换成别的，下次打开还是他选的。
 *
 * 另外钉住 UI 那侧的一个副作用：出厂默认档不该把思考框染成「自定义」色。
 *
 * 跑法：node scripts/check-new-session-low.mjs   （纯源码守卫 + 真写一遍 override）
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' —— ' + extra : '')); }
};

const __dir = dirname(fileURLToPath(import.meta.url));
const server = readFileSync(join(__dir, '..', 'src', 'server.mjs'), 'utf8');

console.log('〔新建会话默认「自动」〕');
ok('常量定义在（auto）', /const NEW_SESSION_DEFAULT_LEVEL = 'auto';/.test(server));
ok('makeSession 里给新会话写这条覆盖',
  /function makeSession\(payload = \{\}, opts = \{\}\) \{[\s\S]{0,1400}setOverride\(id, \{ level: NEW_SESSION_DEFAULT_LEVEL \}\)/.test(server));
ok('写覆盖包了 try（设不上也不能把新建弄挂）',
  /try \{ setOverride\(id, \{ level: NEW_SESSION_DEFAULT_LEVEL \}\); \} catch/.test(server));
ok('分支会话跟着原会话走、没有就落「自动」',
  /setOverride\(newId, _ov\.level \? \{ level: _ov\.level \} : \{ level: NEW_SESSION_DEFAULT_LEVEL \}\)/.test(server));
ok('没去改全局默认（thinking 的全局档一个字没动）',
  !/setThinkingLevel\(/.test(server) && !/\.level = ['"]auto['"]/.test(server));
ok('出厂默认档不算自定义（框不染色）',
  /isLevelCustom: Boolean\(level\) && String\(level\) !== NEW_SESSION_DEFAULT_LEVEL/.test(server));

console.log('〔真写一遍：会话级覆盖存得住、不串会话〕');
const dir = mkdtempSync(join(tmpdir(), 'xy-newlow-'));
process.env.MINI_AGENT_DATA = dir;
const ov = await import(pathToFileURL(join(__dir, '..', 'src', 'session-overrides.mjs')).href);
ov.setOverride('newA', { level: 'auto' });
ok('新会话读出来就是 auto', ov.getOverride('newA').level === 'auto');
ov.setOverride('oldB', { level: 'max' });
ok('老会话自己的档没被牵连', ov.getOverride('oldB').level === 'max');
ok('没设过的会话仍是「跟全局走」', ov.getOverride('untouched').level === undefined);
ov.setOverride('newA', { level: '' });
ok('主人手动改回去（清空）也能生效', ov.getOverride('newA').level === undefined);
try { rmSync(dir, { recursive: true, force: true }); } catch {}

console.log('');
console.log(`结果：${pass} 过 / ${fail} 挂`);
process.exit(fail ? 1 : 0);
