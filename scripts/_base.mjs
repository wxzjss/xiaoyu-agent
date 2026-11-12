/**
 * 【2026-11-07 加·自动探端口】
 *
 * 病根：一百多个检查脚本把 BASE 默认写成 8788，可服务重启后端口未必还是那个。
 * 每次跑一片 "fetch failed"，看着像代码坏了，其实是端口对不上 —— 白查半天。
 * 2026-11-07 我自己就因为这个追错方向，去改了一通根本不存在的 bug。
 *
 * 做法：跑测试的这一刻去问系统「哪个进程在听 127.0.0.1」，挑第一个真能通的当 BASE。
 * 探不出来退回 8788，至少行为和以前一样。
 *
 * 优先级：显式传参 > 环境变量 BASE > 自动探测 > 8788
 */
import { execSync } from 'node:child_process';

const FALLBACK = 'http://127.0.0.1:8788';

/** 看系统里哪些端口在听（只认 8700~8799 这段，别把别的服务当成本程序） */
function listeningPorts() {
  const out = [];
  try {
    const raw = execSync('netstat -ano', { encoding: 'utf8', timeout: 8000 });
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING/i);
      if (m) out.push(Number(m[1]));
      const m2 = line.match(/TCP\s+0\.0\.0\.0:(\d+)\s+\S+\s+LISTENING/i);
      if (m2) out.push(Number(m2[1]));
    }
  } catch {}
  return [...new Set(out)].filter((p) => p >= 8700 && p <= 8799).sort();
}

/**
 * 这个端口上跑的是不是小鱼。
 *
 * 【2026-11-10 修·把别的服务认成了小鱼】
 *
 * 原来探的是 `/api/sessions`，判据是 `status < 500` —— 于是**任何返回 404 的服务都算「活着」**。
 * 实测踩到：本机 8791 上有个不相干的进程，`/api/sessions` 和 `/api/sessions/new` 都回 404，
 * 却被认成小鱼 → `detectBase()` 挑中它 → `check-chat-e2e` 报「建会话失败: 404」，
 * 看着像我们把路由改坏了，其实连的根本不是我们的服务。
 *
 * 现在探 `/api/health`，要求**200 且 JSON 里带 version**：
 *   · 小鱼自己的健康接口一定回 200 + 版本号；
 *   · 陌生服务要么 404、要么回的 JSON 里没有 version，一律不算。
 * 宁可探不到退回 8788（行为跟以前一样），也不能把假货当真。
 */
function alive(port) {
  try {
    execSync(
      `node -e "fetch('http://127.0.0.1:${port}/api/health').then(async r=>{if(r.status!==200)process.exit(1);const j=await r.json().catch(()=>null);process.exit(j&&j.version?0:1)}).catch(()=>process.exit(1))"`,
      { stdio: 'pipe', timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * 找出服务实际在哪个地址。
 * @param {string[]} extra 额外想先试的端口（比如调用方已知的老端口）
 * @returns {string} 形如 http://127.0.0.1:8788（不带尾斜杠）
 */
export function detectBase(extra = []) {
  /* 【2026-11-09 闸】全量回归期间必须只认隔离实例。
   * 以前这里「探不到就退回 8788」，而 8788 正是主人开着的那个窗口 ——
   * 隔离实例万一没起来，检查会静默地全打回主人数据上，比不隔离还危险。 */
  if (process.env.XY_REQUIRE_ISOLATED === '1' && !process.env.BASE) {
    throw new Error('自检要求隔离实例，但 BASE 没设置 —— 拒绝回落到主人实例');
  }
  if (process.env.BASE) return process.env.BASE.replace(/\/+$/, '');

  /* 【2026-11-12 修·回归把测试会话建到真身 App 上（「_e2e_chat_」通知就是这么来的）】
   * 两个洞一起堵：
   *   ① 子进程带着 PORT（隔离实例给它的端口）时，优先认它 —— 这是 runner 明说的事；
   *   ② 自动探测的顺序把 **8788 排到最后**：以前它排第一，真身 App 一开，
   *      探测永远先命中它 —— 检查的建会话/发消息全灌进主人的会话列表，
   *      跑完还弹「小鱼干完了：_e2e_chat_」的桌面通知。 */
  const ports = listeningPorts();
  const order = [...new Set([
    ...(Number(process.env.PORT) ? [Number(process.env.PORT)] : []),
    ...extra,
    ...ports.filter((p) => p !== 8788),
    8787,
    8788,   // 真身默认端口：最后手段（读接口的检查用，写会话的检查不该走到这）
  ])];
  for (const p of order) {
    if (alive(p)) return 'http://127.0.0.1:' + p;
  }
  return FALLBACK;
}

export { FALLBACK };
