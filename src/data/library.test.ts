import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackupDocument, MetadataCandidate } from '../domain/types';
import { db, LibraryDatabase, stamp, V1_SCHEMA } from './db';
import {
  acceptTag, addBook, applyMetadataRefresh, archiveTag, createTag, deleteBook,
  deleteGoal, deleteReviewLink, deleteSession, getSnapshot, logSession, mergeTags,
  normalizeIsbn, previewMetadataRefresh, rejectTag, renameTag, resetFieldOverride,
  saveGoal, saveRecommendationFeedback, saveReviewLink, saveSettings, searchLibrary,
  setStatus, updateBook, updateSession,
} from './library';
import { BACKUP_LIMITS, cancelImport, commitImport, exportBackup, previewImport, StaleImportPreviewError } from './backup';
import { exportRecoveryBackup } from './recovery';

const candidate = (patch: Partial<MetadataCandidate> = {}): MetadataCandidate => ({
  workId: '/works/OL123W', editionId: '/books/OL123M', title: 'Provider title',
  authors: ['Ursula Author'], subjects: ['Systems'], isbn: ['9780306406157'],
  pageCount: 200, language: 'en', sourceUrl: 'https://openlibrary.org/works/OL123W',
  fetchedAt: '2026-11-10T12:00:00.000Z', ...patch,
});
async function fresh() { db.close(); await db.delete(); await db.open(); }
const backupObject = async () => JSON.parse(await exportBackup()) as BackupDocument;
const decisionsFor = (preview: Awaited<ReturnType<typeof previewImport>>) => Object.fromEntries(preview.conflicts.map((conflict) => [conflict.id, 'use-import' as const]));

beforeEach(fresh);
afterEach(() => { vi.restoreAllMocks(); });

