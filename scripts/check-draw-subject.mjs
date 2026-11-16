#!/usr/bin/env node
/**
 * check-draw-subject.mjs — 【画图插件必须真能画人物】
 *
 * 【2026-11-16 主人报】让她画鲸鱼娘，结果只出两张渐变背景 + 标题
 * （「鲸鱼娘·黄昏海边」「小鱼·鲸鱼娘」）。查出来：人物渲染器
 * （code-draw-scene.mjs 的 CHAR_SCRIPT / whalegirl / mermaid …）早就写好了，
 * 但 make_image 的参数里没有 subject、drawByCode 也从来没引用它 ——
 * 模板只会画场景和标题，所以「画人物」这件事在工具层根本不存在。
 *
 * 这个哨兵钉四件事：
 *   ① make_image 有 subject 参数，说明里提到画角色要传；
 *   ② subject 一路透传到 drawByCode；
 *   ③ drawByCode 会按人物意图切到 buildSceneHtml（不是只走模板）；
 *   ④ 人物路径的截图尺寸按画布 CSS 尺寸走（不然右边下半张全黑）。
 */
import fs from 'node:fs';
import { makeChecker } from './_harness_util.mjs';

const t = makeChecker('画图 / 人物主体');
const img = fs.readFileSync('src/tools-image.mjs', 'utf8');
const draw = fs.readFileSync('src/code-draw.mjs', 'utf8');
const feat = fs.readFileSync('src/features.mjs', 'utf8');

t.ok('make_image 声明了 subject 参数', /subject:\s*\{\s*type:\s*'string'/.test(img));
t.ok('工具说明写了「画角色必须传 subject」', /画.+人物\/角色|画角色一定要说清/.test(img));
t.ok('subject 透传给 drawByCode', /drawByCode\(\{[^}]*subject/.test(img));
t.ok('drawByCode 引了人物渲染器 buildSceneHtml', /buildSceneHtml/.test(draw));
t.ok('按人物意图切渲染器（wantsCharacter）', /function wantsCharacter/.test(draw) && /wantsCharacter\(opt\)/.test(draw));
t.ok('人物词表认得出鲸鱼娘 / 人鱼 / Q版 / chibi', /鲸鱼娘/.test(draw) && /人鱼/.test(draw) && /chibi/.test(draw));
t.ok('人物路径按画布 CSS 尺寸截图（修黑边）', /built\.char \? built\.w :/.test(draw));
t.ok('插件页「画图」卡片提到能画人物', /也能画人物\/角色/.test(feat));

t.done();
