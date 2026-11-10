import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetadataClient, coverUrl, createDebouncedSearch, isValidIsbn, metadataDiff, normalizeIsbn, toIsbn13 } from './books';
import { getNetworkPreferences, setNetworkPreferences } from './network';
import type { MetadataCandidate, FieldOverride } from '../domain/types';
const book: MetadataCandidate = { workId: '/works/OL1W', title: 'Thinking', authors: ['A Writer'], isbn: [], subjects: ['Decision making'], sourceUrl: 'https://openlibrary.org/works/OL1W', fetchedAt: '2026-01-01T00:00:00.000Z' };
const response = (value: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(value), { status, headers });
const searchData = { docs: [{ key: '/works/OL1W', title: 'Thinking', author_name: ['A Writer'], cover_i: 23, isbn: ['9780141033570'], subject: ['Decision making'], language: ['eng'], ratings_average: 4.2, ratings_count: 15, editions: { docs: [{ key: '/books/OL2M', language: ['eng'], isbn: ['9780141033570'] }] } }] };
const clients: MetadataClient[] = [];
function client(fetcher: typeof fetch, interval = 0, timeout = 1000) { const value = new MetadataClient(fetcher, interval, timeout); clients.push(value); return value; }
beforeEach(() => setNetworkPreferences({ onlineLookup: true, covers: false }));
afterEach(() => { clients.splice(0).forEach(value => value.dispose()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); setNetworkPreferences({ onlineLookup: false, covers: false }); });

