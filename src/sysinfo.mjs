import { execFileSync } from 'node:child_process';

/**
 * 设备状态：现在只有「电量」。
 *
 * 【2026-11-18 主人要求】「还要让她知道当前设备的电量（仅她知道，不对用户前端显示）」
 *
 * 为什么要缓存：取电量得问 WMI（PowerShell 子进程，一次几百毫秒）。
 * 每轮都问会让「发一句话」多等半秒，而电量这种东西 30 秒内不会变。
 * 所以给个 TTL —— 默认 60 秒，同一分钟内多次调用只问一次。
 *
 * 为什么不显示在前端：主人明确说了只给她知道。
 * 这个值只拼进**模型上下文**（contextMessage 末尾那块），界面一个像素都不画。
 */

const TTL_MS = 60 * 1000;
let _cache = { at: 0, text: '' };

/** Windows 的电池状态码 → 人话（只在需要时用，认不出来就只说百分比） */
function statusWord(code, acLine) {
  const c = Number(code);
  if (c === 2) return '接着电';
  if (c === 1) return '正在用电池';
  if (c === 6 || c === 7 || c === 8 || c === 9) return '正在充电';
  if (c === 3) return '已充满';
  if (c === 4) return '电量偏低';
  if (c === 5) return '电量告急';
  if (c === 11) return '部分充电';
  if (acLine === true) return '接着电';
  if (acLine === false) return '正在用电池';
  return '';
}

/**
 * 取电量描述。**同步**（contextMessage 是同步拼的），失败一律返回空串 ——
 * 没电量的机器（台式机）不该让提示词里多一行「查不到」，那是噪声。
 *
 * @returns {string} 例如 `78%（接着电）` / `100%（已充满）` / '' （没有电池或查不到）
 */