describe('local catalog and protected personal edits', () => {
  it('starts empty, keeps unknown fields and Unicode, searches locally, and persists holdings', async () => {
    expect((await getSnapshot()).books).toEqual([]);
    const id = await addBook({ title: 'വായന', authors: [], formats: ['physical', 'digital'] });
    db.close(); await db.open();
    const book = (await getSnapshot()).books[0];
    expect(book).toMatchObject({ id, title: 'വായന', formats: ['physical', 'digital'] });
    expect(book.pageCount).toBeUndefined();
    expect((await searchLibrary('വായന'))[0].id).toBe(id);
    expect((await getSnapshot()).settings).toMatchObject({ onlineAccess: false, loadCovers: false });
  });
  it('validates and canonicalizes equivalent ISBN-10/13 checksums', () => {
    expect(normalizeIsbn('0-306-40615-2')).toBe('9780306406157');
    expect(normalizeIsbn('9780306406157')).toBe('9780306406157');
    expect(() => normalizeIsbn('9780306406158')).toThrow('checksum');
  });
  it('persists a form title correction over provider facts and later refreshes', async () => {
    const id = await addBook({ title: 'My correction', candidate: candidate() });
    let book = (await getSnapshot()).books[0];
    expect(book.title).toBe('My correction');
    expect(book.overrides).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'title', value: 'My correction' })]));
    const refreshed = candidate({ title: 'Changed provider', pageCount: 220 });
    expect(await previewMetadataRefresh(id, refreshed)).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'title', overridden: true })]));
    await applyMetadataRefresh(id, refreshed);
    book = (await getSnapshot()).books[0];
    expect(book.title).toBe('My correction'); expect(book.pageCount).toBe(220);
    await resetFieldOverride(id, 'title');
    expect((await getSnapshot()).books[0].title).toBe('Changed provider');
  });
  it('adding another edition preserves existing purpose, Layers, accepted tags, notes, and status', async () => {
    const tag = await createTag('My topic');
    const id = await addBook({ title: 'First edition', candidate: candidate(), purpose: 'My lasting purpose', primaryLayer: 'fuel', secondaryLayers: ['software-applications'], tagIds: [tag], status: 'reading' });
    await updateBook(id, { notes: 'Private note', layerLabel: 'tentative', layerEvidence: 'For today’s project' });
    await addBook({ title: 'Translation', workId: id, candidate: candidate({ editionId: '/books/OL456M', title: 'Translation', isbn: [], language: 'ml' }), purpose: '', primaryLayer: 'hardware', secondaryLayers: [], tagIds: [], status: 'wishlist' });
    const book = (await getSnapshot()).books[0];
    expect(book.editions).toHaveLength(2);
    expect(book).toMatchObject({ purpose: 'My lasting purpose', primaryLayer: 'fuel', secondaryLayers: ['software-applications'], notes: 'Private note', status: 'reading' });
    expect(book.tags.map((item) => item.id)).toContain(tag);
    expect(book.layerAssignment).toMatchObject({ label: 'tentative', evidence: 'For today’s project' });
    expect(book.title).toBe('First edition');
    await updateBook(id, { editionId: book.editions[1].id, publisher: 'My translation publisher' });
    const snapshot = await getSnapshot();
    expect(snapshot.books[0].overrides.some((override) => override.field === 'publisher')).toBe(false);
    expect((await db.entity('fieldOverrides').toArray()).some((override) => override.editionId === book.editions[1].id && override.value === 'My translation publisher')).toBe(true);
  });
  it('does not automatically merge title resemblance and rejects conflicting identifiers atomically', async () => {
    const id = await addBook({ title: 'Same title', authors: ['Same author'] });
    await expect(addBook({ title: 'Same title', authors: ['Same author'] })).rejects.toThrow('similar');
    await addBook({ title: 'Same title', authors: ['Same author'], allowDuplicate: true });
    const other = await addBook({ title: 'Other', candidate: candidate() });
    await expect(addBook({ title: 'Conflict', workId: id, candidate: candidate(), allowDuplicate: true })).rejects.toThrow('conflict');
    expect((await getSnapshot()).books).toHaveLength(3);
    expect(other).not.toBe(id);
  });
  it('missing provider fields do not erase previous facts or personal overrides', async () => {
    const id = await addBook({ title: 'Provider title', candidate: candidate({ publisher: 'Known publisher' }) });
    await updateBook(id, { publisher: 'My publisher' });
    await applyMetadataRefresh(id, candidate({ publisher: undefined }));
    await resetFieldOverride(id, 'publisher');
    expect((await getSnapshot()).books[0].publisher).toBe('Known publisher');
    await applyMetadataRefresh(id, candidate({ authors: [], publisher: '', title: '' }));
    expect((await getSnapshot()).books[0]).toMatchObject({ title: 'Provider title', authors: ['Ursula Author'], publisher: 'Known publisher' });
  });
  it('a form with unchanged bibliographic values does not accidentally pin provider fields', async () => {
    const id = await addBook({ title: 'Provider title', candidate: candidate() });
    const book = (await getSnapshot()).books[0];
    await updateBook(id, { title: book.title, authors: book.authors, pageCount: book.pageCount, purpose: 'Only purpose changed' });
    expect(await db.entity('fieldOverrides').count()).toBe(0);
    await applyMetadataRefresh(id, candidate({ title: 'Fresh title' }));
    expect((await getSnapshot()).books[0].title).toBe('Fresh title');
    await updateBook(id, { title: 'Deliberate correction' });
    await updateBook(id, { title: 'Fresh title' });
    expect((await db.entity('fieldOverrides').toArray())[0].value).toBe('Fresh title');
  });
});

