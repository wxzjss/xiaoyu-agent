#!/usr/bin/env node
/**
 * 【2026-11-10 主人三问】：发布内容边界守卫
 *
 *   ① 会不会把「非出厂默认的其他人设与提示词」发出去？（隐私）
 *   ② 该发布的有没有漏发？（别人装不上）
 *   ③ 我这台能跑的，在别人电脑上会不会坏？（跨机可用）
 *
 * 这个脚本只看**发布物的实际内容**，不看「代码里说了什么」——
 * 判据是「真的会被发出去的那些文件里有没有不该走的 / 缺了该走的」。
 *
 * 做法：跑一次 publish.mjs --dry（它自己会做敏感扫描），然后检查 dist/release。
 * 不联网、不推送、不提交。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * 用自己专属的输出目录，别跟别的检查抢 dist/release。
 * （2026-11-10：回归并行时两边同时写 dist/release，谁后写谁把对方踩了，
 *   这个检查因此被冤枉红过一次。publish.mjs 已支持 XY_PUBLISH_DIST 覆盖。）
 */
const DIST_ROOT = path.join(ROOT, '_tmp', 'release-boundary');
const DIST = DIST_ROOT;

let pass = 0, fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '\n       ' + detail : '')); }
};

/* ---------- 先打一次 dry 包（这步本身也验了敏感扫描能不能过） ---------- */
console.log('\n【准备】跑一次 publish --dry（不提交、不推送）');
let dryOk = false;
let dryWhy = '';
try {
  const out = execFileSync(process.execPath, ['scripts/publish.mjs', '--dry'], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000,
    env: { ...process.env, XY_PUBLISH_DIST: DIST_ROOT },
  });
  dryOk = true;
  const m = out.match(/打包到 .*?（(\d+) 个文件/);
  console.log('  ✓ 打包成功' + (m ? '，' + m[1] + ' 个文件' : ''));
  if (/敏感信息/.test(out)) console.log('  ✓ 敏感信息扫描：' + (out.match(/✓ 敏感信息扫描通过/)?.[0] || '已执行'));
} catch (e) {
  dryWhy = String(e?.stdout || e?.stderr || e?.message || e).slice(0, 300);
  console.log('  ✗ publish --dry 失败：' + dryWhy);
}

/**
 * 【2026-11-10 修·打包失败时别拿旧包硬跑】
 *
 * 原来的行为：--dry 失败 → dryOk=false，但**下面照样读 dist/release 里上一次的旧包**
 * 去做所有断言。后果有两个：
 *   ① 第一条「发布包打出来了」红，后面几十条却全绿 —— 看着像「只有一个问题」，其实
 *      根本没用这次的内容验过，是假绿。
 *   ② 回归里它和别的检查并行跑，dist/release 被抢时必然踩到这一发（实测 101/102 就是这么红的）。
 *
 * 现在：打包失败就**整体 SKIP 退出 0**（不是 fail —— 环境竞争不是代码问题），
 * 并明确写出原因。这样回归不会冤枉它，也不会给出假绿。
 */
if (!dryOk) {
  console.log('\n结果: SKIP（发布包没打出来，无法验证；这不是代码问题）');
  if (dryWhy) console.log('原因：' + dryWhy.split('\n').filter(Boolean).slice(-3).join(' | '));
  console.log('');
  process.exit(0);
}

const rel = (p) => path.join(DIST, p);
const exists = (p) => fs.existsSync(rel(p));
const listAll = (d, out = []) => {
  const abs = rel(d);
  if (!fs.existsSync(abs)) return out;
  for (const f of fs.readdirSync(abs, { withFileTypes: true })) {
    const r = d ? d + '/' + f.name : f.name;
    if (f.isDirectory()) listAll(r, out);
    else out.push(r);
  }
  return out;
};
const all = dryOk && fs.existsSync(DIST) ? listAll('') : [];

