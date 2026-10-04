# Trace format compatibility

WebBrain's trace data has three independent version layers:

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

Tool events may include an optional `data.outcome` summary containing bounded dispatch, application, provider, error, and CAPTCHA-gate diagnostics. In lossless recordings, this summary survives the content-budget marker, while answer tokens, cookies, provider keys, and form inputs are excluded from the summary. Readers should still honor `_truncated` and `losslessBudgetOmitted`; the summary does not reconstruct discarded content.

`/export --traces --full` exports the stored conversation through the existing `webbrain-trace/1` session envelope, including stored screenshots. It adds no Markdown preview or turn-count truncation. Recording-time omissions and privacy projections remain explicit. The side panel reads the shared trace database and assembles the download locally; only the session identity crosses runtime messaging, so screenshot-heavy exports do not hit the browser message-size limit.

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
