/* 站岗：改前红 / 改后绿的源码级断言 */
import { readFileSync } from 'node:fs';
const srv = readFileSync('src/server.mjs', 'utf8');
let p=0,f=0; const ok=(m,c)=>{c?(p++,console.log('  [ok] '+m)):(f++,console.log('  [!!] '+m));};
ok('9657 口：她在屋里开着时旁白让位（正常轮带真工具来答）',
  srv.includes('__whaleAliveInRoom') && srv.includes('!__whaleAliveInRoom'));
ok('旁白人设有硬线：没真调工具不许断言查过',
  srv.includes('真调用过工具') && srv.includes('没调工具就写这些 = 编造'));
ok('收尾自发插话认功能页旁观者名单（不再认旧 whale-on 表）',
  srv.includes('__spectWhale') && srv.includes('__speaksToHer || __spectWhale'));
ok('干活中途的插话闸保持屋里的人过滤',
  srv.includes('const __resident = new Set(residentNamesOf(sessionId));'));
console.log(p+' 过 / '+f+' 挂');
process.exit(f?1:0);
