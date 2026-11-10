import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupDocument, CatalogImportPreview, ImportPreview } from '../domain/types';
import { db } from './db';
import { BACKUP_LIMITS, cancelImport, commitImport, exportBackup, previewImport, StaleImportPreviewError } from './backup';
import { addBook, deleteBook, getSnapshot, logSession, setStatus, updateBook } from './library';
import { parseBackup } from './backup-validation';

beforeEach(async () => { db.close(); await db.delete(); await db.open(); });
afterEach(() => vi.restoreAllMocks());
const invented = () => ({ total_unique_titles: 2, notes: 'An invented example catalog. Reconstructed text is unverified.', books: [
    { title: 'The Lantern Atlas', author: 'A. Example', source_images: [1] },
    { title: 'A Quiet Orchard', author: null, source_images: [2], notes: 'Spine reconstruction, unverified.' },
  ] });
const serialize = (value = invented()) => JSON.stringify(value);
const restore = (preview: ImportPreview) => Object.fromEntries(preview.conflicts.map((conflict) => [conflict.id, 'use-import' as const]));
const catalog = (preview: ImportPreview): CatalogImportPreview => { expect(preview.format).toBe('book-catalog'); return preview as CatalogImportPreview; };

describe('external catalog public import entry point', () => {
it('accepts the originally rejected root shape, previews without writes and keeps unknown authors', async () => {
  const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
  const preview = catalog(await previewImport(serialize()));
  expect(preview.source).toMatchObject({ declaredCount: 2, actualCount: 2, unknownAuthorCount: 1, notes: invented().notes, unverified: true });
  expect(preview.defaults).toEqual({ status: 'to-read', formats: [] });
  expect(preview.counts).toEqual({ added: 2, updated: 0, unchanged: 0, deleted: 0 });
  expect((await getSnapshot()).books).toEqual([]);
  expect(await db.meta.count()).toBe(0);
  expect(await db.entity('importReceipts').count()).toBe(0);
  expect(await commitImport(preview.token)).toEqual({ added: 2, updated: 0, deleted: 0 });
  const snapshot = await getSnapshot();
  const unknown = snapshot.books.find((book) => book.title === 'A Quiet Orchard')!;
  expect(unknown.authors).toEqual([]);
  expect(unknown.formats).toEqual([]);
  expect(unknown).toMatchObject({ status: 'to-read', notes: '', primaryLayer: undefined });
  expect(unknown.catalogProvenance[0]).toMatchObject({ originalAuthor: null, sourceImages: [2], notes: 'Spine reconstruction, unverified.', unverified: true });
  expect(snapshot.sessions).toEqual([]); expect(snapshot.statusEvents).toEqual([]); expect(snapshot.readingCycles).toEqual([]);
  for (const table of ['identifiers', 'metadataSnapshots', 'fieldOverrides', 'tags', 'tagAssignments', 'layerAssignments'] as const) expect(await db.entity(table).count()).toBe(0);
  expect(fetchSpy).not.toHaveBeenCalled();
});
it('uses the actual array count, warns on a declared mismatch and never truncates records', async () => {
  const input = { ...invented(), total_unique_titles: 1 };
  const preview = catalog(await previewImport(serialize(input)));
  expect(preview.source).toMatchObject({ declaredCount: 1, actualCount: 2 });
  expect(preview.warnings.some((warning) => warning.includes('differs') && warning.includes('none are truncated'))).toBe(true);
  await commitImport(preview.token);
  expect((await getSnapshot()).books).toHaveLength(2);
});
it('preserves Unicode, full titles and distinct translation, revision, volume and same-author rows', async () => {
  const input = { books: [
    { title: 'The Star Almanac, Volume 1', author: 'Example Writer' },
    { title: 'The Star Almanac, Volume 2', author: 'Example Writer' },
    { title: 'The Star Almanac, Revised Edition', author: 'Example Writer' },
    { title: '星の年鑑 (Translation A)', author: 'Example Writer' },
    { title: '星の年鑑 (Translation B)', author: 'Example Writer' },
    { title: 'വെളിച്ചത്തിന്റെ ഭൂപടം', author: null },
  ] };
  await commitImport((await previewImport(JSON.stringify(input))).token);
  const snapshot = await getSnapshot();
  expect(snapshot.books.map((book) => book.title).sort()).toEqual(input.books.map((book) => book.title).sort());
  expect(new Set(snapshot.books.map((book) => book.editionId)).size).toBe(input.books.length);
  expect(snapshot.books.every((book) => book.language === undefined && book.isbn === undefined)).toBe(true);
});
it('does not collapse exact duplicate rows, and formatting/reordering the same catalog does not duplicate entries', async () => {
  const one = invented().books[0];
  const text = JSON.stringify({ books: [one, one] });
  const first = await previewImport(text);
  expect(first.warnings.some((warning) => warning.includes('repeated exact rows'))).toBe(true);
  await commitImport(first.token);
  expect((await getSnapshot()).books).toHaveLength(2);
  const repeated = await previewImport(JSON.stringify(JSON.parse(text), null, 4));
  expect(repeated.alreadyImported).toBe(true);
  await commitImport(repeated.token);
  expect((await getSnapshot()).books).toHaveLength(2);
  const changedNotes = await previewImport(JSON.stringify({ books: [one, one], notes: 'Another source note' }));
  await commitImport(changedNotes.token);
  expect((await getSnapshot()).books).toHaveLength(2);
});
it('applies visible choices only to new entries, retaining existing edits/status/holdings on overlapping catalogs', async () => {
  const first = catalog(await previewImport(serialize(), { status: 'wishlist', formats: ['physical', 'digital'] }));
  expect(first.defaults).toEqual({ status: 'wishlist', formats: ['physical', 'digital'] });
  await commitImport(first.token);
  const book = (await getSnapshot()).books.find((book) => book.title === 'The Lantern Atlas')!;
  expect(book.status).toBe('wishlist'); expect(book.formats).toEqual(['physical', 'digital']);
  await setStatus(book.id, 'reading');
  await logSession({ workId: book.id, pages: 12 });
  await updateBook(book.id, { title: 'My corrected title', notes: 'Private diary', formats: ['digital'], primaryLayer: 'fuel' });
  const changed = { ...invented(), notes: 'A differently annotated catalog' };
  await commitImport((await previewImport(serialize(changed), { status: 'to-read', formats: ['physical'] })).token);
  const after = (await getSnapshot()).books.find((saved) => saved.id === book.id)!;
  expect(after).toMatchObject({ title: 'My corrected title', notes: 'Private diary', status: 'reading', primaryLayer: 'fuel', formats: ['digital'] });
  expect(after.progress.pagesRead).toBe(12);
  expect(after.catalogProvenance).toHaveLength(2);
});
it('similar saved titles require explicit add-separate confirmation and never replace saved history', async () => {
  const localId = await addBook({ title: 'The Lantern Atlas', authors: ['A. Example'], status: 'reading', formats: ['digital'] });
  await updateBook(localId, { notes: 'Local note' }); await logSession({ workId: localId, pages: 10 });
  const preview = await previewImport(serialize());
  expect(preview.conflicts).toHaveLength(1);
  expect(preview.conflicts[0]).toMatchObject({ kind: 'identity', catalogEntryIndex: 1, defaultDecision: 'keep-local' });
  await commitImport(preview.token);
  expect((await getSnapshot()).books).toHaveLength(2);
  const changed = await previewImport(serialize({ ...invented(), notes: 'Explicitly adding a separate copy' }));
  await commitImport(changed.token, restore(changed));
  expect((await getSnapshot()).books).toHaveLength(3);
  expect((await getSnapshot()).books.find((book) => book.id === localId)).toMatchObject({ notes: 'Local note', status: 'reading', formats: ['digital'] });
  expect((await getSnapshot()).sessions).toHaveLength(1);
});
it('source/global notes and image provenance survive strict backup export and import', async () => {
  await commitImport((await previewImport(serialize())).token);
  const exported = await exportBackup();
  const doc = parseBackup(exported);
  expect(doc.entities.importReceipts[0].catalog).toMatchObject({ notes: invented().notes, actualCount: 2, declaredCount: 2, unverified: true });
  expect(doc.entities.editions.flatMap((edition) => edition.catalogProvenance ?? [])).toEqual(expect.arrayContaining([
    expect.objectContaining({ originalAuthor: null, sourceImages: [2], notes: 'Spine reconstruction, unverified.' }),
  ]));
  db.close(); await db.delete(); await db.open();
  const preview = await previewImport(exported);
  expect(preview.format).toBe('vaayana-backup');
  await commitImport(preview.token);
  expect((await getSnapshot()).books.find((book) => book.title === 'A Quiet Orchard')!.catalogProvenance[0].originalAuthor).toBeNull();
  expect((await previewImport(serialize())).alreadyImported).toBe(true);
});
it('a different older catalog cannot resurrect a deleted entry silently', async () => {
  await commitImport((await previewImport(serialize())).token);
  const deleted = (await getSnapshot()).books.find((book) => book.title === 'A Quiet Orchard')!;
  await deleteBook(deleted.id);
  const changed = serialize({ ...invented(), notes: 'Different snapshot of the same source entries' });
  const preview = await previewImport(changed);
  expect(preview.conflicts.some((conflict) => conflict.kind === 'deleted' && conflict.catalogEntryIndex === 2)).toBe(true);
  await commitImport(preview.token);
  expect((await getSnapshot()).books).toHaveLength(1);
  const explicit = await previewImport(serialize({ ...invented(), notes: 'Explicit restoration requested' }));
  await commitImport(explicit.token, restore(explicit));
  expect((await getSnapshot()).books).toHaveLength(2);
  expect(await db.entity('tombstones').count()).toBeGreaterThan(0);
});
it('supports cancellation, stale preview rejection and failed atomic commits followed by retry', async () => {
  const first = await previewImport(serialize()); cancelImport(first.token);
  await expect(commitImport(first.token)).rejects.toThrow('cancelled');
  const stale = await previewImport(serialize());
  await addBook({ title: 'A new local change' });
  await expect(commitImport(stale.token)).rejects.toBeInstanceOf(StaleImportPreviewError);
  const preview = await previewImport(serialize());
  const spy = vi.spyOn(db.entity('editions'), 'bulkPut').mockRejectedValueOnce(new DOMException('Quota reached', 'QuotaExceededError'));
  await expect(commitImport(preview.token)).rejects.toThrow('Quota reached');
  expect((await getSnapshot()).books).toHaveLength(1);
  expect(await db.entity('importReceipts').count()).toBe(0);
  spy.mockRestore();
  await commitImport(preview.token);
  expect((await getSnapshot()).books).toHaveLength(3);
});
it('rejects unsupported roots with format guidance and never dumps record values into errors', async () => {
  for (const value of [[], { title: 'Private example title' }, { total_unique_titles: 3 }, { format: 'other', books: invented().books }]) {
    await expect(previewImport(JSON.stringify(value))).rejects.toThrow('Supported formats:');
  }
  const sensitive = 'UNIQUE_PRIVATE_TEST_SENTINEL';
  await expect(previewImport(`{"books":[${sensitive}`)).rejects.toThrow('Invalid JSON.');
  try { await previewImport(`{"books":[${sensitive}`); } catch (error) { expect(String(error)).not.toContain(sensitive); }
});
it('retains strict unknown-field, prototype, type, limit and canonical-backup version/URL validation', async () => {
  const badCatalogs = [
    { ...invented(), extra: true },
    { books: [{ title: 'Good', author: null, isbn: 'unasked-for' }] },
    { books: [{ title: 'Good' }] },
    { books: [{ title: 'Good', author: ['Not a string'] }] },
    { books: [{ title: 'Good', author: null, source_images: [-1] }] },
    { books: [{ title: 'Good', author: null, source_images: [1.2] }] },
    { books: [{ title: ' ', author: null }] },
    { books: [{ title: 'Good', author: null, notes: 'x'.repeat(BACKUP_LIMITS.stringLength + 1) }] },
    { ...invented(), total_unique_titles: -1 },
  ];
  for (const input of badCatalogs) await expect(previewImport(JSON.stringify(input))).rejects.toThrow();
  await expect(previewImport('{"books":[],"__proto__":{"x":true}}')).rejects.toThrow('Unsafe object key');
  await addBook({ title: 'Safe local' });
  const backup = JSON.parse(await exportBackup()) as BackupDocument;
  await expect(previewImport(JSON.stringify({ ...backup, books: [], formatVersion: 99 }))).rejects.toThrow();
  backup.entities.holdings[0].sourceUrl = 'javascript:alert(1)';
  await expect(previewImport(JSON.stringify(backup))).rejects.toThrow();
  expect((await getSnapshot()).books).toHaveLength(1);
});
it('accepts optional catalog fields and zero books without inventing metadata or history', async () => {
  const preview = catalog(await previewImport('{"books":[]}'));
  expect(preview.source.actualCount).toBe(0);
  await commitImport(preview.token);
  expect((await getSnapshot()).books).toEqual([]);
  await expect(previewImport(serialize(), { status: 'finished' as 'to-read' })).rejects.toThrow('history is not inferred');
});
it('rolls back a valid compact catalog if its expanded library would exceed the portable backup byte cap', async () => {
  const text = JSON.stringify({ books: Array.from({ length: 1_000 }, (_, index) => ({
    title: `${index} ${'t'.repeat(490)}`, author: null, notes: 'n'.repeat(19_500),
  })) });
  expect(new TextEncoder().encode(text).byteLength).toBeLessThan(BACKUP_LIMITS.bytes);
  await expect(previewImport(text)).rejects.toThrow('merged catalog would exceed');
  expect((await getSnapshot()).books).toEqual([]);
  expect(await db.entity('importReceipts').count()).toBe(0);
}, 30_000);
});
