import type {
  AddBookInput, Book, EntityMap, Goal, ID, LayerAssignment, LibrarySnapshot,
  LogSessionInput, MetadataCandidate, MetadataDiff, MetadataFields, ReadingStatus,
  ReviewLink, Settings, TagKind, UpdateBookInput,
} from '../domain/types';
import { LAYERS } from '../domain/layers';
import { db, DEFAULT_SETTINGS, getMeta, mutate, readEntities, removeEntity, stamp } from './db';
import { assert, METADATA_FIELDS, normalizeIsbn, positive, safeUrl, STATUSES, textValue, validDate, validateMetadata } from './validation';
import { validateCandidate } from './backup-validation';
export { normalizeIsbn } from './validation';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const providerValuePresent = (value: unknown) => value !== undefined && value !== null &&
  !(typeof value === 'string' && !value.trim()) && !(Array.isArray(value) && value.length === 0);
const normalized = (name: string) => name.normalize('NFKC').trim().toLocaleLowerCase();
const newest = <T extends { updatedAt: string }>(items: T[]): T | undefined => items.reverse().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];

function validateLayers(primary: unknown, secondary: unknown): void {
  assert(primary == null || LAYERS.some((layer) => layer.id === primary), 'Unknown primary Layer.');
  assert(Array.isArray(secondary) && secondary.every((id) => LAYERS.some((layer) => layer.id === id)), 'Unknown secondary Layer.');
}
async function requireBook(workId: ID, editionId?: ID) {
  const work = await db.entity('works').get(workId);
  assert(work, 'Book not found.');
  const edition = editionId || work.preferredEditionId ? await db.entity('editions').get(editionId ?? work.preferredEditionId!) :
    (await db.entity('editions').where('workId').equals(workId).toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  assert(edition && edition.workId === workId, 'Book edition not found.');
  return { work, edition };
}
async function latestCycle(workId: ID) {
  const cycles = await db.entity('readingCycles').where('workId').equals(workId).toArray();
  // Creation order is stable inside a single device; no cross-device timestamp merging is used.
  return newest(cycles);
}
async function putIdentifier(entityId: ID, entityType: 'work' | 'edition', scheme: EntityMap['identifiers']['scheme'], value: string) {
  const existing = await db.entity('identifiers').where('[scheme+value]').equals([scheme, value]).first();
  assert(!existing || existing.entityId === entityId, 'Identifier conflicts with another book or edition. Review it before saving.');
  if (!existing) await db.entity('identifiers').add(stamp({ entityId, entityType, scheme, value }));
}
async function setStatusInternal(workId: ID, status: ReadingStatus, options: { reread?: boolean; occurredAt?: string } = {}) {
  assert(STATUSES.includes(status), 'Unknown reading status.');
  const { edition } = await requireBook(workId);
  const occurredAt = options.occurredAt ?? new Date().toISOString();
  assert(validDate(occurredAt), 'Invalid status date.');
  let cycle = await latestCycle(workId);
  if (cycle?.status === status && !options.reread) return;
  if (cycle?.finishedAt && status !== 'finished') assert(options.reread, 'Start an explicit reread to preserve the completed cycle.');
  if (!cycle || options.reread) {
    assert(!options.reread || status === 'reading', 'A reread starts with Reading status.');
    cycle = stamp({ workId, editionId: edition.id, startedAt: occurredAt, status,
      ...(status === 'finished' ? { finishedAt: occurredAt } : {}) });
  } else {
    cycle = stamp({ ...cycle, status, ...(status === 'finished' ? { finishedAt: occurredAt } : {}) }, cycle);
  }
  await db.entity('readingCycles').put(cycle);
  await db.entity('statusEvents').add(stamp({ workId, cycleId: cycle.id, status, occurredAt }));
}
export async function setStatus(workId: ID, status: ReadingStatus, options?: { reread?: boolean; occurredAt?: string }): Promise<void> {
  await mutate(() => setStatusInternal(workId, status, options));
}
export async function findDuplicates(input: Pick<AddBookInput, 'title' | 'authors' | 'isbn' | 'candidate'>): Promise<Book[]> {
  const snapshot = await getSnapshot();
  const isbn = input.isbn ? normalizeIsbn(input.isbn) : undefined;
  return snapshot.books.filter((book) => (isbn && book.isbn === isbn) ||
    (input.candidate?.workId && book.workKey === input.candidate.workId) ||
    (normalized(book.title) === normalized(input.title) &&
      book.authors.some((author) => input.authors?.some((incoming) => normalized(incoming) === normalized(author)))));
}
export async function addBook(input: AddBookInput): Promise<ID> {
  textValue(input.title, 'title', 1_000);
  assert(input.title.trim(), 'A title is required. Other metadata may be unknown.');
  const candidate = input.candidate;
  const fields: MetadataFields = { title: input.title.trim(), authors: input.authors ?? candidate?.authors ?? [] };
  for (const field of METADATA_FIELDS) {
    const value = input[field as keyof AddBookInput] ?? candidate?.[field];
    if (value !== undefined) Object.assign(fields, { [field]: value });
  }
  validateMetadata(fields);
  const isbns = [...new Set([...(input.isbn ? [input.isbn] : []), ...(candidate?.isbn ?? [])].map(normalizeIsbn))];
  if (input.sourceUrl) safeUrl(input.sourceUrl);
  return mutate(async () => {
    const identifiers = await db.entity('identifiers').toArray();
    const providerWork = candidate?.workId && identifiers.find((item) => item.scheme === 'open-library-work' && item.value === candidate.workId);
    const providerEdition = candidate?.editionId && identifiers.find((item) => item.scheme === 'open-library-edition' && item.value === candidate.editionId);
    const isbnEditions = identifiers.filter((item) => item.scheme === 'isbn' && isbns.includes(item.value));
    const editionIds = new Set([...(providerEdition ? [providerEdition.entityId] : []), ...isbnEditions.map((item) => item.entityId)]);
    assert(editionIds.size <= 1, 'The supplied identifiers point to different editions. Review the conflict.');
    const existingEdition = editionIds.size ? await db.entity('editions').get([...editionIds][0]) : undefined;
    const workIds = new Set([...(input.workId ? [input.workId] : []), ...(providerWork ? [providerWork.entityId] : []), ...(existingEdition ? [existingEdition.workId] : [])]);
    assert(workIds.size <= 1, 'Work and edition identifiers conflict.');
    let work = workIds.size ? await db.entity('works').get([...workIds][0]) : undefined;
    assert(!input.workId || work, 'Selected work no longer exists.');
    if (existingEdition && !input.allowDuplicate) throw new Error('This edition is already in your library. Open the existing book or explicitly add a holding.');
    if (!work && !input.allowDuplicate) {
      const similar = (await db.entity('works').toArray()).some((item) => normalized(item.title) === normalized(fields.title) &&
        item.authors.some((author) => fields.authors.some((incoming) => normalized(incoming) === normalized(author))));
      assert(!similar, 'A similar title and author already exist. Review possible duplicates, then explicitly confirm adding a separate work.');
    }
    const isNewWork = !work;
    if (!work) { work = stamp({ title: fields.title, authors: fields.authors }); await db.entity('works').add(work); }
    const edition = existingEdition ?? stamp({ workId: work.id, metadata: fields });
    if (!existingEdition) await db.entity('editions').add(edition);
    if (!work.preferredEditionId) {
      const previousEditions = (await db.entity('editions').where('workId').equals(work.id).toArray()).filter((item) => item.id !== edition.id);
      const preferredEditionId = previousEditions.sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]?.id ?? edition.id;
      work = stamp({ ...work, preferredEditionId }, work);
      await db.entity('works').put(work);
    }
    if (candidate?.workId) await putIdentifier(work.id, 'work', 'open-library-work', candidate.workId);
    if (candidate?.editionId) await putIdentifier(edition.id, 'edition', 'open-library-edition', candidate.editionId);
    for (const isbn of isbns) await putIdentifier(edition.id, 'edition', 'isbn', isbn);
    const formats = input.formats ?? ['physical'];
    assert(formats.every((format) => format === 'physical' || format === 'digital'), 'Unknown holding format.');
    const holdings = await db.entity('holdings').where('editionId').equals(edition.id).toArray();
    for (const format of new Set(formats)) if (!holdings.some((holding) => holding.format === format)) {
      await db.entity('holdings').add(stamp({ workId: work.id, editionId: edition.id, format, ...(input.sourceUrl ? { sourceUrl: input.sourceUrl } : {}) }));
    }
    if (candidate) {
      await applyMetadataInternal(work.id, edition.id, candidate);
      const corrections = Object.fromEntries(METADATA_FIELDS.filter((field) => {
        const value = input[field as keyof AddBookInput];
        return value !== undefined && candidate[field] !== undefined && !same(value, candidate[field]);
      }).map((field) => [field, input[field as keyof AddBookInput]]));
      await updateBookInternal(work.id, { ...corrections, editionId: edition.id });
    }
    if (isNewWork || input.updateExistingOrganization) await updateBookInternal(work.id, { purpose: input.purpose, primaryLayer: input.primaryLayer, secondaryLayers: input.secondaryLayers, tagIds: input.tagIds });
    if (!(await latestCycle(work.id))) await setStatusInternal(work.id, input.status ?? 'to-read');
    return work.id;
  });
}
async function updateBookInternal(workId: ID, patch: UpdateBookInput) {
  const { edition } = await requireBook(workId, patch.editionId);
  const metadata = Object.fromEntries(METADATA_FIELDS.filter((field) => patch[field] !== undefined).map((field) => [field, patch[field]]));
  validateMetadata(metadata);
  if ('title' in metadata) assert(String(metadata.title).trim(), 'Title cannot be blank.');
  const provider = await db.entity('metadataSnapshots').where('editionId').equals(edition.id).first();
  for (const [field, value] of Object.entries(metadata)) {
    const previous = await db.entity('fieldOverrides').where('[editionId+field]').equals([edition.id, field]).first();
    const effective = previous?.value ?? provider?.candidate[field as keyof MetadataFields] ?? edition.metadata[field as keyof MetadataFields];
    if (same(value, effective)) continue;
    await db.entity('fieldOverrides').put(stamp({ workId, editionId: edition.id, field: field as keyof MetadataFields, value: value as string | string[] | number }, previous));
  }
  if (patch.formats) {
    assert(patch.formats.every((format) => format === 'physical' || format === 'digital'), 'Unknown format.');
    const holdings = await db.entity('holdings').where('editionId').equals(edition.id).toArray();
    for (const holding of holdings) if (!patch.formats.includes(holding.format)) await removeEntity('holdings', holding.id);
    for (const format of new Set(patch.formats)) if (!holdings.some((holding) => holding.format === format)) await db.entity('holdings').add(stamp({ workId, editionId: edition.id, format }));
  }
  if (patch.notes !== undefined) {
    textValue(patch.notes, 'notes', 20_000);
    const notes = (await db.entity('notes').where('workId').equals(workId).toArray()).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const previous = notes[0];
    if (patch.notes.trim()) {
      if (!previous || notes.length > 1 || previous.text !== patch.notes) {
        const consolidated = stamp({ workId, text: patch.notes }, previous);
        consolidated.ancestors = [...new Set([...consolidated.ancestors, ...notes.slice(1).flatMap((note) => [note.revision, ...note.ancestors])])];
        await db.entity('notes').put(consolidated);
      }
      for (const superseded of notes.slice(1)) await removeEntity('notes', superseded.id);
    } else for (const note of notes) await removeEntity('notes', note.id);
  }
  if (patch.personalRating !== undefined) {
    const previous = await db.entity('personalRatings').where('workId').equals(workId).first();
    if (patch.personalRating === null) { if (previous) await removeEntity('personalRatings', previous.id); }
    else {
      assert(patch.personalRating >= 0 && patch.personalRating <= 5 && Number.isFinite(patch.personalRating), 'Personal rating must be between 0 and 5.');
      await db.entity('personalRatings').put(stamp({ workId, value: patch.personalRating }, previous));
    }
  }
  if (patch.purpose !== undefined || patch.primaryLayer !== undefined || patch.secondaryLayers !== undefined || patch.layerLabel !== undefined || patch.layerEvidence !== undefined) {
    const previous = await db.entity('layerAssignments').where('workId').equals(workId).first();
    const primary = patch.primaryLayer === null ? undefined : patch.primaryLayer ?? previous?.primary;
    const secondary = patch.secondaryLayers ?? previous?.secondary ?? [];
    validateLayers(primary, secondary);
    const purpose = patch.purpose ?? previous?.purpose ?? '';
    textValue(purpose, 'purpose');
    const label = patch.layerLabel ?? previous?.label ?? 'user-selected';
    assert(['user-selected', 'tentative', 'needs-review'].includes(label), 'Invalid Layer confidence label.');
    const evidence = patch.layerEvidence ?? previous?.evidence ?? 'Selected by you';
    textValue(evidence, 'Layer evidence');
    await db.entity('layerAssignments').put(stamp({ workId, ...(primary ? { primary } : {}), secondary: [...new Set(secondary)], purpose,
      origin: 'user', label, evidence, pinned: true } as Omit<LayerAssignment, keyof import('../domain/types').Revision>, previous));
  }
  if (patch.tagIds) {
    const assignments = await db.entity('tagAssignments').where('workId').equals(workId).toArray();
    for (const assignment of assignments) if (assignment.state === 'accepted' && !patch.tagIds.includes(assignment.tagId)) {
      await db.entity('tagAssignments').put(stamp({ ...assignment, state: 'rejected', pinned: true }, assignment));
    }
    for (const tagId of new Set(patch.tagIds)) await acceptTagInternal(workId, tagId);
  }
}
export async function updateBook(workId: ID, patch: UpdateBookInput): Promise<void> {
  await mutate(() => updateBookInternal(workId, patch));
}
export async function deleteBook(workId: ID): Promise<void> {
  await mutate(async () => {
    const editions = await db.entity('editions').where('workId').equals(workId).primaryKeys();
    for (const table of ['holdings', 'metadataSnapshots', 'fieldOverrides', 'readingCycles', 'statusEvents', 'sessions', 'notes', 'personalRatings', 'layerAssignments', 'tagAssignments', 'reviewLinks', 'ratingSnapshots'] as const) {
      for (const record of await db.entity(table).where('workId').equals(workId).toArray()) await removeEntity(table, record.id);
    }
    for (const record of await db.entity('identifiers').toArray()) if (record.entityId === workId || editions.includes(record.entityId)) await removeEntity('identifiers', record.id);
    for (const id of editions) await removeEntity('editions', id);
    await removeEntity('works', workId);
  });
}
export async function logSession(input: LogSessionInput): Promise<ID> {
  return mutate(async () => {
    const { edition: defaultEdition } = await requireBook(input.workId);
    const edition = input.editionId ? await db.entity('editions').get(input.editionId) : defaultEdition;
    assert(edition?.workId === input.workId, 'Session edition does not belong to this book.');
    let cycle = await latestCycle(input.workId);
    if (!cycle || ['wishlist', 'to-read'].includes(cycle.status)) {
      await setStatusInternal(input.workId, 'reading'); cycle = await latestCycle(input.workId);
    }
    assert(cycle && !cycle.finishedAt, 'Start an explicit reread before adding another session.');
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    assert(validDate(occurredAt), 'Invalid session date.');
    const pages = input.pages ?? 0;
    const minutes = input.minutes ?? 0;
    if (input.page !== undefined) {
      positive(input.page, 'page');
      assert(!edition.metadata.pageCount || input.page <= edition.metadata.pageCount, 'Page exceeds this edition’s page count.');
    }
    positive(pages, 'pages'); positive(minutes, 'minutes');
    if (input.percent !== undefined) assert(Number.isFinite(input.percent) && input.percent >= 0 && input.percent <= 100, 'Percentage must be between 0 and 100.');
    assert(pages > 0 || minutes > 0 || input.percent !== undefined || input.page !== undefined, 'Enter pages, progress, or minutes.');
    const session = stamp({ workId: input.workId, editionId: edition.id, cycleId: cycle.id, occurredAt, pages, minutes,
      ...(input.page !== undefined ? { page: input.page } : {}), ...(input.percent !== undefined ? { percent: input.percent } : {}) });
    await db.entity('sessions').add(session);
    return session.id;
  });
}
export async function updateSession(id: ID, patch: Partial<Pick<EntityMap['sessions'], 'pages' | 'minutes' | 'page' | 'percent' | 'occurredAt' | 'editionId'>>): Promise<void> {
  await mutate(async () => {
    const previous = await db.entity('sessions').get(id); assert(previous, 'Session not found.');
    const session = { ...previous, ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) };
    await requireBook(previous.workId, session.editionId);
    positive(session.pages, 'pages'); positive(session.minutes, 'minutes');
    if (session.page !== undefined) positive(session.page, 'page');
    if (session.percent !== undefined) assert(session.percent >= 0 && session.percent <= 100 && Number.isFinite(session.percent), 'Invalid percentage.');
    assert(validDate(session.occurredAt), 'Invalid session date.');
    await db.entity('sessions').put(stamp(session, previous));
  });
}
export async function deleteSession(id: ID): Promise<void> { await mutate(() => removeEntity('sessions', id)); }
export async function saveGoal(input: { id?: ID; metric: Goal['metric']; target: number; startDate: string; endDate: string }): Promise<ID> {
  assert(['books', 'pages', 'minutes'].includes(input.metric), 'Unknown goal metric.');
  positive(input.target, 'goal target', false);
  assert(validDate(input.startDate) && validDate(input.endDate) && input.startDate <= input.endDate, 'Choose a valid goal period.');
  return mutate(async () => {
    const previous = input.id ? await db.entity('goals').get(input.id) : undefined;
    assert(!input.id || previous, 'Goal not found.');
    const goal = stamp({ metric: input.metric, target: input.target, startDate: input.startDate, endDate: input.endDate }, previous);
    await db.entity('goals').put(goal); return goal.id;
  });
}
export async function deleteGoal(id: ID): Promise<void> { await mutate(() => removeEntity('goals', id)); }
export const GOAL_COUNTING_RULES = 'Books count once per explicitly completed reading cycle. Pages and minutes sum session amounts in the chosen period; finishing adds no pages. Percentages are not converted to pages. Corrections recalculate totals.';