describe('reading diary and goals', () => {
  it('counts explicit session amounts and finishes once; rereads need an explicit new cycle', async () => {
    const id = await addBook({ title: 'Book', pageCount: 200 });
    await saveGoal({ metric: 'pages', target: 200, startDate: '2026-11-01', endDate: '2026-11-30' });
    await saveGoal({ metric: 'books', target: 2, startDate: '2026-11-01', endDate: '2026-11-30' });
    await logSession({ workId: id, pages: 40, minutes: 20, page: 40, occurredAt: '2026-11-10T12:00:00.000Z' });
    await setStatus(id, 'paused'); await setStatus(id, 'reading');
    await setStatus(id, 'finished', { occurredAt: '2026-11-11T12:00:00.000Z' });
    await setStatus(id, 'finished');
    expect(Object.fromEntries((await getSnapshot()).goals.map((goal) => [goal.metric, goal.progress]))).toEqual({ pages: 40, books: 1 });
    await expect(logSession({ workId: id, pages: 2 })).rejects.toThrow('reread');
    await setStatus(id, 'reading', { reread: true });
    await logSession({ workId: id, pages: 10 });
    await setStatus(id, 'finished');
    const snapshot = await getSnapshot();
    expect(snapshot.readingCycles).toHaveLength(2);
    expect(Object.fromEntries(snapshot.goals.map((goal) => [goal.metric, goal.progress]))).toEqual({ pages: 50, books: 2 });
  });
  it('backdated, repeated, corrected and deleted page bookmarks never inflate page goals', async () => {
    const id = await addBook({ title: 'Book', pageCount: 200 });
    await saveGoal({ metric: 'pages', target: 200, startDate: '2026-11-01', endDate: '2026-11-30' });
    const later = await logSession({ workId: id, page: 100, occurredAt: '2026-11-02T12:00:00.000Z' });
    const earlier = await logSession({ workId: id, page: 50, occurredAt: '2026-11-01T12:00:00.000Z' });
    await logSession({ workId: id, page: 100, occurredAt: '2026-11-02T13:00:00.000Z' });
    expect((await getSnapshot()).goals[0].progress).toBe(0);
    await updateSession(later, { page: 80 });
    expect((await getSnapshot()).goals[0].progress).toBe(0);
    await updateSession(earlier, { pages: 50 });
    await updateSession(later, { pages: 50 });
    expect((await getSnapshot()).goals[0].progress).toBe(100);
    await updateSession(later, { pages: 30, page: 80 });
    expect((await getSnapshot()).goals[0].progress).toBe(80);
    await deleteSession(earlier);
    expect((await getSnapshot()).goals[0].progress).toBe(30);
  });
  it('keeps percentage with unknown totals, corrects edition/session dates, and limits goals to dates', async () => {
    const id = await addBook({ title: 'Digital', formats: ['digital'] });
    const goal = await saveGoal({ metric: 'minutes', target: 60, startDate: '2026-11-02', endDate: '2026-11-02' });
    const session = await logSession({ workId: id, percent: 50, minutes: 30, occurredAt: '2026-11-01T12:00:00.000Z' });
    expect((await getSnapshot()).books[0].progress.pagesRead).toBe(0);
    await updateSession(session, { occurredAt: '2026-11-02T12:00:00.000Z', minutes: 15, pages: undefined });
    expect((await getSnapshot()).goals[0].progress).toBe(15);
    await saveGoal({ id: goal, metric: 'minutes', target: 45, startDate: '2026-11-01', endDate: '2026-11-03' });
    await deleteGoal(goal); expect((await getSnapshot()).goals).toEqual([]);
    await expect(logSession({ workId: id, percent: 101 })).rejects.toThrow('Percentage');
  });
});

