import Dexie, { type Table, type Transaction } from 'dexie';
import type { EntityMap, EntityTable, Revision, Settings } from '../domain/types';

export const ENTITY_TABLES: EntityTable[] = [
  'works', 'editions', 'identifiers', 'holdings', 'metadataSnapshots', 'fieldOverrides',
  'readingCycles', 'statusEvents', 'sessions', 'goals', 'notes', 'personalRatings',
  'layerAssignments', 'tags', 'tagAssignments', 'tagRedirects', 'reviewLinks',
  'ratingSnapshots', 'interests', 'recommendationFeedback', 'settings', 'tombstones',
  'mergeLineage', 'importReceipts',
];
export const DEFAULT_SETTINGS: Settings = {
  onlineAccess: false, loadCovers: false, useLibraryInterests: false, interests: [],
  modelConsent: false, reducedMotion: false, view: 'shelf', onboardingComplete: false,
};
export const V1_SCHEMA = {
  works: 'id, title', editions: 'id, workId', identifiers: 'id, entityId, [scheme+value]',
  holdings: 'id, workId, editionId', metadataSnapshots: 'id, workId, editionId',
  fieldOverrides: 'id, workId, [editionId+field]', readingCycles: 'id, workId, status',
  statusEvents: 'id, workId, cycleId', sessions: 'id, workId, cycleId, occurredAt',
  goals: 'id', notes: 'id, workId', personalRatings: 'id, workId',
  layerAssignments: 'id, workId', tags: 'id, normalizedName', tagAssignments: 'id, workId, tagId',
  tagRedirects: 'id, fromTagId, toTagId', reviewLinks: 'id, workId', ratingSnapshots: 'id, workId',
  interests: 'id', recommendationFeedback: 'id, workKey', settings: 'id',
  candidateCache: 'id', embeddings: 'id', overrides: 'id', meta: 'key',
};
export interface LibraryMeta { key: string; libraryId: string; revision: number; }
export class LibraryDatabase extends Dexie {
  meta!: Table<LibraryMeta, string>;
  constructor(name = 'vaayana-library') {
    super(name);
    this.version(1).stores(V1_SCHEMA);
    this.version(2).stores({
      tagRedirects: 'id, fromTagId, toTagId',
      tombstones: 'id, [table+entityId]', mergeLineage: 'id, [sourceLibraryId+sourceEntityId]',
      importReceipts: 'id, [sourceLibraryId+exportId]',
    }).upgrade(async (tx: Transaction) => {
      // Upgrades are transactional. A failure is propagated; never delete/reset the database.
      await tx.table('tags').toCollection().modify((tag) => {
        tag.archived ??= false;
        tag.pinned ??= true;
        tag.aliases ??= [];
      });
    });
  }
  entity<K extends EntityTable>(name: K): Table<EntityMap[K], string> { return this.table(name); }
}
export const db = new LibraryDatabase();
export const newId = (): string => crypto.randomUUID();
export function stamp<T extends object>(value: T, previous?: Revision): T & Revision {
  const now = new Date().toISOString();
  return { ...value, id: previous?.id ?? newId(), revision: newId(),
    ancestors: previous ? [...previous.ancestors, previous.revision] : [],
    createdAt: previous?.createdAt ?? now, updatedAt: now };
}
export async function getMeta(database = db): Promise<LibraryMeta> {
  const existing = await database.meta.get('library');
  if (existing) return existing;
  const meta = { key: 'library', libraryId: newId(), revision: 0 };
  await database.meta.put(meta);
  return meta;
}
/** Run once during app bootstrap, outside any liveQuery/useLiveQuery callback. */
export async function initializeLibrary(database = db): Promise<void> {
  await database.open();
  await database.transaction('rw', database.meta, () => getMeta(database));
}
export async function mutate<T>(action: () => Promise<T>, database = db): Promise<T> {
  return database.transaction('rw', database.tables, async () => {
    const meta = await getMeta(database);
    const result = await action();
    await database.meta.put({ ...meta, revision: meta.revision + 1 });
    return result;
  });
}
export async function removeEntity<K extends EntityTable>(table: K, id: string): Promise<void> {
  const previous = await db.entity(table).get(id);
  if (!previous) return;
  const catalogFamilyId = table === 'works' && 'catalogFamilyId' in previous ? previous.catalogFamilyId : undefined;
  await db.entity('tombstones').put(stamp({ table, entityId: id, deletedRevision: previous.revision,
    ...(catalogFamilyId ? { catalogFamilyId } : {}) }));
  await db.entity(table).delete(id);
}
export async function readEntities(database = db): Promise<{ [K in EntityTable]: EntityMap[K][] }> {
  const pairs = await Promise.all(ENTITY_TABLES.map(async (name) => [name, await database.entity(name).toArray()] as const));
  return Object.fromEntries(pairs) as { [K in EntityTable]: EntityMap[K][] };
}
