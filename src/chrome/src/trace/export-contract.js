/**
 * Build the versioned JSON envelope used by the Traces page.
 *
 * A standalone export keeps the original { run, events } shape. When a
 * session ID is supplied, the same schema carries { session, runs } so
 * consumers can preserve session-level lineage without guessing whether a
 * single record was exported.
 */

export const TRACE_EXPORT_SCHEMA = 'webbrain-trace/1';

function normalizeEntries(entries) {
  if (!Array.isArray(entries)) return [];
  return entries.map((entry) => ({
    run: entry?.run && typeof entry.run === 'object' ? entry.run : {},
    events: Array.isArray(entry?.events) ? entry.events : [],
  }));
}

export function buildTraceExportPayload(
  entries,
  { sessionId = '', exportedAt = Date.now(), exportedByWebBrainVersion = '' } = {},
) {
  const normalized = normalizeEntries(entries);
  const common = {
    schema: TRACE_EXPORT_SCHEMA,
    exportedAt,
    exportedByWebBrainVersion,
  };

  if (sessionId) {
    return {
      ...common,
      session: { sessionId },
      runs: normalized,
    };
  }

  const first = normalized[0] || { run: {}, events: [] };
  return {
    ...common,
    run: first.run,
    events: first.events,
  };
}
