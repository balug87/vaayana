import 'fake-indexeddb/auto';
import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import Dexie from 'dexie';
import { db, LibraryDatabase, readEntities, stamp, V1_SCHEMA } from './db';
import { addBook, deleteBook, getSnapshot, saveSettings, updateBook } from './library';
import { beginCoverLookup, completeCoverLookup, getCoverQueueSnapshot, getCoverTargets, getUploadedCoverBlob,
  isCoverLookupClaimActive, recoverInterruptedCoverLookups, revertUploadedCover, saveUploadedCover, setCoverQueuePaused } from './covers';
import { COVER_LIMITS, bytesToBase64, validateCoverJpeg } from './cover-validation';
import { exampleCoverJpeg, exactSizeCoverJpeg } from './cover-test-fixtures';
import { BACKUP_LIMITS, commitImport, exportBackup, previewImport } from './backup';
import { serializePortableBackup } from './portable-backup';
import { parseBackup } from './backup-validation';
import type { CoverState, EntityTable } from '../domain/types';

async function fresh() { db.close(); await db.delete(); await db.open(); }
beforeEach(fresh);
afterEach(() => vi.restoreAllMocks());
const blob = (bytes: Uint8Array) => new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' });
const workTarget = async (id: string) => (await getCoverTargets()).find((row) => row.workId === id)!;
async function enable() { await saveSettings({ onlineAccess: true, loadCovers: true, autoFetchCovers: true }); }
async function claim(id: string, options: { manual?: boolean; retry?: boolean } = {}) {
  return beginCoverLookup(id, { queryFingerprint: (await workTarget(id)).queryFingerprint, ...options });
}
const acceptAll = (preview: Awaited<ReturnType<typeof previewImport>>) => Object.fromEntries(preview.conflicts.map((row) => [row.id, 'use-import' as const]));

