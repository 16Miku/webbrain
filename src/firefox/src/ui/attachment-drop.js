const FILE_DRAG_TYPE = 'Files';

export function hasFileDragPayload(event) {
  const dataTransfer = event?.dataTransfer;
  if (!dataTransfer) return false;
  const types = Array.from(dataTransfer.types || [], String);
  return types.includes(FILE_DRAG_TYPE) || Number(dataTransfer.files?.length || 0) > 0;
}

export function installFileDropHandlers(target, onFiles) {
  if (!target?.addEventListener || typeof onFiles !== 'function') return () => {};

  let dragDepth = 0;
  const setDragOver = (active) => target.classList?.toggle?.('drag-over', active);
  const isFileEvent = (event) => hasFileDragPayload(event);

  const onDragEnter = (event) => {
    if (!isFileEvent(event)) return;
    event.preventDefault();
    if (event.relatedTarget && target.contains?.(event.relatedTarget)) return;
    dragDepth += 1;
    setDragOver(true);
  };

  const onDragOver = (event) => {
    if (!isFileEvent(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };

  const onDragLeave = (event) => {
    if (!isFileEvent(event)) return;
    event.preventDefault();
    if (event.relatedTarget && target.contains?.(event.relatedTarget)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) setDragOver(false);
  };

  const onDrop = (event) => {
    if (!isFileEvent(event)) return;
    event.preventDefault();
    dragDepth = 0;
    setDragOver(false);
    const files = event.dataTransfer?.files;
    if (files?.length) onFiles(files);
  };

  const onWindowDragEnd = () => {
    dragDepth = 0;
    setDragOver(false);
  };

  target.addEventListener('dragenter', onDragEnter);
  target.addEventListener('dragover', onDragOver);
  target.addEventListener('dragleave', onDragLeave);
  target.addEventListener('drop', onDrop);
  window.addEventListener?.('dragend', onWindowDragEnd);
  window.addEventListener?.('drop', onWindowDragEnd);

  return () => {
    target.removeEventListener?.('dragenter', onDragEnter);
    target.removeEventListener?.('dragover', onDragOver);
    target.removeEventListener?.('dragleave', onDragLeave);
    target.removeEventListener?.('drop', onDrop);
    window.removeEventListener?.('dragend', onWindowDragEnd);
    window.removeEventListener?.('drop', onWindowDragEnd);
    dragDepth = 0;
    setDragOver(false);
  };
}
