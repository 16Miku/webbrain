# Trace format compatibility

WebBrain trace data has three independent version layers:

- `DB_VERSION` describes IndexedDB object-store structure and changes only when
  stores or indexes change.
- `traceFormatVersion` describes the meaning of a persisted run and its event
  log. New optional fields and new event kinds are additive and remain at the
  current version. Bump this value only when an existing meaning changes, a
  field becomes required, or `seq`/`ts` semantics change.
- `schema` describes the JSON export envelope. `webbrain-trace/1` remains the
  envelope for additive run and event changes. A new schema is reserved for a
  container-shape or semantic break.

## Reader obligations

Treat a missing or malformed `traceFormatVersion` as the legacy baseline. Keep
missing optional fields harmless. Reject a numeric `traceFormatVersion` newer
than the latest version the reader supports instead of interpreting `seq` and
`ts` with older semantics. Readers must not fail an entire export because one
event kind is unknown:

- the Traces UI shows a labeled placeholder with the raw event view;
- machine-readable exporters preserve an unknown event as a generic record with
  its event kind;
- the Markdown summary may omit unknown event details, but reports the count.

Raw JSON re-export keeps the original fields. Compatibility handling does not
perform destructive migration and does not change the default privacy policy.

## Session bundles

The existing single-run `webbrain-trace/1` shape remains valid. A session bundle
may carry a `session` identity and a `runs` array containing `{ run, events }`
entries. Session-aware consumers use persisted `conversationId`, `parentRunId`,
and `parentSessionId` values; they do not infer lineage from in-memory state.
