import 'fake-indexeddb/auto';
import { beforeEach, expect, it } from 'vitest';
import { db, stamp } from './db';
import { addBook, deleteBook, getSnapshot } from './library';
import { BACKUP_LIMITS, commitImport, exportBackup, previewImport } from './backup';
import { parseBackup } from './backup-validation';

async function fresh() { db.close(); await db.delete(); await db.open(); }
beforeEach(fresh);
it('rejects the reported 900-row catalog amplification before preview writes, preserving an exportable library', async () => {
  await addBook({ title: 'An existing fictional book' });
  const before = await getSnapshot();
  const text = JSON.stringify({ books: Array.from({ length: 900 }, (_, index) => ({
    title: `${String(index).padStart(4, '0')}${'t'.repeat(996)}`,
    author: 'a'.repeat(500), source_images: [1], notes: 'n'.repeat(20_000),
  })) });
  expect(new TextEncoder().encode(text).byteLength < BACKUP_LIMITS.bytes).toBe(true);
  await expect(previewImport(text)).rejects.toThrow('merged catalog would exceed');
  const after = await getSnapshot();
  expect(after.books.map((book) => book.id)).toEqual(before.books.map((book) => book.id));
  expect(after.revision).toBe(before.revision);
  expect(await db.entity('importReceipts').count()).toBe(0);
  expect(parseBackup(await exportBackup()).entities.works).toHaveLength(1);
}, 30_000);

it('rejects an oversized combination of two individually valid canonical backups before any live writes or receipts', async () => {
  const sourceWork = await addBook({ title: 'The Fictional North Library' });
  await db.entity('notes').bulkAdd(Array.from({ length: 550 }, () => stamp({ workId: sourceWork, text: 's'.repeat(20_000) })));
  const source = await exportBackup();
  expect(new TextEncoder().encode(source).byteLength < BACKUP_LIMITS.bytes).toBe(true);
  await fresh();
  const localWork = await addBook({ title: 'The Fictional South Library' });
  await db.entity('notes').bulkAdd(Array.from({ length: 550 }, () => stamp({ workId: localWork, text: 'l'.repeat(20_000) })));
  const before = await getSnapshot();
  expect(new TextEncoder().encode(await exportBackup()).byteLength < BACKUP_LIMITS.bytes).toBe(true);
  const preview = await previewImport(source);
  expect(preview.warnings.some((warning) => warning.includes('may exceed'))).toBe(true);
  await expect(commitImport(preview.token)).rejects.toThrow('merged library would exceed');
  expect((await getSnapshot()).books.map((book) => book.id)).toEqual(before.books.map((book) => book.id));
  expect(await db.entity('notes').count()).toBe(550);
  expect(await db.entity('importReceipts').count()).toBe(0);
  expect(parseBackup(await exportBackup()).entities.notes).toHaveLength(550);
}, 30_000);

it.each(['notes', 'source_images'] as const)('keeps deleted catalog families deleted when an older row changes only %s', async (changed) => {
  const current = { title: 'An Invented Tide Almanac', author: 'A. Example', source_images: [1], notes: 'An invented annotation v2.' };
  await commitImport((await previewImport(JSON.stringify({ books: [current] }))).token);
  const saved = (await getSnapshot()).books[0];
  await deleteBook(saved.id);
  const older = { ...current, ...(changed === 'notes' ? { notes: 'An invented annotation v1.' } : { source_images: [2] }) };
  const preview = await previewImport(JSON.stringify({ books: [older] }));
  expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'deleted', defaultDecision: 'keep-local' })]));
  await commitImport(preview.token);
  expect((await getSnapshot()).books).toEqual([]);
  const tombstones = await db.entity('tombstones').toArray();
  expect(tombstones.some((row) => row.table === 'works' && Boolean(row.catalogFamilyId))).toBe(true);
  expect(JSON.stringify(tombstones).includes(current.notes)).toBe(false);
  expect(JSON.stringify(tombstones).includes(current.title)).toBe(false);
  const explicit = await previewImport(JSON.stringify({ books: [older], notes: 'Explicitly reviewed separate-entry restoration.' }));
  await commitImport(explicit.token, Object.fromEntries(explicit.conflicts.map((conflict) => [conflict.id, 'use-import' as const])));
  expect((await getSnapshot()).books).toHaveLength(1);
  expect((await getSnapshot()).books[0].catalogProvenance[0].notes).toBe(older.notes);
  expect(parseBackup(await exportBackup()).entities.tombstones.length > 0).toBe(true);
});

it('prompts for same-title ambiguity when a raw catalog author combines multiple existing authors', async () => {
  const localId = await addBook({ title: 'The Invented Shared Observatory', authors: ['A. Example', 'B. Second'], status: 'reading' });
  const text = JSON.stringify({ books: [{ title: 'The Invented Shared Observatory', author: 'A. Example, B. Second' }] });
  const preview = await previewImport(text);
  expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'identity', catalogEntryIndex: 1 })]));
  await commitImport(preview.token);
  expect((await getSnapshot()).books).toHaveLength(1);
  expect((await getSnapshot()).books[0].id).toBe(localId);
  const separate = await previewImport(JSON.stringify({ books: [{ title: 'The Invented Shared Observatory', author: 'A. Example, B. Second' }], notes: 'Separate edition confirmed.' }));
  await commitImport(separate.token, Object.fromEntries(separate.conflicts.map((conflict) => [conflict.id, 'use-import' as const])));
  const books = (await getSnapshot()).books;
  expect(books).toHaveLength(2);
  expect(books.find((book) => book.id !== localId)?.catalogProvenance[0].originalAuthor).toBe('A. Example, B. Second');
  expect(books.find((book) => book.id === localId)?.status).toBe('reading');
});
