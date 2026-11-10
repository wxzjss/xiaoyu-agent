import React from 'react';

/**
 * 兜住「某一条消息渲染出错」。
 *
 * 为什么需要它：React 18 里只要渲染期抛一次，**整棵树会被卸载** ——
 * 屏幕上就一片空白，连已经画好的历史都没了。手写 DOM 那会儿一条坏数据
 * 最多毁它自己那一块，换成 React 之后反而更脆，这个边界就是补这一刀。
 *
 * 出错的那一条退成一行系统提示（主人能看见「哪条坏了、为什么」），
 * 兄弟节点照常显示。真正的问题照样会打到 console，自检也照旧能抓。
 */
export default class RowBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { err: null };
  }

  static getDerivedStateFromError(err) {
    return { err };
  }

  componentDidCatch(err, info) {
    try {
      console.error('[log] 这一条渲染出错，其余照常显示：', err, info && info.componentStack);
    } catch (e) { /* 连日志都打不出去也不能再抛 */ }
  }

  render() {
    if (this.state.err) {
      const msg = String((this.state.err && this.state.err.message) || this.state.err || '未知错误');
      return (
        <div className="sysnote">
          <span>{'⚠ 这一条渲染出错了：' + msg}</span>
        </div>
      );
    }
    return this.props.children;
  }
}
