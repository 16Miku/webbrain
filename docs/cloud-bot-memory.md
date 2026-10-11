# Managed bot memory

`bot_memory_v1` means the runtime supports application-owned action history
through a private `cloud_run.taskMemory` envelope. The platform uses this
history to prevent duplicate posts, messages, purchases, and other guarded
actions across browser restarts and scheduled runs. Advertising the capability
without the controller and runtime implementation is insufficient.

Both browser bridges advertise the same capability. The approved bridge still
accepts only its existing managed-run commands. The envelope is supplied by the
controller, not by page content or a model tool call:

```js
{
  version: 1,
  botId: 'owned-bot',
  runId: 'owned-application-run',
  policyVersion: 1,
  callbackUrl: 'https://app.example/api/internal/bot-memory/owned-application-run',
  callbackToken: '<private credential of at least 32 characters>',
  policy: { schemaVersion: 1, actions: [/* application repeat policies */] },
  context: { document: null, recentActions: [], totalActions: 0 }
}
```

The extension accepts `task_memory` as an alias. The MCP `webbrain_run` schema
uses `task_memory` and forwards it privately as `taskMemory`; a browser missing
the capability is rejected before the run is dispatched.

Invalid envelopes fail before touching a tab or calling the agent. The callback
must use HTTPS, or HTTP on loopback for local tests, with an exact run-specific
path and no URL credentials, query, or fragment. The callback credential stays
in volatile controller/session state; it does not enter model messages, saved
conversations, public results, or traces. Protected continuations need a fresh
envelope for the same bot. Saved workflow replay is refused for protected runs
because it does not execute the guarded runtime path.

Before a consequential browser action, the runtime observes its actual target
and sends `prepare` to the application. A matching reservation and acknowledged
`dispatch` are required before browser input. The ordinary browser permissions,
task authorization, and page-context checks still apply. A response lost after
dispatch leaves uncertainty in the application's ledger. A genuine runtime
`noDispatch` result can release a reservation; model prose cannot.

Fresh page evidence is needed to verify or reconcile a dispatched action.
Read/collection records require an observed entity and a read policy. Notes are
unverified context and cannot establish successful delivery. The five
`bot_memory_*` tools are offered only during protected runs; their page/history
results and prior context use the normal untrusted-content framing. A custom
skill cannot substitute a tool with one of these names.

This memory is separate from the profile-wide User Memory and MemCode stores.
Protected runs omit those unrelated profile sources without changing settings
for ordinary browser chats.

## Image upgrades

The production image builder checks both the bridge's advertised capabilities
and controller behavior before creating or activating a snapshot. A required
`bot_memory_v1` check must remain enabled. A failed candidate leaves the current
image active; enabling an unsupported flag would remove the guard rather than
implement it.

Source changes on `main`, built local extensions, tracked browser-store ZIPs,
and an official GitHub release are distinct artifacts. The release workflows
are manually dispatched. An image builder pinned to an official release will
not receive later `main` commits until a compatible release is published and
its image is rebuilt. Rebuild archives from the validated release commit;
older ZIPs can omit fixes even when their filenames have the current version.

Run the extension checks with `npm run test:bot-memory` and the relay checks
with `npm test --prefix mcp-server`. The platform's
`scripts/browser-capabilities.mjs` also verifies `run_provider_v1`,
`private_results_v1`, and `bot_memory_v1` against the candidate Chrome source.
