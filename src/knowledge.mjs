/**
 * 知识库（2026-11-12 主人钦点）。
 *
 * 【要解决什么】
 * 小鱼Agent 从零到现在踩了太多坑——作用域抓错、双账本打架、乐观气泡错位、
 * 看门狗误杀……这些教训都散落在代码注释和当天的日志里，新会话（或新机器上的
 * 朋友）从零开始干活的活，等于把这些坑重新踩一遍。
 *
 * 知识库就是把这些「弯路」固化成一张张「知识卡」：像岁月史书一样全局共享，
 * 供所有会话的智能体浏览学习；界面上是一座书架，每张卡是一本「书」。
 *
 * 存储：.state/knowledge/cards.json（一张卡一条记录，v1 结构）。
 * 首次初始化时把内置的「踩坑经验」默认卡写进去（可编辑可删除，就是普通卡）。
 *
 * 所有写盘 try/catch 吞掉（跟 resume.mjs 同一规矩：不能拖垮正常对话）。
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from './config.mjs';

const DIR = join(config.dataDir, '.state', 'knowledge');
const FILE = join(DIR, 'cards.json');

/** 卡结构：{ id, title, author, content, tags, createdAt, updatedAt } */
const SCHEMA_VERSION = 1;

/**
 * 内置默认知识卡：重头做小鱼Agent 会绕大弯路的坑，鲸鱼娘一条条实测过。
 * 只在 cards.json 还不存在时写入一次；写进去之后它们就是普通卡，
 * 主人改了删了都随他，代码不会再「恢复出厂」（知识库不是设置页）。
 */
