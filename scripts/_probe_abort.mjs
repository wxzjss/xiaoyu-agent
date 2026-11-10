// 探针：验证 run_command 被 abort 后到底返回什么（临时文件，跑完删）
import { runTool } from '../src/tools.mjs';

function probe(tag, delay, reason) {
  return new Promise((resolve) => {
    const ac = new AbortController();
    const t0 = Date.now();
    const p = runTool(
      'run_command',
      JSON.stringify({ command: 'node -e "setTimeout(()=>{},8000)"' }),
      'probe-x',
      ac.signal
    );
    setTimeout(() => { try { ac.abort(reason); } catch {} }, delay);
    p.then((r) => {
      console.log(`--- ${tag} delay=${delay} reason=${JSON.stringify(reason)} 耗时=${Date.now() - t0}ms`);
      console.log('    ok =', r.ok);
      console.log('    out=', JSON.stringify(String(r.output || '').slice(0, 300)));
      resolve();
    });
  });
}

await probe('A', 400, 'stop');
await probe('B', 1500, 'stop');
await probe('C', 400, undefined);
