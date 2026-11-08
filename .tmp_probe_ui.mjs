import fs from 'node:fs';

const s = fs.readFileSync('D:/小鱼Agent/public/index.html', 'utf8');
const keys = ['toBottomBadge', 'id="toBottom"', 'id="log"', 'unseenNew'];
for (const k of keys) {
  let i = -1, c = 0;
  while ((i = s.indexOf(k, i + 1)) >= 0 && c < 5) {
    c++;
    console.log(k, '@line', s.slice(0, i).split('\n').length);
  }
  if (!c) console.log(k, '-> none');
}

console.log('\n===== bumpUnseen 全文 =====');
let i = s.indexOf('function bumpUnseen');
console.log('line', s.slice(0, i).split('\n').length);
console.log(s.slice(i, i + 1200));

console.log('\n===== paintToBottom 全文 =====');
i = s.indexOf('function paintToBottom');
console.log(s.slice(i, i + 1500));
