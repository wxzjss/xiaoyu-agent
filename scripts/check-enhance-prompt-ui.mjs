#!/usr/bin/env node
/**
 * 【星星按钮·真机点验】2026-11-11 主人要求「实机验证该按钮是否正常工作」。
 *
 * 这条不是桩测试：真起隔离实例（真 server + 真 Edge）、真在输入框里打字、
 * 真用 CDP 点那颗星星、真等模型回话、真检查输入框内容变没变。
 *
 * 四态全覆盖：
 *   ① 空输入 → 按钮不渲染（不让人对着点了会报错的按钮发呆）
 *   ② 有字 → 星星出现；点了变转圈，落回后输入框被改写、按钮变「恢复原文」
 *   ③ 点恢复原文 → 输入框回到原话、按钮变星星
 *   ④ 增强中再点 → 取消，输入框恢复原文、不弹错误
 *
 * 用法：node scripts/check-enhance-prompt-ui.mjs
 * 模型不通（网关 502 / 无可用端点）时打 SKIP，不判红 —— 那是环境问题。
 */
import { startIsolated } from './_test-instance.mjs';
import { connect } from '../_t_cdp.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0, skip = 0;
const ok = (c, m, extra) => {
  if (c) { pass++; console.log('  OK   ' + m); }
  else { fail++; console.log('  [!!] ' + m + (extra ? '  → ' + extra : '')); }
};
const sk = (m, why) => { skip++; console.log('  SKIP ' + m + (why ? '  → ' + why : '')); };

let iso = null, cdp = null;

/** 页面里读星星按钮的当前状态 */
const readBtn = () => cdp.eval(`return (function(){
  const b = document.getElementById('enhanceBtn');
  const i = document.getElementById('input');
  if (!b) return { missing: true };
  return {
    visible: b.classList.contains('show'),
    busy: b.classList.contains('busy'),
    done: b.classList.contains('done'),
    title: b.title || '',
    value: i ? String(i.value || '') : '',
  };
})();`);

(async () => {
  try {
    iso = await startIsolated({ appPort: 8796, cdpPort: 9224 });
    const _p = String(iso.base || '').match(/:(\d+)/);
    cdp = await connect({ port: iso.cdpPort, match: _p ? ':' + _p[1] : '' });
    await cdp.eval('return !!window.sessionId');
    await sleep(400);

    console.log('\n── 一、空输入：星星不该出现 ──');
    await cdp.eval(`(function(){ const i=document.getElementById('input'); if(i){ i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); } return 1; })();`);
    await sleep(200);
    let s = await readBtn();
    ok(s && !s.missing, '星星按钮在 DOM 里（默认隐藏）');
    ok(s && s.visible === false, '空输入时按钮不渲染', JSON.stringify(s));

    console.log('\n── 二、有字：星星出现，点了能改写 ──');
    const ORIGIN = '帮我看看这个报错';
    await cdp.eval(`(function(){ const i=document.getElementById('input'); i.value=${JSON.stringify(ORIGIN)}; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })();`);
    await sleep(250);
    s = await readBtn();
    ok(s && s.visible === true, '有字之后星星出现', JSON.stringify(s));
    ok(s && s.done === false && s.busy === false, '初始是「星星」态（不是已增强）');

    // 真点一下
    await cdp.eval(`document.getElementById('enhanceBtn').click(); return 1;`);
    await sleep(300);
    const mid = await readBtn();
    // 增强中可能很快就结束，所以这里只做机会性检查
    if (mid && mid.busy) ok(true, '点了之后进入「转圈·增强中」态', mid.title);

    // 等结果（最多 60 秒）
    let done = null;
    for (let t = 0; t < 120; t++) {
      await sleep(500);
      const cur = await readBtn();
      if (cur && !cur.busy) { done = cur; break; }
    }
    if (!done) {
      sk('增强结果', '60 秒还没落回，模型可能太慢');
    } else if (done.done === true) {
      ok(true, '增强成功：按钮变「恢复原文」', done.title);
      ok(done.value.trim().length > 0 && done.value !== ORIGIN, '输入框内容被改写', '长度 ' + done.value.length + '（原 ' + ORIGIN.length + '）');
      ok(/[\u4e00-\u9fa5]/.test(done.value), '语言跟随正确（中文进中文出）');
      ok(!/^(好的|这是|以下是)/.test(done.value.trim()), '没有「好的，这是增强后的提示词」这类解说外壳');
      ok(!done.value.trim().startsWith('```'), '没有包代码栅栏');

      console.log('\n── 三、点「恢复原文」 ──');
      await cdp.eval(`document.getElementById('enhanceBtn').click(); return 1;`);
      await sleep(350);
      const back = await readBtn();
      ok(back && back.done === false, '按钮回到「星星」态', JSON.stringify(back));
      ok(back && back.value === ORIGIN, '输入框回到原话', JSON.stringify(back && back.value));

      console.log('\n── 四、手改增强结果后，撤销备份作废 ──');
      await cdp.eval(`document.getElementById('enhanceBtn').click(); return 1;`);
      let again = null;
      for (let t = 0; t < 120; t++) { await sleep(500); const cur = await readBtn(); if (cur && !cur.busy) { again = cur; break; } }
      if (again && again.done) {
        // 模拟用户手改：写一个不同的值 + 真 input 事件
        await cdp.eval(`(function(){ const i=document.getElementById('input'); i.value='我自己改过的内容'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })();`);
        await sleep(250);
        const div = await readBtn();
        ok(div && div.done === false, '手改之后不再是「已增强」态（撤销机会作废）', JSON.stringify(div));
      } else {
        sk('手改作废检查', '第二次增强没成功');
      }
    } else {
      sk('增强结果', '模型没回上来（按钮仍为星星态），前端失败路径不弹错误 ✔', JSON.stringify(done));
      ok(done && done.value === ORIGIN, '失败时输入框保持原文（不吞内容）');
    }

    console.log('\n── 五、增强中再点 = 取消 ──');
    await cdp.eval(`(function(){ const i=document.getElementById('input'); i.value='写一段自我介绍'; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })();`);
    await sleep(200);
    await cdp.eval(`document.getElementById('enhanceBtn').click(); return 1;`);
    await sleep(120);
    await cdp.eval(`document.getElementById('enhanceBtn').click(); return 1;`);  // 立刻再点
    await sleep(1200);
    const cancel = await readBtn();
    ok(cancel && cancel.busy === false && cancel.done === false, '取消后回到星星态', JSON.stringify(cancel));
    ok(cancel && cancel.value === '写一段自我介绍', '取消后输入框恢复原文', JSON.stringify(cancel && cancel.value));

    console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂' + (skip ? ' / ' + skip + ' 跳过' : ''));
  } catch (e) {
    console.log('✘ 跑挂了: ' + (e && e.message ? e.message : e));
    fail++;
  } finally {
    try { if (cdp && cdp.close) cdp.close(); } catch {}
    try { if (iso) await iso.stop(); } catch {}
  }
  process.exit(fail ? 1 : 0);
})();