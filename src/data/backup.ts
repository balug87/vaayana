import type { BackupDocument, CatalogImportOptions, EntityMap, EntityTable, ImportConflict, ImportDecisions, ImportPreview, Revision } from '../domain/types';
import { db, ENTITY_TABLES, getMeta, mutate, newId, readEntities, stamp } from './db';
import { BACKUP_LIMITS, parseBackup, parseImportJson } from './backup-validation';
import { assert } from './validation';
import { ACCEPTED_IMPORT_FORMATS, prepareCatalog, type PreparedCatalog } from './catalog';
import { serializePortableBackup } from './portable-backup';
export { BACKUP_LIMITS } from './backup-validation';
export { CATALOG_LIMITS, ACCEPTED_IMPORT_FORMATS } from './catalog';

type Row = EntityMap[EntityTable];
type Put = { table: EntityTable; row: Row; conflictId?: string; restoreAncestors?: string[]; pairDecision?: { workId: string; tagId: string } };
type Deletion = { table: EntityTable; id: string; conflictId?: string; };
interface Staged {
  document: BackupDocument;
  preview: ImportPreview;
  puts: Put[];
  deletions: Deletion[];
  mappings: Map<string, string>;
  expiresAt: number;
}
const previews = new Map<string, Staged>();
const key = (table: EntityTable, id: string) => `${table}:${id}`;
const own = (row: Row) => row as unknown as Record<string, unknown>;
const hasRevision = (record: Revision, revision: string) => record.revision === revision || record.ancestors.includes(revision);

export async function exportBackup(): Promise<string> {
  return db.transaction('rw', db.tables, async () => {
    const meta = await getMeta();
    const { text, preferences } = serializePortableBackup(meta.libraryId, await readEntities());
    // Backup bookkeeping is not a library-content edit and must not stale a preview.
    await db.entity('settings').put(preferences);
    return text;
  });
}

