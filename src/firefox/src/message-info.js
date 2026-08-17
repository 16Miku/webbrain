function formatSentTime(createdAt, locale) {
  const value = Number(createdAt);
  if (!Number.isFinite(value) || value <= 0) return '';
  const date = new Date(value);
  try {
    return new Intl.DateTimeFormat(locale || undefined, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZoneName: 'short',
    }).format(date);
  } catch {
    const pad = (part) => String(part).padStart(2, '0');
    const offsetMinutes = -date.getTimezoneOffset();
    const offset = offsetMinutes === 0
      ? 'UTC'
      : `UTC${offsetMinutes > 0 ? '+' : '-'}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}, ${pad(date.getHours())}:${pad(date.getMinutes())} ${offset}`;
  }
}

function firstPositiveInteger(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) return Math.floor(number);
  }
  return 0;
}

function finishReason(result) {
  const raw = result?.raw || {};
  return String(
    result?.finishReason
      ?? raw?.choices?.[0]?.finish_reason
      ?? raw?.stop_reason
      ?? raw?.stopReason
      ?? '',
  ).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
}

function formatNumber(value, locale, maximumFractionDigits = 0) {
  try {
    return new Intl.NumberFormat(locale || undefined, {
      maximumFractionDigits,
    }).format(value);
  } catch {
    return Number(value).toFixed(maximumFractionDigits).replace(/\.0+$/, '');
  }
}

export function aggregateMessageCompletion(current, result, durationMs) {
  const previous = current || {};
  const usage = result?.usage || {};
  const reportedFinishReason = finishReason(result);
  const inputTokens = firstPositiveInteger(
    usage.prompt_tokens,
    usage.input_tokens,
    usage.promptTokens,
    usage.inputTokens,
  );
  const outputTokens = firstPositiveInteger(
    usage.completion_tokens,
    usage.output_tokens,
    usage.completionTokens,
    usage.outputTokens,
  );
  const reportedTotal = firstPositiveInteger(usage.total_tokens, usage.totalTokens);
  const elapsed = Number(durationMs);
  return {
    inputTokens: firstPositiveInteger(previous.inputTokens) + inputTokens,
    outputTokens: firstPositiveInteger(previous.outputTokens) + outputTokens,
    totalTokens: firstPositiveInteger(previous.totalTokens) + (reportedTotal || inputTokens + outputTokens),
    durationMs: firstPositiveInteger(previous.durationMs) + (Number.isFinite(elapsed) && elapsed > 0 ? Math.round(elapsed) : 0),
    finishReason: reportedFinishReason || (Object.hasOwn(result || {}, 'finishReason')
      ? ''
      : String(previous.finishReason || '').slice(0, 80)),
  };
}

export function buildMessageInfoPills({ createdAt, completion = {}, verbose = false, locale } = {}) {
  const time = formatSentTime(createdAt, locale);
  if (!time) return [];
  const pills = [{
    kind: 'sent',
    key: 'sp.message_info.sent',
    params: { time },
  }];
  if (!verbose) return pills;
  const outputTokens = firstPositiveInteger(completion.outputTokens);
  const displayedTokens = outputTokens || firstPositiveInteger(completion.totalTokens);
  const durationMs = firstPositiveInteger(completion.durationMs);
  if (outputTokens && durationMs) {
    pills.push({
      kind: 'speed',
      key: 'sp.message_info.speed',
      params: { rate: formatNumber((outputTokens * 1000) / durationMs, locale, 2) },
    });
  }
  if (displayedTokens) {
    pills.push({
      kind: 'tokens',
      key: 'sp.message_info.tokens',
      params: { count: formatNumber(displayedTokens, locale) },
    });
  }
  if (durationMs) {
    pills.push({
      kind: 'duration',
      key: 'sp.message_info.duration',
      params: { seconds: formatNumber(durationMs / 1000, locale, 2) },
    });
  }
  const reason = String(completion.finishReason || '').trim().slice(0, 80);
  if (reason) {
    pills.push({
      kind: 'finish',
      key: 'sp.message_info.finish',
      params: { reason },
    });
  }
  return pills;
}
