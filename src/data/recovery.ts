import { ENTITY_TABLES, newId } from './db';

/**
 * Read-only emergency extraction. Opens the current native database WITHOUT requesting
 * an upgrade, so a broken Dexie migration cannot block saving the original records.
 * This intentionally is a recovery file, not a validated, normally importable backup.
 */
export async function exportRecoveryBackup(databaseName = 'vaayana-library'): Promise<string> {
  const native = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onupgradeneeded = () => { request.transaction?.abort(); reject(new Error('No existing library database was found.')); };
    request.onerror = () => reject(request.error ?? new Error('Unable to open the existing database.'));
    request.onsuccess = () => resolve(request.result);
    request.onblocked = () => reject(new Error('Close other Vaayana tabs, then retry the recovery export.'));
  });
  try {
    const tables = ENTITY_TABLES.filter((name) => native.objectStoreNames.contains(name));
    const names = [...tables, ...(native.objectStoreNames.contains('meta') ? ['meta'] : [])];
    if (!names.length) throw new Error('No recoverable library stores were found.');
    const transaction = native.transaction(names, 'readonly');
    const records = await Promise.all(names.map((name) => new Promise<[string, unknown[]]>((resolve, reject) => {
      const request = transaction.objectStore(name).getAll();
      request.onsuccess = () => resolve([name, request.result]);
      request.onerror = () => reject(request.error);
    })));
    return JSON.stringify({
      format: 'vaayana-recovery', recoveryVersion: 1, schemaVersion: native.version / 10, rawIndexedDBVersion: native.version,
      exportId: newId(), exportedAt: new Date().toISOString(),
      warning: 'Unvalidated recovery records. Keep this sensitive file private. Repair it into a supported Vaayana backup before normal import.',
      stores: Object.fromEntries(records),
    }, null, 2);
  } finally { native.close(); }
}
