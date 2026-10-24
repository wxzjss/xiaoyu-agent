// 小鱼的嗓子：让主人亲耳听她说话。
//
// 开关在【功能】面板（features.json 的 ttsVoice，默认开），这里只存「用哪一档」。
//
// 四档声音，都是真跑出来过的：
//   xiaoyu_144342  —— v2 念法（分片 + 不规则停顿），活泼甜，基线版
//   v4_nuo         —— v2 念法 + 音色抬高放慢，最软最糯
//   v4_tian        —— 同上甜档，稍快一点，甜但没那么嫩
//   v6_a           —— 按短语整段念，字跟字连得最顺，不卡顿
//
// 合成交给 python（本机 pythoncore 环境装了 edge-tts），时间轴和后期交给 ffmpeg。
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join, isAbsolute, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.mjs';

// 嵌入式语音引擎（可选）：主人第一次点「试听」时才装，装在 <数据目录>/runtime 下。
// 装了就用它，没装就退回本机 python —— 开发机上一直都是后者，所以这里只是多一个候选。
import { bundledPython } from './voice-runtime.mjs';

const ROOT = config.root;
import { getEnabledMap } from './features.mjs';

const STATE = join(config.dataDir, '.state');
const FILE = join(STATE, 'tts.json');

/** 四档声音。script 指向程序目录里的合成脚本，args 是给脚本的参数。 */
export const VOICES = [
  {
    id: 'xiaoyu_144342',
    name: '活泼甜',
    desc: '分片念 + 不规则停顿，句尾轻轻上扬。基线版，最稳。',
    script: join(ROOT, 'talk.py'),
    args: ['--mood', '甜'],
  },
  {
    id: 'v4_nuo',
    name: '软糯（最软）',
    desc: '音调抬高、语速放慢，字跟字黏在一起。最像小女孩。',
    script: join(ROOT, 'voice4.py'),
    args: ['--mood', '糯'],
  },
  {
    id: 'v4_tian',
    name: '软糯（偏甜）',
    desc: '糯档但没那么嫩，稍快一点，日常说话最顺耳。',
    script: join(ROOT, 'voice4.py'),
    args: ['--mood', '甜'],
  },
  {
    id: 'v6_a',
    name: '连读自然',
    desc: '按短语整段念，字与字之间不留缝，只在标点处喘气。不卡顿。',
    script: join(ROOT, 'voice6.py'),
    args: [],
  },
  {
    // 主人亲耳听了一圈挑中的就是这个：晓伊嗓子、语速 -18%、音高 +26Hz。
    // 比「糯」档更慢更高，奶味最足，但不是一个字一个字蹦，还在整句念。
    id: 'v4_ji_ruan',
    name: '极软（晓伊）',
    desc: '晓伊嗓子压低放慢、音调抬高，奶味最足。主人亲耳挑的那一档。',
    script: join(ROOT, 'voice4.py'),
    args: ['--mood', '极软'],
  },
];

const BY_ID = new Map(VOICES.map((v) => [v.id, v]));

// 出厂默认：主人拍板「默认是最软」—— v4_nuo（软糯·最软）。
// 原来是 v4_tian（软糯·偏甜）。别又改回去。
// 主人拍板：出厂默认 = v4_nuo（软糯·最软）。
// v4_ji_ruan（极软·晓伊）是后来加的档，很软，但不是默认 —— 别再把默认改回它。
export const DEFAULTS = { voice: 'v4_nuo' };

export function readTTS() {
  let raw = {};
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'));
    if (j && typeof j === 'object' && !Array.isArray(j)) raw = j;
  } catch {}
  const v = typeof raw.voice === 'string' ? raw.voice.trim() : '';
  return { voice: BY_ID.has(v) ? v : DEFAULTS.voice };
}

