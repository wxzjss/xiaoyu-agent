/**
 * 一行系统提示（报错 / 限流 / 断线），后面可能挂一颗按钮。
 *
 * 刻意不挂 `.msg` / `.bubble`：它不是对话内容，不该被当成谁说的话。
 */
export default function SysNote({ it }) {
  const acts = Array.isArray(it.actions) ? it.actions : [];
  return (
    <div className="sysnote">
      <span>{String(it.text || '')}</span>
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