function identityMappings(document: BackupDocument, local: BackupDocument['entities']): Map<string, string> {
  const mapping = new Map<string, string>();
  for (const row of local.mergeLineage) if (row.sourceLibraryId === document.sourceLibraryId) mapping.set(row.sourceEntityId, row.localEntityId);
  const map = (id: string) => mapping.get(id) ?? id;
  const localIdentifiers = new Map(local.identifiers.map((identifier) => [`${identifier.scheme}:${identifier.value}`, identifier]));
  const incomingEditions = new Map(document.entities.editions.map((edition) => [edition.id, edition]));
  const localEditions = new Map(local.editions.map((edition) => [edition.id, edition]));
  const workAliases = (identifiers: EntityMap['identifiers'][]) => {
    const aliases = new Map<string, string[]>();
    for (const row of identifiers) if (row.scheme === 'open-library-work') aliases.set(row.entityId, [...(aliases.get(row.entityId) ?? []), row.value]);
    return aliases;
  };
  const incomingWorkAliases = workAliases(document.entities.identifiers), localWorkAliases = workAliases(local.identifiers);
  const set = (source: string, target: string) => {
    assert(!mapping.has(source) || mapping.get(source) === target, 'Ambiguous import identifiers. No changes were made.');
    mapping.set(source, target);
  };
  // Authoritative aliases, never title/author resemblance, reconcile stable identities.
  for (const identifier of document.entities.identifiers.filter((row) => row.entityType === 'work')) {
    const known = localIdentifiers.get(`${identifier.scheme}:${identifier.value}`);
    if (known) { set(identifier.entityId, known.entityId); set(identifier.id, known.id); }
  }
  for (const identifier of document.entities.identifiers.filter((row) => row.entityType === 'edition')) {
    const known = localIdentifiers.get(`${identifier.scheme}:${identifier.value}`);
    if (!known) continue;
    const incomingEdition = incomingEditions.get(identifier.entityId);
    const localEdition = localEditions.get(known.entityId);
    assert(incomingEdition && localEdition, 'Import identifier relationship is broken.');
    const incomingAliases = incomingWorkAliases.get(incomingEdition.workId) ?? [], localAliases = localWorkAliases.get(localEdition.workId) ?? [];
    assert(!incomingAliases.length || !localAliases.length || incomingAliases.some((value) => localAliases.includes(value)), 'ISBN matches an edition with conflicting provider work IDs. Review the file before import; nothing was merged.');
    set(incomingEdition.workId, localEdition.workId);
    set(identifier.entityId, known.entityId); set(identifier.id, known.id);
  }
  const redirects = new Map(local.tagRedirects.map((row) => [row.fromTagId, row.toTagId]));
  const resolvedTags = new Map<string, string>();
  const resolveTag = (id: string): string => {
    if (resolvedTags.has(id)) return resolvedTags.get(id)!;
    const visited = new Set<string>(); let current = id;
    while (redirects.has(current)) { assert(!visited.has(current), 'Local tag redirect cycle.'); visited.add(current); current = redirects.get(current)!; }
    resolvedTags.set(id, current); return current;
  };
  const tagAliases = new Map<string, Set<string>>();
  const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
  for (const tag of local.tags) for (const name of [tag.normalizedName, ...tag.aliases.map(normalize)]) {
    const targets = tagAliases.get(name) ?? new Set<string>(); targets.add(resolveTag(tag.id)); tagAliases.set(name, targets);
  }
  const localTagIds = new Set(local.tags.map((tag) => tag.id));
  for (const [source, target] of mapping) if (localTagIds.has(target)) mapping.set(source, resolveTag(target));
  for (const tag of document.entities.tags) {
    const matches = new Set([tag.normalizedName, ...tag.aliases.map(normalize)].flatMap((name) => [...(tagAliases.get(name) ?? [])]));
    assert(matches.size <= 1, 'Ambiguous tag aliases require review before import.');
    if (matches.size) set(tag.id, [...matches][0]);
  }
  for (const table of ['metadataSnapshots', 'fieldOverrides', 'layerAssignments', 'personalRatings', 'ratingSnapshots', 'tagRedirects'] as const) {
    const naturalKey = (record: Record<string, unknown>, imported: boolean) => {
      const mapped = (field: string) => imported ? map(record[field] as string) : record[field];
      if (table === 'fieldOverrides') return `${mapped('editionId')}:${record.field}`;
      if (table === 'metadataSnapshots') return String(mapped('editionId'));
      if (table === 'tagRedirects') return String(mapped('fromTagId'));
      return String(mapped('workId'));
    };
    const existing = new Map(local[table].map((row) => [naturalKey(own(row), false), row]));
    for (const incoming of document.entities[table]) {
      const known = existing.get(naturalKey(own(incoming), true));
      if (known) set(incoming.id, known.id);
    }
  }
  return mapping;
}
function remapRow(row: Row, table: EntityTable, mapping: Map<string, string>): Row {
  const copy = structuredClone(row); const record = own(copy);
  record.id = mapping.get(row.id) ?? row.id;
  const fields = ['workId', 'editionId', 'preferredEditionId', 'cycleId', 'tagId', 'fromTagId', 'toTagId', 'entityId'];
  for (const field of fields) if (typeof record[field] === 'string') record[field] = mapping.get(record[field] as string) ?? record[field];
  if (table === 'mergeLineage') record.localEntityId = mapping.get(record.localEntityId as string) ?? record.localEntityId;
  return copy;
}
async function stage(document: BackupDocument): Promise<Staged> {
  return db.transaction('rw', db.tables, async () => {
    const meta = await getMeta(); const local = await readEntities();
    const alreadyImported = local.importReceipts.some((receipt) => receipt.exportId === document.exportId && receipt.sourceLibraryId === document.sourceLibraryId);
    const preview: ImportPreview = { format: 'vaayana-backup', warnings: [], token: newId(), exportId: document.exportId, sourceLibraryId: document.sourceLibraryId,
      counts: { added: 0, updated: 0, deleted: 0, unchanged: 0 }, conflicts: [], alreadyImported, libraryRevision: meta.revision };
    const result: Staged = { document, preview, puts: [], deletions: [], mappings: identityMappings(document, local), expiresAt: Date.now() + 30 * 60_000 };
    if (alreadyImported) { preview.counts.unchanged = ENTITY_TABLES.reduce((sum, table) => sum + document.entities[table].length, 0); return result; }
    const localMaps = Object.fromEntries(ENTITY_TABLES.map((table) => [table, new Map<string, Row>(local[table].map((row) => [row.id, row]))])) as Record<EntityTable, Map<string, Row>>;
    const deleted = new Map<string, EntityMap['tombstones'][]>();
    const tagPairs = new Map<string, EntityMap['tagAssignments'][]>();
    for (const assignment of local.tagAssignments) {
      const pair = `${assignment.workId}:${assignment.tagId}`;
      tagPairs.set(pair, [...(tagPairs.get(pair) ?? []), assignment]);
    }
    const incomingRedirectedTags = new Set(document.entities.tagRedirects.map((redirect) => redirect.fromTagId));
    for (const tombstone of local.tombstones) {
      const identity = key(tombstone.table, tombstone.entityId);
      deleted.set(identity, [...(deleted.get(identity) ?? []), tombstone]);
    }
    const conflict = (table: EntityTable, row: Row, kind: ImportConflict['kind'], description: string) => {
      const id = key(table, row.id);
      preview.conflicts.push({ id, table, entityId: row.id, kind, description, defaultDecision: 'keep-local' }); return id;
    };
    for (const table of ENTITY_TABLES) for (const original of document.entities[table]) {
      if (table === 'importReceipts' || table === 'mergeLineage') {
        const row = remapRow(original, table, result.mappings);
        if (!localMaps[table].has(row.id)) result.puts.push({ table, row });
        continue;
      }
      const row = remapRow(original, table, result.mappings);
      const existing = localMaps[table].get(row.id);
      if (table === 'tagRedirects' && own(row).fromTagId === own(row).toTagId) { preview.counts.unchanged++; continue; }
      if (table === 'tags' && incomingRedirectedTags.has(original.id) && original.id !== row.id && existing) { preview.counts.unchanged++; continue; }
      if (existing?.revision === row.revision) { preview.counts.unchanged++; continue; }
      if (table === 'tombstones') {
        if (!existing) result.puts.push({ table, row });
        const tombstone = row as EntityMap['tombstones'];
        const live = localMaps[tombstone.table].get(tombstone.entityId);
        if (live && !hasRevision(live, tombstone.revision)) {
          const conflictId = conflict(tombstone.table, live, 'deleted', 'The backup deleted this record; keep your current local record or use the imported deletion.');
          result.deletions.push({ table: tombstone.table, id: live.id, conflictId });
        }
        continue;
      }
      const tombstones = deleted.get(key(table, row.id)) ?? [];
      if (tombstones.some((tombstone) => !hasRevision(row, tombstone.revision))) {
        const conflictId = conflict(table, row, 'deleted', 'This record was deleted locally. Keep it deleted, or explicitly restore the imported record.');
        result.puts.push({ table, row, conflictId }); continue;
      }
      if (table === 'tagAssignments') {
        const assignment = row as EntityMap['tagAssignments'];
        const pair = tagPairs.get(`${assignment.workId}:${assignment.tagId}`) ?? [];
        const pinned = pair.filter((local) => local.pinned && local.state !== 'suggested');
        const localState = pinned.some((local) => local.state === 'rejected') ? 'rejected' : pinned.some((local) => local.state === 'accepted') ? 'accepted' : undefined;
        if (localState && assignment.state === 'suggested') { preview.counts.unchanged++; continue; }
        if (localState && assignment.state !== localState) {
          const conflictId = conflict(table, row, localState === 'rejected' ? 'archived' : 'changed', 'This book/tag pair has a pinned local decision. Keep it, or explicitly restore the imported choice for all provenance records.');
          result.puts.push({ table, row, conflictId, pairDecision: { workId: assignment.workId, tagId: assignment.tagId } }); continue;
        }
      }
      if (!existing) {
        result.puts.push({ table, row }); preview.counts.added++; continue;
      }
      const incomingValue = own(row), localValue = own(existing);
      const archivedConflict = table === 'tags' && localValue.archived === true && incomingValue.archived === false;
      const rejectedConflict = table === 'tagAssignments' && localValue.state === 'rejected' && incomingValue.state !== 'rejected';
      if (!archivedConflict && !rejectedConflict && hasRevision(existing, row.revision)) { preview.counts.unchanged++; continue; }
      if (archivedConflict || rejectedConflict || !hasRevision(row, existing.revision)) {
        const kind = archivedConflict || rejectedConflict ? 'archived' : original.id !== row.id ? 'identity' : 'changed';
        const description = archivedConflict || rejectedConflict ? 'Your local archive/rejection is preserved unless you explicitly restore the imported choice.' :
          kind === 'identity' ? 'An authoritative identifier matches an existing record. Keep local fields or explicitly accept the imported fields.' :
            'Both versions have changes or unknown ancestry. Keep your local version or explicitly accept the imported version.';
        result.puts.push({ table, row, conflictId: conflict(table, row, kind, description) });
      } else { result.puts.push({ table, row }); preview.counts.updated++; }
    }
    preview.counts.deleted = result.deletions.filter((operation) => !operation.conflictId).length;
    if (new TextEncoder().encode(JSON.stringify(local) + JSON.stringify(document.entities)).byteLength > BACKUP_LIMITS.bytes) {
      preview.warnings.push('The combined data may exceed the 20 MiB merged-backup limit. The final chosen merge is checked before any changes are saved.');
    }
    return result;
  });
}
async function stageCatalog(catalog: PreparedCatalog): Promise<Staged> {
  return db.transaction('r', db.tables, async () => {
    const meta = await db.meta.get('library'); const local = await readEntities();
    const { document } = catalog;
    const alreadyImported = local.importReceipts.some((receipt) => receipt.exportId === document.exportId && receipt.sourceLibraryId === document.sourceLibraryId);
    const preview: ImportPreview = {
      format: 'book-catalog', token: newId(), sourceLibraryId: document.sourceLibraryId, exportId: document.exportId,
      counts: { added: 0, updated: 0, unchanged: 0, deleted: 0 }, conflicts: [], warnings: catalog.warnings,
      source: catalog.source, defaults: catalog.defaults, alreadyImported, libraryRevision: meta?.revision ?? 0,
    };
    const result: Staged = { document, preview, puts: [], deletions: [], mappings: new Map(), expiresAt: Date.now() + 30 * 60_000 };
    if (alreadyImported) { preview.counts.unchanged = catalog.source.actualCount; return result; }
    const works = new Map(local.works.map((row) => [row.id, row]));
    const editions = new Map(local.editions.map((row) => [row.id, row]));
    const localEditions = new Map<string, EntityMap['editions']>();
    for (const edition of local.editions) if (!localEditions.has(edition.workId)) localEditions.set(edition.workId, edition);
    const provider = new Map(local.metadataSnapshots.map((row) => [row.editionId, row.candidate]));
    const overrides = new Map(local.fieldOverrides.map((row) => [`${row.editionId}:${row.field}`, row.value]));
    const normalize = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
    const titles = new Map<string, { workId: string; authors: string[] }[]>();
    for (const work of local.works) {
      const edition = editions.get(work.preferredEditionId ?? '') ?? localEditions.get(work.id);
      const title = edition ? overrides.get(`${edition.id}:title`) ?? provider.get(edition.id)?.title ?? edition.metadata.title : work.title;
      const authors = edition ? overrides.get(`${edition.id}:authors`) ?? provider.get(edition.id)?.authors ?? edition.metadata.authors : work.authors;
      const normalizedTitle = normalize(String(title));
      titles.set(normalizedTitle, [...(titles.get(normalizedTitle) ?? []), { workId: work.id, authors: (authors as string[]).map(normalize) }]);
    }
    const tombstoned = new Set(local.tombstones.map((row) => key(row.table, row.entityId)));
    const deletedFamilies = new Map<string, string[]>();
    for (const tombstone of local.tombstones) if (tombstone.catalogFamilyId) deletedFamilies.set(tombstone.catalogFamilyId, [
      ...(deletedFamilies.get(tombstone.catalogFamilyId) ?? []), tombstone.revision,
    ]);
    for (const entry of catalog.entries) {
      const existing = works.get(entry.workId);
      if (existing) {
        // A repeated/overlapping source can add provenance, never overwrite edits or reading state.
        const edition = editions.get(entry.editionId);
        const incoming = entry.rows.find((row) => row.table === 'editions')!.row as EntityMap['editions'];
        const additions = incoming.catalogProvenance!.filter((row) => !edition?.catalogProvenance?.some((known) => known.catalogId === row.catalogId && known.entryId === row.entryId));
        if (edition && additions.length) {
          result.puts.push({ table: 'editions', row: stamp({ ...edition, catalogProvenance: [...(edition.catalogProvenance ?? []), ...additions] }, edition) });
          preview.counts.updated++;
        } else preview.counts.unchanged++;
        continue;
      }
      const incomingWork = entry.rows.find((row) => row.table === 'works')!.row as EntityMap['works'];
      const familyDeletions = deletedFamilies.get(incomingWork.catalogFamilyId ?? '') ?? [];
      const wasDeleted = familyDeletions.length > 0 || entry.rows.some(({ table, row }) => tombstoned.has(key(table, row.id)));
      // Joined/multiple/unknown author strings are not authoritative edition identity.
      // Conservatively ask about any same-title ambiguity, never merge it automatically.
      const similar = (titles.get(normalize(entry.title)) ?? []).length > 0;
      let conflictId: string | undefined;
      if (wasDeleted || similar) {
        conflictId = key('works', entry.workId);
        preview.conflicts.push({
          id: conflictId, table: 'works', entityId: entry.workId, kind: wasDeleted ? 'deleted' : 'identity',
          description: wasDeleted ? 'This catalog entry was deleted locally. Keep it deleted, or explicitly restore it.' :
            'This catalog entry resembles a saved title. Keep local to skip it, or use import to add a separate book. Existing books will not be merged or changed.',
          defaultDecision: 'keep-local', catalogEntryIndex: entry.index,
        });
      } else preview.counts.added++;
      for (const { table, row } of entry.rows) result.puts.push({ table, row,
        ...(conflictId ? { conflictId } : {}), ...(familyDeletions.length ? { restoreAncestors: familyDeletions } : {}) });
    }
    // With default keep-local decisions, the additive result is determinable at preview.
    const proposed = Object.fromEntries(ENTITY_TABLES.map((table) => [table, new Map<string, Row>(local[table].map((row) => [row.id, row]))])) as Record<EntityTable, Map<string, Row>>;
    for (const operation of result.puts) if (!operation.conflictId) proposed[operation.table].set(operation.row.id, operation.row);
    const receipt = stamp({ exportId: document.exportId, sourceLibraryId: document.sourceLibraryId, catalog: catalog.source });
    proposed.importReceipts.set(receipt.id, receipt);
    const entities = Object.fromEntries(ENTITY_TABLES.map((table) => [table, [...proposed[table].values()]])) as BackupDocument['entities'];
    serializePortableBackup(meta?.libraryId ?? newId(), entities, 'The merged catalog');
    return result;
  });
}
export async function previewImport(text: string, options: CatalogImportOptions = {}): Promise<ImportPreview> {
  const parsed = parseImportJson(text);
  assert(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed), ACCEPTED_IMPORT_FORMATS);
  const root = parsed as Record<string, unknown>;
  let staged: Staged;
  if (root.format === 'vaayana') staged = await stage(parseBackup(text));
  else if (!Object.hasOwn(root, 'format') && !Object.hasOwn(root, 'entities') && Object.hasOwn(root, 'books')) staged = await stageCatalog(await prepareCatalog(parsed, options));
  else throw new Error(ACCEPTED_IMPORT_FORMATS);
  for (const [token, value] of previews) if (value.expiresAt < Date.now()) previews.delete(token);
  assert(previews.size < 4, 'Finish or cancel another import preview first (maximum four).');
  previews.set(staged.preview.token, staged);
  return structuredClone(staged.preview);
}
export function cancelImport(token: string): void { previews.delete(token); }
export class StaleImportPreviewError extends Error {
  constructor() { super('Your library changed after this preview. Preview the file again before importing.'); this.name = 'StaleImportPreviewError'; }
}
export async function commitImport(token: string, decisions: ImportDecisions = {}): Promise<{ added: number; updated: number; deleted: number }> {
  const staged = previews.get(token);
  assert(staged && staged.expiresAt >= Date.now(), 'This import preview expired or was cancelled. Preview the backup again.');
  for (const [id, decision] of Object.entries(decisions)) {
    assert(staged.preview.conflicts.some((conflict) => conflict.id === id) && ['keep-local', 'use-import'].includes(decision), 'Unknown import conflict decision.');
  }
  const accepted = (conflictId?: string) => !conflictId || decisions[conflictId] === 'use-import';
  const counts = await mutate(async () => {
    const meta = await getMeta();
    if (meta.revision !== staged.preview.libraryRevision) throw new StaleImportPreviewError();
    const changed = { added: 0, updated: 0, deleted: 0 };
    if (staged.preview.alreadyImported) return changed;
    const combined = await readEntities();
    const initialWorks = new Set(combined.works.map((row) => row.id));
    const initialEditions = new Set(combined.editions.map((row) => row.id));
    const merged = Object.fromEntries(ENTITY_TABLES.map((table) => [table, new Map<string, Row>(combined[table].map((row) => [row.id, row]))])) as Record<EntityTable, Map<string, Row>>;
    const assignmentPairs = new Map<string, EntityMap['tagAssignments'][]>();
    const additionalAssignments = new Map<string, Row>();
    for (const assignment of combined.tagAssignments) {
      const pair = `${assignment.workId}:${assignment.tagId}`;
      assignmentPairs.set(pair, [...(assignmentPairs.get(pair) ?? []), assignment]);
    }
    const tombstoneIndex = new Map<string, EntityMap['tombstones'][]>();
    for (const tombstone of [...combined.tombstones, ...staged.puts.filter((operation) => operation.table === 'tombstones').map((operation) => operation.row as EntityMap['tombstones'])]) {
      const identity = key(tombstone.table, tombstone.entityId);
      tombstoneIndex.set(identity, [...(tombstoneIndex.get(identity) ?? []), tombstone]);
    }
    for (const operation of staged.deletions) if (accepted(operation.conflictId)) {
      if (merged[operation.table].delete(operation.id)) changed.deleted++;
    }
    for (const operation of staged.puts) if (accepted(operation.conflictId)) {
      let row = operation.row;
      const rows = merged[operation.table];
      const current = rows.get(row.id);
      if (operation.table === 'settings' && current) {
        const incoming = row as EntityMap['settings'];
        const local = current as EntityMap['settings'];
        const lastExportAt = [incoming.value.lastExportAt, local.value.lastExportAt].filter((date): date is string => Boolean(date)).sort().at(-1);
        row = { ...incoming, value: { ...incoming.value, ...(lastExportAt ? { lastExportAt } : {}) } };
      }
      const tombstones = tombstoneIndex.get(key(operation.table, row.id)) ?? [];
      if (operation.conflictId) {
        row = stamp({ ...row }, current ?? row);
        row.ancestors = [...new Set([...row.ancestors, operation.row.revision, ...(current ? [current.revision] : []),
          ...tombstones.map((record) => record.revision), ...(operation.restoreAncestors ?? [])])];
      }
      if (operation.pairDecision) {
        const state = (row as EntityMap['tagAssignments']).state;
        row = { ...row, pinned: true } as EntityMap['tagAssignments'];
        const pair = `${operation.pairDecision.workId}:${operation.pairDecision.tagId}`;
        for (const assignment of assignmentPairs.get(pair) ?? []) if (assignment.id !== row.id && assignment.state !== state) {
          const updated = stamp({ ...assignment, state, pinned: true }, assignment);
          if (!additionalAssignments.has(updated.id)) changed.updated++;
          merged.tagAssignments.set(updated.id, updated); additionalAssignments.set(updated.id, updated);
        }
      }
      rows.set(row.id, row);
      if (current) changed.updated++; else changed.added++;
    }
    for (const table of ENTITY_TABLES) (combined[table] as Row[]) = [...merged[table].values()];
    const lineagePuts: EntityMap['mergeLineage'][] = [];
    const lineageBySource = new Map(combined.mergeLineage.map((row) => [`${row.sourceLibraryId}:${row.sourceEntityId}`, row]));
    for (const table of ENTITY_TABLES.filter((name) => !['mergeLineage', 'importReceipts'].includes(name))) {
      for (const row of staged.document.entities[table]) {
        if (!staged.mappings.has(row.id) || staged.mappings.get(row.id) === row.id) continue;
        const previous = lineageBySource.get(`${staged.document.sourceLibraryId}:${row.id}`);
        const lineage = stamp({
          sourceLibraryId: staged.document.sourceLibraryId, sourceEntityId: row.id,
          localEntityId: staged.mappings.get(row.id) ?? row.id, sourceRevision: row.revision,
        }, previous);
        lineagePuts.push(lineage); merged.mergeLineage.set(lineage.id, lineage);
      }
    }
    combined.mergeLineage = [...merged.mergeLineage.values()] as EntityMap['mergeLineage'][];
    const receipt = stamp({ exportId: staged.document.exportId, sourceLibraryId: staged.document.sourceLibraryId,
      ...(staged.preview.format === 'book-catalog' ? { catalog: staged.preview.source } : {}) });
    combined.importReceipts = [...combined.importReceipts, receipt];
    // Both formats share export's exact serializer/parser, including receipts,
    // mappings, tombstones and the next successful-export bookkeeping overhead.
    serializePortableBackup(meta.libraryId, combined, staged.preview.format === 'book-catalog' ? 'The merged catalog' : 'The merged library');
    for (const operation of staged.deletions) if (accepted(operation.conflictId)) await db.entity(operation.table).delete(operation.id);
    for (const table of ENTITY_TABLES) {
      const rows = staged.puts.filter((operation) => operation.table === table && accepted(operation.conflictId)).map((operation) => {
        const row = merged[table].get(operation.row.id); assert(row, 'Missing staged import row.'); return row;
      });
      const finalRows = new Map(rows.map((row) => [row.id, row]));
      if (table === 'tagAssignments') for (const [id, row] of additionalAssignments) finalRows.set(id, row);
      if (finalRows.size) await db.entity(table).bulkPut([...finalRows.values()] as never[]);
    }
    if (lineagePuts.length) await db.entity('mergeLineage').bulkPut(lineagePuts);
    await db.entity('importReceipts').put(receipt);
    if (staged.preview.format === 'book-catalog') {
      changed.added = staged.puts.filter((operation) => operation.table === 'works' && !initialWorks.has(operation.row.id) && accepted(operation.conflictId)).length;
      changed.updated = staged.puts.filter((operation) => operation.table === 'editions' && initialEditions.has(operation.row.id) && accepted(operation.conflictId)).length;
      changed.deleted = 0;
    }
    return changed;
  });
  previews.delete(token);
  return counts;
}
