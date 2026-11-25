import type { Book } from '../domain/types';
import { MetadataClient, MetadataServiceError, metadataClient, normalizeIsbn, toIsbn13 } from './books';
import { abortError, canUseNetwork, getNetworkPreferences, subscribeNetworkPreferences, throwIfAborted } from './network';

export type CoverLookupInput = Pick<Book, 'title' | 'authors' | 'isbn' | 'workKey' | 'editionKey'>;
export type CoverResolution =
  | { status: 'found'; coverId: number; sourceUrl: string; fetchedAt: string; matchedBy: 'edition' | 'work' | 'isbn' | 'title-author' }
  | { status: 'no-match' | 'ambiguous'; reason: string };
export function hasCoverConsent(): boolean {
  const preferences = getNetworkPreferences();
  return preferences.onlineLookup && preferences.covers && preferences.autoFetchCovers === true;
}
export const canFetchCovers = (): boolean => hasCoverConsent() && canUseNetwork();
export const normalizeCoverText = (value: string): string => value.normalize('NFKC').toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\u2010-\u2015]/g, '-').replace(/\s+/g, ' ').trim();
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const coverId = (value: unknown): number | undefined => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000 ? value : undefined;
const firstCover = (value: unknown): number | undefined => Array.isArray(value) ? value.map(coverId).find(Boolean) : undefined;
const escapeQuery = (value: string) => value.replace(/[\\"]/g, '\\$&');
function providerKey(value: string, kind: 'edition' | 'work'): string {
  const prefix = kind === 'edition' ? '/books/' : '/works/';
  const expression = kind === 'edition' ? /^(?:\/books\/)?OL\d+M$/ : /^(?:\/works\/)?OL\d+W$/;
  if (!expression.test(value)) throw new MetadataServiceError('INVALID_QUERY', 'The saved provider identifier is invalid.');
  return prefix + value.split('/').pop();
}
/** Resolves a cover reference only. It never imports metadata, notes, photos or diary data. */
export async function resolveCover(input: CoverLookupInput, options: {
  signal?: AbortSignal; beforeRequest?: () => void | Promise<void>; client?: MetadataClient;
} = {}): Promise<CoverResolution> {
  throwIfAborted(options.signal);
  if (!canFetchCovers()) throw new MetadataServiceError('OFFLINE', 'Automatic cover lookup is off or the network is unavailable.');
  const controller = new AbortController();
  const cancel = () => controller.abort();
  if (typeof window !== 'undefined') window.addEventListener('offline', cancel);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const unsubscribe = subscribeNetworkPreferences(() => { if (!canFetchCovers()) cancel(); });
  const client = options.client ?? metadataClient;
  const guard = async () => {
    throwIfAborted(controller.signal);
    if (!canFetchCovers()) throw abortError();
    await options.beforeRequest?.();
    throwIfAborted(controller.signal);
    if (!canFetchCovers()) throw abortError();
  };
  try {
    let path: string;
    let matchedBy: 'edition' | 'work' | 'isbn' | 'title-author';
    if (input.editionKey) { path = `${providerKey(input.editionKey, 'edition')}.json`; matchedBy = 'edition'; }
    else if (input.workKey) { path = `${providerKey(input.workKey, 'work')}.json`; matchedBy = 'work'; }
    else if (input.isbn && toIsbn13(input.isbn)) { path = `/isbn/${normalizeIsbn(input.isbn)}.json`; matchedBy = 'isbn'; }
    else {
      const authors = input.authors.map(normalizeCoverText).filter(Boolean);
      if (!normalizeCoverText(input.title) || !authors.length) return { status: 'no-match', reason: 'A reliable title and author, ISBN, or provider record is needed.' };
      if (input.title.length > 1000 || input.authors.some(value => value.length > 500)) return { status: 'no-match', reason: 'The saved title or author is too long for a safe lookup.' };
      const params = new URLSearchParams({
        q: `title:"${escapeQuery(input.title)}" AND author:"${escapeQuery(input.authors.find(author => normalizeCoverText(author))!)}"`,
        fields: 'key,title,author_name,cover_i', limit: '12',
      });
      path = `/search.json?${params}`; matchedBy = 'title-author';
    }
    await guard();
    const response = await client.request(path, { signal: controller.signal, beforeRequest: guard });
    await guard();
    const data = record(response.data);
    let selectedCover: number | undefined;
    let sourceUrl: string;
    if (matchedBy === 'title-author') {
      if (!Array.isArray(data.docs) || !Number.isSafeInteger(data.numFound) || Number(data.numFound) < 0) throw new MetadataServiceError('INVALID_RESPONSE', 'The cover search response was incomplete.');
      if (Number(data.numFound) > data.docs.length || data.numFoundExact === false) return { status: 'ambiguous', reason: 'Too many possible records. No cover was chosen automatically.' };
      const authors = input.authors.map(normalizeCoverText).filter(Boolean);
      const matches = new Map<string, Record<string, unknown>>();
      for (const value of data.docs) {
        const doc = record(value);
        if (typeof doc.key !== 'string' || !/^\/works\/OL\d+W$/.test(doc.key) || typeof doc.title !== 'string' || normalizeCoverText(doc.title) !== normalizeCoverText(input.title)) continue;
        const names = Array.isArray(doc.author_name) ? doc.author_name.filter((v): v is string => typeof v === 'string').map(normalizeCoverText) : [];
        if (authors.every(author => names.includes(author))) matches.set(doc.key, doc);
      }
      if (matches.size > 1) return { status: 'ambiguous', reason: 'More than one work has this title and author. No cover was chosen automatically.' };
      if (!matches.size) return { status: 'no-match', reason: 'No exact title-and-author match was found.' };
      const [key, doc] = [...matches][0];
      selectedCover = coverId(doc.cover_i); sourceUrl = `https://openlibrary.org${key}`;
    } else {
      const key = typeof data.key === 'string' ? data.key : '';
      if (matchedBy === 'edition' && key !== providerKey(input.editionKey!, 'edition') || matchedBy === 'work' && key !== providerKey(input.workKey!, 'work')) throw new MetadataServiceError('INVALID_RESPONSE', 'The provider returned a different record.');
      if (matchedBy === 'isbn') {
        const isbns = [data.isbn_10, data.isbn_13].flatMap(value => Array.isArray(value) ? value : []).filter((value): value is string => typeof value === 'string');
        if (!/^\/books\/OL\d+M$/.test(key) || !isbns.some(value => toIsbn13(value) === toIsbn13(input.isbn!))) return { status: 'no-match', reason: 'The provider did not confirm the saved ISBN.' };
      }
      selectedCover = firstCover(data.covers); sourceUrl = `https://openlibrary.org${key}`;
    }
    return selectedCover ? { status: 'found', coverId: selectedCover, sourceUrl, fetchedAt: response.fetchedAt, matchedBy } : { status: 'no-match', reason: 'The matching provider record has no available cover.' };
  } catch (error) {
    if (error instanceof MetadataServiceError && error.code === 'NOT_FOUND') return { status: 'no-match', reason: 'The provider has no record for this identifier.' };
    throw error;
  } finally { unsubscribe(); options.signal?.removeEventListener('abort', cancel); if (typeof window !== 'undefined') window.removeEventListener('offline', cancel); }
}
