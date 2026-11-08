import PptxGenJS from 'pptxgenjs';

const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_16x9';
pptx.author = '小鱼';
pptx.title = '测试';

const s = pptx.addSlide();
s.background = { color: '1B2A4A' };
s.addText('小鱼能做 PPT 了', {
  x: 0.5, y: 1.6, w: 9, h: 1.2,
  fontSize: 40, bold: true, color: 'FFFFFF', align: 'center'
});
s.addText('pptxgenjs · 纯 JS · 不需要 Office', {
  x: 0.5, y: 2.9, w: 9, h: 0.6,
  fontSize: 18, color: 'A8C4E8', align: 'center'
});

const s2 = pptx.addSlide();
s2.addText('第二页', { x: 0.5, y: 0.4, w: 9, h: 0.8, fontSize: 28, bold: true, color: '1B2A4A' });
s2.addText(
  [
    { text: '可以加表：', options: { bullet: true, breakLine: true } },
    { text: '可以加图、加形状、加图表', options: { bullet: true, breakLine: true } },
    { text: '输出就是 .pptx，WPS / Office 都能开', options: { bullet: true } }
  ],
  { x: 0.6, y: 1.4, w: 8.5, h: 2, fontSize: 18, color: '333333' }
);

await pptx.writeFile({ fileName: 'D:/小鱼Agent/.tmp_pptx_test.pptx' });
console.log('写出去了');