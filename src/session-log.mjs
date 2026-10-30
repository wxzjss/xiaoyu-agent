/**
 * 会话日志导出（.zip）。
 *
 * 主人要的是 dsh 那个「下载日志」：把这次会话的原始记录 + 用到的附件打成一个压缩包，
 * 拿到手可以直接翻、能发给别人、出问题时也能拿去查。
 *
 * 包里装什么：
 *   session.json          这次会话的完整消息（含 system、隐藏的开场轮，一条不删）
 *   session.txt           同一份内容的可读版，肉眼看不用工具
 *   memory.md             这个会话的记忆本子（如果有）
 *   rewinds.json          回退记录（如果有）
 *   attachments/<名字>    这轮里引用过的图片 / 文件，按原样带上
 *   README.txt            包里的东西都是什么
 *
 * 压缩只用 Node 自带的 zlib：不引第三方库，离线也能跑。
 * zip 容器自己写（deflate + 中央目录），够标准，Windows 资源管理器、7-Zip、unzip 都认。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { config } from './config.mjs';
import { memoryPath } from './session-memory.mjs';
import { loadRewinds } from './rewind.mjs';

// ---------------------------------------------------------------- zip 容器

/** CRC32 查表（zip 每个文件都要带校验，浏览器 / 系统都拿它验完整性）。 */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 本地时间 → DOS 时间格式（zip 头里就是这套老格式）。 */
function dosTime(d) {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/**
 * 把一组 {name, data: Buffer} 打成 zip。
 * @param {Array<{name: string, data: Buffer}>} entries
 * @param {Date} [when] 所有条目共用的时间戳
 * @returns {Buffer}
 */
export function makeZip(entries, when = new Date()) {
  const { time, date } = dosTime(when);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const raw = e.data;
    const crc = crc32(raw);

    // 能压小的才压；已经很小的（比如 PNG）直接存，省得白费力气还变大
    const packed = deflateRawSync(raw, { level: 6 });
    const useDeflate = packed.length < raw.length;
    const body = useDeflate ? packed : raw;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);           // 需要解压的版本
    local.writeUInt16LE(0x0800, 6);       // 文件名是 UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);           // 没扩展字段
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);         // 打包程序版本
    central.writeUInt16LE(20, 6);         // 需要解压的版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);         // 扩展字段长度
    central.writeUInt16LE(0, 32);         // 注释长度
    central.writeUInt16LE(0, 34);         // 磁盘号
    central.writeUInt16LE(0, 36);         // 内部属性
    central.writeUInt32LE(0, 38);         // 外部属性
    central.writeUInt32LE(offset, 42);    // 本地头偏移
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuf, end]);
}

// ---------------------------------------------------------------- 内容

function safeName(s) {
  return String(s || 'x').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80) || 'x';
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 会话文件在哪（跟 server.mjs 里读写的是同一处）。 */
function sessionFile(id) {
  return join(config.dataDir, '.state', 'sessions', `${id}.json`);
}

