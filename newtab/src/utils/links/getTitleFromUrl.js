/**
 * Default label for a link the user added without a name.
 *
 * Mue fetched the page to read its <title>. That sent the typed URL (and any
 * redirect target) to a site the user had not visited, so it is derived locally
 * instead: the hostname without a leading "www.". Stays async because callers await it.
 */
export async function getTitleFromUrl(url) {
  const value = String(url ?? '').trim();
  try {
    const host = new URL(/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`).hostname;
    return host.replace(/^www\./i, '') || value;
  } catch {
    return value;
  }
}
