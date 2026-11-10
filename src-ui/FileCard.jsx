import { memo, useRef, useState } from 'react';
import { fmtSize } from './bridge.js';

/**
 * 她发的一张文件卡（A2 收编后的唯一画法）。
 *
 * 数据是服务端清单里的 k:'file' 条目（appendLiveItem / buildLiveItems 合成），
 * 或历史 turn.out 直出的同形条目 —— 两边一个字段都不加工。
 *
 * CSS 类名全部照搬 index.html 里已有的（fileCard / fk / fmeta / fname / fsize /
 * fdl / fileRow / vidBox / vidSave / fthumb / msgVoice / vbub…），一行新样式都不写。
 *
 * 为什么不在气泡里挂卡片：mdInto 每个流式 tick 都重写 .bubble 的 innerHTML，
 * 谁往里 append 谁下一个 tick 就没了（审查实测「文件卡一闪就没」）。
 * 现在文件卡是 #log 里的**独立一行**，跟工具卡一个节奏，由 React 按 key 复用。
 */

/** 一个文件的取图地址（outbox key 优先 —— 路径没了也能从兜底箱拿回来） */
function fileUrl(f, download) {
  if (f.fkey) return '/api/attach/outbox-out?key=' + encodeURIComponent(f.fkey) + (download ? '&download=1' : '');
  const p = String(f.path || '');
  if (!p) return '';
  return '/api/attach/raw?path=' + encodeURIComponent(p) + (download ? '&download=1' : '');
}

function iconOf(k, name) {
  if (k === 'video') return '🎬';
  if (k === 'image') return '🖼';
  if (k === 'audio') return '🎵';
  if (k === 'pdf') return '📕';
  if (k === 'text') return '📝';
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (ext === 'zip' || ext === 'rar' || ext === '7z') return '🗜';
  return '📄';
}

/** 名字像语音、或本来就在 voice 目录里的音频，按语音条画（口径照旧） */
function looksVoice(f) {
  const p = String(f.path || '').replace(/\\/g, '/');
  return /(^|\/)(say_|voice_)[^/]*\.(mp3|m4a|wav|ogg|aac)$/i.test(p)
    || /[/\\]voice[/\\][^/\\]*\.(mp3|m4a|wav|ogg|aac)$/i.test(p)
    || /_v[0-9]+_[^/]*\.(mp3|m4a|wav|ogg|aac)$/i.test(p);
}

/** 语音条：点一下响，再点一下停（结构与老 voiceBubble 一致，节点由 React 管） */
function VoiceRow({ f }) {
  const url = fileUrl(f, false);
  const dl = fileUrl(f, true);
  return (
    <div className="msgVoice">
      <Vbub url={url} dl={dl} name={String(f.name || '语音')} />
    </div>
  );
}

function Vbub({ url, dl, name }) {
  const au = useRef(null);
  const [dur, setDur] = useState(0);
  const [left, setLeft] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [paused, setPaused] = useState(false);
  const secs = (n) => (n > 0 ? Math.max(1, Math.round(n)) : '–') + '\u2033';
  const toggle = () => {
    const a = au.current;
    if (!a) return;
    if (a.paused) {
      try {
        document.querySelectorAll('.vbub audio').forEach((x) => {
          if (x !== a && !x.paused) { try { x.pause(); } catch (e) {} }
        });
        a.play();
      } catch (e) {}
    } else {
      try { a.pause(); } catch (e) {}
    }
  };
  const pct = dur > 0 ? Math.min(100, ((dur - left) / dur) * 100) : 0;
  return (
    <div
      className={'vbub' + (playing ? ' playing' : '') + (paused ? ' paused' : '')}
      title="点一下听，再点一下停"
      onClick={toggle}
    >
      <div className="vwave">{[0, 1, 2, 3, 4].map((i) => <i key={i} />)}</div>
      <span className="vsec">{left > 0 ? secs(left) : secs(dur)}</span>
      <span className="vtag">语音</span>
      <a
        className="vdl"
        href={dl}
        download={name}
        title="存下来"
        onClick={(e) => e.stopPropagation()}
      >
        {'\u2193'}
      </a>
      <div className="vprog"><b style={{ width: pct + '%' }} /></div>
      <audio
        ref={au}
        preload="metadata"
        src={url}
        style={{ display: 'none' }}
        onLoadedMetadata={(e) => { const d = e.currentTarget.duration; setDur(Number.isFinite(d) ? d : 0); }}
        onTimeUpdate={(e) => {
          const a = e.currentTarget;
          if (!a.duration) return;
          setDur(a.duration);
          setLeft(a.duration - a.currentTime);
        }}
        onPlay={() => { setPlaying(true); setPaused(false); }}
        onPause={(e) => { setPlaying(false); if (!e.currentTarget.ended) setPaused(true); }}
        onEnded={(e) => {
          setPlaying(false);
          setPaused(false);
          setLeft(0);
          const d = e.currentTarget.duration;
          setDur(Number.isFinite(d) ? d : 0);
        }}
      />
    </div>
  );
}

