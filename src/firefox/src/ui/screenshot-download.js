// Firefox rejects data: URLs in downloads.download. Use an extension-owned
// blob URL and retain it until the download completes (or fails).
export async function saveScreenshot(dataUrl, filename, { saveAs = true, api = browser } = {}) {
  if (!/^data:image\/png;base64,/i.test(dataUrl)) throw new Error('Invalid screenshot image');
  const url = URL.createObjectURL(await (await fetch(dataUrl)).blob());
  let downloadId, timer;
  const release = () => {
    clearTimeout(timer);
    api.downloads.onChanged.removeListener(onChanged);
    URL.revokeObjectURL(url);
  };
  const onChanged = delta => {
    if (delta.id === downloadId && ['complete', 'interrupted'].includes(delta.state?.current)) release();
  };
  api.downloads.onChanged.addListener(onChanged);
  try {
    downloadId = await api.downloads.download({ url, filename, saveAs, conflictAction: 'uniquify' });
    timer = setTimeout(release, 60_000);
    // A small local image can finish before download() resolves.
    const [download] = await api.downloads.search({ id: downloadId });
    if (['complete', 'interrupted'].includes(download?.state)) release();
    return downloadId;
  } catch (error) {
    release();
    throw error;
  }
}
