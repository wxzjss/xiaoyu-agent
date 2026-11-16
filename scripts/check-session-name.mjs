/**
 * check-session-name.mjs — 守「会话名」这一整套规矩。
 *
 * 主人 2026-11-16 原话（四条一起）：
 *   ① 「为什么每个会话的ai都不知道自己的会话名是什么？我希望能随会话名的变化
 *      动态知道自己的会话名现在叫什么。」
 *   ② 「【会话】页不能有同样的会话名，如果有同样的会话名，就自动在那个名字后面加一个数字」
 *   ③ 「会话名不能随会话内发送的消息动态变化（比如我在会话里发了个继续，
 *      会话名不能因此变成继续）」
 *   ④ 「只能由主人手动填写或会话里的ai发现自己的会话名是【新会话】时，根据自己在干的活
 *      以及自己是鲸鱼娘还是人类还是猫娘等身份手动填写【xx鱼】【xx猫】【xx人】的会话名」
 *
 * 对应四条代码路径，一条断言一条，少一条就红。
 */
import { readFileSync } from 'node:fs';

const core = readFileSync(new URL('../src/sessions-core.mjs', import.meta.url), 'utf8');
const srv = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const tools = readFileSync(new URL('../src/tools.mjs', import.meta.url), 'utf8');
const sub = readFileSync(new URL('../src/subagent.mjs', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const persona = readFileSync(new URL('../src/persona.mjs', import.meta.url), 'utf8');
let pass = 0, fail = 0;
const ok = (n, c, x) => {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  [!!] ' + n + (x ? '  → ' + x : '')); }
};

/* ── ① 每轮告诉她当前会话名（动态） ───────────────── */
ok('每轮系统提示带「当前会话名」',
  /当前会话名：「' \+ _nameNow \+ '」/.test(srv) || /当前会话名：/.test(srv));
ok('名字取自 session.title（不是写死的）',
  /const _nameNow = String\(session\.title \|\| ''\)\.trim\(\) \|\| '新会话'/.test(srv));
ok('是「新会话」时把起名规矩一并给她',
  /_nameNow === '新会话'[\s\S]{0,200}rename_session/.test(srv));

/* ── ② 重名自动加数字 ─────────────────────────────── */
ok('有唯一化函数 uniqueSessionTitle',
  /export function uniqueSessionTitle\(id, wantTitle\)/.test(core));
ok('追加的是「名字 + 空格 + 数字」',
  /stem \+ ' ' \+ n/.test(core));
ok('renameSession 走唯一化（主人手动改名也去重）',
  /const next = uniqueSessionTitle\(id, title\)/.test(core));
ok('新建会话也走唯一化',
  /title: uniqueSessionTitle\(id, String\(payload\?\.title/.test(srv));
ok('「新会话」不参与去重（否则 AI 起名判断失效）',
  /if \(base === '新会话'\) return base;/.test(core));

/* ── ③ 不许按消息自动改名 ─────────────────────────── */
ok('首句自动起名已删（chat 路径不再调 titleFromMessage）',
  !/session\.title = titleFromMessage\(message\)/.test(srv),
  '这句一回来，主人发个「继续」名字就变成「继续」');
ok('收尾兜底起名已删（用最近一句主人话补标题那段）',
  !/_newTitle && _newTitle !== '新会话'/.test(srv));

/* ── ④ AI 自己起名：工具 + 注入 + 前端同步 ────────── */
ok('有 rename_session 工具', /name: 'rename_session'/.test(tools));
ok('工具说明写了 xx鱼 / xx猫 / xx人',
  /xx鱼/.test(tools) && /xx猫/.test(tools) && /xx人/.test(tools));
ok('工具只能改自己会话（用 ctxNow().sessionId）',
  /const sid = ctxNow\(\)\.sessionId \|\| 'default';[\s\S]{0,300}fn\(sid, want\)/.test(tools));
ok('服务端注入改名通道（落盘 + 去重 + 广播）',
  /setSessionRenamer\(\(sid, title\) =>/.test(srv) && /renameSession\(id, title\)/.test(srv));
ok('改名后推 session_title 事件',
  /type: 'session_title'/.test(srv));
ok('前端收得到（更新标题 + 刷会话列表）',
  /ev\.type === 'session_title'/.test(ui) && /paintSessNow\(\)/.test(ui));

/* ── ⑤ 顺带：子Agent 步骤不能是英文工具名 ─────────── */
ok('子Agent 进度用中文功能名（label）而不是 tc.name',
  /onProgress\(`\$\{label\}\\$\{__argHint\}`\)/.test(sub)
  || (sub.includes('onProgress(`${label}${__argHint}`)') && !sub.includes('onProgress(`${tc.name}${__argHint}`)')),
  '用 tc.name 的话主人展开看到的是 run_command / read_file');

/* ── ⑥ 提示词里也有这条规矩 ───────────────────────── */
ok('系统提示写了会话名规矩',
  /【会话名 —— 你在哪个会话里】/.test(persona));

console.log('\n会话名：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
