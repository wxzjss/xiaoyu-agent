import { useLayoutEffect, useRef } from 'react';
import { mdInto } from './bridge.js';

/**
 * 一个「内容由 window.mdInto 画」的 div。
 *
 * 为什么不用 React 渲染 markdown：
 *   mdInto 是这个项目里打磨过的唯一一份 markdown 实现（代码块 / 表格 / 标题 / 列表 /
 *   粗体 / 行内代码 / 裸链接，还会剥掉 <thinking> 与 XML 工具调用）。重写一份
 *   等于把已经修好的十几个坑重新踩一遍。
 *
 * 为什么不会跟 React 打架：
 *   这个 div 在 JSX 里**没有任何 children** —— React 从不管理它的子节点。
 *   我们只在 `text` 变化时整块重画一次（mdInto 自己也是幂等的）。
 */
export default function MdDiv({ className, text, style, divRef, attrs }) {
  const inner = useRef(null);

  const setRef = (el) => {
    inner.current = el;
    if (divRef) divRef.current = el;
  };

  useLayoutEffect(() => {
    mdInto(inner.current, text);
  }, [text]);

  return <div className={className} style={style} ref={setRef} {...(attrs || {})} />;
}
