import type { MetadataCandidate, MetadataFields, MetadataDiff, FieldOverride } from '../domain/types';
import { DEPLOYMENT_CACHE_PREFIX } from './cache-scope';
import { abortError, canUseNetwork, delay, getNetworkPreferences, subscribeNetworkPreferences, throwIfAborted } from './network';

export type BookMetadata = MetadataCandidate;
export interface LookupOptions { signal?: AbortSignal; language?: string; limit?: number; force?: boolean }
export class MetadataServiceError extends Error {
  constructor(public code: 'OFFLINE' | 'TIMEOUT' | 'HTTP' | 'INVALID_QUERY' | 'NOT_FOUND' | 'INVALID_RESPONSE', message: string, public status?: number) {
    super(message); this.name = 'MetadataServiceError';
  }
}
export const METADATA_CACHE = `${DEPLOYMENT_CACHE_PREFIX}metadata-v1`;
export const SEARCH_FIELDS = 'key,title,author_name,first_publish_year,cover_i,isbn,language,subject,ratings_average,ratings_count,editions,editions.key,editions.title,editions.language,editions.isbn';
const ORIGIN = 'https://openlibrary.org';
const TTL = 24 * 60 * 60 * 1000;
const MAX_CACHE = 80;
const THROTTLE_KEY = 'vaayana:open-library:last-request';
interface Cached { value: unknown; fetchedAt: string; expiresAt: number }
type Json = Record<string, unknown>;
const record = (value: unknown): Json => value && typeof value === 'object' && !Array.isArray(value) ? value as Json : {};
const strings = (value: unknown, max = 60): string[] => Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string').map(s => s.trim().slice(0, 500)).filter(Boolean).slice(0, max) : [];
const text = (value: unknown, max = 10000): string | undefined => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
const positive = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const workKey = (value: unknown): string | undefined => typeof value === 'string' && /^(?:\/works\/)?OL\d+W$/.test(value) ? `/works/${value.split('/').pop()}` : undefined;
const editionKey = (value: unknown): string | undefined => typeof value === 'string' && /^(?:\/books\/)?OL\d+M$/.test(value) ? `/books/${value.split('/').pop()}` : undefined;
const languageCodes: Record<string, string> = { en: 'eng', fr: 'fre', de: 'ger', es: 'spa', it: 'ita', pt: 'por', ml: 'mal', hi: 'hin', ta: 'tam', ja: 'jpn', zh: 'chi', ru: 'rus', ar: 'ara' };
export function normalizeLanguage(value?: string): string | undefined {
  if (!value) return undefined;
  const code = value.split('/').pop()!.toLowerCase();
  const aliases: Record<string, string> = { fra: 'fr', deu: 'de', zho: 'zh', msa: 'ms', nld: 'nl', ron: 'ro', ces: 'cs', ell: 'el' };
  return aliases[code] ?? Object.entries(languageCodes).find(([, provider]) => provider === code)?.[0] ?? (/^[a-z]{2,3}$/.test(code) ? code : undefined);
}
export function normalizeIsbn(value: string): string { return value.replace(/[\s-]/g, '').toUpperCase(); }
export function isValidIsbn(value: string): boolean {
  const isbn = normalizeIsbn(value);
  if (/^\d{9}[\dX]$/.test(isbn)) return [...isbn].reduce((n, c, i) => n + (c === 'X' ? 10 : Number(c)) * (10 - i), 0) % 11 === 0;
  return /^\d{13}$/.test(isbn) && [...isbn].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10 === 0;
}
export function toIsbn13(value: string): string | undefined {
  const isbn = normalizeIsbn(value);
  if (!isValidIsbn(isbn)) return undefined;
  if (isbn.length === 13) return isbn;
  const base = `978${isbn.slice(0, 9)}`;
  const sum = [...base].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0);
  return `${base}${(10 - sum % 10) % 10}`;
}
function validIsbns(value: unknown): string[] { return [...new Set(strings(value).map(normalizeIsbn).filter(isValidIsbn))]; }

