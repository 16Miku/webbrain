// A read navigation does not undo a native commit. Keep only the latest
// app-owned navigation, and require that exact document's explicit read and
// independent completion verdict; page prose is never commit evidence.
import { withCompletionTimeout } from './completion-verifier.js';

// This isolated-world metadata is shared with content.js's AX scope. It can
// be read at document_start, before the action receiver exists, and never
// inspects page content or dispatches an event.
export function nativeSemanticNavigationScope() {
  if (!window.__wbAxDocumentToken) {
    window.__wbAxDocumentToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  return { documentToken: window.__wbAxDocumentToken, pageUrl: location.href,
    documentIdentity: [location.href, performance.timeOrigin].join('|') };
}

export async function captureSemanticNavigationDocument(api, tabId, committed, signal) {
  const events = api?.webNavigation?.onCommitted;
  if (!committed?.url || (!committed.documentId && !Number.isFinite(committed.timeStamp))
      || !events?.addListener || !events?.removeListener) return null;
  let replaced = false;
  const changed = details => {
    if (details?.tabId !== tabId || details.frameId !== 0) return;
    if (details.url !== committed.url || details.timeStamp !== committed.timeStamp
        || details.documentId !== committed.documentId) replaced = true;
  };
  try {
    // Firefox MV2 has no scripting permission and older native events omit
    // documentId. Keep a commit observer across its immediate script read;
    // Chromium additionally pins the exact native document ID.
    events.addListener(changed);
    return await withCompletionTimeout(async () => {
      let scope, nativeDocumentId = '';
      if (api.scripting?.executeScript && !api.tabs?.executeScript) {
        const target = committed.documentId
          ? { tabId, documentIds: [committed.documentId] } : { tabId, frameIds: [0] };
        const results = await api.scripting.executeScript({ target, injectImmediately: true,
          func: nativeSemanticNavigationScope });
        const result = results?.find(value => value.frameId === 0 && !value.error);
        scope = result?.result; nativeDocumentId = result?.documentId || '';
        if (committed.documentId && nativeDocumentId !== committed.documentId) return null;
      } else if (api.tabs?.executeScript) {
        [scope] = await api.tabs.executeScript(tabId, { frameId: 0, runAt: 'document_start',
          code: `(${nativeSemanticNavigationScope.toString()})()` });
      } else return null;
      if (committed.documentId) {
        const frame = await api.webNavigation.getFrame({ tabId, frameId: 0 });
        if (frame?.documentId !== committed.documentId || frame.url !== committed.url) return null;
      }
      return !replaced && scope?.documentToken && scope.pageUrl === committed.url
        && scope.documentIdentity?.startsWith(committed.url + '|')
        ? { ...scope, nativeDocumentId: committed.documentId || nativeDocumentId } : null;
    }, signal, 2000);
  } catch { return null; }
  finally { try { events.removeListener(changed); } catch {} }
}

// Full native input acknowledgement proves the input was dispatched, even
// when its subsequent observation was interrupted. Retain that provenance
// for fresh read-only verification; this is not evidence of the remote effect.
export function canRecordSemanticCommitDispatch(result) {
  if (!result || result.missingToolResponse === true || result.noDispatch === true
      || result.dispatched === false || result.cancelled === true || result.formValidationFailed === true) return false;
  if (result.success === true && !result.error && result.outcomeUnknown !== true) return true;
  return result.dispatched === true && result.nativeInputAcknowledged === true
    && result.observationInterrupted === true && result.outcomeUnknown === true;
}

function pageUrl(value, base) {
  try {
    const url = new URL(value, base);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
}

export function semanticCommitScopeMatches(submit, context) {
  const binding = submit?.semanticCommit;
  return !!(binding && !binding.invalidated && submit.dispatched && !submit.formValidationFailed
    && binding.documentToken && binding.documentToken === submit.originatingDocument
    && binding.taskKey === context.taskKey && binding.runToken === context.runToken
    && binding.sourceSha256 === context.sourceSha256 && !context.cancelled);
}

export function semanticCommitNavigationRequest(submit, name, args, result, context) {
  const binding = submit?.semanticCommit, prior = binding?.verificationNavigation;
  if (name !== 'navigate' || !semanticCommitScopeMatches(submit, context)
      || context.lastActionSequence !== (prior?.actionSequence ?? submit.actionSequence)
      || context.documentToken !== (prior?.documentToken ?? binding.documentToken)
      || context.documentToken !== submit.currentDocument
      || !pageUrl(context.pageUrl) || pageUrl(context.pageUrl).href !== pageUrl(submit.currentUrl)?.href
      || result?.success !== true || result.dispatched !== true || result.verified !== true
      || result.error || result.outcomeUnknown || result.missingToolResponse || result.noDispatch
      || result.cancelled || result.navigationPending || result.noProgress || result.inconclusive) return null;
  const original = pageUrl(submit.originatingUrl), requested = pageUrl(args?.url, submit.currentUrl);
  const reportedRequest = pageUrl(result.requestedUrl, submit.currentUrl), arrived = pageUrl(result.currentUrl || result.url);
  if (!original || !requested || !reportedRequest || !arrived || requested.href !== reportedRequest.href
      || requested.origin !== original.origin || arrived.origin !== original.origin) return null;
  return { taskKey: binding.taskKey, runToken: binding.runToken, sourceSha256: binding.sourceSha256,
    fromActionSequence: context.lastActionSequence, fromDocument: context.documentToken, url: arrived.href };
}

export function recordSemanticCommitNavigation(submit, before, after, receipt, context) {
  if (!submit?.semanticCommit || Number(after.lastAction?.sequence) <= Number(before.lastAction?.sequence || 0)) return submit;
  const valid = semanticCommitScopeMatches(submit, context) && after.lastAction?.name === 'navigate'
    && receipt?.fromActionSequence === before.lastAction?.sequence
    && receipt.taskKey === submit.semanticCommit.taskKey && receipt.runToken === submit.semanticCommit.runToken
    && receipt.sourceSha256 === submit.semanticCommit.sourceSha256 && receipt.documentToken && receipt.documentIdentity
    && receipt.fromDocument === (submit.semanticCommit.verificationNavigation?.documentToken ?? submit.semanticCommit.documentToken)
    && receipt.documentIdentity.startsWith(receipt.url + '|');
  if (!valid) return { ...submit, observedAfterSubmit: false,
    semanticCommit: { ...submit.semanticCommit, invalidated: true } };
  return { ...submit, currentUrl: receipt.url, currentDocument: receipt.documentToken,
    documentChanged: true, observedAfterSubmit: false, completionSignalObserved: false,
    semanticCommit: { ...submit.semanticCommit, verificationNavigation: {
      actionSequence: after.lastAction.sequence, url: receipt.url,
      documentToken: receipt.documentToken, documentIdentity: receipt.documentIdentity,
    } } };
}

export function semanticCommitIsCurrent(submit, context) {
  const binding = submit?.semanticCommit, navigation = binding?.verificationNavigation;
  const actionSequence = navigation?.actionSequence ?? submit?.actionSequence;
  const documentToken = navigation?.documentToken ?? binding?.documentToken;
  return !!(semanticCommitScopeMatches(submit, context) && submit.observedAfterSubmit
    && documentToken === submit.currentDocument && documentToken === context.documentToken
    && actionSequence === context.lastActionSequence && !context.verificationDebt
    && context.lastObservationSequence > actionSequence
    && pageUrl(submit.currentUrl)?.href === pageUrl(context.pageUrl)?.href
    && (!navigation || navigation.url === pageUrl(context.pageUrl)?.href));
}

export function semanticCommitDocumentMatches(submit, identity) {
  const binding = submit?.semanticCommit;
  return !binding?.invalidated && (!binding?.verificationNavigation
    || binding.verificationNavigation.documentIdentity === identity);
}
