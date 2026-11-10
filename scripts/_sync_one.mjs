import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const repo = 'D:/小鱼Agent/src/agent.mjs';
const live = path.join(os.homedir(), 'AppData/Roaming/小鱼Agent/data/code/src/agent.mjs');

const a = fs.readFileSync(repo);
fs.writeFileSync(live, a);

const b = fs.readFileSync(live);
console.log('repo bytes:', a.length);
console.log('live bytes:', b.length);
console.log('identical:', a.equals(b));
console.log('live has bad_shape retry:', b.toString('utf8').includes('bad_shape'));