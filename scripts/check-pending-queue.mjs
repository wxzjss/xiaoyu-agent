/**
 * 【消息预发送队列】
 *
 * 主人 2026-11-08 要求：
 *   「增加和 workbuddy 一样的消息预发送机制：运行时发送消息会暂时保管这条消息，
 *    等一轮结束后自动发送出去，也可手动直接发送或收回编辑或删除这条预发送消息」
 *
 * 查了两家的实现（主人说「你也可以看 deepseek harness 是怎么实现的」）：
 *   · WorkBuddy：只有 IPC 层的 `pendingSendPromptRequests`（没有订阅者就先存着），
 *     以及 `messageQueueConfig` / `sendQueue` 这类传参和状态名；
 *     中文语言包里连「排队」「待发送」都没有 —— 没找到完整的 UI 队列实现。
 *   · DeepSeek Harness：`lib/main.js` 里 `interject` / `排队` 各 0 处，`steer` 只有
 *     「页面不能导航回本地文件」那个意思 —— 压根没有这个功能。
 * 所以按需求自己实现，思路照 WorkBuddy 那个「忙就先存着、空了再交付」。
 *
 * 设计：
 *   · 忙时按回车 → 入队（**不再**走 interject 打断；打断那条保留，队列里点「直接发送」用它）
 *   · 队列按会话分 key 存 localStorage，刷新不丢
 *   · 每条三个按钮：直接发送 / 编辑（撤回输入框）/ 删除
 *   · 一轮结束用 2 秒轮询兜底（结束出口有好几个，一个个挂容易漏）
 */
import { makeChecker } from './_harness_util.mjs';
import { readUISource } from './_ui-src.mjs';
import fs from 'node:fs';
import { connect } from '../_t_cdp.mjs';

const t = makeChecker('ui / 消息预发送队列');
const ui = readUISource();

