#!/usr/bin/env node
/**
 * 【2026-11-10 主人钦点】模型配置体检：逐个拉真实列表 + 探连通，把过时的名字改掉
 *
 * 主人原话：「拉取做好后，你每个都拉一下，如果拉取成功就改现有的过时模型名称预设」。
 *
 * 为什么需要它：预设表里的名字是「写着好看」的，跟服务商真实能用的 id 未必一样。
 * 实测踩过两次：
 *   · 丸子那家预设给 deepseek-v4.1-flash（调下去 502），真实可用的是
 *     deepseek-v4.1-flash-1017（200）
 *   · 凌风那家挂着 deepseek-v4.1-flash，可它实际只提供 glm-5.3 / glm-5.3-flash
 *     （404 model_not_found）
 * 老板不会自己去猜后缀，所以要有一个能一遍过完全部的工具。
 *
 * 用法：
 *   node scripts/refresh-model-presets.mjs            # 只看（默认，不动配置）
 *   node scripts/refresh-model-presets.mjs --apply    # 真改（只改「确认过时」的那几条）
 *   node scripts/refresh-model-presets.mjs --apply --pick=<模型id或名字关键字>
 *                                                    # 只处理某一条
 *
 * 判据很保守，宁可不改也不乱改：
 *   · 拉不到列表          → 跳过（网络/权限问题，不是名字错）
 *   · 当前名字在列表里    → 不动（名字是对的，通不通是另一回事：限流/余额/上游挂）
 *   · 当前名字不在列表里  → 才算「过时」；再把候选逐个探连通，
 *                          取第一个真的 200 的换上去；一个都不通用 → 只报告不改
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const APPLY = process.argv.includes('--apply');
const pickArg = (process.argv.find((a) => a.startsWith('--pick=')) || '').slice(7);

/* 数据目录：跟 config.mjs 同一套规矩（不做重复实现，直接用它） */
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
process.env.XY_REFRESH_ROOT ||= ROOT;
const modelsMod = await import('file:///' + path.join(ROOT, 'src', 'models.mjs').replace(/\\/g, '/'));

const trim = (u) => String(u ?? '').trim().replace(/\/+$/, '');

/** 拉真实列表：返回 string[] 或 null（拉不到） */
async function pullIds(base, key) {
  const b = trim(base);
  const cands = /\/v1$/i.test(b) ? [`${b}/models`] : [`${b}/v1/models`, `${b}/models`];
  for (const u of cands) {
    try {
      const r = await fetch(u, {
        headers: { Accept: 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        signal: AbortSignal.timeout(12_000),
      });
      if (!r.ok) continue;
      const j = await r.json().catch(() => null);
      const arr = Array.isArray(j?.data) ? j.data : (Array.isArray(j) ? j : (Array.isArray(j?.models) ? j.models : null));
      if (!arr) continue;
      const ids = [...new Set(arr.map((x) => String(x?.id || x?.name || '').trim()).filter(Boolean))];
      if (ids.length) return ids;
    } catch { /* 下一个候选 */ }
  }
  return null;
}

/** 探一个模型名能不能真的回话 */
async function probe(base, key, model, kind = 'chat') {
  const b = trim(base);
  const isImg = String(kind) === 'image';
  const url = b + (isImg ? '/images/generations' : '/chat/completions');
  const body = isImg
    ? { model, prompt: 'a red dot', n: 1, size: '1024x1024' }
    : { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 16 };
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
    const t = await r.text().catch(() => '');
    return { ok: r.ok, status: r.status, msg: String(t).slice(0, 140).replace(/\s+/g, ' ') };
  } catch (e) {
    return { ok: false, status: 'EX', msg: String(e?.message ?? e).slice(0, 100) };
  }
}

const data = modelsMod.listModels();
const list = Array.isArray(data.models) ? data.models : [];

console.log(`\n模型体检：共 ${list.length} 条${APPLY ? '（--apply 会真改）' : '（只看，不改配置）'}`);
console.log('─'.repeat(78));

let changed = 0, stale = 0, okCount = 0, skipped = 0;

