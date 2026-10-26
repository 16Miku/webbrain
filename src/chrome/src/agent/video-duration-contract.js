// App-owned duration receipt. Tool arguments can establish a target but cannot
// erase it on retry; only the runtime's user-confirmation result can lower it.
const STATES = new Set(['pending', 'enough', 'short', 'unverified', 'unjoined', 'failed']);
const seconds = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 86400 ? value : null;
const TOLERANCE_SECONDS = 0.25;

export function normalizeVideoDurationContract(value) {
  const requestedSeconds = seconds(value?.requestedSeconds);
  if (!requestedSeconds) return null;
  const approved = seconds(value?.approvedDurationSeconds);
  const measured = seconds(value?.durationSeconds);
  const contract = { requestedSeconds, status: STATES.has(value.status) ? value.status : 'pending' };
  if (approved && approved <= requestedSeconds) contract.approvedDurationSeconds = approved;
  if (measured) contract.durationSeconds = measured;
  if (contract.status === 'short' && !measured) contract.status = 'unverified';
  // A status label without a sufficient measured receipt is never proof.
  if (contract.status === 'enough' && (!measured || measured + TOLERANCE_SECONDS < videoDurationRequiredSeconds(contract))) {
    contract.status = measured ? 'short' : 'unverified';
  }
  return contract;
}

export function videoDurationRequiredSeconds(contract) {
  return contract.approvedDurationSeconds || contract.requestedSeconds;
}

export function pinVideoDurationTarget(args, previous) {
  const prior = normalizeVideoDurationContract(previous);
  const video = args?.media === 'video' || (args?.media == null && ((prior && prior.status !== 'enough')
    || ['duration', 'estimated_duration', 'scenes', 'aspect_ratio', 'resolution'].some(key => args?.[key] !== undefined)));
  if (!video) return { args, contract: prior };
  const contract = prior
    || normalizeVideoDurationContract({ requestedSeconds: seconds(args.estimated_duration) || seconds(args.duration), status: 'pending' });
  return { args: contract ? { ...args, media: 'video', estimated_duration: videoDurationRequiredSeconds(contract) } : args, contract };
}

export function recordVideoDurationResult(previous, result) {
  const contract = normalizeVideoDurationContract(previous);
  if (!contract) return null;
  // Keep an already verified deliverable if a subsequent attempt fails. Do
  // not add the durations of separate attempts to manufacture one long video.
  if (contract.status === 'enough') return contract;
  const approved = seconds(result?.approvedDurationSeconds);
  if (approved && approved <= contract.requestedSeconds) contract.approvedDurationSeconds = approved;
  delete contract.durationSeconds;
  if (result?.success !== true || result.error) return { ...contract, status: 'failed' };
  if (result.joined === false) return { ...contract, status: 'unjoined' };
  const video = result.mediaType === 'video' || /^video\//.test(result.mimeType || '');
  const measured = video && (result.mediaId || result.url) ? seconds(result.durationSeconds) : null;
  if (!measured) return { ...contract, status: 'unverified' };
  return { ...contract, durationSeconds: measured,
    status: measured + TOLERANCE_SECONDS >= videoDurationRequiredSeconds(contract) ? 'enough' : 'short' };
}

export function videoDurationCompletionBlock(value, outcome = 'success') {
  const contract = normalizeVideoDurationContract(value);
  if (!contract || outcome !== 'success' || contract.status === 'enough') return null;
  const requiredSeconds = videoDurationRequiredSeconds(contract);
  const detail = contract.status === 'short' ? `The delivered video measures ${contract.durationSeconds} seconds.`
    : contract.status === 'unjoined' ? 'The clips have not been joined into one video.'
    : contract.status === 'unverified' ? 'The delivered video duration could not be verified.'
    : 'No completed video with a verified duration has been delivered.';
  return { success: false, blockedDone: true, videoDurationIncomplete: true,
    reason: 'video_duration_incomplete', requiredSeconds, durationStatus: contract.status,
    ...(contract.durationSeconds ? { durationSeconds: contract.durationSeconds } : {}),
    error: `The requested video requires ${requiredSeconds} seconds. ${detail} Keep estimated_duration:${requiredSeconds} on retries. Success requires one joined video with a measured duration meeting that target. Preserve and report existing assets; if the target cannot be delivered or verified, finish with outcome:"partial" or outcome:"failed" and explain the limitation. Do not regenerate paid clips merely to replace missing verification.` };
}
