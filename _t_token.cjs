const http=require('http');
function getJson(p){return new Promise((res,rej)=>{http.get({host:'127.0.0.1',port:9222,path:p},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>{try{res(JSON.parse(d))}catch(e){rej(e)}})}).on('error',rej)})}
async function main(){
  const tabs=await getJson('/json');
  const page=tabs.find(t=>t.type==='page'&&/deepseek/i.test(t.url));
  const WebSocket=require('ws');
  const ws=new WebSocket(page.webSocketDebuggerUrl,{perMessageDeflate:false});
  let id=0;const pend=new Map();
  function send(m,p){return new Promise((res)=>{const i=++id;pend.set(i,res);ws.send(JSON.stringify({id:i,method:m,params:p}))})}
  ws.on('message',m=>{const d=JSON.parse(m);if(d.id&&pend.has(d.id)){pend.get(d.id)(d);pend.delete(d.id)}});
  await new Promise(r=>ws.on('open',r));
  const r=await send('Runtime.evaluate',{expression:`localStorage.getItem('userToken')`,returnByValue:true});
  const raw=r.result.result.value;
  const j=JSON.parse(raw);
  console.log('userToken fields:',Object.keys(j).join(','));
  const tok=j.value||j.token;
  console.log('TOKEN head='+String(tok).slice(0,10)+' len='+String(tok).length);
  require('fs').writeFileSync('D:\\小鱼Agent\\_t_token_new.txt',String(tok));
  ws.close();
}
main().catch(e=>console.log('ERR',e.message));
