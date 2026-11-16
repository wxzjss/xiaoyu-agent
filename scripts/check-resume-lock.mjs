#!/usr/bin/env node
/**
 * 守一条：退出路径记的续跑账（locked）不许被「上一轮跑完的收尾」顺手删掉。
 *
 * 【2026-11-15 事故】主人报「连续重启后，检查鱼 / 小鲸鱼 / 修理鱼都没续上，只有小白曦续上」。
 * 日志实锤（23:59:23）：
 *   · 退出那一刻 4 个会话都记住了（quit-resume ×4）
 *   · 同一秒里上一轮**续跑跑完**的 3 个会话各自收尾清账（resume-done → dropInterrupted）
 *   · 它们的读-改-写把另外几条一起抹掉 → 新实例开机只看到 1 条，只续上 1 个
 *
 * 修法：退出路径 markInterrupted({locked:true})；dropInterrupted 不带 force 时跳过 locked 账；
 * 只有「续跑真的跑成功了」才 dropInterrupted(id, {force:true})。
 * 顺带把写盘改成 tmp+rename（原子），多进程过渡期不会留半截 JSON。
 *
 * 跑法：node scripts/check-resume-lock.mjs   （不碰真数据，全程临时目录）
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

const __dir = dirname(fileURLToPath(import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'resume-lock-'));
process.env.MINI_AGENT_DATA = dir;

const m = await import(pathToFileURL(join(__dir, '..', 'src', 'resume.mjs')).href);

let pass = 0;
let fail = 0;
const ok = (c, name, detail = '') => {
  if (c) { pass++; console.log('  ✔ ' + name); } else { fail++; console.log('  ✘ ' + name + (detail ? '  → ' + detail : '')); }
};

const ids = ['sA', 'sB', 'sC', 'sD'];
const wrote = ids.map((id) => m.markInterrupted({ sessionId: id, text: '半截话', autoResume: true, locked: true }));
ok(wrote.every(Boolean), '退出账 4 条都写成功', JSON.stringify(wrote));
ok(m.listInterrupted().length === 4, '4 条都在（一个会话一条）', String(m.listInterrupted().length));

for (const id of ['sA', 'sB', 'sC']) m.dropInterrupted(id);
ok(m.listInterrupted().length === 4, '上一轮跑完的收尾（无 force）删不掉 locked 账', String(m.listInterrupted().length));

m.dropInterrupted();
ok(m.listInterrupted().length === 4, '无参清账也不会一把抹掉 locked', String(m.listInterrupted().length));

m.dropInterrupted('sA', { force: true });
ok(m.listInterrupted().length === 3, '续跑真成功（force）能清掉自己那条', String(m.listInterrupted().length));
ok(!m.listInterrupted().some((x) => x.sessionId === 'sA'), 'sA 清了、其余三条还在');

m.markInterrupted({ sessionId: 'sE', text: '普通账' });
const before = m.listInterrupted().length;
m.dropInterrupted('sE');
ok(m.listInterrupted().length === before - 1, '普通账（非 locked）跑完照旧删', `${before} → ${m.listInterrupted().length}`);

const f = join(dir, '.state', 'resume.json');
let parsed = null;
try { parsed = JSON.parse(readFileSync(f, 'utf8')); } catch {}
ok(existsSync(f) && !!parsed && Array.isArray(parsed.items), 'resume.json 是合法 v2（原子写没留半截）');
ok(!!parsed && parsed.items.filter((x) => x.locked === true).length === 3, 'locked 字段落盘了（3 条）');

console.log(`\n── resume 退出账锁定：${pass} 过 / ${fail} 挂 ──`);
process.exit(fail ? 1 : 0);
