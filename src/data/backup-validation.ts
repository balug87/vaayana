import type { BackupDocument, EntityMap, EntityTable } from '../domain/types';
import { LAYERS } from '../domain/layers';
import { ENTITY_TABLES } from './db';
import { assert, METADATA_FIELDS, normalizeIsbn, positive, safeUrl, STATUSES, textValue, validDate } from './validation';

export const BACKUP_LIMITS = { bytes: 20 * 1024 * 1024, records: 50_000, provenanceRecords: 100_000, stringLength: 20_000, arrayLength: 10_000, depth: 16 } as const;
const PROVENANCE_TABLES: EntityTable[] = ['tombstones', 'mergeLineage', 'importReceipts'];
type Validator = (value: unknown) => void;
type Shape = Record<string, Validator>;
const str: Validator = (value) => textValue(value, 'text', BACKUP_LIMITS.stringLength);
const short: Validator = (value) => textValue(value, 'short text', 500);
const bool: Validator = (value) => assert(typeof value === 'boolean', 'Expected a boolean.');
const number: Validator = (value) => positive(value, 'number');
const integer: Validator = (value) => { number(value); assert(Number.isInteger(value), 'Expected a whole number.'); };
const id: Validator = (value) => assert(typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value), 'Invalid stable UUID.');
const date: Validator = (value) => assert(typeof value === 'string' && validDate(value), 'Invalid date.');
const url: Validator = (value) => { str(value); safeUrl(value as string); };
const choices = (...values: readonly unknown[]): Validator => (value) => assert(values.includes(value), `Invalid enum value: ${String(value).slice(0, 60)}.`);
const array = (validate: Validator, max = 500): Validator => (value) => {
  assert(Array.isArray(value) && value.length <= max, 'Invalid or oversized array.'); value.forEach(validate);
};
const object = (value: unknown): Record<string, unknown> => {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected an object.');
  return value as Record<string, unknown>;
};
function shape(value: unknown, required: Shape, optional: Shape = {}): void {
  const record = object(value);
  for (const key of Object.keys(record)) assert(Object.hasOwn(required, key) || Object.hasOwn(optional, key), `Unknown field ${key}.`);
  for (const [key, validate] of Object.entries(required)) { assert(Object.hasOwn(record, key), `Missing field ${key}.`); validate(record[key]); }
  for (const [key, validate] of Object.entries(optional)) if (Object.hasOwn(record, key)) validate(record[key]);
}
const metadataRequired = { title: str, authors: array(short) };
const metadataOptional = { subtitle: str, description: str, publisher: short, publishedDate: short, language: short, pageCount: (v: unknown) => { integer(v); assert((v as number) > 0, 'Invalid page count.'); }, coverId: integer, subjects: array(short) };
const metadata: Validator = (value) => shape(value, metadataRequired, metadataOptional);
const candidate: Validator = (value) => shape(value, {
  ...metadataRequired, workId: (v) => assert(typeof v === 'string' && /^\/works\/OL\d+W$/.test(v), 'Invalid provider work ID.'),
  isbn: array((v) => { short(v); normalizeIsbn(v as string); }), subjects: array(short), sourceUrl: url, fetchedAt: date,
}, {
  ...metadataOptional, editionId: (v) => assert(typeof v === 'string' && /^\/books\/OL\d+M$/.test(v), 'Invalid provider edition ID.'),
  firstPublishYear: integer, rating: (v) => shape(v, { source: choices('Open Library reader rating'), average: (n) => { number(n); assert((n as number) <= 5, 'Invalid rating.'); }, count: integer, fetchedAt: date }),
});
export function validateCandidate(value: unknown): void {
  candidate(Object.fromEntries(Object.entries(object(value)).filter(([, field]) => field !== undefined)));
}
const base = { id, revision: id, ancestors: array(id, BACKUP_LIMITS.arrayLength), createdAt: date, updatedAt: date };
const layer = choices(...LAYERS.map((value) => value.id));
const origin = choices('user', 'provider', 'rule', 'model');
const settings: Validator = (value) => shape(value, {
  onlineAccess: bool, loadCovers: bool, useLibraryInterests: bool, interests: array(short, 100), modelConsent: bool,
  reducedMotion: bool, view: choices('shelf', 'list'), onboardingComplete: bool,
}, { modelVersion: short, lastExportAt: date });
const catalogSource: Validator = (value) => shape(value, {
  actualCount: integer, unknownAuthorCount: integer, unverified: choices(true),
}, { declaredCount: integer, notes: str });
const catalogProvenance: Validator = (value) => shape(value, {
  catalogId: id, entryId: id, originalTitle: str, originalAuthor: (v) => { if (v !== null) short(v); },
  sourceImages: array(integer, BACKUP_LIMITS.arrayLength), unverified: choices(true),
}, { notes: str });
const definitions: Record<EntityTable, [Shape, Shape?]> = {
  works: [{ title: str, authors: array(short) }, { preferredEditionId: id, initialStatus: choices('to-read', 'wishlist'), catalogFamilyId: id }],
  editions: [{ workId: id, metadata }, { catalogProvenance: array(catalogProvenance, BACKUP_LIMITS.arrayLength) }],
  identifiers: [{ entityId: id, entityType: choices('work', 'edition'), scheme: choices('isbn', 'open-library-work', 'open-library-edition'), value: short }],
  holdings: [{ workId: id, editionId: id, format: choices('physical', 'digital') }, { sourceUrl: url }],
  metadataSnapshots: [{ workId: id, editionId: id, candidate, acceptedAt: date }],
  fieldOverrides: [{ workId: id, editionId: id, field: choices(...METADATA_FIELDS), value: (v) => {
    if (typeof v === 'string') str(v); else if (typeof v === 'number') number(v); else array(short)(v);
  } }],
  readingCycles: [{ workId: id, editionId: id, startedAt: date, status: choices(...STATUSES) }, { finishedAt: date }],
  statusEvents: [{ workId: id, cycleId: id, status: choices(...STATUSES), occurredAt: date }],
  sessions: [{ workId: id, editionId: id, cycleId: id, occurredAt: date, pages: number, minutes: number }, { page: number, percent: (v) => { number(v); assert((v as number) <= 100, 'Invalid percentage.'); } }],
  goals: [{ metric: choices('books', 'pages', 'minutes'), target: (v) => { number(v); assert((v as number) > 0, 'Invalid goal target.'); }, startDate: date, endDate: date }],
  notes: [{ workId: id, text: str }],
  personalRatings: [{ workId: id, value: (v) => { number(v); assert((v as number) <= 5, 'Invalid personal rating.'); } }],
  layerAssignments: [{ workId: id, secondary: array(layer, 6), purpose: str, origin, label: choices('user-selected', 'tentative', 'needs-review'), evidence: str, pinned: bool }, { primary: layer, version: short }],
  tags: [{ name: (v) => textValue(v, 'tag name', 100), normalizedName: short, kind: choices('topic', 'purpose', 'mood', 'context'), aliases: array(short), archived: bool, pinned: bool }],
  tagAssignments: [{ workId: id, tagId: id, origin, state: choices('suggested', 'accepted', 'rejected'), pinned: bool }, { sourceRef: url, version: short, confidence: (v) => { number(v); assert((v as number) <= 1, 'Invalid confidence.'); } }],
  tagRedirects: [{ fromTagId: id, toTagId: id }],
  reviewLinks: [{ workId: id, url, title: short, source: short, kind: choices('professional', 'reader'), verified: choices(true), verifiedAt: date }],
  ratingSnapshots: [{ workId: id, source: choices('open-library'), average: (v) => { number(v); assert((v as number) <= 5, 'Invalid source rating.'); }, count: integer, fetchedAt: date }],
  interests: [{ name: short }],
  recommendationFeedback: [{ workKey: short, action: choices('dismiss', 'less-like-this'), topics: array(short) }],
  settings: [{ value: settings }],
  tombstones: [{ table: choices(...ENTITY_TABLES.filter((name) => !['tombstones', 'mergeLineage', 'importReceipts'].includes(name))), entityId: (v) => { if (v !== 'preferences') id(v); }, deletedRevision: id }, { catalogFamilyId: id }],
  mergeLineage: [{ sourceLibraryId: id, sourceEntityId: (v) => { if (v !== 'preferences') id(v); }, localEntityId: (v) => { if (v !== 'preferences') id(v); }, sourceRevision: id }],
  importReceipts: [{ exportId: id, sourceLibraryId: id }, { catalog: catalogSource }],
};
function inspectTree(value: unknown, depth = 0, entityStore = false): void {
  assert(depth <= BACKUP_LIMITS.depth, 'Backup nesting exceeds the safe limit.');
  if (typeof value === 'string') { str(value); return; }
  if (Array.isArray(value)) {
    assert(value.length <= (entityStore ? BACKUP_LIMITS.provenanceRecords : BACKUP_LIMITS.arrayLength), 'Backup array exceeds the safe limit.');
    value.forEach((child) => inspectTree(child, depth + 1)); return;
  }
  if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
    assert(!['__proto__', 'prototype', 'constructor'].includes(key), 'Unsafe object key in backup.');
    inspectTree(child, depth + 1, depth === 1 && ENTITY_TABLES.includes(key as EntityTable));
  }
}
export function validateEntities(entities: BackupDocument['entities']): void {
  const entityObject = object(entities);
  assert(Object.keys(entityObject).length === ENTITY_TABLES.length, 'Backup entity stores do not match the supported schema.');
  let count = 0;
  let provenanceCount = 0;
  const globalIds = new Set<string>();
  for (const table of ENTITY_TABLES) {
    const rows = entityObject[table]; assert(Array.isArray(rows), `Missing ${table} store.`);
    if (PROVENANCE_TABLES.includes(table)) provenanceCount += rows.length;
    else count += rows.length;
    assert(count <= BACKUP_LIMITS.records && provenanceCount <= BACKUP_LIMITS.provenanceRecords, 'Backup contains too many records.');
    const ids = new Set<string>();
    for (const row of rows) {
      const record = object(row);
      const [required, optional] = definitions[table];
      shape(record, { ...base, ...(table === 'settings' ? { id: choices('preferences') } : {}), ...required }, optional);
      assert(!ids.has(record.id as string), `Duplicate ID in ${table}.`); ids.add(record.id as string);
      assert(!globalIds.has(record.id as string), 'An entity ID is reused across stores.'); globalIds.add(record.id as string);
      assert(!(record.ancestors as string[]).includes(record.revision as string), 'Revision cannot be its own ancestor.');
      if (table === 'fieldOverrides') {
        const field = record.field as string;
        const validator = ({ ...metadataRequired, ...metadataOptional } as Shape)[field];
        validator(record.value);
      }
      if (table === 'identifiers') {
        if (record.scheme === 'isbn') assert(normalizeIsbn(record.value as string) === record.value, 'ISBN aliases must be canonical ISBN-13.');
        else assert(new RegExp(record.scheme === 'open-library-work' ? '^/works/OL\\d+W$' : '^/books/OL\\d+M$').test(record.value as string), 'Invalid provider identifier.');
        assert(record.entityType === (record.scheme === 'open-library-work' ? 'work' : 'edition'), 'Identifier entity type is inconsistent.');
      }
      if (table === 'goals') assert((record.startDate as string) <= (record.endDate as string), 'Invalid goal period.');
      if (table === 'tags') assert(record.normalizedName === (record.name as string).normalize('NFKC').trim().toLocaleLowerCase(), 'Tag normalized name is inconsistent.');
    }
  }
  const maps = Object.fromEntries(ENTITY_TABLES.map((table) => [table, new Map(entities[table].map((row) => [row.id, row]))])) as { [K in EntityTable]: Map<string, EntityMap[K]> };
  const unique = (table: EntityTable, key: (row: Record<string, unknown>) => string) => {
    const keys = new Set<string>();
    for (const row of entities[table]) { const value = key(row as unknown as Record<string, unknown>); assert(!keys.has(value), `Duplicate identity in ${table}.`); keys.add(value); }
  };
  unique('identifiers', (r) => `${r.scheme}:${r.value}`);
  unique('fieldOverrides', (r) => `${r.editionId}:${r.field}`);
  unique('metadataSnapshots', (r) => String(r.editionId));
  unique('layerAssignments', (r) => String(r.workId));
  unique('personalRatings', (r) => String(r.workId));
  unique('ratingSnapshots', (r) => String(r.workId));
  unique('tags', (r) => String(r.normalizedName));
  unique('tagRedirects', (r) => String(r.fromTagId));
  const requireRelation = (table: EntityTable, id: string) => assert(maps[table].has(id), `Broken ${table} relationship.`);
  for (const table of ENTITY_TABLES) for (const row of entities[table]) {
    const record = row as unknown as Record<string, unknown>;
    if ('workId' in record) requireRelation('works', record.workId as string);
    if ('editionId' in record) {
      requireRelation('editions', record.editionId as string);
      if ('workId' in record) assert(maps.editions.get(record.editionId as string)?.workId === record.workId, 'Edition belongs to a different work.');
    }
    if ('cycleId' in record) {
      requireRelation('readingCycles', record.cycleId as string);
      assert(maps.readingCycles.get(record.cycleId as string)?.workId === record.workId, 'Cycle belongs to a different work.');
    }
    if (table === 'identifiers') requireRelation(record.entityType === 'work' ? 'works' : 'editions', record.entityId as string);
    if (table === 'tagAssignments') requireRelation('tags', record.tagId as string);
    if (table === 'tagRedirects') {
      requireRelation('tags', record.fromTagId as string); requireRelation('tags', record.toTagId as string);
      assert(maps.tags.get(record.fromTagId as string)?.archived, 'Merged tag must stay archived.');
      const seen = new Set<string>([record.fromTagId as string]);
      let next: string | undefined = record.toTagId as string;
      while (next) {
        assert(!seen.has(next), 'Tag redirect cycle.'); seen.add(next);
        next = entities.tagRedirects.find((redirect) => redirect.fromTagId === next)?.toTagId;
      }
    }
  }
  const worksWithEditions = new Set(entities.editions.map((edition) => edition.workId));
  for (const work of entities.works) assert(worksWithEditions.has(work.id), 'A work must retain at least one edition.');
  for (const work of entities.works) if (work.preferredEditionId) assert(maps.editions.get(work.preferredEditionId)?.workId === work.id, 'Preferred edition belongs to a different work.');
}
export function parseImportJson(text: string): unknown {
  assert(typeof text === 'string' && new TextEncoder().encode(text).byteLength <= BACKUP_LIMITS.bytes, 'Import file exceeds the 20 MiB file limit.');
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error('Invalid JSON. Choose a Vaayana backup or a book catalog JSON object containing a books array.'); }
  inspectTree(parsed);
  return parsed;
}
export function parseBackup(text: string): BackupDocument {
  const parsed = parseImportJson(text);
  shape(parsed, { format: choices('vaayana'), formatVersion: choices(1), schemaVersion: choices(1, 2), exportId: id, sourceLibraryId: id, exportedAt: date, entities: (value) => { object(value); } });
  const document = parsed as BackupDocument;
  // Version 1 predates deletion lineage. It remains importable without resetting any database.
  if (document.schemaVersion === 1) {
    document.entities.tombstones ??= [];
    document.entities.mergeLineage ??= [];
    document.entities.importReceipts ??= [];
    document.schemaVersion = 2;
  }
  validateEntities(document.entities);
  return document;
}
