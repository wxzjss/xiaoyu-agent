const http=require('http');
function getJson(p){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9222,path:p},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
async function main(){
  const tabs=await getJson('/json');
  const page=tabs.find(t=>t.type==='page'&&/deepseek/i.test(t.url));
  if(!page){console.log('NO PAGE');return}
  const WebSocket=require('ws');
  const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false});
  let id=0;const pend=new Map();
  function send(m,p){return new Promise((res,rej)=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}))})}
  ws.on('message',m=>{const d=JSON.parse(m);if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id)}});
  await new Promise(r=>ws.on('open',r));
  const expr=`(()=>{
    const code='255475';
    const inputs=[...document.querySelectorAll('input')];
    const ci=inputs.find(i=>/验证码/.test(i.placeholder||''));
    if(!ci)return 'NO CODE INPUT';
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(ci,code);
    ci.dispatchEvent(new Event('input',{bubbles:true}));
    ci.dispatchEvent(new Event('change',{bubbles:true}));
    const btns=[...document.querySelectorAll('button,div[class*=button]')];
    const vb=btns.find(b=>(b.textContent||'').trim()==='验证并登录'&&(b.offsetWidth||b.offsetHeight));
    if(!vb)return 'NO BTN, filled='+ci.value;
    vb.click();
    setTimeout(()=>{},100);
    return 'CLICKED, code='+ci.value;
  })()`;
  const r=await send('Runtime.evaluate',{expression:expr,returnByValue:true});
  console.log(r.result&&r.result.result?r.result.result.value:JSON.stringify(r));
  await new Promise(r=>setTimeout(r,3000));
  const r2=await send('Runtime.evaluate',{expression:`(document.body.innerText||'').slice(0,800)+'||URL:'+location.href`,returnByValue:true});
  console.log('AFTER:',r2.result.result.value);
  ws.close();
}
main().catch(e=>console.log('ERR',e.message));
