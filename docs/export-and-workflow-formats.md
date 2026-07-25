# Export and saved-workflow formats

WebBrain can export a conversation, a recorded tool chain, Settings, or a saved
workflow. These files have different privacy and compatibility properties.

| Command or UI | File | Format | Treat as sensitive? |
|---|---|---|---|
| `/export` | `webbrain-chat-<timestamp>.md` | Conversation Markdown | Yes. It contains visible chat and system messages. |
| `/export --traces` | `webbrain-traces-<timestamp>.md` | Recorded tool-chain Markdown | Yes. It can contain prompts, model output, tool arguments, URLs, and results. |
| `/export --config` | `webbrain-config-<timestamp>.json` | `webbrain-config/1` | **Yes. It is plaintext and can contain API keys, profile data, and user memory.** |
| `/workflow --export <id>` | `<name>.webbrain-workflow.json` | `webbrain-workflow/1` | Review before sharing. Runtime values are omitted, but saved targets and URL scopes remain. |
| Traces page **Export JSON** | `webbrain-trace-<model>-<run-id>.json` | `webbrain-trace/1` | Yes. It contains the raw recorded run and may include screenshots. |

All exports are created locally by the browser. Exporting a file does not upload
it.

## Conversation Markdown

`/export` serializes the messages currently rendered in the side panel:

```md
# WebBrain Conversation

_Exported with WebBrain v25.8.5_

**You:** Summarize this page.

**WebBrain:** ...
```

The export is intended for reading rather than round-trip import. It includes
the exporting extension version but has no schema identifier.

## Recorded tool-chain Markdown

`/export --traces` exports recorded runs associated with the current
conversation. Tracing must have been enabled when the runs occurred. Each turn
contains its recording version when available, model and status metadata, model
responses, tool calls, arguments, and rendered results.

Screenshots, vision sub-calls, and internal trace notes are omitted from this
Markdown format. The export may be marked partial or truncated when the browser
cannot retrieve the complete recorded chain.

The Traces page offers a separate JSON export for one selected run:

```json
{
  "schema": "webbrain-trace/1",
  "run": {},
  "events": [],
  "exportedAt": 1784937600000,
  "exportedByWebBrainVersion": "25.8.5"
}
```

`run` and `events` are diagnostic records, not a stable automation API.
Screenshot events can include `screenshot_base64` or `screenshot_dataUrl`.
Consumers should check `schema`, tolerate additional fields, and avoid relying
on undocumented event internals.

## Settings snapshots: `webbrain-config/1`

`/export --config` creates a versioned Settings snapshot:

```json
{
  "schema": "webbrain-config/1",
  "exportedAt": "2026-07-25T00:00:00.000Z",
  "webbrainVersion": "25.8.5",
  "warning": "Contains plaintext provider API keys and other sensitive Settings data. Store securely.",
  "settings": {
    "wbLocale": "en",
    "activeProvider": "webbrain_cloud",
    "providers": {},
    "askBeforeConsequentialActions": true
  }
}
```

| Field | Meaning |
|---|---|
| `schema` | Required format identifier. Imports accept `webbrain-config/1`. |
| `exportedAt` | ISO 8601 export time. |
| `webbrainVersion` | Version of the extension that created the file. |
| `warning` | Human-readable plaintext-secret warning. |
| `settings` | Allowlisted, default-resolved portable Settings values. |

The snapshot includes provider, vision, transcription, and CapSolver API keys;
profile data; user memory; custom skills; and permission choices. It excludes
conversations, traces, schedules, usage counters, accumulated spend, and
device-bound WebBrain Cloud or Cloud Sync identity and session data.

Import with `/import <json>` or `/import --file`. Import validates known setting
types, ignores unknown setting keys, and fills omitted known settings with the
importing version's defaults. A provider's device-bound identity is preserved
locally rather than replaced by a portable snapshot.

## Portable workflows: `webbrain-workflow/1`

A saved workflow is a normalized automation definition compiled from the latest
successful recorded run. It is not a raw trace replay.

```json
{
  "schema": "webbrain-workflow/1",
  "id": "workflow_1784937600000_example",
  "name": "Search the catalog",
  "createdAt": 1784937600000,
  "updatedAt": 1784937600000,
  "source": {
    "runId": "run_example",
    "webbrainVersion": "25.8.5"
  },
  "start": {
    "origin": "https://shop.example",
    "pathFamily": "/products"
  },
  "parameters": [
    {
      "id": "query",
      "label": "Search",
      "required": true,
      "sensitive": false,
      "type": "text"
    }
  ],
  "steps": [
    {
      "id": "step_1",
      "tool": "set_field",
      "args": {
        "text": {
          "$workflowParam": "query"
        },
        "clear": true,
        "submit": true
      },
      "target": {
        "role": "textbox",
        "label": "Search"
      },
      "scope": {
        "origin": "https://shop.example",
        "pathFamily": "/products"
      },
      "expected": {
        "kind": "tool_verified"
      }
    }
  ],
  "stats": {
    "sourceToolCount": 1,
    "compiledStepCount": 1,
    "skippedToolCount": 0
  }
}
```

| Field | Meaning |
|---|---|
| `schema` | Required format identifier. Imports accept `webbrain-workflow/1`. |
| `id`, `createdAt`, `updatedAt` | Local identity and Unix-millisecond timestamps. Import replaces these with fresh local values. |
| `name` | Display name, limited to 80 characters. |
| `source` | Diagnostic source run and recording version. The source trace itself is not embedded. |
| `start` | Required starting origin and normalized URL path family. |
| `parameters` | Runtime text inputs. Values are never stored in the definition. |
| `steps` | Replayable tools with normalized arguments, semantic targets, URL scopes, and expected postconditions. |
| `stats` | Counts from compilation; these do not control replay. |

Compilation removes historical accessibility `ref_id` values, CSS selectors,
coordinates, URL queries and fragments, and typed field values. Typed values
become `$workflowParam` references. Replay resolves semantic targets against a
fresh accessibility tree and uses the normal Act permissions, confirmation, and
verification gates.

Portable workflow files are limited to 1 MiB, 50 parameters, and 100 steps.
Export and import both normalize the definition. Import rejects unknown or
malformed step arguments, assigns a new local ID and timestamps, and never
overwrites an existing workflow. The same definition can therefore be imported
more than once and moved between the Chrome and Firefox extensions.

## Compatibility guidance

- Read `schema` before consuming JSON. A different schema string is a different
  format version.
- Use `webbrainVersion` or `source.webbrainVersion` for diagnostics, not as a
  substitute for the schema identifier.
- Tolerate additional object fields when reading exports.
- Do not edit generated files unless you are prepared for import validation to
  reject them.
- Keep unencrypted exports out of public issues, repositories, and shared
  folders until you have reviewed and redacted them.
