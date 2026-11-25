export const COVER_PHOTO_LIMITS = { sourceBytes: 10 * 1024 * 1024, pixels: 24_000_000, edge: 512, targetBytes: 32 * 1024, bytes: 64 * 1024 } as const;
export interface NormalizedCoverPhoto { blob: Blob; width: number; height: number }
interface Dimensions { width: number; height: number; mime: 'image/jpeg' | 'image/png' | 'image/webp' }
const invalid = () => new Error('Choose a valid JPEG, PNG, or WebP photo. HEIC, SVG, and other formats are not supported.');
/** Read dimensions before decoding, so a small compressed file cannot allocate an enormous bitmap. */
export function coverPhotoDimensions(bytes: Uint8Array): Dimensions {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (bytes.length >= 24 && bytes[0] === 137 && text(1, 3) === 'PNG' && text(12, 4) === 'IHDR') return { width: view.getUint32(16), height: view.getUint32(20), mime: 'image/png' };
  if (bytes.length >= 12 && text(0, 4) === 'RIFF' && text(8, 4) === 'WEBP') {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const chunk = text(offset, 4); const size = view.getUint32(offset + 4, true); const start = offset + 8;
      if (start + size > bytes.length) throw invalid();
      if (chunk === 'VP8X' && size >= 10) {
        if (bytes[start] & 2) throw new Error('Choose a still photo, not an animated WebP.');
        return { width: 1 + bytes[start + 4] + (bytes[start + 5] << 8) + (bytes[start + 6] << 16), height: 1 + bytes[start + 7] + (bytes[start + 8] << 8) + (bytes[start + 9] << 16), mime: 'image/webp' };
      }
      if (chunk === 'VP8 ' && size >= 10 && bytes[start + 3] === 0x9d && bytes[start + 4] === 1 && bytes[start + 5] === 0x2a) return { width: view.getUint16(start + 6, true) & 0x3fff, height: view.getUint16(start + 8, true) & 0x3fff, mime: 'image/webp' };
      if (chunk === 'VP8L' && size >= 5 && bytes[start] === 0x2f) { const bits = view.getUint32(start + 1, true); return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, mime: 'image/webp' }; }
      offset = start + size + (size % 2);
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset < bytes.length) {
      if (bytes[offset++] !== 0xff) throw invalid();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0xd8 || marker === 1 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length) throw invalid();
      const length = view.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) throw invalid();
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker) && length >= 8) return { width: view.getUint16(offset + 5), height: view.getUint16(offset + 3), mime: 'image/jpeg' };
      offset += length;
    }
  }
  throw invalid();
}
/** Strip browser-added metadata without decoding or rewriting the compressed image. */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw invalid();
  const parts: Uint8Array[] = [bytes.subarray(0, 2)];
  let position = 2, scanStart = -1, entropyBytes = 0;
  let entropy = false;
  while (position < bytes.length) {
    if (entropy && bytes[position] !== 0xff) { entropyBytes++; position++; continue; }
    const start = position;
    if (bytes[position++] !== 0xff) throw invalid();
    while (position < bytes.length && bytes[position] === 0xff) position++;
    if (position === bytes.length) throw invalid();
    const marker = bytes[position++];
    // Stuffed FF bytes and restart markers belong to the scan, not metadata.
    if (entropy && (marker === 0 || marker >= 0xd0 && marker <= 0xd7)) { entropyBytes++; continue; }
    entropy = false;
    if (marker === 0xd9) {
      if (scanStart < 0 || !entropyBytes || position !== bytes.length) throw invalid();
      parts.push(bytes.subarray(scanStart));
      const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
      let offset = 0;
      for (const part of parts) { output.set(part, offset); offset += part.length; }
      return output;
    }
    // SOI, TEM and restart markers have no length and are invalid in this position.
    if (marker === 0 || marker === 0xd8 || marker === 1 || marker >= 0xd0 && marker <= 0xd7 || position + 2 > bytes.length) throw invalid();
    const length = (bytes[position] << 8) | bytes[position + 1], end = position + length;
    if (length < 2 || end > bytes.length) throw invalid();
    const metadata = marker === 0xfe || marker >= 0xe0 && marker <= 0xef;
    const plainJfif = marker === 0xe0 && length === 16 &&
      String.fromCharCode(...bytes.subarray(position + 2, position + 7)) === 'JFIF\0' &&
      bytes[end - 2] === 0 && bytes[end - 1] === 0;
    if (scanStart >= 0 && metadata) throw invalid(); // Never retain metadata hidden between scans.
    if (!metadata && ![0xdb, 0xc4, 0xdd, 0xc0, 0xc2, 0xda].includes(marker)) throw invalid();
    if (marker === 0xda) {
      const count = bytes[position + 2];
      if (!count || count > 4 || length !== 6 + count * 2) throw invalid();
      if (scanStart < 0) scanStart = start;
      entropy = true;
    }
    if (scanStart < 0 && (!metadata || plainJfif)) parts.push(bytes.subarray(start, end));
    position = end;
  }
  throw invalid();
}
async function decodePhoto(blob: Blob): Promise<{ source: CanvasImageSource; width: number; height: number; close(): void }> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    return { source: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { image.src = ''; reject(new Error('Photo decoding timed out. Try another image.')); }, 15000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(invalid()); };
      image.src = url;
    });
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => { image.src = ''; } };
  } finally { URL.revokeObjectURL(url); }
}
/** Only the new canvas JPEG is retained. Original bytes, EXIF/GPS and file names are never saved. */
export async function normalizeCoverPhoto(file: File): Promise<NormalizedCoverPhoto> {
  if (!file.size || file.size > COVER_PHOTO_LIMITS.sourceBytes) throw new Error('Choose a photo no larger than 10 MiB. Your current cover has not changed.');
  if (file.type && !['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw invalid();
  const dimensions = coverPhotoDimensions(new Uint8Array(await file.arrayBuffer()));
  if (file.type && file.type !== dimensions.mime) throw invalid();
  if (!dimensions.width || !dimensions.height || dimensions.width * dimensions.height > COVER_PHOTO_LIMITS.pixels) throw new Error('Choose a photo no larger than 24 megapixels. Your current cover has not changed.');
  let decoded: Awaited<ReturnType<typeof decodePhoto>>;
  try { decoded = await decodePhoto(file); } catch { throw new Error('This photo could not be decoded. Choose a valid JPEG, PNG, or WebP photo. Your current cover has not changed.'); }
  try {
    if (!decoded.width || !decoded.height || decoded.width * decoded.height > COVER_PHOTO_LIMITS.pixels) throw new Error('Choose a photo no larger than 24 megapixels.');
    const scale = Math.min(1, COVER_PHOTO_LIMITS.edge / Math.max(decoded.width, decoded.height));
    const width = Math.max(1, Math.round(decoded.width * scale)); const height = Math.max(1, Math.round(decoded.height * scale));
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('This browser cannot prepare cover photos.');
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height); context.drawImage(decoded.source, 0, 0, width, height);
    let result: Blob | undefined;
    for (const quality of [0.85, 0.72, 0.58, 0.42, 0.28]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (!blob || blob.type !== 'image/jpeg') throw new Error('This browser could not create a JPEG cover.');
      // Canvas JPEGs can contain ICC profiles; only the metadata-free JPEG is saved.
      result = new Blob([stripJpegMetadata(new Uint8Array(await blob.arrayBuffer()))], { type: 'image/jpeg' });
      if (result.size <= COVER_PHOTO_LIMITS.targetBytes) break;
    }
    if (!result?.size || result.size > COVER_PHOTO_LIMITS.bytes) throw new Error('This photo is too detailed to fit safely. Crop it and try again. Your current cover has not changed.');
    return { blob: result, width, height };
  } finally { decoded.close(); }
}
