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
