import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

for (const browser of ['chrome', 'firefox']) {
  const prefix = path.join(ROOT, 'src', browser, 'src');
  const { BaseLLMProvider } = await import(pathToFileURL(path.join(prefix, 'providers', 'base.js')).href);

  assert.equal(new BaseLLMProvider({}).maxOutputTokens, 4096, `${browser}: legacy output fallback changed`);
  assert.equal(new BaseLLMProvider({ maxOutputTokens: 32768 }).maxOutputTokens, 32768, `${browser}: configured output budget ignored`);

  const manager = fs.readFileSync(path.join(prefix, 'providers', 'manager.js'), 'utf8');
  const openai = manager.slice(manager.indexOf('      openai: {'), manager.indexOf('      anthropic: {'));
  assert.match(openai, /contextWindow: 272000/, `${browser}: OpenAI context window should default to the standard-price 272k threshold`);
  assert.match(openai, /maxOutputTokens: 128000/, `${browser}: OpenAI output budget should be 128k`);

  const anthropic = manager.slice(manager.indexOf('      anthropic: {'), manager.indexOf('      gemini: {'));
  assert.match(anthropic, /contextWindow: 1000000/, `${browser}: Anthropic context window should be 1M`);
  assert.match(anthropic, /maxOutputTokens: 128000/, `${browser}: Anthropic output budget should be 128k`);

  const deepseek = manager.slice(manager.indexOf('deepseek: {'), manager.indexOf('xai: {'));
  assert.match(deepseek, /contextWindow: 1000000/, `${browser}: DeepSeek context window should be 1M`);
  assert.match(deepseek, /maxOutputTokens: 384000/, `${browser}: DeepSeek output budget should be 384k`);
  assert.match(manager, /DUPLICATE_BLANK_CONFIG_KEYS[\s\S]*?'maxOutputTokens'/, `${browser}: duplicate providers should not inherit the output override`);

  const settings = fs.readFileSync(path.join(prefix, 'ui', 'settings.js'), 'utf8');
  assert.match(settings, /const MAX_OUTPUT_TOKENS_FIELD = \{[\s\S]*?key: 'maxOutputTokens'/, `${browser}: max output field missing`);
  assert.match(settings, /if \(!keys\.has\('contextWindow'\)\) definition\.fields\.push\(CONTEXT_WINDOW_FIELD\)/, `${browser}: context window is not exposed globally`);
  assert.match(settings, /if \(!keys\.has\('maxOutputTokens'\)\) definition\.fields\.push\(MAX_OUTPUT_TOKENS_FIELD\)/, `${browser}: max output is not exposed globally`);

  const agent = fs.readFileSync(path.join(prefix, 'agent', 'agent.js'), 'utf8');
  assert.match(agent, /const mainMaxTokens = this\._providerMaxOutputTokens\(provider\)/, `${browser}: provider output budget is not resolved`);
  assert.match(agent, /maxTokens: mainMaxTokens/, `${browser}: main generation ignores the provider output budget`);
  assert.doesNotMatch(agent, /const chatOpts = \{ tools:[^\n]+maxTokens: 4096 \}/, `${browser}: main generation still hard-codes 4k`);
}

console.log('provider model limit tests passed');
