/**
 * check-whale-empty.mjs — 群聊侧栏（小鲸）不许把「整条空话」落成裸空 assistant
 *
 * 【2026-11-12 接手小鲸鱼清单第 19/22 步】实测 smwc7bg8fo4ky.json 下标 3：
 * 23:32 主人发「sleep1到10」后，历史里躺着一条
 * {role:'assistant', content:'', _at, _who, _whale} —— 界面上就是
 * 「名字底下只剩时间戳，正文是空的」。
 *
 * 根因：landWhaleSay 的空壳检查 `!withoutAside && body` 拦的是「有字但全是
 * 括号旁白」；text 整个为空时 body 是空串、条件不成立 → 穿透 → 押送 →
 * flushWhalePark 补写落盘。
 *
 * 钉三道闸（改前会红）：
 *  ① landWhaleSay 入口：body 为空直接丢弃；
 *  ② flushWhalePark 补写时跳过裸空记录（存量也不许再漏进历史）；
 *  ③ 前端 turnToItems：没字、没文件（out）就不出 assistant 行。
 */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (m, c, d) => { if (c) { pass++; console.log('  [ok] ' + m + (d ? '  ' + d : '')); } else { fail++; console.log('  [!!] ' + m + (d ? '  ' + d : '')); } };

const server = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8');
const items = readFileSync(new URL('../src-ui/items.js', import.meta.url), 'utf8');

/* ── ① 入口守卫 ── */
ok('landWhaleSay：body 为空直接丢弃（丢掉整条空话）',
  /const body = String\(text \|\| ''\)\.trim\(\);[\s\S]{0,900}if \(!body\) \{[\s\S]{0,200}dropWhaleSay\(send\);/.test(server));

/* ── ② 补写兜底闸 ── */
ok('flushWhalePark：裸空记录（没字/没文件/没工具）不再补进历史',
  /const _rc = String\(rec\.content \?\? ''\)\.trim\(\);[\s\S]{0,300}if \(!_rc && !_rcHasStuff\) \{ out\.n\+\+; continue; \}/.test(server));

/* ── ③ 前端不出空气泡 ── */
ok('turnToItems：assistant 行只在有正文或文件时才出',
  /\} else if \(hasText\(text\) \|\| outs\.length\) \{/.test(items));

console.log('\n── 小鲸空话落盘三道闸：' + pass + '/' + (pass + fail) + (fail ? ' 有失败' : ' 全过') + ' ──');
process.exit(fail ? 1 : 0);