export async function createTag(name: string, kind: TagKind = 'topic'): Promise<ID> {
  textValue(name, 'tag name', 100); assert(name.trim(), 'Tag name is required.');
  assert(['topic', 'purpose', 'mood', 'context'].includes(kind), 'Unknown tag kind.');
  return mutate(async () => {
    const existing = await db.entity('tags').where('normalizedName').equals(normalized(name)).first();
    if (existing) return existing.id;
    const tag = stamp({ name: name.trim(), normalizedName: normalized(name), kind, aliases: [], archived: false, pinned: true });
    await db.entity('tags').add(tag); return tag.id;
  });
}
export async function renameTag(id: ID, name: string): Promise<void> {
  textValue(name, 'tag name', 100); assert(name.trim(), 'Tag name is required.');
  await mutate(async () => {
    const tag = await db.entity('tags').get(id); assert(tag, 'Tag not found.');
    const collision = await db.entity('tags').where('normalizedName').equals(normalized(name)).first();
    assert(!collision || collision.id === id, 'A tag has that name. Merge them instead.');
    await db.entity('tags').put(stamp({ ...tag, name: name.trim(), normalizedName: normalized(name), aliases: [...new Set([...tag.aliases, tag.name])], pinned: true }, tag));
  });
}
export async function archiveTag(id: ID, archived = true): Promise<void> {
  await mutate(async () => {
    const tag = await db.entity('tags').get(id); assert(tag, 'Tag not found.');
    assert(!(await db.entity('tagRedirects').where('fromTagId').equals(id).first()), 'Merged tags stay archived; edit the target tag.');
    await db.entity('tags').put(stamp({ ...tag, archived, pinned: true }, tag));
  });
}
export async function mergeTags(fromId: ID, toId: ID): Promise<void> {
  assert(fromId !== toId, 'Choose two different tags.');
  await mutate(async () => {
    const from = await db.entity('tags').get(fromId), to = await db.entity('tags').get(toId);
    assert(from && to && !to.archived, 'Select an active destination tag.');
    assert(!(await db.entity('tagRedirects').where('fromTagId').equals(fromId).first()), 'This tag was already merged.');
    await db.entity('tags').put(stamp({ ...to, aliases: [...new Set([...to.aliases, from.name, ...from.aliases])], pinned: true }, to));
    await db.entity('tags').put(stamp({ ...from, archived: true, pinned: true }, from));
    await db.entity('tagRedirects').add(stamp({ fromTagId: fromId, toTagId: toId }));
    for (const assignment of await db.entity('tagAssignments').where('tagId').equals(fromId).toArray()) {
      // Keep separate assignment rows so provider/rule provenance is never discarded.
      await db.entity('tagAssignments').put(stamp({ ...assignment, tagId: toId }, assignment));
    }
    for (const redirect of await db.entity('tagRedirects').where('toTagId').equals(fromId).toArray()) {
      await db.entity('tagRedirects').put(stamp({ ...redirect, toTagId: toId }, redirect));
    }
  });
}
async function acceptTagInternal(workId: ID, tagId: ID) {
  await requireBook(workId);
  const redirect = await db.entity('tagRedirects').where('fromTagId').equals(tagId).first();
  tagId = redirect?.toTagId ?? tagId;
  const tag = await db.entity('tags').get(tagId); assert(tag && !tag.archived, 'Tag is missing or archived.');
  const assignments = (await db.entity('tagAssignments').where('workId').equals(workId).toArray()).filter((item) => item.tagId === tagId);
  if (assignments.length) for (const previous of assignments) await db.entity('tagAssignments').put(stamp({ ...previous, state: 'accepted', pinned: true }, previous));
  else await db.entity('tagAssignments').add(stamp({ workId, tagId, origin: 'user', state: 'accepted', pinned: true }));
}
export async function acceptTag(workId: ID, tagId: ID): Promise<void> { await mutate(() => acceptTagInternal(workId, tagId)); }
export async function rejectTag(workId: ID, tagId: ID): Promise<void> {
  await mutate(async () => {
    await requireBook(workId);
    assert(await db.entity('tags').get(tagId), 'Tag not found.');
    const assignments = (await db.entity('tagAssignments').where('workId').equals(workId).toArray()).filter((item) => item.tagId === tagId);
    if (assignments.length) for (const previous of assignments) await db.entity('tagAssignments').put(stamp({ ...previous, state: 'rejected', pinned: true }, previous));
    else await db.entity('tagAssignments').add(stamp({ workId, tagId, origin: 'user', state: 'rejected', pinned: true }));
  });
}
async function applyMetadataInternal(workId: ID, editionId: ID, candidate: MetadataCandidate) {
  validateCandidate(candidate);
  validateMetadata(Object.fromEntries(METADATA_FIELDS.filter((key) => candidate[key] !== undefined).map((key) => [key, candidate[key]])));
  safeUrl(candidate.sourceUrl);
  assert(validDate(candidate.fetchedAt), 'Invalid metadata retrieval date.');
  const previous = await db.entity('metadataSnapshots').where('editionId').equals(editionId).first();
  // Retain last known provider values when fields disappear remotely.
  const edition = await db.entity('editions').get(editionId);
  const incoming = Object.fromEntries(Object.entries(candidate).filter(([field, value]) => value !== undefined &&
    (!METADATA_FIELDS.includes(field as keyof MetadataFields) || providerValuePresent(value))));
  const merged = { ...edition?.metadata, ...previous?.candidate, ...incoming } as MetadataCandidate;
  await db.entity('metadataSnapshots').put(stamp({ workId, editionId, candidate: merged, acceptedAt: new Date().toISOString() }, previous));
  if (candidate.rating) {
    assert(candidate.rating.average >= 0 && candidate.rating.average <= 5, 'Invalid reader rating.');
    positive(candidate.rating.count, 'rating count');
    const old = await db.entity('ratingSnapshots').where('workId').equals(workId).first();
    await db.entity('ratingSnapshots').put(stamp({ workId, source: 'open-library', average: candidate.rating.average, count: candidate.rating.count, fetchedAt: candidate.rating.fetchedAt }, old));
  }
  for (const subject of candidate.subjects.slice(0, 30)) {
    const name = subject.slice(0, 100).trim(); if (!name) continue;
    let tag = (await db.entity('tags').toArray()).find((item) => item.normalizedName === normalized(name) || item.aliases.some((alias) => normalized(alias) === normalized(name)));
    if (!tag) { tag = stamp({ name, normalizedName: normalized(name), kind: 'topic' as const, aliases: [], archived: false, pinned: false }); await db.entity('tags').add(tag); }
    const redirect = await db.entity('tagRedirects').where('fromTagId').equals(tag.id).first();
    const tagId = redirect?.toTagId ?? tag.id;
    const existing = (await db.entity('tagAssignments').where('workId').equals(workId).toArray()).find((item) => item.tagId === tagId);
    if (!existing && !tag.archived) await db.entity('tagAssignments').add(stamp({ workId, tagId, origin: 'provider', sourceRef: candidate.sourceUrl, version: 'open-library-subjects-v1', state: 'suggested', pinned: false }));
  }
}
export async function previewMetadataRefresh(workId: ID, candidate: MetadataCandidate): Promise<MetadataDiff[]> {
  const book = (await getSnapshot()).books.find((item) => item.id === workId); assert(book, 'Book not found.');
  return METADATA_FIELDS.filter((field) => providerValuePresent(candidate[field]) && !same(candidate[field], book.metadataSnapshot?.candidate[field] ?? book.editions[0].metadata[field]))
    .map((field) => ({ field, previous: book.metadataSnapshot?.candidate[field] ?? book.editions[0].metadata[field], incoming: candidate[field], effective: book[field], overridden: book.overrides.some((override) => override.field === field) }));
}
export async function applyMetadataRefresh(workId: ID, candidate: MetadataCandidate): Promise<void> {
  await mutate(async () => {
    const { edition } = await requireBook(workId);
    const identifiers = await db.entity('identifiers').where('entityId').equals(edition.id).toArray();
    const editionKey = identifiers.find((item) => item.scheme === 'open-library-edition')?.value;
    assert(!editionKey || !candidate.editionId || editionKey === candidate.editionId, 'Refresh returned a different edition.');
    const workKey = (await db.entity('identifiers').where('entityId').equals(workId).toArray()).find((item) => item.scheme === 'open-library-work')?.value;
    assert(!workKey || workKey === candidate.workId, 'Refresh returned a different work.');
    await applyMetadataInternal(workId, edition.id, candidate);
  });
}
export async function resetFieldOverride(workId: ID, field: keyof MetadataFields): Promise<void> {
  await mutate(async () => {
    const { edition } = await requireBook(workId);
    const override = await db.entity('fieldOverrides').where('[editionId+field]').equals([edition.id, field]).first();
    if (override) await removeEntity('fieldOverrides', override.id);
  });
}
export async function saveReviewLink(input: { id?: ID; workId: ID; url: string; title: string; source: string; kind: ReviewLink['kind'] }): Promise<ID> {
  safeUrl(input.url); textValue(input.title, 'review title', 500); textValue(input.source, 'review source', 500);
  assert(input.kind === 'professional' || input.kind === 'reader', 'Unknown review type.');
  return mutate(async () => {
    await requireBook(input.workId);
    const previous = input.id ? await db.entity('reviewLinks').get(input.id) : undefined;
    assert(!input.id || previous?.workId === input.workId, 'Review not found.');
    const record = stamp({ workId: input.workId, url: input.url, title: input.title, source: input.source, kind: input.kind, verified: true as const, verifiedAt: new Date().toISOString() }, previous);
    await db.entity('reviewLinks').put(record); return record.id;
  });
}
export async function deleteReviewLink(id: ID): Promise<void> { await mutate(() => removeEntity('reviewLinks', id)); }
export async function saveSettings(patch: Partial<Settings>): Promise<void> {
  await mutate(async () => {
    const previous = await db.entity('settings').get('preferences');
    const value = { ...DEFAULT_SETTINGS, ...previous?.value, ...patch };
    for (const key of ['onlineAccess', 'loadCovers', 'useLibraryInterests', 'modelConsent', 'reducedMotion', 'onboardingComplete'] as const) assert(typeof value[key] === 'boolean', 'Invalid settings.');
    assert(value.view === 'shelf' || value.view === 'list', 'Invalid library view.');
    assert(Array.isArray(value.interests) && value.interests.length <= 100, 'Invalid interests.');
    value.interests.forEach((interest) => textValue(interest, 'interest', 200));
    if (value.modelVersion !== undefined) textValue(value.modelVersion, 'model version', 500);
    if (value.lastExportAt !== undefined) assert(validDate(value.lastExportAt), 'Invalid export date.');
    await db.entity('settings').put({ ...stamp({ value }, previous), id: 'preferences' });
  });
}
export async function getSnapshot(): Promise<LibrarySnapshot> {
  return db.transaction('r', db.tables, async () => {
    const entities = await readEntities(); const meta = (await db.meta.get('library')) ?? { libraryId: '', revision: 0 };
    const books: Book[] = entities.works.map((work) => {
      const editions = entities.editions.filter((item) => item.workId === work.id).sort((a, b) =>
        Number(b.id === work.preferredEditionId) - Number(a.id === work.preferredEditionId) || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      const edition = editions[0]; if (!edition) return undefined;
      const metadataSnapshot = entities.metadataSnapshots.find((item) => item.editionId === edition.id);
      const metadata: MetadataFields = { ...edition.metadata };
      for (const field of METADATA_FIELDS) if (metadataSnapshot?.candidate[field] !== undefined) Object.assign(metadata, { [field]: metadataSnapshot.candidate[field] });
      const overrides = entities.fieldOverrides.filter((item) => item.editionId === edition.id);
      for (const override of overrides) Object.assign(metadata, { [override.field]: override.value });
      const holdings = entities.holdings.filter((item) => item.workId === work.id);
      const cycle = newest(entities.readingCycles.filter((item) => item.workId === work.id));
      const sessions = entities.sessions.filter((item) => item.cycleId === cycle?.id).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.createdAt.localeCompare(b.createdAt));
      const layer = entities.layerAssignments.find((item) => item.workId === work.id);
      const assignments = entities.tagAssignments.filter((item) => item.workId === work.id);
      const activeTags = entities.tags.filter((tag) => !tag.archived);
      const identifiers = entities.identifiers.filter((item) => item.entityId === work.id || item.entityId === edition.id);
      return { ...metadata, id: work.id, workId: work.id, editionId: edition.id, editions, holdings,
        formats: (['physical', 'digital'] as const).filter((format) => holdings.some((item) => item.format === format)), isbn: identifiers.find((item) => item.scheme === 'isbn')?.value,
        workKey: identifiers.find((item) => item.scheme === 'open-library-work')?.value,
        editionKey: identifiers.find((item) => item.scheme === 'open-library-edition')?.value,
        status: cycle?.status ?? work.initialStatus ?? 'to-read', cycleId: cycle?.id,
        progress: { page: [...sessions].reverse().find((item) => item.page !== undefined && item.editionId === edition.id)?.page,
          percent: [...sessions].reverse().find((item) => item.percent !== undefined && item.editionId === edition.id)?.percent,
          pagesRead: sessions.reduce((total, item) => total + item.pages, 0), minutesRead: sessions.reduce((total, item) => total + item.minutes, 0) },
        purpose: layer?.purpose ?? '', primaryLayer: layer?.primary, secondaryLayers: layer?.secondary ?? [], layerAssignment: layer,
        tags: activeTags.filter((tag) => assignments.some((item) => item.tagId === tag.id && item.state === 'accepted') &&
          !assignments.some((item) => item.tagId === tag.id && item.state === 'rejected' && item.pinned)),
        tagSuggestions: assignments.filter((item) => item.state === 'suggested' && !assignments.some((decision) => decision.tagId === item.tagId && decision.pinned && decision.state !== 'suggested')).flatMap((assignment) => {
          const tag = activeTags.find((item) => item.id === assignment.tagId); return tag ? [{ ...assignment, tag }] : [];
        }),
        notes: entities.notes.filter((item) => item.workId === work.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).map((note) => note.text).join('\n\n'),
        personalRating: entities.personalRatings.find((item) => item.workId === work.id)?.value,
        reviewLinks: entities.reviewLinks.filter((item) => item.workId === work.id),
        catalogProvenance: editions.flatMap((item) => item.catalogProvenance ?? []),
        catalogSources: entities.importReceipts.filter((receipt) => receipt.catalog &&
          editions.some((item) => item.catalogProvenance?.some((provenance) => provenance.catalogId === receipt.sourceLibraryId)))
          .map((receipt) => ({ catalogId: receipt.sourceLibraryId, source: receipt.catalog! })),
        readerRating: entities.ratingSnapshots.find((item) => item.workId === work.id), metadataSnapshot, overrides,
        createdAt: work.createdAt, updatedAt: work.updatedAt,
      };
    }).filter((book) => book !== undefined);
    return { books, tags: entities.tags, sessions: entities.sessions, statusEvents: entities.statusEvents, readingCycles: entities.readingCycles, recommendationFeedback: entities.recommendationFeedback,
      goals: entities.goals.map((goal) => {
        const within = (date: string) => date.slice(0, 10) >= goal.startDate.slice(0, 10) && date.slice(0, 10) <= goal.endDate.slice(0, 10);
        const progress = goal.metric === 'books' ? entities.readingCycles.filter((cycle) => cycle.finishedAt && within(cycle.finishedAt)).length :
          entities.sessions.filter((session) => within(session.occurredAt)).reduce((total, session) => total + (goal.metric === 'pages' ? session.pages : session.minutes), 0);
        return { ...goal, progress };
      }), settings: { ...DEFAULT_SETTINGS, ...entities.settings.find((item) => item.id === 'preferences')?.value }, libraryId: meta.libraryId, revision: meta.revision };
  });
}
export async function searchLibrary(query: string): Promise<Book[]> {
  const term = normalized(query); return (await getSnapshot()).books.filter((book) =>
    normalized([book.title, ...book.authors, book.isbn ?? '', ...book.tags.map((tag) => tag.name)].join(' ')).includes(term));
}
export async function saveRecommendationFeedback(workKey: string, action: 'dismiss' | 'less-like-this', topics: string[] = []): Promise<void> {
  await mutate(async () => {
    textValue(workKey, 'work key', 200);
    assert(action === 'dismiss' || action === 'less-like-this', 'Invalid recommendation feedback.');
    topics.forEach((topic) => textValue(topic, 'topic', 200));
    const previous = await db.entity('recommendationFeedback').where('workKey').equals(workKey).first();
    await db.entity('recommendationFeedback').put(stamp({ workKey, action, topics }, previous));
  });
}
