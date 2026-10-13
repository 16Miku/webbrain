// Recovery choices come from the extension UI, never from a model tool call.
export class FailureRecoveryRegistry {
  constructor() { this.offers = new Map(); this.monitoringRetries = new Map(); }

  offer(binding, descriptor) {
    this.monitoringRetries.delete(binding.tabId);
    const offer = { binding: { ...binding }, descriptor: { ...descriptor } };
    this.offers.set(binding.tabId, offer);
    return { ...offer.descriptor };
  }

  current(binding) {
    const offer = this.offers.get(binding.tabId);
    if (!offer) return null;
    if (offer.binding.conversationId !== binding.conversationId || offer.binding.taskKey !== binding.taskKey
        || offer.binding.taskSignature !== binding.taskSignature) {
      this.offers.delete(binding.tabId);
      this.monitoringRetries.delete(binding.tabId);
      return null;
    }
    return offer;
  }

  reserveMonitoringRetry(binding, recoveryId, requestId, grantToken) {
    const offer = this.current(binding);
    if (!requestId || !grantToken || offer?.descriptor.recoveryId !== recoveryId
        || offer.descriptor.retryMode !== 'action_monitoring_relaxed' || !offer.binding.monitoringPage) return null;
    const previous = this.monitoringRetries.get(binding.tabId);
    if (previous) return previous.requestId === requestId ? previous : null;
    const retry = { offer, requestId, grantToken };
    this.monitoringRetries.set(binding.tabId, retry);
    return retry;
  }

  takeMonitoringRetry(binding, requestId) {
    const offer = this.current(binding), retry = this.monitoringRetries.get(binding.tabId);
    if (!retry || retry.offer !== offer || retry.requestId !== requestId) return null;
    this.clear(binding.tabId);
    return retry;
  }

  clear(tabId) { this.offers.delete(tabId); this.monitoringRetries.delete(tabId); }
}

export function modelFailureRecovery(error, { postAction = false, phase = 'model' } = {}) {
  const code = String(error?.code || 'model_request_failed');
  const stage = postAction ? 'completion_verification' : phase;
  const message = postAction
    ? 'Failed during final verification. The action may have completed. Review the current result before choosing Retry.'
    : code === 'webbrain_cloud_upstream_error'
      ? 'Failed while contacting WebBrain Cloud. The model service could not finish this request. You can retry from the current state.'
      : 'Failed while requesting the model response. You can retry from the current state.';
  return { stage, code, message, retryMode: 'resume', diagnostics: String(error?.message || error || '').slice(0,6000) };
}
