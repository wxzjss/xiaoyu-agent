/**
 * check-input-autosize.mjs — 输入框自动增高的站岗（2026-11-12）
 *
 * 主人报：「随着输入框内容增多到一定高度时，每打一个字进输入框，整个上下文都会抖动一下」。
 *
 * 真凶（真机实锤）：全局是 * { box-sizing: border-box }，而 autosizeInput 原来
 * height = scrollHeight —— border-box 下可视内容区 = height − 上下 padding(20) − 边框(2)，
 * **比内容矮 2px** → 内滚动条闪现 → 文字变窄重排 → 下一键再量又变回去，一字一抖。
 *
 * 修法：height = scrollHeight + 边框差（offsetHeight − clientHeight 在 border-box 下
 * 正好 = 左右边框宽），且没到 180 封顶前 overflow-y: hidden（封顶后才要内滚动条）。
 *
 * 这里真机实测（隔离实例 + CDP）：
 *   ① 多行内容下 scrollHeight ≤ clientHeight（不许再溢出那 2px）
 *   ② 未封顶时 overflow-y 是 hidden（不该有内滚动条）
 *   ③ 封顶（>180px）时 height 恰好 180 且 overflow-y 是 auto
 *   ④ 高度只随行数走：同样内容反复触发 input，高度分毫不差（不许来回振荡）
 */
import { startIsolated } from './_test-instance.mjs';

let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log('  [ok] ' + m + (d ? '  ' + d : '')); } else { fail++; console.log('  [!!] ' + m + (d ? '  ' + d : '')); } };

