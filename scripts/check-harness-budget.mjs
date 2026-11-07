/** 上下文预算：纯函数、分档边界、绝不改写输入。 */
import { makeChecker } from './_harness_util.mjs';
import { assess, levelHint, windowAdvice, TIERS, CRITICAL_RATIO } from '../src/harness/context-budget.mjs';

const t = makeChecker('harness / context-budget');

t.ok('五档量线', TIERS.length === 5 && TIERS[0] === 0.3 && TIERS[4] === 0.7);
t.ok('保命线 93%', CRITICAL_RATIO === 0.93);

const at = (pct) => assess({ prompt_tokens: Math.round(100000 * pct) }, 100000);
t.ok('0% 不压', !at(0).shouldCompact && at(0).level === 0);
t.ok('29% 第 0 档', at(0.29).level === 0);
t.ok('30% 第 1 档', at(0.30).level === 1);
t.ok('70% 第 5 档且该压', at(0.70).level === 5 && at(0.70).shouldCompact);
t.ok('93% 保命线 critical', at(0.93).critical);
t.ok('超过 100% 夹到 1', at(1.5).ratio === 1 && at(1.5).critical);
t.ok('budget 为 0 不炸、不压', !assess({ prompt_tokens: 10 }, 0).shouldCompact);
t.ok('空 usage 不炸', !assess(null, 100000).shouldCompact);

// 纯函数：冻结对象不能被改
const frozen = Object.freeze({ prompt_tokens: 75000, completion_tokens: 12 });
const before = JSON.stringify(frozen);
const r = assess(frozen, 100000);
t.ok('输入对象一个字段都没被改', JSON.stringify(frozen) === before);
t.ok('返回值是新对象', r !== frozen);
const msgs = Object.freeze([{ role: 'user', content: 'x' }]);
windowAdvice({ turnCount: 10, ratio: 0.8 });
t.ok('不碰任何 messages（无副作用）', msgs.length === 1 && msgs[0].content === 'x');

t.ok('宽裕时不裁历史', windowAdvice({ turnCount: 10, ratio: 0.1 }).trim === 0);
t.ok('吃紧时给出裁剪建议', windowAdvice({ turnCount: 10, ratio: 0.8 }).keep < 10);
t.ok('至少保留 keepMin 条', windowAdvice({ turnCount: 10, ratio: 0.99, keepMin: 4 }).keep >= 4);
t.ok('levelHint 不越界', typeof levelHint(99) === 'string' && levelHint(-1) === '');

t.done();