/** 图片：缩略图，点开应用内浮层看大图（不跳浏览器，口径照旧） */
function ImageCard({ f }) {
  const url = fileUrl(f, false);
  const size = fmtSize(f.size);
  return (
    <div
      className="fileCard"
      style={{ cursor: 'zoom-in' }}
      title={String(f.name || '') + ' · ' + size + '（点开看大图）'}
      onClick={() => { try { window.openImgView && window.openImgView(url); } catch (e) {} }}
    >
      <img
        className="fthumb"
        alt={String(f.name || '')}
        src={url}
        onError={(e) => {
          /* 图没了就退成图标卡，别挂破图（口径照旧） */
          const im = e.currentTarget;
          const card = im.parentNode;
          if (!card) return;
          try {
            im.remove();
            const meta = document.createElement('div');
            meta.className = 'fmeta';
            const nm = document.createElement('div');
            nm.className = 'fname';
            nm.textContent = String(f.name || '');
            const sz = document.createElement('div');
            sz.className = 'fsize';
            sz.textContent = size + ' · 打不开了';
            meta.append(nm, sz);
            const ic = document.createElement('div');
            ic.className = 'fk';
            ic.textContent = '🖼';
            card.append(ic, meta);
          } catch (e2) { try { im.style.display = 'none'; } catch (e3) {} }
        }}
      />
    </div>
  );
}

/** 视频：宽屏播放器 + 悬停才露的下载小箭头（样式全在 .fileRow.vidBox） */
function VideoRow({ f }) {
  const url = fileUrl(f, false);
  const dl = fileUrl(f, true);
  const size = fmtSize(f.size);
  const name = String(f.name || '视频');
  return (
    <div className="fileRow vidBox" title={name + ' · ' + size}>
      <video
        controls
        preload="metadata"
        src={url}
        playsInline
        onDoubleClick={(e) => {
          const v = e.currentTarget;
          try {
            if (v.requestFullscreen) v.requestFullscreen();
            else if (v.webkitEnterFullscreen) v.webkitEnterFullscreen();
          } catch (err) {}
        }}
      />
      <a className="vidSave" href={dl} download={name} title={'存下来：' + name}>{'↓'}</a>
    </div>
  );
}

/** 普通文件：一张「图标 · 名字 · 大小 · ⬇」的下载卡（点一下存下来，不跳页） */
function DownCard({ f }) {
  const url = fileUrl(f, false);
  const dl = fileUrl(f, true);
  const size = fmtSize(f.size);
  const name = String(f.name || '文件');
  return (
    <a className="fileCard" href={dl} download={name} title={name + ' · ' + size + '（点一下下载）'}>
      <div className="fk">{iconOf(f.fkind, name)}</div>
      <div className="fmeta">
        <div className="fname">{name}</div>
        <div className="fsize">{size + ' · 点一下存下来'}</div>
      </div>
      <div className="fdl">{'⬇'}</div>
    </a>
  );
}

function FileCardInner({ it }) {
  const f = it || {};
  /* 语音口径照旧：像语音的（say_/voice_/…_v4_ 命名、voice 目录）一律语音条 */
  const isVoice = (f.fkind === 'audio' && (looksVoice(f) || !f.path))
    || (f.fkind !== 'video' && f.fkind !== 'image' && looksVoice(f));
  if (isVoice) return <VoiceRow f={f} />;
  if (f.fkind === 'image') return <ImageCard f={f} />;
  if (f.fkind === 'video') return <VideoRow f={f} />;
  return <DownCard f={f} />;
}

/** memo：文件条目内容不变就不重渲染（名字 / 大小 / key 定死了一切） */
export default memo(FileCardInner);
