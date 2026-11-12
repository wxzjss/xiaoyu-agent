// 本机 DeepSeek 预设 · 后端全链路实测
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'http://127.0.0.1:8788';
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { pass++; console.log('  ✔ ' + n); } else { fail++; console.log('  ✘ ' + n + (d ? '  → ' + d : '')); } };

async function api(p, opt = {}) {
  const r = await fetch(BASE + p, {
    method: opt.method || 'GET',
    headers: opt.body ? { 'content-type': 'application/json' } : {},
    body: opt.body ? JSON.stringify(opt.body) : undefined,
  });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch { }
  return { code: r.status, json: j, text: t };
}

// 等服务真就绪（重启后端口要几秒才接客）
for (let i = 0; i < 60; i++) {
  try {
    const r = await fetch(BASE + '/api/mini-deepseek/status');
    if (r.ok) { const j = await r.json(); if (Array.isArray(j.ids) && j.ids.length) break; }
  } catch { }
  await new Promise(r => setTimeout(r, 500));
}

console.log('\n【1】status 接口字段齐全');
{
  const r = await api('/api/mini-deepseek/status');
  ok('HTTP 200', r.code === 200, r.code);
  const j = r.json || {};
  for (const k of ['running', 'waitingLogin', 'base', 'key', 'model', 'up', 'ids', 'hasToken', 'hasProgram', 'python']) {
    ok('字段 ' + k, k in j, Object.keys(j).join(','));
  }
  ok('base 指向 8321', String(j.base).includes('8321'), j.base);
  ok('ids 含两个模型', Array.isArray(j.ids) && j.ids.includes('deepseek-web') && j.ids.includes('deepseek-web-think'), JSON.stringify(j.ids));
}

console.log('\n【2】未登录场景：waitForLogin 会调 opener，且 10 分钟会超时');
{
  const mod = await import('file:///D:/小鱼Agent/src/mini-deepseek.mjs');
  ok('导出 waitForLogin', typeof mod.waitForLogin === 'function');

  let opened = 0;
  const opener = async () => { opened++; };
  // 用 1500ms 假超时，模拟「十分钟内没登录」
  const t0 = Date.now();
  const r = await mod.waitForLogin({ opener, waitMs: 1500, reader: () => ({ token: '' }) });
  const dt = Date.now() - t0;
  ok('调了 opener 打开登录页', opened === 1, 'opened=' + opened);
  ok('返回 timeout', r && r.ok === false && r.reason === 'timeout', JSON.stringify(r));
  ok('确实等到超时才停（>=1400ms）', dt >= 1400, dt + 'ms');
  ok('不超过 4 秒（没有死等）', dt < 4000, dt + 'ms');

  // opener 抛异常也不能崩
  const r2 = await mod.waitForLogin({ opener: async () => { throw new Error('boom'); }, waitMs: 400, reader: () => ({ token: '' }) });
  ok('opener 抛异常不影响轮询/不崩溃', r2 && r2.ok === false && r2.reason === 'timeout', JSON.stringify(r2));
}

console.log('\n【3】login-start / stop 幂等');
{
  const a = await api('/api/mini-deepseek/start', { method: 'POST' });
  ok('start 200', a.code === 200, a.text.slice(0, 120));
  ok('返回 ok:true', a.json && a.json.ok === true, a.text.slice(0, 120));
  const b = await api('/api/mini-deepseek/start', { method: 'POST' });
  ok('重复 start 不报错', b.code === 200 && b.json && b.json.ok === true, b.text.slice(0, 120));
  const c = await api('/api/mini-deepseek/stop', { method: 'POST' });
  ok('stop 200', c.code === 200, c.text.slice(0, 120));
}

