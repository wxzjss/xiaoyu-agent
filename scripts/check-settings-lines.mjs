import fs from "node:fs";

/**
 * 底线/安全词这类字符串数组字段，不许被脏数据洗光、不许存成 "[object Object]"。
 *
 * 【为什么要有这个】（2026-11-06 实测踩到两回）
 * ① POST /api/settings 传 [{text,color}] 这种对象数组，服务端 String(x) 之后
 *    全变 "[object Object]"，把主人 15 条底线整个盖掉，界面上剩一行怪字。
 * ② 传 [{a:1}, null, {}] 全是脏数据，洗完剩 []，于是静默清空 —— 一条不剩。
 *
 * 修法：settings.mjs 里读写全走 normalizeLines()；写入侧再加一道 ——
 * 「传进来的数组有东西、洗完却是空的」直接 400，不当成主人主动清空。
 *
 * 这个脚本守 5 件事：
 *   ① 源码里不许再有裸的 String(x).trim 处理这两个字段
 *   ② normalizeLines 各种输入的返回必须对
 *   ③ normalize() 遇到「非空但全脏」的数组必须抛错，不能静默清空
 *   ④ normalize() 遇到「真空数组」要放行（主人删光是正当操作）
 *   ⑤ 生效目录那份也必须带着这一套
 */

const SRC = "D:/小鱼Agent/src/settings.mjs";
const LIVE = "C:/Users/35453/AppData/Roaming/小鱼Agent/data/code/src/settings.mjs";

let fail = 0;
const ok = (c, m) => { if (c) console.log("  ✔ " + m); else { console.log("  ✘ " + m); fail++; } };

function grab(src, name) {
  const i0 = src.indexOf("function " + name + "(");
  if (i0 < 0) return null;
  let depth = 0;
  for (let j = src.indexOf("{", i0); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (depth === 0) return src.slice(i0, j + 1); }
  }
  return null;
}

console.log("=== 1. 源码不许再有裸的 String(x).trim ===");
const src = fs.readFileSync(SRC, "utf8");
const bare = src.match(/String\([xs]\)\.trim/g) || [];
ok(bare.length === 0, `裸 String(x).trim 出现 ${bare.length} 次（应为 0）`);

console.log("=== 2. normalizeLines 行为 ===");
ok(/function normalizeLines\(list\)/.test(src), "有 normalizeLines 定义");
const nlSrc = grab(src, "normalizeLines");
if (!nlSrc) { console.log("  ✘ 抠不到"); fail++; }
else {
  const fn = new Function("return " + nlSrc)();
  ok(JSON.stringify(fn(["a", " b "])) === JSON.stringify(["a", "b"]), "字符串：trim 后保留");
  ok(JSON.stringify(fn([{ text: "x" }])) === JSON.stringify(["x"]), "对象带 text：取 text");
  ok(JSON.stringify(fn([null, 123, {}, ""])) === JSON.stringify([]), "垃圾值：全丢");
  ok(JSON.stringify(fn(null)) === JSON.stringify([]), "非数组：返回空");
  ok(!JSON.stringify(fn([{ text: "x" }, { a: 1 }])).includes("object Object"), "绝不产出 [object Object]");
}

console.log("=== 3. 全脏的数组必须拦下，不能静默清空 ===");
ok(/input\.bottomLines\.length/.test(src), "源码里有「原数组非空」的判断");
ok(/为免把原有底线清光/.test(src), "有对应的 400 报错文案");
const throwsOnDirty = /if \(!clean\.length && input\.bottomLines\.length\)/.test(src);
ok(throwsOnDirty, "`洗空但原本非空` → 抛错（不是静默存空）");

console.log("=== 4. 真空数组要放行（主人删光是正当的）===");
ok(/bottomLines = clean;/.test(src), "洗完的 clean 会赋回 bottomLines（空数组也走得通）");
ok(!/if \(!clean\.length \&\& true\)/.test(src), "没有写成「只要空就报错」");

console.log("=== 5. 生效那份也必须带着 ===");
const live = fs.readFileSync(LIVE, "utf8");
ok(/function normalizeLines\(list\)/.test(live), "生效那份有 normalizeLines");
ok(/为免把原有底线清光/.test(live), "生效那份有脏数据拦截");
ok((live.match(/String\([xs]\)\.trim/g) || []).length === 0, "生效那份没有裸 String(x).trim");

console.log("");
if (fail) { console.log(`✘ ${fail} 处不对`); process.exit(1); }
console.log("✔ 底线/安全词不会被脏数据洗光");
