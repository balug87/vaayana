import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MetadataClient } from './books';
import { resolveCover } from './covers';
import { setNetworkPreferences } from './network';
const input = { title: 'The Imaginary Orchard', authors: ['Nora Example'] };
const doc = { key: '/works/OL123W', title: input.title, author_name: input.authors, cover_i: 345 };
const clients: MetadataClient[] = [];
function client(data: unknown, status = 200) {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify(data), { status }));
  const api = new MetadataClient(fetcher, 0); clients.push(api); return { client: api, fetcher };
}
beforeEach(() => setNetworkPreferences({ onlineLookup: true, covers: true, autoFetchCovers: true }));
afterEach(() => { clients.splice(0).forEach(api => api.dispose()); setNetworkPreferences({ onlineLookup: false, covers: false }); vi.unstubAllGlobals(); });
describe('conservative cover-only lookup', () => {
  it('requires NEW explicit cover consent, not old image or online consent', async () => {
    const options = client({ numFound: 1, docs: [doc] });
    setNetworkPreferences({ onlineLookup: true, covers: true });
    await expect(resolveCover(input, options)).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(options.fetcher).not.toHaveBeenCalled();
  });
  it('matches one exact normalized title/author, requests only cover fields and never mutates the input', async () => {
    const options = client({ numFound: 1, docs: [{ ...doc, title: 'ｔｈｅ imaginary   ORCHARD', author_name: ['Nora Example'] }] });
    const original = structuredClone(input);
    expect(await resolveCover(input, options)).toMatchObject({ status: 'found', coverId: 345, matchedBy: 'title-author', sourceUrl: 'https://openlibrary.org/works/OL123W' });
    const url = new URL(String(options.fetcher.mock.calls[0][0]));
    expect(url.searchParams.get('q')).toBe('title:"The Imaginary Orchard" AND author:"Nora Example"');
    expect(url.searchParams.get('fields')).toBe('key,title,author_name,cover_i');
    expect(input).toEqual(original);
  });
  it('does not choose between multiple matching works, even if only one has a cover', async () => {
    const options = client({ numFound: 2, docs: [doc, { ...doc, key: '/works/OL456W', cover_i: undefined }] });
    expect(await resolveCover(input, options)).toMatchObject({ status: 'ambiguous' });
  });
  it.each([
    ['C++: The Invented Field Guide', 'C: The Invented Field Guide'],
    ['C#: The Invented Field Guide', 'C: The Invented Field Guide'],
    ['C++: The Invented Field Guide', 'C#: The Invented Field Guide'],
    ['Invented Roads / Rivers', 'Invented Roads Rivers'],
    ['Invented Guide Vol. 2', 'Invented Guide Vol. 1'],
  ])('never collapses meaningful title symbols/volume identity: %s versus %s', async (title, providerTitle) => {
    expect(await resolveCover({ ...input, title }, client({ numFound: 1, docs: [{ ...doc, title: providerTitle }] }))).toMatchObject({ status: 'no-match' });
  });
  it('rejects truncated result sets instead of guessing uniqueness', async () => {
    expect(await resolveCover(input, client({ numFound: 50, docs: [doc] }))).toMatchObject({ status: 'ambiguous' });
  });
  it('does not fuzzy-match a different author or infer an unknown author', async () => {
    expect(await resolveCover(input, client({ numFound: 1, docs: [{ ...doc, author_name: ['N. Example'] }] }))).toMatchObject({ status: 'no-match' });
    const options = client({});
    expect(await resolveCover({ ...input, authors: [] }, options)).toMatchObject({ status: 'no-match' });
    expect(options.fetcher).not.toHaveBeenCalled();
  });
  it('prefers the exact known edition and does not fetch general metadata or authors', async () => {
    const options = client({ key: '/books/OL12M', covers: [-1, 88], title: 'Provider title never imported', works: [{ key: '/works/OL123W' }] });
    expect(await resolveCover({ ...input, editionKey: '/books/OL12M' }, options)).toMatchObject({ status: 'found', coverId: 88, matchedBy: 'edition' });
    expect(String(options.fetcher.mock.calls[0][0])).toBe('https://openlibrary.org/books/OL12M.json');
    expect(options.fetcher).toHaveBeenCalledOnce();
  });
  it('uses ISBN identity only if the provider confirms the equivalent ISBN', async () => {
    const data = { key: '/books/OL12M', covers: [88], isbn_13: ['9780141033570'] };
    expect(await resolveCover({ ...input, isbn: '0141033576' }, client(data))).toMatchObject({ status: 'found', matchedBy: 'isbn' });
    expect(await resolveCover({ ...input, isbn: '0141033576' }, client({ ...data, isbn_13: [] }))).toMatchObject({ status: 'no-match' });
  });
  it('reports missing covers/404s honestly and rejects foreign records', async () => {
    expect(await resolveCover(input, client({ numFound: 1, docs: [{ ...doc, cover_i: undefined }] }))).toMatchObject({ status: 'no-match' });
    expect(await resolveCover({ ...input, workKey: '/works/OL123W' }, client({}, 404))).toMatchObject({ status: 'no-match' });
    await expect(resolveCover({ ...input, editionKey: '/books/OL12M' }, client({ key: '/books/OL999M', covers: [88] }))).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
  it('runs durable authorization after queue waiting and before every retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{}', { status: 429, headers: { 'retry-after': '0' } })).mockResolvedValueOnce(new Response(JSON.stringify({ numFound: 1, docs: [doc] })));
    const api = new MetadataClient(fetcher, 0); clients.push(api);
    const beforeRequest = vi.fn(async () => {});
    expect(await resolveCover(input, { client: api, beforeRequest })).toMatchObject({ status: 'found' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(beforeRequest.mock.calls.length).toBeGreaterThanOrEqual(4);
  });
  it('aborts active cover lookup on image or automatic consent revocation', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation((_url, options) => new Promise((_resolve, reject) => options?.signal?.addEventListener('abort', () => reject(new DOMException('Cancelled', 'AbortError')))));
    const api = new MetadataClient(fetcher, 0); clients.push(api);
    const operation = resolveCover(input, { client: api });
    const rejected = expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    setNetworkPreferences({ onlineLookup: true, covers: false, autoFetchCovers: true });
    await rejected;
  });
  it('does not fetch while offline or after durable authorization refuses a stale claim', async () => {
    const options = client({});
    await expect(resolveCover(input, { ...options, beforeRequest: () => { throw new DOMException('Stale', 'AbortError'); } })).rejects.toMatchObject({ name: 'AbortError' });
    vi.stubGlobal('navigator', { onLine: false });
    await expect(resolveCover(input, options)).rejects.toMatchObject({ code: 'OFFLINE' });
    expect(options.fetcher).not.toHaveBeenCalled();
  });
});
