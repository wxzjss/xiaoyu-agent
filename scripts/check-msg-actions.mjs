#!/usr/bin/env node
/**
 * 【2026-11-10 主人问「重发/删除/回退/编辑/分支 有没有问题」】：静态守卫
 *
 * 查出来的真 bug 一个：
 *   · EditArea 保存时漏传 at → 后端 editMessage 拿不到下标 → 必报「这句不能改」。
 *     主人点「存上」永远失败，还以为这句话本身不能改。**已修**，这里钉住。
 *
 * 顺带钉住五个按钮的「接线」不被打断（React 收编后按钮全靠 attach* 装饰器挂）：
 *   · user 消息要有 回退/编辑/分支/删除
 *   · assistant 消息要有 编辑/分支/删除/重发（没有回退 —— 回退只认 user 那一问）
 *   · 后端五个接口都得在（rewind / edit / edit-undo / message-delete / branch）
 *
 * 只做静态断言：不连 CDP、不起浏览器（历史教训：检查里连 CDP 会拖垮全量回归）。
 * 行为层由 check-log-react 与 check-msg-actions-live 覆盖。
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

const editarea = read('src-ui/EditArea.jsx');
const userb = read('src-ui/UserBubble.jsx');
const asstb = read('src-ui/AssistantBubble.jsx');
const server = read('src/server.mjs');
const html = read('public/index.html');

console.log('\n一、编辑：保存必须带 at（2026-11-10 真 bug，别复发）');
{
  /* 抓 /api/sessions/edit 那一段请求体，看有没有 at */
  const i = editarea.indexOf('/api/sessions/edit');
  ok(i >= 0, 'EditArea 里能找到 /api/sessions/edit 调用');
  if (i >= 0) {
    const seg = editarea.slice(i, i + 900);
    const bodyIdx = seg.indexOf('JSON.stringify');
    const bodySeg = bodyIdx >= 0 ? seg.slice(bodyIdx, bodyIdx + 400) : '';
    ok(/\bat\b/.test(bodySeg), '保存请求体里有 at（漏了必失败：后端靠它定位改哪一句）',
      '请求体片段：' + bodySeg.slice(0, 200));
  }
  /* 撤销那条也必须带 at（对照用；它本来就有） */
  const j = editarea.indexOf('/api/sessions/edit-undo');
  ok(j >= 0 && /\bat\b/.test(editarea.slice(j, j + 600)), '撤销请求体里也有 at');
  /* 后端 editMessage 的定位判据没被放宽 */
  const ed = read('src/edit.mjs');
  ok(/Number\.isInteger\(n\)/.test(ed), '后端仍然要求 at 是整数下标（没被放宽成「随便改」）');
}

console.log('\n二、五个按钮：React 装饰器接线没断');
{
  ok(/attachRewind/.test(userb), 'user 消息挂回退（attachRewind）');
  ok(/attachEdit/.test(userb), 'user 消息挂编辑（attachEdit）');
  ok(/attachBranchBtn/.test(userb), 'user 消息挂分支（attachBranchBtn）');
  ok(/attachDelBtn/.test(userb), 'user 消息挂删除（attachDelBtn）');

  ok(/attachEdit/.test(asstb), 'assistant 消息挂编辑');
  ok(/attachBranchBtn/.test(asstb), 'assistant 消息挂分支');
  ok(/attachDelBtn/.test(asstb), 'assistant 消息挂删除');
  ok(/attachRetry/.test(asstb), 'assistant 消息挂重发（attachRetry）');
  ok(!/attachRewind/.test(asstb), 'assistant 消息**不挂**回退（回退只认 user 那一问，挂错就是退不回去）');

  /* 装饰器本体还在（收编边界 P3：短期容忍、长期收编，不能悄悄消失） */
  for (const fn of ['attachRewind', 'attachEdit', 'attachBranchBtn', 'attachDelBtn', 'attachRetry']) {
    ok(new RegExp('function ' + fn + '\\s*\\(').test(html), '装饰器 ' + fn + ' 本体还在 index.html');
  }
}

console.log('\n三、后端五个接口都在');
{
  const routes = [
    ['/api/sessions/rewind', '回退'],
    ['/api/sessions/edit', '编辑'],
    ['/api/sessions/edit-undo', '撤销编辑'],
    ['/api/sessions/message-delete', '删除'],
    ['/api/sessions/branch', '分支'],
  ];
  for (const [p, name] of routes) {
    ok(server.includes("'" + p + "'"), name + ' 接口 ' + p + ' 存在');
  }
  /* 重发不是独立接口：它是「回退 + 再发一次」，所以只要求 rewind 在（上面已验） */
}

console.log('\n四、跑动期不许改（五个动作都要有 busy 拦截）');
{
  /* 后端三处：rewind / message-delete / edit 都拦了正在跑的那一轮 */
  for (const [p, name] of [['/api/sessions/rewind', '回退'], ['/api/sessions/message-delete', '删除'], ['/api/sessions/edit', '编辑']]) {
    const i = server.indexOf("'" + p + "'");
    const seg = i >= 0 ? server.slice(i, i + 1200) : '';
    ok(/409/.test(seg), name + ' 在跑动期返回 409（不让在跑的时候改历史）');
  }
}

console.log('\n五、删除按钮的老毛病：原生 alert 不得回到按钮路径上');
{
  /* 【2026-11-10】丙报「24 处裸 alert 清零」，但按钮路径上其实还有几处。
   * 运行时被 window.alert 重写兜住了（能用），但源码里留着会误导人 ——
   * 这儿只要求「兜底还在」，不要求源码零 alert（那是另一件事，别混）。 */
  ok(/window\.alert\s*=\s*function/.test(html), 'window.alert 兜底重写还在（裸 alert 不会弹原生框）');
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);