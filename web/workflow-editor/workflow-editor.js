/* WebBrain Workflow Editor. Dependency-free classic script; no network or storage access. */
(function (global) {
  'use strict';

  const copy = value => JSON.parse(JSON.stringify(value));
  const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  const limits = { steps: 100, parameters: 50 };
  const tools = new Set(['navigate', 'go_back', 'go_forward', 'click', 'click_ax', 'set_checked', 'type_ax', 'set_field', 'scroll', 'wait_for_element']);
  const targetFields = { id: 12, fieldName: 9, label: 8, ariaLabel: 8, name: 7, href: 7, placeholder: 5, type: 3, role: 2 };
  const targetRequired = new Set(['click_ax', 'set_checked', 'type_ax', 'set_field']);
  const maxPortableBytes = 1024 * 1024;
  const defaults = { string: '', number: 0, boolean: false, null: null, object: {}, array: [] };
  const at = (value, path) => path.reduce((node, key) => node[key], value);
  const put = (value, key, next) => Object.defineProperty(value, key, { value: next, writable: true, enumerable: true, configurable: true });
  const freshId = (prefix, items, normalize = value => value) => {
    let n = 1;
    while (items.some(item => normalize(item?.id) === normalize(`${prefix}_${n}`))) n++;
    return `${prefix}_${n}`;
  };
  const normalizeParameterId = value => String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100)
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 80)
    .toLowerCase();
  function parse(value) {
    const result = typeof value === 'string' ? JSON.parse(value) : copy(value);
    if (!object(result)) throw Error('The workflow must be a JSON object at the top level.');
    return result;
  }
  function references(value, visit) {
    if (!value || typeof value !== 'object') return;
    if (own(value, '$workflowParam')) visit(value);
    Object.values(value).forEach(child => references(child, visit));
  }
  function replayableTarget(target) {
    if (!object(target)) return false;
    let score = 0;
    for (const [field, points] of Object.entries(targetFields)) {
      const value = workflowCleanText(target[field]);
      if (value && !/^ref_[A-Za-z0-9_-]+$/i.test(value)) score += points;
    }
    return score >= 7;
  }
  function validStepArgs(step, parameterIds) {
    const args = step.args;
    if (!object(args) || Object.keys(args).some(key => /^(ref_?id|x|y|index|replayRequestId|apiReplayRequestId)$/i.test(key))) return false;
    const only = keys => Object.keys(args).every(key => keys.includes(key));
    switch (step.tool) {
      case 'navigate': {
        if (!only(['url']) || typeof args.url !== 'string') return false;
        try { return ['http:', 'https:'].includes(new URL(args.url).protocol); } catch { return false; }
      }
      case 'go_back': case 'go_forward': case 'click_ax': return only([]);
      case 'set_checked': return only(['checked']) && typeof args.checked === 'boolean';
      case 'type_ax': case 'set_field': {
        const keys = step.tool === 'set_field' ? ['text', 'clear', 'submit'] : ['text', 'clear'];
        const ref = args.text;
        return only(keys) && object(ref) && Object.keys(ref).length === 1
          && typeof ref.$workflowParam === 'string' && parameterIds.has(ref.$workflowParam)
          && (!own(args, 'clear') || typeof args.clear === 'boolean')
          && (step.tool !== 'set_field' || !own(args, 'submit') || typeof args.submit === 'boolean');
      }
      case 'click': {
        const text = workflowCleanText(args.text);
        return only(['text']) && typeof args.text === 'string' && !!text && !/^ref_[A-Za-z0-9_-]+$/i.test(text);
      }
      case 'scroll': return only(['direction', 'amount'])
        && (!own(args, 'direction') || ['up', 'down', 'left', 'right'].includes(args.direction))
        && (!own(args, 'amount') || Number.isFinite(args.amount));
      case 'wait_for_element': {
        const text = workflowCleanText(args.text);
        return only(['text', 'timeout']) && typeof args.text === 'string' && !!text
          && !/^ref_[A-Za-z0-9_-]+$/i.test(text)
          && (!own(args, 'timeout') || Number.isFinite(args.timeout));
      }
      default: return false;
    }
  }
  function workflowCleanText(value, max = 240) {
    const text = String(value ?? '').replace(/\u00a0/g, ' ').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
    return text.length > max ? text.slice(0, max).trim() : text;
  }
  function workflowCleanId(value, fallback = '') {
    return workflowCleanText(value, 100).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) || fallback;
  }
  function workflowSafeUrl(value) {
    try {
      const url = new URL(String(value || ''));
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      url.username = ''; url.password = ''; url.search = ''; url.hash = '';
      return url.toString();
    } catch { return ''; }
  }
  function normalizedWorkflowForSize(value) {
    const name = workflowCleanText(value.name, 80);
    const rawStart = value.start;
    const origin = workflowCleanText(rawStart?.origin, 300);
    let start = null;
    try {
      const parsed = new URL(origin);
      if (['http:', 'https:'].includes(parsed.protocol) && parsed.origin === origin) {
        start = { origin, pathFamily: workflowCleanText(rawStart?.pathFamily || '/', 500) || '/' };
      }
    } catch {}
    if (!name || !start) return null;

    const parameters = [], parameterIds = new Set();
    for (const raw of Array.isArray(value.parameters) ? value.parameters : []) {
      const id = normalizeParameterId(workflowCleanId(raw?.id)).toLowerCase();
      if (!id || parameterIds.has(id)) continue;
      parameterIds.add(id);
      const identity = [raw?.id, raw?.label, raw?.type].filter(Boolean).join(' ').toLowerCase();
      parameters.push({ id, label: workflowCleanText(raw?.label || id, 120), required: raw?.required !== false,
        sensitive: raw?.sensitive === true || /password|passcode|secret|token|api.?key|otp|2fa|mfa|one.?time|recovery.?code/.test(identity), type: 'text' });
      if (parameters.length >= limits.parameters) break;
    }

    const steps = [];
    for (const raw of Array.isArray(value.steps) ? value.steps : []) {
      const tool = workflowCleanText(raw?.tool, 80);
      if (!tools.has(tool) || !validStepArgs({ ...raw, tool }, parameterIds)) continue;
      const args = raw.args;
      let normalizedArgs;
      if (tool === 'navigate') normalizedArgs = { url: workflowSafeUrl(args.url) };
      else if (tool === 'go_back' || tool === 'go_forward' || tool === 'click_ax') normalizedArgs = {};
      else if (tool === 'set_checked') normalizedArgs = { checked: args.checked };
      else if (tool === 'type_ax' || tool === 'set_field') normalizedArgs = { text: { $workflowParam: args.text.$workflowParam },
        ...(own(args, 'clear') ? { clear: args.clear } : {}), ...(tool === 'set_field' && own(args, 'submit') ? { submit: args.submit } : {}) };
      else if (tool === 'click') normalizedArgs = { text: workflowCleanText(args.text) };
      else if (tool === 'scroll') normalizedArgs = { direction: args.direction || 'down',
        ...(own(args, 'amount') ? { amount: Math.max(1, Math.min(5000, Math.round(args.amount))) } : {}) };
      else normalizedArgs = { text: workflowCleanText(args.text), ...(own(args, 'timeout') ? { timeout: Math.max(100, Math.min(30000, Math.round(args.timeout))) } : {}) };

      const target = {};
      for (const field of Object.keys(targetFields)) {
        const text = workflowCleanText(raw.target?.[field]);
        if (!text || /^ref_[A-Za-z0-9_-]+$/i.test(text)) continue;
        target[field] = field === 'href' ? (workflowSafeUrl(text) || text) : text;
      }
      const normalizedTarget = Object.keys(target).length ? target : null;
      if (targetRequired.has(tool) && !replayableTarget(normalizedTarget)) continue;
      const rawScope = raw.scope;
      const scopeOrigin = workflowCleanText(rawScope?.origin, 300);
      let scope = null;
      try {
        const parsed = new URL(scopeOrigin);
        if (['http:', 'https:'].includes(parsed.protocol) && parsed.origin === scopeOrigin) {
          scope = { origin: scopeOrigin, pathFamily: workflowCleanText(rawScope?.pathFamily || '/', 500) || '/' };
        }
      } catch {}
      const expectedKind = workflowCleanText(raw.expected?.kind, 40);
      const expected = ['tool_success', 'tool_verified', 'url_changed', 'checked'].includes(expectedKind)
        ? (expectedKind === 'checked' ? { kind: expectedKind, value: raw.expected?.value === true } : { kind: expectedKind })
        : { kind: 'tool_success' };
      steps.push({ id: workflowCleanId(raw.id, `step_${steps.length + 1}`), tool, args: normalizedArgs,
        ...(normalizedTarget ? { target: normalizedTarget } : {}), ...(scope ? { scope } : {}), expected });
      if (steps.length >= limits.steps) break;
    }
    if (!steps.length) return null;
    // Import assigns fresh identity and timestamps after its first normalization.
    const importedTimestamp = Date.now();
    const importedId = `workflow_${importedTimestamp}_${'0'.repeat(8)}`;
    return { schema: value.schema, id: importedId, name,
      createdAt: importedTimestamp, updatedAt: importedTimestamp,
      source: { runId: workflowCleanId(value.source?.runId), webbrainVersion: workflowCleanText(value.source?.webbrainVersion, 40) },
      start, parameters, steps,
      stats: { sourceToolCount: Math.max(0, Math.floor(Number(value.stats?.sourceToolCount) || 0)), compiledStepCount: steps.length,
        skippedToolCount: Math.max(0, Math.floor(Number(value.stats?.skippedToolCount) || 0)) } };
  }
  function warnings(value) {
    const issues = [];
    if (value.schema !== 'webbrain-workflow/1') issues.push('Expected schema “webbrain-workflow/1”.');
    if (typeof value.name !== 'string' || !value.name.trim()) issues.push('Give this workflow a name.');
    try {
      const origin = new URL(value.start?.origin);
      if (!['http:', 'https:'].includes(origin.protocol) || origin.origin !== value.start.origin) throw Error();
    } catch {
      issues.push('Set start.origin to an HTTP or HTTPS origin, such as https://example.com.');
    }
    if (typeof value.start?.pathFamily !== 'string' || !value.start.pathFamily.startsWith('/')) {
      issues.push('Set start.pathFamily to a path beginning with /, such as / or /join.');
    }
    for (const key of ['steps', 'parameters']) {
      if (!Array.isArray(value[key])) { issues.push(`${key} should be an array.`); continue; }
      if (value[key].length > limits[key]) issues.push(`${key} cannot contain more than ${limits[key]} items.`);
      const ids = new Set();
      value[key].forEach((item, i) => {
        if (!object(item)) { issues.push(`${key}[${i}] should be an object.`); return; }
        if (typeof item.id !== 'string' || !item.id.trim()) issues.push(`${key}[${i}] needs an id.`);
        else if (ids.has(item.id)) issues.push(`Duplicate ${key} id: ${item.id}`);
        ids.add(item.id);
        if (key === 'steps' && (typeof item.tool !== 'string' || !item.tool.trim())) issues.push(`Step ${i + 1} needs a tool.`);
      });
    }
    if (Array.isArray(value.steps) && value.steps.length === 0) issues.push('Add at least one workflow step before importing.');
    const ids = new Set();
    (Array.isArray(value.parameters) ? value.parameters : []).forEach((item, index) => {
      if (typeof item?.id !== 'string' || !item.id) return;
      const normalized = normalizeParameterId(item.id);
      if (item.id !== normalized) issues.push(`Parameter ${index + 1} id is not canonical; use lowercase letters, numbers, underscores, or hyphens (up to 80 characters).`);
      if (ids.has(normalized)) issues.push(`Parameter id duplicates another id after normalization: ${normalized}`);
      ids.add(normalized);
    });
    references(value, ref => { if (!ids.has(ref.$workflowParam)) issues.push(`Unknown parameter reference: ${String(ref.$workflowParam)}`); });
    (Array.isArray(value.steps) ? value.steps : []).forEach((step, index) => {
      if (!object(step)) return;
      if (!tools.has(step.tool)) issues.push(`Step ${index + 1} uses an unsupported tool: ${String(step.tool || '(empty)')}.`);
      else if (!validStepArgs(step, ids)) issues.push(`Step ${index + 1} has arguments that the workflow importer cannot use.`);
      if (targetRequired.has(step.tool) && !replayableTarget(step.target)) issues.push(`Step ${index + 1} needs a replayable target with a name, label, id, or other strong locator.`);
    });
    try {
      if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxPortableBytes) {
        issues.push('Workflow JSON exceeds the importer 1 MiB file limit.');
      } else {
        const normalized = normalizedWorkflowForSize(value);
        if (normalized && new TextEncoder().encode(JSON.stringify(normalized)).byteLength > maxPortableBytes) {
          issues.push('Normalized workflow JSON exceeds the importer 1 MiB file limit.');
        }
      }
    } catch { issues.push('Workflow JSON cannot be serialized.'); }
    return [...new Set(issues)];
  }

  const CSS = `
    :host{display:block;color:#203047;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light}
    *{box-sizing:border-box}button,input,select,textarea{font:inherit}button{cursor:pointer;background:#fff;border:1px solid #ccd5e0;border-radius:6px;padding:7px 12px;color:#203047;line-height:1.4}
    button:hover{background:#edf3fc;border-color:#95afd3}button:disabled{opacity:.42;cursor:default}button:focus-visible,input:focus-visible,select:focus-visible,textarea:focus-visible,summary:focus-visible{outline:2px solid #2463cb;outline-offset:3px}
    .primary{background:#245dc1;color:white;border-color:#245dc1}.primary:hover{background:#1c4b9e;color:white}.danger{color:#a33333}.small{padding:4px 8px;font-size:12px}
    .app{max-width:1520px;margin:0 auto;padding:28px 32px;min-height:100vh}.top,.toolbar,.row,.panel-head,.section-head{display:flex;align-items:center;gap:10px}.top{justify-content:space-between;margin-bottom:25px;flex-wrap:wrap}
    .brand{display:flex;align-items:center;gap:12px}.mark{display:grid;place-items:center;background:#245dc1;color:white;width:37px;height:37px;border-radius:9px;font-size:23px;font-weight:600}.brand p,.brand h1{margin:0}.brand h1{font-size:21px;font-weight:650;letter-spacing:-.5px}.brand p{color:#65748a;font-size:12px}.offline{color:#426450;font-size:12px;white-space:nowrap}.offline::before{content:'●';color:#43845a;margin-right:6px}
    .toolbar{flex-wrap:wrap}.workspace{display:grid;grid-template-columns:290px minmax(0,1fr);border:1px solid #d6dde7;border-radius:10px;overflow:hidden;background:white;min-height:650px}.sidebar{background:#f8fafd;border-right:1px solid #d6dde7;padding:20px 12px;min-width:0}.file{padding:0 10px 16px;border-bottom:1px solid #e0e6ee;margin-bottom:12px}.file strong{font-size:17px;display:block;overflow-wrap:anywhere}.muted{color:#69788e}.file small{display:block;overflow-wrap:anywhere}.nav{display:block;text-align:left;width:100%;border-color:transparent;background:transparent;margin:3px 0;padding:9px 10px}.nav.active{background:#e8f0fe;border-color:#c8d9f6;color:#194fa9}.nav strong{font-weight:550}.nav small{display:block;color:#718096;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.step{display:grid;grid-template-columns:25px minmax(0,1fr);align-items:center;gap:7px}.step .number{font-size:12px;color:#718096}.section-head{padding:17px 10px 6px;justify-content:space-between}.section-head h3{font-size:12px;font-weight:650;margin:0;color:#65748a}.steps{max-height:640px;overflow:auto}.nav[draggable=true]{cursor:grab}.nav.drop-target{border:2px dashed #245dc1}.editor{min-width:0;padding:26px 30px}.panel-head{justify-content:space-between;align-items:flex-start;border-bottom:1px solid #e2e7ee;padding-bottom:20px;margin-bottom:22px;flex-wrap:wrap}.panel-head h2{font-size:23px;letter-spacing:-.5px;margin:0 0 4px;overflow-wrap:anywhere}.panel-head p{margin:0;color:#69788e;font-size:13px}.fields{min-width:0}.field{margin:0 0 12px;padding:12px;border:1px solid #e0e6ee;border-radius:7px;background:white}.field-top{display:flex;align-items:center;gap:7px;margin-bottom:9px}.field-top input{font-weight:550;flex:1;min-width:0}.field-top select{width:100px;font-size:12px}.field-top button{padding:4px 8px}.field-value{width:100%;resize:vertical;min-height:37px}.field input,.field select,.field textarea,.add-row input,.add-row select,.filename{border:1px solid #ccd5e0;border-radius:4px;background:#fff;color:#203047;padding:6px 8px}.field textarea{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:13px;line-height:1.6}.nested{border-left:2px solid #e4ebf5;padding-left:13px;margin-top:12px}.nested .field{padding:9px}.field summary{cursor:pointer;color:#63758d;font-size:12px}.add-row{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0}.add-row input{min-width:100px;flex:1}.add-row select{width:105px}.check{display:flex;gap:9px;align-items:center}.check input{width:17px;height:17px}.null{color:#78869a;font-family:monospace}.empty{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:540px;text-align:center;border:1px dashed #b6c6dc;border-radius:10px;background:#fff;padding:40px 20px}.empty h2{font-size:29px;letter-spacing:-.8px;font-weight:600;margin:18px 0 6px}.empty p{color:#69788e;max-width:400px;margin:0 0 24px}.empty .symbol{font:40px ui-monospace,monospace;color:#245dc1}.empty .row{justify-content:center;flex-wrap:wrap}.hint{font-size:12px;color:#78869a;margin-top:20px}.status{min-height:30px;padding-top:12px;font-size:12px;color:#65748a}.status.error{color:#a33333}.checks{margin-top:22px;padding:12px 14px;background:#f7f9fc;border-radius:6px;color:#65748a;font-size:12px}.checks summary{cursor:pointer}.checks ul{padding-left:20px}.checks li{overflow-wrap:anywhere}.raw{width:100%;min-height:470px;resize:vertical;border:1px solid #ccd5e0;border-radius:6px;padding:16px;font:13px/1.65 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2;color:#203047;background:#fbfcfe}.raw-actions{margin-top:12px}.dragging .empty,.dragging .workspace{outline:3px dashed #245dc1;outline-offset:3px}.footer{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-top:14px;color:#78869a;font-size:12px}.filename{max-width:230px;font-size:12px}.array-index{font-size:12px;color:#718096;flex:1}.quiet{background:transparent;border-color:transparent}.badge{font-size:11px;color:#65748a}.empty-list{padding:10px;color:#78869a;font-size:12px}
    @media(min-width:1050px){.fields.root-fields{display:grid;grid-template-columns:1fr 1fr;gap:0 14px;align-items:start}.root-fields>.field.complex,.root-fields>.add-row{grid-column:1/-1}}
    @media(max-width:760px){.app{padding:16px 12px}.top{gap:16px}.workspace{grid-template-columns:1fr}.sidebar{border-right:0;border-bottom:1px solid #d6dde7;padding:12px;max-height:300px;overflow:auto}.steps{max-height:none}.editor{padding:20px 14px}.empty{min-height:430px}.toolbar{gap:6px}.toolbar button{padding:7px 9px}.field{padding:9px}.nested{padding-left:7px}.field-top{flex-wrap:wrap}.field-top input{width:90px}.brand h1{font-size:19px}}
  `;

  class Editor {
    constructor(target, options = {}) {
      this.host = typeof target === 'string' ? document.querySelector(target) : target;
      if (!this.host) throw Error('WorkflowEditor: mount target not found.');
      if (this.host.shadowRoot) throw Error('WorkflowEditor: target already has a shadow root.');
      this.options = options;
      this.root = this.host.attachShadow({ mode: 'open' });
      this.value = null;
      this.history = [];
      this.future = [];
      this.selection = { kind: 'overview' };
      this.filename = 'untitled.webbrain-workflow.json';
      this.saved = 'null';
      this.rawDraft = null;
      this.handlingFieldChange = false;
      this.changeFailed = false;
      this.closed = new Set();
      this.destroyed = false;
      // Let blur/change and the following click finish before replacing controls.
      // This also preserves keyboard focus when tabbing between edited fields.
      this.flushRender = () => {
        if (this.needsRender && !this.pointerActive && !this.deferRender) this.render();
      };
      this.releasePointer = () => { this.pointerActive = false; this.flushRender(); };
      this.pointerUp = () => setTimeout(this.releasePointer, 0);
      this.root.addEventListener('pointerdown', () => { this.pointerActive = true; }, true);
      document.addEventListener('click', this.releasePointer);
      document.addEventListener('pointerup', this.pointerUp);
      document.addEventListener('pointercancel', this.releasePointer);
      this.root.addEventListener('change', event => {
        this.handlingFieldChange = !!event.target.closest?.('[data-path]');
        if (this.handlingFieldChange) this.changeFailed = false;
        this.pendingField = null;
        this.deferRender = true;
        setTimeout(() => { this.handlingFieldChange = false; this.deferRender = false; this.flushRender(); }, 0);
      }, true);
      this.root.addEventListener('input', event => {
        if (event.target.closest('[data-path]')) this.pendingField = event.target;
      });
      this.root.addEventListener('dragover', event => {
        if (Array.from(event.dataTransfer?.types || []).includes('Files')) { event.preventDefault(); this.app.classList.add('dragging'); }
      });
      this.root.addEventListener('dragleave', event => { if (!this.host.contains(event.relatedTarget)) this.app.classList.remove('dragging'); });
      this.root.addEventListener('drop', event => {
        event.preventDefault(); this.app.classList.remove('dragging');
        if (event.dataTransfer?.files.length) this.readFile(event.dataTransfer.files[0]);
      });
      this.root.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); this.download(); }
      });
      if (options.value !== undefined) this.load(options.value, options.filename);
      else this.render();
    }
    el(tag, attrs = {}, children = []) {
      const element = document.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith('on')) element.addEventListener(key.slice(2), value);
        else if (key === 'class') element.className = value;
        else if (key === 'text') element.textContent = value;
        else element.setAttribute(key, value);
      }
      element.append(...children);
      return element;
    }
    button(text, action, className = '', disabled = false) {
      const button = this.el('button', { type: 'button', text, class: className, onclick: action });
      button.disabled = disabled;
      return button;
    }
    message(text, error = false) {
      this.notice = { text, error };
      if (this.status) { this.status.textContent = text; this.status.classList.toggle('error', error); }
    }
    attempt(action) { try { action(); } catch (error) { if (this.handlingFieldChange) this.changeFailed = true; this.render(); this.message(error.message, true); } }
    notify() {
      const value = this.getValue();
      this.host.dispatchEvent(new CustomEvent('workflowchange', { detail: { value }, bubbles: true }));
      if (typeof this.options.onChange === 'function') this.options.onChange(this.getValue(), this);
    }
    load(value, filename = 'workflow.webbrain-workflow.json') {
      const next = parse(value);
      this.value = next;
      this.changeFailed = false;
      this.notice = null;
      this.filename = String(filename || 'workflow.webbrain-workflow.json');
      this.saved = JSON.stringify(next);
      this.history = []; this.future = []; this.rawDraft = null; this.closed.clear();
      this.selection = { kind: 'overview' };
      this.render();
      return this;
    }
    getValue() { return copy(this.value); }
    toJSON(space = 2) {
      if (this.rawDraft !== null) throw Error('Apply or discard your JSON edits before exporting.');
      return JSON.stringify(this.value, null, space) + '\n';
    }
    isDirty() { return !!this.pendingField || this.rawDraft !== null || JSON.stringify(this.value) !== this.saved; }
    validate() { return this.value ? warnings(this.value) : []; }
    markSaved(snapshot) {
      const serialized = JSON.stringify(snapshot);
      if (serialized === undefined) throw Error('markSaved requires the snapshot that finished saving.');
      this.saved = serialized;
      // A host may finish saving while the user is typing their next edit.
      // Do not rebuild controls: that can discard or commit the pending text.
      this.message(this.isDirty() ? 'Unsaved changes remain' : 'Saved');
    }
    destroy() {
      this.destroyed = true;
      document.removeEventListener('click', this.releasePointer);
      document.removeEventListener('pointerup', this.pointerUp);
      document.removeEventListener('pointercancel', this.releasePointer);
      this.root.replaceChildren();
    }
    commit(change) {
      const next = copy(this.value);
      change(next);
      if (JSON.stringify(next) === JSON.stringify(this.value)) return;
      this.history.push(copy(this.value)); if (this.history.length > 100) this.history.shift();
      this.future = []; this.value = next; this.rawDraft = null;
      this.notice = null;
      this.render(); this.notify();
    }
    undo() {
      if (!this.history.length || this.rawDraft !== null) return;
      this.future.push(this.value); this.value = this.history.pop(); this.render(); this.notify();
    }
    redo() {
      if (!this.future.length || this.rawDraft !== null) return;
      this.history.push(this.value); this.value = this.future.pop(); this.render(); this.notify();
    }
    select(kind, index) {
      if (this.rawDraft !== null) { this.message('Apply or discard your JSON edits first.', true); return; }
      this.selection = { kind, index }; this.render();
    }
    confirmReplace() { return !this.isDirty() || global.confirm('Replace this workflow? Download it first to keep your changes.'); }
    async readFile(file) {
      try {
        const value = parse(await file.text());
        if (this.destroyed || !this.confirmReplace()) return;
        this.load(value, file.name); this.message(`Opened ${file.name}. The file stays on your device.`);
      } catch (error) { if (!this.destroyed) this.message(`Could not open file: ${error.message}`, true); }
    }
    newWorkflow() {
      if (!this.confirmReplace()) return;
      this.load({ schema: 'webbrain-workflow/1', id: `workflow_${Date.now()}`, name: 'Untitled workflow', start: { origin: '', pathFamily: '/' }, parameters: [], steps: [] }, 'untitled.webbrain-workflow.json');
      this.saved = 'null'; this.render();
    }
    download() {
      if (!this.value) return;
      if (this.changeFailed) { this.changeFailed = false; return; }
      const active = this.root.activeElement;
      if (active?.matches('.filename')) this.filename = active.value.trim() || 'workflow.json';
      // Keyboard save must include the text still focused in the form.
      if (this.pendingField?.isConnected) {
        this.pendingField.dispatchEvent(new Event('change', { bubbles: true }));
        if (this.changeFailed) { this.changeFailed = false; return; }
      }
      this.attempt(() => {
        const blob = new Blob([this.toJSON()], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = this.el('a', { href: url, download: this.filename.endsWith('.json') ? this.filename : `${this.filename}.json` });
        this.root.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        this.saved = JSON.stringify(this.value); this.render(); this.message('Download created. Your original file is unchanged.');
      });
    }
    set(path, value) {
      this.attempt(() => this.commit(next => {
        if (path.length === 3 && path[0] === 'parameters' && path[2] === 'id') {
          const old = at(next, path);
          if (typeof value !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(value) || normalizeParameterId(value) !== value) {
            throw Error('Parameter ids must use 1–80 lowercase letters, numbers, underscores, or hyphens.');
          }
          if (next.parameters.some((item, i) => i !== path[1] && normalizeParameterId(item?.id) === value)) {
            throw Error('That parameter id already exists after normalization.');
          }
          if (typeof old === 'string' && old && !next.parameters.some((item, i) => i !== path[1] && item?.id === old)) {
            references(next, ref => { if (ref.$workflowParam === old) ref.$workflowParam = value; });
          }
        }
        put(at(next, path.slice(0, -1)), path.at(-1), value);
      }));
    }
    move(path, from, to) {
      this.commit(next => { const items = at(next, path); items.splice(to, 0, items.splice(from, 1)[0]); });
    }
    addItem(kind) {
      this.commit(next => {
        const items = next[kind];
        items.push(kind === 'steps'
          ? { id: freshId('step', items), tool: 'click_ax', args: {}, target: { role: 'button', name: '' }, scope: copy(object(next.start) ? next.start : { origin: '', pathFamily: '/' }), expected: { kind: 'tool_success' } }
          : { id: freshId('parameter', items, normalizeParameterId), label: 'New parameter', type: 'text', required: false, sensitive: false });
        this.selection = { kind, index: items.length - 1 };
      });
    }
    render() {
      if (this.destroyed) return;
      if (this.pointerActive || this.deferRender) { this.needsRender = true; return; }
      this.needsRender = false;
      this.pendingField = null;
      this.changeFailed = false;
      this.renderPaths = new Set();
      const focused = this.root.activeElement;
      const focusLabel = focused?.matches('input,textarea,select') ? focused.getAttribute('aria-label') : null;
      const selection = focused?.selectionStart == null ? null : [focused.selectionStart, focused.selectionEnd];
      this.root.replaceChildren(this.el('style', { text: CSS }));
      this.app = this.el('div', { class: 'app' }); this.root.append(this.app);
      this.fileInput = this.el('input', { type: 'file', accept: '.json,application/json', hidden: '', 'aria-label': 'Open workflow file', onchange: event => { if (event.target.files[0]) this.readFile(event.target.files[0]); } });
      this.app.append(this.fileInput);
      const toolbar = this.el('div', { class: 'toolbar' }, [
        this.button('New', () => this.newWorkflow()), this.button('Open JSON', () => this.fileInput.click()),
        this.button('Undo', () => this.undo(), '', !this.history.length || this.rawDraft !== null),
        this.button('Redo', () => this.redo(), '', !this.future.length || this.rawDraft !== null),
        this.button('Download JSON', () => this.download(), 'primary', !this.value || this.rawDraft !== null)
      ]);
      this.app.append(this.el('header', { class: 'top' }, [
        this.el('div', { class: 'brand' }, [this.el('span', { class: 'mark', text: '≡', 'aria-hidden': 'true' }), this.el('div', {}, [this.el('h1', { text: 'Workflow editor' }), this.el('p', { text: 'WebBrain / local workspace' })])]), toolbar
      ]));
      if (!this.value) {
        this.app.append(this.el('section', { class: 'empty' }, [
          this.el('div', { class: 'symbol', text: '{ }', 'aria-hidden': 'true' }), this.el('h2', { text: 'A workspace for your workflows.' }),
          this.el('p', { text: 'Drop a workflow JSON file here. Rename steps, adjust parameters, and edit every field in one place.' }),
          this.el('div', { class: 'row' }, [this.button('Choose a JSON file', () => this.fileInput.click(), 'primary'), this.button('Start a new workflow', () => this.newWorkflow())]),
          this.el('span', { class: 'hint', text: 'No uploads. No account. No connection required.' })
        ]));
      } else {
        const workspace = this.el('div', { class: 'workspace' });
        workspace.append(this.sidebar());
        this.panel = this.el('section', { class: 'editor', 'aria-label': 'Workflow fields' }); workspace.append(this.panel);
        this.app.append(workspace); this.renderPanel();
      }
      this.status = this.el('div', { class: `status ${this.notice?.error ? 'error' : ''}`, role: 'status', 'aria-live': 'polite', text: this.notice?.text ?? (this.value ? (this.isDirty() ? 'Changes not downloaded' : 'Ready to edit') : 'Open a file or start from scratch.') });
      this.app.append(this.status);
      const footer = this.el('footer', { class: 'footer' }, [this.el('span', { class: 'offline', text: 'Offline · files stay on your device' })]);
      if (this.value) {
        const filename = this.el('input', { class: 'filename', value: this.filename, 'aria-label': 'Download filename', onchange: event => { this.filename = event.target.value.trim() || 'workflow.json'; } });
        footer.append(this.el('label', {}, ['Download as ', filename]));
      } else footer.append(this.el('span', { text: 'Edit locally. Download when you’re ready.' }));
      this.app.append(footer);
      if (focusLabel) {
        const replacement = Array.from(this.root.querySelectorAll('[aria-label]')).find(node => node.getAttribute('aria-label') === focusLabel);
        if (replacement) {
          replacement.focus({ preventScroll: true });
          if (selection && replacement.setSelectionRange) replacement.setSelectionRange(...selection);
        }
      }
    }
    sidebar() {
      const sidebar = this.el('nav', { class: 'sidebar', 'aria-label': 'Workflow navigation' });
      sidebar.append(this.el('div', { class: 'file' }, [this.el('strong', { text: typeof this.value.name === 'string' ? this.value.name : 'Untitled workflow' }), this.el('small', { class: 'muted', text: `${Array.isArray(this.value.steps) ? this.value.steps.length : 0} steps` })]));
      for (const [kind, label] of [['overview', 'Workflow details'], ['json', 'JSON source']]) {
        sidebar.append(this.button(label, () => this.select(kind), `nav ${this.selection.kind === kind ? 'active' : ''}`));
      }
      for (const kind of ['parameters', 'steps']) {
        if (!Array.isArray(this.value[kind])) continue;
        sidebar.append(this.el('div', { class: 'section-head' }, [this.el('h3', { text: `${kind === 'steps' ? 'Steps' : 'Parameters'} (${this.value[kind].length})` }), this.button('+ Add', () => this.addItem(kind), 'small', this.rawDraft !== null || this.value[kind].length >= limits[kind])]));
        const list = this.el('div', { class: 'steps' });
        if (!this.value[kind].length) list.append(this.el('div', { class: 'empty-list', text: `No ${kind} yet.` }));
        this.value[kind].forEach((item, index) => {
          const title = kind === 'steps' ? (item?.name || item?.target?.name || item?.tool || 'Step') : (item?.label || item?.id || 'Parameter');
          const button = this.button('', () => this.select(kind, index), `nav step ${this.selection.kind === kind && this.selection.index === index ? 'active' : ''}`);
          button.setAttribute('aria-label', `${kind === 'steps' ? 'Step' : 'Parameter'} ${index + 1}: ${String(title)}`);
          button.append(this.el('span', { class: 'number', text: String(index + 1).padStart(2, '0') }), this.el('span', {}, [this.el('strong', { text: String(title) }), this.el('small', { text: String(kind === 'steps' ? (item?.tool || '') : (item?.id || '')) })]));
          button.draggable = this.rawDraft === null;
          button.addEventListener('dragstart', event => { this.drag = { kind, index }; event.dataTransfer.setData('text/plain', String(index)); event.dataTransfer.effectAllowed = 'move'; });
          button.addEventListener('dragend', () => { this.drag = null; this.root.querySelectorAll('.drop-target').forEach(node => node.classList.remove('drop-target')); });
          button.addEventListener('dragover', event => { if (this.drag?.kind === kind) { event.preventDefault(); button.classList.add('drop-target'); } });
          button.addEventListener('dragleave', () => button.classList.remove('drop-target'));
          button.addEventListener('drop', event => {
            if (this.drag?.kind !== kind) return;
            event.preventDefault(); event.stopPropagation(); const from = this.drag.index; this.drag = null;
            this.selection = { kind, index }; this.move([kind], from, index);
          });
          list.append(button);
        });
        sidebar.append(list);
      }
      return sidebar;
    }
    renderPanel() {
      let { kind, index } = this.selection;
      if (!['overview', 'json'].includes(kind) && (!Array.isArray(this.value[kind]) || index >= this.value[kind].length)) {
        this.selection = { kind: 'overview' }; kind = 'overview';
      }
      const title = kind === 'overview' ? 'Workflow details' : kind === 'json' ? 'JSON source' : `${kind === 'steps' ? 'Step' : 'Parameter'} ${index + 1}`;
      const subtitle = kind === 'overview' ? 'Name, starting page, and file metadata.' : kind === 'json' ? 'Edit the full document. Apply changes to return to the visual editor.' : kind === 'steps' ? 'Edit any field. Drag steps in the list to reorder them.' : 'Renaming an id also updates its parameter references.';
      const heading = this.el('div', { class: 'panel-head' }, [this.el('div', {}, [this.el('h2', { text: title }), this.el('p', { text: subtitle })])]);
      this.panel.append(heading);
      if (kind === 'json') {
        const raw = this.el('textarea', { class: 'raw', 'aria-label': 'Workflow JSON source', spellcheck: 'false' });
        raw.value = this.rawDraft ?? this.toJSON();
        raw.addEventListener('input', () => {
          this.rawDraft = raw.value;
          this.root.querySelectorAll('.toolbar button').forEach(button => { if (['Undo', 'Redo', 'Download JSON'].includes(button.textContent)) button.disabled = true; });
          this.root.querySelectorAll('.section-head button').forEach(button => { button.disabled = true; });
          this.root.querySelectorAll('[draggable]').forEach(button => { button.draggable = false; });
          this.message('JSON edits pending. Apply changes or discard them.');
        });
        this.panel.append(raw, this.el('div', { class: 'row raw-actions' }, [
          this.button('Apply JSON', () => this.attempt(() => {
            const next = parse(raw.value);
            this.rawDraft = null;
            this.commit(value => { Object.keys(value).forEach(key => delete value[key]); Object.entries(next).forEach(([key, item]) => put(value, key, item)); });
            this.render(); this.message('JSON changes applied.');
          }), 'primary'),
          this.button('Discard JSON edits', () => { this.rawDraft = null; this.render(); })
        ]));
      } else {
        let path = [];
        if (kind !== 'overview') {
          path = [kind, index];
          heading.append(this.el('div', { class: 'row' }, [
            this.button('↑', () => { this.selection.index--; this.move([kind], index, index - 1); }, '', index === 0),
            this.button('↓', () => { this.selection.index++; this.move([kind], index, index + 1); }, '', index === this.value[kind].length - 1),
            this.button('Duplicate', () => this.commit(next => { const item = copy(next[kind][index]); if (object(item)) item.id = freshId(kind === 'steps' ? 'step' : 'parameter', next[kind], kind === 'parameters' ? normalizeParameterId : undefined); next[kind].splice(index + 1, 0, item); this.selection.index++; }), '', this.value[kind].length >= limits[kind]),
            this.button('Remove', () => this.commit(next => { next[kind].splice(index, 1); this.selection = { kind: 'overview' }; }), 'danger')
          ]));
          heading.querySelectorAll('button').forEach(button => { if (button.textContent === '↑') button.setAttribute('aria-label', 'Move up'); if (button.textContent === '↓') button.setAttribute('aria-label', 'Move down'); });
        }
        const value = at(this.value, path);
        if (value !== null && typeof value === 'object') this.panel.append(this.fields(value, path, true));
        else this.panel.append(this.field(value, path));
      }
      const issues = this.validate();
      this.panel.append(this.el('details', { class: 'checks' }, [
        this.el('summary', { text: issues.length ? `${issues.length} workflow check${issues.length === 1 ? '' : 's'} to review` : 'Basic checks passed' }),
        this.el('p', { text: 'Checks cover the starting scope, names, ids, and parameter references. They do not test whether a workflow will run. All fields are preserved when exporting.' }),
        this.el('ul', {}, issues.map(text => this.el('li', { text })))
      ]));
    }
    trackPath(path) {
      this.renderPaths.add(path);
      return path;
    }
    rename(path, nextName) {
      const previous = path.slice(), key = previous.at(-1);
      if (nextName === key) return;
      this.commit(next => {
        const target = at(next, previous.slice(0, -1));
        if (own(target, nextName)) throw Error('A field with that name already exists.');
        const entries = Object.entries(target);
        Object.keys(target).forEach(name => delete target[name]);
        entries.forEach(([name, item]) => put(target, name === key ? nextName : name, item));
        // During a blur-to-click transition, existing controls are still live.
        // Rebase their paths before the following action or nested action runs.
        for (const current of this.renderPaths) {
          if (current.length >= previous.length && previous.every((part, index) => current[index] === part)) {
            current[previous.length - 1] = nextName;
          }
        }
      });
    }
    fields(value, path, root = false) {
      this.trackPath(path);
      const container = this.el('div', { class: `fields ${root ? 'root-fields' : ''}` });
      Object.keys(value).forEach(key => {
        if (!path.length && ['steps', 'parameters'].includes(key) && Array.isArray(value[key])) return;
        container.append(this.field(value[key], [...path, Array.isArray(value) ? Number(key) : key]));
      });
      const keyInput = this.el('input', { placeholder: 'New field name', 'aria-label': `New field name at ${JSON.stringify(path)}` });
      const type = this.el('select', { 'aria-label': `New field type at ${JSON.stringify(path)}` }, Object.keys(defaults).map(name => this.el('option', { value: name, text: name })));
      const add = this.el('form', { class: 'add-row', onsubmit: event => {
        event.preventDefault();
        this.attempt(() => this.commit(next => {
          const parent = at(next, path);
          if (Array.isArray(parent)) parent.push(copy(defaults[type.value]));
          else {
            if (!keyInput.value.trim()) throw Error('Enter a field name.');
            if (own(parent, keyInput.value)) throw Error('A field with that name already exists.');
            put(parent, keyInput.value, copy(defaults[type.value]));
          }
        }));
      } });
      if (!Array.isArray(value)) add.append(keyInput);
      add.append(type, this.el('button', {
        type: 'submit', text: Array.isArray(value) ? '+ Add item' : '+ Add field',
        onclick: event => {
          // Submit before the document click listener flushes a pending redraw.
          // Otherwise Firefox can lose the default submission with the old form.
          event.preventDefault(); add.requestSubmit();
        }
      }));
      container.append(add); return container;
    }
    field(value, path) {
      this.trackPath(path);
      const key = path.at(-1), parentPath = this.trackPath(path.slice(0, -1)), parent = at(this.value, parentPath);
      const array = Array.isArray(parent), type = typeOf(value), address = JSON.stringify(path);
      const field = this.el('div', { class: `field ${['object', 'array'].includes(type) ? 'complex' : ''}`, 'data-path': address });
      const top = this.el('div', { class: 'field-top' });
      if (array) top.append(this.el('span', { class: 'array-index', text: `Item ${Number(key) + 1}` }));
      else {
        const name = this.el('input', { value: key, 'aria-label': `Field name ${address}`, onchange: event => this.attempt(() => this.rename(path, event.target.value)) }); top.append(name);
      }
      const select = this.el('select', { 'aria-label': `Type ${address}`, onchange: event => {
        const nextType = event.target.value;
        if ((type === 'object' || type === 'array') && Object.keys(value).length && !global.confirm('Changing this type replaces its nested fields. Continue?')) { event.target.value = type; return; }
        this.set(path, copy(defaults[nextType]));
      } }, Object.keys(defaults).map(name => this.el('option', { value: name, text: name })));
      select.value = type; top.append(select);
      if (array) {
        const up = this.button('↑', () => this.move(parentPath, key, key - 1), 'small', key === 0); up.setAttribute('aria-label', `Move up ${address}`);
        const down = this.button('↓', () => this.move(parentPath, key, key + 1), 'small', key === parent.length - 1); down.setAttribute('aria-label', `Move down ${address}`); top.append(up, down);
      }
      const remove = this.button('×', () => this.commit(next => { const target = at(next, parentPath); const currentKey = path.at(-1); if (array) target.splice(currentKey, 1); else delete target[currentKey]; }), 'quiet danger');
      remove.setAttribute('aria-label', `Remove ${address}`); top.append(remove); field.append(top);
      if (type === 'object' || type === 'array') {
        const details = this.el('details', {}, [this.el('summary', { text: `${Object.keys(value).length} ${type === 'array' ? 'items' : 'fields'}` }), this.el('div', { class: 'nested' }, [this.fields(value, path)])]);
        details.open = !this.closed.has(address);
        details.addEventListener('toggle', () => { if (!details.isConnected) return; if (details.open) this.closed.delete(address); else this.closed.add(address); });
        field.append(details);
      } else if (type === 'boolean') {
        const checkbox = this.el('input', { type: 'checkbox', 'aria-label': `Value ${address}`, onchange: event => this.set(path, event.target.checked) }); checkbox.checked = value;
        field.append(this.el('label', { class: 'check' }, [checkbox, String(value)]));
      } else if (type === 'null') field.append(this.el('span', { class: 'null', text: 'null' }));
      else {
        const input = this.el(type === 'string' ? 'textarea' : 'input', { class: 'field-value', 'aria-label': `Value ${address}`, spellcheck: 'false' });
        if (type === 'string') input.rows = Math.min(6, Math.max(1, String(value).split('\n').length, Math.ceil(String(value).length / 85)));
        else { input.type = 'number'; input.step = 'any'; }
        input.value = value;
        input.addEventListener('change', () => {
          if (type === 'number' && (!input.value.trim() || !Number.isFinite(Number(input.value)))) { if (this.handlingFieldChange) this.changeFailed = true; input.value = value; this.message('Enter a finite number.', true); return; }
          this.set(path, type === 'number' ? Number(input.value) : input.value);
        });
        field.append(input);
      }
      return field;
    }
  }
  global.WorkflowEditor = Object.freeze({ mount: (target, options) => new Editor(target, options), version: '1.0.0' });
})(globalThis);
