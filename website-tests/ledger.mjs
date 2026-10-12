import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { HarnessError, scopeDigest } from './config.mjs';

export class MutationLedger {
  constructor(filename, data) { this.filename = filename; this.data = data; this.pending = Promise.resolve(); }
  static async create(config, directory) {
    const data = { schema: 'authenticated-ledger/1', id: randomUUID(), createdAt: new Date().toISOString(), scope: scopeDigest(config), entries: [], resources: [] };
    const ledger = new MutationLedger(path.join(directory, 'ledger.private.json'), data);
    await ledger.save(); return ledger;
  }
  static async load(filename, config) {
    const data = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (data.schema !== 'authenticated-ledger/1' || !Array.isArray(data.entries) || !Array.isArray(data.resources)) throw new HarnessError('invalid_ledger');
    if (data.scope !== scopeDigest(config)) throw new HarnessError('cleanup_scope_changed', 'Use the original authorized accounts and mutation scope to reconcile this run.');
    return new MutationLedger(filename, data);
  }
  async save() {
    this.pending = this.pending.then(async () => {
      await fs.mkdir(path.dirname(this.filename), { recursive: true });
      const tmp = `${this.filename}.${randomUUID()}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
      await fs.rename(tmp, this.filename);
    });
    await this.pending;
  }
  async attempt({ scenario, stage, actor, action, marker, sha256, remoteName, requestId = randomUUID() }) {
    if (this.data.entries.some(e => e.scenario === scenario && e.stage === stage && e.marker === marker && !['not_delivered', 'verified', 'cleaned'].includes(e.status)))
      throw new HarnessError('pending_attempt_requires_reconciliation');
    const entry = { requestId, scenario, stage, actor, action, marker, status: 'attempted', ...(sha256 ? { sha256 } : {}), ...(remoteName ? { remoteName } : {}), attemptedAt: new Date().toISOString() };
    this.data.entries.push(entry); await this.save(); return entry;
  }
  async update(requestId, patch) {
    const entry = this.data.entries.find(e => e.requestId === requestId);
    if (!entry) throw new HarnessError('unknown_attempt');
    // Only durable dispatch/evidence metadata; page/task bodies never belong here.
    for (const key of ['status', 'runId', 'sessionId', 'tabId', 'completedAt', 'code', 'verifiedAt', 'remoteName', 'sha256']) if (patch[key] !== undefined) entry[key] = patch[key];
    await this.save(); return entry;
  }
  async saveLocalReceipt(requestId, receipt) {
    const entry = this.data.entries.find(item => item.requestId === requestId);
    if (!validLocalReceipt(entry, receipt)) throw new HarnessError('local_saved_run_identity_mismatch');
    entry.localReceipt = { backend: 'local', source: receipt.source, tabId: receipt.tabId,
      requestId, runId: receipt.runId, status: receipt.status, active: false };
    await this.save();
  }
  async recordResource(entry, resource, identity) {
    if (!resource?.id || !resource?.url || !identity) throw new HarnessError('resource_ownership_unproven');
    const item = { id: resource.id, url: resource.url, kind: resource.kind, conversationId: resource.conversationId,
      immutable: resource.immutable === true, owned: true, ledgerId: this.data.id,
      threadId: resource.threadId, messageId: resource.messageId,
      sourceStage: entry.stage, expectedBody: resource.expectedBody,
      ownerIdentity: identity, marker: entry.marker, scenario: entry.scenario, requestId: entry.requestId, cleanup: 'pending', observedAt: new Date().toISOString() };
    const old = this.data.resources.find(r => r.id === item.id && r.url === item.url);
    if (old && (old.marker !== item.marker || old.ownerIdentity !== item.ownerIdentity)) throw new HarnessError('resource_ownership_changed');
    if (old && item.expectedBody) { old.expectedBody = item.expectedBody; old.latestStage = entry.stage; }
    if (!old) this.data.resources.push(item);
    await this.save(); return old || item;
  }
  async cleaned(resource) {
    const item = this.data.resources.find(r => r.id === resource.id && r.url === resource.url);
    if (!item) throw new HarnessError('resource_not_owned');
    item.cleanup = 'verified'; item.cleanedAt = new Date().toISOString(); await this.save();
  }
  pendingEntries() { return this.data.entries.filter(e => ['attempted', 'accepted', 'ambiguous', 'running', 'needs_user_input'].includes(e.status)); }
  pendingResources() { return this.data.resources.filter(r => r.cleanup !== 'verified'); }
}

export function validLocalReceipt(entry, receipt) {
  return !!entry && receipt?.backend === 'local' && receipt.source === 'installed-extension-run-journal'
    && Number.isSafeInteger(entry.tabId) && entry.tabId > 0 && receipt.tabId === entry.tabId && receipt.requestId === entry.requestId && !!receipt.runId
    && (!entry.runId || receipt.runId === entry.runId) && receipt.active === false
    && ['completed', 'failed', 'aborted', 'stopped', 'cancelled'].includes(receipt.status);
}