export function writeTTS(patch) {
  const cur = readTTS();
  const next = { ...cur };
  const p = patch && typeof patch === 'object' ? patch : {};
  if ('voice' in p) {
    const v = String(p.voice ?? '').trim();
    if (!BY_ID.has(v)) throw Object.assign(new Error(`没有这一档声音：${v || '(空)'}`), { status: 400 });
    next.voice = v;
  }
  if (!existsSync(STATE)) {
    try {
      mkdirSync(STATE, { recursive: true });
    } catch {}
  }
  writeFileSync(FILE, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/**
 * 本机 python 在哪（给界面看的那个"首选"）。
 * 系统里 WindowsApps 那个 python.exe 是空壳（跑起来 exit 9009），
 * 所以优先用 pythoncore 那个真解释器；找不到再退回 PATH。
 */
export function pythonExe() {
  const cands = pythonCandidates();
  return cands[0] || 'python';
}

/**
 * python 候选列表，按可信度排。
 * 注意：路径统一转成正斜杠。Windows 上带反斜杠的串在 spawn 里会被当成转义，
 * 结果就是 ENOENT / exit 9009 —— 这个坑踩过一次了。
 */
export function pythonCandidates() {
  const lad = process.env.LOCALAPPDATA || '';
  const raw = [
    // 自己装的那份最可信：它就是为这台机器配好的，import edge_tts 一定有用
    bundledPython(),
    process.env.XIAOYU_PYTHON || '',
    lad ? join(lad, 'Python', 'bin', 'python.exe') : '',
    lad ? join(lad, 'Python', 'pythoncore-3.14-64', 'python.exe') : '',
    'python',
  ].filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const p of raw) {
    const s = p.includes(sep) || /[\\/]/.test(p) ? p.split(sep).join('/').split('\\').join('/') : p;
    if (seen.has(s)) continue;
    seen.add(s);
    // 带路径的要确认存在；光一个 "python" 交给系统去找
    if (/[\\/]/.test(s) && !existsSync(s)) continue;
    out.push(s);
  }
  return out.length ? out : ['python'];
}

/**
 * 说话脚本的真实路径。
 * 麻烦之处：装好的程序里 src/ 和 scripts/ 都压在 app.asar 里，
 * 而 python 不认 asar（它不是 Electron，没有那层补丁），
 * 所以脚本必须落成一个能直接读的普通文件才跑得起来。
 * 做法：先找普通文件；找不到就从 asar 里读出来，释放到数据目录下的 scripts/voice/。
 */
export function scriptPath(script) {
  const name = isAbsolute(script) ? script.split(/[\\/]/).pop() : script;

  // 1) 已经是普通文件、直接能用
  const direct = [
    isAbsolute(script) ? script : '',
    join(ROOT, 'scripts', 'voice', name),
    join(config.dataDir, 'scripts', 'voice', name),
    join(process.cwd(), 'scripts', 'voice', name),
    join(config.dataDir, name),
  ].filter(Boolean);
  for (const p of direct) {
    try {
      if (existsSync(p) && !p.includes('.asar' + sep)) {
        const st = statSync(p);
        if (st.isFile() && st.size > 0) return p;
      }
    } catch {}
  }

  // 2) 从 asar 包里释放一份出来
  const out = join(config.dataDir, 'scripts', 'voice', name);
  const inAsar = [
    join(ROOT, 'scripts', 'voice', name),
    join(ROOT, name),
    join(ROOT, 'scripts', name),
  ];
  for (const src of inAsar) {
    try {
      const buf = readFileSync(src); // node 认 asar 路径（Electron 环境里）
      if (!buf || !buf.length) continue;
      mkdirSync(join(config.dataDir, 'scripts', 'voice'), { recursive: true });
      writeFileSync(out, buf);
      if (existsSync(out) && statSync(out).size > 0) return out;
    } catch {}
  }
  return null;
}

/** 把一次 spawn 包成 promise：拿到 OK| 就算成功，退出码 0 且文件在也算 */
function runOnce(exe, args, cwd, out) {
  return new Promise((done, fail) => {
    let err = '';
    let finished = false;
    let p;
    try {
      p = spawn(exe, args, { cwd, windowsHide: true, shell: false });
    } catch (e) {
      return fail(new Error(String(e?.message ?? e)));
    }
    p.stdout?.on('data', (d) => {
      const s = String(d);
      if (!finished && s.includes('OK|')) {
        finished = true;
        done(out);
      }
    });
    p.stderr?.on('data', (d) => {
      err += String(d);
    });
    p.on('error', (e) => {
      if (!finished) fail(new Error(String(e?.message ?? e)));
    });
    p.on('close', (code) => {
      if (finished) return;
      try {
        if (existsSync(out)) {
          finished = true;
          return done(out);
        }
      } catch {}
      fail(new Error(`退出码 ${code}${err ? '：' + err.slice(-300) : ''}`));
    });
  });
}

/**
 * 念一段话，返回生成的 mp3 绝对路径。
 * 故意不给超时：模型可能给一整段，慢慢念就是了，干掉它反而留半截文件。
 */
export async function speak(text, voiceId) {
  const said = String(text ?? '').trim();
  if (!said) throw Object.assign(new Error('没有要念的话'), { status: 400 });
  if (said.length > 1200) throw Object.assign(new Error('一次最多念 1200 字，太长了'), { status: 400 });

  const voice = BY_ID.get(voiceId) || BY_ID.get(readTTS().voice) || VOICES[0];
  const script = scriptPath(voice.script);
  if (!script) throw Object.assign(new Error(`找不到合成脚本 ${voice.script}`), { status: 500 });

  const outDir = join(config.dataDir, 'voice');
  try {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  } catch {}

  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const out = join(outDir, `say_${voice.id}_${stamp}_${Math.random().toString(36).slice(2, 6)}.mp3`);

  const args = [script, said, ...voice.args, '--out', out];
  const tried = [];
  const cands = pythonCandidates();
  let lastErr = null;

  // 一个解释器不行就换下一个：9009 / ENOENT 都是商店空壳干的好事
  for (const py of cands) {
    tried.push(py);
    try {
      // cwd 必须是真目录：config.root 在装好的程序里是 app.asar 这个文件，拿它当工作目录 spawn 必定 ENOENT
      return await runOnce(py, args, config.dataDir, out);
    } catch (e) {
      lastErr = e;
    }
  }
  const why = String(lastErr?.message ?? lastErr ?? '未知');
  throw Object.assign(new Error('合成没成：' + why + '（试过：' + tried.join(' , ') + '）'), { status: 500 });
}

/** 界面要的一份状态：开关 + 四档声音 + 现在选的是哪档。 */
export function getTTSState() {
  const enabled = Boolean(getEnabledMap().ttsVoice);
  const { voice } = readTTS();
  return {
    enabled,
    voice,
    defaults: DEFAULTS,
    voices: VOICES.map((v) => ({ id: v.id, name: v.name, desc: v.desc })),
  };
}
