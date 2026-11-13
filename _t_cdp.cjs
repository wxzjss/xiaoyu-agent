const http = require('http');
function getJson(path){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9222,path},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
async function main(){
  const tabs = await getJson('/json');
  const page = tabs.find(t=>t.type==='page' && /deepseek|login/i.test(t.url)) || tabs.find(t=>t.type==='page');
  if(!page){console.log('NO PAGE');return}
  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl, {perMessageDeflate:false});
  let id=0; const pend=new Map();
  function send(method,params){return new Promise((res,rej)=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method,params}))})}
  ws.on('message',m=>{const d=JSON.parse(m);if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id)}});
  await new Promise(r=>ws.on('open',r));
  const expr = `(()=>{
    const t=(document.body.innerText||'').slice(0,1500);
    const btns=[...document.querySelectorAll('button,div[class*=button],a')].map(b=>({txt:(b.textContent||'').trim().slice(0,30),vis:!!(b.offsetWidth||b.offsetHeight)})).filter(b=>b.txt&&b.vis).slice(0,30);
    const inputs=[...document.querySelectorAll('input')].map(i=>({ph:i.placeholder||'',len:(i.value||'').length,vis:!!(i.offsetWidth||i.offsetHeight)}));
    const popup=document.querySelector('[class*=modal],[class*=dialog],[class*=popup],[class*=captcha],[class*=slide],[class*=verify]');
    return JSON.stringify({url:location.href.slice(0,120),text:t,inputs,btns,popup:popup?(popup.className+'|'+popup.innerText.slice(0,300)):null},null,1);
  })()`;
  const r = await send('Runtime.evaluate',{expression:expr,returnByValue:true});
  console.log(r.result && r.result.result ? r.result.result.value : JSON.stringify(r));
  ws.close();
}
main().catch(e=>console.log('ERR',e.message));
