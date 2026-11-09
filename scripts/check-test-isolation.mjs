/**
 * 【2026-11-09 加】把「自检不许碰主人那份」钉死。
 *
 * 主人当天截图问「为什么用我的会话来测试」：全量回归默认连 8788，
 * 那正是他开着的窗口；CDP 浏览器打开的也是同一个页面。检查在他会话里
 * 发消息、造会话、开关智能体，还留下了三条「你好」和一串小白曦口吻的回复。
 *
 * 光改一次不够 —— 以后有人（包括我）图省事把 BASE 写死、把 sweep 改回
 * 主人目录，这道闸就又没了。所以这里静态钉住几个关键点。
 */
import { makeChecker } from './_harness_util.mjs';
import fs from 'node:fs';

const t = makeChecker('自检隔离：不碰主人的实例和会话');
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const iso = read('scripts/_test-instance.mjs');
const runner = read('scripts/run-all-checks.mjs');
const base = read('scripts/_base.mjs');
const tapi = read('_t_api.mjs');

t.ok('有独立的隔离实例模块', iso.length > 1000);
t.ok('临时数据目录不带任何会话', /name === 'sessions'\)\s*continue/.test(iso));
t.ok('隔离实例用独立端口（不是主人那个）', /appPort\s*=\s*8795/.test(iso));
t.ok('浏览器打开的是隔离实例页面', /--remote-debugging-port=/.test(iso) && /\bbase,\r?\n/.test(iso));
t.ok('实例没起来直接抛错，不静默回落', /throw new Error\('隔离实例没起来/.test(iso));
t.ok('调试端口被占就拒绝复用（怕连到主人窗口）', /拒绝复用/.test(iso));
t.ok('stop() 会删掉临时目录', /rmSync\(dataDir, \{ recursive: true, force: true \}\)/.test(iso));

t.ok('全量回归确实调用了隔离模块', /await startIsolated\(\)/.test(runner));
t.ok('sweep 只扫隔离目录，不扫主人 data', /const DATA = iso\.dataDir;/.test(runner));
t.ok('所有检查子进程都带隔离 env',
  (runner.match(/env: iso\.env/g) || []).length >= 4);
t.ok('结尾会关实例、删临时数据', /await iso\.stop\(\)/.test(runner));
t.ok('存活检查不再写死 8788', /iso\.base \+ ["']\/api\/health["']/.test(runner));

t.ok('detectBase 有「没 BASE 就抛错」的保险',
  /XY_REQUIRE_ISOLATED === '1' && !process\.env\.BASE/.test(base)
  && /拒绝回落到主人实例/.test(base));
t.ok('接口体检也认 BASE（不再写死 8788）', /process\.env\.BASE/.test(tapi));

/* 【2026-11-09 第二轮发现的坑】好几个检查把主人数据目录写死在源码里，
 * 隔离回归一跑就读错地方（读主人那份 / 读不到）。这条把「不许写死」钉住。 */
const hardCoded = fs.readdirSync('scripts')
  .filter((f) => /^check-.*\.mjs$/.test(f))
  .filter((f) => {
    const body = fs.readFileSync('scripts/' + f, 'utf8');
    return /小鱼Agent\/data\/\.state\/sessions/.test(body)
      || /小鱼Agent\/data\/public\/index\.html/.test(body);
  });
t.ok('检查脚本不再写死主人数据目录', hardCoded.length === 0, hardCoded.join(', '));

/* cpSync(recursive) 在这台机器上会被安全写入垫片静默杀掉整个 node 进程
 * （退出码 127、零输出、catch 接不到）。改用逐文件复制。 */
t.ok('不用会被垫片拦掉的递归复制', !/cpSync\(join\(/.test(iso) && /copyFileSync\(sp, dp\)/.test(iso));

/* 【2026-11-09 主人：删测试会话】查出来垃圾来自 check-reset.mjs：
 * 它直接 writeFileSync 造「下线验收」假会话，末尾却用 HTTP 接口删；
 * 隔离回归里文件写主人目录、接口删临时目录，每跑一轮就多留一个。 */
const reset = read('scripts/check-reset.mjs');
t.ok('check-reset 的数据目录跟着实例走（用 MINI_AGENT_DATA）',
  /const DATA = process\.env\.MINI_AGENT_DATA/.test(reset));
t.ok('check-reset 有本地兜底清理，接口没删到也不会留孤儿',
  /existsSync\(sessPath\(id\)\)[\s\S]{0,120}unlinkSync\(sessPath\(id\)\)/.test(reset));
/* 按环境变量拼，别写死字面串 —— 上面那条「检查脚本不许写死主人目录」会连自己一起抓 */
const realSess = [process.env.APPDATA || '', '小鱼Agent', 'data', '.state', 'sessions'].join('/');
const junk = [];
try {
  for (const f of fs.readdirSync(realSess)) {
    if (!f.endsWith('.json') || f.includes('.bak')) continue;
    if (f.startsWith('smvchkreset')) { junk.push(f); continue; }
    try {
      const jj = JSON.parse(fs.readFileSync(realSess + '/' + f, 'utf8'));
      if (String(jj.title || '') === '下线验收') junk.push(f);
    } catch {}
  }
} catch {}
t.ok('主人会话目录里没有测试脚本残留的垃圾', junk.length === 0, junk.join(', '));

t.done();