describe('tags, review links, and network preferences', () => {
  it('accepts, renames, rejects, merges and archives with provenance and no resurrected suggestions', async () => {
    const id = await addBook({ title: 'Provider title', candidate: candidate() });
    let book = (await getSnapshot()).books[0];
    const subject = book.tagSuggestions[0].tagId;
    await rejectTag(id, subject);
    await applyMetadataRefresh(id, candidate());
    expect((await getSnapshot()).books[0].tagSuggestions).toHaveLength(0);
    await acceptTag(id, subject);
    await renameTag(subject, 'Connected thinking');
    const target = await createTag('Systems practice', 'purpose');
    await mergeTags(subject, target);
    book = (await getSnapshot()).books[0];
    expect(book.tags.map((tag) => tag.id)).toEqual([target]);
    expect((await db.entity('tagAssignments').toArray())[0]).toMatchObject({ origin: 'provider', sourceRef: candidate().sourceUrl, state: 'accepted', pinned: true });
    await archiveTag(target);
    await applyMetadataRefresh(id, candidate());
    expect((await getSnapshot()).books[0].tags).toHaveLength(0);
    expect((await getSnapshot()).books[0].tagSuggestions).toHaveLength(0);
    await expect(mergeTags(target, subject)).rejects.toThrow('active destination');
  });
  it('finds renamed subject aliases so rejected, accepted and archived decisions survive refresh', async () => {
    const id = await addBook({ title: 'Provider title', candidate: candidate({ subjects: ['Psychology'] }) });
    const tagId = (await getSnapshot()).books[0].tagSuggestions[0].tagId;
    await rejectTag(id, tagId); await renameTag(tagId, 'Mind');
    await applyMetadataRefresh(id, candidate({ subjects: ['Psychology'] }));
    expect((await getSnapshot()).books[0].tagSuggestions).toEqual([]);
    expect(await db.entity('tags').count()).toBe(1);
    await acceptTag(id, tagId);
    await applyMetadataRefresh(id, candidate({ subjects: ['Psychology', 'Other subject'], title: 'Updated' }));
    expect((await getSnapshot()).books[0].tags[0].name).toBe('Mind');
    const target = await createTag('Mental models'); await mergeTags(tagId, target); await archiveTag(target);
    await applyMetadataRefresh(id, candidate({ subjects: ['Psychology', 'Mind'] }));
    const snapshot = await getSnapshot();
    expect(snapshot.books[0].tagSuggestions.map((item) => item.tag.name)).toEqual(['Other subject']);
    expect(snapshot.books[0].tags).toEqual([]);
    expect(await db.entity('tags').count()).toBe(3);
  });
  it('saves only HTTPS review links, retains feedback and settings across reload', async () => {
    const id = await addBook({ title: 'Book' });
    await expect(saveReviewLink({ workId: id, title: 'Bad', source: 'Bad', kind: 'reader', url: 'javascript:alert(1)' })).rejects.toThrow();
    const review = await saveReviewLink({ workId: id, title: 'Direct review', source: 'Kirkus', kind: 'professional', url: 'https://www.kirkusreviews.com/book-reviews/example/' });
    await saveSettings({ onlineAccess: false, loadCovers: false, interests: ['systems'] });
    await saveRecommendationFeedback('/works/OL123W', 'dismiss', ['systems']);
    db.close(); await db.open();
    const snapshot = await getSnapshot();
    expect(snapshot.books[0].reviewLinks[0]).toMatchObject({ verified: true, title: 'Direct review' });
    expect(snapshot.recommendationFeedback[0]).toMatchObject({ workKey: '/works/OL123W', action: 'dismiss' });
    expect(snapshot.settings.interests).toEqual(['systems']);
    await deleteReviewLink(review); expect((await getSnapshot()).books[0].reviewLinks).toEqual([]);
  });
});

