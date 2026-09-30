import { buildTraceExportPayload } from './export-contract.js';
import { sanitizeTraceExport } from '../agent/trace-export.js';

// Export the stored session without the Markdown preview's text/run limits.
// This deliberately preserves recording-time omission markers: an export
// cannot recover content that was never retained by the recorder.
export async function exportRecordedSession(store, sessionId, version = '') {
  const runs = (await store.listRuns({ limit: Number.MAX_SAFE_INTEGER, conversationId: sessionId }))
    .filter(run => run.conversationId === sessionId)
    .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0) || String(a.runId).localeCompare(String(b.runId)));
  const entries = [];
  let recordingTruncated = false;
  for (const run of runs) {
    const events = await store.getRunEvents(run.runId);
    for (const event of events) {
      if (event.data?.losslessBudgetOmitted || event.data?.result?._truncated || event.data?.messages?._truncated) recordingTruncated = true;
      if (event.kind !== 'screenshot') continue;
      const shot = await store.getScreenshot(run.runId, event.seq);
      if (shot?.blob) {
        const bytes = new Uint8Array(await shot.blob.arrayBuffer());
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
        event.data = { ...event.data, screenshot_base64: `data:${shot.blob.type || 'image/png'};base64,${btoa(binary)}` };
      } else if (shot?.dataUrl) event.data = { ...event.data, screenshot_dataUrl: shot.dataUrl };
    }
    entries.push({ run, events });
  }
  return { json: JSON.stringify(sanitizeTraceExport(buildTraceExportPayload(entries, {
    sessionId, exportedByWebBrainVersion: version,
  })), null, 2), turnCount: entries.length, recordingTruncated };
}