describe('cover-only persistence and portable images', () => {
  it('shows uploaded photos offline, preserves every non-cover book field, and exposes descriptors rather than bytes', async () => {
    await commitImport((await previewImport(JSON.stringify({ books: [{ title: 'Invented cover-only entry', author: null }] }))).token);
    const before = await getSnapshot(), id = before.books[0].id;
    const nonCoverTables = (db.tables.map((row) => row.name).filter((name) => !['coverStates', 'coverJobs', 'meta'].includes(name))) as EntityTable[];
    const original = await Promise.all(nonCoverTables.map((name) => db.table(name).toArray()));
    const photo = await exampleCoverJpeg();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network'));
    await saveUploadedCover(id, { jpeg: blob(photo) }, { expectedCoverRevision: null });
    const book = (await getSnapshot()).books[0];
    expect(book.cover).toMatchObject({ kind: 'uploaded', width: 32, height: 48, byteLength: photo.length });
    expect(JSON.stringify(await getSnapshot()).includes(bytesToBase64(photo))).toBe(false);
    expect(JSON.stringify(await getCoverTargets()).includes(bytesToBase64(photo))).toBe(false);
    expect(await Promise.all(nonCoverTables.map((name) => db.table(name).toArray()))).toEqual(original);
    expect((await getSnapshot()).readingCycles).toEqual([]);
    const stored = await getUploadedCoverBlob(id);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(photo);
    db.close(); await db.open();
    expect((await getSnapshot()).books[0].cover?.kind).toBe('uploaded');
    expect(await getUploadedCoverBlob(id, 'outdated-revision')).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('uploaded cover wins, removal exposes the provider fallback, and old exports cannot undo removal', async () => {
    const id = await addBook({ title: 'Invented fallback' }); await enable();
    const lookup = (await claim(id))!;
    await completeCoverLookup(id, { attemptId: lookup.attemptId, queryFingerprint: lookup.target.queryFingerprint, result: { status: 'found', coverId: 42 } });
    const provider = await workTarget(id);
    await saveUploadedCover(id, { jpeg: blob(await exampleCoverJpeg()) }, { expectedCoverRevision: provider.coverRevision });
    const old = await exportBackup();
    const photoState = (await getSnapshot()).books[0].cover!;
    expect(photoState.kind).toBe('uploaded');
    await revertUploadedCover(id);
    expect((await getSnapshot()).books[0].cover).toMatchObject({ kind: 'provider', coverId: 42 });
    await commitImport((await previewImport(old)).token);
    expect((await getSnapshot()).books[0].cover?.kind).toBe('provider');
    expect((await db.entity('coverStates').toArray())[0].uploaded).toBeUndefined();
  });
  it('allows repeated upload/remove/upload using the shelf descriptor revision without a provider fallback', async () => {
    const id = await addBook({ title: 'Invented repeat photo cycle' }), jpeg = blob(await exampleCoverJpeg());
    expect((await getSnapshot()).books[0].cover).toEqual({ kind: 'none' });
    let retainedId: string | undefined;
    for (let cycle = 0; cycle < 3; cycle++) {
      const before = (await getSnapshot()).books[0].cover;
      await saveUploadedCover(id, { jpeg }, { expectedCoverRevision: before?.revision ?? null });
      const uploaded = (await db.entity('coverStates').where('workId').equals(id).first())!;
      retainedId ??= uploaded.id;
      expect(uploaded.id).toBe(retainedId);
      await revertUploadedCover(id, { expectedCoverRevision: uploaded.revision });
      const removed = (await db.entity('coverStates').where('workId').equals(id).first())!;
      expect(removed.id).toBe(retainedId);
      expect(removed.ancestors).toContain(uploaded.revision);
      expect(removed.uploaded).toBeUndefined();
      expect((await getSnapshot()).books[0].cover?.kind).toBe('none');
      await expect(saveUploadedCover(id, { jpeg }, { expectedCoverRevision: uploaded.revision })).rejects.toThrow('The cover changed');
    }
    const current = (await db.entity('coverStates').where('workId').equals(id).first())!;
    expect((await getSnapshot()).books[0].cover).toEqual({ kind: 'none', revision: current.revision });
    expect((await workTarget(id)).cover).toEqual({ kind: 'none', revision: current.revision });
  });
  it('allows another upload after a removed-cover backup is imported into a fresh library', async () => {
    const id = await addBook({ title: 'Invented portable photo removal' }), jpeg = blob(await exampleCoverJpeg());
    await saveUploadedCover(id, { jpeg }, { expectedCoverRevision: null });
    await revertUploadedCover(id);
    const removed = (await db.entity('coverStates').where('workId').equals(id).first())!;
    const exported = await exportBackup();
    await fresh(); await commitImport((await previewImport(exported)).token);
    const imported = (await getSnapshot()).books[0].cover;
    expect(imported?.kind).toBe('none');
    await saveUploadedCover(id, { jpeg }, { expectedCoverRevision: imported?.revision ?? null });
    const uploaded = (await db.entity('coverStates').where('workId').equals(id).first())!;
    expect(uploaded.id).toBe(removed.id);
    expect(uploaded.ancestors).toContain(removed.revision);
    expect((await getSnapshot()).books[0].cover?.kind).toBe('uploaded');
    await expect(saveUploadedCover(id, { jpeg }, { expectedCoverRevision: null })).rejects.toThrow('The cover changed');
  });
  it('round trips normalized JPEGs and excludes operational jobs/pause; fresh import never enables consent', async () => {
    const id = await addBook({ title: 'Invented portable cover' }); await enable();
    await saveUploadedCover(id, { jpeg: blob(await exampleCoverJpeg()) }, { expectedCoverRevision: null });
    await setCoverQueuePaused(true);
    const text = await exportBackup(), parsed = parseBackup(text);
    expect(parsed.schemaVersion).toBe(3);
    expect(parsed.entities.coverStates[0].uploaded?.mime).toBe('image/jpeg');
    expect(parsed.entities).not.toHaveProperty('coverJobs');
    expect(text.includes('cover-queue')).toBe(false);
    await fresh();
    await commitImport((await previewImport(text)).token);
    expect((await getSnapshot()).settings.autoFetchCovers).toBe(false);
    expect((await getCoverQueueSnapshot()).jobs).toEqual([]);
    expect(await getUploadedCoverBlob(id)).toBeDefined();
    expect((await getCoverQueueSnapshot()).paused).toBe(false);
  });
  it('retains receiver opt-in and durable queue pause across imported settings and catalogue additions', async () => {
    await addBook({ title: 'Source settings' }); const source = await exportBackup();
    await fresh(); await enable(); await setCoverQueuePaused(true);
    const preview = await previewImport(source);
    await commitImport(preview.token, acceptAll(preview));
    expect((await getSnapshot()).settings.autoFetchCovers).toBe(true);
    expect((await getCoverQueueSnapshot()).paused).toBe(true);
    await commitImport((await previewImport('{"books":[{"title":"New queued catalog","author":null}]}')).token);
    expect((await getCoverQueueSnapshot()).paused).toBe(true);
  });
  it('rejects overlapping uploads using the revision captured before image preparation', async () => {
    const id = await addBook({ title: 'Invented overlap' }), photo = blob(await exampleCoverJpeg());
    const results = await Promise.allSettled([
      saveUploadedCover(id, { jpeg: photo }, { expectedCoverRevision: null }),
      saveUploadedCover(id, { jpeg: photo }, { expectedCoverRevision: null }),
    ]);
    expect(results.filter((row) => row.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((row) => row.status === 'rejected')).toHaveLength(1);
    expect(await db.entity('coverStates').count()).toBe(1);
  });
  it('photo deletion tombstones contain no bytes; older uploads require explicit restore and quota rollback preserves the old photo', async () => {
    const id = await addBook({ title: 'Invented delete' }), jpeg = await exampleCoverJpeg();
    await saveUploadedCover(id, { jpeg: blob(jpeg) }, { expectedCoverRevision: null });
    const before = await exportBackup();
    const original = await db.entity('coverStates').where('workId').equals(id).first();
    const spy = vi.spyOn(db.entity('coverStates'), 'put').mockRejectedValueOnce(new DOMException('Storage quota', 'QuotaExceededError'));
    await expect(saveUploadedCover(id, { jpeg: blob(jpeg) }, { expectedCoverRevision: original!.revision })).rejects.toThrow('Storage quota');
    spy.mockRestore();
    expect((await db.entity('coverStates').where('workId').equals(id).first())?.revision).toBe(original!.revision);
    await deleteBook(id);
    expect(JSON.stringify(await db.entity('tombstones').toArray()).includes(bytesToBase64(jpeg))).toBe(false);
    const preview = await previewImport(before);
    expect(preview.conflicts.some((row) => row.table === 'coverStates' && row.kind === 'deleted')).toBe(true);
    await commitImport(preview.token);
    expect((await getSnapshot()).books).toEqual([]);
  });
  it('different libraries matching the same authoritative work expose a cover conflict, preserving the local photo by default', async () => {
    const candidate = { workId: '/works/OL777W', editionId: '/books/OL777M', title: 'Invented shared work',
      authors: ['Fictional Author'], subjects: [], isbn: [], sourceUrl: 'https://openlibrary.org/works/OL777W', fetchedAt: '2026-11-24T12:00:00.000Z' };
    const sourceId = await addBook({ title: candidate.title, candidate });
    await enable();
    const sourceClaim = (await claim(sourceId, { manual: true }))!;
    await completeCoverLookup(sourceId, { attemptId: sourceClaim.attemptId, queryFingerprint: sourceClaim.target.queryFingerprint,
      result: { status: 'found', coverId: 77 } });
    const source = await exportBackup();
    await fresh();
    const localId = await addBook({ title: candidate.title, candidate });
    await saveUploadedCover(localId, { jpeg: blob(await exampleCoverJpeg()) }, { expectedCoverRevision: null });
    const preview = await previewImport(source);
    expect(preview.conflicts.some((row) => row.table === 'coverStates')).toBe(true);
    await commitImport(preview.token);
    expect((await getSnapshot()).books).toHaveLength(1);
    expect((await getSnapshot()).books[0].cover?.kind).toBe('uploaded');
    expect(await db.entity('coverStates').count()).toBe(1);
  });
});

describe('strict photo and backup bounds', () => {
  it('accepts a genuine metadata-free JPEG, rejects arbitrary types, EXIF, trailing payloads and oversized dimensions', async () => {
    const good = await exampleCoverJpeg();
    expect(validateCoverJpeg(good)).toEqual({ width: 32, height: 48 });
    expect(await sharp(Buffer.from(good)).metadata()).toMatchObject({ format: 'jpeg', width: 32, height: 48 });
    const malicious = [
      new TextEncoder().encode('<svg onload="alert(1)"/>'),
      Uint8Array.from([...good, ...new TextEncoder().encode('<script>')]),
      Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, ...new TextEncoder().encode('Exif\0\0'), ...good.slice(2)]),
      good.slice(0, -2),
    ];
    for (const bytes of malicious) expect(() => validateCoverJpeg(bytes)).toThrow();
    const huge = new Uint8Array(await sharp({ create: { width: 513, height: 16, channels: 3, background: '#fff' } }).jpeg().toBuffer());
    expect(() => validateCoverJpeg(huge)).toThrow('512');
  });
  it('rejects the reported marker-only JPEG, missing table references and unsupported scan structure on save and import', async () => {
    const bogus = Uint8Array.from([255,216,255,219,0,2,255,196,0,2,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]);
    const good = await exampleCoverJpeg();
    const wrongTable = Uint8Array.from(good);
    const wrongScan = Uint8Array.from(good);
    for (let index = 2; index < good.length - 2; index++) {
      if (good[index] === 0xff && good[index + 1] === 0xc0) wrongTable[index + 12] = 3;
      if (good[index] === 0xff && good[index + 1] === 0xda) {
        const end = index + 2 + (good[index + 2] << 8) + good[index + 3];
        wrongScan[end - 2] = 64;
        break;
      }
    }
    const id = await addBook({ title: 'Keep the genuine original cover' });
    await saveUploadedCover(id, { jpeg: blob(good) }, { expectedCoverRevision: null });
    const original = (await workTarget(id)).coverRevision!;
    const exported = JSON.parse(await exportBackup());
    for (const bad of [bogus, wrongTable, wrongScan]) {
      expect(() => validateCoverJpeg(bad)).toThrow();
      await expect(saveUploadedCover(id, { jpeg: blob(bad) }, { expectedCoverRevision: original })).rejects.toThrow();
      const incoming = structuredClone(exported);
      incoming.entities.coverStates[0].uploaded = { mime: 'image/jpeg', width: 1, height: 1, byteLength: bad.length, jpegBase64: bytesToBase64(bad) };
      await expect(previewImport(JSON.stringify(incoming))).rejects.toThrow();
    }
    expect((await workTarget(id)).coverRevision).toBe(original);
    expect(await getUploadedCoverBlob(id)).toBeDefined();
  });
  it('checks exact 64 KiB/next-byte JPEG caps and genuine decodability independently', async () => {
    const exact = await exactSizeCoverJpeg(65_536);
    expect(exact.length).toBe(COVER_LIMITS.photoBytes);
    expect(validateCoverJpeg(exact)).toEqual({ width: 32, height: 48 });
    expect((await sharp(Buffer.from(exact)).raw().toBuffer()).length).toBe(32 * 48 * 3);
    expect(() => validateCoverJpeg(awaitableTooLarge(exact))).toThrow('64 KiB');
  });
  it('keeps all other strings/unknown keys strict and rejects bad MIME/dimensions/base64 in imported covers', async () => {
    const id = await addBook({ title: 'Invented hostile backup' });
    await saveUploadedCover(id, { jpeg: blob(await exampleCoverJpeg()) }, { expectedCoverRevision: null });
    const document = JSON.parse(await exportBackup());
    for (const field of ['mime', 'width', 'byteLength', 'jpegBase64']) {
      const hostile = structuredClone(document);
      const upload = hostile.entities.coverStates[0].uploaded;
      upload[field] = field === 'mime' ? 'image/svg+xml' : field === 'jpegBase64' ? 'data:image/jpeg;base64,bad' : 999;
      await expect(previewImport(JSON.stringify(hostile))).rejects.toThrow();
    }
    const hostile = structuredClone(document);
    hostile.entities.coverStates[0].uploaded.arbitrary = 'https://example.com/photo';
    await expect(previewImport(JSON.stringify(hostile))).rejects.toThrow('Unknown field');
    const other = structuredClone(document); other.entities.works[0].title = 'x'.repeat(20_001);
    await expect(previewImport(JSON.stringify(other))).rejects.toThrow();
  });
  it('accepts exactly 8 MiB of genuine JPEGs, rejects the next photo and round trips the full budget', async () => {
    const started = performance.now(), exact = await exactSizeCoverJpeg(65_536);
    const uploaded = { mime: 'image/jpeg' as const, width: 32, height: 48, byteLength: exact.length, jpegBase64: bytesToBase64(exact) };
    const states: CoverState[] = [];
    for (let index = 0; index < 127; index++) {
      const work = stamp({ title: `Budget cover ${index}`, authors: [] });
      const edition = stamp({ workId: work.id, metadata: { title: work.title, authors: [] } });
      await db.entity('works').add(work); await db.entity('editions').add(edition);
      states.push(stamp({ workId: work.id, uploaded }));
    }
    await db.entity('coverStates').bulkAdd(states);
    const final = await addBook({ title: 'Final budget photo' });
    await saveUploadedCover(final, { jpeg: blob(exact) }, { expectedCoverRevision: null });
    const next = await addBook({ title: 'Over budget photo' });
    await expect(saveUploadedCover(next, { jpeg: blob(exact) }, { expectedCoverRevision: null })).rejects.toThrow('8 MiB');
    expect(await db.entity('coverStates').count()).toBe(128);
    const text = await exportBackup();
    expect(parseBackup(text).entities.coverStates).toHaveLength(128);
    await fresh(); await commitImport((await previewImport(text)).token);
    expect(await db.entity('coverStates').count()).toBe(128);
    console.info(JSON.stringify({ photoBytes: 8 * 1024 * 1024, portableBytes: new TextEncoder().encode(text).byteLength,
      fullBudgetRoundtripMs: Math.round(performance.now() - started) }));
  }, 60_000);
  it('refuses a cover change that would make a near-20-MiB library unexportable without changing records or success timestamps', async () => {
    const id = await addBook({ title: 'Invented near-cap library' });
    const entities = await readEntities(), meta = await db.meta.get('library');
    const notes = [];
    let remaining = BACKUP_LIMITS.bytes - 10_000 - new TextEncoder().encode(serializePortableBackup(meta!.libraryId, entities).text).byteLength;
    // Each row's serialized overhead is measured independently; no relaxed limits.
    while (remaining > 500) {
      const row = stamp({ workId: id, text: '' });
      const overhead = new TextEncoder().encode(JSON.stringify(row, null, 2)).byteLength +
        Object.keys(row).length * 6 + 10;
      const length = Math.min(20_000, Math.max(0, remaining - overhead));
      row.text = 'x'.repeat(length); notes.push(row);
      remaining -= length + overhead;
    }
    entities.notes = notes;
    let serialized = serializePortableBackup(meta!.libraryId, entities);
    const actualBytes = new TextEncoder().encode(serialized.text).byteLength;
    const adjust = BACKUP_LIMITS.bytes - 10_000 - actualBytes;
    if (adjust > 0) {
      let needed = adjust;
      for (const row of notes) {
        const add = Math.min(20_000 - row.text.length, needed);
        row.text += 'x'.repeat(add); needed -= add;
        if (!needed) break;
      }
    } else {
      let needed = -adjust;
      for (const row of notes) {
        const cut = Math.min(row.text.length, needed);
        row.text = row.text.slice(cut); needed -= cut;
        if (!needed) break;
      }
    }
    serialized = serializePortableBackup(meta!.libraryId, entities);
    expect(new TextEncoder().encode(serialized.text).byteLength > BACKUP_LIMITS.bytes - 50_000).toBe(true);
    await db.entity('notes').bulkAdd(notes);
    await exportBackup();
    const before = (await getSnapshot()).settings.lastExportAt, revision = (await getSnapshot()).revision;
    await expect(saveUploadedCover(id, { jpeg: blob(await exactSizeCoverJpeg(65_536)) }, { expectedCoverRevision: null })).rejects.toThrow('20 MiB');
    expect(await db.entity('coverStates').count()).toBe(0);
    expect((await getSnapshot()).revision).toBe(revision);
    expect((await getSnapshot()).settings.lastExportAt).toBe(before);
    expect(parseBackup(await exportBackup()).entities.notes.length).toBe(notes.length);
  }, 30_000);
});
function awaitableTooLarge(exact: Uint8Array) { return Uint8Array.from([...exact, 0]); }

describe('operational queue claims and cancellation', () => {
  it('allows at most one live claim across different books even without browser WebLocks', async () => {
    const first = await addBook({ title: 'First independent claimed book' });
    const second = await addBook({ title: 'Second independent claimed book' });
    await enable();
    const claims = await Promise.all([claim(first), claim(second)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const running = (await getCoverQueueSnapshot()).jobs.filter((job) => job.status === 'running');
    expect(running).toHaveLength(1);
    await recoverInterruptedCoverLookups();
    expect((await getCoverQueueSnapshot()).jobs[0].status).toBe('running');
    const owned = claims.find(Boolean)!;
    await completeCoverLookup(owned.target.workId, { attemptId: owned.attemptId, queryFingerprint: owned.target.queryFingerprint,
      result: { status: 'cancelled', failureCode: 'cancelled' } });
    expect(await claim(owned.target.workId)).toBeUndefined();
    const other = owned.target.workId === first ? second : first;
    expect(await claim(other)).toBeDefined();
  });
  it('requires consent, persists claims without library revisions and admits only one overlapping claim', async () => {
    const id = await addBook({ title: 'Invented queue' }), before = (await getSnapshot()).revision;
    expect(await claim(id)).toBeUndefined(); expect(await claim(id, { manual: true })).toBeUndefined();
    await enable();
    const revision = (await getSnapshot()).revision;
    const claims = await Promise.all([claim(id), claim(id)]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await getSnapshot()).revision).toBe(revision);
    expect(revision > before).toBe(true);
    const owned = claims.find(Boolean)!;
    expect(await isCoverLookupClaimActive(id, { attemptId: owned.attemptId, queryFingerprint: owned.target.queryFingerprint })).toBe(true);
    expect(JSON.stringify(owned).includes('notes')).toBe(false);
  });
  it('a failed/no-match same-fingerprint job survives reload and requires explicit retry', async () => {
    const id = await addBook({ title: 'Invented no-match' }); await enable();
    const first = (await claim(id))!;
    await completeCoverLookup(id, { attemptId: first.attemptId, queryFingerprint: first.target.queryFingerprint, result: { status: 'no-match', failureCode: 'ambiguous' } });
    db.close(); await db.open();
    expect(await claim(id)).toBeUndefined();
    expect((await getCoverQueueSnapshot()).jobs[0]).toMatchObject({ status: 'no-match', failureCode: 'ambiguous' });
    expect(await claim(id, { retry: true })).toBeDefined();
  });
  it('pause remains through edits/reload and cancels late writes; manual attempts bypass pause but not permissions', async () => {
    const id = await addBook({ title: 'Invented pause' }); await enable();
    const first = (await claim(id))!;
    const revision = (await getSnapshot()).revision;
    await setCoverQueuePaused(true);
    expect((await getSnapshot()).revision).toBe(revision);
    expect(await isCoverLookupClaimActive(id, { attemptId: first.attemptId, queryFingerprint: first.target.queryFingerprint })).toBe(false);
    expect((await completeCoverLookup(id, { attemptId: first.attemptId, queryFingerprint: first.target.queryFingerprint, result: { status: 'found', coverId: 5 } })).applied).toBe(false);
    await updateBook(id, { notes: 'A private correction' }); db.close(); await db.open();
    expect((await getCoverQueueSnapshot()).paused).toBe(true);
    expect(await claim(id)).toBeUndefined();
    expect(await claim(id, { manual: true, retry: true })).toBeDefined();
    await saveSettings({ onlineAccess: false });
    expect(await claim(id, { manual: true, retry: true })).toBeUndefined();
  });
  it.each(['edit', 'upload', 'delete', 'disable', 'expire'] as const)('rechecks actual saved state before fetch and commit after %s', async (change) => {
    const id = await addBook({ title: `Invented ${change}` }); await enable();
    const first = (await claim(id))!;
    const input = { attemptId: first.attemptId, queryFingerprint: first.target.queryFingerprint };
    if (change === 'edit') await updateBook(id, { title: 'Changed actual bibliography' });
    if (change === 'upload') await saveUploadedCover(id, { jpeg: blob(await exampleCoverJpeg()) }, { expectedCoverRevision: null });
    if (change === 'delete') await deleteBook(id);
    if (change === 'disable') await saveSettings({ autoFetchCovers: false });
    if (change === 'expire') {
      const job = await db.table('coverJobs').get(id); await db.table('coverJobs').put({ ...job, leaseUntil: 0 });
    }
    expect(await isCoverLookupClaimActive(id, input)).toBe(false);
    expect((await completeCoverLookup(id, { ...input, result: { status: 'found', coverId: 123 } })).applied).toBe(false);
    expect((await db.entity('coverStates').where('workId').equals(id).first())?.provider).toBeUndefined();
    if (change === 'delete') expect(await db.table('coverJobs').get(id)).toBeUndefined();
  });
  it('lease recovery cancels, does not retry, and a new bibliography permits one new claim', async () => {
    const id = await addBook({ title: 'Invented recovery' }); await enable(); await claim(id);
    const job = await db.table('coverJobs').get(id); await db.table('coverJobs').put({ ...job, leaseUntil: 0 });
    await recoverInterruptedCoverLookups();
    expect((await getCoverQueueSnapshot()).jobs[0]).toMatchObject({ status: 'cancelled', failureCode: 'interrupted' });
    expect(await claim(id)).toBeUndefined();
    await updateBook(id, { title: 'Another genuine bibliography revision' });
    expect(await claim(id)).toBeDefined();
  });
});
it('migrates an actual schema2 IndexedDB fixture to 3 without touching catalog or diary records', async () => {
  const name = `cover-migration-${crypto.randomUUID()}`, old = new Dexie(name);
  old.version(2).stores({ ...V1_SCHEMA, tombstones: 'id', mergeLineage: 'id', importReceipts: 'id' });
  await old.open();
  const work = stamp({ title: 'Legacy saved book', authors: [] });
  await old.table('works').put(work); old.close();
  const upgraded = new LibraryDatabase(name);
  try {
    await upgraded.open();
    expect((await upgraded.entity('works').get(work.id))?.title).toBe(work.title);
    expect(upgraded.verno).toBe(3);
    expect(await upgraded.entity('coverStates').count()).toBe(0);
    expect(await upgraded.table('coverJobs').count()).toBe(0);
  } finally { upgraded.close(); await upgraded.delete(); }
});
it('accepts genuine old schema2 backups, but rejects new cover keys masquerading as schema2', async () => {
  await addBook({ title: 'Invented historical backup' });
  const current = JSON.parse(await exportBackup());
  const older = structuredClone(current); older.schemaVersion = 2;
  delete older.entities.coverStates;
  for (const setting of older.entities.settings) delete setting.value.autoFetchCovers;
  expect(parseBackup(JSON.stringify(older)).schemaVersion).toBe(3);
  const malformed = structuredClone(current); malformed.schemaVersion = 2;
  await expect(previewImport(JSON.stringify(malformed))).rejects.toThrow('schema version 3');
});
