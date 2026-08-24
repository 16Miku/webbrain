#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TRACE_FORMAT_VERSION, isKnownKind } from '../src/chrome/src/trace/event-model.js';
import { buildTraceLineageGroups } from '../src/chrome/src/trace/lineage.js';

const WEBBRAIN_TRACE_SCHEMA = 'webbrain-trace/1';
const CONTENT_LIMIT = 20_000;
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;
const STATUS_CODE_ERROR = 2;

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function unixNano(milliseconds) {
  const micros = BigInt(Math.max(0, Math.round(finiteNumber(milliseconds) * 1000)));
  return String(micros * 1000n);
}

function stableHex(seed, length) {
  const value = createHash('sha256').update(String(seed)).digest('hex').slice(0, length);
  return /^0+$/.test(value) ? `${'0'.repeat(length - 1)}1` : value;
}

function normalizedId(value) {
  return value == null ? '' : String(value).trim();
}

function normalizedFormatVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 0) return 0;
  if (version > TRACE_FORMAT_VERSION) {
    throw new Error(
      `Unsupported trace format version ${version}; maximum supported version is ${TRACE_FORMAT_VERSION}.`,
    );
  }
  return version;
}

function normalizedRun(run) {
  return {
    ...run,
    traceFormatVersion: normalizedFormatVersion(run.traceFormatVersion),
  };
}

function normalizedEvents(events) {
  return events.filter((event) => event && typeof event === 'object');
}

function safeJson(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? '' : serialized;
  } catch {
    try {
      return String(value);
    } catch {
      return '(unserializable)';
    }
  }
}

function boundedContent(value) {
  if (value == null) return '';
  const text = typeof value === 'string' ? value : safeJson(value);
  if (text.length <= CONTENT_LIMIT) return text;
  return `${text.slice(0, CONTENT_LIMIT)}…`;
}

function anyValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value)
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (value == null || value === '') return null;
  return { stringValue: String(value) };
}

function attributes(entries) {
  return entries.flatMap(([key, value]) => {
    const encoded = anyValue(value);
    return encoded ? [{ key, value: encoded }] : [];
  });
}

function eventTime(event, fallback) {
  const value = finiteNumber(event?.ts, fallback);
  return value > 0 ? value : fallback;
}

function spanBounds(event, runStart) {
  const end = eventTime(event, runStart);
  const latency = Math.max(0, finiteNumber(event?.data?.latencyMs));
  return {
    startTimeUnixNano: unixNano(Math.max(runStart, end - latency)),
    endTimeUnixNano: unixNano(Math.max(runStart, end)),
  };
}

function failedToolResult(result) {
  if (result == null) return true;
  return typeof result === 'object' && (result.success === false || Boolean(result.error));
}

function contentAttributes(run, includeContent) {
  if (!includeContent) return [];
  return [
    ['webbrain.user.message', boundedContent(run.userMessage)],
    ['webbrain.final.response', boundedContent(run.finalContent)],
  ];
}

function genericEvent(event, includeContent, runStart) {
  const data = event?.data || {};
  return {
    timeUnixNano: unixNano(eventTime(event, runStart)),
    name: 'webbrain.unknown',
    attributes: attributes([
      ['webbrain.event.sequence', finiteNumber(event?.seq)],
      ['webbrain.event.kind', String(event?.kind || 'unknown')],
      ['webbrain.step', finiteNumber(data.step)],
      ...(includeContent ? [['webbrain.event.data', boundedContent(data)]] : []),
    ]),
  };
}

function rootEvents(events, includeContent, runStart) {
  return events.flatMap((event) => {
    const data = event?.data || {};
    if (!isKnownKind(event?.kind)) return [genericEvent(event, includeContent, runStart)];
    const base = [
      ['webbrain.event.sequence', finiteNumber(event?.seq)],
      ['webbrain.step', finiteNumber(data.step)],
    ];
    if (event?.kind === 'error') {
      return [{
        timeUnixNano: unixNano(eventTime(event, runStart)),
        name: 'exception',
        attributes: attributes([
          ...base,
          ['exception.type', data.phase ? `webbrain.${data.phase}` : 'webbrain.error'],
          ...(includeContent ? [['exception.message', boundedContent(data.message)]] : []),
        ]),
      }];
    }
    if (event?.kind === 'streaming' || event?.kind === 'note' || event?.kind === 'screenshot') {
      return [{
        timeUnixNano: unixNano(eventTime(event, runStart)),
        name: `webbrain.${event.kind}`,
        attributes: attributes([
          ...base,
          ['webbrain.event.status', data.status],
          ['webbrain.event.reason', data.reason],
          ...(includeContent && event.kind === 'note'
            ? [['webbrain.note', boundedContent(data.note)]]
            : []),
        ]),
      }];
    }
    return [];
  });
}

