const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.ogg'];

/**
 * A `data:video/` URL, a File's MIME type (`video/mp4`, ...), or an address whose path ends in
 * `.mp4`, `.webm` or `.ogg` is a video. The path is looked at on its own, in lower case, so a
 * signed link such as `https://cdn.example/CLIP.MP4?token=abc` still counts.
 * @param url - The URL of the file to be checked.
 * @returns Whether it is a video.
 */
export default function videoCheck(url) {
  const value = String(url ?? '');
  const lower = value.toLowerCase();
  if (lower.startsWith('data:video/') || lower.startsWith('video/')) return true;
  let pathname;
  try {
    pathname = new URL(value).pathname;
  } catch {
    pathname = value.split(/[?#]/)[0];
  }
  pathname = pathname.toLowerCase();
  return VIDEO_EXTENSIONS.some((extension) => pathname.endsWith(extension));
}
