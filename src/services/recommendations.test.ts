import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MetadataCandidate } from '../domain/types';
import * as books from './books';
import { bridgesFor, discover, rankCandidates } from './recommendations';
import { setNetworkPreferences } from './network';
import psychologyResponses from './fixtures/psychology-expand-search.json';
vi.mock('./books', async importOriginal => ({ ...await importOriginal<typeof import('./books')>(), searchBooks: vi.fn() }));
const candidate = (id: string, title: string, subjects: string[], authors = ['Writer']): MetadataCandidate => ({ workId: `/works/${id}`, title, subjects, authors, language: 'en', isbn: [], sourceUrl: `https://openlibrary.org/works/${id}`, fetchedAt: '2026-11-10' });
afterEach(() => { vi.clearAllMocks(); setNetworkPreferences({ onlineLookup: false, covers: false }); });
describe('two real-candidate lanes', () => {
  it('does no retrieval before a cold-start interest choice', async () => {
    expect((await discover({ interests: [], lane: 'deepen' })).status).toBe('needs-interests');
    expect(books.searchBooks).not.toHaveBeenCalled();
  });
  it('Deepen respects exclusions, language, work deduplication and negative feedback', () => {
    const input = [
      candidate('OL1W', 'Cooking at home', ['Cooking']), candidate('OL1W', 'Another edition', ['Cooking']),
      candidate('OL2W', 'Already read', ['Cooking']), candidate('OL3W', 'Unwanted recipes', ['Cooking', 'Meat']),
      { ...candidate('OL4W', 'French cooking', ['Cooking']), language: 'fr' },
    ];
    const ranked = rankCandidates(input, { interests: ['cooking'], lane: 'deepen', excludedWorkIds: ['OL2W'], dislikedTopics: ['meat'], language: 'en' });
    expect(ranked.map(item => item.book.workId)).toEqual(['/works/OL1W']);
    expect(ranked[0].reason).toContain('cooking');
  });
  it('Expand uses a named bridge and actual novel-topic evidence, not shuffling owned books', () => {
    const input = [candidate('OL1W', 'Cooking at home', ['Cooking']), candidate('OL2W', 'A food history', ['Food history'])];
    const ranked = rankCandidates(input, { interests: ['cooking'], lane: 'expand' }, bridgesFor(['cooking']));
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ book: { workId: '/works/OL2W' }, bridge: { from: 'cooking', to: 'food history' }, mode: 'rule-based' });
  });
  it('caps repeated authors and diversifies rankings', () => {
    const input = Array.from({ length: 6 }, (_, i) => candidate(`OL${i + 1}W`, `Cooking ${i}`, ['Cooking'], [i < 4 ? 'Same Writer' : `Other ${i}`]));
    const result = rankCandidates(input, { interests: ['cooking'], lane: 'deepen', limit: 6 });
    expect(result.filter(value => value.book.authors.includes('Same Writer'))).toHaveLength(2);
    expect(result).toHaveLength(4);
  });
  it('excludes equivalent ISBN-10/13 identities', () => {
    const item = { ...candidate('OL1W', 'Cooking', ['Cooking']), isbn: ['0141033576'] };
    expect(rankCandidates([item], { interests: ['cooking'], lane: 'deepen', excludedIsbns: ['9780141033570'] })).toEqual([]);
  });
  it('retrieves live DTOs through the metadata service and never invents missing candidates', async () => {
    setNetworkPreferences({ onlineLookup: true, covers: false });
    vi.mocked(books.searchBooks).mockResolvedValue([candidate('OL2W', 'A food history', ['Food history'])]);
    const result = await discover({ interests: ['Cooking'], lane: 'expand', language: 'en' });
    expect(books.searchBooks).toHaveBeenCalledWith('subject:"food history"', expect.objectContaining({ language: 'en' }));
    expect(result.status).toBe('ready');
    expect(result.items[0].book.workId).toBe('/works/OL2W');
  });
  it.each(['en', 'eng'])('keeps English retrieval and ranking equivalent for %s', async language => {
    setNetworkPreferences({ onlineLookup: true, covers: false });
    vi.mocked(books.searchBooks).mockResolvedValue([
      candidate('OL1W', 'Cooking', ['Cooking']),
      { ...candidate('OL2W', 'Cuisine', ['Cooking']), language: 'fr' },
    ]);
    const result = await discover({ interests: ['cooking'], lane: 'deepen', language });
    expect(books.searchBooks).toHaveBeenCalledWith('subject:"cooking"', expect.objectContaining({ language: 'en' }));
    expect(result.items.map(item => item.book.workId)).toEqual(['/works/OL1W']);
    expect(rankCandidates([candidate('OL1W', 'Cooking', ['Cooking'])], { interests: ['cooking'], lane: 'deepen', language })).toHaveLength(1);
  });
  it('does not silently remove an invalid language filter', async () => {
    expect(await discover({ interests: ['cooking'], lane: 'deepen', language: 'English' })).toMatchObject({ items: [], status: 'partial' });
    expect(books.searchBooks).not.toHaveBeenCalled();
  });
  it('reports partial coverage rather than fabricating an unknown bridge', async () => {
    const result = await discover({ interests: ['unmapped-interest'], lane: 'expand' });
    expect(result).toMatchObject({ items: [], status: 'partial' });
    expect(books.searchBooks).not.toHaveBeenCalled();
  });
  it('retains cached timestamps and truthful offline status', async () => {
    vi.mocked(books.searchBooks).mockResolvedValue([candidate('OL1W', 'Cooking', ['Cooking'])]);
    const result = await discover({ interests: ['cooking'], lane: 'deepen' });
    expect(result.status).toBe('offline');
    expect(result.items[0].book.fetchedAt).toBe('2026-11-10');
  });
  it('propagates cancellation instead of presenting an empty successful lane', async () => {
    const signal = AbortSignal.abort();
    await expect(discover({ interests: ['cooking'], lane: 'deepen' }, { signal })).rejects.toMatchObject({ name: 'AbortError' });
  });
  // Real response fields/subjects from 2026-11-10; identifiers normalized to short synthetic test IDs.
  function psychologyLookup() {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => {
      const query = new URL(String(url)).searchParams.get('q');
      const data = query === 'subject:"cognitive anthropology" language:eng' ? psychologyResponses.narrow : psychologyResponses.broader;
      return new Response(JSON.stringify(data));
    });
    const api = new books.MetadataClient(fetcher, 0);
    vi.mocked(books.searchBooks).mockImplementation((query, options) => api.searchBooks(query, options));
    return { fetcher, api };
  }
  it('retrieves a broader real Psychology bridge after a successful empty narrow response', async () => {
    setNetworkPreferences({ onlineLookup: true, covers: false });
    const { fetcher, api } = psychologyLookup();
    try {
      const result = await discover({ interests: ['Psychology'], lane: 'expand', language: 'eng' });
      expect(result.status).toBe('ready');
      expect(result.errors).toEqual([]);
      expect(result.items.map(item => item.book.workId).sort()).toEqual(['/works/OL1W', '/works/OL2W']);
      expect(result.items.every(item => item.book.language === 'en' && item.matchedTopics[0] === 'anthropology')).toBe(true);
      expect(result.items[0].bridge).toEqual({ from: 'psychology', to: 'anthropology', broaderThan: 'cognitive anthropology' });
      expect(result.items[0].reason).toContain('broader curated bridge because cognitive anthropology returned no eligible candidates');
      expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('q'))).toEqual(['subject:"cognitive anthropology" language:eng', 'subject:"anthropology" language:eng']);
    } finally { api.dispose(); }
  });
  it('keeps exclusions and dislikes authoritative for broader fallback candidates', async () => {
    setNetworkPreferences({ onlineLookup: true, covers: false });
    const { api } = psychologyLookup();
    try {
      const excluded = await discover({ interests: ['Psychology'], lane: 'expand', language: 'en', excludedWorkIds: ['OL1W'] });
      expect(excluded.items.map(item => item.book.workId)).toEqual(['/works/OL2W']);
      const disliked = await discover({ interests: ['Psychology'], lane: 'expand', language: 'en', dislikedTopics: ['anthropology'] });
      expect(disliked).toMatchObject({ items: [], status: 'partial' });
    } finally { api.dispose(); }
  });
  it('does not broaden over a failed request or make additional fallback calls offline', async () => {
    setNetworkPreferences({ onlineLookup: true, covers: false });
    vi.mocked(books.searchBooks).mockRejectedValueOnce(new Error('Catalogue unavailable.'));
    const failed = await discover({ interests: ['psychology'], lane: 'expand', language: 'en' });
    expect(failed).toMatchObject({ items: [], status: 'partial', errors: ['Catalogue unavailable.'] });
    expect(books.searchBooks).toHaveBeenCalledTimes(1);
    vi.mocked(books.searchBooks).mockClear().mockResolvedValue([]);
    setNetworkPreferences({ onlineLookup: false, covers: false });
    const offline = await discover({ interests: ['psychology'], lane: 'expand', language: 'en' });
    expect(offline).toMatchObject({ items: [], status: 'offline' });
    expect(books.searchBooks).toHaveBeenCalledTimes(1);
  });
  it('does not request a broader topic when the narrow topic already has eligible results', async () => {
    setNetworkPreferences({ onlineLookup: true, covers: false });
    vi.mocked(books.searchBooks).mockResolvedValue([candidate('OL1W', 'Cognitive anthropology', ['Cognitive anthropology'])]);
    const result = await discover({ interests: ['psychology'], lane: 'expand', language: 'en' });
    expect(result.items[0].bridge).toEqual({ from: 'psychology', to: 'cognitive anthropology' });
    expect(books.searchBooks).toHaveBeenCalledTimes(1);
  });
  it('retains the two-query lane budget when a broader bridge is needed', async () => {
    setNetworkPreferences({ onlineLookup: true, covers: false });
    vi.mocked(books.searchBooks).mockResolvedValueOnce([]).mockResolvedValueOnce([candidate('OL2W', 'Anthropological theory', ['Anthropology'])]);
    const result = await discover({ interests: ['psychology', 'cooking'], lane: 'expand', language: 'en' });
    expect(result.items).toHaveLength(1);
    expect(books.searchBooks).toHaveBeenCalledTimes(2);
  });
  it('does not relax language, ISBN, topic evidence or author diversity for broader candidates', async () => {
    setNetworkPreferences({ onlineLookup: true, covers: false });
    vi.mocked(books.searchBooks).mockResolvedValueOnce([]).mockResolvedValueOnce([
      { ...candidate('OL1W', 'Anthropology in French', ['Anthropology']), language: 'fr' },
      { ...candidate('OL2W', 'Anthropology without language', ['Anthropology']), language: undefined },
      { ...candidate('OL3W', 'An excluded edition', ['Anthropology']), isbn: ['0141033576'] },
      candidate('OL4W', 'Psychology alone', ['Psychology']),
      ...[5, 6, 7].map(id => candidate(`OL${id}W`, `Anthropology ${id}`, ['Anthropology'], ['Same author'])),
    ]);
    const result = await discover({ interests: ['psychology'], lane: 'expand', language: 'eng', excludedIsbns: ['9780141033570'] });
    expect(result.items).toHaveLength(2);
    expect(result.items.every(item => ['OL5W', 'OL6W', 'OL7W'].some(id => item.book.workId.endsWith(id)))).toBe(true);
    expect(result.items.every(item => item.bridge?.to === 'anthropology')).toBe(true);
  });
  it('never calls an already chosen interest a novel broader topic', async () => {
    setNetworkPreferences({ onlineLookup: true, covers: false });
    vi.mocked(books.searchBooks).mockResolvedValueOnce([]).mockResolvedValueOnce([candidate('OL2W', 'Anthropological theory', ['Anthropology'])]);
    expect(await discover({ interests: ['psychology', 'anthropology'], lane: 'expand', language: 'en' })).toMatchObject({ items: [], status: 'partial' });
  });
});
