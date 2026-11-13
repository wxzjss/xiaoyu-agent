const fs = require('fs');
const p = 'public/index.html';
let s = fs.readFileSync(p, 'utf8');
let n = 0;
const rep = (oldStr, newStr, tag) => {
  if (s.includes(oldStr)) { s = s.split(oldStr).join(newStr); n++; console.log('OK', tag); }
  else console.log('MISS', tag);
};

// 1) 本机分支开头：把表单 base 规范成带 /v1（not found 的根治）
rep(
`      // 先把模型加进 / 对齐（内部会查服务、必要时起服务）
      let done = await localDeepSeekApply(payload);`,
`      // base 少 /v1 的话自动补上（not found 的根治：8321 只有 /v1 前缀路由）
      if (mdlBase && mdlBase.value && !/\\/v1\\s*$/.test(mdlBase.value.trim())) {
        mdlBase.value = mdlBase.value.trim().replace(/\\/+$/, '') + '/v1';
        payload = formPayload();
      }

      // 先把模型加进 / 对齐（内部会查服务、必要时起服务）
      let done = await localDeepSeekApply(payload);`,
't1 base补/v1');

// 2) token 失效救急：重取 token 后强制重启（ensure 看 up+hasToken 会跳过，救不动）
rep(
`      } else {
        // token 原因：重取一次`,
`      } else {
        // token 原因：重取一次（并强制重启服务，旧进程里 token 不会自己换新）`,
't2 注释');

const i = s.indexOf("getElementById('mdlTest')");
const seg = s.slice(i, i + 6000);
console.log('--- else 分支原文 ---');
const e = seg.indexOf("} else {");
console.log(seg.slice(e, e + 1200));
fs.writeFileSync(p, s);
console.log('saved, applied', n);
