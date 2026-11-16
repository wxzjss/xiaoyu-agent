// 临时脚本：把运行时真正生效的那套提示词原样导出（system 段 + user 上下文段）
// 用法：cd scripts; node _dump_live_prompt.mjs <sessionId> <outPath>
// 关键：agentId 必须跟 server.mjs 真实那一轮用同一个算法（mainAgentId(sessionId, mateSwitchOn)），
//      否则「你现在是「小鲸」」那段拼不出来，导出来就不是真发出去的那份。
import fs from 'node:fs';
import { systemPrompt, contextMessage } from '../src/agent.mjs';
import { mainAgentId, agentForSession } from '../src/agents.mjs';


const sid = process.argv[2] || 'default';
const out = process.argv[3] || '';

let safeMode = false, safeWord = '';
try {
  const p = process.env.APPDATA + '\\小鱼Agent\\data\\.state\\sessions\\' + sid + '.json';
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  if (j && j.mode && j.mode.word) { safeMode = true; safeWord = j.mode.word; }
} catch {}

let agentId = '';
try { agentId = String(mainAgentId(sid) || ''); } catch (e) { console.log('mainAgentId fail:', e.message); }
let agentName = '';
try { const a = agentForSession(sid, agentId); agentName = (a && (a.name || a.id)) || ''; } catch (e) { console.log('agentForSession fail:', e.message); }

const sys = systemPrompt(sid, { safeMode, safeWord, agentId });
const ctx = contextMessage(sid, { safeMode, safeWord, agentId });

const bar = '='.repeat(70);
const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
const parts = [
  `【提示词导出·运行时原文】会话 ${sid}（${agentName || agentId || '默认人设'}）`,
  `导出时间 ${stamp}　绑定卡 ${agentId || '(默认)'}　安全词档 ${safeMode ? safeWord : '(人设档)'}`,
  `system ${sys.length} 字 + 上下文 ${ctx.length} 字 = 合计 ${sys.length + ctx.length} 字`,
  bar,
  '',
  '【第 1 段】system 段（只有一句身份锚；规矩不在这儿，因为很多网关会吞 system）',
  bar,
  sys,
  '',
  bar,
  '【第 2 段】user 上下文段 —— 这才是真正那套规矩：人设、程序规矩、记忆本、压缩规矩全在这',
  bar,
  ctx,
  '',
];
const text = parts.join('\n');

if (out) {
  fs.writeFileSync(out, text, 'utf8');
  console.log('WROTE', out, text.length, 'chars | agentId=', agentId, agentName, '| safe=', safeMode ? safeWord : '-');
} else {
  console.log(text);
}