function inferenceSpan(event, context, includeContent) {
  const data = event.data || {};
  const model = String(data.model || context.run.model || 'unknown');
  const usage = data.usage || {};
  return {
    traceId: context.traceId,
    spanId: stableHex(`${context.run.runId}:llm_response:${event.seq}`, 16),
    parentSpanId: context.rootSpanId,
    name: `chat ${model}`,
    kind: SPAN_KIND_CLIENT,
    ...spanBounds(event, context.runStart),
    attributes: attributes([
      ['gen_ai.operation.name', 'chat'],
      ['gen_ai.provider.name', context.run.providerId],
      ['gen_ai.request.model', model],
      ['gen_ai.usage.input_tokens', usage.prompt_tokens],
      ['gen_ai.usage.output_tokens', usage.completion_tokens],
      ['webbrain.event.sequence', finiteNumber(event.seq)],
      ['webbrain.step', finiteNumber(data.step)],
      ...(includeContent
        ? [['webbrain.llm.response.content', boundedContent(data.content)]]
        : []),
    ]),
  };
}

function toolSpan(event, context, includeContent) {
  const data = event.data || {};
  const name = String(data.name || 'unknown');
  const failed = failedToolResult(data.result);
  return {
    traceId: context.traceId,
    spanId: stableHex(`${context.run.runId}:tool:${event.seq}`, 16),
    parentSpanId: context.rootSpanId,
    name: `execute_tool ${name}`,
    kind: SPAN_KIND_INTERNAL,
    ...spanBounds(event, context.runStart),
    attributes: attributes([
      ['gen_ai.operation.name', 'execute_tool'],
      ['gen_ai.tool.name', name],
      ['gen_ai.agent.name', 'WebBrain'],
      ...(failed ? [['error.type', 'tool_error']] : []),
      ['webbrain.event.sequence', finiteNumber(event.seq)],
      ['webbrain.step', finiteNumber(data.step)],
      ...(includeContent
        ? [
            ['gen_ai.tool.call.arguments', boundedContent(data.args)],
            ['gen_ai.tool.call.result', boundedContent(data.result)],
          ]
        : []),
    ]),
    ...(failed ? { status: { code: STATUS_CODE_ERROR } } : {}),
  };
}

function normalizeBundleEntry(entry, index) {
  if (!entry?.run || typeof entry.run !== 'object' || Array.isArray(entry.run)) {
    throw new Error(`Trace export bundle entry ${index} must contain a run object.`);
  }
  if (!Array.isArray(entry.events)) {
    throw new Error(`Trace export bundle entry ${index} must contain an events array.`);
  }
  return { run: normalizedRun(entry.run), events: normalizedEvents(entry.events) };
}

export function normalizeTraceExport(input) {
  if (!input || input.schema !== WEBBRAIN_TRACE_SCHEMA) {
    throw new Error(`Expected a ${WEBBRAIN_TRACE_SCHEMA} export.`);
  }
  const exported = {
    schema: input.schema,
    exportedAt: finiteNumber(input.exportedAt),
    exportedByWebBrainVersion: String(input.exportedByWebBrainVersion || ''),
  };
  if (Array.isArray(input.runs)) {
    if (input.runs.length === 0) throw new Error('Trace export must contain a non-empty runs array.');
    const runs = input.runs.map(normalizeBundleEntry);
    return {
      ...exported,
      legacy: false,
      sessionId: normalizedId(input.session?.sessionId),
      runs,
    };
  }
  if (!input.run || typeof input.run !== 'object' || Array.isArray(input.run)) {
    throw new Error('Trace export must contain a run object.');
  }
  if (!Array.isArray(input.events)) {
    throw new Error('Trace export must contain an events array.');
  }
  const run = normalizedRun(input.run);
  return {
    ...exported,
    legacy: true,
    sessionId: normalizedId(run.conversationId),
    runs: [{ run, events: normalizedEvents(input.events) }],
  };
}

