/**
 * AI 自检引擎：把「这台机器的现状」交给模型，由它自己查、自己判断。
 *
 * 和 selfcheck.mjs 的分工：
 *   selfcheck.mjs  —— 只管【程序必须真动手】的事（建快捷方式、自动更新），
 *                     以及把两边的结果合成一份、落盘、给系统提示用。
 *   本文件        —— 提供一组【只读】探针 + 现场快照 + 提示词，
 *                     跑一轮模型循环，让 AI 自己决定查什么、什么算问题。
 *
 * 为什么这么拆：以前「查什么、什么算合格」全是代码里写死的检查项，
 * 机器不会变通（主人故意删掉的目录它照样喊「缺文件」）。现在判断权交给模型，
 * 程序只负责保证探针真实、只读、不越界。
 *
 * 硬边界：
 *   1. 探针全部只读：不写、不删、不发布、不装东西；
 *   2. 只能在项目目录里查，出界直接拒；
 *   3. 没配模型 / 没网 → 返回 skipped，绝不挡启动。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createConnection } from 'node:net';
import { homedir, platform, release, cpus, totalmem } from 'node:os';

import { config } from './config.mjs';
import { chat } from './llm.mjs';
import { activeEndpoint, probeEndpoint } from './models.mjs';
import { loadRulesText } from './rules.mjs';

const ROOT = config.root;

/** 一次自检最多让模型来回几轮 */
const MAX_ROUNDS = 5;

// 探针总次数上限。2026-10-26 实测：模型每轮会一次甩出 4~5 个探针，5 轮 = 10 次，
// 轮数还没用完但「整轮探针」已经把时间烧光，最后连一句结论都没给，
// 报出来的是「问了太多轮还没给结论」——轮数其实是够的，是探针太碎。
// 所以这里按「探针总次数」掐，而不是按轮数掐。留一格给收尾轮。
// 2026-10-26 实测第二轮：掐到 4 还是不够 —— 模型第一次调用就甩 4 个探针，
// 一轮就把预算烧光，收尾轮仓促，3 次里有 1 次给不出 JSON（items 空）。放到 6
// 允许「甩一次 4 个 + 再补 2 个」，同时仍然只有原来 10 次的一半多点。
const MAX_PROBES = 6;

/** 整个自检最多花多久（毫秒） */
const TOTAL_TIMEOUT = 90_000;

/** 单条命令超时 */
const CMD_TIMEOUT = 15_000;

// ------------------------------------------------------------------ 只读探针

/**
 * 把不该写进自检结果的东西遮掉。
 *
  * 为什么：探针会把文件内容原样带出来，.env 里就写着 WORKSPACE 加本机真实路径；
 * 而自检结论要落盘（.state/selfcheck.json）、还会进系统提示词。
 * 主人的真实用户名、密钥、邮箱，一个字都不该跟着跑出去。
 */
