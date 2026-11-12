/**
 * 【macOS 兼容性站岗】—— 2026-11-12 mac 兼容批次
 *
 * 背景：主人问「小鱼Agent 能否同时兼容 Windows 与 macOS」。审计结论（当天日志有全文）：
 * 核心跨平台没问题，坏点集中在四块 —— 打包 / 自动更新 / 语音自装 / QQ 接线。
 * 这个检查把「这次补的 mac 路线」钉住，谁改没了就红：
 *   ① package.json：build.mac 必须有 zip 目标（dmg 在 Windows 上打不出来，所以只声明 zip/dir）
 *   ② updater-installer：pickInstaller 必须认识 mac 包（.dmg/.zip + 架构优先）；
 *      spawnSilentInstall 非 win32 必须给「手动安装」人话，不许硬跑 cmd 脚本
 *   ③ updater：mac 上挑不到包时提示里必须带 releases 地址
 *   ④ voice-runtime：readyPythons 候选必须有 python3 / Homebrew 路径；
 *      installRuntime 非 win32 必须拦下（Windows 嵌入式 Python 在 mac 上是废件）
 *   ⑤ napcat-runtime：detectQQ 非 win32 直接回「只支持 Windows」
 *   ⑥ electron/main.cjs：boot.log 在 mac 上落到 ~/Library/Application Support
 *   ⑦ 反向：Windows 路线一条不许少（.exe / setup / NSIS / python.exe 全还得在）
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('兼容 / macOS 路线钉死（Windows 不回退）');
const read = (p) => fs.readFileSync(p, 'utf8');

const pkg = JSON.parse(read('package.json'));
const upInst = read('src/updater-installer.mjs');
const updater = read('src/updater.mjs');
const voice = read('src/voice-runtime.mjs');
const napcat = read('src/napcat-runtime.mjs');
const mainCjs = read('electron/main.cjs');

/* ── ① 打包配置 ─────────────────────────────────────────────── */
{
  const mac = pkg.build && pkg.build.mac;
  const targets = mac && mac.target ? mac.target.map((x) => (typeof x === 'string' ? x : x.target)) : [];
  t.ok('build.mac 存在且带 zip 目标（zip 在非 mac 机器也能打包）',
    Boolean(mac) && targets.includes('zip'),
    'targets=' + JSON.stringify(targets));
  t.ok('mac 目标里没有 dmg（dmg 只有 mac 系统能打，声明了 --mac 在 Windows 上必炸）',
    Boolean(mac) && !targets.includes('dmg'));
  t.ok('pack:mac 脚本存在', Boolean(pkg.scripts && pkg.scripts['pack:mac']));
  /* 反向：Windows 配置不许丢 */
  t.ok('build.win 的 nsis+portable 还在（mac 批次不许碰坏 Windows 主路）',
    Boolean(pkg.build && pkg.build.win
      && String(JSON.stringify(pkg.build.win.target)).includes('nsis')
      && String(JSON.stringify(pkg.build.win.target)).includes('portable')));
}

/* ── ② 更新安装器 ───────────────────────────────────────────── */
t.ok('pickInstaller 有 darwin 分支且认 .dmg/.zip',
  /platform === 'darwin'/.test(upInst) && /dmg/.test(upInst) && /zip/.test(upInst));
t.ok('pickInstaller mac 分支按架构挑（arm64 优先）',
  /platform === 'darwin'[\s\S]{0,900}arm64[\s\S]{0,400}kind: 'mac'/.test(upInst));
t.ok('spawnSilentInstall 非 win32 直接拦（manual:true + 人话「拖进应用程序」），不硬跑 cmd 脚本',
  /export function spawnSilentInstall[\s\S]{0,400}platform !== 'win32'[\s\S]{0,600}manual: true[\s\S]{0,400}应用程序/.test(upInst));
t.ok('Windows 静默安装路线原样保留（cmd /S 脚本）',
  /apply-update\.cmd/.test(upInst) && /tasklist \/FI "PID eq/.test(upInst));

/* ── ③ 更新器提示 ───────────────────────────────────────────── */
t.ok('mac 挑不到包时报错带 releases 地址（REPO 拼接，不许用不在作用域的 REL）',
  /mac 版安装包还没发布[\s\S]{0,200}github\.com\/\$\{REPO\}\/releases/.test(updater));

/* ── ④ 语音运行时 ───────────────────────────────────────────── */
t.ok('readyPythons 候选含 python3', /'python3'/.test(voice));
t.ok('readyPythons 候选含 Homebrew python3 路径（darwin 守卫）',
  /platform === 'darwin' \? '\/opt\/homebrew\/bin\/python3'/.test(voice));
t.ok('installRuntime 非 win32 拦下（Windows 嵌入式 Python 不给 mac 装）',
  /export async function installRuntime[\s\S]{0,300}platform !== 'win32'[\s\S]{0,500}return\s*\{/.test(voice));
/* 反向：Windows 路线原样 */
t.ok('Windows 语音路线原样保留（python.exe / embed-amd64）',
  /python\.exe/.test(voice) && /embed-amd64\.zip/.test(voice));

/* ── ⑤ QQ 接线 ──────────────────────────────────────────────── */
t.ok('detectQQ 有 darwin 真路线（认 /Applications/QQ.app + Info.plist 读版本）',
  /export async function detectQQ[\s\S]{0,400}platform === 'darwin'[\s\S]{0,600}\/Applications\/QQ\.app[\s\S]{0,400}CFBundleShortVersionString/.test(napcat));
t.ok('detectQQ 其余非 win32 仍给明白话（支持 Windows 与 macOS）',
  /platform !== 'win32'[\s\S]{0,300}支持 Windows 与 macOS/.test(napcat));
t.ok('detectNapCat 认 mac 安装形态（QQ 容器 napcat 目录 / 注入 loader）',
  /export function detectNapCat[\s\S]{0,400}platform === 'darwin'[\s\S]{0,700}com\.tencent\.qq[\s\S]{0,300}loadNapCat\.js/.test(napcat));
t.ok('launchNapCat mac 起的是 QQ 本体带 --no-sandbox（沙盒 EPERM 必踩）',
  /export async function launchNapCat[\s\S]{0,400}platform === 'darwin'[\s\S]{0,700}--no-sandbox/.test(napcat));
t.ok('installNapCat mac 不代劳，回 NapCat-Mac-Installer 官方指引',
  /export async function installNapCat[\s\S]{0,300}platform === 'darwin'[\s\S]{0,700}NapCat-Mac-Installer/.test(napcat));
t.ok('napcatStatus mac 上版本比对放宽（mac 没有版本账，真话看 3001）',
  /isMac[\s\S]{0,300}versionMatch[\s\S]{0,400}\(isMac \|\|/.test(napcat));

/* ── ⑥ 主进程 boot.log ──────────────────────────────────────── */
t.ok('boot.log 在 mac 上落到 ~/Library/Application Support',
  /platform === 'darwin'[\s\S]{0,200}Library', 'Application Support', '小鱼Agent/.test(mainCjs));

t.done();