function sortedEvents(events) {
  return [...events].sort((a, b) => finiteNumber(a.seq) - finiteNumber(b.seq));
}

function runBounds(run, events, exportedAt) {
  const eventTimes = events.map((event) => finiteNumber(event.ts)).filter((time) => time > 0);
  const fallbackStarts = [...eventTimes, finiteNumber(exportedAt)].filter((time) => time > 0);
  const initialStart = finiteNumber(
    run.startedAt,
    fallbackStarts.length ? Math.min(...fallbackStarts) : 0,
  );
  const childStarts = events.map((event) => (
    eventTime(event, initialStart) - Math.max(0, finiteNumber(event?.data?.latencyMs))
  ));
  const runStart = Math.max(0, Math.min(initialStart, ...childStarts));
  const runEnd = Math.max(
    runStart,
    finiteNumber(run.endedAt),
    runStart + Math.max(0, finiteNumber(run.durationMs)),
    ...eventTimes,
  );
  return { runStart, runEnd };
}

function sessionIdForRun(run, bundleSessionId, index) {
  return normalizedId(run.conversationId)
    || normalizedId(bundleSessionId)
    || `run:${normalizedId(run.runId) || index}`;
}

function buildLineageRecords(bundle) {
  const records = bundle.runs.map(({ run, events }, index) => {
    const sessionId = sessionIdForRun(run, bundle.sessionId, index);
    return {
      index,
      run: { ...run, conversationId: sessionId },
      events: sortedEvents(events),
      runId: normalizedId(run.runId),
      sessionId,
      parentRunId: normalizedId(run.parentRunId),
      parentSessionId: normalizedId(run.parentSessionId),
      lineageState: 'root',
      parent: null,
      crossSessionParent: null,
      spanId: '',
    };
  });
  const lineage = buildTraceLineageGroups(records.map(record => record.run));
  const nodesByIndex = new Map(
    lineage.groups.flatMap(group => group.nodes).map(node => [node.index, node]),
  );
  const nodesByKey = new Map(
    lineage.groups.flatMap(group => group.nodes).map(node => [node.key, node]),
  );
  const byRunId = new Map();
  for (const record of records) {
    if (!record.runId) continue;
    const matches = byRunId.get(record.runId) || [];
    matches.push(record);
    byRunId.set(record.runId, matches);
  }
  for (const record of records) {
    const node = nodesByIndex.get(record.index);
    record.lineageState = node?.lineageState || 'root';
    if (node?.parentKey) record.parent = records[nodesByKey.get(node.parentKey)?.index];
    if (record.lineageState === 'missing-parent'
      && record.parentSessionId
      && record.parentSessionId !== record.sessionId) {
      record.lineageState = 'cross-session-parent';
      record.crossSessionParent = { sessionId: record.parentSessionId, parent: null };
    }
    if (record.lineageState === 'cross-session-parent') {
      const candidates = byRunId.get(record.parentRunId) || [];
      if (candidates.length === 1) {
        record.crossSessionParent = {
          sessionId: record.parentSessionId || candidates[0].sessionId,
          parent: candidates[0],
        };
      }
    }
  }
  const counts = new Map();
  for (const record of records) {
    if (record.runId) counts.set(record.runId, (counts.get(record.runId) || 0) + 1);
  }
  const occurrences = new Map();
  for (const record of records) {
    const occurrence = occurrences.get(record.runId) || 0;
    occurrences.set(record.runId, occurrence + 1);
    const suffix = counts.get(record.runId) > 1 ? `:duplicate:${occurrence}` : '';
    record.spanId = stableHex(`webbrain:run:${record.runId || record.index}${suffix}`, 16);
  }
  return records;
}