let iso = null, ws = null;
try {
  iso = await startIsolated({ appPort: 8967, cdpPort: 9367 });
  const list = await fetch('http://127.0.0.1:' + iso.cdpPort + '/json/list').then((r) => r.json());
  /* 【2026-11-12 修·探针连错页】/json/list 里可能躺着一个 Edge 启动期的 about:blank，
   * find 第一个 type==='page' 会连到空页上，量出来的全是 undefined。认准隔离实例那个页。 */
  const page = list.find((t) => t.type === 'page' && String(t.url || '').startsWith(iso.base))
    || list.find((t) => t.type === 'page');
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
  const send = (m, p) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
  const ev = async (x) => {
    const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true });
    if (r?.result?.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 200));
    return r?.result?.result?.value;
  };
  await send('Runtime.enable');
  /* 【2026-11-12 修·抢跑】连上时页面可能还在加载/脚本没跑完，符号全是 undefined。
   * 先强制导航到干净状态，再等 window.input 就绪 —— 不许带着半加载的页面量。 */
  await send('Page.enable');
  await send('Page.navigate', { url: iso.base + '/' });
  let ready = false;
  /* 【2026-11-12 改·就绪判据】window.input 在 HTML 解析到 4697 行就有了（巨型内联脚本
   * 还在执行），拿它当就绪会抢跑量到半截页面。就绪 = 自动增高函数真的在全局了。 */
  for (let i = 0; i < 80; i++) { if (await ev('typeof autosizeInput === "function"')) { ready = true; break; } await new Promise((r) => setTimeout(r, 250)); }
  if (!ready) throw new Error('探针页没就绪（autosizeInput 一直没有）');

  /* ①② 未封顶：多行内容 → 量完不许溢出、不许有内滚动条 */
  {
    const r = await ev(`(function(){
      var t = window.input;
      t.value = Array.from({length: 4}, function(_, i){ return '第' + i + '行打字抖动测试内容，需要足够长才能折行。'; }).join('\\n');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      var cs = getComputedStyle(t);
      return {
        sh: t.scrollHeight, ch: t.clientHeight, oh: t.offsetHeight,
        styleH: parseInt(t.style.height, 10), overflowY: cs.overflowY,
        boxSizing: cs.boxSizing
      };
    })()`);
    ok('全局是 border-box（前提变了这条检查就得跟着改）', r.boxSizing === 'border-box', 'box-sizing=' + r.boxSizing);
    ok('多行内容不再溢出那 2px（scrollHeight ≤ clientHeight）',
      r.sh <= r.ch, 'scrollHeight=' + r.sh + ' clientHeight=' + r.ch);
    ok('未封顶时没有内滚动条（overflow-y: hidden）',
      r.overflowY === 'hidden', 'overflowY=' + r.overflowY);
    ok('高度 = scrollHeight + 边框补偿（border-box 下不再矮 2px）',
      r.styleH === r.sh + (r.oh - r.ch), 'style.height=' + r.styleH + ' 应为 ' + (r.sh + (r.oh - r.ch)));
  }

  /* ③ 封顶：超过 180 → 高度恰好 180 且滚动条要回来 */
  {
    const r = await ev(`(function(){
      var t = window.input;
      t.value = Array.from({length: 30}, function(_, i){ return '超出封顶的第' + i + '行内容。'; }).join('\\n');
      t.dispatchEvent(new Event('input', { bubbles: true }));
      var cs = getComputedStyle(t);
      return { styleH: parseInt(t.style.height, 10), overflowY: cs.overflowY };
    })()`);
    ok('封顶后高度恰好 180', r.styleH === 180, 'style.height=' + r.styleH);
    ok('封顶后滚动条要回来（overflow-y: auto）', r.overflowY === 'auto', 'overflowY=' + r.overflowY);
  }

  /* ④ 反复触发不许振荡：同样内容连打 6 次，高度每次都一样。
   * 【2026-11-12 踩坑记录】autosizeInput 第一行就是 style.height='auto'——dispatch 完
   * 立刻读会量到单行瞬时值（67），不是抖动，是中间态。所以每拍读两次，把瞬时值滤掉，
   * 只留稳定值比对；另外初始化序列里 restoreDraft() 会清一次输入框（无草稿→清空→缩回），
   * 撞进采样窗口也是假抖动——先预热两拍把它吃掉。 */
  {
    const r = await ev(`(async function(){
      var t = window.input;
      var text = Array.from({length: 4}, function(_, i){ return '振荡测试第' + i + '行，内容保持完全一致。'; }).join('\\n');
      function nextFrame() { return new Promise(function(rr){ requestAnimationFrame(function(){ requestAnimationFrame(rr); }); }); }
      /* 预热：把初始化那一刷（restoreDraft / 首次 live 同步）吃掉 */
      for (var w = 0; w < 2; w++) {
        t.value = text;
        t.dispatchEvent(new Event('input', { bubbles: true }));
        await nextFrame(); await nextFrame();
      }
      var hs = [];
      var lenOk = true;
      for (var k = 0; k < 6; k++) {
        t.value = text;
        t.dispatchEvent(new Event('input', { bubbles: true }));
        void t.offsetHeight;
        hs.push(parseInt(t.style.height, 10));   // 瞬时值（可能还是中间态）
        await nextFrame(); await nextFrame();
        var stable = parseInt(t.style.height, 10);
        if (t.value.length !== text.length) lenOk = false;
        hs.push(stable);                          // 稳定值
      }
      var last = hs.filter(function(x, i){ return i % 2 === 1; });   // 只比稳定值
      return { hs: last, stable: last.length > 0 && last.every(function(x){ return x === last[0]; }), lenOk: lenOk };
    })()`);
    ok('同样内容反复触发，稳定高度分毫不差（不许一字一抖）',
      r.stable, 'stable-heights=' + JSON.stringify(r.hs));
    ok('采样期间输入内容没有被后台清掉（restoreDraft 不许误清正在打的字）',
      r.lenOk === true);
  }
  /* ⑤ 主人钦点的行为：输入框增高时，聊天内容最低端要贴住输入框最高端。
   * 往回翻着看时绝不动滚动位置（不抢主人的滚动）。 */
  {
    const r = await ev(`(async function(){
      var t = window.input, log = document.getElementById('log');
      function nextFrame() { return new Promise(function(rr){ requestAnimationFrame(function(){ requestAnimationFrame(rr); }); }); }
      function gap() { return log.scrollHeight - log.scrollTop - log.clientHeight; }
      /* 落几十条消息把 #log 撑出滚动空间。
       * 【2026-11-12 修探针】页面刚起来 React 可能还没挂载，setHistory 塞了也没渲染
       * （#log 没滚动条，情形 A 的「贴底」是空滚动域的假贴底）—— 先 warmup 等真画出气泡。 */
      if (window.__logStore && window.sessionId) {
        var turns = [];
        for (var i = 0; i < 30; i++) turns.push({ role: i % 2 ? 'assistant' : 'user', text: '贴底测试消息第' + i + '条，内容足够长让它撑出滚动条。' });
        var _warm = false;
        for (var wi = 0; wi < 40; wi++) {
          try { window.__logStore.setHistory(window.sessionId, turns); } catch (e) {}
          await new Promise(function(rr){ setTimeout(rr, 100); });
          if (document.querySelectorAll('#log .msg').length >= 10) { _warm = true; break; }
        }
        await nextFrame(); await nextFrame();
      }
      var out = {};
      /* 情形 A：原本贴底 → 输入框增高后内容底边仍贴住输入框顶边（gap 回到 ≈0） */
      log.scrollTop = log.scrollHeight; await nextFrame();
      out.gapBeforeAtBottom = gap();
      t.value = Array.from({length: 6}, function(_, i){ return '增高测试第' + i + '行。'; }).join(String.fromCharCode(10));
      t.dispatchEvent(new Event('input', { bubbles: true }));
      await nextFrame(); await nextFrame();
      out.gapAfterGrow = gap();
      out.heightGrew = parseInt(t.style.height, 10) > 44;
      /* 情形 B：往回翻（离底很远）→ 增高绝不动滚动位置。
       * 【2026-11-12 修探针·假挂】之前这里把输入框清空（缩回单行），聊天区变高、
       * 滚动范围变小，浏览器把 scrollTop clamp 了 —— 那是几何必然，不是「抢滚动」。
       * 改成纯增高方向（短→长）：maxScroll 只会变大，clamp 不会发生。 */
      t.value = '单行起点';
      t.dispatchEvent(new Event('input', { bubbles: true }));
      await nextFrame(); await nextFrame();
      /* 模拟主人往上翻：LogView 认的主人意图通道是 wheel/pointer/keydown（程序性
       * 写 scrollTop 不算——那是它防「收缩 clamp 误判」的设计）。先滚一发轮子，
       * followRef 才会置 false，增高时 pin 才真正被拦住 —— 这才是要验证的行为。 */
      log.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true }));
      await nextFrame();
      log.scrollTop = Math.max(0, log.scrollHeight - log.clientHeight - 300);
      await nextFrame();
      var st = log.scrollTop, sh0 = log.scrollHeight, ch0 = log.clientHeight;
      t.value = Array.from({length: 6}, function(_, i){ return '增高测试第' + i + '行。'; }).join(String.fromCharCode(10));
      t.dispatchEvent(new Event('input', { bubbles: true }));
      await nextFrame(); await nextFrame();
      out.scrollTopKept = log.scrollTop === st;
      out.stB = st; out.afterB = log.scrollTop; out.shB0 = sh0; out.chB0 = ch0; out.shB1 = log.scrollHeight; out.chB1 = log.clientHeight;
      return out;
    })()`);
    ok('原本贴底：输入框增高后内容底边仍贴住输入框顶边（gap≈0）',
      r.heightGrew && r.gapAfterGrow <= 2, 'gap前=' + r.gapBeforeAtBottom + ' gap后=' + r.gapAfterGrow + ' 长高=' + r.heightGrew);
    ok('往回翻着看时增高绝不抢滚动位置', r.scrollTopKept === true,
      'st=' + r.stB + ' after=' + r.afterB + ' sh0=' + r.shB0 + ' ch0=' + r.chB0 + ' sh1=' + r.shB1 + ' ch1=' + r.chB1);
  }
} catch (e) {
  fail++;
  console.log('  [!!] 探针失败：' + String(e?.message ?? e));
} finally {
  if (iso) await iso.stop().catch(() => {});
  try { if (ws) ws.close(); } catch {}
}
console.log('\n输入框自动增高：' + pass + ' 过 / ' + fail + ' 挂');
process.exit(fail ? 1 : 0);
