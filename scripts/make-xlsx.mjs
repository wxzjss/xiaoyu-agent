/**
 * 做 Excel 表格。
 *
 * 用法：写一份 JSON，跑这个脚本，得到 .xlsx。
 *
 * 输入 JSON：
 * {
 *   "file": "报表.xlsx",
 *   "sheets": [
 *     {
 *       "name": "明细",
 *       "head": ["日期", "项目", "金额"],
 *       "rows": [["2026-11-09","买菜",35.5],["2026-11-09","车费",12]],
 *       "widths": [14, 20, 12],
 *       "currency": [2],          // 哪几列是钱，自动加千分位两位小数
 *       "freeze": true,           // 冻结首行
 *       "sumRow": true            // 末尾加一行合计（只对数字列）
 *     }
 *   ]
 * }
 *
 * 命令：node scripts/make-xlsx.mjs 输入.json [输出.xlsx]
 */
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

const [, , inFile, outArg] = process.argv;
if (!inFile) {
  console.error('用法: node scripts/make-xlsx.mjs <输入.json> [输出.xlsx]');
  process.exit(1);
}
const spec = JSON.parse(fs.readFileSync(path.resolve(inFile), 'utf8').replace(/^\uFEFF/, ''));
const sheets = spec.sheets || [];
if (!sheets.length) {
  console.error('没有 sheets，什么都没做');
  process.exit(1);
}

const wb = new ExcelJS.Workbook();
wb.creator = spec.author || '小鱼';
wb.created = new Date();

for (const s of sheets) {
  const ws = wb.addWorksheet(String(s.name || 'Sheet').slice(0, 31));
  const head = s.head || [];
  const rows = s.rows || [];
  const widths = s.widths || [];
  const money = new Set(s.currency || []);

  if (head.length) {
    ws.addRow(head);
    const hr = ws.getRow(1);
    hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    hr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    hr.alignment = { vertical: 'middle', horizontal: 'center' };
    hr.height = 22;
  }
  for (const r of rows) ws.addRow(r);

  // 列宽
  head.forEach((_, i) => {
    const w = widths[i];
    ws.getColumn(i + 1).width = w || Math.max(10, Math.min(40, String(head[i] ?? '').length * 2 + 6));
  });

  // 数字列加千分位
  if (money.size) {
    for (const ci of money) {
      const col = ws.getColumn(ci + 1);
      col.numFmt = '#,##0.00';
    }
  }

  // 冻结首行
  if (s.freeze) ws.views = [{ state: 'frozen', ySplit: 1 }];

  // 合计行
  if (s.sumRow) {
    const last = ws.rowCount;
    const sumIdx = last + 1;
    const row = ws.getRow(sumIdx);
    row.font = { bold: true };
    row.getCell(1).value = '合计';
    for (let ci = 0; ci < head.length; ci++) {
      const allNum = rows.length > 0 && rows.every(r => typeof r[ci] === 'number');
      if (allNum) {
        const colLetter = ws.getColumn(ci + 1).letter;
        row.getCell(ci + 1).value = { formula: `SUM(${colLetter}2:${colLetter}${last})` };
        if (money.has(ci)) row.getCell(ci + 1).numFmt = '#,##0.00';
      }
    }
    ws.getRow(sumIdx).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
  }

  // 边框
  const lastRow = ws.rowCount, lastCol = head.length || 1;
  for (let r = 1; r <= lastRow; r++) {
    for (let c = 1; c <= lastCol; c++) {
      ws.getCell(r, c).border = {
        top: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        left: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } },
        right: { style: 'thin', color: { argb: 'FFD9D9D9' } }
      };
    }
  }
}

const out = outArg || spec.file || 'report.xlsx';
const outAbs = path.isAbsolute(out) ? out : path.resolve(process.cwd(), out);
fs.mkdirSync(path.dirname(outAbs), { recursive: true });
await wb.xlsx.writeFile(outAbs);
console.log(`好了: ${outAbs}`);
console.log(`${sheets.length} 个表，大小 ${(fs.statSync(outAbs).size / 1024).toFixed(1)} KB`);