describe('ISBN identity', () => {
  it('normalizes and verifies ISBN-10/13 check digits', () => {
    expect(normalizeIsbn('0-14-103357-6')).toBe('0141033576');
    expect(isValidIsbn('0141033576')).toBe(true);
    expect(isValidIsbn('9780141033570')).toBe(true);
    expect(toIsbn13('0141033576')).toBe('9780141033570');
    expect(isValidIsbn('9780141033571')).toBe(false);
    expect(isValidIsbn('bad')).toBe(false);
  });
});
describe('metadata transport and privacy', () => {
  it('has opt-in network settings and no cover URL unless both switches permit it', () => {
    setNetworkPreferences({ onlineLookup: false, covers: true });
    expect(getNetworkPreferences().onlineLookup).toBe(false);
    expect(coverUrl({ coverId: 23 })).toBeUndefined();
    setNetworkPreferences({ onlineLookup: true, covers: false });
    expect(coverUrl({ coverId: 23 })).toBeUndefined();
    setNetworkPreferences({ onlineLookup: true, covers: true });
    expect(coverUrl({ coverId: 23 })).toBe('https://covers.openlibrary.org/b/id/23-M.jpg?default=false');
    expect(coverUrl({ coverId: -3 })).toBeUndefined();
  });
  it('sends explicit bounded fields without credentials or diary fields', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(searchData));
    const results = await client(fetcher).searchBooks('Thinking', { language: 'en' });
    const [url, options] = fetcher.mock.calls[0];
    expect(String(url)).toContain('fields=');
    expect(new URL(String(url)).searchParams.get('q')).toBe('Thinking language:eng');
    expect(options).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(results[0]).toMatchObject({ workId: '/works/OL1W', editionId: '/books/OL2M', language: 'en', rating: { source: 'Open Library reader rating', average: 4.2, count: 15 } });
    expect(results[0].pageCount).toBeUndefined();
  });
  it('does not perform lookups when access is off', async () => {
    setNetworkPreferences({ onlineLookup: false, covers: false });
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).searchBooks('Thinking')).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses cached provider timestamps offline without another network request', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(searchData));
    const api = client(fetcher);
    const original = await api.searchBooks('Thinking');
    setNetworkPreferences({ onlineLookup: false, covers: false });
    const cached = await api.searchBooks('Thinking');
    expect(cached).toEqual(original);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('serializes requests with at least the configured interval', async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { starts.push(Date.now()); return response(searchData); });
    const api = client(fetcher, 35);
    await Promise.all([api.searchBooks('one'), api.searchBooks('two'), api.searchBooks('three')]);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(30);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(30);
  });
  it('keeps the shipped default queue below one network request per second', async () => {
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { starts.push(Date.now()); return response(searchData); });
    const api = client(fetcher, 1050);
    await Promise.all([api.searchBooks('default-one'), api.searchBooks('default-two')]);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
  });
  it('shares the default throttle across independent clients using the origin lock and timestamp', async () => {
    let tail: Promise<unknown> = Promise.resolve();
    const lock = vi.fn((_name: string, _options: unknown, task: () => Promise<unknown>) => {
      const operation = tail.then(task);
      tail = operation.catch(() => undefined);
      return operation;
    });
    const store = new Map<string, string>();
    vi.stubGlobal('navigator', { locks: { request: lock } });
    vi.stubGlobal('localStorage', { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value) });
    const starts: number[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => { starts.push(Date.now()); return response(searchData); });
    await Promise.all([client(fetcher, 1050).searchBooks('tab-one'), client(fetcher, 1050).searchBooks('tab-two')]);
    expect(lock).toHaveBeenCalledTimes(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    expect(store.size).toBe(1);
  });
  it('backs off 429 responses and recovers', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({}, 429, { 'retry-after': '0' })).mockResolvedValueOnce(response(searchData));
    expect(await client(fetcher).searchBooks('Thinking')).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not retry earlier than an excessive Retry-After', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({}, 429, { 'retry-after': '300' }));
    await expect(client(fetcher).searchBooks('Thinking')).rejects.toMatchObject({ status: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('aborts outstanding and queued work when online access is disabled', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))));
    const api = client(fetcher);
    const first = api.searchBooks('first');
    const second = api.searchBooks('second');
    const results = Promise.allSettled([first, second]);
    await new Promise(resolve => setTimeout(resolve, 5));
    setNetworkPreferences({ onlineLookup: false, covers: false });
    expect((await results).every(result => result.status === 'rejected')).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('times out a hung fetch and reports timeout rather than a successful result', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))));
    await expect(client(fetcher, 0, 15).searchBooks('slow')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });
  it('rejects foreign URLs before fetching', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(client(fetcher).request('https://example.com/secret')).rejects.toMatchObject({ code: 'INVALID_QUERY' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('handles malformed optional fields and missing ratings without inventing values', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ docs: [{ key: '/works/OL1W', title: 'Sparse', ratings_average: 9, author_name: null, subject: 'bad' }, { key: 'bad', title: 'Invalid' }] }));
    expect(await client(fetcher).searchBooks('Sparse')).toMatchObject([{ title: 'Sparse', authors: [], subjects: [], rating: undefined }]);
  });
  it('returns an error for malformed search responses', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ notDocs: [] }));
    await expect(client(fetcher).searchBooks('Sparse')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
describe('edition resolution and refresh', () => {
  it('returns actual edition page count/language without treating work facts as edition facts', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ entries: [{ key: '/books/OL2M', title: 'A French edition', number_of_pages: 318, languages: [{ key: '/languages/fre' }], isbn_13: ['9780141033570'] }] }));
    const result = await client(fetcher).getEditions(book, { language: 'fr' });
    expect(result[0]).toMatchObject({ workId: '/works/OL1W', editionId: '/books/OL2M', pageCount: 318, language: 'fr' });
  });
  it('rejects an edition whose work relationship changed', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ key: '/books/OL2M', works: [{ key: '/works/OL99W' }] }));
    await expect(client(fetcher).resolveBook({ ...book, editionId: '/books/OL2M' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('looks up a valid ISBN through its actual edition and work', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ key: '/books/OL2M', title: 'Edition', isbn_13: ['9780141033570'], works: [{ key: '/works/OL1W' }], number_of_pages: 300 }))
      .mockResolvedValueOnce(response({ key: '/works/OL1W', title: 'Work', subjects: ['Psychology'], authors: [] }));
    expect(await client(fetcher).lookupIsbn('9780141033570')).toMatchObject({ workId: '/works/OL1W', editionId: '/books/OL2M', pageCount: 300, isbn: ['9780141033570'] });
  });
  it('refreshes ratings with a distinct real source timestamp', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(response({ title: 'New title', authors: [] })).mockResolvedValueOnce(response({ summary: { average: 4.1, count: 20 } }));
    const result = await client(fetcher).refreshMetadata(book);
    expect(result.title).toBe('New title');
    expect(result.rating).toMatchObject({ source: 'Open Library reader rating', count: 20 });
  });
  it('produces a pure field diff with protected effective overrides', () => {
    const override = { field: 'title', value: 'My title' } as FieldOverride;
    const diff = metadataDiff(book, { ...book, title: 'Provider new', description: undefined }, [override]);
    expect(diff).toEqual([{ field: 'title', previous: 'Thinking', incoming: 'Provider new', effective: 'My title', overridden: true }]);
    expect(book.title).toBe('Thinking');
  });
  it('debounced search rejects superseded input without requesting it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(searchData));
    vi.stubGlobal('fetch', fetcher);
    const input = createDebouncedSearch(10);
    const old = input.search('old');
    const handled = old.catch(error => error);
    const current = input.search('new');
    expect((await handled).name).toBe('AbortError');
    expect(await current).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
