// Terminal client: node src/cli.mjs "your prompt"  (streams reasoning, tools, answer)
import readline from 'node:readline';
import { runAgent, systemPrompt } from './agent.mjs';
import { activeEndpoint } from './models.mjs';

const args = process.argv.slice(2).join(' ').trim();
const history = [{ role: 'system', content: systemPrompt('cli') }];

const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  blue: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

async function turn(text) {
  history.push({ role: 'user', content: text });
  process.stdout.write('\n');
  await runAgent({
    messages: history,
    sessionId: 'cli',
    onEvent: (ev) => {
      if (ev.type === 'reasoning') process.stdout.write(C.dim(ev.text));
      else if (ev.type === 'text') process.stdout.write(ev.text);
      else if (ev.type === 'tool_start') {
        process.stdout.write(`\n${C.blue('>> ' + ev.name)} ${C.dim(String(ev.args).slice(0, 160))}\n`);
      } else if (ev.type === 'tool_end') {
        const head = ev.output.split('\n').slice(0, 6).join('\n');
        process.stdout.write((ev.ok ? C.green('  ok  ') : C.red('  err ')) + C.dim(head) + '\n');
      }
    },
  });
  process.stdout.write('\n');
}

async function main() {
  const ep = activeEndpoint();
  if (!ep.apiKey) {
    console.error('还没有可用的模型：打开界面顶部「模型」按钮填一份 API Key，或编辑 .env。');
    process.exit(1);
  }
  console.log(C.dim(`小鱼Agent | ${ep.model} | ${ep.baseURL}`));

  if (args) {
    await turn(args);
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: C.blue('you> ') });
  rl.prompt();
  for await (const line of rl) {
    const t = line.trim();
    if (t === '/exit' || t === '/quit') break;
    if (t) await turn(t);
    rl.prompt();
  }
  rl.close();
}

main().catch((err) => {
  console.error('fatal:', err?.message ?? err);
  process.exit(1);
});
