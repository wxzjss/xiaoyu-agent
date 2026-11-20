// Shared browser connection for the local UI checks.
const EVAL_TIMEOUT_MS = 30000;
const SEND_TIMEOUT_MS = 20000;

function matches(url, match) {
  if (!match) return true;
  try { return new URL(url).origin === new URL(match).origin; } catch { return String(url || '').includes(String(match)); }
}

export async function connect({ port, match, tries = 20, gapMs = 500 } = {}) {
  if (!Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) throw new Error('CDP 端口无效');
  let lastError;
  for (let i = 0; i < tries; i++) {
    try {
      const response = await fetch('http://127.0.0.1:' + port + '/json/list', { signal: AbortSignal.timeout(1500), redirect: 'error' });
      const pages = (await response.json()).filter((page) => page.type === 'page');
      const page = pages.find((candidate) => matches(candidate.url, match));
      if (page?.webSocketDebuggerUrl) return await openConnection(page.webSocketDebuggerUrl);
      lastError = new Error('没有匹配的页面（match=' + match + '）');
    } catch (error) { lastError = error; }
    if (i + 1 < tries) await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  throw new Error('CDP 连不上：' + lastError?.message, { cause: lastError });
}

async function openConnection(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  const lifecycle = new Set();
  const onDisconnect = new Set();
  let nextId = 0;
  let closed;
  const disconnect = (error) => {
    if (closed) return;
    closed = error;
    for (const request of pending.values()) request.finish(error);
    for (const fn of onDisconnect) fn(error);
    lifecycle.clear();
    onDisconnect.clear();
  };
  ws.addEventListener('error', () => disconnect(new Error('CDP WebSocket 连接失败')));
  ws.addEventListener('close', () => disconnect(new Error('CDP WebSocket 已断开')));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      disconnect(new Error('CDP WebSocket 握手超时'));
      ws.close();
    }, 3000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    onDisconnect.add(fail);
    ws.addEventListener('open', () => { clearTimeout(timer); onDisconnect.delete(fail); resolve(); }, { once: true });
  });

  ws.addEventListener('message', ({ data }) => {
    let message;
    try { message = JSON.parse(data); } catch { return; }
    if (message.method === 'Page.lifecycleEvent') {
      for (const fn of lifecycle) fn(message.params || {});
    }
    const request = pending.get(message.id);
    if (!request) return;
    if (message.error) request.finish(new Error(request.method + '：' + message.error.message));
    else request.finish(null, message.result || {});
  });

  const send = (method, params = {}, timeout = SEND_TIMEOUT_MS, signal) => new Promise((resolve, reject) => {
    if (closed || signal?.aborted) { reject(closed || signal.reason); return; }
    const id = ++nextId;
    const finish = (error, result) => {
      if (!pending.delete(id)) return;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = () => finish(signal.reason);
    const timer = setTimeout(() => finish(new Error((method === 'Runtime.evaluate' ? 'CDP eval' : method) + ' 超时 ' + timeout + 'ms')), timeout);
    pending.set(id, { method, finish });
    signal?.addEventListener('abort', onAbort, { once: true });
    try { ws.send(JSON.stringify({ id, method, params })); } catch (error) { finish(error); }
  });

  return {
    send,
    async eval(expr) {
      const result = await send('Runtime.evaluate', {
        expression: '(async () => { ' + expr + ' })()', awaitPromise: true, returnByValue: true,
      }, EVAL_TIMEOUT_MS);
      const error = result.exceptionDetails;
      if (error) throw new Error(String(error.exception?.description || error.text).slice(0, 300));
      return result.result?.value;
    },
    async nav(url, { timeout = 15000, onFailure } = {}) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error('等待超时')), timeout);
      const ready = new Set();
      let loaderId;
      let phase = 'Page.enable';
      let loaded;
      const record = (event) => {
        if (event.name !== 'DOMContentLoaded') return;
        ready.add(event.loaderId);
        if (event.loaderId === loaderId) loaded?.();
      };
      const onClose = (error) => ac.abort(error);
      lifecycle.add(record);
      onDisconnect.add(onClose);
      try {
        await send(phase, {}, timeout, ac.signal);
        phase = 'Page.setLifecycleEventsEnabled';
        await send(phase, { enabled: true }, timeout, ac.signal);
        ready.clear();
        phase = 'Page.navigate';
        const result = await send(phase, { url }, timeout, ac.signal);
        if (result.errorText || result.isDownload) throw new Error(result.errorText || '意外下载');
        phase = 'DOMContentLoaded';
        loaderId = result.loaderId;
        if (!loaderId || ready.has(loaderId)) return true;
        await new Promise((resolve, reject) => {
          if (ac.signal.aborted) { reject(ac.signal.reason); return; }
          loaded = resolve;
          ac.signal.addEventListener('abort', () => reject(ac.signal.reason), { once: true });
        });
        return true;
      } catch (error) {
        try { onFailure?.(phase + ': ' + error.message); } catch {}
        return false;
      } finally {
        clearTimeout(timer);
        lifecycle.delete(record);
        onDisconnect.delete(onClose);
      }
    },
    close() {
      disconnect(new Error('CDP 连接已关闭'));
      ws.close();
    },
  };
}
