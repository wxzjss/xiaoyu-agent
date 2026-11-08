import fs from 'node:fs';


// tools.mjs 必须先加载：它和 tools-sendfile 是循环依赖，反过来会 ReferenceError
const { runWithToolContext } = await import('../src/tools.mjs');
const { sendFileTool } = await import('../src/tools-sendfile.mjs');
const { normalizeSend } = await import('../src/outbox.mjs');

let pass = 0, fail = 0;
const chk = (label, ok, extra) => {
  if (ok) { pass++; console.log('  ✔ ' + label); } else { fail++; console.log('  ✘ ' + label + (extra ? '  → ' + extra : '')); }
};

// 造一个可控的小文件
const tmp = 'D:/小鱼Agent/_sf_probe.txt';
fs.writeFileSync(tmp, 'hello 发文件', 'utf8');

// ① 直接调工具，看它推没推 sentfile
const events = [];
const box = [];
const out = await runWithToolContext(
  { sessionId: 'test-sendfile', outbox: box, pushEvent: (ev) => events.push(ev), stashFile: () => {} },
  () => sendFileTool.run({ path: tmp, note: '探针文件' }),
);
chk('工具返回成功文案', typeof out === 'string' && out.indexOf('已经交到主人手上') >= 0, String(out).slice(0, 60));
chk('推了一条 sentfile 事件', events.length === 1 && events[0].type === 'sentfile', JSON.stringify(events[0] || {}).slice(0, 80));
const ev = events[0] || {};
chk('事件带的文件有 name/size/kind/key', !!(ev.file && ev.file.name && ev.file.size > 0 && ev.file.kind && ev.file.key), JSON.stringify(ev.file || {}).slice(0, 90));
chk('事件带的 note 传下去了', ev.note === '探针文件', String(ev.note));

// ② 路径边界
const r1 = normalizeSend('_sf_probe.txt');
chk('相对路径能认（转成工作区绝对路径）', !!(r1.entry || r1.skip), JSON.stringify(r1).slice(0, 80));
const r2 = normalizeSend('D:/小鱼Agent/playground');
chk('文件夹不崩，要么展开要么说明', !!(r2.kids || r2.skip), JSON.stringify(r2).slice(0, 80));
const r3 = normalizeSend('D:/不存在的文件xyz.txt');
chk('不存在的文件给明确提示', !!r3.skip && r3.skip.indexOf('找不到') >= 0, String(r3.skip));
const r4 = normalizeSend('');
chk('空路径给提示', !!r4.skip, String(r4.skip));

// ③ 零字节文件
const zero = 'D:/小鱼Agent/_sf_zero.txt';
fs.writeFileSync(zero, '', 'utf8');
const r5 = normalizeSend(zero);
chk('空文件被拦并说明', !!r5.skip && r5.skip.indexOf('空文件') >= 0, String(r5.skip));

// ④ 出的文件真的落到 outbox 目录了吗（重启后还在）
const key = (ev.file && ev.file.key) || '';
chk('拿到了 outbox key', !!key, key);
try {
  const { outboxPath } = await import('../src/outbox.mjs');
  const p = outboxPath(key);
  chk('outbox 里真有一份副本', !!(p && fs.existsSync(p)), String(p));
} catch (e) {
  chk('outbox 里真有一份副本', false, String(e.message).slice(0, 50));
}

/* 【2026-11-08 修】清理不能裸奔：某些环境会给 fs.unlinkSync 套一层
 * 安全删除 shim，删不掉就抛异常 —— 那会把整个检查脚本带崩，
 * 报成「check-sendfile 失败」，可被测的功能其实全过了。包起来。 */
try { fs.unlinkSync(tmp); } catch {}
try { fs.unlinkSync(zero); } catch {}

console.log('');
console.log(fail ? ('★ 失败 ' + fail + ' 条 / 通过 ' + pass) : ('PASS 发文件 ' + pass + ' 项全过'));
process.exit(fail ? 1 : 0);