/** One serialized queue for every lookup, edition request and recommendation query. */
export class MetadataClient {
  private tail: Promise<unknown> = Promise.resolve();
  private nextRequest = 0;
  private memory = new Map<string, Cached>();
  private controllers = new Set<AbortController>();
  private unsubscribe: () => void;
  constructor(private fetcher: typeof fetch = (...args) => fetch(...args), private interval = 1050, private timeout = 12000) {
    this.unsubscribe = subscribeNetworkPreferences(value => {
      if (!value.onlineLookup) for (const controller of this.controllers) controller.abort();
    });
  }
  dispose(): void { this.unsubscribe(); for (const controller of this.controllers) controller.abort(); }
  async clearCache(): Promise<void> {
    this.memory.clear();
    if (typeof caches !== 'undefined') await caches.delete(METADATA_CACHE);
  }
  private async cached(url: string): Promise<Cached | undefined> {
    if (this.memory.has(url)) return this.memory.get(url);
    try {
      if (typeof caches === 'undefined') return undefined;
      const response = await (await caches.open(METADATA_CACHE)).match(url);
      if (!response) return undefined;
      const entry: Cached = await response.json();
      if (typeof entry.fetchedAt !== 'string' || !Number.isFinite(entry.expiresAt)) return undefined;
      this.memory.set(url, entry);
      return entry;
    } catch { return undefined; }
  }
  private async save(url: string, entry: Cached): Promise<void> {
    this.memory.delete(url); this.memory.set(url, entry);
    while (this.memory.size > MAX_CACHE) this.memory.delete(this.memory.keys().next().value!);
    try {
      if (typeof caches === 'undefined') return;
      const cache = await caches.open(METADATA_CACHE);
      await cache.put(url, new Response(JSON.stringify(entry), { headers: { 'Content-Type': 'application/json' } }));
      const keys = await cache.keys();
      for (const key of keys.slice(0, Math.max(0, keys.length - MAX_CACHE))) await cache.delete(key);
    } catch { /* A replaceable cache must not make a successful lookup fail. */ }
  }
  async request(path: string, options: LookupOptions = {}): Promise<{ data: unknown; fetchedAt: string }> {
    throwIfAborted(options.signal);
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || !/^(\/search\.json|\/(?:works|books)\/OL\d+[WM](?:\/(?:editions|ratings))?\.json|\/isbn\/[\dX]+\.json|\/authors\/OL\d+A\.json)$/.test(url.pathname)) {
      throw new MetadataServiceError('INVALID_QUERY', 'Invalid catalogue request.');
    }
    const cached = await this.cached(url.href);
    throwIfAborted(options.signal);
    if (cached && (!canUseNetwork() || (!options.force && cached.expiresAt > Date.now()))) return { data: cached.value, fetchedAt: cached.fetchedAt };
    if (!canUseNetwork()) throw new MetadataServiceError('OFFLINE', 'Online lookup is off or unavailable. Your saved library is still available.');
    const controller = new AbortController();
    let abortReason: Error | undefined;
    const cancel = () => controller.abort();
    options.signal?.addEventListener('abort', cancel, { once: true });
    this.controllers.add(controller);
    const task = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        throwIfAborted(controller.signal);
        if (!canUseNetwork()) throw new MetadataServiceError('OFFLINE', 'Online lookup has been turned off.');
        if (this.interval >= 1000) {
          try {
            const last = Number(localStorage.getItem(THROTTLE_KEY));
            if (Number.isFinite(last) && last > 0 && last <= Date.now()) this.nextRequest = Math.max(this.nextRequest, last + this.interval);
          } catch { /* Storage may be unavailable in private browsing. */ }
        }
        await delay(this.nextRequest - Date.now(), controller.signal);
        throwIfAborted(controller.signal);
        this.nextRequest = Date.now() + this.interval;
        if (this.interval >= 1000) {
          try { localStorage.setItem(THROTTLE_KEY, String(Date.now())); } catch { /* In-tab queue remains active. */ }
        }
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abortReason = new MetadataServiceError('TIMEOUT', 'The catalogue took too long to respond. Try again.'); controller.abort(); }, this.timeout);
        try {
          const response = await this.fetcher(url.href, {
            signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' },
          });
          if (!response.ok) {
            if ((response.status === 429 || response.status === 503) && attempt < 2) {
              const header = response.headers.get('retry-after');
              const wait = header ? (/^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 1500 * 2 ** attempt;
              if (Number.isFinite(wait) && wait <= 60000) {
                this.nextRequest = Math.max(this.nextRequest, Date.now() + Math.max(0, wait));
                continue;
              }
            }
            throw new MetadataServiceError(response.status === 404 ? 'NOT_FOUND' : 'HTTP', `Catalogue lookup failed (${response.status}). Try again later.`, response.status);
          }
          let value: unknown;
          try { value = await response.json(); } catch { throw new MetadataServiceError('INVALID_RESPONSE', 'The catalogue returned an unreadable response.'); }
          throwIfAborted(controller.signal);
          if (!value || typeof value !== 'object') throw new MetadataServiceError('INVALID_RESPONSE', 'The catalogue response is incomplete.');
          const fetchedAt = new Date().toISOString();
          await this.save(url.href, { value, fetchedAt, expiresAt: Date.now() + TTL });
          return { data: value, fetchedAt };
        } catch (error) {
          if (timedOut) throw new MetadataServiceError('TIMEOUT', 'The catalogue took too long to respond. Try again.');
          throw error;
        } finally { clearTimeout(timer); }
      }
      throw new MetadataServiceError('HTTP', 'The catalogue is temporarily busy.');
    };
    const lockedTask = async () => this.interval >= 1000 && typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('vaayana-open-library', { signal: controller.signal }, task)
      : task();
    const work = this.tail.then(lockedTask);
    this.tail = work.catch(() => undefined);
    try {
      return await new Promise((resolve, reject) => {
        const aborted = () => reject(abortReason ?? abortError());
        controller.signal.addEventListener('abort', aborted, { once: true });
        if (controller.signal.aborted) aborted();
        work.then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', aborted));
      });
    } finally { options.signal?.removeEventListener('abort', cancel); this.controllers.delete(controller); }
  }
  async searchBooks(query: string, options: LookupOptions = {}): Promise<MetadataCandidate[]> {
    const clean = query.trim();
    if (!clean) return [];
    if (clean.length > 300) throw new MetadataServiceError('INVALID_QUERY', 'Please use a search under 300 characters.');
    const maybeIsbn = normalizeIsbn(clean);
    if (/^[\dX]{10,13}$/.test(maybeIsbn)) {
      if (!isValidIsbn(maybeIsbn)) throw new MetadataServiceError('INVALID_QUERY', 'This ISBN has an invalid check digit.');
      return [await this.lookupIsbn(maybeIsbn, options)];
    }
    const language = normalizeLanguage(options.language);
    const params = new URLSearchParams({ q: clean + (language ? ` language:${languageCodes[language] ?? language}` : ''), fields: SEARCH_FIELDS, limit: String(Math.max(1, Math.min(options.limit ?? 12, 40))) });
    const { data, fetchedAt } = await this.request(`/search.json?${params}`, options);
    const docs = record(data).docs;
    if (!Array.isArray(docs)) throw new MetadataServiceError('INVALID_RESPONSE', 'The catalogue did not return search results.');
    return docs.map(value => fromSearch(record(value), fetchedAt, language)).filter((v): v is MetadataCandidate => !!v);
  }
  async lookupIsbn(value: string, options: LookupOptions = {}): Promise<MetadataCandidate> {
    const isbn = normalizeIsbn(value);
    if (!isValidIsbn(isbn)) throw new MetadataServiceError('INVALID_QUERY', 'Enter a valid ISBN-10 or ISBN-13.');
    const { data, fetchedAt } = await this.request(`/isbn/${isbn}.json`, options);
    const edition = record(data);
    const works = Array.isArray(edition.works) ? edition.works : [];
    const workId = workKey(record(works[0]).key);
    if (!workId) throw new MetadataServiceError('INVALID_RESPONSE', 'This edition is not linked to a catalogue work. Add it manually instead.');
    const base = await this.getWork(workId, options);
    return fromEdition(edition, base, fetchedAt);
  }
  private async getWork(id: string, options: LookupOptions): Promise<MetadataCandidate> {
    const key = workKey(id);
    if (!key) throw new MetadataServiceError('INVALID_QUERY', 'Choose a valid catalogue work.');
    const { data, fetchedAt } = await this.request(`${key}.json`, options);
    const work = record(data);
    // Work endpoints contain author IDs, not names. Fetch at most four, using the same queue.
    const names: string[] = [];
    for (const author of (Array.isArray(work.authors) ? work.authors : []).slice(0, 4)) {
      const ref = record(record(author).author).key;
      if (typeof ref === 'string' && /^\/authors\/OL\d+A$/.test(ref)) {
        try { const result = await this.request(`${ref}.json`, options); const name = text(record(result.data).name, 300); if (name) names.push(name); }
        catch (error) { if (options.signal?.aborted || !canUseNetwork()) throw error; }
      }
    }
    return {
      workId: key, title: text(work.title, 1000) ?? 'Untitled catalogue record', authors: names,
      subjects: strings(work.subjects), isbn: [], description: description(work.description),
      coverId: Array.isArray(work.covers) ? positive(work.covers[0]) : undefined,
      sourceUrl: `${ORIGIN}${key}`, fetchedAt,
    };
  }
  async getEditions(candidate: MetadataCandidate, options: LookupOptions = {}): Promise<MetadataCandidate[]> {
    const key = workKey(candidate.workId);
    if (!key) return [];
    const { data, fetchedAt } = await this.request(`${key}/editions.json?limit=${Math.max(1, Math.min(options.limit ?? 20, 40))}`, options);
    const entries = record(data).entries;
    if (!Array.isArray(entries)) throw new MetadataServiceError('INVALID_RESPONSE', 'No edition information was returned.');
    const editions = entries.filter(value => editionKey(record(value).key)).map(value => fromEdition(record(value), candidate, fetchedAt));
    const language = normalizeLanguage(options.language);
    return language ? editions.filter(edition => edition.language === language) : editions;
  }
  async resolveBook(candidate: MetadataCandidate, options: LookupOptions = {}): Promise<MetadataCandidate> {
    if (!candidate.editionId) return candidate;
    const key = editionKey(candidate.editionId);
    if (!key) throw new MetadataServiceError('INVALID_QUERY', 'Choose a valid edition.');
    const { data, fetchedAt } = await this.request(`${key}.json`, options);
    const result = fromEdition(record(data), candidate, fetchedAt);
    const linkedWorks = record(data).works;
    if (Array.isArray(linkedWorks) && !linkedWorks.some(value => workKey(record(value).key) === candidate.workId)) {
      throw new MetadataServiceError('INVALID_RESPONSE', 'The edition no longer matches this work. Choose an edition again.');
    }
    return result;
  }
  async refreshMetadata(candidate: MetadataCandidate, options: LookupOptions = {}): Promise<MetadataCandidate> {
    const base = await this.getWork(candidate.workId, { ...options, force: true });
    let rating = candidate.rating;
    try {
      const result = await this.request(`${base.workId}/ratings.json`, { ...options, force: true });
      const summary = record(record(result.data).summary);
      const average = positive(summary.average), count = positive(summary.count);
      rating = average && average <= 5 && count && Number.isInteger(count) ? { source: 'Open Library reader rating', average, count, fetchedAt: result.fetchedAt } : undefined;
    } catch (error) {
      if (options.signal?.aborted || error instanceof DOMException && error.name === 'AbortError') throw error;
      // Retain an old aggregate with its old date if optional rating refresh fails.
    }
    const combined = { ...base, rating, editionId: candidate.editionId };
    return candidate.editionId ? this.resolveBook(combined, { ...options, force: true }) : combined;
  }
}
function description(value: unknown): string | undefined { return text(typeof value === 'string' ? value : record(value).value); }
function fromSearch(doc: Json, fetchedAt: string, preferredLanguage?: string): MetadataCandidate | undefined {
  const workId = workKey(doc.key);
  const title = text(doc.title, 1000);
  if (!workId || !title) return undefined;
  const editions = record(doc.editions).docs;
  const best = Array.isArray(editions) ? record(editions[0]) : {};
  const languages = strings(best.language ?? doc.language);
  const language = preferredLanguage && languages.some(v => normalizeLanguage(v) === preferredLanguage) ? preferredLanguage : normalizeLanguage(languages[0]);
  const average = positive(doc.ratings_average);
  const count = positive(doc.ratings_count);
  return {
    workId, editionId: editionKey(best.key), title, authors: strings(doc.author_name, 10),
    subjects: strings(doc.subject), isbn: validIsbns(best.isbn ?? doc.isbn), language,
    firstPublishYear: positive(doc.first_publish_year), coverId: positive(doc.cover_i),
    rating: average && average <= 5 && count ? { source: 'Open Library reader rating', average, count, fetchedAt } : undefined,
    sourceUrl: `${ORIGIN}${workId}`, fetchedAt,
  };
}
function fromEdition(edition: Json, base: MetadataCandidate, fetchedAt: string): MetadataCandidate {
  const languageValue = Array.isArray(edition.languages) ? record(edition.languages[0]).key : undefined;
  return {
    ...base, editionId: editionKey(edition.key) ?? base.editionId,
    title: text(edition.title, 1000) ?? base.title, subtitle: text(edition.subtitle, 1000),
    isbn: [...new Set([...validIsbns(edition.isbn_13), ...validIsbns(edition.isbn_10)])],
    publisher: strings(edition.publishers, 5).join(', ') || undefined, publishedDate: text(edition.publish_date, 100),
    language: normalizeLanguage(typeof languageValue === 'string' ? languageValue : undefined),
    pageCount: positive(edition.number_of_pages), description: description(edition.description) ?? base.description,
    coverId: Array.isArray(edition.covers) ? positive(edition.covers[0]) ?? base.coverId : base.coverId,
    sourceUrl: `${ORIGIN}${editionKey(edition.key) ?? base.workId}`, fetchedAt,
  };
}
export const metadataClient = new MetadataClient();
export const searchBooks = (query: string, options?: LookupOptions) => metadataClient.searchBooks(query, options);
export const lookupIsbn = (isbn: string, options?: LookupOptions) => metadataClient.lookupIsbn(isbn, options);
export const getEditions = (candidate: MetadataCandidate, options?: LookupOptions) => metadataClient.getEditions(candidate, options);
export const resolveBook = (candidate: MetadataCandidate, options?: LookupOptions) => metadataClient.resolveBook(candidate, options);
export const refreshMetadata = (candidate: MetadataCandidate, options?: LookupOptions) => metadataClient.refreshMetadata(candidate, options);
export const clearMetadataCache = () => metadataClient.clearCache();

