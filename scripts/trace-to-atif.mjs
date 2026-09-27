#!/usr/bin/env node

/**
 * Convert a Traces-page `webbrain-trace/1` JSON export to ATIF v1.7.
 *
 * This deliberately stays offline and dependency-free. Screenshots and verbose
 * diagnostic events are counted but not copied because ATIF represents images
 * as files referenced alongside the trajectory, not embedded data URLs.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SOURCE_SCHEMA = 'webbrain-trace/1';
const ATIF_SCHEMA_VERSION = 'ATIF-v1.7';

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function timestamp(value) {
  if (value == null || value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function jsonSafe(value, fallback) {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? fallback : JSON.parse(serialized);
  } catch {
    return fallback;
  }
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

function parseArguments(value) {
  if (isObject(value)) return { arguments: jsonSafe(value, {}) };
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (isObject(parsed)) return { arguments: parsed };
    } catch {}
    return {
      arguments: {},
      extra: { raw_arguments: value },
    };
  }
  if (value == null) return { arguments: {} };
  return {
    arguments: {},
    extra: { raw_arguments: String(value) },
  };
}

function resultContent(value) {
  if (value === undefined) return '(missing tool result)';
  if (typeof value === 'string') return value;
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? String(value) : serialized;
  } catch {
    return String(value);
  }
}

function usageMetrics(usage) {
  if (!isObject(usage)) return undefined;
  const extra = {};
  // WebBrain records provider-native cost. Some providers report USD, while
  // others do not guarantee a currency, so never mislabel it as ATIF cost_usd.
  const reportedCost = finiteNumber(usage.cost);
  if (reportedCost !== undefined) extra.webbrain_reported_cost = reportedCost;
  const metrics = compactObject({
    prompt_tokens: finiteNumber(usage.prompt_tokens),
    completion_tokens: finiteNumber(usage.completion_tokens),
    cached_tokens: finiteNumber(
      usage.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens,
    ),
    extra: Object.keys(extra).length ? extra : undefined,
  });
  return Object.keys(metrics).length ? metrics : undefined;
}

function eventOrder(left, right) {
  const leftSeq = finiteNumber(left?.seq) ?? Number.MAX_SAFE_INTEGER;
  const rightSeq = finiteNumber(right?.seq) ?? Number.MAX_SAFE_INTEGER;
  if (leftSeq !== rightSeq) return leftSeq - rightSeq;
  return (finiteNumber(left?.ts) ?? 0) - (finiteNumber(right?.ts) ?? 0);
}

function sameToolName(left, right) {
  return String(left || '') === String(right || '');
}

export function webbrainTraceToAtif(input) {
  if (!isObject(input)) throw new TypeError('WebBrain trace export must be an object.');
  if (input.schema !== SOURCE_SCHEMA) {
    throw new TypeError(`Expected schema "${SOURCE_SCHEMA}".`);
  }
  if (Array.isArray(input.runs)) return webbrainTraceBundleToAtif(input);
  if (!isObject(input.run)) throw new TypeError('WebBrain trace run must be an object.');
  if (!Array.isArray(input.events)) throw new TypeError('WebBrain trace events must be an array.');
  if (typeof input.run.runId !== 'string' || !input.run.runId.trim()) {
    throw new TypeError('WebBrain trace run.runId must be a non-empty string.');
  }

  const run = input.run;
  const runId = String(run.runId).trim();
  const version = String(
    run.webbrainVersion || input.exportedByWebBrainVersion || 'unknown',
  );
  const steps = [];
  const omittedEventCounts = {};
  let lastAgentMessage = '';
  let pendingAgent = null;
  const allocatedToolCallIds = new Set();

  function appendStep(step) {
    const complete = { step_id: steps.length + 1, ...compactObject(step) };
    steps.push(complete);
    return complete;
  }

  appendStep({
    timestamp: timestamp(run.startedAt),
    source: 'user',
    message: String(run.userMessage || ''),
  });

  for (const event of [...input.events].sort(eventOrder)) {
    if (!isObject(event)) continue;
    if (event.runId != null && String(event.runId) !== runId) {
      throw new TypeError(`Trace event runId "${event.runId}" does not match run.runId "${runId}".`);
    }
    const data = isObject(event.data) ? event.data : {};
    const eventSeq = finiteNumber(event.seq);

    if (event.kind === 'llm_response') {
      const toolCalls = Array.isArray(data.toolCalls)
        ? data.toolCalls.map((call, index) => {
          const parsed = parseArguments(call?.args);
          const recordedId = String(call?.id || '').trim();
          const fallbackId = `webbrain-${runId}-${eventSeq ?? 'unknown'}-${index + 1}`;
          const toolCallId = recordedId && !allocatedToolCallIds.has(recordedId)
            ? recordedId
            : fallbackId;
          allocatedToolCallIds.add(toolCallId);
          return compactObject({
            tool_call_id: toolCallId,
            function_name: String(call?.name || 'unknown_tool'),
            arguments: parsed.arguments,
            extra: parsed.extra,
          });
        })
        : [];
      const message = String(data.content || '');
      const extra = compactObject({
        webbrain_seq: eventSeq,
        webbrain_step: finiteNumber(data.step),
        phase: data.phase ? String(data.phase) : undefined,
        latency_ms: finiteNumber(data.latencyMs),
      });
      const step = appendStep({
        timestamp: timestamp(event.ts),
        source: 'agent',
        model_name: data.model ? String(data.model) : undefined,
        message,
        tool_calls: toolCalls.length ? toolCalls : undefined,
        metrics: usageMetrics(data.usage),
        llm_call_count: 1,
        extra: Object.keys(extra).length ? extra : undefined,
      });
      pendingAgent = {
        step,
        webbrainStep: finiteNumber(data.step),
        usedCallIds: new Set(),
      };
      if (message.trim()) lastAgentMessage = message.trim();
      continue;
    }

    if (event.kind === 'tool') {
      const toolName = String(data.name || 'unknown_tool');
      const pendingCall = pendingAgent?.step.tool_calls?.find((call) => (
        !pendingAgent.usedCallIds.has(call.tool_call_id)
        && sameToolName(call.function_name, toolName)
        && (
          pendingAgent.webbrainStep === undefined
          || finiteNumber(data.step) === undefined
          || pendingAgent.webbrainStep === finiteNumber(data.step)
        )
      ));
      const observationExtra = compactObject({
        latency_ms: finiteNumber(data.latencyMs),
        webbrain_seq: eventSeq,
      });
      if (pendingCall) {
        pendingAgent.usedCallIds.add(pendingCall.tool_call_id);
        if (!pendingAgent.step.observation) pendingAgent.step.observation = { results: [] };
        pendingAgent.step.observation.results.push({
          source_call_id: pendingCall.tool_call_id,
          content: resultContent(data.result),
          ...(Object.keys(observationExtra).length ? { extra: observationExtra } : {}),
        });
        continue;
      }

      const parsed = parseArguments(data.args);
      let toolCallId = `webbrain-${runId}-${eventSeq ?? steps.length + 1}-1`;
      let suffix = 2;
      while (allocatedToolCallIds.has(toolCallId)) {
        toolCallId = `webbrain-${runId}-${eventSeq ?? steps.length + 1}-${suffix}`;
        suffix += 1;
      }
      allocatedToolCallIds.add(toolCallId);
      const stepExtra = compactObject({
        webbrain_seq: eventSeq,
        webbrain_step: finiteNumber(data.step),
      });
      appendStep({
        timestamp: timestamp(event.ts),
        source: 'agent',
        message: '',
        tool_calls: [compactObject({
          tool_call_id: toolCallId,
          function_name: toolName,
          arguments: parsed.arguments,
          extra: parsed.extra,
        })],
        observation: {
          results: [{
            source_call_id: toolCallId,
            content: resultContent(data.result),
            ...(Object.keys(observationExtra).length ? { extra: observationExtra } : {}),
          }],
        },
        llm_call_count: 0,
        extra: Object.keys(stepExtra).length ? stepExtra : undefined,
      });
      pendingAgent = null;
      continue;
    }

    if (event.kind === 'error') {
      const errorExtra = compactObject({
        webbrain_seq: eventSeq,
        webbrain_step: finiteNumber(data.step),
        phase: data.phase ? String(data.phase) : undefined,
      });
      appendStep({
        timestamp: timestamp(event.ts),
        source: 'system',
        message: 'WebBrain runtime error',
        observation: {
          results: [{ content: String(data.message || 'Unknown error') }],
        },
        extra: Object.keys(errorExtra).length ? errorExtra : undefined,
      });
      pendingAgent = null;
      continue;
    }

    const kind = String(event.kind || 'unknown');
    omittedEventCounts[kind] = (omittedEventCounts[kind] || 0) + 1;
  }

  const finalContent = String(run.finalContent || '').trim();
  if (finalContent && finalContent !== lastAgentMessage) {
    appendStep({
      timestamp: timestamp(run.endedAt),
      source: 'agent',
      message: finalContent,
      extra: { webbrain_final_content: true },
    });
  }

  const agentExtra = compactObject({
    provider_id: run.providerId ? String(run.providerId) : undefined,
    provider_class: run.providerClass ? String(run.providerClass) : undefined,
    mode: run.mode ? String(run.mode) : undefined,
  });
  const rootExtra = compactObject({
    source_schema: SOURCE_SCHEMA,
    source_exported_at: timestamp(input.exportedAt),
    source_exported_by_webbrain_version: input.exportedByWebBrainVersion
      ? String(input.exportedByWebBrainVersion)
      : undefined,
    status: run.status ? String(run.status) : undefined,
    tab_url: run.tabUrl ? String(run.tabUrl) : undefined,
    tab_title: run.tabTitle ? String(run.tabTitle) : undefined,
    omitted_event_counts: Object.keys(omittedEventCounts).length
      ? omittedEventCounts
      : undefined,
  });
  const finalMetrics = compactObject({
    total_prompt_tokens: finiteNumber(run.totalInputTokens),
    total_completion_tokens: finiteNumber(run.totalOutputTokens),
    total_steps: steps.length,
  });

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: runId,
    trajectory_id: runId,
    agent: compactObject({
      name: 'webbrain',
      version,
      model_name: run.model ? String(run.model) : undefined,
      extra: Object.keys(agentExtra).length ? agentExtra : undefined,
    }),
    steps,
    final_metrics: finalMetrics,
    extra: rootExtra,
  };
}

function uniqueValues(values) {
  return [...new Set(values.filter(value => value != null && value !== ''))];
}

function summedMetric(trajectories, key) {
  const values = trajectories
    .map(({ trajectory }) => finiteNumber(trajectory.final_metrics?.[key]))
    .filter(value => value !== undefined);
  return values.length ? values.reduce((total, value) => total + value, 0) : undefined;
}

function appendBundleSteps(target, trajectory, runId, allocatedToolCallIds) {
  for (const sourceStep of trajectory.steps) {
    const remappedCallIds = new Map();
    const step = {
      ...sourceStep,
      step_id: target.length + 1,
      extra: {
        ...(sourceStep.extra || {}),
        webbrain_run_id: runId,
      },
    };
    if (Array.isArray(sourceStep.tool_calls)) {
      step.tool_calls = sourceStep.tool_calls.map((call) => {
        const originalId = String(call.tool_call_id || 'webbrain-call');
        let toolCallId = originalId;
        if (allocatedToolCallIds.has(toolCallId)) {
          const stem = `${originalId}-${runId}`;
          toolCallId = stem;
          let suffix = 2;
          while (allocatedToolCallIds.has(toolCallId)) {
            toolCallId = `${stem}-${suffix}`;
            suffix += 1;
          }
          remappedCallIds.set(originalId, toolCallId);
        }
        allocatedToolCallIds.add(toolCallId);
        return { ...call, tool_call_id: toolCallId };
      });
    }
    if (sourceStep.observation) {
      step.observation = {
        ...sourceStep.observation,
        results: Array.isArray(sourceStep.observation.results)
          ? sourceStep.observation.results.map((result) => ({
              ...result,
              ...(result.source_call_id && remappedCallIds.has(result.source_call_id)
                ? { source_call_id: remappedCallIds.get(result.source_call_id) }
                : {}),
            }))
          : sourceStep.observation.results,
      };
    }
    target.push(step);
  }
}

function webbrainTraceBundleToAtif(input) {
  const sessionId = isObject(input.session) && typeof input.session.sessionId === 'string'
    ? input.session.sessionId.trim()
    : '';
  if (!sessionId) {
    throw new TypeError('WebBrain trace bundle session.sessionId must be a non-empty string.');
  }
  if (input.runs.length === 0) {
    throw new TypeError('WebBrain trace bundle runs must be a non-empty array.');
  }

  const entries = input.runs.map((entry, index) => {
    if (!isObject(entry)) {
      throw new TypeError(`WebBrain trace bundle entry ${index} must be an object.`);
    }
    return entry;
  }).sort((left, right) => {
    const timeDelta = (finiteNumber(left.run?.startedAt) ?? 0)
      - (finiteNumber(right.run?.startedAt) ?? 0);
    if (timeDelta !== 0) return timeDelta;
    return String(left.run?.runId || '').localeCompare(String(right.run?.runId || ''));
  });

  const trajectories = entries.map((entry) => ({
    runId: String(entry.run?.runId || '').trim(),
    trajectory: webbrainTraceToAtif({
      schema: input.schema,
      exportedAt: input.exportedAt,
      exportedByWebBrainVersion: input.exportedByWebBrainVersion,
      run: entry.run,
      events: entry.events,
    }),
  }));
  const steps = [];
  const allocatedToolCallIds = new Set();
  for (const { runId, trajectory } of trajectories) {
    appendBundleSteps(steps, trajectory, runId, allocatedToolCallIds);
  }

  const models = uniqueValues(trajectories.map(({ trajectory }) => trajectory.agent.model_name));
  const providerIds = uniqueValues(trajectories.map(({ trajectory }) => trajectory.agent.extra?.provider_id));
  const providerClasses = uniqueValues(trajectories.map(({ trajectory }) => trajectory.agent.extra?.provider_class));
  const modes = uniqueValues(trajectories.map(({ trajectory }) => trajectory.agent.extra?.mode));
  const agentExtra = compactObject({
    webbrain_run_count: trajectories.length,
    provider_id: providerIds.length === 1 ? providerIds[0] : undefined,
    provider_class: providerClasses.length === 1 ? providerClasses[0] : undefined,
    mode: modes.length === 1 ? modes[0] : undefined,
  });
  const version = String(
    input.exportedByWebBrainVersion || trajectories[0].trajectory.agent.version || 'unknown',
  );

  return {
    schema_version: ATIF_SCHEMA_VERSION,
    session_id: sessionId,
    trajectory_id: sessionId,
    agent: compactObject({
      name: 'webbrain',
      version,
      model_name: models.length === 1 ? models[0] : undefined,
      extra: agentExtra,
    }),
    steps,
    final_metrics: compactObject({
      total_prompt_tokens: summedMetric(trajectories, 'total_prompt_tokens'),
      total_completion_tokens: summedMetric(trajectories, 'total_completion_tokens'),
      total_steps: steps.length,
    }),
    extra: compactObject({
      source_schema: SOURCE_SCHEMA,
      source_exported_at: timestamp(input.exportedAt),
      source_exported_by_webbrain_version: input.exportedByWebBrainVersion
        ? String(input.exportedByWebBrainVersion)
        : undefined,
      source_session_id: sessionId,
      source_run_count: trajectories.length,
      source_run_ids: trajectories.map(({ runId }) => runId),
    }),
  };
}

async function main(argv) {
  const [inputPath, outputPath] = argv;
  if (!inputPath || argv.length > 2) {
    throw new Error('Usage: node scripts/trace-to-atif.mjs <trace.json> [trajectory.json|-]');
  }
  const raw = await fs.readFile(inputPath, 'utf8');
  const trajectory = webbrainTraceToAtif(JSON.parse(raw));
  const serialized = `${JSON.stringify(trajectory, null, 2)}\n`;
  if (outputPath === '-') {
    process.stdout.write(serialized);
    return;
  }
  const destination = outputPath || path.join(
    path.dirname(inputPath),
    `${path.basename(inputPath, path.extname(inputPath))}.atif.json`,
  );
  await fs.writeFile(destination, serialized, 'utf8');
  process.stderr.write(`Wrote ${destination}\n`);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  });
}
