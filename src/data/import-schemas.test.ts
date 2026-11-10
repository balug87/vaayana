import 'fake-indexeddb/auto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv';
import { beforeEach, expect, it } from 'vitest';
import { BACKUP_SCHEMA, CATALOG_SCHEMA } from './import-schemas';
import { db } from './db';
import { acceptTag, addBook, createTag, logSession, saveGoal, updateBook } from './library';
import { commitImport, exportBackup, previewImport } from './backup';
import { parseBackup } from './backup-validation';

const directory = join(process.cwd(), 'public', 'import-formats');
const read = (file: string) => JSON.parse(readFileSync(join(directory, file), 'utf8'));
beforeEach(async () => { db.close(); await db.delete(); await db.open(); });

it('publishes structural schemas matching the current validator fields, and validates public samples independently with Ajv', async () => {
  if (process.env.REGENERATE_IMPORT_EXAMPLES === '1') {
    const catalogPreview = await previewImport(JSON.stringify({
      notes: 'A fictional catalog used only for documentation.', total_unique_titles: 1,
      books: [{ title: 'The Example Observatory', author: null, source_images: [1], notes: 'Invented source note, not verified metadata.' }],
    }));
    await commitImport(catalogPreview.token);
    const tag = await createTag('Example practice');
    const book = await addBook({ title: 'A Practice Garden', authors: ['Example Writer'], formats: ['physical', 'digital'], pageCount: 120, status: 'reading', purpose: 'Try one practice', primaryLayer: 'fuel' });
    await acceptTag(book, tag);
    await updateBook(book, { notes: 'Fictional sample reading note.', personalRating: 4 });
    await logSession({ workId: book, pages: 5, minutes: 10, page: 5, occurredAt: '2026-11-10T12:00:00.000Z' });
    await saveGoal({ metric: 'pages', target: 50, startDate: '2026-11-01', endDate: '2026-11-30' });
    const backup = await exportBackup();
    writeFileSync(join(directory, 'catalog.schema.json'), JSON.stringify(CATALOG_SCHEMA, null, 2) + '\n');
    writeFileSync(join(directory, 'backup.schema.json'), JSON.stringify(BACKUP_SCHEMA, null, 2) + '\n');
    writeFileSync(join(directory, 'backup.example.json'), backup + '\n');
  }
  const catalogSchema = read('catalog.schema.json'), backupSchema = read('backup.schema.json');
  expect(catalogSchema).toEqual(CATALOG_SCHEMA);
  expect(backupSchema).toEqual(BACKUP_SCHEMA);
  const catalog = read('catalog.example.json'), backup = read('backup.example.json');
  const ajv = new Ajv({ strict: false, allErrors: true });
  const validateCatalog = ajv.compile(catalogSchema), validateBackup = ajv.compile(backupSchema);
  expect(validateCatalog(catalog), JSON.stringify(validateCatalog.errors)).toBe(true);
  expect(validateBackup(backup), JSON.stringify(validateBackup.errors)).toBe(true);
  expect(parseBackup(JSON.stringify(backup))).toMatchObject({ format: 'vaayana', formatVersion: 1, schemaVersion: 2 });
  expect((await previewImport(JSON.stringify(catalog))).format).toBe('book-catalog');
  expect((await previewImport(JSON.stringify(backup))).format).toBe('vaayana-backup');
});

it('independent schemas reject unknown fields, unsupported versions and structurally wrong author/source values', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const catalog = ajv.compile(CATALOG_SCHEMA), backup = ajv.compile(BACKUP_SCHEMA);
  expect(catalog({ books: [{ title: 'Invented', author: null, source_images: [1] }] })).toBe(true);
  expect(catalog({ books: [{ title: 'Invented', author: ['Wrong type'] }] })).toBe(false);
  expect(catalog({ books: [{ title: 'Invented', author: null, source_images: ['one'] }] })).toBe(false);
  expect(catalog({ books: [], unexpected: true })).toBe(false);
  const example = read('backup.example.json');
  expect(backup({ ...example, formatVersion: 2 })).toBe(false);
  expect(backup({ ...example, books: [] })).toBe(false);
  example.entities.works[0].unexpected = 'Rejected';
  expect(backup(example)).toBe(false);
});
