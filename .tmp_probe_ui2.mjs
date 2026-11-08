/**
 * 验「回到最新」那个小箭头到底冒不冒数字。
 * 思路：不开真窗口，直接在浏览器里注入一段脚本，用 CDP 拿不到就走浏览器页面自带的能力。
 * 这里先做个最实在的：检查 DOM 现在的状态 + 在页面里跑一段自测。
 */
const B = 'http://127.0.0.1:8788';

const r = await fetch(B + '/api/sessions');
const t = await r.json();
const list = Array.isArray(t) ? t : t.sessions || [];
const big = list
  .filter((x) => !/^__(r|ord|e2e)/.test(x.title || ''))
  .sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
console.log(
  '最长的几个会话:',
  big.slice(0, 5).map((x) => ({ id: x.id, title: (x.title || '').slice(0, 16), n: x.messageCount }))
);
