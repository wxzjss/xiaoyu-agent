/** 给 check-factory-prompt 用：按当前进程的数据目录生成一份完整系统提示词，原样写到 stdout。
 * 下划线开头，run-all-checks 不会单独枚举它。 */
const m = await import('../src/persona.mjs');
const { enabledToolSchemas } = await import('../src/tools.mjs');
m.setToolLister(() => enabledToolSchemas());
const p = m.buildSystemPrompt({
  sessionId: '__factory__',
  safeMode: false,
  safeWord: '',
  agentId: '',
  turnSource: '',
});
process.stdout.write(p);