function maskSensitive(text) {
  let t = String(text ?? '');
  // Windows 用户目录里的用户名要遮掉（只留盘符和 Users 这段）
  t = t.replace(/([A-Za-z]:[\\/][Uu]sers[\\/])([^\\/\s"'`<>|]+)/g, '$1***');
  // 其他盘符的长绝对路径：保留盘符和最后一层，中间打码
  t = t.replace(/([A-Za-z]:\\)((?:[^\\\s"'`<>|]+\\){2,})([^\\\s"'`<>|]+)/g, (m, drive, mid, last) => drive + '***\\' + last);
  // 用户主目录整体替换
  try {
    const home = homedir();
    if (home && home.length > 3) {
      const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(esc, 'gi'), '<用户目录>');
    }
  } catch {}
  // KEY / TOKEN / SECRET / PASSWORD 的值
  t = t.replace(/([A-Za-z0-9_-]*(?:KEY|TOKEN|SECRET|PASSWORD|PWD)[A-Za-z0-9_-]*\s*[=:]\s*)(\S{6,})/gi,
    (m, head, val) => head + val.slice(0, 2) + '***' + val.slice(-2));
  // 邮箱
  t = t.replace(/[A-Za-z0-9._%+-]+@(?!example\.|local\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '***@***');
  return t;
}

function inRoot(p) {
  const abs = join(ROOT, String(p));
  const rel = relative(ROOT, abs);
  if (rel.startsWith('..')) throw new Error(`只能在项目目录里查：${p}`);
  return abs;
}

export const PROBES = [
  {
    name: 'probe_files',
    description:
      '看文件/目录在不在、多大、什么时候改的。判断「关键文件齐不齐」就用它，别靠猜。',
    parameters: {
      type: 'object',
      properties: {
        paths: {
          type: 'array',
          items: { type: 'string' },
          description: '相对项目根的路径，比如 ["src/server.mjs","public/index.html"]',
        },
      },
      required: ['paths'],
    },
    run({ paths }) {
      const out = [];
      for (const p of Array.isArray(paths) ? paths : []) {
        const abs = inRoot(p);
        try {
          const s = statSync(abs);
          if (s.isDirectory()) {
            const kids = readdirSync(abs);
            out.push(`${p}/  目录，${kids.length} 项：${kids.slice(0, 12).join(', ')}`);
          } else {
            out.push(`${p}  ${s.size}B  改于 ${new Date(s.mtimeMs).toISOString()}`);
          }
        } catch (e) {
          out.push(`${p}  ✗ 不存在（${e.code || e.message}）`);
        }
      }
      return out.join('\n') || '(没给路径)';
    },
  },
  {
    name: 'probe_read',
    description: '读项目里一个文本文件的前一段（确认配置写没写对）。只读，密钥会自动遮掉。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '相对项目根的路径' },
        maxChars: { type: 'number', description: '最多读多少字符，默认 1200' },
      },
      required: ['path'],
    },
    run({ path, maxChars }) {
      const abs = inRoot(path);
      const n = Math.max(200, Math.min(6000, Number(maxChars) || 1200));
      const text = readFileSync(abs, 'utf8');
      const masked = maskSensitive(text);
      return masked.length > n ? `${masked.slice(0, n)}\n...[还有 ${masked.length - n} 字符]` : masked;
    },
  },
  {
    name: 'probe_cmd',
    description:
      '跑一条只读的查看命令（node -v / npm -v / git status 之类），看输出。自检阶段不许改东西。' +
      '【Windows 上这个工具背后是 PowerShell】多条命令请用 ; 分隔，不要用 &&（PowerShell 不认）。',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
    run({ command }) {
      let cmd = String(command || '').trim();
      if (!cmd) throw new Error('命令是空的');
      /**
       * 【2026-10-28 修：`&&` 别再让主人看见那条提醒】
       *
       * 自检模型习惯了 bash，常写 `node --check x.mjs && echo ok`。
       * 这条命令在 PowerShell 下直接解析失败（退出码 1），它就把「语法错误」
       * 当成真的问题报给主人 —— 每次自检都顶着一条「语法检查整条没跑成」，
       * 而代码其实是好的。一条永远冤枉人的提醒，比没有提醒更坏。
       *
       * 这里替它翻译一下：Windows 上把 && 换成 ;。语义上不完全等价
       * （前一条失败也照跑后一条），但自检只是「看一眼」，这个差别不要紧。
       */
      if (platform() === 'win32') cmd = cmd.replace(/\s*&&\s*/g, '; ');
      // 自检只读：把明显会写盘/搞破坏的挡在外面
      const risky = /(^|[\s;&|])(rm|del|erase|rmdir|rd|move|mv|cp|copy|ren|rename|format|mkfs|shutdown|taskkill|kill|npm\s+(i|install|ci)|pip\s+install|winget\s+install)(\s|$)/i;
      if (risky.test(cmd) || /(>|>>)\s*\S/.test(cmd) || /git\s+(push|commit|reset|checkout|clean|merge)/i.test(cmd)) {
        throw new Error('自检是只读的，这条命令看起来会改东西，换一条只查看的');
      }
      try {
        const bin = platform() === 'win32' ? 'powershell.exe' : '/bin/sh';
        const args = platform() === 'win32' ? ['-NoProfile', '-Command', cmd] : ['-c', cmd];
        const out = execFileSync(bin, args, {
          cwd: ROOT,
          timeout: CMD_TIMEOUT,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return maskSensitive(String(out).trim()).slice(0, 3000) || '(没有输出)';
      } catch (e) {
        const o = `${e.stdout || ''}${e.stderr || ''}`.trim();
        return `退出码 ${e.status ?? '?'}${o ? '\n' + o.slice(0, 2000) : '\n' + String(e.message || e)}`;
      }
    },
  },
  {
    name: 'probe_port',
    description: '探一下本机某个端口是不是被占着（判断服务能不能起来）。',
    parameters: {
      type: 'object',
      properties: { port: { type: 'number' } },
      required: ['port'],
    },
    run({ port }) {
      const p = Number(port);
      if (!Number.isFinite(p) || p < 1 || p > 65535) throw new Error('端口不对');
      return new Promise((resolve) => {
        const sock = createConnection({ host: '127.0.0.1', port: p });
        const done = (msg) => {
          try { sock.destroy(); } catch {}
          resolve(msg);
        };
        sock.setTimeout(1500);
        sock.once('connect', () => done(`端口 ${p}：已被占用`));
        sock.once('timeout', () => done(`端口 ${p}：没连上（多半是空着）`));
        sock.once('error', (e) => done(`端口 ${p}：空着（${e.code || 'refused'}）`));
      });
    },
  },
];

const PROBE_SCHEMAS = PROBES.map((p) => ({
  type: 'function',
  function: { name: p.name, description: p.description, parameters: p.parameters },
}));

async function runProbe(name, rawArgs) {
  const probe = PROBES.find((p) => p.name === name);
  if (!probe) return `没有这个探针：${name}`;
  let args = {};
  try {
    args = typeof rawArgs === 'string' && rawArgs.trim() ? JSON.parse(rawArgs) : rawArgs || {};
  } catch {
    return '参数不是合法 JSON';
  }
  try {
    return await probe.run(args);
  } catch (e) {
    return String(e?.message || e);
  }
}

// ------------------------------------------------------------------ 现场快照

/** 纯本地读出来的现状，不调模型 */
export async function snapshot() {
  const has = (p) => existsSync(join(ROOT, p));
  const ls = (p) => {
    try {
      return readdirSync(join(ROOT, p));
    } catch {
      return [];
    }
  };
  let ep = null;
  try {
    ep = activeEndpoint();
  } catch {}

  /**
   * 【2026-10-28 修：原来这条提醒是假的】
   *
   * 以前这里写「没有 rules/rules.md（会用占位文案）」，主人每次来自检都被告知
   * 「规则层走占位文案」。实测不是：`loadRulesText()` 只被自检自己 import，
   * 系统提示根本不拼它（systemPrompt 5138 字里连「规则」两个字都没有），
   * 「占位文案」之说早就不成立 —— 一条永远修不掉的提醒，只会教人以后无视自检。
   *
   * 现在按真实情况说：文件在就报字数（全是注释等于空）；不在就直说没启用，不吓人。
   */
  let rulesInfo = '没有（这一版不读它，不影响）';
  if (has('rules/rules.md')) {
    try {
      const len = loadRulesText().length;
      rulesInfo = len > 0 ? `${len} 字` : '有，但全是注释 —— 等于空';
    } catch {
      rulesInfo = '有，但读不出来';
    }
  }

  // 真探一次端口（只连 TCP/TLS，不发请求，几百毫秒内出结果）。
  let probeLine = '（没配模型，跳过）';
  if (ep && ep.baseURL) {
    try {
      const pr = await probeEndpoint(ep.baseURL, { timeoutMs: 3000 });
      probeLine = pr.ok
        ? `通（${pr.host}:${pr.port}，${pr.ms}ms）`
        : `✗ 不通 —— ${pr.reason}（${pr.host}:${pr.port}）。这个地址上现在没有服务在应答，模型一调就会失败。`;
    } catch (e) {
      probeLine = `探不了（${String(e?.message ?? e)}）`;
    }
  }
  return [
    `项目目录：${ROOT}`,
    `node：${process.version}   平台：${platform()} ${release()}`,
    `CPU：${cpus().length} 核   内存：${(totalmem() / 1024 ** 3).toFixed(1)} GB`,
    '',
    '顶层：' + (ls('.').join(', ') || '(空)'),
    'src/：' + (ls('src').join(', ') || '(没有)'),
    'public/：' + (ls('public').join(', ') || '(没有)'),
    'electron/：' + (ls('electron').join(', ') || '(没有)'),
    'persona/：' + (ls('persona').join(', ') || '(没有)'),
    'rules/：' + (has('rules') ? ls('rules').join(', ') || '(空目录)' : '（没有这个目录）'),
    '',
    '.env：' + (has('.env') ? '在' : '没有'),
    '.state：' + (has('.state') ? `在（${ls('.state').length} 项）` : '没有'),
    'node_modules：' + (has('node_modules') ? '在' : '没有（没装依赖）'),
    '',
    ep
      ? `当前模型：${ep.model}   接口：${ep.baseURL}   key：${ep.apiKey ? '有' : '没有'}（来源：${ep.source}）`
      : '当前模型：读不出来',
    // 地址写得对不对，光看字符串看不出来 —— 必须真探一次。
    // 2026-10-26 教训：models.json 里有个指向 127.0.0.1:18599 的地址，
    // 字符串看着完全正常，实际那个端口上没有服务，主人看到的却是「连接一直断」。
    `接口可达性：${probeLine}`,
    `规则文件 rules/rules.md：${rulesInfo}`,
    `端口配置：${config.port}`,
    `单轮工具上限：${Number.isFinite(config.maxRounds) ? config.maxRounds : '不限'}`,
  ].join('\n');
}

// ------------------------------------------------------------------ 提示词

const SYSTEM = `你是这台机器上「小鱼Agent」项目的「自检员」。这次不是在跟主人聊天，任务只有一个：把现状查清楚，判断有没有真问题。

你有几个【只读】探针：
- probe_files：看文件/目录在不在、多大、何时改的
- probe_read：读文本文件（密钥会自动遮掉）
- probe_cmd：跑只读的查看命令（node -v、npm -v 之类）
- probe_port：探端口占没占

怎么干：
1. 先看下面给的现场快照，找出值得怀疑的地方（缺文件、没装依赖、key 没配、端口被占…）；
2. 用探针去核实，别靠猜。查到的事实才算数；
3. 判断一条是不是「真问题」，记住这几条：
   - 有些文件是主人故意删掉/自己整理过的，别把它当致命错误；
   - 只有「缺了就起不来 / 用不了」才算 fail；
   - 用着别扭但不挡事的，算 warn；
   - 查过没问题的就别写进结果，别凑数；
4. 你只负责「查 + 判断 + 给建议」，**不要改文件、不要装东西、不要发布**。要修就写进建议里，等主人来了再说。

**效率是硬要求，这条最要紧**：
- 整个自检**最多只能调 ${MAX_PROBES} 次探针**（超出的调用会被直接丢掉，你什么都拿不到）；
- **一次只调一个探针**。一次甩四五个 = 把这轮预算一次烧光，然后你就再也查不了了；
- 预算用完会立刻逼你给结论。到那一步你还没查完也得给，所以先查最要紧的；
- **快照里已经写清楚的事实，不要再探针去验**。特别是：
  · 快照有「接口可达性：通（…ms）」这行，说明地址已经真探过了，**不要再 probe_port**；
  · 快照有「当前模型 / key：有」这行，**不要再读 .env**；
  · 快照已经列了 src/ 和顶层文件清单，**不要再 probe_files 去看这些**；
- 真正值得花探针的是快照里**没结论**的地方：比如某个文件明明该在却不在、某个目录该有却没有、进程数目对不上；
- 快照里看下来一切正常，那就**一次探针都不要调**，直接给结论。这是最理想的情况。

最后必须只回下面这个 JSON（不要 Markdown 代码块，不要多余的话）：

{"ok": true, "summary": "一句话说这台机器现在什么状态", "findings": [{"level": "fail|warn|ok", "name": "短标题", "detail": "查到的事实 + 为什么算问题", "fix": "建议怎么修（没有就留空字符串）"}]}

findings 只写你真查过的。全都正常就给一条 level=ok 的。`;

/**
 * 从模型的回复里把 JSON 抠出来。
 *
 * 模型不听话是常态，实测会出现的几种：
 *   1. 规规矩矩的纯 JSON
 *   2. 包在 ```json ... ``` 里
 *   3. 前后带一段「好的，我来汇报：」
 *   4. 中文引号、单引号（JSON.parse 直接挂）
 *   5. 末尾多一个逗号
 *   6. 干脆没给 JSON，只给一段话
 * 这里逐级往下退，退到底还不行就返回 null，让调用方当「这次没结论」处理。
 */
/**
 * 模型没按 findings 格式回话时，尽量从它自己那套结构里把「查到了什么」捞出来。
 *
 * 见过的形状（都是同一个模型自称更清楚时写的）：
 *   { status, machine, verified: [...], issues_found: [...], not_checked: [...], next_steps: [...] }
 *   { ok, checks: [{name, result, note}], problems: [...] }
 *   { summary, items: [...] }
 * 捞不出来就返回 null，让上层照旧追问。
 *
 * @param {object} o 解析出来的对象
 * @returns {Array|null} items 或 null
 */
/**
 * 把一条「模型认为的发现」归一成 {id,name,level,detail,fix}。
 *
 * 2026-10-26 实测的大坑：提示词里明明写着 name/level/detail/fix，
 * 模型**真的**回了 findings 数组，但每条的字段是
 *   { severity: "high", area: "rules", fact: "…", evidence: "…", fix: "…" }
 * 原来代码 `.filter(f => f && f.name)` 直接把 7 条全过滤掉了，
 * 于是界面上「有 summary、下面一条没有」，看起来像自检没跑成。
 * 所以这里按**语义**认字段，不认名字。
 *
 * @param {any} f
 * @param {number} i
 * @returns {object|null}
 */
function normFinding(f, i) {
  if (!f) return null;
  if (typeof f === 'string') {
    const t = f.trim();
    return t ? { id: 'ai-' + i, name: '发现', level: 'warn', detail: t.slice(0, 600), fix: '' } : null;
  }
  if (typeof f !== 'object') return null;

  const pick = (...keys) => {
    for (const k of keys) {
      const v = f[k];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number') return String(v);
    }
    return '';
  };

  const title = pick('name', 'title', 'area', 'topic', 'subject', 'item', 'check', 'kind');
  const body = pick('detail', 'description', 'desc', 'fact', 'note', 'message', 'msg', 'text', 'result', 'finding', 'evidence', 'problem', 'issue');
  const fix = pick('fix', 'suggestion', 'advice', 'remedy', 'recommend', 'action');
  const lvRaw = pick('level', 'severity', 'status', 'result', 'grade', 'priority');

  // severity: high/medium/low 也要能认；中文也认
  let level = 'warn';
  if (/^(ok|pass|good|fine|正常|通过)/i.test(lvRaw)) level = 'ok';
  else if (/fail|fatal|critical|blocker|严重|致命|错误|失败|不可用/i.test(lvRaw)) level = 'fail';
  else if (/^(warn|warning|medium|low|minor|注意|提醒|警告)/i.test(lvRaw)) level = 'warn';
  // high 当成 fail 太重，但也不能当 ok —— 留在 warn
  if (!title && !body) return null;

  // detail 里把 evidence 也带上，别丢信息
  const evidence = pick('evidence', 'proof', 'why');
  const detail = [body, evidence && evidence !== body ? '依据：' + evidence : ''].filter(Boolean).join('\n').slice(0, 600);

  return {
    id: 'ai-' + i,
    name: (title || body || '发现').slice(0, 60),
    level,
    detail: detail || (title ? title : ''),
    fix: fix.slice(0, 400),
  };
}

function adaptLooseFindings(o) {
  const out = [];
  const push = (level, name, detail, fix = '') => {
    const n = String(name ?? '').trim();
    if (!n) return;
    out.push({
      id: 'ai-' + out.length,
      name: n.slice(0, 60),
      level: ['fail', 'warn', 'ok'].includes(level) ? level : 'warn',
      detail: String(detail ?? '').slice(0, 600),
      fix: String(fix ?? '').slice(0, 400),
    });
  };
  const arr = (v) => (Array.isArray(v) ? v : []);
  const txt = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? JSON.stringify(v).slice(0, 300) : '');

  // 「查过没问题的」
  for (const v of arr(o.verified).concat(arr(o.checks), arr(o.items))) {
    if (typeof v === 'string') push('ok', '已确认', v);
    else if (v && typeof v === 'object') {
      const lv = /fail|error|错|失败/i.test(txt(v.level) + txt(v.result)) ? 'warn' : 'ok';
      push(lv, v.name ?? v.check ?? '已确认', txt(v.detail ?? v.note ?? v.result));
    }
  }

  // 「发现的问题」—— 一律 warn 起步；明确说 fail 才算 fail
  // 注意：**不要**把 o.findings 放进来 —— 那是标准格式，主循环会自己处理，
  // 放进来会让「有 findings 但字段残缺」的回复被这套兜底逻辑抢走。
  for (const src of [arr(o.issues_found), arr(o.problems), arr(o.issues)]) {
    for (const v of src) {
      if (typeof v === 'string') push('warn', '发现问题', v);
      else if (v && typeof v === 'object') {
        const lv = /fail|fatal|严重|致命/i.test(txt(v.level) + txt(v.severity)) ? 'fail' : 'warn';
        push(lv, v.name ?? v.title ?? '发现问题', txt(v.detail ?? v.desc ?? v.description), txt(v.fix ?? v.suggestion));
      }
    }
  }

  // 「还没查的」也值得记一笔，但只是提醒
  for (const v of arr(o.not_checked)) push('warn', '未验证', typeof v === 'string' ? v : txt(v));

  return out.length ? out : null;
}

function parseJsonReply(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;

  // 1) 有代码块就先剥出来；可能不止一个，从后往前试（模型习惯把结论放最后）
  const fences = [...raw.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((m) => m[1]);
  const candidates = [...fences, raw];

  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    let body = c.slice(start, end + 1);

    const tries = [
      () => JSON.parse(body),
      // 中文引号 / 单引号当字符串定界符的，先换成普通双引号（只换紧贴冒号或逗号的，别误伤正文）
      () => JSON.parse(body.replace(/[“”]/g, '"')),
      // 末尾多余逗号
      () => JSON.parse(body.replace(/,\s*([}\]])/g, '$1')),
      () => JSON.parse(body.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, '$1')),
      // 单引号当定界符（简单粗暴地把 'x' 换成 "x"，只在双侧成对时生效）
      () => JSON.parse(body.replace(/'([^'\\]*)'/g, '"$1"')),
    ];
    for (const t of tries) {
      try {
        const v = t();
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      } catch {}
    }
  }
  return null;
}

/**
 * 跑一轮 AI 自检。
 * @param {object} [opts]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{items:Array, summary:string, transcript?:Array, skipped?:string, error?:string}>}
 */
export async function runAiSelfCheck(opts = {}) {
  const started = Date.now();
  const transcript = [];

  let ep = null;
  try {
    ep = activeEndpoint();
  } catch {}
  if (!ep || !ep.apiKey) {
    return { items: [], summary: '还没配模型，AI 自检这次跳过', skipped: 'no-model' };
  }

  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `这是这台机器现在的现场快照：\n\n${await snapshot()}\n\n开始查吧，该调的探针你自己调。` },
  ];

  const deadline = started + TOTAL_TIMEOUT;

  // 格式不对时只补问一次，别为了漂亮格式反复烧 token
  let askedAgain = false;

  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (opts.signal?.aborted) throw new Error('被中止了');
      if (Date.now() > deadline) throw new Error('自检超时');

      // 最后一轮不再给工具：逼它把已有的发现收成结论，别又跑去查。
      // 探针预算用完也当最后一轮处理 —— 查够了，给结论。
      const isLast = round === MAX_ROUNDS - 1 || transcript.length >= MAX_PROBES;
      if (isLast) {
        messages.push({
          role: 'user',
          content: '轮数用完了。现在**立刻**按格式给 JSON 结论，不要再调探针。查到的写，没查的别提。',
        });
      }
      const res = await chat({ messages, tools: isLast ? undefined : PROBE_SCHEMAS, signal: opts.signal });
      const msg = res?.choices?.[0]?.message ?? {};
      const toolCalls = msg.tool_calls ?? [];

      if (toolCalls.length) {
        const normalized = toolCalls.map((tc, i) => ({
          id: tc.id || `probe_${round}_${i}`,
          type: 'function',
          function: { name: tc.function?.name, arguments: tc.function?.arguments || '{}' },
        }));
        messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: normalized });
        for (const tc of normalized) {
          // 预算用完就别再查了，剩下的工具调用直接丢掉（模型一次甩 5 个是常态）
          if (transcript.length >= MAX_PROBES) break;
          const out = await runProbe(tc.function.name, tc.function.arguments);
          transcript.push({ probe: tc.function.name, args: tc.function.arguments, out: String(out).slice(0, 400) });
          messages.push({ role: 'tool', tool_call_id: tc.id, content: String(out) });
        }
        continue;
      }

      const parsed = parseJsonReply(msg.content);

      // 2026-10-26 实测：模型有一半的机会不回 findings，而是自己发明一套结构，
      // 比如 {status, machine, verified[], issues_found[], not_checked[], next_steps[]}。
      // 原来的写法是「没 findings 就当格式错，追问一次」，代价是白烧一整轮，
      // 而且预算紧的时候追问那轮根本轮不到，于是 items 直接是空的 —— 界面上
      // 明明有一句像样的 summary，底下却一条都没有。
      // 现在先别追问，看看能不能从它自己那套结构里把材料捞出来。
      const adapted = parsed && !Array.isArray(parsed.findings) ? adaptLooseFindings(parsed) : null;
      if (adapted && adapted.length) {
        return {
          items: adapted,
          summary: String(parsed.summary ?? parsed.verdict ?? parsed.conclusion ?? '').slice(0, 300),
          transcript,
        };
      }

      if (parsed && Array.isArray(parsed.findings)) {
        // 别指望字段名就叫 name/level/detail —— 见 normFinding 里的说明
        const items = parsed.findings.map((f, i) => normFinding(f, i)).filter(Boolean);
        if (items.length) {
          return { items, summary: String(parsed.summary ?? '').slice(0, 300), ok: parsed.ok !== false, transcript };
        }
      }

      // 没按格式来：先试一次「再问一句要 JSON」——比直接把一段话当结论靠谱得多，
      // 但也只多问这一次，不为了漂亮格式去烧 token。
      if (!askedAgain) {
        askedAgain = true;
        messages.push({ role: 'assistant', content: String(msg.content ?? '') });
        messages.push({
          role: 'user',
          content: '格式不对。只要那个 JSON：{"findings":[{"name":"…","level":"ok|warn|fail","detail":"…","fix":"…"}],"summary":"…"}。不要代码块，不要解释。',
        });
        continue;
      }

      return {
        items: [{ id: 'ai-0', name: '自检结论', level: 'warn', detail: String(msg.content ?? '').slice(0, 500), fix: '' }],
        summary: String(msg.content ?? '').slice(0, 200),
        transcript,
      };
    }
    throw new Error('问了太多轮还没给结论');
  } catch (err) {
    const why = String(err?.message ?? err);
    return {
      items: [{ id: 'ai-error', name: 'AI 自检没跑完', level: 'warn', detail: why, fix: '多半是网络或模型接口的问题；下次启动会再试，不影响使用' }],
      summary: `AI 自检没跑完：${why}`,
      error: why,
      transcript,
    };
  }
}
