import type { BackupDocument } from '../domain/types';
import { DEFAULT_SETTINGS, newId, stamp } from './db';
import { BACKUP_LIMITS, parseBackup } from './backup-validation';
import { assert } from './validation';

/** No database writes: export and merge validate the identical portable representation. */
export function serializePortableBackup(libraryId: string, entities: BackupDocument['entities'], label = 'The library export') {
  const exportedAt = new Date().toISOString();
  const previous = entities.settings.find((row) => row.id === 'preferences');
  const preferences = { ...stamp({ value: { ...DEFAULT_SETTINGS, ...previous?.value, lastExportAt: exportedAt } }, previous), id: 'preferences' };
  const document: BackupDocument = {
    format: 'vaayana', formatVersion: 1, schemaVersion: 2,
    exportId: newId(), sourceLibraryId: libraryId, exportedAt,
    entities: { ...entities, settings: [preferences] },
  };
  const text = JSON.stringify(document, null, 2);
  assert(new TextEncoder().encode(text).byteLength <= BACKUP_LIMITS.bytes,
    `${label} would exceed the 20 MiB portable-backup limit. No changes were saved.`);
  parseBackup(text);
  return { text, preferences };
}