/** 从某条消息里抠出它引用的附件路径。 */
function attachmentPathsOf(messages) {
  const out = new Set();
  for (const m of messages) {
    // 1) 前端存下来的结构：messages[i].attachments = [{path,name,kind}]
    if (Array.isArray(m.attachments)) {
      for (const a of m.attachments) {
        const p = typeof a === 'string' ? a : a && a.path;
        if (p) out.add(String(p));
      }
    }
    // 2) 工具读过 / 写过的产物也算（主人想看的往往就是这些）
    if (m && m.role === 'tool' && typeof m.content === 'string') {
      const re = /([A-Za-z]:\\[^\s"'<>|?*\n]+?\.(?:png|jpe?g|gif|webp|bmp|pdf|txt|md|json|csv|xlsx?|docx?|zip|mp4|mp3))/g;
      let g;
      while ((g = re.exec(m.content)) !== null) out.add(g[1]);
    }
  }
  return [...out];
}

/**
 * 造这次会话的日志包。
 * @param {{id: string, messages: Array, title?: string}} session
 * @returns {{ok: true, filename: string, buffer: Buffer, files: number, bytes: number} | {ok: false, error: string}}
 */
export function buildSessionLog(session) {
  if (!session || !session.id) return { ok: false, error: '没有会话 id' };
  if (!Array.isArray(session.messages)) return { ok: false, error: '这个会话没有消息' };

  const at = new Date();
  const title = safeName(session.title || session.id);
  const id = session.id;
  const entries = [];

  // ---- session.json：原始消息一条不删（隐藏的开场轮也在，方便排查） ----
  const payload = {
    format: 'xiaoyu-session-log',
    version: 1,
    exportedAt: at.toISOString(),
    sessionId: id,
    title: session.title || '',
    dataDir: config.dataDir,
    messageCount: session.messages.length,
    messages: session.messages,
  };
  entries.push({ name: 'session.json', data: Buffer.from(JSON.stringify(payload, null, 2), 'utf8') });

  // ---- session.txt：给人看的版本 ----
  const lines = [
    `会话：${session.title || '（没名字）'}`,
    `id：${id}`,
    `导出时间：${at.toLocaleString('zh-CN')}`,
    `消息数：${session.messages.length}`,
    ''.padEnd(60, '='),
    '',
  ];
  for (const m of session.messages) {
    const who = m.role === 'user' ? '主人' : m.role === 'assistant' ? '小鱼' : m.role === 'tool' ? '工具' : m.role;
    let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    if (m.toolName || m.name) text = `[${m.toolName || m.name}] ${text}`;
    lines.push(`---- ${who} ----`);
    lines.push(text || '（空）');
    lines.push('');
  }
  entries.push({ name: 'session.txt', data: Buffer.from(lines.join('\n'), 'utf8') });

  // ---- 记忆本子 ----
  const mp = (() => {
    try { return memoryPath(id); } catch { return null; }
  })();
  if (mp && existsSync(mp)) {
    entries.push({ name: 'memory.md', data: readFileSync(mp) });
  }

  // ---- 回退记录 ----
  try {
    const rw = loadRewinds(session);
    if (rw && rw.length) {
      entries.push({ name: 'rewinds.json', data: Buffer.from(JSON.stringify(rw, null, 2), 'utf8') });
    }
  } catch { /* 没回退功能就算了，不影响导出 */ }

  // ---- 附件 ----
  const seen = new Set();
  let n = 0;
  for (const p of attachmentPathsOf(session.messages)) {
    try {
      if (!existsSync(p)) continue;
      const st = statSync(p);
      if (!st.isFile() || st.size > 40 * 1024 * 1024) continue;
      let name = basename(p);
      if (seen.has(name)) name = `${n}-${name}`;
      seen.add(name);
      entries.push({ name: `attachments/${name}`, data: readFileSync(p) });
      n++;
    } catch { /* 读不了就跳过，别让一个附件把整个导出搞挂 */ }
  }

  // ---- 说明 ----
  const readme = [
    '小鱼Agent 会话日志',
    '',
    `会话：${session.title || '（没名字）'}`,
    `时间：${at.toLocaleString('zh-CN')}`,
    '',
    '包里有什么：',
    '  session.json   完整消息，程序读的版本（含系统提示和隐藏的开场轮，一条没删）',
    '  session.txt    同一份内容，用记事本直接看',
    '  memory.md      这个会话的记忆本子（如果这个会话有）',
    '  rewinds.json   回退记录（如果用过回退）',
    '  attachments/   聊天里用到的图片和文件（如果有）',
    '',
    '出问题要反馈的时候，把这个包发过去就够了。',
  ].join('\n');
  entries.push({ name: 'README.txt', data: Buffer.from(readme, 'utf8') });

  const buffer = makeZip(entries, at);
  return {
    ok: true,
    filename: `小鱼Agent-会话日志-${title}-${stamp(at)}.zip`,
    buffer,
    files: entries.length,
    bytes: buffer.length,
  };
}

/** 附件名取不到扩展名的兜底（导出时用不上，留着给别处复用）。 */
export function extOf(p) {
  return extname(String(p || '')).toLowerCase();
}