console.log('\n【4】probe：未起服务时自动起，通后 up=true');
{
  const mod = await import('file:///D:/小鱼Agent/src/mini-deepseek.mjs');
  // 先确保没起
  try { mod.stopLocalService(); } catch { }
  const r0 = await api('/api/mini-deepseek/status');
  ok('停掉后 running=false', r0.json && r0.json.running === false, JSON.stringify(r0.json && r0.json.running));

  const r = await api('/api/mini-deepseek/probe', { method: 'POST' });
  ok('probe 200', r.code === 200, r.text.slice(0, 200));
  ok('probe 结果 ok:true', r.json && r.json.ok === true, r.text.slice(0, 200));
  const r2 = await api('/api/mini-deepseek/status');
  ok('probe 后 running=true', r2.json && r2.json.running === true, JSON.stringify(r2.json && r2.json.running));
  ok('probe 后 up=true', r2.json && r2.json.up === true, JSON.stringify(r2.json && r2.json.up));
}

console.log('\n【5】probe 后 /v1/models 真能列出两个模型');
{
  const r = await fetch('http://127.0.0.1:8321/v1/models');
  const j = await r.json();
  const ids = (j.data || []).map((x) => x.id);
  ok('/v1/models 200', r.status === 200, r.status);
  ok('含 deepseek-web', ids.includes('deepseek-web'), ids.join(','));
  ok('含 deepseek-web-think', ids.includes('deepseek-web-think'), ids.join(','));
}

console.log('\n【6】已有模型 → 再 probe 应 already=true 且静默');
{
  const r = await api('/api/mini-deepseek/probe', { method: 'POST' });
  ok('probe 200', r.code === 200, r.text.slice(0, 200));
  ok('返回 already:true', r.json && r.json.already === true, r.text.slice(0, 200));
  ok('返回 base/key/model', !!(r.json && r.json.base && r.json.key && r.json.model), r.text.slice(0, 200));
}

console.log('\n【7】token 坏掉 → probe 自动重取并恢复');
{
  // 把 token 缓存文件改坏，模拟过期
  const tokFile = 'D:/小鱼Agent/sandbox/mini_ds/.token';
  let backup = null;
  try { backup = fs.readFileSync(tokFile, 'utf8'); } catch { }
  try {
    fs.writeFileSync(tokFile, 'BROKEN_TOKEN_FOR_TEST', 'utf8');
    const mod = await import('file:///D:/小鱼Agent/src/mini-deepseek.mjs');
    try { mod.stopLocalService(); } catch { }
    const r = await api('/api/mini-deepseek/probe', { method: 'POST' });
    ok('坏 token 时 probe 仍返回 200', r.code === 200, r.code);
    ok('坏 token 能自动恢复到 ok', r.json && r.json.ok === true, r.text.slice(0, 300));
  } finally {
    if (backup !== null) fs.writeFileSync(tokFile, backup, 'utf8');
    else { try { fs.unlinkSync(tokFile); } catch { } }
  }
}

console.log('\n【8】apply：填地址/key/模型名，且幂等（已有就 already）');
{
  const r = await api('/api/mini-deepseek/apply', { method: 'POST' });
  ok('apply 200', r.code === 200, r.text.slice(0, 200));
  ok('返回 base/key/model', !!(r.json && r.json.base && r.json.key && r.json.model), r.text.slice(0, 200));
  ok('base 是 8321', String(r.json && r.json.base).includes('8321'), r.json && r.json.base);
  ok('key 非空', !!(r.json && r.json.key), r.json && r.json.key);
}

console.log('\n【9】模型真的进模型表了');
{
  const r = await api('/api/models');
  const list = (r.json && (r.json.models || r.json.list)) || [];
  const hit = list.find((m) => String(m.baseURL || m.base || '').includes('8321'));
  ok('模型表里有 8321 的模型', !!hit, JSON.stringify(list.map((m) => m.name + '|' + (m.baseURL || m.base))).slice(0, 300));
}

console.log('\n【10】超时文案是「十分钟」');
{
  const mod = await import('file:///D:/小鱼Agent/src/mini-deepseek.mjs');
  const r = await mod.waitForLogin({ opener: async () => { }, waitMs: 300, reader: () => ({ token: '' }) });
  ok('超时文案提到十分钟', String(r.error || '').includes('十分钟'), r.error);
}

console.log('\n===== 结果 ' + pass + ' 过 / ' + fail + ' 没过 =====');
process.exit(fail ? 1 : 0);
