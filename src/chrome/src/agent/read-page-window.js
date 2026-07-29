export const READ_PAGE_DEFAULT_LIMIT = 4000;
export const READ_PAGE_MIN_LIMIT = 500;
export const READ_PAGE_MAX_LIMIT = 6000;

function boundedInteger(value, fallback, min, max) {
  if (value == null || value === '') return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

function withDeliveredText(result, text) {
  const originalLength = Number(result.originalLength) || 0;
  const textOffset = Number(result.textOffset) || 0;
  const returnedLength = text.length;
  const deliveredEnd = Math.min(originalLength, textOffset + returnedLength);
  const hasMore = deliveredEnd < originalLength;
  const textTruncated = textOffset > 0 || hasMore;
  const continuationArgs = hasMore
    ? {
      offset: deliveredEnd,
      limit: Number(result.textLimit) || READ_PAGE_DEFAULT_LIMIT,
      includeChrome: result.includeChrome === true,
    }
    : null;
  return {
    ...result,
    text,
    returnedLength,
    textTruncated,
    hasMore,
    nextOffset: hasMore ? deliveredEnd : null,
    continuationArgs,
    truncationReason: textTruncated ? 'tool_output_window' : null,
  };
}

function compactForm(form, inputLimit) {
  if (!form || typeof form !== 'object' || !Array.isArray(form.inputs)) return form;
  if (form.inputs.length <= inputLimit) return form;
  return {
    ...form,
    inputs: form.inputs.slice(0, inputLimit),
    inputsTruncated: true,
    originalInputCount: form.inputs.length,
  };
}

function compactAuxiliaryContent(result, {
  linkLimit,
  formLimit,
  inputLimit,
  shadowLimit,
  mediaLimit,
}) {
  const links = Array.isArray(result.links) ? result.links : null;
  const forms = Array.isArray(result.forms) ? result.forms : null;
  const shadowDOM = Array.isArray(result.shadowDOM) ? result.shadowDOM : null;
  const media = result.media && typeof result.media === 'object' ? result.media : null;
  const videos = Array.isArray(media?.videos) ? media.videos : null;
  const images = Array.isArray(media?.images) ? media.images : null;
  return {
    ...result,
    ...(links ? {
      links: links.slice(0, linkLimit),
      originalLinkCount: links.length,
    } : {}),
    ...(forms ? {
      forms: forms.slice(0, formLimit).map(form => compactForm(form, inputLimit)),
      originalFormCount: forms.length,
    } : {}),
    ...(shadowDOM ? {
      shadowDOM: shadowDOM.slice(0, shadowLimit),
      originalShadowRootCount: shadowDOM.length,
    } : {}),
    ...(media ? {
      media: {
        ...media,
        ...(videos ? { videos: videos.slice(0, mediaLimit) } : {}),
        ...(images ? { images: images.slice(0, mediaLimit) } : {}),
      },
    } : {}),
    auxiliaryContentTruncated: true,
  };
}

function compactCoreResult(result) {
  const shortString = (value, limit) => (
    typeof value === 'string' ? value.slice(0, limit) : value
  );
  const pageGate = result.pageGate && typeof result.pageGate === 'object'
    ? {
      type: shortString(result.pageGate.type, 100),
      blocking: result.pageGate.blocking === true,
      surface: shortString(result.pageGate.surface, 100),
      label: shortString(result.pageGate.label, 500),
    }
    : undefined;
  return withDeliveredText({
    url: shortString(result.url, 1000),
    title: shortString(result.title, 500),
    text: result.text,
    textSource: shortString(result.textSource, 200),
    isArticlePage: result.isArticlePage === true,
    includeChrome: result.includeChrome === true,
    originalLength: result.originalLength,
    textOffset: result.textOffset,
    textLimit: result.textLimit,
    accessState: result.accessState,
    accessGateEvidence: result.accessGateEvidence,
    ...(pageGate ? { pageGate } : {}),
    auxiliaryContentTruncated: true,
  }, result.text);
}

export function isReadPageWindowResult(result) {
  return !!result
    && typeof result === 'object'
    && typeof result.text === 'string'
    && Number.isFinite(Number(result.originalLength))
    && Number.isFinite(Number(result.textOffset))
    && typeof result.accessState === 'string';
}

export function applyReadPageWindow(result, args = {}) {
  if (!result || typeof result !== 'object' || typeof result.text !== 'string') return result;

  const originalText = result.text;
  const originalLength = originalText.length;
  const requestedOffset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const textOffset = Math.min(requestedOffset, originalLength);
  const textLimit = boundedInteger(
    args.limit,
    READ_PAGE_DEFAULT_LIMIT,
    READ_PAGE_MIN_LIMIT,
    READ_PAGE_MAX_LIMIT,
  );
  const text = originalText.slice(textOffset, textOffset + textLimit);
  const blockingPageGate = result.pageGate?.blocking === true;
  const {
    media,
    activeElement,
    links,
    forms,
    shadowDOM,
    ...core
  } = result;

  return withDeliveredText({
    ...core,
    text,
    originalLength,
    textOffset,
    textLimit,
    accessState: blockingPageGate ? 'blocked_by_page_gate' : 'no_blocking_page_gate',
    accessGateEvidence: blockingPageGate ? 'pageGate' : 'none',
    ...(media !== undefined ? { media } : {}),
    ...(activeElement !== undefined ? { activeElement } : {}),
    ...(links !== undefined ? { links } : {}),
    ...(forms !== undefined ? { forms } : {}),
    ...(shadowDOM !== undefined ? { shadowDOM } : {}),
  }, text);
}

export function fitReadPageWindowResult(result, maxChars = 8000) {
  if (!isReadPageWindowResult(result)) return result;
  const fits = candidate => JSON.stringify(candidate).length <= maxChars;
  if (fits(result)) return result;

  const profiles = [
    { linkLimit: 20, formLimit: 5, inputLimit: 10, shadowLimit: 5, mediaLimit: 5 },
    { linkLimit: 10, formLimit: 3, inputLimit: 5, shadowLimit: 2, mediaLimit: 2 },
    { linkLimit: 0, formLimit: 0, inputLimit: 0, shadowLimit: 0, mediaLimit: 0 },
  ];
  let compact = result;
  for (const profile of profiles) {
    compact = compactAuxiliaryContent(result, profile);
    if (fits(compact)) return compact;
  }
  if (!fits(withDeliveredText(compact, ''))) {
    compact = compactCoreResult(result);
  }

  let low = 0;
  let high = compact.text.length;
  let best = withDeliveredText(compact, '');
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = withDeliveredText(compact, compact.text.slice(0, mid));
    if (fits(candidate)) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}
