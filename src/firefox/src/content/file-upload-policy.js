/** Bounded byte-aware file-input accept policy, shared by isolated content and background transports. */
(() => {
  function validateUploadFile(accept, file = {}) {
    const fail = (reason, actualMime = '') => ({ success: false, dispatched: false, noDispatch: true,
      outcomeUnknown: false, reasonCode: reason, actualMime,
      error: reason === 'file_type_unverified'
        ? 'The actual file type could not be verified against this input’s accepted types. Obtain the intended file bytes, inspect them, and re-read the exact file input before trying again.'
        : 'The actual file content does not match this input’s accepted file types. ' + (actualMime === 'text/html' ? 'A file-viewer web page is not the underlying asset: inspect the source’s Raw/Download link and download that file, then use its new downloadId. ' : 'Obtain the intended file in an accepted format, inspect its actual bytes, and re-read the exact file input before trying again. ') + 'Do not retry this incompatible file or treat local attachment as a remote upload.' });
    const rule = String(accept || '').trim().toLowerCase();
    if (!rule || rule === '*' || rule === '*/*') return { success: true };
    if (rule.length > 4096) return fail('file_type_unverified');
    const tokens = rule.split(',').map(s => s.trim()).filter(Boolean);
    if (tokens.length > 128 || !tokens.length) return fail('file_type_unverified');
    if (tokens.some(s => s === '*' || s === '*/*')) return { success: true };
    if (typeof file.base64 !== 'string') return fail('file_type_unverified');
    const name = String(file.filename || file.name || '').split(/[\\/]/).pop().toLowerCase();
    let bytes;
    try {
      const encoded = String(file.base64 || '');
      const binary = atob(encoded.slice(0, Math.ceil(8192 / 3) * 4));
      bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    } catch { return fail('file_type_unverified'); }
    const is = (...values) => values.every((v, i) => bytes[i] === v);
    const ascii = (start, end) => Array.from(bytes.slice(start, end), b => String.fromCharCode(b)).join('');
    const ftypSize = bytes.length >= 16 ? (bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3]) : 0;
    const brands = [];
    if (ascii(4,8) === 'ftyp' && ftypSize >= 16) {
      brands.push(ascii(8,12));
      for (let offset=16;offset+4<=Math.min(ftypSize,bytes.length,256);offset+=4) brands.push(ascii(offset,offset+4));
    }
    let mime = '', extensions = [], contentKnown = true;
    if (is(137,80,78,71,13,10,26,10)) { mime='image/png'; extensions=['.png']; }
    else if (is(255,216,255)) { mime='image/jpeg'; extensions=['.jpg','.jpeg','.jpe']; }
    else if (ascii(0,6)==='GIF87a' || ascii(0,6)==='GIF89a') { mime='image/gif'; extensions=['.gif']; }
    else if (ascii(0,4)==='RIFF' && ascii(8,12)==='WEBP') { mime='image/webp'; extensions=['.webp']; }
    else if (ascii(0,2)==='BM') { mime='image/bmp'; extensions=['.bmp']; }
    else if (is(73,73,42,0) || is(77,77,0,42)) { mime='image/tiff'; extensions=['.tif','.tiff']; }
    else if (is(0,0,1,0)) { mime='image/vnd.microsoft.icon'; extensions=['.ico']; }
    else if (ascii(0,5)==='%PDF-') { mime='application/pdf'; extensions=['.pdf']; }
    else if (is(80,75,3,4) || is(80,75,5,6) || is(80,75,7,8)) { mime='application/zip'; extensions=['.zip','.docx','.xlsx','.pptx','.odt','.ods','.odp','.epub','.jar']; }
    else if (is(255,10) || is(0,0,0,12,74,88,76,32,13,10,135,10)) { mime='image/jxl'; extensions=['.jxl']; }
    else if (brands.some(brand => brand === 'avif' || brand === 'avis')) { mime='image/avif'; extensions=['.avif']; }
    else if (brands.some(brand => ['heic','heix','hevc','hevx','mif1','msf1'].includes(brand))) { mime='image/heif'; extensions=['.heic','.heif']; }
    else if (ascii(0,4)==='RIFF' && ascii(8,12)==='WAVE') { mime='audio/wav'; extensions=['.wav']; }
    else if (ascii(0,3)==='ID3') { mime='audio/mpeg'; extensions=['.mp3']; }
    else {
      let text=''; try { text=new TextDecoder(bytes[0] === 255 && bytes[1] === 254 ? 'utf-16le' : bytes[0] === 254 && bytes[1] === 255 ? 'utf-16be' : 'utf-8').decode(bytes).replace(/^\uFEFF/,'').trimStart(); } catch {}
      for (let i=0;i<8;i++) {
        const prolog = text.match(/^(?:<\?xml[^>]{0,1024}>|<!--[\s\S]{0,4096}?-->|<!doctype\s+svg[^>]{0,1024}>)\s*/i);
        if (!prolog) break; text=text.slice(prolog[0].length);
      }
      if (/^<svg(?:\s|>)/i.test(text)) { mime='image/svg+xml';extensions=['.svg']; }
      else if (/^(?:<!doctype\s+html\b|<html\b|<head\b|<body\b)/i.test(text)) { mime='text/html';extensions=['.htm','.html']; }
      else if (text && !/[\x00-\x08\x0e-\x1f\uFFFD]/.test(text)) { mime='text/plain'; contentKnown=false; }
      else contentKnown=false;
    }
    const canonical = value => {
      const normalized=String(value || '').split(';')[0].trim().toLowerCase();
      const aliases = {'image/x-png':'image/png','image/jpg':'image/jpeg','image/pjpeg':'image/jpeg','image/x-icon':'image/vnd.microsoft.icon','image/ico':'image/vnd.microsoft.icon','image/heic':'image/heif','application/x-pdf':'application/pdf','application/x-zip-compressed':'application/zip','audio/x-wav':'audio/wav'};
      return Object.prototype.hasOwnProperty.call(aliases, normalized) ? aliases[normalized] : normalized;
    };
    const declared = canonical(file.mimeType || file.type);
    const zipDeclared = mime === 'application/zip' && /^(?:application\/vnd\.openxmlformats-officedocument\.|application\/vnd\.oasis\.opendocument\.|application\/epub\+zip|application\/java-archive)/.test(declared);
    const textualDeclared = declared.startsWith('text/') || /^(?:application\/(?:json|xml|javascript|x-javascript))$/.test(declared);
    const effective = zipDeclared ? declared : contentKnown ? mime : mime === 'text/plain' && textualDeclared ? declared : mime || declared;
    for (const token of tokens) {
      if (/^\.[a-z0-9][a-z0-9._+-]*$/.test(token) && name.endsWith(token)) {
        if (/^\.(?:png|jpe?g|jpe|gif|webp|bmp|tiff?|ico|svg|avif|hei[cf]|jxl|pdf)$/.test(token) && (!contentKnown || !bytes.length)) continue;
        if (/^\.(?:docx|xlsx|pptx|odt|ods|odp|epub|jar|zip)$/.test(token) && mime !== 'application/zip') continue;
        if (/^\.(?:txt|csv|md|json|xml|html?|log)$/.test(token) && mime && !mime.startsWith('text/') && mime !== 'image/svg+xml') continue;
        // A conclusively recognized signature cannot be overridden by a renamed file.
        // Explicit custom extensions and unknown formats retain native accept semantics.
        if (!contentKnown || extensions.includes(token) || !/^\.(?:png|jpe?g|jpe|gif|webp|bmp|tiff?|ico|svg|avif|hei[cf]|jxl|pdf)$/.test(token)) return { success: true, actualMime: mime, contentTypeVerified: contentKnown && mime !== 'application/zip' };
      }
      const normalized=canonical(token);
      if ((normalized.startsWith('image/') || normalized === 'application/pdf') && (!contentKnown || !bytes.length)) continue;
      if (/^[a-z0-9!#$&^_.+-]+\/(?:[a-z0-9!#$&^_.+-]+|\*)$/.test(normalized) && effective) {
        if (!mime && (normalized.startsWith('text/') || /^(?:application\/(?:pdf|zip|json|xml|javascript|x-javascript|vnd\.openxmlformats-officedocument\..*|vnd\.oasis\.opendocument\..*))$/.test(normalized))) continue;
        const match = normalized === effective || (mime === 'application/zip' && normalized === 'application/zip') || (normalized.endsWith('/*') && effective.startsWith(normalized.slice(0,-1)));
        if (match) return { success: true, actualMime: mime, contentTypeVerified: contentKnown && mime !== 'application/zip' };
      }
    }
    return fail(mime || !bytes.length ? 'file_type_mismatch' : 'file_type_unverified', mime || (!bytes.length ? 'application/x-empty' : ''));
  }
  function observedFileViewerResource(base64, sourceUrl) {
    let original;
    try { original = new URL(sourceUrl); } catch { return null; }
    if (original.protocol !== 'https:' || original.hostname !== 'github.com' || original.username || original.password || original.port) return null;
    const parts = original.pathname.split('/');
    if (parts.length < 6 || !parts[1] || !parts[2] || parts[3] !== 'blob') return null;
    let text;
    try { const bin = atob(String(base64 || '').slice(0, Math.ceil(262144 / 3) * 4)); text = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); } catch { return null; }
    const matches = [...text.matchAll(/"rawBlobUrl"\s*:\s*("(?:[^"\\]|\\.){1,4096}")/g)].slice(0, 9);
    if (matches.length !== 1) return null;
    let raw;
    try { raw = new URL(JSON.parse(matches[0][1])); } catch { return null; }
    if (raw.protocol !== 'https:' || raw.hostname !== original.hostname || raw.username || raw.password || raw.port || raw.search || raw.hash) return null;
    const prefix = `/${parts[1]}/${parts[2]}/raw/`, requested = parts.slice(4).join('/');
    if (!raw.pathname.startsWith(prefix)) return null;
    const resolved = raw.pathname.slice(prefix.length).replace(/^refs\/(?:heads|tags)\//, '');
    if (resolved !== requested || /%(?:2f|5c|00)/i.test(raw.pathname)) return null;
    return { kind: 'observed_file_viewer_raw_resource', url: raw.href, fromSavedBytes: true,
      instruction: 'This saved file is the viewer HTML. Download this observed raw resource through download_files under its normal permission checks, then attach the new downloadId. The resource has not yet been downloaded or verified.' };
  }
  globalThis.__wbFileUploadPolicy = Object.freeze({ validateUploadFile, observedFileViewerResource, source: `const validateUploadFile = ${validateUploadFile.toString()};` });
})();
