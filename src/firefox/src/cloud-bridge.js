/**
 * Outbound WebSocket bridge for MCP and other controllers (Firefox).
 *
 * Mirror of src/chrome/src/offscreen/cloud-bridge.js. Firefox MV2 has a
 * persistent background page and no offscreen documents, so the socket lives
 * in the background page and commands are handed to `dispatch` directly
 * instead of through runtime.sendMessage (a page does not receive its own
 * runtime messages). Keep the protocol identical to the Chrome file.
 */

export const BRIDGE_PROTOCOL_VERSION = 2;
const BRIDGE_CAPABILITIES = ['saved_workflows_v1', 'run_modes_v1', 'scheduled_jobs_v1', 'run_provider_v1', 'private_results_v1', 'bot_memory_v1', 'run_handoff_v1'];
const ALLOWED_BRIDGE_ACTIONS = new Set([
  'cloud_run',
  'cloud_workflow_compile',
  'cloud_workflow_run',
  'cloud_status',
  'cloud_scheduled_jobs',
  'cloud_respond',
  'cloud_abort',
  'cloud_pause',
  'cloud_resume',
]);
// Local bridges (the MCP server and the LM Studio plugin) challenge each new
// socket with a nonce and only trust it after it returns this HMAC, keyed by
// the pairing key the user pasted in Settings. The key never crosses the
// socket. Keep in sync with mcp-server/src/pairing.ts.
const PAIRING_SCHEME = 'hmac-sha256-v1';
const PAIRING_PROOF_LABEL = 'webbrain-bridge-pairing-v1:';
const PAIRING_CLOSE_CODE = 4001;

