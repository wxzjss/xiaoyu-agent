import { memo } from 'react';
import { thinkPeek } from './bridge.js';

/** 柜门右侧那一小截灰字（思考摘要） */
function peekOf(text) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (!flat) return '';
  return thinkPeek(flat);
}

/**
 * 灰字（规格 4.5）。
 *
 * 单独 memo 出来：**只有这段文字本身变了才重渲染**。
 * 原来它每秒被整体重写一次，而它是 `text-overflow: ellipsis` 的那个元素 ——
 * 每次重写都要重新算截断点 → 那一行重排 → 鼠标停在上面时看着就是「抖」。
 * 现在：① 节点身份稳定（React key）；② 文案不变就一个字节都不碰；
 * ③ CSS 改成 clip（不画省略号，也就不需要为了省略号重新测量）。
 */
export const GrayPeek = memo(function GrayPeek({ text, className }) {
  const t = peekOf(text);
  if (!t) return null;
  return (
    <span className={className || 'hubpeek'} title={t}>
      {t}
    </span>
  );
});

/** 思考块右侧那行「N 字」，同理 memo 住 */
export const ThinkMeta = memo(function ThinkMeta({ body }) {
  const n = String(body || '').length;
  if (!n) return null;
  return <span className="thinkMeta">{n + ' 字'}</span>;
});
