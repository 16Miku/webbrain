export function isTextAttachment(file) {
  const mimeType = typeof file?.type === 'string' ? file.type : '';
  const fileName = typeof file?.name === 'string' ? file.name : '';
  const isImage = mimeType.startsWith('image/');
  const isPdf = mimeType === 'application/pdf';

  // The reported MIME type for text files is OS-registry dependent and
  // often empty — fall back to the extension.
  return mimeType === 'application/json'
    || mimeType === 'text/plain'
    || mimeType === 'text/csv'
    || mimeType === 'text/markdown'
    || (!isImage && !isPdf && /\.(json|txt|csv|md)$/i.test(fileName));
}

const VIDEO_MIME_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const VIDEO_MIME_BY_EXTENSION = { mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm' };

// Returns the canonical video MIME for an upload-only video, or '' when the
// file is not a supported video. Browsers often report an empty or generic
// type for .mov/.webm files, so the extension is the fallback.
export function videoMimeType(file) {
  const mimeType = typeof file?.type === 'string' ? file.type.toLowerCase() : '';
  if (VIDEO_MIME_TYPES.has(mimeType)) return mimeType;
  if (mimeType === 'video/x-m4v') return 'video/mp4';
  if (mimeType && !mimeType.startsWith('video/') && mimeType !== 'application/octet-stream') return '';
  const fileName = typeof file?.name === 'string' ? file.name : '';
  const extension = /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() || '';
  return VIDEO_MIME_BY_EXTENSION[extension] || '';
}

export function isVideoAttachment(file) {
  return videoMimeType(file) !== '';
}
