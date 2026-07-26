#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

function rootEvents(events, includeContent, runStart) {
  return events.flatMap((event) => {
    const data = event?.data || {};
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

export function traceExportToOtlp(input, { includeContent = false } = {}) {
  if (!input || input.schema !== WEBBRAIN_TRACE_SCHEMA) {
    throw new Error(`Expected a ${WEBBRAIN_TRACE_SCHEMA} export.`);
  }
  if (!input.run || typeof input.run !== 'object' || Array.isArray(input.run)) {
    throw new Error('Trace export must contain a run object.');
  }
  if (!Array.isArray(input.events)) {
    throw new Error('Trace export must contain an events array.');
  }

  const run = input.run;
  const events = [...input.events]
    .filter((event) => event && typeof event === 'object')
    .sort((a, b) => finiteNumber(a.seq) - finiteNumber(b.seq));
  const eventTimes = events.map((event) => finiteNumber(event.ts)).filter((time) => time > 0);
  const fallbackStarts = [...eventTimes, finiteNumber(input.exportedAt)].filter((time) => time > 0);
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