// ── 1. 源码：零件齐不齐 ────────────────────────────────────────
t.ok('有队列容器', /id="pendingQueue"/.test(ui));
t.ok('有金色虚线卡片样式', /\.pendingItem button\.go/.test(ui) && /border: 1px dashed rgba\(240,185,84/.test(ui));
t.ok('有入队函数', /function enqueueMessage\(/.test(ui));
t.ok('有「直接发送」', /function sendPendingNow\(/.test(ui));
t.ok('有「编辑」（撤回输入框）', /function editPending\(/.test(ui));
t.ok('有「删除」', /function removePending\(/.test(ui));
t.ok('有一轮结束后的自动发出', /async function flushPendingQueue\(/.test(ui));
t.ok('用轮询兜底（结束出口有好几个，挂点容易漏）',
  /setInterval\(\(\) => \{[\s\S]{0,260}_flushingPending && pendingQueue\.length/.test(ui));
t.ok('按会话分 key 存 localStorage', /'xy_pending_' \+ \(sessionId/.test(ui));
t.ok('忙时回车入队（不再直接打断）', (ui.match(/else queueFromInput\(\);/g) || []).length >= 2);
t.ok('打断那条还在（队列里「直接发送」要用）', /async function interject\(\)/.test(ui));
t.ok('切会话会载入那个会话的队列', /loadPendingQueue\(\);/.test(ui));

/* 【2026-11-08 加·别再把主人的话吞了】
 *
 * 老写法 `const next = pendingQueue.shift(); savePendingQueue(); await runTurn(...)`
 * —— runTurn 一抛错，那条已经不在队列、盘上也删了，catch 又是空的，消息就这么没了。
 * 这跟服务端 `pending.shift()` 提前取走那个坑同一形状。
 * 现在要求：先发，成功才按 id 取走；失败留着并记次数。
 */
t.ok('不是先 shift 再发（那样一抛错就丢话）',
  !/pendingQueue\.shift\(\);\s*\n\s*savePendingQueue\(\);[\s\S]{0,200}await runTurn/.test(ui));
t.ok('发出去了才把那条取走', /if \(sent\)[\s\S]{0,260}findIndex[\s\S]{0,120}splice\(ix, 1\)/.test(ui));
t.ok('发失败留在队列里（不删）', /next\._tries = \(Number\(next\._tries\) \|\| 0\) \+ 1/.test(ui));
t.ok('失败有上限，不会每 2 秒转到天亮', /\(Number\(next\._tries\) \|\| 0\) >= 3\) return/.test(ui));

/* 【2026-11-08 加·「一份发了、一份还挂着」】
 * runTurn 是先落盘再接流式；流断了会抛错，可服务端已经收下那句话。
 * 不能靠文本比对猜（短句本来就重复），也不能直接删（万一真没发就丢）。
 * 现在标成不确定：不删、不自动重发、界面提示主人自己决定。 */
t.ok('抛错时标成「可能已发出」', /next\._uncertain = true/.test(ui));
t.ok('不确定的那条不再自动重发', /if \(next\._uncertain\) return/.test(ui));
t.ok('界面明确写出这个状态', /可能已发出/.test(ui) && /_uncertain \? '可能已发出'/.test(ui));

/* 【2026-11-08 加·删掉的预发送消息重启后跑回输入框】
 * 草稿 xy.draft.<sid> 和队列 xy_pending_<sid> 是两个独立 key。
 * 入队时只把 input.value 清空（程序改 value 不触发 input 事件，草稿没清），
 * 主人删了队列项、重启后 restoreDraft() 又把草稿写回输入框。
 * 真实 leveldb 里那个草稿 key 出现 98 次、最后一份仍有内容 —— 实证。 */
t.ok('入队时同步作废草稿', /enqueueMessage\(t, a\);[\s\S]{0,900}clearDraft\(\)/.test(ui));
t.ok('删除队列项时按文本比对清掉历史残留草稿',
  /function removePending\(id\)[\s\S]{0,400}localStorage\.getItem\(draftKey\(\)\)[\s\S]{0,200}clearDraft\(\)/.test(ui));

// ── 2. 真机 ────────────────────────────────────────────────────
let cdp = null;
try { cdp = await connect({ port: Number(process.env.XY_CDP_PORT || 9223), match: '8788' }); } catch { cdp = null; }

if (!cdp) {
  console.log('\n真机格：SKIP（没连上 9223 的调试浏览器，源码断言已过）');
} else {
  await cdp.send('Page.enable');
  await cdp.send('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 12000));

  const r = await cdp.eval(`
    const out = {};
    const inp = document.getElementById('input');
    const box = document.getElementById('pendingQueue');
    const oldBusy = busy;
    try {
      pendingQueue.length = 0; savePendingQueue(); renderPendingQueue();
      out.startedEmpty = box.hidden === true;

      busy = true;
      inp.value = '这是排队的第一条';
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      out.queued = pendingQueue.length;
      out.shown = box.hidden === false;
      out.cleared = inp.value === '';
      out.text = (box.querySelector('.pendingItem .ptext') || {}).textContent || '';
      out.btns = [...box.querySelectorAll('.pendingItem button')].map((b) => b.textContent);

      inp.value = '第二条';
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      out.two = pendingQueue.length;

      box.querySelector('.pendingItem button:last-of-type').click();
      out.afterDel = pendingQueue.length;

      const bEdit = [...box.querySelectorAll('.pendingItem button')].find((b) => b.textContent === '编辑');
      bEdit.click();
      out.afterEdit = pendingQueue.length;
      out.inputBack = inp.value;

      out.stored = (localStorage.getItem(pendingStoreKey()) || '').length > 0;

      inp.value = '';
      pendingQueue.length = 0; savePendingQueue(); renderPendingQueue();
    } catch (e) { out.err = String(e); }
    busy = oldBusy;
    return JSON.stringify(out);
  `);
  const got = JSON.parse(r);
  console.log('  真机：' + r);

  t.ok('一开始是空的（不显示）', got.startedEmpty === true);
  t.ok('忙时按回车 → 进了队列', got.queued === 1, String(got.queued));
  t.ok('队列卡片显示出来了', got.shown === true);
  t.ok('输入框被清空', got.cleared === true);
  t.ok('队列里能看到原文', got.text === '这是排队的第一条', String(got.text));
  t.ok('三个按钮齐全（直接发送 / 编辑 / 删除）',
    JSON.stringify(got.btns) === JSON.stringify(['直接发送', '编辑', '删除']), JSON.stringify(got.btns));
  t.ok('第二条也进得去', got.two === 2, String(got.two));
  t.ok('删除一条', got.afterDel === 1, String(got.afterDel));
  t.ok('编辑会出队', got.afterEdit === 0, String(got.afterEdit));
  t.ok('编辑会把内容放回输入框', got.inputBack === '第二条', String(got.inputBack));
  t.ok('存进了 localStorage（刷新不丢）', got.stored === true);

  cdp.close();
}

t.done();
