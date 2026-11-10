import 'fake-indexeddb/auto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { addBook, applyMetadataRefresh, db, getSnapshot, previewMetadataRefresh, updateBook } from '../data/repository';
import type { Book, MetadataCandidate } from '../domain/types';
import { bookDetailsPatch, metadataLookupQuery, type BookDetailsDraft } from './bookDetailsPatch';
const candidate: MetadataCandidate = { workId: '/works/OL123W', editionId: '/books/OL123M', title: 'Provider title', authors: ['An author'], isbn: [], subjects: ['History'], pageCount: 200, sourceUrl: 'https://openlibrary.org/works/OL123W', fetchedAt: '2026-11-10T12:00:00.000Z' };
const draftFor = (book: Book): BookDetailsDraft => ({ title: book.title, author: book.authors.join(', '), pages: String(book.pageCount ?? ''), purpose: book.purpose, primary: book.primaryLayer ?? '', secondary: book.secondaryLayers, formats: book.formats, layerLabel: book.layerAssignment?.label ?? 'user-selected', layerEvidence: book.layerAssignment?.evidence ?? '' });
beforeEach(async () => { await db.delete(); await db.open(); });
afterAll(async () => { await db.delete(); });
describe('actual Details form patch preserves metadata refresh', () => {
  it('later enriches the same manual book by its stored ISBN without silently changing its title', async () => {
    const id = await addBook({ title: 'Offline shorthand', authors: ['An author'], isbn: '9780140328721' });
    let book = (await getSnapshot()).books[0];
    expect(book.metadataSnapshot).toBeUndefined();
    expect(metadataLookupQuery(book)).toBe('9780140328721');
    const source = { ...candidate, isbn: ['9780140328721'] };
    expect((await previewMetadataRefresh(id, source)).some(diff => diff.field === 'title')).toBe(true);
    expect((await getSnapshot()).books[0].title).toBe('Offline shorthand');
    await updateBook(id, { title: 'My protected title' });
    await applyMetadataRefresh(id, source);
    book = (await getSnapshot()).books[0];
    expect(book.id).toBe(id);
    expect(book.title).toBe('My protected title');
    expect(book.metadataSnapshot?.candidate.workId).toBe(candidate.workId);
    expect(book.pageCount).toBe(200);
    expect(metadataLookupQuery({ title: 'No ISBN', authors: ['Writer'] })).toBe('No ISBN Writer');
  });
  it('purpose-only save creates no bibliographic overrides; provider changes still flow', async () => {
    const id = await addBook({ title: candidate.title, authors: candidate.authors, candidate });
    let book = (await getSnapshot()).books[0];
    const patch = bookDetailsPatch(book, { ...draftFor(book), purpose: 'A new perspective', primary: 'mind-expanding' });
    expect(patch).not.toHaveProperty('title'); expect(patch).not.toHaveProperty('authors'); expect(patch).not.toHaveProperty('pageCount');
    await updateBook(id, patch);
    book = (await getSnapshot()).books[0];
    expect(book.overrides).toHaveLength(0);
    await applyMetadataRefresh(id, { ...candidate, title: 'Refreshed provider title', pageCount: 210 });
    book = (await getSnapshot()).books[0];
    expect(book.title).toBe('Refreshed provider title'); expect(book.pageCount).toBe(210); expect(book.purpose).toBe('A new perspective');
  });
  it('a deliberately changed title stays pinned through later refreshes', async () => {
    const id = await addBook({ title: candidate.title, authors: candidate.authors, candidate });
    let book = (await getSnapshot()).books[0];
    await updateBook(id, bookDetailsPatch(book, { ...draftFor(book), title: 'My corrected title' }));
    await applyMetadataRefresh(id, { ...candidate, title: 'A later source title' });
    book = (await getSnapshot()).books[0];
    expect(book.title).toBe('My corrected title');
    expect(book.overrides.some(o => o.field === 'title')).toBe(true);
  });
});
