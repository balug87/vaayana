import sharp from 'sharp';
/** Generated pixels only, never a user photograph. */
export async function exampleCoverJpeg(): Promise<Uint8Array> {
  return new Uint8Array(await sharp({ create: { width: 32, height: 48, channels: 3, background: '#71815a' } }).jpeg({ quality: 75 }).toBuffer());
}
/** Fill with unused, legal JPEG tables so exact byte-cap tests exercise real decodable JPEGs. */
export async function exactSizeCoverJpeg(size: number): Promise<Uint8Array> {
  const original = await exampleCoverJpeg();
  let gap = size - original.length;
  const extra: number[] = [];
  while (gap > 183) {
    extra.push(0xff, 0xdb, 0, 67, 3, ...Array(64).fill(1));
    gap -= 69;
  }
  if (gap < 22) throw new Error('Unsupported synthetic fixture size.');
  const symbols = gap - 21;
  const acSymbols = [0, 0xf0, ...Array.from({ length: 160 }, (_, index) => ((Math.floor(index / 10)) << 4) | (index % 10 + 1))];
  extra.push(0xff, 0xc4, (gap - 2) >> 8, (gap - 2) & 255, 0x13,
    ...Array(15).fill(0), symbols, ...acSymbols.slice(0, symbols));
  return Uint8Array.from([...original.slice(0, 2), ...extra, ...original.slice(2)]);
}
