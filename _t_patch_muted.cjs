const fs=require('fs');
let p='D:/小鱼Agent/sandbox/mini_ds/mini_ds.py';
let s=fs.readFileSync(p,'utf8');
if(s.includes('muted_probe')){console.log('already');process.exit(0)}
let old=`        body = r.json()
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(data, dict):`;
let nw=`        body = r.json()
        data = body.get("data") if isinstance(body, dict) else None
        # muted_probe: 建会话也可能被禁言拦（data 变 null 带 biz_code=5），别误报成 token 失效
        if isinstance(body, dict):
            _d0 = body.get("data")
            if isinstance(_d0, dict) and (_d0.get("biz_code") == 5 or _d0.get("is_muted") == 1):
                _note_muted(_d0.get("mute_until") or (time.time() + 3600))
                raise RuntimeError("账号被禁言，约 " + str(int((_RATE['muted_until'] - time.time()) / 3600) + 1) + " 小时后解除，别重试")
        if not isinstance(data, dict):`;
if(!s.includes(old)){console.log('anchor2 not found');process.exit(1)}
s=s.replace(old,nw);
fs.writeFileSync(p,s);
console.log('patched');
