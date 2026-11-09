const fs = require('fs');
const p = 'src/tools.mjs';
let t = fs.readFileSync(p, 'utf8');
const before = t.length;

const importAnchor = "import { makeImageTool } from './tools-image.mjs';";
if (!t.includes(importAnchor)) { console.log('NO ANCHOR import'); process.exit(1); }
if (!t.includes('tools-office.mjs')) {
  t = t.replace(importAnchor, importAnchor + "\nimport { makePptxTool, makeDocxTool, makeXlsxTool } from './tools-office.mjs';");
}

const toolAnchor = '  makeImageTool,';
if (!t.includes(toolAnchor)) { console.log('NO ANCHOR tools'); process.exit(1); }
if (!t.includes('makePptxTool,')) {
  t = t.replace(toolAnchor, '  makeImageTool,\n  makePptxTool,\n  makeDocxTool,\n  makeXlsxTool,');
}

fs.writeFileSync(p, t, 'utf8');
console.log('len', before, '->', fs.statSync(p).size);
console.log('import ok', /tools-office\.mjs/.test(t), '| tools ok', /makePptxTool,/.test(t));