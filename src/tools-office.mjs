/**
 * 做文档的三个工具：PPT / Word / Excel。
 *
 * 为什么不在这儿重写一遍生成逻辑：scripts/make-pptx.mjs 那三份已经实际跑通、
 * 文件结构验过了（zip 里 slide1..N.xml 都在、SUM 公式在）。工具层只负责
 * 「把我给的结构化内容写成 JSON → 调那个脚本 → 把产出发给主人」，
 * 生成逻辑只有一份，改样式只改脚本，不会两边跑偏。
 */
import { writeFileSync, mkdirSync, existsSync, statSync, unlinkSync } from 'node:fs';
import { resolve, isAbsolute, join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { config } from './config.mjs';

/** 脚本所在的 scripts 目录：仓库版和打包版位置不同，按运行时目录往上找。 */
function scriptsDir() {
  const here = dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
  const cands = [
    resolve(here, '..', 'scripts'),                        // data/code/src -> data/code/scripts
    resolve(here, '..', '..', 'scripts'),
    resolve(process.cwd(), 'scripts'),
  ];
  for (const c of cands) if (existsSync(c)) return c;
  return cands[0];
}

/** 跑脚本，带超时；返回 stdout。脚本自己会校验内容并用退出码报错。 */
function runScript(script, args, timeoutMs = 90000) {
  return new Promise((ok, bad) => {
    execFile(process.execPath, [join(scriptsDir(), script), ...args], {
      timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true,
    }, (err, stdout, stderr) => {
      if (err) {
        const msg = String(stderr || err.message || '').trim().slice(-800);
        return bad(new Error(msg || '脚本退出码非 0'));
      }
      ok(String(stdout || '').trim());
    });
  });
}

/** 三个工具共用的骨架：写 JSON → 调脚本 → 交文件。 */
function officeTool({ name, ext, script, key, describe }) {
  return {
    name,
    description: describe,
    parameters: {
      type: 'object',
      properties: {
        [key]: {
          type: 'object',
          description: '内容结构，见工具说明。',
          additionalProperties: true,
        },
        out: {
          type: 'string',
          description: '存到哪（绝对路径，或工作区相对路径）。不填就放 dump/docs 下自动起名。',
        },
        note: { type: 'string', description: '一句话说这是啥，会单独作为一条文字发出去。' },
      },
      required: [key],
    },
    async run(args = {}) {
      const spec = args[key];
      if (!spec || typeof spec !== 'object') return `ERROR：${key} 要是对象，不能空。`;

      const title = String(spec.title || '未命名');
      const base = (config.workspace || process.cwd());
      const tmpDir = join(base, 'dump', '.tmp');
      mkdirSync(tmpDir, { recursive: true });
      const tmpJson = join(tmpDir, `office-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);

      const outPath = args.out && String(args.out).trim()
        ? (isAbsolute(String(args.out)) ? String(args.out) : resolve(base, String(args.out)))
        : join(base, 'dump', 'docs', `${String(title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60)}.${ext}`);

      writeFileSync(tmpJson, JSON.stringify(spec, null, 2), 'utf8');
      try {
        await runScript(script, [tmpJson, outPath]);
      } catch (e) {
        try { unlinkSync(tmpJson); } catch { }
        return `ERROR：没做出来 —— ${e.message}`;
      }
      try { unlinkSync(tmpJson); } catch { }

      if (!existsSync(outPath)) return `ERROR：脚本说做完了，但文件不在：${outPath}`;
      const size = statSync(outPath).size;
      if (!size) return `ERROR：文件是 0 字节：${outPath}`;

      // 交给主人：走 outbox，聊天里就长出文件卡片
      let card = '';
      try {
        const { stash } = await import('./outbox.mjs');
        stash({ path: outPath, note: args.note || '' });
        card = '\n（已经发出去了，聊天里能直接下。）';
      } catch {
        card = `\n（文件在这儿：${outPath}）`;
      }
      const kb = (size / 1024).toFixed(1);
      const said = args.note ? `\n（${args.note}）` : '';
      return `做好了：${outPath}\n大小 ${kb} KB${card}${said}`;
    },
  };
}

const COMMON_HINT =
  '内容结构写清楚就行，别自己拼 XML。做出来会存成真文件并直接发给你。';

export const makePptxTool = officeTool({
  name: 'make_pptx',
  ext: 'pptx',
  script: 'make-pptx.mjs',
  key: 'deck',
  describe:
    '做一份 PPT 文件（真 .pptx，PowerPoint 能打开）。' +
    'deck 里：{ title, author, theme: "dark"|"light", slides: [ {type:"cover", title, subtitle} / ' +
    '{type:"section", title} / {type:"bullets", title, items:[...]} / ' +
    '{type:"table", title, head:[...], rows:[[...]]} ] }。' +
    '16:9 版式，深色和亮色两套模板自动配色。' + COMMON_HINT,
});

export const makeDocxTool = officeTool({
  name: 'make_docx',
  ext: 'docx',
  script: 'make-docx.mjs',
  key: 'doc',
  describe:
    '做一份 Word 文档（真 .docx，Word/WPS 能打开）。' +
    'doc 里：{ title, blocks: [...] }，block 的 type 可以是 ' +
    'h1/h2/h3（text）、p（text）、bullets（items 数组）、numbers（items 数组）、' +
    'quote（text）、code（text，多行用 \\n）、table（head 数组 + rows 二维数组）。' +
    '标题层级、项目符号、代码块、表格样式都是排好的。' + COMMON_HINT,
});

export const makeXlsxTool = officeTool({
  name: 'make_xlsx',
  ext: 'xlsx',
  script: 'make-xlsx.mjs',
  key: 'book',
  describe:
    '做一个 Excel 表格（真 .xlsx）。' +
    'book 里：{ title, sheets: [ {name, head:[表头...], rows:[[...],[...]], sum: true} ] }。' +
    'sum 填 true 就在最后加一行合计（数字列走 SUM 公式，不是写死的值）。' +
    '会自动设列宽、加表头样式。多个 sheet 一次就能出多页。' + COMMON_HINT,
});