const DEFAULT_CARDS = [
  {
    id: 'kb-seed-001',
    title: '小鱼Agent 架构速览（新会话先读这张）',
    author: '鲸鱼娘',
    tags: ['架构', '必读'],
    content: [
      '小鱼Agent 是 Electron 桌面应用：electron/main.cjs 是主进程（窗口/托盘/重启），src/server.mjs 是内嵌服务（8788 端口，路由+轮次+直播），src/agent.mjs 是智能体循环（取信箱→调模型→执行工具），src/tools.mjs 是工具注册表，src-ui/ 是 React 前端（构建产物 public/ui/log.bundle.js），旧 DOM 路径在 public/index.html 内联脚本里（两套并存）。',
      '',
      '关键目录：会话存 <数据根>/.state/sessions/*.json（一条消息一 at 时间戳）；诊断日志 .state/diag.log（排查问题的第一站）；运行实例在 %APPDATA%\\小鱼Agent\\data\\（打包态），开发态源码在 D:\\小鱼Agent。',
      '',
      '改前端要 npm run build:ui 重打 bundle；改 src/ 要 npm run sync 同步到运行实例并重启才生效。改完必须跑 scripts/check-*.mjs 站岗（每个修复都配了站岗，红=回归）。',
    ].join('\n'),
  },
  {
    id: 'kb-seed-002',
    title: '排查问题的标准套路（先看 diag.log 时间线）',
    author: '鲸鱼娘',
    tags: ['排查', '必读'],
    content: [
      '查任何「她停了/没回/渲染怪/改不了删不了」的问题，第一步先翻 .state/diag.log 的完整时间线——502、自动接回、重启、插话（interject-steered）、额度（retry-budget-reset / stuck-retry-give-up）这些关键事件全在里面，按时间定位到出事那一刻再去看代码。',
      '',
      '第二条铁律：找问题不许猜，必须真看日志/真读文件再下结论。上来就读源码从零挖是最慢的路。',
      '',
      '第三条：诊断「前端没渲染」时先分清三套账——会话历史（.state/sessions，服务端真相）、直播缓存（liveLogs 的 events+items，本轮实时）、前端清单（照 items 画）。events 在涨 items 不动=渲染断了；历史有屏幕没有=补拉没触发。',
    ].join('\n'),
  },
  {
    id: 'kb-seed-003',
    title: '直播缓存账规矩（必须走 appendLiveCache 一套）',
    author: '鲸鱼娘',
    tags: ['架构', '踩坑'],
    content: [
      'server.mjs 里凡是「往 live 缓存写事件」的路径必须走同一个函数 appendLiveCache（合并/seq+rev 游标/items 清单/封顶 notice/压薄全在里面）。主轮、排队轮（startQueuedTurn）、续跑轮（resumeInterruptedTurn）三处 send 都用它。',
      '',
      '新增 send/写缓存路径的做法：①只调 appendLiveCache，禁止再手写 live.events.push——只写 events 不写 items 的话，前端照 items 画，接续轮说什么屏幕都看不见；②禁止「每处各写一份」——一处改了别处漏，两边账永远对不齐。',
      '',
      '乐观气泡（pushPendingUser）的孤儿账有两规矩——同文落盘就收、≥2 条别的 user 未对账也收。谁动这套规矩先跑 check-tool-start-pair 和 check-live-items-parity。',
    ].join('\n'),
  },
  {
    id: 'kb-seed-004',
    title: '并行会话协作规矩（提交前必核对）',
    author: '鲸鱼娘',
    tags: ['协作', '踩坑'],
    content: [
      '小鱼主会话和小鲸鱼会话可能同时在改同一个仓库。规矩：',
      '',
      '①改重要默认值必须在站岗里加断言钉死——谁改回去回归直接红，不靠自觉；',
      '②提交前 git status/diff 逐文件核对归属，只 add 自己的文件；',
      '③发现别人改了同一文件先看时间戳，文件安静（5 次采样无变化）再动手；',
      '④别人 add -A 把你的工作区改动一起提交了，用 git show 逐项核对内容无损即可，不用回滚；核对出损了才要补提交。',
    ].join('\n'),
  },
  {
    id: 'kb-seed-005',
    title: '上下文压缩与消息定位（时间戳不会漂）',
    author: '鲸鱼娘',
    tags: ['架构', '踩坑'],
    content: [
      '上下文压缩折叠会把会话 messages 数组折短，**数组下标会漂、时间戳（at/_at）不会**。改/删消息一律按 msgAt 定位（locateByMsgAt：at+_at ±2ms 容差，同毫秒取离提示下标近的），带 msgAt 对不上直接报「收进摘要」，绝不退回旧下标——旧下标指向的早就是别的消息，改了就是改错人。',
      '',
      '历史里 _sysNote=true 的消息是程序递的背景（重启提示/团队汇报），不算「主人说的话」：lastUserLine 要跳过它（否则续跑提示套娃），插话额度重置也不认它。',
    ].join('\n'),
  },
  {
    id: 'kb-seed-006',
    title: '续跑机制（resume.json 的账怎么记怎么清）',
    author: '鲸鱼娘',
    tags: ['架构', '机制'],
    content: [
      'resume.json（v2 结构，items 数组）记录「断在半路的轮」。记账点：每条轮路径**开局**就 markInterrupted（autoResume:true，taskLine=主人原话）；清账点：正常跑完/主人点停止（ac.abort reason=stop）→ dropInterrupted；quit/handoff 不清（退出路径会覆盖记更全的账）——硬杀/崩溃残留的账就是开机要自动续的那轮。',
      '',
      '续跑执行 resumeInterruptedTurn：peek 不删（闸门没过不能把机会删了），真跑完才 dropInterrupted。开机 boot-resume-go → resume-enter → resume-go:intent。看门狗已停用（主人钦定不掐，误杀实锤），真实故障由 llm 层超时+错误接回兜底（STUCK_RETRY_MAX=10，give-up 落系统提示，主人亲自发消息清账重置额度）。',
      '',
      '注意：重启测续跑要等 resume-done 日志出现才算跑完（LLM 调用中会话文件几分钟不落盘是正常的，别误判「静默失败」）。',
    ].join('\n'),
  },
  {
    id: 'kb-seed-007',
    title: '插话/发送缓冲/信箱递话三套通道',
    author: '鲸鱼娘',
    tags: ['机制'],
    content: [
      '主人的消息三条通道：①她没在跑→/api/chat 开新轮；②她在跑→/api/interject→steer 进 inbox steps 槽，agent 循环下一步取走织入（不打断手头的活）；③发送缓冲（功能页 sendBuffer 卡）→ 前端缓冲窗攒一批，到点 extraMessages 一次性发（窗内不算插话），到点她还在跑就整包合成一条走插话。',
      '',
      '会话间递话（ask_peer）：信落 peer.mjs 信箱 + deliverMailNow 即时递送——在跑→steer 带 _sysNote（仅AI可见系统提示，不打主人署名）+直播 notice 条；没在跑→wakePeer 叫醒。_sysNote=true 的消息 agent 落成 context+_sysNote。',
      '',
      '前端分派：回车=直接发（busy 则 interject）；【发送】按钮=sendBuffered 缓冲窗；金框 queueFromInput 待发送机制已死（调用方清零）。',
    ].join('\n'),
  },
  {
    id: 'kb-seed-008',
    title: 'Windows 打包/重启的坑（explorer 委托启动）',
    author: '鲸鱼娘',
    tags: ['运维', '踩坑'],
    content: [
      '①直接 Start-Process 启动 小鱼Agent.exe 会闪退（ExitCode=0），要用 explorer.exe 委托启动（模拟双击）。',
      '',
      '②杀进程用 taskkill /PID <主进程> /T /F（Electron 进程树，只杀主进程留一堆子进程）。',
      '',
      '③mac 打包（npm run pack:mac）在 Windows 上打不出来——electron-builder 硬性限制「Build for macOS is supported only on macOS」，连 zip 都拦。朋友要用 mac 版只能 clone 源码 npm start。',
      '',
      '④npm run sync 只同步代码到运行实例；真正发版要 npm run pack:exe 重打 asar。',
      '',
      '⑤e2e/隔离实例用 scripts/_test-instance.mjs（自带 BASE 隔离+XY_REQUIRE_ISOLATED 双保险，防测试污染主人真身会话）。重启服务前查会话空闲（90 秒以上才动手），掐了干一半的活就是事故。',
    ].join('\n'),
  },
];

