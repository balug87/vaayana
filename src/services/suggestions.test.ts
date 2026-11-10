import { describe, expect, it } from 'vitest';
import type { MetadataCandidate } from '../domain/types';
import { normalizeTag, suggestLayers, suggestTags } from './suggestions';
import { getReviewSources, safeExternalUrl } from './reviews';
const book: MetadataCandidate = { workId: '/works/OL1W', title: 'Book', authors: ['Writer'], subjects: [], isbn: [], sourceUrl: 'https://openlibrary.org/works/OL1W', fetchedAt: '2026-11-10' };
describe('dynamic suggestions', () => {
  it('normalizes tags and suppresses accepted/rejected duplicates', () => {
    expect(normalizeTag('  Decision   MAKING ')).toBe('decision making');
    const result = suggestTags({ ...book, subjects: [' Psychology ', 'psychology', 'Decision making', 'nyt:foo', 'BF441', 'New York Times bestseller'] }, { rejectedNames: ['PSYCHOLOGY'] });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ normalizedName: 'decision making', label: 'tentative', origin: 'provider' });
  });
  it('never mutates the book or existing user tags', () => {
    const input = { ...book, subjects: ['Psychology'] };
    expect(suggestTags(input, { existing: ['psychology'] })).toEqual([]);
    expect(input.subjects).toEqual(['Psychology']);
  });
  it('permits unknown Layers and overlapping tentative suggestions', () => {
    expect(suggestLayers(book)).toEqual([]);
    const result = suggestLayers({ ...book, subjects: ['Cognitive psychology', 'Philosophy'] });
    expect(result.map(value => value.layer)).toEqual(expect.arrayContaining(['operating-system', 'mind-expanding']));
    expect(result.every(value => value.label === 'needs-review')).toBe(true);
  });
  it('preserves confirmed/rejected Layers and honors immediate practical purpose', () => {
    const result = suggestLayers({ ...book, subjects: ['Programming', 'Handbooks'] }, { purpose: 'Solve a practical task today', confirmedLayers: ['software-applications'], rejectedLayers: ['hardware'] });
    expect(result.map(value => value.layer)).toContain('fuel');
    expect(result.map(value => value.layer)).not.toContain('software-applications');
    expect(result.find(value => value.layer === 'fuel')?.label).toBe('tentative');
  });
});
describe('honest review sources', () => {
  it('keeps ratings, verified links and search actions distinct', () => {
    const result = getReviewSources(book, [{ url: 'https://www.kirkusreviews.com/book-reviews/writer/book/', title: 'User-confirmed review', kind: 'professional', source: 'Kirkus', verified: true, verifiedAt: '2026-11-10' }]);
    expect(result.rating).toBeUndefined();
    expect(result.reviews[0].verified).toBe(true);
    expect(result.searchActions.every(action => !action.verified)).toBe(true);
    expect(result.searchActions[0].title).toBe('Search Goodreads');
  });
  it.each(['javascript:alert(1)', 'http://example.com', 'https://user:password@example.com', 'https://127.0.0.1/foo', 'https://[::1]/', 'https://localhost/', 'https://app.internal/'])('rejects unsafe link %s', value => expect(safeExternalUrl(value)).toBeUndefined());
});