async function pairingProof(key, nonce) {
  const encoder = new TextEncoder();
  const hmacKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', hmacKey, encoder.encode(PAIRING_PROOF_LABEL + nonce));
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// A token-configured controller must pass a mutual HMAC challenge
// (docs/cloud-bridge-browser-approval.md). The token never crosses the
// socket: whoever answers on the loopback port proves it knows the token
// first, and only then does the extension prove itself and reveal its
// browser and installation IDs. A process that wins the port learns nothing
// it can replay and cannot move the socket to `approved`.
const BRIDGE_AUTH_METHOD = 'hmac-sha256-v1';
const BRIDGE_AUTH_LABEL = 'webbrain-bridge-auth-v1';
const HEX_256 = /^[0-9a-f]{64}$/;

const utf8 = (value) => new TextEncoder().encode(value);
const toHex = (bytes) => Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => Uint8Array.from(hex.match(/../g), (pair) => parseInt(pair, 16));
const hmacKey = (token, usage) => crypto.subtle.importKey('raw', utf8(token), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
// A JSON array keeps the role, the nonces and the identity unambiguous.
const authTranscript = (...parts) => utf8(JSON.stringify([BRIDGE_AUTH_LABEL, ...parts]));

export function createCloudBridge({ dispatch, WebSocketImpl = globalThis.WebSocket, nav = globalThis.navigator } = {}) {
  let socket = null;
  let bridgeUrl = null;
  let enabled = false;
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let lastError = '';
  // With a token configured the backend must authenticate and then approve
  // each new socket before any cloud_* command runs; without one the legacy
  // local behaviour is kept. `legacyBearerAuth` is the deprecated opt-in that
  // still sends the token in the hello for controllers without the challenge.
  // `pairingKey` is independent of the token: it answers the pairing challenge
  // that the local MCP / LM Studio bridges send to authenticate the extension.
  let identity = { token: '', browserId: '', installationId: '', extensionVersion: '', legacyBearerAuth: false, pairingKey: '' };
  let approval = 'not_required'; // not_required | pending | approved | rejected

  function browserInfo() {
    const match = /(Edg|Firefox|Chrome)\/([\d.]+)/.exec(nav?.userAgent || '');
    const names = { Edg: 'Edge', Firefox: 'Firefox', Chrome: 'Chrome' };
    return { name: match ? names[match[1]] : 'unknown', version: match ? match[2] : '' };
  }

  function normalizeBridgeUrl(value) {
    const url = new URL(String(value || 'ws://127.0.0.1:17374/extension'));
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) {
      throw new Error('MCP URL must use ws:// on localhost.');
    }
    return url.href;
  }

  function status() {
    return {
      enabled,
      url: bridgeUrl,
      browserId: identity.browserId || null,
      installationId: identity.installationId || null,
      approval,
      connected: socket?.readyState === WebSocketImpl.OPEN,
      readyState: socket ? socket.readyState : null,
      reconnectAttempt,
      lastError,
    };
  }

  function sendJson(obj, target = socket) {
    if (!target || target.readyState !== WebSocketImpl.OPEN) return;
    try {
      target.send(JSON.stringify(obj));
    } catch (e) {
      lastError = e.message || String(e);
    }
  }

  // A pairing failure needs the user to fix Settings; reconnecting would only
  // repeat it. Saving Settings or "Save & test" starts a fresh attempt.
  function failPairing(target, reason) {
    approval = 'rejected';
    lastError = reason;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    try { target.close(); } catch {}
  }

  function authMode() {
    if (!identity.token) return 'none';
    return identity.legacyBearerAuth ? 'legacy_bearer' : 'challenge';
  }

  async function answerAuthChallenge(msg, target, auth) {
    // One challenge per socket, and only after our own nonce went out.
    if (auth.mode !== 'challenge' || auth.state !== 'awaiting_controller') return;
    auth.state = 'verifying';
    const { token, browserId, installationId } = identity;
    let proof = '';
    try {
      const verified = msg.method === BRIDGE_AUTH_METHOD
        && typeof msg.nonce === 'string' && HEX_256.test(msg.nonce)
        && typeof msg.proof === 'string' && HEX_256.test(msg.proof)
        && await crypto.subtle.verify('HMAC', await hmacKey(token, 'verify'), fromHex(msg.proof),
          authTranscript('controller', auth.nonce, msg.nonce));
      if (verified) {
        proof = toHex(await crypto.subtle.sign('HMAC', await hmacKey(token, 'sign'),
          authTranscript('extension', auth.nonce, msg.nonce, browserId, installationId)));
      }
    } catch {
      proof = '';
    }
    if (socket !== target) return;
    if (!proof) {
      // Not the controller this token belongs to: answer nothing and retry
      // with backoff, in case the real controller gets its port back.
      auth.state = 'failed';
      lastError = 'Bridge controller failed authentication';
      try { target.close(); } catch {}
      return;
    }
    auth.state = 'verified';
    reconnectAttempt = 0;
    sendJson({ type: 'auth_response', method: BRIDGE_AUTH_METHOD, proof, browserId, installationId }, target);
  }

  function scheduleReconnect() {
    if (!enabled || !bridgeUrl || reconnectTimer) return;
    const delay = Math.min(30000, 500 * Math.pow(2, reconnectAttempt++));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (!enabled || !bridgeUrl) return;
    if (socket && (socket.readyState === WebSocketImpl.OPEN || socket.readyState === WebSocketImpl.CONNECTING)) return;
    try {
      const nextSocket = new WebSocketImpl(bridgeUrl);
      // Per-socket authentication state; nothing carries over a reconnect.
      const auth = { mode: 'none', state: 'none', nonce: '' };
      socket = nextSocket;
      nextSocket.addEventListener('open', () => {
        if (socket !== nextSocket) return;
        auth.mode = authMode();
        // A challenged socket only counts as healthy once the controller has
        // proved itself, so a squatter that fails cannot reset the backoff.
        if (auth.mode !== 'challenge') reconnectAttempt = 0;
        lastError = '';
        // Every new socket starts unapproved; approval never carries over.
        approval = identity.token ? 'pending' : 'not_required';
        const hello = {
          type: 'hello',
          client: 'webbrain-extension',
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          capabilities: BRIDGE_CAPABILITIES,
          browser: browserInfo(),
          extensionVersion: identity.extensionVersion,
          platform: nav?.platform || '',
          status: status(),
        };
        if (auth.mode === 'challenge') {
          auth.nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
          auth.state = 'awaiting_controller';
          hello.auth = { type: 'challenge', method: BRIDGE_AUTH_METHOD, nonce: auth.nonce };
          // The IDs go out in auth_response, after the controller's proof.
          delete hello.status.browserId;
          delete hello.status.installationId;
        } else if (auth.mode === 'legacy_bearer') {
          // Deprecated: hands the reusable token to whoever owns the port.
          hello.auth = { type: 'bearer', token: identity.token };
          hello.browserId = identity.browserId;
          hello.installationId = identity.installationId;
        }
        sendJson(hello, nextSocket);
      });
      nextSocket.addEventListener('message', async (event) => {
        if (socket !== nextSocket) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          sendJson({ ok: false, error: `Invalid JSON message: ${e.message}` }, nextSocket);
          return;
        }
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
          sendJson({ ok: false, code: 'invalid_message', error: 'Cloud bridge message must be a JSON object.' }, nextSocket);
          return;
        }

        if (msg.type === 'auth_challenge') {
          await answerAuthChallenge(msg, nextSocket, auth);
          return;
        }

        // The local MCP / LM Studio bridges authenticate the extension with a
        // separate pairing challenge. It has its own message types so it can
        // never be confused with the controller auth_challenge above.
        if (msg.type === 'pairing_challenge') {
          if (msg.scheme !== PAIRING_SCHEME || typeof msg.nonce !== 'string' || !msg.nonce || msg.nonce.length > 256) return;
          if (!identity.pairingKey) {
            failPairing(nextSocket, 'This bridge requires a pairing key. Paste it under Settings → Bridge → Pairing key.');
            return;
          }
          let proof;
          try {
            proof = await pairingProof(identity.pairingKey, msg.nonce);
          } catch (e) {
            failPairing(nextSocket, `Could not compute the pairing proof: ${e.message || e}`);
            return;
          }
          if (socket !== nextSocket) return;
          sendJson({ type: 'pairing_proof', scheme: PAIRING_SCHEME, proof }, nextSocket);
          return;
        }

        if (msg.type === 'connection_pending' || msg.type === 'connection_approved' || msg.type === 'connection_rejected') {
          if (!identity.token) return;
          // Only a controller that proved the token may move a challenged
          // socket toward approval. A rejection only takes rights away, so it
          // is honoured from anyone.
          if (auth.mode === 'challenge' && auth.state !== 'verified' && msg.type !== 'connection_rejected') return;
          if (msg.browserId && msg.browserId !== identity.browserId) return;
          if (msg.type === 'connection_pending') {
            if (approval !== 'approved') approval = 'pending';
          } else if (msg.type === 'connection_approved') {
            approval = 'approved';
            lastError = '';
          } else {
            approval = 'rejected';
            lastError = String(msg.reason || 'Connection rejected by backend');
            // A backoff timer from an earlier socket must not reconnect a rejected browser.
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            try { nextSocket.close(); } catch {}
          }
          return;
        }

        const id = msg.id || null;
        const action = msg.action || msg.command;
        const payload = msg.payload || msg;
        if (!action) {
          sendJson({ id, ok: false, error: 'Missing action' }, nextSocket);
          return;
        }
        if (!ALLOWED_BRIDGE_ACTIONS.has(action)) {
          sendJson({ id, ok: false, error: `Unsupported cloud bridge action: ${action}` }, nextSocket);
          return;
        }
        if (identity.token && approval !== 'approved') {
          sendJson({ id, ok: false, error: 'Connection not approved', code: 'connection_not_approved', status: 403 }, nextSocket);
          return;
        }

        try {
          const response = await dispatch({ ...payload, target: 'background', action });
          const isRunSnapshot = !!response
            && (response.runId != null || response.run_id != null)
            && typeof response.status === 'string';
          if (response?.error && !isRunSnapshot) {
            sendJson({ id, ok: false, error: response.error, status: response.status || 500 }, nextSocket);
          } else {
            sendJson({ id, ok: true, result: response }, nextSocket);
          }
        } catch (e) {
          sendJson({ id, ok: false, error: e.message || String(e) }, nextSocket);
        }
      });
      nextSocket.addEventListener('close', (event) => {
        if (socket !== nextSocket) return;
        socket = null;
        if (event?.code === PAIRING_CLOSE_CODE) {
          failPairing(nextSocket, String(event.reason || 'Pairing rejected by the bridge'));
          return;
        }
        // A rejected browser stays rejected until the settings change.
        if (approval === 'rejected') return;
        approval = identity.token ? 'pending' : 'not_required';
        scheduleReconnect();
      });
      nextSocket.addEventListener('error', () => {
        // Closing a socket we dropped can error; keep the reason we dropped it.
        if (socket !== nextSocket || auth.state === 'failed') return;
        lastError = 'WebSocket error';
      });
    } catch (e) {
      lastError = e.message || String(e);
      socket = null;
      scheduleReconnect();
    }
  }

  function start(msg = {}) {
    let nextUrl;
    try {
      nextUrl = normalizeBridgeUrl(msg.url || bridgeUrl);
    } catch (error) {
      lastError = error.message || String(error);
      return { ...status(), error: lastError };
    }
    const nextIdentity = {
      token: String(msg.token || ''),
      browserId: String(msg.browserId || ''),
      installationId: String(msg.installationId || ''),
      extensionVersion: String(msg.extensionVersion || ''),
      pairingKey: String(msg.pairingKey || '').trim(),
      legacyBearerAuth: msg.legacyBearerAuth === true,
    };
    const identityChanged = JSON.stringify(nextIdentity) !== JSON.stringify(identity);
    const changed = (bridgeUrl && bridgeUrl !== nextUrl) || identityChanged;
    enabled = true;
    bridgeUrl = nextUrl;
    identity = nextIdentity;
    if (identityChanged) {
      approval = identity.token ? 'pending' : 'not_required';
      reconnectAttempt = 0;
    }
    if (changed && socket) {
      const previousSocket = socket;
      socket = null;
      try { previousSocket.close(); } catch {}
    }
    connect();
    return status();
  }

  function stop() {
    enabled = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    reconnectAttempt = 0;
    if (socket) {
      const previousSocket = socket;
      socket = null;
      try { previousSocket.close(); } catch {}
    }
    return status();
  }

  return { start, stop, status };
}
