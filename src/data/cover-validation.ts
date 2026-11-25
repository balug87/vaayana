import type { UploadedCover } from '../domain/types';
import { assert } from './validation';

export const COVER_LIMITS = {
  inputBytes: 10 * 1024 * 1024, inputPixels: 24_000_000, edge: 512,
  targetBytes: 32 * 1024, photoBytes: 64 * 1024, totalPhotoBytes: 8 * 1024 * 1024,
  base64Length: 87_384, leaseMs: 5 * 60_000,
} as const;
const invalid = () => { throw new Error('Invalid cover photo. Choose a JPEG, PNG, or WebP photo and let Vaayana prepare a small JPEG.'); };
/** Bounded JPEG marker/segment validation before any decoder sees the pixels. */
export function validateCoverJpeg(bytes: Uint8Array): { width: number; height: number } {
  assert(bytes.length > 0 && bytes.length <= COVER_LIMITS.photoBytes, 'Prepared cover must be at most 64 KiB. Try a smaller or simpler photo.');
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) invalid();
  let position = 2;
  let width = 0, height = 0;
  let frame = false, scan = false, progressive = false;
  let entropy = false, entropyBytes = 0;
  const components = new Set<number>();
  const componentQuantization = new Map<number, number>();
  const quantizationTables = new Set<number>(), huffmanTables = new Set<number>();
  const word = (offset: number) => (bytes[offset] << 8) | bytes[offset + 1];
  while (position < bytes.length) {
    if (entropy && bytes[position] !== 0xff) { entropyBytes++; position++; continue; }
    if (bytes[position++] !== 0xff) invalid();
    while (bytes[position] === 0xff) position++;
    const marker = bytes[position++];
    if (marker === undefined) invalid();
    if (entropy && (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7))) {
      entropyBytes++; continue;
    }
    entropy = false;
    if (marker === 0xd9) {
      if (position !== bytes.length || !frame || !scan || !quantizationTables.size || !huffmanTables.size || !entropyBytes) invalid();
      return { width, height };
    }
    if (![0xe0, 0xdb, 0xc4, 0xdd, 0xc0, 0xc2, 0xda].includes(marker) || position + 2 > bytes.length) invalid();
    const length = word(position), end = position + length, start = position + 2;
    if (length < 2 || end > bytes.length) invalid();
    if (marker === 0xe0) {
      // Only a plain JFIF header, never EXIF, ICC, comments or other source metadata.
      if (length !== 16 || String.fromCharCode(...bytes.slice(start, start + 5)) !== 'JFIF\0' || bytes[end - 2] || bytes[end - 1]) invalid();
    } else if (marker === 0xdb) {
      let cursor = start;
      if (cursor === end) invalid();
      while (cursor < end) {
        const table = bytes[cursor++];
        if ((table >> 4) > 1 || (table & 15) > 3) invalid();
        const tableEnd = cursor + ((table >> 4) ? 128 : 64);
        if (tableEnd > end) invalid();
        for (; cursor < tableEnd; cursor += (table >> 4) ? 2 : 1) {
          if ((table >> 4) ? !word(cursor) : !bytes[cursor]) invalid();
        }
        quantizationTables.add(table & 15);
      }
      if (cursor !== end) invalid();
    } else if (marker === 0xc4) {
      let cursor = start;
      if (cursor === end) invalid();
      while (cursor < end) {
        const table = bytes[cursor++];
        if ((table >> 4) > 1 || (table & 15) > 3 || cursor + 16 > end) invalid();
        let symbols = 0, available = 1;
        for (let index = 0; index < 16; index++) {
          const count = bytes[cursor++];
          available = available * 2 - count;
          if (available < 0) invalid();
          symbols += count;
        }
        if (!symbols || symbols > 256 || cursor + symbols > end) invalid();
        for (let index = cursor; index < cursor + symbols; index++) {
          const value = bytes[index];
          if ((table >> 4) === 0 ? value > 11 : (value & 15) > 10 || (!(value & 15) && value !== 0 && value !== 0xf0)) invalid();
        }
        cursor += symbols;
        huffmanTables.add(table);
      }
      if (cursor !== end) invalid();
    } else if (marker === 0xdd) {
      if (length !== 4) invalid();
    } else if (marker === 0xc0 || marker === 0xc2) {
      if (frame || length < 8 || bytes[start] !== 8) invalid();
      height = word(start + 1); width = word(start + 3);
      assert(width > 0 && height > 0 && width <= COVER_LIMITS.edge && height <= COVER_LIMITS.edge,
        'Prepared cover must be at most 512 pixels on each edge. Try uploading it again.');
      const count = bytes[start + 5];
      if (![1, 3].includes(count) || length !== 8 + count * 3) invalid();
      for (let cursor = start + 6; cursor < end; cursor += 3) {
        if (components.has(bytes[cursor])) invalid();
        components.add(bytes[cursor]);
        const sampling = bytes[cursor + 1];
        if (!(sampling >> 4) || (sampling >> 4) > 4 || !(sampling & 15) || (sampling & 15) > 4 || bytes[cursor + 2] > 3) invalid();
        componentQuantization.set(bytes[cursor], bytes[cursor + 2]);
      }
      frame = true; progressive = marker === 0xc2;
    } else if (marker === 0xda) {
      const count = bytes[start];
      if (!frame || !quantizationTables.size || !huffmanTables.size || !count || count > components.size || length !== 6 + count * 2) invalid();
      const spectralStart = bytes[end - 3], spectralEnd = bytes[end - 2], approximation = bytes[end - 1];
      if (!progressive && (spectralStart !== 0 || spectralEnd !== 63 || approximation !== 0)) invalid();
      if (progressive && (spectralStart > spectralEnd || spectralEnd > 63 || (spectralStart === 0 && spectralEnd !== 0) ||
        (spectralStart > 0 && count !== 1) || (approximation >> 4) > 13 || (approximation & 15) > 13 ||
        ((approximation >> 4) !== 0 && (approximation >> 4) !== (approximation & 15) + 1))) invalid();
      const seen = new Set<number>();
      for (let cursor = start + 1; cursor < start + 1 + count * 2; cursor += 2) {
        if (!components.has(bytes[cursor]) || seen.has(bytes[cursor]) || (bytes[cursor + 1] >> 4) > 3 || (bytes[cursor + 1] & 15) > 3) invalid();
        if (!quantizationTables.has(componentQuantization.get(bytes[cursor])!)) invalid();
        const dc = bytes[cursor + 1] >> 4, ac = 0x10 | (bytes[cursor + 1] & 15);
        if ((!progressive || (spectralStart === 0 && (approximation >> 4) === 0)) && !huffmanTables.has(dc)) invalid();
        if ((!progressive || spectralStart > 0) && !huffmanTables.has(ac)) invalid();
        seen.add(bytes[cursor]);
      }
      scan = true; entropy = true;
    }
    position = end;
  }
  return invalid();
}
export function bytesToBase64(bytes: Uint8Array): string {
  // Bounded at 64 KiB, avoid spreading a large array into one function call.
  let raw = '';
  for (let index = 0; index < bytes.length; index++) raw += String.fromCharCode(bytes[index]);
  return btoa(raw);
}
export function base64ToCoverBytes(value: string): Uint8Array {
  assert(typeof value === 'string' && value.length <= COVER_LIMITS.base64Length &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),
  'Invalid cover encoding. Only bounded JPEG bytes are supported, not image URLs or SVG.');
  const raw = atob(value);
  assert(btoa(raw) === value, 'Invalid cover encoding.');
  const bytes = Uint8Array.from(raw, (character) => character.charCodeAt(0));
  validateCoverJpeg(bytes);
  return bytes;
}
export function validateUploadedCover(value: UploadedCover): void {
  assert(value.mime === 'image/jpeg', 'Uploaded covers must be prepared JPEG photos.');
  const bytes = base64ToCoverBytes(value.jpegBase64);
  const dimensions = validateCoverJpeg(bytes);
  assert(Number.isInteger(value.byteLength) && value.byteLength === bytes.length &&
    dimensions.width === value.width && dimensions.height === value.height, 'Cover dimensions or byte count do not match the photo.');
}
