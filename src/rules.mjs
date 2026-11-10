// User-editable rules. Everything the model is told about *behaviour* lives here (rules/rules.md),
// so the platform can be re-tuned without touching code.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.mjs';

const RULES_FILE = join(config.root, 'rules', 'rules.md');

/**
 * 本机私有规则：只在这台机器上生效，**永远不进发布物**。
 * 发布白名单里没有这个目录，scripts/publish.mjs 还会再拦一道。
 * 放那些「只对我这份安装有意义」的规矩（比如我自己的发布习惯）。
 */
const PRIVATE_RULES_FILE = join(config.root, '.private', 'rules.local.md');

let cached = null;

export function loadRulesText() {
  if (cached) return cached;
  if (!existsSync(RULES_FILE)) {
    cached = '(rules file missing)';
    return cached;
  }
  // Strip HTML comments so the user can keep notes in the file without feeding them to the model.
  cached = readFileSync(RULES_FILE, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  return cached;
}

/** 私有规则文本；没有就是空串 */
export function loadPrivateRulesText() {
  if (!existsSync(PRIVATE_RULES_FILE)) return '';
  try {
    return readFileSync(PRIVATE_RULES_FILE, 'utf8').replace(/<!--[\s\S]*?-->/g, '').trim();
  } catch {
    return '';
  }
}

export function invalidateRules() {
  cached = null;
}

/** Auto-load (initialise cache eagerly so a broken file fails at startup, not mid-chat). */
export function rulesStatus() {
  return { path: RULES_FILE, exists: existsSync(RULES_FILE), chars: loadRulesText().length };
}
