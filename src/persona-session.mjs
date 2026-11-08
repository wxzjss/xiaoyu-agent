// 人设「按会话」而不是「全局」—— 2026-11-01
//
// 主人原话：「让多套人设里的人设按会话来，而不是全局切换，比如说A会话是默认人设，
//            我把A会话切换成这个人设，B会话依旧是默认人设。」
//
// 存法：`.state/persona-sessions.json`
//   { "<scope>": { "<sessionId>": "<personaId>" } }
//   scope = '' 是小鱼（主人自己那个库），'whale' 是小鲸，别的自建卡就是它的 id。
//
// 三条规矩：
//   1. **没记过 = 用这个库当前那套**（全局的 `current` 还在，它只是从「唯一开关」
//      降级成「新会话的起点」）。所以老数据、老行为一个字节都不用改。
//   2. 记过的 id 如果在库里已经删了，就当没记过（回落到全局那套），不让会话卡在半空。
//   3. 删会话时把它的记录一起清掉 —— 不清的话同一串 id 不会再出现，但文件会一直长。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const FILE = join(config.dataDir, '.state', 'persona-sessions.json');

/** 只许字母数字下划线横线（scope 会被拼进文件里的 key，不许有别的花样） */
function scopeOk(x) {
  return typeof x === 'string' && /^[A-Za-z0-9_-]{0,64}$/.test(x);
}

function normScope(scope) {
  const s = String(scope ?? '').trim();
  if (!s || s === 'xiaoyu' || s === 'fish') return '';
  return scopeOk(s) ? s : '';
}

function readAll() {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

function writeAll(obj) {
  try {
    mkdirSync(join(config.dataDir, '.state'), { recursive: true });
    // 全空就把文件删掉，别留一个 {} 在那儿让人猜
    const any = Object.keys(obj).some((k) => obj[k] && Object.keys(obj[k]).length);
    if (!any) {
      if (existsSync(FILE)) writeFileSync(FILE, '{}\n', 'utf8');
      return;
    }
    writeFileSync(FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch {
    /* 记不上就算了：最坏情况是这次切换只在这一轮生效，不该把整轮搞挂 */
  }
}

/** 这个会话在哪个库里用了哪套；没记过返回 '' */
export function sessionPersonaId(scope, sessionId) {
  const s = normScope(scope);
  const sid = String(sessionId ?? '').trim();
  if (!sid) return '';
  const all = readAll();
  const per = all[s];
  if (!per || typeof per !== 'object') return '';
  const id = String(per[sid] ?? '').trim();
  return id;
}

/** 记下「这个会话用哪套」。id 传空 = 抹掉（回到全局那套） */
export function setSessionPersona(scope, sessionId, id) {
  const s = normScope(scope);
  const sid = String(sessionId ?? '').trim();
  if (!sid) return { ok: false, error: '没有会话 id' };
  const want = String(id ?? '').trim();
  const all = readAll();
  if (!all[s] || typeof all[s] !== 'object') all[s] = {};
  if (!want) delete all[s][sid];
  else if (!/^[A-Za-z0-9_-]{1,64}$/.test(want)) return { ok: false, error: '人设 id 不对' };
  else all[s][sid] = want;
  writeAll(all);
  return { ok: true, scope: s, sessionId: sid, id: want };
}

/** 会话删了：把所有库里跟它有关的记录都清掉 */
export function clearSessionPersona(sessionId) {
  const sid = String(sessionId ?? '').trim();
  if (!sid) return 0;
  const all = readAll();
  let n = 0;
  for (const s of Object.keys(all)) {
    const per = all[s];
    if (per && typeof per === 'object' && Object.prototype.hasOwnProperty.call(per, sid)) {
      delete per[sid];
      n += 1;
    }
  }
  if (n) writeAll(all);
  return n;
}

/** 面板要看的那张表（某个库的；不传就是全部） */
export function sessionPersonaMap(scope) {
  const all = readAll();
  if (scope === undefined) return all;
  const per = all[normScope(scope)];
  return per && typeof per === 'object' ? { ...per } : {};
}
