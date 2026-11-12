import { useEffect, useRef } from 'react';
import { fmtSize } from './bridge.js';
import { beginEdit, getEdit } from './store.js';
import EditArea from './EditArea.jsx';

/** 附件是视频 / 音频吗（要能直接播放，不能缩成一个纸片图标） */
function mediaKindOf(a) {
  const ext = String((a && a.path) || '').split('.').pop().toLowerCase();
  if (a && a.kind === 'video') return 'video';
  if (a && a.kind === 'audio') return 'audio';
  if (['mp4', 'webm', 'mkv', 'mov', 'm4v', 'flv'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'm4a', 'flac', 'ogg', 'aac'].includes(ext)) return 'audio';
  return '';
}

function rawUrl(path, download) {
  return '/api/attach/raw?path=' + encodeURIComponent(String(path || '')) + (download ? '&download=1' : '');
}

/** 一个附件纸片（图片 / 文件） */
function AttachChip({ a }) {
  const src = a.dataUrl || rawUrl(a.path, false);
  return (
    <div className="attachChip" title={a.path || ''}>
      {a.kind === 'image' ? (
        <img
          className="thumb"
          alt={a.name || ''}
          title={a.name || a.path || ''}
          src={src}
          onClick={() => {
            try { window.openImgView && window.openImgView(src); } catch (e) { /* 打不开就不放大 */ }
          }}
          onError={(e) => {
            /* 图没了就退成图标，别显示破图 */
            const im = e.currentTarget;
            const d = document.createElement('div');
            d.className = 'ficon';
            d.textContent = '🖼';
            try { im.replaceWith(d); } catch (e2) { im.style.display = 'none'; }
          }}
        />
      ) : (
        <div className="ficon">{'📄'}</div>
      )}
      {a.kind !== 'image' ? <div className="aname">{a.name || ''}</div> : null}
    </div>
  );
}

/** 一个音视频附件（播放器 + 名字/大小/下载） */
function MediaRow({ a }) {
  const kind = mediaKindOf(a);
  const src = rawUrl(a.path, false);
  return (
    <div className="fileRow">
      {kind === 'video' ? (
        <video controls preload="metadata" src={src} />
      ) : (
        <audio controls preload="metadata" src={src} />
      )}
      <div className="finfo">
        <div className="fname">{(kind === 'video' ? '🎬 ' : '🎵 ') + String(a.name || '')}</div>
        <div className="fsize">{a.size ? fmtSize(a.size) : ''}</div>
        <a className="fdl" href={rawUrl(a.path, true)} download={a.name || ''}>
          下载
        </a>
      </div>
    </div>
  );
}

/**
 * 主人说的话（含附件、插话标记、改名、回退/编辑/分支/删除）。
 *
 * 结构跟原来的 addEl 那条路完全一致（`.msg.user > .role + .msgAttach + .bubble`），
 * 样式一个类名都不用改。差别只有一处：**节点由 React 按 key 复用**，
 * 不再「先删后建」，所以不存在中间态。
 */
export default function UserBubble({ it }) {
  const wrap = useRef(null);
  const list = Array.isArray(it.atts) ? it.atts.filter((a) => a && a.path) : [];

  /* 悬停按钮 / 时间戳 / 编辑能力：复用 index.html 里那几段打磨过的装饰器。
   * 它们只往这个节点里「加」东西，React 从不重建这个节点（key 稳定），
   * 所以不需要把这些逻辑重写一遍。
   * 编辑（A1）：点「✎ 编辑」不再走手写 textarea，而是把 editKey 记进 store，
   * 由下面的 React 渲染分支换成受控的编辑框。 */
  useEffect(() => {
    const w = wrap.current;
    if (!w) return;
    try { if (!w.querySelector('.msgTime') && window.attachTime) window.attachTime(w, it.ts); } catch (e) { /* 没时间就不画 */ }
    try { window.attachRewind && window.attachRewind(w, it.rewindId); } catch (e) {}
    try { window.attachEdit && window.attachEdit(w, it.rewindId, () => beginEdit(it.key, it.rewindId)); } catch (e) {}
    try { window.attachBranchBtn && window.attachBranchBtn(w, it.rewindId); } catch (e) {}
    try { window.attachDelBtn && window.attachDelBtn(w, it.rewindId, it.ts); } catch (e) {}
  }, [it.rewindId, it.ts, it.key]);

  const editing = (() => { try { const e = getEdit(); return !!e && e.key === it.key; } catch (e) { return false; } })();
  const cls = 'msg user' + (editing ? ' editing' : '') + (it.edited ? ' edited' : '');
  return (
    <div
      className={cls}
      ref={wrap}
      data-rewind-id={it.rewindId == null ? undefined : String(it.rewindId)}
      data-at={it.rewindId == null ? undefined : String(it.rewindId)}
    >
      <div className="role">
        {String(it.who || '主人')}
        {it.tag ? <span className="interjectTag">{it.tag}</span> : null}
      </div>
      {list.length ? (
        <div className="msgAttach">
          {list.map((a, i) =>
            mediaKindOf(a) ? <MediaRow key={'m' + i} a={a} /> : <AttachChip key={'c' + i} a={a} />,
          )}
        </div>
      ) : null}
      {editing ? (
        <EditArea text={String(it.text || '')} at={it.rewindId} msgAt={it.ts} />
      ) : (
        String(it.text || '') ? <div className="bubble">{String(it.text || '')}</div> : null
      )}
    </div>
  );
}
