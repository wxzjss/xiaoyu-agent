import fs from 'node:fs';
const P = 'D:/小鱼Agent/src/agent.mjs';
let s = fs.readFileSync(P, 'utf8');
const before = s.length;
const A = "        if (!limited || !cfg429.enabled) throw err;";
const i = s.indexOf(A);
if (i < 0) { console.log('ANCHOR-MISS'); process.exit(1); }
const repl = [
  "        if (!limited || !cfg429.enabled) {",
  "          // Upstream rejected the request shape (HTTP 400 / 413 / 422, invalid_argument).",
  "          // That is not a network blip and not a 429, but it is usually transient:",
  "          // one retry with the same payload succeeds most of the time. Old code threw",
  "          // straight away and killed the whole turn mid-way (2026-11-09 19:29 hit this).",
  "          const shapeBad = status === 400 || status === 413 || status === 422",
  "            || /invalid_argument|rejected the request shape/i.test(String(text_ || ''));",
  "          if (shapeBad) {",
  "            const bn = bumpStreak(sessionId + ':badshape');",
  "            if (bn <= 1) {",
  "              onEvent({ type: 'retry', reason: 'bad_shape', attempt: bn, waitMs: 1500 });",
  "              await sleep(1500);",
  "              continue;",
  "            }",
  "          }",
  "          throw err;",
  "        }"
].join("\n");
s = s.slice(0, i) + repl + s.slice(i + A.length);
fs.writeFileSync(P, s, 'utf8');
console.log('OK delta=' + (s.length - before));