describe('safe backup staging and atomic merge', () => {
  it('round trips every user-owned store and omits replaceable caches', async () => {
    const id = await addBook({ title: 'My correction', candidate: candidate(), formats: ['physical', 'digital'], purpose: 'Understand systems', primaryLayer: 'mind-expanding' });
    await updateBook(id, { notes: 'Private note', personalRating: 4 });
    await logSession({ workId: id, pages: 20, minutes: 10 });
    await saveGoal({ metric: 'pages', target: 100, startDate: '2026-11-01', endDate: '2026-11-30' });
    await db.table('candidateCache').put({ id: 'cache', secret: 'replaceable' });
    await db.table('embeddings').put({ id: 'model', values: [1, 2] });
    const document = await backupObject();
    expect(JSON.stringify(document)).not.toContain('replaceable');
    expect(document.entities).not.toHaveProperty('embeddings');
    await fresh();
    const preview = await previewImport(JSON.stringify(document));
    expect((await getSnapshot()).books).toHaveLength(0);
    await commitImport(preview.token);
    const book = (await getSnapshot()).books[0];
    expect(book).toMatchObject({ id, title: 'My correction', notes: 'Private note', personalRating: 4, formats: ['physical', 'digital'], purpose: 'Understand systems', primaryLayer: 'mind-expanding' });
    expect((await getSnapshot()).goals[0].progress).toBe(20);
  });
  it('same-file and overlapping snapshots do not duplicate books, sessions, notes or goals', async () => {
    const id = await addBook({ title: 'Book' }); await updateBook(id, { notes: 'First' });
    await logSession({ workId: id, pages: 10 });
    await saveGoal({ metric: 'pages', target: 50, startDate: '2026-11-01', endDate: '2026-11-30' });
    const first = await exportBackup();
    await updateBook(id, { notes: 'Second' }); await logSession({ workId: id, pages: 20 });
    const second = await exportBackup();
    await fresh();
    await commitImport((await previewImport(first)).token);
    await commitImport((await previewImport(first)).token);
    await commitImport((await previewImport(second)).token);
    const snapshot = await getSnapshot();
    expect(snapshot.books).toHaveLength(1); expect(snapshot.sessions).toHaveLength(2);
    expect(snapshot.books[0].notes).toBe('Second'); expect(snapshot.goals).toHaveLength(1);
    expect((await db.entity('notes').toArray())).toHaveLength(1);
  });
  it('older different snapshots cannot resurrect deleted notes/sessions or reverse tag archives/rejections', async () => {
    const id = await addBook({ title: 'Book' }); const tag = await createTag('Keep archived');
    await updateBook(id, { notes: 'Secret deleted text', tagIds: [tag] });
    const session = await logSession({ workId: id, pages: 20 });
    const old = await backupObject();
    await updateBook(id, { notes: '' }); await deleteSession(session); await archiveTag(tag); await rejectTag(id, tag);
    old.exportId = crypto.randomUUID(); // A different older snapshot, not a receipt-only duplicate.
    const preview = await previewImport(JSON.stringify(old));
    expect(preview.conflicts.filter((conflict) => conflict.kind === 'deleted')).toHaveLength(2);
    expect(preview.conflicts.some((conflict) => conflict.kind === 'archived')).toBe(true);
    await commitImport(preview.token);
    const snapshot = await getSnapshot();
    expect(snapshot.books[0].notes).toBe(''); expect(snapshot.sessions).toHaveLength(0);
    expect(snapshot.tags.find((item) => item.id === tag)?.archived).toBe(true);
    expect((await db.entity('tagAssignments').toArray())[0].state).toBe('rejected');
    const latest = await backupObject();
    expect(JSON.stringify(latest.entities.tombstones)).not.toContain('Secret deleted text');
  });
  it('explicit restore works while keeping deletion lineage', async () => {
    const id = await addBook({ title: 'Book' }); await updateBook(id, { notes: 'Restore me' });
    const old = await backupObject(); await updateBook(id, { notes: '' });
    const preview = await previewImport(JSON.stringify(old));
    await commitImport(preview.token, decisionsFor(preview));
    expect((await getSnapshot()).books[0].notes).toBe('Restore me');
    expect(await db.entity('tombstones').count()).toBe(1);
    expect((await backupObject()).entities.notes[0].ancestors).toContain((await db.entity('tombstones').toArray())[0].revision);
  });
  it('repeated delete/restore/delete events retain every deletion barrier', async () => {
    const id = await addBook({ title: 'Book' }); await updateBook(id, { notes: 'Original' });
    const first = await backupObject(); await updateBook(id, { notes: '' });
    const restore = await previewImport(JSON.stringify(first)); await commitImport(restore.token, decisionsFor(restore));
    const restored = await backupObject(); await updateBook(id, { notes: '' });
    restored.exportId = crypto.randomUUID();
    const later = await previewImport(JSON.stringify(restored));
    expect(later.conflicts.some((conflict) => conflict.table === 'notes' && conflict.kind === 'deleted')).toBe(true);
    await commitImport(later.token);
    expect((await getSnapshot()).books[0].notes).toBe('');
    expect(await db.entity('tombstones').count()).toBe(2);
  });
  it('preserves local divergent changes by default and can explicitly accept imported changes', async () => {
    const id = await addBook({ title: 'Book' }); await updateBook(id, { notes: 'Base' });
    const base = await backupObject();
    await updateBook(id, { notes: 'Local' });
    const remote = structuredClone(base);
    const note = remote.entities.notes[0];
    remote.entities.notes[0] = stamp({ ...note, text: 'Remote' }, note);
    remote.exportId = crypto.randomUUID();
    const preview = await previewImport(JSON.stringify(remote));
    expect(preview.conflicts.some((conflict) => conflict.table === 'notes')).toBe(true);
    await commitImport(preview.token);
    expect((await getSnapshot()).books[0].notes).toBe('Local');
    remote.exportId = crypto.randomUUID();
    const restore = await previewImport(JSON.stringify(remote));
    await commitImport(restore.token, decisionsFor(restore));
    expect((await getSnapshot()).books[0].notes).toBe('Remote');
  });
  it('reconciles authoritative ISBN/work aliases from another library without duplicate editions', async () => {
    await addBook({ title: 'Provider title', candidate: candidate() }); const source = await exportBackup();
    await fresh();
    await addBook({ title: 'My local title', candidate: candidate() });
    const preview = await previewImport(source);
    await commitImport(preview.token);
    const snapshot = await getSnapshot();
    expect(snapshot.books).toHaveLength(1); expect(snapshot.books[0].editions).toHaveLength(1);
    expect(snapshot.books[0].title).toBe('My local title');
    expect((await db.entity('identifiers').toArray())).toHaveLength(3);
  });
  it('cross-library different assignment UUIDs preserve a pinned local rejection by resolved book/tag pair', async () => {
    const sourceId = await addBook({ title: 'Provider title', candidate: candidate({ subjects: ['Psychology'] }), purpose: 'Remote purpose', primaryLayer: 'fuel', secondaryLayers: ['hardware'] });
    await acceptTag(sourceId, (await getSnapshot()).books[0].tagSuggestions[0].tagId);
    const source = await backupObject();
    await fresh();
    const localId = await addBook({ title: 'Provider title', candidate: candidate({ subjects: ['Psychology'] }), purpose: 'Local purpose', primaryLayer: 'operating-system', secondaryLayers: ['mind-expanding'] });
    const tagId = (await getSnapshot()).books[0].tagSuggestions[0].tagId;
    await rejectTag(localId, tagId);
    const preview = await previewImport(JSON.stringify(source));
    expect(preview.conflicts.some((conflict) => conflict.table === 'tagAssignments' && conflict.kind === 'archived')).toBe(true);
    expect(preview.conflicts.some((conflict) => conflict.table === 'layerAssignments')).toBe(true);
    await commitImport(preview.token);
    let book = (await getSnapshot()).books[0];
    expect(book.tags).toEqual([]);
    expect(book).toMatchObject({ purpose: 'Local purpose', primaryLayer: 'operating-system', secondaryLayers: ['mind-expanding'] });
    expect(await db.entity('layerAssignments').count()).toBe(1);
    source.exportId = crypto.randomUUID();
    const restore = await previewImport(JSON.stringify(source));
    await commitImport(restore.token, Object.fromEntries(restore.conflicts.filter((conflict) => conflict.table === 'tagAssignments').map((conflict) => [conflict.id, 'use-import' as const])));
    book = (await getSnapshot()).books[0];
    expect(book.tags.map((tag) => tag.id)).toEqual([tagId]);
    expect((await db.entity('tagAssignments').toArray()).every((assignment) => assignment.state === 'accepted')).toBe(true);
  });
  it('cross-library alias and merge mapping cannot bypass a renamed rejection or archived destination', async () => {
    const sourceId = await addBook({ title: 'Provider title', candidate: candidate({ subjects: ['Psychology'] }) });
    await acceptTag(sourceId, (await getSnapshot()).books[0].tagSuggestions[0].tagId);
    const source = await backupObject(); await fresh();
    const localId = await addBook({ title: 'Provider title', candidate: candidate({ subjects: ['Psychology'] }) });
    const oldTag = (await getSnapshot()).books[0].tagSuggestions[0].tagId;
    await rejectTag(localId, oldTag); await renameTag(oldTag, 'Mind');
    const first = await previewImport(JSON.stringify(source)); await commitImport(first.token);
    expect((await getSnapshot()).books[0].tags).toEqual([]);
    expect(await db.entity('tags').count()).toBe(1);
    const target = await createTag('Mental models'); await mergeTags(oldTag, target); await archiveTag(target);
    source.exportId = crypto.randomUUID();
    const second = await previewImport(JSON.stringify(source)); await commitImport(second.token);
    expect((await getSnapshot()).books[0].tags).toEqual([]);
    expect((await getSnapshot()).tags.find((tag) => tag.id === target)?.archived).toBe(true);
    expect(await db.entity('tags').count()).toBe(2);
  });
  it('cross-library distinct notes consolidate once on textarea save and never resurrect after deletion', async () => {
    const sourceId = await addBook({ title: 'Provider title', candidate: candidate() });
    await updateBook(sourceId, { notes: 'Remote note' }); const source = await backupObject();
    await fresh();
    const localId = await addBook({ title: 'Provider title', candidate: candidate() }); await updateBook(localId, { notes: 'Local note' });
    await commitImport((await previewImport(JSON.stringify(source))).token);
    const joined = (await getSnapshot()).books[0].notes;
    expect(joined).toContain('Local note'); expect(joined).toContain('Remote note');
    await updateBook(localId, { notes: joined }); await updateBook(localId, { notes: joined });
    expect((await getSnapshot()).books[0].notes).toBe(joined);
    expect(await db.entity('notes').count()).toBe(1);
    await updateBook(localId, { notes: 'Edited once' });
    expect((await getSnapshot()).books[0].notes).toBe('Edited once');
    await updateBook(localId, { notes: '' });
    source.exportId = crypto.randomUUID();
    const oldPreview = await previewImport(JSON.stringify(source));
    expect(oldPreview.conflicts.some((conflict) => conflict.table === 'notes' && conflict.kind === 'deleted')).toBe(true);
    await commitImport(oldPreview.token);
    expect((await getSnapshot()).books[0].notes).toBe('');
  });
  it('rejects stale previews and concurrent commits without partial changes', async () => {
    await addBook({ title: 'Imported' }); const source = await exportBackup(); await fresh();
    const first = await previewImport(source), second = await previewImport(source);
    await commitImport(first.token);
    await expect(commitImport(second.token)).rejects.toBeInstanceOf(StaleImportPreviewError);
    expect((await getSnapshot()).books).toHaveLength(1);
    const stale = await previewImport(source); await addBook({ title: 'Local change' });
    await expect(commitImport(stale.token)).rejects.toThrow('changed after');
  });
  it('a successful safety export does not invalidate an import preview', async () => {
    await addBook({ title: 'Imported' }); const source = await exportBackup(); await fresh();
    const preview = await previewImport(source);
    const before = (await getSnapshot()).revision;
    await exportBackup();
    const exportedAt = (await getSnapshot()).settings.lastExportAt;
    expect((await getSnapshot()).revision).toBe(before);
    await commitImport(preview.token);
    expect((await getSnapshot()).books).toHaveLength(1);
    expect((await getSnapshot()).settings.lastExportAt).toBe(exportedAt);
  });
  it('a failed export does not falsely record success or change library content', async () => {
    const id = await addBook({ title: 'Book' });
    await exportBackup();
    const before = await getSnapshot();
    await db.entity('notes').put(stamp({ workId: id, text: 'x'.repeat(BACKUP_LIMITS.stringLength + 1) }));
    await expect(exportBackup()).rejects.toThrow();
    const after = await getSnapshot();
    expect(after.settings.lastExportAt).toBe(before.settings.lastExportAt);
    expect(after.revision).toBe(before.revision);
  });
  it('cancellation and failed writes preserve the previous library and retries work', async () => {
    const id = await addBook({ title: 'Imported' }); await updateBook(id, { notes: 'Payload' }); const source = await exportBackup(); await fresh();
    const cancelled = await previewImport(source); cancelImport(cancelled.token);
    await expect(commitImport(cancelled.token)).rejects.toThrow('cancelled');
    const preview = await previewImport(source);
    const spy = vi.spyOn(db.entity('notes'), 'bulkPut').mockRejectedValueOnce(new DOMException('Storage full', 'QuotaExceededError'));
    await expect(commitImport(preview.token)).rejects.toThrow('Storage full'); spy.mockRestore();
    expect((await getSnapshot()).books).toHaveLength(0); expect(await db.entity('importReceipts').count()).toBe(0);
    await commitImport(preview.token); expect((await getSnapshot()).books).toHaveLength(1);
  });
  it('rejects malformed, unsupported, hostile, oversized, unsafe URL and broken-relation files before writes', async () => {
    const id = await addBook({ title: 'Safe' }); const document = await backupObject();
    const cases: string[] = ['{', JSON.stringify({ ...document, formatVersion: 99 }), '{"__proto__":{"polluted":true}}', ' '.repeat(BACKUP_LIMITS.bytes + 1)];
    const unsafe = structuredClone(document); unsafe.entities.holdings[0].sourceUrl = 'javascript:alert(1)'; cases.push(JSON.stringify(unsafe));
    const broken = structuredClone(document); broken.entities.editions[0].workId = crypto.randomUUID(); cases.push(JSON.stringify(broken));
    const badIsbn = structuredClone(document); badIsbn.entities.identifiers.push(stamp({ entityId: document.entities.editions[0].id, entityType: 'edition', scheme: 'isbn', value: '9780306406158' })); cases.push(JSON.stringify(badIsbn));
    const hostileNested = JSON.stringify(document).replace('"title":"Safe"', '"title":"Safe","constructor":{}'); cases.push(hostileNested);
    for (const text of cases) await expect(previewImport(text)).rejects.toThrow();
    expect((await getSnapshot()).books[0].id).toBe(id);
    expect(await db.entity('importReceipts').count()).toBe(0);
  });
  it('a deleted book stays deleted after importing a different older snapshot', async () => {
    const id = await addBook({ title: 'Deleted' }); await updateBook(id, { notes: 'Gone' });
    const old = await exportBackup(); await deleteBook(id);
    const preview = await previewImport(old); await commitImport(preview.token);
    expect((await getSnapshot()).books).toHaveLength(0);
  });
});

