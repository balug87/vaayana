import type { MetadataFields } from '../domain/types';
export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export function textValue(value: unknown, label: string, max = 20_000): asserts value is string {
  assert(typeof value === 'string' && value.length <= max, `Invalid ${label}.`);
}
export function positive(value: unknown, label: string, allowZero = true): asserts value is number {
  assert(typeof value === 'number' && Number.isFinite(value) && value >= (allowZero ? 0 : 1) && value <= 1_000_000_000, `Invalid ${label}.`);
}
export function validDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T[\d:.]+Z)?$/.test(value) && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString().slice(0, 10) === value.slice(0, 10);
}
export function safeUrl(value: string): string {
  const url = new URL(value);
  assert(url.protocol === 'https:' && !url.username && !url.password, 'Links must use HTTPS without embedded credentials.');
  assert(!/^(localhost|127\.|0\.|169\.254\.|10\.|192\.168\.|\[?::1)/i.test(url.hostname), 'Local/private links are not allowed.');
  return url.href;
}
export function normalizeIsbn(input: string): string {
  const isbn = input.replace(/[\s-]/g, '').toUpperCase();
  assert(/^(?:\d{9}[\dX]|\d{13})$/.test(isbn), 'ISBN must have 10 or 13 characters.');
  if (isbn.length === 10) {
    assert([...isbn].reduce((sum, digit, index) => sum + (digit === 'X' ? 10 : Number(digit)) * (10 - index), 0) % 11 === 0, 'ISBN-10 checksum is invalid.');
    const prefix = `978${isbn.slice(0, 9)}`;
    const check = (10 - [...prefix].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10) % 10;
    return prefix + check;
  }
  assert(/^(978|979)/.test(isbn) && [...isbn].reduce((sum, digit, index) => sum + Number(digit) * (index % 2 ? 3 : 1), 0) % 10 === 0, 'ISBN-13 checksum is invalid.');
  return isbn;
}
export function validateMetadata(fields: Partial<MetadataFields>): void {
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (key === 'authors' || key === 'subjects') {
      assert(Array.isArray(value) && value.length <= 500, `Invalid ${key}.`);
      value.forEach((item) => textValue(item, key, 500));
    } else if (key === 'pageCount' || key === 'coverId') {
      positive(value, key, false);
      assert(Number.isInteger(value), `${key} must be a whole number.`);
    } else textValue(value, key, ['publisher', 'publishedDate', 'language'].includes(key) ? 500 : 20_000);
  }
}
export const METADATA_FIELDS: (keyof MetadataFields)[] = ['title', 'authors', 'subtitle', 'description', 'publisher', 'publishedDate', 'language', 'pageCount', 'coverId', 'subjects'];
export const STATUSES = ['wishlist', 'to-read', 'reading', 'paused', 'finished', 'abandoned'] as const;
