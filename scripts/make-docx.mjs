/**
 * 做 Word 文档。
 *
 * 用法：写一份 JSON，跑这个脚本，得到 .docx。
 *
 * 输入 JSON：
 * {
 *   "title": "标题",
 *   "author": "小鱼",
 *   "blocks": [
 *     { "type": "h1", "text": "大标题" },
 *     { "type": "h2", "text": "小标题" },
 *     { "type": "p", "text": "正文段落" },
 *     { "type": "bullets", "items": ["第一条", "第二条"] },
 *     { "type": "numbers", "items": ["第一步", "第二步"] },
 *     { "type": "table", "head": ["列1","列2"], "rows": [["a","b"]] },
 *     { "type": "code", "text": "console.log(1)" },
 *     { "type": "quote", "text": "引用的话" },
 *     { "type": "pagebreak" }
 *   ]
 * }
 *
 * 命令：node scripts/make-docx.mjs 输入.json 输出.docx
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  Document, Packer, Paragraph, TextRun, HeadingLevel,
  Table, TableRow, TableCell, WidthType, AlignmentType
} from 'docx';

const [, , inFile, outArg] = process.argv;
if (!inFile) {
  console.error('用法: node scripts/make-docx.mjs <输入.json> [输出.docx]');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(path.resolve(inFile), 'utf8').replace(/^\uFEFF/, ''));
const blocks = spec.blocks || [];

const kids = [];

if (spec.title) {
  kids.push(new Paragraph({
    text: spec.title,
    heading: HeadingLevel.TITLE,
    spacing: { after: 240 }
  }));
}

for (const b of blocks) {
  const t = b.type || 'p';
  if (t === 'h1') {
    kids.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_1, spacing: { before: 240, after: 120 } }));
  } else if (t === 'h2') {
    kids.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_2, spacing: { before: 200, after: 100 } }));
  } else if (t === 'h3') {
    kids.push(new Paragraph({ text: b.text, heading: HeadingLevel.HEADING_3, spacing: { before: 160, after: 80 } }));
  } else if (t === 'p') {
    kids.push(new Paragraph({ text: b.text || '', spacing: { after: 120 } }));
  } else if (t === 'bullets') {
    for (const it of (b.items || [])) {
      kids.push(new Paragraph({ text: String(it), bullet: { level: 0 }, spacing: { after: 60 } }));
    }
  } else if (t === 'numbers') {
    for (const it of (b.items || [])) {
      kids.push(new Paragraph({ text: String(it), numbering: { reference: 'num-list', level: 0 }, spacing: { after: 60 } }));
    }
  } else if (t === 'quote') {
    kids.push(new Paragraph({
      children: [new TextRun({ text: b.text || '', italics: true, color: '555555' })],
      indent: { left: 480 },
      spacing: { after: 120 }
    }));
  } else if (t === 'code') {
    for (const line of String(b.text || '').split('\n')) {
      kids.push(new Paragraph({
        children: [new TextRun({ text: line, font: 'Consolas', size: 18 })],
        shading: { fill: 'F4F4F4' },
        spacing: { after: 0 }
      }));
    }
    kids.push(new Paragraph({ text: '', spacing: { after: 80 } }));
  } else if (t === 'table') {
    const head = b.head || [];
    const rows = b.rows || [];
    const mkCell = (txt, bold) => new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text: String(txt ?? ''), bold: !!bold })] })],
      margins: { top: 60, bottom: 60, left: 100, right: 100 }
    });
    const trs = [];
    if (head.length) trs.push(new TableRow({ tableHeader: true, children: head.map(h => mkCell(h, true)) }));
    for (const r of rows) trs.push(new TableRow({ children: r.map(c => mkCell(c, false)) }));
    kids.push(new Table({ rows: trs, width: { size: 100, type: WidthType.PERCENTAGE } }));
    kids.push(new Paragraph({ text: '', spacing: { after: 120 } }));
  } else if (t === 'pagebreak') {
    kids.push(new Paragraph({ children: [], pageBreakBefore: true }));
  }
}

const doc = new Document({
  creator: spec.author || '小鱼',
  title: spec.title || '文档',
  numbering: {
    config: [{
      reference: 'num-list',
      levels: [{ level: 0, format: 'decimal', text: '%1.', alignment: AlignmentType.START }]
    }]
  },
  sections: [{ children: kids }]
});

const out = outArg || `${(spec.title || 'document').replace(/[\\/:*?"<>|]/g, '_')}.docx`;
const outAbs = path.isAbsolute(out) ? out : path.resolve(process.cwd(), out);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
fs.writeFileSync(outAbs, await Packer.toBuffer(doc));
console.log(`好了: ${outAbs}`);
console.log(`段落 ${kids.length} 个，大小 ${(fs.statSync(outAbs).size / 1024).toFixed(1)} KB`);