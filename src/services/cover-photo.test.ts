import { afterEach, describe, expect, it, vi } from 'vitest';
import { COVER_PHOTO_LIMITS, coverPhotoDimensions, normalizeCoverPhoto, stripJpegMetadata } from './cover-photo';
import { validateCoverJpeg } from '../data/cover-validation';
import { exampleCoverJpeg } from '../data/cover-test-fixtures';
function jpegBytes(size: number) {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0]);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
}
const join = (...parts: Uint8Array[]) => Uint8Array.from(parts.flatMap(part => [...part]));
function segment(marker: number, payload: string) {
  const bytes = Uint8Array.from(payload, character => character.charCodeAt(0)), length = bytes.length + 2;
  return join(Uint8Array.of(0xff, marker, length >> 8, length & 255), bytes);
}
const inject = (jpeg: Uint8Array, metadata: Uint8Array) => join(jpeg.subarray(0, 2), metadata, jpeg.subarray(2));
function png(width = 1024, height = 2048) {
  const bytes = new Uint8Array(24); bytes.set([137, 80, 78, 71, 13, 10, 26, 10]); bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer); view.setUint32(16, width); view.setUint32(20, height);
  return new File([bytes], 'private-name-never-used.png', { type: 'image/png' });
}
function canvasFixture(sizes = [24_000]) {
  const close = vi.fn(); const drawImage = vi.fn();
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 1024, height: 2048, close })));
  const toBlob = vi.fn((callback: (value: Blob) => void, type: string) => callback(new Blob([jpegBytes(sizes.length > 1 ? sizes.shift()! : sizes[0])], { type })));
  const canvas = { width: 0, height: 0, getContext: () => ({ fillStyle: '', fillRect: vi.fn(), drawImage }), toBlob };
  vi.stubGlobal('document', { createElement: () => canvas });
  return { canvas, close, drawImage, toBlob };
}
afterEach(() => vi.unstubAllGlobals());
describe('bounded local-only cover photo preparation', () => {
  it('reencodes supported input into a <=512px JPEG, not original bytes or a file name', async () => {
    const fixture = canvasFixture(); const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const result = await normalizeCoverPhoto(png());
    expect(result).toMatchObject({ width: 256, height: 512 });
    expect(result.blob.type).toBe('image/jpeg'); expect(result.blob.size).toBe(24_000);
    expect(Object.keys(result)).toEqual(['blob', 'width', 'height']);
    expect(fixture.close).toHaveBeenCalledOnce(); expect(fetcher).not.toHaveBeenCalled();
  });
  it('tries lower JPEG quality toward 32KiB and refuses output above the hard64KiB cap', async () => {
    const fixture = canvasFixture([80_000, 45_000, 30_000]);
    expect((await normalizeCoverPhoto(png())).blob.size).toBe(30_000);
    expect(fixture.toBlob).toHaveBeenCalledTimes(3);
    canvasFixture([70_000]);
    await expect(normalizeCoverPhoto(png())).rejects.toThrow('Crop it');
  });
  it('checks24MP BEFORE decoding and10MiB BEFORE reading', async () => {
    const fixture = canvasFixture();
    await expect(normalizeCoverPhoto(png(6000, 4001))).rejects.toThrow('24 megapixels');
    expect(createImageBitmap).not.toHaveBeenCalled(); expect(fixture.toBlob).not.toHaveBeenCalled();
    const oversized = { size: COVER_PHOTO_LIMITS.sourceBytes + 1, arrayBuffer: vi.fn() } as unknown as File;
    await expect(normalizeCoverPhoto(oversized)).rejects.toThrow('10 MiB');
    expect(oversized.arrayBuffer).not.toHaveBeenCalled();
  });
  it('accepts the exact24MP source limit and preserves the previous cover on decoder errors', async () => {
    canvasFixture();
    expect((await normalizeCoverPhoto(png(6000, 4000))).blob.type).toBe('image/jpeg');
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw new Error('Bad decoder'); }));
    await expect(normalizeCoverPhoto(png())).rejects.toThrow('current cover has not changed');
  });
  it('rejects SVG/HEIC, type spoofing and damaged headers clearly without decoding', async () => {
    canvasFixture();
    for (const type of ['image/svg+xml', 'image/heic']) await expect(normalizeCoverPhoto(new File(['unsafe'], 'x', { type }))).rejects.toThrow('not supported');
    const file = png();
    await expect(normalizeCoverPhoto(new File([await file.arrayBuffer()], 'x.jpg', { type: 'image/jpeg' }))).rejects.toThrow('not supported');
    await expect(normalizeCoverPhoto(new File(['bad'], 'x.png', { type: 'image/png' }))).rejects.toThrow('not supported');
    expect(createImageBitmap).not.toHaveBeenCalled();
  });
  it('reads JPEG SOF dimensions and WebP lossless dimensions without loading pixels', () => {
    const jpeg = new Uint8Array([255, 216, 255, 192, 0, 8, 8, 2, 0, 1, 0, 0]);
    expect(coverPhotoDimensions(jpeg)).toEqual({ width: 256, height: 512, mime: 'image/jpeg' });
    const webp = new Uint8Array(26); const view = new DataView(webp.buffer);
    webp.set([82, 73, 70, 70], 0); webp.set([87, 69, 66, 80, 86, 80, 56, 76], 8); view.setUint32(16, 5, true); webp[20] = 47;
    view.setUint32(21, (511 << 14) | 255, true);
    expect(coverPhotoDimensions(webp)).toEqual({ width: 256, height: 512, mime: 'image/webp' });
  });
  it('strips Chrome-style ICC metadata so the genuine JPEG passes the unchanged strict validator', async () => {
    const clean = await exampleCoverJpeg();
    const jfif = segment(0xe0, 'JFIF\0\x01\x01\0\0\x01\0\x01\0\0');
    const original = inject(clean, jfif);
    const withIcc = inject(original, segment(0xe2, 'ICC_PROFILE\0\x01\x01generated color profile'));
    expect(() => validateCoverJpeg(withIcc)).toThrow('Invalid cover photo');
    const stripped = stripJpegMetadata(withIcc);
    expect(stripped).toEqual(original);
    expect(validateCoverJpeg(stripped)).toEqual({ width: 32, height: 48 });
  });
  it('drops all APPn except plain JFIF, including JFXX/EXIF/XMP/ICC/IPTC/Adobe and COM', async () => {
    const clean = await exampleCoverJpeg();
    let withMetadata = clean;
    for (let marker = 0xe0; marker <= 0xef; marker++) withMetadata = inject(withMetadata, segment(marker, 'private metadata'));
    for (const [marker, payload] of [[0xe0, 'JFXX\0thumbnail'], [0xe1, 'Exif\0\0GPS'], [0xe1, 'http://ns.adobe.com/xap/1.0/\0XMP'], [0xe2, 'ICC_PROFILE\0'], [0xed, 'Photoshop 3.0\0IPTC'], [0xee, 'Adobe'], [0xfe, 'private comment']] as const) {
      withMetadata = inject(withMetadata, segment(marker, payload));
    }
    expect(stripJpegMetadata(withMetadata)).toEqual(clean);
  });
  it('keeps already-clean genuine JPEG bytes identical, including legal FF fill bytes', async () => {
    const clean = await exampleCoverJpeg();
    expect(stripJpegMetadata(clean)).toEqual(clean);
    const withFill = inject(clean, Uint8Array.of(0xff, 0xff));
    expect(stripJpegMetadata(withFill)).toEqual(withFill);
    expect(validateCoverJpeg(withFill)).toEqual({ width: 32, height: 48 });
  });
  it('rejects every truncated prefix and malformed/no-length header marker without passing output', async () => {
    const clean = await exampleCoverJpeg();
    for (let length = 0; length < clean.length; length++) expect(() => stripJpegMetadata(clean.subarray(0, length))).toThrow('Choose a valid JPEG');
    for (const bad of [
      Uint8Array.of(1, 2, 3, 4), inject(clean, Uint8Array.of(0xff, 0xe2, 0, 1)),
      inject(clean, Uint8Array.of(0xff, 0xe2, 0xff, 0xff)), inject(clean, Uint8Array.of(0xff, 0x00)),
      ...[0xd8, 0xd9, 0x01, 0xd0, 0xd7].map(marker => inject(clean, Uint8Array.of(0xff, marker))),
      join(clean, Uint8Array.of(0)), Uint8Array.of(0xff, 0xd8, 0xff, 0xff),
    ]) expect(() => stripJpegMetadata(bad)).toThrow('Choose a valid JPEG');
  });
  it('copies SOS headers, stuffed FF00, restart markers and entropy through EOI verbatim', async () => {
    const clean = await exampleCoverJpeg();
    const scan = clean.findIndex((value, index) => value === 0xff && clean[index + 1] === 0xda);
    const headerEnd = scan + 2 + (clean[scan + 2] << 8 | clean[scan + 3]);
    // Marker-looking metadata bytes after stuffed FF00 are image data, not a segment.
    const entropy = Uint8Array.of(1, 0xff, 0, 0xe1, 0x45, 0xff, 0xd0, 2, 0xff, 0xff, 0xd7, 3);
    const withEntropy = join(clean.subarray(0, headerEnd), entropy, clean.subarray(headerEnd));
    const stripped = stripJpegMetadata(inject(withEntropy, segment(0xe2, 'ICC_PROFILE\0')));
    expect(stripped).toEqual(withEntropy);
    expect(stripped.subarray(scan)).toEqual(withEntropy.subarray(scan));
    expect(() => stripJpegMetadata(join(clean.subarray(0, -2), segment(0xfe, 'comment'), clean.subarray(-2)))).toThrow('Choose a valid JPEG');
  });
  it('normalizes browser ICC-bearing output into a metadata-free JPEG accepted by storage', async () => {
    const clean = await exampleCoverJpeg();
    const withIcc = inject(clean, segment(0xe2, 'ICC_PROFILE\0\x01\x01generated color profile'));
    const fixture = canvasFixture();
    fixture.toBlob.mockImplementation(callback => callback(new Blob([withIcc], { type: 'image/jpeg' })));
    const result = await normalizeCoverPhoto(png());
    const saved = new Uint8Array(await result.blob.arrayBuffer());
    expect(saved).toEqual(clean);
    expect(validateCoverJpeg(saved)).toEqual({ width: 32, height: 48 });
  });
});
