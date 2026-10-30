/**
 * 验收：token 估算有没有把「图片」和「tool_calls 参数」算进去。
 *
 * 【为什么要这份】
 * 2026-11-01 查出两个真窟窿：
 *
 *   一、estimateTokens 用 `filter(p => p.type === 'text')` 把 image_url 整段
 *       丢掉了，注释还写着「base64 不计入预算」。可网关是算的 ——
 *       一张 1.2MB 截图 base64 后 1.6MB，按 1.5 字符/token 就是 100 万 token。
 *       结果带图的会话永远判「还没到线」，压都不压，一路堆到网关打回。
 *
 *   二、图片漏算 → 真实用量回来时 real/est 冲到几十上百 → 被夹到 8 →
 *       「挪一半」把 calibRatio 从 1.6 拖到 4.8 → 所有会话估算凭空虚高三倍
 *       → 一压就压过头（见过 826 万 → 24 万那种暴力落底）。
 *
 * 这份脚本把两件事都钉住，以后谁改回去就会红。
 *
 * 用法：node scripts/check-token-estimate.mjs
 */
import { estimateTokens } from '../src/compress.mjs';
import { measureMessages } from '../src/turn-slim.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  \u2714 ${name}`);
  } else {
    fail++;
    console.log(`  \u2718 ${name}${extra ? '  ← ' + extra : ''}`);
  }
};
const head = (s) => {
  console.log('');
  console.log('\u2500'.repeat(60));
  console.log(s);
  console.log('\u2500'.repeat(60));
};

// ── 1. 图片必须计入 ────────────────────────────────────────────
head('一、图片 base64 要计入 token 估算');

{
  const BASE64 = 1_600_000; // 一张 1.2MB 的 PNG base64 后大约这么大
  const withImg = [
    {
      role: 'user',
      content: [
        { type: 'text', text: '看看这张图' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(BASE64) } },
      ],
    },
  ];
  const withoutImg = [{ role: 'user', content: [{ type: 'text', text: '看看这张图' }] }];
  const a = estimateTokens(withImg);
  const b = estimateTokens(withoutImg);
  ok(`一张 1.6MB base64 图要算进去（带图 ${a} vs 不带图 ${b}）`, a > 1_000_000, `实际 ${a}`);
  ok('差距要接近 base64 长度 ÷ 1.5', Math.abs(a - b - BASE64 / 1.5) < 2000, `差 ${a - b}`);
}

{
  // 只有路径、还没 inflate 的落盘形态
  const p = estimateTokens([{ role: 'user', content: '看图', _images: ['C:\\shot.png'] }]);
  const q = estimateTokens([{ role: 'user', content: '看图' }]);
  ok(`只有路径的图也要记一笔（${p} vs ${q}）`, p > q + 5000, `多出 ${p - q}`);
  ok('三张路径图按三倍算', estimateTokens([{ role: 'user', content: 'x', _images: ['a', 'b', 'c'] }]) > q + 15000);
}

// ── 2. tool_calls 的参数必须计入 ──────────────────────────────
head('二、tool_calls 的 arguments 要计入 token 估算');

{
  const big = 'x'.repeat(100_000);
  const withCall = [
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'write_file', arguments: big } }] },
  ];
  const noCall = [{ role: 'assistant', content: '' }];
  const a = estimateTokens(withCall);
  const b = estimateTokens(noCall);
  ok(`10 万字符的写文件参数要算进去（${a} vs ${b}）`, a > 100_000, `实际 ${a}`);
}

// ── 3. measureMessages 口径要和 estimateTokens 对齐 ──────────
head('三、measureMessages 不能再漏这两样');

{
  const msgs = [
    { role: 'user', content: '看看', _images: ['C:\\a.png'] },
    { role: 'assistant', content: '', tool_calls: [{ function: { name: 'f', arguments: 'y'.repeat(50_000) } }] },
  ];
  const m = measureMessages(msgs);
  ok('图片数要报出来', m.images === 1, `images=${m.images}`);
  ok('工具调用数要报出来', m.calls === 1, `calls=${m.calls}`);
  ok('字符数要含 5 万参数', m.chars > 50_000, `chars=${m.chars}`);
}

// ── 4. calibRatio 不能被一次离谱比例带跑 ─────────────────────
head('四、离谱比例不许污染校准系数');

{
  const { noteRealTokens, currentCalibration } = await import('../src/compress.mjs');
  const start = currentCalibration();
  // 模拟「估算漏了图片」那种场面：真 1600 万、估 20 万 → 80 倍
  noteRealTokens(16_000_000, 200_000);
  const after = currentCalibration();
  ok(
    `80 倍离谱比例只让系数挪一小步（${start.toFixed(2)} → ${after.toFixed(2)}）`,
    after < start + 0.5,
    `涨了 ${(after - start).toFixed(2)}`
  );
  ok('系数永远不超过 8', after <= 8);
}

// ── 5. 正常情况还是要能校 ────────────────────────────────────
head('五、正常的 1.6 倍比例照常校准');

{
  const { noteRealTokens, currentCalibration } = await import('../src/compress.mjs');
  const before = currentCalibration();
  noteRealTokens(160_000, 100_000); // 正好 1.6 倍
  const after = currentCalibration();
  ok(`正常比例能把系数往 1.6 拉（${before.toFixed(2)} → ${after.toFixed(2)}）`, after < before, '没往下走');
}

// ── 6. 普通纯文字会话不受影响 ────────────────────────────────
head('六、纯文字会话的估算不该被这次改动静默改掉');

{
  const plain = [
    { role: 'system', content: 'a'.repeat(1000) },
    { role: 'user', content: 'b'.repeat(1000) },
    { role: 'assistant', content: 'c'.repeat(1000) },
  ];
  const t = estimateTokens(plain);
  // 3000 字符 / 1.5 * 1.6 ≈ 3200，再加 3 条开销
  ok(`纯 3000 字符估出来在 3000~3600 之间（实际 ${t}）`, t > 3000 && t < 3600, `实际 ${t}`);
}

console.log('');
console.log('\u2500'.repeat(60));
console.log(`结果：${pass} 项通过，${fail} 项失败`);
console.log('\u2500'.repeat(60));
process.exit(fail ? 1 : 0);