for (const m of list) {
  const name = String(m.name || '?');
  const base = trim(m.baseURL);
  const model = String(m.model || '');
  const kind = String(m.kind || 'chat');

  if (pickArg && !name.includes(pickArg) && !String(m.id).includes(pickArg)) continue;

  if (!base) { console.log(`— ${name}：没填接口地址，跳过`); skipped++; continue; }

  /* 拿 key：listModels 只回 hasKey（安全设计），真值得用 keyForBaseURL 这个口子。
 * 踩过的坑：这里原先写 `modelsMod.listModels.__raw()` —— 那东西不存在，
 * 结果每一条都拿空 key 去问，全被 401 顶回来，界面看起来像「全都拉不到」。 */
  const key = (() => {
    try { return modelsMod.keyForBaseURL(base) || ''; } catch { return ''; }
  })();

  const ids = await pullIds(base, key);
  if (!ids) {
    console.log(`✗ ${name}\n   拉不到列表（网络/权限），不动它`);
    skipped++;
    continue;
  }

  const inList = ids.includes(model);
  if (inList) {
    console.log(`✔ ${name}  model=${model} 在列表里（${ids.length} 个可用）`);
    okCount++;
    continue;
  }

  /* 不在列表里 = 名字可能过时。但**生图模型和聊天模型是两套列表**：
   * 很多中转站的 /v1/models 只列聊天模型（实测丸子那家 /v1/models 回 4 个聊天模型，
   * 而它明明能画 gpt-image-2.5-sunburst）。所以生图那条**不能拿聊天列表来判断**，
   * 否则每次体检都会把好的生图配置误报成「过时」。
   * 生图怎么判：直接拿它自己去探一次 /images/generations，通了就是好的。 */
  stale++;
  console.log(`✗ ${name}  model=${model} **不在列表里**（${ids.length} 个）`);
  console.log(`   列表：${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ' …' : ''}`);

  if (kind === 'image') {
    const self = await probe(base, key, model, 'image');
    if (self.ok) {
      console.log(`   → 但它是生图模型，直接探 /images/generations 通了（HTTP ${self.status}）。`
        + `\n      /v1/models 只列聊天模型，不能拿它判断生图 —— 不建议改名`);
    } else if (/not\s+supported\s+for\s+this\s+platform|api\s+is\s+not\s+supported/i.test(self.msg)) {
      /* 实测星猫那家就是这个：404 「Images API is not supported for this platform」
       * —— 这家平台压根不提供生图接口，换什么名字都没用。 */
      console.log(`   → 这家平台不支持生图（HTTP ${self.status}）：换名字也没用，`
        + `要么换一家，要么把这条删掉`);
    } else {
      console.log(`   → 生图探测也没通（HTTP ${self.status} ${self.msg.slice(0, 60)}）`
        + `\n      名字大概率是对的（402 余额 / 超时 / 无可用通道都长这样），别乱改`);
    }
    continue;
  }

  const like = ids.filter((x) => x.startsWith(model.split('-').slice(0, 2).join('-')));
  const cands = (like.length ? like : ids).slice(0, 6);
  let picked = '';
  for (const c of cands) {
    const p = await probe(base, key, c, kind);
    console.log(`   试 ${c} → ${p.ok ? 'HTTP ' + p.status + ' ✔' : 'HTTP ' + p.status + ' ✘ ' + p.msg.slice(0, 60)}`);
    if (p.ok) { picked = c; break; }
  }

  if (!picked) { console.log(`   → 一个都没接通，不改（多半是上游挂了/没钱/限流，不是名字问题）`); continue; }

  if (!APPLY) {
    console.log(`   → 建议改成 ${picked}（加 --apply 才会真改）`);
    continue;
  }

  try {
    const r = modelsMod.saveModel({ id: m.id, model: picked, baseURL: base, name: name, kind });
    changed++;
    console.log(`   → 已改成 ${picked}（${r && r.model ? r.model : ''}）`);
  } catch (e) {
    console.log(`   → 改失败：${String(e?.message ?? e).slice(0, 120)}`);
  }
}

console.log('─'.repeat(78));
console.log(`正常 ${okCount} 条 / 过时 ${stale} 条 / 跳过 ${skipped} 条 / 已改 ${changed} 条`);
if (stale && !APPLY) console.log('（想真改就加 --apply）');
console.log('');