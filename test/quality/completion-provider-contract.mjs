// Deterministic provider fixtures must obey the same advertised recovery
// contract as a model. Never turn an unavailable success into a passing partial.
export function conformFixtureCompletionCall(input, call, recovery) {
  if (call.name !== 'done') return call;
  const tools = (input.tools || []).map(tool => tool.function || tool);
  const done = tools.find(tool => tool.name === 'done');
  const outcomes = done?.parameters?.properties?.outcome?.enum;
  if (Array.isArray(outcomes) && outcomes.includes(call.args.outcome)) return call;
  if ((recovery.reads || 0) >= 2) throw new Error('Completion fixture exhausted read-only recovery; no success or action retry is authorized.');
  const read = tools.find(tool => tool.name === 'get_accessibility_tree')
    || tools.find(tool => tool.name === 'read_page');
  if (!read) throw new Error('Completion fixture has no advertised outcome or read-only recovery tool.');
  recovery.reads = (recovery.reads || 0) + 1;
  return read.name === 'get_accessibility_tree'
    ? { name: read.name, args: { filter: 'all' } }
    : { name: read.name, args: { limit: 2000 } };
}
