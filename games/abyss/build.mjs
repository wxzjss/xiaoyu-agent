import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(__dirname, 'src');

const ORDER = [
  '00-core.js',
  '10-art-char.js',
  '11-art-fx.js',
  '20-weapons.js',
  '21-enemies.js',
  '22-passives.js',
  '30-audio.js',
  '40-game.js',
  '50-ui.js',
];

const missing = [];
const parts = [];
let totalBytes = 0;
for (const f of ORDER) {
  const p = path.join(SRC, f);
  if (!fs.existsSync(p)) { missing.push(f); continue; }
  const code = fs.readFileSync(p, 'utf8');
  totalBytes += Buffer.byteLength(code, 'utf8');
  parts.push('/* ===== ' + f + ' ===== */\n;(function(){\n' + code + '\n})();');
}
if (missing.length) {
  console.warn('[build] 缺少文件：' + missing.join(', '));
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<meta name="theme-color" content="#05070d">
<title>鲸落·深渊 — ABYSS FALL</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html,body {
    width:100%; height:100%; overflow:hidden; background:#05070d;
    -webkit-tap-highlight-color:transparent; user-select:none;
    font-family:"Microsoft YaHei","PingFang SC",sans-serif;
  }
  #wrap { position:fixed; inset:0; background:#05070d; }
  #game {
    position:absolute; image-rendering: pixelated;
    image-rendering: -moz-crisp-edges;
    image-rendering: crisp-edges;
    background:#05070d;
  }
  #ui { position:absolute; left:0; top:0; pointer-events:none; }
  #boot {
    position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
    flex-direction:column; gap:14px; color:#8fd4f0; background:#05070d; z-index:10;
    font-size:14px; letter-spacing:2px;
  }
  #boot .t { font-size:30px; font-weight:700; color:#dff4ff; letter-spacing:8px;
    text-shadow:0 0 24px rgba(110,200,255,.75); }
  #boot .s { font-size:11px; color:#4a6a8a; letter-spacing:3px; }
  #boot .spin { width:26px; height:26px; border:2px solid #1e2c4a; border-top-color:#8fd4f0;
    border-radius:50%; animation:sp .9s linear infinite; }
  @keyframes sp { to { transform:rotate(360deg); } }
  #err { position:absolute; left:12px; bottom:12px; right:12px; color:#ff8f9e;
    font:12px/1.5 monospace; white-space:pre-wrap; display:none; z-index:20;
    background:rgba(0,0,0,.8); padding:10px; border-radius:8px; max-height:40%; overflow:auto; }
</style>
</head>
<body>
<div id="wrap">
  <canvas id="game"></canvas>
  <canvas id="ui"></canvas>
  <div id="boot">
    <div class="t">鲸 落 · 深 渊</div>
    <div class="spin"></div>
    <div class="s">A B Y S S   F A L L</div>
  </div>
  <div id="err"></div>
</div>
<script>
window.addEventListener('error', function(e){
  var el = document.getElementById('err');
  if(!el) return;
  el.style.display = 'block';
  el.textContent += (e.message || e.error) + '\\n  at ' + (e.filename||'') + ':' + (e.lineno||'') + '\\n';
});
</script>
<script>
${parts.join('\n\n')}
</script>
<script>
(function(){
  setTimeout(function(){
    var b = document.getElementById('boot');
    if(b) b.style.display = 'none';
    try { if (window.G && G.UI && G.UI.init) G.UI.init(); } catch(e){ console.warn(e); }
  }, 260);
})();
</script>
</body>
</html>
`;

const out = path.join(__dirname, '..', 'abyss-fall.html');
fs.writeFileSync(out, html, 'utf8');
const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
console.log('[build] 写入 ' + out + '  (' + kb + ' KB, 源码 ' + (totalBytes/1024).toFixed(1) + ' KB)');
if (missing.length) process.exitCode = 1;
