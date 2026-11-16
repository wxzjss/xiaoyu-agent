import { actorScript } from '../src/code-draw-actor.mjs';
import { writeFileSync } from 'node:fs';

const body = actorScript();
const html = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;background:#0a1020}canvas{display:block}</style>
<canvas id="c" width="1024" height="1024"></canvas>
<script>
var cv=document.getElementById('c'), ctx=cv.getContext('2d');
var W=1024,H=1024;
${body}
/* 背景：夜空渐变 + 一点星云，用来检验角色在场景里是否融得进去 */
var g=ctx.createLinearGradient(0,0,0,H);
g.addColorStop(0,'#08101f');g.addColorStop(0.55,'#122a4a');g.addColorStop(1,'#2a4a6e');
ctx.fillStyle=g;ctx.fillRect(0,0,W,H);
for(var i=0;i<220;i++){var x=Math.random()*W,y=Math.random()*H*0.75,r=Math.random()*1.7+0.3;
ctx.globalAlpha=0.25+Math.random()*0.75;ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x,y,r,0,6.2832);ctx.fill();}
ctx.globalAlpha=1;
var gn=ctx.createRadialGradient(760,220,10,760,220,320);
gn.addColorStop(0,'rgba(120,180,255,0.30)');gn.addColorStop(1,'rgba(120,180,255,0)');
ctx.fillStyle=gn;ctx.fillRect(0,0,W,H);
var gn2=ctx.createRadialGradient(250,420,10,250,420,300);
gn2.addColorStop(0,'rgba(190,120,220,0.22)');gn2.addColorStop(1,'rgba(190,120,220,0)');
ctx.fillStyle=gn2;ctx.fillRect(0,0,W,H);
/* 地面 */
var gg=ctx.createLinearGradient(0,780,0,H);
gg.addColorStop(0,'#16283f');gg.addColorStop(1,'#0a1626');
ctx.fillStyle=gg;ctx.fillRect(0,780,W,H-780);

/* 角色：1024 里 s=440 让身高约 450px */
wgGirl(300, 900, 420, {});
wgGirl(512, 950, 470, {});
wgGirl(740, 905, 400, {});
window.__done = 1;
</script>`;
writeFileSync('D:/小鱼Agent/dump/_shot/actor-test.html', html);
console.log('ok', html.length);