export function coverUrl(candidate: Pick<MetadataCandidate, 'coverId'>): string | undefined {
  const settings = getNetworkPreferences();
  return settings.onlineLookup && settings.covers && candidate.coverId && Number.isSafeInteger(candidate.coverId) && candidate.coverId > 0
    ? `https://covers.openlibrary.org/b/id/${candidate.coverId}-M.jpg?default=false` : undefined;
}
export function metadataDiff(previous: MetadataCandidate, incoming: MetadataCandidate, overrides: FieldOverride[] = []): MetadataDiff[] {
  const fields: (keyof MetadataFields)[] = ['title', 'authors', 'subtitle', 'description', 'publisher', 'publishedDate', 'language', 'pageCount', 'coverId', 'subjects'];
  return fields.filter(field => incoming[field] !== undefined && JSON.stringify(previous[field]) !== JSON.stringify(incoming[field])).map(field => {
    const override = overrides.find(value => value.field === field);
    return { field, previous: previous[field], incoming: incoming[field], effective: override ? override.value : incoming[field], overridden: !!override };
  });
}
export function createDebouncedSearch(wait = 350) {
  let controller: AbortController | undefined;
  const cancel = () => controller?.abort();
  return {
    cancel,
    async search(query: string, options: LookupOptions = {}) {
      cancel(); controller = new AbortController();
      const current = controller;
      const abort = () => current.abort();
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) current.abort();
      try { await delay(wait, current.signal); return await searchBooks(query, { ...options, signal: current.signal }); }
      finally { options.signal?.removeEventListener('abort', abort); }
    },
  };
}
