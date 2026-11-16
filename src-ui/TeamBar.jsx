import { useEffect, useMemo, useRef, useState } from 'react';
import WorkerCard from './WorkerCard.jsx';

/**
 * TeamBar —— 【团队模式】的轻量状态条（2026-11-11）。
 *
 * 设计文档 §2.2③：只在有 worker 在跑时出现，不占布局；点它滚到最新的
 * worker 卡。数据来自 /api/team/workers 的 3 秒轮询（SSE 只在主轮活着时
 * 有缓冲，后台 worker 在主轮结束后还在跑 —— 轮询是唯一可靠的通道）。
 *
 * 同时兜两件事：
 *   · 流外的 running 卡：主轮结束后直播清单清空，还在跑的 worker 在聊天流里
 *     没有位置了 —— 这里按花名册补画（跟流里已有的按 wid 去重，不画两份）。
 *   · 「✕ 停掉」的主人入口（POST /api/team/stop）。
 *
 * 全停之后轮询自动降频到 10 秒（不彻底停 —— 要看到历史 worker 的收尾状态）。
 */

/** 停一个 worker（聊天流里的卡和这里的轮询卡都走这一个入口）。 */
export async function teamStopWorker(sid, wid) {
  try {
    await fetch('/api/team/stop', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, wid }),
    });
  } catch { /* 停不掉下次轮询会看到它还在跑，再试就是 */ }
}

