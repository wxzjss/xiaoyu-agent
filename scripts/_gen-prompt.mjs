/** 量运行时 buildSystemPrompt 真输出：正文打 stdout（check-factory-prompt 消费），同时写 _live.out（人工查验用，UTF-8）。
 *  【2026-11-15 修】必须接上 setToolLister——运行时是 agent.mjs:96 接的，这里不接的话
 *  toolBlock 直接返回空串，快照就缺「你手上有什么」整段（check-prompt-facts 连环假红）。
 *  import 必须走生效层 data\code\src（运行时真正加载的那份），仓库 src 是残缺副本。 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

const dataCode = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '小鱼Agent', 'data', 'code', 'src');
const persona = await import(pathToFileURL(path.join(dataCode, 'persona.mjs')).href);
const tools = await import(pathToFileURL(path.join(dataCode, 'tools.mjs')).href);

persona.setToolLister((sid) => tools.enabledToolSchemas(sid));
const txt = persona.buildSystemPrompt({}) ?? '';
fs.writeFileSync(new URL('./_live.out', import.meta.url), txt, 'utf8');
process.stdout.write(txt);
