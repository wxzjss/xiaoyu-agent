/**
 * 一行系统提示（报错 / 限流 / 断线），后面可能挂一颗按钮。
 *
 * 刻意不挂 `.msg` / `.bubble`：它不是对话内容，不该被当成谁说的话。
 */
import { useState } from 'react';

export default function SysNote({ it, sid }) {
  const acts = Array.isArray(it.actions) ? it.actions : [];
  /**
   * 【2026-11-16 主人要求·过程话别刷屏幕】
   *
   * 「工作过程中有时候重启时屏幕上会显示密密麻麻的你做了什么的话，
   *   我希望是仅你自己可见的系统提示形式，不要直接发在我屏幕上让我看见。」
   *
   * 所以带 process 标记的这类提示默认只露**一行摘要**（首句截断），
   * 想看全文才点「展开」。这样屏幕上永远不会再糊一大片灰字。
   */
  const isProcess = it.process === true;
  const [open, setOpen] = useState(false);
  const fullText = String(it.text || '');
  const oneLine = (() => {
    const flat = fullText.replace(/\s+/g, ' ').trim();
    return flat.length > 60 ? flat.slice(0, 60) + '…' : flat;
  })();
  const shown = isProcess && !open ? oneLine : fullText;
  /**
   * 【2026-11-15 加·折叠存档的入口】
   *
   * 主人报「重启后消息全没了」，查明是压缩把历史折进 .state/folded/，
   * 界面上只剩一句「折叠存档了」——原文一个字都看不到。数据一直在盘上，
   * 只是没有入口。这里给那条提示挂一颗「翻原文」，点开就能看、能恢复。
   */
  const isFoldNote = /折叠存档/.test(String(it.text || ''));
  return (
    <div className="sysnote">
      <span>{shown}</span>
      {isProcess && fullText.replace(/\s+/g, ' ').trim().length > 60 ? (
        <button type="button" className="sysnoteBtn" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '展开'}
        </button>
      ) : null}
      {isFoldNote ? (
        <button
          type="button"
          className="sysnoteBtn"
          onClick={() => {
            try {
              if (typeof window.openFoldedArchive === 'function') window.openFoldedArchive(sid);
            } catch (e) { /* 按钮自己的错不连累屏幕 */ }
          }}
        >
          翻原文
        </button>
      ) : null}
      {acts.map((a, i) => (
        <button
          key={'a' + i}
          type="button"
          className="sysnoteBtn"
          onClick={(e) => {
            try { a.onClick && a.onClick(e.currentTarget); } catch (err) { /* 按钮自己的错不连累屏幕 */ }
          }}
        >
          {String(a.label || '确定')}
        </button>
      ))}
    </div>
  );
}
