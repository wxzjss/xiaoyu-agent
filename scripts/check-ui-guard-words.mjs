/**
 * 【护栏取舍的检查】—— 钉住「该拦的拦住、不该拦的别误伤」
 *
 * 2026-11-10 我在同一个地方翻过两次车，都是**只在脑子里权衡、没写测试**：
 *   翻车 1：为了补「英文界面零拦截」，往 DANGER_WORDS 里加了
 *           `delete|remove|format|clear|uninstall` ——
 *           结果点「Format Document」（VS Code 格式化当前文件）、
 *           点「Remove from favorites」（收藏夹）全被拦，功能没法用。
 *   翻车 2：改成只查窗口标题 → 文件名里带危险词的窗口全被拦。
 *           `snap.title` 是根窗口标题，含文件名，所以打开 `delete.ts` /
 *           `remove_old.py`，整个窗口所有按钮（保存、运行、切标签）都要确认。
 *
 * 两次都是「用一条规则覆盖两种语义」。现在规则定型成：
 *   · **控件名**只认中文（中文「删除/格式化」在控件名里几乎不误判）
 *   · **窗口标题**要求「动作词 + 对象词」同时出现（`delete file` ✔ / `delete.ts` ✘）
 * 这份脚本就是那个取舍的可执行版本。**谁要改规则，先让这里全绿。**
 *
 * 跑法：node scripts/check-ui-guard-words.mjs
 */
import { checkGuard } from '../src/ui-guard.mjs';

let pass = 0;
const fails = [];
const t = (name, cond, detail = '') => {
  if (cond) { pass += 1; console.log('  [ok] ' + name + (detail ? '   ' + detail : '')); }
  else { fails.push(name + (detail ? '  ' + detail : '')); console.log('  [!!] ' + name + (detail ? '   ' + detail : '')); }
};

const click = (btnName, title, app = 'app') =>
  checkGuard({ tool: 'ui_click', el: { name: btnName }, snap: { app, title } });
const asked = (r) => Boolean(r && r.needAsk);

console.log('=== A. 该拦的必须拦住（漏拦 = 主人东西被删） ===');
/* 第 1 类：系统级删除动作（标题即动作） */
for (const title of ['Delete File', 'Empty Trash', '删除文件夹', '清空回收站', '卸载 微信', 'Delete Folder']) {
  t('窗口「' + title + '」里点 OK → 拦', asked(click('OK', title)), '');
}
/* 第 3 类：确认框语境（只有动作没有对象，但最该拦） */
for (const title of ['确认删除', '确认清空？', 'Confirm Delete', 'Delete file?']) {
  t('确认框「' + title + '」里点 OK → 拦', asked(click('OK', title)), '');
}
/* 第 2 类：通用软件的危险菜单（按 app 判，标题是文件名）
 * 注意：无歧义的单词（Delete/Uninstall/Erase）单词就拦；
 * 有歧义的（Remove/Clear/Format）**必须带宾语**才拦 —— 见 ui-guard 里 DANGER_BTN_IN_APP 的注释 */
for (const [btn, app] of [
  ['Delete', 'code'],
  ['Uninstall', 'explorer'],
  ['Delete Layer', 'photoshop'],
  ['Remove file', 'totalcmd'],
  ['Clear history', 'explorer'],
]) {
  t(app + ' 里点「' + btn + '」→ 拦', asked(click(btn, 'main.ts - ' + app, app)), '');
}
/* 控件名类：中文危险词 */
for (const btn of ['删除', '清空', '格式化', '卸载']) {
  t('点控件「' + btn + '」（普通窗口）→ 拦', asked(click(btn, 'Notepad', 'notepad')), '');
}
/* 键盘组合里有危险键 */
for (const keys of ['Ctrl+Delete', 'Shift+Delete', 'Ctrl+Backspace']) {
  t('按 ' + keys + ' → 拦',
    asked(checkGuard({ tool: 'ui_key', text: keys, snap: { app: 'x', title: 'Notepad' } })), '');
}

console.log('');
console.log('=== B. 不该拦的别误伤（误伤 = 功能没法用） ===');
/* 文件名里带危险词 —— 这是最容易踩的坑，实测踩过两次 */
for (const [title, app] of [
  ['delete.ts - Visual Studio Code', 'code'],
  ['remove_old_data.py - Code', 'code'],
  ['clear_cache.rs - Code', 'code'],
  ['format_disk.md - Typora', 'typora'],
  ['uninstall_guide.txt - 记事本', 'notepad'],
]) {
  t('文件名带词的窗口「' + title + '」点 OK → 放', !asked(click('OK', title, app)), '');
}
/* 通用软件里的无害按钮（在 app 名单里，但按钮名不是删除动作） */
for (const [btn, app] of [
  ['Format Document', 'code'],
  ['Remove from favorites', 'explorer'],
  ['Clear Console', 'code'],
  ['Save', 'code'],
  ['Run', 'code'],
]) {
  t(app + ' 里点「' + btn + '」→ 放', !asked(click(btn, 'x.ts - ' + app, app)), '');
}
/* 普通程序里的保存/确定 */
for (const [btn, title, app] of [['OK', 'Notepad', 'notepad'], ['Save', 'Photos', 'photos'], ['确定', '记事本', 'notepad'], ['Apply', 'Settings', 'systemsettings']]) {
  t('点「' + btn + '」在「' + title + '」→ 放', !asked(click(btn, title, app)), '');
}

console.log('');
console.log('=== C. 文案要通顺（拼接出来的话别读着别扭） ===');
const r1 = click('OK', 'Delete File', 'explorer');
t('拒绝理由不是「是在干掉东西的」这种病句',
  r1.needAsk && !/是.*的，/.test(String(r1.reason)) || /在删东西，/.test(String(r1.reason)),
  String(r1.reason).slice(0, 50));
const r2 = click('OK', '', 'Explorer');
t('窗口没标题时不留空括号', !/（）|\(\s*\)/.test(String(r2.reason || '')), String(r2.reason || '').slice(0, 50));

console.log('');
console.log('────────────────────────────────');
if (!fails.length) {
  console.log('断言：' + pass + '/' + pass + '   全部通过');
  console.log('PASS 该拦的拦住、不该拦的放行（规则改动必须先让这里全绿）');
  process.exit(0);
}
console.log('断言：' + (pass) + '/' + (pass + fails.length) + '   有失败');
for (const f of fails) console.log('  ✘ ' + f);
console.log('FAIL 护栏取舍被改坏了 —— 要么漏拦（会丢东西），要么误伤（没法用）');
process.exit(1);