function bundleEvent(event, includeContent, runStart) {
  const data = event?.data || {};
  const kind = String(event?.kind || 'unknown');
  const base = [
    ['webbrain.event.sequence', finiteNumber(event?.seq)],
    ['webbrain.event.kind', kind],
    ['webbrain.step', finiteNumber(data.step)],
  ];
  let name = isKnownKind(kind) ? `webbrain.${kind}` : 'webbrain.unknown';
  const extra = [];
  if (kind === 'error') {
    name = 'exception';
    extra.push(['exception.type', data.phase ? `webbrain.${data.phase}` : 'webbrain.error']);
    if (includeContent) extra.push(['exception.message', boundedContent(data.message)]);
  } else if (kind === 'llm_response') {
    extra.push(
      ['gen_ai.request.model', data.model],
      ['gen_ai.usage.input_tokens', data.usage?.prompt_tokens],
      ['gen_ai.usage.output_tokens', data.usage?.completion_tokens],
    );
    if (includeContent) extra.push(['webbrain.llm.response.content', boundedContent(data.content)]);
  } else if (kind === 'tool') {
    const failed = failedToolResult(data.result);
    extra.push(['gen_ai.tool.name', data.name], ...(failed ? [['error.type', 'tool_error']] : []));
    if (includeContent) {
      extra.push(
        ['gen_ai.tool.call.arguments', boundedContent(data.args)],
        ['gen_ai.tool.call.result', boundedContent(data.result)],
      );
    }
  } else if (kind === 'streaming' || kind === 'note') {
    extra.push(['webbrain.event.status', data.status], ['webbrain.event.reason', data.reason]);
    if (includeContent && kind === 'note') extra.push(['webbrain.note', boundedContent(data.note)]);
  }
  if (!isKnownKind(kind) && includeContent) extra.push(['webbrain.event.data', boundedContent(data)]);
  return {
    timeUnixNano: unixNano(eventTime(event, runStart)),
    name,
    attributes: attributes([...base, ...extra]),
  };
}

function bundleEvents(events, includeContent, runStart) {
  return events.map((event) => bundleEvent(event, includeContent, runStart));
}

function lineageAttributes(record) {
  return [
    ['webbrain.trace.format.version', record.run.traceFormatVersion],
    ['webbrain.parent.run.id', record.parentRunId],
    ['webbrain.parent.session.id', record.parentSessionId],
    ...(record.lineageState !== 'root' && record.lineageState !== 'attached'
      ? [['webbrain.lineage.state', record.lineageState]]
      : []),
  ];
}

function sessionTraceId(sessionId) {
  return stableHex(`webbrain:session:${sessionId}`, 32);
}

function bundleRunSpan(record, bundle, includeContent) {
  const { runStart, runEnd } = runBounds(record.run, record.events, bundle.exportedAt);
  const hasError = ['error', 'failed', 'loop_stopped'].includes(String(record.run.status || '').toLowerCase())
    || record.events.some((event) => event.kind === 'error');
  const span = {
    traceId: sessionTraceId(record.sessionId),
    spanId: record.spanId,
    name: `invoke_agent ${record.run.runId || `run-${record.index}`}`,
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: unixNano(runStart),
    endTimeUnixNano: unixNano(runEnd),
    attributes: attributes([
      ['gen_ai.operation.name', 'invoke_agent'],
      ['gen_ai.agent.name', 'WebBrain'],
      ['gen_ai.agent.version', record.run.webbrainVersion || bundle.exportedByWebBrainVersion],
      ['gen_ai.provider.name', record.run.providerId],
      ['gen_ai.request.model', record.run.model],
      ['gen_ai.conversation.id', record.sessionId],
      ['gen_ai.usage.input_tokens', record.run.totalInputTokens],
      ['gen_ai.usage.output_tokens', record.run.totalOutputTokens],
      ['webbrain.run.id', record.run.runId],
      ['webbrain.run.status', record.run.status],
      ...lineageAttributes(record),
      ...contentAttributes(record.run, includeContent),
    ]),
    events: bundleEvents(record.events, includeContent, runStart),
    ...(record.parent ? { parentSpanId: record.parent.spanId } : {}),
    ...(hasError ? { status: { code: STATUS_CODE_ERROR } } : {}),
  };
  if (record.crossSessionParent) {
    const { parent, sessionId } = record.crossSessionParent;
    span.links = [{
      traceId: sessionTraceId(sessionId),
      spanId: parent?.spanId || stableHex(`webbrain:run:${record.parentRunId}`, 16),
      attributes: attributes([
        ['webbrain.parent.run.id', record.parentRunId],
        ['webbrain.parent.session.id', sessionId],
      ]),
    }];
  }
  return span;
}

