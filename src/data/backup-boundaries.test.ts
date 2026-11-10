import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { BackupDocument } from '../domain/types';
import { db, stamp } from './db';
import { addBook, getSnapshot, logSession } from './library';
import { BACKUP_LIMITS, cancelImport, commitImport, exportBackup, previewImport } from './backup';
import { parseBackup } from './backup-validation';

async function fresh() { db.close(); await db.delete(); await db.open(); }
beforeEach(fresh);
describe('published backup boundaries', () => {
  it('exports, parses, and atomically imports 10,001 actual session records', async () => {
    const started = performance.now();
    const workId = await addBook({ title: 'Long reading diary' });
    await logSession({ workId, pages: 1 });
    const first = (await db.entity('sessions').toArray())[0];
    await db.entity('sessions').bulkAdd(Array.from({ length: 10_000 }, () => stamp({
      workId, editionId: first.editionId, cycleId: first.cycleId, occurredAt: first.occurredAt, pages: 1, minutes: 1,
    })));
    const text = await exportBackup();
    expect(parseBackup(text).entities.sessions).toHaveLength(10_001);
    await fresh();
    await commitImport((await previewImport(text)).token);
    expect(await db.entity('sessions').count()).toBe(10_001);
    expect(parseBackup(await exportBackup()).entities.sessions).toHaveLength(10_001);
    console.info(`10001 sessions: ${new TextEncoder().encode(text).byteLength} bytes, ${Math.round(performance.now() - started)} ms export/parse/import/re-export`);
  }, 60_000);
  it('round trips the full 50,000 user-record cap with provenance kept separately', async () => {
    const started = performance.now();
    await addBook({ title: 'Maximum corpus' });
    const base = JSON.parse(await exportBackup()) as BackupDocument;
    const count = Object.values(base.entities).reduce((total, rows) => total + rows.length, 0);
    await db.entity('interests').bulkAdd(Array.from({ length: BACKUP_LIMITS.records - count }, () => stamp({ name: 'x' })));
    const text = await exportBackup();
    const document = parseBackup(text);
    expect(Object.values(document.entities).reduce((total, rows) => total + rows.length, 0)).toBe(BACKUP_LIMITS.records);
    await fresh();
    await commitImport((await previewImport(text)).token);
    const after = parseBackup(await exportBackup());
    expect(after.entities.interests).toHaveLength(BACKUP_LIMITS.records - count);
    expect(after.entities.importReceipts).toHaveLength(1);
    console.info(`50000 user records: ${new TextEncoder().encode(text).byteLength} bytes, ${Math.round(performance.now() - started)} ms export/parse/import/re-export`);
  }, 120_000);
  it('accepts exactly 20 MiB, rejects the next byte and counts UTF-8 bytes rather than JS characters', async () => {
    await addBook({ title: 'Boundary' }); const text = await exportBackup();
    const bytes = new TextEncoder().encode(text).byteLength;
    const max = text + ' '.repeat(BACKUP_LIMITS.bytes - bytes);
    const preview = await previewImport(max); cancelImport(preview.token);
    await expect(previewImport(max + ' ')).rejects.toThrow('20 MiB');
    const multibyte = JSON.stringify({ text: 'അ'.repeat(Math.ceil(BACKUP_LIMITS.bytes / 2)) });
    expect(multibyte.length).toBeLessThan(BACKUP_LIMITS.bytes);
    await expect(previewImport(multibyte)).rejects.toThrow('20 MiB');
    expect((await getSnapshot()).books).toHaveLength(1);
  }, 30_000);
});