export function batteryText() {
  const now = Date.now();
  if (_cache.at && now - _cache.at < TTL_MS) return _cache.text;

  let text = '';
  try {
    if (process.platform === 'win32') {
      /* 只问两个字段，别拉整个对象回来 —— 输出小、解析快。
       * timeout 给 3 秒：WMI 偶尔会卡，卡住也不能把这一轮拖死。 */
      const out = execFileSync('powershell', [
        '-NoProfile', '-NonInteractive', '-Command',
        '$b = Get-CimInstance Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1;'
        + 'if ($b) { "$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)" } else { "" }',
      ], { encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();

      if (out) {
        const [pctRaw, stRaw] = out.split('|');
        const pct = Number(pctRaw);
        const word = statusWord(stRaw);
        if (Number.isFinite(pct) && pct >= 0) {
          text = pct + '%' + (word ? '（' + word + '）' : '');
        }
      }
      /* 有电池但读不出百分比 → 不写；没电池（台式机）→ 也不写。
       * 空白比错误的口号好：她不该因为「查不到电量」而跟主人解释一堆。 */
    }
  } catch { text = ''; }

  _cache = { at: now, text };
  return text;
}

/** 测试用：把缓存清掉，逼它下次真去查 */
export function _resetBatteryCache() {
  _cache = { at: 0, text: '' };
}

/* ══════════════════════════════════════════════════════════════════
   【2026-11-18 主人要求】位置地区 + 当地天气
   「还要让她知道当前设备的位置地区信息以及该地区天气情况」

   为什么要「异步预热 + 同步读」：
   · contextMessage 是**同步**拼的（一轮开头就要用），里面不能 await；
   · 而这两样都得走网络（定位、天气），一次几百毫秒到几秒。
   所以规定：**永远不在这里等网络**。后台定时刷新，同步只读上一次的结果。
   拿不到就空着 —— 宁可少一行，不能让她说话卡在那儿。

   隐私：定位是把本机出口 IP 发给第三方换城市。主人明确要求这个功能，
   所以做了；但两样都**只进模型上下文**，界面一个像素都不画，也不写进日志。
   ══════════════════════════════════════════════════════════════════ */

/** 定位多久算过期（6 小时 —— 人不会一天换三个城市） */
const GEO_TTL_MS = 6 * 60 * 60 * 1000;
/** 天气多久算过期（30 分钟 —— 够新鲜，又不会把接口打爆） */
const WX_TTL_MS = 30 * 60 * 1000;

let _geo = { at: 0, place: '', lat: 0, lon: 0 };
let _wx = { at: 0, text: '' };
let _warming = false;

/** 天气码 → 中文（WMO，open-meteo 用的就是这套） */
function wxWord(code) {
  const c = Number(code);
  if (c === 0) return '晴';
  if (c === 1) return '少云';
  if (c === 2) return '多云';
  if (c === 3) return '阴';
  if (c === 45 || c === 48) return '有雾';
  if (c >= 51 && c <= 57) return '毛毛雨';
  if (c >= 61 && c <= 67) return '下雨';
  if (c >= 71 && c <= 77) return '下雪';
  if (c >= 80 && c <= 82) return '阵雨';
  if (c >= 85 && c <= 86) return '阵雪';
  if (c === 95) return '雷阵雨';
  if (c === 96 || c === 99) return '雷阵雨伴冰雹';
  return '';
}

/** 同步读：拿上一次预热的结果，绝不发请求 */
export function envText() {
  const place = String(_geo.place || '');
  const weather = String(_wx.text || '');
  return { place, weather };
}

/**
 * 异步预热。多次并发调用只跑一次。
 * 任何一步失败都**保持上一次的值**（别把好数据清成空）。
 */
export async function warmEnv() {
  if (_warming) return;
  _warming = true;
  const now = Date.now();
  try {
    /* ① 定位（过期才查） */
    if (!_geo.at || now - _geo.at > GEO_TTL_MS) {
      try {
        const r = await fetch('https://ipwho.is/?lang=zh-CN', { signal: AbortSignal.timeout(6000) });
        if (r.ok) {
          const j = await r.json();
          if (j && j.success !== false && Number.isFinite(Number(j.latitude))) {
            const bits = [j.country, j.region, j.city].map((x) => String(x || '').trim()).filter(Boolean);
            /* 去掉重复（有的接口 country=region=city） */
            const uniq = bits.filter((x, i) => bits.indexOf(x) === i);
            _geo = {
              at: now,
              place: uniq.join(' '),
              lat: Number(j.latitude),
              lon: Number(j.longitude),
            };
          }
        }
      } catch { /* 网络不通就沿用旧的 */ }
    }

    /* ② 天气（知道城市、且过期才查）
     *
     * 【换过源】原来用 open-meteo（按经纬度，数据最干净），但实测**国内连不上**
     * （`fetch failed`）—— 定位能拿到武汉，天气却永远空着。
     * 现在改走 wttr.in：国内能通（实测 1.9 秒），而且不用 API key。
     * 也试着保留 open-meteo 做兜底（国外用户那边它更快更准）。
     */
    if (_wx.at && now - _wx.at <= WX_TTL_MS) { /* 还新鲜，不问 */ }
    else {
      /* —— 主源：wttr.in，按城市名 —— */
      const city = String((_geo.place || '').split(' ').pop() || '').trim();
      if (city) {
        try {
          const u = 'https://wttr.in/' + encodeURIComponent(city) + '?format=%C|%t|%h|%w&lang=zh-cn';
          const r = await fetch(u, { signal: AbortSignal.timeout(9000) });
          if (r.ok) {
            const txt = String(await r.text()).trim();
            /* 形如：晴|+13°C|29%|↓18km/h */
            const seg = txt.split('|').map((x) => x.trim());
            if (seg.length >= 2 && seg[1] && !/unknown/i.test(txt)) {
              const bits = [];
              if (seg[1]) bits.push(seg[1].replace(/^\+/, ''));
              if (seg[0]) bits.push(seg[0]);
              if (seg[2]) bits.push('湿度 ' + seg[2]);
              if (seg[3]) bits.push('风 ' + seg[3].replace(/[↓↑→←↙↘↖↗]/g, '').trim());
              _wx = { at: now, text: bits.join('，') };
            }
          }
        } catch { /* 落到下面的兜底 */ }
      }

      /* —— 兜底：open-meteo（按经纬度；国内通常连不上，国外好用） —— */
      if (!_wx.at || now - _wx.at > 5 * 60 * 1000) {
        if (_geo.lat && _geo.lon) {
          try {
            const u = 'https://api.open-meteo.com/v1/forecast'
              + '?latitude=' + _geo.lat + '&longitude=' + _geo.lon
              + '&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m'
              + '&timezone=auto';
            const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
            if (r.ok) {
              const j = await r.json();
              const cur = j && j.current;
              if (cur && Number.isFinite(Number(cur.temperature_2m))) {
                const word = wxWord(cur.weather_code);
                const parts = [Math.round(Number(cur.temperature_2m)) + '°C'];
                if (word) parts.push(word);
                if (Number.isFinite(Number(cur.relative_humidity_2m))) parts.push('湿度 ' + Math.round(Number(cur.relative_humidity_2m)) + '%');
                if (Number.isFinite(Number(cur.wind_speed_10m))) parts.push('风 ' + Math.round(Number(cur.wind_speed_10m)) + 'km/h');
                _wx = { at: now, text: parts.join('，') };
              }
            }
          } catch { /* 两边都拿不到就空着 */ }
        }
      }
    }
  } finally {
    _warming = false;
  }
}

/** 测试用：清缓存 */
export function _resetEnvCache() {
  _geo = { at: 0, place: '', lat: 0, lon: 0 };
  _wx = { at: 0, text: '' };
}
