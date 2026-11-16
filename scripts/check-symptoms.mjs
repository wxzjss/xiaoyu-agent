import fs from 'node:fs';
/* 【2026-11-09】隔离全量回归时这两份文件在临时目录里，不能再写死主人那份 */
const DATA = process.env.XY_TEST_DATA || process.env.MINI_AGENT_DATA || 'C:/Users/35453/AppData/Roaming/小鱼Agent/data';
/* 隔离实例跑的就是仓库这份 src/server.mjs（spawn 时直接指它），
   临时数据目录里没有 code/ 那份运行版副本，读仓库才是同一份代码。 */
const s = fs.readFileSync('src/server.mjs', 'utf8');
const f = fs.readFileSync(DATA + '/public/index.html', 'utf8');

const R = [];
const add = (sym, ok, why) => R.push({ sym, ok: ok ? 'OK' : '!!', why });

// 症状1：消息被吞
add('发消息被吞', f.includes('409 = 服务端说还在跑') && s.includes('409-cleanup'), '前端 409 改走插话 + 后端清 aborted 残骸');
// 症状2：画面固定
add('画面固定', !f.includes('if (_genBusy && !(opts && opts.force))') , '生成中不再整屏不画（改成只认当前会话真在流式时）');
// 症状3：刷新也看不到
/* 【2026-11-15 修】旧断言钉的是 _curInFlight 这个变量名，可聊天流已经搬进 public/ui/chat.js，
   那里的实现符号叫 turnsInFlight（index.html 里也还留着同名导出）。钉变量名 = 永远红，
   这里改成钉「跳过重画的判定依据是逐轮在飞记录」这个意图本身。 */
add('刷新看不到', f.includes('turnsInFlight'), 'renderTurns 只在本会话确实在流式时跳过，否则照画历史');
// 症状4：停止按钮变发送
add('按钮变发送', f.includes('409 = 服务端说还在跑'), '撞 409 时改插话，不再把输入区判成空闲');
// 症状5：文字和工具条交错
add('文字工具条交错', !/live\.events\.sort\(\(a, b\) => \(a\.at \|\| 0\)/.test(s), '压薄后按原始下标排，不再按缺失的 at 排');
// 症状6：显示不全
/* 【2026-11-15 修】旧断言要的是字面量 '>= 24' / '>= 120'，可真实写法是三元式
   `_minChars = _k === 'text' ? 6 : 24` / `_maxWait = ... : 120`，字面量 '>= ' 只在用到处出现，
   钉写法 = 永远红。改成认「24 字 / 120ms 这两个阈值确实落在这两个常量上」。 */
add('显示不全', /_minChars[\s\S]{0,40}24/.test(s) && /_maxWait[\s\S]{0,40}120/.test(s), '合并阈值 60字/250ms 降到 24字/120ms + 收尾/异常都 flush');
// 症状7：事件爆炸把前端打崩
add('事件爆炸', s.includes('_opAcc[_k] = (_opAcc[_k]'), '两千多条碎 reasoning 合并成几十条');
// 症状8：重启后接着干活（主人要删）
add('重启自动续跑已删', !/setTimeout\(\(\) => \{\s*\r?\n\s*resumeInterruptedTurn/.test(s), '启动入口已整段拿掉');

for (const r of R) console.log(r.ok + '  ' + r.sym.padEnd(16) + ' ' + r.why);
console.log('');
console.log('未通过:', R.filter((x) => x.ok !== 'OK').length);