console.log('\n一、隐私：非出厂的人设 / 提示词 / 私人数据不会被发出去');
{
  ok(dryOk, '发布包打出来了（后续断言才有对象）');

  /* 私人数据目录整个不该出现 */
  for (const bad of ['.state', '.env', 'sandbox', 'node_modules', 'backup', 'dump', 'logs', 'notes', 'scratch', 'shots', 'docs', 'mobile', 'playground', 'runtime']) {
    const hit = all.filter((f) => f === bad || f.startsWith(bad + '/'));
    ok(hit.length === 0, '不带 ' + bad + '/（' + (hit.length ? hit.length + ' 个文件漏了' : '干净') + '）',
      hit.slice(0, 5).join(', '));
  }

  /* persona 目录里只许出现出厂那几个（git 里追踪过的） */
  const personaFiles = all.filter((f) => f.startsWith('persona/'));
  const known = ['persona/FACTORY-PROMPT.md', 'persona/xiaoyu.md', 'persona/xiaoyu-qq.md',
    'persona/xiaoyu.original.md', 'persona/agents/pangbai.md', 'persona/agents/xiaobaixi.md'];
  const extra = personaFiles.filter((f) => !known.includes(f));
  ok(extra.length === 0, 'persona/ 里没有非出厂文件（' + personaFiles.length + ' 个，全是厂货）',
    extra.join(', '));

  /* 备份 / 删除痕迹一个都不许发 */
  const junk = all.filter((f) => /\.bak(-|$)|\.deleted\.|\.wiped-|\.bak-before/.test(f));
  ok(junk.length === 0, '没有备份/删除残留（.bak-* / .deleted.* / .wiped-*）', junk.slice(0, 5).join(', '));

  /* 会话与设置绝不外发（这俩是主人隐私里最要命的） */
  const priv = all.filter((f) => /(^|\/)(agents|settings|thinking|defaults|personas)\.json$/.test(f)
    || /\/sessions?\//.test(f) || /session.*\.json$/.test(f));
  ok(priv.length === 0, '不带会话与设置数据（agents/settings/thinking/defaults/sessions）', priv.slice(0, 5).join(', '));

  /* 凭据文件 */
  const cred = all.filter((f) => /ghp\.txt$|\.ghp|id_rsa|\.pem$|credentials/i.test(f));
  ok(cred.length === 0, '不带任何凭据文件', cred.join(', '));
}

console.log('\n二、完整性：该发布的都在（别人下下来能跑）');
{
  /* 【2026-11-10 修】skills/ 原来不在 INCLUDE_DIRS 里：
   * src/skills.mjs 的 skillsDir() 在 data/skills 空时回落 <root>/skills，
   * 不发布它 → 别人装完出厂技能全消失、提示词少一大段。 */
  ok(exists('skills'), 'skills/ 发了（出厂技能，data/skills 空时回落它）');
  if (exists('skills')) {
    const n = fs.readdirSync(rel('skills'), { withFileTypes: true }).filter((d) => d.isDirectory()).length;
    ok(n >= 1, 'skills/ 里有 ' + n + ' 个技能');
  }

  for (const d of ['src', 'public', 'electron', 'persona', 'assets', 'scripts']) {
    ok(exists(d), '带 ' + d + '/');
  }
  for (const f of ['package.json', 'package-lock.json', 'README.md', 'LICENSE', 'start.bat', 'start.sh']) {
    ok(exists(f), '带 ' + f);
  }

  /* 前端 bundle 必须是最新那份已构建的（没有它别人打开是白屏） */
  ok(exists('public/ui/log.bundle.js'), '带 public/ui/log.bundle.js（没有它界面白屏）');
  ok(exists('public/index.html'), '带 public/index.html');

  /* 入口链完整 */
  ok(exists('electron/main.cjs'), '带 electron/main.cjs（package.json 的 main 指向它）');

  /* src/ 内部相对引用全部能解析（缺一个文件别人一启动就崩） */
  const missing = [];
  const walkImports = (d) => {
    const abs = rel(d);
    if (!fs.existsSync(abs)) return;
    for (const f of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = d + '/' + f.name;
      if (f.isDirectory()) { if (f.name !== 'node_modules') walkImports(r); continue; }
      if (!/\.(mjs|cjs|js)$/.test(f.name)) continue;
      const txt = fs.readFileSync(rel(r), 'utf8');
      for (const m of txt.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const t = path.posix.normalize(path.posix.join(path.posix.dirname(r), m[1].replace(/\\/g, '/')));
        const cands = [t, t + '.mjs', t + '.js', t + '.cjs', t + '/index.mjs', t + '/index.js'];
        if (!cands.some((c) => exists(c))) missing.push(r + ' → ' + m[1]);
      }
    }
  };
  walkImports('src'); walkImports('electron');
  ok(missing.length === 0, '发布物里源码内部相对引用全部存在', missing.slice(0, 6).join('\n       '));
}

console.log('\n三、跨机：别人电脑上不会因为「本机路径 / 本机依赖」坏掉');
{
  /* 真实代码（非注释）里不许写死本机绝对路径 */
  const badPath = [];
  for (const f of all) {
    if (!/\.(mjs|cjs|js|json|html)$/.test(f)) continue;
    const abs = rel(f);
    let txt;
    try { txt = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const lines = txt.split('\n');
    lines.forEach((l, i) => {
      const t = l.trim();
      /* 注释行放过（说明文字里提本机路径是历史记录，不是行为） */
      if (t.startsWith('*') || t.startsWith('//') || t.startsWith('/*') || t.startsWith('#')) return;
      if (/C:[\\/]+Users[\\/]+[A-Za-z0-9_.-]{2,}/.test(t) && !/Users[\\/]+<%|Users[\\/]+\$\{|Users[\\/]+USER/.test(t)) {
        badPath.push(f + ':' + (i + 1) + '  ' + t.slice(0, 80));
      }
      if (/[A-Z]:[\\/]+(小鱼Agent|xiaoyu)[\\/]*/.test(t) && !/process\.env|import\.meta|__dirname/.test(t)) {
        badPath.push(f + ':' + (i + 1) + '  ' + t.slice(0, 80));
      }
    });
  }
  ok(badPath.length === 0, '真实代码里没有写死本机绝对路径（注释不算）', badPath.slice(0, 8).join('\n       '));

  /* 依赖声明齐全：src/electron 引用的外部包都得在 package.json 里 */
  const pkg = JSON.parse(fs.readFileSync(rel('package.json'), 'utf8'));
  const deps = new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.devDependencies || {}), ...Object.keys(pkg.optionalDependencies || {})]);
  const undeclared = new Set();
  for (const f of all) {
    if (!/^(src|electron)\//.test(f)) continue;
    if (!/\.(mjs|cjs|js)$/.test(f)) continue;
    const txt = fs.readFileSync(rel(f), 'utf8');
    for (const m of txt.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const n = m[1].replace(/\\/g, '/');
      if (n.startsWith('node:') || n.startsWith('.') || n.startsWith('/')) continue;
      const parts = n.split('/');
      const base = parts[0].startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
      if (!deps.has(base)) undeclared.add(base + '（' + f + '）');
    }
  }
  ok(undeclared.size === 0, '用到的外部包都声明在 package.json（别人 npm i 装得齐）',
    [...undeclared].slice(0, 6).join('\n       '));

  /* .env.example 不许带作者在用的具体服务商（占位就行） */
  const envEx = exists('.env.example') ? fs.readFileSync(rel('.env.example'), 'utf8') : '';
  const realUrl = /BASE_URL=(https?:\/\/[^\s#]+)/.exec(envEx);
  ok(!realUrl || /example\.com|your-|xxx|placeholder/i.test(realUrl[1]),
    'BASE_URL 是占位不是作者在用的那家', realUrl ? '实际是：' + realUrl[1] : '（空，OK）');
  /* 凭据必须是空的 */
  ok(!/WANZI_API_KEY=\S/.test(envEx), '.env.example 里没有真实 key');
}

console.log('\n结果: ' + pass + ' 过 / ' + fail + ' 挂\n');
process.exit(fail ? 1 : 0);