describe('versioned IndexedDB upgrades', () => {
  it('migrates a v1 fixture without losing user data', async () => {
    const name = `migration-${crypto.randomUUID()}`; const old = new Dexie(name);
    old.version(1).stores(V1_SCHEMA); await old.open();
    const tag = stamp({ name: 'Legacy', normalizedName: 'legacy', kind: 'topic' });
    await old.table('tags').put(tag); old.close();
    const current = new LibraryDatabase(name); await current.open();
    expect(await current.entity('tags').get(tag.id)).toMatchObject({ name: 'Legacy', archived: false, pinned: true, aliases: [] });
    expect(current.tables.some((table) => table.name === 'tombstones')).toBe(true);
    current.close(); await current.delete();
  });
  it('an aborted upgrade leaves the prior database readable, without reset', async () => {
    const name = `failed-migration-${crypto.randomUUID()}`; const old = new LibraryDatabase(name); await old.open();
    const tag = stamp({ name: 'Keep', normalizedName: 'keep', kind: 'topic', aliases: [], archived: false, pinned: true });
    await old.table('tags').put(tag); old.close();
    const broken = new Dexie(name); broken.version(2).stores({ ...V1_SCHEMA, tombstones: 'id', mergeLineage: 'id', importReceipts: 'id' });
    broken.version(3).stores({ tags: 'id' }).upgrade(async (tx) => { await tx.table('tags').clear(); throw new Error('Upgrade failed'); });
    await expect(broken.open()).rejects.toThrow('Upgrade failed'); broken.close();
    const recovery = JSON.parse(await exportRecoveryBackup(name));
    expect(recovery.format).toBe('vaayana-recovery');
    expect(recovery.schemaVersion).toBe(2);
    expect(recovery.stores.tags[0].name).toBe('Keep');
    const recovered = new LibraryDatabase(name); await recovered.open();
    expect((await recovered.entity('tags').get(tag.id))?.name).toBe('Keep');
    recovered.close(); await recovered.delete();
  });
});
