import assert from 'node:assert/strict';
import { test } from 'node:test';

for (const browser of ['chrome', 'firefox']) {
  const { OpenAICompatibleProvider } = await import(
    new URL(`../src/${browser}/src/providers/openai.js`, import.meta.url)
  );
  const compat = await import(
    new URL(`../src/${browser}/src/providers/provider-compatibility.js`, import.meta.url)
  );

  test(`${browser}: OpenRouter Ling 3 Flash VL supports vision`, () => {
    const provider = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'inclusionai/ling-3.0-flash-vl',
    });

    assert.equal(provider.supportsVision, true);
  });

  test(`${browser}: OpenRouter Ling vision covers variants but not text-only checkpoints`, () => {
    assert.equal(compat.isOpenRouterLingVisionModel('inclusionai/ling-3.0-flash-vl:free'), true);
    assert.equal(compat.isOpenRouterLingVisionModel('ling-3.0-flash-vl'), true);
    assert.equal(compat.isOpenRouterLingVisionModel('inclusionai/ling-3.0-flash'), false);
    assert.equal(compat.isOpenRouterLingVisionModel('inclusionai/ling-2.6-1t'), false);

    const textOnly = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'inclusionai/ling-3.0-flash',
    });
    assert.equal(textOnly.supportsVision, false);
  });

  test(`${browser}: OpenRouter Nex N2.5 mini reports native tools as unsupported`, () => {
    const provider = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'nex-agi/nex-n2.5-mini:free',
    });

    assert.equal(provider.supportsTools, false);
  });

  test(`${browser}: OpenRouter Nex mini detection covers routing and snapshot suffixes`, () => {
    assert.equal(compat.isOpenRouterNexN25MiniModel('nex-agi/nex-n2.5-mini'), true);
    assert.equal(compat.isOpenRouterNexN25MiniModel('nex-agi/nex-n2.5-mini:nitro'), true);
    assert.equal(compat.isOpenRouterNexN25MiniModel('nex-agi/nex-n2.5-mini-20260908'), true);
    assert.equal(compat.isOpenRouterNexN25MiniModel('nex-agi/nex-n2.5-pro'), false);

    const snapshot = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'nex-agi/nex-n2.5-mini-20260908',
    });
    assert.equal(snapshot.supportsTools, false);
  });

  test(`${browser}: OpenRouter capability overrides take precedence over model defaults`, () => {
    const toolsForcedOn = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'nex-agi/nex-n2.5-mini',
      toolsMode: 'on',
    });
    const toolsForcedOff = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'nex-agi/nex-n2.5-pro',
      toolsMode: 'off',
    });
    const visionForcedOff = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'inclusionai/ling-3.0-flash-vl',
      visionMode: 'off',
    });
    const visionForcedOn = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'nex-agi/nex-n2.5-mini',
      visionMode: 'on',
    });
    const legacyVisionOff = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'inclusionai/ling-3.0-flash-vl',
      supportsVision: false,
    });

    assert.equal(toolsForcedOn.supportsTools, true);
    assert.equal(toolsForcedOff.supportsTools, false);
    assert.equal(visionForcedOff.supportsVision, false);
    assert.equal(visionForcedOn.supportsVision, true);
    assert.equal(legacyVisionOff.supportsVision, false);
  });

  test(`${browser}: other OpenRouter Nex models retain native tools`, () => {
    const provider = new OpenAICompatibleProvider({
      providerName: 'openrouter',
      model: 'nex-agi/nex-n2.5-pro',
    });

    assert.equal(provider.supportsTools, true);
  });
}