export default function TeamBar({ sid, items }) {
  const [ws, setWs] = useState([]);
  const aliveRef = useRef(true);
  /**
   * 【2026-11-15 修·A 会话的子 Agent 跑到 B 会话底下来】
   *
   * 主人报：「A 会话拉起了子 Agent，底部固定显示在跑；切到 B 会话，那条也还在 B 里。」
   *
   * 病根是**竞态**，不是后端：/api/team/workers 是按 sessionId 查的（花名册一个会话一份文件），
   * 可切会话时旧那次 fetch 还在路上；等它回来，新 effect 已经把 aliveRef 又置成 true 了
   * —— 于是「已卸载」的判断形同虚设，A 的名单照样 setWs 进 B 的组件里。
   *
   * 修法：进闭包时记下**这次请求属于哪个会话**，回来时跟「现在真的是哪个会话」比，
   * 不一致就整个丢弃。用 ref 而不是 state，是为了读到最新值又不触发重渲染。
   */
  const curSidRef = useRef(sid);
  useEffect(() => { curSidRef.current = sid; }, [sid]);

  useEffect(() => {
    aliveRef.current = true;
    /** 这次轮询属于哪个会话 —— 回来时拿它跟最新 sid 比 */
    const mySid = sid;
    let timer = null;
    const poll = async () => {
      if (!aliveRef.current) return;
      try {
        const r = await fetch('/api/team/workers?sessionId=' + encodeURIComponent(String(mySid || '')));
        const j = await r.json();
        /* 双保险：组件已卸载，或者用户已经切到别的会话 → 这份数据不属于现在这块屏幕 */
        if (!aliveRef.current) return;
        if (String(curSidRef.current || '') !== String(mySid || '')) return;
        const list = Array.isArray(j && j.workers) ? j.workers : [];
        setWs(list);
        /* 只在有 running 时按 3 秒轮；全停了降到 10 秒兜底（便宜，本机回环） */
        timer = setTimeout(poll, list.some((w) => w && w.status === 'running') ? 3000 : 10000);
      } catch {
        if (aliveRef.current) timer = setTimeout(poll, 8000);
      }
    };
    if (sid) poll();
    return () => {
      aliveRef.current = false;
      if (timer) clearTimeout(timer);
    };
  }, [sid]);

  /* 切会话立刻清空旧数据，免得上一秒还显示 A 会话的 worker */
  useEffect(() => { setWs([]); }, [sid]);

  const running = ws.filter((w) => w && w.status === 'running');
  /**
   * 【2026-11-15 改·在跑的一律由这里画，不再跟聊天流去重】
   *
   * 原来这段用 inFlowRunning 把「聊天流里已经画着的」剔掉 ——
   * 可 LogView 那边（renderRow）现在**不再画在跑的 worker** 了（见那里的注释），
   * 所以这里必须全画，否则主人一个都看不见。
   *
   * 历史里那种已经结束的卡走聊天流（它们在正文里的位置是确定的，不该飞到底部），
   * 两条路各管各的，职责不重叠。
   */
  const extra = running;

  const onStop = (wid) => { teamStopWorker(sid, wid); };
  /**
   * 滚到最新一条。原来单击就跳，现在单击用来收起/展开（主人点名要的），
   * 跳转挪到**双击**上 —— 双击这颗小条仍然能「滚到最新的 worker 卡」，习惯没丢。
   */
  const jumpToLatest = () => {
    try {
      const el = document.getElementById('log');
      if (el) el.scrollTop = el.scrollHeight;
    } catch { /* 滚不动就算了 */ }
  };

  /**
   * 【2026-11-15 加·主人两条要求】
   *
   * ① 「点击【⚑ 3 个在后台干活…】能把子Agent干活显示像收柜子一样收起来，再点一次展开」
   *    —— 加一个本地开关 collapsed。默认展开（他点开就是想看），点一下收成一行，
   *       再点展开。收起来时不渲染 teamTail，屏幕上只剩那颗小条。
   *
   * 【踩过的坑·必须放在 early return 之前】
   * 这个 useState 一开始写在了 `if (!running.length && !extra.length) return null;`
   * **后面**，结果第一次渲染（没有 worker）时少调一个 hook、有 worker 时又多调一个，
   * React 当场抛 #310「Rendered more hooks than during the previous render」，
   * 整块渲染崩掉 —— 主人看到的就是「界面脚本出错了，这一行之后都不生效」。
   * 规矩：hooks 永远写在所有条件返回之前，一个都不能例外。
   */
  const [collapsed, setCollapsed] = useState(true);
  const onToggleCollapse = () => setCollapsed((v) => !v);

  if (!running.length && !extra.length) return null;

  return (
    <div className="teamBar" data-team-sid={String(sid || '')}>
      <style>{`
        /* 【2026-11-16 主人澄清】不要 sticky —— 它就是流里的最后一块。
         * 「和正常柜子一样正常显示，只是固定显示在所有消息与工具调用显示下面」。
         * 一旦 sticky，它就会浮在旧消息上面跟着滚轮走，那是主人明确不要的。 */
        .teamBar {
          position: static;
          max-width: 100%; min-width: 0; box-sizing: border-box;
          padding-top: 2px;
          /*
           * 【2026-11-15 修·那块黑底（主人截图：⚑ 那条下面横着一条黑带）】
           *
           * 上一版在这里铺了一条 linear-gradient 想给贴底遮罩，
           * 结果：壁纸主题下 --bg 是**半透明**的 rgba（body.wall 里 --bg 被改成
           * rgba(var(--bg-rgb), var(--surface))），叠在图片上就是一大块脏兮兮的深色；
           * 而且这条渐变铺满了整块 .teamBar 的宽度，比消息栏还宽。
           *
           * 现在：**不加任何底色**。贴底遮挡交给每张卡自己的背景（WorkerCard 本来就有），
           * 中间的空隙透出壁纸才是对的 —— 主人要的是"卡片贴底"，不是"一条黑条贴底"。
           * （注意：CSS 注释里不要出现反引号，会截断外层的模板字符串。）
           */
          background: none;
        }
        .teamBar .teamHint {
          /* 【2026-11-16】原来这里是 sticky; top:0 —— 在流里它会让按钮
           * 粘在聊天区顶部（正是「跟着滚轮走」的另一个来源）。去掉。 */
          position: static;
          margin: 4px 0 6px 0;
          padding: 4px 12px;
          font-size: 12px;
          color: var(--warn, #d8a13a);
          background: color-mix(in srgb, var(--warn, #d8a13a) 10%, transparent);
          border: 1px solid color-mix(in srgb, var(--warn, #d8a13a) 35%, transparent);
          border-radius: 999px;
          width: fit-content; max-width: 100%;
          cursor: pointer;
          backdrop-filter: blur(4px);
          /* 收起/展开的箭头跟着走，让主人看得出这颗能点 */
          display: inline-flex; align-items: center; gap: 5px;
        }
        .teamBar .teamHint .caret { font-size: 10px; opacity: .75; }
        /* 卡片列表：贴底时最多占半屏，多了在内部滚 ——
         * 不这样的话，三张卡一起贴底就把正文全遮住了。 */
        .teamBar .teamTail {
          margin: 2px 0 8px 0;
          max-width: 100%; min-width: 0;
          max-height: 42vh; overflow-y: auto;
          overscroll-behavior: contain;
        }
        /* 里面的 worker 卡一律不许超出消息栏 */
        .teamBar .teamTail details.wcard,
        .teamBar .teamTail details.wcard > summary,
        .teamBar .teamTail details.wcard > pre {
          max-width: 100%; min-width: 0; box-sizing: border-box;
          overflow-wrap: anywhere;
        }
      `}</style>
      {(running.length || extra.length) ? (
        <button
          type="button"
          className="teamHint"
          onClick={onToggleCollapse}
          onDoubleClick={jumpToLatest}
          title={collapsed
            ? '点一下展开子Agent 的干活流水（双击滚到最新）'
            : '点一下收起（双击滚到最新）'}
        >
          {running.length ? ('⚑ ' + running.length + ' 个在后台干活…') : ('⚑ ' + extra.length + ' 个子Agent 的干活流水…')}
          <span className="caret">{collapsed ? '▸' : '▾'}</span>
        </button>
      ) : null}
      {!collapsed && extra.length ? (
        <div className="teamTail">
          {extra.map((w) => (
            <WorkerCard
              key={'team-' + w.id}
              it={{
                key: 'team-' + w.id,
                id: String(w.id),
                name: String(w.name || ''),
                status: 'run',
                steps: (Array.isArray(w.progress) ? w.progress : []).map((p) => ({ kind: 'step', t: String((p && p.line) || '') })),
                note: String(w.said || ''),
                startedAt: Number(w.startedAt) || 0,
                endedAt: 0,
                rounds: Number(w.rounds) || 0,
                tools: Number(w.tools) || 0,
              }}
              onStop={onStop}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
