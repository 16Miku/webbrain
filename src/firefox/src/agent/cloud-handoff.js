// Run-level control handoff. This deliberately does not pause or power off the
// browser session: the original run keeps its tab and mutation receipts.
export class CloudHandoffGate {
  constructor({ onState = async () => {}, keepAlive = () => () => {} } = {}) {
    this.onState = onState;
    this.keepAlive = keepAlive;
    this.state = null;
    this.waiter = null;
    this.closed = false;
  }

  async request() {
    if (this.closed) throw Object.assign(new Error('This browser run has finished.'), { status: 409 });
    if (this.state) return;
    this.state = 'pausing';
    this.promise = new Promise(resolve => { this.waiter = resolve; });
    await this.onState('pausing');
  }

  async acknowledge() {
    if (this.closed || this.state !== 'pausing') return;
    // A durable acknowledgement is required before the viewer becomes writable.
    await this.onState('paused');
    if (!this.closed && this.state === 'pausing') {
      this.state = 'paused';
      this.stopKeepAlive = this.keepAlive();
    }
  }

  async boundary() {
    if (this.closed || !this.state) return null;
    await this.acknowledge();
    return await this.promise;
  }

  async resume(note = '') {
    if (this.closed || this.state !== 'paused') {
      throw Object.assign(new Error('Wait until this browser run is paused before handing it back.'), { status: 409 });
    }
    this.state = 'resuming';
    await this.onState('resuming');
    this.waiter?.({ note });
    this.waiter = null;
  }

  async observed() {
    if (this.closed) return;
    this.stopKeepAlive?.();
    this.stopKeepAlive = null;
    this.state = null;
    await this.onState('running');
  }

  close() {
    this.closed = true;
    this.stopKeepAlive?.();
    this.stopKeepAlive = null;
    this.waiter?.(null);
    this.waiter = null;
  }
}
