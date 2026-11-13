// 把 dataURL 存成 png
const fs = require('fs');
let d = fs.readFileSync('D:/小鱼Agent/_t_cap_data.txt', 'utf8').trim();
d = d.replace(/^"+|"+$/g, '');
if (d.startsWith('data:image')) {
  fs.writeFileSync('D:/小鱼Agent/_t_captcha.png', Buffer.from(d.split(',')[1], 'base64'));
  console.log('saved ' + d.length);
} else {
  console.log('NOT DATA: ' + d.slice(0, 150));
}