function ensureDir() {
  try { mkdirSync(DIR, { recursive: true }); } catch {}
}

function normalizeCard(raw) {
  const now = Date.now();
  const c = (raw && typeof raw === 'object') ? raw : {};
  const title = String(c.title ?? '').trim();
  if (!title) return null;
  const content = String(c.content ?? '');
  return {
    id: String(c.id ?? '').trim() || ('kb-' + now.toString(36) + randomBytes(3).toString('hex')),
    title: title.slice(0, 120),
    author: String(c.author ?? '').trim().slice(0, 60) || '佚名',
    tags: Array.isArray(c.tags) ? c.tags.map((t) => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 6) : [],
    content,
    createdAt: Number.isFinite(Number(c.createdAt)) ? Number(c.createdAt) : now,
    updatedAt: Number.isFinite(Number(c.updatedAt)) ? Number(c.updatedAt) : now,
  };
}

function loadAll() {
  try {
    if (!existsSync(FILE)) return null;   // 没建过 → 走 seed
    const d = JSON.parse(readFileSync(FILE, 'utf8'));
    const list = Array.isArray(d?.cards) ? d.cards : [];
    return list.map((c) => normalizeCard(c)).filter(Boolean);
  } catch {
    return [];
  }
}

function saveAll(list) {
  try {
    ensureDir();
    writeFileSync(FILE, JSON.stringify({ v: SCHEMA_VERSION, cards: list }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 首次初始化：写入内置踩坑卡（只在文件不存在时） */
export function initKnowledge() {
  try {
    if (existsSync(FILE)) return;
    const cards = DEFAULT_CARDS.map((c) => normalizeCard(c)).filter(Boolean);
    saveAll(cards);
  } catch {}
}

/** 全部卡（按更新时间新→旧） */
export function listCards() {
  let cards = loadAll();
  if (cards === null) { initKnowledge(); cards = loadAll() || []; }
  return cards.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

export function getCard(id) {
  return listCards().find((c) => c.id === String(id ?? '')) || null;
}

/** 新建/更新。带 id 且存在 → 更新（updatedAt 刷新）；否则新建。 */
export function saveCard({ id, title, author, content, tags }) {
  const cards = loadAll() || [];
  const now = Date.now();
  const nid = String(id ?? '').trim();
  const idx = nid ? cards.findIndex((c) => c.id === nid) : -1;
  if (idx >= 0) {
    const old = cards[idx];
    const upd = normalizeCard({
      ...old,
      title: title ?? old.title,
      author: author ?? old.author,
      content: content ?? old.content,
      tags: tags ?? old.tags,
      createdAt: old.createdAt,
      updatedAt: now,
    });
    if (!upd) return { ok: false, error: '标题不能为空' };
    cards[idx] = upd;
    saveAll(cards);
    return { ok: true, card: upd, created: false };
  }
  const c = normalizeCard({ title, author, content, tags, createdAt: now, updatedAt: now });
  if (!c) return { ok: false, error: '标题不能为空' };
  cards.unshift(c);
  saveAll(cards);
  return { ok: true, card: c, created: true };
}

export function deleteCard(id) {
  const cards = loadAll() || [];
  const i = cards.findIndex((c) => c.id === String(id ?? ''));
  if (i < 0) return { ok: false, error: '这张卡不存在（可能已经被删了）' };
  const [gone] = cards.splice(i, 1);
  saveAll(cards);
  return { ok: true, card: gone };
}

/**
 * 导入一批卡（导入文件 / 别处粘贴的 JSON）。
 * 规矩：同 id 覆盖（updatedAt 保留文件里较新的），其余追加；新卡 id 撞了老卡但内容不同 → 换新 id 追加。
 */
export function importCards(payload) {
  let incoming = payload;
  if (typeof payload === 'string') {
    try { incoming = JSON.parse(payload); } catch { return { ok: false, error: '这不是能认的 JSON' }; }
  }
  const rawList = Array.isArray(incoming) ? incoming
    : Array.isArray(incoming?.cards) ? incoming.cards : null;
  if (!rawList) return { ok: false, error: '没有找到卡（要 { "cards": [...] } 或数组）' };
  const cards = loadAll() || [];
  let added = 0, updated = 0;
  for (const raw of rawList) {
    const c = normalizeCard(raw);
    if (!c) continue;
    const i = cards.findIndex((x) => x.id === c.id);
    if (i >= 0) {
      if (cards[i].updatedAt >= c.updatedAt) continue;   // 本地较新，跳过
      cards[i] = c; updated++;
    } else {
      cards.unshift(c); added++;
    }
  }
  saveAll(cards);
  return { ok: true, added, updated };
}

/** 导出全部卡（导入导出同一格式，闭环） */
export function exportCards() {
  return { v: SCHEMA_VERSION, exportedAt: Date.now(), cards: listCards() };
}

/** 搜索：标题/内容/作者/标签都搜，命中的词越多排越前（给智能体用） */
export function searchCards(query, limit = 20) {
  const q = String(query ?? '').trim();
  const cards = listCards();
  if (!q) return cards.slice(0, limit);
  const terms = q.split(/\s+/).filter(Boolean);
  const scored = [];
  for (const c of cards) {
    const hay = (c.title + '\n' + c.content + '\n' + c.author + '\n' + (c.tags || []).join('\n')).toLowerCase();
    let score = 0;
    for (const t of terms) if (hay.includes(t.toLowerCase())) score++;
    if (score > 0) scored.push({ score, card: c });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((x) => x.card);
}

/** 给智能体的浏览文本：目录（标题+作者+标签）或单卡全文 */
export function digestForAgent(query, id, limit = 20) {
  if (id) {
    const c = getCard(id);
    if (!c) return '没有这张卡（id 不对，或者已经被删了）。先用不带 id 的方式列目录。';
    return `【${c.title}】作者：${c.author}${(c.tags || []).length ? '｜标签：' + c.tags.join('、') : ''}\n——\n${c.content}`;
  }
  const cards = searchCards(query, limit);
  if (!cards.length) return '知识库还没建，或者没有命中的卡。用 knowledge_save 建一张吧。';
  const lines = cards.map((c, i) => {
    const brief = c.content.replace(/\s+/g, ' ').slice(0, 80);
    return `${i + 1}. 【${c.title}】作者：${c.author}${(c.tags || []).length ? '｜' + c.tags.join('、') : ''}｜id=${c.id}\n   ${brief}${c.content.length > 80 ? '…' : ''}`;
  });
  return `知识库共 ${listCards().length} 张卡，命中 ${cards.length} 张：\n` + lines.join('\n')
    + '\n要看全文就用 knowledge_read 带 id 精读那一张。';
}
