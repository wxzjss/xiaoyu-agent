// 实测：用代码画图真画几张，看效果和耗时
import { drawByCode } from '../src/code-draw.mjs';

const jobs = [
  { prompt: '星空下的鲸鱼', template: 'starfield', palette: 'aurora', title: '星空下的鲸鱼', size: '1024x1024' },
  { prompt: '深海里的光', template: 'ocean', palette: 'ocean', title: '深海里的光', size: '1280x720' },
  { prompt: '傍晚的山', template: 'mountains', palette: 'sunset', title: '傍晚的山', size: '1024x1024' },
  { prompt: '赛博城市夜景', template: 'city', palette: 'cyber', title: '赛博城市', size: '1280x720' },
  { prompt: '一颗蓝色星球', template: 'planet', palette: 'midnight', title: '蓝色星球', size: '1024x1024' },
  { prompt: '水波纹', template: 'waves', palette: 'ocean', title: '水波纹', size: '1024x1024' },
];

for (const j of jobs) {
  const t0 = Date.now();
  const r = await drawByCode(j);
  console.log(JSON.stringify({
    tpl: j.template, ok: r.ok, engine: r.engine, path: r.path,
    wh: r.width + 'x' + r.height, kb: Math.round((r.bytes || 0) / 1024),
    ms: Date.now() - t0, warn: r.warn || '', err: r.error || '',
  }));
}
