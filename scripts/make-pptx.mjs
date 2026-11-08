/**
 * 做 PPT。
 *
 * 用法：写一份 JSON（讲什么内容），跑这个脚本，得到 .pptx。
 * 不用装 Office，纯 JS 生成。
 *
 * 输入 JSON 长这样：
 * {
 *   "title": "标题",
 *   "theme": "dark" | "light",            // 可选，默认 dark
 *   "slides": [
 *     { "type": "cover", "title": "...", "subtitle": "..." },
 *     { "type": "bullets", "title": "...", "items": ["a", "b"] },
 *     { "type": "table", "title": "...", "head": ["列1","列2"], "rows": [["a","b"]] },
 *     { "type": "section", "title": "..." }
 *   ]
 * }
 *
 * 跑法：node scripts/make-pptx.mjs 输入.json [输出.pptx]
 */
import fs from 'node:fs';
import path from 'node:path';
import PptxGenJS from 'pptxgenjs';

const THEMES = {
  dark: {
    bg: '1B2A4A', title: 'FFFFFF', body: 'D6E4F5',
    accent: '5B9BD5', coverSub: 'A8C4E8', tableHead: '2E4A75', tableRow: '24405F'
  },
  light: {
    bg: 'FFFFFF', title: '1B2A4A', body: '333333',
    accent: '2E75B6', coverSub: '5A7A9E', tableHead: 'DCE6F2', tableRow: 'F5F8FC'
  }
};

function arg(i, fallback) {
  return process.argv[i] ?? fallback;
}

const inPath = arg(2);
if (!inPath) {
  console.error('用法: node scripts/make-pptx.mjs <内容.json> [输出.pptx]');
  process.exit(2);
}
if (!fs.existsSync(inPath)) {
  console.error(`找不到输入文件: ${inPath}`);
  process.exit(2);
}

let spec;
try {
  spec = JSON.parse(fs.readFileSync(inPath, 'utf8').replace(/^\uFEFF/, ''));
} catch (e) {
  console.error(`JSON 读不了: ${e.message}`);
  process.exit(2);
}

const theme = THEMES[spec.theme] || THEMES.dark;
const slides = Array.isArray(spec.slides) ? spec.slides : [];
if (!slides.length) {
  console.error('slides 是空的，没什么可做');
  process.exit(2);
}

const pptx = new PptxGenJS();
pptx.layout = 'LAYOUT_16x9';
pptx.author = spec.author || '小鱼';
pptx.title = spec.title || '未命名';

for (const s of slides) {
  const sl = pptx.addSlide();
  const type = s.type || (s.items ? 'bullets' : 'cover');

  if (type === 'cover') {
    sl.background = { color: theme.bg };
    sl.addText(s.title || spec.title || '', {
      x: 0.6, y: 1.7, w: 8.8, h: 1.3,
      fontSize: 40, bold: true, color: theme.title, align: 'center'
    });
    if (s.subtitle) {
      sl.addText(s.subtitle, {
        x: 0.6, y: 3.1, w: 8.8, h: 0.9,
        fontSize: 18, color: theme.coverSub, align: 'center'
      });
    }
    continue;
  }

  if (type === 'section') {
    sl.background = { color: theme.bg };
    sl.addText(s.title || '', {
      x: 0.6, y: 2.4, w: 8.8, h: 1.2,
      fontSize: 34, bold: true, color: theme.title, align: 'center'
    });
    continue;
  }

  // 内容页统一样式
  sl.background = { color: theme.bg };
  if (s.title) {
    sl.addText(s.title, {
      x: 0.5, y: 0.35, w: 9, h: 0.9,
      fontSize: 26, bold: true, color: theme.title
    });
    sl.addShape(pptx.ShapeType.line, {
      x: 0.5, y: 1.25, w: 9, h: 0,
      line: { color: theme.accent, width: 2 }
    });
  }

  if (type === 'bullets' || Array.isArray(s.items)) {
    const items = (s.items || []).map(t => ({
      text: String(t),
      options: { bullet: true, breakLine: true, color: theme.body, fontSize: 18 }
    }));
    if (items.length) {
      sl.addText(items, { x: 0.7, y: 1.6, w: 8.6, h: 4, lineSpacingMultiple: 1.3 });
    }
  }

  if (type === 'table' && Array.isArray(s.head)) {
    const rows = [
      s.head.map(h => ({
        text: String(h),
        options: { bold: true, color: theme.title, fill: { color: theme.tableHead }, fontSize: 14 }
      })),
      ...(s.rows || []).map(r => r.map(c => ({
        text: String(c),
        options: { color: theme.body, fill: { color: theme.tableRow }, fontSize: 13 }
      })))
    ];
    sl.addTable(rows, {
      x: 0.6, y: 1.6, w: 8.8,
      border: { type: 'solid', color: theme.accent, pt: 0.5 },
      autoPage: false
    });
  }

  if (s.note) {
    sl.addNotes(String(s.note));
  }
}

const out = arg(3, path.join(process.cwd(), `${(spec.title || 'presentation').replace(/[\\/:*?"<>|]/g, '_')}.pptx`));
const outAbs = path.isAbsolute(out) ? out : path.resolve(process.cwd(), out);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
await pptx.writeFile({ fileName: outAbs });
const size = fs.statSync(outAbs).size;
console.log(`好了: ${outAbs}`);
console.log(`页数 ${slides.length}，大小 ${(size / 1024).toFixed(1)} KB`);