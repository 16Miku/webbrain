import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

export class BidiSession {
  constructor(WebSocketImpl = WebSocket) {
    this.WebSocketImpl = WebSocketImpl;
    this.pending = new Map(); this.runs = new Map(); this.sequence = 0; this.files = []; this.closedRuns = new Set(); this.dialogs = new Map();
  }
  connect(port = 9222) {
    if (!this.connection) this.connection = this.connectSession(port).catch(error => {
      this.socket?.close(); this.connection = null; throw error;
    });
    return this.connection;
  }
  async connectSession(port) {
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid local Firefox port');
    if (this.socket?.readyState === 1) return { connected: true };
    const socket = this.socket = new this.WebSocketImpl(`ws://127.0.0.1:${port}/session`);
    socket.addEventListener('message', event => this.receive(JSON.parse(event.data)));
    socket.addEventListener('close', () => {
      for (const entry of this.pending.values()) entry.reject(new Error('Firefox disconnected; action outcome may be unknown'));
      this.pending.clear(); this.runs.clear(); this.dialogs.clear(); this.connection = null;
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(new Error('Start Firefox with --remote-debugging-port')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to Firefox BiDi')); }, { once: true });
    });
    await this.send('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } });
    await this.send('session.subscribe', { events: ['browsingContext.userPromptOpened', 'browsingContext.userPromptClosed', 'browsingContext.contextDestroyed'] });
    return { connected: true };
  }
  send(method, params) {
    if (this.socket?.readyState !== 1) return Promise.reject(new Error('Firefox BiDi is disconnected'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out; do not repeat an uncertain action`)); }, 10000);
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.get(id).reject(error); this.pending.delete(id); }
    });
  }
  receive(message) {
    if (message.id != null) {
      const entry = this.pending.get(message.id); if (!entry) return;
      this.pending.delete(message.id);
      if (message.type === 'error') entry.reject(new Error(message.error || 'BiDi command failed'));
      else entry.resolve(message.result);
      return;
    }
    const params = message.params || {};
    if (message.method === 'browsingContext.contextDestroyed') {
      for (const [id, run] of this.runs) if (run.context === params.context) this.runs.delete(id);
    }
    if (message.method === 'browsingContext.userPromptClosed' || message.method === 'browsingContext.contextDestroyed') this.dialogs.delete(params.context);
    if (message.method === 'browsingContext.userPromptOpened') {
      this.dialogs.set(params.context, { type: params.type });
      const run = [...this.runs.values()].find(item => item.context === params.context);
      if (run) void this.handleDialog(run).catch(() => {});
    }
  }
  async handleDialog(run) {
    const dialog = this.dialogs.get(run.context);
    if (!dialog) return;
    if (dialog.handling) return dialog.handling;
    const accept = dialog.type === 'alert' || (dialog.type === 'beforeunload' && run.navigation === true);
    if (dialog.type === 'beforeunload') run.navigation = false;
    dialog.handling = this.send('browsingContext.handleUserPrompt', { context: run.context, accept });
    try { await dialog.handling; }
    finally { if (this.dialogs.get(run.context) === dialog) this.dialogs.delete(run.context); }
  }
  async locate(token, url, context = null) {
    if (!/^[a-f0-9-]{36}$/.test(token) || !/^https?:\/\//.test(url)) throw new Error('Invalid tab binding');
    const tree = await this.send('browsingContext.getTree', context ? { root: context } : {});
    const contexts = [];
    const visit = nodes => { for (const node of nodes || []) { contexts.push(node); visit(node.children); } };
    visit(tree.contexts);
    if (contexts.length > 128) throw new Error('Too many Firefox contexts to bind safely');
    const matches = [];
    for (const frame of contexts) {
      if (frame.url !== url) continue;
      const found = await this.send('browsingContext.locateNodes', {
        context: frame.context, locator: { type: 'css', value: `[data-webbrain-bidi="${token}"]` },
      });
      for (const node of found.nodes || []) matches.push({ context: frame.context, node });
    }
    if (matches.length !== 1) throw new Error('Tab or element binding is stale or ambiguous; re-read the page');
    return matches[0];
  }
  async openRun(id, token, url) {
    if (!/^[a-f0-9-]{36}$/.test(id) || this.runs.has(id) || this.closedRuns.has(id)) throw new Error('Invalid run');
    const match = await this.locate(token, url);
    if (this.closedRuns.has(id)) throw new Error('Run stopped during binding');
    this.runs.set(id, { context: match.context, navigation: false });
    await this.handleDialog(this.runs.get(id));
    if (this.closedRuns.has(id)) throw new Error('Run stopped during binding');
    await this.call(match, '(el) => { el.removeAttribute("data-webbrain-bidi"); return true; }');
    return { connected: true };
  }
  call(match, functionDeclaration, args = []) {
    return this.send('script.callFunction', { target: { context: match.context }, functionDeclaration,
      arguments: [{ sharedId: match.node.sharedId }, ...args], awaitPromise: true });
  }
  async closeRun(id) {
    this.closedRuns.add(id);
    if (this.closedRuns.size > 4096) this.closedRuns.delete(this.closedRuns.values().next().value);
    const run = this.runs.get(id); this.runs.delete(id);
    if (run) await this.send('input.releaseActions', { context: run.context }).catch(() => {});
    return {};
  }
  async perform(id, action, payload) {
    const dispatch = { started: false };
    try { return await this.performAction(id, action, payload, dispatch); }
    catch (error) {
      error.dispatchState = { dispatched: dispatch.started, noDispatch: !dispatch.started,
        outcomeUnknown: dispatch.started, retryable: !dispatch.started };
      throw error;
    }
  }
  async performAction(id, action, payload, dispatch) {
    if (!['navigate', 'click', 'hover', 'type', 'field', 'key', 'upload'].includes(action)) throw new Error('Unsupported BiDi action');
    if (payload.modifiers) throw new Error('Key modifiers are not supported by this tool');
    const run = this.runs.get(id); if (!run) throw new Error('Run stopped or disconnected');
    const assertLive = () => {
      if (this.runs.get(id) !== run) throw new Error('Run stopped');
      if (payload.deadlineAt && Date.now() >= payload.deadlineAt) throw new Error('Action deadline expired');
    };
    assertLive();
    if (action === 'navigate') {
      if (!/^https?:\/\//.test(payload.url)) throw new Error('Invalid navigation URL');
      run.navigation = true;
      try { dispatch.started = true; await this.send('browsingContext.navigate', { context: run.context, url: payload.url, wait: 'interactive' }); }
      finally { run.navigation = false; }
      return { success: true, dispatched: true };
    }
    const match = await this.locate(payload.token, payload.url, run.context);
    assertLive();
    const point = action === 'click' && payload.point != null ? payload.point : null;
    if (point && (!Number.isInteger(point.x) || !Number.isInteger(point.y))) throw new Error('Invalid click coordinates');
    const check = await this.call(match, `(el, token, action, x, y) => {
      if (!el.isConnected || el.getAttribute('data-webbrain-bidi') !== token || el.disabled) return false;
      el.removeAttribute('data-webbrain-bidi');
      if (action === 'upload') return el.tagName === 'INPUT' && el.type === 'file';
      const r = el.getBoundingClientRect();
      const px = x === null ? r.x+r.width/2 : x;
      const py = y === null ? r.y+r.height/2 : y;
      if (px < 0 || py < 0 || px >= innerWidth || py >= innerHeight) return false;
      const hit = document.elementFromPoint(px, py);
      if (!r.width || !r.height || !(hit === el || el.contains(hit))) return false;
      if (action === 'type' || action === 'field' || action === 'key') {
        el.focus({preventScroll:true});
        if (el.getRootNode().activeElement !== el) return false;
      }
      return true;
    }`, [{ type: 'string', value: payload.token }, { type: 'string', value: action }, point ? {type:'number',value:point.x} : {type:'null'}, point ? {type:'number',value:point.y} : {type:'null'}]);
    if (check.result?.value !== true) throw new Error('Target changed or is covered; no input sent');
    assertLive();
    if (action === 'upload') {
      if (typeof payload.base64 !== 'string' || payload.base64.length > 36 * 1024 * 1024) throw new Error('Upload exceeds 25MB');
      const bytes = Buffer.from(payload.base64, 'base64');
      if (bytes.length > 25 * 1024 * 1024) throw new Error('Upload exceeds 25MB');
      const dir = await mkdtemp(join(tmpdir(), 'webbrain-bidi-')); this.files.push(dir);
      const name = basename(String(payload.filename || 'attachment')).replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = join(dir, name === '.' || name === '..' ? 'attachment' : name);
      await writeFile(path, bytes, { mode: 0o600 });
      assertLive();
      dispatch.started = true;
      await this.send('input.setFiles', { context: match.context, element: { sharedId: match.node.sharedId }, files: [path] });
      const attached = await this.call(match, '(el, name, size) => el.isConnected && el.files?.length === 1 && el.files[0].name === name && el.files[0].size === size', [{ type: 'string', value: name }, { type: 'number', value: bytes.length }]);
      if (attached.result?.value !== true) return { success: false, dispatched: true, outcomeUnknown: true, retryable: false, error: 'File input changed after attachment; inspect the page before retrying.' };
      return { success: true, dispatched: true, attachmentState: 'input_attached', file: name, size: bytes.length };
    }
    const typing = action === 'type' || action === 'field';
    const clear = action === 'field' ? payload.clear !== false : payload.clear === true;
    const before = typing ? await this.call(match, '(el) => el.isContentEditable ? el.innerText : el.value') : null;
    const assertFocus = async () => {
      assertLive();
      const focused = await this.call(match, '(el) => el.isConnected && !el.disabled && el.getRootNode().activeElement === el');
      if (focused.result?.value !== true) throw new Error('Focus changed; no further keys sent');
      assertLive();
    };
    const press = async (value, modifier = null, followTabFocus = false) => {
      if (followTabFocus) assertLive();
      else await assertFocus();
      const actions = [
        ...(modifier ? [{ type: 'keyDown', value: modifier }] : []),
        { type: 'keyDown', value }, { type: 'keyUp', value },
        ...(modifier ? [{ type: 'keyUp', value: modifier }] : []),
      ];
      try { dispatch.started = true; await this.send('input.performActions', { context: match.context, actions: [{ type: 'key', id: 'webbrain-keyboard', actions }] }); }
      finally { await this.send('input.releaseActions', { context: match.context }).catch(() => {}); }
      assertLive();
    };
    if (action === 'click' || action === 'hover') {
      const source = { type: 'pointer', id: 'webbrain-pointer', parameters: { pointerType: 'mouse' }, actions: [
        point ? { type: 'pointerMove', x: point.x, y: point.y, origin: 'viewport' }
          : { type: 'pointerMove', x: 0, y: 0, origin: { type: 'element', element: { sharedId: match.node.sharedId } } },
        ...(action === 'click' ? [{ type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] : []),
      ] };
      assertLive();
      try { dispatch.started = true; await this.send('input.performActions', { context: match.context, actions: [source] }); }
      finally { await this.send('input.releaseActions', { context: match.context }).catch(() => {}); }
      assertLive();
    } else if (typing) {
      if (typeof payload.text !== 'string' || payload.text.length > 10000) throw new Error('Trusted text input is limited to 10000 characters per action');
      if (/[\r\n]/.test(payload.text)) {
        const multiline = await this.call(match, '(el) => el.tagName === "TEXTAREA" || el.isContentEditable');
        if (multiline.result?.value !== true) throw new Error('Newlines require a multiline editor; no text sent');
      }
      if (clear) {
        const platform = await this.call(match, '() => navigator.platform');
        await press('a', /Mac/.test(platform.result?.value || '') ? '\uE03D' : '\uE009');
        await press('\uE003');
      }
      // One character per dispatch bounds work after Stop and catches focus changes between keys.
      for (const char of payload.text) {
        if (char === '\n' || char === '\r') {
          await assertFocus();
          // Enter is a submit shortcut on many editors, even with Shift. Insert a literal
          // newline through the editing command instead; never synthesize a submit key.
          dispatch.started = true;
          const inserted = await this.call(match, `(el, text) => {
            if (!el.isConnected || el.getRootNode().activeElement !== el) return false;
            return document.execCommand('insertText', false, text);
          }`, [{ type: 'string', value: char }]);
          if (inserted.result?.value !== true) throw new Error('Editor rejected literal newline insertion');
          assertLive();
        } else await press(char);
      }
    } else if (action === 'key') {
      const keys = { Enter: '\uE007', Tab: '\uE004', Escape: '\uE00C', Backspace: '\uE003', Delete: '\uE017', ArrowLeft: '\uE012', ArrowRight: '\uE014', ArrowUp: '\uE013', ArrowDown: '\uE015', Home: '\uE011', End: '\uE010' };
      const value = keys[payload.key] || (String(payload.key).length === 1 ? payload.key : null);
      if (!value) throw new Error('Unsupported trusted key');
      const repeat = Math.max(1, Math.min(3, Math.floor(Number(payload.repeat) || 1)));
      // Repeated Tab intentionally follows the focus moved by the previous Tab.
      for (let i = 0; i < repeat; i++) await press(value, null, payload.key === 'Tab' && i > 0);
    }
    if (typing) {
      await new Promise(resolve => setTimeout(resolve, 100));
      assertLive();
      const expected = clear ? payload.text : String(before.result?.value || '') + payload.text;
      const verified = await this.call(match, '(el, expected) => el.isConnected && (el.isContentEditable ? el.innerText : el.value) === expected', [{ type: 'string', value: expected }]);
      if (verified.result?.value !== true) return { success: false, dispatched: true, verified: false, submitted: false, outcomeUnknown: true, retryable: false, error: 'Trusted typing did not match the requested value; inspect before another write.' };
      if (action === 'field' && payload.submit === true) {
        assertLive();
        await press('\uE007');
      }
      return { success: true, dispatched: true, verified: true, submitted: action === 'field' && payload.submit === true, method: 'firefox-bidi' };
    }
    return { success: true, dispatched: true, verified: false, method: 'firefox-bidi' };
  }
  async close() {
    for (const id of this.runs.keys()) await this.closeRun(id);
    this.socket?.close();
    for (const dir of this.files) await rm(dir, { recursive: true, force: true });
    this.files = [];
  }
}
