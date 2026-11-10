import type { BackupDocument, BookFormat, CatalogImportOptions, CatalogSource, EntityMap, EntityTable } from '../domain/types';
import { BACKUP_LIMITS, validateEntities } from './backup-validation';
import { ENTITY_TABLES, stamp } from './db';
import { assert, textValue } from './validation';

export const CATALOG_LIMITS = { books: 10_000, titleLength: 1_000, authorLength: 500, notesLength: BACKUP_LIMITS.stringLength, sourceImages: BACKUP_LIMITS.arrayLength } as const;
export const ACCEPTED_IMPORT_FORMATS = 'Supported formats: a Vaayana backup exported by this app, or a book catalog object with a books array (title, author, optional source_images and notes).';
interface CatalogRow { title: string; author: string | null; source_images?: number[]; notes?: string; }
interface CatalogDocument { books: CatalogRow[]; total_unique_titles?: number; notes?: string; }
export interface PreparedCatalogEntry { index: number; workId: string; editionId: string; title: string; author: string | null; rows: { table: EntityTable; row: EntityMap[EntityTable] }[]; }
export interface PreparedCatalog {
  document: BackupDocument;
  entries: PreparedCatalogEntry[];
  source: CatalogSource;
  defaults: { status: 'to-read' | 'wishlist'; formats: BookFormat[] };
  warnings: string[];
}
function record(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be a JSON object. ${ACCEPTED_IMPORT_FORMATS}`);
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  assert(Object.keys(value).every((key) => allowed.includes(key)), `${label} contains unsupported fields. Allowed fields: ${allowed.join(', ')}.`);
}
function count(value: unknown, label: string): void {
  assert(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000, `${label} must be a non-negative whole number.`);
}
export function parseCatalog(value: unknown): CatalogDocument {
  const root = record(value, 'Catalog');
  keys(root, ['books', 'total_unique_titles', 'notes'], 'Catalog root');
  assert(Array.isArray(root.books) && root.books.length <= CATALOG_LIMITS.books, `Catalog books must be an array of at most ${CATALOG_LIMITS.books} entries.`);
  if ('total_unique_titles' in root) count(root.total_unique_titles, 'Catalog total_unique_titles');
  if ('notes' in root) textValue(root.notes, 'catalog notes', CATALOG_LIMITS.notesLength);
  root.books.forEach((value, index) => {
    const label = `Catalog entry ${index + 1}`;
    const row = record(value, label);
    keys(row, ['title', 'author', 'source_images', 'notes'], label);
    textValue(row.title, `${label} title`, CATALOG_LIMITS.titleLength);
    assert(row.title.trim(), `${label} requires a non-empty title.`);
    assert(Object.hasOwn(row, 'author'), `${label} requires author: a string, or null when unknown.`);
    if (row.author !== null) textValue(row.author, `${label} author`, CATALOG_LIMITS.authorLength);
    if ('notes' in row) textValue(row.notes, `${label} notes`, CATALOG_LIMITS.notesLength);
    if ('source_images' in row) {
      assert(Array.isArray(row.source_images) && row.source_images.length <= CATALOG_LIMITS.sourceImages, `${label} source_images must be an array of at most ${CATALOG_LIMITS.sourceImages} image indices.`);
      row.source_images.forEach((value) => count(value, `${label} source_images item`));
    }
  });
  return root as unknown as CatalogDocument;
}
async function stableId(namespace: string, value: string): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${namespace}:${value}`)));
  // UUIDv8 identifies application-defined, content-derived identity. It is not an ISBN/work match.
  hash[6] = (hash[6] & 0x0f) | 0x80; hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = [...hash.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export async function prepareCatalog(value: unknown, options: CatalogImportOptions = {}): Promise<PreparedCatalog> {
  const input = parseCatalog(value);
  const status = options.status ?? 'to-read';
  assert(status === 'to-read' || status === 'wishlist', 'Catalog status must be To read or Wishlist; reading history is not inferred.');
  const formats = [...new Set(options.formats ?? [])];
  assert(formats.length <= 2 && formats.every((format) => format === 'physical' || format === 'digital'), 'Catalog holdings must be physical, digital, both, or unknown.');
  const canonicalRows = input.books.map((row) => ({ title: row.title, author: row.author,
    ...(row.source_images !== undefined ? { source_images: row.source_images } : {}), ...(row.notes !== undefined ? { notes: row.notes } : {}) }));
  const canonical = JSON.stringify({ books: canonicalRows, ...(input.total_unique_titles !== undefined ? { total_unique_titles: input.total_unique_titles } : {}), ...(input.notes !== undefined ? { notes: input.notes } : {}) });
  const sourceLibraryId = await stableId('vaayana-catalog-v1', canonical);
  const exportId = await stableId('vaayana-catalog-export-v1', canonical);
  const entities = Object.fromEntries(ENTITY_TABLES.map((table) => [table, []])) as unknown as BackupDocument['entities'];
  const entries: PreparedCatalogEntry[] = [];
  const occurrences = new Map<string, number>();
  let repeated = 0;
  for (const [index, row] of canonicalRows.entries()) {
    const identity = JSON.stringify(row);
    const occurrence = occurrences.get(identity) ?? 0; occurrences.set(identity, occurrence + 1);
    if (occurrence) repeated++;
    const stable = `${identity}:${occurrence}`;
    const [workId, editionId, entryId, catalogFamilyId] = await Promise.all([
      stableId('catalog-work-v1', stable), stableId('catalog-edition-v1', stable), stableId('catalog-entry-v1', stable),
      stableId('catalog-title-family-v1', row.title.normalize('NFKC').trim().toLocaleLowerCase()),
    ]);
    const authors = row.author !== null && row.author.trim() ? [row.author] : [];
    const work = { ...stamp({ title: row.title, authors, preferredEditionId: editionId, initialStatus: status, catalogFamilyId }), id: workId };
    const edition = { ...stamp({ workId, metadata: { title: row.title, authors }, catalogProvenance: [{
      catalogId: sourceLibraryId, entryId, originalTitle: row.title, originalAuthor: row.author, sourceImages: row.source_images ?? [],
      ...(row.notes !== undefined ? { notes: row.notes } : {}), unverified: true as const,
    }] }), id: editionId };
    const rows: PreparedCatalogEntry['rows'] = [{ table: 'works', row: work }, { table: 'editions', row: edition }];
    for (const format of formats) {
      const holding = { ...stamp({ workId, editionId, format }), id: await stableId(`catalog-holding-${format}-v1`, stable) };
      rows.push({ table: 'holdings', row: holding });
    }
    for (const { table, row: entity } of rows) (entities[table] as EntityMap[EntityTable][]).push(entity);
    entries.push({ index: index + 1, workId, editionId, title: row.title, author: row.author, rows });
  }
  const source: CatalogSource = {
    actualCount: input.books.length, unknownAuthorCount: input.books.filter((row) => row.author === null || !row.author.trim()).length,
    ...(input.total_unique_titles !== undefined ? { declaredCount: input.total_unique_titles } : {}),
    ...(input.notes !== undefined ? { notes: input.notes } : {}), unverified: true,
  };
  const warnings = ['Catalog entries and source notes are unverified. No metadata, reading history, tags, or Layers will be inferred or fetched.'];
  if (source.declaredCount !== undefined && source.declaredCount !== source.actualCount) warnings.push(`Declared count ${source.declaredCount} differs from ${source.actualCount} actual entries. All ${source.actualCount} entries will be considered; none are truncated.`);
  if (source.unknownAuthorCount) warnings.push(`${source.unknownAuthorCount} entries have unknown authors and will keep them unknown.`);
  if (repeated) warnings.push(`${repeated} repeated exact rows remain separate entries. Nothing is silently deduplicated.`);
  const document: BackupDocument = { format: 'vaayana', formatVersion: 1, schemaVersion: 2, exportId, sourceLibraryId, exportedAt: new Date().toISOString(), entities };
  validateEntities(entities);
  return { document, entries, source, defaults: { status, formats }, warnings };
}