function sessionBundleToOtlp(bundle, includeContent) {
  const records = buildLineageRecords(bundle);
  const groups = new Map();
  for (const record of records) {
    const group = groups.get(record.sessionId) || [];
    group.push(record);
    groups.set(record.sessionId, group);
  }
  return {
    resourceSpans: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sessionId, sessionRecords]) => ({
      resource: {
        attributes: attributes([
          ['service.name', 'webbrain'],
          ['service.version', bundle.exportedByWebBrainVersion],
          ['webbrain.session.id', sessionId],
        ]),
      },
      scopeSpans: [{
        scope: {
          name: 'webbrain.trace-export',
          ...(bundle.exportedByWebBrainVersion
            ? { version: String(bundle.exportedByWebBrainVersion) }
            : {}),
        },
        spans: sessionRecords
          .sort((a, b) => (finiteNumber(a.run.startedAt) - finiteNumber(b.run.startedAt)) || a.runId.localeCompare(b.runId))
          .map(record => bundleRunSpan(record, bundle, includeContent)),
      }],
    })),
  };
}

export function traceExportToOtlp(input, { includeContent = false } = {}) {
  const bundle = normalizeTraceExport(input);
  if (!bundle.legacy) return sessionBundleToOtlp(bundle, includeContent);

  const [{ run, events: rawEvents }] = bundle.runs;
  const events = sortedEvents(rawEvents);
  const { runStart, runEnd } = runBounds(run, events, bundle.exportedAt);
  const traceId = stableHex(`webbrain:${run.runId || runStart}`, 32);
  const rootSpanId = stableHex(`webbrain:${run.runId || runStart}:root`, 16);
  const context = { run, runStart, traceId, rootSpanId };
  const hasError = ['error', 'failed', 'loop_stopped'].includes(String(run.status || '').toLowerCase())
    || events.some((event) => event.kind === 'error');

  const root = {
    traceId,
    spanId: rootSpanId,
    name: 'invoke_agent WebBrain',
    kind: SPAN_KIND_INTERNAL,
    startTimeUnixNano: unixNano(runStart),
    endTimeUnixNano: unixNano(runEnd),
    attributes: attributes([
      ['gen_ai.operation.name', 'invoke_agent'],
      ['gen_ai.agent.name', 'WebBrain'],
      ['gen_ai.agent.version', run.webbrainVersion || input.exportedByWebBrainVersion],
      ['gen_ai.provider.name', run.providerId],
      ['gen_ai.request.model', run.model],
      ['gen_ai.conversation.id', run.conversationId],
      ['gen_ai.usage.input_tokens', run.totalInputTokens],
      ['gen_ai.usage.output_tokens', run.totalOutputTokens],
      ['webbrain.run.id', run.runId],
      ['webbrain.run.status', run.status],
      ...contentAttributes(run, includeContent),
    ]),
    events: rootEvents(events, includeContent, runStart),
    ...(hasError ? { status: { code: STATUS_CODE_ERROR } } : {}),
  };
  const childSpans = events.flatMap((event) => {
    if (event.kind === 'llm_response') return [inferenceSpan(event, context, includeContent)];
    if (event.kind === 'tool') return [toolSpan(event, context, includeContent)];
    return [];
  });

  return {
    resourceSpans: [{
      resource: {
        attributes: attributes([
          ['service.name', 'webbrain'],
          ['service.version', run.webbrainVersion || input.exportedByWebBrainVersion],
        ]),
      },
      scopeSpans: [{
        scope: {
          name: 'webbrain.trace-export',
          ...(input.exportedByWebBrainVersion
            ? { version: String(input.exportedByWebBrainVersion) }
            : {}),
        },
        spans: [root, ...childSpans],
      }],
    }],
  };
}

export function parseTraceToOtlpArgs(argv) {
  const parsed = { input: '', output: '', includeContent: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--include-content') {
      parsed.includeContent = true;
    } else if (arg === '--output') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --output.');
      parsed.output = value;
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else if (!parsed.input) {
      parsed.input = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }
  if (!parsed.input) throw new Error('Missing input trace JSON path.');
  return parsed;
}

function runCli() {
  try {
    const args = parseTraceToOtlpArgs(process.argv.slice(2));
    const input = JSON.parse(readFileSync(args.input, 'utf8'));
    const output = `${JSON.stringify(
      traceExportToOtlp(input, { includeContent: args.includeContent }),
      null,
      2,
    )}\n`;
    if (args.output) {
      writeFileSync(args.output, output);
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    console.error(`trace-to-otlp: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
