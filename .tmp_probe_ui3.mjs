/**
 * 掏真代码来跑：把 index.html 里「回到最新」那套逻辑整段抠出来，
 * 配一套假 DOM，验各种情形下 badge 上写的是什么。
 */
import fs from 'node:fs';

const html = fs.readFileSync('D:/小鱼Agent/public/index.html', 'utf8');

function cut(name) {
  const i = html.indexOf('function ' + name);
  if (i < 0) throw new Error('找不到函数 ' + name);
  let depth = 0, started = false;
  for (let k = i; k < html.length; k++) {
    const ch = html[k];
    if (ch === '{') { depth++; started = true; }
    else if (ch === '}') { depth--; if (started && depth === 0) return html.slice(i, k + 1); }
  }
  throw new Error('括号没配平: ' + name);
}

const src = {
  toBottomEl: cut('toBottomEl'),
  really: cut('_reallyAtBottom'),
  paint: cut('paintToBottom'),
  bump: cut('bumpUnseen'),
  once: cut('_bumpOncePerSpeech'),
};

function makeEnv({ atBottom = false, unseen = 0, scrollTop = 0 } = {}) {
  const badge = { textContent: '', classList: { add() {}, remove() {}, toggle() {}, contains: () => false }, style: {} };
  const btn = {
    style: { display: '' },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    querySelector: () => badge,
  };
  const logEl = { scrollTop, scrollHeight: 1000, clientHeight: 400 };

  const document = {
    getElementById: (id) => (id === 'log' ? logEl : null),
    querySelector: (sel) => (String(sel).includes('toBottom') ? btn : null),
    querySelectorAll: () => [],
  };

  const factory = new Function(
    'document',
    'logEl',
    'stickBottom',
    'currentSession',
    'unseenNew',
    `
    ${src.toBottomEl}
    ${src.really}
    ${src.paint}
    ${src.bump}
    ${src.once}
    return {
      bumpUnseen, _bumpOncePerSpeech, paintToBottom, _reallyAtBottom, toBottomEl,
      getUnseen: () => unseenNew,
    };
    `
  );
  const api = factory(document, logEl, atBottom, { id: 'x' }, unseen);
  return { api, badge, btn, logEl };
}

function show(label, env) {
  console.log(
    label.padEnd(34),
    '| badge =', JSON.stringify(env.badge.textContent),
    '| unseen =', env.api.getUnseen()
  );
}

console.log('=== 1. 贴底时调用，不许加数 ===');
{
  const e = makeEnv({ atBottom: true });
  e.api.bumpUnseen();
  e.api._bumpOncePerSpeech('stream');
  show('贴底 bumpOnce', e);
}

console.log('\n=== 2. 不贴底，说完整一段话 +1 ===');
{
  const e = makeEnv({ atBottom: false, scrollTop: 0 });
  e.api.bumpUnseen({ reason: 'speech-final' });
  show('不贴底 speech', e);
}

console.log('\n=== 3. 不贴底，开始调工具 +1 ===');
{
  const e = makeEnv({ atBottom: false, scrollTop: 0 });
  e.api.bumpUnseen({ reason: 'tool-start' });
  show('不贴底 tool', e);
}

console.log('\n=== 4. 流式吐字 / 思考块不许加 ===');
{
  const e = makeEnv({ atBottom: false, scrollTop: 0 });
  e.api.bumpUnseen({ reason: 'stream' });
  e.api.bumpUnseen({ reason: 'think' });
  e.api.bumpUnseen({ reason: 'muted' });
  show('stream/think/muted', e);
}

console.log('\n=== 5. 数字为 0 时 badge 必须是空串 ===');
{
  const e = makeEnv({ atBottom: false, scrollTop: 0 });
  e.api.paintToBottom();
  show('paintToBottom 初态', e);
}

console.log('\n=== 6. 连加三次 ===');
{
  const e = makeEnv({ atBottom: false, scrollTop: 0 });
  e.api.bumpUnseen({ reason: 'speech-final' });
  e.api.bumpUnseen({ reason: 'tool-start' });
  e.api.bumpUnseen({ reason: 'speech-final' });
  show('三次后', e);
}

console.log('\n=== 7. 同一段话内重复调 _bumpOncePerSpeech 只加一次 ===');
{
  const e = makeEnv({ atBottom: false, scrollTop: 0 });
  e.api._bumpOncePerSpeech('stream');
  e.api._bumpOncePerSpeech('stream');
  e.api._bumpOncePerSpeech('stream');
  show('同一段三次', e);
}
